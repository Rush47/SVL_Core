# SVL MCP — pełny odczyt/zapis z dostępem z internetu (bez stałego IP i domeny)

Samodzielny serwer MCP (`src/mcp/`), niezależny od bramy `server.ts`. Działa jako osobny proces
(`npm run mcp` albo usługa `svl-mcp`) i sam wystawia się do internetu tunelem wychodzącym —
router, przekierowanie portów, stałe IP ani własna domena nie są potrzebne.

## Narzędzia

| Narzędzie | Opis | Zapis |
|---|---|---|
| `read_file` | czyta plik (UTF-8/base64, offset/limit linii) | – |
| `list_dir` | lista plików (rekurencyjnie do `depth`) | – |
| `search` | szukanie tekstu/regex w plikach lub nazwach (`glob`) | – |
| `stat` | metadane pliku | – |
| `write_file` | tworzy/nadpisuje/dopisuje plik | ✔ |
| `edit_file` | zamiana dokładnego fragmentu (`old_string` → `new_string`) | ✔ |
| `make_dir`, `move_path`, `delete_path` | katalogi, przenoszenie/kopiowanie, usuwanie | ✔ |
| `run_command` | polecenie bash z limitem czasu | ✔ |
| `svl_chat` | polecenie do AI SVL (`/api/chat`: Grok → Ollama → Gemini) jako Bielik/Maya | ✔ |
| `svl_logs` | końcówka logów SVL (`system`, `gateway`, `python`, `gui`) | – |
| `mcp_info` | stan serwera i tunelu | – |

Operacje plikowe są zamknięte w `MCP_ROOT` (blokada `../`, ścieżek bezwzględnych spoza katalogu
i ucieczki przez dowiązania symboliczne). **`run_command` ma pełne prawa użytkownika usługi i może
wyjść poza `MCP_ROOT`** — wyłącz go przez `MCP_ALLOW_SHELL=0`, jeśli nie jest potrzebny.
`MCP_READ_ONLY=1` ukrywa i blokuje wszystkie narzędzia zapisu (także powłokę i `svl_chat`).

## Bezpieczeństwo

- Każde żądanie `/mcp` wymaga tokenu: `Authorization: Bearer <MCP_TOKEN>` (albo `X-MCP-Token`).
  Dla klientów, które nie umieją wysłać nagłówka: `/mcp/k/<MCP_TOKEN>` (wyłączysz przez `MCP_ALLOW_URL_TOKEN=0`).
- Brak `MCP_TOKEN` w `.env` → token generuje się przy pierwszym starcie i trafia do
  `data/svl_mcp_token.secret` (prawa 0600). Token nie jest nigdy zapisywany w logach (`fileLogger` go maskuje).
- Porównanie tokenu w stałym czasie. `/healthz` jest publiczne, ale nie zdradza niczego poza `ok`.
- Serwer nasłuchuje tylko na `127.0.0.1` — z zewnątrz dostępny wyłącznie przez tunel.
- Pełny zapis + powłoka wystawione do internetu = pełna kontrola nad maszyną dla każdego, kto zna
  token. Nie udostępniaj pliku `data/svl_mcp_connector.secret`; w razie wycieku zmień token
  (usuń plik `data/svl_mcp_token.secret` albo ustaw nowy `MCP_TOKEN`) i zrestartuj usługę.

## Tunel (adres z internetu)

`MCP_TUNNEL`:

| Wartość | Konto | Adres | Uwagi |
|---|---|---|---|
| `cloudflared` (domyślnie) | nie | `https://<losowe-słowa>.trycloudflare.com` | **zmienia się po każdym restarcie tunelu** |
| `cloudflared` + `MCP_CLOUDFLARED_TOKEN` + `MCP_PUBLIC_URL` | Cloudflare (darmowe) + domena w Cloudflare | stały | nazwany tunel (`cloudflared tunnel create`, token z panelu Zero Trust) |
| `tailscale` | Tailscale (darmowe) | stały `https://<host>.<tailnet>.ts.net` | Tailscale Funnel; włącz Funnel w ACL, `tailscale up` wcześniej |
| `ngrok` | ngrok (darmowe) | darmowa stała domena (`MCP_PUBLIC_URL`) | wcześniej `ngrok config add-authtoken …` |
| `none` | – | tylko lokalnie | |

Tunel startuje dopiero, gdy jest sieć (sprawdzenie DNS co 10 s), po zerwaniu restartuje się
z backoffem (2 s → 60 s), a watchdog co minutę sprawdza publiczny `/healthz` i po 3 porażkach
restartuje tunel. `cloudflared` jest uznawany za gotowy dopiero po „Registered tunnel connection”
(wymaga wyjścia na port **7844** TCP lub UDP do Cloudflare).

**Gdzie jest adres i token**

- `data/svl_mcp_tunnel.json` — bieżący stan i publiczny adres (`mcpUrl`), bez tokenu.
- `data/svl_mcp_connector.secret` (0600) — gotowe dane: adres, nagłówek, adres z kluczem,
  wpis dla Gemini CLI i polecenie dla Claude Code. Aktualizuje się przy każdej zmianie adresu.
- `journalctl -u svl-mcp -f` / `logi/backend_gateway.txt` (kategoria `mcp_full`) — adres tunelu (bez tokenu).
- `GET <adres>/status` z nagłówkiem Bearer — stan serwera i tunelu; narzędzie `mcp_info` z poziomu klienta.

## Instalacja (Debian, start przy uruchomieniu)

```bash
sudo bash deploy/install-mcp.sh /opt/svl-python-os svlos   # cloudflared + usługa svl-mcp
sudo cat /opt/svl-python-os/data/svl_mcp_connector.secret
```

Usługa startuje po `network-online.target`, `Restart=always`. Ręcznie: `npm run mcp`
(HTTP + tunel) albo `npm run mcp:stdio` (lokalny klient uruchamiający serwer jako proces).

## Podłączanie klientów

Adres = `mcpUrl` z `data/svl_mcp_tunnel.json` (np. `https://abc-def.trycloudflare.com/mcp`).

**Gemini CLI** — `~/.gemini/settings.json` (Streamable HTTP to `httpUrl`, nie `url`):

```json
{
  "mcpServers": {
    "svl": {
      "httpUrl": "https://abc-def.trycloudflare.com/mcp",
      "headers": { "Authorization": "Bearer $SVL_MCP_TOKEN" },
      "timeout": 600000
    }
  }
}
```

albo `gemini mcp add --scope user --transport http --header "Authorization: Bearer $SVL_MCP_TOKEN" svl https://abc-def.trycloudflare.com/mcp`.

**Gemini API / Google AI Studio (Interactions API)** — narzędzie `mcp_server` (tylko Streamable HTTP, nazwa bez `-`):

```python
client.interactions.create(model="…", input="…", tools=[{
    "type": "mcp_server", "name": "svl",
    "url": "https://abc-def.trycloudflare.com/mcp",
    "headers": {"Authorization": "Bearer <MCP_TOKEN>"},
}])
```

**Claude Code**: `claude mcp add --transport http svl https://…/mcp --header "Authorization: Bearer <MCP_TOKEN>"`.

**Klienci bez nagłówków** (np. konektory w aplikacjach webowych): adres `https://…/mcp/k/<MCP_TOKEN>`.
Serwer nie ma OAuth — klient wymagający OAuth się nie połączy.

Przy domyślnym quick tunnelu adres zmienia się po restarcie — wtedy zaktualizuj go w kliencie
albo przejdź na stały adres (nazwany tunel Cloudflare / Tailscale Funnel / domena ngrok).
