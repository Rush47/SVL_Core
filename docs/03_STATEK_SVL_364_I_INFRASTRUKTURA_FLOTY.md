# 03. Statek Kosmiczny SVL-364 Ebon Apex i Infrastruktura Floty

## 1. Moduł `SVL-364` (`Svl364CommandCenter.tsx`)

- **Holograficzna Mapa Taktyczna CIC (styl Mass Effect)**:
  - Wizualizuje przekaźnik masy `SOL-RELAY-01`, stację `Cytadela SVL-01`, układ słoneczny (9 obiektów) oraz aktualny wektor i pozycję statku flagowego **SVL-364 Ebon Apex** (`Sektor Sol-Terra · Orbita L2 · Przekaźnik Kwantowy Sol-Relay-01`, współrzędne `[+142.88, -19.42, +88.04] AU`).
- **Telemetria Pokładowa (CPU / GPU / RAM)**:
  - Wyświetla na żywo obciążenie procesora (`CPU`), akceleratora `NVIDIA H100 Tensor Core (24 GB VRAM)`, alokację pamięci `RAM`, moc reaktora fuzyjnego `He-3` (`99.4%`) oraz integralność tarcz kinetycznych (`100%`).
- **Dane Sieciowe Połączenia ze Statkiem (`QKD-364`)**:
  - Szyfrowany tunel kwantowy `Quantum Entanglement Mesh v5.5 (AES-512-GCM + QKD-364)`, przepustowość `14.8 Gbps / 12.4 Gbps`, latencja `0.42 ms`, `0.000%` strat pakietów.

## 2. Moduł `Infrastruktura` (`InfrastructureWorkspace.tsx`)

- **Flota Statków Kosmicznych (5 jednostek)** — telemetria reaktora, tarcz, hull, CPU/GPU/RAM, lokalizacja, misja i ETA.
- **Placówki Planetarne i Stacje Orbitalne (5 baz)** — populacja, załoga AI, produkcja energii i status obrony.
- **Botanika & Bioreaktory Hydroponiczne (4 sekcje)** — produkcja tlenu (`+830 L O2/h`), wilgotność, spektrum LED, postęp wzrostu i ETA zbiorów.
- **Badania Naukowe & Projekty R&D (4 projekty)** — kierownik badań, postęp `%`, priorytet i ETA ukończenia.

## Zakładka SVL-364 — źródła danych (od wersji z prawdziwą telemetrią)

Zakładka pokazuje wyłącznie pomiary. Brak źródła = napis „brak danych”, nigdy wartość domyślna.

| Element | Źródło |
| :--- | :--- |
| CPU % | różnica dwóch odczytów `/proc/stat`; model i MHz z `/proc/cpuinfo`; load z `os.getloadavg()` |
| RAM, swap | `/proc/meminfo` |
| Dysk | `shutil.disk_usage("/")` |
| Sieć | `/proc/net/dev` (prędkość z różnicy odczytów) |
| GPU | `nvidia-smi` (gdy brak: „Brak GPU” z powodem) |
| Zapora | prawdziwe `ufw status` (stany: aktywna / nieaktywna / nieznany / nie zainstalowano) |
| Ollama, ComfyUI | zapytanie HTTP z pomiarem czasu; wbudowany zastępnik Ollamy jest oznaczany jako „nie prawdziwa Ollama” |
| Host SSH (`SVL_SSH_TARGET`) | `ssh -G` + pomiar połączenia TCP; zdalne CPU/RAM/dysk przez OpenSSH co 60 s |

Endpoint: `GET /api/py/svl364/telemetry?ship=1` (wymaga `SVL_OPERATOR_TOKEN`).

Usunięto fikcyjny stan statku (sektor, orbita, reaktor, tarcze, DEFCON), mapę galaktyki,
łącze „QKD-364”, narzędzia MCP `svl364_starship_helm`, `svl364_tactical_shields`,
`svl364_fleet_botany_control` oraz fałszywe programy `ssh`/`ufw`/`sudo`, które wcześniejsze wersje
instalowały w `/usr/local/bin` (`ssh` wykonywał polecenia lokalnie, `ufw` zawsze zgłaszał aktywną zaporę).
Backend przy starcie usuwa ich stare kopie — tylko pliki o dokładnie tej treści.

## Zakładka Infrastruktura — źródła danych

Fikcyjne dane (flota statków, placówki planetarne, botanika, badania z ETA) zostały usunięte.
Endpoint `GET /api/py/infrastructure` (wymaga `SVL_OPERATOR_TOKEN`, `backend/infrastructure_probe.py`):

| Sekcja | Źródło |
| :--- | :--- |
| Hosty z SSH | konkretne aliasy z `~/.ssh/config` użytkownika backendu + pomiar połączenia TCP |
| Hosty monitorowane | moduły z `config.category = "infrastructure"` i `config.address = "host:port"` (formularz w zakładce) |
| Usługi | `systemctl show` dla `svl-python-os`, `svl-comfyui`, `svl-codex-mcp`, `ollama`, `ssh` |
| Kontenery | `docker ps -a` |
| Porty | stan LISTEN z `/proc/net/tcp` i `/proc/net/tcp6` (nazwa usługi = typowa dla numeru portu) |
| Dyski | `/proc/mounts` + zajętość liczona jak w `df` |
| Zadania | tabela SQLite `agent_tasks` (status, czasy, błąd) |

Wpisy dodane wcześniej starym formularzem (z „lokalizacją” i „ETA”) są pokazywane jako hosty bez adresu — nie są mierzone.

### Automatyczne wykrywanie hostów (`backend/host_discovery.py`)

Hosty pojawiają się same w sekcji „Wykryte automatycznie”. Aplikacja **nie skanuje sieci** — czyta tylko to, co system już wie:

- sąsiedzi z tablicy ARP/NDP jądra (`ip -j neigh show`, a bez iproute2 `/proc/net/arp`), łączeni po adresie MAC,
- `~/.ssh/known_hosts` użytkownika backendu (wpisy zahaszowane — `HashKnownHosts yes` — są nieczytelne i pomijane),
- `/etc/hosts`; nazwy uzupełnia odwrotny DNS (limit 1,5 s).

Połączenie TCP sprawdzane jest tylko dla hostów ze znanym portem SSH (z known_hosts). Wykryte hosty są pamiętane
24 h w pamięci procesu (restart backendu czyści listę). Przycisk „Monitoruj” zapisuje host jako moduł z `config.address`.
Urządzenie pojawi się w tablicy ARP, gdy host backendu się z nim komunikuje (np. brama, NAS, drukarka w użyciu).
