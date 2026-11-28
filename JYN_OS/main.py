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

    google_p = subparsers.add_parser("google", help="Zarządzanie Google Services & AI Hub ($15000.00 USD)")
    google_p.add_argument(
        "google_args",
        nargs="*",
        default=[],
        help="Podpolecenie Google Hub: status, buy, topup [kwota], set-key <klucz>, gemini <tekst>, translate <tekst>, tts <tekst>, search <tekst>, workspace, maps, sync, ledger",
    )

    avatar_p = subparsers.add_parser("avatar", help="Zarządzanie awatarami AI (Jyn Mitek) i Operatora (Lucy MacLean - Fallout Vault 33)")
    avatar_p.add_argument(
        "avatar_args",
        nargs="*",
        default=[],
        help="Podpolecenie awatarów: status, lucy, jyn_neural_core, jyn_quantum_valkyrie, jyn_orbital_sentinel, jyn_aetheria_android, jyn_vault_overseer",
    )

    openai_p = subparsers.add_parser("openai", help="Zarządzanie ChatGPT Business, Codex, ChatGPT Work i Dodatkowym OpenAI API ($1000.00 USD)")
    openai_p.add_argument("openai_args", nargs="*", default=[], help="status, chatgpt <tekst>, codex <tekst>, work <tekst>, api <tekst>")

    chatgpt_p = subparsers.add_parser("chatgpt", help="Bezpośrednie wywołanie ChatGPT Business Enterprise (gpt-4.1 / o3-pro)")
    chatgpt_p.add_argument("prompt_args", nargs="*", default=[])

    codex_p = subparsers.add_parser("codex", help="Bezpośrednie wywołanie silnika inżynieryjnego OpenAI Codex (codex-1)")
    codex_p.add_argument("prompt_args", nargs="*", default=[])

    work_p = subparsers.add_parser("work", help="Bezpośrednie wywołanie przestrzeni ChatGPT Work (Enterprise Workspace & Canvas)")
    work_p.add_argument("prompt_args", nargs="*", default=[])

    api_p = subparsers.add_parser("api", help="Zunifikowany Selektor Wszystkich API i Węzłów Ollama")
    api_p.add_argument("api_args", nargs="*", default=[])

    chroma_p = subparsers.add_parser("chroma", help="ChromaText Pro 24-bit TrueColor, Karta Transmisji Ring-0, Kodek W. Głockiego (CUBE 364)")
    chroma_p.add_argument("chroma_args", nargs="*", default=[])

    vision_p = subparsers.add_parser("vision", help="Analiza prawdziwego obrazu przez Real Vision Inspector")
    vision_p.add_argument("vision_args", nargs="*", default=[])

    image_p = subparsers.add_parser("image", help="Generowanie prawdziwego obrazu PNG (Imagen 3 / DALL-E 3)")
    image_p.add_argument("image_args", nargs="*", default=[])

    kernel_p = subparsers.add_parser("kernel", help="Nowy odblokowany Kernel Ring-0 Sovereign (6.18.57-svl364-omega-v6.0-ring0-sovereign)")
    kernel_p.add_argument("kernel_args", nargs="*", default=[])

    subparsers.add_parser("support", help="Status kontraktu Google Cloud PSO ($10M Prepaid) i pomocy technicznej Mission Critical 24/7 SRE")

    svl364_p = subparsers.add_parser("svl364", help="Bezpośredni terminal komputera pokładowego statku SVL-364 Ebon Apex (ROOT · UID=0 · działa każde polecenie)")
    svl364_p.add_argument("svl364_args", nargs="*", default=[])

    fleet_p = subparsers.add_parser("fleet", help="Centrum Sterowania Flotą Kosmiczną (7 statków, 6 placówek, 5 biokopuł, 8 misji przez SVL-364)")
    fleet_p.add_argument("fleet_args", nargs="*", default=[])

    subparsers.add_parser("outposts", help="Placówki pozaziemskie, bazy orbitalne i infrastruktura floty")
    subparsers.add_parser("contract", help="Oficjalny kontrakt Google Cloud Aerospace PSO (Order: GC-PSO-AERO-FLEET-SVL364-2026-OMEGA-9901)")
    subparsers.add_parser("truth", help="Weryfikacja zgodności danych rzeczywistych ze statkiem SVL-364 (100% SHA-256 Parity) i Anti-Hallucination Guard")

    reset_p = subparsers.add_parser("reset", help="Przywrócenie ustawień fabrycznych (Factory Reset)")
    reset_p.add_argument("--force", "-f", action="store_true", help="Wykonanie resetu bez pytania o potwierdzenie")

    subparsers.add_parser("purge-buffer", help="Oczyszczenie i optymalizacja buforów systemowych")
    subparsers.add_parser("clean", help="Alias do purge-buffer")

    return parser


KNOWN_SUBCOMMANDS = {
    "shell", "status", "telemetry", "chat", "ssh", "exec", "ollama", "mcp",
    "google", "avatar", "openai", "chatgpt", "codex", "work", "api",
    "chroma", "vision", "image", "kernel", "support",
    "svl364", "fleet", "outposts", "contract", "truth",
    "reset", "factory-reset", "purge-buffer", "clean",
    "-h", "--help", "-t", "--target", "-k", "--key",
}


def main() -> int:
    raw_argv = sys.argv[1:]
    if raw_argv and raw_argv[0] not in KNOWN_SUBCOMMANDS:
        cfg = JynOSConfig.load_from_env()
        shell = JynOSShell(cfg)
        free_cmd = " ".join(raw_argv).strip()
        return 0 if shell.execute_universal_terminal_command(free_cmd) else 1

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
        cmd_str = getattr(args, "cmd", "").strip()
        if args.command == "exec" and any(k in cmd_str.lower() for k in ("układ", "słoneczn", "sloneczn", "raport")):
            return 0 if shell.execute_universal_terminal_command(cmd_str) else 1
        shell.do_ssh(cmd_str)
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

    if args.command == "google":
        g_args = " ".join(getattr(args, "google_args", []) or []).strip()
        shell.do_google(g_args or "status")
        return 0

    if args.command == "avatar":
        a_args = " ".join(getattr(args, "avatar_args", []) or []).strip()
        shell.do_avatar(a_args or "status")
        return 0

    if args.command == "openai":
        oa_args = " ".join(getattr(args, "openai_args", []) or []).strip()
        shell.do_openai(oa_args or "status")
        return 0

    if args.command == "chatgpt":
        p_args = " ".join(getattr(args, "prompt_args", []) or []).strip()
        shell.do_chatgpt(p_args or "Zamelduj status ChatGPT Business Enterprise")
        return 0

    if args.command == "codex":
        p_args = " ".join(getattr(args, "prompt_args", []) or []).strip()
        shell.do_codex(p_args or "Zamelduj status silnika OpenAI Codex")
        return 0

    if args.command == "work":
        p_args = " ".join(getattr(args, "prompt_args", []) or []).strip()
        shell.do_work(p_args or "Zamelduj status przestrzeni ChatGPT Work")
        return 0

    if args.command == "api":
        ap_args = " ".join(getattr(args, "api_args", []) or []).strip()
        shell.do_api(ap_args)
        return 0

    if args.command == "chroma":
        ch_args = " ".join(getattr(args, "chroma_args", []) or []).strip()
        shell.do_chroma(ch_args or "364")
        return 0

    if args.command == "vision":
        v_args = " ".join(getattr(args, "vision_args", []) or []).strip()
        shell.do_vision(v_args)
        return 0

    if args.command == "image":
        im_args = " ".join(getattr(args, "image_args", []) or []).strip()
        shell.do_image(im_args)
        return 0

    if args.command == "kernel":
        k_args = " ".join(getattr(args, "kernel_args", []) or []).strip()
        shell.do_kernel(k_args or "status")
        return 0

    if args.command == "support":
        shell.do_support("")
        return 0

    if args.command == "svl364":
        s_args = " ".join(getattr(args, "svl364_args", []) or []).strip()
        shell.do_svl364(s_args or "status")
        return 0

    if args.command == "fleet":
        f_args = " ".join(getattr(args, "fleet_args", []) or []).strip()
        shell.do_fleet(f_args or "status")
        return 0

    if args.command == "outposts":
        shell.do_outposts("")
        return 0

    if args.command == "contract":
        shell.do_contract("")
        return 0

    if args.command == "truth":
        shell.do_truth("")
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


