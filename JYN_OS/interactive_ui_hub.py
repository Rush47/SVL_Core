"""
JYN_OS v3.2 · Enterprise Interactive AI UI & Generative Widget Library (`interactive_ui_hub.py`).

Najlepsza biblioteka elementów interaktywnych dla AI do używania na czacie Jyn Mitek
(CopilotKit + Vercel AI SDK Generative UI + Google A2UI + AG-UI + Mermaid/Recharts/Framer Motion Protocol).

Zapewnia:
- Bezkomendowy interfejs oparty wyłącznie na klikalnych przyciskach akcji (`[btn: Etykieta | module:id:action]`),
  kartach modułów (`[module_card: ...]`), wykresach telemetrycznych (`[chart: ...]`),
  inspektorze wizyjnym (`[vision_card: ...]`), tabelach i przełącznikach.
- Automatyczne dopasowywanie i wstrzykiwanie komponentów UI do odpowiedzi czatu Jyn Mitek.
- Wykonywanie kliknięć przycisków bez konieczności wpisywania jakichkolwiek komend przez Operatora.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class InteractiveButton:
    """Reprezentuje pojedynczy klikalny przycisk akcji w czacie Jyn Mitek."""

    button_id: str
    label: str
    module_id: str
    action: str
    variant: str = "primary"  # primary, success, warning, danger, info
    icon: str = "⚡"
    payload: Dict[str, Any] = field(default_factory=dict)

    def to_tag(self) -> str:
        return f"[btn: {self.icon} {self.label} | module:{self.module_id}:{self.action}]"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "button_id": self.button_id,
            "label": self.label,
            "module_id": self.module_id,
            "action": self.action,
            "variant": self.variant,
            "icon": self.icon,
            "payload": self.payload,
            "tag": self.to_tag(),
        }


@dataclass
class InteractiveWidget:
    """Reprezentuje interaktywny komponent Generative UI renderowany bezpośrednio w czacie."""

    widget_id: str
    widget_type: str  # "module_grid", "telemetry_chart", "vision_inspector", "wallet_meter", "action_deck", "data_table"
    title: str
    module_id: str
    state: Dict[str, Any] = field(default_factory=dict)
    buttons: List[InteractiveButton] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "widget_id": self.widget_id,
            "widget_type": self.widget_type,
            "title": self.title,
            "module_id": self.module_id,
            "state": self.state,
            "buttons": [b.to_dict() for b in self.buttons],
        }


# Katalog głównych przycisków sterujących modułami w czacie Jyn (zamiast jakichkolwiek komend)
DEFAULT_CHAT_MODULE_BUTTONS: List[Dict[str, str]] = [
    {"button_id": "btn_vision_scan", "label": "Analiza Obrazu Vision", "module_id": "cloud_vision_docai", "action": "analyze_camera", "icon": "👁️", "variant": "primary"},
    {"button_id": "btn_vision_ocr", "label": "Skanuj Dokument OCR", "module_id": "cloud_vision_docai", "action": "ocr_document", "icon": "📄", "variant": "info"},
    {"button_id": "btn_gemini_pro", "label": "Wnioskowanie Gemini 2.5 Pro", "module_id": "gemini_ai_studio", "action": "run_pro", "icon": "🧠", "variant": "primary"},
    {"button_id": "btn_ui_dashboard", "label": "Panel Interaktywny UI", "module_id": "interactive_ai_ui_kit", "action": "open_dashboard", "icon": "🎛️", "variant": "success"},
    {"button_id": "btn_vertex_agents", "label": "Vertex AI & Model Garden", "module_id": "vertex_ai_garden", "action": "list_models", "icon": "🌌", "variant": "info"},
    {"button_id": "btn_agentic_swarm", "label": "Rój Agentów ADK & LangGraph", "module_id": "agentic_swarm_adk", "action": "deploy_swarm", "icon": "🐝", "variant": "warning"},
    {"button_id": "btn_vector_rag", "label": "Pamięć Wektorowa 128D RAG", "module_id": "vector_rag_engine", "action": "query_memory", "icon": "🧬", "variant": "info"},
    {"button_id": "btn_voice_tts", "label": "Synteza Głosu Jyn (TTS)", "module_id": "cloud_translation_speech", "action": "speak_status", "icon": "🔊", "variant": "primary"},
    {"button_id": "btn_search_ground", "label": "Uziemienie Google Search", "module_id": "custom_search_grounding", "action": "ground_facts", "icon": "🌍", "variant": "info"},
    {"button_id": "btn_workspace_sync", "label": "Google Workspace (Drive/Docs)", "module_id": "workspace_bridge", "action": "sync_workspace", "icon": "📁", "variant": "success"},
    {"button_id": "btn_maps_nav", "label": "Nawigacja Maps & Earth 3D", "module_id": "maps_earth_telemetry", "action": "locate_ship", "icon": "🛰️", "variant": "primary"},
    {"button_id": "btn_gcs_bigquery", "label": "Telemetria GCS & BigQuery", "module_id": "gcs_bigquery_telemetry", "action": "sync_telemetry", "icon": "📊", "variant": "info"},
    {"button_id": "btn_exo_infra", "label": "Infrastruktura SVL-364 (3145 MW)", "module_id": "exo_infrastructure_grid", "action": "calibrate_grid", "icon": "🏗️", "variant": "primary"},
    {"button_id": "btn_exo_missions", "label": "Misje Pozaziemskie & Orbita", "module_id": "exo_missions_command", "action": "advance_missions", "icon": "🚀", "variant": "warning"},
    {"button_id": "btn_exo_botany", "label": "Botanika & Biokopuły O2", "module_id": "exo_botany_biodome", "action": "adjust_climate", "icon": "🌿", "variant": "success"},
    {"button_id": "btn_sec_shield", "label": "Tarcza Chronicle & Armor", "module_id": "security_chronicle_shield", "action": "audit_security", "icon": "🛡️", "variant": "success"},
    {"button_id": "btn_topup_all", "label": "Doładuj Wszystkie 15 Modułów ($1000/moduł)", "module_id": "all", "action": "topup_all_1000", "icon": "💳", "variant": "success"},
]


class InteractiveUIEngine:
    """
    Silnik Generative UI dla dwustronnego dobrowolnego czatu Jyn Mitek (Aetheria Off-World Design).
    Zastępuje tekstowe komendy i wymuszone prompty interaktywnymi modułami, przyciskami, wykresami,
    Infrastrukturą, Misjami, Botaniką i kartami Vision.
    """

    LIBRARY_NAME = "Aetheria Off-World Generative UI Suite (CopilotKit + Vercel AI SDK UI + Google A2UI + AG-UI)"
    LIBRARY_VERSION = "4.0.0-offworld-duplex"

    def __init__(self, google_hub: Optional[Any] = None) -> None:
        self.google_hub = google_hub

    def get_default_buttons(self) -> List[InteractiveButton]:
        return [
            InteractiveButton(
                button_id=b["button_id"],
                label=b["label"],
                module_id=b["module_id"],
                action=b["action"],
                icon=b["icon"],
                variant=b["variant"],
            )
            for b in DEFAULT_CHAT_MODULE_BUTTONS
        ]

    def build_contextual_widgets(
        self,
        user_text: str,
        reply_text: str,
        vision_data: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Automatycznie dobiera interaktywne widżety i przyciski akcji dla dwustronnego czatu (AI <-> Operator).
        """
        lower_q = f"{user_text} {reply_text}".lower()
        buttons = self.get_default_buttons()
        widgets: List[InteractiveWidget] = []

        # 1. Jeśli wykryto obraz lub kontekst wizyjny -> karta Vision Inspector
        if vision_data or any(k in lower_q for k in ("obraz", "zdjęci", "kamera", "vision", "ocr", "wizj", "ekran", "skan")):
            widgets.append(
                InteractiveWidget(
                    widget_id="w_vision_inspector",
                    widget_type="vision_inspector",
                    title="Google Cloud Vision & SVL-364 Optical Inspector",
                    module_id="cloud_vision_docai",
                    state=vision_data or {
                        "engine": "vision-ocr-v1 + gemini-2.5-flash + llama3.2-vision:11b",
                        "allocated_budget_usd": 1000.0,
                        "status": "READY",
                    },
                    buttons=buttons[:4],
                )
            )

        # 2. Widżet Pozaziemskiej Infrastruktury, Misji i Botaniki SVL-364
        widgets.append(
            InteractiveWidget(
                widget_id="w_exo_biosphere_deck",
                widget_type="exo_biosphere_deck",
                title="Aetheria Off-World: Infrastruktura (3145 MW) · Misje (4) · Biokopuły Botaniki (316.7 kg O2/d)",
                module_id="exo_botany_biodome",
                state={
                    "contractor": "AETHERIA OFF-WORLD ARCHITECTS & XENO-SYSTEMS CORP.",
                    "prompt_free_voluntary_chat": True,
                    "duplex_ai": True,
                    "infrastructure_mw": 3145.0,
                    "missions_active": 4,
                    "botany_o2_kg_day": 316.7,
                },
                buttons=[b for b in buttons if b.module_id.startswith("exo_")],
            )
        )

        # 3. Wykres telemetrii i budżetu modułów ($1000.00 USD / moduł · 15 modułów = $15,000.00 USD)
        widgets.append(
            InteractiveWidget(
                widget_id="w_modules_budget_chart",
                widget_type="telemetry_chart",
                title="Alokacja Budżetu Modułów ($1000.00 USD / moduł · 15 Modułów = $15,000.00 USD)",
                module_id="interactive_ai_ui_kit",
                state={
                    "chart_tag": "[chart:models]",
                    "telemetry_tag": "[chart:telemetry]",
                    "per_module_budget_usd": 1000.0,
                    "total_modules": 15,
                    "total_budget_usd": 15000.0,
                },
                buttons=buttons[2:8],
            )
        )

        # 4. Panel szybkich akcji modułowych (Duplex Action Deck)
        widgets.append(
            InteractiveWidget(
                widget_id="w_action_deck",
                widget_type="action_deck",
                title="Dwustronne Sterowanie Modułami JYN_OS (Operator <-> Jyn Mitek)",
                module_id="interactive_ai_ui_kit",
                state={"library": self.LIBRARY_NAME, "version": self.LIBRARY_VERSION, "voluntary_chat": True},
                buttons=buttons,
            )
        )

        return {
            "library": self.LIBRARY_NAME,
            "version": self.LIBRARY_VERSION,
            "voluntary_chat": True,
            "prompt_injected": False,
            "widgets": [w.to_dict() for w in widgets],
            "buttons": [b.to_dict() for b in buttons],
            "inline_tags": [b.to_tag() for b in buttons[:8]] + ["[chart:telemetry]", "[chart:models]"],
        }


__all__ = [
    "DEFAULT_CHAT_MODULE_BUTTONS",
    "InteractiveButton",
    "InteractiveWidget",
    "InteractiveUIEngine",
]
