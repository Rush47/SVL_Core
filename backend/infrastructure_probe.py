"""
Infrastruktura SVL — prawdziwe dane o maszynach i usługach.

Źródła: ~/.ssh/config (hosty) + pomiar połączenia TCP, systemd (`systemctl show`),
Docker (`docker ps`), porty nasłuchujące z /proc/net/tcp{,6}, punkty montowania
z /proc/mounts, hosty dodane przez operatora (moduły z `config.address`) oraz
zadania agentów z tabeli SQLite `agent_tasks`.

Gdy źródło jest niedostępne, raport zawiera powód — nigdy wartość wymyśloną.
"""

from __future__ import annotations

import json
import re
import shutil
import socket
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

try:
    from host_discovery import HostDiscovery
    from real_telemetry import disk_used_percent, find_real_binary
except ImportError:  # uruchomienie jako pakiet backend.*
    from backend.host_discovery import HostDiscovery
    from backend.real_telemetry import disk_used_percent, find_real_binary

SVL_SYSTEMD_UNITS = ("svl-python-os", "svl-comfyui", "svl-codex-mcp", "ollama", "ssh")
KNOWN_PORTS = {
    22: "SSH",
    80: "HTTP",
    443: "HTTPS",
    3000: "SVL Gateway",
    5432: "PostgreSQL",
    6379: "Redis",
    8085: "SVL Python Kernel",
    8188: "ComfyUI",
    11434: "Ollama",
}
REAL_FILESYSTEMS = {"ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "f2fs", "vfat", "exfat", "ntfs", "ntfs3", "fuseblk"}
MAX_PROBED_HOSTS = 24
_HOST_RE = re.compile(r"^[A-Za-z0-9._:-]{1,253}$")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# --- Parsery ------------------------------------------------------------------------------


def parse_ssh_config(text: str) -> list[dict[str, Any]]:
    """Konkretne aliasy z ~/.ssh/config (bez wzorców *, ?, !) z HostName/Port/User."""
    hosts: list[dict[str, Any]] = []
    current: list[dict[str, Any]] = []
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        key, _, value = line.partition(" ") if " " in line else line.partition("=")
        key, value = key.strip().lower(), value.strip().lstrip("=").strip()
        if key == "host":
            current = []
            for alias in value.split():
                if any(ch in alias for ch in "*?!"):
                    continue
                entry = {"alias": alias, "hostname": alias, "port": 22, "user": None}
                hosts.append(entry)
                current.append(entry)
        elif key == "match":
            current = []
        elif current and key == "hostname":
            for entry in current:
                entry["hostname"] = value
        elif current and key == "port":
            try:
                for entry in current:
                    entry["port"] = int(value)
            except ValueError:
                pass
        elif current and key == "user":
            for entry in current:
                entry["user"] = value
    return hosts


def _decode_proc_address(hex_addr: str) -> tuple[str, int]:
    ip_hex, port_hex = hex_addr.split(":")
    port = int(port_hex, 16)
    raw = bytes.fromhex(ip_hex)
    if len(raw) == 4:
        return socket.inet_ntop(socket.AF_INET, raw[::-1]), port
    # IPv6 w /proc jest zapisany jako cztery 32-bitowe słowa little-endian.
    words = b"".join(raw[i:i + 4][::-1] for i in range(0, 16, 4))
    return socket.inet_ntop(socket.AF_INET6, words), port


def parse_listening_ports(tcp_text: str, tcp6_text: str = "") -> list[dict[str, Any]]:
    seen: set[tuple[str, int]] = set()
    ports: list[dict[str, Any]] = []
    for text in (tcp_text, tcp6_text):
        for line in text.splitlines()[1:]:
            fields = line.split()
            if len(fields) < 4 or fields[3] != "0A":  # 0A = LISTEN
                continue
            try:
                address, port = _decode_proc_address(fields[1])
            except (ValueError, OSError):
                continue
            if (address, port) in seen:
                continue
            seen.add((address, port))
            ports.append({"address": address, "port": port, "service": KNOWN_PORTS.get(port)})
    return sorted(ports, key=lambda p: (p["port"], p["address"]))


def parse_mounts(text: str) -> list[dict[str, str]]:
    mounts: list[dict[str, str]] = []
    seen_devices: set[str] = set()
    for line in text.splitlines():
        fields = line.split()
        if len(fields) < 3:
            continue
        device, mountpoint, fstype = fields[0], fields[1].replace("\\040", " "), fields[2]
        is_container_root = fstype == "overlay" and mountpoint == "/"
        if fstype not in REAL_FILESYSTEMS and not is_container_root:
            continue
        if device in seen_devices:
            continue
        seen_devices.add(device)
        mounts.append({"device": device, "mountpoint": mountpoint, "fstype": fstype})
    return mounts


def parse_address(value: str) -> Optional[tuple[str, int]]:
    """'host:port' lub '[ipv6]:port' → (host, port); None gdy nieprawidłowy."""
    text = str(value or "").strip()
    match = re.fullmatch(r"\[([0-9A-Fa-f:]+)\]:(\d{1,5})", text) or re.fullmatch(r"([^\s:\[\]]+):(\d{1,5})", text)
    if not match:
        return None
    host, port = match.group(1), int(match.group(2))
    if not (1 <= port <= 65535) or not _HOST_RE.fullmatch(host):
        return None
    return host, port


def parse_systemctl_show(text: str) -> dict[str, Any]:
    values = dict(line.split("=", 1) for line in text.splitlines() if "=" in line)
    try:
        pid: Optional[int] = int(values.get("MainPID", "0")) or None
    except ValueError:
        pid = None
    return {
        "load_state": values.get("LoadState"),
        "active_state": values.get("ActiveState"),
        "sub_state": values.get("SubState"),
        "main_pid": pid,
        "active_since": values.get("ActiveEnterTimestamp") or None,
    }


def parse_docker_ps(text: str) -> list[dict[str, str]]:
    containers = []
    for line in text.splitlines():
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        containers.append({
            "name": str(item.get("Names", "")),
            "image": str(item.get("Image", "")),
            "state": str(item.get("State", "")),
            "status": str(item.get("Status", "")),
        })
    return containers


# --- Sondy --------------------------------------------------------------------------------


def tcp_probe(host: str, port: int, timeout: float = 2.0) -> dict[str, Any]:
    started = time.perf_counter()
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return {"reachable": True, "rtt_ms": round((time.perf_counter() - started) * 1000, 1), "error": None}
    except OSError as exc:
        return {"reachable": False, "rtt_ms": None, "error": str(exc) or exc.__class__.__name__}


def ssh_config_hosts() -> dict[str, Any]:
    path = Path.home() / ".ssh" / "config"
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return {"source": str(path), "hosts": [], "reason": f"Brak pliku {path} dla użytkownika backendu."}
    except OSError as exc:
        return {"source": str(path), "hosts": [], "reason": f"Nie można odczytać {path}: {exc}"}
    hosts = parse_ssh_config(text)[:MAX_PROBED_HOSTS]
    with ThreadPoolExecutor(max_workers=8) as pool:
        probes = list(pool.map(lambda h: tcp_probe(h["hostname"], h["port"]), hosts))
    return {
        "source": str(path),
        "hosts": [{**host, "probe": result} for host, result in zip(hosts, probes)],
        "reason": None if hosts else "Plik nie zawiera konkretnych aliasów Host.",
    }


def systemd_units(units: tuple[str, ...] = SVL_SYSTEMD_UNITS) -> dict[str, Any]:
    systemctl = find_real_binary("systemctl")
    if not systemctl:
        return {"available": False, "units": [], "reason": "Brak polecenia systemctl na hoście backendu."}
    if not Path("/run/systemd/system").is_dir():
        return {"available": False, "units": [], "reason": "systemd nie jest menedżerem usług na tym hoście (np. kontener)."}
    results = []
    for unit in units:
        try:
            proc = subprocess.run(
                [systemctl, "show", f"{unit}.service", "-p", "LoadState,ActiveState,SubState,MainPID,ActiveEnterTimestamp"],
                capture_output=True, text=True, timeout=5,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            results.append({"unit": unit, "error": str(exc)})
            continue
        info = parse_systemctl_show(proc.stdout)
        if info["load_state"] == "not-found":
            continue
        results.append({"unit": unit, **info, "error": None if proc.returncode == 0 else (proc.stderr or "").strip()[:200]})
    return {"available": True, "units": results, "reason": None if results else "Żadna z usług SVL nie jest zainstalowana w systemd."}


def docker_containers() -> dict[str, Any]:
    docker = find_real_binary("docker")
    if not docker:
        return {"available": False, "containers": [], "reason": "Docker nie jest zainstalowany na hoście backendu."}
    try:
        proc = subprocess.run([docker, "ps", "-a", "--format", "{{json .}}"], capture_output=True, text=True, timeout=6)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"available": False, "containers": [], "reason": f"docker ps nie odpowiedział: {exc}"}
    if proc.returncode != 0:
        return {"available": False, "containers": [], "reason": (proc.stderr or "docker ps zwrócił błąd").strip()[:300]}
    return {"available": True, "containers": parse_docker_ps(proc.stdout), "reason": None}


def _read(path: str) -> str:
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def mounts_with_usage() -> list[dict[str, Any]]:
    out = []
    for mount in parse_mounts(_read("/proc/mounts")):
        try:
            usage = shutil.disk_usage(mount["mountpoint"])
        except OSError as exc:
            out.append({**mount, "error": str(exc)})
            continue
        out.append({
            **mount,
            "total_gb": round(usage.total / 1024**3, 2),
            "free_gb": round(usage.free / 1024**3, 2),
            "percent": disk_used_percent(usage),
            "error": None,
        })
    return out


def monitored_hosts(kernel: Any) -> list[dict[str, Any]]:
    """Moduły kategorii 'infrastructure'. Pomiar tylko dla tych, które mają `config.address`."""
    modules = [
        m for m in kernel.list_system_modules()
        if isinstance(m.get("config"), dict) and m["config"].get("category") == "infrastructure"
    ]

    def check(module: dict[str, Any]) -> dict[str, Any]:
        address = module["config"].get("address")
        parsed = parse_address(address) if address else None
        base = {"id": module["id"], "name": module.get("name") or module["id"], "status": module.get("status"),
                "address": address, "probe": None, "note": None}
        if not address:
            return {**base, "note": "Brak adresu host:port — nie ma czego mierzyć (wpis z danymi opisowymi)."}
        if not parsed:
            return {**base, "note": f"Nieprawidłowy adres: {address}"}
        return {**base, "probe": tcp_probe(*parsed)}

    with ThreadPoolExecutor(max_workers=8) as pool:
        return list(pool.map(check, modules[:MAX_PROBED_HOSTS]))


def recent_agent_tasks(kernel: Any, limit: int = 20) -> list[dict[str, Any]]:
    def _read_tasks(conn: Any) -> list[dict[str, Any]]:
        try:
            rows = conn.execute(
                "SELECT id, target_agent, title, status, error, created_at, started_at, completed_at "
                "FROM agent_tasks ORDER BY created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        except Exception:  # tabela tworzona przez orkiestrator; może jeszcze nie istnieć
            return []
        return [dict(row) for row in rows]

    return kernel.run_db(_read_tasks, write=False)


# Jedna instancja na proces: pamięta wykryte hosty między odświeżeniami.
DEFAULT_DISCOVERY = HostDiscovery()


def build_infrastructure_report(kernel: Any, discovery: Optional[HostDiscovery] = None) -> dict[str, Any]:
    with ThreadPoolExecutor(max_workers=4) as pool:
        ssh_future = pool.submit(ssh_config_hosts)
        systemd_future = pool.submit(systemd_units)
        docker_future = pool.submit(docker_containers)
        monitored_future = pool.submit(monitored_hosts, kernel)
        ssh_hosts, monitored = ssh_future.result(), monitored_future.result()
        tracked = {h["alias"] for h in ssh_hosts["hosts"]} | {h["hostname"] for h in ssh_hosts["hosts"]}
        for item in monitored:
            parsed = parse_address(item["address"]) if item["address"] else None
            if parsed:
                tracked.add(parsed[0])
        return {
            "ok": True,
            "collected_at": _now(),
            "hostname": socket.gethostname(),
            "ssh_hosts": ssh_hosts,
            "monitored": monitored,
            "discovered": (discovery or DEFAULT_DISCOVERY).discover(tracked_addresses=tracked),
            "systemd": systemd_future.result(),
            "docker": docker_future.result(),
            "listening_ports": parse_listening_ports(_read("/proc/net/tcp"), _read("/proc/net/tcp6")),
            "mounts": mounts_with_usage(),
            "tasks": recent_agent_tasks(kernel),
        }
