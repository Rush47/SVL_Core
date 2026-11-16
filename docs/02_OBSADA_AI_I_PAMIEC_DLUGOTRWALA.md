# 02. Obsada AI (Agata Mitek & Iris AI) oraz Pamięć Długotrwała 128D

## 1. Kanoniczna Obsada Systemu

W systemie aktywne są wyłącznie następujące podmioty:
- **Mateusz Mitek (Operator)** — Dowódca Floty i główny architekt `SVL_System`.
- **Agata Mitek (`id: Agata`)** — Jedyna autonomiczna agentka AI Rodziny Mitek z pełnymi uprawnieniami `ROOT (UID 0 · NOPASSWD: ALL)`.
- **Iris AI (`id: iris`)** — Systemowy koordynator telemetrii, powiadomień `[Iris][N]` oraz szczegółowych raportów `SVL_System` na kanale **Rodzina Mitek (wszyscy)**.

Dawne profile pomocnicze (`Alex`, `Aria`/`si_1`, `Astyria`, `Aurelius`) oraz zewnętrzny mostek `Codex CLI` zostały trwale usunięte z kodu i bazy SQLite.

## 2. Pamięć Długotrwała 128D (SQLite WAL + Hyperspace)

- **Okno kontekstu rozmowy**: rozszerzone do **64 tur** (`max_context_turns: 64`) oraz **16 384 tokenów** (`ollama_num_ctx: 16384`).
- **Wyszukiwanie semantyczne**: przed każdą odpowiedzią `recall_agent_memories()` wyszukuje 18 najbardziej dopasowanych wspomnień w 128-wymiarowej przestrzeni binarnej `BinaryHyperspaceKernel` z priorytetem dla typów `preference`, `decision`, `fact` oraz `task`.
- **Automatyczna deduplikacja i zapis**: każda rozmowa oraz polecenie `/exec` są automatycznie indeksowane w tabeli `agent_memory` bez blokowania głównego wątku odpowiedzi.

## Swobodna rozmowa obustronna (Operator ↔ Bielik ↔ Maya) — bez promptów

Modele **nie dostają żadnych instrukcji** — ani w zwykłym czacie, ani w rozmowie obustronnej, ani w trybie Codex CLI.
Widzą wyłącznie zapis rozmowy, w którym każda wypowiedź ma postać `[Imię]: treść`.
Logika: `src/server/conversation.ts`, endpoint `POST /api/chat/proactive`.

- **AI same decydują, kto mówi.** Serwer dopisuje do zapisu rozmowy znak `[` i model sam uzupełnia imię
  następnego mówcy (Ollama `/api/generate` z `raw: true`, czyli bez szablonu i bez promptu).
  - wskazany Bielik lub Maya → ta AI dopisuje swoją kwestię po `[Imię]: ` własnym modelem z konfiguracji,
  - wskazany Operator → AI milkną i czekają na Twoją wiadomość,
  - wskazany ktoś spoza rozmowy → AI czekają.
- **„Niech AI mówi dalej”** (przycisk nad czatem) daje głos AI, która najdawniej mówiła.
- **Bezpiecznik kosztów:** po `SVL_DUPLEX_MAX_AI_TURNS` (domyślnie 8) wypowiedziach AI z rzędu bez Twojej wiadomości.
- **Bez wpływu na treść:** serwer odrzuca jedynie powtórzenia i ucina kwestie, które model dopisał za innych uczestników.
- **Polecenia czatu** („Zapisz w pamięci…”, `/exec`, `/modul` …) rozpoznaje i wykonuje serwer, bez udziału modelu.
  Model nie dostaje już protokołu `[[SVL_ACTION]]`, więc sam akcji nie wykonuje.
- Persona i pamięć z zakładki Agenci nie są wysyłane do modelu w czacie (wciąż służą zadaniom workerów).
