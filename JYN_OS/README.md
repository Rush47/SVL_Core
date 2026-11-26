# JYN_OS v3.1 — System Klienta, Google Services Hub ($1000 USD) i Moduł Czatu Statku SVL-364 Ebon Apex

**Dedykowany dla:** Operator Mateusz Mitek  
**Rdzeń systemu:** Jyn Mitek (`System_SI_1`)  
**Repozytorium:** `Rush47/SVL_Core`  
**Lokalizacja:** `SVL_Core/JYN_OS/`

---

## 1. Architektura v3.1

**JYN_OS v3.1** integruje:
1. **Google Services & AI Integration Hub (`google_services_hub.py`)**:
   - **Portfel Operacyjny i Klucze API zasilone kwotą `$1000.00 USD`** (trwały zapis w bazie SQLite `data/jyn_google_hub.sqlite3`, księga rozliczeniowa `usage_ledger`, magazyn kluczy `api_keys_vault`).
   - **8 zakupionych i aktywnych pakietów usług Google**:
     1. **Google Gemini / AI Studio API** (`gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `imagen-3`, `veo-2`, `text-embedding-004`) — alokacja `$300.00 USD`
     2. **Vertex AI & Model Garden** (`vertex/gemini-2.5-pro`, `vertex/gemini-2.5-flash`, `vertex/claude-3-7-sonnet`, `vertex/llama-3.3-70b-instruct`) — alokacja `$200.00 USD`
     3. **Google Cloud Translation, Cloud TTS & STT** (`nmt-v3-neural`, `chirp-2-stt`, `journey-pl-PL-Wavenet-A`) — alokacja `$100.00 USD`
     4. **Google Cloud Vision & Document AI** (`vision-ocr-v1`, `document-ai-layout-v2`) — alokacja `$100.00 USD`
     5. **Google Custom Search / Grounding API** (`google-search-grounding-v1`) — alokacja `$80.00 USD`
     6. **Google Workspace Bridge** (`gdocs`, `gdrive`, `gsheets`, `gslides`, `gcalendar`, `gmail` w `/opt/antigravity/bin`) — alokacja `$70.00 USD`
     7. **Google Maps / Earth Telemetry API** (`geospatial-earth-v1`, `routes-matrix-v2`) — alokacja `$75.00 USD`
     8. **Google Cloud Storage (GCS) & BigQuery Telemetry Sync** (`gs://svl364-ebon-apex-telemetry`, `svl364_core.telemetry_events`) — alokacja `$75.00 USD`
2. **Moduł czatu (`chat_engine.py`)**:
   - **Strumieniowanie całkowicie wyłączone (`stream: False`)** — zawsze jedna kompletna odpowiedź JSON.
   - **Język polski (`DEFAULT_SYSTEM_PROMPT_PL`)** — stały, zwięzły prefiks systemowy Jyn Mitek zapewniający 100% trafień w pamięć KV-cache silnika Ollama.
   - **Szybkie komendy czatu** (`/status`, `/google`, `/google buy`, `/google topup 1000`, `/gemini <tekst>`, `/modele`, `/model <nazwa>`, `/wezel local|ship`, `/rozgrzej`, `/wyczysc`).
3. **Dwa węzły Ollama i 13 kanonicznych modeli SVL-364**:
   - **Lokalny silnik Ollama (`:11434`)** oraz **Węzeł pokładowy SVL-364 (`:11435`)** z 13 kanonicznymi modelami (`svl364-apex-uncensored:latest`, `dolphin-mixtral:8x22b`, `dolphin-llama3:70b`, `wizard-vicuna-uncensored:30b`, `dolphin-mixtral:8x7b`, `dolphin-llama3:8b-v2.9-q2_K`, `llama3.2-vision:90b`, `llama3.2-vision:11b`, `deepseek-r1:7b`, `qwen2.5:7b`, `qwen2.5-coder:7b`, `llama3:8b`, `mistral:7b`).
4. **Mostek OpenSSH (`Ship` · port 22)** oraz **Federacja 4 serwerów MCP** (`:3334`, `:3000/mcp/svl`, `:3000/api/mcp/svl364`, `:8085/api/py/svl364/mcp`).

---

## 2. Szybki Start i Polecenia

```bash
cd /home/antigravity/Rush47/SVL_Core/JYN_OS

# Status wszystkich 8 zakupionych usług Google i portfela $1000.00 USD
./jyn_os google status

# Zakup/re-provisioning wszystkich usług Google i doładowanie kluczy API do $1000.00 USD
./jyn_os google buy
./jyn_os google topup 1000

# Wywołania zintegrowanych usług Google w JYN_OS
./jyn_os google gemini "Zamelduj status integracji Google Cloud z JYN_OS"
./jyn_os google workspace
./jyn_os google maps
./jyn_os google sync

# Bezpośrednia rozmowa po polsku z Jyn Mitek (bez strumieniowania)
./jyn_os chat "Cześć Jyn, zamelduj gotowość systemów SVL-364"
```
