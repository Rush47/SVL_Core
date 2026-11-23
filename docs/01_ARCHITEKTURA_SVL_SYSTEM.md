# 01. Architektura SVL_System i Baza SQLite WAL

## 1. Struktura Katalogów i Modułów

- **`backend/svl_core.py`** — Główne jądro `SVLSystemKernel`: baza danych SQLite w trybie `WAL` (`synchronous=NORMAL`, `cache_size=-64000`, `mmap_size=268435456`), generator wielosekcyjnych raportów Markdown `SVL_System`, rejestr modułów i historia rewizji.
- **`backend/ollama_daemon.py`** — Uruchamianie prawdziwej Ollamy na `127.0.0.1:11434`, jeśli jest zainstalowana.
- **`backend/autonomous_daemon.py`** — Autonomiczny demon tła (domyślnie aktywny), monitorujący usługi systemowe, SQLite WAL i kod projektu.
- **`backend/agents_runtime.py`** — Orkiestrator procesów workerów `Bielik` i `Maya` (`SVLAgentOrchestrator`) oraz silnik pamięci długotrwałej 128D.
- **`backend/hyperspace_engine.py`** — `BinaryHyperspaceKernel` (128-bitowe wektory Hamminga) oraz `WithoutNlpHarmonicEngine` (analiza harmoniczna Eulera/Fouriera).
- **`backend/spherical_bus.py`** — Asynchroniczna Sferyczna Magistrala Zdarzeń (`SphericalEventBus`) z mechanizmem Circuit Breaker.
- **`backend/app.py`** — Serwer HTTP/API jądra Python (`127.0.0.1:8085`).
- **`server.ts`** — Brama Express + WebSocket (`/ws/svl`) + SSE (`/api/events`) na porcie `3000`, `LiveRepoSync`, `LiveSyncBus` i cache metadanych.
- **`SVL_CoreOS_2/debian13/`** — W pełni odblokowany profil jądra Debian 13 Trixie (Bare-Metal Standalone, `kernel_unlocked: true`): `svl-coreos2-sysctl.conf` (BBR, eBPF, `sysrq=1`, `ptrace=0`, `perf=-1`, `dmesg=0`, `kptr=0`), `svl-coreos2-modules.conf`, `grub_svl_kernel.cfg` (`mitigations=off`, `iommu=pt`, `apparmor=0`).
- **`src/components/`** — Nowoczesne GUI **Apex-Glass** (`src/index.css`, `src/App.tsx` z wskaźnikiem `LIVE/SSE · rev` i przełącznikiem motywów):
  1. `ChatWorkspace.tsx` — Czat grupowy `Rodzina Mitek (wszyscy)` oraz kanały `Bielik` i `Maya` (1-na-1); powiadomienia Mayi na kanale „wszyscy”.
  2. `ApexCommandDock.tsx` — Ekran dowodzenia Apex OS.
  3. `Svl364CommandCenter.tsx` — Centrum Dowodzenia Statkiem `SVL-364 Ebon Apex` i mostek SSH.
  4. `InfrastructureWorkspace.tsx` — Zarządzanie Flotą, Placówkami, Botaniką Hydroponiczną i Badaniami z ETA.
  5. `AgentsPanel.tsx` — Panel agentów `Bielik` i `Maya` oraz inspektor Pamięci Długotrwałej 128D.
  6. `GalleryPanel.tsx` — Galeria i analiza wizyjna Real Vision.
  7. `TerminalsWorkspace.tsx` — 5 Terminali Systemowych (`SVL-364 ROOT CLI`, `Python 3 Console`, `System Logs`, `Ollama Local AI`, `GitHub CLI`).
  8. `KernelDiagnosticsView.tsx` — Diagnostyka Jądra SVL & Sfera 128D.
  9. `LinuxDeployDashboard.tsx` — Diagnostyka Hosta Linux, Demona Ollama i synchronizacji GitHub (`GitHubPanel.tsx`).

## 2. Polecenia z czatu i globalna synchronizacja

Polecenia Operatora wpisane w czacie są wykonywane **przed** wywołaniem modelu AI
(`POST /api/chat` w `server.ts`), dzięki czemu zmiana trafia do SQLite i do wszystkich
klientów (`/ws/svl` oraz SSE `/api/events`) w ciągu kilkudziesięciu milisekund, niezależnie od czasu odpowiedzi modelu.

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
