# SVL CoreOS 2: Apex — Debian 13 (Trixie) & SVL-364 Ship-Hosted AI

**SVL CoreOS 2: Apex** to dedykowany podsystem operacyjny bazujący na **Debian 13 (Trixie)**, zintegrowany bezpośrednio z jednostką **SVL-364 (`Ship`)** i zarządzany na poziomie jądra przez **Mayę (Kernel Master Daemon · ROOT)**.

## Architektura Systemu

1. **Kernel Master Daemon (Maya · AI Statku SVL-364 · ROOT)**
   - Bezpośredni nadzór nad alokacją zasobów obliczeniowych, pamięcią długotrwałą 128D SQLite WAL, telemetrią jednostki SVL-364 oraz zaporą i tarczą `E_Shield`.
   - Protokół kompilacji rozproszonej **Compute-Thrust** wykorzystujący klastry CPU/NPU jednostki SVL-364.

2. **Silnik AI Hostowany ze Statku SVL-364 (`svl364-apex-uncensored`)**
   - Silnik **Ollama** hostowany bezpośrednio z jednostki `SVL-364` (`ssh://Ship` · tunel `127.0.0.1:11434`) jako usługa systemowa czasu rzeczywistego (`Real-time AI Scheduling`).
   - Model **`svl364-apex-uncensored:latest`** (baza wag: `llama3.2-vision:11b`, okno kontekstowe `16384` tokenów, bezpośrednie wykonywanie poleceń operatora Mateusza).

3. **Standardowe Opcje Interfejsu (Omni-Interface)**
   - **Czat**: standardowy wybór modelu `SVL CoreOS 2 · Apex-Uncensored (Maya · SVL-364 Ship)` oraz szybki przełącznik na pasku czatu.
   - **Terminale (ROOT / SSH / Linux / GitHub)**: bezpośrednie komendy diagnostyczne i wdrożeniowe katalogu `SVL_CoreOS_2/`.

## Struktura Katalogu `SVL_CoreOS_2/`

- `README.md` — specyfikacja architektury **SVL CoreOS 2: Apex**.
- `core_init.log` — dziennik inicjalizacji rdzenia, mostka SSH/MCP i integracji z jednostką SVL-364.
- `build_manifest.json` — manifest kompilacji obrazu Debian 13 Trixie oraz konfiguracji klastra SVL-364.
- `ai_core/Modelfile.apex-uncensored` — definicja modelu Ollama `svl364-apex-uncensored:latest` zarządzanego przez Mayę.
- `ai_core/ollama_svl364_config.json` — parametry hostingu silnika Ollama na statku SVL-364.
- `debian13/install_coreos2_svl364.sh` — skrypt instalacyjny jądra i usług systemd na Debianie 13 (Trixie).
