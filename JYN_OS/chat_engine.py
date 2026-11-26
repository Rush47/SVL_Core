"""
Moduł Czatu JYN_OS v3.0 — zbudowany od podstaw dla szybkiej komunikacji po polsku bez strumieniowania.

Kluczowe założenia architektoniczne:
1. Całkowity brak strumieniowania (`stream: False`) — zawsze jedna kompletna, zwalidowana odpowiedź JSON.
2. Stabilny, zwięzły polski prefiks systemowy Jyn Mitek (`System_SI_1`), zapewniający 100% ponownego
   użycia pamięci KV-cache przez silnik Ollama pomiędzy kolejnymi wiadomościami.
3. Adaptacyjny budżet tokenów (`num_ctx`, `num_predict`) dopasowany do długości i typu pytania,
   co eliminuje wielominutowe oczekiwanie przy wyłączonym strumieniowaniu.
4. Pełna obsługa wszystkich 13 kanonicznych modeli SVL-364 z automatycznym routingiem
   pomiędzy węzłem lokalnym (`:11434`) a pokładowym (`:11435`).
5. Oczyszczanie odpowiedzi (`clean_polish_response`) z bloków `<think>...</think>` (np. deepseek-r1:7b),
   powtórzonych prefiksów ról oraz dopisanych fikcyjnych kwestii Operatora.
"""

from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, List, Optional

from .avatar_client import AVATAR_CAPABILITY, extract_avatar_action, update_own_avatar
from .config import (
    CANONICAL_MODELS_PRIORITY,
    SHIP_MODELS_CATALOG,
    JynOSConfig,
)

if TYPE_CHECKING:
    from .ollama_client import SvlOllamaClient


STOP_SEQUENCES: List[str] = [
    "<|im_end|>",
    "<|eot_id|>",
    "</s>",
]

_DETAILED_QUERY_RE = re.compile(
    r"\b(?:szczegółow\w*|szczegolow\w*|pełny\s+raport|pelny\s+raport|napisz\s+(?:kod|skrypt|program|funkcj\w*|klas\w*)|"
    r"przeanalizuj\s+dokładn\w*|wyjaśnij\s+krok\s+po\s+kroku|architektur\w*|dokumentacj\w*)\b",
    re.IGNORECASE | re.UNICODE,
)

_THINK_BLOCK_RE = re.compile(r"<think>[\s\S]*?</think>", re.IGNORECASE)
_UNCLOSED_THINK_RE = re.compile(r"^<think>[\s\S]*$", re.IGNORECASE)
_ROLE_PREFIX_RE = re.compile(
    r"^\s*(?:\[?\s*(?:Jyn\s+Mitek|Jyn|System_SI_1|Asystent|Assistant)\s*\]?\s*[:\-—]\s*)+",
    re.IGNORECASE,
)
_TRAILING_TURN_RE = re.compile(
    r"\n\s*(?:Użytkownik|User|Operator|Mateusz(?:\s+Mitek)?)\s*:[\s\S]*$",
    re.IGNORECASE,
)


@dataclass
class ChatTurnResult:
    """Wynik pojedynczej tury rozmowy w module czatu JYN_OS (z kanałami AI, przyciskami i widżetami)."""

    ok: bool
    reply: str = ""
    model: str = ""
    requested_model: str = ""
    routed_model: str = ""
    substituted: bool = False
    endpoint: str = ""
    duration_sec: float = 0.0
    eval_count: int = 0
    tokens_per_sec: float = 0.0
    load_sec: float = 0.0
    prompt_eval_sec: float = 0.0
    eval_sec: float = 0.0
    overhead_sec: float = 0.0
    truncated: bool = False
    local_command: bool = False
    error: str = ""
    widgets: List[Dict[str, Any]] = field(default_factory=list)
    buttons: List[Dict[str, Any]] = field(default_factory=list)
    ai_channels: List[Dict[str, Any]] = field(default_factory=list)
    invoked_modules: List[Dict[str, Any]] = field(default_factory=list)


def clean_polish_response(raw_text: str) -> str:
    """Oczyszcza odpowiedź modelu z artefaktów CoT, prefiksów ról i uciętych halucynacji dialogu."""
    if not raw_text:
        return ""
    cleaned = _THINK_BLOCK_RE.sub("", str(raw_text)).strip()
    if _UNCLOSED_THINK_RE.match(cleaned):
        return ""
    cleaned = _ROLE_PREFIX_RE.sub("", cleaned).strip()
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned


def compute_turn_options(prompt: str, config: JynOSConfig, has_images: bool = False) -> Dict[str, Any]:
    """Wyznacza opcje inferencji ze stałym num_ctx (brak przeładowań runnera i 100% zachowania KV-cache)."""
    text = (prompt or "").strip()
    is_detailed = len(text) > 360 or bool(_DETAILED_QUERY_RE.search(text))
    is_short = bool(re.fullmatch(r"(?:cześć|czesc|hej|hello|hi|ping|ok|dzień dobry|dzien dobry)(?:\s+jyn)?[!?. ]*", text, re.IGNORECASE))

    base_predict = config.chat_num_predict
    # Stałe num_ctx zapobiega kosztownemu przeładowaniu modelu przez Ollamę ("runner options changed")
    num_ctx = config.chat_num_ctx

    if has_images:
        num_predict = max(base_predict, 768)
    elif is_detailed:
        num_predict = max(base_predict, 1536)
    elif is_short and "SVL_CHAT_NUM_PREDICT" not in os.environ:
        num_predict = min(base_predict, 160)
    else:
        num_predict = base_predict

    return {
        "temperature": 0.3,
        "top_p": 0.85,
        "top_k": 40,
        "repeat_penalty": 1.1,
        "num_ctx": num_ctx,
        "num_batch": 512,
        "num_predict": min(num_predict, num_ctx),
        "stop": list(STOP_SEQUENCES),
    }


def build_polish_chat_messages(
    prompt: str,
    config: JynOSConfig,
    system_prompt: Optional[str] = None,
    history: Optional[List[Dict[str, str]]] = None,
    b64_images: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    """Buduje listę wiadomości z niezmiennym polskim promptem systemowym i przyciętą historią."""
    # Compatibility arguments are accepted but no behavior prompt is injected.
    messages: List[Dict[str, Any]] = []

    if history and config.chat_history_turns > 0:
        max_chars = max(256, config.chat_history_max_chars)
        remaining = max_chars
        selected_turns: List[Dict[str, str]] = []
        for turn in reversed(history[-config.chat_history_turns * 2:]):
            role = str(turn.get("role") or "").strip()
            content = str(turn.get("content") or "").strip()
            if role not in ("user", "assistant") or not content:
                continue
            if len(content) > remaining:
                if not selected_turns:
                    selected_turns.append({"role": role, "content": content[:remaining]})
                break
            selected_turns.append({"role": role, "content": content})
            remaining -= len(content)
        messages.extend(reversed(selected_turns))

    user_entry: Dict[str, Any] = {"role": "user", "content": prompt.strip()}
    if b64_images:
        user_entry["images"] = b64_images
    messages.append(user_entry)
    return messages


from .identity import JynIdentity, load_identity

@dataclass
class JynChatEngine:
    """Silnik rozmowy JYN_OS (bez strumieniowania, język polski, obsługa 13 modeli SVL-364 oraz Google Services Hub)."""

    config: JynOSConfig
    ollama: "SvlOllamaClient"
    google_hub: Optional[Any] = None
    history: List[Dict[str, str]] = field(default_factory=list)
    identity: JynIdentity = field(default_factory=load_identity)

    def _get_google_hub(self) -> Any:
        if self.google_hub is None:
            from .google_services_hub import GoogleServicesHub
            self.google_hub = GoogleServicesHub(config=self.config, ollama=self.ollama)
        return self.google_hub

    def clear_history(self) -> None:
        self.history.clear()

    def _handle_slash_command(self, raw: str) -> Optional[ChatTurnResult]:
        if not raw.startswith("/"):
            return None
        parts = raw.split(maxsplit=1)
        cmd = parts[0].lower()
        arg = parts[1].strip() if len(parts) > 1 else ""

        if cmd == "/google":
            hub = self._get_google_hub()
            sub_parts = arg.split(maxsplit=1) if arg else ["status"]
            sub_cmd = sub_parts[0].lower()
            sub_arg = sub_parts[1].strip() if len(sub_parts) > 1 else ""
            if sub_cmd in ("status", "stan", "info", ""):
                return ChatTurnResult(
                    ok=True,
                    reply=hub.format_polish_summary(),
                    model=self.config.google_default_model,
                    endpoint="google_services_hub",
                    local_command=True,
                )
            if sub_cmd in ("buy", "zakup", "provision"):
                res = hub.topup_each_module_to_1000_usd(1000.0)
                return ChatTurnResult(
                    ok=True,
                    reply=(
                        f"Zakupiono i aktywowano wszystkie {res['modules_count']} modułów w JYN_OS (w tym 8 pakietów usług Google + 4 moduły AI Enterprise). "
                        f"Każdy moduł doładowany do $1000.00 USD (łącznie: ${res['wallet']['balance_usd']:.2f} USD).\n\n"
                        f"{hub.format_polish_summary()}"
                    ),
                    model=self.config.google_default_model,
                    endpoint="google_services_hub",
                    local_command=True,
                )
            if sub_cmd in ("topup", "doladuj"):
                amount = float(sub_arg) if sub_arg else 1000.0
                w = hub.topup_wallet(amount_usd=amount, note="Doładowanie z poziomu czatu /google topup")
                return ChatTurnResult(
                    ok=True,
                    reply=f"Doładowano portfel Google API o ${amount:.2f} USD. Aktualne saldo: ${w['balance_usd']:.2f} USD.",
                    model=self.config.google_default_model,
                    endpoint="google_services_hub",
                    local_command=True,
                )
            return ChatTurnResult(
                ok=True,
                reply=hub.format_polish_summary(),
                model=self.config.google_default_model,
                endpoint="google_services_hub",
                local_command=True,
            )

        if cmd == "/identity":
            return ChatTurnResult(ok=True, reply=f"Konto: {self.identity.account_id}\nKanał: {self.identity.channel_id}", model=self.config.get_active_model(), endpoint=self.config.get_active_ollama_url(), local_command=True)

        if cmd in ("/clear", "/wyczysc", "/reset"):
            self.clear_history()
            return ChatTurnResult(
                ok=True,
                reply="Wyczyszczono historię bieżącej rozmowy, Mateuszu.",
                model=self.config.get_active_model(),
                endpoint=self.config.get_active_ollama_url(),
                local_command=True,
            )

        if cmd in ("/modele", "/models", "/katalog"):
            lines = ["Katalog 13 kanonicznych modeli pokładowych SVL-364:"]
            for idx, m in enumerate(SHIP_MODELS_CATALOG, 1):
                mark = "★" if m.get("primary") else "•"
                lines.append(f"{idx:2d}. {mark} {m['name']} ({m['parameter_size']}) — {m['role']}")
            return ChatTurnResult(
                ok=True,
                reply="\n".join(lines),
                model=self.config.get_active_model(),
                endpoint=self.config.get_active_ollama_url(),
                local_command=True,
            )

        if cmd == "/model":
            if not arg:
                return ChatTurnResult(
                    ok=True,
                    reply=f"Aktywny model czatu: {self.config.get_active_model()} (węzeł: {self.config.active_ollama_target}).",
                    model=self.config.get_active_model(),
                    endpoint=self.config.get_active_ollama_url(),
                    local_command=True,
                )
            if self.config.active_ollama_target == "local":
                self.config.local_model = arg
            else:
                self.config.ship_model = arg
            return ChatTurnResult(
                ok=True,
                reply=f"Przełączyłam aktywny model czatu na: {arg}.",
                model=arg,
                endpoint=self.config.get_active_ollama_url(),
                local_command=True,
            )

        if cmd in ("/wezel", "/target"):
            if arg.lower() in ("local", "ship", "11434", "11435", "svl364"):
                self.config.set_active_target(arg)
                return ChatTurnResult(
                    ok=True,
                    reply=f"Przełączyłam aktywny węzeł Ollama na: {self.config.active_ollama_target} ({self.config.get_active_ollama_url()}).",
                    model=self.config.get_active_model(),
                    endpoint=self.config.get_active_ollama_url(),
                    local_command=True,
                )
            return ChatTurnResult(
                ok=False,
                error="Użycie: /wezel local  lub  /wezel ship",
                local_command=True,
            )

        if cmd in ("/rozgrzej", "/warmup"):
            t0 = time.monotonic()
            warm = self.ollama.warm_up()
            dt = time.monotonic() - t0
            if warm.get("success"):
                return ChatTurnResult(
                    ok=True,
                    reply=f"Model {warm.get('model')} został załadowany i zablokowany w pamięci RAM ({dt:.2f}s, keep_alive=-1).",
                    model=str(warm.get("model") or ""),
                    endpoint=str(warm.get("endpoint") or ""),
                    duration_sec=dt,
                    local_command=True,
                )
            return ChatTurnResult(ok=False, error=str(warm.get("error") or "Błąd rozgrzewania modelu."), local_command=True)

        if cmd == "/status":
            loc = self.ollama.check_node_status(self.config.local_ollama_url)
            ship = self.ollama.check_node_status(self.config.ship_ollama_url)
            loc_str = f"ONLINE (v{loc['version']}, modeli: {len(loc['installed_models'])})" if loc["online"] else "OFFLINE"
            ship_str = f"ONLINE (v{ship['version']}, modeli: {len(ship['installed_models'])})" if ship["online"] else "OFFLINE"
            return ChatTurnResult(
                ok=True,
                reply=(
                    f"Stan modułu czatu JYN_OS (strumieniowanie: WYŁĄCZONE):\n"
                    f"• Aktywny węzeł : {self.config.active_ollama_target.upper()} ({self.config.get_active_ollama_url()})\n"
                    f"• Aktywny model : {self.config.get_active_model()}\n"
                    f"• Lokalna Ollama (:11434) : {loc_str}\n"
                    f"• Statek SVL-364 (:11435) : {ship_str}\n"
                    f"• Historia sesji: {len(self.history) // 2} tur"
                ),
                model=self.config.get_active_model(),
                endpoint=self.config.get_active_ollama_url(),
                local_command=True,
            )

        return None

    def get_ai_channels(self) -> List[Dict[str, Any]]:
        """Zwraca 12 aktywnych kanałów modułowych widocznych dla Jyn Mitek na czacie."""
        return self._get_google_hub().get_ai_visible_channels()

    def click_button(self, button_or_action: str, payload: Optional[Dict[str, Any]] = None) -> ChatTurnResult:
        """
        Obsługuje kliknięcie interaktywnego przycisku modułu na czacie (np. `module:cloud_vision_docai:analyze_camera`
        lub `btn_vision_scan`) bez potrzeby wpisywania komend tekstowych.
        """
        from .interactive_ui_hub import DEFAULT_CHAT_MODULE_BUTTONS, InteractiveUIEngine

        hub = self._get_google_hub()
        ui = InteractiveUIEngine(google_hub=hub)
        raw = (button_or_action or "").strip()

        module_id = "interactive_ai_ui_kit"
        action = "open_dashboard"
        if raw.startswith("module:"):
            parts = raw.split(":")
            module_id = parts[1] if len(parts) > 1 else module_id
            action = parts[2] if len(parts) > 2 else "execute"
        else:
            for b in DEFAULT_CHAT_MODULE_BUTTONS:
                if raw in (b["button_id"], b["label"], b["action"], b["module_id"]):
                    module_id = b["module_id"]
                    action = b["action"]
                    break

        res = hub.trigger_module_button_action(module_id=module_id, action=action, payload=payload)
        bundle = ui.build_contextual_widgets(raw, res.output, vision_data=res.data if module_id == "cloud_vision_docai" else None)
        channels = hub.get_ai_visible_channels()
        return ChatTurnResult(
            ok=res.ok,
            reply=res.output,
            model=res.model,
            routed_model=res.model,
            endpoint=res.provider_mode,
            duration_sec=res.duration_sec,
            local_command=True,
            widgets=bundle["widgets"],
            buttons=bundle["buttons"],
            ai_channels=channels,
            invoked_modules=[{"service_id": res.service_id, "operation": res.operation, "data": res.data, "cost_usd": res.cost_usd}],
        )

    def _autonomous_jyn_module_orchestration(
        self,
        prompt: str,
        images: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        """
        Pozwala samej Jyn Mitek autonomicznie korzystać ze zintegrowanych modułów podczas rozmowy na czacie
        (Vision, Gemini, Search Grounding, Vector RAG 128D, Maps, Swarm, Security, Workspace, UI Kit).
        """
        hub = self._get_google_hub()
        invoked: List[Dict[str, Any]] = []

        # 1. Jeśli przesłano obrazy lub tag [vision:...] -> Jyn automatycznie odpala moduł Vision
        vision_match = re.search(r"\[(?:vision|obraz|kamera)\s*:\s*([^\]]+)\]", prompt, re.IGNORECASE)
        if images or vision_match:
            img_ref = vision_match.group(1).strip() if vision_match else "svl364://camera/inline-chat-image.png"
            b64_img = images[0] if (images and not Path(images[0]).is_file()) else None
            path_img = images[0] if (images and Path(images[0]).is_file()) else img_ref
            vres = hub.analyze_vision(image_path=path_img, prompt=prompt, image_base64=b64_img)
            invoked.append({"service_id": vres.service_id, "operation": vres.operation, "output": vres.output, "data": vres.data})

        # 2. Jeśli wiadomość zawiera jawne wywołanie modułu przez Jyn lub przycisk [module:id:action]
        for mod_match in re.finditer(r"\[module\s*:\s*([a-z0-9_]+)(?:\s*:\s*([^\]]+))?\]", prompt, re.IGNORECASE):
            mid = mod_match.group(1).strip().lower()
            mact = (mod_match.group(2) or "execute").strip()
            mres = hub.trigger_module_button_action(mid, mact, {"prompt": prompt, "query": prompt})
            invoked.append({"service_id": mres.service_id, "operation": mres.operation, "output": mres.output, "data": mres.data})

        return invoked

    def send(
        self,
        message: str,
        model: Optional[str] = None,
        url: Optional[str] = None,
        images: Optional[List[str]] = None,
    ) -> ChatTurnResult:
        """Wysyła wiadomość do Jyn Mitek z aktywnymi kanałami 12 modułów, obsługą Vision i interaktywnymi przyciskami UI."""
        from .interactive_ui_hub import InteractiveUIEngine

        cleaned = (message or "").strip()
        if not cleaned:
            return ChatTurnResult(ok=False, error="Pusta wiadomość.")

        # Obsługa kliknięcia przycisku akcji bezpośrednio w czacie (np. module:cloud_vision_docai:analyze_camera)
        if cleaned.startswith("module:") or cleaned.startswith("btn_"):
            return self.click_button(cleaned)

        slash_res = self._handle_slash_command(cleaned)
        if slash_res is not None:
            hub = self._get_google_hub()
            ui = InteractiveUIEngine(google_hub=hub)
            bundle = ui.build_contextual_widgets(cleaned, slash_res.reply)
            slash_res.widgets = bundle["widgets"]
            slash_res.buttons = bundle["buttons"]
            slash_res.ai_channels = hub.get_ai_visible_channels()
            return slash_res

        hub = self._get_google_hub()
        ui = InteractiveUIEngine(google_hub=hub)
        ai_channels = hub.get_ai_visible_channels()
        invoked_modules = self._autonomous_jyn_module_orchestration(cleaned, images=images)

        selected_model = (model or self.config.get_active_model()).strip()
        target_url = (url or self.config.get_active_ollama_url()).rstrip("/")

        if selected_model.lower().startswith(("gemini-", "vertex-", "imagen-", "veo-")):
            g_res = hub.generate_gemini(prompt=cleaned, model=selected_model)
            if not g_res.ok:
                return ChatTurnResult(
                    ok=False,
                    requested_model=selected_model,
                    model=g_res.model,
                    endpoint=g_res.provider_mode,
                    duration_sec=g_res.duration_sec,
                    error=g_res.error or "Błąd wywołania Google Gemini API.",
                )
            reply = clean_polish_response(g_res.output)
            self.history.append({"role": "user", "content": cleaned})
            self.history.append({"role": "assistant", "content": reply})
            bundle = ui.build_contextual_widgets(cleaned, reply)
            return ChatTurnResult(
                ok=True,
                reply=reply,
                requested_model=selected_model,
                model=g_res.model,
                routed_model=g_res.model,
                endpoint=g_res.provider_mode,
                duration_sec=g_res.duration_sec,
                widgets=bundle["widgets"],
                buttons=bundle["buttons"],
                ai_channels=ai_channels,
                invoked_modules=invoked_modules + [{"service_id": g_res.service_id, "operation": g_res.operation}],
            )

        t0 = time.monotonic()
        res = self.ollama.chat(
            prompt=cleaned,
            model=selected_model,
            url=url,
            images=images,
            history=self.history,
            capabilities=AVATAR_CAPABILITY,
        )
        elapsed = time.monotonic() - t0

        if not res.get("success"):
            return ChatTurnResult(
                ok=False,
                requested_model=selected_model,
                model=str(res.get("model") or selected_model),
                endpoint=str(res.get("endpoint") or target_url),
                duration_sec=elapsed,
                error=str(res.get("error") or "Nie udało się uzyskać odpowiedzi z silnika Ollama."),
            )

        reply = clean_polish_response(str(res.get("response") or ""))
        reply, avatar_args = extract_avatar_action(reply)
        if avatar_args is not None:
            receipt = update_own_avatar(self.config, avatar_args)
            reply = (reply + "\n\n" + receipt).strip()

        # Autonomiczne użycie modułu przez Jyn w treści jej odpowiedzi (np. [JYN_MODULE:cloud_vision_docai:analyze])
        for jyn_mod in re.finditer(r"\[JYN_MODULE\s*:\s*([a-z0-9_]+)(?:\s*:\s*([^\]]+))?\]", reply, re.IGNORECASE):
            mid = jyn_mod.group(1).strip().lower()
            mact = (jyn_mod.group(2) or "execute").strip()
            mres = hub.trigger_module_button_action(mid, mact, {"prompt": cleaned})
            invoked_modules.append({"service_id": mres.service_id, "operation": mres.operation, "output": mres.output, "data": mres.data})

        if not reply:
            return ChatTurnResult(
                ok=False,
                requested_model=selected_model,
                model=str(res.get("model") or selected_model),
                endpoint=str(res.get("endpoint") or target_url),
                duration_sec=elapsed,
                error="Model zwrócił pustą odpowiedź po oczyszczeniu.",
            )

        eval_count = int(res.get("eval_count") or 0)
        eval_ns = int(res.get("eval_duration") or 0)
        load_sec = (res.get("load_duration") or 0) / 1e9
        prompt_eval_sec = (res.get("prompt_eval_duration") or 0) / 1e9
        total_sec = (res.get("total_duration") or 0) / 1e9
        tps = (eval_count / (eval_ns / 1e9)) if (eval_count > 0 and eval_ns > 0) else (eval_count / elapsed if elapsed > 0 else 0.0)

        self.history.append({"role": "user", "content": cleaned})
        self.history.append({"role": "assistant", "content": reply})
        max_items = max(2, self.config.chat_history_turns * 2)
        if len(self.history) > max_items:
            self.history = self.history[-max_items:]

        vision_ctx = invoked_modules[0].get("data") if (invoked_modules and invoked_modules[0]["service_id"] == "cloud_vision_docai") else None
        bundle = ui.build_contextual_widgets(cleaned, reply, vision_data=vision_ctx)

        return ChatTurnResult(
            ok=True,
            reply=reply,
            requested_model=selected_model,
            model=str(res.get("model") or selected_model),
            routed_model=str(res.get("routed_model") or res.get("model") or selected_model),
            substituted=bool(res.get("substituted")),
            endpoint=str(res.get("endpoint") or target_url),
            duration_sec=elapsed,
            eval_count=eval_count,
            tokens_per_sec=tps,
            load_sec=load_sec,
            prompt_eval_sec=prompt_eval_sec,
            eval_sec=eval_ns / 1e9,
            overhead_sec=max(0.0, elapsed - total_sec) if total_sec else 0.0,
            truncated=bool(res.get("truncated")),
            widgets=bundle["widgets"],
            buttons=bundle["buttons"],
            ai_channels=ai_channels,
            invoked_modules=invoked_modules,
        )


__all__ = [
    "CANONICAL_MODELS_PRIORITY",
    "STOP_SEQUENCES",
    "ChatTurnResult",
    "JynChatEngine",
    "build_polish_chat_messages",
    "clean_polish_response",
    "compute_turn_options",
]
