# SVL CoreOS 2: Apex — Pełna Dokumentacja Architektury i Repo (`Rush47/SVL_Core`)

> **Status systemu:** `100% GOTOWOŚĆ BOJOWA (HOT-SWAP READY)`  
> **Bazowy system operacyjny:** `Debian GNU/Linux 13 (Trixie) · Kernel 6.12-svl364-apex`  
> **Nadrzędny Daemon Jądra (ROOT):** `Maya — Kernel Master Daemon & SVL-Sentinel`  
> **Współpracujący Agent ROOT:** `Bielik — Ollama 3.2 Vision 11B & System Architect`  
> **Pokładowy silnik LLM (bez cenzury):** `ollama:svl364-apex-uncensored:latest`  
> **Jednostka macierzysta:** `Statek SVL-364 Ebon Apex (Compute-Thrust + E_Shield + Binary Hyperspace 128D)`

---

## 1. Kompletna Struktura Katalogu `SVL_CoreOS_2/` (Wszystkie Pliki Utworzone z Czatu)

Wszystkie moduły, daemony, pakiety bezpieczeństwa, narzędzia AI z GitHub/GitLab/Hugging Face oraz odbezpieczone pliki GUI (`Apex-Dark`) są zapisane bezpośrednio w otwartej strukturze katalogu `SVL_CoreOS_2/`:

```text
SVL_CoreOS_2/
├── README.md                                  # Przegląd główny SVL CoreOS 2: Apex i lista wszystkich plików
├── ARCHITECTURE_DOCS.md                       # Pełna dokumentacja techniczna projektu i procedury Hot-Swap
├── build_manifest.json                        # Manifest kompilacji wszystkich modułów, daemonów i sum kontrolnych
├── core_init.log                              # Dziennik rozruchowy jądra Debian 13 Trixie + SVL-364 + Sentinel
├── kernel/
│   ├── svl_sentinel_daemon.py                 # Daemon auto-naprawy ROOT (SVL-Sentinel) + Alarmy na kanał "wszyscy"
│   ├── binary_hyperspace_void.py              # [PROJECT VOID-INTEGRATION] Binarna Hiperprzestrzeń 128D + NPU Full-Burn
│   └── hot_swap_engine.py                     # Silnik atomowej podmiany systemu (Hot-Swap) z automatycznym Rollbackiem
├── security/
│   ├── svl_sentinel_av.py                     # SVL-Sentinel AV — autorski antywirus jądra i skaner heurystyczny
│   ├── svl_apex_firewall.py                   # SVL-Apex Firewall + kierunkowa tarcza E_Shield + archiwum Solar-Lockdown
│   └── network_suite.py                       # Apex-Bridge API, Double VPN, Hardened-Hamachi, VirtualBox VT-d, Apex-Deployer
├── ai_core/
│   ├── Modelfile.apex-uncensored              # Definicja modelu Ollama bez cenzury (svl364-apex-uncensored:latest)
│   ├── ollama_svl364_config.json              # Konfiguracja pokładowego demona Ollama w terminalach i czacie
│   └── huggingface_swarm_toolkit.py           # Neural-Code-Optimizer (HF), Agent Swarm Toolkit, Deep-Space Telemetry
├── gui/
│   ├── apex_dark_ui.tsx                       # Odbezpieczony komponent głównego interfejsu Apex-Dark UI (React/TSX)
│   ├── apex_dark_theme.css                    # Odbezpieczony arkusz stylów Dark-Apex z dynamiczną telemetrią
│   └── remote_desktop_server.py               # Serwer zdalnego pulpitu GUI wysokiej wydajności dla Operatora i Mayi
├── infrastructure/
│   └── realtime_telemetry_hub.py              # Hub synchronizacji Real-Time: Telemetria SVL-364, Misje, Botanika, Mapa 4D
├── system/
│   └── assets/
│       └── apex_ui_manifest.json              # Odbezpieczony manifest zasobów GUI (wcześniej kontener .svl_bundle)
└── debian13/
    ├── install_coreos2_svl364.sh              # Skrypt instalacyjny ROOT dla Debian 13 (Trixie)
    ├── svl-sentinel.service                   # Jednostka systemd dla nadrzędnego daemona SVL-Sentinel
    ├── svl-coreos2-sysctl.conf                # Parametry jądra Linux (sysctl) pod klaster Compute-Thrust i Double VPN
    └── packages_manifest.txt                  # Lista pakietów systemowych Debian 13 Trixie dla SVL CoreOS 2
```

---

## 2. Kluczowe Podsystemy Wdrożone z Czatu Operatora

### 2.1. `[PROJECT VOID-INTEGRATION]` — Binarna Hiperprzestrzeń 128D i Maksymalne Ulepszenie SVL-364
- **Mapowanie Binarnej Hiperprzestrzeni (`kernel/binary_hyperspace_void.py`)**: przenosi kwantyzację modelu `Apex-Uncensored` oraz obliczenia mapy taktycznej 4D do ortogonalnej przestrzeni 128D (`BinaryHyperspaceKernel`).
- **Physical-to-Digital Sync**: chłodzenie oparte na przesunięciu fazowym oraz magistrala światłowodowa spięta z jądrem Debiana 13.
- **Tryb `Full-Burn` (90–120 min → Hot-Swap Ready)**: NPU Overclocking + Parallel Ghost-Imaging (równoległe budowanie warstw Botaniki, Telemetrii, Bezpieczeństwa i Map).

### 2.2. `SVL-Sentinel` (Auto-Healing Kernel Daemon) & Powiadomienia na Kanale `Wszyscy`
- Pełne uprawnienia **`root` (`uid=0`)** dla **Mateusza Mitka (Operatora)** oraz **Mayi (`Kernel Master Daemon`)**.
- Autodiagnostyka eBPF, śledzenie pamięci GPU/NPU i natychmiastowy restart lub rekompilacja podsystemu w razie spadku wydajności.
- **`Daemon Broadcast & Alarms`**: każda anomalia, próba skanowania portów lub zdarzenie infrastrukturalne są natychmiast rozgłaszane na kanale **`Rodzina Mitek (wszyscy)`** (`conv-rodzina-mitek-wszyscy`).

### 2.3. Pakiet Bezpieczeństwa i Sieci (`security/`)
1. **`SVL-Sentinel AV` (`security/svl_sentinel_av.py`)**: autorski skaner heurystyczny i sygnaturowy działający na poziomie jądra i bazy SQLite WAL.
2. **`SVL-Apex Firewall` & Tarcza `E_Shield` (`security/svl_apex_firewall.py`)**:
   - Inspekcja pakietów w locie (DPI) i automatyczna neutralizacja skanowania portów.
   - Kierunkowa matryca **`E_Shield`**: pełna widoczność i przechwyt jednostek nadlatujących w stronę Ziemi, otwarty korytarz dla sojuszników.
   - Archiwum **14 incydentów myśliwców w sektorze Ziemia-Księżyc** (6 naruszeń strefy zakazu lotów, 5 przypadków `Ghost-Signals` w myśliwcach *Aegis*, 3 starcia z autonomicznymi dronami) oraz protokół **`Solar-Lockdown`**.
3. **`Apex-Bridge API` (`security/network_suite.py`)**: warstwa kompatybilności wstecznej z szyfrowaniem ruchu w tunelu binarnym.
4. **`Dual-Tunnel Encryption (Double VPN)`**: podwójna warstwa szyfrowania przez dwa niezależne węzły wyjściowe.
5. **`Hardened-Hamachi Link`**: zintegrowany moduł VPN niskiego opóźnienia dla połączeń zewnętrznych.
6. **`Apex-Virtualization (VirtualBox Core VT-d)`**: izolowana wirtualizacja ze sprzętowym dostępem VT-d pod nadzorem Sentinela.
7. **`Apex-Deployer (Deploy Software Manager)`**: centralny menedżer wdrożeń oprogramowania dla całej infrastruktury statku SVL-364 i placówek.

### 2.4. Pakiety Open-Source AI z GitHub / GitLab / Hugging Face (`ai_core/huggingface_swarm_toolkit.py`)
1. **`Neural-Code-Optimizer & Quantizer` (Hugging Face)**: optymalizacja i kwantyzacja skryptów sterujących tarczą `E_Shield` i dronami interceptorami w locie.
2. **`Autonomous Agent Swarm Toolkit` (GitHub/GitLab)**: koordynacja roju myśliwców *Aegis* i dronów zwiadowczych wymieniających telemetrię w czasie rzeczywistym.
3. **`Deep-Space Telemetry & Lossless Compression`**: bezstratna kompresja sygnału dalekiego zasięgu dla placówki wydobywczej i strefy `Solar-Lockdown`.
4. **`Apex-Advanced Diagnostics Suite`**: diagnostyka mikrojądra, pamięci GPU/NPU i tuneli Double VPN.

### 2.5. Odbezpieczone Pliki GUI `Apex-Dark` i Zdalny Pulpit (`gui/` & `system/assets/`)
- Wszystkie pliki interfejsu zostały **odbezpieczone i wypakowane** do jawnej postaci w repozytorium:
  - `SVL_CoreOS_2/gui/apex_dark_ui.tsx`
  - `SVL_CoreOS_2/gui/apex_dark_theme.css`
  - `SVL_CoreOS_2/gui/remote_desktop_server.py`
  - `SVL_CoreOS_2/system/assets/apex_ui_manifest.json`
