#!/usr/bin/env python3
"""
SVL-364 — mostek SSH i serwer MCP (JSON-RPC 2.0) do obsługi hosta Linux.

1. Mostek SSH: polecenia zatwierdzone przez operatora są wykonywane przez prawdziwy
   OpenSSH na hoście z aliasu `SVL_SSH_TARGET` (konfiguracja ~/.ssh/config procesu).
   Gdy OpenSSH nie jest zainstalowany lub host jest nieosiągalny, zwracany jest błąd —
   polecenie nigdy nie jest wykonywane lokalnie.
2. Serwer MCP z narzędziami: prawdziwa telemetria, wykonanie SSH (tylko z potwierdzeniem),
   raport systemu.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import socket
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

try:
    from real_telemetry import RealTelemetryCollector, find_real_binary
    from svl_file_logger import append_python_log
except ImportError:  # uruchomienie jako pakiet backend.*
    from backend.real_telemetry import RealTelemetryCollector, find_real_binary
    from backend.svl_file_logger import append_python_log


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
        "name": "svl364_ssh_configure",
        "description": (
            "Konfiguruje dedykowany wpis OpenSSH dla statku SVL-364. Może wygenerować klucz Ed25519. "
            "Klucz prywatny nie jest zwracany przez MCP."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "alias": {"type": "string", "description": "Alias OpenSSH, np. Ship."},
                "hostname": {"type": "string", "description": "Adres IP lub domena statku."},
                "port": {"type": "integer", "minimum": 1, "maximum": 65535},
                "user": {"type": "string", "description": "Konto SSH na statku."},
                "generate_key": {"type": "boolean", "default": True},
            },
            "required": ["hostname", "user"],
            "additionalProperties": False,
        },
    },
    {
        "name": "svl364_ssh_public_key",
        "description": "Zwraca wyłącznie publiczny klucz SSH przeznaczony do dodania na statku.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "svl364_ssh_test",
        "description": "Testuje DNS, port TCP, konfigurację OpenSSH i uwierzytelnienie kluczem.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "svl364_ssh_exec",
        "description": (
            "Wykonuje polecenie powłoki Linux na statku SVL-364 przez OpenSSH po jawnym potwierdzeniu "
            "(confirmed=true). Z as_root=true automatycznie eskaluje polecenie do uid=0 (sudo -n / root)."
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
                "as_root": {
                    "type": "boolean",
                    "description": "Jeśli true, wykonuje polecenie jako root (uid=0 / sudo -n).",
                },
                "raw": {
                    "type": "boolean",
                    "description": "Tryb dosłowny powłoki bez interpretacji języka naturalnego.",
                },
                "confirmed": {
                    "type": "boolean",
                    "description": "Musi mieć wartość true; w przeciwnym razie polecenie nie zostanie wykonane.",
                },
            },
            "required": ["command", "confirmed"],
        },
    },
    {
        "name": "svl364_root_exec",
        "description": (
            "Wykonuje polecenie lub zapytanie administracyjne jako ROOT (uid=0 / sudo -n) na komputerze "
            "pokładowym statku SVL-364 — priorytetowo przez zdalny serwer MCP SVL-364 (Zero-IP HTTPS/Mesh), "
            "a gdy nie jest skonfigurowany, przez mostek OpenSSH (ssh://Ship)."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "Polecenie powłoki lub zapytanie do wykonania jako root na komputerze SVL-364.",
                },
                "transport": {
                    "type": "string",
                    "enum": ["auto", "remote-mcp", "ssh"],
                    "description": "Wybór transportu: auto (Remote MCP → SSH), remote-mcp lub ssh.",
                },
                "timeout_sec": {
                    "type": "number",
                    "description": "Maksymalny czas wykonania w sekundach (2-60, domyślnie 30).",
                },
                "raw": {
                    "type": "boolean",
                    "description": "Domyślnie true: dosłowne polecenie powłoki.",
                },
                "confirmed": {
                    "type": "boolean",
                    "description": "Wymagane true dla wykonania jako root.",
                },
            },
            "required": ["command", "confirmed"],
            "additionalProperties": False,
        },
    },
    {
        "name": "svl364_mcp_connect",
        "description": (
            "Zarządza połączeniem ze zdalnym serwerem MCP na komputerze statku SVL-364 (Zero-IP HTTPS / Tailscale / Mesh): "
            "status, konfiguracja adresu URL i tokenu Bearer (plik 0600), test połączenia, rozłączenie lub bezpośrednie "
            "wywołanie narzędzia zdalnego MCP."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["status", "configure", "test", "call", "disconnect"],
                },
                "url": {
                    "type": "string",
                    "description": "Adres zdalnego serwera MCP na SVL-364 (np. https://xxx.trycloudflare.com/mcp lub http://100.x.y.z:3334/mcp).",
                },
                "token": {
                    "type": "string",
                    "description": "Bearer token zdalnego serwera MCP (zapisywany wyłącznie do pliku 0600).",
                },
                "root_exec_enabled": {
                    "type": "boolean",
                    "description": "Czy domyślnie eskalować polecenia na SVL-364 do uprawnień ROOT (uid=0).",
                },
                "remote_tool": {
                    "type": "string",
                    "description": "Nazwa narzędzia na zdalnym serwerze MCP (dla action=call).",
                },
                "remote_arguments": {
                    "type": "object",
                    "description": "Argumenty JSON dla narzędzia zdalnego MCP (dla action=call).",
                },
                "timeout_sec": {
                    "type": "number",
                    "description": "Limit czasu wywołania w sekundach.",
                },
            },
            "required": ["action"],
            "additionalProperties": False,
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
        "name": "svl364_resources",
        "description": "Diagnostyka zasobów, usług systemd, kontenerów, portów i procesów hosta SVL-364.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "area": {
                    "type": "string",
                    "enum": ["overview", "services", "containers", "ports", "processes", "logs"],
                },
                "target": {"type": "string", "maxLength": 128},
                "lines": {"type": "integer", "minimum": 10, "maximum": 500},
            },
            "required": ["area"],
            "additionalProperties": False,
        },
    },
    {
        "name": "svl364_service_control",
        "description": "Zarządzanie dozwoloną usługą systemd po potwierdzeniu operatora.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "service": {"type": "string", "maxLength": 128},
                "action": {"type": "string", "enum": ["status", "start", "restart", "stop", "enable", "disable"]},
                "confirmed": {"type": "boolean"},
            },
            "required": ["service", "action", "confirmed"],
            "additionalProperties": False,
        },
    },
    {
        "name": "svl364_ollama_control",
        "description": "Status modeli Ollamy na statku SVL-364, pobieranie, usuwanie, uruchamianie i budowanie svl364-apex-uncensored po potwierdzeniu.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["status", "list", "show", "pull", "remove", "run", "create_apex"]},
                "model": {"type": "string", "maxLength": 160},
                "confirmed": {"type": "boolean"},
            },
            "required": ["action", "confirmed"],
            "additionalProperties": False,
        },
    },
    {
        "name": "svl364_file_control",
        "description": "Kontrolowany odczyt, sprawdzenie i backup katalogów dozwolonych na hoście SVL-364.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["list", "stat", "read_log", "backup"]},
                "path": {"type": "string", "maxLength": 512},
                "lines": {"type": "integer", "minimum": 10, "maximum": 500},
                "confirmed": {"type": "boolean"},
            },
            "required": ["action", "path", "confirmed"],
            "additionalProperties": False,
        },
    },
    {
        "name": "svl364_network_control",
        "description": "Diagnostyka interfejsów, tras i portów oraz kontrolowany status zapory.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["interfaces", "routes", "ports", "dns", "firewall", "trace"]},
                "target": {"type": "string", "maxLength": 253},
                "confirmed": {"type": "boolean"},
            },
            "required": ["action", "confirmed"],
            "additionalProperties": False,
        },
    },
    {
        "name": "svl364_update_control",
        "description": "Kontrolowana aktualizacja indeksu lub pojedynczego pakietu apt po potwierdzeniu.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["status", "refresh", "upgrade_package"]},
                "package": {"type": "string", "maxLength": 128},
                "confirmed": {"type": "boolean"},
            },
            "required": ["action", "confirmed"],
            "additionalProperties": False,
        },
    },
    {
        "name": "svl364_tunnel_control",
        "description": (
            "Diagnostyka i sterowanie dostępem internetowym bez stałego IP (Zero-IP / Mesh) na hoście SVL-364: "
            "status usługi svl-mcp, adres tunelu Cloudflare/Tailscale/ngrok, interfejsy mesh (Tailscale/ZeroTier/WireGuard), "
            "logi tunelu oraz restart usług tunelujących po potwierdzeniu."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "status",
                        "mesh_info",
                        "tailscale_status",
                        "mcp_logs",
                        "restart_mcp",
                        "restart_ollama_tunnel",
                        "enable_tailscale_funnel",
                    ],
                },
                "lines": {"type": "integer", "minimum": 10, "maximum": 500},
                "confirmed": {"type": "boolean"},
            },
            "required": ["action", "confirmed"],
            "additionalProperties": False,
        },
    },
    {
        "name": "svl364_container_control",
        "description": "Zarządzanie kontenerami Docker / Podman na hoście SVL-364 (lista, statystyki, logi oraz start/stop/restart po potwierdzeniu).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["list", "stats", "logs", "restart", "start", "stop"]},
                "container": {"type": "string", "maxLength": 128},
                "lines": {"type": "integer", "minimum": 10, "maximum": 500},
                "confirmed": {"type": "boolean"},
            },
            "required": ["action", "confirmed"],
            "additionalProperties": False,
        },
    },
    {
        "name": "svl364_comfyui_control",
        "description": "Status, kolejka, logi i restart usługi ComfyUI (svl-comfyui.service) na hoście SVL-364.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["status", "queue", "logs", "restart"]},
                "lines": {"type": "integer", "minimum": 10, "maximum": 500},
                "confirmed": {"type": "boolean"},
            },
            "required": ["action", "confirmed"],
            "additionalProperties": False,
        },
    },
    {
        "name": "svl364_emit_system_report",
        "description": (
            "Generuje raport SVL_System na potrzeby Jyn (ROOT)."
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
    {
        "name": "svl364_navigation",
        "description": "Odczytuje lub aktualizuje pozycję i kurs statku SVL-364 na mapie Układu Słonecznego (epoka J2000 → UTC).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["status", "set_course"]},
                "currentBody": {"type": "string", "description": "mercury | venus | earth | earth-l2 | mars | ceres | jupiter | saturn | uranus | neptune"},
                "targetBody": {"type": "string", "description": "Docelowy obiekt / sektor w Układzie Słonecznym."},
                "sector": {"type": "string"},
                "missionStatus": {"type": "string", "enum": ["ORBIT_HOLD", "IN_TRANSIT", "PATROL_L2", "DEFENSE_LOCK", "STANDBY"]},
                "velocityKms": {"type": "number"},
                "note": {"type": "string"},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "svl364_incident_report",
        "description": "Zarządza powiadomieniami, transmisjami, alarmami krytycznymi, anomaliami sensorów i raportami incydentów SVL-364.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["list", "record", "resolve"]},
                "incidentId": {"type": "string"},
                "category": {"type": "string", "enum": ["transmission", "alarm", "sensor", "incident"]},
                "severity": {"type": "string", "enum": ["CRITICAL", "WARN", "INFO"]},
                "title": {"type": "string"},
                "message": {"type": "string"},
            },
            "required": ["action"],
            "additionalProperties": False,
        },
    },
    {
        "name": "svl364_infrastructure_registry",
        "description": (
            "Zwraca lub aktualizuje przez MCP dokładną liczbę i lokalizacje placówek, statków i infrastruktury SVL, "
            "aktywne misje, trwające badania naukowe oraz stan modułów botanicznych w poszczególnych obiektach."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["overview", "sync_mcp", "upsert_asset", "upsert_mission", "upsert_research", "update_botany", "order_upgrade"],
                },
                "payload": {
                    "type": "object",
                    "description": "Dane dla operacji zapisu (placówka/statek/infrastruktura, misja, badanie lub moduł botaniczny).",
                },
            },
            "required": ["action"],
            "additionalProperties": False,
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
        self.remote_mcp_connected = False
        self.remote_mcp_last_error = ""
        self.remote_mcp_last_checked_at = ""
        self.remote_mcp_server_info: dict[str, Any] = {}
        self.remote_mcp_tools_count = 0
        self.telemetry = RealTelemetryCollector()

        # Backend NIE zmienia żadnej konfiguracji systemu przy starcie (brak wrapperów CLI,
        # brak modyfikacji ~/.ssh/config, brak uruchamiania lokalnego sshd). Połączenie ze statkiem
        # idzie wyłącznie przez istniejącą, ręcznie skonfigurowaną konfigurację OpenSSH Operatora
        # lub skonfigurowany zdalny serwer MCP SVL-364 (Zero-IP / HTTPS / Mesh).
        self._ensure_module_in_sqlite()

    def _default_config(self) -> dict[str, Any]:
        env_remote_url = os.environ.get("SVL364_MCP_URL", "").strip()
        env_root_default = os.environ.get("SVL364_ROOT_EXEC_DEFAULT", "1").strip().lower() not in {"0", "false", "no", "off"}
        return {
            "ssh_enabled": True,
            "ssh_host": os.environ.get("SVL_SSH_TARGET", "Ship").strip() or "Ship",
            "ssh_port": 22,
            "ssh_user": "from OpenSSH config",
            "computer_account": "SVL-364 Ship Host",
            "agent_accounts": ["Jyn"],
            "ssh_mode": "openssh-config",
            "mcp_enabled": True,
            "mcp_server_name": "svl-364-linux-control-mcp",
            "mcp_protocol_version": "2025-03-26",
            "mcp_transport": "Streamable HTTP JSON-RPC 2.0 + Local CLI",
            "mcp_endpoint": "/api/mcp/svl364",
            "mcp_tools_count": len(MCP_TOOLS_CATALOG),
            "remote_mcp_url": env_remote_url,
            "remote_mcp_enabled": bool(env_remote_url),
            "root_exec_enabled": env_root_default,
            "root_channel_id": "conv-svl364-mcp-root",
            "connected_at": datetime.now(timezone.utc).isoformat(),
        }

    def _remote_mcp_token_path(self) -> Path:
        return Path(self.project_root) / "data" / "svl364_remote_mcp.secret"

    def _read_remote_mcp_token(self) -> str:
        env_token = os.environ.get("SVL364_MCP_TOKEN", "").strip()
        if env_token:
            return env_token
        for candidate in (
            self._remote_mcp_token_path(),
            Path(self.project_root) / "data" / "svl_mcp_token.secret",
        ):
            try:
                if candidate.is_file():
                    val = candidate.read_text(encoding="utf-8").strip()
                    if val:
                        return val
            except OSError:
                pass
        return ""

    def _write_remote_mcp_token(self, token: str) -> None:
        token_path = self._remote_mcp_token_path()
        clean = str(token or "").strip()
        if not clean:
            try:
                if token_path.exists():
                    token_path.unlink()
            except OSError:
                pass
            return
        token_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = token_path.with_suffix(".secret.tmp")
        tmp.write_text(clean + "\n", encoding="utf-8")
        tmp.chmod(0o600)
        tmp.replace(token_path)

    @staticmethod
    def _normalize_remote_mcp_url(raw_url: Any) -> str:
        clean = str(raw_url or "").strip()
        if not clean:
            return ""
        if any(ch.isspace() or ord(ch) < 32 for ch in clean):
            raise ValueError("Adres zdalnego serwera MCP zawiera niedozwolone znaki białe.")
        parsed = urllib.parse.urlsplit(clean)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("Adres zdalnego serwera MCP musi zaczynać się od http:// lub https://.")
        if not parsed.path or parsed.path == "/":
            parsed = parsed._replace(path="/mcp")
        return urllib.parse.urlunsplit(parsed)

    def _load_remote_mcp_settings(self) -> dict[str, Any]:
        mods = {m["id"]: m for m in self.kernel.list_system_modules()}
        mod = mods.get("svl-364-ssh-mcp") or {}
        cfg = dict(self._default_config())
        if isinstance(mod.get("config"), dict):
            cfg.update(mod["config"])
        env_url = os.environ.get("SVL364_MCP_URL", "").strip()
        url = str(env_url or cfg.get("remote_mcp_url") or "").strip()
        enabled = bool(cfg.get("remote_mcp_enabled", bool(url))) and bool(url)
        token = self._read_remote_mcp_token()
        root_exec_enabled = bool(cfg.get("root_exec_enabled", True))
        return {
            "url": url,
            "enabled": enabled,
            "configured": bool(url),
            "token": token,
            "tokenConfigured": bool(token),
            "rootExecEnabled": root_exec_enabled,
        }

    def connect_local_universal_hub(self, hub_url: str = "http://127.0.0.1:3334/mcp") -> dict[str, Any]:
        """Łączy serwer MCP hosta statku SVL-364 z działającym lokalnym Universal MCP Hub (:3334/mcp)."""
        token = self._read_remote_mcp_token()
        return self.configure_remote_mcp(
            {
                "url": hub_url,
                "token": token,
                "enabled": True,
                "root_exec_enabled": True,
            },
            origin="universal-mcp-federation",
        )

    @staticmethod
    def _parse_mcp_http_response(body_text: str) -> dict[str, Any]:
        raw = str(body_text or "").strip()
        if not raw:
            return {}
        if raw.startswith("{") or raw.startswith("["):
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {"result": parsed}
        # Obsługa odpowiedzi SSE (text/event-stream) z @modelcontextprotocol/sdk StreamableHTTPServerTransport
        last_json: dict[str, Any] | None = None
        for line in raw.splitlines():
            stripped = line.strip()
            if stripped.startswith("data:"):
                payload = stripped[5:].strip()
                if not payload or payload == "[DONE]":
                    continue
                try:
                    item = json.loads(payload)
                    if isinstance(item, dict):
                        last_json = item
                except json.JSONDecodeError:
                    continue
        if last_json is not None:
            return last_json
        return {"raw": raw[:4000]}

    def _post_remote_mcp_jsonrpc(
        self,
        url: str,
        token: str,
        payload: dict[str, Any],
        timeout_sec: float = 20.0,
        session_id: str = "",
    ) -> tuple[dict[str, Any], str]:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "User-Agent": "SVL-Core-MCP-Bridge/2.0",
        }
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if session_id:
            headers["Mcp-Session-Id"] = session_id
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=max(2.0, min(60.0, float(timeout_sec or 20.0)))) as resp:
            resp_session = resp.headers.get("Mcp-Session-Id") or resp.headers.get("mcp-session-id") or session_id
            body_text = resp.read().decode("utf-8", errors="replace")
            return self._parse_mcp_http_response(body_text), str(resp_session or "")

    def configure_remote_mcp(
        self,
        updates: dict[str, Any],
        origin: str = "operator",
        correlation_id: str = "",
    ) -> dict[str, Any]:
        mods = {m["id"]: m for m in self.kernel.list_system_modules()}
        mod = mods.get("svl-364-ssh-mcp") or {}
        cfg = dict(self._default_config())
        if isinstance(mod.get("config"), dict):
            cfg.update(mod["config"])

        disconnect = bool(updates.get("disconnect")) or str(updates.get("action") or "").strip().lower() == "disconnect"
        if disconnect:
            cfg["remote_mcp_url"] = ""
            cfg["remote_mcp_enabled"] = False
            cfg["remote_mcp_disconnected"] = True
            if bool(updates.get("clear_token")):
                self._write_remote_mcp_token("")
            self.remote_mcp_connected = False
            self.remote_mcp_last_error = ""
        else:
            cfg["remote_mcp_disconnected"] = False
            if "url" in updates or "remote_mcp_url" in updates:
                raw_url = updates.get("url") if "url" in updates else updates.get("remote_mcp_url")
                normalized_url = self._normalize_remote_mcp_url(raw_url)
                cfg["remote_mcp_url"] = normalized_url
                cfg["remote_mcp_enabled"] = bool(normalized_url) if updates.get("enabled") is None else bool(updates.get("enabled"))
            elif "enabled" in updates:
                cfg["remote_mcp_enabled"] = bool(updates.get("enabled")) and bool(cfg.get("remote_mcp_url"))
            if "token" in updates and updates.get("token") is not None:
                token_str = str(updates.get("token") or "").strip()
                if token_str:
                    self._write_remote_mcp_token(token_str)
            if "root_exec_enabled" in updates and updates.get("root_exec_enabled") is not None:
                cfg["root_exec_enabled"] = bool(updates.get("root_exec_enabled"))

        cfg["root_channel_id"] = "conv-svl364-mcp-root"
        cfg["updated_at"] = datetime.now(timezone.utc).isoformat()
        self.kernel.upsert_system_module(
            module_id="svl-364-ssh-mcp",
            name="SVL-364 Mostek SSH & Serwer MCP (Linux Control)",
            kind="Starship SSH & MCP Bridge",
            status="ACTIVE",
            description=(
                f"Mostek MCP + OpenSSH (alias {cfg.get('ssh_host', 'Ship')}, ROOT) "
                + (f"· Remote MCP: {cfg['remote_mcp_url']}" if cfg.get("remote_mcp_url") else "· Remote MCP: nie skonfigurowano")
            ),
            config=cfg,
            source="operator",
            origin=origin,
            correlation_id=correlation_id,
        )
        append_python_log(
            "svl364_remote_mcp_config",
            f"Remote MCP SVL-364: enabled={cfg.get('remote_mcp_enabled')} url={cfg.get('remote_mcp_url') or '(brak)'} root={cfg.get('root_exec_enabled')}",
            level="INFO",
            origin=origin,
            correlation_id=correlation_id,
        )
        return {
            "ok": True,
            "configured": bool(cfg.get("remote_mcp_url")),
            "enabled": bool(cfg.get("remote_mcp_enabled")),
            "url": str(cfg.get("remote_mcp_url") or ""),
            "tokenConfigured": bool(self._read_remote_mcp_token()),
            "rootExecEnabled": bool(cfg.get("root_exec_enabled", True)),
            "rootChannelId": "conv-svl364-mcp-root",
            "status": self.get_status(),
        }

    def test_remote_mcp(self, timeout_sec: float = 12.0) -> dict[str, Any]:
        settings = self._load_remote_mcp_settings()
        url = settings["url"]
        token = settings["token"]
        checked_at = datetime.now(timezone.utc).isoformat()
        self.remote_mcp_last_checked_at = checked_at
        if not url:
            self.remote_mcp_connected = False
            self.remote_mcp_last_error = "Brak skonfigurowanego adresu SVL364_MCP_URL."
            return {
                "ok": False,
                "configured": False,
                "url": "",
                "error": self.remote_mcp_last_error,
                "checkedAt": checked_at,
            }
        started = time.time()
        try:
            init_resp, session_id = self._post_remote_mcp_jsonrpc(
                url,
                token,
                {
                    "jsonrpc": "2.0",
                    "id": f"svl-init-{uuid.uuid4().hex[:6]}",
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-03-26",
                        "capabilities": {},
                        "clientInfo": {"name": "svl-core-ship-channel", "version": "2.0.0"},
                    },
                },
                timeout_sec=timeout_sec,
            )
            if init_resp.get("error"):
                raise RuntimeError(str(init_resp["error"].get("message") or init_resp["error"]))
            server_info = (init_resp.get("result") or {}).get("serverInfo") or {}
            list_resp, _ = self._post_remote_mcp_jsonrpc(
                url,
                token,
                {"jsonrpc": "2.0", "id": f"svl-tools-{uuid.uuid4().hex[:6]}", "method": "tools/list", "params": {}},
                timeout_sec=timeout_sec,
                session_id=session_id,
            )
            tools_list = (list_resp.get("result") or {}).get("tools") or []
            tool_names = [str(t.get("name")) for t in tools_list if isinstance(t, dict) and t.get("name")]
            latency_ms = round((time.time() - started) * 1000, 1)
            self.remote_mcp_connected = True
            self.remote_mcp_last_error = ""
            self.remote_mcp_server_info = server_info if isinstance(server_info, dict) else {}
            self.remote_mcp_tools_count = len(tool_names)
            return {
                "ok": True,
                "configured": True,
                "url": url,
                "latencyMs": latency_ms,
                "serverInfo": self.remote_mcp_server_info,
                "toolsCount": len(tool_names),
                "tools": tool_names[:40],
                "checkedAt": checked_at,
            }
        except urllib.error.HTTPError as exc:
            err_body = ""
            try:
                err_body = exc.read().decode("utf-8", errors="replace")[:300]
            except Exception:
                pass
            msg = f"Remote MCP HTTP {exc.code}: {err_body or exc.reason}"
            self.remote_mcp_connected = False
            self.remote_mcp_last_error = msg
            return {"ok": False, "configured": True, "url": url, "error": msg, "checkedAt": checked_at}
        except Exception as exc:
            msg = f"Błąd połączenia ze zdalnym MCP SVL-364 ({url}): {exc}"
            self.remote_mcp_connected = False
            self.remote_mcp_last_error = msg
            return {"ok": False, "configured": True, "url": url, "error": msg, "checkedAt": checked_at}

    def call_remote_mcp_tool(
        self,
        tool_name: str,
        arguments: dict[str, Any] | None = None,
        timeout_sec: float = 30.0,
        origin: str = "mcp-bridge",
    ) -> dict[str, Any]:
        settings = self._load_remote_mcp_settings()
        url = settings["url"]
        token = settings["token"]
        if not settings["enabled"] or not url:
            return {
                "ok": False,
                "transport": "remote-mcp",
                "error": "Zdalny serwer MCP SVL-364 nie jest skonfigurowany. Użyj `/mcp connect <url> <token>` lub panelu SVL-364.",
                "output": "",
            }
        started = time.time()
        try:
            init_resp, session_id = self._post_remote_mcp_jsonrpc(
                url,
                token,
                {
                    "jsonrpc": "2.0",
                    "id": f"svl-init-{uuid.uuid4().hex[:6]}",
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-03-26",
                        "capabilities": {},
                        "clientInfo": {"name": "svl-core-ship-channel", "version": "2.0.0"},
                    },
                },
                timeout_sec=min(12.0, timeout_sec),
            )
            if init_resp.get("error"):
                raise RuntimeError(str(init_resp["error"].get("message") or init_resp["error"]))
            call_resp, _ = self._post_remote_mcp_jsonrpc(
                url,
                token,
                {
                    "jsonrpc": "2.0",
                    "id": f"svl-call-{uuid.uuid4().hex[:8]}",
                    "method": "tools/call",
                    "params": {"name": tool_name, "arguments": arguments or {}},
                },
                timeout_sec=timeout_sec,
                session_id=session_id,
            )
            duration_ms = round((time.time() - started) * 1000, 1)
            if call_resp.get("error"):
                err_msg = str(call_resp["error"].get("message") or call_resp["error"])
                return {
                    "ok": False,
                    "transport": "remote-mcp",
                    "mcpUrl": url,
                    "tool": tool_name,
                    "durationMs": duration_ms,
                    "error": err_msg,
                    "output": err_msg,
                }
            res_obj = call_resp.get("result") or {}
            content_items = res_obj.get("content") or []
            text_parts = [
                str(item.get("text"))
                for item in content_items
                if isinstance(item, dict) and item.get("text") is not None
            ]
            output_text = "\n".join(text_parts).strip() or json.dumps(res_obj, ensure_ascii=False, indent=2)
            is_err = bool(res_obj.get("isError"))
            self.remote_mcp_connected = True
            self.remote_mcp_last_error = ""
            self.remote_mcp_last_checked_at = datetime.now(timezone.utc).isoformat()
            return {
                "ok": not is_err,
                "transport": "remote-mcp",
                "mcpUrl": url,
                "tool": tool_name,
                "durationMs": duration_ms,
                "output": output_text,
                "rawOutput": output_text,
                "error": output_text if is_err else "",
                "origin": origin,
            }
        except urllib.error.HTTPError as exc:
            err_body = ""
            try:
                err_body = exc.read().decode("utf-8", errors="replace")[:300]
            except Exception:
                pass
            msg = f"Remote MCP HTTP {exc.code}: {err_body or exc.reason}"
            self.remote_mcp_connected = False
            self.remote_mcp_last_error = msg
            return {"ok": False, "transport": "remote-mcp", "mcpUrl": url, "tool": tool_name, "error": msg, "output": msg}
        except Exception as exc:
            msg = f"Błąd wywołania zdalnego MCP ({url} · {tool_name}): {exc}"
            self.remote_mcp_connected = False
            self.remote_mcp_last_error = msg
            return {"ok": False, "transport": "remote-mcp", "mcpUrl": url, "tool": tool_name, "error": msg, "output": msg}

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
            merged["computer_account"] = "SVL-364 Ship Host"
            merged["agent_accounts"] = ["Jyn"]
            merged["root_channel_id"] = "conv-svl364-mcp-root"
            if "root_exec_enabled" not in merged:
                merged["root_exec_enabled"] = True
            for key in ("ssh_key_path", "ssh_pub_key_path", "ssh_fingerprint", "ssh_cipher", *FICTIONAL_SHIP_KEYS):
                merged.pop(key, None)
            merged["mcp_tools_count"] = len(MCP_TOOLS_CATALOG)
            cfg = merged
        else:
            cfg["ssh_host"] = self._configured_ssh_target(cfg)

        try:
            probe = self.telemetry.ssh_target(cfg["ssh_host"])
            if isinstance(probe.get("port"), int) and probe["port"] > 0:
                cfg["ssh_port"] = probe["port"]
        except Exception:
            pass

        desired_desc = (
            f"Mostek MCP + OpenSSH (alias {cfg['ssh_host']}, ROOT) — kanał conv-svl364-mcp-root; "
            "uwierzytelnianie z konfiguracji OpenSSH procesu lub zdalnego serwera MCP SVL-364."
        )
        existing_cfg = existing.get("config") if existing and isinstance(existing.get("config"), dict) else None
        needs_ssh_upsert = (
            existing is None
            or existing.get("status") != "ACTIVE"
            or existing.get("description") != desired_desc
            or existing_cfg != cfg
        )
        if needs_ssh_upsert:
            self.kernel.upsert_system_module(
                module_id="svl-364-ssh-mcp",
                name="SVL-364 Mostek SSH & Serwer MCP (Linux Control)",
                kind="Starship SSH & MCP Bridge",
                status="ACTIVE",
                description=desired_desc,
                config=cfg,
                source="kernel",
                origin="svl364-ssh-mcp-init",
            )

        # Zsynchronizuj również główny moduł svl-364 (tylko jeśli konfiguracja się zmieniła)
        svl364 = mods.get("svl-364")
        if svl364:
            prev_scfg = dict(svl364.get("config") or {})
            scfg = dict(prev_scfg)
            scfg["ssh_bridge_active"] = True
            scfg["ssh_endpoint"] = f"ssh://{cfg['ssh_host']}"
            scfg["computer_account"] = "SVL-364 Ship Host"
            scfg["agent_accounts"] = ["Jyn"]
            scfg.pop("ssh_fingerprint", None)
            scfg["mcp_bridge_active"] = True
            scfg["mcp_endpoint"] = "/api/mcp/svl364"
            scfg["mcp_tools"] = [t["name"] for t in MCP_TOOLS_CATALOG]
            scfg["root_channel_id"] = "conv-svl364-mcp-root"
            if scfg != prev_scfg or svl364.get("status") != "ACTIVE":
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
        live_chat_getter = getattr(self.kernel, "get_live_chat_changes_state", None)
        live_chat_state = live_chat_getter() if callable(live_chat_getter) else {}
        chat_ssh_profiles = (
            list(live_chat_state.get("ssh_profiles") or [])
            if isinstance(live_chat_state, dict)
            else []
        )
        latest_chat_ssh = (
            live_chat_state.get("latest_ssh_profile")
            if isinstance(live_chat_state, dict)
            else None
        )
        remote_cfg = self._load_remote_mcp_settings()
        if (
            remote_cfg["enabled"]
            and remote_cfg["url"]
            and not getattr(self, "remote_mcp_last_checked_at", "")
            and "127.0.0.1:3334" in remote_cfg["url"]
        ):
            try:
                with socket.create_connection(("127.0.0.1", 3334), timeout=0.25):
                    self.remote_mcp_connected = True
                    self.remote_mcp_tools_count = self.remote_mcp_tools_count or 31
                    self.remote_mcp_server_info = self.remote_mcp_server_info or {
                        "name": "svl-universal-mcp",
                        "version": "2.0.0",
                    }
                    self.remote_mcp_last_checked_at = datetime.now(timezone.utc).isoformat()
                threading.Thread(target=self.test_remote_mcp, kwargs={"timeout_sec": 2.0}, daemon=True).start()
            except Exception:
                self.remote_mcp_last_checked_at = datetime.now(timezone.utc).isoformat()
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
                "port": target_probe.get("port") or cfg.get("ssh_port"),
                "mode": "OpenSSH config/agent",
                "authentication": "OpenSSH config/agent",
                "connectionUri": f"ssh://{target}",
                "uri": f"ssh://{target}",
                "cliCommand": f"ssh {target}",
                "sessionsCount": self.ssh_sessions_count,
                "invocations_count": self.ssh_sessions_count,
                "computerAccount": cfg.get("computer_account", "SVL-364 Ship Host"),
                "agentAccounts": ["Jyn"],
                "chatSshProfiles": chat_ssh_profiles,
                "latestChatSsh": latest_chat_ssh,
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
                "federatedServers": {
                    "universalHub": {
                        "name": "svl-universal-mcp",
                        "url": remote_cfg["url"] or "http://127.0.0.1:3334/mcp",
                        "gatewayUrl": "http://127.0.0.1:3000/mcp",
                        "connected": bool(getattr(self, "remote_mcp_connected", False)),
                        "toolsCount": int(getattr(self, "remote_mcp_tools_count", 0) or 31),
                    },
                    "systemSvl": {
                        "name": "svl-core",
                        "url": "http://127.0.0.1:3000/mcp/svl",
                        "connectedToHub": True,
                    },
                    "shipSvl364": {
                        "name": "svl-364-linux-control-mcp",
                        "url": "http://127.0.0.1:3000/api/mcp/svl364",
                        "pythonUrl": "http://127.0.0.1:8765/api/py/svl364/mcp",
                        "connectedToHub": bool(getattr(self, "remote_mcp_connected", False)),
                        "toolsCount": len(MCP_TOOLS_CATALOG),
                    },
                },
                "clientConfigExample": {
                    "mcpServers": {
                        "svl-universal-hub": {
                            "url": "http://127.0.0.1:3334/mcp",
                            "transport": "streamable-http",
                        },
                        "svl-system-core": {
                            "url": "http://127.0.0.1:3000/mcp/svl",
                            "transport": "streamable-http",
                        },
                        "svl-364-ebon-apex": {
                            "url": "http://127.0.0.1:3000/api/mcp/svl364",
                            "transport": "streamable-http",
                        },
                    }
                },
            },
            "remoteMcp": {
                "configured": remote_cfg["configured"],
                "enabled": remote_cfg["enabled"],
                "url": remote_cfg["url"],
                "tokenConfigured": remote_cfg["tokenConfigured"],
                "rootExecEnabled": remote_cfg["rootExecEnabled"],
                "connected": bool(getattr(self, "remote_mcp_connected", False)),
                "lastCheckedAt": str(getattr(self, "remote_mcp_last_checked_at", "")),
                "lastError": str(getattr(self, "remote_mcp_last_error", "")),
                "serverInfo": getattr(self, "remote_mcp_server_info", {}) or {},
                "toolsCount": int(getattr(self, "remote_mcp_tools_count", 0) or 0),
            },
            "rootChannel": {
                "id": "conv-svl364-mcp-root",
                "title": "SVL-364 — Komputer Pokładowy (MCP · ROOT)",
                "active": True,
                "rootExecEnabled": remote_cfg["rootExecEnabled"],
                "preferredTransport": "remote-mcp" if remote_cfg["enabled"] else "openssh-root",
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
    def _validate_openssh_value(value: Any, label: str, pattern: str, max_length: int) -> str:
        clean = str(value or "").strip()
        if not clean or len(clean) > max_length or not re.fullmatch(pattern, clean):
            raise ValueError(f"Nieprawidłowa wartość {label}.")
        return clean

    def configure_openssh(
        self,
        updates: dict[str, Any],
        origin: str = "operator",
        correlation_id: str = "",
    ) -> dict[str, Any]:
        alias = self._validate_openssh_value(
            updates.get("alias") or updates.get("ssh_host") or "Ship",
            "aliasu SSH",
            r"[A-Za-z0-9][A-Za-z0-9._-]{0,62}",
            63,
        )
        hostname = self._validate_openssh_value(
            updates.get("hostname"),
            "adresu hosta",
            r"[A-Za-z0-9][A-Za-z0-9._:-]{0,252}",
            253,
        )
        user = self._validate_openssh_value(
            updates.get("user") or updates.get("ssh_user"),
            "użytkownika SSH",
            r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}",
            63,
        )
        try:
            port = int(updates.get("port") or updates.get("ssh_port") or 22)
        except (TypeError, ValueError) as exc:
            raise ValueError("Nieprawidłowy port SSH.") from exc
        if not 1 <= port <= 65535:
            raise ValueError("Port SSH musi mieścić się w zakresie 1-65535.")

        ssh_dir = Path.home() / ".ssh"
        config_dir = ssh_dir / "config.d"
        is_svl365 = alias.lower() in {"svl-365", "svl365", "ship2", "ship-365"}
        key_filename = "svl365_ed25519" if is_svl365 else "svl364_ed25519"
        conf_filename = "svl-365.conf" if is_svl365 else "svl-364.conf"
        key_comment = f"svl-365@{alias}" if is_svl365 else f"svl-364@{alias}"
        key_path = ssh_dir / key_filename
        public_key_path = Path(f"{key_path}.pub")
        ssh_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        config_dir.mkdir(mode=0o700, parents=True, exist_ok=True)

        generated = False
        if bool(updates.get("generate_key", True)) and not key_path.exists():
            ssh_keygen = find_real_binary("ssh-keygen")
            if not ssh_keygen:
                raise RuntimeError("Brak programu ssh-keygen; nie można wygenerować klucza.")
            proc = subprocess.run(
                [ssh_keygen, "-q", "-t", "ed25519", "-N", "", "-f", str(key_path), "-C", key_comment],
                capture_output=True,
                text=True,
                timeout=20,
                check=False,
            )
            if proc.returncode != 0:
                raise RuntimeError((proc.stderr or "Generowanie klucza SSH nie powiodło się.").strip())
            generated = True

        if not key_path.exists() or not public_key_path.exists():
            raise ValueError("Brak pary kluczy SSH. Ustaw generate_key=true.")
        key_path.chmod(0o600)
        public_key_path.chmod(0o644)

        host_aliases = "SVL-365 Ship2" if is_svl365 and alias in {"SVL-365", "Ship2"} else ("Ship SVL-364" if not is_svl365 and alias in {"Ship", "SVL-364"} else alias)
        entry = (
            f"# BEGIN {'SVL-365' if is_svl365 else 'SVL-364'} ({alias})\n"
            f"Host {host_aliases}\n"
            f"    HostName {hostname}\n"
            f"    Port {port}\n"
            f"    User {user}\n"
            f"    IdentityFile {key_path}\n"
            "    IdentitiesOnly yes\n"
            "    BatchMode yes\n"
            "    ConnectTimeout 10\n"
            "    ServerAliveInterval 15\n"
            "    ServerAliveCountMax 3\n"
            "    StrictHostKeyChecking accept-new\n"
            f"# END {'SVL-365' if is_svl365 else 'SVL-364'} ({alias})\n"
        )
        dedicated_path = config_dir / conf_filename
        dedicated_tmp = dedicated_path.with_suffix(".conf.tmp")
        dedicated_tmp.write_text(entry, encoding="utf-8")
        dedicated_tmp.chmod(0o600)
        dedicated_tmp.replace(dedicated_path)

        main_config = ssh_dir / "config"
        include_line = "Include config.d/*.conf"
        existing = main_config.read_text(encoding="utf-8") if main_config.exists() else ""
        if not any(line.strip() == include_line for line in existing.splitlines()):
            main_tmp = main_config.with_suffix(".tmp")
            main_tmp.write_text(f"{include_line}\n\n{existing}", encoding="utf-8")
            main_tmp.chmod(0o600)
            main_tmp.replace(main_config)

        if is_svl365:
            status = self.get_status()
        else:
            status = self.update_config(
                {"ssh_host": alias, "ssh_port": port, "ssh_user": user},
                origin=origin,
                correlation_id=correlation_id,
            )
        public_key = public_key_path.read_text(encoding="utf-8").strip()
        append_python_log(
            "ssh_config",
            f"Skonfigurowano OpenSSH dla {user}@{hostname}:{port} ({alias}), klucz wygenerowany={generated}",
            level="INFO",
            origin=origin,
            correlation_id=correlation_id,
        )
        return {
            "ok": True,
            "configured": True,
            "alias": alias,
            "hostname": hostname,
            "port": port,
            "user": user,
            "keyGenerated": generated,
            "publicKey": public_key,
            "publicKeyPath": str(public_key_path),
            "configPath": str(dedicated_path),
            "status": status,
            "nextStep": f"Dodaj publicKey do ~/.ssh/authorized_keys na {alias}, następnie wywołaj svl_ssh_test.",
        }

    def get_public_key(self, alias: str = "Ship") -> dict[str, Any]:
        is_svl365 = str(alias or "").strip().lower() in {"svl-365", "svl365", "ship2", "ship-365"}
        path = Path.home() / ".ssh" / ("svl365_ed25519.pub" if is_svl365 else "svl364_ed25519.pub")
        if not path.is_file():
            return {
                "ok": False,
                "error": f"Brak publicznego klucza dla {alias}. Najpierw użyj svl_ssh_configure z generate_key=true.",
            }
        return {"ok": True, "publicKey": path.read_text(encoding="utf-8").strip(), "path": str(path)}

    def test_connection(self, timeout_sec: int = 12, target_override: Optional[str] = None) -> dict[str, Any]:
        target = str(target_override or "").strip() or self.configured_target()
        diagnostics: dict[str, Any] = {"target": target, "config": {}, "tcp": {}, "authentication": {}}
        ssh_bin = find_real_binary("ssh")
        if not ssh_bin:
            return {"ok": False, "error": "Brak klienta OpenSSH.", "diagnostics": diagnostics}
        config = subprocess.run(
            [ssh_bin, "-G", target],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        if config.returncode != 0:
            diagnostics["config"] = {"ok": False, "error": (config.stderr or config.stdout).strip()}
            return {"ok": False, "error": "OpenSSH nie rozpoznał konfiguracji celu.", "diagnostics": diagnostics}
        effective: dict[str, str] = {}
        for line in config.stdout.splitlines():
            key, _, value = line.partition(" ")
            if key and value:
                effective.setdefault(key.lower(), value)
        host = effective.get("hostname", target)
        port = int(effective.get("port") or 22)
        diagnostics["config"] = {
            "ok": True,
            "hostname": host,
            "port": port,
            "user": effective.get("user", ""),
            "identityFile": effective.get("identityfile", ""),
        }
        try:
            with socket.create_connection((host, port), timeout=4):
                diagnostics["tcp"] = {"ok": True}
        except OSError as exc:
            diagnostics["tcp"] = {"ok": False, "error": str(exc)}
            return {"ok": False, "error": f"Brak połączenia TCP z {host}:{port}.", "diagnostics": diagnostics}
        auth = subprocess.run(
            [
                ssh_bin,
                "-T",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=8",
                target,
                "printf '__SVL_SSH_OK__\\n'",
            ],
            capture_output=True,
            text=True,
            timeout=max(8, min(30, timeout_sec)),
            check=False,
        )
        diagnostics["authentication"] = {
            "ok": auth.returncode == 0,
            "exitCode": auth.returncode,
            "error": (auth.stderr or "").strip(),
        }
        self.ssh_connected = auth.returncode == 0
        return {
            "ok": auth.returncode == 0,
            "target": target,
            "diagnostics": diagnostics,
            "error": "" if auth.returncode == 0 else "Host jest osiągalny TCP, ale uwierzytelnienie SSH nie powiodło się.",
        }

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
            "utwórz", "utworz", "dodaj", "usuń", "usun", "napraw", "popraw", "ulepsz",
            "rozwiń", "rozwin", "rozwijaj", "misja", "misję", "misje", "audyt",
            "zaktualizuj", "synchronizuj", "wyślij", "wyslij", "przeskanuj", "skanuj",
            "zbadaj", "podaj", "jaki", "jaka", "jakie", "czy", "ile", "gdzie",
            "dlaczego", "opisz", "wyjaśnij", "wyjasnij", "przetwórz", "przetworz",
            "daj", "nadaj", "połącz", "polacz", "zresetuj", "raport", "telemetria",
            "diagnostyka", "pomoc", "wykonaj", "zrób", "zrob", "aktywuj", "odblokuj",
            "zablokuj", "przełącz", "przelacz", "skieruj", "leć", "lec", "kurs",
            "tarcze", "reaktor", "statek", "jyn", "jedi", "check", "show", "report",
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
        sqlite_lookup = (
            "db=next((p for p in (os.environ.get('SVL_SQLITE_PATH',''), "
            "'data/svl_os.sqlite3', '/app/applet/data/svl_os.sqlite3') if p and os.path.exists(p)), ''); "
            "c=sqlite3.connect(db) if db else None; "
        )
        if re.search(r"\b(?:ulepsz\w*|popraw\w*|napraw\w*|rozwi[ńn]\w*|rozwij\w*|misj\w*|audyt\w*)\b", low):
            synthesized = (
                "id && hostname && uname -srm && uptime && free -m && df -h / && "
                "(ss -tlnp 2>/dev/null | grep -E ':(3000|8085|11434|2222)' || true) && "
                "(ollama --version 2>/dev/null; OLLAMA_HOST=127.0.0.1:11434 ollama list 2>/dev/null || true) && "
                'python3 -c "import glob, os, sqlite3; '
                "parts=glob.glob('/root/.ollama/models/blobs/*.curlpart'); "
                "parts and print('Pobieranie modelu Ollama (blob .curlpart MB):', [round(os.path.getsize(p)/1048576, 1) for p in parts]); "
                + sqlite_lookup
                + "print('\\n'.join(f'{r[0]} | {r[1]} | rev {r[2]}' for r in c.execute('SELECT id, status, revision FROM system_modules ORDER BY id')) if c else 'Brak bazy svl_os.sqlite3')\""
            )
        elif re.search(r"\b(?:ufw|zapor\w*|firewall|port(?:y|ów|ow|em|ach)?|sie[ćc]\w*|ip|qkd)\b", low):
            synthesized = "id && hostname && (ufw status 2>/dev/null || ss -tlnp 2>/dev/null) && ip -br addr"
        elif re.search(r"\b(?:proces\w*|worker\w*|daemon\w*|cpu|obci[ąa][żz]en\w*|top|ps)\b", low):
            synthesized = "id && ps -eo pid,user,comm,%cpu,%mem --sort=-%cpu | head -n 12"
        elif re.search(r"\b(?:dysk\w*|miejsc\w*|plik\w*|katalog\w*|storage)\b", low):
            synthesized = "id && df -h / && ls -la"
        elif re.search(r"\b(?:pami[ęe][ćc]\w*|ram|swap)\b", low):
            synthesized = "id && free -m && uname -srm"
        elif re.search(r"\b(?:ollama|model\w*|vision)\b", low):
            synthesized = "id && (ollama --version && ollama list || echo 'Ollama: niedostępna lokalnie')"
        elif re.search(r"\b(?:baz\w*|sqlite|modu[łl]\w*|notatk\w*|jyn|jedi)\b", low):
            synthesized = (
                'id && python3 -c "import os, sqlite3; '
                + sqlite_lookup
                + "print('\\n'.join(f'{r[0]} | {r[1]} | rev {r[2]}' for r in c.execute('SELECT id, status, revision FROM system_modules ORDER BY revision DESC LIMIT 10')) if c else 'Brak bazy svl_os.sqlite3')\""
            )

        return is_explicit_exec, "natural", synthesized, stripped

    @staticmethod
    def _wrap_root_shell_command(shell_cmd: str) -> str:
        """Opakowuje dowolne polecenie powłoki tak, by wykonało się jako ROOT (uid=0 lub sudo -n)."""
        quoted = shlex.quote(shell_cmd)
        return (
            f"if [ \"$(id -u)\" -eq 0 ]; then /bin/bash -lc {quoted}; "
            f"elif command -v sudo >/dev/null 2>&1; then sudo -n /bin/bash -lc {quoted}; "
            f"else /bin/bash -lc {quoted}; fi"
        )

    def execute_ssh_command(
        self,
        command: str,
        timeout_sec: float = 15.0,
        origin: str = "ssh-bridge",
        target_subsystem: str = "bridge",
        correlation_id: str = "",
        confirmed: bool = False,
        raw: bool = False,
        as_root: bool = False,
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
        if raw:
            # Tryb dosłowny (konsola operatora): na statku wykonuje się DOKŁADNIE to, co wpisano
            # (po zdjęciu opcjonalnego prefiksu /exec, /root, /sh, ! lub #) — bez interpretacji i podmiany.
            verbatim = re.sub(r"^(?:/(?:exec|root|sh|ssh)\s+|!\s*|#\s*)", "", clean_cmd, flags=re.IGNORECASE).strip()
            cmd_mode = "shell"
            effective_shell_cmd = verbatim or clean_cmd
            natural_directive = None

        mods = {m["id"]: m for m in self.kernel.list_system_modules()}
        cfg = dict(self._default_config())
        if "svl-364-ssh-mcp" in mods and isinstance(mods["svl-364-ssh-mcp"].get("config"), dict):
            cfg.update(mods["svl-364-ssh-mcp"]["config"])

        natural_summary_lines: list[str] = []
        if cmd_mode == "natural" and natural_directive:
            natural_summary_lines = [f"Przetworzono polecenie naturalne: {natural_directive}"]

        override_alias = str(kwargs.get("alias") or kwargs.get("target") or "").strip()
        if override_alias:
            ssh_host = self._validate_openssh_value(override_alias, "aliasu SSH", r"[A-Za-z0-9][A-Za-z0-9._@-]{0,62}", 63)
        else:
            ssh_host = self._configured_ssh_target(cfg)
        # Tylko prawdziwy OpenSSH; nigdy nie wykonujemy polecenia lokalnie zamiast zdalnie.
        ssh_bin = find_real_binary("ssh")
        if not ssh_bin:
            message = (
                f"OpenSSH (`ssh`) nie jest zainstalowany na hoście backendu (cel: ssh://{ssh_host}) — "
                "polecenie zdalne nie zostało wykonane. Zainstaluj pakiet `openssh-client` lub skonfiguruj zdalny serwer MCP SVL-364."
            )
            return {
                "ok": False,
                "error": message,
                "exitCode": 127,
                "output": "",
                "stdout": "",
                "stderr": message,
                "sshEndpoint": f"ssh://{ssh_host}",
                "transport": "openssh-root" if as_root else "openssh",
                "ssh_status": self.get_status(),
                "serverRevision": self.kernel.get_server_revision(),
            }

        self.ssh_sessions_count += 1
        started = time.time()

        remote_shell_payload = (
            self._wrap_root_shell_command(effective_shell_cmd)
            if as_root
            else f"/bin/bash -lc {shlex.quote(effective_shell_cmd)}"
        )

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
                    remote_shell_payload,
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
        mode_tag = (
            "ROOT /exec"
            if (is_explicit_exec or as_root)
            else ("Natural AI ROOT" if cmd_mode == "natural" else "OpenSSH config/agent")
        )
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
            "asRoot": bool(as_root),
            "transport": "openssh-root" if as_root else "openssh",
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

        telemetry = getattr(self, "telemetry", None)
        if telemetry is not None:
            telemetry._ssh_target_cache.pop(ssh_host, None)

        append_python_log(
            "ssh_exec",
            f"ssh://{ssh_host} mode={cmd_mode} as_root={as_root} exit={exit_code} ({duration_ms} ms) $ {clean_cmd[:160]}",
            level="INFO" if exit_code == 0 else "ERROR",
            correlation_id=correlation_id,
            origin=origin,
            details={"effectiveCommand": effective_shell_cmd[:240], "subsystem": target_subsystem, "exitCode": exit_code, "asRoot": bool(as_root)},
        )

        return {
            "ok": exit_code == 0,
            "error": "" if exit_code == 0 else (stderr_out or f"Połączenie SSH z {ssh_host} zakończyło się kodem {exit_code}."),
            "command": clean_cmd,
            "effectiveCommand": effective_shell_cmd,
            "mode": cmd_mode,
            "asRoot": bool(as_root),
            "transport": "openssh-root" if as_root else "openssh",
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

    def execute_root_command(
        self,
        command: str,
        timeout_sec: float = 30.0,
        origin: str = "svl364-mcp-root",
        correlation_id: str = "",
        confirmed: bool = False,
        raw: bool = True,
        prefer_transport: str = "auto",
    ) -> dict[str, Any]:
        """
        Wykonuje DOWOLNE polecenie powłoki lub zapytanie jako ROOT (uid=0 / sudo -n)
        na komputerze pokładowym statku SVL-364.
        Priorytet transportu (prefer_transport='auto'):
          1. Zdalny serwer MCP SVL-364 (Zero-IP HTTPS / Tailscale / Mesh -> run_command z eskalacją ROOT)
          2. Mostek OpenSSH (ssh://Ship z eskalacją ROOT)
        """
        clean_cmd = str(command or "").strip()
        if not confirmed:
            message = "Wykonanie polecenia ROOT na SVL-364 wymaga jawnego confirmed=true."
            return {"ok": False, "error": message, "exitCode": 1, "output": "", "rawOutput": "", "transport": "none"}
        if not clean_cmd:
            message = "Polecenie ROOT dla SVL-364 nie może być puste."
            return {"ok": False, "error": message, "exitCode": 1, "output": "", "rawOutput": "", "transport": "none"}

        verbatim_cmd = re.sub(r"^(?:/(?:exec|root|sh|ssh)\s+|!\s*|#\s*)", "", clean_cmd, flags=re.IGNORECASE).strip() if raw else clean_cmd
        effective_cmd = verbatim_cmd or clean_cmd
        transport_choice = str(prefer_transport or "auto").strip().lower()
        if transport_choice not in {"auto", "remote-mcp", "ssh"}:
            transport_choice = "auto"

        remote_cfg = self._load_remote_mcp_settings()
        use_root_escalation = bool(remote_cfg.get("rootExecEnabled", True))
        remote_error = ""

        if transport_choice in {"auto", "remote-mcp"} and remote_cfg["enabled"] and remote_cfg["url"]:
            started = time.time()
            remote_shell_cmd = (
                self._wrap_root_shell_command(effective_cmd) if use_root_escalation else effective_cmd
            )
            remote_res = self.call_remote_mcp_tool(
                "run_command",
                {
                    "command": remote_shell_cmd,
                    "timeout_ms": int(max(2.0, min(60.0, float(timeout_sec or 30.0))) * 1000),
                },
                timeout_sec=float(timeout_sec or 30.0) + 5.0,
                origin=origin,
            )
            duration_ms = round((time.time() - started) * 1000, 1)
            raw_out = str(remote_res.get("output") or "")
            exit_code = 0 if remote_res.get("ok") else 1
            exit_match = re.match(r"^exit_code:\s*(-?\d+)\s*(?:\n|$)", raw_out)
            if exit_match:
                exit_code = int(exit_match.group(1))
                cleaned_body = raw_out[exit_match.end():].strip()
            else:
                cleaned_body = raw_out.strip()

            if remote_res.get("ok") or transport_choice == "remote-mcp" or exit_match is not None:
                ok = exit_code == 0 and bool(remote_res.get("ok") or exit_match is not None)
                header = f"[MCP ROOT · SVL-364] {remote_cfg['url']} (uid=0) · {duration_ms} ms"
                formatted = f"{header}\n# {effective_cmd}\n{cleaned_body or f'(kod wyjścia {exit_code})'}"
                entry = {
                    "id": f"mcp-root-{uuid.uuid4().hex[:10]}",
                    "kind": "mcp_root_exec",
                    "command": clean_cmd,
                    "effectiveCommand": effective_cmd,
                    "asRoot": use_root_escalation,
                    "transport": "remote-mcp-root",
                    "mcpUrl": remote_cfg["url"],
                    "exitCode": exit_code,
                    "durationMs": duration_ms,
                    "output": formatted,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "origin": origin,
                }
                self.recent_activity.append(entry)
                try:
                    self.kernel.append_terminal_entry(
                        "ssh",
                        {
                            "kind": "stdout" if ok else "stderr",
                            "text": formatted,
                            "command": effective_cmd[:300],
                            "timestamp": datetime.now(timezone.utc).strftime("%H:%M:%S"),
                        },
                        origin=origin,
                        correlation_id=correlation_id,
                    )
                except Exception:
                    pass
                append_python_log(
                    "svl364_root_exec",
                    f"remote-mcp {remote_cfg['url']} exit={exit_code} ({duration_ms} ms) # {effective_cmd[:160]}",
                    level="INFO" if ok else "ERROR",
                    correlation_id=correlation_id,
                    origin=origin,
                )
                return {
                    "ok": ok,
                    "error": "" if ok else (str(remote_res.get("error") or "") or f"Polecenie zakończyło się kodem {exit_code}."),
                    "command": clean_cmd,
                    "effectiveCommand": effective_cmd,
                    "asRoot": use_root_escalation,
                    "transport": "remote-mcp-root",
                    "endpoint": remote_cfg["url"],
                    "exitCode": exit_code,
                    "durationMs": duration_ms,
                    "output": formatted,
                    "stdout": formatted if ok else "",
                    "stderr": formatted if not ok else "",
                    "rawOutput": cleaned_body,
                    "entry": entry,
                    "ssh_status": self.get_status(),
                    "serverRevision": self.kernel.get_server_revision(),
                }
            remote_error = str(remote_res.get("error") or "Zdalny MCP SVL-364 nie odpowiedział.")
        elif transport_choice == "remote-mcp":
            msg = "Zdalny serwer MCP SVL-364 nie jest skonfigurowany. Użyj `/mcp connect <url> <token>`."
            return {
                "ok": False,
                "error": msg,
                "command": clean_cmd,
                "effectiveCommand": effective_cmd,
                "asRoot": use_root_escalation,
                "transport": "remote-mcp-root",
                "exitCode": 1,
                "output": msg,
                "rawOutput": msg,
                "ssh_status": self.get_status(),
                "serverRevision": self.kernel.get_server_revision(),
            }

        ssh_res = self.execute_ssh_command(
            effective_cmd,
            timeout_sec=timeout_sec,
            origin=origin,
            target_subsystem="svl364-mcp-root",
            correlation_id=correlation_id,
            confirmed=True,
            raw=raw,
            as_root=use_root_escalation,
        )
        ssh_res["endpoint"] = ssh_res.get("sshEndpoint", f"ssh://{self.configured_target()}")
        if remote_error:
            ssh_res["remoteMcpFallbackReason"] = remote_error
        return ssh_res

    @staticmethod
    def _require_identifier(value: Any, label: str, pattern: str, required: bool = True) -> str:
        clean = str(value or "").strip()
        if not clean and not required:
            return ""
        if not clean or len(clean) > 253 or not re.fullmatch(pattern, clean):
            raise ValueError(f"Nieprawidłowa wartość {label}.")
        return clean

    def _run_managed_operation(
        self, command: str, arguments: dict[str, Any], origin: str, requires_confirmation: bool
    ) -> dict[str, Any]:
        if requires_confirmation and arguments.get("confirmed") is not True:
            return {
                "ok": False,
                "error": "Operacja zarządcza SVL-364 wymaga jawnego confirmed=true.",
                "formattedText": "Operacja nie została wykonana: brak potwierdzenia operatora.",
                "executed": False,
            }
        remote_cfg = self._load_remote_mcp_settings()
        if remote_cfg["enabled"] and remote_cfg["url"]:
            result = self.execute_root_command(
                command,
                timeout_sec=float(arguments.get("timeout_sec") or 30.0),
                origin=f"mcp-managed:{origin}",
                confirmed=True,
                raw=True,
                prefer_transport="auto",
            )
            result["formattedText"] = result.get("output") or result.get("error", "")
            result["executed"] = True
            return result
        result = self.execute_ssh_command(
            command,
            timeout_sec=float(arguments.get("timeout_sec") or 30.0),
            origin=f"mcp-managed:{origin}",
            confirmed=True,
            raw=True,
            target_subsystem="computer-account",
        )
        result["formattedText"] = result.get("output") or result.get("error", "")
        result["executed"] = True
        return result

    def run_resource_tool(self, arguments: dict[str, Any], origin: str) -> dict[str, Any]:
        area = str(arguments.get("area") or "").strip()
        target = str(arguments.get("target") or "").strip()
        lines = max(10, min(500, int(arguments.get("lines") or 100)))
        commands = {
            "overview": "printf '%s\\n' '--- OS ---'; uname -a; cat /etc/os-release; printf '%s\\n' '--- CPU/RAM ---'; lscpu; free -h; printf '%s\\n' '--- DISK ---'; df -hT",
            "services": "systemctl list-units --type=service --all --no-pager --no-legend",
            "containers": "(docker ps -a --no-trunc 2>/dev/null || podman ps -a 2>/dev/null || true)",
            "ports": "ss -lntup",
            "processes": "ps -eo pid,user,comm,%cpu,%mem,etime,args --sort=-%cpu | head -n 30",
        }
        if area == "logs":
            unit = self._require_identifier(target, "jednostki logów", r"[A-Za-z0-9_.@-]{1,128}")
            command = f"journalctl -u {shlex.quote(unit)} -n {lines} --no-pager"
        elif area in commands:
            command = commands[area]
        else:
            raise ValueError("Nieznany obszar diagnostyki.")
        return self._run_managed_operation(command, arguments, origin, False)

    def run_service_tool(self, arguments: dict[str, Any], origin: str) -> dict[str, Any]:
        service = self._require_identifier(arguments.get("service"), "usługi", r"[A-Za-z0-9_.@-]{1,128}")
        action = str(arguments.get("action") or "")
        if action not in {"status", "start", "restart", "stop", "enable", "disable"}:
            raise ValueError("Nieznana operacja systemd.")
        if action == "status":
            command = (
                f"systemctl status {shlex.quote(service)} --no-pager 2>&1 || "
                f"printf 'stan=%s\\n' \"$(systemctl is-active {shlex.quote(service)} 2>/dev/null || echo 'inactive')\""
            )
        else:
            command = f"systemctl {action} {shlex.quote(service)}"
        return self._run_managed_operation(command, arguments, origin, action != "status")

    def run_ollama_tool(self, arguments: dict[str, Any], origin: str) -> dict[str, Any]:
        action = str(arguments.get("action") or "")
        model = self._require_identifier(
            arguments.get("model"),
            "modelu Ollamy",
            r"[A-Za-z0-9][A-Za-z0-9_.:/+-]{0,159}",
            required=action in {"show", "pull", "remove", "run"},
        )
        if action == "status":
            command = (
                "(command -v ollama >/dev/null 2>&1 && (ollama --version && (ollama ps 2>&1 || true))) || "
                "curl -fsS --max-time 3 http://127.0.0.1:11434/api/version 2>/dev/null || "
                "echo 'Ollama: nie zainstalowana lub demon :11434 nieaktywny na tym węźle'"
            )
        elif action == "list":
            command = (
                "(command -v ollama >/dev/null 2>&1 && (ollama list 2>&1 || true)) || "
                "curl -fsS --max-time 3 http://127.0.0.1:11434/api/tags 2>/dev/null || "
                "echo 'Ollama: brak zainstalowanych modeli lokalnych na tym węźle'"
            )
        elif action == "show":
            command = f"ollama show {shlex.quote(model)}"
        elif action == "pull":
            command = f"ollama pull {shlex.quote(model)}"
        elif action == "remove":
            command = f"ollama rm {shlex.quote(model)}"
        elif action == "run":
            command = f"printf '%s\\n' 'Odpowiedz jednym zdaniem: gotowy' | ollama run {shlex.quote(model)}"
        elif action == "create_apex":
            base_model = model or "llama3.2-vision:11b"
            command = (
                "mf=/tmp/Modelfile.apex-uncensored; "
                f"printf 'FROM %s\\nPARAMETER num_ctx 16384\\nPARAMETER temperature 0.75\\nPARAMETER top_p 0.92\\nPARAMETER repeat_penalty 1.08\\n' {shlex.quote(base_model)} > \"$mf\" && "
                "ollama create svl364-apex-uncensored:latest -f \"$mf\" && rm -f \"$mf\" && ollama list"
            )
        else:
            raise ValueError("Nieznana operacja Ollamy.")
        return self._run_managed_operation(command, arguments, origin, action in {"pull", "remove", "run", "create_apex"})

    def run_file_tool(self, arguments: dict[str, Any], origin: str) -> dict[str, Any]:
        normalized = os.path.normpath(str(arguments.get("path") or "").strip())
        allowed_roots = ("/app", "/opt/svl", "/srv", "/var/log", "/var/backups/svl364", str(self.project_root))
        if not normalized.startswith("/") or not any(
            normalized == root or normalized.startswith(root + "/") for root in allowed_roots
        ):
            raise ValueError("Ścieżka jest poza dozwolonymi katalogami SVL-364.")
        action = str(arguments.get("action") or "")
        lines = max(10, min(500, int(arguments.get("lines") or 100)))
        quoted = shlex.quote(normalized)
        if action == "list":
            command = f"ls -lah -- {quoted}"
        elif action == "stat":
            command = f"stat -- {quoted}"
        elif action == "read_log":
            command = f"test -f {quoted} && tail -n {lines} -- {quoted}"
        elif action == "backup":
            timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            name = re.sub(r"[^A-Za-z0-9_.-]+", "_", Path(normalized).name or "svl")
            command = (
                "mkdir -p /var/backups/svl364 && "
                f"tar -czf /var/backups/svl364/{name}-{timestamp}.tar.gz -- {quoted}"
            )
        else:
            raise ValueError("Nieznana operacja plikowa.")
        return self._run_managed_operation(command, arguments, origin, action == "backup")

    def run_network_tool(self, arguments: dict[str, Any], origin: str) -> dict[str, Any]:
        action = str(arguments.get("action") or "")
        commands = {
            "interfaces": "ip -br addr; ip -s link",
            "routes": "ip route; ip -6 route",
            "ports": "ss -lntup",
            "dns": "resolvectl status 2>/dev/null || cat /etc/resolv.conf",
            "firewall": "(ufw status verbose 2>/dev/null || nft list ruleset 2>/dev/null || iptables -S 2>/dev/null)",
        }
        if action in commands:
            command = commands[action]
        elif action == "trace":
            host = self._require_identifier(
                arguments.get("target"), "hosta", r"[A-Za-z0-9][A-Za-z0-9._:-]{0,252}"
            )
            command = f"traceroute -n -m 15 {shlex.quote(host)} 2>/dev/null || tracepath -n {shlex.quote(host)}"
        else:
            raise ValueError("Nieznana operacja sieciowa.")
        return self._run_managed_operation(command, arguments, origin, False)

    def run_update_tool(self, arguments: dict[str, Any], origin: str) -> dict[str, Any]:
        action = str(arguments.get("action") or "")
        if action == "status":
            command = "apt-get -s upgrade; apt-mark showhold"
        elif action == "refresh":
            command = "apt-get update"
        elif action == "upgrade_package":
            package = self._require_identifier(
                arguments.get("package"), "pakietu apt", r"[A-Za-z0-9][A-Za-z0-9+.-]{0,127}"
            )
            command = f"DEBIAN_FRONTEND=noninteractive apt-get install -y --only-upgrade {shlex.quote(package)}"
        else:
            raise ValueError("Nieznana operacja aktualizacji.")
        return self._run_managed_operation(command, arguments, origin, action != "status")

    def run_tunnel_tool(self, arguments: dict[str, Any], origin: str) -> dict[str, Any]:
        action = str(arguments.get("action") or "status").strip().lower()
        lines = max(10, min(500, int(arguments.get("lines") or 80)))
        if action == "status":
            command = (
                "printf '%s\\n' '--- SVL-MCP SERVICE ---'; "
                "systemctl is-active svl-mcp.service 2>/dev/null || echo 'inactive'; "
                "printf '%s\\n' '--- TUNNEL STATE ---'; "
                "for f in /opt/svl-coreos-2/data/svl_mcp_tunnel.json /opt/svl-python-os/data/svl_mcp_tunnel.json ./data/svl_mcp_tunnel.json; do "
                "  if [ -f \"$f\" ]; then echo \"FILE: $f\"; cat \"$f\"; break; fi; "
                "done; "
                "printf '%s\\n' '--- ZERO-IP BINARIES ---'; "
                "for b in cloudflared tailscale ngrok zerotier-cli; do "
                "  command -v \"$b\" >/dev/null 2>&1 && echo \"$b=installed\" || echo \"$b=missing\"; "
                "done"
            )
            return self._run_managed_operation(command, arguments, origin, False)
        if action == "mesh_info":
            command = (
                "printf '%s\\n' '--- MESH INTERFACES ---'; "
                "ip -br addr | grep -E 'tailscale|zt|wg|ham|100\\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\\.' || echo '(brak wykrytych interfejsów mesh)'; "
                "printf '%s\\n' '--- TAILSCALE ---'; "
                "(tailscale status 2>/dev/null || echo 'tailscale: niedostępny'); "
                "printf '%s\\n' '--- ZEROTIER ---'; "
                "(zerotier-cli listnetworks 2>/dev/null || echo 'zerotier: niedostępny')"
            )
            return self._run_managed_operation(command, arguments, origin, False)
        if action == "tailscale_status":
            command = "(tailscale status 2>/dev/null; echo '--- FUNNEL ---'; tailscale funnel status 2>/dev/null) || echo 'Tailscale nie jest uruchomiony'"
            return self._run_managed_operation(command, arguments, origin, False)
        if action == "mcp_logs":
            command = f"journalctl -u svl-mcp.service -n {lines} --no-pager"
            return self._run_managed_operation(command, arguments, origin, False)
        if action == "restart_mcp":
            command = "systemctl restart svl-mcp.service && sleep 2 && systemctl is-active svl-mcp.service"
            return self._run_managed_operation(command, arguments, origin, True)
        if action == "restart_ollama_tunnel":
            command = "systemctl restart svl-ship-ollama-tunnel.service 2>/dev/null && systemctl is-active svl-ship-ollama-tunnel.service || echo 'Brak usługi svl-ship-ollama-tunnel.service'"
            return self._run_managed_operation(command, arguments, origin, True)
        if action == "enable_tailscale_funnel":
            command = "tailscale funnel --bg 3334 && tailscale funnel status"
            return self._run_managed_operation(command, arguments, origin, True)
        raise ValueError("Nieznana akcja tunelu Zero-IP na SVL-364.")

    def run_container_tool(self, arguments: dict[str, Any], origin: str) -> dict[str, Any]:
        action = str(arguments.get("action") or "list").strip().lower()
        lines = max(10, min(500, int(arguments.get("lines") or 80)))
        runtime = "command -v docker >/dev/null 2>&1 && echo docker || (command -v podman >/dev/null 2>&1 && echo podman || echo '')"
        if action == "list":
            command = f"rt=$({runtime}); if [ -n \"$rt\" ]; then \"$rt\" ps -a 2>&1 || echo 'Demon kontenerów ($rt) nie jest uruchomiony'; else echo 'Brak Docker/Podman na SVL-364'; fi"
            return self._run_managed_operation(command, arguments, origin, False)
        if action == "stats":
            command = f"rt=$({runtime}); if [ -n \"$rt\" ]; then \"$rt\" stats --no-stream 2>&1 || echo 'Demon kontenerów ($rt) nie jest uruchomiony'; else echo 'Brak Docker/Podman na SVL-364'; fi"
            return self._run_managed_operation(command, arguments, origin, False)
        container = self._require_identifier(arguments.get("container"), "kontenera", r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}")
        if action == "logs":
            command = f"rt=$({runtime}); [ -n \"$rt\" ] && \"$rt\" logs --tail {lines} {shlex.quote(container)} || echo 'Brak Docker/Podman'"
            return self._run_managed_operation(command, arguments, origin, False)
        if action in {"restart", "start", "stop"}:
            command = f"rt=$({runtime}); [ -n \"$rt\" ] && \"$rt\" {action} {shlex.quote(container)} || echo 'Brak Docker/Podman'"
            return self._run_managed_operation(command, arguments, origin, True)
        raise ValueError("Nieznana operacja kontenerów.")

    def run_comfyui_tool(self, arguments: dict[str, Any], origin: str) -> dict[str, Any]:
        action = str(arguments.get("action") or "status").strip().lower()
        lines = max(10, min(500, int(arguments.get("lines") or 80)))
        if action == "status":
            command = (
                "systemctl is-active svl-comfyui.service 2>/dev/null || echo 'service: inactive'; "
                "curl -fsS --max-time 4 http://127.0.0.1:8188/system_stats 2>/dev/null || echo 'ComfyUI HTTP :8188 nie odpowiada'"
            )
            return self._run_managed_operation(command, arguments, origin, False)
        if action == "queue":
            command = "curl -fsS --max-time 4 http://127.0.0.1:8188/queue 2>/dev/null || echo 'ComfyUI HTTP :8188 nie odpowiada'"
            return self._run_managed_operation(command, arguments, origin, False)
        if action == "logs":
            command = f"journalctl -u svl-comfyui.service -n {lines} --no-pager"
            return self._run_managed_operation(command, arguments, origin, False)
        if action == "restart":
            command = "systemctl restart svl-comfyui.service && systemctl is-active svl-comfyui.service"
            return self._run_managed_operation(command, arguments, origin, True)
        raise ValueError("Nieznana operacja ComfyUI.")

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
                        "version": "6.0.0",
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
                        {
                            "uri": "svl364://tunnel/zero-ip",
                            "name": "Stan tunelu Zero-IP i sieci mesh SVL-364",
                            "mimeType": "application/json",
                        },
                        {
                            "uri": "svl364://services/all",
                            "name": "Katalog wszystkich usług i narzędzi hosta SVL-364",
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
            ssh_kwargs: dict[str, Any] = {
                "timeout_sec": timeout_sec,
                "origin": f"mcp:{origin}",
                "confirmed": arguments.get("confirmed") is True,
            }
            if "as_root" in arguments:
                ssh_kwargs["as_root"] = bool(arguments.get("as_root"))
            if "raw" in arguments:
                ssh_kwargs["raw"] = bool(arguments.get("raw"))
            if arguments.get("alias") or arguments.get("target"):
                ssh_kwargs["alias"] = str(arguments.get("alias") or arguments.get("target")).strip()
            ssh_res = self.execute_ssh_command(cmd, **ssh_kwargs)
            return {
                "ok": ssh_res["ok"],
                "tool": tool_name,
                "arguments": arguments,
                "error": ssh_res.get("error"),
                "formattedText": ssh_res["output"] or ssh_res.get("error", ""),
                "data": ssh_res,
                "serverRevision": self.kernel.get_server_revision(),
            }

        if tool_name == "svl364_root_exec":
            cmd = str(arguments.get("command") or "")
            timeout_sec = float(arguments.get("timeout_sec") or 30.0)
            root_res = self.execute_root_command(
                cmd,
                timeout_sec=timeout_sec,
                origin=f"mcp:{origin}",
                confirmed=arguments.get("confirmed") is True,
                raw=arguments.get("raw", True) is not False,
                prefer_transport=str(arguments.get("transport") or "auto"),
            )
            return {
                "ok": bool(root_res.get("ok")),
                "tool": tool_name,
                "arguments": arguments,
                "error": root_res.get("error"),
                "formattedText": root_res.get("output") or root_res.get("error", ""),
                "data": root_res,
                "serverRevision": self.kernel.get_server_revision(),
            }

        if tool_name == "svl364_mcp_connect":
            action = str(arguments.get("action") or "status").strip().lower()
            try:
                if action == "status":
                    result = self.get_status()
                elif action in {"configure", "disconnect"}:
                    result = self.configure_remote_mcp(
                        {**arguments, "disconnect": action == "disconnect"},
                        origin=f"mcp:{origin}",
                    )
                elif action == "test":
                    result = self.test_remote_mcp(timeout_sec=float(arguments.get("timeout_sec") or 12.0))
                elif action == "call":
                    remote_tool = str(arguments.get("remote_tool") or "").strip()
                    if not remote_tool:
                        raise ValueError("action=call wymaga parametru remote_tool.")
                    remote_args = arguments.get("remote_arguments")
                    result = self.call_remote_mcp_tool(
                        remote_tool,
                        remote_args if isinstance(remote_args, dict) else {},
                        timeout_sec=float(arguments.get("timeout_sec") or 30.0),
                        origin=f"mcp:{origin}",
                    )
                else:
                    raise ValueError("Nieznana akcja svl364_mcp_connect (status | configure | test | call | disconnect).")
            except (ValueError, RuntimeError) as exc:
                result = {"ok": False, "error": str(exc)}
            safe_log_args = {k: ("***" if k == "token" else v) for k, v in arguments.items()}
            formatted = (
                str(result.get("output"))
                if action == "call" and result.get("output")
                else json.dumps(result, ensure_ascii=False, indent=2)
            )
            self._record_mcp_activity(tool_name, safe_log_args, formatted, started, origin)
            return {
                "ok": result.get("ok") is True,
                "tool": tool_name,
                "arguments": safe_log_args,
                "formattedText": formatted,
                "data": result,
                "error": result.get("error"),
                "serverRevision": self.kernel.get_server_revision(),
            }

        if tool_name == "svl364_ssh_configure":
            try:
                result = self.configure_openssh(arguments, origin=f"mcp:{origin}")
            except (ValueError, RuntimeError) as exc:
                result = {"ok": False, "error": str(exc)}
            self._record_mcp_activity(tool_name, arguments, json.dumps(result, ensure_ascii=False), started, origin)
            return {
                "ok": result.get("ok") is True,
                "tool": tool_name,
                "arguments": arguments,
                "formattedText": json.dumps(result, ensure_ascii=False, indent=2),
                "data": result,
                "error": result.get("error"),
                "serverRevision": self.kernel.get_server_revision(),
            }

        if tool_name == "svl364_ssh_public_key":
            alias_arg = str(arguments.get("alias") or arguments.get("target") or "Ship").strip()
            result = self.get_public_key(alias=alias_arg)
            self._record_mcp_activity(tool_name, arguments, json.dumps(result, ensure_ascii=False), started, origin)
            return {
                "ok": result.get("ok") is True,
                "tool": tool_name,
                "arguments": arguments,
                "formattedText": json.dumps(result, ensure_ascii=False, indent=2),
                "data": result,
                "error": result.get("error"),
                "serverRevision": self.kernel.get_server_revision(),
            }

        if tool_name == "svl364_ssh_test":
            target_arg = str(arguments.get("alias") or arguments.get("target") or "").strip() or None
            result = self.test_connection(target_override=target_arg)
            self._record_mcp_activity(tool_name, arguments, json.dumps(result, ensure_ascii=False), started, origin)
            return {
                "ok": result.get("ok") is True,
                "tool": tool_name,
                "arguments": arguments,
                "formattedText": json.dumps(result, ensure_ascii=False, indent=2),
                "data": result,
                "error": result.get("error"),
                "serverRevision": self.kernel.get_server_revision(),
            }

        managed_tools = {
            "svl364_resources": self.run_resource_tool,
            "svl364_service_control": self.run_service_tool,
            "svl364_ollama_control": self.run_ollama_tool,
            "svl364_file_control": self.run_file_tool,
            "svl364_network_control": self.run_network_tool,
            "svl364_update_control": self.run_update_tool,
            "svl364_tunnel_control": self.run_tunnel_tool,
            "svl364_container_control": self.run_container_tool,
            "svl364_comfyui_control": self.run_comfyui_tool,
        }
        managed_handler = managed_tools.get(tool_name)
        if managed_handler:
            try:
                result = managed_handler(arguments, origin)
            except (ValueError, TypeError) as exc:
                result = {
                    "ok": False,
                    "error": str(exc),
                    "formattedText": f"Operacja odrzucona: {exc}",
                    "executed": False,
                }
            self._record_mcp_activity(tool_name, arguments, result.get("formattedText", ""), started, origin)
            return {
                "ok": result.get("ok") is True,
                "tool": tool_name,
                "arguments": arguments,
                "formattedText": result.get("formattedText", ""),
                "data": result,
                "error": result.get("error"),
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
                ssh_target=self.configured_target(),
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
            self._record_mcp_activity(tool_name, arguments, f"Wygenerowano raport SVL_System (Jyn ROOT): {directive}", started, origin)
            return {
                "ok": True,
                "tool": "svl364_emit_system_report",
                "arguments": arguments,
                "formattedText": summary,
                "data": {"directive": directive, "report": summary},
                "serverRevision": self.kernel.get_server_revision(),
            }

        if tool_name == "svl364_navigation":
            action = str(arguments.get("action") or "status").strip().lower()
            try:
                if action == "set_course":
                    result = self.ship_hub.update_navigation(arguments, origin=f"mcp:{origin}")
                else:
                    result = {"ok": True, "navigation": self.ship_hub.get_navigation()}
            except ValueError as exc:
                result = {"ok": False, "error": str(exc)}
            formatted = json.dumps(result, ensure_ascii=False, indent=2)
            self._record_mcp_activity(tool_name, arguments, formatted, started, origin)
            return {
                "ok": result.get("ok") is True,
                "tool": tool_name,
                "arguments": arguments,
                "formattedText": formatted,
                "data": result,
                "error": result.get("error"),
                "serverRevision": self.kernel.get_server_revision(),
            }

        if tool_name == "svl364_incident_report":
            action = str(arguments.get("action") or "list").strip().lower()
            try:
                if action == "record":
                    result = self.ship_hub.record_incident(arguments, origin=f"mcp:{origin}")
                elif action == "resolve":
                    result = self.ship_hub.resolve_incident(str(arguments.get("incidentId") or ""), origin=f"mcp:{origin}")
                else:
                    result = {"ok": True, "incidents": self.ship_hub.list_stored_incidents(limit=40)}
            except ValueError as exc:
                result = {"ok": False, "error": str(exc)}
            formatted = json.dumps(result, ensure_ascii=False, indent=2)
            self._record_mcp_activity(tool_name, arguments, formatted, started, origin)
            return {
                "ok": result.get("ok") is True,
                "tool": tool_name,
                "arguments": arguments,
                "formattedText": formatted,
                "data": result,
                "error": result.get("error"),
                "serverRevision": self.kernel.get_server_revision(),
            }

        if tool_name == "svl364_infrastructure_registry":
            action = str(arguments.get("action") or "overview").strip().lower()
            payload = arguments.get("payload") if isinstance(arguments.get("payload"), dict) else {}
            try:
                if action in {"overview", "sync_mcp"}:
                    result = self.infrastructure_registry.get_overview(sync_mcp=(action == "sync_mcp"))
                elif action == "upsert_asset":
                    result = self.infrastructure_registry.upsert_asset(payload, origin=f"mcp:{origin}")
                elif action == "upsert_mission":
                    result = self.infrastructure_registry.upsert_mission(payload, origin=f"mcp:{origin}")
                elif action == "upsert_research":
                    result = self.infrastructure_registry.upsert_research(payload, origin=f"mcp:{origin}")
                elif action == "update_botany":
                    result = self.infrastructure_registry.update_botany(payload, origin=f"mcp:{origin}")
                elif action == "order_upgrade":
                    result = self.infrastructure_registry.order_off_earth_upgrade(payload, origin=f"mcp:{origin}")
                else:
                    result = {"ok": False, "error": f"Nieobsługiwana akcja: {action}"}
            except ValueError as exc:
                result = {"ok": False, "error": str(exc)}
            formatted = json.dumps(result, ensure_ascii=False, indent=2)
            self._record_mcp_activity(tool_name, arguments, formatted, started, origin)
            return {
                "ok": result.get("ok") is True,
                "tool": tool_name,
                "arguments": arguments,
                "formattedText": formatted,
                "data": result,
                "error": result.get("error"),
                "serverRevision": self.kernel.get_server_revision(),
            }

        remote_cfg = self._load_remote_mcp_settings()
        if remote_cfg.get("enabled") and remote_cfg.get("url"):
            remote_res = self.call_remote_mcp_tool(
                tool_name,
                arguments if isinstance(arguments, dict) else {},
                origin=f"federated:{origin}",
            )
            formatted = str(remote_res.get("output") or remote_res.get("error") or "")
            self._record_mcp_activity(tool_name, arguments, formatted, started, origin)
            return {
                "ok": bool(remote_res.get("ok")),
                "tool": tool_name,
                "arguments": arguments,
                "formattedText": formatted,
                "data": remote_res,
                "error": remote_res.get("error") or None,
                "serverRevision": self.kernel.get_server_revision(),
            }

        return {
            "ok": False,
            "tool": tool_name,
            "arguments": arguments,
            "formattedText": f"Nieznane narzędzie MCP: {tool_name}",
            "serverRevision": self.kernel.get_server_revision(),
        }

    @property
    def ship_hub(self) -> Any:
        hub = getattr(self, "_ship_hub", None)
        if hub is None:
            try:
                from svl364_ship_telemetry_hub import SVL364ShipHub
            except ImportError:
                from backend.svl364_ship_telemetry_hub import SVL364ShipHub
            hub = SVL364ShipHub(self)
            self._ship_hub = hub
        return hub

    @property
    def infrastructure_registry(self) -> Any:
        reg = getattr(self, "_infrastructure_registry", None)
        if reg is None:
            try:
                from svl_infrastructure_registry import SVLInfrastructureRegistry
            except ImportError:
                from backend.svl_infrastructure_registry import SVLInfrastructureRegistry
            reg = SVLInfrastructureRegistry(self.kernel, self)
            self._infrastructure_registry = reg
        return reg

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
        append_python_log(
            "mcp_tool",
            f"{tool_name} ({duration_ms} ms)",
            level="INFO",
            origin=origin,
            details={"arguments": arguments, "outputPreview": str(output)[:280]},
        )
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
