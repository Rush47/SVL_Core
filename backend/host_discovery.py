"""
Automatyczne wykrywanie prawdziwych hostów — bez skanowania sieci.

Źródła (tylko to, co system już wie):
- sąsiedzi z tablicy ARP/NDP jądra: `ip -j neigh show` (stan REACHABLE/STALE…, IPv4 i IPv6)
  lub, gdy brak iproute2, /proc/net/arp,
- ~/.ssh/known_hosts użytkownika backendu (wpisy niezahaszowane),
- /etc/hosts.

Adresy tego samego urządzenia są łączone po MAC. Połączenie TCP jest sprawdzane wyłącznie
dla hostów ze znanym portem SSH (z known_hosts). Jądro szybko usuwa wpisy z tablicy ARP,
więc wykryte hosty są pamiętane (pierwszy/ostatnio widziany) przez `retention_sec`.
"""

from __future__ import annotations

import ipaddress
import json
import socket
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor, wait
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

try:
    from real_telemetry import find_real_binary
except ImportError:  # uruchomienie jako pakiet backend.*
    from backend.real_telemetry import find_real_binary

LIVE_NEIGHBOR_STATES = {"REACHABLE", "STALE", "DELAY", "PROBE", "PERMANENT", "NOARP", "COMPLETE"}
MAX_HOSTS = 128
MAX_TCP_PROBES = 24


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _is_listable_address(value: str) -> bool:
    try:
        ip = ipaddress.ip_address(value)
    except ValueError:
        return False
    return not (ip.is_loopback or ip.is_multicast or ip.is_link_local or ip.is_unspecified)


# --- Parsery ------------------------------------------------------------------------------


def parse_proc_net_arp(text: str) -> list[dict[str, str]]:
    entries = []
    for line in text.splitlines()[1:]:
        fields = line.split()
        if len(fields) < 6:
            continue
        address, flags, mac, interface = fields[0], fields[2], fields[3].lower(), fields[5]
        try:
            complete = int(flags, 16) & 0x2
        except ValueError:
            continue
        if not complete or mac == "00:00:00:00:00:00" or not _is_listable_address(address):
            continue
        entries.append({"address": address, "mac": mac, "interface": interface, "state": "COMPLETE"})
    return entries


def parse_ip_neigh_json(text: str) -> list[dict[str, str]]:
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return []
    entries = []
    for item in data if isinstance(data, list) else []:
        address = str(item.get("dst") or "")
        mac = str(item.get("lladdr") or "").lower()
        states = [str(s).upper() for s in item.get("state") or []]
        state = next((s for s in states if s in LIVE_NEIGHBOR_STATES), None)
        if not mac or not state or not _is_listable_address(address):
            continue
        entries.append({"address": address, "mac": mac, "interface": str(item.get("dev") or ""), "state": state})
    return entries


def parse_known_hosts(text: str) -> tuple[list[dict[str, Any]], int]:
    """Zwraca (hosty, liczba wpisów zahaszowanych — nieczytelnych bez znajomości nazwy)."""
    hosts: list[dict[str, Any]] = []
    seen: set[tuple[str, int]] = set()
    hashed = 0
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("@"):
            continue
        field = line.split()[0]
        if field.startswith("|1|"):
            hashed += 1
            continue
        for pattern in field.split(","):
            if any(ch in pattern for ch in "*?!"):
                continue
            name, port = pattern, 22
            if pattern.startswith("[") and "]:" in pattern:
                name, _, port_text = pattern[1:].partition("]:")
                try:
                    port = int(port_text)
                except ValueError:
                    continue
            if name and (name, port) not in seen:
                seen.add((name, port))
                hosts.append({"name": name, "port": port})
    return hosts, hashed


def parse_etc_hosts(text: str) -> list[dict[str, Any]]:
    entries = []
    for raw in text.splitlines():
        fields = raw.split("#", 1)[0].split()
        if len(fields) < 2 or not _is_listable_address(fields[0]):
            continue
        entries.append({"address": fields[0], "names": fields[1:]})
    return entries


# --- Rozwiązywanie nazw i pomiar (z twardym limitem czasu) --------------------------------


def _run_with_timeout(func: Any, items: Iterable[str], timeout: float) -> dict[str, Any]:
    items = list(dict.fromkeys(items))
    if not items:
        return {}
    pool = ThreadPoolExecutor(max_workers=min(16, len(items)))
    futures = {pool.submit(func, item): item for item in items}
    done, _ = wait(futures, timeout=timeout)
    # Nie czekamy na wolne zapytania DNS: wątki zakończą się same, wynik jest ignorowany.
    pool.shutdown(wait=False, cancel_futures=True)
    results = {}
    for future in done:
        try:
            value = future.result()
        except Exception:  # noqa: BLE001 — brak odpowiedzi = brak nazwy
            continue
        if value:
            results[futures[future]] = value
    return results


def reverse_dns(addresses: Iterable[str], timeout: float = 1.5) -> dict[str, str]:
    return _run_with_timeout(lambda addr: socket.gethostbyaddr(addr)[0], addresses, timeout)


def resolve_names(names: Iterable[str], timeout: float = 1.5) -> dict[str, str]:
    def resolve(name: str) -> Optional[str]:
        infos = socket.getaddrinfo(name, None, proto=socket.IPPROTO_TCP)
        return str(infos[0][4][0]) if infos else None

    return _run_with_timeout(resolve, names, timeout)


def tcp_probe(host: str, port: int, timeout: float = 2.0) -> dict[str, Any]:
    started = time.perf_counter()
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return {"reachable": True, "rtt_ms": round((time.perf_counter() - started) * 1000, 1), "error": None}
    except OSError as exc:
        return {"reachable": False, "rtt_ms": None, "error": str(exc) or exc.__class__.__name__}


# --- Wykrywanie ---------------------------------------------------------------------------


class HostDiscovery:
    def __init__(
        self,
        *,
        home: Optional[Path] = None,
        etc_hosts_path: Path = Path("/etc/hosts"),
        proc_arp_path: Path = Path("/proc/net/arp"),
        retention_sec: float = 24 * 3600,
    ) -> None:
        self.home = home
        self.etc_hosts_path = etc_hosts_path
        self.proc_arp_path = proc_arp_path
        self.retention_sec = retention_sec
        self._memory: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

    @staticmethod
    def _read(path: Path) -> Optional[str]:
        try:
            return path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return None

    def _neighbors(self) -> tuple[list[dict[str, str]], str]:
        ip_bin = find_real_binary("ip")
        if ip_bin:
            try:
                proc = subprocess.run([ip_bin, "-j", "neigh", "show"], capture_output=True, text=True, timeout=5)
                if proc.returncode == 0:
                    return parse_ip_neigh_json(proc.stdout), "ip neigh (tablica sąsiadów jądra)"
            except (OSError, subprocess.TimeoutExpired):
                pass
        return parse_proc_net_arp(self._read(self.proc_arp_path) or ""), str(self.proc_arp_path)

    def discover(self, tracked_addresses: Optional[set[str]] = None) -> dict[str, Any]:
        tracked = {a.lower() for a in (tracked_addresses or set())}
        home = self.home or Path.home()
        known_hosts_path = home / ".ssh" / "known_hosts"

        neighbors, neighbor_source = self._neighbors()
        known_text = self._read(known_hosts_path)
        known_hosts, hashed = parse_known_hosts(known_text or "")
        etc_entries = parse_etc_hosts(self._read(self.etc_hosts_path) or "")

        hosts: dict[str, dict[str, Any]] = {}
        by_address: dict[str, str] = {}

        def host_for(key: str) -> dict[str, Any]:
            if key not in hosts:
                hosts[key] = {"key": key, "addresses": [], "names": [], "mac": None, "interface": None,
                              "neighbor_state": None, "sources": [], "ssh_port": None}
            return hosts[key]

        def add(host: dict[str, Any], *, address: Optional[str] = None, name: Optional[str] = None, source: str) -> None:
            if address and address not in host["addresses"]:
                host["addresses"].append(address)
                by_address[address] = host["key"]
            if name and name not in host["names"]:
                host["names"].append(name)
            if source not in host["sources"]:
                host["sources"].append(source)

        for entry in neighbors:
            host = host_for(entry["mac"])
            host.update(mac=entry["mac"], interface=entry["interface"], neighbor_state=entry["state"])
            add(host, address=entry["address"], source="arp")

        for entry in etc_entries:
            host = host_for(by_address.get(entry["address"], entry["address"]))
            add(host, address=entry["address"], source="etc_hosts")
            for name in entry["names"]:
                add(host, name=name, source="etc_hosts")

        name_entries = [e for e in known_hosts if not _is_listable_address(e["name"])]
        resolved = resolve_names([e["name"] for e in name_entries]) if name_entries else {}
        for entry in known_hosts:
            name, port = entry["name"], entry["port"]
            if _is_listable_address(name):
                host = host_for(by_address.get(name, name))
                add(host, address=name, source="known_hosts")
            else:
                address = resolved.get(name)
                key = by_address.get(address, address or name) if address else name
                host = host_for(key)
                add(host, address=address, name=name, source="known_hosts")
            host["ssh_port"] = host["ssh_port"] or port

        unnamed = [h["addresses"][0] for h in hosts.values() if h["addresses"] and not h["names"]]
        for address, name in reverse_dns(unnamed).items():
            add(hosts[by_address[address]], name=name, source="dns")

        probe_targets = [h for h in hosts.values() if h["ssh_port"]][:MAX_TCP_PROBES]
        with ThreadPoolExecutor(max_workers=8) as pool:
            probes = list(pool.map(
                lambda h: tcp_probe(h["addresses"][0] if h["addresses"] else h["names"][0], h["ssh_port"]),
                probe_targets,
            ))
        probe_by_key = {h["key"]: p for h, p in zip(probe_targets, probes)}

        now_ts, now_iso = time.time(), _now_iso()
        with self._lock:
            for key, host in hosts.items():
                previous = self._memory.get(key)
                self._memory[key] = {
                    **host,
                    "probe": probe_by_key.get(key),
                    "first_seen": previous["first_seen"] if previous else now_iso,
                    "last_seen": now_iso,
                    "_last_seen_ts": now_ts,
                }
            for key in list(self._memory):
                if key not in hosts and now_ts - self._memory[key]["_last_seen_ts"] > self.retention_sec:
                    del self._memory[key]
            snapshot = sorted(self._memory.values(), key=lambda h: (h["_last_seen_ts"] < now_ts, h["key"]))[:MAX_HOSTS]

        result_hosts = []
        for host in snapshot:
            seen_now = host["key"] in hosts
            identifiers = {i.lower() for i in host["addresses"] + host["names"]}
            result_hosts.append({
                **{k: v for k, v in host.items() if not k.startswith("_")},
                "probe": host["probe"] if seen_now else None,
                "seen_now": seen_now,
                "tracked": bool(identifiers & tracked),
            })

        return {
            "hosts": result_hosts,
            "sources": {
                "neighbors": neighbor_source,
                "known_hosts": str(known_hosts_path) if known_text is not None else f"brak pliku {known_hosts_path}",
                "etc_hosts": str(self.etc_hosts_path),
            },
            "hashed_known_hosts": hashed,
            "retention_hours": round(self.retention_sec / 3600, 1),
        }
