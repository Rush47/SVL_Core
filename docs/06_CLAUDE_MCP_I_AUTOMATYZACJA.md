# 06. Claude: MCP, automatyzacja GitHub i narzędzia AI

## 1. Serwer MCP systemu (`/mcp/svl`)

Jeden serwer MCP dla całego SVL Python OS. Łączy się z nim Claude Code, Claude Desktop
albo dowolny klient MCP (Streamable HTTP). Uwierzytelnienie: domyślnie niewymagane; przy `SVL_REQUIRE_OPERATOR_TOKEN=1` — `Authorization: Bearer <SVL_OPERATOR_TOKEN>`.

| Narzędzie | Co robi |
| --- | --- |
| `svl_status` | jądro, Ollama i modele, moduły, stan GitHub |
| `svl_chat` | rozmowa z Bielikiem lub Mayą; wiadomość widoczna w aplikacji jako „Claude (MCP)” |
| `svl_conversation` | ostatnie wiadomości kanału (wszyscy / bielik / maya) |
| `svl_terminal` | terminale: linux, python, ssh (statek SVL-364), github, hyperspace, agents |
| `svl_ship_telemetry` | prawdziwe pomiary hosta, usług i jednostki SVL-364 |
| `svl_ssh_status` / `svl_ssh_test` | status OpenSSH oraz test DNS, TCP i uwierzytelnienia |
| `svl_ssh_configure` / `svl_ssh_public_key` | konfiguracja statku i zarządzanie kluczem Ed25519 bez ujawniania klucza prywatnego |
| `svl_ssh_exec` | polecenie zdalne wyłącznie po jawnym `confirmed=true` |
| `svl_ollama_tunnel` | stan i bieżące włączenie/wyłączenie tunelu Ollamy przez SSH |
| `svl_ship_manage` | zasoby, systemd, Ollama, pliki/backup, sieć/zapora i aktualizacje komputera pokładowego |
| `svl_logs` | logi z `logi/` z filtrem kategorii i poziomu |
| `svl_memory_search` / `svl_memory_add` | pamięć długotrwała agentów |
| `svl_github` | synchronizacja z `Rush47/SVL_Core` i polecenia `gh` |
| `svl_notify` | powiadomienie od Mayi na kanale „wszyscy” |
| `svl_antivirus_scan` / `svl_report` | skan i raport (publikuje Maya) |

Konfiguracja SSH przez MCP:
1. Wywołaj `svl_ssh_configure` z `hostname`, `user`, opcjonalnie `alias` i `port`.
2. Dodaj zwrócony `publicKey` do `~/.ssh/authorized_keys` na statku SVL-364.
3. Wywołaj `svl_ssh_test`, aby sprawdzić DNS/TCP i uwierzytelnienie.
4. Dopiero wtedy użyj `svl_ssh_exec` z `confirmed=true` albo `svl_ollama_tunnel`.

Konfiguracja jest zapisywana w `~/.ssh/config.d/svl-364.conf`. Klucz prywatny pozostaje
wyłącznie lokalnie w `~/.ssh/svl364_ed25519`. Zmiana tunelu przez MCP dotyczy bieżącego
procesu gatewaya i nie zastępuje trwałych zmiennych `SVL_SHIP_OLLAMA*`.

### Zarządzanie kontem „SVL-364 Komputer pokładowy”

Endpoint `/api/mcp/svl364` udostępnia dodatkowo kontrolowane narzędzia
`svl364_resources`, `svl364_service_control`, `svl364_ollama_control`,
`svl364_file_control`, `svl364_network_control` i `svl364_update_control`.
Odczyt zasobów, usług, logów i sieci nie modyfikuje statku. Zmiana usługi,
pobieranie/usuwanie modelu, backup i aktualizacja wymagają `confirmed=true`.
Ścieżki plików są ograniczone do `/app`, `/opt/svl`, `/srv`, `/var/log`
oraz `/var/backups/svl364`.

Bielik i Maya korzystają z tego samego konta technicznego widocznego w panelu
SVL-364. Samo podłączenie konta nie oznacza osiągalności statku: aktualny
stan TCP/SSH nadal pochodzi wyłącznie z testu OpenSSH.

### Claude Code
Plik `.mcp.json` w repozytorium dodaje serwer `svl-core` pod stałym adresem
`http://127.0.0.1:3000/mcp/svl`. Najpierw uruchom bramę poleceniem `npm run dev`, a następnie
uruchom `claude` w katalogu projektu. Jeśli SVL działa pod innym adresem, zmień `url` bezpośrednio
w `.mcp.json` — zmienna `SVL_MCP_URL` nie jest przez ten plik używana.

Token operatora domyślnie nie jest wymagany. Jeśli ustawiono `SVL_REQUIRE_OPERATOR_TOKEN=1`,
przed uruchomieniem Claude Code udostępnij mu `SVL_OPERATOR_TOKEN`:

```bash
export SVL_OPERATOR_TOKEN="…" # ten sam token co w aplikacji
claude
```

### Claude Desktop
Dodaj serwer HTTP pod adresem `…/mcp/svl`. Gdy `SVL_REQUIRE_OPERATOR_TOKEN=1`, ustaw nagłówek
`Authorization: Bearer <SVL_OPERATOR_TOKEN>`. Dla konektora w aplikacji Claude użyj adresu
z kluczem skopiowanego z karty „Claude MCP” w panelu — nie udostępniaj tego adresu.
Serwer musi być osiągalny z komputera klienta; `127.0.0.1` oznacza sam komputer klienta, a podgląd
aplikacji w Google AI Studio może być niedostępny spoza logowania Google.

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
