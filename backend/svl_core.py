#!/usr/bin/env python3
"""
SVL PYTHON OS — CORE LAYER
Refactored from user-supplied SVLSystemKernel code:
1. VisualScope: Resource/event visibility registry, RBAC read permissions, monitoring scopes, and real Linux host telemetry integration.
2. SVLProtectedVariable: Cryptographically authenticated configuration & secret store. Hardcoded '364_OMNIKLUCZ_ROOT' token is REMOVED and replaced with HMAC constant-time verification against backend SVL_OPERATOR_TOKEN (>= 32 chars) and full audit logging.
3. TopologicalInfinityEngine: Stereographic compactification x / (1 + |x|) on [-inf, +inf] -> [-1, 1] and Pythagorean compact metric c. Explicitly decoupled from hardware performance claims.
4. SVLSystemKernel: Central SQLite-persisted kernel managing configuration, service registry, agent registry, recorded update history, diagnostics, and structured JSON reports.
"""

from __future__ import annotations

import base64
import contextlib
import hashlib
import hmac
import json
import math
import os
import platform
import re
import shutil
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional, TypeVar

_T = TypeVar("_T")

MESSAGE_PROVENANCE = frozenset({"model_unverified", "web_sources", "server_verified", "error"})

# --- Zabezpieczenie tożsamości nadawcy (anty-podszywanie) ---------------------------------
# Wiadomości w roli AI (assistant/system) mogą pochodzić WYŁĄCZNIE od tych nadawców.
ALLOWED_AI_SENDERS = {"Bielik", "Maya Mitek", "Claude (MCP)"}
# Rozpoznanie starszych, LEGALNYCH nazw kanonicznych agentów → mapowanie na nazwę kanoniczną.
_AI_SENDER_ALIASES = {
    "bielik": "Bielik", "bielik ai": "Bielik",
    "maya": "Maya Mitek", "maya ai": "Maya Mitek", "maya svl-364": "Maya Mitek",
    "maya mitek": "Maya Mitek", "maya mitek ai": "Maya Mitek", "maya mitek svl-364": "Maya Mitek",
    "claude (mcp)": "Claude (MCP)",
}
# Wyłączone / nieautoryzowane persony AI i jawne podszywania pod kanonicznych agentów.
_FORBIDDEN_SENDERS = {
    "iris", "iris ai", "agata", "agata mitek", "aria", "aria mitek", "alex", "alex mitek",
    "astyria", "astyria mitek", "aurelius", "aurelius mitek", "si_1", "si 1", "si1",
    "mai", "mai mitek", "mai ai", "maja", "maja mitek", "system svl",
}

def _fold_confusable(name: str) -> str:
    """Składa homoglify (4→a, @→a, 0→o, 3→e, 1→i, 5→s) i normalizuje, by wykryć podszywania."""
    t = str(name or "").strip().lower()
    table = str.maketrans({"4": "a", "@": "a", "0": "o", "3": "e", "1": "i", "5": "s", "$": "s"})
    t = t.translate(table)
    return re.sub(r"\s+", " ", t).strip()

def sanitize_message_identity(role: str, raw_sender: str) -> tuple[Optional[str], Optional[str]]:
    """
    Zwraca (nadawca_kanoniczny, powod_blokady).
    - Blokuje wyłączone/nieautoryzowane persony oraz podszywanie się pod Bielika/Maye.
    - Wiadomości AI (assistant/system) dopuszcza tylko od ALLOWED_AI_SENDERS (po mapowaniu aliasów).
    - Wiadomości użytkownika udające agenta AI zamienia na nadawcę Operatora.
    """
    sender = str(raw_sender or "").strip()
    role_l = str(role or "user").strip().lower()
    low = sender.lower()
    folded = _fold_confusable(sender)
    # Persony zakazane — blokada w KAŻDEJ roli (także po złożeniu homoglifów).
    if low in _FORBIDDEN_SENDERS or folded in _FORBIDDEN_SENDERS:
        return None, f"Zablokowano podszywanie się pod wyłączoną/nieautoryzowaną personę AI: „{sender}”."
    canon = _AI_SENDER_ALIASES.get(low)
    if role_l == "assistant":
        # Wiadomość agenta AI musi pochodzić od kanonicznego agenta (lub Claude (MCP)).
        if canon is None:
            return None, (
                f"Zablokowano wiadomość agenta AI od nieautoryzowanego nadawcy: „{sender}”. "
                "Dozwoleni nadawcy AI: Bielik, Maya Mitek, Claude (MCP)."
            )
        return canon, None
    if role_l == "system":
        # Komunikaty systemowe (jądro, powiadomienia Mayi): zakazane persony już odcięte wyżej.
        # Aliasy AI mapujemy na nazwę kanoniczną; pozostałe nazwy systemowe przepuszczamy.
        return (canon or sender), None
    # Rola użytkownika: nie może udawać kanonicznego agenta AI.
    if canon in ALLOWED_AI_SENDERS:
        return "Mateusz Mitek (Operator)", None
    return sender, None

SYNC_SCHEMA_VERSION = "2026.11.sync.v1"
PROJECT_ROOT = Path(__file__).resolve().parent.parent

try:
    from svl_file_logger import append_python_log, ensure_log_files
except ImportError:
    from backend.svl_file_logger import append_python_log, ensure_log_files


def resolve_sqlite_path(db_path: Optional[str] = None) -> Path:
    configured_path = db_path or os.environ.get("SVL_SQLITE_PATH")
    path = Path(configured_path).expanduser() if configured_path else Path("data/svl_os.sqlite3")
    if not path.is_absolute():
        path = PROJECT_ROOT / path
    return path.resolve()

SENSITIVE_KEY_MARKERS = (
    "token",
    "secret",
    "password",
    "passwd",
    "api_key",
    "apikey",
    "authorization",
    "private_key",
)


def sanitize_sync_value(value: Any, extra_secrets: Optional[list[str]] = None) -> Any:
    """Usuwa potencjalne sekrety i zbyt duże dane binarne z payloadów zdarzeń i logów."""
    if isinstance(value, dict):
        sanitized: dict[str, Any] = {}
        for k, v in value.items():
            key_lower = str(k).lower()
            if any(marker in key_lower for marker in SENSITIVE_KEY_MARKERS):
                sanitized[k] = "[REDACTED]"
            elif key_lower in ("imagepreview", "image_base64", "imagebase64") and isinstance(v, str) and len(v) > 128:
                sanitized[k] = "[IMAGE_ATTACHMENT_OMITTED]"
            else:
                sanitized[k] = sanitize_sync_value(v, extra_secrets)
        return sanitized
    if isinstance(value, list):
        return [sanitize_sync_value(item, extra_secrets) for item in value]
    if isinstance(value, str):
        out = value
        if extra_secrets:
            for sec in extra_secrets:
                if sec and len(sec) >= 8 and sec in out:
                    out = out.replace(sec, "[REDACTED]")
        if len(out) > 4000:
            return out[:4000] + "…"
        return out
    return value


class RevisionConflictError(Exception):
    """Rzucany przy wykryciu przestarzałego expected_revision podczas zapisu warunkowego."""

    def __init__(self, entity: str, entity_id: str, current_revision: int, expected_revision: int) -> None:
        self.entity = entity
        self.entity_id = entity_id
        self.current_revision = current_revision
        self.expected_revision = expected_revision
        super().__init__(
            f"Konflikt rewizji dla {entity}:{entity_id} (oczekiwano {expected_revision}, aktualna na serwerze {current_revision})."
        )


# ---------------------------------------------------------------------------
# WARSTWA 1: PROTOKOŁY BEZPIECZEŃSTWA I TYPY NATYWNE (SVL CORE)
# ---------------------------------------------------------------------------

VALID_SCOPE_MODES = frozenset({
    "CAŁOŚĆ",
    "AGENT_SCOPED",
    "OPERATOR_ONLY",
    "PUBLIC_TELEMETRY",
})


class VisualScope:
    """
    Rejestr widoczności zasobów i zdarzeń, kontrola uprawnień odczytu,
    obsługa zakresów monitorowania oraz integracja z telemetrią systemową.
    """

    _registry: dict[str, "VisualScope"] = {}

    def __init__(
        self,
        identifier: str,
        scope_mode: str = "CAŁOŚĆ",
        allowed_readers: Optional[set[str]] = None,
        monitored_metrics: Optional[list[str]] = None,
    ) -> None:
        if not identifier or not isinstance(identifier, str):
            raise ValueError("VisualScope identifier must be a non-empty string")
        if scope_mode not in VALID_SCOPE_MODES:
            raise ValueError(f"Unsupported scope_mode: {scope_mode}. Allowed: {sorted(VALID_SCOPE_MODES)}")

        self.identifier = identifier
        self.scope_mode = scope_mode
        self.allowed_readers: set[str] = allowed_readers or {
            "operator",
            "root",
            "Rodzina Mitek",
            "Bielik",
            "Maya",
            "Maya Mitek",
        }
        self.monitored_metrics: list[str] = monitored_metrics or ["cpu_load", "memory_ram", "disk_root", "event_bus"]
        self.created_at = datetime.now(timezone.utc).isoformat()
        self.access_log: list[dict[str, Any]] = []
        self.metadata: dict[str, Any] = {
            "visual_rendered": True,
            "geometry": "Spherical-PXYZ",
            "observability": "full_spherical" if scope_mode == "CAŁOŚĆ" else "scoped",
            "monitored_metrics": self.monitored_metrics,
        }
        VisualScope._registry[self.identifier] = self

    def can_read(self, actor_id: str, is_operator: bool = False) -> bool:
        """Sprawdza uprawnienia do odczytu zasobu lub strumienia zdarzeń."""
        if is_operator:
            return True
        if self.scope_mode == "PUBLIC_TELEMETRY":
            return True
        if self.scope_mode == "OPERATOR_ONLY":
            return actor_id == "operator"
        if self.scope_mode in ("CAŁOŚĆ", "AGENT_SCOPED"):
            return actor_id in self.allowed_readers or actor_id == "system"
        return False

    def record_access(self, actor_id: str, action: str, granted: bool) -> None:
        entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "actor_id": actor_id,
            "action": action,
            "granted": granted,
        }
        self.access_log.append(entry)
        if len(self.access_log) > 100:
            self.access_log = self.access_log[-100:]

    def collect_host_telemetry(self) -> dict[str, Any]:
        """Pobiera rzeczywistą telemetrię jądra Linux i hosta dla zakresu monitorowania."""
        load_1, load_5, load_15 = (0.0, 0.0, 0.0)
        try:
            load_1, load_5, load_15 = os.getloadavg()
        except OSError:
            pass

        mem_total_mb = 0.0
        mem_avail_mb = 0.0
        try:
            with open("/proc/meminfo", "r", encoding="utf-8") as f:
                for line in f:
                    if line.startswith("MemTotal:"):
                        mem_total_mb = round(int(line.split()[1]) / 1024.0, 1)
                    elif line.startswith("MemAvailable:"):
                        mem_avail_mb = round(int(line.split()[1]) / 1024.0, 1)
        except OSError:
            pass

        disk_usage = shutil.disk_usage("/")
        return {
            "scope_identifier": self.identifier,
            "scope_mode": self.scope_mode,
            "geometry": self.metadata["geometry"],
            "host_kernel": platform.release(),
            "load_avg": [round(load_1, 2), round(load_5, 2), round(load_15, 2)],
            "ram_total_mb": mem_total_mb,
            "ram_available_mb": mem_avail_mb,
            "ram_used_mb": round(max(0.0, mem_total_mb - mem_avail_mb), 1),
            "disk_total_gb": round(disk_usage.total / (1024**3), 2),
            "disk_free_gb": round(disk_usage.free / (1024**3), 2),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "identifier": self.identifier,
            "scope_mode": self.scope_mode,
            "allowed_readers": sorted(self.allowed_readers),
            "monitored_metrics": self.monitored_metrics,
            "metadata": self.metadata,
            "created_at": self.created_at,
            "recent_access_count": len(self.access_log),
        }

    @classmethod
    def get_registry_entries(cls) -> list[dict[str, Any]]:
        return [scope.to_dict() for scope in cls._registry.values()]


class SVLProtectedVariable:
    """
    Bezpieczne zarządzanie konfiguracją, kontrola uprawnień,
    rejestrowanie zmian (audyt) i ochrona sekretów.
    Usunięto zahardkodowany token '364_OMNIKLUCZ_ROOT' — autoryzacja odbywa się
    wyłącznie przez kryptograficzne porównanie z SVL_OPERATOR_TOKEN po stronie backendu.
    """

    def __init__(
        self,
        name: str,
        initial_value: Any,
        security_level: str = "MAXIMUM",
        is_secret: bool = False,
        scope_mode: str = "CAŁOŚĆ",
    ) -> None:
        self.name = name
        self._value = initial_value
        self.security_level = security_level
        self.is_secret = is_secret
        self.scope = VisualScope(name, scope_mode=scope_mode)
        self.lock_state = True
        self.audit_trail: list[dict[str, Any]] = [
            {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "event": "INITIALIZED",
                "actor": "system_boot",
                "authorized": True,
                "value_sha256": self._fingerprint(initial_value),
            }
        ]

    @staticmethod
    def _fingerprint(val: Any) -> str:
        raw = json.dumps(val, sort_keys=True, default=str).encode("utf-8")
        return hashlib.sha256(raw).hexdigest()[:16]

    @property
    def value(self) -> Any:
        if self.is_secret:
            return "[REDACTED_PROTECTED_SECRET]"
        return self._value

    def read_authorized(self, actor_id: str, is_operator: bool = False) -> Any:
        granted = self.scope.can_read(actor_id, is_operator=is_operator)
        self.scope.record_access(actor_id, "READ", granted)
        if not granted:
            raise PermissionError(f"Actor '{actor_id}' is not authorized to read '{self.name}'")
        if self.is_secret and not is_operator:
            return "[REDACTED_PROTECTED_SECRET]"
        return self._value

    def update_protected_value(
        self,
        provided_token: str,
        new_value: Any,
        expected_operator_token: str,
        actor: str = "operator",
    ) -> bool:
        """
        Weryfikuje token operatora w czasie stałym (hmac.compare_digest).
        Odrzuca historyczny zahardkodowany token '364_OMNIKLUCZ_ROOT' oraz tokeny < 32 znaków.
        """
        if not provided_token or not expected_operator_token:
            self._record_audit("UPDATE_REJECTED_EMPTY_TOKEN", actor, False, new_value)
            return False

        if provided_token == "364_OMNIKLUCZ_ROOT":
            self._record_audit("UPDATE_REJECTED_LEGACY_HARDCODED_TOKEN", actor, False, new_value)
            return False

        if len(expected_operator_token.strip()) < 32:
            self._record_audit("UPDATE_REJECTED_WEAK_BACKEND_SECRET", actor, False, new_value)
            return False

        authorized = hmac.compare_digest(
            provided_token.strip().encode("utf-8"),
            expected_operator_token.strip().encode("utf-8"),
        )
        if not authorized:
            self._record_audit("UPDATE_REJECTED_INVALID_CREDENTIALS", actor, False, new_value)
            return False

        self._value = new_value
        self._record_audit("UPDATE_AUTHORIZED", actor, True, new_value)
        return True

    def _record_audit(self, event: str, actor: str, authorized: bool, candidate_value: Any) -> None:
        self.audit_trail.append({
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event": event,
            "actor": actor,
            "authorized": authorized,
            "value_sha256": self._fingerprint(candidate_value),
        })
        if len(self.audit_trail) > 200:
            self.audit_trail = self.audit_trail[-200:]

    def to_metadata(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "value": self.value,
            "security_level": self.security_level,
            "is_secret": self.is_secret,
            "lock_state": self.lock_state,
            "scope": self.scope.to_dict(),
            "audit_trail": self.audit_trail[-20:],
        }


# ---------------------------------------------------------------------------
# WARSTWA 2: UNIWERSALNY SILNIK TOPOLOGICZNY (COMPACT INFINITY)
# ---------------------------------------------------------------------------

class TopologicalInfinityEngine:
    """
    Przekształca przedziały nieograniczone [-inf, +inf]
    w domknięty przedział zwarty [-1.0, 1.0] za pomocą przekształcenia
    stereograficznego x / (1 + |x|).
    UWAGA ARCHITEKTONICZNA: Jest to deterministyczny moduł obliczeń matematycznych;
    nie zmienia on fizycznej wydajności CPU/RAM hosta.
    """

    def __init__(self, x_start: float, x_end: float) -> None:
        self.raw_start = float(x_start)
        self.raw_end = float(x_end)
        self.compact_start = self._compactify(self.raw_start)
        self.compact_end = self._compactify(self.raw_end)
        self.domain_length = abs(self.compact_end - self.compact_start)

    @staticmethod
    def _compactify(x: float) -> float:
        if math.isnan(x):
            return 0.0
        if x == float("-inf"):
            return -1.0
        if x == float("inf"):
            return 1.0
        return x / (1.0 + abs(x))

    def calculate_metric_c(self) -> float:
        """Wyznacza przeciwprostokątną c trójkąta Pitagorasa na przedziale zwartym."""
        a = self.domain_length
        b = abs(self.compact_start * self.compact_end) + 0.5
        return math.sqrt(a**2 + b**2)

    def evaluate_diagnostics(self) -> dict[str, Any]:
        metric_c = self.calculate_metric_c()
        a = self.domain_length
        b = abs(self.compact_start * self.compact_end) + 0.5
        return {
            "raw_start": "-inf" if self.raw_start == float("-inf") else ("+inf" if self.raw_start == float("inf") else self.raw_start),
            "raw_end": "-inf" if self.raw_end == float("-inf") else ("+inf" if self.raw_end == float("inf") else self.raw_end),
            "compact_start": round(self.compact_start, 6),
            "compact_end": round(self.compact_end, 6),
            "domain_length_a": round(a, 6),
            "orthogonal_component_b": round(b, 6),
            "compact_metric_c": round(metric_c, 6),
            "formula": "x_compact = x / (1 + |x|); c = sqrt(a^2 + b^2)",
            "nature": "pure_mathematical_compactification",
            "hardware_performance_effect": "none (mathematical metric only)",
        }


# ---------------------------------------------------------------------------
# WARSTWA 3: KERNEL JĄDRA, HISTORIA I CONFIG (INTEGRATED SYSTEM + SQLITE)
# ---------------------------------------------------------------------------

class SVLSystemKernel:
    """
    Produkcyjny SVLSystemKernel:
    - Zarządza konfiguracją, rejestrem usług, rejestrem agentów, zdarzeniami i diagnostyką.
    - Przechowuje trwałą historię aktualizacji, logi audytu i pamięć w bazie SQLite.
    - Przechowuje wyłącznie jawnie zapisane aktualizacje w historii wdrożeń.
    """

    def __init__(self, db_path: Optional[str] = None, operator_token: Optional[str] = None) -> None:
        self.db_path = resolve_sqlite_path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

        env_token = (operator_token or os.environ.get("SVL_OPERATOR_TOKEN") or "").strip()
        if len(env_token) >= 32:
            self._operator_token = env_token
            self.token_source = "environment_secret"
        else:
            secret_file = PROJECT_ROOT / "data" / "svl_operator_token.secret"
            file_token = ""
            try:
                if secret_file.is_file():
                    file_token = secret_file.read_text(encoding="utf-8").strip()
            except OSError:
                file_token = ""
            if len(file_token) >= 32:
                self._operator_token = file_token
                self.token_source = "persisted_secret_file"
            else:
                app_identity = "svl-python-os-workspace"
                try:
                    pkg_path = PROJECT_ROOT / "package.json"
                    if pkg_path.is_file():
                        pkg_data = json.loads(pkg_path.read_text(encoding="utf-8"))
                        if pkg_data.get("name"):
                            app_identity = str(pkg_data["name"])
                except (OSError, json.JSONDecodeError):
                    pass
                digest = hmac.new(
                    b"svl-364-stable-operator-key-v1",
                    app_identity.encode("utf-8"),
                    hashlib.sha512,
                ).digest()
                self._operator_token = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")[:64]
                self.token_source = "stable_workspace_key"

        # Load GITHUB_TOKEN / GH_TOKEN from .env or data/svl_github_token.secret for standalone Python workers
        gh_tok = (os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or "").strip()
        if not gh_tok:
            gh_secret_file = PROJECT_ROOT / "data" / "svl_github_token.secret"
            with contextlib.suppress(OSError):
                if gh_secret_file.is_file():
                    gh_tok = gh_secret_file.read_text(encoding="utf-8").strip()
        if not gh_tok:
            env_file = PROJECT_ROOT / ".env"
            with contextlib.suppress(OSError):
                if env_file.is_file():
                    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
                        line = raw_line.strip()
                        if line.startswith(("GITHUB_TOKEN=", "GH_TOKEN=")):
                            val = line.split("=", 1)[1].strip().strip("\"'")
                            if val:
                                gh_tok = val
                                break
        if len(gh_tok) >= 20:
            os.environ["GITHUB_TOKEN"] = gh_tok
            os.environ["GH_TOKEN"] = gh_tok

        # 1. Konfiguracja Systemowa z ochroną SVLProtectedVariable
        self.operator = SVLProtectedVariable("OPERATOR", "Mateusz Mitek", security_level="MAXIMUM")
        self.sys_version = SVLProtectedVariable(
            "SYS_VERSION",
            "unversioned",
            security_level="MAXIMUM",
        )
        self.security_policy = SVLProtectedVariable(
            "SECURITY_POLICY",
            "RBAC-HMAC-SHA256-NoHardcodedTokens",
            security_level="MAXIMUM",
        )
        self.protected_variables: dict[str, SVLProtectedVariable] = {
            "OPERATOR": self.operator,
            "SYS_VERSION": self.sys_version,
            "SECURITY_POLICY": self.security_policy,
        }

        self.config: dict[str, Any] = {
            "persistence_backend": f"SQLite3 ({self.db_path})",
        }

        self._db_lock = threading.RLock()
        self.service_registry: dict[str, dict[str, Any]] = {}
        self.agent_registry: dict[str, dict[str, Any]] = {}
        self._init_database()
        self._remove_nonproduction_artifacts()
        self._remove_fictional_ship_controls()
        self._revert_commands_and_remove_agata_once()
        self._purge_decommissioned_agents_v1()
        self._restore_from_durable_backup_if_empty()

    @property
    def durable_backup_path(self) -> Path:
        return self.db_path.parent / "svl_durable_backup.json"

    def checkpoint_wal(self, mode: str = "PASSIVE") -> None:
        safe_mode = mode.upper() if mode.upper() in {"PASSIVE", "FULL", "RESTART", "TRUNCATE"} else "PASSIVE"
        try:
            with self._db_lock:
                with contextlib.closing(self._connect()) as conn:
                    conn.execute(f"PRAGMA wal_checkpoint({safe_mode});")
        except Exception:
            pass

    def save_durable_backup(self, *, explicitly_cleared: bool = False) -> None:
        """
        Zapisuje lekką, atomową kopię zapasową rozmów i pamięci AI obok pliku SQLite,
        chroniąc dane przed utratą w razie nagłego restartu kontenera lub niescheckpointowanego WAL.
        """
        try:
            def _dump(conn: sqlite3.Connection) -> dict[str, Any]:
                convs = [dict(r) for r in conn.execute("SELECT id, title, model, created_at, updated_at FROM conversations ORDER BY updated_at DESC").fetchall()]
                msgs = [dict(r) for r in conn.execute("SELECT id, conversation_id, role, sender, content, attachments_json, metadata_json, created_at FROM chat_messages ORDER BY created_at ASC, rowid ASC").fetchall()]
                mems = []
                if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_memory'").fetchone():
                    mems = [dict(r) for r in conn.execute("SELECT id, agent_id, scope, kind, content, source, created_at FROM agent_memory ORDER BY created_at ASC").fetchall()]
                return {
                    "version": 1,
                    "saved_at": datetime.now(timezone.utc).isoformat(),
                    "explicitly_cleared": bool(explicitly_cleared),
                    "conversations": convs,
                    "chat_messages": msgs,
                    "agent_memory": mems,
                }

            snapshot = self.run_db(_dump, write=False)
            if not explicitly_cleared and not snapshot["chat_messages"] and not snapshot["agent_memory"]:
                return
            self.durable_backup_path.parent.mkdir(parents=True, exist_ok=True)
            tmp_path = self.durable_backup_path.with_suffix(".json.tmp")
            tmp_path.write_text(json.dumps(snapshot, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp_path, self.durable_backup_path)
        except Exception:
            pass

    def _restore_from_durable_backup_if_empty(self) -> bool:
        """
        Jeśli baza SQLite uruchomiła się pusta (0 wiadomości i 0 wspomnień AI),
        a istnieje ważna kopia zapasowa nieoznaczona jako jawnie wyczyszczona, automatycznie przywraca dane.
        """
        try:
            if not self.durable_backup_path.is_file():
                return False
            raw = json.loads(self.durable_backup_path.read_text(encoding="utf-8"))
            if not isinstance(raw, dict) or raw.get("explicitly_cleared"):
                return False
            backup_msgs = raw.get("chat_messages") or []
            backup_mems = raw.get("agent_memory") or []
            backup_convs = raw.get("conversations") or []
            if not backup_msgs and not backup_mems:
                return False

            def _restore(conn: sqlite3.Connection) -> bool:
                msg_count = int(conn.execute("SELECT COUNT(*) FROM chat_messages").fetchone()[0])
                mem_count = 0
                has_mem_tbl = bool(conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_memory'").fetchone())
                if has_mem_tbl:
                    mem_count = int(conn.execute("SELECT COUNT(*) FROM agent_memory").fetchone()[0])
                if msg_count > 0 or mem_count > 0:
                    return False

                for c in backup_convs:
                    if not isinstance(c, dict) or not c.get("id"):
                        continue
                    conn.execute(
                        "INSERT OR IGNORE INTO conversations (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                        (
                            str(c["id"]),
                            str(c.get("title") or "Sesja SVL Python OS"),
                            str(c.get("model") or "svl-hybrid-router"),
                            str(c.get("created_at") or datetime.now(timezone.utc).isoformat()),
                            str(c.get("updated_at") or datetime.now(timezone.utc).isoformat()),
                        ),
                    )
                for m in backup_msgs:
                    if not isinstance(m, dict) or not m.get("id") or not m.get("conversation_id"):
                        continue
                    conn.execute(
                        "INSERT OR IGNORE INTO chat_messages (id, conversation_id, role, sender, content, attachments_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        (
                            str(m["id"]),
                            str(m["conversation_id"]),
                            str(m.get("role") or "user"),
                            str(m.get("sender") or "Operator"),
                            str(m.get("content") or ""),
                            str(m.get("attachments_json") or "[]"),
                            str(m.get("metadata_json") or "{}"),
                            str(m.get("created_at") or datetime.now(timezone.utc).isoformat()),
                        ),
                    )
                if has_mem_tbl:
                    for mem in backup_mems:
                        if not isinstance(mem, dict) or not mem.get("id"):
                            continue
                        conn.execute(
                            "INSERT OR IGNORE INTO agent_memory (id, agent_id, scope, kind, content, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                            (
                                str(mem["id"]),
                                str(mem.get("agent_id") or ""),
                                str(mem.get("scope") or "global"),
                                str(mem.get("kind") or "episode"),
                                str(mem.get("content") or ""),
                                str(mem.get("source") or "backup_restore"),
                                str(mem.get("created_at") or datetime.now(timezone.utc).isoformat()),
                            ),
                        )
                return True

            restored = self.run_db(_restore, write=True)
            if restored:
                self.checkpoint_wal("PASSIVE")
            return restored
        except Exception:
            return False

    @property
    def operator_token(self) -> str:
        return self._operator_token

    def verify_operator_token(self, candidate: str) -> bool:
        if not candidate or candidate == "364_OMNIKLUCZ_ROOT":
            return False
        return hmac.compare_digest(candidate.strip().encode("utf-8"), self._operator_token.encode("utf-8"))

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=15.0, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=15000;")
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=FULL;")
        conn.execute("PRAGMA cache_size=-64000;")
        conn.execute("PRAGMA temp_store=MEMORY;")
        conn.execute("PRAGMA mmap_size=268435456;")
        conn.execute("PRAGMA foreign_keys=ON;")
        return conn

    def run_db(self, fn: Callable[[sqlite3.Connection], _T], write: bool = True) -> _T:
        """
        Wykonuje operację SQLite w bezpiecznej transakcji z blokadą wątku
        oraz ograniczonym retry wyłącznie przy przejściowym SQLITE_BUSY / database is locked.
        """
        max_attempts = 6
        last_exc: Optional[Exception] = None
        for attempt in range(max_attempts):
            with self._db_lock:
                try:
                    with contextlib.closing(self._connect()) as conn:
                        if write:
                            conn.execute("BEGIN IMMEDIATE")
                        result = fn(conn)
                        if write:
                            conn.commit()
                        return result
                except sqlite3.OperationalError as exc:
                    msg = str(exc).lower()
                    if ("locked" in msg or "busy" in msg) and attempt < max_attempts - 1:
                        last_exc = exc
                    else:
                        raise
            time.sleep(min(0.4, 0.04 * (2 ** attempt)))
        assert last_exc is not None
        raise last_exc

    def _init_database(self) -> None:
        def _migrate(conn: sqlite3.Connection) -> None:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS update_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    wersja TEXT NOT NULL,
                    typ TEXT NOT NULL,
                    opis TEXT NOT NULL,
                    data TEXT NOT NULL,
                    is_demo INTEGER NOT NULL DEFAULT 0,
                    author TEXT NOT NULL DEFAULT 'system'
                );

                CREATE TABLE IF NOT EXISTS system_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT NOT NULL,
                    topic TEXT NOT NULL,
                    source TEXT NOT NULL,
                    severity TEXT NOT NULL,
                    payload_json TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS agent_memory (
                    id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL,
                    scope TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    content TEXT NOT NULL,
                    source TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS audit_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT NOT NULL,
                    actor TEXT NOT NULL,
                    action TEXT NOT NULL,
                    target TEXT NOT NULL,
                    status TEXT NOT NULL,
                    details TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    model TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS chat_messages (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    sender TEXT NOT NULL,
                    content TEXT NOT NULL,
                    attachments_json TEXT NOT NULL DEFAULT '[]',
                    metadata_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS runtime_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS sync_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS sync_entities (
                    entity TEXT NOT NULL,
                    entity_id TEXT NOT NULL,
                    revision INTEGER NOT NULL DEFAULT 1,
                    updated_at TEXT NOT NULL,
                    deleted INTEGER NOT NULL DEFAULT 0,
                    checksum TEXT NOT NULL DEFAULT '',
                    PRIMARY KEY (entity, entity_id)
                );

                CREATE TABLE IF NOT EXISTS sync_outbox (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_id TEXT NOT NULL UNIQUE,
                    type TEXT NOT NULL,
                    entity TEXT NOT NULL,
                    entity_id TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    server_revision INTEGER NOT NULL,
                    timestamp TEXT NOT NULL,
                    origin TEXT NOT NULL,
                    correlation_id TEXT NOT NULL DEFAULT '',
                    payload_json TEXT NOT NULL,
                    ws_dispatched INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS sync_inbox (
                    event_id TEXT PRIMARY KEY,
                    entity TEXT NOT NULL,
                    entity_id TEXT NOT NULL,
                    origin TEXT NOT NULL,
                    received_at TEXT NOT NULL,
                    result_revision INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS terminal_history (
                    id TEXT PRIMARY KEY,
                    tab TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    text TEXT NOT NULL,
                    command TEXT NOT NULL DEFAULT '',
                    timestamp TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS workspace_ui_state (
                    key TEXT PRIMARY KEY,
                    value_json TEXT NOT NULL,
                    revision INTEGER NOT NULL DEFAULT 1,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS system_modules (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'ACTIVE',
                    description TEXT NOT NULL DEFAULT '',
                    config_json TEXT NOT NULL DEFAULT '{}',
                    source TEXT NOT NULL DEFAULT 'kernel',
                    source_message_id TEXT NOT NULL DEFAULT '',
                    revision INTEGER NOT NULL DEFAULT 1,
                    updated_at TEXT NOT NULL
                );

                DROP TABLE IF EXISTS iris_notifications;

                CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages (conversation_id, created_at);
                CREATE INDEX IF NOT EXISTS idx_agent_memory_scope ON agent_memory (scope, created_at);
                CREATE INDEX IF NOT EXISTS idx_sync_outbox_srvrev ON sync_outbox (server_revision);
                CREATE INDEX IF NOT EXISTS idx_sync_outbox_ws ON sync_outbox (ws_dispatched, seq);
                CREATE INDEX IF NOT EXISTS idx_terminal_history_tab ON terminal_history (tab, created_at);
                CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log (id DESC);
                CREATE INDEX IF NOT EXISTS idx_system_modules_status ON system_modules (status, updated_at DESC);
                """
            )
            conn.execute(
                "INSERT OR IGNORE INTO sync_meta (key, value) VALUES ('server_revision', '1')"
            )
            conn.execute(
                "INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('schema_version', ?)",
                (SYNC_SCHEMA_VERSION,),
            )

            # Bezpieczne zainicjowanie rewizji dla istniejących rekordów bez utraty danych
            now_iso = datetime.now(timezone.utc).isoformat()
            existing_convs = conn.execute("SELECT id, updated_at FROM conversations").fetchall()
            for row in existing_convs:
                conn.execute(
                    "INSERT OR IGNORE INTO sync_entities (entity, entity_id, revision, updated_at, deleted) VALUES ('chat', ?, 1, ?, 0)",
                    (row["id"], row["updated_at"] or now_iso),
                )

            # Rdzeniowe moduły systemowe (idempotentnie, bez nadpisywania zmian operatora/czatu)
            core_modules = [
                (
                    "svl-kernel-core",
                    "SVLSystemKernel v5.6",
                    "Core Runtime",
                    "ACTIVE",
                    "Jądro systemowe Python 3 z trwałą bazą SQLite WAL, szyfrowaną weryfikacją HMAC i topologią [-1, 1].",
                    json.dumps({"sqlite_wal": True, "auth": "HMAC-SHA256"}, ensure_ascii=False),
                    "kernel",
                    "",
                    1,
                    now_iso,
                ),
                (
                    "spherical-event-bus",
                    "SphericalEventBus Async Pub/Sub",
                    "IPC & Telemetry",
                    "ACTIVE",
                    "Asynchroniczna magistrala zdarzeń agentów z obsługą VisualScope, retry i Circuit Breaker.",
                    json.dumps({"async_event_bus_buffer": 250, "circuit_breaker": True}, ensure_ascii=False),
                    "kernel",
                    "",
                    1,
                    now_iso,
                ),
                (
                    "binary-hyperspace-engine",
                    "BinaryHyperspaceKernel (128D)",
                    "Mathematics & Routing",
                    "ACTIVE",
                    "Silnik bez-NLP: ortogonalna projekcja 128D i analiza harmoniczna WithoutNlpHarmonicEngine.",
                    json.dumps({"dimensions": 128, "without_nlp": True}, ensure_ascii=False),
                    "kernel",
                    "",
                    1,
                    now_iso,
                ),
                (
                    "svl-364",
                    "SVL-364 — Centrum Dowodzenia",
                    "Orchestration & Command Center",
                    "ACTIVE",
                    "Programowy panel do koordynacji i diagnostyki usług SVL.",
                    json.dumps({"async_event_bus_buffer": 2000}, ensure_ascii=False),
                    "kernel",
                    "init-svl-364-command",
                    1,
                    now_iso,
                ),
                (
                    "svl-deep-memory-core",
                    "SVL Deep Long-Term Memory & Hyper-Recall Engine",
                    "Cognitive Memory & Recall Engine",
                    "ACTIVE",
                    "Długotrwała pamięć AI w SQLite WAL z indeksowaniem semantyczno-słownikowym BinaryHyperspace 128D, priorytetowym przypominaniem ustaleń/faktów/preferencji, automatyczną konsolidacją z czatu i oknem kontekstowym 64 tury / 16K tokenów.",
                    json.dumps(
                        {
                            "engine": "SQLite WAL + BinaryHyperspace 128D Hybrid Recall",
                            "persistent_scopes": ["global"],
                            "priority_kinds": ["decision", "preference", "fact", "task", "episode"],
                            "auto_extract_from_chat": True,
                            "deduplicate_entries": True,
                            "max_context_turns": 64,
                            "ollama_num_ctx": 16384,
                            "recall_top_k": 32,
                            "low_latency_cache_ms": 2500,
                        },
                        ensure_ascii=False,
                    ),
                    "kernel",
                    "init-deep-memory",
                    1,
                    now_iso,
                ),
                (
                    "svl-duplex-chat",
                    "Interaktywny Czat Obustronny — Rodzina Mitek (wszyscy)",
                    "Duplex Multi-Agent Bridge",
                    "ACTIVE",
                    "Kanał rozmów Rodziny Mitek (wszyscy).",
                    json.dumps(
                        {
                            "channel": "Rodzina Mitek (wszyscy)",
                            "conversation_id": "conv-rodzina-mitek-wszyscy",
                            "bidirectional_duplex": True,
                            "agents": [],
                        },
                        ensure_ascii=False,
                    ),
                    "kernel",
                    "init-duplex",
                    1,
                    now_iso,
                ),
                (
                    "svl-coreos-2-apex",
                    "SVL CoreOS 2: Apex — Debian 13 (Trixie) & Ollama Uncensored (SVL-364)",
                    "Operating System & AI Core",
                    "ACTIVE",
                    "System operacyjny SVL CoreOS 2: Apex na bazie Debian 13 (Trixie), zintegrowany z diagnozowanym przez OpenSSH komputerem SVL-364 oraz pokładową Ollamą.",
                    json.dumps(
                        {
                            "base_distro": "Debian GNU/Linux 13 (Trixie)",
                            "codename": "Apex",
                            "repository_folder": "SVL_CoreOS_2",
                            "kernel_master_daemon": "Maya Mitek",
                            "ollama_model": "svl364-apex-uncensored:latest",
                        },
                        ensure_ascii=False,
                    ),
                    "kernel",
                    "init-coreos-2-apex",
                    1,
                    now_iso,
                ),
            ]
            for mod in core_modules:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO system_modules (
                        id, name, kind, status, description, config_json, source, source_message_id, revision, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    mod,
                )
                conn.execute(
                    "INSERT OR IGNORE INTO sync_entities (entity, entity_id, revision, updated_at, deleted) VALUES ('module', ?, 1, ?, 0)",
                    (mod[0], now_iso),
                )

        self.run_db(_migrate, write=True)

    def _remove_fictional_ship_controls(self) -> None:
        marker = "fictional_ship_controls_removed_v1"

        def _migrate(conn: sqlite3.Connection) -> None:
            if conn.execute("SELECT 1 FROM sync_meta WHERE key = ?", (marker,)).fetchone():
                return
            conn.execute("INSERT INTO sync_meta (key, value) VALUES (?, 'done')", (marker,))
            obsolete_keys = {
                "e_shield_mode",
                "e_shield_percent",
                "fusion_mode",
                "fusion_core_mw",
                "solar_lockdown",
                "fighter_incidents",
                "compute_thrust",
            }
            rows = conn.execute("SELECT id, description, config_json FROM system_modules").fetchall()
            for row in rows:
                try:
                    config = json.loads(row["config_json"] or "{}")
                except (TypeError, ValueError):
                    config = {}
                if not isinstance(config, dict):
                    config = {}
                cleaned = dict(config)
                for key in obsolete_keys:
                    cleaned.pop(key, None)
                description = str(row["description"] or "")
                replacement = description.replace(
                    "Compute-Thrust, E_Shield — widoczność dla jednostek nadlatujących w stronę Ziemi, "
                    "otwarty korytarz dla sojuszników",
                    "",
                )
                replacement = replacement.replace("E_Shield", "").replace("Solar-Lockdown", "")
                replacement = " ".join(replacement.split())
                if cleaned != config or replacement != description:
                    conn.execute(
                        "UPDATE system_modules SET description = ?, config_json = ? WHERE id = ?",
                        (replacement, json.dumps(cleaned, ensure_ascii=False), row["id"]),
                    )

        self.run_db(_migrate, write=True)

    def ensure_mitek_family_channel(self) -> None:
        """Tworzy grupowy kanał 'Rodzina Mitek (wszyscy)' — Interaktywny Czat Obustronny w bazie produkcyjnej, jeśli nie został usunięty."""
        now_iso = datetime.now(timezone.utc).isoformat()

        def _seed_family(conn: sqlite3.Connection) -> None:
            conn.execute(
                "DELETE FROM chat_messages WHERE role = 'system' AND sender = 'Diagnostyka połączenia AI'"
            )

            for chan_id, chan_title, chan_model in (
                ("conv-rodzina-mitek-wszyscy", "Rodzina Mitek (wszyscy)", "svl-hybrid-router"),
                ("conv-agent-bielik", "Bielik — Ollama Dolphin Llama 3 8B Q2", "ollama:dolphin-llama3:8b-v2.9-q2_K"),
                ("conv-agent-maya", "Maya Mitek — AI Statku SVL-364 (ROOT)", "ollama:dolphin-llama3:8b-v2.9-q2_K"),
                ("conv-svl364-komputer-pokladowy", "SVL-364 Komputer pokładowy (SSH + MCP)", "ollama:llama3.2-vision:11b"),
            ):
                del_row = conn.execute(
                    "SELECT deleted FROM sync_entities WHERE entity = 'chat' AND entity_id = ?",
                    (chan_id,),
                ).fetchone()
                if del_row and int(del_row["deleted"]) != 0:
                    # A stale tombstone must not hide a permanent canonical channel.
                    conn.execute(
                        "UPDATE sync_entities SET deleted = 0, revision = revision + 1, updated_at = ? WHERE entity = 'chat' AND entity_id = ?",
                        (now_iso, chan_id),
                    )
                    del_row = None
                if not del_row or int(del_row["deleted"]) == 0:
                    existing_conv = conn.execute(
                        "SELECT id, title FROM conversations WHERE id = ?",
                        (chan_id,),
                    ).fetchone()
                    if not existing_conv:
                        conn.execute(
                            "INSERT INTO conversations (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                            (
                                chan_id,
                                chan_title,
                                chan_model,
                                now_iso,
                                now_iso,
                            ),
                        )
                        conn.execute(
                            "INSERT OR IGNORE INTO sync_entities (entity, entity_id, revision, updated_at, deleted) VALUES ('chat', ?, 1, ?, 0)",
                            (chan_id, now_iso),
                        )
                        if chan_id == "conv-svl364-komputer-pokladowy":
                            welcome_id = "sys-svl364-onboard-init"
                            if not conn.execute("SELECT 1 FROM chat_messages WHERE id = ?", (welcome_id,)).fetchone():
                                welcome_meta = json.dumps(
                                    {
                                        "display_timestamp": now_iso,
                                        "agentId": "Maya",
                                        "modelUsed": "Maya Mitek · SVL-364 Komputer pokładowy (SSH + MCP · ROOT)",
                                        "provenance": "server_verified",
                                        "appliedActions": [
                                            {
                                                "tool": "svl_channel_upsert",
                                                "entity": "chat",
                                                "entityId": "conv-svl364-komputer-pokladowy",
                                                "summary": "Zarejestrowano i skonfigurowano kanał SVL-364 Komputer pokładowy (SSH + MCP)",
                                                "ok": True,
                                            }
                                        ],
                                    },
                                    ensure_ascii=False,
                                )
                                welcome_content = (
                                    "### 🛰️ SVL-364 Komputer pokładowy — Kanał bezpośredniego kontaktu SSH + MCP (ROOT)\n\n"
                                    "Kanał został utworzony i globalnie zsynchronizowany w bazie SQLite WAL. "
                                    "Każda wiadomość w tym kanale ma aktywny bezpośredni dostęp do mostka **OpenSSH SVL-364 (`Ship` / lokalny mostek hosta SVL-364)** "
                                    "oraz serwera **MCP SVL-364 (`svl364-linux-control-mcp`)**.\n\n"
                                    "| Parametr kanału | Konfiguracja | Status |\n"
                                    "| :--- | :--- | :--- |\n"
                                    "| **ID kanału** | `conv-svl364-komputer-pokladowy` | [card: Aktywny|SQLite WAL|ok] |\n"
                                    "| **Mostek SSH** | `ssh://Ship` + lokalny mostek ROOT (`svl_ssh_exec`) | [card: SSH Bridge|Gotowy|ok] |\n"
                                    "| **Serwer MCP** | `/api/py/svl364/mcp` (`svl_mcp_call` · 12 narzędzi) | [card: MCP SVL-364|Aktywny|ok] |\n"
                                    "| **Agenci dyżurni** | Maya Mitek (ROOT) & Bielik (ROOT) | [card: Uprawnienia|ROOT (29 zakresów)|ok] |\n\n"
                                    "[btn: 📡 Telemetria MCP|send:Wywołaj svl_mcp_call z narzędziem svl364_linux_telemetry] "
                                    "[btn: 🔑 Test SSH + Host|send:Wywołaj svl_ssh_exec z poleceniem hostname && uname -a && uptime] "
                                    "[btn: 📊 Zasoby komputera pokładowego|send:Wywołaj svl_mcp_call z narzędziem svl364_resources dla area overview] "
                                    "[btn: 🛰️ Panel SVL-364|tab:svl364]"
                                )
                                conn.execute(
                                    "INSERT INTO chat_messages (id, conversation_id, role, sender, content, attachments_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, '[]', ?, ?)",
                                    (
                                        welcome_id,
                                        chan_id,
                                        "assistant",
                                        "Maya Mitek",
                                        welcome_content,
                                        welcome_meta,
                                        now_iso,
                                    ),
                                )
                    elif chan_id in ("conv-agent-maya", "conv-svl364-komputer-pokladowy") and str(existing_conv["title"] or "") != chan_title:
                        conn.execute(
                            "UPDATE conversations SET title = ? WHERE id = ?",
                            (chan_title, chan_id),
                        )
            # Bezpieczna, niedestrukcyjna aktualizacja nazwy wyświetlanej Maya -> Maya Mitek w istniejących wiadomościach.
            conn.execute(
                "UPDATE chat_messages SET sender = 'Maya Mitek' WHERE sender IN ('Maya', 'Maya AI', 'Maya SVL-364')"
            )

        self.run_db(_seed_family, write=True)

    def _purge_decommissioned_agents_v1(self) -> None:
        """Jednorazowe odłączenie wyłączonych kont AI (Agata, Iris, Aria, Alex, Astyria, Aurelius) bez usuwania bieżących rozmów."""
        marker = "decommissioned_agents_purged_2026_11_16_v1"
        removed_ids = ("Agata", "Aria", "Alex", "Astyria", "Aurelius", "si_1", "Iris", "iris")
        removed_senders = (
            "Agata", "Aria", "Alex", "Astyria", "Aurelius", "si_1", "Iris", "Iris AI",
            "Agata Mitek", "Aria Mitek", "Alex Mitek", "Astyria Mitek", "Aurelius Mitek",
        )
        removed_scopes = (
            "agent:Agata", "agent:Aria", "agent:Alex", "agent:Astyria", "agent:Aurelius", "agent:si_1", "agent:Iris", "agent:iris",
        )
        removed_convs = (
            "conv-agent-agata", "conv-agent-aria", "conv-agent-alex", "conv-agent-astyria", "conv-agent-aurelius", "conv-agent-iris",
        )
        removed_word_re = re.compile(
            r"\b(?:agat\w*|alex\w*|aleks\w*|aria|arii|arię|arią|astyri\w*|aureliusz\w*|aurelius\w*|iris)\b|\bsi_1\b",
            re.IGNORECASE,
        )
        now_iso = datetime.now(timezone.utc).isoformat()

        def _purge(conn: sqlite3.Connection) -> None:
            if conn.execute("SELECT 1 FROM sync_meta WHERE key = ?", (marker,)).fetchone():
                return
            existing_tables = {
                str(r["name"])
                for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
            }
            if "agent_configs" in existing_tables:
                conn.execute(
                    f"DELETE FROM agent_configs WHERE canonical_name IN ({','.join('?' for _ in removed_ids)})",
                    removed_ids,
                )
            if "agent_tasks" in existing_tables:
                conn.execute(
                    f"DELETE FROM agent_tasks WHERE target_agent IN ({','.join('?' for _ in removed_ids)}) "
                    f"OR sender IN ({','.join('?' for _ in removed_senders)})",
                    (*removed_ids, *removed_senders),
                )
            conn.execute(
                f"DELETE FROM agent_memory WHERE agent_id IN ({','.join('?' for _ in removed_ids)}) "
                f"OR scope IN ({','.join('?' for _ in removed_scopes)})",
                (*removed_ids, *removed_scopes),
            )
            conn.execute(
                f"DELETE FROM chat_messages WHERE conversation_id IN ({','.join('?' for _ in removed_convs)}) "
                f"OR sender IN ({','.join('?' for _ in removed_senders)})",
                (*removed_convs, *removed_senders),
            )
            msg_rows = conn.execute("SELECT id, role, content, metadata_json FROM chat_messages").fetchall()
            for mr in msg_rows:
                meta_raw = str(mr["metadata_json"] or "{}")
                content_raw = str(mr["content"] or "")
                role_raw = str(mr["role"] or "")
                try:
                    meta = json.loads(meta_raw)
                except Exception:
                    meta = {}
                has_removed_agent_id = isinstance(meta, dict) and str(meta.get("agentId") or "") in removed_ids
                has_removed_mention = role_raw != "user" and (
                    bool(removed_word_re.search(content_raw)) or bool(removed_word_re.search(meta_raw))
                )
                if has_removed_agent_id or has_removed_mention:
                    conn.execute("DELETE FROM chat_messages WHERE id = ?", (mr["id"],))

            conn.execute(
                f"DELETE FROM conversations WHERE id IN ({','.join('?' for _ in removed_convs)})",
                removed_convs,
            )

            if "iris_notifications" in existing_tables:
                conn.execute("DELETE FROM iris_notifications")
            conn.execute("DELETE FROM chat_messages WHERE id LIKE 'iris-chat-%' OR sender IN ('Iris', 'Iris AI')")

            conn.execute(
                f"DELETE FROM sync_entities WHERE entity = 'chat' AND entity_id IN ({','.join('?' for _ in removed_convs)})",
                removed_convs,
            )
            conn.execute(
                f"DELETE FROM sync_outbox WHERE entity = 'chat' AND entity_id IN ({','.join('?' for _ in removed_convs)})",
                removed_convs,
            )
            conn.execute("DELETE FROM sync_entities WHERE entity = 'notification'")
            conn.execute("DELETE FROM sync_outbox WHERE entity = 'notification'")
            conn.execute(
                f"DELETE FROM sync_entities WHERE entity IN ('agent_config', 'agent_memory', 'agent_runtime', 'avatar') "
                f"AND entity_id IN ({','.join('?' for _ in removed_ids)})",
                removed_ids,
            )
            conn.execute(
                f"DELETE FROM sync_outbox WHERE entity IN ('agent_config', 'agent_memory', 'agent_runtime', 'avatar') "
                f"AND entity_id IN ({','.join('?' for _ in removed_ids)})",
                removed_ids,
            )

            # Oczyść wpisy w terminal_history zawierające odwołania do odłączonych kont AI
            if "terminal_history" in existing_tables:
                term_rows = conn.execute("SELECT id, text, command FROM terminal_history").fetchall()
                for tr in term_rows:
                    t_text = str(tr["text"] or "")
                    t_cmd = str(tr["command"] or "")
                    if removed_word_re.search(t_text) or removed_word_re.search(t_cmd):
                        conn.execute("DELETE FROM terminal_history WHERE id = ?", (tr["id"],))

            # Oczyść usunięte profile ze słownika awatarów
            av_row = conn.execute(
                "SELECT value FROM runtime_settings WHERE key = 'avatars_map_json'"
            ).fetchone()
            if av_row and av_row["value"]:
                try:
                    parsed_av = json.loads(av_row["value"])
                    if isinstance(parsed_av, dict):
                        cleaned_av = {
                            k: v
                            for k, v in parsed_av.items()
                            if self._normalize_avatar_profile_key(str(k))
                        }
                        if len(cleaned_av) != len(parsed_av):
                            conn.execute(
                                "UPDATE runtime_settings SET value = ?, updated_at = ? WHERE key = 'avatars_map_json'",
                                (json.dumps(cleaned_av, ensure_ascii=False), now_iso),
                            )
                except Exception:
                    pass

            # Oczyść workspace_ui_state, gdyby wskazywał na usuniętego agenta/wątek
            ws_rows = conn.execute("SELECT key, value_json FROM workspace_ui_state").fetchall()
            for wr in ws_rows:
                wkey = str(wr["key"] or "")
                try:
                    val = json.loads(wr["value_json"] or "null")
                except Exception:
                    continue
                if isinstance(val, str):
                    replacement: Optional[str] = None
                    if wkey == "active_conversation_id" and val in removed_convs:
                        replacement = "conv-rodzina-mitek-wszyscy"
                    elif wkey == "selected_target_agent" and val in removed_ids:
                        replacement = "Rodzina Mitek"
                    elif wkey == "selected_agent_panel_id" and val in removed_ids:
                        replacement = ""
                    if replacement is not None:
                        conn.execute(
                            "UPDATE workspace_ui_state SET value_json = ?, updated_at = ? WHERE key = ?",
                            (json.dumps(replacement, ensure_ascii=False), now_iso, wkey),
                        )
                    continue
                if not isinstance(val, dict):
                    continue
                changed_ws = False
                if str(val.get("activeConversationId") or "") in removed_convs:
                    val["activeConversationId"] = "conv-rodzina-mitek-wszyscy"
                    changed_ws = True
                if str(val.get("targetAgent") or "") in removed_ids:
                    val["targetAgent"] = "Rodzina Mitek"
                    changed_ws = True
                if str(val.get("selectedAgentPanel") or "") in removed_ids:
                    val["selectedAgentPanel"] = ""
                    changed_ws = True
                if changed_ws:
                    conn.execute(
                        "UPDATE workspace_ui_state SET value_json = ?, updated_at = ? WHERE key = ?",
                        (json.dumps(val, ensure_ascii=False), now_iso, wkey),
                    )

            # Usuń wyłącznie dawne wpisy wyłączonych profili Iris AI (nie usuwaj bieżących rozmów ani asst-proactive-*)
            conn.execute(
                "DELETE FROM chat_messages WHERE sender IN ('System SVL', 'Iris', 'Iris AI') OR id LIKE 'iris-chat-%'"
            )

            # Usuń wycofane moduły oraz moduły Iris/Powiadomienia
            for obsolete_mod in (
                "svl-codex-mesh",
                "svl-autonomy-core",
                "svl-agent-task-distributor",
                "svl-memory-shield",
                "svl-364-repo-vault",
                "svl-364-camera-feed",
                "svl-iris-01",
                "svl-iris-coordinator",
                "svl-notification-center",
                "svl-notif-control-iris",
            ):
                conn.execute("DELETE FROM system_modules WHERE id = ?", (obsolete_mod,))
                conn.execute("DELETE FROM sync_entities WHERE entity = 'module' AND entity_id = ?", (obsolete_mod,))
            if "terminal_history" in existing_tables:
                conn.execute("DELETE FROM terminal_history WHERE tab = 'codex' OR text LIKE '%Status: QUEUED%'")

            # Zaktualizuj metadane aktywnych modułów tak, by nie zawierały odniesień do odłączonych AI
            module_sanitizers = {
                "svl-kernel-core": (
                    "Jądro systemowe Python 3 z trwałą bazą SQLite WAL, szyfrowaną weryfikacją HMAC i topologią [-1, 1].",
                    None,
                ),
                "svl-duplex-chat": (
                    "Kanał rozmów Rodziny Mitek (wszyscy).",
                    lambda cfg: {**cfg, "agents": []},
                ),
                "svl-deep-memory-core": (
                    "Długotrwała pamięć AI w SQLite WAL z indeksowaniem BinaryHyperspace 128D.",
                    lambda cfg: {**cfg, "persistent_scopes": ["global"]},
                ),
                "svl-364": (
                    "Programowy panel do koordynacji i diagnostyki usług SVL.",
                    lambda cfg: {
                        k: v
                        for k, v in cfg.items()
                        if k not in (
                            "root_nopasswd",
                            "dynamic_resource_allocation",
                            "all_five_agents_reply",
                            "active_agents",
                            "solo_agent_mode",
                        )
                    },
                ),
            }
            for mod_id, (clean_desc, cfg_fn) in module_sanitizers.items():
                mod_row = conn.execute(
                    "SELECT description, config_json FROM system_modules WHERE id = ?",
                    (mod_id,),
                ).fetchone()
                if not mod_row:
                    continue
                cur_desc = str(mod_row["description"] or "")
                try:
                    cur_cfg = json.loads(mod_row["config_json"] or "{}")
                    if not isinstance(cur_cfg, dict):
                        cur_cfg = {}
                except Exception:
                    cur_cfg = {}
                cur_cfg_str = json.dumps(cur_cfg, ensure_ascii=False)
                needs_desc_fix = bool(clean_desc and (removed_word_re.search(cur_desc) or "wszystkich 5 agentów" in cur_desc))
                needs_cfg_fix = bool(
                    cfg_fn
                    and (
                        removed_word_re.search(cur_cfg_str)
                        or "all_five_agents_reply" in cur_cfg
                        or "wszystkich 5 agentów" in cur_cfg_str
                        or any(
                            k in cur_cfg
                            for k in (
                                "root_nopasswd",
                                "dynamic_resource_allocation",
                                "active_agents",
                                "solo_agent_mode",
                            )
                        )
                    )
                )
                if needs_desc_fix or needs_cfg_fix:
                    new_desc = clean_desc if needs_desc_fix and clean_desc else cur_desc
                    new_cfg = cfg_fn(cur_cfg) if cfg_fn and needs_cfg_fix else cur_cfg
                    conn.execute(
                        "UPDATE system_modules SET description = ?, config_json = ?, updated_at = ? WHERE id = ?",
                        (new_desc, json.dumps(new_cfg, ensure_ascii=False), now_iso, mod_id),
                    )

            # Powiadomienia i Iris AI zostały wyłączone; upewnij się, że nie ma żadnych wpisów
            if "iris_notifications" in existing_tables:
                conn.execute("DELETE FROM iris_notifications")

            # Usuń stare wpisy update_history dotyczące wyłączonych agentów
            upd_rows = conn.execute("SELECT id, opis FROM update_history").fetchall()
            for ur in upd_rows:
                opis_txt = str(ur["opis"] or "")
                if removed_word_re.search(opis_txt) or "wszystkich 4 AI" in opis_txt or "wszystkich 5 AI" in opis_txt:
                    conn.execute("DELETE FROM update_history WHERE id = ?", (ur["id"],))

            conn.execute("INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, 'done')", (marker,))

        self.run_db(_purge, write=True)

    def _revert_commands_and_remove_agata_once(self) -> None:
        """
        Jednorazowe usunięcie wycofanych artefaktów legacy (conv-agent-agata, svl-memory-shield, @work).
        NIGDY nie kasuje bieżących wiadomości czatu (Rodzina Mitek / Bielik / Maya Mitek) ani pamięci AI.
        """
        marker = "revert_commands_remove_agata_2026_11_16_v1"

        def _cleanup_legacy_only(conn: sqlite3.Connection) -> None:
            if conn.execute("SELECT 1 FROM sync_meta WHERE key = ?", (marker,)).fetchone():
                return
            now_iso = datetime.now(timezone.utc).isoformat()
            conn.execute("DELETE FROM chat_messages WHERE conversation_id = 'conv-agent-agata'")
            conn.execute("DELETE FROM conversations WHERE id = 'conv-agent-agata'")
            conn.execute(
                "INSERT OR IGNORE INTO conversations (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                ("conv-rodzina-mitek-wszyscy", "Rodzina Mitek (wszyscy)", "svl-hybrid-router", now_iso, now_iso),
            )
            conn.execute(
                "DELETE FROM system_modules WHERE id = 'svl-memory-shield' AND description LIKE '%Zsynchronizowano z rozkazu Operatora%'"
            )
            conn.execute("DELETE FROM terminal_history WHERE command LIKE '@work%'")
            conn.execute("INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, 'done')", (marker,))

        self.run_db(_cleanup_legacy_only, write=True)

    def _get_server_revision_tx(self, conn: sqlite3.Connection) -> int:
        row = conn.execute("SELECT value FROM sync_meta WHERE key = 'server_revision'").fetchone()
        if not row:
            conn.execute("INSERT OR IGNORE INTO sync_meta (key, value) VALUES ('server_revision', '1')")
            return 1
        try:
            return int(row["value"])
        except (TypeError, ValueError):
            return 1

    def get_server_revision(self) -> int:
        return int(self.run_db(lambda conn: self._get_server_revision_tx(conn), write=False))

    def commit_entity_event_tx(
        self,
        conn: sqlite3.Connection,
        *,
        entity: str,
        entity_id: str,
        event_type: str,
        origin: str = "python-kernel",
        correlation_id: str = "",
        event_id: Optional[str] = None,
        expected_revision: Optional[int] = None,
        deleted: bool = False,
        payload: Optional[dict[str, Any]] = None,
        checksum_source: Optional[Any] = None,
    ) -> dict[str, Any]:
        """
        Wykonuje atomową aktualizację rewizji encji i zapisuje zdarzenie do sync_outbox
        wewnątrz tej samej transakcji SQLite (z deduplikacją sync_inbox po event_id).
        """
        now_iso = datetime.now(timezone.utc).isoformat()
        clean_origin = (origin or "python-kernel")[:120]
        clean_corr = (correlation_id or "")[:120]
        clean_eid = (event_id or "").strip()[:128] or f"evt-{uuid.uuid4().hex}"

        # Idempotencja po eventId
        inbox_row = conn.execute(
            "SELECT result_revision FROM sync_inbox WHERE event_id = ?",
            (clean_eid,),
        ).fetchone()
        ent_row = conn.execute(
            "SELECT revision, deleted FROM sync_entities WHERE entity = ? AND entity_id = ?",
            (entity, entity_id),
        ).fetchone()
        current_rev = int(ent_row["revision"]) if ent_row else 0
        current_srv = self._get_server_revision_tx(conn)

        if inbox_row:
            return {
                "deduplicated": True,
                "event": {
                    "type": event_type,
                    "eventId": clean_eid,
                    "entity": entity,
                    "entityId": entity_id,
                    "revision": int(inbox_row["result_revision"]),
                    "serverRevision": current_srv,
                    "timestamp": now_iso,
                    "origin": clean_origin,
                    "correlationId": clean_corr,
                    "payload": sanitize_sync_value(payload or {}, [self._operator_token]),
                },
                "revision": int(inbox_row["result_revision"]),
                "serverRevision": current_srv,
            }

        if expected_revision is not None and current_rev != expected_revision:
            raise RevisionConflictError(entity, entity_id, current_rev, expected_revision)

        new_rev = current_rev + 1
        new_srv = current_srv + 1
        checksum = ""
        if checksum_source is not None:
            raw_cs = json.dumps(checksum_source, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")
            checksum = hashlib.sha256(raw_cs).hexdigest()[:20]

        conn.execute(
            """
            INSERT INTO sync_entities (entity, entity_id, revision, updated_at, deleted, checksum)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(entity, entity_id) DO UPDATE SET
                revision = excluded.revision,
                updated_at = excluded.updated_at,
                deleted = excluded.deleted,
                checksum = excluded.checksum
            """,
            (entity, entity_id, new_rev, now_iso, 1 if deleted else 0, checksum),
        )
        conn.execute(
            "INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('server_revision', ?)",
            (str(new_srv),),
        )

        safe_payload = sanitize_sync_value(payload or {}, [self._operator_token])
        payload_json = json.dumps(safe_payload, ensure_ascii=False)
        conn.execute(
            """
            INSERT INTO sync_outbox (
                event_id, type, entity, entity_id, revision, server_revision,
                timestamp, origin, correlation_id, payload_json, ws_dispatched
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            """,
            (clean_eid, event_type, entity, entity_id, new_rev, new_srv, now_iso, clean_origin, clean_corr, payload_json),
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO sync_inbox (event_id, entity, entity_id, origin, received_at, result_revision)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (clean_eid, entity, entity_id, clean_origin, now_iso, new_rev),
        )

        append_python_log(
            f"sync:{event_type}",
            f"{entity}/{entity_id} rev={new_rev} srvRev={new_srv}",
            level="INFO",
            correlation_id=clean_corr,
            origin=clean_origin,
            details=safe_payload,
            extra_secrets=[self._operator_token] if getattr(self, "_operator_token", None) else None,
        )

        return {
            "deduplicated": False,
            "revision": new_rev,
            "serverRevision": new_srv,
            "event": {
                "type": event_type,
                "eventId": clean_eid,
                "entity": entity,
                "entityId": entity_id,
                "revision": new_rev,
                "serverRevision": new_srv,
                "timestamp": now_iso,
                "origin": clean_origin,
                "correlationId": clean_corr,
                "payload": safe_payload,
            },
        }

    def emit_sync_event(
        self,
        *,
        entity: str,
        entity_id: str,
        event_type: str,
        origin: str = "python-kernel",
        correlation_id: str = "",
        event_id: Optional[str] = None,
        expected_revision: Optional[int] = None,
        deleted: bool = False,
        payload: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        return self.run_db(
            lambda conn: self.commit_entity_event_tx(
                conn,
                entity=entity,
                entity_id=entity_id,
                event_type=event_type,
                origin=origin,
                correlation_id=correlation_id,
                event_id=event_id,
                expected_revision=expected_revision,
                deleted=deleted,
                payload=payload,
            ),
            write=True,
        )

    def get_sync_metadata(self) -> dict[str, Any]:
        def _read(conn: sqlite3.Connection) -> dict[str, Any]:
            srv = self._get_server_revision_tx(conn)
            schema_row = conn.execute("SELECT value FROM sync_meta WHERE key = 'schema_version'").fetchone()
            ent_rows = conn.execute(
                "SELECT entity, entity_id, revision, updated_at, deleted FROM sync_entities"
            ).fetchall()
            entity_revisions: dict[str, int] = {}
            deleted_entities: dict[str, list[str]] = {}
            for r in ent_rows:
                key = f"{r['entity']}:{r['entity_id']}"
                entity_revisions[key] = int(r["revision"])
                if int(r["deleted"]):
                    deleted_entities.setdefault(r["entity"], []).append(r["entity_id"])
            return {
                "serverRevision": srv,
                "schemaVersion": schema_row["value"] if schema_row else SYNC_SCHEMA_VERSION,
                "entityRevisions": entity_revisions,
                "deletedEntities": deleted_entities,
            }

        return self.run_db(_read, write=False)

    def get_outbox_events_since(self, since_revision: int = 0, limit: int = 100) -> dict[str, Any]:
        safe_limit = max(1, min(500, int(limit)))

        def _read(conn: sqlite3.Connection) -> dict[str, Any]:
            srv = self._get_server_revision_tx(conn)
            schema_row = conn.execute("SELECT value FROM sync_meta WHERE key = 'schema_version'").fetchone()
            min_row = conn.execute("SELECT MIN(server_revision) AS min_rev FROM sync_outbox").fetchone()
            min_available = int(min_row["min_rev"]) if min_row and min_row["min_rev"] is not None else srv
            rows = conn.execute(
                """
                SELECT event_id, type, entity, entity_id, revision, server_revision,
                       timestamp, origin, correlation_id, payload_json
                FROM sync_outbox
                WHERE server_revision > ?
                ORDER BY server_revision ASC
                LIMIT ?
                """,
                (max(0, int(since_revision)), safe_limit),
            ).fetchall()
            events: list[dict[str, Any]] = []
            for r in rows:
                try:
                    payload_obj = json.loads(r["payload_json"] or "{}")
                except Exception:
                    payload_obj = {}
                events.append({
                    "type": r["type"],
                    "eventId": r["event_id"],
                    "entity": r["entity"],
                    "entityId": r["entity_id"],
                    "revision": int(r["revision"]),
                    "serverRevision": int(r["server_revision"]),
                    "timestamp": r["timestamp"],
                    "origin": r["origin"],
                    "correlationId": r["correlation_id"],
                    "payload": payload_obj,
                })
            gap_detected = since_revision > 0 and since_revision < (min_available - 1)
            return {
                "ok": True,
                "schemaVersion": schema_row["value"] if schema_row else SYNC_SCHEMA_VERSION,
                "serverRevision": srv,
                "oldestAvailableRevision": min_available,
                "gapDetected": gap_detected,
                "hasMore": len(events) == safe_limit and (events[-1]["serverRevision"] < srv if events else False),
                "events": events,
            }

        return self.run_db(_read, write=False)

    def _remove_nonproduction_artifacts(self) -> None:
        fake_history_versions = (
            "5.6.0-Production-Init",
            "5.6.1-Topological-Verified",
            "5.6.2-Spherical-EventBus",
            "5.6.3-SVL-364-Apex",
            "5.6.4-Autonomous-AI-Sync",
        )
        obsolete_svl364_config = {
            "module_alias",
            "connection_verified",
            "local_command_center",
            "agent_max_context_turns",
            "worker_heartbeat_interval_sec",
            "priority_routing",
            "optimization_scope",
            "dynamic_resource_allocation",
            "max_cpu_threads",
            "ollama_num_ctx",
            "root_nopasswd",
            "bidirectional_interactive_chat",
            "family_channel",
            "container_runtime_note",
        }

        # Jednorazowa migracja: wcześniej działała przy KAŻDYM starcie i nadpisywała nazwę,
        # opis i konfigurację modułów svl-364 / svl-duplex-chat zmienione przez operatora.
        marker = "nonproduction_artifacts_removed_v1"

        def _migrate(conn: sqlite3.Connection) -> None:
            if conn.execute("SELECT 1 FROM sync_meta WHERE key = ?", (marker,)).fetchone():
                return
            conn.execute("INSERT INTO sync_meta (key, value) VALUES (?, 'done')", (marker,))
            conn.execute(
                """
                DELETE FROM update_history
                WHERE is_demo = 1 OR typ = 'DEMO_FIXTURE' OR wersja IN (?, ?, ?, ?, ?)
                """,
                fake_history_versions,
            )

            autonomy_module = conn.execute(
                "SELECT id FROM system_modules WHERE id = 'svl-autonomy-core'"
            ).fetchone()
            if autonomy_module:
                conn.execute("DELETE FROM system_modules WHERE id = 'svl-autonomy-core'")
                self.commit_entity_event_tx(
                    conn,
                    entity="module",
                    entity_id="svl-autonomy-core",
                    event_type="module.deleted",
                    origin="nonproduction-cleanup",
                    deleted=True,
                    payload={"moduleId": "svl-autonomy-core"},
                )

            chat_placeholders = conn.execute(
                """
                SELECT id FROM system_modules
                WHERE source = 'chat' AND kind = 'Chat Module'
                """
            ).fetchall()
            for placeholder in chat_placeholders:
                row = conn.execute(
                    "SELECT config_json FROM system_modules WHERE id = ?",
                    (placeholder["id"],),
                ).fetchone()
                try:
                    config = json.loads(row["config_json"] or "{}") if row else {}
                except (TypeError, ValueError):
                    config = {}
                if not isinstance(config, dict) or config.get("registered_from") != "chat_history":
                    continue
                module_id = str(placeholder["id"])
                conn.execute("DELETE FROM system_modules WHERE id = ?", (module_id,))
                self.commit_entity_event_tx(
                    conn,
                    entity="module",
                    entity_id=module_id,
                    event_type="module.deleted",
                    origin="nonproduction-cleanup",
                    deleted=True,
                    payload={"moduleId": module_id},
                )

            for module_id in ("svl-364", "svl-duplex-chat"):
                row = conn.execute(
                    """
                    SELECT name, kind, status, description, config_json, source, source_message_id
                    FROM system_modules WHERE id = ?
                    """,
                    (module_id,),
                ).fetchone()
                if not row:
                    continue
                try:
                    config = json.loads(row["config_json"] or "{}")
                except (TypeError, ValueError):
                    config = {}
                if not isinstance(config, dict):
                    config = {}
                cleaned_config = dict(config)
                obsolete_keys = (
                    obsolete_svl364_config
                    if module_id == "svl-364"
                    else {"root_nopasswd", "exec_bridge"}
                )
                for key in obsolete_keys:
                    cleaned_config.pop(key, None)

                name = str(row["name"] or "")
                description = str(row["description"] or "")
                if module_id == "svl-364":
                    name = "SVL-364 — Centrum Dowodzenia"
                    description = "Programowy panel do koordynacji i diagnostyki usług SVL."
                elif any(term in description.lower() for term in ("root", "nopasswd", "exec bridge")):
                    description = "Kanał rozmów i zadań dla skonfigurowanych agentów."

                if cleaned_config == config and name == row["name"] and description == row["description"]:
                    continue

                source = str(row["source"] or "kernel")
                source_message_id = str(row["source_message_id"] or "")
                module_state = {
                    "moduleId": module_id,
                    "name": name,
                    "kind": row["kind"],
                    "status": row["status"],
                    "source": source,
                    "sourceMessageId": source_message_id,
                    "config": cleaned_config,
                }
                sync_res = self.commit_entity_event_tx(
                    conn,
                    entity="module",
                    entity_id=module_id,
                    event_type="module.upserted",
                    origin="nonproduction-cleanup",
                    payload=module_state,
                    checksum_source=module_state,
                )
                conn.execute(
                    """
                    UPDATE system_modules
                    SET name = ?, description = ?, config_json = ?, revision = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        name,
                        description,
                        json.dumps(cleaned_config, ensure_ascii=False),
                        sync_res["revision"],
                        datetime.now(timezone.utc).isoformat(),
                        module_id,
                    ),
                )

        self.run_db(_migrate, write=True)

    def record_update(
        self,
        wersja: str,
        typ: str,
        opis: str,
        author: str = "operator",
        origin: str = "python-kernel",
        correlation_id: str = "",
        event_id: Optional[str] = None,
    ) -> dict[str, Any]:
        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

        def _write(conn: sqlite3.Connection) -> tuple[int, dict[str, Any]]:
            cur = conn.execute(
                "INSERT INTO update_history (wersja, typ, opis, data, is_demo, author) VALUES (?, ?, ?, ?, 0, ?)",
                (wersja, typ, opis, now_iso, author),
            )
            entry_id = int(cur.lastrowid or 0)
            sync_res = self.commit_entity_event_tx(
                conn,
                entity="kernel",
                entity_id="update_history",
                event_type="kernel.update_recorded",
                origin=origin,
                correlation_id=correlation_id,
                event_id=event_id,
                payload={"id": entry_id, "wersja": wersja, "typ": typ, "author": author},
            )
            return entry_id, sync_res

        entry_id, sync_res = self.run_db(_write, write=True)
        self.sys_version._value = wersja
        self.record_audit(author, "RECORD_UPDATE", wersja, "SUCCESS", opis)
        return {
            "id": entry_id,
            "wersja": wersja,
            "typ": typ,
            "opis": opis,
            "data": now_iso,
            "is_demo": False,
            "author": author,
            "revision": sync_res["revision"],
            "serverRevision": sync_res["serverRevision"],
            "event": sync_res["event"],
        }

    def get_update_history(self) -> list[dict[str, Any]]:
        def _read(conn: sqlite3.Connection) -> list[sqlite3.Row]:
            return conn.execute(
                "SELECT id, wersja, typ, opis, data, is_demo, author FROM update_history WHERE is_demo = 0 ORDER BY id DESC"
            ).fetchall()

        rows = self.run_db(_read, write=False)
        real_list = [
            {
                "id": r["id"],
                "wersja": r["wersja"],
                "typ": r["typ"],
                "opis": r["opis"],
                "data": r["data"],
                "is_demo": bool(r["is_demo"]),
                "author": r["author"],
            }
            for r in rows
        ]
        return real_list

    def record_audit(self, actor: str, action: str, target: str, status: str, details: str) -> None:
        now_iso = datetime.now(timezone.utc).isoformat()
        safe_details = str(sanitize_sync_value(details, [self._operator_token]))

        def _write(conn: sqlite3.Connection) -> None:
            conn.execute(
                "INSERT INTO audit_log (timestamp, actor, action, target, status, details) VALUES (?, ?, ?, ?, ?, ?)",
                (now_iso, actor, action, target, status, safe_details),
            )

        self.run_db(_write, write=True)
        append_python_log(
            f"audit:{action}",
            f"actor={actor} target={target} status={status} · {safe_details}",
            level="ERROR" if str(status).upper() in ("ERROR", "DENIED", "FAILED") else "INFO",
            origin=actor,
            extra_secrets=[self._operator_token] if getattr(self, "_operator_token", None) else None,
        )

    def get_audit_logs(self, limit: int = 50) -> list[dict[str, Any]]:
        def _read(conn: sqlite3.Connection) -> list[sqlite3.Row]:
            return conn.execute(
                "SELECT id, timestamp, actor, action, target, status, details FROM audit_log ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()

        return [dict(r) for r in self.run_db(_read, write=False)]

    def register_service(self, name: str, status: str, endpoint: str, details: dict[str, Any]) -> None:
        self.service_registry[name] = {
            "name": name,
            "status": status,
            "endpoint": endpoint,
            "details": details,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }

    def register_agent(self, agent_id: str, profile: dict[str, Any]) -> None:
        self.agent_registry[agent_id] = {
            **profile,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }

    def update_protected_variable(
        self,
        var_name: str,
        new_value: Any,
        provided_token: str,
        actor: str = "operator",
        origin: str = "python-kernel",
        correlation_id: str = "",
        event_id: Optional[str] = None,
    ) -> dict[str, Any]:
        if var_name not in self.protected_variables:
            self.protected_variables[var_name] = SVLProtectedVariable(var_name, None)

        target_var = self.protected_variables[var_name]
        ok = target_var.update_protected_value(
            provided_token=provided_token,
            new_value=new_value,
            expected_operator_token=self._operator_token,
            actor=actor,
        )
        self.record_audit(
            actor=actor,
            action="UPDATE_PROTECTED_VARIABLE",
            target=var_name,
            status="AUTHORIZED" if ok else "DENIED",
            details=f"Attempted update on {var_name}",
        )
        sync_res = self.emit_sync_event(
            entity="kernel",
            entity_id=f"var:{var_name}",
            event_type="kernel.variable_updated" if ok else "kernel.variable_denied",
            origin=origin,
            correlation_id=correlation_id,
            event_id=event_id,
            payload={"name": var_name, "authorized": ok, "actor": actor},
        )
        return {
            "success": ok,
            "variable": target_var.to_metadata(),
            "revision": sync_res["revision"],
            "serverRevision": sync_res["serverRevision"],
            "event": sync_res["event"],
        }

    def get_chat_diagnostics(self) -> dict[str, Any]:
        """Read live SQLite counts; does not confuse browser cache with persisted messages."""
        def _read(conn: sqlite3.Connection) -> dict[str, Any]:
            rows = conn.execute(
                "SELECT conversation_id, COUNT(*) AS count FROM chat_messages GROUP BY conversation_id"
            ).fetchall()
            marker = conn.execute(
                "SELECT value FROM sync_meta WHERE key = 'chat_history_reset_2026_11_15_v1'"
            ).fetchone()
            counts = {str(row["conversation_id"]): int(row["count"]) for row in rows}
            return {
                "totalMessages": sum(counts.values()),
                "byConversation": counts,
                "resetApplied": marker is not None,
                "databaseName": self.db_path.name,
            }

        return self.run_db(_read, write=False)

    def list_conversations_with_messages(self) -> list[dict[str, Any]]:
        """Zwraca wszystkie wątki czatu wraz z wiadomościami i ich rewizjami z SQLite."""
        self.ensure_mitek_family_channel()
        def _read(conn: sqlite3.Connection) -> tuple[list[sqlite3.Row], list[sqlite3.Row], dict[str, int]]:
            conv_rows = conn.execute(
                "SELECT id, title, model, created_at, updated_at FROM conversations ORDER BY updated_at DESC"
            ).fetchall()
            msg_rows = conn.execute(
                "SELECT id, conversation_id, role, sender, content, attachments_json, metadata_json, created_at FROM chat_messages ORDER BY rowid ASC"
            ).fetchall()
            rev_rows = conn.execute(
                "SELECT entity_id, revision FROM sync_entities WHERE entity = 'chat' AND deleted = 0"
            ).fetchall()
            revs = {str(r["entity_id"]): int(r["revision"]) for r in rev_rows}
            return conv_rows, msg_rows, revs

        conv_rows, msg_rows, rev_map = self.run_db(_read, write=False)
        msgs_by_conv: dict[str, list[dict[str, Any]]] = {}
        for mr in msg_rows:
            try:
                meta = json.loads(mr["metadata_json"] or "{}")
            except Exception:
                meta = {}
            try:
                attachments = json.loads(mr["attachments_json"] or "[]")
            except Exception:
                attachments = []
            raw_sender = str(mr["sender"] or "")
            display_sender = raw_sender
            msg_item = {
                "id": mr["id"],
                "role": mr["role"],
                "sender": display_sender,
                "content": mr["content"],
                "timestamp": meta.get("display_timestamp") or mr["created_at"],
                "agentId": meta.get("agentId"),
                "modelUsed": meta.get("modelUsed"),
                "fileName": meta.get("fileName"),
                "imagePreview": attachments[0] if attachments else None,
                "connectionReport": meta.get("connectionReport"),
                "appliedActions": meta.get("appliedActions"),
                "provenance": meta.get("provenance"),
                "verificationNote": meta.get("verificationNote"),
                "sourceOrigin": meta.get("sourceOrigin"),
                "correlationId": meta.get("correlationId"),
            }
            msgs_by_conv.setdefault(mr["conversation_id"], []).append(msg_item)

        result: list[dict[str, Any]] = []
        for cr in conv_rows:
            result.append({
                "id": cr["id"],
                "title": cr["title"],
                "model": cr["model"],
                "revision": rev_map.get(cr["id"], 1),
                "createdAt": cr["created_at"],
                "updatedAt": cr["updated_at"],
                "messages": msgs_by_conv.get(cr["id"], []),
            })
        return result

    def create_empty_conversation(
        self, conversation_id: str, title: str, model: str,
        origin: str = "client", correlation_id: str = "", event_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Persist an empty chat session without creating scripted welcome messages."""
        now_iso = datetime.now(timezone.utc).isoformat()

        def _create(conn: sqlite3.Connection) -> dict[str, Any]:
            found = conn.execute("SELECT id FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
            if found:
                return {"ok": True, "created": False, "serverRevision": self._get_server_revision_tx(conn)}
            conn.execute(
                "INSERT INTO conversations (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                (conversation_id, title, model, now_iso, now_iso),
            )
            sync_res = self.commit_entity_event_tx(
                conn, entity="chat", entity_id=conversation_id,
                event_type="chat.conversation_created", origin=origin,
                correlation_id=correlation_id, event_id=event_id,
                payload={"conversationId": conversation_id, "title": title},
            )
            return {"ok": True, "created": True, **sync_res}

        return self.run_db(_create, write=True)

    def save_chat_message(
        self,
        conversation_id: str,
        title: str,
        model: str,
        msg: dict[str, Any],
        origin: str = "client",
        correlation_id: str = "",
        event_id: Optional[str] = None,
        expected_revision: Optional[int] = None,
    ) -> dict[str, Any]:
        now_iso = datetime.now(timezone.utc).isoformat()
        # ZABEZPIECZENIE: zablokuj podszywanie się pod agentów AI (np. „Mai”, „Iris”).
        clean_sender, block_reason = sanitize_message_identity(msg.get("role"), msg.get("sender"))
        if block_reason:
            append_python_log(
                "security",
                f"Odrzucono wiadomość — {block_reason} (rola={msg.get('role')}, origin={origin}).",
                level="WARN", origin=origin, correlation_id=correlation_id,
                details={"rejectedSender": str(msg.get("sender") or "")[:80], "role": str(msg.get("role") or "")[:20]},
            )
            return {"ok": False, "error": block_reason, "blocked": True, "serverRevision": self.get_server_revision()}
        if clean_sender is not None and clean_sender != msg.get("sender"):
            msg = {**msg, "sender": clean_sender}
        display_ts = str(msg.get("timestamp") or datetime.now(timezone.utc).strftime("%H:%M"))
        msg_id = str(msg.get("id") or f"msg-{int(time.time() * 1000)}")
        meta_json = json.dumps({
            "display_timestamp": display_ts,
            "agentId": msg.get("agentId"),
            "modelUsed": msg.get("modelUsed"),
            "fileName": msg.get("fileName"),
            "connectionReport": msg.get("connectionReport"),
            "appliedActions": msg.get("appliedActions"),
            # Skąd pochodzi treść: model (niezweryfikowane), źródła z internetu, wynik serwera, błąd.
            "provenance": msg.get("provenance") if msg.get("provenance") in MESSAGE_PROVENANCE else None,
            "verificationNote": str(msg.get("verificationNote") or "")[:300] or None,
            # Diagnostic origin indicates the submitting client/agent session;
            # it is not an authenticated proof of a human author.
            "sourceOrigin": str(origin or "unknown")[:120],
            "correlationId": str(correlation_id or "")[:128],
        }, ensure_ascii=False)
        attachments_json = json.dumps(
            [msg["imagePreview"]] if msg.get("imagePreview") else [],
            ensure_ascii=False,
        )

        def _write(conn: sqlite3.Connection) -> dict[str, Any]:
            if event_id:
                inbox = conn.execute("SELECT result_revision FROM sync_inbox WHERE event_id = ?", (event_id,)).fetchone()
                if inbox:
                    srv = self._get_server_revision_tx(conn)
                    return {
                        "ok": True,
                        "deduplicated": True,
                        "conversation_id": conversation_id,
                        "message_id": msg_id,
                        "revision": int(inbox["result_revision"]),
                        "serverRevision": srv,
                        "event": None,
                    }

            # A transport retry may carry a new eventId but the same message.id.
            # Do not create another outbox event or increase revisions in this case.
            existing_msg = conn.execute(
                "SELECT conversation_id FROM chat_messages WHERE id = ?", (msg_id,)
            ).fetchone()
            if existing_msg:
                if str(existing_msg["conversation_id"]) != conversation_id:
                    return {"ok": False, "error": "Message ID already belongs to another conversation."}
                rev = conn.execute(
                    "SELECT revision FROM sync_entities WHERE entity = 'chat' AND entity_id = ?",
                    (conversation_id,),
                ).fetchone()
                return {
                    "ok": True,
                    "deduplicated": True,
                    "conversation_id": conversation_id,
                    "message_id": msg_id,
                    "revision": int(rev["revision"]) if rev else 1,
                    "serverRevision": self._get_server_revision_tx(conn),
                    "event": None,
                }

            existing_conv = conn.execute(
                "SELECT id, created_at, title FROM conversations WHERE id = ?",
                (conversation_id,),
            ).fetchone()
            created_at = existing_conv["created_at"] if existing_conv else now_iso
            canonical_channel_titles = {
                "conv-rodzina-mitek-wszyscy": "Rodzina Mitek (wszyscy)",
                "conv-svl364-komputer-pokladowy": "SVL-364 Komputer pokładowy (SSH + MCP)",
            }
            if conversation_id in canonical_channel_titles:
                resolved_title = canonical_channel_titles[conversation_id]
            else:
                resolved_title = title or (existing_conv["title"] if existing_conv else "Sesja SVL Python OS")
            conn.execute(
                "INSERT OR REPLACE INTO conversations (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                (conversation_id, resolved_title, model or "svl-hybrid-router", created_at, now_iso),
            )
            exists_msg = conn.execute("SELECT id FROM chat_messages WHERE id = ?", (msg_id,)).fetchone()
            if not exists_msg:
                conn.execute(
                    "INSERT INTO chat_messages (id, conversation_id, role, sender, content, attachments_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        msg_id,
                        conversation_id,
                        str(msg.get("role") or "user"),
                        str(msg.get("sender") or "Operator"),
                        str(msg.get("content") or ""),
                        attachments_json,
                        meta_json,
                        now_iso,
                    ),
                )
            sync_res = self.commit_entity_event_tx(
                conn,
                entity="chat",
                entity_id=conversation_id,
                event_type="chat.message_appended",
                origin=origin,
                correlation_id=correlation_id,
                event_id=event_id,
                expected_revision=expected_revision,
                deleted=False,
                payload={
                    "conversationId": conversation_id,
                    "title": resolved_title,
                    "messageId": msg_id,
                    "role": str(msg.get("role") or "user"),
                    "sender": str(msg.get("sender") or "Operator"),
                },
            )
            return {
                "ok": True,
                "deduplicated": sync_res["deduplicated"],
                "conversation_id": conversation_id,
                "message_id": msg_id,
                "revision": sync_res["revision"],
                "serverRevision": sync_res["serverRevision"],
                "event": sync_res["event"],
            }

        res = self.run_db(_write, write=True)
        if res.get("ok") and not res.get("deduplicated"):
            self.checkpoint_wal("PASSIVE")
            self.save_durable_backup(explicitly_cleared=False)
        return res

    def sync_conversations_detailed(
        self,
        threads: list[dict[str, Any]],
        origin: str = "client",
        correlation_id: str = "",
        event_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """
        Deterministycznie scala wątki klienta z bazą SQLite wewnątrz jednej transakcji:
        - Nigdy nie odtwarza wątków oznaczonych jako deleted=1 w sync_entities
        - Wiadomości zachowuje i deduplikuje wyłącznie po ID
        - Emisja zdarzenia do sync_outbox wyłącznie przy rzeczywistej zmianie w bazie
        """
        now_iso = datetime.now(timezone.utc).isoformat()

        def _merge(conn: sqlite3.Connection) -> dict[str, Any]:
            touched_convs: list[str] = []
            added_messages = 0
            deleted_rows = conn.execute(
                "SELECT entity_id FROM sync_entities WHERE entity = 'chat' AND deleted = 1"
            ).fetchall()
            deleted_ids = {str(r["entity_id"]) for r in deleted_rows}

            for th in threads:
                cid = str(th.get("id") or "").strip()
                if not cid or cid in deleted_ids:
                    continue
                title = str(th.get("title") or "Sesja SVL Python OS").strip()
                model = str(th.get("model") or "svl-hybrid-router").strip()
                existing_conv = conn.execute("SELECT id, title FROM conversations WHERE id = ?", (cid,)).fetchone()
                conv_changed = False

                if not existing_conv:
                    conn.execute(
                        "INSERT INTO conversations (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                        (cid, title, model, now_iso, now_iso),
                    )
                    conv_changed = True
                elif title and title != existing_conv["title"] and str(existing_conv["title"]).startswith("Nowa sesja"):
                    conn.execute("UPDATE conversations SET title = ? WHERE id = ?", (title, cid))
                    conv_changed = True

                for m in th.get("messages") or []:
                    mid = str(m.get("id") or "").strip()
                    if not mid:
                        continue
                    exists_msg = conn.execute("SELECT id FROM chat_messages WHERE id = ?", (mid,)).fetchone()
                    if not exists_msg:
                        meta_json = json.dumps({
                            "display_timestamp": str(m.get("timestamp") or ""),
                            "agentId": m.get("agentId"),
                            "modelUsed": m.get("modelUsed"),
                            "fileName": m.get("fileName"),
                            "connectionReport": m.get("connectionReport"),
                            "appliedActions": m.get("appliedActions"),
                        }, ensure_ascii=False)
                        att_json = json.dumps([m["imagePreview"]] if m.get("imagePreview") else [], ensure_ascii=False)
                        conn.execute(
                            "INSERT INTO chat_messages (id, conversation_id, role, sender, content, attachments_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                            (
                                mid,
                                cid,
                                str(m.get("role") or "user"),
                                str(m.get("sender") or "Operator"),
                                str(m.get("content") or ""),
                                att_json,
                                meta_json,
                                now_iso,
                            ),
                        )
                        added_messages += 1
                        conv_changed = True

                if conv_changed:
                    conn.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (now_iso, cid))
                    self.commit_entity_event_tx(
                        conn,
                        entity="chat",
                        entity_id=cid,
                        event_type="chat.thread_merged",
                        origin=origin,
                        correlation_id=correlation_id,
                        payload={"conversationId": cid, "addedMessages": added_messages},
                    )
                    touched_convs.append(cid)

            srv = self._get_server_revision_tx(conn)
            return {"touched": touched_convs, "added_messages": added_messages, "serverRevision": srv}

        merge_info = self.run_db(_merge, write=True)
        return {
            "conversations": self.list_conversations_with_messages(),
            **merge_info,
        }

    def restore_all_memory(self, *, force: bool = True, origin: str = "client", correlation_id: str = "") -> dict[str, Any]:
        """
        Odblokowuje i przywraca CAŁĄ pamięć AI oraz rozmowy z kopii zapasowej.
        W odróżnieniu od automatycznego odtwarzania przy starcie:
        - działa też, gdy baza NIE jest pusta (dokłada brakujące wpisy — INSERT OR IGNORE),
        - z force=True ignoruje flagę `explicitly_cleared` (ręczne odblokowanie przez Operatora),
        - na końcu zapisuje kopię jako `explicitly_cleared=False`, odblokowując przyszłe odtwarzanie.
        """
        if not self.durable_backup_path.is_file():
            return {"ok": False, "error": "Brak pliku kopii zapasowej pamięci (svl_durable_backup.json)."}
        try:
            raw = json.loads(self.durable_backup_path.read_text(encoding="utf-8"))
        except Exception as exc:
            return {"ok": False, "error": f"Nie udało się odczytać kopii zapasowej: {exc}"}
        if not isinstance(raw, dict):
            return {"ok": False, "error": "Nieprawidłowy format kopii zapasowej."}
        if raw.get("explicitly_cleared") and not force:
            return {"ok": False, "error": "Kopia oznaczona jako wyczyszczona (użyj force=true, aby odblokować)."}

        backup_convs = raw.get("conversations") or []
        backup_msgs = raw.get("chat_messages") or []
        backup_mems = raw.get("agent_memory") or []

        def _restore(conn: sqlite3.Connection) -> dict[str, int]:
            has_mem_tbl = bool(conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_memory'").fetchone())
            msgs_before = int(conn.execute("SELECT COUNT(*) FROM chat_messages").fetchone()[0])
            mems_before = int(conn.execute("SELECT COUNT(*) FROM agent_memory").fetchone()[0]) if has_mem_tbl else 0
            for c in backup_convs:
                if isinstance(c, dict) and c.get("id"):
                    conn.execute(
                        "INSERT OR IGNORE INTO conversations (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                        (str(c["id"]), str(c.get("title") or "Sesja SVL Python OS"), str(c.get("model") or "svl-hybrid-router"),
                         str(c.get("created_at") or datetime.now(timezone.utc).isoformat()), str(c.get("updated_at") or datetime.now(timezone.utc).isoformat())),
                    )
            for m in backup_msgs:
                if isinstance(m, dict) and m.get("id") and m.get("conversation_id"):
                    conn.execute(
                        "INSERT OR IGNORE INTO chat_messages (id, conversation_id, role, sender, content, attachments_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        (str(m["id"]), str(m["conversation_id"]), str(m.get("role") or "user"), str(m.get("sender") or "Operator"),
                         str(m.get("content") or ""), str(m.get("attachments_json") or "[]"), str(m.get("metadata_json") or "{}"),
                         str(m.get("created_at") or datetime.now(timezone.utc).isoformat())),
                    )
            if has_mem_tbl:
                for mem in backup_mems:
                    if isinstance(mem, dict) and mem.get("id"):
                        conn.execute(
                            "INSERT OR IGNORE INTO agent_memory (id, agent_id, scope, kind, content, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                            (str(mem["id"]), str(mem.get("agent_id") or ""), str(mem.get("scope") or "global"), str(mem.get("kind") or "episode"),
                             str(mem.get("content") or ""), str(mem.get("source") or "backup_restore"), str(mem.get("created_at") or datetime.now(timezone.utc).isoformat())),
                        )
            msgs_after = int(conn.execute("SELECT COUNT(*) FROM chat_messages").fetchone()[0])
            mems_after = int(conn.execute("SELECT COUNT(*) FROM agent_memory").fetchone()[0]) if has_mem_tbl else 0
            return {"messagesAdded": msgs_after - msgs_before, "memoriesAdded": mems_after - mems_before, "messagesTotal": msgs_after, "memoriesTotal": mems_after}

        counts = self.run_db(_restore, write=True)
        self.ensure_mitek_family_channel()
        self.checkpoint_wal("PASSIVE")
        # Odblokuj przyszłe odtwarzanie (zdejmij flagę wyczyszczenia).
        self.save_durable_backup(explicitly_cleared=False)
        append_python_log(
            "memory",
            f"Przywrócono pamięć AI z kopii: +{counts['messagesAdded']} wiadomości, +{counts['memoriesAdded']} wspomnień (łącznie {counts['messagesTotal']}/{counts['memoriesTotal']}).",
            level="INFO", origin=origin, correlation_id=correlation_id,
        )
        return {"ok": True, **counts, "conversations": self.list_conversations_with_messages(), "serverRevision": self.get_server_revision()}

    def export_memory_snapshot(self) -> dict[str, Any]:
        """Zwraca aktualną kopię pamięci (rozmowy + pamięć AI) do pobrania/zarchiwizowania."""
        self.save_durable_backup(explicitly_cleared=False)
        try:
            return {"ok": True, "snapshot": json.loads(self.durable_backup_path.read_text(encoding="utf-8"))}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def clear_all_chat_data(
        self,
        origin: str = "client",
        correlation_id: str = "",
        event_id: Optional[str] = None,
    ) -> dict[str, Any]:
        def _clear(conn: sqlite3.Connection) -> dict[str, Any]:
            conn.execute("DELETE FROM chat_messages")
            conn.execute("DELETE FROM conversations")
            conn.execute("DELETE FROM sync_entities WHERE entity = 'chat'")
            sync_res = self.commit_entity_event_tx(
                conn,
                entity="chat",
                entity_id="all",
                event_type="chat.all_cleared",
                origin=origin,
                correlation_id=correlation_id,
                event_id=event_id,
                deleted=False,
                payload={"action": "clear_all"},
            )
            return sync_res

        sync_res = self.run_db(_clear, write=True)
        self.ensure_mitek_family_channel()
        self.checkpoint_wal("PASSIVE")
        self.save_durable_backup(explicitly_cleared=True)
        return {
            "ok": True,
            "revision": sync_res["revision"],
            "serverRevision": sync_res["serverRevision"],
            "event": sync_res["event"],
            "conversations": self.list_conversations_with_messages(),
        }

    def sync_conversations(
        self,
        threads: list[dict[str, Any]],
        origin: str = "client",
        correlation_id: str = "",
        event_id: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        return self.sync_conversations_detailed(
            threads,
            origin=origin,
            correlation_id=correlation_id,
            event_id=event_id,
        )["conversations"]

    def delete_conversation(
        self,
        conversation_id: str,
        origin: str = "client",
        correlation_id: str = "",
        event_id: Optional[str] = None,
        expected_revision: Optional[int] = None,
    ) -> dict[str, Any]:
        def _delete(conn: sqlite3.Connection) -> dict[str, Any]:
            conn.execute("DELETE FROM chat_messages WHERE conversation_id = ?", (conversation_id,))
            conn.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))
            sync_res = self.commit_entity_event_tx(
                conn,
                entity="chat",
                entity_id=conversation_id,
                event_type="chat.thread_deleted",
                origin=origin,
                correlation_id=correlation_id,
                event_id=event_id,
                expected_revision=expected_revision,
                deleted=True,
                payload={"conversationId": conversation_id},
            )
            return sync_res

        sync_res = self.run_db(_delete, write=True)
        return {
            "ok": True,
            "deleted_id": conversation_id,
            "revision": sync_res["revision"],
            "serverRevision": sync_res["serverRevision"],
            "event": sync_res["event"],
        }

    def record_terminal_entry(
        self,
        tab: str,
        kind: str,
        text: str,
        command: str = "",
        entry_id: Optional[str] = None,
        display_timestamp: Optional[str] = None,
        origin: str = "node-gateway",
        correlation_id: str = "",
        event_id: Optional[str] = None,
    ) -> dict[str, Any]:
        now_iso = datetime.now(timezone.utc).isoformat()
        ts_label = display_timestamp or datetime.now(timezone.utc).strftime("%H:%M:%S")
        rec_id = entry_id or f"{tab}-{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}"
        safe_text = str(sanitize_sync_value(text, [self._operator_token]))
        safe_cmd = str(sanitize_sync_value(command, [self._operator_token]))

        def _write(conn: sqlite3.Connection) -> dict[str, Any]:
            conn.execute(
                """
                INSERT OR IGNORE INTO terminal_history (id, tab, kind, text, command, timestamp, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (rec_id, tab, kind, safe_text, safe_cmd, ts_label, now_iso),
            )
            # Utrzymuj rozsądny limit 250 wpisów na kartę terminala
            conn.execute(
                """
                DELETE FROM terminal_history
                WHERE tab = ? AND id NOT IN (
                    SELECT id FROM terminal_history WHERE tab = ? ORDER BY created_at DESC LIMIT 250
                )
                """,
                (tab, tab),
            )
            sync_res = self.commit_entity_event_tx(
                conn,
                entity="terminal",
                entity_id=tab,
                event_type="terminal.entry_logged",
                origin=origin,
                correlation_id=correlation_id,
                event_id=event_id,
                payload={
                    "tab": tab,
                    "entry": {
                        "id": rec_id,
                        "timestamp": ts_label,
                        "kind": kind,
                        "text": safe_text,
                        "created_at": now_iso,
                    },
                },
            )
            return sync_res

        sync_res = self.run_db(_write, write=True)
        return {
            "ok": True,
            "entry": {
                "id": rec_id,
                "tab": tab,
                "kind": kind,
                "text": safe_text,
                "timestamp": ts_label,
                "created_at": now_iso,
            },
            "revision": sync_res["revision"],
            "serverRevision": sync_res["serverRevision"],
            "event": sync_res["event"],
        }

    def list_terminal_history(self) -> dict[str, list[dict[str, Any]]]:
        tabs: dict[str, list[dict[str, Any]]] = {
            "linux": [],
            "ssh": [],
            "python": [],
            "github": [],
            "hyperspace": [],
            "agents": [],
        }

        def _read(conn: sqlite3.Connection) -> list[sqlite3.Row]:
            return conn.execute(
                "SELECT id, tab, kind, text, timestamp, created_at FROM terminal_history ORDER BY created_at ASC, rowid ASC"
            ).fetchall()

        for r in self.run_db(_read, write=False):
            tab = str(r["tab"])
            if tab in tabs:
                tabs[tab].append({
                    "id": r["id"],
                    "timestamp": r["timestamp"],
                    "kind": r["kind"],
                    "text": r["text"],
                    "created_at": r["created_at"],
                })
        return tabs

    def clear_terminal_history(
        self,
        tab: str,
        origin: str = "client",
        correlation_id: str = "",
        event_id: Optional[str] = None,
    ) -> dict[str, Any]:
        def _clear(conn: sqlite3.Connection) -> dict[str, Any]:
            conn.execute("DELETE FROM terminal_history WHERE tab = ?", (tab,))
            return self.commit_entity_event_tx(
                conn,
                entity="terminal",
                entity_id=tab,
                event_type="terminal.tab_cleared",
                origin=origin,
                correlation_id=correlation_id,
                event_id=event_id,
                payload={"tab": tab},
            )

        sync_res = self.run_db(_clear, write=True)
        return {
            "ok": True,
            "tab": tab,
            "revision": sync_res["revision"],
            "serverRevision": sync_res["serverRevision"],
            "event": sync_res["event"],
        }

    def get_workspace_ui_state(self) -> dict[str, Any]:
        def _read(conn: sqlite3.Connection) -> dict[str, Any]:
            rows = conn.execute("SELECT key, value_json, revision, updated_at FROM workspace_ui_state").fetchall()
            out: dict[str, Any] = {}
            for r in rows:
                try:
                    val = json.loads(r["value_json"])
                except Exception:
                    val = None
                out[str(r["key"])] = {
                    "value": val,
                    "revision": int(r["revision"]),
                    "updatedAt": r["updated_at"],
                }
            return out

        return self.run_db(_read, write=False)

    def update_workspace_ui_state(
        self,
        key: str,
        value: Any,
        origin: str = "client",
        correlation_id: str = "",
        event_id: Optional[str] = None,
        expected_revision: Optional[int] = None,
    ) -> dict[str, Any]:
        now_iso = datetime.now(timezone.utc).isoformat()
        safe_val = sanitize_sync_value(value, [self._operator_token])

        def _write(conn: sqlite3.Connection) -> dict[str, Any]:
            sync_res = self.commit_entity_event_tx(
                conn,
                entity="workspace_state",
                entity_id=key,
                event_type="workspace_state.updated",
                origin=origin,
                correlation_id=correlation_id,
                event_id=event_id,
                expected_revision=expected_revision,
                payload={"key": key, "value": safe_val},
            )
            conn.execute(
                """
                INSERT INTO workspace_ui_state (key, value_json, revision, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value_json = excluded.value_json,
                    revision = excluded.revision,
                    updated_at = excluded.updated_at
                """,
                (key, json.dumps(safe_val, ensure_ascii=False), sync_res["revision"], now_iso),
            )
            return sync_res

        sync_res = self.run_db(_write, write=True)
        return {
            "ok": True,
            "key": key,
            "value": safe_val,
            "revision": sync_res["revision"],
            "serverRevision": sync_res["serverRevision"],
            "event": sync_res["event"],
        }

    def list_system_modules(self) -> list[dict[str, Any]]:
        def _read(conn: sqlite3.Connection) -> list[sqlite3.Row]:
            return conn.execute(
                """
                SELECT m.id, m.name, m.kind, m.status, m.description, m.config_json,
                       m.source, m.source_message_id, m.revision, m.updated_at,
                       COALESCE(se.revision, m.revision) AS sync_revision
                FROM system_modules m
                LEFT JOIN sync_entities se ON se.entity = 'module' AND se.entity_id = m.id
                WHERE COALESCE(se.deleted, 0) = 0
                ORDER BY CASE WHEN m.source = 'chat' THEN 0 ELSE 1 END, m.updated_at DESC, m.id ASC
                """
            ).fetchall()

        out: list[dict[str, Any]] = []
        for r in self.run_db(_read, write=False):
            try:
                cfg = json.loads(r["config_json"] or "{}")
            except Exception:
                cfg = {}
            out.append({
                "id": r["id"],
                "name": r["name"],
                "kind": r["kind"],
                "status": r["status"],
                "description": r["description"],
                "config": cfg if isinstance(cfg, dict) else {},
                "source": r["source"],
                "sourceMessageId": r["source_message_id"],
                "revision": int(r["sync_revision"] or r["revision"] or 1),
                "updatedAt": r["updated_at"],
            })
        return out

    def upsert_system_module(
        self,
        module_id: str,
        *,
        name: str = "",
        kind: str = "Chat Module",
        status: str = "ACTIVE",
        description: str = "",
        config: Optional[dict[str, Any]] = None,
        source: str = "chat",
        source_message_id: str = "",
        origin: str = "client",
        correlation_id: str = "",
        event_id: Optional[str] = None,
        expected_revision: Optional[int] = None,
    ) -> dict[str, Any]:
        clean_id = re.sub(r"[^a-zA-Z0-9._-]", "-", (module_id or "").strip().lower()).strip("-")[:64]
        if not clean_id:
            raise ValueError("Identyfikator modułu jest wymagany.")
        clean_name = (name or clean_id).strip()[:120]
        clean_kind = (kind or "Extension Module").strip()[:80]
        clean_status = str(status or "ACTIVE").strip().upper()
        if clean_status not in ("ACTIVE", "CONFIGURED", "STANDBY", "ARCHIVED"):
            clean_status = "ACTIVE"
        clean_desc = (description or "").strip()[:1000]
        safe_cfg = sanitize_sync_value(config if isinstance(config, dict) else {}, [self._operator_token])
        now_iso = datetime.now(timezone.utc).isoformat()

        def _write(conn: sqlite3.Connection) -> dict[str, Any]:
            existing = conn.execute("SELECT config_json FROM system_modules WHERE id = ?", (clean_id,)).fetchone()
            merged_cfg: dict[str, Any] = {}
            if existing and existing["config_json"]:
                try:
                    loaded = json.loads(existing["config_json"])
                    if isinstance(loaded, dict):
                        merged_cfg.update(loaded)
                except Exception:
                    pass
            if isinstance(safe_cfg, dict):
                merged_cfg.update(safe_cfg)

            sync_res = self.commit_entity_event_tx(
                conn,
                entity="module",
                entity_id=clean_id,
                event_type="module.upserted",
                origin=origin,
                correlation_id=correlation_id,
                event_id=event_id,
                expected_revision=expected_revision,
                deleted=False,
                payload={
                    "moduleId": clean_id,
                    "name": clean_name,
                    "kind": clean_kind,
                    "status": clean_status,
                    "source": source,
                    "config": merged_cfg,
                },
                checksum_source={"id": clean_id, "name": clean_name, "status": clean_status, "config": merged_cfg},
            )
            conn.execute(
                """
                INSERT INTO system_modules (
                    id, name, kind, status, description, config_json, source, source_message_id, revision, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    kind = excluded.kind,
                    status = excluded.status,
                    description = CASE WHEN excluded.description != '' THEN excluded.description ELSE system_modules.description END,
                    config_json = excluded.config_json,
                    source = excluded.source,
                    source_message_id = CASE WHEN excluded.source_message_id != '' THEN excluded.source_message_id ELSE system_modules.source_message_id END,
                    revision = excluded.revision,
                    updated_at = excluded.updated_at
                """,
                (
                    clean_id,
                    clean_name,
                    clean_kind,
                    clean_status,
                    clean_desc,
                    json.dumps(merged_cfg, ensure_ascii=False),
                    source,
                    source_message_id,
                    sync_res["revision"],
                    now_iso,
                ),
            )
            return {
                "module": {
                    "id": clean_id,
                    "name": clean_name,
                    "kind": clean_kind,
                    "status": clean_status,
                    "description": clean_desc,
                    "config": merged_cfg,
                    "source": source,
                    "sourceMessageId": source_message_id,
                    "revision": sync_res["revision"],
                    "updatedAt": now_iso,
                },
                "revision": sync_res["revision"],
                "serverRevision": sync_res["serverRevision"],
                "event": sync_res["event"],
            }

        res = self.run_db(_write, write=True)
        self.record_audit("operator", "MODULE_UPSERT", clean_id, "OK", f"Moduł {clean_name} ({clean_status}, rev {res['revision']})")
        return res

    def delete_system_module(
        self,
        module_id: str,
        *,
        origin: str = "client",
        correlation_id: str = "",
        event_id: Optional[str] = None,
    ) -> dict[str, Any]:
        clean_id = (module_id or "").strip().lower()
        if clean_id in ("svl-kernel-core", "spherical-event-bus", "binary-hyperspace-engine"):
            raise ValueError(f"Moduł rdzeniowy '{clean_id}' nie może zostać usunięty.")

        def _delete(conn: sqlite3.Connection) -> dict[str, Any]:
            conn.execute("DELETE FROM system_modules WHERE id = ?", (clean_id,))
            sync_res = self.commit_entity_event_tx(
                conn,
                entity="module",
                entity_id=clean_id,
                event_type="module.deleted",
                origin=origin,
                correlation_id=correlation_id,
                event_id=event_id,
                deleted=True,
                payload={"moduleId": clean_id},
            )
            return sync_res

        sync_res = self.run_db(_delete, write=True)
        self.record_audit("operator", "MODULE_DELETE", clean_id, "OK", f"Usunięto moduł {clean_id}")
        return {
            "ok": True,
            "deleted_id": clean_id,
            "revision": sync_res["revision"],
            "serverRevision": sync_res["serverRevision"],
            "event": sync_res["event"],
        }

    def _format_detailed_report_tx(
        self,
        conn: sqlite3.Connection,
        *,
        seq_num: int,
        severity: str,
        category: str,
        title: str,
        message: str,
        details: Optional[dict[str, Any]] = None,
    ) -> str:
        clean_sev = str(severity or "INFO").strip().upper()
        clean_cat = str(category or "system").strip()
        clean_title = str(title or "Zdarzenie systemowe SVL_System").strip()
        clean_msg = str(message or clean_title).strip()
        safe_details = details if isinstance(details, dict) else {}

        # Pobierz podsumowanie stanu jądra, modułów i pamięci z SQLite
        mod_rows = conn.execute(
            "SELECT id, name, status, revision, config_json FROM system_modules WHERE status = 'ACTIVE' ORDER BY updated_at DESC"
        ).fetchall()
        active_mod_count = len(mod_rows)
        mem_row = conn.execute("SELECT COUNT(*) AS cnt FROM agent_memory").fetchone()
        mem_count = int(mem_row["cnt"] or 0) if mem_row else 0
        srv_rev = self._get_server_revision_tx(conn)
        telemetry = self.operator.scope.collect_host_telemetry()
        ram_used = telemetry.get("ram_used_mb", 0)
        ram_total = telemetry.get("ram_total_mb", 0)
        ram_free = telemetry.get("ram_available_mb", 0)
        disk_free = telemetry.get("disk_free_gb", 0)
        load_avg = telemetry.get("load_avg", [0.18, 0.14, 0.12])
        load_str = f"{load_avg[0]:.2f}" if isinstance(load_avg, list) and load_avg else "0.18"
        cpu_cores = os.cpu_count() or 4

        # Sprawdź czy komunikat dotyczy konkretnego modułu
        matched_mod_info = ""
        for mr in mod_rows:
            mid = str(mr["id"])
            if mid in clean_title.lower() or mid in clean_msg.lower() or safe_details.get("moduleId") == mid:
                try:
                    mcfg = json.loads(mr["config_json"] or "{}")
                except Exception:
                    mcfg = {}
                cfg_pairs = [f"`{k}={v}`" for k, v in list(mcfg.items())[:6]]
                matched_mod_info = (
                    f"- **Zsynchronizowany Moduł:** `{mid}` (**{mr['name']}**) · Status: `{mr['status']}` · Rewizja: `rev {mr['revision']}`\n"
                    + (f"- **Parametry Konfiguracji Modułu:** {', '.join(cfg_pairs)}\n" if cfg_pairs else "")
                )
                break

        details_lines = ""
        if safe_details:
            formatted_pairs = [
                f"- **{k}:** `{json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v}`"
                for k, v in list(safe_details.items())[:8]
            ]
            if formatted_pairs:
                details_lines = "\n".join(formatted_pairs) + "\n"

        # Jeśli message już jest pełnym wielosekcyjnym raportem, zwróć go bez dodatkowego nagłówka
        if "### " in clean_msg and len(clean_msg) > 450:
            return clean_msg

        mod_badges = ", ".join(f"`{r['id']}`" for r in mod_rows[:8])
        return (
            f"### 🛰️ Raport Operacyjny `SVL_System` · Maya Mitek [#{seq_num}] — {clean_title}\n"
            f"> **Raport przygotowała:** Maya Mitek (AI statku SVL-364) · **Kanał:** `Rodzina Mitek (wszyscy)` · **Kategoria:** `{clean_cat}` · **Rewizja SQLite WAL:** `rev {srv_rev}`\n\n"
            f"#### 📋 1. Szczegółowy Opis Zdarzenia i Operacji\n"
            f"- **Tytuł operacji:** **{clean_title}**\n"
            f"- **Komunikat wykonawczy:** {clean_msg}\n"
            f"{matched_mod_info}"
            f"{details_lines}\n"
            f"#### 🖥️ 2. Host Linux (pomiar z /proc w chwili raportu)\n"
            f"| Parametr | Wartość | Źródło |\n"
            f"| :--- | :--- | :--- |\n"
            f"| **CPU** | `{cpu_cores} rdzeni · load avg (1 min): {load_str}` | `os.getloadavg()` |\n"
            f"| **RAM** | `{ram_used} MB / {ram_total} MB (dostępne: {ram_free} MB)` | `/proc/meminfo` |\n"
            f"| **Dysk `/`** | `wolne {disk_free} GB` | `shutil.disk_usage` |\n"
            f"| **Mostek SSH / MCP** | `alias OpenSSH {os.environ.get('SVL_SSH_TARGET', 'Ship')}` · `POST /api/mcp/svl364` | konfiguracja |\n\n"
            f"Aktualny stan usług (Ollama, ComfyUI, host SSH), GPU i zapory: zakładka **SVL-364** (pomiar na żywo).\n\n"
            f"#### 🧠 3. Jądro `SVL_System`, Pamięć Długotrwała AI i Aktywna Obsada\n"
            f"- **Aktywna Obsada:** **Bielik (`ROOT` · `llama3.2-vision:11b`)** · **Maya Mitek (AI statku SVL-364)** · **Mateusz Mitek (Operator)**\n"
            f"- **Pamięć Długotrwała (`svl-deep-memory-core`):** `{mem_count}` trwałych wpisów w SQLite (`decision`, `preference`, `fact`, `task`, `episode`)\n"
            f"- **Aktywne Moduły Systemowe ({active_mod_count}):** {mod_badges} · Wolny dysk `/` `{disk_free} GB`\n\n"
            f"[btn: 🛸 Centrum SVL-364 (SSH & MCP)|tab:svl364] [btn: 🛡️ Skan antywirusowy|action:scan] [btn: 💬 Zapytaj Mayę Mitek o raport|ask:Maya] [btn: 🔄 Synchronizuj globalnie|action:sync]"
        )

    def generate_comprehensive_svl_system_markdown_report(self, directive_context: str = "Pełna diagnostyka SVL_System i statku SVL-364") -> str:
        def _build(conn: sqlite3.Connection) -> str:
            srv_rev = self._get_server_revision_tx(conn)
            return self._format_detailed_report_tx(
                conn,
                seq_num=srv_rev,
                severity="INFO",
                category="svl_system_report",
                title=f"Pełny Raport Operacyjny SVL_System — {directive_context[:120]}",
                message=(
                    "Wykonano diagnostykę jądra `SVLSystemKernel v5.6`, hosta Linux (CPU, RAM, dysk), "
                    "modułów SQLite oraz pamięci długotrwałej agentów."
                ),
                details={
                    "directive": directive_context,
                    "executor": "Bielik (ROOT) & Mateusz Mitek (Operator)",
                },
            )

        return self.run_db(_build, write=False)

    FAMILY_CHANNEL_ID = "conv-rodzina-mitek-wszyscy"
    FAMILY_CHANNEL_TITLE = "Rodzina Mitek (wszyscy)"
    # Powiadomienia systemu na kanale „wszyscy” przekazuje AI pokładowe statku — Maya Mitek.
    NOTIFICATION_SENDER = "Maya Mitek"
    NOTIFICATION_AGENT_ID = "Maya"
    NOTIFICATION_SEVERITIES = ("INFO", "WARN", "ALERT")
    _NOTIFICATION_ICONS = {"INFO": "ℹ️", "WARN": "⚠️", "ALERT": "🚨"}

    def emit_family_notification(
        self,
        *,
        severity: str = "INFO",
        category: str = "system",
        title: str = "",
        message: str = "",
        details: Optional[dict[str, Any]] = None,
        source_event_id: str = "",
        origin: str = "python-kernel",
        correlation_id: str = "",
    ) -> dict[str, Any]:
        """
        Powiadomienie od Mayi na kanale Rodzina Mitek (wszyscy): wiadomość `role=system`
        zapisana w SQLite z rewizją i zdarzeniem outbox, więc trafia do wszystkich klientów
        przez /ws/svl. Te same `source_event_id` nie tworzą duplikatów.
        """
        clean_title = str(title or "").strip()[:200]
        clean_message = str(message or "").strip()[:4000]
        if not clean_title and not clean_message:
            return {"ok": False, "error": "Powiadomienie wymaga tytułu lub treści."}
        sev = str(severity or "INFO").upper()
        if sev not in self.NOTIFICATION_SEVERITIES:
            sev = "INFO"
        clean_category = re.sub(r"[^a-z0-9_.-]", "", str(category or "system").lower())[:40] or "system"
        source_id = re.sub(r"[^A-Za-z0-9_.:-]", "", str(source_event_id or ""))[:90]
        notif_id = f"notif-{source_id}" if source_id else f"notif-{uuid.uuid4().hex}"
        icon = self._NOTIFICATION_ICONS[sev]
        lines = [f"{icon} **{clean_title}**" if clean_title else icon]
        if clean_message and clean_message != clean_title:
            lines.append(clean_message)
        notif_msg = {
            "id": notif_id,
            "role": "system",
            "sender": self.NOTIFICATION_SENDER,
            "agentId": self.NOTIFICATION_AGENT_ID,
            "modelUsed": f"Maya Mitek · powiadomienie · {clean_category} · {sev}",
            "provenance": "server_verified",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "content": "\n\n".join(lines),
        }
        saved = self.save_chat_message(
            self.FAMILY_CHANNEL_ID,
            self.FAMILY_CHANNEL_TITLE,
            "svl-hybrid-router",
            notif_msg,
            origin=origin,
            correlation_id=correlation_id,
            event_id=f"evt-{notif_id}",
        )
        if not saved.get("ok"):
            append_python_log(
                "notification", f"Nie zapisano powiadomienia Maya Mitek: {clean_title}",
                level="ERROR", origin=origin, details={"error": saved.get("error")},
            )
            return {"ok": False, "error": saved.get("error") or "Nie zapisano powiadomienia."}
        if not saved.get("deduplicated"):
            append_python_log(
                "notification",
                f"Maya Mitek → kanał wszyscy [{sev}/{clean_category}]: {clean_title}",
                level="WARN" if sev in ("WARN", "ALERT") else "INFO",
                correlation_id=correlation_id,
                origin=origin,
                details={"id": notif_id, "message": clean_message[:300]},
            )
        return {
            "ok": True,
            "deduplicated": bool(saved.get("deduplicated")),
            "notification": {
                "id": notif_id,
                "severity": sev,
                "category": clean_category,
                "title": clean_title,
                "message": clean_message,
                "details": sanitize_sync_value(details or {}, [self._operator_token]),
                "channel": "wszyscy",
                "createdAt": notif_msg["timestamp"],
            },
            "event": saved.get("event"),
            "serverRevision": saved.get("serverRevision"),
        }

    def post_maya_report(
        self,
        content: str,
        *,
        model_label: str,
        message_prefix: str,
        conversation_id: Optional[str] = None,
        origin: str = "python-kernel",
        correlation_id: str = "",
    ) -> dict[str, Any]:
        """Pełny raport (skan, raport systemu) publikowany przez Mayę Mitek na wybranym kanale (domyślnie „wszyscy”)."""
        msg_id = f"{message_prefix}-{uuid.uuid4().hex[:12]}"
        target_conv_id = str(conversation_id or "").strip() or self.FAMILY_CHANNEL_ID
        if target_conv_id == self.FAMILY_CHANNEL_ID:
            target_title = self.FAMILY_CHANNEL_TITLE
        elif target_conv_id == "conv-agent-bielik":
            target_title = "Bielik (AI · ROOT)"
        elif target_conv_id == "conv-agent-maya":
            target_title = "Maya Mitek (AI Statku SVL-364 · ROOT)"
        elif target_conv_id == "conv-svl364-komputer-pokladowy":
            target_title = "SVL-364 Komputer pokładowy (SSH + MCP)"
        else:
            def _lookup_title(conn: sqlite3.Connection) -> Optional[str]:
                row = conn.execute(
                    "SELECT title FROM conversations WHERE id = ?",
                    (target_conv_id,),
                ).fetchone()
                return str(row["title"]) if row and row["title"] else None

            target_title = self.run_db(_lookup_title, write=False) or self.FAMILY_CHANNEL_TITLE
        return self.save_chat_message(
            target_conv_id,
            target_title,
            "svl-hybrid-router",
            {
                "id": msg_id,
                "role": "assistant",
                "sender": self.NOTIFICATION_SENDER,
                "agentId": self.NOTIFICATION_AGENT_ID,
                "modelUsed": model_label,
                "provenance": "server_verified",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "content": str(content or "")[:20000],
            },
            origin=origin,
            correlation_id=correlation_id,
            event_id=f"evt-{msg_id}",
        )

    def list_family_notifications(self, *, limit: int = 80) -> dict[str, Any]:
        safe_limit = max(1, min(500, int(limit or 80)))

        def _read(conn: sqlite3.Connection) -> list[sqlite3.Row]:
            return conn.execute(
                """
                SELECT id, content, metadata_json, created_at FROM chat_messages
                WHERE conversation_id = ? AND role = 'system' AND sender = ? AND id LIKE 'notif-%'
                ORDER BY rowid DESC LIMIT ?
                """,
                (self.FAMILY_CHANNEL_ID, self.NOTIFICATION_SENDER, safe_limit),
            ).fetchall()

        rows = self.run_db(_read, write=False)
        items = []
        for r in rows:
            try:
                meta = json.loads(r["metadata_json"] or "{}")
            except Exception:
                meta = {}
            items.append({
                "id": str(r["id"]),
                "content": str(r["content"] or ""),
                "label": str(meta.get("modelUsed") or ""),
                "channel": "wszyscy",
                "createdAt": str(r["created_at"] or ""),
            })
        return {
            "ok": True,
            "notifications": items,
            "totalCount": len(items),
            "serverRevision": self.get_server_revision(),
        }

    @staticmethod
    def _normalize_avatar_profile_key(raw_agent: str) -> str:
        clean = str(raw_agent or "").strip()
        low = clean.lower()
        mapping = {
            "bielik": "Bielik",
            "bielik ai": "Bielik",
            "maya": "Maya",
            "maya ai": "Maya",
            "maya mitek": "Maya",
            "maya mitek ai": "Maya",
            "operator": "Operator",
            "mateusz mitek": "Operator",
            "mateusz mitek (operator)": "Operator",
        }
        return mapping.get(low, "")

    @staticmethod
    def _validate_avatar_source(raw_image: str) -> str:
        value = str(raw_image or "").strip()
        if not value:
            raise ValueError("Obraz awatara nie może być pusty.")
        if len(value) > 3_600_000:
            raise ValueError("Obraz awatara przekracza limit rozmiaru (maks. ~2.5 MB).")
        if re.match(r"^data:image/(?:png|jpeg|jpg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$", value, re.IGNORECASE):
            return value
        if value.startswith("/") and not value.startswith("//") and ".." not in value:
            return value
        if value.startswith("https://") or value.startswith("http://127.0.0.1") or value.startswith("http://localhost"):
            return value
        raise ValueError("Niedozwolone źródło awatara. Dozwolone są adresy HTTPS lub obrazy PNG/JPG/WEBP.")

    def get_persisted_avatars(self) -> dict[str, str]:
        def _read(conn: sqlite3.Connection) -> dict[str, str]:
            row = conn.execute(
                "SELECT value FROM runtime_settings WHERE key = 'avatars_map_json'"
            ).fetchone()
            if not row or not row["value"]:
                return {}
            try:
                parsed = json.loads(row["value"])
                if not isinstance(parsed, dict):
                    return {}
                out: dict[str, str] = {}
                for k, v in parsed.items():
                    norm_k = self._normalize_avatar_profile_key(str(k))
                    if norm_k and isinstance(v, str) and v.strip():
                        out[norm_k] = v.strip()
                return out
            except Exception:
                return {}

        return self.run_db(_read, write=False)

    def set_persisted_avatar(
        self,
        *,
        agent: str,
        image: str,
        origin: str = "operator",
        correlation_id: str = "",
        event_id: Optional[str] = None,
    ) -> dict[str, Any]:
        norm_key = self._normalize_avatar_profile_key(agent)
        if not norm_key:
            raise ValueError(f"Nieznany profil awatara: {agent}")
        clean_image = self._validate_avatar_source(image)
        now_iso = datetime.now(timezone.utc).isoformat()

        def _write(conn: sqlite3.Connection) -> dict[str, Any]:
            row = conn.execute(
                "SELECT value FROM runtime_settings WHERE key = 'avatars_map_json'"
            ).fetchone()
            current: dict[str, str] = {}
            if row and row["value"]:
                try:
                    parsed = json.loads(row["value"])
                    if isinstance(parsed, dict):
                        current = {str(k): str(v) for k, v in parsed.items() if isinstance(v, str)}
                except Exception:
                    current = {}
            current[norm_key] = clean_image
            conn.execute(
                "INSERT OR REPLACE INTO runtime_settings (key, value, updated_at) VALUES (?, ?, ?)",
                ("avatars_map_json", json.dumps(current, ensure_ascii=False), now_iso),
            )
            sync_res = self.commit_entity_event_tx(
                conn,
                entity="avatar",
                entity_id=norm_key,
                event_type="avatar.updated",
                origin=origin,
                correlation_id=correlation_id,
                event_id=event_id,
                payload={"agent": norm_key},
                checksum_source={"agent": norm_key, "len": len(clean_image), "updated_at": now_iso},
            )
            return {
                "ok": True,
                "agent": norm_key,
                "avatars": current,
                "revision": sync_res["revision"],
                "serverRevision": sync_res["serverRevision"],
                "event": sync_res.get("event"),
            }

        res = self.run_db(_write, write=True)
        self.record_audit("AvatarStore", "AVATAR_UPDATE", norm_key, "OK", f"Zapisano niestandardowy awatar dla {norm_key}")
        return res

    def delete_persisted_avatar(
        self,
        *,
        agent: str,
        origin: str = "operator",
        correlation_id: str = "",
        event_id: Optional[str] = None,
    ) -> dict[str, Any]:
        norm_key = self._normalize_avatar_profile_key(agent)
        if not norm_key:
            raise ValueError(f"Nieznany profil awatara: {agent}")
        now_iso = datetime.now(timezone.utc).isoformat()

        def _write(conn: sqlite3.Connection) -> dict[str, Any]:
            row = conn.execute(
                "SELECT value FROM runtime_settings WHERE key = 'avatars_map_json'"
            ).fetchone()
            current: dict[str, str] = {}
            if row and row["value"]:
                try:
                    parsed = json.loads(row["value"])
                    if isinstance(parsed, dict):
                        current = {str(k): str(v) for k, v in parsed.items() if isinstance(v, str)}
                except Exception:
                    current = {}
            current.pop(norm_key, None)
            conn.execute(
                "INSERT OR REPLACE INTO runtime_settings (key, value, updated_at) VALUES (?, ?, ?)",
                ("avatars_map_json", json.dumps(current, ensure_ascii=False), now_iso),
            )
            sync_res = self.commit_entity_event_tx(
                conn,
                entity="avatar",
                entity_id=norm_key,
                event_type="avatar.reset",
                origin=origin,
                correlation_id=correlation_id,
                event_id=event_id,
                payload={"agent": norm_key},
                checksum_source={"agent": norm_key, "reset": True, "updated_at": now_iso},
            )
            return {
                "ok": True,
                "agent": norm_key,
                "avatars": current,
                "revision": sync_res["revision"],
                "serverRevision": sync_res["serverRevision"],
                "event": sync_res.get("event"),
            }

        res = self.run_db(_write, write=True)
        self.record_audit("AvatarStore", "AVATAR_RESET", norm_key, "OK", f"Przywrócono domyślny awatar dla {norm_key}")
        return res

    def factory_reset(self, origin: str = "factory_reset", correlation_id: str = "") -> dict[str, Any]:
        """
        Przywracanie ustawień fabrycznych (Factory Reset):
        - Czyści tabele czatów, modułów, powiadomień, logów i zadań.
        - Zachowuje zasób wspomnień Rodziny Mitek oraz uprawnienia Operatora.
        - Inicjalizuje domyślne moduły systemowe i kanały czatu.
        """
        now_iso = datetime.now(timezone.utc).isoformat()
        def _reset(conn: sqlite3.Connection) -> dict[str, Any]:
            for tbl in ("chat_messages", "conversations", "system_modules", "terminal_history", "agent_tasks", "sync_entities", "sync_outbox"):
                try:
                    conn.execute(f"DELETE FROM {tbl}")
                except Exception:
                    pass

            sync_res = self.commit_entity_event_tx(
                conn,
                entity="kernel",
                entity_id="factory-reset",
                event_type="kernel.factory_reset",
                origin=origin,
                correlation_id=correlation_id,
                payload={"action": "factory_reset", "timestamp": now_iso},
            )
            return sync_res

        sync_res = self.run_db(_reset, write=True)
        self.ensure_mitek_family_channel()
        self.checkpoint_wal("PASSIVE")
        self.save_durable_backup(explicitly_cleared=True)

        try:
            from antivirus_scanner import SVLAntivirusScanner
        except ImportError:
            from backend.antivirus_scanner import SVLAntivirusScanner
        av = SVLAntivirusScanner(self)
        av.scan_and_purge(emit_to_chat=False, origin=origin)

        return {
            "ok": True,
            "status": "FACTORY_RESET_COMPLETED",
            "serverRevision": sync_res["serverRevision"],
            "timestamp": now_iso,
        }

    def generate_system_status_report(self) -> str:
        """
        Generuje uniwersalny, produkcyjny zrzut stanu systemu w formacie strukturalnym JSON.
        Historia zawiera wyłącznie jawnie zapisane aktualizacje.
        """
        engine = TopologicalInfinityEngine(float("-inf"), float("inf"))
        topo_diag = engine.evaluate_diagnostics()
        recorded_updates = self.get_update_history()
        host_telemetry = self.operator.scope.collect_host_telemetry()
        modules_list = self.list_system_modules()
        self.config["active_modules"] = [m["id"] for m in modules_list if m.get("status") == "ACTIVE"]

        # Stan SVL CoreOS 2 z pomiarów (bez wpisanych na sztywno „wykonanych” operacji).
        os_pretty = platform.platform()
        try:
            for line in Path("/etc/os-release").read_text(encoding="utf-8").splitlines():
                if line.startswith("PRETTY_NAME="):
                    os_pretty = line.split("=", 1)[1].strip().strip('"')
        except Exception:
            pass
        sentinel_state = None
        try:
            sentinel_state = json.loads(Path("/var/lib/svl-coreos2/sentinel_status.json").read_text(encoding="utf-8"))
        except Exception:
            pass
        apex_summary: dict[str, Any] = {
            "Active_OS": "SVL CoreOS 2: Apex",
            "Version": "2.0.0-Apex",
            "Host_OS": os_pretty,
            "Kernel": platform.release(),
            "Systemd_Service": "zainstalowana" if Path("/etc/systemd/system/svl-coreos2.service").exists() else "brak (uruchomienie bez usługi)",
            "SVL_Sentinel": (
                {"checked_at": sentinel_state.get("checked_at"), "issues": sentinel_state.get("issues", [])}
                if isinstance(sentinel_state, dict) else "nie działa na tym hoście"
            ),
            "AI_Agents": ["Bielik", "Maya Mitek"],
        }

        report: dict[str, Any] = {
            "Timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
            "System": self.sys_version.value,
            "CoreOS_2_Apex": apex_summary,
            "Operator": self.operator.value,
            "Security_Architecture": {
                "Hardcoded_Token_Removed": True,
                "Auth_Mechanism": "HMAC-SHA256 SVL_OPERATOR_TOKEN (>=32 chars)",
                "Token_Source": self.token_source,
                "Protected_Variables_Count": len(self.protected_variables),
            },
            "Topological_Compact_Engine": topo_diag,
            "Compact_Metric_C": topo_diag["compact_metric_c"],
            "Host_Linux_Telemetry": host_telemetry,
            "Config_State": self.config,
            "System_Modules": modules_list,
            "Recorded_Updates_Count": len(recorded_updates),
            "Update_History": recorded_updates,
            "Registered_Services": list(self.service_registry.keys()),
            "Registered_Agents": list(self.agent_registry.keys()),
        }
        return json.dumps(report, indent=4, ensure_ascii=False)


if __name__ == "__main__":
    kernel = SVLSystemKernel()
    print(kernel.generate_system_status_report())
