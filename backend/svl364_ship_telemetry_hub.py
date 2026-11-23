#!/usr/bin/env python3
"""
SVL-364 Ship Telemetry, Services, Solar Navigation & Incidents Hub.

Łączy przez MCP (Remote MCP Zero-IP → OpenSSH ROOT) oraz lokalne pomiary:
1. Telemetrię zasobów i sensorów sprzętowych (CPU, RAM, GPU, dysk, termika, sieć, zapora).
2. Dostępność wszystkich usług statku SVL-364 i węzła sterującego.
3. Rzeczywistą mapę Układu Słonecznego (epoka J2000 → bieżący czas UTC) z pozycją i kursem SVL-364.
4. Powiadomienia ze statku: transmisje, krytyczne alarmy, anomalie z sensorów i raporty z incydentów.
"""

from __future__ import annotations

import json
import math
import os
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

NAV_META_KEY = "svl364_navigation_v1"
INCIDENTS_META_KEY = "svl364_incidents_v1"

SVL364_TRACKED_UNITS = (
    ("svl-mcp.service", "SVL Universal MCP Hub", "mcp"),
    ("svl-coreos2.service", "SVL CoreOS 2 Runtime", "core"),
    ("svl-python-os.service", "SVL Python OS Kernel", "core"),
    ("svl-gateway.service", "SVL Gateway HTTP/WS", "core"),
    ("svl-sentinel.service", "SVL-365 Sentinel Monitor", "security"),
    ("ollama.service", "Ollama AI Engine (SVL-364)", "ai"),
    ("svl-ship-ollama-tunnel.service", "Tunel SSH Ollama SVL-364", "ai"),
    ("svl-comfyui.service", "ComfyUI Vision / Render", "ai"),
    ("tailscaled.service", "Tailscale Mesh Zero-IP", "network"),
    ("cloudflared.service", "Cloudflare Tunnel Zero-IP", "network"),
    ("docker.service", "Docker Engine", "infra"),
    ("ssh.service", "OpenSSH Daemon", "network"),
)

# Elementy orbitalne (epoka J2000.0 = 2000-01-01T12:00:00Z): (au, okres_dni, dlugosc_j2000_deg, nazwa_pl, typ)
SOLAR_BODIES: dict[str, dict[str, Any]] = {
    "mercury": {"name": "Merkury", "au": 0.387, "periodDays": 87.969, "j2000Deg": 252.25, "kind": "planet", "color": "#94a3b8", "radius": 3.5},
    "venus": {"name": "Wenus", "au": 0.723, "periodDays": 224.701, "j2000Deg": 181.98, "kind": "planet", "color": "#f59e0b", "radius": 5.0},
    "earth": {"name": "Ziemia", "au": 1.000, "periodDays": 365.256, "j2000Deg": 100.46, "kind": "planet", "color": "#38bdf8", "radius": 5.5},
    "earth-l2": {"name": "Punkt Lagrange'a Ziemia–Słońce L2", "au": 1.010, "periodDays": 365.256, "j2000Deg": 100.46, "kind": "station", "parent": "earth", "color": "#22d3ee", "radius": 3.0},
    "mars": {"name": "Mars", "au": 1.524, "periodDays": 686.980, "j2000Deg": 355.45, "kind": "planet", "color": "#f97316", "radius": 4.5},
    "ceres": {"name": "Pas Planetoid (Ceres)", "au": 2.767, "periodDays": 1681.63, "j2000Deg": 95.99, "kind": "belt", "color": "#a8a29e", "radius": 3.2},
    "jupiter": {"name": "Jowisz", "au": 5.204, "periodDays": 4332.59, "j2000Deg": 34.40, "kind": "planet", "color": "#fbbf24", "radius": 9.0},
    "saturn": {"name": "Saturn", "au": 9.582, "periodDays": 10759.22, "j2000Deg": 49.94, "kind": "planet", "color": "#fde047", "radius": 7.5, "hasRings": True},
    "uranus": {"name": "Uran", "au": 19.201, "periodDays": 30688.5, "j2000Deg": 313.23, "kind": "planet", "color": "#67e8f9", "radius": 6.0},
    "neptune": {"name": "Neptun", "au": 30.047, "periodDays": 60182.0, "j2000Deg": 304.88, "kind": "planet", "color": "#3b82f6", "radius": 6.0},
}

DEFAULT_NAVIGATION: dict[str, Any] = {
    "sector": "Sektor Ziemski · Punkt L2",
    "currentBody": "earth-l2",
    "targetBody": "earth-l2",
    "missionStatus": "ORBIT_HOLD",
    "velocityKms": 29.78,
    "altitudeKm": 1500000,
    "transponder": "SVL-364-EBON-APEX · QKD-MCP ACTIVE",
    "note": "Pozycja orbitalna przy punkcie L2 Ziemia–Słońce (osłona Układu Słonecznego i łączność MCP).",
}


def _days_since_j2000(now_utc: Optional[datetime] = None) -> float:
    dt = now_utc or datetime.now(timezone.utc)
    j2000 = datetime(2000, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    return (dt - j2000).total_seconds() / 86400.0


def compute_solar_ephemeris(now_utc: Optional[datetime] = None) -> dict[str, dict[str, Any]]:
    """Wyznacza rzeczywistą długość heliocentryczną planet dla bieżącej daty UTC (epoka J2000)."""
    days = _days_since_j2000(now_utc)
    out: dict[str, dict[str, Any]] = {}
    for body_id, info in SOLAR_BODIES.items():
        angle_deg = (float(info["j2000Deg"]) + (360.0 / float(info["periodDays"])) * days) % 360.0
        rad = math.radians(angle_deg)
        au = float(info["au"])
        out[body_id] = {
            **info,
            "id": body_id,
            "angleDeg": round(angle_deg, 2),
            "xAu": round(au * math.cos(rad), 4),
            "yAu": round(au * math.sin(rad), 4),
        }
    return out


def read_local_thermal_sensors() -> list[dict[str, Any]]:
    """Czyta prawdziwe strefy termiczne z /sys/class/thermal/thermal_zone* na hoście Linux."""
    readings: list[dict[str, Any]] = []
    base = Path("/sys/class/thermal")
    if not base.is_dir():
        return readings
    try:
        zones = sorted(base.glob("thermal_zone*"))[:8]
    except OSError:
        return readings
    for zone in zones:
        try:
            raw_temp = (zone / "temp").read_text(encoding="utf-8", errors="replace").strip()
            temp_c = round(float(raw_temp) / 1000.0, 1)
            if temp_c <= -40 or temp_c > 150:
                continue
            ztype = (zone / "type").read_text(encoding="utf-8", errors="replace").strip() or zone.name
            readings.append({
                "id": f"thermal-{zone.name}",
                "label": f"Termika ({ztype})",
                "value": f"{temp_c:.1f} °C",
                "numericValue": temp_c,
                "unit": "°C",
                "status": "critical" if temp_c >= 85 else ("warn" if temp_c >= 72 else "nominal"),
                "source": "local-host",
            })
        except (OSError, ValueError):
            continue
    return readings


class SVL364ShipHub:
    """Zarządza zunifikowanym stanem modułu SVL-364 (MCP probe, nawigacja Układu Słonecznego, incydenty i alarmy)."""

    def __init__(self, controller: Any) -> None:
        self.controller = controller
        self.kernel = controller.kernel
        self._probe_cache: Optional[dict[str, Any]] = None
        self._probe_cache_at: float = 0.0

    # --- Persystencja w SQLite (sync_meta) ---

    def _read_meta_json(self, key: str, default: Any) -> Any:
        def _read(conn: Any) -> Any:
            row = conn.execute("SELECT value FROM sync_meta WHERE key = ?", (key,)).fetchone()
            if not row or not row["value"]:
                return default
            try:
                return json.loads(row["value"])
            except (TypeError, ValueError):
                return default

        run_db = getattr(self.kernel, "run_db", None)
        if not callable(run_db):
            return default
        try:
            return run_db(_read, write=False)
        except Exception:
            return default

    def _write_meta_json(self, key: str, value: Any) -> None:
        run_db = getattr(self.kernel, "run_db", None)
        if not callable(run_db):
            return
        payload = json.dumps(value, ensure_ascii=False)
        try:
            run_db(
                lambda conn: conn.execute(
                    "INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)",
                    (key, payload),
                ),
                write=True,
            )
        except Exception:
            pass

    # --- Nawigacja Układu Słonecznego ---

    def get_navigation(self) -> dict[str, Any]:
        saved = self._read_meta_json(NAV_META_KEY, {})
        nav = dict(DEFAULT_NAVIGATION)
        if isinstance(saved, dict):
            nav.update({k: v for k, v in saved.items() if v is not None})

        ephemeris = compute_solar_ephemeris()
        cur_id = str(nav.get("currentBody") or "earth-l2")
        if cur_id not in ephemeris:
            cur_id = "earth-l2"
        tgt_id = str(nav.get("targetBody") or cur_id)
        if tgt_id not in ephemeris:
            tgt_id = cur_id

        cur_body = ephemeris[cur_id]
        tgt_body = ephemeris[tgt_id]
        earth_body = ephemeris["earth"]

        ship_x = float(cur_body["xAu"])
        ship_y = float(cur_body["yAu"])
        dist_earth_au = round(math.hypot(ship_x - float(earth_body["xAu"]), ship_y - float(earth_body["yAu"])), 4)
        dist_target_au = round(math.hypot(ship_x - float(tgt_body["xAu"]), ship_y - float(tgt_body["yAu"])), 4)
        # 1 AU ≈ 499.004784 sekund świetlnych
        light_delay_earth_sec = round(dist_earth_au * 499.004784, 1)
        light_delay_target_sec = round(dist_target_au * 499.004784, 1)

        mods = {m["id"]: m for m in self.kernel.list_system_modules()}
        solar_bridge_active = "solar-defense-read-bridge" in mods
        alliance_grid_active = "alliance-defense-grid" in mods
        si_sphere_active = any(str(mid).startswith("si-sphere") for mid in mods)

        fleet_markers = [
            {
                "id": "apex-citadel",
                "name": "APEX-CITADEL (Orbita Ziemi)",
                "bodyId": "earth",
                "xAu": earth_body["xAu"],
                "yAu": earth_body["yAu"],
                "au": earth_body["au"],
                "angleDeg": earth_body["angleDeg"],
                "status": "ACTIVE",
            },
        ]
        if si_sphere_active:
            jup = ephemeris["jupiter"]
            fleet_markers.append({
                "id": "svl-465",
                "name": "SVL-465 Baza Kwantowa (SI_Sphere)",
                "bodyId": "jupiter",
                "xAu": jup["xAu"],
                "yAu": jup["yAu"],
                "au": jup["au"],
                "angleDeg": jup["angleDeg"],
                "status": "ACTIVE",
            })

        return {
            "sector": nav.get("sector") or cur_body["name"],
            "currentBody": cur_id,
            "currentBodyName": cur_body["name"],
            "targetBody": tgt_id,
            "targetBodyName": tgt_body["name"],
            "missionStatus": nav.get("missionStatus") or ("IN_TRANSIT" if cur_id != tgt_id else "ORBIT_HOLD"),
            "au": cur_body["au"],
            "angleDeg": cur_body["angleDeg"],
            "xAu": ship_x,
            "yAu": ship_y,
            "velocityKms": nav.get("velocityKms", 29.78),
            "altitudeKm": nav.get("altitudeKm", 1500000),
            "distanceFromEarthAu": dist_earth_au,
            "lightDelayEarthSec": light_delay_earth_sec,
            "distanceToTargetAu": dist_target_au,
            "lightDelayTargetSec": light_delay_target_sec,
            "transponder": nav.get("transponder") or DEFAULT_NAVIGATION["transponder"],
            "note": nav.get("note") or "",
            "solarDefenseReadActive": solar_bridge_active,
            "allianceDefenseActive": alliance_grid_active,
            "bodies": list(ephemeris.values()),
            "fleetMarkers": fleet_markers,
            "epochUtc": datetime.now(timezone.utc).isoformat(),
            "updatedAt": nav.get("updatedAt") or datetime.now(timezone.utc).isoformat(),
        }

    def update_navigation(self, updates: dict[str, Any], origin: str = "operator", correlation_id: str = "") -> dict[str, Any]:
        saved = self._read_meta_json(NAV_META_KEY, {})
        nav = dict(DEFAULT_NAVIGATION)
        if isinstance(saved, dict):
            nav.update(saved)

        if updates.get("currentBody") in SOLAR_BODIES:
            nav["currentBody"] = str(updates["currentBody"])
            nav["sector"] = str(updates.get("sector") or SOLAR_BODIES[nav["currentBody"]]["name"])
        if updates.get("targetBody") in SOLAR_BODIES:
            nav["targetBody"] = str(updates["targetBody"])
        if updates.get("sector"):
            nav["sector"] = str(updates["sector"]).strip()[:120]
        if updates.get("missionStatus"):
            status_val = str(updates["missionStatus"]).strip().upper()
            if status_val in {"ORBIT_HOLD", "IN_TRANSIT", "PATROL_L2", "DEFENSE_LOCK", "STANDBY"}:
                nav["missionStatus"] = status_val
        elif nav.get("currentBody") != nav.get("targetBody"):
            nav["missionStatus"] = "IN_TRANSIT"
        else:
            nav["missionStatus"] = "ORBIT_HOLD"
        if updates.get("velocityKms") is not None:
            try:
                nav["velocityKms"] = max(0.0, min(299792.0, round(float(updates["velocityKms"]), 2)))
            except (TypeError, ValueError):
                pass
        if updates.get("note") is not None:
            nav["note"] = str(updates["note"]).strip()[:300]
        nav["updatedAt"] = datetime.now(timezone.utc).isoformat()
        nav["updatedBy"] = origin
        self._write_meta_json(NAV_META_KEY, nav)

        self.record_incident(
            {
                "category": "transmission",
                "severity": "INFO",
                "title": f"SVL-364: aktualizacja kursu orbitalnego ({nav['sector']})",
                "message": f"Pozycja: {SOLAR_BODIES[nav['currentBody']]['name']} → Cel: {SOLAR_BODIES[nav['targetBody']]['name']} · tryb: {nav['missionStatus']}.",
                "source": f"navigation:{origin}",
            },
            origin=origin,
            correlation_id=correlation_id,
            emit_notification=False,
        )
        return {"ok": True, "navigation": self.get_navigation(), "serverRevision": self.kernel.get_server_revision()}

    # --- Raporty incydentów, transmisji i alarmów ---

    def list_stored_incidents(self, limit: int = 80) -> list[dict[str, Any]]:
        raw = self._read_meta_json(INCIDENTS_META_KEY, [])
        if not isinstance(raw, list):
            return []
        return [item for item in raw if isinstance(item, dict)][: max(1, min(120, int(limit or 80)))]

    def record_incident(
        self,
        payload: dict[str, Any],
        origin: str = "operator",
        correlation_id: str = "",
        emit_notification: bool = True,
    ) -> dict[str, Any]:
        title = str(payload.get("title") or "").strip()[:180]
        message = str(payload.get("message") or "").strip()[:1500]
        if not title:
            raise ValueError("Raport incydentu / transmisji wymaga tytułu (title).")
        category = str(payload.get("category") or "incident").strip().lower()
        if category not in {"transmission", "alarm", "sensor", "incident"}:
            category = "incident"
        severity = str(payload.get("severity") or ("CRITICAL" if category == "alarm" else "INFO")).strip().upper()
        if severity not in {"CRITICAL", "WARN", "INFO"}:
            severity = "INFO"

        now_iso = datetime.now(timezone.utc).isoformat()
        item = {
            "id": f"inc-{uuid.uuid4().hex[:10]}",
            "category": category,
            "severity": severity,
            "title": title,
            "message": message or title,
            "source": str(payload.get("source") or f"svl364:{origin}").strip()[:80],
            "resolved": False,
            "createdAt": now_iso,
            "resolvedAt": None,
            "details": payload.get("details") if isinstance(payload.get("details"), dict) else {},
        }
        items = self.list_stored_incidents(limit=120)
        items.insert(0, item)
        self._write_meta_json(INCIDENTS_META_KEY, items[:120])

        if emit_notification and (severity == "CRITICAL" or category in {"alarm", "transmission"}):
            emit_fn = getattr(self.kernel, "emit_family_notification", None)
            if callable(emit_fn):
                try:
                    emit_fn(
                        severity="ALERT" if severity == "CRITICAL" else severity,
                        category=f"svl364-{category}",
                        title=title,
                        message=message or title,
                        details={"incidentId": item["id"], "category": category},
                        source_event_id=item["id"],
                        origin=origin,
                        correlation_id=correlation_id,
                    )
                except Exception:
                    pass
        return {"ok": True, "incident": item, "serverRevision": self.kernel.get_server_revision()}

    def resolve_incident(self, incident_id: str, origin: str = "operator") -> dict[str, Any]:
        cid = str(incident_id or "").strip()
        if not cid:
            return {"ok": False, "error": "Wymagany incidentId."}
        items = self.list_stored_incidents(limit=120)
        updated = None
        now_iso = datetime.now(timezone.utc).isoformat()
        for item in items:
            if item.get("id") == cid:
                item["resolved"] = True
                item["resolvedAt"] = now_iso
                item["resolvedBy"] = origin
                updated = item
                break
        if updated is None:
            return {"ok": False, "error": f"Nie znaleziono incydentu {cid}."}
        self._write_meta_json(INCIDENTS_META_KEY, items)
        return {"ok": True, "incident": updated, "serverRevision": self.kernel.get_server_revision()}

    # --- Sonda na żywo przez MCP / OpenSSH ---

    def probe_ship_via_mcp(self, force: bool = False) -> dict[str, Any]:
        """Odpytuje komputer statku SVL-364 przez MCP (Remote MCP Zero-IP → OpenSSH) o usługi, sensory i błędy."""
        now = time.monotonic()
        if not force and self._probe_cache is not None and (now - self._probe_cache_at) < 25.0:
            return self._probe_cache

        status = self.controller.get_status()
        remote_cfg = status.get("remoteMcp") or {}
        ssh_cfg = status.get("ssh") or {}
        can_probe = bool(remote_cfg.get("enabled") and remote_cfg.get("url")) or bool(ssh_cfg.get("targetReachable"))
        if not can_probe and not force:
            result = {
                "ok": False,
                "transport": "offline",
                "probedAt": datetime.now(timezone.utc).isoformat(),
                "error": ssh_cfg.get("targetError") or "Brak aktywnego Remote MCP ani osiągalnego hosta SSH SVL-364.",
                "services": {},
                "thermals": [],
                "failedUnits": [],
                "journalErrors": [],
                "shipHost": {},
            }
            self._probe_cache = result
            self._probe_cache_at = now
            return result

        units_str = " ".join(u for u, _, _ in SVL364_TRACKED_UNITS)
        probe_cmd = (
            "printf 'HOST=%s\\n' \"$(hostname 2>/dev/null)\"; "
            "printf 'KERNEL=%s\\n' \"$(uname -srm 2>/dev/null)\"; "
            "printf 'UPTIME=%s\\n' \"$(awk '{print int($1)}' /proc/uptime 2>/dev/null)\"; "
            "printf 'LOAD=%s\\n' \"$(awk '{print $1,$2,$3}' /proc/loadavg 2>/dev/null)\"; "
            "printf 'CORES=%s\\n' \"$(nproc 2>/dev/null)\"; "
            "awk '/MemTotal:|MemAvailable:/{print $1,$2}' /proc/meminfo 2>/dev/null; "
            "df -BG -P / 2>/dev/null | awk 'NR==2{print \"DISK_GB=\" $2 \" \" $4 \" \" $5}'; "
            f"if command -v systemctl >/dev/null 2>&1; then "
            f"for u in {units_str}; do printf 'SVC:%s=%s\\n' \"$u\" \"$(systemctl is-active \"$u\" 2>/dev/null || echo inactive)\"; done; "
            "systemctl --failed --no-legend --no-pager 2>/dev/null | head -n 8 | sed 's/^/FAILED:/'; "
            "fi; "
            "for z in /sys/class/thermal/thermal_zone*; do "
            "[ -r \"$z/temp\" ] && printf 'TEMP:%s=%s\\n' \"$(cat \"$z/type\" 2>/dev/null || basename \"$z\")\" \"$(cat \"$z/temp\" 2>/dev/null)\"; "
            "done 2>/dev/null | head -n 8; "
            "command -v journalctl >/dev/null 2>&1 && journalctl -p err..emerg -n 10 --no-pager --output=short-iso 2>/dev/null | sed 's/^/JERR:/'"
        )
        exec_res = self.controller.execute_root_command(
            probe_cmd,
            timeout_sec=14.0,
            origin="svl364-mcp-probe",
            confirmed=True,
            raw=True,
            prefer_transport="auto",
        )
        raw_out = str(exec_res.get("rawOutput") or "")
        services_map: dict[str, str] = {}
        thermals: list[dict[str, Any]] = []
        failed_units: list[str] = []
        journal_errors: list[str] = []
        ship_host: dict[str, Any] = {}

        if exec_res.get("ok") and raw_out:
            for line in raw_out.splitlines():
                s = line.strip()
                if not s:
                    continue
                if s.startswith("HOST="):
                    ship_host["hostname"] = s[5:].strip()
                elif s.startswith("KERNEL="):
                    ship_host["kernel"] = s[7:].strip()
                elif s.startswith("UPTIME="):
                    try:
                        ship_host["uptime_sec"] = int(float(s[7:].strip()))
                    except ValueError:
                        pass
                elif s.startswith("LOAD="):
                    try:
                        ship_host["load_avg"] = [float(x) for x in s[5:].split()[:3]]
                    except ValueError:
                        pass
                elif s.startswith("CORES="):
                    try:
                        ship_host["cores"] = int(s[6:].strip())
                    except ValueError:
                        pass
                elif s.startswith("MemTotal:"):
                    try:
                        ship_host["ram_total_mb"] = round(float(s.split()[1]) / 1024.0, 1)
                    except (IndexError, ValueError):
                        pass
                elif s.startswith("MemAvailable:"):
                    try:
                        ship_host["ram_available_mb"] = round(float(s.split()[1]) / 1024.0, 1)
                    except (IndexError, ValueError):
                        pass
                elif s.startswith("DISK_GB="):
                    parts = s[8:].split()
                    if len(parts) >= 2:
                        try:
                            ship_host["disk_total_gb"] = float(parts[0].rstrip("G"))
                            ship_host["disk_free_gb"] = float(parts[1].rstrip("G"))
                        except ValueError:
                            pass
                elif s.startswith("SVC:") and "=" in s:
                    unit, state = s[4:].split("=", 1)
                    services_map[unit.strip()] = state.strip()
                elif s.startswith("TEMP:") and "=" in s:
                    zname, raw_t = s[5:].split("=", 1)
                    try:
                        tc = round(float(raw_t.strip()) / 1000.0, 1)
                        if -40 < tc <= 150:
                            thermals.append({
                                "id": f"ship-temp-{len(thermals)}",
                                "label": f"SVL-364 Termika ({zname.strip()})",
                                "value": f"{tc:.1f} °C",
                                "numericValue": tc,
                                "unit": "°C",
                                "status": "critical" if tc >= 85 else ("warn" if tc >= 72 else "nominal"),
                                "source": "svl364-mcp",
                            })
                    except ValueError:
                        pass
                elif s.startswith("FAILED:"):
                    fu = s[7:].strip()
                    if fu and not fu.startswith("--"):
                        failed_units.append(fu[:180])
                elif s.startswith("JERR:"):
                    je = s[5:].strip()
                    if je and not je.startswith("--"):
                        journal_errors.append(je[:260])

        result = {
            "ok": bool(exec_res.get("ok")),
            "transport": str(exec_res.get("transport") or "offline"),
            "endpoint": str(exec_res.get("endpoint") or ""),
            "durationMs": exec_res.get("durationMs"),
            "probedAt": datetime.now(timezone.utc).isoformat(),
            "error": "" if exec_res.get("ok") else str(exec_res.get("error") or ""),
            "services": services_map,
            "thermals": thermals,
            "failedUnits": failed_units,
            "journalErrors": journal_errors,
            "shipHost": ship_host,
        }
        self._probe_cache = result
        self._probe_cache_at = now
        return result

    # --- Zunifikowany przegląd modułu SVL-364 ---

    def _classify_notification(self, notif: dict[str, Any]) -> tuple[str, str]:
        text = f"{notif.get('label', '')} {notif.get('content', '')}".lower()
        if any(k in text for k in ("alert", "krytycz", "błąd", "brak łączności", "failed", "zagroż", "alarm", "offline")):
            severity = "CRITICAL"
        elif any(k in text for k in ("warn", "ostrzeż", "mało", "przeciąż", "ponownie", "spadek")):
            severity = "WARN"
        else:
            severity = "INFO"

        if any(k in text for k in ("transmisj", "łączność", "ssh", "mcp", "tunel", "komunikat", "hiperprzestrz", "kurs", "kanał")):
            category = "transmission"
        elif any(k in text for k in ("sensor", "ram", "dysk", "procesor", "cpu", "gpu", "temp", "termik", "vision")):
            category = "sensor"
        elif severity == "CRITICAL":
            category = "alarm"
        else:
            category = "incident"
        return category, severity

    def get_overview(
        self,
        *,
        include_mcp_probe: bool = False,
        ollama_host: str = "http://127.0.0.1:11434",
        comfyui_url: str = "http://127.0.0.1:8188",
    ) -> dict[str, Any]:
        bridge_status = self.controller.get_status()
        telemetry = self.controller.telemetry.snapshot(
            include_ship=True,
            ollama_host=ollama_host,
            comfyui_url=comfyui_url,
            ssh_target=bridge_status["ssh"]["host"],
        )
        mcp_probe = self.probe_ship_via_mcp(force=include_mcp_probe)
        navigation = self.get_navigation()

        remote_mcp = bridge_status.get("remoteMcp") or {}
        ssh_info = bridge_status.get("ssh") or {}
        ship_snap = telemetry.get("ship") or {}
        probe_ship = mcp_probe.get("shipHost") or {}

        # Zintegrowane metryki statku (priorytet: sonda MCP -> sonda SSH -> host lokalny)
        if mcp_probe.get("ok") and probe_ship:
            connected_via = str(mcp_probe.get("transport") or "remote-mcp-root")
        elif ship_snap.get("online"):
            connected_via = "openssh-root"
        else:
            connected_via = "local-host"

        # 1. Lista usług i ich dostępności
        services_out: list[dict[str, Any]] = []
        probe_svcs = mcp_probe.get("services") or {}
        if probe_svcs:
            for unit, label, cat in SVL364_TRACKED_UNITS:
                raw_state = str(probe_svcs.get(unit, "unknown")).lower()
                mapped = (
                    "online"
                    if raw_state == "active"
                    else "degraded"
                    if raw_state in {"activating", "reloading"}
                    else "offline"
                    if raw_state in {"inactive", "failed", "deactivating"}
                    else "unknown"
                )
                services_out.append({
                    "id": unit,
                    "name": label,
                    "category": cat,
                    "unit": unit,
                    "status": mapped,
                    "rawState": raw_state,
                    "source": connected_via,
                    "detail": f"systemd ({unit}): {raw_state}",
                })
        else:
            # Gdy zdalna sonda systemd nie jest jeszcze podłączona — pokaż prawdziwy stan usług z pomiarów bramy i MCP
            svc_snap = telemetry.get("services") or {}
            py_k = svc_snap.get("python_kernel") or {}
            oll = svc_snap.get("ollama") or {}
            comfy = svc_snap.get("comfyui") or {}
            services_out.extend([
                {
                    "id": "svl-remote-mcp",
                    "name": "Zdalny serwer MCP SVL-364 (Zero-IP)",
                    "category": "mcp",
                    "unit": "svl-mcp.service",
                    "status": "online" if remote_mcp.get("connected") else ("degraded" if remote_mcp.get("configured") else "offline"),
                    "rawState": "connected" if remote_mcp.get("connected") else ("configured" if remote_mcp.get("configured") else "unconfigured"),
                    "source": "mcp-bridge",
                    "detail": remote_mcp.get("url") or "Nie skonfigurowano — połącz przez URL + token MCP",
                },
                {
                    "id": "svl-openssh",
                    "name": f"Mostek OpenSSH ({ssh_info.get('uri', 'ssh://Ship')})",
                    "category": "network",
                    "unit": "ssh.service",
                    "status": "online" if ship_snap.get("online") else ("degraded" if ssh_info.get("targetReachable") else "offline"),
                    "rawState": "online" if ship_snap.get("online") else "offline",
                    "source": "openssh",
                    "detail": ship_snap.get("hostname") or ssh_info.get("targetError") or "Brak połączenia SSH",
                },
                {
                    "id": "svl-python-os",
                    "name": "Jądro SVL Python OS (:8085)",
                    "category": "core",
                    "unit": "svl-python-os.service",
                    "status": "online" if py_k.get("reachable") else "offline",
                    "rawState": "active" if py_k.get("reachable") else "inactive",
                    "source": "local-probe",
                    "detail": f"PID {py_k.get('pid', '?')} · uptime {py_k.get('uptime_sec', 0)} s",
                },
                {
                    "id": "ollama",
                    "name": "Ollama AI Engine",
                    "category": "ai",
                    "unit": "ollama.service",
                    "status": "online" if (oll.get("reachable") and not oll.get("synthetic")) else ("degraded" if oll.get("reachable") else "offline"),
                    "rawState": f"v{oll.get('version')}" if oll.get("version") else "offline",
                    "source": "local-probe",
                    "detail": f"{oll.get('url', '')} · {oll.get('latency_ms', '?')} ms" if oll.get("reachable") else str(oll.get("error") or "niedostępna"),
                },
                {
                    "id": "svl-comfyui",
                    "name": "ComfyUI Vision / Render",
                    "category": "ai",
                    "unit": "svl-comfyui.service",
                    "status": "online" if comfy.get("reachable") else "offline",
                    "rawState": f"HTTP {comfy.get('status_code')}" if comfy.get("reachable") else "offline",
                    "source": "local-probe",
                    "detail": f"{comfy.get('url', '')} · {comfy.get('latency_ms', '?')} ms" if comfy.get("reachable") else str(comfy.get("error") or "niedostępny"),
                },
                {
                    "id": "svl-mcp-gateway",
                    "name": "Brama MCP JSON-RPC (/api/mcp/svl364)",
                    "category": "mcp",
                    "unit": "svl-gateway.service",
                    "status": "online",
                    "rawState": "active",
                    "source": "local-probe",
                    "detail": f"MCP 2025-03-26 · narzędzi: {len(bridge_status.get('mcp', {}).get('tools', []))}",
                },
            ])

        # 2. Sensory sprzętowe i anomalie
        sensors: list[dict[str, Any]] = []
        host = telemetry.get("host") or {}
        cpu = host.get("cpu") or {}
        mem = host.get("memory") or {}
        disk = host.get("disk") or {}
        gpu = host.get("gpu") or {}
        fw = host.get("firewall") or {}

        cpu_pct = cpu.get("percent")
        sensors.append({
            "id": "sensor-cpu",
            "label": "Obciążenie CPU",
            "value": f"{cpu_pct:.1f}%" if isinstance(cpu_pct, (int, float)) else "brak danych",
            "numericValue": cpu_pct,
            "unit": "%",
            "status": "critical" if isinstance(cpu_pct, (int, float)) and cpu_pct >= 92 else ("warn" if isinstance(cpu_pct, (int, float)) and cpu_pct >= 75 else "nominal"),
            "source": "local-host",
        })
        ram_pct = mem.get("ram_percent")
        sensors.append({
            "id": "sensor-ram",
            "label": "Pamięć RAM",
            "value": f"{ram_pct:.1f}%" if isinstance(ram_pct, (int, float)) else "brak danych",
            "numericValue": ram_pct,
            "unit": "%",
            "status": "critical" if isinstance(ram_pct, (int, float)) and ram_pct >= 92 else ("warn" if isinstance(ram_pct, (int, float)) and ram_pct >= 80 else "nominal"),
            "source": "local-host",
        })
        disk_pct = disk.get("percent")
        disk_free = disk.get("free_gb")
        sensors.append({
            "id": "sensor-disk",
            "label": "Dysk / (wolne)",
            "value": f"{disk_free} GB wolne" if disk_free is not None else "brak danych",
            "numericValue": disk_pct,
            "unit": "%",
            "status": "critical" if (disk_free is not None and float(disk_free) < 3.0) else ("warn" if (disk_free is not None and float(disk_free) < 8.0) else "nominal"),
            "source": "local-host",
        })
        if gpu.get("available") and gpu.get("devices"):
            g0 = gpu["devices"][0]
            g_temp = g0.get("temperature_c")
            sensors.append({
                "id": "sensor-gpu",
                "label": f"GPU ({g0.get('name', 'NVIDIA')})",
                "value": f"{g0.get('utilization_percent', '?')}% · {g_temp}°C" if g_temp is not None else f"{g0.get('utilization_percent', '?')}%",
                "numericValue": g_temp,
                "unit": "°C",
                "status": "critical" if isinstance(g_temp, (int, float)) and g_temp >= 85 else ("warn" if isinstance(g_temp, (int, float)) and g_temp >= 75 else "nominal"),
                "source": "local-host",
            })
        sensors.append({
            "id": "sensor-firewall",
            "label": f"Zapora ({fw.get('tool', 'ufw')})",
            "value": str(fw.get("state") or "unknown").upper(),
            "numericValue": None,
            "unit": "",
            "status": "nominal" if fw.get("state") == "active" else "warn",
            "source": "local-host",
        })
        sensors.extend(mcp_probe.get("thermals") or read_local_thermal_sensors())

        # 3. Feed powiadomień, transmisji, alarmów krytycznych i incydentów
        feed: list[dict[str, Any]] = []
        stored_incidents = self.list_stored_incidents(limit=80)
        feed.extend(stored_incidents)

        # Auto-alarmy z nieaktywnych / uszkodzonych usług na statku
        for failed_line in mcp_probe.get("failedUnits") or []:
            feed.append({
                "id": f"auto-failed-{abs(hash(failed_line)) % 1000000}",
                "category": "alarm",
                "severity": "CRITICAL",
                "title": f"SVL-364: uszkodzona usługa systemd",
                "message": failed_line,
                "source": "svl364-mcp:systemd",
                "resolved": False,
                "createdAt": mcp_probe.get("probedAt"),
                "ephemeral": True,
            })
        for jerr in (mcp_probe.get("journalErrors") or [])[:8]:
            feed.append({
                "id": f"auto-jerr-{abs(hash(jerr)) % 1000000}",
                "category": "incident",
                "severity": "WARN",
                "title": "SVL-364: błąd w dzienniku systemowym (journalctl)",
                "message": jerr,
                "source": "svl364-mcp:journalctl",
                "resolved": False,
                "createdAt": mcp_probe.get("probedAt"),
                "ephemeral": True,
            })

        # Anomalie sensorów
        for s in sensors:
            if s["status"] in {"warn", "critical"}:
                feed.append({
                    "id": f"auto-sensor-{s['id']}",
                    "category": "sensor",
                    "severity": "CRITICAL" if s["status"] == "critical" else "WARN",
                    "title": f"Sensor: {s['label']} — {s['value']}",
                    "message": f"Wykryto stan {s['status'].upper()} na sensorze `{s['label']}` (źródło: {s['source']}).",
                    "source": f"sensor:{s['source']}",
                    "resolved": False,
                    "createdAt": telemetry.get("collected_at"),
                    "ephemeral": True,
                })

        # Powiadomienia systemowe z SQLite (ship-monitor, transmisje, alarmy Jyn)
        list_notifs = getattr(self.kernel, "list_family_notifications", None)
        if callable(list_notifs):
            try:
                raw_notifs = (list_notifs(limit=40) or {}).get("notifications") or []
                for n in raw_notifs:
                    cat, sev = self._classify_notification(n)
                    content_str = str(n.get("content") or "").strip()
                    first_line = content_str.splitlines()[0].lstrip("#*!🔔⚠️🚨 ").strip()[:140] or "Powiadomienie SVL-364"
                    feed.append({
                        "id": str(n.get("id") or f"notif-{uuid.uuid4().hex[:8]}"),
                        "category": cat,
                        "severity": sev,
                        "title": first_line,
                        "message": content_str[:600],
                        "source": str(n.get("label") or "Jyn"),
                        "resolved": False,
                        "createdAt": str(n.get("createdAt") or ""),
                        "ephemeral": True,
                    })
            except Exception:
                pass

        # Ostatnie aktywności transmisji MCP/SSH
        for act in (bridge_status.get("recentActivity") or [])[:8]:
            ok_act = act.get("exitCode", 0) == 0
            feed.append({
                "id": str(act.get("id") or f"act-{uuid.uuid4().hex[:6]}"),
                "category": "transmission" if ok_act else "incident",
                "severity": "INFO" if ok_act else "WARN",
                "title": f"MCP/SSH · {act.get('tool') or act.get('command', 'operacja')[:70]}",
                "message": str(act.get("output") or "")[:360],
                "source": str(act.get("transport") or act.get("origin") or "mcp-bridge"),
                "resolved": ok_act,
                "createdAt": str(act.get("timestamp") or ""),
                "ephemeral": True,
            })

        # Sortuj malejąco po czasie, deduplikuj po id
        seen_ids: set[str] = set()
        deduped_feed: list[dict[str, Any]] = []
        for entry in sorted(feed, key=lambda x: str(x.get("createdAt") or ""), reverse=True):
            eid = str(entry.get("id") or "")
            if eid and eid in seen_ids:
                continue
            seen_ids.add(eid)
            deduped_feed.append(entry)

        open_critical = sum(1 for f in deduped_feed if f["severity"] == "CRITICAL" and not f.get("resolved"))
        open_warn = sum(1 for f in deduped_feed if f["severity"] == "WARN" and not f.get("resolved"))
        transmissions_count = sum(1 for f in deduped_feed if f["category"] == "transmission")
        open_incidents = sum(1 for f in stored_incidents if not f.get("resolved"))

        return {
            "ok": True,
            "collectedAt": datetime.now(timezone.utc).isoformat(),
            "connectedVia": connected_via,
            "mcpBridge": {
                "remoteMcp": remote_mcp,
                "ssh": ssh_info,
                "rootChannel": bridge_status.get("rootChannel"),
                "toolsCount": len(bridge_status.get("mcp", {}).get("tools", [])),
                "callsCount": bridge_status.get("mcp", {}).get("callsCount", 0),
                "probe": {
                    "ok": mcp_probe.get("ok"),
                    "transport": mcp_probe.get("transport"),
                    "probedAt": mcp_probe.get("probedAt"),
                    "durationMs": mcp_probe.get("durationMs"),
                    "error": mcp_probe.get("error"),
                    "shipHost": probe_ship,
                },
            },
            "telemetry": telemetry,
            "services": services_out,
            "navigation": navigation,
            "sensors": sensors,
            "feed": deduped_feed[:80],
            "incidents": stored_incidents[:40],
            "summary": {
                "servicesOnline": sum(1 for s in services_out if s["status"] == "online"),
                "servicesTotal": len(services_out),
                "criticalAlarms": open_critical,
                "warnings": open_warn,
                "transmissions": transmissions_count,
                "openIncidents": open_incidents,
            },
            "serverRevision": self.kernel.get_server_revision(),
        }
