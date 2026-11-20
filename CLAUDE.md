# SVL Python OS — wskazówki dla Claude

Repozytorium: **Rush47/SVL_Core** (jedyne obsługiwane). Interfejs i komunikaty po polsku.

## Architektura
- `server.ts` — brama Express + WebSocket `/ws/svl` (port 3000), czat `/api/chat`, MCP `/mcp/svl` i `/mcp/github`.
- Synchronizacja na żywo: każda zmiana stanu idzie przez `LiveSyncBus` (`src/server/liveSyncBus.ts`) do `/ws/svl` i do zapasowego SSE `/api/events` (gdy proxy zrywa WebSocket).
- Akcje czatu: modele bez natywnych narzędzi (Ollama) dostają protokół `<svl_action>{…}</svl_action>` (`src/server/chatActions.ts`); serwer wykonuje bloki tym samym kodem co narzędzia.
- `backend/` — jądro Python (port 8085, SQLite WAL): `svl_core.py`, `app.py`, `agents_runtime.py`, `ship_monitor.py`.
- `src/` — React + Vite; `src/server/*` — moduły serwera (Gemini, GitHub, MCP, logi).
- AI w systemie to **wyłącznie Bielik i Maya** (Ollama, zapasowo Gemini). Nie dodawaj innych person AI.
- Maya publikuje powiadomienia na kanale „Rodzina Mitek (wszyscy)”.

## Polecenia
```bash
npm run dev            # brama + jądro Python
npx tsc --noEmit       # typy
npm run test:unit      # testy TypeScript
npm run test:python    # testy Pythona
npx vite build         # build frontendu
```

## Zasady
- Każda zmiana: typy, oba zestawy testów i build muszą przechodzić.
- Bez sekretów w repo (`.env`, `data/*.secret`, tokeny). Token GitHub tylko w `.env` (`GITHUB_TOKEN`).
- Bez zmyślonych danych — telemetria, statek SVL-364 (SSH) i stan usług tylko z prawdziwych pomiarów.
- Operacje nieodwracalne na GitHubie wymagają potwierdzenia operatora.
- Podgląd AI Studio (`DISABLE_HMR=true`): bez HMR i bez WebSocketu Vite (inaczej klient Vite przeładowuje stronę po każdym zerwaniu połączenia przez proxy).
- Logi systemu: `logi/*.txt` (kategorie m.in. `ai_chat`, `ai_models`, `github`, `ship_monitor`).

## MCP
`.mcp.json` łączy Claude Code z działającym systemem (`svl-core`, `http://127.0.0.1:3000/mcp/svl`). Adres jest wpisany na stałe, bo Copilot nie rozwija składni `${VAR:-domyślna}` w `url` i odrzuca cały plik; inny adres zmień bezpośrednio w `.mcp.json`.
Token operatora domyślnie nie jest wymagany — `SVL_REQUIRE_OPERATOR_TOKEN=1` włącza wymóg
(wtedy ustaw też `SVL_OPERATOR_TOKEN` w środowisku). Narzędzia: `svl_status`, `svl_chat`, `svl_conversation`,
`svl_terminal`, `svl_ship_telemetry`, `svl_logs`, `svl_memory_*`, `svl_github`, `svl_notify`,
`svl_antivirus_scan`, `svl_report`.
