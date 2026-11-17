#!/usr/bin/env python3
"""
SVL-364 — mostek SSH i serwer MCP (JSON-RPC 2.0) do obsługi hosta Linux.

1. Mostek SSH: polecenia zatwierdzone przez operatora są wykonywane przez prawdziwy
   OpenSSH na hoście z aliasu `SVL_SSH_TARGET` (konfiguracja ~/.ssh/config procesu).
   Gdy OpenSSH nie jest zainstalowany lub host jest nieosiągalny, zwracany jest błąd —
   polecenie nigdy nie jest wykonywane lokalnie.
2. Serwer MCP z narzędziami: prawdziwa telemetria, wykonanie SSH (tylko z potwierdzeniem),
   raport systemu.
3. Narzędzia CLI `svl364-ssh` oraz `svl364-mcp` (klienci API backendu).
"""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

try:
    from real_telemetry import RealTelemetryCollector, find_real_binary, remove_legacy_fake_wrappers
except ImportError:  # uruchomienie jako pakiet backend.*
    from backend.real_telemetry import RealTelemetryCollector, find_real_binary, remove_legacy_fake_wrappers


# Pola fikcyjnego "stanu statku" z poprzednich wersji (sektor, orbita, reaktor, tarcze...).
# Nie odpowiadały żadnemu pomiarowi, więc są usuwane z zapisanej konfiguracji.
FICTIONAL_SHIP_KEYS = (
    "ship_sector", "ship_orbit_km", "ship_speed_kms", "ship_reactor_gw",
    "ship_shields_percent", "ship_heading", "defense_posture",
)
REMOVED_FICTIONAL_TOOLS = {
    "svl364_starship_helm": "nawigacja statku",
    "svl364_tactical_shields": "tarcze i reaktor",
    "svl364_fleet_botany_control": "botanika i O2",
}

MCP_TOOLS_CATALOG: list[dict[str, Any]] = [
    {
        "name": "svl364_ssh_exec",
        "description": (
            "Wykonywanie zdalnych poleceń jest dostępne wyłącznie w interaktywnym terminalu SSH "
            "po potwierdzeniu operatora; wywołania MCP/AI nie mogą uruchamiać poleceń."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "Polecenie powłoki Linux do wykonania na statku SVL-364 (np. 'uname -a && free -m').",
                },
                "timeout_sec": {
                    "type": "number",
                    "description": "Maksymalny czas wykonania w sekundach (domyślnie 15).",
                },
            },
            "required": ["command"],
        },
    },
    {
        "name": "svl364_linux_telemetry",
        "description": (
            "Zwraca prawdziwą telemetrię hosta backendu (CPU z /proc/stat, RAM, dysk, sieć, GPU z nvidia-smi, "
            "stan zapory ufw) oraz osiągalność usług i hosta SSH. Nie wykonuje poleceń zdalnych."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {

            },
        },
    },
    {
        "name": "svl364_emit_system_report",
        "description": (
            "Generuje raport SVL_System na potrzeby Bielika (ROOT)."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "directive": {
                    "type": "string",
                    "description": "Tytuł lub dyrektywa raportu operacyjnego.",
                },
            },
        },
    },
]


def format_telemetry_summary(snap: dict[str, Any]) -> str:
    """Czytelne podsumowanie prawdziwej telemetrii (bez wartości szacowanych)."""
    host = snap["host"]
    cpu, mem, disk, gpu, fw = host["cpu"], host["memory"], host["disk"], host["gpu"], host["firewall"]
    na = "brak danych"
    lines = [
        f"[MCP · svl364_linux_telemetry] Telemetria hosta {host['hostname']} ({snap['collected_at']}):",
        f"• System: {host['os'] or na} · jądro {host['kernel']} · {host['architecture']} · uptime {host['uptime_sec'] or na} s",
        f"• CPU: {cpu['percent'] if cpu['percent'] is not None else na}% · {cpu['cores']} rdz. · {cpu['model'] or na}"
        f" · load {cpu['load_avg'] or na}",
        f"• RAM: {mem['ram_used_mb'] if mem['ram_used_mb'] is not None else na} / {mem['ram_total_mb'] or na} MB"
        f" · dysk wolne {disk.get('free_gb', na)} GB",
        "• GPU: " + ("; ".join(
            f"{d['name']} {d['utilization_percent']}% · {d['memory_used_mb']}/{d['memory_total_mb']} MB · {d['temperature_c']}°C"
            for d in gpu["devices"]) if gpu["available"] else str(gpu["reason"])),
        f"• Zapora ({fw['tool']}): {fw['state']}" + (f" — {fw['detail']}" if fw.get("detail") else ""),
    ]
    ollama = snap["services"]["ollama"]
    lines.append(
        "• Ollama: " + (
            ("zastępnik wbudowany (nie prawdziwa Ollama)" if ollama["synthetic"] else f"v{ollama['version']}")
            + f" · {ollama['latency_ms']} ms" if ollama["reachable"] else f"niedostępna ({ollama['error']})"
        )
    )
    target = snap["ssh_target"]
    lines.append(
        f"• Host SSH `{target['alias']}`: "
        + (f"{target['hostname']}:{target['port']} osiągalny, TCP {target['tcp_rtt_ms']} ms" if target["reachable"]
           else f"nieosiągalny ({target['error']})")
    )
    return "\n".join(lines)


class SVL364SshMcpController:
    """Zarządza połączeniem SSH oraz serwerem MCP do sterowania statkiem SVL-364 w Linuxie."""

    def __init__(self, kernel: Any) -> None:
        self.kernel = kernel
        self.project_root = Path(__file__).resolve().parent.parent
        self.ssh_connected = False
        self.recent_activity: list[dict[str, Any]] = []
        self.ssh_sessions_count = 0
        self.mcp_calls_count = 0
        self.telemetry = RealTelemetryCollector()

        self._install_cli_wrappers()
        self._ensure_module_in_sqlite()

    def _install_cli_wrappers(self) -> None:
        bin_dir = Path(__file__).resolve().parent / "bin"
        bin_dir.mkdir(parents=True, exist_ok=True)
        # Poprzednie wersje instalowały fałszywe `ssh` (wykonujące polecenia lokalnie) oraz
        # `ufw`/`sudo` udające aktywną zaporę. Usuwamy wyłącznie pliki o tej dokładnej treści.
        remove_legacy_fake_wrappers([bin_dir, Path("/usr/local/bin")])

        ssh_script = """#!/usr/bin/env python3
import json, os, sys, urllib.request

cmd = " ".join(sys.argv[1:]).strip()
if not cmd:
    cmd = "id && uname -a && uptime && free -m"
req = urllib.request.Request(
    "http://127.0.0.1:8085/api/py/svl364/ssh/exec",
    data=json.dumps({"command": cmd, "confirmed": True, "origin": "svl364-ssh-cli"}).encode("utf-8"),
    headers={"Content-Type": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=20) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
        sys.stdout.write(payload.get("output") or "")
        if not (payload.get("output") or "").endswith("\\n"):
            sys.stdout.write("\\n")
        sys.exit(int(payload.get("exitCode") or 0))
except Exception as exc:
    sys.stderr.write(f"svl364-ssh error: {exc}\\n")
    sys.exit(1)
"""
        mcp_script = """#!/usr/bin/env python3
import json, sys, urllib.request

args = sys.argv[1:]
tool_name = args[0] if args else "svl364_linux_telemetry"
tool_args = {}
if len(args) > 1:
    raw = " ".join(args[1:]).strip()
    if raw.startswith("{"):
        try:
            tool_args = json.loads(raw)
        except Exception:
            tool_args = {"command": raw}
    else:
        tool_args = {"command": raw}

rpc_body = {
    "jsonrpc": "2.0",
    "id": "cli-1",
    "method": "tools/call",
    "params": {"name": tool_name, "arguments": tool_args},
}
req = urllib.request.Request(
    "http://127.0.0.1:8085/api/py/svl364/mcp",
    data=json.dumps(rpc_body).encode("utf-8"),
    headers={"Content-Type": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=20) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
        print(json.dumps(payload, ensure_ascii=False, indent=2))
except Exception as exc:
    sys.stderr.write(f"svl364-mcp error: {exc}\\n")
    sys.exit(1)
"""
        for name, content in (("svl364-ssh", ssh_script), ("svl364-mcp", mcp_script)):
            local_target = bin_dir / name
            try:
                local_target.write_text(content, encoding="utf-8")
                os.chmod(local_target, 0o755)
            except OSError:
                pass
            usr_target = Path("/usr/local/bin") / name
            try:
                usr_target.write_text(content, encoding="utf-8")
                os.chmod(usr_target, 0o755)
            except OSError:
                pass

        current_path = os.environ.get("PATH", "")
        if str(bin_dir) not in current_path.split(os.pathsep):
            os.environ["PATH"] = f"{bin_dir}{os.pathsep}{current_path}"

    def _default_config(self) -> dict[str, Any]:
        return {
            "ssh_enabled": True,
            "ssh_host": os.environ.get("SVL_SSH_TARGET", "Ship").strip() or "Ship",
            "ssh_port": 22,
            "ssh_user": "from OpenSSH config",
            "ssh_mode": "openssh-config",
            "mcp_enabled": True,
            "mcp_server_name": "svl-364-linux-control-mcp",
            "mcp_protocol_version": "2025-03-26",
            "mcp_transport": "Streamable HTTP JSON-RPC 2.0 + Local CLI",
            "mcp_endpoint": "/api/mcp/svl364",
            "mcp_tools_count": len(MCP_TOOLS_CATALOG),
            "connected_at": datetime.now(timezone.utc).isoformat(),
        }

    @staticmethod
    def _configured_ssh_target(config: dict[str, Any]) -> str:
        target = str(
            os.environ.get("SVL_SSH_TARGET")
            or config.get("ssh_host")
            or "Ship"
        ).strip()
        if target in {"svl-364-ship.qkd.mesh", "svl-364-ship"}:
            target = "Ship"
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._@:-]{0,252}", target):
            raise ValueError("SVL_SSH_TARGET must be an OpenSSH alias or user@host.")
        return target

    def _ensure_module_in_sqlite(self) -> None:
        mods = {m["id"]: m for m in self.kernel.list_system_modules()}
        existing = mods.get("svl-364-ssh-mcp")
        cfg = self._default_config()
        if existing and isinstance(existing.get("config"), dict):
            merged = dict(cfg)
            merged.update(existing["config"])
            merged["ssh_host"] = self._configured_ssh_target(merged)
            merged["ssh_mode"] = "openssh-config"
            for key in ("ssh_key_path", "ssh_pub_key_path", "ssh_fingerprint", "ssh_cipher", *FICTIONAL_SHIP_KEYS):
                merged.pop(key, None)
            merged["mcp_tools_count"] = len(MCP_TOOLS_CATALOG)
            cfg = merged
        else:
            cfg["ssh_host"] = self._configured_ssh_target(cfg)

        self.kernel.upsert_system_module(
            module_id="svl-364-ssh-mcp",
            name="SVL-364 Mostek SSH & Serwer MCP (Linux Control)",
            kind="Starship SSH & MCP Bridge",
            status="ACTIVE",
            description=(
                f"Ręcznie zatwierdzane polecenia przez OpenSSH host alias {cfg['ssh_host']}; "
                "uwierzytelnianie i klucze pochodzą z konfiguracji OpenSSH procesu."
            ),
            config=cfg,
            source="kernel",
            origin="svl364-ssh-mcp-init",
        )

        # Zsynchronizuj również główny moduł svl-364
        svl364 = mods.get("svl-364")
        if svl364:
            scfg = dict(svl364.get("config") or {})
            scfg["ssh_bridge_active"] = True
            scfg["ssh_endpoint"] = f"ssh://{cfg['ssh_host']}"
            scfg.pop("ssh_fingerprint", None)
            scfg["mcp_bridge_active"] = True
            scfg["mcp_endpoint"] = "/api/mcp/svl364"
            scfg["mcp_tools"] = [t["name"] for t in MCP_TOOLS_CATALOG]
            self.kernel.upsert_system_module(
                module_id="svl-364",
                name=svl364.get("name") or "SVL-364 Ebon Apex — Centrum Dowodzenia",
                kind=svl364.get("kind") or "Starship Command & Telemetry",
                status="ACTIVE",
                description=svl364.get("description") or "",
                config=scfg,
                source=svl364.get("source") or "kernel",
                origin="svl364-ssh-mcp-sync",
            )

    def configured_target(self) -> str:
        """Alias hosta statku z konfiguracji modułu (bez sondowania sieci)."""
        mods = {m["id"]: m for m in self.kernel.list_system_modules()}
        cfg = dict(self._default_config())
        mod_cfg = (mods.get("svl-364-ssh-mcp") or {}).get("config")
        if isinstance(mod_cfg, dict):
            cfg.update(mod_cfg)
        return self._configured_ssh_target(cfg)

    def get_status(self) -> dict[str, Any]:
        mods = {m["id"]: m for m in self.kernel.list_system_modules()}
        mod = mods.get("svl-364-ssh-mcp") or {}
        cfg = dict(self._default_config())
        if isinstance(mod.get("config"), dict):
            cfg.update(mod["config"])
        target = self._configured_ssh_target(cfg)
        ssh_bin = find_real_binary("ssh")
        ssh_cfg_exists = (Path.home() / ".ssh" / "config").is_file()
        telemetry = getattr(self, "telemetry", None)
        target_probe = (
            telemetry.ssh_target(target)
            if telemetry is not None
            else {"reachable": False, "error": "OpenSSH nie jest skonfigurowany" if not ssh_bin else None}
        )
        return {
            "ok": True,
            "moduleId": "svl-364-ssh-mcp",
            "status": "ACTIVE",
            "ssh": {
                "connected": self.ssh_connected,
                "sshInstalled": bool(ssh_bin),
                "sshBinaryPath": ssh_bin,
                "sshConfigExists": ssh_cfg_exists,
                "targetReachable": bool(target_probe.get("reachable")),
                "targetError": target_probe.get("error"),
                "host": target,
                "mode": "OpenSSH config/agent",
                "authentication": "OpenSSH config/agent",
                "connectionUri": f"ssh://{target}",
                "uri": f"ssh://{target}",
                "cliCommand": f"ssh {target}",
                "sessionsCount": self.ssh_sessions_count,
                "invocations_count": self.ssh_sessions_count,
            },
            "mcp": {
                "active": True,
                "serverName": "svl-364-linux-control-mcp",
                "protocolVersion": "2025-03-26",
                "endpoint": "/api/mcp/svl364",
                "pythonEndpoint": "/api/py/svl364/mcp",
                "transport": "Streamable HTTP JSON-RPC 2.0",
                "tools": MCP_TOOLS_CATALOG,
                "callsCount": self.mcp_calls_count,
                "invocations_count": self.mcp_calls_count,
                "clientConfigExample": {
                    "mcpServers": {
                        "svl-364-ebon-apex": {
                            "url": "http://127.0.0.1:3000/api/mcp/svl364",
                            "transport": "streamable-http",
                        }
                    }
                },
            },
            "recentActivity": self.recent_activity[-20:][::-1],
            "serverRevision": self.kernel.get_server_revision(),
        }

    def update_config(
        self,
        updates: dict[str, Any],
        origin: str = "operator",
        correlation_id: str = "",
        **kwargs: Any,
    ) -> dict[str, Any]:
        mods = {m["id"]: m for m in self.kernel.list_system_modules()}
        mod = mods.get("svl-364-ssh-mcp") or {}
        cfg = dict(self._default_config())
        if isinstance(mod.get("config"), dict):
            cfg.update(mod["config"])

        for key in (
            "ssh_host",
            "ssh_port",
            "ssh_user",
            "ssh_mode",
        ):
            if key in updates and updates[key] is not None:
                cfg[key] = updates[key]

        cfg["ssh_host"] = self._configured_ssh_target(cfg)
        cfg["ssh_mode"] = "openssh-config"
        if "ssh_port" in cfg:
            try:
                cfg["ssh_port"] = max(1, min(65535, int(cfg["ssh_port"])))
            except (TypeError, ValueError):
                cfg["ssh_port"] = 22
        for key in ("ssh_key_path", "ssh_pub_key_path", "ssh_fingerprint", "ssh_cipher", *FICTIONAL_SHIP_KEYS):
            cfg.pop(key, None)
        cfg["updated_at"] = datetime.now(timezone.utc).isoformat()
        self.telemetry._ssh_target_cache.clear()
        self.telemetry._ship_cache.clear()
        self.kernel.upsert_system_module(
            module_id="svl-364-ssh-mcp",
            name="SVL-364 Mostek SSH & Serwer MCP (Linux Control)",
            kind="Starship SSH & MCP Bridge",
            status="ACTIVE",
            description=(
                f"Ręcznie zatwierdzane polecenia przez OpenSSH host alias {cfg['ssh_host']}."
            ),
            config=cfg,
            source="operator",
            origin=origin,
            correlation_id=correlation_id,
        )
        return self.get_status()

    @staticmethod
    def _parse_ssh_ship_input(raw_cmd: str) -> tuple[bool, str, str, Optional[str]]:
        """
        Zwraca (is_explicit_exec, mode: 'shell'|'natural', shell_cmd, natural_directive).
        Obsługuje `/exec <dowolne polecenie>`, `/root <dowolne polecenie>`, dowolne polecenia
        w języku naturalnym oraz bezpośrednie komendy powłoki Linux z uprawnieniami root.
        """
        trimmed = str(raw_cmd or "").strip()
        is_explicit_exec = bool(re.match(r"^/(?:exec|root)(?:\s+|$)", trimmed, flags=re.IGNORECASE))
        stripped = re.sub(r"^/(?:exec|root)\s*", "", trimmed, flags=re.IGNORECASE).strip()
        if not stripped:
            return is_explicit_exec, "shell", "id && uname -a && uptime && free -m", None

        known_shell_bins = {
            "id", "whoami", "uname", "hostname", "uptime", "free", "df", "du", "ls", "ll",
            "pwd", "cd", "cat", "head", "tail", "grep", "egrep", "fgrep", "awk", "sed",
            "find", "ps", "top", "htop", "ip", "ss", "netstat", "ping", "curl", "wget",
            "ssh", "scp", "sudo", "su", "ufw", "iptables", "systemctl", "service",
            "journalctl", "dmesg", "env", "printenv", "export", "echo", "printf", "date",
            "cal", "wc", "sort", "uniq", "tr", "cut", "chmod", "chown", "mkdir", "rm",
            "cp", "mv", "touch", "ln", "tar", "gzip", "gunzip", "zip", "unzip", "python",
            "python3", "pip", "pip3", "node", "npm", "npx", "git", "ollama", "sqlite3",
            "svl364-ssh", "svl364-mcp", "svl-db", "which", "whereis", "file", "stat",
            "lscpu", "lsblk", "lspci", "lsusb", "vmstat", "iostat", "ulimit", "kill",
            "pkill", "pgrep", "nohup", "true", "false", "test", "[", "bash", "sh", "zsh",
        }
        natural_starters = {
            "sprawdź", "sprawdz", "pokaż", "pokaz", "wyświetl", "wyswietl", "ustaw",
            "uruchom", "włącz", "wlacz", "wyłącz", "wylacz", "stwórz", "stworz",
            "utwórz", "utworz", "dodaj", "usuń", "usun", "napraw", "zaktualizuj",
            "synchronizuj", "wyślij", "wyslij", "przeskanuj", "skanuj", "zbadaj",
            "podaj", "jaki", "jaka", "jakie", "czy", "ile", "gdzie", "dlaczego",
            "opisz", "wyjaśnij", "wyjasnij", "przetwórz", "przetworz", "daj",
            "nadaj", "połącz", "polacz", "zresetuj", "raport", "telemetria",
            "diagnostyka", "pomoc", "wykonaj", "zrób", "zrob", "aktywuj", "odblokuj",
            "zablokuj", "przełącz", "przelacz", "skieruj", "leć", "lec", "kurs",
            "tarcze", "reaktor", "statek", "maya", "bielik", "check", "show", "report",
        }

        words = stripped.split()
        first_word = (words[0] if words else "").lower().rstrip(":,;.!?")
        has_diacritics = bool(re.search(r"[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]", stripped))
        has_shell_syntax = bool(re.search(r"[|&;><$`=]", stripped)) or stripped.startswith(("/bin/", "/usr/", "./", "../"))

        is_natural = (
            first_word in natural_starters
            or first_word in {"/pomoc", "/help", "/status", "/raport"}
            or (has_diacritics and first_word not in {"echo", "printf", "grep", "sqlite3", "python", "python3", "curl"})
            or (first_word not in known_shell_bins and not has_shell_syntax and len(words) >= 2)
        )

        if not is_natural:
            return is_explicit_exec, "shell", stripped, None

        low = stripped.lower()
        synthesized = "id && hostname && uname -srm && uptime && free -m && df -h /"
        if any(k in low for k in ("ufw", "zapor", "firewall", "port", "sieć", "siec", "ip", "qkd")):
            synthesized = "id && hostname && ufw status && ip -br addr"
        elif any(k in low for k in ("proces", "worker", "daemon", "cpu", "obciążen", "obciazen", "top", "ps")):
            synthesized = "id && ps -eo pid,user,comm,%cpu,%mem --sort=-%cpu | head -n 12"
        elif any(k in low for k in ("dysk", "miejsc", "plik", "katalog", "storage")):
            synthesized = "id && df -h / && ls -la"
        elif any(k in low for k in ("pamięć", "pamiec", "ram", "swap")):
            synthesized = "id && free -m && uname -srm"
        elif any(k in low for k in ("ollama", "model", "vision")):
            synthesized = "id && ollama --version && ollama list"
        elif any(k in low for k in ("baz", "sqlite", "moduł", "modul", "notatk", "prac", "maya", "bielik")):
            synthesized = 'id && sqlite3 data/svl_os.sqlite3 "SELECT id, status, revision FROM system_modules ORDER BY revision DESC LIMIT 10;"'

        return is_explicit_exec, "natural", synthesized, stripped

    def execute_ssh_command(
        self,
        command: str,
        timeout_sec: float = 15.0,
        origin: str = "ssh-bridge",
        target_subsystem: str = "bridge",
        correlation_id: str = "",
        confirmed: bool = False,
        **kwargs: Any,
    ) -> dict[str, Any]:
        clean_cmd = str(command or "").strip()
        if not confirmed:
            message = "Wykonanie SSH wymaga jawnego potwierdzenia w terminalu operatora."
            return {"ok": False, "error": message, "exitCode": 1, "output": "", "stdout": "", "stderr": message}
        if not clean_cmd:
            return {
                "ok": False,
                "error": "Polecenie SSH nie może być puste.",
                "exitCode": 1,
                "output": "",
                "stdout": "",
                "stderr": "Polecenie SSH nie może być puste.",
            }

        is_explicit_exec, cmd_mode, effective_shell_cmd, natural_directive = self._parse_ssh_ship_input(clean_cmd)

        mods = {m["id"]: m for m in self.kernel.list_system_modules()}
        cfg = dict(self._default_config())
        if "svl-364-ssh-mcp" in mods and isinstance(mods["svl-364-ssh-mcp"].get("config"), dict):
            cfg.update(mods["svl-364-ssh-mcp"]["config"])

        natural_summary_lines: list[str] = []
        if cmd_mode == "natural" and natural_directive:
            natural_summary_lines = [f"Przetworzono polecenie naturalne: {natural_directive}"]

        ssh_host = self._configured_ssh_target(cfg)
        # Tylko prawdziwy OpenSSH; nigdy nie wykonujemy polecenia lokalnie zamiast zdalnie.
        ssh_bin = find_real_binary("ssh")
        if not ssh_bin:
            message = (
                f"OpenSSH (`ssh`) nie jest zainstalowany na hoście backendu (cel: ssh://{ssh_host}) — "
                "polecenie zdalne nie zostało wykonane. Zainstaluj pakiet `openssh-client` lub użyj zakładki `Powłoka Linux (ROOT)` dla poleceń lokalnych."
            )
            return {
                "ok": False,
                "error": message,
                "exitCode": 127,
                "output": "",
                "stdout": "",
                "stderr": message,
                "sshEndpoint": f"ssh://{ssh_host}",
                "ssh_status": self.get_status(),
                "serverRevision": self.kernel.get_server_revision(),
            }

        self.ssh_sessions_count += 1
        started = time.time()

        stderr_out = ""
        try:
            proc = subprocess.run(
                [
                    ssh_bin,
                    "-T",
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "StrictHostKeyChecking=yes",
                    "-o",
                    "ConnectTimeout=10",
                    ssh_host,
                    f"/bin/bash -lc {shlex.quote(effective_shell_cmd)}",
                ],
                cwd=str(self.project_root),
                env=os.environ.copy(),
                capture_output=True,
                text=True,
                timeout=max(2.0, min(60.0, float(timeout_sec or 15.0))),
            )
            stdout = (proc.stdout or "").strip()
            stderr_out = (proc.stderr or "").strip()
            combined = "\n".join(part for part in (stdout, stderr_out) if part).strip()
            if not combined:
                combined = f"[SSH {ssh_host}] Polecenie zakończone kodem {proc.returncode}."
            exit_code = int(proc.returncode)
            self.ssh_connected = exit_code != 255
        except subprocess.TimeoutExpired:
            combined = f"[SSH {ssh_host}] Przekroczono limit czasu ({timeout_sec}s)."
            stderr_out = combined
            exit_code = 124
            self.ssh_connected = False
        except Exception as exc:
            combined = f"[SSH {ssh_host}] Błąd wykonania: {exc}"
            stderr_out = combined
            exit_code = 1
            self.ssh_connected = False

        if natural_summary_lines:
            combined = "\n".join(natural_summary_lines) + f"\n$ {effective_shell_cmd}\n{combined}"

        duration_ms = round((time.time() - started) * 1000, 1)
        mode_tag = "ROOT /exec" if is_explicit_exec else ("Natural AI ROOT" if cmd_mode == "natural" else "OpenSSH config/agent")
        header = (
            f"[SSH · {target_subsystem}] {ssh_host} ({mode_tag}) · {duration_ms} ms"
        )
        formatted_output = f"{header}\n$ {clean_cmd}\n{combined}"

        entry = {
            "id": f"ssh-{uuid.uuid4().hex[:10]}",
            "kind": "ssh_exec",
            "command": clean_cmd,
            "effectiveCommand": effective_shell_cmd,
            "mode": cmd_mode,
            "subsystem": target_subsystem,
            "exitCode": exit_code,
            "durationMs": duration_ms,
            "output": formatted_output,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "origin": origin,
        }
        self.recent_activity.append(entry)

        # Zapisuj bezpośrednio do SQLite tylko spoza mostka `/api/terminal/exec` (ten sam zapisuje przez respondAndPersist).
        if not str(origin or "").startswith("terminal:"):
            try:
                self.kernel.append_terminal_entry(
                    "ssh",
                    {
                        "kind": "stdout" if exit_code == 0 else "stderr",
                        "text": formatted_output,
                        "command": clean_cmd[:300],
                        "timestamp": datetime.now(timezone.utc).strftime("%H:%M:%S"),
                    },
                    origin=origin,
                    correlation_id=correlation_id,
                )
            except Exception:
                pass

        return {
            "ok": exit_code == 0,
            "error": "" if exit_code == 0 else (stderr_out or f"Połączenie SSH z {ssh_host} zakończyło się kodem {exit_code}."),
            "command": clean_cmd,
            "effectiveCommand": effective_shell_cmd,
            "mode": cmd_mode,
            "subsystem": target_subsystem,
            "exitCode": exit_code,
            "durationMs": duration_ms,
            "sshEndpoint": f"ssh://{ssh_host}",
            "output": formatted_output,
            "stdout": formatted_output if exit_code == 0 else "",
            "stderr": formatted_output if exit_code != 0 else "",
            "rawOutput": combined,
            "entry": entry,
            "ssh_status": self.get_status(),
            "serverRevision": self.kernel.get_server_revision(),
        }

    def handle_mcp_jsonrpc(
        self,
        payload: dict[str, Any] | None = None,
        origin: str = "mcp-client",
        correlation_id: str = "",
        **kwargs: Any,
    ) -> dict[str, Any]:
        if payload is None and "request_body" in kwargs and isinstance(kwargs["request_body"], dict):
            payload = kwargs["request_body"]
        payload = payload or {}
        rpc_id = payload.get("id", 1)
        method = str(payload.get("method") or "").strip()
        params = payload.get("params") or {}

        if method == "initialize":
            return {
                "jsonrpc": "2.0",
                "id": rpc_id,
                "result": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {
                        "tools": {"listChanged": True},
                        "resources": {"listChanged": True},
                    },
                    "serverInfo": {
                        "name": "svl-364-linux-control-mcp",
                        "version": "5.6.0",
                        "ship": "SVL-364 Ebon Apex",
                    },
                },
            }

        if method == "notifications/initialized":
            return {"jsonrpc": "2.0", "id": rpc_id, "result": {"ok": True}}

        if method == "tools/list":
            return {
                "jsonrpc": "2.0",
                "id": rpc_id,
                "result": {"tools": MCP_TOOLS_CATALOG},
            }

        if method == "resources/list":
            return {
                "jsonrpc": "2.0",
                "id": rpc_id,
                "result": {
                    "resources": [
                        {
                            "uri": "svl364://telemetry/live",
                            "name": "Status mostka SSH i serwera MCP",
                            "mimeType": "application/json",
                        },
                        {
                            "uri": "svl364://ssh/config",
                            "name": "Konfiguracja mostka SSH (alias OpenSSH)",
                            "mimeType": "application/json",
                        },
                    ]
                },
            }

        if method == "resources/read":
            uri = str(params.get("uri") or "svl364://telemetry/live")
            status_data = self.get_status()
            return {
                "jsonrpc": "2.0",
                "id": rpc_id,
                "result": {
                    "contents": [
                        {
                            "uri": uri,
                            "mimeType": "application/json",
                            "text": json.dumps(status_data, ensure_ascii=False, indent=2),
                        }
                    ]
                },
            }

        if method == "tools/call":
            tool_name = str(params.get("name") or "").strip()
            arguments = params.get("arguments") or {}
            if not isinstance(arguments, dict):
                arguments = {}
            call_res = self.call_mcp_tool(tool_name, arguments, origin=origin)
            return {
                "jsonrpc": "2.0",
                "id": rpc_id,
                "result": {
                    "content": [
                        {
                            "type": "text",
                            "text": call_res["formattedText"],
                        }
                    ],
                    "isError": not call_res["ok"],
                    "structuredContent": call_res,
                },
            }

        return {
            "jsonrpc": "2.0",
            "id": rpc_id,
            "error": {
                "code": -32601,
                "message": f"Nieznana metoda MCP JSON-RPC: {method}. Dostępne: initialize, tools/list, tools/call, resources/list, resources/read.",
            },
        }

    def call_mcp_tool(
        self, tool_name: str, arguments: dict[str, Any], origin: str = "mcp-tool"
    ) -> dict[str, Any]:
        self.mcp_calls_count += 1
        started = time.time()

        if tool_name == "svl364_ssh_exec":
            cmd = str(arguments.get("command") or "")
            timeout_sec = float(arguments.get("timeout_sec") or 15.0)
            ssh_res = self.execute_ssh_command(cmd, timeout_sec=timeout_sec, origin=f"mcp:{origin}")
            return {
                "ok": ssh_res["ok"],
                "tool": tool_name,
                "arguments": arguments,
                "error": ssh_res.get("error"),
                "formattedText": ssh_res["output"] or ssh_res.get("error", ""),
                "data": ssh_res,
                "serverRevision": self.kernel.get_server_revision(),
            }

        if tool_name in REMOVED_FICTIONAL_TOOLS:
            summary = (
                f"[MCP · {tool_name}] Narzędzie usunięte: sterowało fikcyjnym stanem statku "
                f"({REMOVED_FICTIONAL_TOOLS[tool_name]}), który nie odpowiadał żadnemu rzeczywistemu urządzeniu. "
                "Użyj svl364_linux_telemetry, aby odczytać prawdziwy stan hosta."
            )
            return {
                "ok": False,
                "tool": tool_name,
                "arguments": arguments,
                "error": "tool_removed",
                "formattedText": summary,
                "serverRevision": self.kernel.get_server_revision(),
            }

        if tool_name == "svl364_linux_telemetry":
            snap = self.telemetry.snapshot(
                include_ship=False,
                ollama_host=os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434"),
                comfyui_url=os.environ.get("COMFYUI_HOST", "http://127.0.0.1:8188"),
                ssh_target=self._configured_ssh_target(self._default_config()),
            )
            summary = format_telemetry_summary(snap)
            self._record_mcp_activity(tool_name, arguments, summary, started, origin)
            return {
                "ok": True,
                "tool": tool_name,
                "arguments": arguments,
                "formattedText": summary,
                "data": snap,
                "serverRevision": self.kernel.get_server_revision(),
            }

        if tool_name == "svl364_emit_system_report":
            directive = str(
                arguments.get("directive")
                or "Raport sterowania statkiem SVL-364 przez SSH i protokół MCP w Linuxie"
            )
            summary = self.kernel.generate_comprehensive_svl_system_markdown_report(directive)
            self._record_mcp_activity(tool_name, arguments, f"Wygenerowano raport SVL_System (Bielik ROOT): {directive}", started, origin)
            return {
                "ok": True,
                "tool": "svl364_emit_system_report",
                "arguments": arguments,
                "formattedText": summary,
                "data": {"directive": directive, "report": summary},
                "serverRevision": self.kernel.get_server_revision(),
            }

        return {
            "ok": False,
            "tool": tool_name,
            "arguments": arguments,
            "formattedText": f"Nieznane narzędzie MCP: {tool_name}",
            "serverRevision": self.kernel.get_server_revision(),
        }

    def _record_mcp_activity(
        self, tool_name: str, arguments: dict[str, Any], output: str, started: float, origin: str
    ) -> None:
        duration_ms = round((time.time() - started) * 1000, 1)
        entry = {
            "id": f"mcp-{uuid.uuid4().hex[:10]}",
            "kind": "mcp_tool",
            "tool": tool_name,
            "arguments": arguments,
            "durationMs": duration_ms,
            "output": output,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "origin": origin,
        }
        self.recent_activity.append(entry)
        try:
            self.kernel.append_terminal_entry(
                "root",
                {
                    "type": "output",
                    "text": output,
                    "timestamp": datetime.now(timezone.utc).strftime("%H:%M:%S"),
                },
                origin=origin,
            )
        except Exception:
            pass
