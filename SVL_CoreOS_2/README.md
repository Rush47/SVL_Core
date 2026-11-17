# SVL CoreOS 2: Apex

**SVL CoreOS 2: Apex** to aktualna wersja systemu SVL (repozytorium `Rush47/SVL_Core`): brama Node
(port 3000), jądro Python (port 8085, SQLite WAL), interfejs React oraz AI **Bielik** i **Maya**.
Na Debianie 13 (Trixie) instaluje się jako usługi systemd.

## Obraz ISO (bootowalny system)

Pełny system do zainstalowania na komputerze lub maszynie wirtualnej: Debian 13 (Trixie) z SVL CoreOS 2.
- Pobranie: GitHub → **Actions → „Build SVL CoreOS 2 ISO”** → ostatni przebieg → artefakt `svl-coreos2-apex-iso`
  (albo plik ISO w zakładce **Releases** po opublikowaniu wydania).
- Uruchom z pendrive'a (np. Balena Etcher / `dd`) albo w VirtualBox/QEMU; menu startowe oferuje system live
  i instalator Debiana na dysk.
- Po starcie: SVL działa na `http://<adres>:3000`, token: `sudo grep SVL_OPERATOR_TOKEN /etc/svl-coreos2/svl.env`
  (tworzony przy pierwszym uruchomieniu). Użytkownik live: `svl`.
- Budowa lokalna (Debian 13 / Docker): `docker run --rm --privileged -v "$PWD:/src" -w /src debian:trixie bash SVL_CoreOS_2/iso/build_iso.sh`

## Instalacja (Debian 13, jako root)

```bash
git clone https://github.com/Rush47/SVL_Core.git && cd SVL_Core
sudo bash SVL_CoreOS_2/debian13/install_coreos2_svl364.sh
# opcjonalnie: SVL_INSTALL_OLLAMA=1 (Ollama), SVL_RUN_DEBOOTSTRAP=1 (rootfs Debiana 13)
```

Instalator:
1. instaluje pakiety (Node, Python, git, gh, OpenSSH, nftables, debootstrap),
2. kopiuje system do `/opt/svl-coreos-2`, buduje interfejs i środowisko Python,
3. tworzy `/etc/svl-coreos2/svl.env` z nowym `SVL_OPERATOR_TOKEN` (uzupełnij `GITHUB_TOKEN`, `GEMINI_API_KEY`),
4. włącza usługi `svl-coreos2` (system) i `svl-sentinel` (nadzór),
5. sprawdza, czy system odpowiada, i wypisuje wynik każdego kroku (OK / BŁĄD / POMINIĘTO).

Log instalacji: `/var/log/svl-coreos2-install.log`. Stan usług: `systemctl status svl-coreos2 svl-sentinel`.

## SVL-Sentinel (`kernel/svl_sentinel_daemon.py`)

Co 30 s mierzy bramę, jądro Python, Ollamę, dysk i RAM. Gdy brama nie odpowiada 3 razy z rzędu —
restartuje `svl-coreos2`. Każdą zmianę stanu Maya ogłasza na kanale „Rodzina Mitek (wszyscy)”.
Ostatni pomiar: `/var/lib/svl-coreos2/sentinel_status.json` (widoczny w panelu Apex).
Jednorazowy pomiar: `python3 kernel/svl_sentinel_daemon.py --once`.

## Panel Apex

Pokazuje stan z prawdziwych pomiarów hosta: system i jądro, usługę `svl-coreos2`, Sentinel, demony
(WireGuard, Hamachi, VirtualBox, Apex-Bridge) i rootfs debootstrap. Tarcza E_Shield, reaktor
i Solar-Lockdown to ustawienia scenariusza statku SVL-364 — nie pomiar sprzętu.

## Pozostałe pliki

- `kernel/hot_swap_engine.py` — sumy SHA-256 plików (weryfikacja integralności przed instalacją).
- `debian13/` — instalator, usługa Sentinel, `sysctl`, lista pakietów, skrypty debootstrap.
- `ai_core/Modelfile.apex-uncensored` — profil modelu Ollama (`llama3.2-vision:11b` z instrukcją systemową).
- `security/`, `gui/`, `infrastructure/` — moduły pomocnicze w repozytorium (nie są uruchamiane jako usługi).
