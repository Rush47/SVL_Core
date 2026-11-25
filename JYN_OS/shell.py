"""Interaktywna powłoka systemowa JYN_OS v3.0 dla statku SVL-364 z nowym modułem czatu bez strumieniowania."""

from __future__ import annotations

import cmd
import json
import os
import urllib.request
from typing import Dict, List, Optional

from .chat_engine import JynChatEngine
from .config import JynOSConfig, resolve_auth_token
from .mcp_client import SvlMcpClient
from .ollama_client import SvlOllamaClient
from .ssh_client import Svl364SshClient
from .telemetry import SvlShipTelemetry


# Kolory terminalowe ANSI
CYAN = "\033[96m"
GREEN = "\033[92m"
YELLOW = "\033[93m"
RED = "\033[91m"
MAGENTA = "\033[95m"
BOLD = "\033[1m"
DIM = "\033[2m"
RESET = "\033[0m"


class JynOSShell(cmd.Cmd):
    """Główna powłoka interaktywna klienta JYN_OS dedykowana Operatorowi Mateuszowi Mitkowi."""

    intro = f"""
{CYAN}{BOLD}================================================================================{RESET}
{MAGENTA}{BOLD}   ✦ JYN_OS v3.0 · KLIENT SYSTEMOWY I MOSTEK STATKU SVL-364 EBON APEX ✦{RESET}
{CYAN}   Rdzeń AI: Jyn Mitek (System_SI_1) · Operator: Mateusz Mitek · Czat PL (stream=OFF){RESET}
{DIM}   Wpisz '{BOLD}help{RESET}{DIM}' dla listy komend, '{BOLD}status{RESET}{DIM}' dla audytu lub pisz bezpośrednio do Jyn.{RESET}
{CYAN}{BOLD}================================================================================{RESET}
"""
    prompt = f"{CYAN}{BOLD}JYN_OS [SVL-364]{RESET}{BOLD}❯{RESET} "

    def __init__(self, config: Optional[JynOSConfig] = None):
        super().__init__()
        self.config = config or JynOSConfig.load_from_env()
        self.ssh = Svl364SshClient(self.config)
        self.mcp = SvlMcpClient(self.config)
        self.ollama = SvlOllamaClient(self.config)
        self.telemetry = SvlShipTelemetry(self.config, self.ssh)
        self.chat_engine = JynChatEngine(config=self.config, ollama=self.ollama)

    @property
    def chat_history(self) -> List[Dict[str, str]]:
        return self.chat_engine.history

    @chat_history.setter
    def chat_history(self, value: List[Dict[str, str]]) -> None:
        self.chat_engine.history = list(value)

    def do_status(self, arg: str) -> None:
        """status — Wyświetla pełny audyt połączeń ze statkiem SVL-364 (SSH, MCP, Ollama :11434/:11435)."""
        print(f"\n{BOLD}🔍 [AUDYT INFRASTRUKTURY SVL-364 / JYN_OS]{RESET}\n")

        # 1. SSH
        key_info = self.ssh.get_key_status()
        profile_info = self.ssh.check_ssh_config_profile()
        print(f"{CYAN}{BOLD}1. Mostek OpenSSH (Statek SVL-364):{RESET}")
        print(f"   • Profil docelowy : {BOLD}{self.config.ssh_profile}{RESET} (port: {self.config.ssh_port})")
        print(f"   • Klucz Ed25519   : {key_info['key_path']} [{'Zainstalowany' if key_info['private_key_exists'] else 'Brak pliku'}]")
        print(f"   • Konfiguracja SSH: {profile_info['config_file']} [{'Skonfigurowany' if profile_info['configured'] else 'Nieskonfigurowany'}]")

        probe = self.ssh.execute_command("uname -r", timeout=2.5)
        if probe.success:
            print(f"   • Połączenie SSH  : {GREEN}ONLINE{RESET} (Kernel: {probe.stdout.strip()})")
        else:
            print(f"   • Połączenie SSH  : {YELLOW}Czeka na zestawienie / nieosiągalny{RESET} ({probe.stderr.strip() or 'brak odpowiedzi'})")

        # 2. Federacja MCP
        print(f"\n{CYAN}{BOLD}2. Federacja Serwerów MCP (Model Context Protocol):{RESET}")
        mcp_probes = self.mcp.probe_all_endpoints()
        for name, info in mcp_probes.items():
            st_color = GREEN if info["online"] else RED
            print(f"   • {name:38}: {st_color}{info['status']}{RESET} ({info['url']})")

        # 3. Silnik Ollama
        print(f"\n{CYAN}{BOLD}3. Jednostka Obliczeniowa AI Ollama (Strumieniowanie: WYŁĄCZONE):{RESET}")
        ship_ollama = self.ollama.check_node_status(self.config.ship_ollama_url)
        st_color = GREEN if ship_ollama["online"] else RED
        status_txt = f"ONLINE (v{ship_ollama['version']})" if ship_ollama["online"] else "OFFLINE"
        print(f"   • Pokładowa Ollama SVL-364 (:11435): {st_color}{status_txt}{RESET}")
        print(f"     └─ Model domyślny                : {BOLD}{self.config.ship_model}{RESET} [{'OBECNY' if ship_ollama['apex_present'] else 'Brak'}]")
        if ship_ollama["installed_models"]:
            print(f"     └─ Modele pokładowe ({len(ship_ollama['installed_models']):2d})         : {', '.join(ship_ollama['installed_models'][:6])}...")

        local_ollama = self.ollama.check_node_status(self.config.local_ollama_url)
        loc_color = GREEN if local_ollama["online"] else YELLOW
        loc_txt = f"ONLINE (v{local_ollama['version']})" if local_ollama["online"] else "OFFLINE"
        print(f"   • Lokalna Ollama (:11434)          : {loc_color}{loc_txt}{RESET}")
        if local_ollama["installed_models"]:
            print(f"     └─ Zainstalowane wagi            : {', '.join(local_ollama['installed_models'])}")
            print(f"     └─ Model Vision ({self.config.vision_model}): {'✅ ZAINSTALOWANY' if local_ollama['vision_present'] else 'Dostępny na żądanie'}")
        print()

    def do_ssh(self, arg: str) -> None:
        """ssh [polecenie] — Wykonuje polecenie na statku SVL-364 lub otwiera interaktywną powłokę."""
        cmd_text = arg.strip()
        if not cmd_text:
            print(f"{YELLOW}Uruchamianie bezpośredniej sesji terminalowej SSH ze statkiem...{RESET}")
            self.ssh.launch_interactive_shell()
            return

        print(f"{DIM}Wykonywanie na statku [{self.config.ssh_profile}]: {cmd_text}{RESET}")
        res = self.ssh.execute_command(cmd_text)
        if res.success:
            print(res.stdout, end="" if res.stdout.endswith("\n") else "\n")
        else:
            print(f"{RED}❌ Błąd wykonania (kod {res.exit_code}):{RESET}\n{res.stderr}")

    def do_exec(self, arg: str) -> None:
        """exec <polecenie> — Bezpośrednie wykonanie polecenia na statku SVL-364 przez SSH."""
        cmd_text = arg.strip()
        if not cmd_text:
            print(f"{YELLOW}Użycie: exec <komenda linux>{RESET}")
            return
        self.do_ssh(cmd_text)

    def do_telemetry(self, arg: str) -> None:
        """telemetry — Pobiera i wyświetla aktualną telemetrię techniczną statku SVL-364."""
        print(f"\n{CYAN}{BOLD}🛰️  [TELEMETRIA POKŁADOWA STATKU SVL-364 EBON APEX]{RESET}\n")
        live = self.telemetry.fetch_live_ssh_telemetry()
        if live["available"]:
            print(f"• Host     : {GREEN}{live['host']}{RESET}")
            print(f"• Kernel   : {live['uname']}")
            print(f"• Uptime   : {live['uptime']}")
            print(f"• Obciążenie: {live['load']}")
            print(f"\n{BOLD}Pamięć RAM:{RESET}\n{live['memory']}\n")
            print(f"{BOLD}Dysk główny (/):{RESET}\n{live['disk']}\n")
            print(f"{BOLD}Interfejsy sieciowe:{RESET}\n{live['network']}\n")
        else:
            print(f"{YELLOW}⚠️  Brak bezpośredniego odczytu z węzła SSH:{RESET} {live['error']}")
            print("Sprawdzam buforowaną telemetrię z bramy API...")
            api = self.telemetry.fetch_api_telemetry()
            if api["available"]:
                print(f"{GREEN}Pobrano dane telemetryczne z: {api['source']}{RESET}")
                print(api["data"])
            else:
                print(f"{RED}Brak dostępnych danych telemetrycznych.{RESET}")
        print()

    def do_ollama(self, arg: str) -> None:
        """ollama [status|target|model|vision|pull|install|fix|warmup|chat|list|catalog|clear] — Zarządzanie Ollamą."""
        parts = arg.strip().split(maxsplit=1)
        subcmd = parts[0].lower() if parts else "status"
        extra = parts[1] if len(parts) > 1 else ""

        if subcmd == "status":
            target = extra.strip().lower() if extra else ""
            print(f"\n{CYAN}{BOLD}--- Stan węzłów obliczeniowych Ollama (Strumieniowanie: WYŁĄCZONE) ---{RESET}")
            print(f"Aktywny cel JYN_OS: {BOLD}{self.config.active_ollama_target.upper()}{RESET} (domyślny model: {BOLD}{self.config.get_active_model()}{RESET})\n")

            if target in ("", "local", "11434"):
                loc_st = self.ollama.check_node_status(self.config.local_ollama_url)
                print(f"🖥️  {BOLD}Lokalny węzeł Ollama (:11434):{RESET}")
                print(f"   └─ Status        : {GREEN if loc_st['online'] else RED}{'ONLINE' if loc_st['online'] else 'OFFLINE'}{RESET}")
                if loc_st["online"]:
                    print(f"   └─ Wersja        : v{loc_st['version']}")
                    print(f"   └─ Modele        : {', '.join(loc_st['installed_models']) or 'brak zainstalowanych modeli'}")
                    print(f"   └─ Model Apex    : {'✅ Dostępny' if loc_st['apex_present'] else 'Brak (uruchom: ollama fix)'}")
                else:
                    print(f"   └─ Diagnostyka   : {loc_st['error']} (uruchom: ollama fix)")
                print()

            if target in ("", "ship", "11435"):
                ship_st = self.ollama.check_node_status(self.config.ship_ollama_url)
                print(f"🛰️  {BOLD}Węzeł pokładowy SVL-364 (:11435):{RESET}")
                print(f"   └─ Status        : {GREEN if ship_st['online'] else RED}{'ONLINE' if ship_st['online'] else 'OFFLINE'}{RESET}")
                if ship_st["online"]:
                    print(f"   └─ Wersja        : v{ship_st['version']}")
                    print(f"   └─ Modele        : {', '.join(ship_st['installed_models'][:6])} (łącznie: {len(ship_st['installed_models'])})")
                    print(f"   └─ Model Apex    : {'✅ Dostępny' if ship_st['apex_present'] else 'Brak'}")
                else:
                    print(f"   └─ Diagnostyka   : {ship_st['error']}")
                print()

        elif subcmd in ("target", "switch"):
            tgt = extra.strip().lower()
            if tgt in ("local", "11434"):
                self.config.set_active_target("local")
                print(f"\n{GREEN}✔ Przełączono aktywny węzeł Ollama na: LOKALNY (:11434){RESET}")
                print(f"Aktywny model: {self.config.get_active_model()}\n")
            elif tgt in ("ship", "11435", "remote", "svl364"):
                self.config.set_active_target("ship")
                print(f"\n{GREEN}✔ Przełączono aktywny węzeł Ollama na: POKŁADOWY SVL-364 (:11435){RESET}")
                print(f"Aktywny model: {self.config.get_active_model()}\n")
            else:
                print(f"{YELLOW}Podaj cel przełączenia: ollama target local  LUB  ollama target ship{RESET}")

        elif subcmd in ("model", "use"):
            chosen = extra.strip()
            if not chosen:
                print(f"Bieżący aktywny model: {BOLD}{self.config.get_active_model()}{RESET}")
                print("Użycie: ollama model <nazwa_modelu> (np. ollama model qwen2.5:7b)")
                return
            if self.config.active_ollama_target == "local":
                self.config.local_model = chosen
            else:
                self.config.ship_model = chosen
            print(f"\n{GREEN}✔ Ustawiono aktywny model na: {BOLD}{chosen}{RESET}\n")

        elif subcmd in ("install", "fix", "repair"):
            print(f"\n{CYAN}⚡ Naprawa i optymalizacja silnika Ollama oraz profilu Apex...{RESET}")
            res = self.ollama.install_local_ollama(ensure_models=True)
            if res.get("success"):
                print(f"{GREEN}✔ Lokalny silnik Ollama jest aktywny, rozgrzany i gotowy (:11434).{RESET}")
                print(f"Wersja: v{res.get('version')} | Plik binarny: {res.get('binary')}")
                print(f"Zainstalowane modele: {', '.join(res.get('models', [])) or 'brak'}\n")
            else:
                print(f"{RED}❌ Błąd podczas uruchamiania/naprawy Ollamy:{RESET} {res.get('error')}\n")

        elif subcmd in ("warmup", "rozgrzej"):
            print(f"\n{CYAN}🔥 Ładowanie modelu do pamięci RAM (keep_alive=-1)...{RESET}")
            res = self.ollama.warm_up()
            if res.get("success"):
                print(f"{GREEN}✔ Model {res.get('model')} zablokowany w RAM na węźle {res.get('endpoint')}.{RESET}\n")
            else:
                print(f"{RED}❌ Błąd rozgrzewania:{RESET} {res.get('error')}\n")

        elif subcmd == "pull":
            model_to_pull = extra.strip() or self.config.get_active_model()
            print(f"\n{CYAN}⏳ Pobieranie modelu '{model_to_pull}' do lokalnego węzła Ollama (:11434)...{RESET}")
            res = self.ollama.pull_model(model_to_pull, url=self.config.local_ollama_url)
            if res.get("success"):
                print(f"{GREEN}✔ Model {model_to_pull} został pomyślnie zainstalowany!{RESET}\n")
            else:
                print(f"{RED}❌ Błąd pobierania:{RESET} {res.get('error')}\n")

        elif subcmd in ("vision", "image"):
            vparts = extra.strip().split(maxsplit=1)
            if not vparts:
                print(f"{YELLOW}Użycie: ollama vision <ścieżka_do_obrazka> [pytanie]{RESET}")
                return
            img_path = vparts[0]
            vprompt = vparts[1] if len(vparts) > 1 else "Przeanalizuj ten obraz ze statku i opisz szczegółowo co na nim widać."
            print(f"\n{CYAN}👁️ [Analiza multimodalna modelem: {self.config.vision_model}...]{RESET}\n")
            res = self.ollama.chat_vision(prompt=vprompt, image_path=img_path)
            if res.get("success"):
                print(f"{GREEN}{BOLD}✦ Raport Wizyjny [{res['model']}]:{RESET}\n{res['response']}\n")
            else:
                print(f"{RED}❌ Błąd analizy wizyjnej:{RESET} {res.get('error')}\n")

        elif subcmd in ("catalog", "models"):
            print(f"\n{CYAN}{BOLD}Katalog 13 kanonicznych modeli pokładowych statku SVL-364:{RESET}\n")
            catalog = self.ollama.get_ship_models_catalog()
            for i, m in enumerate(catalog, 1):
                flag = f"{GREEN}★ GŁÓWNY{RESET}" if m.get("primary") else ("👁️ VISION" if "vision" in m["name"] else "  ")
                print(f"{i:2}. {BOLD}{m['name']:32}{RESET} [{m['parameter_size']:4}] {flag}")
                print(f"    Rola: {m['role']}")
            print()

        elif subcmd in ("chat", "ask"):
            prompt = extra.strip()
            if not prompt:
                print(f"{YELLOW}Podaj treść zapytania, np.: ollama chat 'Melduj gotowość systemów'{RESET}")
                return
            self._run_complete_chat(prompt)

        elif subcmd in ("clear", "reset-chat"):
            self.chat_engine.clear_history()
            print(f"\n{GREEN}✔ Wyczyszczono historię rozmowy sesji JYN_OS.{RESET}\n")

        elif subcmd == "list":
            target = extra.strip().lower() or self.config.active_ollama_target
            if target not in ("local", "11434", "ship", "11435", "remote", "svl364"):
                print(f"{YELLOW}Użycie: ollama list [local|ship]{RESET}")
                return
            local = target in ("local", "11434")
            url = self.config.local_ollama_url if local else self.config.ship_ollama_url
            label = "Lokalny (:11434)" if local else "Pokładowy SVL-364 (:11435)"
            st = self.ollama.check_node_status(url)
            if st["online"] and not st["error"]:
                print(f"\nZainstalowane modele na węźle {label} ({len(st['installed_models'])}):")
                for m in st["installed_models"]:
                    print(f" • {m}")
                print()
            else:
                print(f"{RED}Węzeł Ollama {label} nie odpowiada: {st['error']}{RESET}")

        else:
            print(f"{YELLOW}Dostępne polecenia: status, target [local|ship], model [nazwa], fix, warmup, vision <obraz> [tekst], install, pull [model], list, catalog, chat <tekst>, clear{RESET}")

    def do_mcp(self, arg: str) -> None:
        """mcp [ping|list|call <nazwa_narzędzia>] — Diagnostyka i sterowanie federacją serwerów MCP."""
        parts = arg.strip().split(maxsplit=1)
        subcmd = parts[0].lower() if parts else "ping"
        extra = parts[1] if len(parts) > 1 else ""

        if subcmd == "ping":
            print(f"\n{CYAN}{BOLD}Odpytywanie węzłów MCP:{RESET}")
            probes = self.mcp.probe_all_endpoints()
            for name, info in probes.items():
                col = GREEN if info["online"] else RED
                print(f" • {name:36}: {col}{info['status']}{RESET}")
            print()

        elif subcmd == "list":
            print(f"\n{CYAN}{BOLD}Wykrywanie narzędzi MCP w federacji...{RESET}")
            tools = self.mcp.list_tools()
            if not tools:
                print(f"{YELLOW}Brak aktywnych narzędzi (serwery MCP mogą być offline lub wymagać autoryzacji).{RESET}\n")
                return
            print(f"Odnaleziono {len(tools)} narzędzi:\n")
            for t in tools:
                print(f" • {BOLD}{t.get('name')}{RESET} ({t.get('_endpoint')})")
                print(f"   Opis: {t.get('description', 'Brak opisu')}")
            print()

        elif subcmd == "call":
            tool_name = extra.strip()
            if not tool_name:
                print(f"{YELLOW}Użycie: mcp call <nazwa_narzędzia>{RESET}")
                return
            print(f"Wywoływanie narzędzia MCP: {tool_name} ...")
            res = self.mcp.call_tool(tool_name)
            if res.get("success"):
                print(f"{GREEN}Wynik wywołania:{RESET}\n{res.get('result')}")
            else:
                print(f"{RED}Błąd:{RESET} {res.get('error')}")

        else:
            print(f"{YELLOW}Dostępne opcje mcp: ping, list, call <narzędzie>{RESET}")

    def do_reset(self, arg: str) -> None:
        """reset — Przywraca ustawienia fabryczne (Factory Reset) systemu SVL CoreOS 2 i JYN_OS."""
        parts = arg.strip().lower()
        if parts not in ("yes", "y", "tak", "force", "--force", "-f"):
            confirm = input(f"{YELLOW}⚠️  Czy na pewno chcesz przywrócić ustawienia fabryczne systemu SVL CoreOS 2? [t/N]: {RESET}").strip().lower()
            if confirm not in ("t", "tak", "y", "yes"):
                print("Anulowano przywracanie ustawień fabrycznych.")
                return

        print(f"\n{CYAN}⚙️  [JYN_OS] Wykonywanie procedury Factory Reset...{RESET}")
        token = resolve_auth_token(self.config.gateway_url)
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "X-SVL-Operator-Token": token,
        }
        endpoints = [
            f"{self.config.gateway_url}/api/kernel/factory-reset",
            f"{self.config.backend_url}/api/py/kernel/factory-reset",
        ]
        success = False
        res_data = {}
        for url in endpoints:
            try:
                req = urllib.request.Request(url, data=json.dumps({"operatorToken": token}).encode(), headers=headers, method="POST")
                with urllib.request.urlopen(req, timeout=10.0) as r:
                    res_data = json.loads(r.read().decode())
                    if res_data.get("ok"):
                        success = True
                        break
            except Exception:
                continue

        if success:
            print(f"{GREEN}{BOLD}✅ Ustawienia fabryczne zostały pomyślnie przywrócone!{RESET}")
            print(f" • Status           : {res_data.get('status')}")
            print(f" • Nowa rewizja     : {res_data.get('serverRevision')}")
            print(f" • Zainicjalizowane : {res_data.get('modulesCount', 'komplet')} modułów systemowych")
            print("\nUruchamiam automatyczny audyt stanu po resecie:")
            self.do_status("")
        else:
            print(f"{RED}❌ Błąd podczas wykonywania Factory Reset przez API. Sprawdź działanie bramy i jądra.{RESET}")

    def do_factory_reset(self, arg: str) -> None:
        """factory-reset — Alias do polecenia reset."""
        self.do_reset(arg)

    def do_purge_buffer(self, arg: str) -> None:
        """purge_buffer [clean] — Oczyszcza zapchane bufory systemowe, outbox, historię terminali i pamięć podręczną."""
        print(f"\n{CYAN}🧹 [JYN_OS] Oczyszczanie i optymalizacja buforów systemowych...{RESET}")
        token = resolve_auth_token(self.config.gateway_url)
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "X-SVL-Operator-Token": token,
        }
        endpoints = [
            f"{self.config.gateway_url}/api/system/buffer/purge",
            f"{self.config.backend_url}/api/py/kernel/buffer-purge",
        ]
        success = False
        res_data = {}
        for url in endpoints:
            try:
                req = urllib.request.Request(url, data=json.dumps({"operatorToken": token}).encode(), headers=headers, method="POST")
                with urllib.request.urlopen(req, timeout=10.0) as r:
                    res_data = json.loads(r.read().decode())
                    if res_data.get("ok"):
                        success = True
                        break
            except Exception:
                continue

        if success:
            stats = res_data.get("stats", {})
            print(f"{GREEN}{BOLD}✅ Bufory systemowe zostały pomyślnie oczyszczone!{RESET}")
            print(f" • Terminale usunięte: {stats.get('terminal_history_cleared', 0)} wpisów")
            print(f" • Zdarzenia usunięte: {stats.get('system_events_cleared', 0)} zdarzeń")
            print(f" • Outbox odciążony   : {stats.get('sync_outbox_cleared', 0)} rekordów")
            print(f" • Rewizja jądra     : {res_data.get('serverRevision')}")
        else:
            print(f"{RED}❌ Nie udało się oczyścić buforów przez API.{RESET}")

    def do_clean(self, arg: str) -> None:
        """clean — Alias do polecenia purge_buffer."""
        self.do_purge_buffer(arg)

    def do_clear(self, arg: str) -> None:
        """clear — Czyści ekran terminala."""
        os.system("clear" if os.name == "posix" else "cls")

    def do_exit(self, arg: str) -> bool:
        """exit — Zamyka powłokę klienta JYN_OS."""
        print(f"{CYAN}Rozłączono sesję klienta JYN_OS. Do usłyszenia, Mateuszu.{RESET}")
        return True

    def do_quit(self, arg: str) -> bool:
        """quit — Zamyka powłokę klienta JYN_OS."""
        return self.do_exit(arg)

    def _run_complete_chat(self, prompt: str, model: Optional[str] = None) -> bool:
        cleaned = (prompt or "").strip()
        if not cleaned:
            return False
        active_url = self.config.get_active_ollama_url()
        active_mod = model or self.config.get_active_model()
        if not cleaned.startswith("/"):
            print(f"\n{CYAN}[Jyn Mitek · {active_mod} ({active_url}) · tryb bez strumieniowania]{RESET}", flush=True)
        try:
            turn = self.chat_engine.send(cleaned, model=model)
        except KeyboardInterrupt:
            print(f"\n{YELLOW}Przerwano oczekiwanie na odpowiedź.{RESET}")
            return False

        if not turn.ok:
            print(f"\n{RED}❌ Błąd czatu:{RESET} {turn.error}\n")
            return False

        timing = ""
        if not turn.local_command and turn.duration_sec > 0:
            tps_part = f", {turn.tokens_per_sec:.1f} tok/s" if turn.tokens_per_sec > 0 else ""
            timing = (f" {DIM}({turn.duration_sec:.2f}s{tps_part}; "
                      f"load {turn.load_sec:.2f}s; prompt {turn.prompt_eval_sec:.2f}s; "
                      f"gen {turn.eval_sec:.2f}s; narzut {turn.overhead_sec:.2f}s){RESET}")

        badge_model = turn.model or active_mod
        if turn.routed_model and turn.routed_model != badge_model:
            badge_model = f"{badge_model} → {turn.routed_model}"

        print(f"{GREEN}{BOLD}✦ Jyn [{badge_model}]:{RESET}{timing} {turn.reply}\n", flush=True)
        if turn.truncated:
            print(f"{YELLOW}[Osiągnięto limit długości odpowiedzi; wpisz „kontynuuj”, aby dokończyć wypowiedź.]{RESET}")
        return True

    def do_chat(self, arg: str) -> None:
        """chat <wiadomość> — Bezpośrednia rozmowa z Jyn Mitek po polsku (bez strumieniowania + pamięć sesji)."""
        if not arg.strip():
            print(f"{YELLOW}Użycie: chat <wiadomość do Jyn> (lub /status, /modele, /wyczysc){RESET}")
            return
        self._run_complete_chat(arg)

    def do_jyn(self, arg: str) -> None:
        """jyn <wiadomość> — Alias bezpośredniej rozmowy z Jyn Mitek."""
        self.do_chat(arg)

    def default(self, line: str) -> None:
        """Kieruje wypowiedzi w języku naturalnym oraz komendy /... bezpośrednio do modułu czatu Jyn Mitek."""
        cleaned = line.strip()
        if not cleaned:
            return
        self._run_complete_chat(cleaned)

    def do_EOF(self, arg: str) -> bool:
        """Zakończ sesję po Ctrl-D lub zamknięciu wejścia."""
        return self.do_exit(arg)

    def emptyline(self) -> bool:
        """Nie powtarzaj ostatniego polecenia po wciśnięciu Enter."""
        return False
