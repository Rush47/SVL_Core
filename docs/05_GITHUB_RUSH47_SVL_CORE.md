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
