"""
Wspólny zapisywacz logów systemowych do plików .txt w katalogu `logi/`.
Przechowuje na bieżąco logi z jądra Pythona, serwera HTTP/FastAPI, SQLite, SSH/MCP oraz zdarzeń systemowych.
"""

from __future__ import annotations

import json
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

MAX_LOG_FILE_BYTES = 25 * 1024 * 1024  # 25 MB

MASTER_LOG_FILE = "system_wszystko.txt"
PYTHON_LOG_FILE = "backend_python.txt"

_WRITE_LOCK = threading.RLock()

_ENV_SECRET_KEYS = (
    "SVL_OPERATOR_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "OPENAI_API_KEY",
)

_SENSITIVE_FIELD_RE = re.compile(
    r"(token|secret|password|passwd|haslo|hasło|apikey|api_key|authorization|private[_-]?key|credential)",
    re.IGNORECASE,
)


def resolve_log_dir(custom_dir: Optional[str] = None) -> Path:
    configured = (custom_dir if custom_dir is not None else os.environ.get("SVL_LOG_DIR", "")).strip()
    if configured:
        return Path(configured).resolve()
    project_root = Path(__file__).resolve().parent.parent
    return (project_root / "logi").resolve()


def scrub_log_text(raw: Any, extra_secrets: Optional[list[str]] = None) -> str:
    cleaned = str(raw if raw is not None else "")
    cleaned = re.sub(r"\x1b\[[0-9;]*m", "", cleaned)
    cleaned = re.sub(r"[\r\n]+", " ", cleaned)
    cleaned = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", cleaned)

    for key in _ENV_SECRET_KEYS:
        val = os.environ.get(key, "")
        if val and len(val) >= 8:
            cleaned = cleaned.replace(val, "[REDACTED]")
    for sec in extra_secrets or ():
        if sec and len(sec) >= 8:
            cleaned = cleaned.replace(sec, "[REDACTED]")

    cleaned = re.sub(r"\bBearer\s+[A-Za-z0-9_.\-=+/]{8,}", "Bearer [REDACTED]", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bsvl-auth\.[A-Za-z0-9_-]{4,}", "svl-auth.[REDACTED]", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(
        r"(x-svl-operator-token|authorization)\s*[:=]\s*['\"]?[^\s,'\";\]]+",
        r"\1=[REDACTED]",
        cleaned,
        flags=re.IGNORECASE,
    )
    cleaned = re.sub(
        r"\b(api[_-]?key|password|passwd|operator[_-]?token|secret|token)\s*[:=]\s*['\"]?([^\s,'\";\]\}]{4,})",
        r"\1=[REDACTED]",
        cleaned,
        flags=re.IGNORECASE,
    )
    cleaned = re.sub(
        r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
        "[REDACTED_PRIVATE_KEY]",
        cleaned,
    )
    cleaned = re.sub(
        r"data:image/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]{32,}",
        "[DATA_IMAGE_BASE64]",
        cleaned,
        flags=re.IGNORECASE,
    )
    return cleaned.strip()[:2400]


def scrub_log_details(value: Any, extra_secrets: Optional[list[str]] = None, depth: int = 0) -> Any:
    if value is None or isinstance(value, (int, float, bool)):
        return value
    if depth > 4:
        return "[MAX_DEPTH]"
    if isinstance(value, str):
        return scrub_log_text(value, extra_secrets)
    if isinstance(value, (list, tuple)):
        return [scrub_log_details(item, extra_secrets, depth + 1) for item in list(value)[:25]]
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for idx, (k, v) in enumerate(value.items()):
            if idx >= 30:
                break
            key_str = str(k)
            if _SENSITIVE_FIELD_RE.search(key_str):
                out[key_str] = "[REDACTED]"
            else:
                out[key_str] = scrub_log_details(v, extra_secrets, depth + 1)
        return out
    return scrub_log_text(value, extra_secrets)


def ensure_log_files(log_dir: Optional[Path] = None) -> Path:
    target_dir = resolve_log_dir(str(log_dir) if log_dir is not None else None)
    with _WRITE_LOCK:
        target_dir.mkdir(parents=True, exist_ok=True)
        for fname in (MASTER_LOG_FILE, PYTHON_LOG_FILE):
            fpath = target_dir / fname
            if not fpath.exists():
                header = (
                    f"=== SVL PYTHON OS · LOG SYSTEMOWY ({fname}) · "
                    f"Utworzono: {datetime.now(timezone.utc).isoformat()} ===\n"
                )
                fpath.write_text(header, encoding="utf-8")
    return target_dir


def _rotate_if_needed(fpath: Path) -> None:
    try:
        if fpath.exists() and fpath.stat().st_size >= MAX_LOG_FILE_BYTES:
            backup = fpath.with_name(fpath.name.replace(".txt", ".prev.txt"))
            if backup.exists():
                backup.unlink()
            fpath.rename(backup)
    except OSError:
        pass


def append_python_log(
    category: str,
    message: str,
    *,
    level: str = "INFO",
    layer: str = "PYTHON",
    correlation_id: str = "",
    origin: str = "python-kernel",
    details: Any = None,
    extra_secrets: Optional[list[str]] = None,
    log_dir: Optional[Path] = None,
) -> None:
    try:
        ts = datetime.now(timezone.utc).isoformat()
        clean_layer = str(layer or "PYTHON").upper()[:16]
        clean_level = str(level or "INFO").upper()[:8]
        clean_cat = scrub_log_text(category or "general", extra_secrets)[:48] or "general"
        clean_msg = scrub_log_text(message or "", extra_secrets) or "(brak treści)"

        tags = [f"[{ts}]", f"[{clean_layer}]", f"[{clean_level}]", f"[{clean_cat}]"]
        if correlation_id:
            corr = scrub_log_text(correlation_id, extra_secrets)[:80]
            if corr:
                tags.append(f"[corr={corr}]")
        if origin:
            orig = scrub_log_text(origin, extra_secrets)[:80]
            if orig:
                tags.append(f"[origin={orig}]")

        suffix = ""
        if details not in (None, "", {}, []):
            if isinstance(details, str):
                cleaned_str = scrub_log_text(details, extra_secrets)
                if cleaned_str:
                    suffix = f" | {cleaned_str}"
            else:
                cleaned_obj = scrub_log_details(details, extra_secrets)
                try:
                    serialized = json.dumps(cleaned_obj, ensure_ascii=False, default=str)
                    if serialized and serialized not in ("{}", "[]"):
                        suffix = f" | {serialized[:1200]}"
                except Exception:
                    pass

        line = f"{' '.join(tags)} {clean_msg}{suffix}\n"
        target_dir = ensure_log_files(log_dir)
        with _WRITE_LOCK:
            for fname in (MASTER_LOG_FILE, PYTHON_LOG_FILE):
                fpath = target_dir / fname
                _rotate_if_needed(fpath)
                with open(fpath, "a", encoding="utf-8") as fh:
                    fh.write(line)
                    fh.flush()
    except Exception:
        # Logging must never break application execution
        pass
