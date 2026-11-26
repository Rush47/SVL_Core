#!/usr/bin/env python3
"""
Automatyczny konfigurator i instalator środowiska dla JYN_OS v3.0 i hosta SVL-364.
Przygotowuje klucze SSH, tokeny bezpieczeństwa, zoptymalizowany silnik Ollama (:11434),
kanoniczny model svl364-apex-uncensored:latest oraz pokładowy serwer SVL-364 (:11435).
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from JYN_OS.config import JynOSConfig, select_canonical_base_for_host
from JYN_OS.shell import JynOSShell


def is_port_open(host: str, port: int, timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except (OSError, socket.error):
        return False


def setup_ssh_environment() -> None:
    """Tworzy klucz Ed25519 dla statku SVL-364 oraz konfigurację OpenSSH."""
    ssh_dir = Path.home() / ".ssh"
    ssh_dir.mkdir(mode=0o700, parents=True, exist_ok=True)

    key_path = ssh_dir / "svl364_ed25519"
    pub_key_path = ssh_dir / "svl364_ed25519.pub"

    if not key_path.is_file():
        keygen = shutil.which("ssh-keygen")
        if keygen:
            print("🔑 Generowanie klucza kryptograficznego Ed25519 dla SVL-364...")
            subprocess.run(
                [keygen, "-t", "ed25519", "-N", "", "-f", str(key_path), "-C", "jyn_os_svl364_root"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
            if not key_path.is_file():
                raise RuntimeError("Nie udało się wygenerować klucza SSH.")
            key_path.chmod(0o600)
            if pub_key_path.is_file():
                pub_key_path.chmod(0o644)

    auth_keys = ssh_dir / "authorized_keys"
    if pub_key_path.is_file():
        pub_content = pub_key_path.read_text(encoding="utf-8").strip()
        current_auth = auth_keys.read_text(encoding="utf-8") if auth_keys.is_file() else ""
        if pub_content and pub_content not in current_auth:
            with open(auth_keys, "a", encoding="utf-8") as f:
                f.write(f"\n{pub_content}\n")
            auth_keys.chmod(0o600)

    config_file = ssh_dir / "config"
    config_d = ssh_dir / "config.d"
    config_d.mkdir(mode=0o700, parents=True, exist_ok=True)
    ship_conf = config_d / "svl-364.conf"

    ship_entry = (
        "# BEGIN SVL-364 (Ship)\n"
        "Host Ship SVL-364\n"
        "    HostName 127.0.0.1\n"
        "    Port 22\n"
        f"    User {os.environ.get('USER', 'root')}\n"
        f"    IdentityFile {key_path}\n"
        "    IdentitiesOnly yes\n"
        "    BatchMode yes\n"
        "    ConnectTimeout 10\n"
        "    ServerAliveInterval 15\n"
        "    ServerAliveCountMax 3\n"
        "    StrictHostKeyChecking accept-new\n"
        "# END SVL-364 (Ship)\n"
    )

    if not ship_conf.is_file():
        ship_conf.write_text(ship_entry, encoding="utf-8")
        ship_conf.chmod(0o600)

    existing_config = config_file.read_text(encoding="utf-8") if config_file.is_file() else ""
    if "Include config.d/*.conf" not in existing_config and "Host Ship" not in existing_config:
        with open(config_file, "a", encoding="utf-8") as f:
            f.write("Include config.d/*.conf\n\n" + ship_entry)
        config_file.chmod(0o600)


def setup_security_tokens() -> None:
    """Tworzy katalog data/ i niezbędne tokeny kryptograficzne jeśli ich brakuje."""
    data_dir = PROJECT_ROOT / "data"
    data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)

    operator_token_file = data_dir / "svl_operator_token.secret"
    if not operator_token_file.is_file():
        operator_token_file.write_text(os.urandom(32).hex(), encoding="utf-8")
        operator_token_file.chmod(0o600)

    mcp_token_file = data_dir / "svl_mcp_token.secret"
    if not mcp_token_file.is_file():
        mcp_token_file.write_text(os.urandom(24).hex(), encoding="utf-8")
        mcp_token_file.chmod(0o600)


def ensure_local_ollama_ready(shell: JynOSShell) -> None:
    """Uruchamia zoptymalizowaną usługę Ollama (:11434), buduje svl364-apex-uncensored:latest i rozgrzewa RAM."""
    ollama_bin = shutil.which("ollama") or "/usr/local/bin/ollama"
    if not os.path.isfile(ollama_bin):
        print("⚡ [JYN_OS] Instalowanie lokalnego silnika Ollama...")
        shell.ollama.install_local_ollama(ensure_models=False)
        ollama_bin = shutil.which("ollama") or "/usr/local/bin/ollama"

    if not os.path.isfile(ollama_bin):
        return

    if not is_port_open("127.0.0.1", 11434):
        print("⚡ [JYN_OS] Uruchamianie zoptymalizowanej usługi Ollama (port 11434, FlashAttention + KV q8_0 + Parallel=1)...")
        daemon_env = dict(os.environ)
        daemon_env.setdefault("OLLAMA_HOST", "127.0.0.1:11434")
        daemon_env.setdefault("OLLAMA_KEEP_ALIVE", "-1")
        daemon_env.setdefault("OLLAMA_FLASH_ATTENTION", "1")
        daemon_env.setdefault("OLLAMA_KV_CACHE_TYPE", "q8_0")
        daemon_env.setdefault("OLLAMA_NUM_PARALLEL", "1")
        daemon_env.setdefault("OLLAMA_MAX_LOADED_MODELS", "1")
        subprocess.Popen(
            [ollama_bin, "serve"],
            env=daemon_env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        for _ in range(30):
            time.sleep(0.2)
            if is_port_open("127.0.0.1", 11434):
                break

    status = shell.ollama.check_node_status(shell.config.local_ollama_url)
    if status["online"]:
        models = status["installed_models"]
        if not models:
            base_model = select_canonical_base_for_host()
            print(f"⏳ [JYN_OS] Pobieranie kanonicznego modelu bazowego {base_model}...")
            shell.ollama.pull_model(base_model, url=shell.config.local_ollama_url)
            status = shell.ollama.check_node_status(shell.config.local_ollama_url)
            models = status["installed_models"]

        if models and not status["apex_present"]:
            print("🛠️  [JYN_OS] Budowanie profilu svl364-apex-uncensored:latest (język polski, stream=False)...")
            shell.ollama.create_apex_model(url=shell.config.local_ollama_url)

        print("🔥 [JYN_OS] Rozgrzewanie modelu w pamięci RAM (keep_alive=-1)...")
        shell.ollama.warm_up(url=shell.config.local_ollama_url)


def ensure_ship_ollama_running() -> None:
    """Uruchamia węzeł Ollama statku SVL-364 (:11435, 13 modeli) jeśli port jest wolny."""
    if not is_port_open("127.0.0.1", 11435):
        print("⚡ [JYN_OS] Uruchamianie węzła Ollama SVL-364 w tle (port 11435, 13 modeli, stream=False)...")
        script_path = PROJECT_ROOT / "JYN_OS" / "svl364_standalone_ollama.py"
        subprocess.Popen(
            [sys.executable, str(script_path), "11435"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        for _ in range(20):
            time.sleep(0.15)
            if is_port_open("127.0.0.1", 11435):
                break


def main() -> int:
    print("\n" + "=" * 76)
    print(" 🛠️  [JYN_OS v3.1 BOOTSTRAP] Konfiguracja systemu, SVL-364 i Google Hub ($1000 USD)...")
    print("=" * 76 + "\n")

    cfg = JynOSConfig.load_from_env()
    shell = JynOSShell(cfg)

    setup_ssh_environment()
    setup_security_tokens()
    shell.google_hub.provision_and_topup_1000_usd()
    ensure_local_ollama_ready(shell)
    ensure_ship_ollama_running()

    shell.do_status("")

    status = shell.ollama.check_node_status(cfg.get_active_ollama_url())
    if not status["online"] or status["error"]:
        print(f"\n❌ Ollama niegotowa: {status['error']}")
        return 1
    if not status["installed_models"]:
        print("\n❌ Brak zainstalowanych modeli na aktywnym węźle Ollama.")
        return 1

    print("\n✅ Węzły Ollama (:11434 oraz SVL-364 :11435), 13 modeli i Google Hub ($1000 USD) są gotowe.")
    print("👉 Usługi Google Hub:     ./jyn_os google status")
    print("👉 Rozmowa po polsku:     ./jyn_os chat \"Cześć Jyn, zamelduj status\"")
    print("👉 Konsola interaktywna:  ./jyn_os\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
