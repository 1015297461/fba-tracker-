"""
卖家精灵账号凭据的本地加密存储。

存在哪 / 为什么
---------------
`data/sprite-cred.json`（`/data/` 已在 .gitignore，不进 git）。文件里**只有密文**，
没有明文账号密码 —— 防的是「文件被同事看到 / 被打包误传 / 被顺手 grep」。
不防「本机已被完全入侵」（那时任何本地加密都白搭）。

加密做法（纯标准库，不引第三方依赖）
--------------------------------
密钥不落盘，由**本机机器标识**（macOS 的 IOPlatformUUID）+ 随机 salt 经 `hashlib.scrypt`
派生；密文用 HMAC-SHA256 计数器模式做流加密（keystream = HMAC(encKey, nonce||counter)），
再附一段 HMAC 做完整性校验。换台机器解不开（机器标识不同），文件被改也会校验失败。

用法
----
    python3 -m backend.sprite_cred set      # 交互输入账号+密码（密码不回显），写入
    python3 -m backend.sprite_cred show     # 只看是否已配置、账号名（不显示密码）
    python3 -m backend.sprite_cred clear    # 删除
"""

import base64
import getpass
import hashlib
import hmac
import json
import os
import re
import struct
import subprocess
import sys

from .utils import PROJECT_ROOT, _log

CRED_PATH = os.path.join(PROJECT_ROOT, "data", "sprite-cred.json")
MAGIC = b"FBASCRED1"
SCRYPT_N, SCRYPT_R, SCRYPT_P = 2 ** 14, 8, 1


# ---------------------------------------------------------------- 机器标识
def _machine_id() -> str:
    """尽量稳定的本机标识。换机器就换值 —— 密文不可跨机器解。"""
    # macOS
    try:
        out = subprocess.run(
            ["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
            capture_output=True, text=True, timeout=5).stdout or ""
        # 形如：  "IOPlatformUUID" = "45E44EF9-...."
        m = re.search(r'IOPlatformUUID"\s*=\s*"([^"]+)"', out)
        if m:
            return "mac:" + m.group(1)
    except Exception:
        pass
    # Linux
    try:
        p = "/etc/machine-id"
        if os.path.exists(p):
            with open(p, "r", encoding="utf-8") as f:
                v = f.read().strip()
            if v:
                return "linux:" + v
    except Exception:
        pass
    # 兜底：主机名 + 用户名（稳定性差一些，但总比固定 salt 强）
    import getpass as _gp
    import socket
    return f"fallback:{socket.gethostname()}:{_gp.getuser()}"


def _derive(salt: bytes):
    raw = hashlib.scrypt(_machine_id().encode("utf-8"), salt=salt,
                         n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=64)
    return raw[:32], raw[32:]


def _keystream_xor(key: bytes, nonce: bytes, data: bytes) -> bytes:
    out = bytearray(len(data))
    pos = 0
    counter = 0
    while pos < len(data):
        block = hmac.new(key, nonce + struct.pack(">I", counter), hashlib.sha256).digest()
        n = min(len(block), len(data) - pos)
        for i in range(n):
            out[pos + i] = data[pos + i] ^ block[i]
        pos += n
        counter += 1
    return bytes(out)


# ---------------------------------------------------------------- 读写
def load():
    """返回 {"user":..., "password":...}；没配置或解不开返回 None。"""
    if not os.path.exists(CRED_PATH):
        return None
    try:
        with open(CRED_PATH, "r", encoding="utf-8") as f:
            box = json.load(f)
        salt = base64.b64decode(box["salt"])
        nonce = base64.b64decode(box["nonce"])
        ct = base64.b64decode(box["ct"])
        mac = base64.b64decode(box["mac"])
        enc_key, mac_key = _derive(salt)
        want = hmac.new(mac_key, MAGIC + nonce + ct, hashlib.sha256).digest()
        if not hmac.compare_digest(want, mac):
            _log("[sprite-cred] 校验失败（文件被改过，或换了机器）")
            return None
        plain = _keystream_xor(enc_key, nonce, ct)
        data = json.loads(plain.decode("utf-8"))
        if not data.get("user") or not data.get("password"):
            return None
        return {"user": str(data["user"]), "password": str(data["password"])}
    except Exception as e:
        _log(f"[sprite-cred] 读取失败：{type(e).__name__}: {e}")
        return None


def save(user: str, password: str):
    os.makedirs(os.path.dirname(CRED_PATH), exist_ok=True)
    salt = os.urandom(16)
    nonce = os.urandom(16)
    enc_key, mac_key = _derive(salt)
    plain = json.dumps({"user": user, "password": password}, ensure_ascii=False).encode("utf-8")
    ct = _keystream_xor(enc_key, nonce, plain)
    mac = hmac.new(mac_key, MAGIC + nonce + ct, hashlib.sha256).digest()
    box = {
        "v": 1,
        "note": "卖家精灵账号（密文，密钥由本机标识派生；换机器需重新 set）",
        "salt": base64.b64encode(salt).decode(),
        "nonce": base64.b64encode(nonce).decode(),
        "ct": base64.b64encode(ct).decode(),
        "mac": base64.b64encode(mac).decode(),
    }
    with open(CRED_PATH, "w", encoding="utf-8") as f:
        json.dump(box, f, ensure_ascii=False, indent=2)
    try:
        os.chmod(CRED_PATH, 0o600)        # 只有本人可读
    except Exception:
        pass


def clear():
    try:
        if os.path.exists(CRED_PATH):
            os.remove(CRED_PATH)
            return True
    except Exception:
        pass
    return False


def status():
    """给前端/诊断用：是否已配置（不返回密码）。"""
    c = load()
    return {"configured": bool(c), "user": (c or {}).get("user")}


# ---------------------------------------------------------------- 命令行
def _main(argv):
    cmd = (argv[1] if len(argv) > 1 else "show").strip().lower()
    if cmd == "set":
        print("卖家精灵账号（保存在 data/sprite-cred.json，加密存储、不进 git）")
        user = input("账号（手机号/邮箱）: ").strip()
        if not user:
            print("账号不能为空")
            return 1
        pw = getpass.getpass("密码（输入不回显）: ")
        if not pw:
            print("密码不能为空")
            return 1
        pw2 = getpass.getpass("再输一次确认: ")
        if pw != pw2:
            print("两次输入不一致")
            return 1
        save(user, pw)
        print(f"已保存。校验：{status()}")
        return 0
    if cmd == "clear":
        print("已删除" if clear() else "本来就没有")
        return 0
    if cmd == "show":
        st = status()
        print(f"已配置: {st['configured']}" + (f"（账号 {st['user']}）" if st["configured"] else ""))
        if not st["configured"]:
            print("设置：python3 -m backend.sprite_cred set")
        return 0
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(_main(sys.argv))
