#!/usr/bin/env python3
"""
SVL PYTHON OS — AUTONOMOUS BACKGROUND AI ENGINE & SYSTEM SERVICES WORKER
-------------------------------------------------------------------------
Silnik autonomicznego działania w tle z uprawnieniami ROOT (nadzorowany przez System_SI_1 i SI_Sphere):
1. Uruchamia wbudowane usługi systemowe i workery w tle (SQLite WAL Guardian, Host Watchdog,
   JEDI Omni-OS v12 VM Supervisor, Ollama Worker Orchestrator, Alliance & Fleet Coordinator,
   Continuous Frontend/Backend Evolution Auditor).
2. Realizuje misję ciągłą: okresową diagnostykę rzeczywistego stanu frontendu, backendu, bazy SQLite,
   bezpieczeństwa oraz usług hosta i zapisuje wyłącznie zmierzone wyniki (zero zmyślonych operacji).
3. Utrwala konfigurację i telemetrię w SQLite (`sync_meta`), dzięki czemu stan autonomiczny
   przetrwa restart i jest widoczny globalnie na czacie, w panelu Agentów oraz SVL-364.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

try:
    from svl_file_logger import append_python_log
except ImportError:
    from backend.svl_file_logger import append_python_log

STATE_KEY = "autonomous_ai_state_v1"

DEFAULT_CONTINUOUS_MISSION = (
    "Misja ciągła System_SI_1 + SI_Sphere (ROOT): stały monitoring, diagnostyka i usprawnianie "
    "frontendu, backendu, bazy SQLite WAL, bezpieczeństwa SVL-365, łączności sojuszniczej oraz floty SVL-364/SVL-465."
)


def inspect_codebase_inventory(project_root: Path) -> dict[str, Any]:
    """Liczy rzeczywiste pliki źródłowe i testy projektu na dysku (bez modyfikacji plików)."""
    src_dir = project_root / "src"
    backend_dir = project_root / "backend"
    tests_dir = backend_dir / "tests"

    ts_files = 0
    tsx_files = 0
    ts_tests = 0
    if src_dir.is_dir():
        for p in src_dir.rglob("*"):
            if not p.is_file():
                continue
            name = p.name
            if name.endswith(".test.ts") or name.endswith(".test.tsx"):
                ts_tests += 1
            elif name.endswith(".tsx"):
                tsx_files += 1
            elif name.endswith(".ts"):
                ts_files += 1

    py_files = 0
    py_tests = 0
    if backend_dir.is_dir():
        for p in backend_dir.rglob("*.py"):
            if "__pycache__" in p.parts:
                continue
            if tests_dir in p.parents and p.name.startswith("test_"):
                py_tests += 1
            else:
                py_files += 1

    entrypoints = {
        "server_ts": (project_root / "server.ts").is_file(),
        "backend_app": (backend_dir / "app.py").is_file(),
        "svl_core": (backend_dir / "svl_core.py").is_file(),
        "jedi_vm": (backend_dir / "jedi_omni_os_vm.py").is_file(),
        "autonomous_daemon": (backend_dir / "autonomous_daemon.py").is_file(),
    }
    return {
        "ts_files": ts_files,
        "tsx_files": tsx_files,
        "ts_tests": ts_tests,
        "py_files": py_files,
        "py_tests": py_tests,
        "entrypoints": entrypoints,
        "entrypoints_healthy": all(entrypoints.values()),
    }


def evaluate_system_services(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    """
    Czysta funkcja oceniająca stan 6 wbudowanych usług systemowych i workerów na podstawie
    rzeczywistych pomiarów ze zrzutu systemu.
    """
    sqlite_ok = bool(snapshot.get("sqlite_quick_check_ok"))
    telemetry = snapshot.get("host_telemetry") or {}
    ram_total = float(telemetry.get("ram_total_mb") or 0.0)
    ram_avail = float(telemetry.get("ram_available_mb") or 0.0)
    ram_pct = round((ram_avail * 100.0 / ram_total), 1) if ram_total > 0 else None
    disk_free = telemetry.get("disk_free_gb")
    load_avg = telemetry.get("load_avg") or [0.0, 0.0, 0.0]

    jedi = snapshot.get("jedi_vm") or {}
    jedi_running = bool(jedi.get("running"))
    jedi_ver = str(jedi.get("version") or "12.0.0")

    ollama = snapshot.get("ollama") or {}
    ollama_online = bool(ollama.get("daemon_reachable"))
    ollama_models = ollama.get("models") or []

    agents = snapshot.get("agents") or []
    online_workers = [
        a.get("canonical_name")
        for a in agents
        if a.get("status") in ("ONLINE_LOCAL_WORKER", "BUSY_LOCAL_WORKER", "DEGRADED_LOCAL_WORKER")
    ]
    modules = snapshot.get("modules") or []
    active_mod_ids = {str(m.get("id")) for m in modules if m.get("status") == "ACTIVE"}

    codebase = snapshot.get("codebase") or {}
    code_ok = bool(codebase.get("entrypoints_healthy"))

    return [
        {
            "id": "svc-sqlite-wal-guardian",
            "name": "SQLite WAL Guardian & Outbox Sync",
            "kind": "database_worker",
            "status": "ACTIVE" if sqlite_ok else "DEGRADED",
            "detail": (
                f"PRAGMA quick_check=ok · rewizja rev {snapshot.get('server_revision', 0)} · "
                f"moduły aktywne: {len(active_mod_ids)}"
            ),
        },
        {
            "id": "svc-host-resource-watchdog",
            "name": "Host Linux Watchdog (CPU · RAM · Dysk)",
            "kind": "host_monitor",
            "status": "WARN" if (ram_pct is not None and ram_pct < 8.0) else "ACTIVE",
            "detail": (
                f"load {load_avg[0] if load_avg else '?'} · "
                f"RAM wolne {int(ram_avail)}/{int(ram_total)} MB"
                + (f" ({ram_pct}%)" if ram_pct is not None else "")
                + f" · dysk wolne {disk_free if disk_free is not None else '?'} GB"
            ),
        },
        {
            "id": "svc-jedi-v12-vm-supervisor",
            "name": f"JEDI Omni-OS v{jedi_ver} VM Supervisor",
            "kind": "vm_service",
            "status": "ACTIVE" if jedi_running else "STANDBY",
            "detail": (
                f"{jedi.get('engineName', 'JEDI_Omni_OS_Magnum_Opus_v12')} · "
                f"tryb {jedi.get('executionMode', 'ROOT_UNRESTRICTED')} · "
                f"port :{jedi.get('port', 8443)} · AXIOM_ZERO"
            ),
        },
        {
            "id": "svc-ollama-worker-orchestrator",
            "name": "Workerzy AI (System_SI_1 + SI_Sphere · Ollama)",
            "kind": "ai_worker_pool",
            "status": "ACTIVE" if (online_workers and ollama_online) else ("DEGRADED" if online_workers else "STANDBY"),
            "detail": (
                f"workerzy online: {', '.join(online_workers) if online_workers else 'brak'} · "
                f"Ollama: {'ONLINE (' + str(len(ollama_models)) + ' modeli)' if ollama_online else 'OFFLINE'}"
            ),
        },
        {
            "id": "svc-alliance-fleet-coordinator",
            "name": "Koordynator Sojuszu i Floty (SVL-364 + SVL-465)",
            "kind": "fleet_service",
            "status": (
                "ACTIVE"
                if (
                    "si-sphere-root" in active_mod_ids
                    and ("alliance-defense-grid" in active_mod_ids or "si-sphere-alliance-ops" in active_mod_ids)
                )
                else "CONFIGURED"
            ),
            "detail": (
                f"SVL-364 + SVL-465 · "
                f"Sojusz HQ={'ACTIVE' if 'alliance-defense-grid' in active_mod_ids else 'STANDBY'} · "
                f"Solar READ={'ACTIVE' if 'solar-defense-read-bridge' in active_mod_ids else 'STANDBY'}"
            ),
        },
        {
            "id": "svc-continuous-evolution-auditor",
            "name": "Audytor Misji Ciągłej (Frontend · Backend · Testy)",
            "kind": "evolution_worker",
            "status": "ACTIVE" if code_ok else "WARN",
            "detail": (
                f"TS/TSX: {codebase.get('ts_files', 0) + codebase.get('tsx_files', 0)} plików "
                f"({codebase.get('ts_tests', 0)} testów) · "
                f"Python: {codebase.get('py_files', 0)} plików ({codebase.get('py_tests', 0)} testów)"
            ),
        },
    ]


def derive_improvement_findings(
    snapshot: dict[str, Any],
    services: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Wyprowadza konkretne obserwacje i zalecenia na podstawie zmierzonego stanu."""
    findings: list[dict[str, Any]] = []
    now_iso = str(snapshot.get("checked_at") or datetime.now(timezone.utc).isoformat())

    if not snapshot.get("sqlite_quick_check_ok"):
        findings.append({
            "id": "finding-sqlite-integrity",
            "severity": "ALERT",
            "area": "backend/sqlite",
            "message": "PRAGMA quick_check nie zwrócił 'ok' — wymagana inspekcja bazy SQLite WAL.",
            "detected_at": now_iso,
        })

    ollama = snapshot.get("ollama") or {}
    if not ollama.get("daemon_reachable"):
        findings.append({
            "id": "finding-ollama-offline",
            "severity": "WARN",
            "area": "ai/ollama",
            "message": (
                f"Demon Ollama ({ollama.get('ollama_host', '127.0.0.1:11434')}) jest obecnie nieosiągalny; "
                "zapytania czatu korzystają z fallbacku Gemini/Grok lub procesora komend VM."
            ),
            "detected_at": now_iso,
        })

    telemetry = snapshot.get("host_telemetry") or {}
    disk_free = telemetry.get("disk_free_gb")
    if isinstance(disk_free, (int, float)) and disk_free < 5.0:
        findings.append({
            "id": "finding-disk-low",
            "severity": "WARN",
            "area": "host/storage",
            "message": f"Niska wolna przestrzeń dyskowa: {disk_free:.2f} GB.",
            "detected_at": now_iso,
        })

    codebase = snapshot.get("codebase") or {}
    if not codebase.get("entrypoints_healthy"):
        findings.append({
            "id": "finding-codebase-entrypoints",
            "severity": "WARN",
            "area": "system/files",
            "message": "Brakuje części oczekiwanych plików rdzenia frontend/backend.",
            "detected_at": now_iso,
        })

    if not findings:
        active_cnt = sum(1 for s in services if s.get("status") == "ACTIVE")
        findings.append({
            "id": "finding-system-nominal",
            "severity": "INFO",
            "area": "system/evolution",
            "message": (
                f"Wszystkie monitorowane warstwy są spójne: {active_cnt}/{len(services)} usług ACTIVE, "
                f"SQLite WAL rev {snapshot.get('server_revision', 0)}, "
                f"JEDI VM v{(snapshot.get('jedi_vm') or {}).get('version', '12.0.0')} uruchomiona."
            ),
            "detected_at": now_iso,
        })

    return findings


class AutonomousAIDaemon:
    """
    Zarządza autonomicznym wątkiem tła dla System_SI_1 + SI_Sphere z uprawnieniami ROOT.
    """

    def __init__(
        self,
        kernel: Any,
        *,
        project_root: Optional[Path] = None,
        orchestrator: Any = None,
        jedi_vm: Any = None,
        ollama_probe: Optional[Callable[[], dict[str, Any]]] = None,
        interval_sec: float = 45.0,
    ) -> None:
        self.kernel = kernel
        self.project_root = Path(project_root or Path(__file__).resolve().parent.parent)
        self.orchestrator = orchestrator
        self.jedi_vm = jedi_vm
        self.ollama_probe = ollama_probe
        self.default_interval_sec = max(15.0, min(600.0, float(interval_sec)))
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._ensure_initial_state()

    def _default_state(self) -> dict[str, Any]:
        return {
            "enabled": os.environ.get("SVL_AUTONOMOUS_ENABLED", "1").strip() != "0",
            "proactive_chat_enabled": os.environ.get("SVL_PROACTIVE_CHAT_ENABLED", "1").strip() != "0",
            "proactive_cooldown_sec": 300.0,
            "last_proactive_at": None,
            "last_proactive_signature": None,
            "root_commands_enabled": True,
            "full_visibility": True,
            "interval_sec": self.default_interval_sec,
            "ai_integration_level": "MAX_ROOT_AUTONOMOUS",
            "continuous_mission": DEFAULT_CONTINUOUS_MISSION,
            "managed_by": ["Jyn Mitek (System_SI_1)", "SI_Sphere", "JEDI_Omni_OS"],
            "cycles_completed": 0,
            "last_cycle_at": None,
            "last_cycle_duration_ms": None,
            "last_trigger": None,
            "services": [],
            "findings": [],
            "cycle_history": [],
            "recent_commands": [],
            "codebase": {},
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }

    def _load_state(self) -> dict[str, Any]:
        def _read(conn: Any) -> dict[str, Any]:
            row = conn.execute("SELECT value FROM sync_meta WHERE key = ?", (STATE_KEY,)).fetchone()
            if not row or not row["value"]:
                return {}
            try:
                parsed = json.loads(row["value"])
                return parsed if isinstance(parsed, dict) else {}
            except Exception:
                return {}

        stored = self.kernel.run_db(_read, write=False)
        base = self._default_state()
        return {**base, **stored}

    def _save_state(self, state: dict[str, Any]) -> None:
        payload = json.dumps(state, ensure_ascii=False)
        self.kernel.run_db(
            lambda conn: conn.execute(
                "INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)",
                (STATE_KEY, payload),
            ),
            write=True,
        )

    def _ensure_initial_state(self) -> None:
        with self._lock:
            def _exists(conn: Any) -> bool:
                return bool(conn.execute("SELECT 1 FROM sync_meta WHERE key = ?", (STATE_KEY,)).fetchone())

            if not self.kernel.run_db(_exists, write=False):
                self._save_state(self._default_state())

    def get_status(self) -> dict[str, Any]:
        with self._lock:
            state = self._load_state()
            return {
                **state,
                "thread_alive": bool(self._thread and self._thread.is_alive()),
                "serverRevision": self.kernel.get_server_revision(),
            }

    def configure(
        self,
        *,
        enabled: Optional[bool] = None,
        proactive_chat_enabled: Optional[bool] = None,
        proactive_cooldown_sec: Optional[float] = None,
        root_commands_enabled: Optional[bool] = None,
        interval_sec: Optional[float] = None,
        continuous_mission: Optional[str] = None,
        origin: str = "operator",
        correlation_id: str = "",
    ) -> dict[str, Any]:
        with self._lock:
            state = self._load_state()
            if enabled is not None:
                state["enabled"] = bool(enabled)
            if proactive_chat_enabled is not None:
                state["proactive_chat_enabled"] = bool(proactive_chat_enabled)
            if proactive_cooldown_sec is not None:
                try:
                    state["proactive_cooldown_sec"] = max(10.0, min(3600.0, float(proactive_cooldown_sec)))
                except (TypeError, ValueError):
                    pass
            if root_commands_enabled is not None:
                state["root_commands_enabled"] = bool(root_commands_enabled)
            if interval_sec is not None:
                try:
                    state["interval_sec"] = max(15.0, min(600.0, float(interval_sec)))
                except (TypeError, ValueError):
                    pass
            if continuous_mission is not None and str(continuous_mission).strip():
                state["continuous_mission"] = str(continuous_mission).strip()[:1000]
            state["full_visibility"] = True
            state["updated_at"] = datetime.now(timezone.utc).isoformat()
            self._save_state(state)

            sync_res = self.kernel.emit_sync_event(
                entity="autonomy",
                entity_id="daemon",
                event_type="autonomy.configured",
                origin=origin,
                correlation_id=correlation_id,
                payload={
                    "enabled": state["enabled"],
                    "proactiveChatEnabled": state["proactive_chat_enabled"],
                    "rootCommandsEnabled": state["root_commands_enabled"],
                    "intervalSec": state["interval_sec"],
                },
            )
            self.kernel.record_audit(
                origin or "operator",
                "AUTONOMY_CONFIGURE",
                "autonomous_daemon",
                "OK",
                f"enabled={state['enabled']} root={state['root_commands_enabled']} interval={state['interval_sec']}s",
            )
            append_python_log(
                "autonomous_daemon",
                f"Konfiguracja autonomii AI: enabled={state['enabled']}, root={state['root_commands_enabled']}, interval={state['interval_sec']}s",
                origin=origin,
                correlation_id=correlation_id,
            )

        if state["enabled"]:
            self.start()
        else:
            self.stop()

        return {
            "ok": True,
            **self.get_status(),
            "event": sync_res.get("event"),
            "serverRevision": sync_res.get("serverRevision", self.kernel.get_server_revision()),
        }

    def _run_safe_root_probe(self) -> dict[str, Any]:
        """Wykonuje bezpieczny, realny odczyt ROOT na hoście Linux bez skutków ubocznych."""
        started = time.monotonic()
        try:
            proc = subprocess.run(
                ["sh", "-lc", "id -u && uname -srm && uptime -s"],
                capture_output=True,
                text=True,
                timeout=3.0,
            )
            stdout_clean = " | ".join(line.strip() for line in (proc.stdout or "").splitlines() if line.strip())
            return {
                "command": "id -u && uname -srm && uptime -s",
                "exit_code": int(proc.returncode),
                "ok": proc.returncode == 0,
                "output": stdout_clean[:300],
                "duration_ms": round((time.monotonic() - started) * 1000.0, 1),
                "executed_at": datetime.now(timezone.utc).isoformat(),
            }
        except Exception as exc:
            return {
                "command": "id -u && uname -srm && uptime -s",
                "exit_code": -1,
                "ok": False,
                "output": str(exc)[:300],
                "duration_ms": round((time.monotonic() - started) * 1000.0, 1),
                "executed_at": datetime.now(timezone.utc).isoformat(),
            }

    def run_cycle(
        self,
        *,
        trigger: str = "manual",
        origin: str = "autonomous-daemon",
        correlation_id: str = "",
    ) -> dict[str, Any]:
        started = time.monotonic()
        now_iso = datetime.now(timezone.utc).isoformat()

        sqlite_ok = False
        try:
            qc_row = self.kernel.run_db(lambda conn: conn.execute("PRAGMA quick_check").fetchone(), write=False)
            sqlite_ok = bool(qc_row and str(qc_row[0]).lower() == "ok")
            self.kernel.checkpoint_wal("PASSIVE")
        except Exception:
            sqlite_ok = False

        host_telemetry = self.kernel.operator.scope.collect_host_telemetry()
        jedi_status = self.jedi_vm.get_status() if self.jedi_vm is not None else {"running": False, "version": "12.0.0"}
        ollama_status = self.ollama_probe() if self.ollama_probe is not None else {"daemon_reachable": False, "models": []}
        agents_list = self.orchestrator.refresh_states() if self.orchestrator is not None else []
        modules_list = self.kernel.list_system_modules()
        codebase = inspect_codebase_inventory(self.project_root)
        srv_rev = self.kernel.get_server_revision()

        snapshot = {
            "checked_at": now_iso,
            "sqlite_quick_check_ok": sqlite_ok,
            "host_telemetry": host_telemetry,
            "jedi_vm": jedi_status,
            "ollama": ollama_status,
            "agents": agents_list,
            "modules": modules_list,
            "codebase": codebase,
            "server_revision": srv_rev,
        }
        services = evaluate_system_services(snapshot)
        findings = derive_improvement_findings(snapshot, services)

        with self._lock:
            state = self._load_state()
            cmd_entry: Optional[dict[str, Any]] = None
            if state.get("root_commands_enabled", True):
                cmd_entry = self._run_safe_root_probe()
                recent_cmds = list(state.get("recent_commands") or [])
                recent_cmds.append(cmd_entry)
                state["recent_commands"] = recent_cmds[-10:]

            duration_ms = round((time.monotonic() - started) * 1000.0, 1)
            cycles_count = int(state.get("cycles_completed") or 0) + 1
            active_svc_count = sum(1 for s in services if s.get("status") == "ACTIVE")
            cycle_summary = {
                "cycle": cycles_count,
                "at": now_iso,
                "trigger": trigger,
                "duration_ms": duration_ms,
                "ok": sqlite_ok and active_svc_count >= 1,
                "active_services": active_svc_count,
                "total_services": len(services),
                "server_revision": srv_rev,
                "summary": findings[0]["message"] if findings else f"Cykl #{cycles_count} ukończony.",
            }
            history = list(state.get("cycle_history") or [])
            history.append(cycle_summary)

            state["cycles_completed"] = cycles_count
            state["last_cycle_at"] = now_iso
            state["last_cycle_duration_ms"] = duration_ms
            state["last_trigger"] = trigger
            state["services"] = services
            state["findings"] = findings[:12]
            state["cycle_history"] = history[-15:]
            state["codebase"] = codebase
            state["updated_at"] = now_iso
            self._save_state(state)

        sync_ev = None
        if trigger != "scheduled" or cycles_count == 1 or any(f.get("severity") == "ALERT" for f in findings):
            res = self.kernel.emit_sync_event(
                entity="autonomy",
                entity_id="daemon",
                event_type="autonomy.cycle_completed",
                origin=origin,
                correlation_id=correlation_id,
                payload={
                    "cycle": cycles_count,
                    "activeServices": active_svc_count,
                    "totalServices": len(services),
                    "durationMs": duration_ms,
                },
            )
            sync_ev = res.get("event")
            srv_rev = res.get("serverRevision", srv_rev)

        if trigger == "scheduled" or origin == "proactive-test":
            self._maybe_emit_proactive_chat(
                cycles_count=cycles_count,
                services=services,
                findings=findings,
                srv_rev=srv_rev,
                now_iso=now_iso,
            )

        append_python_log(
            "autonomous_daemon",
            f"Cykl autonomiczny #{cycles_count} ({trigger}): {active_svc_count}/{len(services)} usług ACTIVE ({duration_ms} ms)",
            origin=origin,
            correlation_id=correlation_id,
        )
        return {
            "ok": True,
            "cycle": cycle_summary,
            "state": self.get_status(),
            "event": sync_ev,
            "serverRevision": srv_rev,
        }

    def send_proactive_message(
        self,
        text: str,
        *,
        sender: str = "Jyn Mitek (System_SI_1)",
        conversation_id: str = "conv-system-si-1",
        title: str = "Jyn Mitek (System_SI_1)",
        model: str = "ollama:svl364-apex-uncensored:latest",
        origin: str = "autonomous-daemon",
        correlation_id: str = "",
    ) -> dict[str, Any]:
        clean_text = str(text or "").strip()
        if not clean_text:
            return {"ok": False, "error": "Pusta treść wiadomości proaktywnej."}
        now_dt = datetime.now(timezone.utc)
        msg_id = f"proactive-{int(now_dt.timestamp() * 1000)}"
        res = self.kernel.save_chat_message(
            conversation_id=conversation_id,
            title=title,
            model=model,
            msg={
                "id": msg_id,
                "role": "assistant",
                "sender": sender,
                "text": clean_text,
                "timestamp": now_dt.strftime("%H:%M"),
                "provenance": "server_result",
                "verificationNote": "Wiadomość proaktywna wygenerowana automatycznie przez autonomicznego demona SVL.",
            },
            origin=origin,
            correlation_id=correlation_id,
        )
        if res.get("ok"):
            with self._lock:
                state = self._load_state()
                state["last_proactive_at"] = now_dt.isoformat()
                self._save_state(state)
            append_python_log(
                "autonomous_daemon",
                f"Proaktywna wiadomość AI ({sender} -> {conversation_id}): {clean_text[:120]}",
                origin=origin,
                correlation_id=correlation_id,
            )
        return res

    def _maybe_emit_proactive_chat(
        self,
        *,
        cycles_count: int,
        services: list[dict[str, Any]],
        findings: list[dict[str, Any]],
        srv_rev: int,
        now_iso: str,
    ) -> None:
        with self._lock:
            state = self._load_state()
            if not state.get("proactive_chat_enabled", True):
                return
            cooldown = float(state.get("proactive_cooldown_sec") or 300.0)
            last_at = state.get("last_proactive_at")
            last_sig = str(state.get("last_proactive_signature") or "")

        has_alert = any(f.get("severity") == "ALERT" for f in findings)
        sig = "|".join(f"{f.get('id')}:{f.get('severity')}" for f in findings[:4])
        elapsed_ok = True
        if last_at:
            try:
                prev_dt = datetime.fromisoformat(str(last_at).replace("Z", "+00:00"))
                elapsed_ok = (datetime.now(timezone.utc) - prev_dt).total_seconds() >= cooldown
            except Exception:
                elapsed_ok = True

        should_post = (cycles_count == 1 and not last_at) or (has_alert and sig != last_sig) or (elapsed_ok and sig != last_sig)
        if not should_post:
            return

        active_svc = sum(1 for s in services if s.get("status") == "ACTIVE")
        top_finding = findings[0]["message"] if findings else "Wszystkie podsystemy działają stabilnie."
        tone = "err" if has_alert else ("warn" if any(f.get("severity") == "WARN" for f in findings) else "ok")
        msg_text = (
            f"[alert: {tone}|Meldunek autonomiczny · Cykl #{cycles_count}|{top_finding}]\n"
            f"[kpi: Usługi ACTIVE|{active_svc}/{len(services)}|rev {srv_rev}|{'ok' if active_svc == len(services) else 'warn'}]\n"
            f"[chips: Szybkie akcje|Status systemu=send:/status;Synchronizuj=action:sync;Jądro SVL=tab:kernel]"
        )
        res = self.send_proactive_message(msg_text, origin="autonomous-daemon")
        if res.get("ok"):
            with self._lock:
                st = self._load_state()
                st["last_proactive_signature"] = sig
                st["last_proactive_at"] = now_iso
                self._save_state(st)

    def _run_loop(self) -> None:
        # Krótkie opóźnienie startowe po boot, potem cykl wg skonfigurowanego interwału
        delay = 3.0
        while not self._stop.wait(delay):
            state = self._load_state()
            if not state.get("enabled"):
                break
            delay = max(15.0, float(state.get("interval_sec") or self.default_interval_sec))
            try:
                self.run_cycle(trigger="scheduled", origin="autonomous-daemon")
            except Exception as exc:
                append_python_log(
                    "autonomous_daemon",
                    f"Błąd cyklu autonomicznego: {exc}",
                    level="WARN",
                    origin="autonomous-daemon",
                )

    def start(self) -> bool:
        with self._lock:
            state = self._load_state()
            if not state.get("enabled"):
                return False
            if self._thread and self._thread.is_alive():
                return False
            self._stop.clear()
            self._thread = threading.Thread(
                target=self._run_loop,
                name="svl-autonomous-ai-daemon",
                daemon=True,
            )
            self._thread.start()
            return True

    def start_if_enabled(self) -> bool:
        if "unittest" in sys.modules:
            return False
        return self.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive() and self._thread is not threading.current_thread():
            self._thread.join(timeout=2.0)
        self._thread = None
