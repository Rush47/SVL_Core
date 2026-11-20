# 05. GitHub — repozytorium `Rush47/SVL_Core`

System obsługuje **wyłącznie** repozytorium `Rush47/SVL_Core`. Inne repozytoria (w tym dawne
`mmitek515-netizen/*`) są odłączone i blokowane — zarówno w API, jak i w GitHub CLI.

## Token (classic)

1. GitHub → Settings → Developer settings → Personal access tokens → **Tokens (classic)**.
2. Zakresy: `repo`, `workflow`; dla pełnej administracji także `admin:repo_hook` i `delete_repo`.
3. Wpisz token w pliku **`.env`** na serwerze (wzór w `.env.example`) i uruchom aplikację ponownie:

```bash
GITHUB_TOKEN="ghp_…"
SVL_GITHUB_SYNC_BRANCH="main"
SVL_GITHUB_AUTOSYNC_SEC="0"   # np. 300 = synchronizacja obustronna co 5 minut
```

Token zostaje na serwerze: nie trafia do przeglądarki, argumentów procesów, `.git/config` ani logów.

## Synchronizacja obustronna (katalog projektu ↔ GitHub)

| Akcja | Co robi |
| --- | --- |
| `status` | pobiera stan z GitHuba: do wysłania / do pobrania / niezapisane pliki |
| `pobierz` | scala zmiany z GitHuba (odmawia, gdy są niezapisane zmiany lokalne) |
| `wyślij` | zapisuje lokalne zmiany jako commit i wysyła |
| `synchronizuj` | zapisuje lokalne zmiany, scala zmiany z GitHuba i wysyła — w obie strony |
| `init` | łączy katalog bez gita z repozytorium (pliki na dysku pozostają bez zmian) |

Nigdy nie ma nadpisywania siłą: przy konflikcie scalanie jest przerywane, a pliki zostają
w lokalnej wersji. Zmiany zawierające sekrety (tokeny, klucze, `.env`, `*.secret`) są blokowane.

Gdzie: panel **Linux → GitHub · Rush47/SVL_Core**, zakładka terminala **GitHub CLI**, czat
(`/github status|pobierz|wyślij|synchronizuj|init`), API `POST /api/github/sync`.

## Zmiany widoczne od razu (synchronizacja na żywo)

Wcześniej po `git pull` (panel, terminal, autosynchronizacja) i po edycji plików przez AI (czat, MCP,
agenci) działająca aplikacja niczego nie zauważała: w trybie produkcyjnym (`npm start`) GUI jest
serwowane z gotowego katalogu `dist/`, budowanego tylko przy starcie, a panele odświeżały się tylko
po zmianach w bazie SQLite. Nowe elementy pojawiały się dopiero po ręcznej synchronizacji/restarcie.

Teraz gateway (`src/server/liveRepoSync.ts`) obserwuje repozytorium i HEAD gita:

| Co się zmieniło | Co dzieje się samo | Czas |
|---|---|---|
| dowolny plik repo (np. `SVL_CoreOS_2/`, `docs/`) | ramka `svl.repo_changed` → panel GitHub i drzewa plików odświeżają się | ~0,3–2 s |
| nowy commit (pull, auto-pull, commit, checkout — także z konsoli) | ramka `svl.git_head` + odświeżenie wszystkich danych w GUI | ≤1,5 s |
| GUI: `src/` (poza `src/server`), `index.html`, `public/` | produkcja: `vite build` do `dist.__next`, podmiana `dist` dopiero po udanym buildzie, karty przeładowują się same (czekają, gdy piszesz; wracają na tę samą zakładkę) | ~2–5 s |
| `backend/*.py` | restart jądra Python, gateway i GUI działają dalej | ~3–4 s |
| `server.ts`, `src/server/`, `src/mcp/`, `src/utils/` | pod systemd/pm2: automatyczny restart gatewaya; bez nadzorcy: baner z przyciskiem **Uruchom serwer ponownie** | po kliknięciu ~5–10 s |
| `package.json` / `package-lock.json` | baner restartu; restart najpierw robi `npm install` | zależnie od npm |

Automatyczne pobieranie z GitHuba (`SVL_GITHUB_AUTOPULL_SEC`, domyślnie co 60 s w produkcji):
tylko fast-forward, bez commitów i wysyłania; pomijane, gdy lokalna gałąź ma własne commity albo
niezapisane zmiany dotyczą plików przychodzących z GitHuba. Ręcznie: `POST /api/live/pull`.

Samodzielny serwer MCP (`npm run mcp`) po każdej zmianie pliku zgłasza ją aplikacji
(`POST /api/live/repo-changed`, token `SVL_OPERATOR_TOKEN`); nawet bez tego zmianę wykrywa obserwator.

API (wszystkie z nagłówkiem `X-SVL-Operator-Token`): `GET /api/live/status`,
`POST /api/live/repo-changed` (`{ "paths": [...], "source": "..." }`), `POST /api/live/rebuild`,
`POST /api/live/pull`, `POST /api/live/restart`. Ustawienia: sekcja „SYNCHRONIZACJA NA ŻYWO” w `.env.example`.

Zalecane uruchomienie pod systemd (automatyczny restart po zmianie kodu serwera):
`deploy/systemd/svl-gateway.service`.

## GitHub CLI

- Prawdziwe `gh` (instalowane przez `deploy/install-debian13.sh` i obraz Docker), uruchamiane
  z `GH_TOKEN` i `GH_REPO=Rush47/SVL_Core`.
- Bez `gh` (np. AI Studio): wbudowane `gh api …`, `gh auth status`, `gh repo view`, `gh pr list`,
  `gh issue list`, `gh run list`, `gh release list`, `gh branch list`, `gh workflow list` przez REST.
- Czat: `/gh <polecenie>`, np. `/gh pr list`, `/gh issue create --title "…" --body "…"`.

## Administracja przez AI (Bielik i Maya)

Agenci mają uprawnienia `github.read`, `github.write_sync` i `github.admin`. W czacie (silnik Gemini
z narzędziami) korzystają z:

- `github_api` — całe REST API GitHuba dla `Rush47/SVL_Core`,
- `github_sync` — synchronizacja obustronna,
- `github_cli` — polecenia `gh`,
- `github_read_file` / `github_update_file` — pliki na gałęzi `svl-sync`.

**Operacje nieodwracalne** (usuwanie repozytorium, gałęzi czy wydań, zmiana ustawień i widoczności,
współpracownicy, klucze, webhooki, sekrety Actions, ochrona gałęzi, scalanie PR, wymuszony push)
nie są wykonywane od razu: pod odpowiedzią AI pojawia się przycisk **✅ Potwierdź** / **✖ Anuluj**
(ważny 15 minut). Wszystkie operacje trafiają do `logi/backend_gateway.txt` (kategoria `github`).
