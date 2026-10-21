#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI 模型调用（OpenAI 兼容接口，默认 DeepSeek）
================================================
为什么不用 `claude -p`：
  · 报告生成只需要「读一段 JSON、写一段 Markdown」，不需要 agent 能力
    （不用开浏览器、不用调 MCP），一次 HTTP 调用就够；
  · 走接口 = 一把可共享的 key，不绑某个人的登录态，也不依赖本机装 CLI；
  · 换供应商只改 data/ai-config.json，不动代码。

配置（data/ai-config.json，该目录已被 .gitignore 忽略，key 不入库）：
  {
    "provider": "deepseek",
    "base_url": "https://api.deepseek.com",   // 也支持 https://api.deepseek.com/v1
    "api_key": "sk-xxxx",
    "model": "deepseek-chat",
    "temperature": 0.3,
    "max_tokens": 8000,
    "timeout": 120
  }

零第三方依赖：只用标准库 urllib，和 sif_fetcher 一致。
"""

import json
import os
import time
import urllib.error
import urllib.request

from .utils import PROJECT_ROOT

CONFIG_PATH = os.path.join(PROJECT_ROOT, "data", "ai-config.json")

DEFAULTS = {
    "provider": "deepseek",
    "base_url": "https://api.deepseek.com",
    "model": "deepseek-chat",
    "temperature": 0.3,
    "max_tokens": 4000,
    "timeout": 120,
}

_config_cache = {"t": 0.0, "cfg": None}


class LLMError(Exception):
    """模型调用失败。message 面向用户展示（含可操作的排查提示）。"""

    def __init__(self, message: str, code: str = ""):
        super().__init__(message)
        self.code = code


def _load_config():
    """读配置并缓存 30 秒（改完配置不用重启服务）。"""
    now = time.time()
    if now - _config_cache["t"] < 30 and _config_cache["cfg"] is not None:
        return _config_cache["cfg"]

    cfg = dict(DEFAULTS)
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            raw = json.load(f)
        if isinstance(raw, dict):
            cfg.update({k: v for k, v in raw.items() if v not in (None, "")})
    except FileNotFoundError:
        cfg["api_key"] = ""
    except Exception as e:
        raise LLMError(f"读取 data/ai-config.json 失败：{e}", code="config_broken")

    # 环境变量优先，方便临时覆盖
    if os.environ.get("AI_API_KEY"):
        cfg["api_key"] = os.environ["AI_API_KEY"]
    if os.environ.get("AI_BASE_URL"):
        cfg["base_url"] = os.environ["AI_BASE_URL"]
    if os.environ.get("AI_MODEL"):
        cfg["model"] = os.environ["AI_MODEL"]

    _config_cache.update({"t": now, "cfg": cfg})
    return cfg


def is_configured() -> bool:
    try:
        cfg = _load_config()
    except LLMError:
        return False
    return bool(cfg.get("api_key"))


def describe() -> dict:
    """给前端/日志用的配置摘要（**不含 key**）。"""
    try:
        cfg = _load_config()
    except LLMError:
        return {"configured": False}
    key = cfg.get("api_key") or ""
    return {
        "configured": bool(key),
        "provider": cfg.get("provider"),
        "base_url": cfg.get("base_url"),
        "model": cfg.get("model"),
        "key_hint": (key[:6] + "…" + key[-4:]) if len(key) > 12 else ("已配置" if key else ""),
    }


def chat(messages, max_tokens=None, temperature=None, timeout=None) -> dict:
    """调用一次 chat/completions，返回 {text, usage, model, elapsed}。

    messages 为 [{"role": "system"|"user"|"assistant", "content": "..."}]。
    失败抛 LLMError（HTTP 4xx/5xx、网络、响应格式异常都会转成可读信息）。
    """
    cfg = _load_config()
    key = cfg.get("api_key") or ""
    if not key:
        raise LLMError(
            "未配置 AI 模型：请创建 data/ai-config.json 并填入 api_key（参考文档）",
            code="not_configured",
        )

    url = str(cfg.get("base_url") or DEFAULTS["base_url"]).rstrip("/")
    if not url.endswith("/chat/completions"):
        url += "/chat/completions"

    body = {
        "model": cfg.get("model") or DEFAULTS["model"],
        "messages": messages,
        "temperature": float(temperature if temperature is not None else cfg.get("temperature", 0.3)),
        "max_tokens": int(max_tokens or cfg.get("max_tokens") or 4000),
        "stream": False,
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + key,
        },
        method="POST",
    )

    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=float(timeout or cfg.get("timeout") or 120)) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        code = getattr(e, "code", 0) or 0
        try:
            detail = e.read()[:300].decode("utf-8", "replace")
        except Exception:
            detail = ""
        if code == 401:
            raise LLMError("模型接口鉴权失败（401）：请检查 api_key 是否正确", code="auth") from e
        if code == 402:
            raise LLMError("模型账户余额不足（402）：请充值后再试", code="insufficient") from e
        if code == 429:
            raise LLMError("模型接口调用过于频繁（429）：请稍等再试", code="rate_limit") from e
        raise LLMError(f"模型接口返回 HTTP {code}：{detail}", code="http") from e
    except urllib.error.URLError as e:
        raise LLMError(f"连不上模型接口：{e.reason}（检查 base_url 与网络）", code="network") from e
    except Exception as e:
        raise LLMError(f"调用模型失败：{type(e).__name__}: {e}") from e

    try:
        data = json.loads(raw)
    except Exception:
        raise LLMError(f"模型响应不是合法 JSON：{raw[:200]}", code="bad_json")

    choices = data.get("choices") or []
    if not choices:
        raise LLMError(f"模型未返回内容：{str(data)[:200]}", code="empty")
    choice = choices[0]
    msg = choice.get("message") or {}
    text = (msg.get("content") or "").strip()
    reasoning = (msg.get("reasoning_content") or "").strip()
    finish = choice.get("finish_reason")

    if not text:
        # 推理型模型（如 deepseek-flash / reasoner）会先输出 reasoning_content 再给 content。
        # 额度太小的话，token 全被思考吃掉，content 为空且 finish_reason=length。
        if finish == "length" and reasoning:
            raise LLMError(
                f"输出额度被推理过程占满：该模型是推理型，先思考再作答，"
                f"当前 max_tokens={body['max_tokens']} 不够。"
                f"请把 data/ai-config.json 的 max_tokens 调到 6000 以上再试",
                code="truncated",
            )
        raise LLMError(f"模型返回空内容（finish_reason={finish}）", code="empty")

    usage = data.get("usage") or {}
    details = usage.get("completion_tokens_details") or {}
    return {
        "text": text,
        "usage": {
            "prompt_tokens": usage.get("prompt_tokens"),
            "completion_tokens": usage.get("completion_tokens"),
            "reasoning_tokens": details.get("reasoning_tokens"),
            "total_tokens": usage.get("total_tokens"),
        },
        "reasoning": reasoning[:500] if reasoning else "",
        "finish_reason": finish,
        "model": data.get("model") or body["model"],
        "elapsed": round(time.time() - t0, 1),
    }
