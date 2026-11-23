"""
Prawdziwa telemetria modułu SVL-364. (MAXIMAL OPTIMIZED EDITION)

Każda wartość pochodzi z rzeczywistego źródła (/proc, nvidia-smi, ufw, OpenSSH,
pomiar połączenia HTTP/TCP). Gdy źródło jest niedostępne, zwracana jest jawna
informacja o braku danych — nigdy wartość wymyślona lub domyślna.

Optymalizacje V2:
- Agresywne cache GPU i firewall (TTL 45s)
- Mniejsze okna próbkowania CPU/net gdy możliwe
- Lepsza odporność na błędy I/O i subprocess
- Thread-safe caching z RLock
"""

from __future__ import annotations

import os
import platform
import re
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

# --- Fałszywe wrappery z poprzednich wersji -------------------------------------------------

LEGACY_FAKE_SUDO = (
    '#!/usr/bin/env bash\nwhile [[ $# -gt 0 ]]; do\n  case "$1" in\n    -n|-E|-H|-s|-i|-S) shift ;;\n'
    '    -u|-g|-p) shift 2 ;;\n    --) shift; break ;;\n    -*) shift ;;\n    *) break ;;\n  esac\ndone\n'
    'if [[ $# -eq 0 ]]; then exec /bin/bash; fi\nexec "$@"\n'
)
_LEGACY_FAKE_MARKERS = (
    'HOSTNAME="svl-364-ship"',
    'env["HOSTNAME"] = "svl-364-ship"',
    "SVL-364 Ebon Apex QKD-364 Zero-Trust Shield",
)
LEGACY_WRAPPER_NAMES = ("ssh", "ufw", "sudo")
_MAX_WRAPPER_SIZE = 16 * 1024


def is_legacy_fake_wrapper(path: Path | str) -> bool:
    candidate = Path(path)
    try:
        if not candidate.is_file() or candidate.stat().st_size > _MAX_WRAPPER_SIZE:
            return False
        content = candidate.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return False
    return content == LEGACY_FAKE_SUDO or any(marker in content for marker in _LEGACY_FAKE_MARKERS)


def remove_legacy_fake_wrappers(directories: Iterable[Path | str]) -> list[str]:
    removed: list[str] = []
    for directory in directories:
        for name in LEGACY_WRAPPER_NAMES:
            candidate = Path(directory) / name
            if is_legacy_fake_wrapper(candidate):
                try:
                    candidate.unlink()
                    removed.append(str(candidate))
                except OSError:
                    pass
    return removed


def find_real_binary(name: str, path: Optional[str] = None) -> Optional[str]:
    search_path = os.environ.get("PATH", "") if path is None else path
    for directory in search_path.split(os.pathsep):
        if not directory:
            continue
        candidate = Path(directory) / name
        if candidate.is_file() and os.access(candidate, os.X_OK) and not is_legacy_fake_wrapper(candidate):
            return str(candidate)
    return None


def parse_proc_stat(text: str) -> Optional[tuple[int, int]]:
    for line in text.splitlines():
        if line.startswith("cpu "):
            values = [int(v) for v in line.split()[1:]]
            idle = values[3] + (values[4] if len(values) > 4 else 0)
            total = sum(values[:8])
            return total - idle, total
    return None


def cpu_percent_between(first: Optional[tuple[int, int]], second: Optional[tuple[int, int]]) -> Optional[float]:
    if not first or not second:
        return None
    busy = second[0] - first[0]
    total = second[1] - first[1]
    if total <= 0:
        return None
    return round(max(0.0, min(100.0, busy * 100.0 / total)), 1)


def parse_meminfo(text: str) -> dict[str, Optional[float]]:
    values: dict[str, int] = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0].endswith(":"):
            try:
                values[parts[0][:-1]] = int(parts[1])
            except ValueError:
                continue

    def mb(key: str) -> Optional[float]:
        return round(values[key] / 1024.0, 1) if key in values else None

    total, available = mb("MemTotal"), mb("MemAvailable")
    used = round(total - available, 1) if total is not None and available is not None else None
    swap_total, swap_free = mb("SwapTotal"), mb("SwapFree")
    return {
        "ram_total_mb": total,
        "ram_available_mb": available,
        "ram_used_mb": used,
        "ram_percent": round(used * 100.0 / total, 1) if used is not None and total else None,
        "swap_total_mb": swap_total,
        "swap_used_mb": round(swap_total - swap_free, 1) if swap_total is not None and swap_free is not None else None,
    }


def parse_cpuinfo(text: str) -> dict[str, Any]:
    model: Optional[str] = None
    mhz_values: list[float] = []
    for line in text.splitlines():
        key, _, value = line.partition(":")
        key = key.strip().lower()
        if key == "model name" and model is None:
            model = value.strip() or None
        elif key == "cpu mhz":
            try:
                mhz_values.append(float(value))
            except ValueError:
                pass
    return {"model": model, "mhz": round(sum(mhz_values) / len(mhz_values), 1) if mhz_values else None}


def parse_net_dev(text: str) -> dict[str, dict[str, int]]:
    interfaces: dict[str, dict[str, int]] = {}
    for line in text.splitlines():
        if ":" not in line:
            continue
        name, _, data = line.partition(":")
        name = name.strip()
        fields = data.split()
        if name == "lo" or len(fields) < 9:
            continue
        try:
            interfaces[name] = {"rx_bytes": int(fields[0]), "tx_bytes": int(fields[8])}
        except ValueError:
            continue
    return interfaces


def parse_nvidia_smi(text: str) -> list[dict[str, Any]]:
    devices: list[dict[str, Any]] = []
    for line in text.splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) < 5 or not parts[0]:
            continue

        def num(value: str) -> Optional[float]:
            try:
                return float(value)
            except ValueError:
                return None

        devices.append({
            "name": parts[0],
            "utilization_percent": num(parts[1]),
            "memory_used_mb": num(parts[2]),
            "memory_total_mb": num(parts[3]),
            "temperature_c": num(parts[4]),
        })
    return devices


def disk_used_percent(usage: Any) -> Optional[float]:
    denominator = usage.used + usage.free
    return round(usage.used * 100.0 / denominator, 1) if denominator else None


def _read(path: str) -> Optional[str]:
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class RealTelemetryCollector:
    SAMPLE_WINDOW_SEC = 0.18  # reduced from 0.25 for faster sampling
    SSH_TARGET_TTL_SEC = 45.0
    SHIP_TTL_SEC = 90.0
    GPU_TTL_SEC = 45.0
    FIREWALL_TTL_SEC = 60.0
    REMOTE_SHIP_COMMAND = (
        "hostname; uname -srm; cat /proc/uptime; cat /proc/loadavg; nproc; "
        "grep -E '^(MemTotal|MemAvailable):' /proc/meminfo; df -Pk / | tail -1"
    )

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._last_sample: Optional[tuple[float, Optional[tuple[int, int]], dict[str, dict[str, int]]]] = None
        self._ssh_target_cache: dict[str, tuple[float, dict[str, Any]]] = {}
        self._ship_cache: dict[str, tuple[float, dict[str, Any]]] = {}
        self._gpu_cache: Optional[tuple[float, dict[str, Any]]] = None
        self._firewall_cache: Optional[tuple[float, dict[str, Any]]] = None
        self._process_started = time.time()

    def _sample(self) -> tuple[float, Optional[tuple[int, int]], dict[str, dict[str, int]]]:
        return (
            time.monotonic(),
            parse_proc_stat(_read("/proc/stat") or ""),
            parse_net_dev(_read("/proc/net/dev") or ""),
        )

    def _cpu_and_network(self) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        with self._lock:
            previous = self._last_sample
            now = time.monotonic()
            if previous is None or now - previous[0] < 0.08:
                previous = self._sample()
                time.sleep(self.SAMPLE_WINDOW_SEC)
            current = self._sample()
            self._last_sample = current

        elapsed = max(1e-6, current[0] - previous[0])
        info = parse_cpuinfo(_read("/proc/cpuinfo") or "")
        try:
            load = [round(v, 2) for v in os.getloadavg()]
        except OSError:
            load = None
        cpu = {
            "percent": cpu_percent_between(previous[1], current[1]),
            "cores": os.cpu_count(),
            "model": info["model"],
            "mhz": info["mhz"],
            "load_avg": load,
            "sample_window_sec": round(elapsed, 2),
        }
        network = []
        for name, now_counters in sorted(current[2].items()):
            before = previous[2].get(name)
            network.append({
                "interface": name,
                "rx_bytes": now_counters["rx_bytes"],
                "tx_bytes": now_counters["tx_bytes"],
                "rx_bytes_per_sec": round((now_counters["rx_bytes"] - before["rx_bytes"]) / elapsed, 1) if before else None,
                "tx_bytes_per_sec": round((now_counters["tx_bytes"] - before["tx_bytes"]) / elapsed, 1) if before else None,
            })
        return cpu, network

    @staticmethod
    def _os_name() -> Optional[str]:
        text = _read("/etc/os-release") or ""
        match = re.search(r'^PRETTY_NAME="?([^"\n]+)"?', text, re.MULTILINE)
        return match.group(1) if match else None

    @staticmethod
    def _uptime_sec() -> Optional[float]:
        text = _read("/proc/uptime")
        try:
            return round(float(text.split()[0]), 1) if text else None
        except (ValueError, IndexError):
            return None

    @staticmethod
    def _disk(path: str = "/") -> dict[str, Any]:
        try:
            usage = shutil.disk_usage(path)
        except OSError as exc:
            return {"path": path, "error": str(exc)}
        return {
            "path": path,
            "total_gb": round(usage.total / 1024**3, 2),
            "used_gb": round(usage.used / 1024**3, 2),
            "free_gb": round(usage.free / 1024**3, 2),
            "percent": disk_used_percent(usage),
        }

    def clear_caches(self) -> None:
        with self._lock:
            self._gpu_cache = None
            self._firewall_cache = None
            self._ssh_target_cache.clear()
            self._ship_cache.clear()

    def gpu(self, *, use_cache: bool = False) -> dict[str, Any]:
        if use_cache:
            with self._lock:
                if self._gpu_cache and time.monotonic() - self._gpu_cache[0] < self.GPU_TTL_SEC:
                    return self._gpu_cache[1]
        smi = find_real_binary("nvidia-smi")
        if not smi:
            result = {"available": False, "devices": [], "reason": "Brak narzędzia nvidia-smi — nie wykryto karty NVIDIA."}
        else:
            try:
                proc = subprocess.run(
                    [smi, "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu", "--format=csv,noheader,nounits"],
                    capture_output=True, text=True, timeout=4,
                )
                devices = parse_nvidia_smi(proc.stdout) if proc.returncode == 0 else []
                if devices:
                    result = {"available": True, "devices": devices, "reason": None}
                else:
                    detail = (proc.stderr or proc.stdout or "").strip()[:200]
                    result = {"available": False, "devices": [], "reason": f"nvidia-smi nie zwrócił danych GPU. {detail}".strip()}
            except (OSError, subprocess.TimeoutExpired) as exc:
                result = {"available": False, "devices": [], "reason": f"nvidia-smi nie odpowiedział: {exc}"}
        with self._lock:
            self._gpu_cache = (time.monotonic(), result)
        return result

    def firewall(self, *, use_cache: bool = False) -> dict[str, Any]:
        if use_cache:
            with self._lock:
                if self._firewall_cache and time.monotonic() - self._firewall_cache[0] < self.FIREWALL_TTL_SEC:
                    return self._firewall_cache[1]
        ufw = find_real_binary("ufw")
        if not ufw:
            result = {"tool": "ufw", "state": "not_installed", "detail": "Zapora ufw nie jest zainstalowana na tym hoście."}
        else:
            try:
                proc = subprocess.run([ufw, "status"], capture_output=True, text=True, timeout=4)
                match = re.search(r"Status:\s*(active|inactive)", proc.stdout or "", re.IGNORECASE)
                if proc.returncode == 0 and match:
                    rules = [
                        line.strip() for line in (proc.stdout or "").splitlines()
                        if line.strip() and not line.startswith(("Status:", "To ", "--"))
                    ]
                    result = {"tool": "ufw", "state": match.group(1).lower(), "rules": rules[:20], "detail": None}
                else:
                    detail = (proc.stderr or proc.stdout or "").strip()[:200]
                    result = {"tool": "ufw", "state": "unknown", "detail": detail or f"ufw zakończył się kodem {proc.returncode}."}
            except (OSError, subprocess.TimeoutExpired) as exc:
                result = {"tool": "ufw", "state": "unknown", "detail": f"Nie udało się odczytać stanu ufw: {exc}"}
        with self._lock:
            self._firewall_cache = (time.monotonic(), result)
        return result

    @staticmethod
    def http_probe(url: str, timeout: float = 1.8) -> dict[str, Any]:
        started = time.perf_counter()
        try:
            with urllib.request.urlopen(url, timeout=timeout) as resp:
                body = resp.read(4096).decode("utf-8", errors="replace")
                return {
                    "url": url,
                    "reachable": True,
                    "status_code": resp.status,
                    "latency_ms": round((time.perf_counter() - started) * 1000, 1),
                    "body": body,
                    "error": None,
                }
        except urllib.error.HTTPError as exc:
            return {"url": url, "reachable": True, "status_code": exc.code,
                    "latency_ms": round((time.perf_counter() - started) * 1000, 1), "body": "", "error": f"HTTP {exc.code}"}
        except Exception as exc:
            reason = getattr(exc, "reason", exc)
            return {"url": url, "reachable": False, "status_code": None, "latency_ms": None, "body": "", "error": str(reason)}

    def services(self, ollama_host: str, comfyui_url: str) -> dict[str, Any]:
        ollama = self.http_probe(ollama_host.rstrip("/") + "/api/version")
        version = None
        if ollama["reachable"] and ollama["body"]:
            match = re.search(r'"version"\s*:\s*"([^"]+)"', ollama["body"])
            version = match.group(1) if match else None
        synthetic = bool(version and "svl-364" in version.lower())
        comfy = self.http_probe(comfyui_url.rstrip("/") + "/system_stats")
        strip = lambda probe: {k: v for k, v in probe.items() if k != "body"}
        return {
            "ollama": {**strip(ollama), "version": version, "synthetic": synthetic},
            "comfyui": strip(comfy),
            "python_kernel": {
                "reachable": True,
                "pid": os.getpid(),
                "uptime_sec": round(time.time() - self._process_started, 1),
            },
        }

    def ssh_target(self, target: str) -> dict[str, Any]:
        with self._lock:
            cached = self._ssh_target_cache.get(target)
            if cached and time.monotonic() - cached[0] < self.SSH_TARGET_TTL_SEC:
                return cached[1]
        result = self._probe_ssh_target(target)
        with self._lock:
            self._ssh_target_cache[target] = (time.monotonic(), result)
        return result

    def _probe_ssh_target(self, target: str) -> dict[str, Any]:
        base: dict[str, Any] = {"alias": target, "hostname": None, "port": None, "user": None,
                                "reachable": False, "tcp_rtt_ms": None, "error": None, "checked_at": _now()}
        ssh = find_real_binary("ssh")
        if not ssh:
            return {**base, "error": "OpenSSH (ssh) nie jest zainstalowany na hoście backendu."}
        try:
            proc = subprocess.run([ssh, "-G", target], capture_output=True, text=True, timeout=4)
        except (OSError, subprocess.TimeoutExpired) as exc:
            return {**base, "error": f"ssh -G nie powiódł się: {exc}"}
        if proc.returncode != 0:
            return {**base, "error": (proc.stderr or "ssh -G zwrócił błąd").strip()[:200]}
        options: dict[str, str] = {}
        for line in proc.stdout.splitlines():
            key, _, value = line.partition(" ")
            options.setdefault(key.lower(), value.strip())
        hostname = options.get("hostname") or target
        try:
            port = int(options.get("port") or 22)
        except ValueError:
            port = 22
        info = {**base, "hostname": hostname, "port": port, "user": options.get("user")}
        started = time.perf_counter()
        try:
            with socket.create_connection((hostname, port), timeout=2.5):
                rtt = round((time.perf_counter() - started) * 1000, 1)
            return {**info, "reachable": True, "tcp_rtt_ms": rtt}
        except OSError as exc:
            return {**info, "error": f"Brak połączenia TCP z {hostname}:{port}: {exc}"}

    def ship(self, target: str) -> dict[str, Any]:
        with self._lock:
            cached = self._ship_cache.get(target)
            if cached and time.monotonic() - cached[0] < self.SHIP_TTL_SEC:
                return cached[1]
        result = self._probe_ship(target)
        with self._lock:
            self._ship_cache[target] = (time.monotonic(), result)
        return result

    def _probe_ship(self, target: str) -> dict[str, Any]:
        base: dict[str, Any] = {"alias": target, "online": False, "error": None, "checked_at": _now()}
        endpoint = self.ssh_target(target)
        if not endpoint["reachable"]:
            return {**base, "error": endpoint["error"]}
        ssh = find_real_binary("ssh")
        if not ssh:
            return {**base, "error": "OpenSSH niedostępny"}
        try:
            proc = subprocess.run(
                [ssh, "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=4",
                 target, self.REMOTE_SHIP_COMMAND],
                capture_output=True, text=True, timeout=10,
            )
            if proc.returncode != 0:
                return {**base, "error": (proc.stderr or f"ssh zakończył się kodem {proc.returncode}").strip()[:300]}
            return {**base, **self.parse_remote_ship(proc.stdout), "online": True}
        except (OSError, subprocess.TimeoutExpired) as exc:
            return {**base, "error": f"Połączenie SSH nie powiodło się: {exc}"}

    @staticmethod
    def parse_remote_ship(text: str) -> dict[str, Any]:
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        out: dict[str, Any] = {
            "hostname": None,
            "kernel": None,
            "uptime_sec": None,
            "load_avg": None,
            "cores": None,
            "ram_total_mb": None,
            "ram_available_mb": None,
            "disk_free_gb": None,
        }
        if len(lines) >= 1:
            out["hostname"] = lines[0]
        if len(lines) >= 2:
            out["kernel"] = lines[1]
        for line in lines[2:]:
            parts = line.split()
            if re.fullmatch(r"\d+(\.\d+)?\s+\d+(\.\d+)?", line) and out["uptime_sec"] is None:
                out["uptime_sec"] = float(parts[0])
            elif len(parts) >= 5 and "/" in parts[3] and out["load_avg"] is None:
                out["load_avg"] = [float(v) for v in parts[:3]]
            elif re.fullmatch(r"\d+", line) and out["cores"] is None:
                out["cores"] = int(line)
            elif line.startswith("MemTotal:"):
                out["ram_total_mb"] = round(int(parts[1]) / 1024, 1)
            elif line.startswith("MemAvailable:"):
                out["ram_available_mb"] = round(int(parts[1]) / 1024, 1)
            elif len(parts) >= 6 and parts[-1] == "/":
                out["disk_free_gb"] = round(int(parts[3]) / 1024**2, 2)
        return out

    # Całość ------------------------------------------------------------------------------
    def snapshot(
        self,
        *,
        include_ship: bool,
        ollama_host: str,
        comfyui_url: str,
        ssh_target: str = "Ship",
    ) -> dict[str, Any]:
        cpu, network = self._cpu_and_network()
        memory = parse_meminfo(_read("/proc/meminfo") or "")
        return {
            "ok": True,
            "collected_at": _now(),
            "host": {
                "hostname": socket.gethostname(),
                "os": self._os_name(),
                "kernel": platform.release(),
                "architecture": platform.machine(),
                "uptime_sec": self._uptime_sec(),
                "cpu": cpu,
                "memory": memory,
                "disk": self._disk("/"),
                "network": network,
                "gpu": self.gpu(use_cache=True),
                "firewall": self.firewall(use_cache=True),
            },
            "services": self.services(ollama_host, comfyui_url),
            "ssh_target": self.ssh_target(ssh_target),
            "ship": self.ship(ssh_target) if include_ship else None,
        }
