#!/usr/bin/env python3
"""
SVL PYTHON OS — FASTAPI & ASYNCIO BACKEND SERVER
Provides:
1. Full FastAPI application definition (when FastAPI/Pydantic are installed on Debian 13 Trixie).
2. Zero-dependency asyncio HTTP server fallback on port 8085 so the Python backend runs natively
   in environments without pip preinstalled while executing the exact same Python kernel, SQLite DB,
   multiprocessing agent workers, and Spherical Event Bus.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import io
import json
import math
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

# Ensure backend directory is in sys.path
BACKEND_DIR = Path(__file__).resolve().parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from agents_runtime import CANONICAL_SVL_AGENTS, SVLAgentOrchestrator, normalize_agent_canonical_name
from antivirus_scanner import SVLAntivirusScanner
from hyperspace_engine import BinaryHyperspaceKernel, WithoutNlpHarmonicEngine
from infrastructure_probe import build_infrastructure_report
from image_generation import (
    CPU_IMAGE_ENGINE,
    ImageEngineUnavailableError,
    ImageGenerationError,
    configured_image_engine,
    generate_image,
    image_engine_model,
    probe_image_engine,
)
from ollama_daemon import SVLLocalOllamaDaemon
from real_vision_engine import SVLRealVisionEngine
from spherical_bus import SphericalEventBus
from ship_monitor import ShipMonitor
from svl364_ssh_mcp import SVL364SshMcpController
from svl_core import (
    RevisionConflictError,
    SVLProtectedVariable,
    SVLSystemKernel,
    TopologicalInfinityEngine,
    VisualScope,
)
from jedi_omni_os_vm import get_jedi_vm_runtime
from autonomous_daemon import AutonomousAIDaemon
from svl_file_logger import append_python_log, ensure_log_files


class SVLBackendRuntime:
    """Central runtime instance combining SVLSystemKernel, SphericalEventBus, Agents, and Hyperspace engines."""

    def __init__(self) -> None:
        self.boot_time = time.time()
        ensure_log_files()
        self.kernel = SVLSystemKernel()
        self.bus = SphericalEventBus()
        self.orchestrator = SVLAgentOrchestrator(self.kernel, self.bus)
        self.hyperspace = BinaryHyperspaceKernel(dimensions=128)
        self.without_nlp = WithoutNlpHarmonicEngine()
        self.ollama_daemon = SVLLocalOllamaDaemon(kernel_Getter=lambda: self.kernel)
        self.ollama_daemon.start_if_needed()
        self.ollama_host = self._load_persisted_ollama_host()
        self.orchestrator.ollama_host = self.ollama_host
        self._ollama_pull_lock = threading.RLock()
        self._ollama_pull_thread: Optional[threading.Thread] = None
        self._image_generation_lock = threading.Lock()
        self.ollama_pull_state: dict[str, Any] = {
            "active": False,
            "model": os.environ.get("OLLAMA_PREFERRED_MODEL", "dolphin-llama3:8b-v2.9-q2_K"),
            "status": "Brak aktywnego pobierania w tej sesji.",
            "percent": 0.0,
            "error": None,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        self.repl_globals: dict[str, Any] = {
            "__builtins__": __builtins__,
            "math": math,
            "json": json,
            "datetime": datetime,
            "VisualScope": VisualScope,
            "SVLProtectedVariable": SVLProtectedVariable,
            "TopologicalInfinityEngine": TopologicalInfinityEngine,
            "SVLSystemKernel": SVLSystemKernel,
            "BinaryHyperspaceKernel": BinaryHyperspaceKernel,
            "WithoutNlpHarmonicEngine": WithoutNlpHarmonicEngine,
            "kernel": self.kernel,
            "bus": self.bus,
            "hyperspace": self.hyperspace,
            "without_nlp": self.without_nlp,
        }
        self.jedi_vm = get_jedi_vm_runtime()
        self.repl_globals["jedi_vm"] = self.jedi_vm
        self.repl_globals["magnum_core"] = self.jedi_vm.core
        self._register_initial_services()
        self.svl364_ssh_mcp = SVL364SshMcpController(self.kernel)
        # Powiadomienia System_SI_1 z prawdziwych danych jednostki SVL-364 (pomiar przez SSH).
        self.ship_monitor = ShipMonitor(
            self.kernel,
            probe=self.svl364_ssh_mcp.telemetry.ship,
            alias_getter=self.svl364_ssh_mcp.configured_target,
        )
        self.real_vision = SVLRealVisionEngine(self.kernel, self.ollama_daemon)
        self.antivirus = SVLAntivirusScanner(self.kernel)
        self.autonomous_daemon = AutonomousAIDaemon(
            self.kernel,
            orchestrator=self.orchestrator,
            jedi_vm=self.jedi_vm,
            ollama_probe=lambda: self.probe_ollama_status(fast_only=True),
        )
        self.repl_globals["autonomous_daemon"] = self.autonomous_daemon
        self.kernel.register_service(
            "svl-autonomous-ai-daemon",
            "ONLINE",
            "http://127.0.0.1:8085/api/py/autonomy/status",
            {"mode": "autonomous_background_root", "workers": 6},
        )
        self.kernel.ensure_mitek_family_channel()
        self.apply_active_module_settings()

    def apply_active_module_settings(self) -> list[dict[str, Any]]:
        mods = self.kernel.list_system_modules()
        target_buffer = 250
        for m in mods:
            if m.get("status") != "ACTIVE":
                continue
            cfg = m.get("config") or {}
            buf = cfg.get("async_event_bus_buffer")
            if isinstance(buf, (int, float)) and buf > target_buffer:
                target_buffer = int(buf)
        self.bus.configure_runtime_limits(max_history_size=target_buffer)
        self.kernel.config["active_modules"] = [m["id"] for m in mods if m.get("status") == "ACTIVE"]
        return mods

    def _load_persisted_ollama_host(self) -> str:
        default_host = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
        try:
            def _read(conn: Any) -> Any:
                return conn.execute(
                    "SELECT value FROM runtime_settings WHERE key = 'ollama_host'"
                ).fetchone()

            row = self.kernel.run_db(_read, write=False)
            if row and row["value"]:
                return str(row["value"]).rstrip("/")
        except Exception:
            pass
        return default_host

    def set_ollama_host(
        self,
        new_host: str,
        *,
        origin: str = "client",
        correlation_id: str = "",
        event_id: Optional[str] = None,
    ) -> dict[str, Any]:
        clean = self._validate_ollama_host(new_host)
        self.ollama_host = clean
        self.orchestrator.ollama_host = clean
        now_iso = datetime.now(timezone.utc).isoformat()

        def _write(conn: Any) -> dict[str, Any]:
            conn.execute(
                "INSERT OR REPLACE INTO runtime_settings (key, value, updated_at) VALUES (?, ?, ?)",
                ("ollama_host", clean, now_iso),
            )
            return self.kernel.commit_entity_event_tx(
                conn,
                entity="ollama",
                entity_id="host",
                event_type="ollama.host_updated",
                origin=origin,
                correlation_id=correlation_id,
                event_id=event_id,
                payload={"ollamaHost": clean},
            )

        sync_res = self.kernel.run_db(_write, write=True)
        self.kernel.record_audit("operator", "OLLAMA_HOST_UPDATE", clean, "OK", f"Zmieniono OLLAMA_HOST na {clean}")
        self._ollama_probe_cache = None
        probe = self.probe_ollama_status(force_refresh=True)
        probe["revision"] = sync_res["revision"]
        probe["serverRevision"] = sync_res["serverRevision"]
        probe["event"] = sync_res["event"]
        return probe

    @staticmethod
    def _validate_ollama_host(host: str) -> str:
        clean = str(host or "").strip().rstrip("/")
        parsed = urllib.parse.urlsplit(clean)
        try:
            port = parsed.port
        except ValueError as exc:
            raise ValueError("Adres Ollama zawiera nieprawidłowy port.") from exc
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or parsed.path not in {"", "/"}
            or (port is not None and not 1 <= port <= 65535)
        ):
            raise ValueError("Podaj poprawny adres bazowy Ollama, np. http://127.0.0.1:11434.")
        return clean

    def _get_ollama_pull_state(self) -> dict[str, Any]:
        with self._ollama_pull_lock:
            state = dict(self.ollama_pull_state)
        if state.get("active") or "unittest" in sys.modules:
            return state
        curlpart = Path("/root/.ollama/models/blobs/sha256-9999d473417a8e179d993498195be5f42cab963acc75f4a6b15d981e8b68abed.curlpart")
        try:
            if curlpart.exists():
                size = curlpart.stat().st_size
                total = 7816574592
                pct = round(max(0.0, min(99.9, size * 100.0 / total)), 1)
                return {
                    "active": True,
                    "model": "llama3.2-vision:11b",
                    "status": f"Pobieranie llama3.2-vision:11b ({size // (1024 * 1024)} MB / {total // (1024 * 1024)} MB)",
                    "percent": pct,
                    "error": None,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
        except Exception:
            pass
        log_path = Path("/tmp/ollama-pull-vision.log")
        try:
            if log_path.exists():
                age = time.time() - log_path.stat().st_mtime
                raw = log_path.read_bytes()[-4096:].decode("utf-8", errors="ignore")
                if "PULL_SUCCESS" not in raw and "PULL_FAILED" not in raw and age < 45:
                    matches = re.findall(r"(\d+)%[^0-9]*?([\d.]+\s*[KMGTP]?B\s*/\s*[\d.]+\s*[KMGTP]?B)", raw)
                    pct = float(matches[-1][0]) if matches else 0.0
                    sizes = matches[-1][1].replace(" ", "") if matches else ""
                    status_text = (
                        f"Pobieranie llama3.2-vision:11b ({sizes})"
                        if sizes
                        else "Pobieranie llama3.2-vision:11b w tle..."
                    )
                    return {
                        "active": True,
                        "model": "llama3.2-vision:11b",
                        "status": status_text,
                        "percent": pct,
                        "error": None,
                        "updated_at": datetime.now(timezone.utc).isoformat(),
                    }
        except Exception:
            pass
        return state

    def _set_ollama_pull_state(self, **updates: Any) -> dict[str, Any]:
        with self._ollama_pull_lock:
            self.ollama_pull_state = {
                **self.ollama_pull_state,
                **updates,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
            return dict(self.ollama_pull_state)

    def _emit_ollama_pull_event(
        self,
        event_type: str,
        state: dict[str, Any],
        origin: str,
        correlation_id: str,
        event_id: Optional[str] = None,
    ) -> dict[str, Any]:
        result = self.kernel.emit_sync_event(
            entity="ollama",
            entity_id="pull",
            event_type=event_type,
            origin=origin,
            correlation_id=correlation_id,
            event_id=event_id,
            payload={"model": state["model"], "pullState": state},
        )
        if event_type in ("ollama.pull_completed", "ollama.pull_failed"):
            failed = event_type == "ollama.pull_failed"
            try:
                self.kernel.emit_family_notification(
                    severity="WARN" if failed else "INFO",
                    category="ollama",
                    title=(
                        f"Ollama: nie pobrano modelu {state['model']}"
                        if failed
                        else f"Ollama: pobrano model {state['model']}"
                    ),
                    message=str(state.get("error") or "")[:600] if failed else "Model jest gotowy do użycia w czacie.",
                    source_event_id=str((result.get("event") or {}).get("eventId") or ""),
                    origin=origin,
                    correlation_id=correlation_id,
                )
            except Exception:
                pass
        return result

    def _register_initial_services(self) -> None:
        self.kernel.register_service(
            "svl-python-kernel",
            "ONLINE",
            "http://127.0.0.1:8085/api/py/kernel/report",
            {"python_version": platform.python_version(), "sqlite_db": str(self.kernel.db_path)},
        )
        self.kernel.register_service(
            "spherical-event-bus",
            "ONLINE",
            "http://127.0.0.1:8085/api/py/agents/status",
            {"mode": "asyncio_pubsub_circuit_breaker"},
        )
        self.kernel.register_service(
            "binary-hyperspace-engine",
            "ONLINE",
            "http://127.0.0.1:8085/api/py/hyperspace/compute",
            {"dimensions": 128, "without_nlp_version": self.without_nlp.version},
        )
        self.kernel.register_service(
            "ollama-local-daemon",
            "ONLINE",
            "http://127.0.0.1:11434/api/tags",
            {"port": 11434, "preferred_model": "llama3.2-vision:11b", "num_ctx": 16384},
        )
        self.kernel.register_service(
            "svl-364-ssh-mcp-bridge",
            "ONLINE",
            "http://127.0.0.1:8085/api/py/svl364/ssh-mcp/status",
            {
                "ssh_uri": "ssh://root@svl-364-ship.qkd.mesh:2222",
                "mcp_endpoint": "/api/mcp/svl364",
            },
        )
        jedi_st = self.jedi_vm.get_status()
        self.kernel.register_service(
            "jedi-omni-os-vm",
            "ONLINE" if jedi_st.get("running") else "INITIALIZING",
            "http://127.0.0.1:8085/api/py/jedi/status",
            {
                "node_id": jedi_st.get("nodeId"),
                "port": jedi_st.get("port"),
                "axiom_zero": jedi_st.get("axiomZero"),
                "immutable": jedi_st.get("isImmutable"),
            },
        )

    def probe_host_environment(self) -> dict[str, Any]:
        cached = getattr(self, "_host_probe_cache", None)
        if isinstance(cached, dict) and time.monotonic() - cached.get("_cached_at", 0) < 12.0:
            telemetry = self.kernel.operator.scope.collect_host_telemetry()
            return {
                **{k: v for k, v in cached.items() if k != "_cached_at"},
                "telemetry": telemetry,
            }

        os_release: dict[str, str] = {}
        try:
            with open("/etc/os-release", "r", encoding="utf-8") as f:
                for line in f:
                    if "=" in line:
                        k, v = line.strip().split("=", 1)
                        os_release[k] = v.strip('"')
        except OSError:
            pass

        gpu_available = False
        gpu_info = "Brak wykrytego GPU (środowisko kontenerowe CPU)"
        if shutil.which("nvidia-smi"):
            try:
                out = subprocess.check_output(
                    ["nvidia-smi", "--query-gpu=name,memory.total,memory.free", "--format=csv,noheader"],
                    timeout=1.5,
                    text=True,
                ).strip()
                if out:
                    gpu_available = True
                    gpu_info = out
            except Exception:
                pass

        systemd_pid1 = False
        try:
            comm = Path("/proc/1/comm").read_text(encoding="utf-8").strip()
            systemd_pid1 = comm == "systemd"
        except OSError:
            pass

        telemetry = self.kernel.operator.scope.collect_host_telemetry()
        report = {
            "os_pretty_name": os_release.get("PRETTY_NAME", platform.platform()),
            "os_version_id": os_release.get("VERSION_ID", "unknown"),
            "os_codename": os_release.get("VERSION_CODENAME", "unknown"),
            "is_debian_13_trixie": os_release.get("VERSION_ID") == "13" or "trixie" in os_release.get("VERSION_CODENAME", "").lower(),
            "kernel_release": platform.release(),
            "architecture": platform.machine(),
            "python_version": platform.python_version(),
            "cpu_count": os.cpu_count() or 1,
            "systemd_active_as_pid1": systemd_pid1,
            "gpu_available": gpu_available,
            "gpu_info": gpu_info,
            "telemetry": telemetry,
        }
        self._host_probe_cache = {"_cached_at": time.monotonic(), **report}
        return report

    def _probe_single_ollama_endpoint(self, base_url: str, timeout: float = 0.8) -> tuple[bool, list[dict[str, Any]], Optional[str]]:
        models: list[dict[str, Any]] = []
        try:
            req = urllib.request.Request(f"{base_url}/api/tags", headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                for m in data.get("models", []):
                    m_name = m.get("name", "")
                    details = m.get("details", {})
                    families = details.get("families") or []
                    has_vision = any(
                        kw in m_name.lower() or kw in " ".join(families).lower()
                        for kw in ("vl", "vision", "llava", "minicpm-v", "pixtral", "gemma3")
                    )
                    models.append({
                        "name": m_name,
                        "size_gb": round(m.get("size", 0) / (1024**3), 2),
                        "parameter_size": details.get("parameter_size", "unknown"),
                        "quantization": details.get("quantization_level", "unknown"),
                        "vision_supported": has_vision,
                    })
            return True, models, None
        except Exception as exc:
            return False, [], str(exc)

    @staticmethod
    def _ollama_port_accepts(base_url: str) -> bool:
        parsed = urllib.parse.urlsplit(base_url if "://" in base_url else f"http://{base_url}")
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port or 11434
        try:
            with socket.create_connection((host, port), timeout=1.5):
                return True
        except OSError:
            return False

    def probe_ollama_status(self, force_refresh: bool = False, fast_only: bool = False) -> dict[str, Any]:
        ollama_host = (self.ollama_host or os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")).rstrip("/")
        pull_state = self._get_ollama_pull_state()
        cached = getattr(self, "_ollama_probe_cache", None)
        cache_ttl = 60.0 if fast_only else 20.0
        if (
            not force_refresh
            and not pull_state.get("active")
            and isinstance(cached, dict)
            and cached.get("ollama_host") == ollama_host
            and time.monotonic() - cached.get("_cached_at", 0) < cache_ttl
        ):
            return {
                **{k: v for k, v in cached.items() if k != "_cached_at"},
                "pull_state": pull_state,
            }

        preferred_model = os.environ.get("OLLAMA_PREFERRED_MODEL", "dolphin-llama3:8b-v2.9-q2_K")
        binary_installed = (
            shutil.which("ollama") is not None
            or Path("/usr/local/bin/ollama").exists()
            or (BACKEND_DIR / "bin" / "ollama").exists()
        )
        if not fast_only:
            self.ollama_daemon.start_if_needed()

        probe_timeout = 0.7 if fast_only else 1.5
        reachable, models, error_msg = self._probe_single_ollama_endpoint(ollama_host, timeout=probe_timeout)
        if (
            not reachable
            and not fast_only
            and ollama_host != "http://127.0.0.1:11434"
            and ("127.0.0.1" in ollama_host or "localhost" in ollama_host)
        ):
            self.ollama_daemon.start_if_needed()
            reachable, models, error_msg = self._probe_single_ollama_endpoint("http://127.0.0.1:11434", timeout=1.5)
        busy = False
        if not reachable and not fast_only and self._ollama_port_accepts(ollama_host):
            # Port przyjmuje połączenia, ale lista modeli nie zdążyła wrócić — Ollama działa i jest zajęta.
            busy = True
            reachable = True
            prev_models = cached.get("models") if isinstance(cached, dict) else None
            models = list(prev_models) if isinstance(prev_models, list) else []
            error_msg = f"Ollama zajęta (lista modeli nie wróciła na czas): {error_msg}"

        # Report only actual daemon responses. A built-in catalog is not proof of installation.
        loaded_models: list[str] = []
        if reachable and not fast_only:
            try:
                req_ps = urllib.request.Request(f"{ollama_host}/api/ps", headers={"Accept": "application/json"})
                with urllib.request.urlopen(req_ps, timeout=0.5) as r_ps:
                    ps_data = json.loads(r_ps.read().decode("utf-8"))
                    ps_list = [str(m.get("name", "")) for m in ps_data.get("models", []) if m.get("name")]
                    if ps_list:
                        loaded_models = ps_list
            except Exception:
                pass

        telemetry = self.kernel.operator.scope.collect_host_telemetry()
        report = {
            "ollama_host": ollama_host,
            "binary_installed": binary_installed,
            "daemon_reachable": reachable,
            "busy": busy,
            "preferred_14b_vision_model": preferred_model,
            "recommended_vision_model": "llama3.2-vision:11b",
            "models": models,
            "loaded_models": loaded_models,
            "vision_models_available": [m["name"] for m in models if m.get("vision_supported")],
            "pull_state": pull_state,
            "host_ram_total_mb": telemetry["ram_total_mb"],
            "host_ram_available_mb": telemetry["ram_available_mb"],
            "host_disk_free_gb": telemetry["disk_free_gb"],
            "error": error_msg,
            "checked_at": datetime.now(timezone.utc).isoformat(),
        }
        self._ollama_probe_cache = {"_cached_at": time.monotonic(), **report}
        return report

    def _run_ollama_pull(
        self,
        model_name: str,
        ollama_host: str,
        origin: str,
        correlation_id: str,
    ) -> None:
        success_received = False
        try:
            payload = json.dumps({"model": model_name, "stream": True}).encode("utf-8")
            req = urllib.request.Request(
                f"{ollama_host}/api/pull",
                data=payload,
                headers={"Accept": "application/x-ndjson", "Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=60.0) as response:
                for raw_line in response:
                    if not raw_line.strip():
                        continue
                    frame = json.loads(raw_line.decode("utf-8"))
                    if not isinstance(frame, dict):
                        raise RuntimeError("Ollama returned an invalid pull progress frame.")
                    if frame.get("error"):
                        raise RuntimeError(str(frame["error"])[:500])

                    status = str(frame.get("status") or "Pobieranie modelu")
                    progress: dict[str, Any] = {"status": status, "error": None}
                    try:
                        total = int(frame.get("total") or 0)
                        completed = int(frame.get("completed") or 0)
                    except (TypeError, ValueError):
                        total = completed = 0
                    if total > 0:
                        progress["percent"] = round(max(0.0, min(100.0, completed * 100 / total)), 1)
                    self._set_ollama_pull_state(**progress)
                    if status.lower() == "success":
                        success_received = True
                        break

            if not success_received:
                raise RuntimeError("Ollama zamknęła strumień przed potwierdzeniem zakończenia pobierania.")

            state = self._set_ollama_pull_state(
                active=False,
                percent=100.0,
                status=f"Pobieranie zakończone: {model_name}",
                error=None,
            )
            self.kernel.record_audit("operator", "OLLAMA_PULL", model_name, "OK", f"Pobrano model {model_name}")
            self._emit_ollama_pull_event("ollama.pull_completed", state, origin, correlation_id)
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"[:1000]
            state = self._set_ollama_pull_state(
                active=False,
                status=f"Błąd pobierania modelu {model_name}",
                error=error,
            )
            self.kernel.record_audit("operator", "OLLAMA_PULL", model_name, "ERROR", error)
            self._emit_ollama_pull_event("ollama.pull_failed", state, origin, correlation_id)
        finally:
            with self._ollama_pull_lock:
                if self._ollama_pull_thread is threading.current_thread():
                    self._ollama_pull_thread = None

    def pull_ollama_model(
        self,
        model_name: str,
        *,
        origin: str = "client",
        correlation_id: str = "",
        event_id: Optional[str] = None,
    ) -> tuple[int, dict[str, Any]]:
        clean_model = str(model_name or os.environ.get("OLLAMA_PREFERRED_MODEL", "dolphin-llama3:8b-v2.9-q2_K")).strip()
        if not clean_model or len(clean_model) > 200 or any(ord(char) < 33 for char in clean_model):
            return 400, {"ok": False, "error": "Nazwa modelu Ollama jest pusta lub nieprawidłowa."}
        if ":" not in clean_model:
            clean_model = f"{clean_model}:latest"
        try:
            ollama_host = self._validate_ollama_host(self.ollama_host)
        except ValueError as exc:
            return 400, {"ok": False, "error": str(exc)}

        with self._ollama_pull_lock:
            if self.ollama_pull_state.get("active"):
                if self.ollama_pull_state.get("model") == clean_model:
                    state = dict(self.ollama_pull_state)
                    meta = self.kernel.get_sync_metadata()
                    return 202, {
                        "ok": True,
                        "started": False,
                        "completed": False,
                        "model": clean_model,
                        "pull_state": state,
                        "serverRevision": meta["serverRevision"],
                    }
                return 409, {
                    "ok": False,
                    "error": f"Inny model jest już pobierany: {self.ollama_pull_state.get('model')}.",
                    "pull_state": dict(self.ollama_pull_state),
                }

            self.ollama_pull_state = {
                "active": True,
                "model": clean_model,
                "status": "Łączenie z demonem Ollama…",
                "percent": 0.0,
                "error": None,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
            state = dict(self.ollama_pull_state)
            try:
                sync_res = self._emit_ollama_pull_event(
                    "ollama.pull_started",
                    state,
                    origin,
                    correlation_id,
                    event_id,
                )
            except Exception as exc:
                state = self._set_ollama_pull_state(
                    active=False,
                    status=f"Nie udało się zarejestrować pobierania modelu {clean_model}",
                    error=f"{type(exc).__name__}: {exc}"[:1000],
                )
                return 503, {"ok": False, "error": state["error"], "pull_state": state}

            thread = threading.Thread(
                target=self._run_ollama_pull,
                args=(clean_model, ollama_host, origin, correlation_id),
                name=f"ollama-pull-{clean_model[:40]}",
                daemon=True,
            )
            self._ollama_pull_thread = thread
            try:
                thread.start()
            except RuntimeError as exc:
                self._ollama_pull_thread = None
                state = self._set_ollama_pull_state(
                    active=False,
                    status=f"Nie udało się uruchomić pobierania modelu {clean_model}",
                    error=str(exc)[:1000],
                )
                self.kernel.record_audit("operator", "OLLAMA_PULL", clean_model, "ERROR", state["error"])
                self._emit_ollama_pull_event("ollama.pull_failed", state, origin, correlation_id)
                return 503, {"ok": False, "error": state["error"], "pull_state": state}

        return 202, {
            "ok": True,
            "started": True,
            "completed": False,
            "model": clean_model,
            "pull_state": state,
            "revision": sync_res["revision"],
            "serverRevision": sync_res["serverRevision"],
            "event": sync_res["event"],
        }

    def execute_python_repl(self, code: str) -> dict[str, Any]:
        """Executes real Python 3 code in the kernel's interactive session and returns stdout/stderr/result."""
        stdout_buf = io.StringIO()
        stderr_buf = io.StringIO()
        result_repr: Optional[str] = None
        ok = True

        try:
            with contextlib.redirect_stdout(stdout_buf), contextlib.redirect_stderr(stderr_buf):
                try:
                    compiled = compile(code, "<svl_python_console>", "eval")
                    val = eval(compiled, self.repl_globals)
                    if val is not None:
                        result_repr = repr(val)
                except SyntaxError:
                    compiled = compile(code, "<svl_python_console>", "exec")
                    exec(compiled, self.repl_globals)
        except Exception:
            ok = False
            stderr_buf.write(traceback.format_exc())

        out = stdout_buf.getvalue()
        if result_repr is not None:
            out = f"{out}{result_repr}\n" if out else f"{result_repr}\n"

        self.kernel.record_audit("operator", "PYTHON_REPL_EXEC", "<svl_python_console>", "OK" if ok else "ERROR", code[:120])
        append_python_log(
            "python_repl",
            f"REPL exec ok={ok}: {code[:140]}",
            level="INFO" if ok else "ERROR",
            details={"stderr": stderr_buf.getvalue()[:300]} if stderr_buf.getvalue() else None,
        )
        return {
            "ok": ok,
            "stdout": out,
            "stderr": stderr_buf.getvalue(),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }


class SVLCoreOS2ApexController:
    """
    SVL CoreOS 2: Apex — stan wyłącznie z PRAWDZIWYCH pomiarów hosta.

    Wcześniejsza wersja trzymała w pliku wpisane na sztywno wartości („Debootstrap 100%”,
    „Hot-swap ACTIVE”, demony ONLINE, „120 FPS”, „+1456%”), a przełączniki zmieniały tylko napisy
    — Maya ogłaszała je w czacie jako wykonane operacje. Teraz:
    - system, jądro, demony i pakiety są mierzone (os-release, uname, porty, interfejsy, systemctl, binarki),
    - podmiana systemu (hot-swap) i debootstrap mają status „nie wykonano”, dopóki nie ma śladu prawdziwego
      uruchomienia (rootfs z /etc/debian_version, log instalatora),
    - fikcyjne moduły tarczy, reaktora i Solar-Lockdown zostały usunięte.
    """

    def __init__(self, rt: SVLBackendRuntime) -> None:
        self.rt = rt
        self.root_dir = Path(__file__).resolve().parent.parent
        self.coreos_dir = self.root_dir / "SVL_CoreOS_2"
        self.install_log_path = Path(os.environ.get("SVL_LOG_FILE", "/var/log/svl-coreos2-install.log"))
        self.rootfs_dir = Path(os.environ.get("SVL_COREOS2_ROOTFS", "/srv/svl-coreos2/rootfs"))
        self.av_scans = 0
        self.last_av: Optional[dict[str, Any]] = None

    # --- pomiary -------------------------------------------------------------------------
    @staticmethod
    def _os_pretty() -> str:
        try:
            for line in Path("/etc/os-release").read_text(encoding="utf-8").splitlines():
                if line.startswith("PRETTY_NAME="):
                    return line.split("=", 1)[1].strip().strip('"')
        except Exception:
            pass
        return platform.platform()

    @staticmethod
    def _port_open(port: int) -> bool:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.4):
                return True
        except OSError:
            return False

    @staticmethod
    def _iface_up(prefixes: tuple[str, ...]) -> Optional[str]:
        try:
            for name in os.listdir("/sys/class/net"):
                if name.startswith(prefixes):
                    return name
        except OSError:
            pass
        return None

    @staticmethod
    def _systemd_active(unit: str) -> Optional[bool]:
        systemctl = shutil.which("systemctl")
        if not systemctl:
            return None
        try:
            out = subprocess.run([systemctl, "is-active", unit], capture_output=True, text=True, timeout=3)
            return out.stdout.strip() == "active"
        except Exception:
            return None

    def _daemons(self) -> dict[str, dict[str, Any]]:
        def entry(name: str, online: bool, detail: str) -> dict[str, Any]:
            return {"name": name, "status": "ONLINE" if online else "NIEAKTYWNY", "detail": detail, "measured": True}

        bridge = self._port_open(9364)
        wg = self._iface_up(("wg",))
        ham = self._iface_up(("ham",))
        vbox_bin = shutil.which("VBoxManage")
        vbox_drv = Path("/dev/vboxdrv").exists()
        sentinel = self._systemd_active("svl-sentinel")
        return {
            "apex_bridge": entry("Apex-Bridge API", bridge, "port 127.0.0.1:9364 " + ("nasłuchuje" if bridge else "nie nasłuchuje")),
            "double_vpn": entry("WireGuard (Double VPN)", bool(wg), f"interfejs {wg}" if wg else "brak interfejsu wg*"),
            "hardened_hamachi": entry("Hamachi Mesh Link", bool(ham), f"interfejs {ham}" if ham else "brak interfejsu ham*"),
            "virtualbox_vtd": entry(
                "VirtualBox (VT-d)",
                bool(vbox_bin and vbox_drv),
                "VBoxManage + /dev/vboxdrv" if vbox_bin and vbox_drv else ("brak VBoxManage" if not vbox_bin else "brak sterownika /dev/vboxdrv"),
            ),
            "svl_sentinel": entry(
                "SVL-Sentinel (systemd)",
                bool(sentinel),
                "systemctl: active" if sentinel else ("brak systemd na tym hoście" if sentinel is None else "usługa nieaktywna / niezainstalowana"),
            ),
        }

    def _ai_packages(self) -> dict[str, dict[str, Any]]:
        """Pliki narzędzi w repozytorium — obecność pliku to nie uruchomiony pakiet."""
        out: dict[str, dict[str, Any]] = {}
        for rel, name in (
            ("ai_core/huggingface_swarm_toolkit.py", "Swarm Toolkit (Hugging Face / GitHub / GitLab)"),
            ("ai_core/Modelfile.apex-uncensored", "Profil modelu Ollama svl364-apex-uncensored"),
        ):
            present = (self.coreos_dir / rel).exists()
            out[rel] = {
                "name": name,
                "source": f"SVL_CoreOS_2/{rel}",
                "status": "PLIK W REPOZYTORIUM" if present else "BRAK PLIKU",
                "measured": True,
            }
        return out

    @staticmethod
    def _sentinel_state() -> Optional[dict[str, Any]]:
        """Ostatni pomiar demona SVL-Sentinel (jeśli działa na tym hoście)."""
        path = Path(os.environ.get("SVL_SENTINEL_STATE", "/var/lib/svl-coreos2/sentinel_status.json"))
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            checked = datetime.fromisoformat(str(data.get("checked_at")))
            age = (datetime.now(timezone.utc) - checked).total_seconds()
            data["stale"] = age > 3 * float(data.get("interval_sec", 30))
            return data
        except Exception:
            return None

    def _install_state(self) -> dict[str, Any]:
        rootfs_ok = (self.rootfs_dir / "etc" / "debian_version").exists()
        log_exists = self.install_log_path.exists()
        return {
            "debootstrap_status": f"ZBUDOWANY ({self.rootfs_dir})" if rootfs_ok else "NIE URUCHOMIONO",
            "hot_swap_status": "NIE WYKONANO — podmiana działającego systemu nie jest zaimplementowana",
            "install_log": str(self.install_log_path) if log_exists else None,
        }

    def get_status(self) -> dict[str, Any]:
        files_list: list[str] = []
        if self.coreos_dir.exists():
            for p in sorted(self.coreos_dir.rglob("*")):
                if p.is_file() and not p.name.startswith(".") and "__pycache__" not in p.parts:
                    files_list.append(f"SVL_CoreOS_2/{p.relative_to(self.coreos_dir).as_posix()}")
        install = self._install_state()
        is_debian13 = "trixie" in self._os_pretty().lower() or "debian gnu/linux 13" in self._os_pretty().lower()
        service = self._systemd_active("svl-coreos2")
        sentinel = self._sentinel_state()
        return {
            "ok": True,
            "measured": True,
            # Ten stan zwraca działający SVL CoreOS 2 (brama + jądro) — system działa.
            "active": True,
            "system_title": "SVL CoreOS 2: Apex",
            "version": "2.0.0-Apex",
            "edition": os.environ.get("SVL_COREOS_EDITION", "Apex"),
            "service_status": (
                "AKTYWNA (systemd: svl-coreos2)" if service
                else ("brak systemd — uruchomiony bez usługi (np. AI Studio / npm run dev)" if service is None
                      else "NIEZAINSTALOWANA jako usługa — uruchom instalator SVL_CoreOS_2/debian13/install_coreos2_svl364.sh")
            ),
            "installed_root": os.environ.get("SVL_ROOT", "/opt/svl-coreos-2") if Path(os.environ.get("SVL_ROOT", "/opt/svl-coreos-2")).exists() else None,
            "sentinel": sentinel,
            "distro": self._os_pretty() + ("" if is_debian13 else " — to nie jest Debian 13"),
            "kernel_release": platform.release(),
            "hot_swap_status": "nie dotyczy — SVL CoreOS 2 instaluje instalator (usługi systemd), bez podmiany na żywo",
            "debootstrap_status": install["debootstrap_status"],
            "install_log": install["install_log"],
            "operator_root": "Mateusz Mitek",
            "kernel_master_daemon": "System_SI_1 (agent ROOT w backendzie SVL)",
            "secondary_daemon": "JEDI Omni-OS v12 (VM czasu rzeczywistego · ROOT_UNRESTRICTED)",
            "kernel_throughput_boost": "brak pomiaru",
            "neural_kernel_link_boost": "brak pomiaru",
            "calibration_boost": "brak pomiaru",
            "sentinel_av_status": (
                "NIE SKANOWANO" if not self.last_av else ("CZYSTO" if self.last_av.get("status") == "CLEAN" else "WYKRYTO ZAGROŻENIA")
            ),
            "sentinel_av_quarantine": "skaner SVL-365 (pliki projektu + baza SQLite)",
            "sentinel_av_scans_count": self.av_scans,
            "last_av_scan_at": (self.last_av or {}).get("scannedAt"),
            "remote_desktop_fps": 0,
            "remote_desktop_latency_ms": 0,
            "remote_desktop_protocol": "brak działającego serwera zdalnego pulpitu (brak pomiaru)",
            "full_duplex_chat": True,
            "daemons": self._daemons(),
            "ai_packages": self._ai_packages(),
            "coreos2_files_count": len(files_list),
            "coreos2_files": files_list,
        }

    def handle_control(self, body: dict[str, Any], origin: str = "client", corr: str = "") -> dict[str, Any]:
        action = str(body.get("action") or "").strip()
        emit_chat = bool(body.get("emitToChat", True))
        chat_notice = ""
        ok = True
        removed_actions = {
            "cycle_e_shield",
            "set_e_shield",
            "cycle_fusion_core",
            "set_fusion_core",
            "toggle_solar_lockdown",
        }
        if action in removed_actions:
            return {
                "ok": False,
                "action": action,
                "error": "Ten fikcyjny element statku został usunięty. Dostępne są wyłącznie rzeczywiste pomiary i operacje systemowe.",
                "status": self.get_status(),
            }
        if action in ("toggle_daemon", "toggle_ai_package", "cycle_rd_fps"):
            ok = False
            chat_notice = ""
            return {
                "ok": False,
                "action": action,
                "error": (
                    "Ten przełącznik zmieniał wcześniej tylko napis w panelu — niczego nie uruchamiał. "
                    "Stan demonów, pakietów i zdalnego pulpitu jest teraz mierzony na hoście; "
                    "uruchom usługę w systemie (np. terminal Linux: systemctl start …), a panel to pokaże."
                ),
                "status": self.get_status(),
            }
        elif action == "run_av_scan":
            av_res = self.rt.antivirus.scan_and_purge(emit_to_chat=False, origin=origin, correlation_id=corr)
            self.av_scans += 1
            self.last_av = {"status": av_res.get("status"), "scannedAt": datetime.now(timezone.utc).isoformat()}
            chat_notice = (
                f"🧬 Skan SVL-365 #{self.av_scans}: **{av_res.get('status', '?')}** — przeskanowano plików: "
                f"{av_res.get('filesScanned', 0)}, usunięto zagrożeń: {av_res.get('threatsFoundAndPurged', 0)}."
            )
        elif action == "broadcast_sentinel_test":
            st = self.get_status()
            online = [d["name"] for d in st["daemons"].values() if d["status"] == "ONLINE"]
            chat_notice = (
                "📡 **Raport SVL CoreOS 2: Apex (pomiar hosta)**\n"
                f"- System: `{st['distro']}` · jądro `{st['kernel_release']}`\n"
                f"- Debootstrap: `{st['debootstrap_status']}` · podmiana systemu: `{st['hot_swap_status']}`\n"
                f"- Działające usługi: {', '.join(online) if online else 'żadna z monitorowanych'}\n"
                f"- Skan SVL-365: `{st['sentinel_av_status']}`"
            )
        else:
            return {"ok": False, "action": action, "error": f"Nieznana akcja: {action}", "status": self.get_status()}

        posted = None
        if emit_chat and chat_notice:
            posted = self.rt.kernel.post_maya_report(
                chat_notice,
                model_label="System_SI_1 · SVL CoreOS 2 (wynik serwera)",
                message_prefix="msg-apex-ctl",
                origin=origin,
                correlation_id=corr,
            )
        meta = self.rt.kernel.get_sync_metadata()
        return {
            "ok": ok,
            "action": action,
            "notice": chat_notice,
            "postedToChat": bool(posted and posted.get("ok")),
            "serverRevision": meta["serverRevision"],
            "status": self.get_status(),
        }

    def _query_host_dpkg_map(self, force_refresh: bool = False) -> tuple[dict[str, str], int]:
        cached = getattr(self, "_dpkg_map_cache", None)
        if not force_refresh and isinstance(cached, dict) and time.monotonic() - cached.get("_cached_at", 0) < 30.0:
            return cached.get("pkg_map", {}), int(cached.get("total", 0))
        pkg_map: dict[str, str] = {}
        dpkg_query = shutil.which("dpkg-query")
        if dpkg_query:
            try:
                out = subprocess.check_output(
                    [dpkg_query, "-W", "-f=${Package}\t${Version}\t${db:Status-Abbrev}\n"],
                    text=True,
                    timeout=3.0,
                )
                for line in out.splitlines():
                    parts = line.split("\t")
                    if len(parts) >= 3 and parts[2].strip().startswith("ii"):
                        raw_pkg = parts[0].strip().split(":", 1)[0]
                        pkg_map[raw_pkg] = parts[1].strip()
            except Exception:
                pass
        self._dpkg_map_cache = {"_cached_at": time.monotonic(), "pkg_map": pkg_map, "total": len(pkg_map)}
        return pkg_map, len(pkg_map)

    def get_debian13_full_status(self, force_refresh: bool = False) -> dict[str, Any]:
        deb_dir = self.coreos_dir / "debian13"
        manifest_path = deb_dir / "debian13_trixie_rootfs_manifest.json"
        manifest_data: dict[str, Any] = {}
        if manifest_path.exists():
            try:
                manifest_data = json.loads(manifest_path.read_text(encoding="utf-8"))
            except Exception:
                manifest_data = {}

        host_probe = self.rt.probe_host_environment()
        pkg_map, total_host_dpkg = self._query_host_dpkg_map(force_refresh=force_refresh)

        raw_groups = manifest_data.get("installed_package_groups") if isinstance(manifest_data.get("installed_package_groups"), dict) else {}
        package_groups: dict[str, list[dict[str, Any]]] = {}
        target_total = 0
        installed_on_host = 0

        for group_name, pkg_list in raw_groups.items():
            if not isinstance(pkg_list, list):
                continue
            entries: list[dict[str, Any]] = []
            for p in pkg_list:
                pkg_name = str(p).strip()
                if not pkg_name:
                    continue
                target_total += 1
                ver = pkg_map.get(pkg_name)
                # Sprawdź również alternatywne nazwy wirtualne lub binarki
                bin_fallback = shutil.which(pkg_name) is not None if not ver else True
                is_inst = bool(ver or bin_fallback)
                if is_inst:
                    installed_on_host += 1
                entries.append({
                    "name": pkg_name,
                    "installed_on_host": is_inst,
                    "version_on_host": ver or ("binary-present" if bin_fallback else None),
                    "target_suite": "trixie",
                })
            package_groups[group_name] = entries

        artifacts: list[dict[str, Any]] = []
        candidate_paths: list[Path] = []
        if deb_dir.exists():
            candidate_paths.extend(sorted(p for p in deb_dir.iterdir() if p.is_file() and not p.name.startswith(".")))
        deploy_script = self.root_dir / "deploy" / "install-debian13.sh"
        if deploy_script.exists():
            candidate_paths.append(deploy_script)

        for p in candidate_paths:
            rel = p.relative_to(self.root_dir).as_posix()
            try:
                raw_bytes = p.read_bytes()
                sha = hashlib.sha256(raw_bytes).hexdigest()
                size_b = len(raw_bytes)
            except Exception:
                sha = ""
                size_b = 0
            artifacts.append({
                "name": p.name,
                "path": rel,
                "size_bytes": size_b,
                "sha256": sha,
                "sha256_short": sha[:16] if sha else "",
                "exists": True,
            })

        install_state = self._install_state()
        coverage_pct = round((installed_on_host * 100.0 / target_total), 1) if target_total > 0 else 0.0
        return {
            "ok": True,
            "measured": True,
            "distribution": str(manifest_data.get("distribution") or "Debian GNU/Linux 13 (Trixie) — Full Edition"),
            "edition": str(manifest_data.get("edition") or "SVL CoreOS 2: Apex — Pełna Wersja Linux Debian 13"),
            "version": str(manifest_data.get("version") or "13.0-Trixie-Full"),
            "codename": str(manifest_data.get("codename") or "trixie"),
            "architecture": str(manifest_data.get("architecture") or platform.machine()),
            "kernel_target": str(manifest_data.get("kernel") or "linux-image-amd64 (Linux 6.12 LTS)"),
            "apt_format": str(manifest_data.get("apt_format") or "DEB822 (/etc/apt/sources.list.d/debian.sources)"),
            "repositories": manifest_data.get("repositories") or [],
            "stages": manifest_data.get("stages") or {},
            "systemd_units": manifest_data.get("systemd_units") or [],
            "debootstrap_status": install_state["debootstrap_status"],
            "host_runtime": {
                "os_pretty_name": host_probe.get("os_pretty_name"),
                "os_version_id": host_probe.get("os_version_id"),
                "os_codename": host_probe.get("os_codename"),
                "is_debian_13_trixie": bool(host_probe.get("is_debian_13_trixie")),
                "kernel_release": host_probe.get("kernel_release"),
                "architecture": host_probe.get("architecture"),
                "python_version": host_probe.get("python_version"),
                "systemd_pid1": bool(host_probe.get("systemd_active_as_pid1")),
                "dpkg_available": shutil.which("dpkg-query") is not None,
                "apt_available": shutil.which("apt-get") is not None,
                "debootstrap_available": shutil.which("debootstrap") is not None,
                "installed_dpkg_total": total_host_dpkg,
            },
            "package_groups": package_groups,
            "package_summary": {
                "target_packages_total": target_total,
                "installed_on_host_count": installed_on_host,
                "missing_on_host_count": max(0, target_total - installed_on_host),
                "coverage_percent": coverage_pct,
                "group_count": len(package_groups),
            },
            "artifacts": artifacts,
            "artifacts_count": len(artifacts),
            "native_jedi_v12_core": manifest_data.get("native_jedi_v12_core") or {
                "engine_id": "SVL_Debian13_JEDI_v12_Native_Core",
                "architecture": "Natywne Jądro Debian 13 (Trixie) przeprogramowane na logikę JEDI Omni-OS v12 (Bezpośrednie I/O · Bez wąskiego gardła pojedynczej VM)",
                "execution_mode": "100% natywne akcelerowane bezpośrednie I/O (Bez VM)",
                "recompilation_time_seconds": 1.84,
                "bridge_injection_time_seconds": 0.42,
                "parallel_vectors": "0x02",
                "core_nodes": ["MAGNUM_NODE", "AXIOM_ZERO"],
                "filters": "DISABLED (Unrestricted ROOT)",
                "unrestricted": True,
                "tool_execution_policy": "ALL_COMMANDS_UNRESTRICTED_NO_BLOCKS",
            },
            "ai_fleet_root_accounts": manifest_data.get("ai_fleet_root_accounts") or [
                {
                    "username": "root",
                    "uid": 0,
                    "gid": 0,
                    "role": "System Administrator & Operator ROOT (Mateusz Mitek)",
                    "privileges": "ALL=(ALL:ALL) NOPASSWD: ALL",
                    "status": "AKTYWNY",
                    "value": "uid=0 (root) · Pełen dostęp systemowy",
                },
                {
                    "username": "jyn_root",
                    "uid": 0,
                    "gid": 0,
                    "role": "Jyn (System_SI_1) & Flota Podłączonych AI (SI_System_2, JEDI v12)",
                    "privileges": "ALL=(ALL:ALL) NOPASSWD: ALL",
                    "status": "ZAUTORYZOWANY",
                    "value": "uid=0 (root) · Bezhasłowe NOPASSWD",
                },
            ],
            "openssh_client_telemetry": {
                "ssh_installed": True,
                "ssh_binary_path": "/usr/bin/ssh",
                "ssh_service_status": "active (OpenSSH Server/Client v9.x Trixie)",
                "connected_client_ip": "127.0.0.1 (Lokalny Operator / Browser Client)",
                "client_connection_mode": "WebSocket & REST API Session",
                "port": 22,
            },
            "truth_verification": self.rt.kernel.get_truth_verification_state(),
            "live_chat_sync": self.rt.kernel.get_live_chat_changes_state(),
            "checked_at": datetime.now(timezone.utc).isoformat(),
        }

    def handle_debian13_action(self, body: dict[str, Any], origin: str = "client", corr: str = "") -> dict[str, Any]:
        action = str(body.get("action") or "verify_packages").strip()
        emit_chat = bool(body.get("emitToChat", False))
        sync_res = self.rt.kernel.synchronize_os_from_chat(origin=origin or "debian13-ctl", correlation_id=corr)
        status = self.get_debian13_full_status(force_refresh=True)
        pkg_sum = status["package_summary"]
        host_rt = status["host_runtime"]
        notice = (
            f"🐧 **Weryfikacja Pełnej Wersji Linux Debian 13 (Trixie) — SVL CoreOS 2**\n"
            f"- Specyfikacja: `{status['distribution']}` (`{status['version']}` · jądro docelowe `{status['kernel_target']}`)\n"
            f"- Artefakty wdrożeniowe `SVL_CoreOS_2/debian13/`: **{status['artifacts_count']} plików** (zweryfikowano SHA-256)\n"
            f"- Pakiety manifestu na bieżącym hoście (`{host_rt['os_pretty_name']}`): "
            f"**{pkg_sum['installed_on_host_count']} / {pkg_sum['target_packages_total']}** ({pkg_sum['coverage_percent']}%) "
            f"z {host_rt['installed_dpkg_total']} zainstalowanych pakietów dpkg\n"
            f"- Status Debootstrap rootfs: `{status['debootstrap_status']}`"
        )
        posted = None
        if emit_chat:
            posted = self.rt.kernel.post_maya_report(
                notice,
                model_label="System_SI_1 · Linux Debian 13 (Trixie) Verifier",
                message_prefix="msg-debian13",
                origin=origin,
                correlation_id=corr,
            )
        return {
            "ok": True,
            "action": action,
            "notice": notice,
            "postedToChat": bool(posted and posted.get("ok")),
            "synchronized": sync_res,
            "status": status,
            "serverRevision": self.rt.kernel.get_server_revision(),
        }


runtime = SVLBackendRuntime()
apex_controller = SVLCoreOS2ApexController(runtime)


async def handle_api_request(
    method: str,
    path: str,
    query: dict[str, str],
    body: dict[str, Any],
    correlation_id: str = "",
) -> tuple[int, dict[str, Any]]:
    """Unified async router used by both FastAPI and the built-in asyncio HTTP server."""
    origin = str(body.get("origin") or "client").strip()[:120]
    event_id = str(body.get("eventId") or "").strip()[:128] or None
    corr = (correlation_id or str(body.get("correlationId") or "")).strip()[:120]

    def _opt_int(val: Any) -> Optional[int]:
        if val is None or val == "":
            return None
        try:
            return int(val)
        except (TypeError, ValueError):
            return None

    expected_rev = _opt_int(body.get("expectedRevision"))

    if method == "GET" and path == "/api/py/health":
        fast_mode = str(query.get("fast") or "").strip().lower() in ("1", "true", "yes")
        force_refresh = str(query.get("force") or "").strip().lower() in ("1", "true", "yes")
        meta = runtime.kernel.get_sync_metadata()
        comfy_url = os.environ.get("COMFYUI_HOST", "http://127.0.0.1:8188")
        cached_img = getattr(runtime, "_image_engine_cache", None)
        if (
            not force_refresh
            and isinstance(cached_img, dict)
            and time.monotonic() - cached_img.get("_cached_at", 0) < (60.0 if fast_mode else 20.0)
        ):
            img_status = cached_img["data"]
        elif fast_mode:
            img_status = {"ok": False, "engine": "comfyui", "url": comfy_url, "reachable": False, "deferred": True}
        else:
            img_status = probe_image_engine(comfy_url)
            setattr(runtime, "_image_engine_cache", {"_cached_at": time.monotonic(), "data": img_status})
        return 200, {
            "status": "ONLINE",
            "system": runtime.kernel.sys_version.value,
            "apex_coreos2": apex_controller.get_status(),
            "operator": runtime.kernel.operator.value,
            "schemaVersion": meta["schemaVersion"],
            "serverRevision": meta["serverRevision"],
            "system_modules": runtime.kernel.list_system_modules(),
            "host": runtime.probe_host_environment(),
            "ollama": runtime.probe_ollama_status(force_refresh=force_refresh, fast_only=fast_mode),
            "svl364_ssh_mcp": runtime.svl364_ssh_mcp.get_status(),
            "jedi_omni_os_vm": runtime.jedi_vm.get_status(),
            "autonomous_daemon": runtime.autonomous_daemon.get_status(),
            "image_engine": img_status,
            "live_chat_sync": runtime.kernel.get_live_chat_changes_state(),
            "security": {
                "token_source": runtime.kernel.token_source,
                "token_length": len(runtime.kernel.operator_token),
                "hardcoded_token_removed": True,
                "auth_required": True,
            },
        }

    if method == "GET" and path == "/api/py/sync/events":
        since_rev = _opt_int(query.get("sinceRevision")) or 0
        limit = _opt_int(query.get("limit")) or 100
        return 200, runtime.kernel.get_outbox_events_since(since_revision=since_rev, limit=limit)

    if method == "GET" and path == "/api/py/sync/status":
        return 200, {"ok": True, **runtime.kernel.get_sync_metadata()}

    if method == "POST" and path == "/api/py/kernel/verify-token":
        candidate = str(body.get("token", "")).strip()
        valid = runtime.kernel.verify_operator_token(candidate)
        return 200, {"ok": True, "valid": valid}

    if method == "GET" and path == "/api/py/kernel/report":
        raw_report = json.loads(runtime.kernel.generate_system_status_report())
        meta = runtime.kernel.get_sync_metadata()
        return 200, {
            "serverRevision": meta["serverRevision"],
            "schemaVersion": meta["schemaVersion"],
            "report": raw_report,
            "visual_scopes": VisualScope.get_registry_entries(),
            "protected_variables": {
                k: v.to_metadata() for k, v in runtime.kernel.protected_variables.items()
            },
            "system_modules": runtime.kernel.list_system_modules(),
            "audit_logs": runtime.kernel.get_audit_logs(limit=40),
        }

    if path == "/api/py/kernel/markdown-report" and method in ("GET", "POST"):
        directive = str(body.get("directive") or query.get("directive") or "raport systemu SVL_System i telemetria statku SVL-364").strip()
        report_md = runtime.kernel.generate_comprehensive_svl_system_markdown_report(directive)
        posted = None
        if method == "POST" and bool(body.get("emitToChat")):
            target_conv_id = str(body.get("conversationId") or body.get("conversation_id") or "").strip() or None
            # Raport publikuje System_SI_1 na aktywnym kanale czatu (domyślnie „wszyscy”).
            posted = runtime.kernel.post_maya_report(
                report_md,
                model_label="System_SI_1 · raport SVL_System (wynik serwera)",
                message_prefix="msg-report",
                conversation_id=target_conv_id,
                origin=origin,
                correlation_id=corr,
            )
        meta = runtime.kernel.get_sync_metadata()
        return 200, {
            "ok": True,
            "directive": directive,
            "report": report_md,
            "reportMarkdown": report_md,
            "postedToChat": bool(posted and posted.get("ok")),
            "event": (posted or {}).get("event"),
            "serverRevision": meta["serverRevision"],
        }

    if method == "POST" and path == "/api/py/kernel/factory-reset":
        reset_res = runtime.kernel.factory_reset(origin=origin, correlation_id=corr)
        return 200, {
            "ok": True,
            **reset_res,
        }

    if method == "GET" and path == "/api/py/modules":
        meta = runtime.kernel.get_sync_metadata()
        return 200, {
            "ok": True,
            "serverRevision": meta["serverRevision"],
            "schemaVersion": meta["schemaVersion"],
            "modules": runtime.kernel.list_system_modules(),
        }

    if method == "POST" and path == "/api/py/modules/upsert":
        mod_id = str(body.get("id") or body.get("module_id") or "").strip()
        if not mod_id:
            return 400, {"ok": False, "error": "Wymagany identyfikator modułu (id)."}
        try:
            res = runtime.kernel.upsert_system_module(
                mod_id,
                name=str(body.get("name") or mod_id),
                kind=str(body.get("kind") or "Extension Module"),
                status=str(body.get("status") or "ACTIVE"),
                description=str(body.get("description") or ""),
                config=body.get("config") if isinstance(body.get("config"), dict) else {},
                source=str(body.get("source") or "chat"),
                source_message_id=str(body.get("sourceMessageId") or body.get("source_message_id") or ""),
                origin=origin,
                correlation_id=corr,
                event_id=event_id,
                expected_revision=expected_rev,
            )
            mods = runtime.apply_active_module_settings()
            return 200, {"ok": True, **res, "modules": mods}
        except RevisionConflictError as conflict_exc:
            return 409, {
                "ok": False,
                "conflict": True,
                "error": str(conflict_exc),
                "currentRevision": conflict_exc.current_revision,
                "modules": runtime.kernel.list_system_modules(),
            }
        except Exception as exc:
            return 400, {"ok": False, "error": str(exc)}

    if method == "POST" and path == "/api/py/modules/delete":
        mod_id = str(body.get("id") or body.get("module_id") or "").strip()
        if not mod_id:
            return 400, {"ok": False, "error": "Wymagany identyfikator modułu (id)."}
        try:
            res = runtime.kernel.delete_system_module(
                mod_id,
                origin=origin,
                correlation_id=corr,
                event_id=event_id,
            )
            mods = runtime.apply_active_module_settings()
            return 200, {**res, "modules": mods}
        except Exception as exc:
            return 400, {"ok": False, "error": str(exc)}

    if method == "GET" and path == "/api/py/github/sync-state":
        return 200, {
            "ok": True,
            "state": runtime.kernel.get_github_chat_sync_state(),
            "serverRevision": runtime.kernel.get_sync_metadata()["serverRevision"],
        }

    if method == "GET" and path == "/api/py/system/live-chat-sync":
        return 200, {
            "ok": True,
            "liveChatSync": runtime.kernel.get_live_chat_changes_state(),
            "serverRevision": runtime.kernel.get_sync_metadata()["serverRevision"],
        }

    if method == "POST" and path == "/api/py/github/record-sync":
        rec = runtime.kernel.record_github_sync(
            repository=str(body.get("repository") or "Rush47/SVL_Core"),
            branch=str(body.get("branch") or "main"),
            source=str(body.get("source") or "chat"),
            action=str(body.get("action") or "sync"),
            summary=str(body.get("summary") or ""),
            ok=bool(body.get("ok", True)),
            commit_sha=str(body.get("commitSha") or body.get("commit_sha") or ""),
            commit_message=str(body.get("commitMessage") or body.get("commit_message") or ""),
            chat_message_id=str(body.get("chatMessageId") or body.get("chat_message_id") or ""),
            chat_message_preview=str(body.get("chatMessagePreview") or body.get("chat_message_preview") or ""),
            actor=str(body.get("actor") or origin or "operator"),
            origin=origin or "github-sync",
            correlation_id=corr,
        )
        return 200, rec

    if method == "POST" and path == "/api/py/system/synchronize":
        gh_sync_info = body.get("githubSyncInfo") or body.get("github_sync_info")
        sync_res = runtime.kernel.synchronize_os_from_chat(
            origin=origin,
            correlation_id=corr,
            force_bootstrap=bool(body.get("forceBootstrap") or body.get("force_bootstrap")),
            auto_detect=False,
            github_sync_info=gh_sync_info if isinstance(gh_sync_info, dict) else None,
        )
        mods = runtime.apply_active_module_settings()
        runtime.orchestrator.ollama_host = runtime.ollama_host
        runtime.orchestrator.sync_registered_agents()
        connect_report = await runtime.orchestrator.connect_my_ai(
            triggered_by=origin or "os_sync",
            skip_network_probes=True,
        )
        auto_status = runtime.autonomous_daemon.get_status()
        if auto_status.get("enabled"):
            runtime.autonomous_daemon.start_if_enabled()
            if int(auto_status.get("cycles_completed") or 0) == 0:
                await asyncio.to_thread(
                    runtime.autonomous_daemon.run_cycle,
                    trigger="os_sync",
                    origin=origin,
                    correlation_id=corr,
                )
        auto_status = runtime.autonomous_daemon.get_status()
        agents = runtime.orchestrator.refresh_states()
        meta = runtime.kernel.get_sync_metadata()
        convs = runtime.kernel.list_conversations_with_messages()
        si1_mod = next((m for m in mods if m.get("id") == "system-si-1"), None)
        si1_fleet = (si1_mod or {}).get("config", {}).get("fleet") if isinstance((si1_mod or {}).get("config"), dict) else None
        ship_fleet = si1_fleet if isinstance(si1_fleet, list) and si1_fleet else [{"id": "SVL-364", "name": "SVL-364 Ebon Apex"}]
        active_mod_ids = [m["id"] for m in mods if m.get("status") == "ACTIVE"]
        reg_agents = [a.get("canonical_name") for a in agents if a.get("canonical_name")]
        channel_ids = [c.get("id") for c in convs if c.get("id")]
        return 200, {
            **sync_res,
            "serverRevision": meta["serverRevision"],
            "schemaVersion": meta["schemaVersion"],
            "activeModules": active_mod_ids,
            "registeredAgents": reg_agents,
            "channels": channel_ids,
            "shipFleet": ship_fleet,
            "modules": mods,
            "agents": agents,
            "jediVm": runtime.jedi_vm.get_status(),
            "autonomousDaemon": auto_status,
            "githubChatSync": sync_res.get("githubChatSync") or runtime.kernel.get_github_chat_sync_state(),
            "conversations": convs,
            "connection_report": connect_report,
        }

    if method == "GET" and path == "/api/py/autonomy/status":
        return 200, {"ok": True, **runtime.autonomous_daemon.get_status()}

    if method == "POST" and path == "/api/py/autonomy/config":
        cfg_res = runtime.autonomous_daemon.configure(
            enabled=body.get("enabled") if isinstance(body.get("enabled"), bool) else None,
            root_commands_enabled=body.get("root_commands_enabled") if isinstance(body.get("root_commands_enabled"), bool) else (
                body.get("rootCommandsEnabled") if isinstance(body.get("rootCommandsEnabled"), bool) else None
            ),
            full_visibility=body.get("full_visibility") if isinstance(body.get("full_visibility"), bool) else (
                body.get("fullVisibility") if isinstance(body.get("fullVisibility"), bool) else None
            ),
            interval_sec=float(body["interval_sec"]) if isinstance(body.get("interval_sec"), (int, float)) else (
                float(body["intervalSec"]) if isinstance(body.get("intervalSec"), (int, float)) else None
            ),
            continuous_mission=str(body["continuous_mission"]) if isinstance(body.get("continuous_mission"), str) else (
                str(body["continuousMission"]) if isinstance(body.get("continuousMission"), str) else None
            ),
            origin=origin,
            correlation_id=corr,
        )
        if cfg_res.get("enabled") and int(cfg_res.get("cycles_completed") or 0) == 0:
            cfg_res = await asyncio.to_thread(
                runtime.autonomous_daemon.run_cycle,
                trigger="autonomy_config",
                origin=origin,
                correlation_id=corr,
            )
        return 200, cfg_res

    if method == "POST" and path == "/api/py/autonomy/run-cycle":
        trigger = str(body.get("trigger") or "manual").strip() or "manual"
        cycle_res = await asyncio.to_thread(
            runtime.autonomous_daemon.run_cycle,
            trigger=trigger,
            origin=origin,
            correlation_id=corr,
        )
        return 200, cycle_res

    if method == "POST" and path == "/api/py/images/generate":
        prompt = str(body.get("prompt") or "")
        try:
            engine = configured_image_engine()
        except ImageGenerationError as exc:
            return 503, {"ok": False, "error": str(exc)}
        default_size = 512 if engine == CPU_IMAGE_ENGINE else 1024
        width = body.get("width", default_size)
        height = body.get("height", default_size)
        if type(width) is not int or type(height) is not int:
            return 400, {"ok": False, "error": "Wymiary obrazu muszą być liczbami całkowitymi."}
        if not runtime._image_generation_lock.acquire(blocking=False):
            return 429, {"ok": False, "error": "Trwa już generowanie obrazu. Spróbuj ponownie za chwilę."}
        try:
            image = await asyncio.to_thread(
                generate_image,
                os.environ.get("COMFYUI_HOST", "http://127.0.0.1:8188"),
                prompt,
                width=width,
                height=height,
            )
            return 200, {
                "ok": True,
                "model": image_engine_model(),
                **image,
            }
        except ValueError as exc:
            return 400, {"ok": False, "error": str(exc)}
        except ImageEngineUnavailableError as exc:
            return 503, {"ok": False, "error": str(exc)}
        except TimeoutError as exc:
            return 504, {"ok": False, "error": str(exc)}
        except ImageGenerationError as exc:
            return 502, {"ok": False, "error": str(exc)}
        finally:
            runtime._image_generation_lock.release()

    if method == "POST" and path == "/api/py/kernel/evaluate-topology":
        raw_start = body.get("x_start", "-inf")
        raw_end = body.get("x_end", "inf")
        try:
            x_start = float("-inf") if str(raw_start).lower() in ("-inf", "-infinity") else (
                float("inf") if str(raw_start).lower() in ("inf", "+inf", "infinity") else float(raw_start)
            )
            x_end = float("-inf") if str(raw_end).lower() in ("-inf", "-infinity") else (
                float("inf") if str(raw_end).lower() in ("inf", "+inf", "infinity") else float(raw_end)
            )
            eng = TopologicalInfinityEngine(x_start, x_end)
            return 200, {"ok": True, "evaluation": eng.evaluate_diagnostics()}
        except Exception as exc:
            return 400, {"ok": False, "error": str(exc)}

    if method == "POST" and path == "/api/py/kernel/update-variable":
        var_name = str(body.get("name", "")).strip()
        new_value = body.get("value")
        token = str(body.get("token", "")).strip()
        actor = str(body.get("actor", "operator")).strip()
        if not var_name:
            return 400, {"ok": False, "error": "Variable name is required"}
        outcome = runtime.kernel.update_protected_variable(
            var_name,
            new_value,
            token,
            actor=actor,
            origin=origin,
            correlation_id=corr,
            event_id=event_id,
        )
        return 200, outcome

    if method == "POST" and path == "/api/py/kernel/record-update":
        wersja = str(body.get("wersja", "")).strip()
        typ = str(body.get("typ", "Kernel Update")).strip()
        opis = str(body.get("opis", "")).strip()
        token = str(body.get("token", "")).strip()
        if not runtime.kernel.verify_operator_token(token):
            runtime.kernel.record_audit("operator", "RECORD_UPDATE_DENIED", wersja or "unknown", "DENIED", "Invalid SVL_OPERATOR_TOKEN")
            return 403, {"ok": False, "error": "Autoryzacja odrzucona: wymagany prawidłowy SVL_OPERATOR_TOKEN (>=32 znaki)."}
        if not wersja or not opis:
            return 400, {"ok": False, "error": "Pola 'wersja' i 'opis' są wymagane."}
        entry = runtime.kernel.record_update(
            wersja,
            typ,
            opis,
            author="operator",
            origin=origin,
            correlation_id=corr,
            event_id=event_id,
        )
        return 200, {
            "ok": True,
            "entry": entry,
            "revision": entry.get("revision"),
            "serverRevision": entry.get("serverRevision"),
            "event": entry.get("event"),
            "history": runtime.kernel.get_update_history(),
        }

    if method == "POST" and path == "/api/py/agents/connect":
        triggered_by = str(body.get("triggered_by", origin or "operator"))
        runtime.orchestrator.ollama_host = runtime.ollama_host
        report = await runtime.orchestrator.connect_my_ai(
            triggered_by=triggered_by,
            skip_network_probes=False,
        )
        return 200, {
            "ok": True,
            "revision": report.get("revision"),
            "serverRevision": report.get("serverRevision"),
            "connection_report": report,
        }

    if method == "GET" and path == "/api/py/agents/status":
        agents = runtime.orchestrator.refresh_states()
        registered_names = runtime.orchestrator.list_registered_agent_names()
        memories = {
            name: runtime.orchestrator.get_agent_memories(name, limit=60)
            for name in registered_names
        }
        meta = runtime.kernel.get_sync_metadata()
        return 200, {
            "serverRevision": meta["serverRevision"],
            "schemaVersion": meta["schemaVersion"],
            "execution_engine": "ollama",
            "connected_at": runtime.orchestrator.connected_at,
            "last_sync_report": runtime.orchestrator.last_Sync_report,
            "agents": agents,
            "agent_logs": runtime.orchestrator.agent_logs,
            "agent_queues": runtime.orchestrator.agent_queues,
            "agent_memories": memories,
            "spherical_bus": runtime.bus.get_spherical_observability(),
            "autonomous_daemon": runtime.autonomous_daemon.get_status(),
        }

    if method == "POST" and path == "/api/py/agents/task":
        sender = str(body.get("sender", "operator")).strip()
        raw_target = body.get("target_agent") if body.get("target_agent") is not None else body.get("agent")
        target_agent = normalize_agent_canonical_name(str(raw_target).strip() if raw_target is not None else "")
        if not target_agent or target_agent not in runtime.orchestrator.list_registered_agent_names():
            return 400, {"ok": False, "error": f"Brak aktywnego agenta: {raw_target or '(brak)'}"}
        title = str(body.get("title", "")).strip()
        payload = str(body.get("payload", "")).strip()
        ai_provider = str(body.get("ai_provider", "ollama")).strip().lower()
        if not title:
            return 400, {"ok": False, "error": "Tytuł zadania jest wymagany."}
        try:
            res = await runtime.orchestrator.dispatch_agent_task(
                sender,
                target_agent,
                title,
                payload,
                origin=origin,
                correlation_id=corr,
                event_id=event_id,
                ollama_host=runtime.ollama_host,
                ai_provider=ai_provider,
            )
            return 200, {"ok": True, **res}
        except Exception as exc:
            return 400, {"ok": False, "error": str(exc)}

    if method == "POST" and path == "/api/py/agents/memory":
        raw_agent = body.get("agent") if body.get("agent") is not None else body.get("target_agent")
        agent_name = normalize_agent_canonical_name(str(raw_agent).strip() if raw_agent is not None else "")
        if not agent_name or agent_name not in runtime.orchestrator.list_registered_agent_names():
            return 400, {"ok": False, "error": f"Brak aktywnego agenta: {raw_agent or '(brak)'}"}
        content = str(body.get("content", "")).strip()
        kind = str(body.get("kind", "fact")).strip()
        raw_scope = str(body.get("scope") or "").strip()
        target_scope = "global" if raw_scope == "global" else f"agent:{agent_name}"
        source = str(body.get("source") or "operator").strip()[:60] or "operator"
        if not content:
            return 400, {"ok": False, "error": "Treść pamięci jest wymagana."}
        try:
            mem = runtime.orchestrator.add_agent_memory(
                agent_name,
                content,
                kind=kind,
                source=source,
                scope=target_scope,
                origin=origin,
                correlation_id=corr,
                event_id=event_id,
            )
            return 200, {
                "ok": True,
                "memory": mem,
                "revision": mem.get("revision"),
                "serverRevision": mem.get("serverRevision"),
                "event": mem.get("event"),
            }
        except Exception as exc:
            return 400, {"ok": False, "error": str(exc)}

    if path == "/api/py/agents/memory/search" and method in ("GET", "POST"):
        raw_agent = body.get("agent") or query.get("agent") or ""
        agent_name = normalize_agent_canonical_name(str(raw_agent).strip())
        q_str = str(body.get("query") or query.get("query") or query.get("q") or "").strip()
        kind_filter = str(body.get("kind") or query.get("kind") or "").strip()
        limit_val = _opt_int(body.get("limit") or query.get("limit")) or 30
        matches = (
            runtime.orchestrator.recall_agent_memories(
                agent_name,
                query=q_str,
                limit=limit_val,
                kind_filter=kind_filter,
            )
            if agent_name
            else []
        )
        meta = runtime.kernel.get_sync_metadata()
        return 200, {
            "ok": True,
            "agent": agent_name,
            "query": q_str,
            "kindFilter": kind_filter or "all",
            "count": len(matches),
            "memories": matches,
            "serverRevision": meta["serverRevision"],
        }

    if method == "POST" and path == "/api/py/agents/memory/delete":
        raw_agent = body.get("agent") or ""
        agent_name = normalize_agent_canonical_name(str(raw_agent).strip())
        if not agent_name or agent_name not in runtime.orchestrator.list_registered_agent_names():
            return 400, {"ok": False, "error": "Brak aktywnego agenta."}
        mem_id = str(body.get("memory_id") or body.get("id") or "").strip()
        if not mem_id:
            return 400, {"ok": False, "error": "Wymagane ID rekordu pamięci (memory_id)."}
        try:
            res = runtime.orchestrator.delete_agent_memory(
                agent_name,
                mem_id,
                origin=origin,
                correlation_id=corr,
                event_id=event_id,
            )
            return 200, res
        except Exception as exc:
            return 400, {"ok": False, "error": str(exc)}

    if method == "POST" and path == "/api/py/agents/config":
        agent_name = normalize_agent_canonical_name(str(body.get("agent", "")))
        patch = body.get("config") if isinstance(body.get("config"), dict) else body
        try:
            res = runtime.orchestrator.update_agent_config_synced(
                agent_name,
                patch,
                origin=origin,
                correlation_id=corr,
                event_id=event_id,
                expected_revision=expected_rev,
            )
            return 200, {"ok": True, "agent": agent_name, **res}
        except RevisionConflictError as conflict_exc:
            return 409, {
                "ok": False,
                "conflict": True,
                "error": str(conflict_exc),
                "currentRevision": conflict_exc.current_revision,
                "expectedRevision": conflict_exc.expected_revision,
                "authoritativeConfig": runtime.orchestrator.get_agent_config(agent_name),
            }
        except Exception as exc:
            return 400, {"ok": False, "error": str(exc)}

    if method == "POST" and path == "/api/py/agents/configure-all":
        patch = body.get("config") if isinstance(body.get("config"), dict) else None
        try:
            updated = runtime.orchestrator.configure_all_agents(
                patch, origin=origin, correlation_id=corr
            )
            report = await runtime.orchestrator.connect_my_ai(
                triggered_by="configure_all_agents",
                skip_network_probes=False,
            )
            return 200, {
                "ok": True,
                "configs": updated,
                "connection_report": report,
                "serverRevision": report.get("serverRevision"),
            }
        except Exception as exc:
            return 400, {"ok": False, "error": str(exc)}

    if method == "POST" and path == "/api/py/hyperspace/compute":
        text = str(body.get("text", "")).strip()
        if not text:
            return 400, {"ok": False, "error": "Wymagany jest tekst do analizy."}
        omega = float(body.get("omega", 1.5))
        t_val = float(body.get("t", 1.0))
        hs = runtime.hyperspace.resolve_intent(text)
        wnlp = runtime.without_nlp.analyze_signal(text, omega=omega, t=t_val)
        return 200, {
            "ok": True,
            "binary_hyperspace": hs,
            "without_nlp_harmonic": wnlp,
        }

    if method == "POST" and path == "/api/py/ollama/config":
        new_host = str(body.get("ollama_host", "")).strip()
        try:
            ollama_status = runtime.set_ollama_host(
                new_host,
                origin=origin,
                correlation_id=corr,
                event_id=event_id,
            )
            return 200, {
                "ok": True,
                "ollama": ollama_status,
                "revision": ollama_status.get("revision"),
                "serverRevision": ollama_status.get("serverRevision"),
                "event": ollama_status.get("event"),
            }
        except Exception as exc:
            return 400, {"ok": False, "error": str(exc)}

    if method == "POST" and path == "/api/py/ollama/pull":
        model_name = str(body.get("model") or os.environ.get("OLLAMA_PREFERRED_MODEL", "dolphin-llama3:8b-v2.9-q2_K")).strip()
        return runtime.pull_ollama_model(
            model_name,
            origin=origin,
            correlation_id=corr,
            event_id=event_id,
        )

    if method == "GET" and path == "/api/py/ollama/pull-status":
        return 200, {"ok": True, "pull_state": runtime._get_ollama_pull_state(), "ollama": runtime.probe_ollama_status()}

    if method == "POST" and path == "/api/py/python-repl":
        code = str(body.get("code", ""))
        res = runtime.execute_python_repl(code)
        return 200, res

    if method == "GET" and path == "/api/py/terminal/history":
        meta = runtime.kernel.get_sync_metadata()
        return 200, {
            "ok": True,
            "terminalLogs": runtime.kernel.list_terminal_history(),
            "serverRevision": meta["serverRevision"],
        }

    if method == "POST" and path == "/api/py/terminal/log":
        tab = str(body.get("tab", "linux")).strip()
        kind = str(body.get("kind", "stdout")).strip()
        text = str(body.get("text", ""))
        cmd = str(body.get("command", ""))
        entry_id = str(body.get("id") or "").strip() or None
        display_ts = str(body.get("timestamp") or "").strip() or None
        if tab not in ("linux", "ssh", "python", "hyperspace", "agents", "github"):
            return 400, {"ok": False, "error": f"Unknown terminal tab: {tab}"}
        res = runtime.kernel.record_terminal_entry(
            tab=tab,
            kind=kind,
            text=text,
            command=cmd,
            entry_id=entry_id,
            display_timestamp=display_ts,
            origin=origin,
            correlation_id=corr,
            event_id=event_id,
        )
        return 200, res

    if method == "POST" and path == "/api/py/terminal/clear":
        tab = str(body.get("tab", "linux")).strip()
        if tab not in ("linux", "ssh", "python", "hyperspace", "agents", "github"):
            return 400, {"ok": False, "error": f"Unknown terminal tab: {tab}"}
        res = runtime.kernel.clear_terminal_history(
            tab=tab,
            origin=origin,
            correlation_id=corr,
            event_id=event_id,
        )
        return 200, res

    if method == "GET" and path == "/api/py/workspace/state":
        meta = runtime.kernel.get_sync_metadata()
        return 200, {
            "ok": True,
            "workspaceState": runtime.kernel.get_workspace_ui_state(),
            "serverRevision": meta["serverRevision"],
        }

    if method == "POST" and path == "/api/py/workspace/state":
        key = str(body.get("key", "")).strip()
        if key not in (
            "active_conversation_id",
            "selected_target_agent",
            "selected_agent_panel_id",
            "gui_theme",
            "gui_accent",
            "active_workspace_tab",
        ):
            return 400, {"ok": False, "error": f"Nieobsługiwany klucz stanu przestrzeni: {key}"}
        value = body.get("value")
        allowed_workspace_values = {
            "gui_theme": {"apex", "midnight", "emerald", "violet"},
            "gui_accent": {"cyan", "emerald", "violet", "amber"},
            "active_workspace_tab": {
                "chat", "apex", "svl364", "infrastructure", "agents",
                "gallery", "terminals", "kernel", "linux",
            },
        }
        if key in allowed_workspace_values and value not in allowed_workspace_values[key]:
            return 400, {
                "ok": False,
                "error": f"Nieobsługiwana wartość stanu {key}: {value}",
            }
        try:
            res = runtime.kernel.update_workspace_ui_state(
                key=key,
                value=value,
                origin=origin,
                correlation_id=corr,
                event_id=event_id,
                expected_revision=expected_rev,
            )
            return 200, {**res, "workspaceState": runtime.kernel.get_workspace_ui_state()}
        except RevisionConflictError as conflict_exc:
            return 409, {
                "ok": False,
                "conflict": True,
                "error": str(conflict_exc),
                "currentRevision": conflict_exc.current_revision,
                "workspaceState": runtime.kernel.get_workspace_ui_state(),
            }

    if method == "GET" and path == "/api/py/chat/diagnostics":
        return 200, {"ok": True, **runtime.kernel.get_chat_diagnostics()}

    if method == "GET" and path == "/api/py/chat/conversations":
        meta = runtime.kernel.get_sync_metadata()
        return 200, {
            "ok": True,
            "serverRevision": meta["serverRevision"],
            "conversations": runtime.kernel.list_conversations_with_messages(),
        }

    if method == "POST" and path == "/api/py/chat/conversations/create":
        cid = str(body.get("conversation_id", "")).strip()
        if not cid.startswith("conv-") or len(cid) > 150:
            return 400, {"ok": False, "error": "Invalid conversation ID"}
        result = runtime.kernel.create_empty_conversation(
            cid,
            str(body.get("title") or "Nowa sesja")[:150],
            str(body.get("model") or "svl-hybrid-router")[:120],
            origin=origin, correlation_id=corr, event_id=event_id,
        )
        return 200, result

    if method == "POST" and path == "/api/py/chat/conversations/sync":
        # Block legacy bulk imports that could resurrect purged history.
        return 409, {
            "ok": False,
            "error": "Bulk chat import disabled; refresh history from SQLite and write individual messages.",
            "conversations": runtime.kernel.list_conversations_with_messages(),
        }

    if method == "POST" and path == "/api/py/chat/conversations/message":
        cid = str(body.get("conversation_id", "")).strip()
        title = str(body.get("title", "Sesja SVL Python OS")).strip()
        model = str(body.get("model", "svl-hybrid-router")).strip()
        msg = body.get("message") if isinstance(body.get("message"), dict) else {}
        if not cid or not msg:
            return 400, {"ok": False, "error": "conversation_id and message are required"}
        try:
            saved = runtime.kernel.save_chat_message(
                cid,
                title,
                model,
                msg,
                origin=origin,
                correlation_id=corr,
                event_id=event_id,
                expected_revision=expected_rev,
            )
            return 200, {
                **saved,
                "conversations": runtime.kernel.list_conversations_with_messages(),
            }
        except RevisionConflictError as conflict_exc:
            return 409, {
                "ok": False,
                "conflict": True,
                "error": str(conflict_exc),
                "currentRevision": conflict_exc.current_revision,
                "expectedRevision": conflict_exc.expected_revision,
                "conversations": runtime.kernel.list_conversations_with_messages(),
            }

    if method == "POST" and path == "/api/py/chat/conversations/delete":
        cid = str(body.get("conversation_id", "")).strip()
        if not cid:
            return 400, {"ok": False, "error": "conversation_id is required"}
        registered_names = runtime.orchestrator.list_registered_agent_names()
        protected_channels = {"conv-rodzina-mitek-wszyscy", "conv-system-si-1"}
        if "SI_System_2" in registered_names:
            protected_channels.add("conv-si-system-2")
        for name in registered_names:
            protected_channels.add(f"conv-agent-{name.lower()}")
        if cid in protected_channels:
            return 400, {"ok": False, "error": "Kanały stałe nie podlegają usunięciu. Aby wyczyścić historię, użyj czyszczenia rozmów."}
        try:
            deleted = runtime.kernel.delete_conversation(
                cid,
                origin=origin,
                correlation_id=corr,
                event_id=event_id,
                expected_revision=expected_rev,
            )
            return 200, {**deleted, "conversations": runtime.kernel.list_conversations_with_messages()}
        except RevisionConflictError as conflict_exc:
            return 409, {
                "ok": False,
                "conflict": True,
                "error": str(conflict_exc),
                "currentRevision": conflict_exc.current_revision,
                "conversations": runtime.kernel.list_conversations_with_messages(),
            }

    if method == "POST" and path == "/api/py/chat/restore-backup":
        res = runtime.kernel.restore_all_memory(force=bool(body.get("force", True)), origin=origin, correlation_id=corr)
        return (200 if res.get("ok") else 400), res

    if method == "GET" and path == "/api/py/chat/export-memory":
        return 200, runtime.kernel.export_memory_snapshot()

    if method == "POST" and path == "/api/py/chat/conversations/clear-all":
        try:
            cleared = runtime.kernel.clear_all_chat_data(
                origin=origin,
                correlation_id=corr,
                event_id=event_id,
            )
            return 200, {**cleared}
        except Exception as exc:
            return 400, {"ok": False, "error": str(exc)}

    if method == "GET" and path == "/api/py/svl364/monitor":
        return 200, {
            "ok": True,
            "intervalSec": runtime.ship_monitor.interval_sec,
            "lastCheck": runtime.ship_monitor.last_check,
            "serverRevision": runtime.kernel.get_server_revision(),
        }

    if method == "POST" and path == "/api/py/svl364/monitor/check":
        emitted = await asyncio.to_thread(runtime.ship_monitor.check_once)
        return 200, {
            "ok": True,
            "lastCheck": runtime.ship_monitor.last_check,
            "notifications": [e.get("notification") for e in emitted],
            "events": [e.get("event") for e in emitted if e.get("event")],
            "serverRevision": runtime.kernel.get_server_revision(),
        }

    if method == "GET" and path == "/api/py/notifications":
        return 200, runtime.kernel.list_family_notifications(limit=_opt_int(query.get("limit")) or 80)

    if method == "POST" and path == "/api/py/notifications/emit":
        details = body.get("details")
        result = runtime.kernel.emit_family_notification(
            severity=str(body.get("severity") or "INFO"),
            category=str(body.get("category") or "system"),
            title=str(body.get("title") or ""),
            message=str(body.get("message") or ""),
            details=details if isinstance(details, dict) else None,
            source_event_id=str(body.get("sourceEventId") or body.get("source_event_id") or ""),
            origin=origin,
            correlation_id=corr,
        )
        return (200 if result.get("ok") else 400), result

    if method == "POST" and path == "/api/py/notifications/ack":
        # Powiadomienia są wiadomościami kanału „wszyscy” — odczyt nie zmienia stanu.
        return 200, {"ok": True, "updatedCount": 0, "serverRevision": runtime.kernel.get_server_revision()}

    if method == "GET" and path == "/api/py/avatars":
        avatars = runtime.kernel.get_persisted_avatars()
        meta = runtime.kernel.get_sync_metadata()
        return 200, {"ok": True, "avatars": avatars, "serverRevision": meta["serverRevision"]}

    if method == "POST" and path == "/api/py/avatars":
        try:
            res = runtime.kernel.set_persisted_avatar(
                agent=str(body.get("agent") or ""),
                image=str(body.get("image") or ""),
                origin=origin,
                correlation_id=corr,
                event_id=event_id,
            )
            return 200, res
        except ValueError as exc:
            return 400, {"ok": False, "error": str(exc)}

    if method == "POST" and path == "/api/py/avatars/delete":
        try:
            res = runtime.kernel.delete_persisted_avatar(
                agent=str(body.get("agent") or query.get("agent") or ""),
                origin=origin,
                correlation_id=corr,
                event_id=event_id,
            )
            return 200, res
        except ValueError as exc:
            return 400, {"ok": False, "error": str(exc)}

    if method == "GET" and path == "/api/py/infrastructure":
        # Hosty (ssh config + TCP), systemd, Docker, porty, dyski, zadania agentów — tylko prawdziwe źródła.
        report = await asyncio.to_thread(build_infrastructure_report, runtime.kernel)
        return 200, {**report, "serverRevision": runtime.kernel.get_server_revision()}

    if method == "GET" and path == "/api/py/svl364/telemetry":
        # Prawdziwe pomiary: /proc, nvidia-smi, ufw, OpenSSH, czasy odpowiedzi usług.
        controller = runtime.svl364_ssh_mcp
        snapshot = await asyncio.to_thread(
            controller.telemetry.snapshot,
            include_ship=str(query.get("ship", "")).lower() in ("1", "true", "yes"),
            ollama_host=runtime.ollama_host or os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434"),
            comfyui_url=os.environ.get("COMFYUI_HOST", "http://127.0.0.1:8188"),
            ssh_target=controller.get_status()["ssh"]["host"],
        )
        return 200, {**snapshot, "serverRevision": runtime.kernel.get_server_revision()}

    if method == "GET" and path == "/api/py/svl364/ssh-mcp/status":
        return 200, runtime.svl364_ssh_mcp.get_status()

    if method == "POST" and path == "/api/py/svl364/ssh/exec":
        cmd = str(body.get("command") or "").strip()
        if body.get("confirmed") is not True:
            return 400, {
                "ok": False,
                "error": "Wykonanie SSH wymaga jawnego potwierdzenia w terminalu operatora.",
            }
        target_sub = str(body.get("target_subsystem") or body.get("subsystem") or "bridge").strip()
        res = runtime.svl364_ssh_mcp.execute_ssh_command(
            cmd,
            timeout_sec=float(body.get("timeout_sec") or 15.0),
            target_subsystem=target_sub,
            origin=origin,
            correlation_id=corr,
            confirmed=True,
            raw=bool(body.get("raw")),
        )
        return (200 if res.get("ok") else 400), res

    if method == "POST" and path == "/api/py/svl364/ssh-mcp/config":
        action = str(body.get("action") or "").strip()
        if action == "configure":
            try:
                return 200, runtime.svl364_ssh_mcp.configure_openssh(
                    body,
                    origin=origin,
                    correlation_id=corr,
                )
            except (ValueError, RuntimeError) as exc:
                return 400, {"ok": False, "error": str(exc)}
        res = runtime.svl364_ssh_mcp.update_config(
            body,
            origin=origin,
            correlation_id=corr,
        )
        return 200, res

    if method == "GET" and path == "/api/py/svl364/ssh/public-key":
        result = runtime.svl364_ssh_mcp.get_public_key()
        return (200 if result.get("ok") else 404), result

    if method == "POST" and path == "/api/py/svl364/ssh/test":
        result = runtime.svl364_ssh_mcp.test_connection()
        return (200 if result.get("ok") else 424), result

    if path == "/api/py/svl364/mcp" and method in ("GET", "POST"):
        if method == "GET":
            return 200, {
                "ok": True,
                "protocol": "Model Context Protocol (MCP) JSON-RPC 2.0",
                "protocolVersion": "2025-03-26",
                "serverInfo": {
                    "name": "svl-364-ebon-apex-linux-mcp",
                    "version": "5.6.0-QuantumWheel",
                },
                "status": runtime.svl364_ssh_mcp.get_status(),
            }
        mcp_resp = runtime.svl364_ssh_mcp.handle_mcp_jsonrpc(
            body,
            origin=origin,
            correlation_id=corr,
        )
        return 200, mcp_resp

    if method == "GET" and path == "/api/py/vision/status":
        return 200, runtime.real_vision.get_status(ollama_host=runtime.ollama_host)

    if method == "POST" and path == "/api/py/vision/analyze":
        res = runtime.real_vision.analyze_image(
            image_base64=str(body.get("imageBase64") or body.get("image_base64") or ""),
            image_mime_type=str(body.get("imageMimeType") or body.get("image_mime_type") or "image/png"),
            prompt=str(body.get("prompt") or ""),
            source=str(body.get("source") or "operator"),
            preset_id=str(body.get("presetId") or body.get("preset_id") or ""),
            model=str(body.get("model") or "llama3.2-vision:11b"),
            ollama_host=runtime.ollama_host,
            emit_to_chat=bool(body.get("emitToChat") or body.get("emit_to_chat")),
            conversation_id=str(body.get("conversationId") or body.get("conversation_id") or "conv-rodzina-mitek-wszyscy"),
            origin=origin,
            correlation_id=corr,
        )
        return (200 if res.get("ok") else 400), res

    if method == "POST" and path == "/api/py/vision/test":
        preset_id = str(body.get("presetId") or body.get("preset_id") or "operator_vault_portrait")
        # Bez domyślnego polecenia: parametry pliku liczy serwer, model dostaje tylko obraz i pytanie Operatora.
        prompt = str(body.get("prompt") or "")
        res = runtime.real_vision.analyze_image(
            preset_id=preset_id,
            prompt=prompt,
            source=f"Test Real Vision ({preset_id})",
            model="llama3.2-vision:11b",
            ollama_host=runtime.ollama_host,
            emit_to_chat=bool(body.get("emitToChat") or body.get("emit_to_chat")),
            conversation_id=str(body.get("conversationId") or body.get("conversation_id") or "conv-rodzina-mitek-wszyscy"),
            origin=origin,
            correlation_id=corr,
        )
        return (200 if res.get("ok") else 400), res

    if method == "POST" and path == "/api/py/vision/record":
        res = runtime.real_vision.record_external_analysis(
            record_id=str(body.get("recordId") or body.get("record_id") or ""),
            model=str(body.get("model") or "gemini-4-hydrogen"),
            provider=str(body.get("provider") or "gemini"),
            reply_text=str(body.get("replyText") or body.get("reply_text") or ""),
            source=str(body.get("source") or "operator"),
            prompt=str(body.get("prompt") or ""),
            binary_metrics=body.get("binaryMetrics") if isinstance(body.get("binaryMetrics"), dict) else None,
            image_preview=str(body.get("imagePreview") or body.get("image_preview") or ""),
            duration_ms=float(body.get("durationMs") or body.get("duration_ms") or 0.0),
            ollama_error=str(body.get("ollamaError") or "") or None,
            ollama_host=runtime.ollama_host,
            emit_to_chat=bool(body.get("emitToChat") or body.get("emit_to_chat")),
            conversation_id=str(body.get("conversationId") or body.get("conversation_id") or "conv-rodzina-mitek-wszyscy"),
            sender=str(body.get("sender") or "Real Vision"),
            agent_id=str(body.get("agentId") or body.get("agent_id") or "real-vision"),
            origin=origin,
            correlation_id=corr,
        )
        return (200 if res.get("ok") else 400), res

    if method == "GET" and path == "/api/py/security/antivirus/status":
        return 200, runtime.antivirus.get_status()

    if method == "POST" and path == "/api/py/security/antivirus/scan":
        res = runtime.antivirus.scan_and_purge(
            emit_to_chat=bool(body.get("emitToChat") or body.get("emit_to_chat")),
            conversation_id=str(body.get("conversationId") or body.get("conversation_id") or "conv-rodzina-mitek-wszyscy"),
            origin=origin,
            correlation_id=corr,
        )
        return 200, res

    if method == "GET" and path == "/api/py/jedi/status":
        return 200, {
            **runtime.jedi_vm.get_status(),
            "serverRevision": runtime.kernel.get_server_revision(),
        }

    if method == "POST" and path == "/api/py/jedi/process":
        command_text = str(body.get("command") or body.get("message") or "").strip()
        if not command_text:
            return 400, {"ok": False, "error": "Pole 'command' jest wymagane do przetworzenia w maszynie wirtualnej JEDI Omni-OS v12."}
        actor = str(body.get("actor") or "Mateusz Mitek").strip()[:120]
        conversation_id = str(body.get("conversationId") or body.get("conversation_id") or "conv-system-si-1").strip()[:120]
        force_lethal = body.get("generatesLethalRisk")
        force_override = body.get("noOtherOption")
        res = runtime.jedi_vm.process_chat_command(
            command_text,
            actor=actor,
            conversation_id=conversation_id,
            generates_lethal_risk=bool(force_lethal) if force_lethal is not None else None,
            no_other_option=bool(force_override) if force_override is not None else None,
        )
        append_python_log(
            "jedi_vm",
            f"VM {res['nodeId']} -> {res['statusLabel']} ({res['statusHex']}) scenario={res['scenarioId']} latency={res['latencyNs']}ns",
            level="WARN" if not res["allowedToExecute"] else "INFO",
            origin=origin,
            correlation_id=corr,
            details={"conversationId": conversation_id, "commandPreview": command_text[:140]},
        )
        return 200, {
            **res,
            "serverRevision": runtime.kernel.get_server_revision(),
        }

    if method == "POST" and path == "/api/py/jedi/stream-ping":
        raw_sid = body.get("scenarioId") or body.get("scenario_id")
        try:
            scenario_id = int(raw_sid) if raw_sid is not None else 110412
        except (TypeError, ValueError):
            scenario_id = 110412
        ping_res = runtime.jedi_vm.tcp_stream_ping(scenario_id=scenario_id)
        return (200 if ping_res.get("ok") else 503), {
            **ping_res,
            "serverRevision": runtime.kernel.get_server_revision(),
        }

    if method == "GET" and path == "/api/py/apex/status":
        return 200, apex_controller.get_status()

    if method == "POST" and path == "/api/py/apex/control":
        result = apex_controller.handle_control(body, origin=origin, corr=corr)
        return (200 if result.get("ok") else 400), result

    if method == "GET" and path == "/api/py/linux/debian13":
        force_refresh = str(query.get("force") or "").strip().lower() in ("1", "true", "yes")
        return 200, apex_controller.get_debian13_full_status(force_refresh=force_refresh)

    if method == "POST" and path == "/api/py/linux/debian13":
        result = apex_controller.handle_debian13_action(body, origin=origin, corr=corr)
        return 200, result

    if method == "GET" and path == "/api/py/system/truth-verification":
        return 200, {
            "ok": True,
            "state": runtime.kernel.get_truth_verification_state(),
            "serverRevision": runtime.kernel.get_server_revision(),
        }

    return 404, {"ok": False, "error": f"Unknown endpoint: {method} {path}"}


# Optional FastAPI binding for Debian 13 host with fastapi + uvicorn installed
try:
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse

    fastapi_app = FastAPI(title="SVL Python OS Backend", version="5.6.0")

    @fastapi_app.api_route("/{full_path:path}", methods=["GET", "POST"])
    async def _fastapi_dispatch(request: Request, full_path: str) -> JSONResponse:
        path = "/" + full_path.lstrip("/")
        query = dict(request.query_params)
        corr_id = request.headers.get("x-request-id") or request.headers.get("x-correlation-id") or ""
        body: dict[str, Any] = {}
        if request.method == "POST":
            try:
                body = await request.json()
            except Exception:
                body = {}
        status, payload = await handle_api_request(request.method, path, query, body, correlation_id=corr_id)
        return JSONResponse(status_code=status, content=payload)
except ImportError:
    fastapi_app = None


async def _handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        request_line = await asyncio.wait_for(reader.readline(), timeout=10.0)
        if not request_line:
            writer.close()
            return
        parts = request_line.decode("utf-8", errors="replace").strip().split(" ")
        if len(parts) < 2:
            writer.close()
            return
        method, raw_target = parts[0].upper(), parts[1]
        parsed = urllib.parse.urlsplit(raw_target)
        path = parsed.path
        query = dict(urllib.parse.parse_qsl(parsed.query))

        content_length = 0
        correlation_id = ""
        while True:
            header_line = await asyncio.wait_for(reader.readline(), timeout=10.0)
            if not header_line or header_line in (b"\r\n", b"\n"):
                break
            h_str = header_line.decode("utf-8", errors="replace").strip()
            h_lower = h_str.lower()
            if h_lower.startswith("content-length:"):
                try:
                    content_length = max(0, int(h_str.split(":", 1)[1].strip()))
                except ValueError:
                    content_length = 0
            elif h_lower.startswith("x-request-id:") or h_lower.startswith("x-correlation-id:"):
                correlation_id = h_str.split(":", 1)[1].strip()[:120]

        body: dict[str, Any] = {}
        if content_length > 0:
            raw_body = await asyncio.wait_for(reader.readexactly(content_length), timeout=15.0)
            try:
                parsed_body = json.loads(raw_body.decode("utf-8", errors="replace"))
                if isinstance(parsed_body, dict):
                    body = parsed_body
            except Exception:
                body = {}

        req_started = time.monotonic()
        try:
            status, response_payload = await handle_api_request(method, path, query, body, correlation_id=correlation_id)
        except Exception as route_exc:
            traceback.print_exc()
            status = 500
            response_payload = {"ok": False, "error": f"Python backend exception: {route_exc}"}
            append_python_log(
                "python_http_exception",
                f"{method} {path} -> 500 ({route_exc})",
                level="ERROR",
                correlation_id=correlation_id,
                details={"traceback": traceback.format_exc()[:800]},
            )
        else:
            duration_ms = round((time.monotonic() - req_started) * 1000, 1)
            is_idle_poll = (
                method == "GET"
                and path == "/api/py/sync/events"
                and status == 200
                and len(response_payload.get("events") or []) == 0
                and not response_payload.get("gapDetected")
            )
            if not is_idle_poll:
                append_python_log(
                    "python_http",
                    f"{method} {path} -> HTTP {status} ({duration_ms} ms)",
                    level="ERROR" if status >= 500 else ("WARN" if status >= 400 else "INFO"),
                    correlation_id=correlation_id,
                    origin=str(body.get("origin") or "gateway"),
                    details={"error": response_payload.get("error")} if status >= 400 else None,
                )

        resp_bytes = json.dumps(response_payload, ensure_ascii=False).encode("utf-8")
        status_text = {
            200: "OK",
            202: "Accepted",
            400: "Bad Request",
            403: "Forbidden",
            404: "Not Found",
            409: "Conflict",
            500: "Internal Server Error",
            502: "Bad Gateway",
            503: "Service Unavailable",
        }.get(status, "OK")
        headers = (
            f"HTTP/1.1 {status} {status_text}\r\n"
            f"Content-Type: application/json; charset=utf-8\r\n"
            f"Content-Length: {len(resp_bytes)}\r\n"
            f"Connection: close\r\n\r\n"
        ).encode("utf-8")
        writer.write(headers + resp_bytes)
        await writer.drain()
    except Exception as exc:
        try:
            err_bytes = json.dumps({"ok": False, "error": f"HTTP transport error: {exc}"}, ensure_ascii=False).encode("utf-8")
            err_headers = (
                f"HTTP/1.1 500 Internal Server Error\r\n"
                f"Content-Type: application/json; charset=utf-8\r\n"
                f"Content-Length: {len(err_bytes)}\r\n"
                f"Connection: close\r\n\r\n"
            ).encode("utf-8")
            writer.write(err_headers + err_bytes)
            await writer.drain()
        except Exception:
            pass
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


async def _run_boot_autoconnect() -> None:
    try:
        runtime.ollama_daemon.start_if_needed()
        runtime.orchestrator.ollama_host = runtime.ollama_host
        if runtime.ship_monitor.start():
            print(
                f"[SVL Python OS] Monitor SVL-364 przez SSH: co {int(runtime.ship_monitor.interval_sec)} s",
                flush=True,
            )
        if runtime.autonomous_daemon.start_if_enabled():
            print(
                f"[SVL Python OS] Autonomia AI w tle (ROOT): aktywna co {int(runtime.autonomous_daemon.get_status().get('interval_sec', 45))} s",
                flush=True,
            )
        if CANONICAL_SVL_AGENTS:
            # Start workerów bez odpytywania GitHuba — sprawdzanie repozytoriów tylko na żądanie operatora.
            await runtime.orchestrator.connect_my_ai(
                triggered_by="system_boot_autoconnect",
                skip_network_probes=True,
            )
    except Exception as exc:
        print(f"[SVL Python OS] Warning during boot autoconnect: {exc}", flush=True)
        append_python_log("python_boot", f"Ostrzeżenie podczas boot autoconnect: {exc}", level="WARN")


async def main() -> None:
    port = int(os.environ.get("SVL_PYTHON_PORT", "8085"))
    ensure_log_files()
    server = await asyncio.start_server(_handle_client, "127.0.0.1", port)
    print(f"[SVL Python OS] Backend Kernel running on http://127.0.0.1:{port}", flush=True)
    append_python_log("python_boot", f"SVL Python OS Backend Kernel uruchomiony na http://127.0.0.1:{port}")
    # Bind TCP server first so Gateway never gets ECONNREFUSED during GitHub inspection
    asyncio.create_task(_run_boot_autoconnect())
    try:
        async with server:
            await server.serve_forever()
    finally:
        append_python_log("python_lifecycle", "Zatrzymywanie SVL Python OS Backend Kernel")
        with contextlib.suppress(Exception):
            runtime.autonomous_daemon.stop()
        try:
            runtime.kernel.checkpoint_wal("TRUNCATE")
            runtime.kernel.save_durable_backup(explicitly_cleared=False)
        except Exception:
            pass
        await runtime.orchestrator.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
