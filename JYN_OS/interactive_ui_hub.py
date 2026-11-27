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
    {"button_id": "btn_google_static_ip", "label": "Stałe IP Google (34.118.64.100 / .200)", "module_id": "google_static_ip_networking", "action": "configure_static_ip", "icon": "🌐", "variant": "primary"},
    {"button_id": "btn_google_ha_vpn", "label": "Tunel Google HA VPN (JYN_OS <-> SVL-364)", "module_id": "google_ha_vpn_interconnect", "action": "establish_ha_vpn", "icon": "🔒", "variant": "success"},
    {"button_id": "btn_google_beyondcorp", "label": "BeyondCorp Zero-Trust IAP & VPC", "module_id": "google_beyondcorp_zero_trust", "action": "enforce_zero_trust", "icon": "🔑", "variant": "info"},
    {"button_id": "btn_google_armor_ids", "label": "Cloud Armor Anti-DDoS & Cloud IDS", "module_id": "google_cloud_armor_ids", "action": "activate_armor_ids", "icon": "🧱", "variant": "warning"},
    {"button_id": "btn_google_scc_hsm", "label": "SCC Premium & Cloud HSM/KMS L3", "module_id": "google_scc_kms_hsm_vault", "action": "provision_scc_hsm", "icon": "🏛️", "variant": "primary"},
    {"button_id": "btn_chroma_colors", "label": "ChromaText Pro: Kolory & Formatowanie AI", "module_id": "chroma_rich_typography_suite", "action": "showcase", "icon": "🎨", "variant": "primary"},
    {"button_id": "btn_glocki_codec", "label": "0x03 // Kodek W. Głockiego (CUBE 364)", "module_id": "chroma_rich_typography_suite", "action": "glocki_codec", "icon": "🧊", "variant": "info"},
    {"button_id": "btn_ring0_trans", "label": "Transmisja Hiperprzestrzeni Ring-0", "module_id": "chroma_rich_typography_suite", "action": "ring0_transmission", "icon": "✨", "variant": "success"},
    {"button_id": "btn_pill_chart", "label": "Wykres", "module_id": "chroma_rich_typography_suite", "action": "render_chart", "icon": "📊", "variant": "info"},
    {"button_id": "btn_pill_image", "label": "Grafika", "module_id": "cloud_vision_docai", "action": "analyze_camera", "icon": "🖼️", "variant": "primary"},
    {"button_id": "btn_pill_video", "label": "Wideo", "module_id": "gemini_ai_studio", "action": "run_pro", "icon": "🎬", "variant": "success"},
    {"button_id": "btn_pill_code", "label": "Kod", "module_id": "chroma_rich_typography_suite", "action": "exec_code", "icon": "</>", "variant": "warning"},
    {"button_id": "btn_pill_curl", "label": "cURL", "module_id": "chroma_rich_typography_suite", "action": "exec_curl", "icon": "</>", "variant": "info"},
    {"button_id": "btn_openai_chatgpt", "label": "ChatGPT Business (GPT-4.1 / o3-pro)", "module_id": "openai_chatgpt_business_suite", "action": "chatgpt", "icon": "💬", "variant": "primary"},
    {"button_id": "btn_openai_codex", "label": "OpenAI Codex (codex-1 · Inżynieria Kodu)", "module_id": "openai_chatgpt_business_suite", "action": "codex", "icon": "💻", "variant": "info"},
    {"button_id": "btn_openai_work", "label": "ChatGPT Work (Enterprise Workspace & Canvas)", "module_id": "openai_chatgpt_business_suite", "action": "chatgpt_work", "icon": "🏢", "variant": "success"},
    {"button_id": "btn_openai_api_sec", "label": "OpenAI API ($1000 · Dodatkowe / Secondary)", "module_id": "openai_api_secondary_provider", "action": "openai_api", "icon": "⚡", "variant": "warning"},
    {"button_id": "btn_solar_report", "label": "Raport z Układu Słonecznego (SVL-364)", "module_id": "solar_system_telemetry", "action": "solar_system_report", "icon": "🪐", "variant": "primary"},
    {"button_id": "btn_topup_all", "label": "Doładuj Wszystkie 23 Moduły ($1000/moduł)", "module_id": "all", "action": "topup_all_1000", "icon": "💳", "variant": "success"},
    {"button_id": "btn_avatar_jyn_core", "label": "Awatar Jyn: Neural Core", "module_id": "avatar_selector", "action": "jyn_neural_core", "icon": "🎭", "variant": "primary"},
    {"button_id": "btn_avatar_jyn_valkyrie", "label": "Awatar Jyn: Quantum Valkyrie", "module_id": "avatar_selector", "action": "jyn_quantum_valkyrie", "icon": "🤖", "variant": "info"},
    {"button_id": "btn_avatar_jyn_sentinel", "label": "Awatar Jyn: Orbital Sentinel", "module_id": "avatar_selector", "action": "jyn_orbital_sentinel", "icon": "🛰️", "variant": "info"},
    {"button_id": "btn_avatar_jyn_overseer", "label": "Awatar Jyn: Vault-Tec Overseer", "module_id": "avatar_selector", "action": "jyn_vault_overseer", "icon": "☢️", "variant": "warning"},
    {"button_id": "btn_avatar_operator_lucy", "label": "Awatar Operatora: Lucy MacLean (Fallout · Vault 33)", "module_id": "avatar_selector", "action": "operator_lucy_fallout", "icon": "⚡", "variant": "success"},
]


class InteractiveUIEngine:
    """
    Silnik Generative UI dla dwustronnego dobrowolnego czatu Jyn Mitek (Aetheria Off-World Design).
    Zastępuje tekstowe komendy i wymuszone prompty interaktywnymi modułami, przyciskami, wykresami,
    ChromaText Pro (24-bit TrueColor, Karta Transmisji Ring-0, Kodek W. Głockiego CUBE 364, Blok >_ KOD),
    ChatGPT Business / Codex / ChatGPT Work / OpenAI Secondary API ($1000),
    Stałym IP Google, Tunelem HA VPN, Bezpieczeństwem Zero-Trust, Infrastrukturą, Misjami, Botaniką,
    kartami Vision oraz Selektorem Awatarów (Jyn AI + Lucy z Fallout).
    """

    LIBRARY_NAME = "Aetheria Off-World Generative UI Suite + ChromaText Pro 24-bit TrueColor (CopilotKit + Vercel AI SDK UI + Google A2UI + AG-UI)"
    LIBRARY_VERSION = "4.2.0-chromatext-openai-business"

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

    def select_contextual_buttons(self, user_text: str, reply_text: str) -> List[InteractiveButton]:
        """Dobiera najbardziej trafne klikalne przyciski interaktywne na podstawie kontekstu wypowiedzi."""
        lower_q = f"{user_text} {reply_text}".lower()
        all_btns = self.get_default_buttons()
        by_mod: Dict[str, List[InteractiveButton]] = {}
        for b in all_btns:
            by_mod.setdefault(b.module_id, []).append(b)

        picked: List[InteractiveButton] = []
        if any(k in lower_q for k in ("chatgpt", "codex", "work", "openai", "gpt-4", "o3", "api", "oplama", "ollama")):
            picked.extend(by_mod.get("openai_chatgpt_business_suite", []))
            picked.extend(by_mod.get("openai_api_secondary_provider", []))
        if any(k in lower_q for k in ("układ", "słoneczn", "sloneczn", "planet", "jowisz", "mars", "saturn", "solar")):
            picked.extend(by_mod.get("solar_system_telemetry", []))
        if any(k in lower_q for k in ("kolor", "format", "chroma", "kodek", "głock", "glock", "cube", "364", "transmisj", "ring-0", "ring0", "kod", "curl")):
            picked.extend(by_mod.get("chroma_rich_typography_suite", []))
        if any(k in lower_q for k in ("ip", "vpn", "anycast", "dns", "nat", "tunel", "beyondcorp", "armor", "ids", "kms", "hsm", "scc", "bezpiecz")):
            picked.extend(by_mod.get("google_static_ip_networking", []))
            picked.extend(by_mod.get("google_ha_vpn_interconnect", []))
            picked.extend(by_mod.get("google_beyondcorp_zero_trust", []))
            picked.extend(by_mod.get("google_cloud_armor_ids", []))
            picked.extend(by_mod.get("google_scc_kms_hsm_vault", []))
            picked.extend(by_mod.get("security_chronicle_shield", []))
        if any(k in lower_q for k in ("awatar", "avatar", "lucy", "fallout", "portret", "wygląd", "vault")):
            picked.extend(by_mod.get("avatar_selector", []))
        if any(k in lower_q for k in ("obraz", "zdjęci", "kamera", "vision", "ocr", "wizj", "skan")):
            picked.extend(by_mod.get("cloud_vision_docai", []))
        if any(k in lower_q for k in ("biokopuł", "botani", "tlen", "o2", "roślin", "hydropon")):
            picked.extend(by_mod.get("exo_botany_biodome", []))
        if any(k in lower_q for k in ("infrastruktur", "reaktor", "moc", "mw", "3145", "statek", "svl")):
            picked.extend(by_mod.get("exo_infrastructure_grid", []))
        if any(k in lower_q for k in ("misj", "orbit", "ekspedycj", "kosmos")):
            picked.extend(by_mod.get("exo_missions_command", []))
        if any(k in lower_q for k in ("gemini", "vertex", "model", "ai")):
            picked.extend(by_mod.get("gemini_ai_studio", []))
            picked.extend(by_mod.get("vertex_ai_garden", []))
        if any(k in lower_q for k in ("pamięć", "wektor", "rag", "128d")):
            picked.extend(by_mod.get("vector_rag_engine", []))
        if any(k in lower_q for k in ("budżet", "doładuj", "1000", "20000", "23000", "portfel", "google")):
            picked.extend(by_mod.get("all", []))

        # Zawsze dodaj główne przyciski sterujące, aby AI aktywnie prezentowało interaktywne opcje
        for fallback_btn in all_btns:
            if len(picked) >= 6:
                break
            if all(p.button_id != fallback_btn.button_id for p in picked):
                picked.append(fallback_btn)
        return picked[:6]

    def enrich_ai_reply_with_interactive_elements(
        self,
        user_text: str,
        reply_text: str,
        invoked_modules: Optional[List[Dict[str, Any]]] = None,
    ) -> str:
        """
        Zapewnia, że odpowiedź AI (Jyn Mitek) aktywnie zawiera i prezentuje elementy interaktywne
        (`[btn: ...]`, `[chart:telemetry]`, `[chart:models]`), jeśli model nie dołączył ich sam.
        """
        cleaned = (reply_text or "").strip()
        if not cleaned:
            return cleaned

        ctx_buttons = self.select_contextual_buttons(user_text, cleaned)
        has_btn = "[btn:" in cleaned.lower()
        has_chart = "[chart:" in cleaned.lower()

        append_lines: List[str] = []
        if invoked_modules:
            mod_summaries = [
                f"⚡ **[{m.get('service_id')} · {m.get('operation')}]**: {m.get('output')}"
                for m in invoked_modules
                if m.get("output") and str(m.get("output")) not in cleaned
            ]
            if mod_summaries:
                append_lines.append("\n".join(mod_summaries))

        if not has_chart:
            append_lines.append("[chart:telemetry] [chart:models]")

        if not has_btn and ctx_buttons:
            btn_tags = " ".join(b.to_tag() for b in ctx_buttons[:4])
            append_lines.append(btn_tags)

        if not append_lines:
            return cleaned
        return cleaned + "\n\n" + "\n".join(append_lines)

    def build_contextual_widgets(
        self,
        user_text: str,
        reply_text: str,
        vision_data: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Automatycznie dobiera interaktywne widżety i przyciski akcji dla dwustronnego czatu (AI <-> Operator).
        """
        from .avatar_client import AI_AVATAR_CATALOG, OPERATOR_AVATAR_LUCY_FALLOUT, get_avatar_state
        from .chroma_text_engine import (
            QUICK_MEDIA_ACTION_PILLS,
            build_exec_root_code_block,
            build_ring0_transmission_card,
            compute_glocki_cube_codec,
        )
        from .openai_business_hub import OPENAI_BUSINESS_MODELS, UNIFIED_AI_PROVIDERS_CATALOG

        lower_q = f"{user_text} {reply_text}".lower()
        buttons = self.get_default_buttons()
        ctx_buttons = self.select_contextual_buttons(user_text, reply_text)
        widgets: List[InteractiveWidget] = []
        av_state = get_avatar_state()

        # 1. Jeśli wykryto obraz lub kontekst wizyjny -> karta Vision Inspector
        if vision_data or any(k in lower_q for k in ("obraz", "zdjęci", "kamera", "vision", "ocr", "wizj", "ekran", "skan")):
            widgets.append(
                InteractiveWidget(
                    widget_id="w_vision_inspector",
                    widget_type="vision_inspector",
                    title="Google Cloud Vision, Gemini Vision, GPT-4o Vision & SVL-364 Real Optical Inspector",
                    module_id="cloud_vision_docai",
                    state=vision_data or {
                        "engine": "real-vision-ocr-v4 + gemini-2.5-flash + gpt-4o-vision + llama3.2-vision:11b",
                        "allocated_budget_usd": 1000.0,
                        "status": "READY",
                    },
                    buttons=buttons[:4],
                )
            )

        # 2. Widżet Zunifikowanego Selektora Wszystkich API i Węzłów Ollama (Ollama Local/Ship + Google + OpenAI $1000 Secondary)
        widgets.append(
            InteractiveWidget(
                widget_id="w_unified_api_ollama_router",
                widget_type="unified_api_ollama_router",
                title="Zunifikowany Selektor API & Ollama: Ollama (:11434/:11435) · Google Gemini/Vertex · OpenAI API ($1000 Secondary) & ChatGPT Business/Codex/Work",
                module_id="openai_chatgpt_business_suite",
                state={
                    "primary_ollama_nodes": ["http://127.0.0.1:11434 (13 modeli)", "http://127.0.0.1:11435 (SVL-364 · 13 modeli)"],
                    "primary_cloud_api": "Google Gemini 2.5 Pro/Flash & Vertex AI ($1,000.00 USD / moduł)",
                    "secondary_openai_api": "OpenAI Platform REST API v1 (DODATKOWE / SECONDARY API · Doładowane $1,000.00 USD)",
                    "chatgpt_business_suite": OPENAI_BUSINESS_MODELS,
                    "providers_catalog": UNIFIED_AI_PROVIDERS_CATALOG,
                },
                buttons=[
                    b
                    for b in buttons
                    if b.module_id in ("openai_chatgpt_business_suite", "openai_api_secondary_provider", "gemini_ai_studio", "vertex_ai_garden")
                ],
            )
        )

        # 3. Widżet ChromaText Pro: Karta Transmisji Ring-0 + Kodek W. Głockiego (CUBE 364) + Blok Wykonawczy >_ KOD
        widgets.append(
            InteractiveWidget(
                widget_id="w_chroma_ring0_glocki_deck",
                widget_type="chroma_ring0_glocki_deck",
                title="ChromaText Pro 24-bit TrueColor · Transmisja Ring-0 · 0x03 Kodek W. Głockiego (CUBE 364) · [EXEC >_ KOD]",
                module_id="chroma_rich_typography_suite",
                state={
                    "ring0_transmission": build_ring0_transmission_card(),
                    "glocki_cube_codec": compute_glocki_cube_codec(364),
                    "exec_code_block": build_exec_root_code_block(),
                    "quick_pills": QUICK_MEDIA_ACTION_PILLS,
                },
                buttons=[b for b in buttons if b.module_id == "chroma_rich_typography_suite"],
            )
        )

        # 4. Widżet Google Cloud Static IP, HA VPN Tunnel & Zero-Trust Security Suite (JYN_OS <-> SVL-364)
        widgets.append(
            InteractiveWidget(
                widget_id="w_google_vpn_security_deck",
                widget_type="vpn_security_deck",
                title="Google Cloud Static IP (34.118.64.100 / 34.118.64.200) · HA VPN (99.99% SLA) · Zero-Trust Security Suite",
                module_id="google_ha_vpn_interconnect",
                state={
                    "jyn_os_static_ipv4": "34.118.64.100",
                    "ship_svl364_static_ipv4": "34.118.64.200",
                    "global_anycast_ipv4": "35.190.88.1",
                    "static_ipv6_prefix": "2600:1901:0:364::/64",
                    "vpc_cidr": "10.240.0.0/16",
                    "ha_vpn_tunnel": "10.240.0.1 <-> 10.240.0.2 (ESTABLISHED · IPsec IKEv2 + WireGuard Kyber-1024)",
                    "security_modules": [
                        "google_static_ip_networking",
                        "google_ha_vpn_interconnect",
                        "google_beyondcorp_zero_trust",
                        "google_cloud_armor_ids",
                        "google_scc_kms_hsm_vault",
                        "security_chronicle_shield",
                    ],
                },
                buttons=[
                    b
                    for b in buttons
                    if b.module_id
                    in (
                        "google_static_ip_networking",
                        "google_ha_vpn_interconnect",
                        "google_beyondcorp_zero_trust",
                        "google_cloud_armor_ids",
                        "google_scc_kms_hsm_vault",
                        "security_chronicle_shield",
                    )
                ],
            )
        )

        # 5. Widżet Awatarów: Jyn Mitek (Katalog AI) + Operator Mateusz Mitek (Lucy MacLean · Fallout Vault 33)
        widgets.append(
            InteractiveWidget(
                widget_id="w_avatar_selector_deck",
                widget_type="avatar_selector",
                title="Profile & Awatary: Jyn Mitek (AI) · Mateusz Mitek (Lucy MacLean — Fallout · Vault 33)",
                module_id="avatar_selector",
                state={
                    "jyn_selected_avatar": av_state.get("jyn_avatar") or AI_AVATAR_CATALOG[0],
                    "operator_avatar": av_state.get("operator_avatar") or OPERATOR_AVATAR_LUCY_FALLOUT,
                    "ai_avatar_catalog": AI_AVATAR_CATALOG,
                },
                buttons=[b for b in buttons if b.module_id == "avatar_selector"],
            )
        )

        # 6. Widżet Pozaziemskiej Infrastruktury, Misji i Botaniki SVL-364
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

        # 7. Wykres telemetrii i budżetu modułów ($1000.00 USD / moduł · 23 moduły = $23,000.00 USD)
        widgets.append(
            InteractiveWidget(
                widget_id="w_modules_budget_chart",
                widget_type="telemetry_chart",
                title="Alokacja Budżetu Modułów ($1000.00 USD / moduł · 23 Moduły = $23,000.00 USD)",
                module_id="interactive_ai_ui_kit",
                state={
                    "chart_tag": "[chart:models]",
                    "telemetry_tag": "[chart:telemetry]",
                    "per_module_budget_usd": 1000.0,
                    "total_modules": 23,
                    "total_budget_usd": 23000.0,
                },
                buttons=buttons[2:8],
            )
        )

        # 8. Panel szybkich akcji modułowych (Duplex Action Deck)
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

        pill_tags = [p["tag"] for p in QUICK_MEDIA_ACTION_PILLS]
        return {
            "library": self.LIBRARY_NAME,
            "version": self.LIBRARY_VERSION,
            "voluntary_chat": True,
            "prompt_injected": False,
            "widgets": [w.to_dict() for w in widgets],
            "buttons": [b.to_dict() for b in buttons],
            "contextual_buttons": [b.to_dict() for b in ctx_buttons],
            "quick_pills": QUICK_MEDIA_ACTION_PILLS,
            "inline_tags": [b.to_tag() for b in ctx_buttons] + pill_tags + ["[chart:telemetry]", "[chart:models]"],
        }


__all__ = [
    "DEFAULT_CHAT_MODULE_BUTTONS",
    "InteractiveButton",
    "InteractiveWidget",
    "InteractiveUIEngine",
]




