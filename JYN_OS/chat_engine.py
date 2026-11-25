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
from typing import TYPE_CHECKING, Any, Dict, List, Optional

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
    "\nUżytkownik:",
    "\nUser:",
    "\nOperator:",
    "\nMateusz Mitek:",
    "\n[Operator]:",
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
    """Wynik pojedynczej tury rozmowy w module czatu JYN_OS."""

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
    truncated: bool = False
    local_command: bool = False
    error: str = ""


def clean_polish_response(raw_text: str) -> str:
    """Oczyszcza odpowiedź modelu z artefaktów CoT, prefiksów ról i uciętych halucynacji dialogu."""
    if not raw_text:
        return ""
    cleaned = _THINK_BLOCK_RE.sub("", str(raw_text)).strip()
    if _UNCLOSED_THINK_RE.match(cleaned):
        cleaned = re.sub(r"^<think>", "", cleaned, flags=re.IGNORECASE).strip()
    cleaned = _ROLE_PREFIX_RE.sub("", cleaned).strip()
    cleaned = _TRAILING_TURN_RE.sub("", cleaned).strip()
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
    effective_sys = (system_prompt if system_prompt is not None else config.system_prompt).strip()
    messages: List[Dict[str, Any]] = []
    if effective_sys:
        messages.append({"role": "system", "content": effective_sys})

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


@dataclass
class JynChatEngine:
    """Silnik rozmowy JYN_OS (bez strumieniowania, język polski, obsługa 13 modeli SVL-364)."""

    config: JynOSConfig
    ollama: "SvlOllamaClient"
    history: List[Dict[str, str]] = field(default_factory=list)

    def clear_history(self) -> None:
        self.history.clear()

    def _handle_slash_command(self, raw: str) -> Optional[ChatTurnResult]:
        if not raw.startswith("/"):
            return None
        parts = raw.split(maxsplit=1)
        cmd = parts[0].lower()
        arg = parts[1].strip() if len(parts) > 1 else ""

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

    def send(
        self,
        message: str,
        model: Optional[str] = None,
        url: Optional[str] = None,
        images: Optional[List[str]] = None,
    ) -> ChatTurnResult:
        """Wysyła wiadomość do silnika Ollama bez strumieniowania i zwraca pełną polską odpowiedź."""
        cleaned = (message or "").strip()
        if not cleaned:
            return ChatTurnResult(ok=False, error="Pusta wiadomość.")

        slash_res = self._handle_slash_command(cleaned)
        if slash_res is not None:
            return slash_res

        selected_model = (model or self.config.get_active_model()).strip()
        target_url = (url or self.config.get_active_ollama_url()).rstrip("/")

        t0 = time.monotonic()
        res = self.ollama.chat(
            prompt=cleaned,
            model=selected_model,
            url=url,
            images=images,
            history=self.history,
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
        tps = (eval_count / (eval_ns / 1e9)) if (eval_count > 0 and eval_ns > 0) else (eval_count / elapsed if elapsed > 0 else 0.0)

        self.history.append({"role": "user", "content": cleaned})
        self.history.append({"role": "assistant", "content": reply})
        max_items = max(2, self.config.chat_history_turns * 2)
        if len(self.history) > max_items:
            self.history = self.history[-max_items:]

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
            truncated=bool(res.get("truncated")),
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
