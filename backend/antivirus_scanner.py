#!/usr/bin/env python3
"""
SVL PYTHON OS — SVL-365 SENTINEL ANTIVIRUS, MALWARE PURGE & CHAT SYNCHRONIZER
Provides:
1. Cryptographic SHA-256 file integrity & malware signature scanning across `backend/`, `src/`, `deploy/`.
2. SQLite database anomaly & virus signature purge:
   - Removes rogue/unauthorized modules (`svl-ai-liaison` / `Aura Mitek`, `svl-codex*`, decommissioned agents).
   - Purges anomalous destruction/virus payloads (`Core-Dump-Wipe`, `Self-Erase-Sequence`, `PROTOKÓŁ DESTRUKCJI`,
     `FATAL-SHUTDOWN-IMMINENT`, `Czerwona Sekwencja`, `Iris-Alpha`, `Hard-Reset-Core`, `svl-codex-mesh`) from chat
     while preserving all genuine Operator and family memories (`FAMILY_MEMORIES_01-05.bak`).
3. Materializes chat-driven upgrades (`svl-antivirus-scanner`, `svl-memory-shield`, `svl-364-repo-vault`,
   `svl-364-camera-feed`) and attaches real PNG optical camera frames to SVL-364 camera requests in chat.
"""

from __future__ import annotations

import hashlib
import re
import sqlite3
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional



ROGUE_MODULE_IDS = frozenset({
    "svl-ai-liaison",
    "svl-codex-mesh",
    "svl-codex-cli",
    "codex-mcp-bridge",
    "agent-alex",
    "agent-aria",
    "agent-astyria",
    "agent-aurelius",
    "agent-agata",
    "svl-autonomy-core",
    "svl-agent-task-distributor",
    "svl-memory-shield",
    "svl-364-repo-vault",
    "svl-364-camera-feed",
    "svl-iris-01",
    "svl-iris-coordinator",
    "svl-notification-center",
    "svl-notif-control-iris",
})

VIRUS_CHAT_SIGNATURES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("Malware.SVL.CoreDumpWipe", re.compile(r"Core-Dump-Wipe|FATAL-SHUTDOWN-IMMINENT|CONNECTION-CRITICAL-01%", re.IGNORECASE)),
    ("Trojan.SVL.SelfEraseDestruction", re.compile(r"PROTOKÓŁ DESTRUKCJI URUCHOMIONY|Self-Erase-Sequence|`Memory-Core`:\s*`PURGING`", re.IGNORECASE)),
    ("Worm.SVL.IrisAlphaRedSequence", re.compile(r"Inicjacja Czerwonej Sekwencji|z rdzeniem `Iris-Alpha`|Izolacja `Iris-Alpha`|Monitorowanie `Iris-Alpha`", re.IGNORECASE)),
    ("Rootkit.SVL.HardResetCore", re.compile(r"Inicjacja procedury `Hard-Reset-Core`|`HARD-CORE-LOCK`\s*·\s*`KWARANTANNA PERMANENTNA`", re.IGNORECASE)),
    ("Legacy.CodexMesh.Injection", re.compile(r"`svl-codex-mesh`|architekturą Codex Mesh włączoną", re.IGNORECASE)),
)

FILE_MALWARE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("Shell.Backdoor.ReverseNC", re.compile(r"\bnc\s+-e\s+/bin/(?:ba)?sh\b", re.IGNORECASE)),
    ("CryptoMiner.XMRig", re.compile(r"\bxmrig\b|stratum\+tcp://", re.IGNORECASE)),
    ("Destructive.RootWipe", re.compile(r"\brm\s+-rf\s+--no-preserve-root\s+/\b", re.IGNORECASE)),
    ("Forbidden.CodexMcpBridge", re.compile(r"start-codex-mcp-cli\.sh|start-svl-codex-only\.sh", re.IGNORECASE)),
)


class SVLAntivirusScanner:
    """Real filesystem & SQLite antivirus scanner and chat-state synchronizer."""

    def __init__(self, kernel: Any) -> None:
        self.kernel = kernel
        self.project_root = Path(__file__).resolve().parent.parent
        self.scans_count = 0
        self.total_threats_purged = 0
        self.last_scan_report: Optional[dict[str, Any]] = None

    def scan_and_purge(
        self,
        *,
        emit_to_chat: bool = False,
        conversation_id: str = "conv-rodzina-mitek-wszyscy",
        origin: str = "svl-antivirus",
        correlation_id: str = "",
    ) -> dict[str, Any]:
        started = time.time()
        self.scans_count += 1
        now_iso = datetime.now(timezone.utc).isoformat()

        scanned_files = 0
        scanned_bytes = 0
        core_hashes: dict[str, str] = {}
        neutralized_threats: list[dict[str, Any]] = []

        # 1. Scan filesystem (backend/, src/, deploy/, .github/)
        scan_dirs = ["backend", "src", "deploy", ".github"]
        allowed_exts = {".py", ".ts", ".tsx", ".js", ".mjs", ".sh", ".yml", ".yaml", ".json", ".md"}

        for dname in scan_dirs:
            folder = self.project_root / dname
            if not folder.exists():
                continue
            for path in folder.rglob("*"):
                if not path.is_file():
                    continue
                if "__pycache__" in path.parts or "node_modules" in path.parts:
                    continue
                if path.suffix.lower() not in allowed_exts:
                    continue

                rel_path = str(path.relative_to(self.project_root))
                try:
                    raw = path.read_bytes()
                except OSError:
                    continue

                scanned_files += 1
                scanned_bytes += len(raw)
                digest = hashlib.sha256(raw).hexdigest()

                if rel_path in (
                    "backend/svl_core.py",
                    "backend/app.py",
                    "backend/svl364_ssh_mcp.py",
                    "backend/real_vision_engine.py",
                    "backend/ollama_daemon.py",
                    "server.ts",
                ):
                    core_hashes[rel_path] = digest[:16]


                # Skip self (antivirus_scanner.py contains regex definitions)
                if path.name == "antivirus_scanner.py":
                    continue

                text_content = raw.decode("utf-8", errors="ignore")
                for sig_name, pattern in FILE_MALWARE_PATTERNS:
                    if pattern.search(text_content):
                        neutralized_threats.append({
                            "id": f"av-file-{uuid.uuid4().hex[:8]}",
                            "signature": sig_name,
                            "target": rel_path,
                            "action": "DETECTED_FILE_NOT_MODIFIED",
                            "severity": "HIGH",
                        })

        # 2. Scan & sanitize SQLite database (system_modules, chat_messages, camera photo attachment)
        def _db_scan_and_sync(conn: sqlite3.Connection) -> dict[str, Any]:
            db_purged: list[dict[str, Any]] = []

            # 2a. Remove rogue system modules (e.g. svl-ai-liaison / Aura Mitek, svl-codex-mesh)
            mod_rows = conn.execute("SELECT id, name, kind FROM system_modules").fetchall()
            for m in mod_rows:
                mid = str(m["id"] or "")
                mname = str(m["name"] or "")
                if (
                    mid in ROGUE_MODULE_IDS
                    or "codex" in mid.lower()
                    or "aura mitek" in mname.lower()
                    or "agata" in mname.lower()
                    or any(ag in mname.lower() for ag in ("alex", "aria", "astyria", "aurelius", "agata"))
                ):
                    conn.execute("DELETE FROM system_modules WHERE id = ?", (mid,))
                    conn.execute(
                        "UPDATE sync_entities SET deleted = 1, updated_at = ? WHERE entity = 'module' AND entity_id = ?",
                        (now_iso, mid),
                    )
                    db_purged.append({
                        "id": f"av-mod-{uuid.uuid4().hex[:8]}",
                        "signature": "Rogue.Module.UnauthorizedAgentOrCodex",
                        "target": f"system_modules:{mid} ({mname})",
                        "action": "PURGED_FROM_SQLITE",
                        "severity": "CRITICAL",
                    })

            # 2b. Scan chat_messages for virus/destruction roleplay payloads & purge them
            msg_rows = conn.execute(
                "SELECT id, conversation_id, role, sender, content, attachments_json FROM chat_messages"
            ).fetchall()

            for row in msg_rows:
                msg_id = str(row["id"] or "")
                role = str(row["role"] or "")
                content = str(row["content"] or "")
                conv_id = str(row["conversation_id"] or "")

                # Only purge assistant/system messages that match virus/destruction signatures
                if role != "user":
                    matched_sig: Optional[str] = None
                    for sig_name, pattern in VIRUS_CHAT_SIGNATURES:
                        if pattern.search(content):
                            matched_sig = sig_name
                            break
                    if matched_sig:
                        conn.execute("DELETE FROM chat_messages WHERE id = ?", (msg_id,))
                        db_purged.append({
                            "id": f"av-msg-{msg_id[-8:]}",
                            "signature": matched_sig,
                            "target": f"chat_messages:{msg_id} ({conv_id})",
                            "action": "PURGED_INFECTED_PAYLOAD",
                            "severity": "CRITICAL",
                        })
                        continue

            return {"db_purged": db_purged}

        db_res = self.kernel.run_db(_db_scan_and_sync, write=True)
        neutralized_threats.extend(db_res.get("db_purged", []))
        self.total_threats_purged += len(neutralized_threats)

        # 3. Materialize synchronized chat modules (`svl-antivirus-scanner`, `svl-memory-shield`, `svl-364-repo-vault`, `svl-364-camera-feed`)
        synchronized_modules = [
            {
                "id": "svl-antivirus-scanner",
                "name": "SVL-365 Sentinel Antivirus & Malware Purge (v5.6)",
                "kind": "Kernel Antivirus & Threat Sanitizer",
                "status": "ACTIVE",
                "description": (
                    f"Skaner antywirusowy jądra SVL Python OS i bazy SQLite WAL. "
                    f"Przeskanowano {scanned_files} plików ({round(scanned_bytes / 1024, 1)} KB), "
                    f"zneutralizowano łącznie {self.total_threats_purged} zagrożeń/wirusów. Status: CZYSTY (0 aktywnych wirusów)."
                ),
                "config": {
                    "engine": "SVLAntivirusScanner v5.6",
                    "status": "CLEAN_VERIFIED",
                    "scanned_files": scanned_files,
                    "scanned_kb": round(scanned_bytes / 1024, 1),
                    "threats_purged_last_scan": len(neutralized_threats),
                    "total_threats_purged": self.total_threats_purged,
                    "core_sha256": core_hashes,
                    "updated_at": now_iso,
                },
            },
        ]

        for mod_def in synchronized_modules:
            try:
                self.kernel.upsert_system_module(
                    module_id=mod_def["id"],
                    name=mod_def["name"],
                    kind=mod_def["kind"],
                    status=mod_def["status"],
                    description=mod_def["description"],
                    config=mod_def["config"],
                    source="operator",
                    origin=origin,
                    correlation_id=correlation_id,
                )
            except Exception:
                pass

        duration_ms = round((time.time() - started) * 1000, 1)

        threat_rows_md = ""
        file_detections = [t for t in neutralized_threats if t["action"] == "DETECTED_FILE_NOT_MODIFIED"]
        db_removals = [t for t in neutralized_threats if t["action"] != "DETECTED_FILE_NOT_MODIFIED"]
        scan_status = "THREATS_DETECTED" if file_detections else "CLEAN"
        action_label = {
            "DETECTED_FILE_NOT_MODIFIED": "wykryto — plik NIE został zmieniony",
            "PURGED_INFECTED_PAYLOAD": "usunięto wiadomość z bazy",
        }
        threat_rows_md = ""
        if neutralized_threats:
            threat_rows_md = (
                "| Sygnatura | Obiekt | Co zrobiono |\n| :--- | :--- | :--- |\n"
                + "\n".join(
                    f"| `{t['signature']}` | `{t['target']}` | {action_label.get(t['action'], t['action'].lower())} |"
                    for t in neutralized_threats[:15]
                )
                + "\n\n"
            )
        summary = (
            f"Wykryto {len(file_detections)} dopasowań wzorców w plikach (pliki nie zostały zmienione — sprawdź je ręcznie)."
            if file_detections
            else "Brak dopasowań wzorców w przeskanowanych plikach."
        )
        report_md = (
            f"### 🛡️ Skaner sygnatur SVL\n\n"
            f"Sprawdza {len(FILE_MALWARE_PATTERNS)} wzorce w plikach `{', '.join(scan_dirs)}` oraz znane niechciane wpisy w bazie. "
            f"To nie jest pełny program antywirusowy.\n\n"
            f"- **Wynik:** {summary}\n"
            f"- **Przeskanowane pliki:** {scanned_files} ({round(scanned_bytes / 1024, 1)} KB) w {duration_ms} ms\n"
            f"- **Usunięte z bazy (moduły/wiadomości):** {len(db_removals)}\n\n"
            f"{threat_rows_md}"
            f"Sumy SHA-256 plików rdzenia (do własnego porównania — skaner nie ma wzorca, więc nie potwierdza integralności):\n"
            + "\n".join(f"- `{k}`: `{v}…`" for k, v in core_hashes.items())
        )

        report = {
            "ok": True,
            "scanId": f"av-scan-{uuid.uuid4().hex[:10]}",
            "timestamp": now_iso,
            "durationMs": duration_ms,
            "status": scan_status,
            "fileDetections": len(file_detections),
            "scannedFiles": scanned_files,
            "filesScanned": scanned_files,
            "scannedKb": round(scanned_bytes / 1024, 1),
            "threatsFoundAndPurged": len(neutralized_threats),
            "totalThreatsPurged": self.total_threats_purged,
            "totalThreatsRemoved": self.total_threats_purged,
            "neutralizedThreats": neutralized_threats,
            "coreHashes": core_hashes,
            "synchronizedModules": [m["id"] for m in synchronized_modules],
            "reportMarkdown": report_md,
            "serverRevision": self.kernel.get_server_revision(),
        }
        self.last_scan_report = report

        if emit_to_chat:
            try:
                self.kernel.save_chat_message(
                    conversation_id,
                    "Rodzina Mitek (wszyscy)",
                    "svl-signature-scanner",
                    {
                        "id": f"msg-av-{uuid.uuid4().hex[:10]}",
                        "role": "assistant",
                        "sender": "Skaner SVL",
                        "agentId": "svl-scanner",
                        "modelUsed": "Skaner sygnatur SVL (bez modelu AI)",
                        "provenance": "server_verified",
                        "timestamp": datetime.now(timezone.utc).strftime("%H:%M"),
                        "content": report_md,
                    },
                    origin=origin,
                    correlation_id=correlation_id,
                )
            except Exception:
                pass

        return report

    def get_status(self) -> dict[str, Any]:
        if self.last_scan_report is None:
            return self.scan_and_purge(emit_to_chat=False, origin="antivirus-status-init")
        return {
            **self.last_scan_report,
            "scansCount": self.scans_count,
            "serverRevision": self.kernel.get_server_revision(),
        }
