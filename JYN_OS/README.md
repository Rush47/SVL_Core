# JYN_OS v3.0 — System Klienta i Moduł Czatu Statku SVL-364 Ebon Apex

**Dedykowany dla:** Operator Mateusz Mitek  
**Rdzeń systemu:** Jyn Mitek (`System_SI_1`)  
**Repozytorium:** `Rush47/SVL_Core`  
**Lokalizacja:** `SVL_Core/JYN_OS/`

---

## 1. Architektura v3.0

**JYN_OS v3.0** integruje:
1. **Nowy moduł czatu (`chat_engine.py`)**:
   - **Strumieniowanie całkowicie wyłączone (`stream: False`)** — zawsze jedna kompletna odpowiedź JSON bez zacięć strumienia.
   - **Język polski (`DEFAULT_SYSTEM_PROMPT_PL`)** — stały, zwięzły prefiks systemowy Jyn Mitek zapewniający 100% trafień w pamięć KV-cache silnika Ollama pomiędzy turami rozmowy.
   - **Adaptacyjny budżet generowania** — szybkie odpowiedzi przy krótkich pytaniach (`num_predict=192`, `num_ctx=2048`) oraz rozszerzony budżet dla raportów i kodu (`num_predict=768`, `num_ctx=3072`).
   - **Szybkie komendy czatu** (`/status`, `/modele`, `/model <nazwa>`, `/wezel local|ship`, `/rozgrzej`, `/wyczysc`).
2. **Dwa węzły Ollama i 13 kanonicznych modeli SVL-364**:
   - **Lokalny silnik Ollama (`:11434`)**: zoptymalizowany pod niskie opóźnienia (`OLLAMA_KEEP_ALIVE=-1`, `OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0`, `OLLAMA_NUM_PARALLEL=1`).
   - **Węzeł pokładowy SVL-364 (`:11435`)**: udostępnia wszystkie **13 kanonicznych modeli pokładowych** (`svl364-apex-uncensored:latest`, `dolphin-mixtral:8x22b`, `dolphin-llama3:70b`, `wizard-vicuna-uncensored:30b`, `dolphin-mixtral:8x7b`, `dolphin-llama3:8b-v2.9-q2_K`, `llama3.2-vision:90b`, `llama3.2-vision:11b`, `deepseek-r1:7b`, `qwen2.5:7b`, `qwen2.5-coder:7b`, `llama3:8b`, `mistral:7b`) w trybie `stream=False`.
3. **Mostek OpenSSH (`Ship` · port 22)** oraz **Federacja 4 serwerów MCP** (`:3334`, `:3000/mcp/svl`, `:3000/api/mcp/svl364`, `:8085/api/py/svl364/mcp`).

---

## 2. Szybki Start i Polecenia

```bash
cd /home/antigravity/Rush47/SVL_Core/JYN_OS

# Konfiguracja i rozgrzanie środowiska
bash bootstrap.sh

# Bezpośrednia rozmowa po polsku z Jyn Mitek (bez strumieniowania)
./jyn_os chat "Cześć Jyn, zamelduj gotowość systemów SVL-364"

# Wybór dowolnego z 13 kanonicznych modeli na węźle SVL-364 (:11435)
./jyn_os chat "Podaj zwięzły status łączności" --node ship --model svl364-apex-uncensored:latest

# Konsola interaktywna
./jyn_os
```

## 3. Parametry Konfiguracyjne

| Zmienna | Domyślnie | Opis |
| :--- | :--- | :--- |
| `SVL_LOCAL_OLLAMA_URL` | `http://127.0.0.1:11434` | Lokalny silnik Ollama |
| `SVL_SHIP_OLLAMA_URL` | `http://127.0.0.1:11435` | Węzeł pokładowy SVL-364 (tunel SSH lub mostek 13 modeli) |
| `SVL_CHAT_NUM_CTX` | `2048` | Okno kontekstu czatu |
| `SVL_CHAT_NUM_PREDICT` | `384` | Domyślny limit generowanych tokenów |
| `SVL_CHAT_TIMEOUT` | `90` | Timeout pojedynczego zapytania HTTP w sekundach |
