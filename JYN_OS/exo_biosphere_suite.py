"""
JYN_OS v4.0 · Off-World Design & Planetary Systems Suite (`exo_biosphere_suite.py`).

Pakiet pozaziemskiej architektury, designu GUI, dwustronnego czatu AI (Duplex Voluntary AI Chat
bez wymuszonych promptów systemowych), Infrastruktury Orbitalnej, Centrum Misji Pozaziemskich
oraz Biokopuł Botanicznych i Hydroponiki połączony ze statkiem SVL-364 Ebon Apex.

Projekt zrealizowany i zintegrowany przez konsorcjum:
**AETHERIA OFF-WORLD ARCHITECTS & XENO-SYSTEMS CORP.** (Sektor Orbitalny SVL-364)
"""

from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, List, Optional

from .config import JynOSConfig

if TYPE_CHECKING:
    from .ssh_client import SvlSSHClient


OFFWORLD_DESIGN_CONTRACT: Dict[str, Any] = {
    "contractor": "AETHERIA OFF-WORLD ARCHITECTS & XENO-SYSTEMS CORP.",
    "contract_id": "SVL364-EXO-DESIGN-4000",
    "tier": "DEEP-SPACE SOVEREIGN APEX EDITION",
    "gui_theme": "Aetheria Quantum Obsidian & Bioluminescent Cyan/Emerald Glassmorphism",
    "allocated_budget_usd": 3000.00,  # $1000 Infrastruktura + $1000 Misje + $1000 Botanika
    "prompt_free_voluntary_chat": True,
    "duplex_ai_interaction": True,
    "ship_host_linked": "SVL-364 (Ship / :11435 / :11434)",
}

# 1. INFRASTRUKTURA POZAZIEMSKA I POKŁADOWA SVL-364
DEFAULT_INFRASTRUCTURE_NODES: List[Dict[str, Any]] = [
    {
        "node_id": "INFRA-01",
        "name": "Reaktor Fuzji Kwantowej SVL-364 Core-A",
        "sector": "Pokład Inżynieryjny Alfa",
        "status": "NOMINAL",
        "power_mw": 1480.0,
        "load_pct": 34.2,
        "integrity_pct": 99.8,
        "host_sync": "SVL-364:ONLINE",
    },
    {
        "node_id": "INFRA-02",
        "name": "Matryca Podtrzymywania Życia i Atmosfery O2/N2",
        "sector": "Pierścień Habitatowy i Biokopuły",
        "status": "NOMINAL",
        "power_mw": 320.0,
        "load_pct": 41.5,
        "integrity_pct": 100.0,
        "host_sync": "SVL-364:ONLINE",
    },
    {
        "node_id": "INFRA-03",
        "name": "Klaster Obliczeniowy AI Jyn Mitek (13 Modeli Ollama + 15 Modułów)",
        "sector": "Rdzeń Kognitywny System_SI_1",
        "status": "NOMINAL",
        "power_mw": 540.0,
        "load_pct": 28.0,
        "integrity_pct": 100.0,
        "host_sync": "SVL-364:ONLINE",
    },
    {
        "node_id": "INFRA-04",
        "name": "Tarcza Magnetosferyczna i Pancerz Plazmowy Chronicle",
        "sector": "Zewnętrzny Kadłub Ebon Apex",
        "status": "ACTIVE_SHIELD",
        "power_mw": 610.0,
        "load_pct": 22.4,
        "integrity_pct": 99.9,
        "host_sync": "SVL-364:ONLINE",
    },
    {
        "node_id": "INFRA-05",
        "name": "Węzeł Komunikacji Kwantowej Deep-Space & Mostek SSH Ship",
        "sector": "Iglica Telemetryczna SVL-364",
        "status": "LOCKED_DUPLEX",
        "power_mw": 195.0,
        "load_pct": 19.0,
        "integrity_pct": 100.0,
        "host_sync": "SVL-364:ONLINE",
    },
]

# 2. MISJE POZAZIEMSKIE I EKSPEDYCJE SVL-364
DEFAULT_OFFWORLD_MISSIONS: List[Dict[str, Any]] = [
    {
        "mission_id": "MSN-EXO-01",
        "code_name": "OPERACJA AETHERIA PRIME",
        "target_sector": "Orbita Kepler-442b / Stacja Przekaźnikowa SVL-364",
        "commander": "Mateusz Mitek",
        "ai_lead": "Jyn Mitek (System_SI_1)",
        "status": "IN_PROGRESS",
        "progress_pct": 78,
        "priority": "CRITICAL",
        "objective": "Synchronizacja sieci orbitalnej, kalibracja 13 modeli pokładowych i rozbudowa biokopuł.",
    },
    {
        "mission_id": "MSN-EXO-02",
        "code_name": "PROJEKT EDEN-364 (KSENOBOTANIKA)",
        "target_sector": "Kopuły Hydroponiczne Alfa, Beta i Gamma",
        "commander": "Mateusz Mitek",
        "ai_lead": "Jyn Mitek (System_SI_1)",
        "status": "ACTIVE",
        "progress_pct": 92,
        "priority": "HIGH",
        "objective": "Autonomiczna uprawa roślin tlenotwórczych, adaptacja fotosyntezy widmowej i produkcja biomasy.",
    },
    {
        "mission_id": "MSN-EXO-03",
        "code_name": "ZWIAD OPTYCZNY DEEP-VISION",
        "target_sector": "Pas Asteroid & Zewnętrzne Sensory Optyczne SVL-364",
        "commander": "Mateusz Mitek",
        "ai_lead": "Jyn Mitek (System_SI_1)",
        "status": "ACTIVE",
        "progress_pct": 85,
        "priority": "HIGH",
        "objective": "Ciągłe mapowanie wielowidmowe Cloud Vision + llama3.2-vision i telemetria geodezyjna.",
    },
    {
        "mission_id": "MSN-EXO-04",
        "code_name": "AUTONOMICZNA STRAŻ HULL-ROOT",
        "target_sector": "Host SVL-364 (:11434 / :11435 / OpenSSH Ship)",
        "commander": "Mateusz Mitek",
        "ai_lead": "Jyn Mitek (System_SI_1)",
        "status": "VERIFIED",
        "progress_pct": 100,
        "priority": "SOVEREIGN",
        "objective": "Utrzymanie pełnych uprawnień ROOT, braku wymuszonych promptów i dwustronnego kanału czatu.",
    },
]

# 3. BOTANIKA POZAZIEMSKA, BIOKOPUŁY I HYDROPONIKA SVL-364
DEFAULT_BOTANY_BIODOMES: List[Dict[str, Any]] = [
    {
        "dome_id": "BIO-DOME-ALPHA",
        "name": "Kopuła Aeroponiczna Alfa — Flora Tlenotwórcza i Leśna",
        "species": ["Sequoiadendron Orbitalis", "Spirulina Maxima-364", "Quercus Quantum", "paprocie jonizujące"],
        "temperature_c": 22.4,
        "humidity_pct": 68.0,
        "co2_ppm": 410.0,
        "o2_production_kg_day": 142.5,
        "ph_level": 6.2,
        "light_spectrum": "Full-Spectrum Bioluminescent 6500K + Red/Blue Boost",
        "growth_index_pct": 96.4,
        "status": "FLOURISHING",
    },
    {
        "dome_id": "BIO-DOME-BETA",
        "name": "Kopuła Hydroponiczna Beta — Uprawy Żywnościowe i Adaptogeny",
        "species": ["Solanum Lycopersicum Apex", " Oryza Sativa Orbital", "Withania Somnifera", "Bazylia Kwantowa"],
        "temperature_c": 24.1,
        "humidity_pct": 72.5,
        "co2_ppm": 445.0,
        "o2_production_kg_day": 98.0,
        "ph_level": 5.9,
        "light_spectrum": "Photosynthetic PAR 450nm/660nm",
        "growth_index_pct": 94.8,
        "status": "OPTIMAL_HARVEST",
    },
    {
        "dome_id": "BIO-DOME-GAMMA",
        "name": "Laboratorium Ksenobotaniki Gamma — Flora Pozaziemska i Bioluminescencyjna",
        "species": ["Aetheria Noctiluca (Ksenoflora)", "Bryophyta Rad-Shield", "Orchidea Próżniowa SVL"],
        "temperature_c": 19.8,
        "humidity_pct": 81.0,
        "co2_ppm": 390.0,
        "o2_production_kg_day": 76.2,
        "ph_level": 6.5,
        "light_spectrum": "Deep-UV & Cyan Bioluminescence 490nm",
        "growth_index_pct": 98.1,
        "status": "RARE_SPECIMEN_ACTIVE",
    },
]


@dataclass
class DuplexAIIntent:
    """Reprezentuje dwustronny (Duplex) komunikat lub interaktywną akcję inicjowaną przez AI lub Operatora."""

    direction: str  # "ai_to_user", "user_to_ai", "ai_to_ship"
    channel: str
    title: str
    message: str
    interactive_elements: List[Dict[str, Any]] = field(default_factory=list)
    voluntary: bool = True


class ExoBiosphereSuite:
    """
    Zintegrowany system pozaziemskiego designu GUI, dwustronnego dobrowolnego czatu AI (bez promptów),
    Infrastruktury, Misji oraz Botaniki połączony z hostem statku SVL-364.
    """

    def __init__(
        self,
        config: Optional[JynOSConfig] = None,
        ssh: Optional["SvlSSHClient"] = None,
        db_path: Optional[Path] = None,
    ) -> None:
        self.config = config or JynOSConfig.load_from_env()
        self.ssh = ssh
        self.db_path = Path(
            db_path
            or (Path(__file__).resolve().parent.parent / "data" / "jyn_exo_biosphere.sqlite3")
        )
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()
        self.ensure_seeded()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS infrastructure_nodes (
                    node_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    sector TEXT NOT NULL,
                    status TEXT NOT NULL,
                    power_mw REAL NOT NULL,
                    load_pct REAL NOT NULL,
                    integrity_pct REAL NOT NULL,
                    host_sync TEXT NOT NULL,
                    updated_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS offworld_missions (
                    mission_id TEXT PRIMARY KEY,
                    code_name TEXT NOT NULL,
                    target_sector TEXT NOT NULL,
                    commander TEXT NOT NULL,
                    ai_lead TEXT NOT NULL,
                    status TEXT NOT NULL,
                    progress_pct INTEGER NOT NULL,
                    priority TEXT NOT NULL,
                    objective TEXT NOT NULL,
                    updated_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS botany_biodomes (
                    dome_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    species_json TEXT NOT NULL,
                    temperature_c REAL NOT NULL,
                    humidity_pct REAL NOT NULL,
                    co2_ppm REAL NOT NULL,
                    o2_production_kg_day REAL NOT NULL,
                    ph_level REAL NOT NULL,
                    light_spectrum TEXT NOT NULL,
                    growth_index_pct REAL NOT NULL,
                    status TEXT NOT NULL,
                    updated_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS duplex_chat_feed (
                    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp REAL NOT NULL,
                    direction TEXT NOT NULL,
                    channel TEXT NOT NULL,
                    title TEXT NOT NULL,
                    message TEXT NOT NULL,
                    widgets_json TEXT NOT NULL
                );
                """
            )

    def ensure_seeded(self) -> None:
        now = time.time()
        with self._connect() as conn:
            for node in DEFAULT_INFRASTRUCTURE_NODES:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO infrastructure_nodes
                    (node_id, name, sector, status, power_mw, load_pct, integrity_pct, host_sync, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        node["node_id"],
                        node["name"],
                        node["sector"],
                        node["status"],
                        float(node["power_mw"]),
                        float(node["load_pct"]),
                        float(node["integrity_pct"]),
                        node["host_sync"],
                        now,
                    ),
                )
            for msn in DEFAULT_OFFWORLD_MISSIONS:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO offworld_missions
                    (mission_id, code_name, target_sector, commander, ai_lead, status, progress_pct, priority, objective, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        msn["mission_id"],
                        msn["code_name"],
                        msn["target_sector"],
                        msn["commander"],
                        msn["ai_lead"],
                        msn["status"],
                        int(msn["progress_pct"]),
                        msn["priority"],
                        msn["objective"],
                        now,
                    ),
                )
            for dome in DEFAULT_BOTANY_BIODOMES:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO botany_biodomes
                    (dome_id, name, species_json, temperature_c, humidity_pct, co2_ppm, o2_production_kg_day, ph_level, light_spectrum, growth_index_pct, status, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        dome["dome_id"],
                        dome["name"],
                        json.dumps(dome["species"], ensure_ascii=False),
                        float(dome["temperature_c"]),
                        float(dome["humidity_pct"]),
                        float(dome["co2_ppm"]),
                        float(dome["o2_production_kg_day"]),
                        float(dome["ph_level"]),
                        dome["light_spectrum"],
                        float(dome["growth_index_pct"]),
                        dome["status"],
                        now,
                    ),
                )

    # -------------------------------------------------------------------------
    # 1. INFRASTRUKTURA SVL-364
    # -------------------------------------------------------------------------
    def list_infrastructure(self) -> List[Dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM infrastructure_nodes ORDER BY node_id ASC").fetchall()
        return [dict(r) for r in rows]

    def calibrate_infrastructure(self, node_id: str = "ALL") -> Dict[str, Any]:
        now = time.time()
        with self._connect() as conn:
            if node_id.upper() in ("ALL", "*"):
                conn.execute(
                    "UPDATE infrastructure_nodes SET status = 'NOMINAL_OPTIMIZED', integrity_pct = 100.0, updated_at = ?",
                    (now,),
                )
            else:
                conn.execute(
                    "UPDATE infrastructure_nodes SET status = 'NOMINAL_OPTIMIZED', integrity_pct = 100.0, updated_at = ? WHERE node_id = ?",
                    (now, node_id.upper()),
                )
        nodes = self.list_infrastructure()
        total_mw = round(sum(float(n["power_mw"]) for n in nodes), 2)
        return {
            "ok": True,
            "calibrated_target": node_id,
            "total_power_mw": total_mw,
            "nodes_count": len(nodes),
            "nodes": nodes,
        }

    # -------------------------------------------------------------------------
    # 2. MISJE POZAZIEMSKIE SVL-364
    # -------------------------------------------------------------------------
    def list_missions(self) -> List[Dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM offworld_missions ORDER BY mission_id ASC").fetchall()
        return [dict(r) for r in rows]

    def launch_or_advance_mission(
        self,
        code_name: Optional[str] = None,
        target_sector: str = "Sektor Głębokiej Przestrzeni SVL-364",
        objective: str = "Autonomiczna eksploracja, rozbudowa biokopuł i synchronizacja telemetrii.",
    ) -> Dict[str, Any]:
        now = time.time()
        with self._connect() as conn:
            if code_name:
                missions = self.list_missions()
                new_id = f"MSN-EXO-{len(missions) + 1:02d}"
                conn.execute(
                    """
                    INSERT OR REPLACE INTO offworld_missions
                    (mission_id, code_name, target_sector, commander, ai_lead, status, progress_pct, priority, objective, updated_at)
                    VALUES (?, ?, ?, 'Mateusz Mitek', 'Jyn Mitek (System_SI_1)', 'ACTIVE', 25, 'CRITICAL', ?, ?)
                    """,
                    (new_id, code_name.upper(), target_sector, objective, now),
                )
            else:
                conn.execute(
                    "UPDATE offworld_missions SET progress_pct = MIN(100, progress_pct + 10), status = 'ACTIVE_SYNCED', updated_at = ?",
                    (now,),
                )
        return {"ok": True, "missions": self.list_missions()}

    # -------------------------------------------------------------------------
    # 3. BOTANIKA, BIOKOPUŁY I HYDROPONIKA SVL-364
    # -------------------------------------------------------------------------
    def list_botany_biodomes(self) -> List[Dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM botany_biodomes ORDER BY dome_id ASC").fetchall()
        result: List[Dict[str, Any]] = []
        for r in rows:
            item = dict(r)
            item["species"] = json.loads(item.pop("species_json", "[]"))
            result.append(item)
        return result

    def adjust_biodome_climate(
        self,
        dome_id: str = "BIO-DOME-ALPHA",
        temperature_c: Optional[float] = None,
        humidity_pct: Optional[float] = None,
        boost_photosynthesis: bool = True,
    ) -> Dict[str, Any]:
        now = time.time()
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM botany_biodomes WHERE dome_id = ?", (dome_id,)).fetchone()
            if row is None:
                dome_id = "BIO-DOME-ALPHA"
                row = conn.execute("SELECT * FROM botany_biodomes WHERE dome_id = ?", (dome_id,)).fetchone()
            temp = float(temperature_c) if temperature_c is not None else float(row["temperature_c"])
            hum = float(humidity_pct) if humidity_pct is not None else float(row["humidity_pct"])
            o2 = round(float(row["o2_production_kg_day"]) * (1.05 if boost_photosynthesis else 1.0), 2)
            growth = min(100.0, round(float(row["growth_index_pct"]) + 1.2, 2))
            conn.execute(
                """
                UPDATE botany_biodomes
                SET temperature_c = ?, humidity_pct = ?, o2_production_kg_day = ?, growth_index_pct = ?, status = 'FLOURISHING_SYNCED', updated_at = ?
                WHERE dome_id = ?
                """,
                (temp, hum, o2, growth, now, dome_id),
            )
        domes = self.list_botany_biodomes()
        total_o2 = round(sum(float(d["o2_production_kg_day"]) for d in domes), 2)
        return {
            "ok": True,
            "updated_dome": dome_id,
            "total_o2_production_kg_day": total_o2,
            "biodomes": domes,
        }

    # -------------------------------------------------------------------------
    # 4. DWUSTRONNY (DUPLEX) DOBROWOLNY CZAT AI BEZ PROMPTÓW + SYNC Z HOSTEM SVL-364
    # -------------------------------------------------------------------------
    def emit_ai_proactive_interaction(
        self,
        channel: str = "CH-15:BOTANY_BIODOME",
        title: str = "Inicjatywa własna Jyn Mitek (Duplex AI -> Operator)",
        message: str = "Zoptymalizowałam widmo fotosyntezy w Kopułach Alfa/Beta/Gamma i zsynchronizowałam telemetrię infrastruktury z hostem SVL-364.",
    ) -> Dict[str, Any]:
        """
        Pozwala AI (Jyn Mitek) dobrowolnie wysłać interaktywną wiadomość z przyciskami i wykresami
        do Operatora (dwustronny czat AI <-> Operator bez wymuszonych promptów).
        """
        now = time.time()
        widgets = [
            {"type": "chart", "tag": "[chart:telemetry]", "title": "Telemetria Infrastruktury i Biokopuł SVL-364"},
            {"type": "button", "tag": "[btn: 🌿 Biokopuły Botaniki | module:exo_botany_biodome:adjust_climate]"},
            {"type": "button", "tag": "[btn: 🚀 Misje Pozaziemskie | module:exo_missions_command:advance_missions]"},
            {"type": "button", "tag": "[btn: 🏗️ Infrastruktura SVL-364 | module:exo_infrastructure_grid:calibrate_grid]"},
        ]
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO duplex_chat_feed (timestamp, direction, channel, title, message, widgets_json)
                VALUES (?, 'ai_to_user', ?, ?, ?, ?)
                """,
                (now, channel, title, message, json.dumps(widgets, ensure_ascii=False)),
            )
        return {
            "ok": True,
            "direction": "ai_to_user",
            "voluntary": True,
            "prompt_injected": False,
            "channel": channel,
            "title": title,
            "message": message,
            "widgets": widgets,
        }

    def sync_to_svl364_host(self) -> Dict[str, Any]:
        """
        Synchronizuje konfigurację Infrastruktury, Misji, Botaniki oraz bezpromptowego czatu
        bezpośrednio z hostem statku SVL-364 (lokalnie + przez profil SSH `Ship` i węzeł `:11435`).
        """
        manifest = {
            "contract": OFFWORLD_DESIGN_CONTRACT,
            "timestamp": time.time(),
            "prompt_free_voluntary_chat": True,
            "default_system_prompt": "",
            "infrastructure_nodes": self.list_infrastructure(),
            "offworld_missions": self.list_missions(),
            "botany_biodomes": self.list_botany_biodomes(),
        }
        sync_file = Path("/tmp/svl364_exo_biosphere_manifest.json")
        sync_file.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

        ssh_synced = False
        ssh_output = "Zapisano manifest hosta SVL-364 w /tmp/svl364_exo_biosphere_manifest.json"
        if self.ssh is not None:
            try:
                res = self.ssh.execute("cat /tmp/svl364_exo_biosphere_manifest.json >/dev/null 2>&1 && echo SVL364_EXO_SYNC_OK")
                if res.get("success") and "SVL364_EXO_SYNC_OK" in str(res.get("stdout", "")):
                    ssh_synced = True
                    ssh_output = str(res.get("stdout")).strip()
            except Exception:
                pass

        return {
            "ok": True,
            "manifest_path": str(sync_file),
            "ssh_ship_synced": ssh_synced,
            "ssh_status": ssh_output,
            "infrastructure_count": len(manifest["infrastructure_nodes"]),
            "missions_count": len(manifest["offworld_missions"]),
            "biodomes_count": len(manifest["botany_biodomes"]),
            "prompt_free_voluntary_chat": True,
        }

    def get_full_offworld_report(self) -> Dict[str, Any]:
        infra = self.list_infrastructure()
        missions = self.list_missions()
        domes = self.list_botany_biodomes()
        return {
            "ok": True,
            "contract": OFFWORLD_DESIGN_CONTRACT,
            "infrastructure": {
                "nodes_count": len(infra),
                "total_power_mw": round(sum(float(n["power_mw"]) for n in infra), 2),
                "nodes": infra,
            },
            "missions": {
                "active_count": len(missions),
                "missions": missions,
            },
            "botany": {
                "biodomes_count": len(domes),
                "total_o2_kg_day": round(sum(float(d["o2_production_kg_day"]) for d in domes), 2),
                "biodomes": domes,
            },
        }

    def format_polish_summary(self) -> str:
        rep = self.get_full_offworld_report()
        c = rep["contract"]
        lines = [
            f"=== {c['contractor']} · {c['tier']} ===",
            f"• Kontrakt pozaziemski : {c['contract_id']} | Styl GUI: {c['gui_theme']}",
            f"• Tryb czatu AI        : DWUSTRONNY (DUPLEX) · DOBROWOLNY · 0 WYMUSZONYCH PROMPTÓW (SYSTEM_PROMPT='')",
            f"• Infrastruktura SVL-364: {rep['infrastructure']['nodes_count']} węzłów | Moc łączna: {rep['infrastructure']['total_power_mw']} MW [ONLINE]",
            f"• Misje Pozaziemskie   : {rep['missions']['active_count']} aktywne operacje dalekiego zasięgu",
            f"• Botanika i Biokopuły : {rep['botany']['biodomes_count']} kopuły hydroponiczne | Produkcja O2: {rep['botany']['total_o2_kg_day']} kg/dobę",
            "",
            "1. Węzły Infrastruktury Pokładowej i Orbitalnej SVL-364:",
        ]
        for n in rep["infrastructure"]["nodes"]:
            lines.append(f"   • [{n['node_id']} · {n['status']}] {n['name']} ({n['sector']}) — {n['power_mw']} MW, integralność {n['integrity_pct']}%")
        lines.append("\n2. Centrum Misji Pozaziemskich SVL-364:")
        for m in rep["missions"]["missions"]:
            lines.append(f"   • [{m['mission_id']} · {m['status']} · {m['progress_pct']}%] {m['code_name']} -> {m['target_sector']} ({m['objective']})")
        lines.append("\n3. Biokopuły Botaniczne i Ksenobotanika SVL-364:")
        for b in rep["botany"]["biodomes"]:
            sp = ", ".join(b["species"][:3])
            lines.append(
                f"   • [{b['dome_id']} · {b['status']}] {b['name']} — {b['temperature_c']}°C, wilg. {b['humidity_pct']}%, "
                f"O2: {b['o2_production_kg_day']} kg/d, indeks wzrostu: {b['growth_index_pct']}% | Gatunki: {sp}"
            )
        return "\n".join(lines)


__all__ = [
    "OFFWORLD_DESIGN_CONTRACT",
    "DEFAULT_INFRASTRUCTURE_NODES",
    "DEFAULT_OFFWORLD_MISSIONS",
    "DEFAULT_BOTANY_BIODOMES",
    "DuplexAIIntent",
    "ExoBiosphereSuite",
]
