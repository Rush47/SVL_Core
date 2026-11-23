# Lokalne modele Qwen i silnik obrazów

## Grok (xAI) — główny silnik czatu

Gdy w `.env` (albo w zmiennych środowiska usługi) ustawisz `XAI_API_KEY`, brama SVL używa **Grok** (`https://api.x.ai/v1/chat/completions`, domyślny model `grok-4.7`) jako **głównego** silnika rozmów. To jest płatne API xAI — klucz zostaje wyłącznie po stronie serwera i nie jest logowany.

Jeśli klucza nie ma, jest pusty albo wygląda na placeholder, albo wywołanie API zwróci błąd (w tym 403 z powodu braku kredytów / limitu wydatków), system wraca do **darmowej lokalnej Ollamy**, a następnie — gdy skonfigurowano `GEMINI_API_KEY` — do Gemini. Kolejność w `/api/chat` i w rozmowie obustronnej: Grok → Ollama → Gemini.

```bash
# w .env na hoście z bramą SVL
XAI_API_KEY="wstaw_klucz_z_console.x.ai"
XAI_MODEL="grok-4.7"      # opcjonalnie
XAI_TIMEOUT_MS="60000"    # opcjonalnie, ms na jedną próbę
```

Status silnika widać na karcie silników AI (`GET /api/ai/engines`). Po zmianie `.env` uruchom ponownie gateway. Brak kredytów na koncie xAI jest zgłaszany jako `Grok: brak kredytów na koncie xAI` i nie jest ponawiany.

Konfiguracja dodaje model tekstowy Qwen 3.8 27B do Ollama oraz Qwen Image 2.1 w ComfyUI. Instalator przeznaczony jest dla Debian 13 z działającym sterownikiem NVIDIA i wcześniej zainstalowanym Ollama/SVL.

## Wymagania hosta

- NVIDIA GPU; dla obrazów zalecane co najmniej 24 GB VRAM.
- Co najmniej 48 GB RAM i 100 GB wolnego miejsca na dysku.
- Zainstalowany sterownik NVIDIA, `nvidia-smi`, Ollama oraz konto systemowe `svlos` (tworzone przez `install-debian13.sh`).
- Modele zużywają około 38 GB na dysku: Qwen 3.8 Q5_K_M (~20,7 GB), transformer obrazu FP8 (~7,1 GB), encoder INT8 (~9,4 GB) i VAE BF16 (~0,7 GB). Ollama przechowuje dodatkową kopię GGUF.

## Instalacja natywna

Z katalogu głównego repozytorium na docelowym komputerze:

```bash
sudo ./deploy/install-debian13.sh
sudo ./deploy/install-ai-engines.sh
```

Drugi skrypt pobiera wybrane warianty z weryfikacją SHA-256, importuje model Q5_K_M do Ollama, instaluje ComfyUI (commit `b0b7435`, wskazany jako przetestowany w karcie modelu) z PyTorch CUDA 12.8 i uruchamia `svl-comfyui.service`. Następnie sprawdza odpowiedź Ollama i wykonuje rzeczywiste generowanie testowego PNG przez API aplikacji; plik trafia do `/var/lib/svl-os/generated/qwen-image-smoke-test.png`.

Wybrany wariant Q5_K_M jest standardowym GGUF, nie MTP: zapewnia lepszą zgodność z Ollama niż wariant spekulacyjnego dekodowania. Dla obrazu używany jest transformer FP8 ComfyUI, encoder INT8 ConvRot i VAE BF16. Workflow bazuje na zalecanych ustawieniach modelu: 35 kroków, CFG 5, sampler `er_sde`, scheduler `simple`, rozdzielczość 1024×1024.

## Docker Compose

Po instalacji modeli uruchom profil graficzny:

```bash
docker compose -f deploy/docker-compose.yml --profile image up -d --build
```

Profil `image` wymaga NVIDIA Container Toolkit. Nie uruchamiaj go równolegle z natywną usługą ComfyUI na tym samym GPU. Gdy ComfyUI jest offline, status pojawi się w `/api/py/health`; czat pokazuje stan silnika przy przycisku **Generuj obraz**.

## Weryfikacja

```bash
curl -fsS http://127.0.0.1:8085/api/py/health
systemctl status svl-comfyui.service
ollama list
```

Test generowania obrazu wykonuje instalator. Można go powtórzyć przyciskiem **Generuj obraz** w czacie. Generowanie wymaga działającego ComfyUI oraz pobranych modeli; sama odpowiedź `/system_stats` potwierdza tylko dostępność API, nie zakończone wnioskowanie.

## Silnik obrazu na CPU

Opcjonalny silnik `stable-diffusion.cpp` używa SD-Turbo Q4 z Hugging Face zamiast ComfyUI/Qwen Image. Instalator pobiera oficjalne binaria CPU z wersji Ubuntu 24.04 przypiętej do rewizji użytej do konwersji GGUF oraz weryfikuje sumy SHA-256 silnika i modelu.

```bash
./deploy/install-sd-turbo-cpu.sh
```

W `.env` ustaw `SVL_IMAGE_ENGINE="stable-diffusion.cpp"` i uruchom ponownie gateway/backend. Domyślna rozdzielczość to 512×512; można wybrać wymiary od 256 do 512, będące wielokrotnością 64. Czat blokuje uruchomienie, gdy dostępna RAM spada poniżej 4 GiB. Model waży ok. 1,85 GB, a jego karta zaleca co najmniej 4 GB RAM; na CPU generowanie może być powolne. SD-Turbo nie jest na karcie oznaczony jako jawnie uncensored i podlega Stability AI Community License oraz Acceptable Use Policy.

## Trwałość promptów, pamięci i konfiguracji

Konfiguracje agentów (w tym edytowane prompty systemowe), wpisy pamięci i historia rozmów są przechowywane w bazie SQLite. Instalacja natywna używa `/var/lib/svl-os/svl_os.sqlite3`; Docker Compose zapisuje bazę w wolumenie `svl-os-data`. Nie usuwaj tego katalogu ani wolumenu podczas aktualizacji. Ścieżki względne `SVL_SQLITE_PATH` są rozwiązywane względem katalogu repozytorium, a nie bieżącego katalogu procesu.

Edytuj prompty w panelu Agentów i zatwierdź przyciskiem zapisu; restart zachowuje je teraz zamiast przywracać wbudowany tekst domyślny. Przed migracją lub reinstalacją wykonaj kopię SQLite, np.:

```bash
sudo sqlite3 /var/lib/svl-os/svl_os.sqlite3 \
  ".backup '/var/lib/svl-os/svl_os.sqlite3.backup'"
```
