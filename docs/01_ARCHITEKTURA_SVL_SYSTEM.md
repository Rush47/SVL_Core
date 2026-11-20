# 01. Architektura SVL_System i Baza SQLite WAL

## 1. Struktura Katalogów i Modułów

- **`backend/svl_core.py`** — Główne jądro `SVLSystemKernel`: baza danych SQLite w trybie `WAL` (`synchronous=NORMAL`, `cache_size=-64000`, `mmap_size=268435456`), generator wielosekcyjnych raportów Markdown `SVL_System`, rejestr modułów i historia rewizji.
- **`backend/ollama_daemon.py`** — Lokalny demon HTTP kompatybilny z Ollama API na porcie `127.0.0.1:11434` oraz instalator binarki CLI `ollama`.
- **`backend/agents_runtime.py`** — Orkiestrator procesów workerów `Bielik` i `Maya` (`SVLAgentOrchestrator`) oraz silnik pamięci długotrwałej 128D.
- **`backend/hyperspace_engine.py`** — `BinaryHyperspaceKernel` (128-bitowe wektory Hamminga) oraz `WithoutNlpHarmonicEngine` (analiza harmoniczna Eulera/Fouriera).
- **`backend/spherical_bus.py`** — Asynchroniczna Sferyczna Magistrala Zdarzeń (`SphericalEventBus`) z mechanizmem Circuit Breaker.
- **`backend/app.py`** — Serwer HTTP/API jądra Python (`127.0.0.1:8085`).
- **`server.ts`** — Brama Express + WebSocket (`/ws/svl`) na porcie `3000` z niskolatencyjnym cachem metadanych (`getFastChatBackendMeta`).
- **`src/components/`** — 7 modułów interfejsu:
  1. `ChatWorkspace.tsx` — Czat grupowy `Rodzina Mitek (wszyscy)` oraz kanały `Bielik` i `Maya` (1-na-1); powiadomienia Mayi na kanale „wszyscy”.
  2. `Svl364CommandCenter.tsx` — Centrum Dowodzenia Statkiem `SVL-364 Ebon Apex` (mapa Mass Effect CIC, sieć QKD-364, CPU/GPU/RAM).
  3. `InfrastructureWorkspace.tsx` — Zarządzanie Flotą, Placówkami, Botaniką Hydroponiczną i Badaniami z ETA.
  4. `AgentsPanel.tsx` — Panel agentów `Bielik` i `Maya` oraz inspektor Pamięci Długotrwałej 128D.
  5. `TerminalsWorkspace.tsx` — 4 Terminale Systemowe (`SVL-364 ROOT CLI`, `Python 3 Console`, `System Logs`, `Ollama Local AI`).
  6. `KernelSphereView.tsx` — Jądro SVL & Sfera 128D.
  7. `LinuxDeployDashboard.tsx` — Diagnostyka Hosta Linux, Demona Ollama i synchronizacji GitHub.

## 2. Polecenia z czatu i globalna synchronizacja

Polecenia Operatora wpisane w czacie są wykonywane **przed** wywołaniem modelu AI
(`POST /api/chat` w `server.ts`), dzięki czemu zmiana trafia do SQLite i do wszystkich
klientów (`/ws/svl`) w ciągu kilkudziesięciu milisekund, niezależnie od czasu odpowiedzi modelu.

1. `src/server/chatDirectives.ts` → `parseChatDirectives()` deterministycznie rozpoznaje polecenia:
   - komendy `/…` (`/modul`, `/pamiec`, `/exec`, `/zadanie`, …) — bez zmian składni;
   - zdania naturalne, np. *„Zapisz w pamięci że …”*, *„Zapamiętaj: …”*, *„Ustaw moduł svl-364 na standby”*,
     *„Aktywuj / Wyłącz moduł <id>”*, *„Utwórz moduł <id> <opis>”*, *„Pokaż moduły”*, *„Co pamiętasz?”*,
     *„Sprawdź status Ollama”*, *„Podłącz workera”*, *„Zleć zadanie: tytuł | opis”*, *„Wykonaj polecenie \`uptime\`”*.
   - Zmiana statusu dotyczy wyłącznie **istniejącego** modułu i zachowuje jego nazwę, typ, opis i konfigurację.
2. Polecenia są wykonywane raz na turę (deduplikacja), a `flushChatSync()` rozsyła `svl.resync_required`
   oraz zdarzenia outboxa do wszystkich kart.
3. Model AI dostaje wyniki wykonanych poleceń w kontekście; znaczniki `[[SVL_ACTION:…]]` z jego odpowiedzi
   wykonywane są dodatkowo (bez powtórzeń). Rzeczywiste potwierdzenia serwera są dopisywane do odpowiedzi.
4. Klient (`svlSyncStore.tsx`): odświeżenie zażądane w trakcie innego odświeżenia uruchamia jedno dodatkowe
   pobranie stanu, a starsze odpowiedzi nie nadpisują nowszych (numerowanie żądań).
