# SVL Python OS v5.6 (CoreOS 2: Apex) — Centrum Dowodzenia SVL-364 & Infrastruktura Floty

**SVL Python OS** to zintegrowane środowisko operacyjne łączące **Python 3 Kernel (`SVLSystemKernel`)**, **autonomicznego demona tła (`AutonomousAIDaemon`)**, **Długotrwałą Pamięć Semantyczną 128D (`BinaryHyperspaceKernel` + SQLite WAL)**, **lokalną lub statkową Ollamę (`127.0.0.1:11434`)**, **odokowany profil jądra Debian 13 Trixie (Bare-Metal Standalone)**, **Centrum Dowodzenia Statkiem `SVL-364 Ebon Apex`** oraz **GUI Apex-Glass** z dwukierunkową synchronizacją w czasie rzeczywistym (`/ws/svl` + SSE `/api/events` + `LiveRepoSync`).

Czat używa **Grok (API xAI)** jako głównego silnika, gdy w `.env` ustawiono `XAI_API_KEY`. Gdy klucza nie ma albo API zawiedzie, system przełącza się na **darmową lokalną Ollamę**, a następnie opcjonalnie na Gemini. Szczegóły: [deploy/AI_ENGINES.md](deploy/AI_ENGINES.md).

---

## Spis Dokumentacji Systemowej (`/docs`)

1. **[01. Architektura SVL_System i Baza SQLite WAL](docs/01_ARCHITEKTURA_SVL_SYSTEM.md)**
   - Dwustronna synchronizacja w czasie rzeczywistym (`/ws/svl` + SSE `/api/events`), `LiveRepoSync`, tryb autonomiczny w tle i cache metadanych.
   - Matematyczne jądro topologiczne `TopologicalInfinityEngine` oraz `WithoutNlpHarmonicEngine`.
2. **[02. Obsada AI (Bielik & Maya) oraz Pamięć Długotrwała 128D](docs/02_OBSADA_AI_I_PAMIEC_DLUGOTRWALA.md)**
   - Kanoniczna obsada: **Mateusz Mitek (Operator)**, **Bielik** (procesor poleceń, ROOT) oraz **Maya** (AI statku SVL-364, powiadomienia na kanale „wszyscy”).
   - Semantyczna pamięć długotrwała 128D w SQLite WAL (okno 64 tur, `num_ctx: 16384`, automatyczna deduplikacja i ekstrakcja faktów/preferencji).
   - Wielosekcyjne raporty `SVL_System` na kanale **Rodzina Mitek (wszyscy)**.
3. **[03. Statek Kosmiczny SVL-364 Ebon Apex i Infrastruktura Floty](docs/03_STATEK_SVL_364_I_INFRASTRUKTURA_FLOTY.md)**
   - Holograficzna mapa taktyczna CIC (Mass Effect Galaxy Map), łącze kwantowe `QKD-364` oraz telemetria `CPU / GPU / RAM`.
   - Zarządzanie statkami floty, placówkami planetarnymi, bioreaktorami botanicznymi (`+830 L O2/h`) i projektami badawczymi z ETA.
4. **[04. Ollama i Terminale ROOT (`SVL-364`)](docs/04_DEMON_OLLAMA_I_TERMINALE_ROOT.md)**
   - Uruchamianie prawdziwej Ollamy (`backend/ollama_daemon.py`) — bez zastępników.
   - Obsługa komend `/exec raport systemu`, `/exec <polecenie>` i `@work` w 4 terminalach systemowych.

5. **[05. GitHub — repozytorium Rush47/SVL_Core](docs/05_GITHUB_RUSH47_SVL_CORE.md)**
   - Token classic w `.env`, synchronizacja obustronna, GitHub CLI i administracja repozytorium przez Bielika i Mayę.

6. **[06. Claude: MCP, automatyzacja GitHub i narzędzia AI](docs/06_CLAUDE_MCP_I_AUTOMATYZACJA.md)**
   - Serwer MCP całego systemu (`/mcp/svl`), `@claude` w issue i PR, CI, czytanie stron i wykonywanie kodu w czacie.

---

## Serwer MCP — pełny odczyt/zapis z internetu

`npm run mcp` uruchamia osobny serwer MCP (`src/mcp/`) z narzędziami plikowymi (odczyt, zapis, edycja,
usuwanie, przenoszenie, wyszukiwanie), powłoką z limitem czasu oraz `svl_chat` (AI SVL: Grok → Ollama)
i `svl_logs`. Wymaga tokenu Bearer (`MCP_TOKEN` albo wygenerowany w `data/svl_mcp_token.secret`)
i sam wystawia się do internetu tunelem Cloudflare (bez konta, stałego IP i domeny); adres trafia do
`data/svl_mcp_tunnel.json`, a gotowe konfiguracje klientów (Gemini CLI, Claude Code) do
`data/svl_mcp_connector.secret`. Usługa przy starcie systemu: `sudo bash deploy/install-mcp.sh`.
Szczegóły, tryb tylko do odczytu i stały adres: [deploy/MCP.md](deploy/MCP.md).

## Szybki Start i Testy

```bash
# Uruchomienie pełnego środowiska (Gateway + Python Kernel; Ollama — jeśli zainstalowana)
npm run dev

# Testy jednostkowe TypeScript i Python Kernel
npm run test:unit
npm run test:python
```
