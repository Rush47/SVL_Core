#!/usr/bin/env python3
"""
SVL CoreOS 2: Apex — SVL-Sentinel (demon nadzoru, usługa systemd `svl-sentinel`).

Działa w pętli i co SVL_SENTINEL_INTERVAL_SEC sekund (domyślnie 30) wykonuje PRAWDZIWE pomiary:
- brama SVL (http://127.0.0.1:3000/api/health), jądro Python (port 8085), Ollama (/api/version),
- wolne miejsce na dysku i dostępna pamięć RAM.

Samonaprawa: gdy brama nie odpowiada przez SVL_SENTINEL_RESTART_AFTER kolejnych pomiarów (domyślnie 3),
demon wykonuje `systemctl restart svl-coreos2` (tylko jeśli ta usługa istnieje). Każda zmiana stanu
(awaria / powrót / restart) trafia do Mayi jako powiadomienie na kanale „Rodzina Mitek (wszyscy)”.
Stan zapisuje w /var/lib/svl-coreos2/sentinel_status.json (czyta go panel Apex).

Nic nie jest wpisane na sztywno: brak pomiaru = brak wartości.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

GATEWAY_URL = os.environ.get("SVL_GATEWAY_URL", "http://127.0.0.1:3000")
BACKEND_PORT = int(os.environ.get("SVL_PYTHON_PORT", "8085"))
OLLAMA_URL = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
INTERVAL = max(5.0, float(os.environ.get("SVL_SENTINEL_INTERVAL_SEC", "30")))
RESTART_AFTER = max(1, int(os.environ.get("SVL_SENTINEL_RESTART_AFTER", "3")))
SERVICE = os.environ.get("SVL_SENTINEL_SERVICE", "svl-coreos2")
STATE_FILE = Path(os.environ.get("SVL_SENTINEL_STATE", "/var/lib/svl-coreos2/sentinel_status.json"))
DISK_MIN_GB = float(os.environ.get("SVL_SENTINEL_DISK_MIN_GB", "5"))
RAM_MIN_PCT = float(os.environ.get("SVL_SENTINEL_RAM_MIN_PCT", "10"))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def http_ok(url: str, timeout: float = 4.0) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return 200 <= resp.status < 300
    except Exception:
        return False


def port_open(port: int, host: str = "127.0.0.1") -> bool:
    try:
        with socket.create_connection((host, port), timeout=2):
            return True
    except OSError:
        return False


def ram_available_pct() -> Optional[float]:
    try:
        info = {}
        for line in Path("/proc/meminfo").read_text().splitlines():
            key, _, rest = line.partition(":")
            info[key] = float(rest.split()[0])
        return round(info["MemAvailable"] * 100.0 / info["MemTotal"], 1)
    except Exception:
        return None


def disk_free_gb(path: str = "/") -> Optional[float]:
    try:
        return round(shutil.disk_usage(path).free / 1024**3, 2)
    except OSError:
        return None


def service_exists(name: str) -> bool:
    systemctl = shutil.which("systemctl")
    if not systemctl:
        return False
    out = subprocess.run([systemctl, "cat", name], capture_output=True, text=True, timeout=5)
    return out.returncode == 0


def notify_maya(title: str, message: str, severity: str = "WARN") -> None:
    """Powiadomienie Mayi przez jądro Python SVL (loopback)."""
    body = json.dumps({
        "title": title,
        "message": message,
        "severity": severity,
        "category": "svl_sentinel",
        "sourceEventId": f"sentinel-{int(time.time())}",
        "origin": "svl-sentinel",
    }).encode("utf-8")
    try:
        req = urllib.request.Request(
            f"http://127.0.0.1:{BACKEND_PORT}/api/py/notifications/emit",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=5).read()
    except Exception as exc:  # brak jądra = brak powiadomienia, ale log zostaje w journald
        print(f"[svl-sentinel] Nie wysłano powiadomienia: {exc}", flush=True)


def measure() -> dict[str, Any]:
    return {
        "checked_at": _now(),
        "gateway": http_ok(f"{GATEWAY_URL}/api/health"),
        "backend": port_open(BACKEND_PORT),
        "ollama": http_ok(f"{OLLAMA_URL}/api/version"),
        "disk_free_gb": disk_free_gb("/"),
        "ram_available_pct": ram_available_pct(),
    }


def problems(m: dict[str, Any]) -> list[str]:
    out = []
    if not m["gateway"]:
        out.append("brama SVL nie odpowiada")
    if not m["backend"]:
        out.append(f"jądro Python (port {BACKEND_PORT}) nie nasłuchuje")
    if m["disk_free_gb"] is not None and m["disk_free_gb"] < DISK_MIN_GB:
        out.append(f"mało miejsca na dysku: {m['disk_free_gb']} GB")
    if m["ram_available_pct"] is not None and m["ram_available_pct"] < RAM_MIN_PCT:
        out.append(f"mało wolnej pamięci RAM: {m['ram_available_pct']}%")
    return out


def write_state(state: dict[str, Any]) -> None:
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
    except OSError as exc:
        print(f"[svl-sentinel] Nie zapisano stanu: {exc}", flush=True)


def run_once(state: dict[str, Any]) -> dict[str, Any]:
    m = measure()
    issues = problems(m)
    prev_issues = set(state.get("issues", []))
    gateway_down = int(state.get("gateway_down_count", 0)) + (0 if m["gateway"] else 1)
    if m["gateway"]:
        gateway_down = 0
    restarted = None
    if gateway_down >= RESTART_AFTER and service_exists(SERVICE):
        res = subprocess.run(["systemctl", "restart", SERVICE], capture_output=True, text=True, timeout=60)
        restarted = {"at": _now(), "ok": res.returncode == 0, "error": res.stderr.strip()[:300] or None}
        gateway_down = 0
        print(f"[svl-sentinel] Restart {SERVICE}: {'OK' if restarted['ok'] else restarted['error']}", flush=True)
    new_issues = [i for i in issues if i not in prev_issues]
    solved = [i for i in prev_issues if i not in issues]
    if new_issues:
        notify_maya("SVL-Sentinel: wykryto problem", "; ".join(new_issues), "WARN")
    if solved:
        notify_maya("SVL-Sentinel: problem ustąpił", "; ".join(solved), "INFO")
    if restarted:
        notify_maya(
            f"SVL-Sentinel: restart usługi {SERVICE}",
            "Brama nie odpowiadała — " + ("usługa uruchomiona ponownie." if restarted["ok"] else f"restart nieudany: {restarted['error']}"),
            "WARN" if restarted["ok"] else "ALERT",
        )
    state = {
        **m,
        "issues": issues,
        "gateway_down_count": gateway_down,
        "last_restart": restarted or state.get("last_restart"),
        "interval_sec": INTERVAL,
        "pid": os.getpid(),
    }
    write_state(state)
    print(f"[svl-sentinel] {m['checked_at']} problemy: {', '.join(issues) if issues else 'brak'}", flush=True)
    return state


def main() -> int:
    if "--once" in sys.argv:
        print(json.dumps(run_once({}), indent=2, ensure_ascii=False))
        return 0
    running = True

    def stop(*_args: Any) -> None:
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    state: dict[str, Any] = {}
    print(f"[svl-sentinel] Start: pomiar co {INTERVAL:.0f} s, restart {SERVICE} po {RESTART_AFTER} nieudanych pomiarach bramy.", flush=True)
    while running:
        try:
            state = run_once(state)
        except Exception as exc:
            print(f"[svl-sentinel] Błąd pomiaru: {exc}", flush=True)
        slept = 0.0
        while running and slept < INTERVAL:
            time.sleep(1.0)
            slept += 1.0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
