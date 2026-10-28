"""内容指纹：判断「这次抓到的东西和上次是不是一样」。

口径刻意只取结构，不含价格/评分/销量：
  价格和销量几乎每次抓都在变，一旦纳入比对，每次点「获取最新数据」都会算「有变化」，
  一天点 5 次就 5 条记录，去重等于没做。价格变动在页面上提示即可，不触发新增。

单独成文件是为了让 db 层也能用（老数据补指纹），否则 db ← rank_monitor 会循环依赖。
"""
import hashlib
import json


def _hash(sig) -> str:
    return "s1:" + hashlib.sha1(
        json.dumps(sig, separators=(",", ":"), default=str).encode()).hexdigest()


def srp_fingerprint(result: dict) -> str:
    """榜单结构指纹：ASIN 顺序 + 自然位 + 广告标记。"""
    items = (result or {}).get("items") or []
    sig = [[str(i.get("asin") or "").upper(),
            None if i.get("ad") else i.get("org"),
            1 if i.get("ad") else 0] for i in items]
    return _hash(sig)


def sif_fingerprint(data: dict) -> str:
    """SIF 结果指纹：前 N 名竞品的份额 + 各自自然位（ASIN 查询则用词维度）。"""
    data = data or {}
    if (data.get("kind") or "") == "asin":
        sig = [[k.get("keyword"), k.get("organic_rank"), k.get("aba_rank")]
               for k in (data.get("keywords") or [])]
    else:
        organic = data.get("organic") or {}
        sig = [[str(t.get("asin") or "").upper(),
                round(float(t.get("total_share") or 0), 4),
                organic.get(str(t.get("asin") or "").upper())]
               for t in (data.get("top") or [])]
    return _hash(sig)
