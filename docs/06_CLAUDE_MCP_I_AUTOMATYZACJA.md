# 06. Claude: MCP, automatyzacja GitHub i narzędzia AI

## 1. Serwer MCP systemu (`/mcp/svl`)

Jeden serwer MCP dla całego SVL Python OS. Łączy się z nim Claude Code, Claude Desktop
albo dowolny klient MCP (Streamable HTTP). Uwierzytelnienie: `Authorization: Bearer <SVL_OPERATOR_TOKEN>`.

| Narzędzie | Co robi |
| --- | --- |
| `svl_status` | jądro, Ollama i modele, moduły, stan GitHub |
| `svl_chat` | rozmowa z Bielikiem lub Mayą; wiadomość widoczna w aplikacji jako „Claude (MCP)” |
| `svl_conversation` | ostatnie wiadomości kanału (wszyscy / bielik / maya) |
| `svl_terminal` | terminale: linux, python, ssh (statek SVL-364), github, hyperspace, agents |
| `svl_ship_telemetry` | prawdziwe pomiary hosta, usług i jednostki SVL-364 |
| `svl_logs` | logi z `logi/` z filtrem kategorii i poziomu |
| `svl_memory_search` / `svl_memory_add` | pamięć długotrwała agentów |
| `svl_github` | synchronizacja z `Rush47/SVL_Core` i polecenia `gh` |
| `svl_notify` | powiadomienie od Mayi na kanale „wszyscy” |
| `svl_antivirus_scan` / `svl_report` | skan i raport (publikuje Maya) |

### Claude Code
Plik `.mcp.json` w repozytorium dodaje serwer `svl-core`. Przed uruchomieniem `claude` w katalogu projektu:

```bash
export SVL_OPERATOR_TOKEN="…"                       # ten sam token co w aplikacji
export SVL_MCP_URL="http://127.0.0.1:3000/mcp/svl"  # albo adres serwera, na którym działa SVL
claude
```

### Claude Desktop
W konfiguracji serwerów MCP dodaj serwer HTTP pod adresem `…/mcp/svl` z nagłówkiem
`Authorization: Bearer <SVL_OPERATOR_TOKEN>`. Serwer musi być osiągalny z Twojego komputera —
podgląd aplikacji w Google AI Studio jest za logowaniem Google, więc zewnętrzne klienty MCP go nie widzą.

## 2. Automatyzacja GitHub (subskrypcja Claude)

| Workflow | Kiedy |
| --- | --- |
| `.github/workflows/ci.yml` | każdy push na `main` i PR: typy, testy TS i Python, build |
| `.github/workflows/claude.yml` | `@claude` w issue, komentarzu lub przeglądzie PR — Claude odpowiada, poprawia kod, tworzy PR |
| `.github/workflows/claude-review.yml` | automatyczny przegląd każdego PR (po polsku, komentarze w kodzie) |

Konfiguracja (jednorazowo):
1. Zainstaluj aplikację GitHub Claude w repozytorium: https://github.com/apps/claude
2. Na swoim komputerze: `claude setup-token` (subskrypcja Pro/Max) — skopiuj token.
3. GitHub → Rush47/SVL_Core → Settings → Secrets and variables → Actions → **New repository secret**:
   `CLAUDE_CODE_OAUTH_TOKEN` = skopiowany token.

`CLAUDE.md` w katalogu głównym opisuje zasady projektu — Claude stosuje je w PR i odpowiedziach.

## 3. Nowe narzędzia Bielika i Mayi w czacie (Gemini)

- **Wyszukiwanie Google** — pytania o aktualne informacje (odpowiedź ze źródłami).
- **Czytanie stron** — link `https://…` w wiadomości: model czyta stronę (`urlContext`).
- **Wykonywanie kodu** — „oblicz”, „policz”, „python”, „symulacja”…: model liczy kodem; kod i wynik
  są dołączane do odpowiedzi.
