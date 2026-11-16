#!/usr/bin/env python3
"""
SVL Python OS — uruchamianie prawdziwej Ollamy.

Jeśli na 127.0.0.1:11434 nic nie nasłuchuje, a w systemie jest prawdziwy program `ollama`
(plik ELF), moduł uruchamia `ollama serve`. W przeciwnym razie nic nie udaje.

Wcześniejsze wersje uruchamiały tu zastępczy serwer HTTP, który podawał się za Ollamę
(wersja „0.6.4-svl-364-apex”), wymyślał listę modeli i odpowiadał gotowymi szablonami
(„obraz zweryfikowany”, „GPU 16.4/24.0 GB”, „położenie statku L2”), oraz fałszywe polecenie
`ollama`. Te odpowiedzi trafiały do użytkownika jako wyniki modelu — zostały usunięte,
a stare kopie fałszywego polecenia są sprzątane przy starcie.
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import time
from pathlib import Path
from typing import Any, Callable, Optional

# Ślady fałszywego polecenia `ollama` z poprzednich wersji (rozpoznawane po treści).
_LEGACY_FAKE_CLI_MARKERS = ("0.6.4-svl-364-apex", "Ollama SVL-364 CLI Bridge")


def is_real_ollama_binary(path: Path) -> bool:
    try:
        if not path.is_file():
            return False
        with path.open("rb") as f:
            return f.read(4) == b"\x7fELF"
    except OSError:
        return False


def is_legacy_fake_ollama_cli(path: Path) -> bool:
    try:
        if not path.is_file() or path.stat().st_size > 16 * 1024 or is_real_ollama_binary(path):
            return False
        content = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return False
    return any(marker in content for marker in _LEGACY_FAKE_CLI_MARKERS)


def find_real_ollama_binary() -> Optional[Path]:
    candidates: list[Path] = []
    which_path = shutil.which("ollama")
    if which_path:
        candidates.append(Path(which_path))
    candidates.extend([Path("/usr/local/bin/ollama"), Path("/usr/bin/ollama")])
    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate)
        if key in seen:
            continue
        seen.add(key)
        if is_real_ollama_binary(candidate):
            try:
                return candidate.resolve()
            except OSError:
                return candidate
    return None


class SVLLocalOllamaDaemon:
    """Uruchamia prawdziwą Ollamę na 127.0.0.1:11434, jeśli jest zainstalowana. Niczego nie symuluje."""

    def __init__(self, kernel_Getter: Optional[Callable[[], Any]] = None, host: str = "127.0.0.1", port: int = 11434) -> None:
        self.kernel_getter = kernel_Getter
        self.host = host
        self.port = port
        self._real_process: Optional[subprocess.Popen[bytes]] = None

    def ensure_cli_binary(self) -> list[str]:
        """Usuwa stare fałszywe polecenia `ollama` (nigdy nie rusza prawdziwego pliku ELF)."""
        removed: list[str] = []
        for target in (Path("/usr/local/bin/ollama"), Path(__file__).resolve().parent / "bin" / "ollama"):
            if is_legacy_fake_ollama_cli(target):
                try:
                    target.unlink()
                    removed.append(str(target))
                except OSError:
                    pass
        return removed

    def _port_open(self) -> bool:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.35)
            return sock.connect_ex((self.host, self.port)) == 0

    def _start_real_ollama_serve(self, real_bin: Path) -> bool:
        log_dir = Path(__file__).resolve().parent.parent / "data"
        log_dir.mkdir(parents=True, exist_ok=True)
        log_file = log_dir / "ollama-serve.log"
        env = dict(os.environ)
        env.setdefault("OLLAMA_HOST", f"{self.host}:{self.port}")
        env.setdefault("OLLAMA_MAX_LOADED_MODELS", "1")
        env.setdefault("OLLAMA_NUM_PARALLEL", "1")
        env.setdefault("OLLAMA_KEEP_ALIVE", "15m")
        env.setdefault("GODEBUG", "netdns=cgo")
        try:
            with log_file.open("ab") as log_handle:
                proc = subprocess.Popen(
                    [str(real_bin), "serve"],
                    stdout=log_handle,
                    stderr=subprocess.STDOUT,
                    env=env,
                    start_new_session=True,
                )
            self._real_process = proc
            for _ in range(30):
                if self._port_open():
                    return True
                time.sleep(0.15)
            return False
        except OSError:
            return False

    def start_if_needed(self) -> bool:
        """True, gdy na porcie działa (lub właśnie wystartowała) Ollama. Bez Ollamy — False."""
        self.ensure_cli_binary()
        if self._port_open():
            return True
        real_bin = find_real_ollama_binary()
        if real_bin is not None and self.port == 11434:
            return self._start_real_ollama_serve(real_bin)
        return False
