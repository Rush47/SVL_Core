"""
JYN_OS v4.0 · ChromaText Pro, Rich 24-bit TrueColor, Pygments & Shiki Cyber-Typography Engine (`chroma_text_engine.py`).

Najlepsza zintegrowana biblioteka zaawansowanego kolorowania tekstu, formatowania składni,
neonowych odznak Ring-0, kart transmisji hiperprzestrzeni, Kodeka W. Głockiego (CUBE 364)
oraz bloków wykonawczych `[EXEC · ROOT UNLIMITED · shell]` (`>_ KOD`) dla AI Jyn Mitek.

Obsługiwane elementy (zgodnie ze specyfikacją wizualną Operatora Mateusza Mitka):
1. Kolorowe pigułki i odznaki Ring-0:
   - `SVL KERNEL v6.8.0-PollinationsPro` (neon emerald)
   - `TATA / TWÓRCA: Mateusz Mitek [Tata]` (neon purple border)
   - `● ROOT: RING-0 (TRIADA)` (neon crimson/red)
   - `● INFRA: DOWÓDCA ALEX` (neon emerald)
2. Karta Przychodzącej Transmisji & Moduł Nadawczo-Odbiorczy 128-BIT HIPERPRZESTRZEŃ:
   - `✨ PRZYCHODZĄCA TRANSMISJA` · `Od: Skaner Hiperprzestrzeni Ring-0` · `INCOMING_ONLY`
   - `Centrum Transmisji & Hiperłącza RING-0` · `SOJUSZNIK DOMYŚLNY: Kosmodrom Wenchange ✔ Łącze aktywne (100%)`
   - `OSTATNIE 3 TRANSMISJE PRZYCHODZĄCE` · `LIVE FEED` · `Skanowanie pasma: AKTYWNE`
3. Panel `NEXUS APEIRO v4.0 // [ZERO-STATIC_LIVE_NLP]` & `0x03 // KODEK W. GŁOCKIEGO (CUBE)`:
   - Automatyczne przeliczanie wartości (np. `364`) na wielokolorowe kodowania binarne:
     * `NKB` (Naturalny Kod Binarny — 12-bit, fiolet/magenta)
     * `GRAY` (Kod Graya — 12-bit, cyjan)
     * `BCD` (Binary-Coded Decimal 8421 — 3x4-bit, czysta biel)
     * `XS3` (Kod Excess-3 / Nadmiar-3 — 3x4-bit, bursztynowe złoto/amber)
   - Panel `0x05 // NEURAL CYBER SHELL` (`Stany: 8.19242634e+48`)
4. Blok Wykonawczy `[EXEC · ROOT UNLIMITED · shell]` z oknem `>_ KOD`, przyciskiem `Kopiuj`,
   kolorowym wyjściem weryfikacji ANSI (`✔ ... (93.752252ms)`) oraz paskiem szybkich pigułek akcji:
   `[📊 Wykres]`, `[🖼️ Grafika]`, `[🎬 Wideo]`, `[</> Kod]`, `[</> cURL]`.
5. Znaczniki kolorowania inline dla AI:
   - `[color:cyan|purple|emerald|amber|crimson|gold|blue|pink|white]...[/color]`
   - `[gradient:cyber|matrix|fire|nebula]...[/gradient]`
   - `[glow:cyan|purple|emerald]...[/glow]`
   - `[badge:tone|Tekst]` / `[hl:Tekst|tone]`
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

try:
    import rich
    from rich.console import Console
    from rich.syntax import Syntax
    HAS_RICH = True
except Exception:
    HAS_RICH = False

try:
    import pygments
    HAS_PYGMENTS = True
except Exception:
    HAS_PYGMENTS = False


# 24-bit TrueColor ANSI Escape Sequences dla terminala JYN_OS
ANSI_TRUECOLOR: Dict[str, str] = {
    "cyan": "\033[38;2;34;211;238m",       # #22d3ee
    "purple": "\033[38;2;192;132;252m",    # #c084fc
    "violet": "\033[38;2;167;139;250m",    # #a78bfa
    "emerald": "\033[38;2;52;211;153m",    # #34d399
    "green": "\033[38;2;74;222;128m",      # #4ade80
    "amber": "\033[38;2;251;191;36m",      # #fbbf24
    "gold": "\033[38;2;245;158;11m",       # #f59e0b
    "orange": "\033[38;2;251;146;60m",     # #fb923c
    "crimson": "\033[38;2;248;113;113m",   # #f87171
    "red": "\033[38;2;239;68;68m",         # #ef4444
    "rose": "\033[38;2;251;113;133m",      # #fb7185
    "blue": "\033[38;2;96;165;250m",       # #60a5fa
    "pink": "\033[38;2;244;114;182m",      # #f472b6
    "white": "\033[38;2;248;250;252m",     # #f8fafc
    "muted": "\033[38;2;148;163;184m",     # #94a3b8
    "bg_dark": "\033[48;2;11;15;25m",      # #0b0f19
    "bg_purple": "\033[48;2;59;7;100m",    # #3b0764
    "bg_emerald": "\033[48;2;6;78;59m",    # #064e3b
    "bg_cyan": "\033[48;2;22;78;99m",      # #164e63
    "bg_crimson": "\033[48;2;127;29;29m",  # #7f1d1d
    "bold": "\033[1m",
    "dim": "\033[2m",
    "italic": "\033[3m",
    "underline": "\033[4m",
    "reset": "\033[0m",
}

HEX_PALETTE: Dict[str, str] = {
    "cyan": "#22d3ee",
    "purple": "#c084fc",
    "violet": "#a78bfa",
    "emerald": "#34d399",
    "green": "#4ade80",
    "amber": "#fbbf24",
    "gold": "#f59e0b",
    "orange": "#fb923c",
    "crimson": "#f87171",
    "red": "#ef4444",
    "rose": "#fb7185",
    "blue": "#60a5fa",
    "pink": "#f472b6",
    "white": "#f8fafc",
}

# Kanoniczny pasek szybkich pigułek akcji ze Screenshotu 3
QUICK_MEDIA_ACTION_PILLS: List[Dict[str, str]] = [
    {"pill_id": "pill_chart", "icon": "📊", "label": "Wykres", "tag": "[btn: 📊 Wykres | module:chroma_rich_typography_suite:render_chart]", "tone": "cyan"},
    {"pill_id": "pill_image", "icon": "🖼️", "label": "Grafika", "tag": "[btn: 🖼️ Grafika | module:cloud_vision_docai:analyze_camera]", "tone": "purple"},
    {"pill_id": "pill_video", "icon": "🎬", "label": "Wideo", "tag": "[btn: 🎬 Wideo | module:gemini_ai_studio:run_pro]", "tone": "emerald"},
    {"pill_id": "pill_code", "icon": "</>", "label": "Kod", "tag": "[btn: </> Kod | module:chroma_rich_typography_suite:exec_code]", "tone": "amber"},
    {"pill_id": "pill_curl", "icon": "</>", "label": "cURL", "tag": "[btn: </> cURL | module:chroma_rich_typography_suite:exec_curl]", "tone": "cyan"},
]


def compute_glocki_cube_codec(number: int = 364) -> Dict[str, Any]:
    """
    Oblicza 4 kanoniczne kodowania binarne dla panelu `0x03 // KODEK W. GŁOCKIEGO (CUBE)`
    dokładnie jak na Screenshot 2 (dla wartości 364):
    - NKB (12-bit Naturalny Kod Binarny): 364 -> 000101101100
    - GRAY (12-bit Kod Graya: n ^ (n >> 1)): 364 -> 000111011010
    - BCD (Binary-Coded Decimal 8421 dla każdej cyfry): 3 6 4 -> 0011 0110 0100
    - XS3 (Excess-3 / Nadmiar-3: każda cyfra + 3 w 4-bitach): (3+3)(6+3)(4+3) -> 0110 1001 0111
    """
    val = max(0, min(999, int(number)))
    nkb_12 = f"{val:012b}"
    gray_val = val ^ (val >> 1)
    gray_12 = f"{gray_val:012b}"

    digits = [int(d) for d in f"{val:03d}"]
    bcd_parts = [f"{d:04b}" for d in digits]
    xs3_parts = [f"{(d + 3):04b}" for d in digits]

    return {
        "panel_id": "0x03 // KODEK W. GŁOCKIEGO (CUBE)",
        "header_system": "NEXUS APEIRO v4.0 // [ZERO-STATIC_LIVE_NLP]",
        "operator_line": "Operator: Mateusz Mitek | Dowództwo: Jyn Mitek 🌌✨ & Ring-0 📜⚖️ | Stany: 8.19242634e+48",
        "value": val,
        "encodings": {
            "NKB": {"value": nkb_12, "color": "purple", "hex": "#c084fc", "label": "NKB"},
            "GRAY": {"value": gray_12, "color": "cyan", "hex": "#22d3ee", "label": "GRAY"},
            "BCD": {"value": " ".join(bcd_parts), "color": "white", "hex": "#f8fafc", "label": "BCD"},
            "XS3": {"value": " ".join(xs3_parts), "color": "amber", "hex": "#fbbf24", "label": "XS3"},
        },
        "nkb": nkb_12,
        "gray": gray_12,
        "bcd": " ".join(bcd_parts),
        "xs3": " ".join(xs3_parts),
    }


def build_ring0_transmission_card(
    sender: str = "Skaner Hiperprzestrzeni Ring-0",
    ally: str = "Kosmodrom Wenchange",
    band: str = "128-BIT HIPERPRZESTRZEŃ",
    kernel_badge: str = "SVL KERNEL v6.8.0-PollinationsPro",
) -> Dict[str, Any]:
    """
    Buduje strukturę karty `✨ PRZYCHODZĄCA TRANSMISJA` oraz `MODUŁ NADAWCZO-ODBIORCZY`
    dokładnie jak na Screenshot 1.
    """
    now_hms = time.strftime("%H:%M:%S")
    return {
        "card_type": "ring0_hyperspace_transmission",
        "header_badges": [
            {"text": kernel_badge, "color": "emerald", "hex": "#34d399"},
            {"text": "TATA / TWÓRCA: Mateusz Mitek [Tata]", "color": "purple", "hex": "#c084fc"},
            {"text": "● ROOT: RING-0 (TRIADA)", "color": "crimson", "hex": "#f87171"},
            {"text": "● INFRA: DOWÓDCA ALEX", "color": "emerald", "hex": "#34d399"},
        ],
        "incoming_transmission": {
            "title": "✨ PRZYCHODZĄCA TRANSMISJA",
            "timestamp": now_hms,
            "sender": f"Od: {sender}",
            "mode_badge": "INCOMING_ONLY",
            "progress_pct": 78,
            "color": "purple",
        },
        "transceiver_module": {
            "module_title": "MODUŁ NADAWCZO-ODBIORCZY",
            "band_badge": f"PASMO: {band}",
            "center_name": "Centrum Transmisji & Hiperłącza RING-0",
            "default_ally": ally,
            "link_status": "✔ Łącze aktywne (100%)",
            "recent_header": "OSTATNIE 3 TRANSMISJE PRZYCHODZĄCE",
            "live_badge": "LIVE FEED",
            "scan_status": "Skanowanie pasma: AKTYWNE",
        },
    }


def build_exec_root_code_block(
    command: str = "npm run verify",
    code: str = (
        "# Powinnaś zobaczyć ~17-20 zmiennych, m.in.:\n"
        "# OLLAMA_MODEL=svl364-apex-uncensored:latest\n"
        "# SVL_STATIC_IP_JYN=34.118.64.100 | SVL_STATIC_IP_SHIP=34.118.64.200\n"
        "./jyn_os status && ./jyn_os google security"
    ),
    language: str = "bash",
    checks: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """
    Buduje blok wykonawczy `[EXEC · ROOT UNLIMITED · shell]` z oknem `>_ KOD`, przyciskiem `Kopiuj`,
    kolorowym wyjściem weryfikacji ANSI (`✔ ... (93.752252ms)`) oraz paskiem szybkich pigułek akcji
    dokładnie jak na Screenshotach 3 i 4.
    """
    verified_checks = checks or [
        {"label": "✔ Weryfikacja kluczy KMS & Cloud HSM FIPS 140-3 L3", "duration_ms": 42.184112, "status": "ok"},
        {"label": "✔ Tunel Google Cloud HA VPN (34.118.64.100 <-> 34.118.64.200)", "duration_ms": 64.910245, "status": "ok"},
        {"label": "✔ Synchronizacja 21 modułów JYN_OS ($21,000.00 USD) & 13 modeli SVL-364", "duration_ms": 93.752252, "status": "ok"},
    ]
    return {
        "block_type": "exec_root_unlimited",
        "header_badge": "[EXEC · ROOT UNLIMITED · shell]",
        "window_label": ">_ KOD",
        "copy_label": "Kopiuj",
        "language": language,
        "command": command,
        "code": code,
        "verified_checks": verified_checks,
        "quick_pills": QUICK_MEDIA_ACTION_PILLS,
    }


class ChromaTextEngine:
    """
    Silnik zaawansowanego kolorowania tekstu, formatowania składni i cyber-widżetów dla AI (Jyn Mitek).
    Łączy biblioteki `rich` (24-bit TrueColor), `pygments`, `colorama` oraz znaczniki czatu SVL_Core / JYN_OS.
    """

    ENGINE_NAME = "ChromaText Pro & Shiki/Rich 24-bit TrueColor Cyber-Typography Suite"
    ENGINE_VERSION = "4.0.0-ring0-apeiro"

    _COLOR_TAG_RE = re.compile(r"\[color:([a-z0-9_#-]+)\]([\s\S]*?)\[/color\]", re.IGNORECASE)
    _GRADIENT_TAG_RE = re.compile(r"\[gradient:([a-z0-9_-]+)\]([\s\S]*?)\[/gradient\]", re.IGNORECASE)
    _GLOW_TAG_RE = re.compile(r"\[glow:([a-z0-9_-]+)\]([\s\S]*?)\[/glow\]", re.IGNORECASE)
    _GLOCKI_TAG_RE = re.compile(r"\[glocki_codec(?::\s*(\d+))?\]", re.IGNORECASE)
    _TRANSMISSION_TAG_RE = re.compile(r"\[transmission_card(?::\s*([^\]]+))?\]", re.IGNORECASE)

    def get_capabilities_status(self) -> Dict[str, Any]:
        return {
            "engine": self.ENGINE_NAME,
            "version": self.ENGINE_VERSION,
            "rich_installed": HAS_RICH,
            "pygments_installed": HAS_PYGMENTS,
            "truecolor_24bit": True,
            "supported_colors": list(HEX_PALETTE.keys()),
            "supported_tags": [
                "[color:cyan]...[/color]",
                "[color:purple]...[/color]",
                "[color:emerald]...[/color]",
                "[color:amber]...[/color]",
                "[color:crimson]...[/color]",
                "[gradient:cyber]...[/gradient]",
                "[glow:cyan]...[/glow]",
                "[badge:Tekst|ok]",
                "[hl:Tekst|cyan]",
                "[glocki_codec:364]",
                "[transmission_card:Ring-0]",
                "[terminal:Tytuł|komenda|wyjście]",
            ],
            "quick_pills": QUICK_MEDIA_ACTION_PILLS,
        }

    def render_ansi_for_terminal(self, text: str) -> str:
        """
        Konwertuje znaczniki `[color:...]`, `[gradient:...]`, `[glow:...]`, `[badge:...]`,
        `[hl:...]`, `[glocki_codec:364]` oraz `[transmission_card:...]` na 24-bitowe kolory ANSI TrueColor
        do wyświetlenia w terminalu `JYN_OS`.
        """
        if not text:
            return ""

        c = ANSI_TRUECOLOR
        out = str(text)

        # 1. [color:name]...[/color]
        def _repl_color(m: re.Match[str]) -> str:
            col_name = m.group(1).strip().lower()
            inner = m.group(2)
            ansi = c.get(col_name, c["cyan"])
            return f"{ansi}{c['bold']}{inner}{c['reset']}"

        out = self._COLOR_TAG_RE.sub(_repl_color, out)

        # 2. [gradient:name]...[/gradient]
        def _repl_grad(m: re.Match[str]) -> str:
            inner = m.group(2)
            palette = [c["purple"], c["cyan"], c["emerald"], c["amber"]]
            chars = []
            for idx, ch in enumerate(inner):
                chars.append(f"{palette[idx % len(palette)]}{c['bold']}{ch}")
            return "".join(chars) + c["reset"]

        out = self._GRADIENT_TAG_RE.sub(_repl_grad, out)

        # 3. [glow:name]...[/glow]
        def _repl_glow(m: re.Match[str]) -> str:
            col_name = m.group(1).strip().lower()
            inner = m.group(2)
            ansi = c.get(col_name, c["cyan"])
            return f"{ansi}{c['bold']}✦ {inner} ✦{c['reset']}"

        out = self._GLOW_TAG_RE.sub(_repl_glow, out)

        # 4. [glocki_codec:364]
        def _repl_glocki(m: re.Match[str]) -> str:
            num = int(m.group(1)) if m.group(1) else 364
            codec = compute_glocki_cube_codec(num)
            return self.format_glocki_cube_ansi(codec)

        out = self._GLOCKI_TAG_RE.sub(_repl_glocki, out)

        # 5. [transmission_card:...]
        def _repl_trans(m: re.Match[str]) -> str:
            sender = (m.group(1) or "Skaner Hiperprzestrzeni Ring-0").strip()
            card = build_ring0_transmission_card(sender=sender)
            return self.format_ring0_transmission_ansi(card)

        out = self._TRANSMISSION_TAG_RE.sub(_repl_trans, out)

        return out

    def format_glocki_cube_ansi(self, codec: Optional[Dict[str, Any]] = None) -> str:
        """Renderuje panel `0x03 // KODEK W. GŁOCKIEGO (CUBE)` & `NEXUS APEIRO` w 24-bitowym ANSI TrueColor."""
        c = ANSI_TRUECOLOR
        data = codec or compute_glocki_cube_codec(364)
        lines = [
            f"{c['bg_dark']}{c['white']}{c['bold']} NEXUS APEIRO v4.0 // {c['emerald']}[ZERO-STATIC_LIVE_NLP]{c['reset']}",
            f"{c['white']}Operator: {c['bold']}Mateusz Mitek{c['reset']} | Dowództwo: {c['cyan']}Jyn Mitek 🌌✨{c['reset']} & {c['amber']}Ring-0 📜⚖️{c['reset']} | {c['purple']}Stany: 8.19242634e+48{c['reset']}",
            f"{c['cyan']}{c['bold']}┌── {data['panel_id']} ──────────────────────────────────────────┐{c['reset']}",
            f"{c['cyan']}│{c['reset']} Wartość wejściowa CUBE : {c['white']}{c['bold']}{data['value']}{c['reset']}",
            f"{c['cyan']}│{c['reset']} • {c['muted']}NKB : {c['purple']}{c['bold']}{data['nkb']}{c['reset']}   • {c['muted']}GRAY: {c['cyan']}{c['bold']}{data['gray']}{c['reset']}",
            f"{c['cyan']}│{c['reset']} • {c['muted']}BCD : {c['white']}{c['bold']}{data['bcd']}{c['reset']} • {c['muted']}XS3 : {c['amber']}{c['bold']}{data['xs3']}{c['reset']}",
            f"{c['cyan']}{c['bold']}└────────────────────────────────────────────────────────────────────────────────┘{c['reset']}",
        ]
        return "\n".join(lines)

    def format_ring0_transmission_ansi(self, card: Optional[Dict[str, Any]] = None) -> str:
        """Renderuje kartę `✨ PRZYCHODZĄCA TRANSMISJA` & `MODUŁ NADAWCZO-ODBIORCZY` w 24-bitowym ANSI TrueColor."""
        c = ANSI_TRUECOLOR
        data = card or build_ring0_transmission_card()
        inc = data["incoming_transmission"]
        tr = data["transceiver_module"]
        lines = [
            f"{c['bg_emerald']}{c['emerald']}{c['bold']} ● SVL KERNEL v6.8.0-PollinationsPro {c['reset']} "
            f"{c['bg_purple']}{c['purple']}{c['bold']} TATA / TWÓRCA: Mateusz Mitek [Tata] {c['reset']} "
            f"{c['bg_crimson']}{c['crimson']}{c['bold']} ● ROOT: RING-0 (TRIADA) {c['reset']} "
            f"{c['bg_emerald']}{c['green']}{c['bold']} ● INFRA: DOWÓDCA ALEX {c['reset']}",
            f"{c['purple']}{c['bold']}┌── {inc['title']} [{inc['timestamp']}] ────────────────────── [{inc['mode_badge']}] ──┐{c['reset']}",
            f"{c['purple']}│{c['reset']} {c['white']}{c['bold']}{inc['sender']}{c['reset']}  {c['purple']}████████████████████░░░░░ 78%{c['reset']}",
            f"{c['cyan']}{c['bold']}├── {tr['module_title']} ─────────────────── [{tr['band_badge']}] ──┤{c['reset']}",
            f"{c['cyan']}│{c['reset']} 📡 {c['white']}{c['bold']}{tr['center_name']}{c['reset']}",
            f"{c['cyan']}│{c['reset']} {c['muted']}SOJUSZNIK DOMYŚLNY:{c['reset']} {c['white']}{c['bold']}{tr['default_ally']}{c['reset']}   {c['emerald']}{c['bold']}{tr['link_status']}{c['reset']}",
            f"{c['cyan']}│{c['reset']} {c['muted']}{tr['recent_header']}{c['reset']} [{c['cyan']}{c['bold']}{tr['live_badge']}{c['reset']}] -> {c['emerald']}{c['bold']}{tr['scan_status']}{c['reset']}",
            f"{c['cyan']}{c['bold']}└────────────────────────────────────────────────────────────────────────────────┘{c['reset']}",
        ]
        return "\n".join(lines)

    def format_exec_code_block_ansi(self, block: Optional[Dict[str, Any]] = None) -> str:
        """Renderuje blok `[EXEC · ROOT UNLIMITED · shell]` (`>_ KOD`) + pigułki akcji w 24-bitowym ANSI TrueColor."""
        c = ANSI_TRUECOLOR
        data = block or build_exec_root_code_block()
        pills_str = " ".join(
            f"{c[p['tone']]}{c['bold']}[{p['icon']} {p['label']}]{c['reset']}"
            for p in data["quick_pills"]
        )
        checks_lines = [
            f"  {c['emerald']}{c['bold']}{chk['label']}{c['reset']} {c['muted']}({chk['duration_ms']:.6f}ms){c['reset']}"
            for chk in data["verified_checks"]
        ]
        lines = [
            f"{c['amber']}{c['bold']}{data['header_badge']}{c['reset']}",
            f"{c['cyan']}{c['bold']}┌── {data['window_label']} ({data['language']}) ──────────────────────────────────────────── [📋 {data['copy_label']}] ──┐{c['reset']}",
        ]
        for code_line in str(data["code"]).splitlines():
            col = c["muted"] if code_line.strip().startswith("#") else c["emerald"]
            lines.append(f"{c['cyan']}│{c['reset']} {col}{code_line}{c['reset']}")
        lines.append(f"{c['cyan']}├── Uruchomiono: {c['amber']}{c['bold']}{data['command']}{c['reset']} {c['cyan']}──────────────────────────────────────────────────┤{c['reset']}")
        lines.extend(checks_lines)
        lines.append(f"{c['cyan']}{c['bold']}└────────────────────────────────────────────────────────────────────────────────┘{c['reset']}")
        lines.append(f"Szybkie akcje AI: {pills_str}")
        return "\n".join(lines)

    def build_showcase_markdown_and_ansi(self, cube_number: int = 364) -> Dict[str, Any]:
        """
        Buduje pełną demonstrację zaawansowanych kolorów tekstu, formatowania, karty transmisji Ring-0,
        Kodeka W. Głockiego (CUBE 364) oraz bloku `>_ KOD` zarówno w kompatybilnych tokenach UI `SVL_Core`,
        jak i w 24-bitowym ANSI TrueColor.
        """
        codec = compute_glocki_cube_codec(cube_number)
        trans = build_ring0_transmission_card()
        exec_blk = build_exec_root_code_block()

        ui_markdown = (
            "[badge:SVL KERNEL v6.8.0-PollinationsPro|ok] "
            "[badge:TATA / TWÓRCA: Mateusz Mitek [Tata]|info] "
            "[badge:● ROOT: RING-0 (TRIADA)|err] "
            "[badge:● INFRA: DOWÓDCA ALEX|ok]\n\n"
            "[alert:info|✨ PRZYCHODZĄCA TRANSMISJA · Od: Skaner Hiperprzestrzeni Ring-0 (INCOMING_ONLY)|"
            "MODUŁ NADAWCZO-ODBIORCZY · PASMO: 128-BIT HIPERPRZESTRZEŃ · "
            "Centrum Transmisji & Hiperłącza RING-0 · SOJUSZNIK DOMYŚLNY: Kosmodrom Wenchange ✔ Łącze aktywne (100%) · "
            "LIVE FEED: Skanowanie pasma: AKTYWNE]\n\n"
            f"**NEXUS APEIRO v4.0 //** [hl:[ZERO-STATIC_LIVE_NLP]|emerald] · "
            f"Operator: **Mateusz Mitek** | Dowództwo: [hl:Jyn Mitek 🌌✨|cyan] & [hl:Ring-0 📜⚖️|amber] | "
            f"[hl:Stany: 8.19242634e+48|violet]\n"
            f"### `0x03 // KODEK W. GŁOCKIEGO (CUBE: {codec['value']})`\n"
            f"- **NKB (12-bit):** [hl:{codec['nkb']}|violet]\n"
            f"- **GRAY (12-bit):** [hl:{codec['gray']}|cyan]\n"
            f"- **BCD (8421):** [hl:{codec['bcd']}|amber]\n"
            f"- **XS3 (Excess-3):** [hl:{codec['xs3']}|emerald]\n\n"
            f"[terminal:[EXEC · ROOT UNLIMITED · shell] >_ KOD|{exec_blk['command']}|"
            f"✔ Weryfikacja KMS & Cloud HSM FIPS 140-3 L3 (42.184112ms) · "
            f"✔ Tunel Google HA VPN 34.118.64.100 <-> 34.118.64.200 (64.910245ms) · "
            f"✔ Synchronizacja 21 modułów JYN_OS $21,000.00 USD (93.752252ms)]\n\n"
            "```bash\n"
            f"{exec_blk['code']}\n"
            "```\n\n"
            "[btn: 📊 Wykres | module:chroma_rich_typography_suite:render_chart] "
            "[btn: 🖼️ Grafika | module:cloud_vision_docai:analyze_camera] "
            "[btn: 🎬 Wideo | module:gemini_ai_studio:run_pro] "
            "[btn: </> Kod | module:chroma_rich_typography_suite:exec_code] "
            "[btn: </> cURL | module:chroma_rich_typography_suite:exec_curl]"
        )

        ansi_preview = "\n\n".join([
            self.format_ring0_transmission_ansi(trans),
            self.format_glocki_cube_ansi(codec),
            self.format_exec_code_block_ansi(exec_blk),
        ])

        return {
            "engine": self.ENGINE_NAME,
            "version": self.ENGINE_VERSION,
            "rich_installed": HAS_RICH,
            "pygments_installed": HAS_PYGMENTS,
            "glocki_codec": codec,
            "ring0_transmission": trans,
            "exec_block": exec_blk,
            "ui_markdown": ui_markdown,
            "ansi_preview": ansi_preview,
        }


__all__ = [
    "ANSI_TRUECOLOR",
    "HEX_PALETTE",
    "QUICK_MEDIA_ACTION_PILLS",
    "ChromaTextEngine",
    "build_exec_root_code_block",
    "build_ring0_transmission_card",
    "compute_glocki_cube_codec",
]
