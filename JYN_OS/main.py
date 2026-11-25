#!/usr/bin/env python3
"""
Główny punkt wejściowy systemu klienta JYN_OS v3.0 dla statku SVL-364 Ebon Apex.

Uruchomienie w trybie interaktywnym:
    python3 main.py
    ./jyn_os

Uruchomienie w trybie pojedynczych poleceń CLI:
    ./jyn_os status
    ./jyn_os chat "Cześć Jyn, zamelduj gotowość statku"
    ./jyn_os ollama chat "Podaj raport gotowości"
    ./jyn_os ollama fix
    ./jyn_os ssh "uname -a"
    ./jyn_os telemetry
    ./jyn_os mcp ping
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

if __name__ == "__main__" and __package__ is None:
    current_dir = Path(__file__).resolve().parent
    sys.path.insert(0, str(current_dir.parent))
    from JYN_OS.config import JynOSConfig
    from JYN_OS.shell import JynOSShell
else:
    from .config import JynOSConfig
    from .shell import JynOSShell


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="jyn_os",
        description="JYN_OS v3.0 — System klienta i moduł czatu statku SVL-364 Ebon Apex (Operator: Mateusz Mitek)",
    )
    parser.add_argument(
        "--target",
        "-t",
        default=None,
        help="Profil lub alias OpenSSH docelowego statku (domyślnie: Ship)",
    )
    parser.add_argument(
        "--key",
        "-k",
        default=None,
        help="Ścieżka do klucza prywatnego OpenSSH (domyślnie: ~/.ssh/svl364_ed25519)",
    )

    subparsers = parser.add_subparsers(dest="command", help="Dostępne moduły poleceń JYN_OS")

    subparsers.add_parser("shell", help="Uruchomienie interaktywnej powłoki JYN_OS TUI")
    subparsers.add_parser("status", help="Audyt stanu połączeń (SSH, MCP, Ollama :11434/:11435)")
    subparsers.add_parser("telemetry", help="Pobranie i wyświetlenie telemetrii statku SVL-364")

    direct_chat = subparsers.add_parser("chat", help="Bezpośrednia rozmowa z Jyn Mitek po polsku (bez strumieniowania)")
    direct_chat.add_argument("prompt", help="Wiadomość do Jyn Mitek")
    direct_chat.add_argument("--model", "-m", default=None, help="Nazwa jednego z 13 modeli SVL-364")
    direct_chat.add_argument("--node", choices=("local", "ship"), default=None, help="Węzeł Ollama (local :11434 lub ship :11435)")

    ssh_p = subparsers.add_parser("ssh", help="Wykonanie polecenia lub sesja interaktywna na statku SVL-364")
    ssh_p.add_argument("cmd", nargs="?", default="", help="Polecenie powłoki zdalnej")

    exec_p = subparsers.add_parser("exec", help="Bezpośrednie wykonanie polecenia na statku przez SSH")
    exec_p.add_argument("cmd", help="Polecenie powłoki zdalnej")

    ollama_p = subparsers.add_parser("ollama", help="Zarządzanie jednostkami Ollama (:11434 oraz SVL-364 :11435)")
    ollama_sub = ollama_p.add_subparsers(dest="ollama_action")
    ollama_sub.add_parser("status", help="Status węzłów Ollama i zainstalowane modele")
    ollama_sub.add_parser("models", help="Katalog 13 kanonicznych modeli pokładowych SVL-364")
    ollama_sub.add_parser("fix", help="Naprawa, uruchomienie i rozgrzanie silnika Ollama oraz modelu Apex")
    ollama_sub.add_parser("warmup", help="Załadowanie modelu do pamięci RAM (keep_alive=-1)")
    list_p = ollama_sub.add_parser("list", help="Lista modeli na wybranym węźle")
    list_p.add_argument("node", nargs="?", choices=("local", "ship"))
    chat_p = ollama_sub.add_parser("chat", help="Wysłanie zapytania do modelu bez strumieniowania")
    chat_p.add_argument("prompt", help="Treść zapytania dla modelu AI")
    chat_p.add_argument("--model", "-m", default=None, help="Nazwa modelu (domyślnie: svl364-apex-uncensored:latest)")
    chat_p.add_argument("--node", choices=("local", "ship"), default=None, help="Węzeł docelowy (local lub ship)")

    mcp_p = subparsers.add_parser("mcp", help="Komunikacja z federacją serwerów MCP")
    mcp_sub = mcp_p.add_subparsers(dest="mcp_action")
    mcp_sub.add_parser("ping", help="Ping serwerów MCP")
    mcp_sub.add_parser("list", help="Lista narzędzi w federacji MCP")
    call_p = mcp_sub.add_parser("call", help="Wywołanie narzędzia MCP")
    call_p.add_argument("tool", help="Nazwa narzędzia MCP")

    reset_p = subparsers.add_parser("reset", help="Przywrócenie ustawień fabrycznych (Factory Reset)")
    reset_p.add_argument("--force", "-f", action="store_true", help="Wykonanie resetu bez pytania o potwierdzenie")

    subparsers.add_parser("purge-buffer", help="Oczyszczenie i optymalizacja buforów systemowych")
    subparsers.add_parser("clean", help="Alias do purge-buffer")

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    cfg = JynOSConfig.load_from_env()
    if args.target:
        cfg.ssh_profile = args.target
    if args.key:
        cfg.ssh_key_path = Path(args.key)

    shell = JynOSShell(cfg)

    if not args.command or args.command == "shell":
        try:
            shell.cmdloop()
            return 0
        except KeyboardInterrupt:
            print("\nRozłączono JYN_OS.")
            return 0

    if args.command == "status":
        shell.do_status("")
        return 0

    if args.command == "telemetry":
        shell.do_telemetry("")
        return 0

    if args.command == "chat":
        if getattr(args, "node", None):
            shell.config.set_active_target(args.node)
        return 0 if shell._run_complete_chat(args.prompt, model=args.model) else 1

    if args.command in ("ssh", "exec"):
        shell.do_ssh(getattr(args, "cmd", ""))
        return 0

    if args.command == "ollama":
        action = getattr(args, "ollama_action", "status") or "status"
        if action == "chat":
            if getattr(args, "node", None):
                shell.config.set_active_target(args.node)
            model = getattr(args, "model", None)
            if model:
                shell.config.local_model = model
                shell.config.ship_model = model
            return 0 if shell._run_complete_chat(getattr(args, "prompt", ""), model=model) else 1
        if action == "list":
            node = getattr(args, "node", None)
            shell.do_ollama("list" + (f" {node}" if node else ""))
        else:
            shell.do_ollama(action)
        return 0

    if args.command == "mcp":
        action = getattr(args, "mcp_action", "ping") or "ping"
        if action == "call":
            shell.do_mcp(f"call {getattr(args, 'tool', '')}")
        else:
            shell.do_mcp(action)
        return 0

    if args.command in ("reset", "factory-reset"):
        shell.do_reset("force" if getattr(args, "force", False) else "")
        return 0

    if args.command in ("purge-buffer", "clean"):
        shell.do_purge_buffer("")
        return 0

    return 0


if __name__ == "__main__":
    sys.exit(main())
