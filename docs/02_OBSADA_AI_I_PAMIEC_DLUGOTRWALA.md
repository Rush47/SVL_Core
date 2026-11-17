# 02. Obsada AI (Bielik & Maya) oraz Pamięć Długotrwała 128D

## 1. Kanoniczna Obsada Systemu

W systemie aktywne są wyłącznie następujące podmioty:
- **Mateusz Mitek (Operator)** — Dowódca Floty i główny architekt `SVL_System`.
- **Bielik (`id: Bielik`)** — procesor poleceń czatu (ROOT) na lokalnej Ollamie `llama3.2-vision:11b`.
- **Maya (`id: Maya`)** — AI pokładowe statku SVL-364; publikuje **powiadomienia systemowe** na kanale
  **Rodzina Mitek (wszyscy)** (zakończone/nieudane zadania agentów, pobieranie modeli Ollama,
  skany antywirusowe, zmiany wydane z czatu na innych kanałach).

Gdy Ollama nie odpowie, serwer może użyć Gemini jako zapasowego silnika — odpowiedź nadal
pochodzi od Bielika lub Mayi. Wszystkie inne AI (Agata, Iris, Alex, Aria/`si_1`, Astyria,
Aurelius, mostek `Codex CLI`) zostały trwale usunięte z kodu i bazy SQLite.

Powiadomienia: `POST /api/py/notifications/emit` (zapis w SQLite + zdarzenie `/ws/svl`),
`GET /api/py/notifications` (lista powiadomień Mayi).

## 2. Pamięć Długotrwała 128D (SQLite WAL + Hyperspace)

- **Okno kontekstu rozmowy**: rozszerzone do **64 tur** (`max_context_turns: 64`) oraz **16 384 tokenów** (`ollama_num_ctx: 16384`).
- **Wyszukiwanie semantyczne**: przed każdą odpowiedzią `recall_agent_memories()` wyszukuje 18 najbardziej dopasowanych wspomnień w 128-wymiarowej przestrzeni binarnej `BinaryHyperspaceKernel` z priorytetem dla typów `preference`, `decision`, `fact` oraz `task`.
- **Automatyczna deduplikacja i zapis**: każda rozmowa oraz polecenie `/exec` są automatycznie indeksowane w tabeli `agent_memory` bez blokowania głównego wątku odpowiedzi.

## Swobodna rozmowa obustronna (Operator ↔ Bielik ↔ Maya) — bez promptów

Modele **nie dostają żadnych instrukcji** — ani w zwykłym czacie, ani w rozmowie obustronnej.
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

## Skąd AI biorą informacje i jak to jest oznaczone

Każda odpowiedź w czacie ma oznaczenie pochodzenia (`provenance`, widoczne pod wiadomością):

| Oznaczenie | Skąd treść | Czy zweryfikowana |
| :--- | :--- | :--- |
| ⚠️ **Wiedza modelu — niezweryfikowana** | model językowy (Ollama, zapasowo Gemini) z własnej wiedzy | **nie** — model może się mylić |
| 🔗 **Ze źródłami z internetu** | Gemini z wyszukiwaniem Google; linki pod odpowiedzią | częściowo — sprawdź źródła |
| ✅ **Wynik serwera** | dane systemu lub wykonane polecenie (np. `/moduly`, „Zapisz w pamięci…”, skaner) | tak — bez udziału modelu |
| ❌ **Brak odpowiedzi modelu** | żaden model nie odpowiedział; powód w treści | — |

- Pytania o aktualne informacje („najnowsza wersja…”, „podaj źródła”, „sprawdź w internecie”) idą do Gemini
  z wyszukiwaniem Google. Bez `GEMINI_API_KEY` odpowiedź modelu dostaje ostrzeżenie, że nie mogła zostać sprawdzona w sieci.
- Model nie dostaje żadnych danych o systemie — jeśli „podaje” pomiary, stany usług czy wyniki poleceń, to je zmyśla.
  Prawdziwe dane są w zakładkach SVL-364 i Infrastruktura oraz w poleceniach czatu (`/status`, `/moduly`).
- Real Vision: parametry pliku (format, rozdzielczość, SHA-256, kolory) liczy serwer; opis treści obrazu pochodzi z modelu.
  Bez modelu nie ma opisu — tylko błąd.
