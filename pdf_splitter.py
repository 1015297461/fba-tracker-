#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PDF 拆分工具后端逻辑

依赖：pypdf（pip3 install pypdf）

主要接口
--------
save_upload(filename, data)         上传一个 PDF，写入临时目录，返回文件信息 dict
run_split_job(job)                  执行单个拆分任务，返回结果 dict
get_download_path(download_id)      根据下载 ID 查询输出文件路径
cleanup_old_tmp(max_age_sec)        清理超期临时文件，服务启动时调用一次
check_pypdf()                       检测 pypdf 是否已安装
"""

import os
import re
import uuid
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# 临时目录
# ---------------------------------------------------------------------------
_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TMP_DIR  = os.path.join(_BASE_DIR, "data", "pdf_tmp")
TMP_SRC  = os.path.join(TMP_DIR, "src")   # 上传的源 PDF
TMP_OUT  = os.path.join(TMP_DIR, "out")   # 未指定自定义目录时的输出

# 运行时注册表（重启后失效，需重新上传）
_file_registry: dict     = {}   # file_id -> {tmp_path, name, pages, size, created}
_download_registry: dict = {}   # download_id -> abs_path


def _ensure_dirs():
    os.makedirs(TMP_SRC, exist_ok=True)
    os.makedirs(TMP_OUT, exist_ok=True)


# ---------------------------------------------------------------------------
# 启动清理
# ---------------------------------------------------------------------------

def cleanup_old_tmp(max_age_sec: int = 86400):
    """清理超过 max_age_sec 秒的临时文件，建议服务启动时调用一次。"""
    _ensure_dirs()
    now = time.time()
    for d in (TMP_SRC, TMP_OUT):
        try:
            for fname in os.listdir(d):
                fpath = os.path.join(d, fname)
                try:
                    if now - os.path.getmtime(fpath) > max_age_sec:
                        os.remove(fpath)
                except OSError:
                    pass
        except OSError:
            pass
    for fid in list(_file_registry):
        if not os.path.exists(_file_registry[fid].get("tmp_path", "")):
            del _file_registry[fid]
    for did in list(_download_registry):
        if not os.path.exists(_download_registry[did]):
            del _download_registry[did]


# ---------------------------------------------------------------------------
# 依赖检测
# ---------------------------------------------------------------------------

def check_pypdf() -> bool:
    try:
        import pypdf  # noqa: F401
        return True
    except ImportError:
        return False


# ---------------------------------------------------------------------------
# 上传
# ---------------------------------------------------------------------------

def save_upload(filename: str, data: bytes) -> dict:
    """
    保存上传的 PDF 到临时目录，计算页数，注册到 _file_registry。
    返回 dict（不含 tmp_path）：{file_id, name, pages, size}
    """
    _ensure_dirs()
    # 文件名仅保留安全字符，避免路径注入
    safe_name = re.sub(r'[^\w\-. ]', '_', filename)
    file_id   = uuid.uuid4().hex[:12]
    tmp_path  = os.path.join(TMP_SRC, f"{file_id}_{safe_name}")

    with open(tmp_path, "wb") as f:
        f.write(data)

    try:
        pages = get_page_count(tmp_path)
    except Exception:
        pages = 0

    info = {
        "file_id":  file_id,
        "name":     filename,
        "pages":    pages,
        "size":     len(data),
        "tmp_path": tmp_path,
        "created":  time.time(),
    }
    _file_registry[file_id] = info
    return {k: v for k, v in info.items() if k != "tmp_path"}


# ---------------------------------------------------------------------------
# 核心工具函数
# ---------------------------------------------------------------------------

def get_page_count(pdf_path: str) -> int:
    from pypdf import PdfReader
    return len(PdfReader(pdf_path).pages)


def parse_ranges(ranges_str: str) -> list:
    """
    解析自定义范围字符串，返回 [(start, end), ...] 列表（1-indexed，闭区间）。
    支持格式：'1-50, 51-200, 300-400' 或 '1-50;51-200'
    单页写法：'5' 等价于 '5-5'
    """
    result = []
    for part in re.split(r'[,;；，\s]+', ranges_str):
        part = part.strip()
        if not part:
            continue
        m = re.match(r'^(\d+)\s*[-–]\s*(\d+)$', part)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            if a >= 1 and b >= a:
                result.append((a, b))
        else:
            m2 = re.match(r'^(\d+)$', part)
            if m2:
                n = int(m2.group(1))
                if n >= 1:
                    result.append((n, n))
    return result


def split_by_max_pages(tmp_path: str, output_dir: str, orig_name: str,
                        max_pages: int, page_from: int, page_to: int) -> list:
    """
    将 [page_from, page_to]（1-indexed，闭区间）范围内的页按 max_pages 拆分。
    返回输出文件绝对路径列表，命名：{stem}_001.pdf, _002.pdf …
    """
    from pypdf import PdfReader, PdfWriter
    reader = PdfReader(tmp_path)
    total  = len(reader.pages)

    pf = max(1, page_from) - 1          # 转 0-indexed
    pt = min(total, max(page_from, page_to))  # 0-indexed exclusive end

    stem = Path(orig_name).stem
    ext  = Path(orig_name).suffix or ".pdf"

    outputs, chunk, i = [], 0, pf
    while i < pt:
        chunk += 1
        writer = PdfWriter()
        for p in range(i, min(i + max_pages, pt)):
            writer.add_page(reader.pages[p])
        out_path = os.path.join(output_dir, f"{stem}_{chunk:03d}{ext}")
        with open(out_path, "wb") as fout:
            writer.write(fout)
        outputs.append(out_path)
        i += max_pages
    return outputs


def split_by_ranges(tmp_path: str, output_dir: str, orig_name: str,
                    ranges_str: str) -> list:
    """
    按自定义范围拆分，每个范围生成一个文件。
    命名：{stem}_p{start}-{end}.pdf
    """
    from pypdf import PdfReader, PdfWriter
    reader = PdfReader(tmp_path)
    total  = len(reader.pages)
    pairs  = parse_ranges(ranges_str)
    if not pairs:
        raise ValueError("无有效页码范围，请检查格式（例：1-50,51-200）")

    stem = Path(orig_name).stem
    ext  = Path(orig_name).suffix or ".pdf"

    outputs = []
    for (start, end) in pairs:
        if start > total:
            continue
        end = min(end, total)
        writer = PdfWriter()
        for p in range(start - 1, end):
            writer.add_page(reader.pages[p])
        out_path = os.path.join(output_dir, f"{stem}_p{start}-{end}{ext}")
        with open(out_path, "wb") as fout:
            writer.write(fout)
        outputs.append(out_path)
    return outputs


# ---------------------------------------------------------------------------
# 拆分任务入口
# ---------------------------------------------------------------------------

def run_split_job(job: dict) -> dict:
    """
    执行单个拆分任务。

    job 字段
    --------
    file_id     str   上传时返回的 ID
    mode        str   "max_pages" | "custom_ranges"
    page_from   int   输出范围起始页（1-indexed）
    page_to     int   输出范围结束页（1-indexed）
    max_pages   int   每份最大页数（mode=max_pages）
    ranges_str  str   自定义范围字符串（mode=custom_ranges）
    output_dir  str   输出目录绝对路径；空字符串 → 使用 TMP_OUT（提供下载链接）

    返回 dict
    ---------
    {name, status, output_files: [{name, download_id, saved_to}], error}
    """
    info = _file_registry.get(job.get("file_id", ""))
    if not info:
        return {
            "name": job.get("name", "?"), "status": "failed",
            "output_files": [], "error": "文件已过期，请重新上传",
        }

    tmp_path  = info["tmp_path"]
    orig_name = info["name"]
    custom_dir = (job.get("output_dir") or "").strip()

    if custom_dir:
        try:
            os.makedirs(custom_dir, exist_ok=True)
        except Exception as e:
            return {
                "name": orig_name, "status": "failed",
                "output_files": [], "error": f"无法创建输出目录：{e}",
            }
        output_dir  = custom_dir
        use_tmp_out = False
    else:
        _ensure_dirs()
        output_dir  = TMP_OUT
        use_tmp_out = True

    try:
        mode = job.get("mode", "max_pages")
        if mode == "max_pages":
            paths = split_by_max_pages(
                tmp_path, output_dir, orig_name,
                max_pages = max(1, int(job.get("max_pages", 1))),
                page_from = max(1, int(job.get("page_from", 1))),
                page_to   = int(job.get("page_to", info["pages"])),
            )
        else:
            paths = split_by_ranges(
                tmp_path, output_dir, orig_name,
                ranges_str = job.get("ranges_str", ""),
            )

        output_files = []
        for p in paths:
            fname = os.path.basename(p)
            if use_tmp_out:
                did = uuid.uuid4().hex[:16]
                _download_registry[did] = p
                output_files.append({"name": fname, "download_id": did, "saved_to": None})
            else:
                output_files.append({"name": fname, "download_id": None, "saved_to": p})

        return {
            "name": orig_name, "status": "success",
            "output_files": output_files, "error": None,
        }

    except Exception as e:
        return {
            "name": orig_name, "status": "failed",
            "output_files": [], "error": str(e),
        }


# ---------------------------------------------------------------------------
# 下载
# ---------------------------------------------------------------------------

def get_download_path(download_id: str):
    """根据下载 ID 返回文件绝对路径，文件不存在返回 None。"""
    path = _download_registry.get(download_id)
    if path and os.path.exists(path):
        return path
    return None
