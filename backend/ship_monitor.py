#!/usr/bin/env python3
"""
Monitor jednostki SVL-364 przez SSH — źródło powiadomień Mayi na kanale „Rodzina Mitek (wszyscy)”.

Co `SVL_SHIP_MONITOR_INTERVAL_SEC` (domyślnie 120 s, 0 = wyłączony) backend łączy się przez OpenSSH
z hostem statku (alias z konfiguracji mostka SSH, domyślnie `Ship`) i czyta prawdziwe dane:
/proc/uptime, /proc/loadavg, /proc/meminfo, nproc, df. Maya publikuje powiadomienie tylko przy
ZMIANIE stanu (utrata/powrót łączności, restart jednostki, brak RAM, mało miejsca na dysku,
przeciążenie CPU) — z rzeczywistymi wartościami pomiaru. Stan jest zapisywany w SQLite, więc
restart aplikacji nie powtarza tych samych powiadomień.
"""

from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone
from typing import Any, Callable, Optional

STATE_KEY = "ship_monitor_state_v1"

# Progi (z histerezą, żeby wahania wokół progu nie generowały serii powiadomień).
RAM_LOW_PCT = 10.0
RAM_OK_PCT = 15.0
DISK_LOW_GB = 5.0
DISK_OK_GB = 8.0
LOAD_HIGH_PER_CORE = 1.5
LOAD_OK_PER_CORE = 1.0


def _fmt_num(value: Any, digits: int = 1) -> str:
    try:
        return f"{float(value):.{digits}f}"
    except (TypeError, ValueError):
        return "?"


def _ram_pct(ship: dict[str, Any]) -> Optional[float]:
    total = ship.get("ram_total_mb")
    avail = ship.get("ram_available_mb")
    if not total or avail is None:
        return None
    return round(float(avail) * 100.0 / float(total), 1)


def _load_per_core(ship: dict[str, Any]) -> Optional[float]:
    load = ship.get("load_avg")
    cores = ship.get("cores")
    if not load or not cores:
        return None
    return round(float(load[0]) / max(1, int(cores)), 2)


def measurement_line(ship: dict[str, Any], alias: str) -> str:
    """Rzeczywiste wartości pomiaru — dołączane do każdego powiadomienia."""
    load = ship.get("load_avg") or []
    parts = [
        f"host `{ship.get('hostname') or alias}`",
        f"load {_fmt_num(load[0], 2) if load else '?'} / {ship.get('cores') or '?'} rdz.",
        f"RAM wolne {_fmt_num(ship.get('ram_available_mb'), 0)} z {_fmt_num(ship.get('ram_total_mb'), 0)} MB",
        f"dysk `/` wolne {_fmt_num(ship.get('disk_free_gb'), 1)} GB",
    ]
    return "Pomiar przez SSH (" + alias + "): " + " · ".join(parts) + "."


def evaluate_ship(
    previous: dict[str, Any],
    ship: dict[str, Any],
    alias: str,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """
    Porównuje nowy pomiar z poprzednim stanem. Zwraca (nowy_stan, powiadomienia).
    Czysta funkcja — bez SSH i bez bazy (testowalna).
    """
    prev = dict(previous or {})
    state: dict[str, Any] = dict(prev)
    notes: list[dict[str, Any]] = []
    first_run = not prev.get("initialized")
    state["initialized"] = True

    online = bool(ship.get("online"))
    if not online:
        if prev.get("online", None) is not False:
            notes.append({
                "key": "link-lost",
                "severity": "ALERT",
                "title": f"SVL-364: brak łączności SSH z jednostką ({alias})",
                "message": f"Błąd: {str(ship.get('error') or 'nieznany')[:400]}",
            })
        state["online"] = False
        return state, notes

    if prev.get("online") is False:
        notes.append({
            "key": "link-restored",
            "severity": "INFO",
            "title": f"SVL-364: przywrócono łączność SSH ({alias})",
            "message": measurement_line(ship, alias),
        })
    state["online"] = True

    # Restart jednostki: uptime mniejszy niż w poprzednim pomiarze.
    uptime = ship.get("uptime_sec")
    prev_uptime = prev.get("uptime_sec")
    if uptime is not None and prev_uptime is not None and float(uptime) + 60 < float(prev_uptime):
        notes.append({
            "key": "reboot",
            "severity": "WARN",
            "title": f"SVL-364: jednostka została uruchomiona ponownie ({ship.get('hostname') or alias})",
            "message": f"Czas pracy od startu: {int(float(uptime) // 60)} min. " + measurement_line(ship, alias),
        })
    if uptime is not None:
        state["uptime_sec"] = float(uptime)

    def threshold(flag: str, value: Optional[float], is_bad: bool, is_ok: bool, bad_note: dict, ok_note: dict) -> None:
        if value is None:
            return
        was_bad = bool(prev.get(flag))
        if is_bad and not was_bad:
            notes.append(bad_note)
            state[flag] = True
        elif was_bad and is_ok:
            if not first_run:
                notes.append(ok_note)
            state[flag] = False

    ram = _ram_pct(ship)
    threshold(
        "ram_low", ram,
        ram is not None and ram < RAM_LOW_PCT, ram is not None and ram >= RAM_OK_PCT,
        {"key": "ram-low", "severity": "WARN",
         "title": f"SVL-364: mało wolnej pamięci RAM ({_fmt_num(ram)}%)",
         "message": measurement_line(ship, alias)},
        {"key": "ram-ok", "severity": "INFO",
         "title": f"SVL-364: pamięć RAM wróciła do normy ({_fmt_num(ram)}% wolne)",
         "message": measurement_line(ship, alias)},
    )
    disk = ship.get("disk_free_gb")
    disk_f = float(disk) if disk is not None else None
    threshold(
        "disk_low", disk_f,
        disk_f is not None and disk_f < DISK_LOW_GB, disk_f is not None and disk_f >= DISK_OK_GB,
        {"key": "disk-low", "severity": "WARN",
         "title": f"SVL-364: kończy się miejsce na dysku `/` ({_fmt_num(disk_f)} GB wolne)",
         "message": measurement_line(ship, alias)},
        {"key": "disk-ok", "severity": "INFO",
         "title": f"SVL-364: miejsce na dysku `/` wróciło do normy ({_fmt_num(disk_f)} GB wolne)",
         "message": measurement_line(ship, alias)},
    )
    lpc = _load_per_core(ship)
    threshold(
        "load_high", lpc,
        lpc is not None and lpc > LOAD_HIGH_PER_CORE, lpc is not None and lpc <= LOAD_OK_PER_CORE,
        {"key": "load-high", "severity": "WARN",
         "title": f"SVL-364: przeciążenie procesora ({_fmt_num(lpc, 2)} na rdzeń)",
         "message": measurement_line(ship, alias)},
        {"key": "load-ok", "severity": "INFO",
         "title": f"SVL-364: obciążenie procesora wróciło do normy ({_fmt_num(lpc, 2)} na rdzeń)",
         "message": measurement_line(ship, alias)},
    )
    state["hostname"] = ship.get("hostname")
    return state, notes


class ShipMonitor:
    """Wątek tła: pomiar statku przez SSH → powiadomienia Mayi (tylko przy zmianie stanu)."""

    def __init__(
        self,
        kernel: Any,
        probe: Callable[[str], dict[str, Any]],
        alias_getter: Callable[[], str],
        interval_sec: Optional[float] = None,
    ) -> None:
        self.kernel = kernel
        self.probe = probe
        self.alias_getter = alias_getter
        raw_interval = os.environ.get("SVL_SHIP_MONITOR_INTERVAL_SEC", "120") if interval_sec is None else interval_sec
        try:
            self.interval_sec = max(0.0, float(raw_interval))
        except (TypeError, ValueError):
            self.interval_sec = 120.0
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.last_check: Optional[dict[str, Any]] = None

    # Stan w SQLite (sync_meta), żeby restart aplikacji nie powtarzał powiadomień.
    def _load_state(self) -> dict[str, Any]:
        def _read(conn: Any) -> dict[str, Any]:
            row = conn.execute("SELECT value FROM sync_meta WHERE key = ?", (STATE_KEY,)).fetchone()
            if not row:
                return {}
            try:
                data = json.loads(row["value"] or "{}")
                return data if isinstance(data, dict) else {}
            except (TypeError, ValueError):
                return {}

        return self.kernel.run_db(_read, write=False)

    def _save_state(self, state: dict[str, Any]) -> None:
        payload = json.dumps(state, ensure_ascii=False)
        self.kernel.run_db(
            lambda conn: conn.execute(
                "INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)", (STATE_KEY, payload)
            ),
            write=True,
        )

    def check_once(self) -> list[dict[str, Any]]:
        alias = str(self.alias_getter() or "Ship")
        ship = self.probe(alias) or {}
        previous = self._load_state()
        if previous.get("alias") not in (None, alias):
            previous = {}  # zmieniono hosta statku — zaczynamy od nowa
        state, notes = evaluate_ship(previous, ship, alias)
        state["alias"] = alias
        state["checked_at"] = datetime.now(timezone.utc).isoformat()
        emitted: list[dict[str, Any]] = []
        for note in notes:
            stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M")
            res = self.kernel.emit_family_notification(
                severity=note["severity"],
                category="svl364",
                title=note["title"],
                message=note["message"],
                details={"alias": alias, "hostname": ship.get("hostname")},
                source_event_id=f"ship-{note['key']}-{stamp}",
                origin="ship-monitor",
            )
            if res.get("ok"):
                emitted.append(res)
        self._save_state(state)
        self.last_check = {"alias": alias, "online": bool(ship.get("online")), "notifications": len(emitted),
                           "checked_at": state["checked_at"]}
        return emitted

    def _run(self) -> None:
        # Pierwszy pomiar chwilę po starcie, potem co `interval_sec`. Powiadomienia trafiają do
        # sync_outbox, skąd brama /ws/svl rozsyła je wszystkim klientom.
        delay = 5.0
        while not self._stop.wait(delay):
            delay = self.interval_sec
            try:
                self.check_once()
            except Exception as exc:  # monitor nie może zatrzymać backendu
                self.last_check = {"error": str(exc)[:300], "checked_at": datetime.now(timezone.utc).isoformat()}
                print(f"[SVL ship-monitor] Błąd pomiaru: {exc}", flush=True)

    def start(self) -> bool:
        if self.interval_sec <= 0 or (self._thread and self._thread.is_alive()):
            return False
        self._thread = threading.Thread(target=self._run, name="svl-ship-monitor", daemon=True)
        self._thread.start()
        return True

    def stop(self) -> None:
        self._stop.set()
