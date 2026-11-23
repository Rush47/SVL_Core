# SVL Universal MCP Hub — wszystkie usługi systemu i hosta SVL-364 bez stałego IP (jak Hamachi)

Zmodernizowany serwer MCP (`src/mcp/` + `/mcp/svl` + `/api/mcp/svl364`) służy jako **centralny punkt sterowania wszystkim** — na hoście systemu oraz na hoście **SVL-364** — działając przez internet bez stałego IP, bez przekierowania portów i bez zmian w routerze. Wszystkie dotychczas skonfigurowane usługi (`svl-coreos2`, `svl-python-os`, `svl-gateway`, `svl-sentinel`, `ollama`, `svl-ship-ollama-tunnel`, `svl-comfyui`, `ssh`, `docker`) pozostają nienaruszone i są w pełni dostępne przez MCP.

## Jak działa połączenie bez stałego IP (Zero-IP / Mesh)

`MCP_TUNNEL="auto"` automatycznie dobiera najlepszy działający transport i wykrywa sieci overlay/mesh:

| Tryb `MCP_TUNNEL` | Konto | Adres | Charakterystyka |
|---|---|---|---|
| `auto` (zalecany) | auto | HTTPS + Mesh IP | Kolejność: nazwany Cloudflare → Tailscale Funnel → Cloudflare Quick Tunnel → ngrok → `ssh-reverse`. Dodatkowo wykrywa interfejsy mesh (Tailscale `100.64.0.0/10`, ZeroTier `zt*`, WireGuard `wg*`, Hamachi `25.x`). |
| `cloudflared` | nie (Quick) / Cloudflare (Named) | `https://<losowe>.trycloudflare.com/mcp` lub stała domena | Działa za każdym NAT/CGNAT; jeśli UDP 7844 jest zablokowany, watchdog automatycznie przełącza na `--protocol http2` (TCP 443). |
| `tailscale` | Tailscale (darmowe) | stały `https://<host>.<tailnet>.ts.net/mcp` + `http://100.x.y.z:3334/mcp` | Najbliższy odpowiednik nowoczesnego Hamachi: szyfrowana sieć mesh WireGuard + publiczny HTTPS Funnel bez stałego IP. |
| `ngrok` | ngrok (darmowe) | darmowa stała domena (`MCP_PUBLIC_URL`) | Wymaga `ngrok config add-authtoken …`. |
| `ssh-reverse` | własny serwer relay | `MCP_PUBLIC_URL` przez `MCP_SSH_REVERSE_TARGET` | Tunel zwrotny `ssh -NT -R` z automatycznym keepalive i ponownym łączeniem. |
| `none` | – | tylko lokalnie (`127.0.0.1:3334`) | Nadal raportuje wykryte lokalne adresy mesh. |

## Narzędzia Universal MCP Hub (`src/mcp/tools.ts` — 27 narzędzi + Resources + Prompts)

| Grupa | Narzędzia | Opis |
|---|---|---|
| Pliki i kod (`MCP_ROOT`) | `read_file`, `list_dir`, `search`, `stat`, `write_file`, `edit_file`, `make_dir`, `move_path`, `delete_path` | Pełny odczyt/zapis w `MCP_ROOT` z ochroną przed wyjściem poza katalog i ucieczką przez symlinki |
| Powłoka i lokalne API | `run_command`, `svl_http_local` | Polecenia bash z limitem czasu oraz kontrolowane żądania HTTP do lokalnych usług (`127.0.0.1` / `localhost`) |
| Usługi systemu | `svl_status`, `svl_services_status`, `svl_service_control` | Status i sterowanie wszystkimi usługami (`svl-coreos2`, `svl-python-os`, `svl-gateway`, `svl-sentinel`, `svl-mcp`, `svl-comfyui`, `svl-ship-ollama-tunnel`, `ollama`, `tailscaled`, `cloudflared`, `docker`, `ssh`) |
| AI, czat i pamięć | `svl_chat`, `svl_conversation`, `svl_memory_search`, `svl_memory_add` | Czat przez JEDI Omni-OS v12 / Dual-Ollama / Gemini (`Jyn`, `SI_Sphere`, `JEDI_Omni_OS`) i pamięć 128D + SQLite |
| Dual-Ollama i ComfyUI | `svl_ollama`, `svl_comfyui` | Router Dual-Ollama (lokalna + SVL-364), lista/pobieranie modeli, tunel SSH Ollamy oraz status/kolejka ComfyUI |
| Host SVL-364 (SSH + MCP) | `svl_ship_telemetry`, `svl_ship_ssh`, `svl_ship_manage` | Telemetria, mostek SSH oraz pełne narzędzia SVL-364 (`svl364_resources`, `svl364_service_control`, `svl364_ollama_control`, `svl364_file_control`, `svl364_network_control`, `svl364_update_control`, `svl364_tunnel_control`, `svl364_container_control`, `svl364_comfyui_control`, `svl364_emit_system_report`) |
| Terminale, GitHub, bezpieczeństwo, logi | `svl_terminal`, `svl_github`, `svl_security_report`, `svl_logs`, `mcp_info` | Wszystkie terminale SVL, synchronizacja i `gh` dla `Rush47/SVL_Core`, antywirus SVL-365, raporty, logi i stan tunelu |

Dodatkowo serwer udostępnia **MCP Resources** (`svl://mcp/info`, `svl://services/catalog`, `svl://system/status`, `svl://ship/telemetry`, `svl://logs/system`) oraz **MCP Prompts** (`svl_full_audit`, `svl_ship_diagnostics`, `svl_zero_ip_check`).

## Bezpieczeństwo

- Każde żądanie `/mcp` wymaga tokenu: `Authorization: Bearer <MCP_TOKEN>` (lub `X-MCP-Token`), a dla klientów bez nagłówków `/mcp/k/<MCP_TOKEN>` (`MCP_ALLOW_URL_TOKEN=0` wyłącza wariant URL).
- Brak `MCP_TOKEN` w `.env` → token generuje się automatycznie do `data/svl_mcp_token.secret` (`0600`) i jest maskowany w logach.
- `MCP_READ_ONLY=1` ukrywa i blokuje wszystkie narzędzia modyfikujące. `MCP_ALLOW_SHELL=0` wyłącza `run_command` i modyfikacje usług systemd.
- Serwer nasłuchuje wyłącznie na `127.0.0.1:3334` — ruch z internetu przechodzi wyłącznie przez szyfrowany tunel wychodzący.

## Instalacja na hoście systemu oraz na hoście SVL-364

### 1. Host systemu (`/opt/svl-python-os`)
```bash
sudo bash deploy/install-mcp.sh /opt/svl-python-os svlos
# Opcjonalnie również z Tailscale (sieć mesh jak Hamachi + stały HTTPS):
sudo SVL_INSTALL_TAILSCALE=1 bash deploy/install-mcp.sh /opt/svl-python-os svlos
sudo svl-mcp-info
```

### 2. Host SVL-364 (bez reinstalacji i bez przerywania istniejących usług)
```bash
sudo bash SVL_CoreOS_2/debian13/install_svl364_mcp_zeroip.sh
# Z siecią mesh Tailscale (stały adres jak Hamachi):
sudo SVL_INSTALL_TAILSCALE=1 bash SVL_CoreOS_2/debian13/install_svl364_mcp_zeroip.sh
sudo svl-mcp-info
```

Pełny instalator `SVL_CoreOS_2/debian13/install_coreos2_svl364.sh` również domyślnie instaluje i uruchamia `svl-mcp.service` (`SVL_INSTALL_MCP=1`).

## Podgląd na żywo i konfiguracja klientów

- W interfejsie webowym SVL: zakładka **SVL-364 → Mostek SSH i serwer MCP** (odczytuje `GET /api/mcp/hub/status` i `GET /api/mcp/hub/connector`).
- Z terminala hosta: `sudo svl-mcp-info` albo `cat data/svl_mcp_tunnel.json`.
- Gotowe sekcje JSON w `data/svl_mcp_connector.secret`: `geminiCli`, `vscodeCopilot`, `genericStreamableHttp`, `meshUrls`, `urlWithKey`.
