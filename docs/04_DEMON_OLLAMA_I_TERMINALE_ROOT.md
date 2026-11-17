# 04. Ollama i Terminale ROOT (`SVL-364`)

## 1. Ollama (`backend/ollama_daemon.py`)

Aplikacja korzysta wyłącznie z **prawdziwej Ollamy**. Jeśli na `127.0.0.1:11434` nic nie nasłuchuje, a w systemie jest
zainstalowany program `ollama` (plik ELF), backend uruchamia `ollama serve`. W przeciwnym razie nic nie udaje Ollamy —
czat, Real Vision i zadania agentów zgłaszają wtedy błąd z powodem.

Wcześniejsze wersje uruchamiały zastępczy serwer HTTP (wersja `0.6.4-svl-364-apex`) z wymyśloną listą modeli
i gotowymi odpowiedziami oraz fałszywe polecenie `ollama`. Zostały usunięte; stare kopie polecenia są sprzątane przy starcie.

Instalacja: https://ollama.com, następnie `ollama pull llama3.2-vision:11b`.

## 2. Terminale Systemowe i Zdalny SSH

Terminal **SSH · Ship** używa aliasu OpenSSH z `SVL_SSH_TARGET` (domyślnie `Ship`) i konfiguracji/uwierzytelniania konta uruchamiającego backendu. Host alias musi być skonfigurowany w `~/.ssh/config`; system nie generuje kluczy ani nie zakłada użytkownika `root`.

Każde polecenie w terminalu SSH wymaga potwierdzenia operatora i jest przekazywane jako polecenie powłoki na wskazany host. Połączenie działa bez PTY; brak SSH, błąd uwierzytelnienia lub nieznany host kończy się błędem — polecenie nigdy nie przełącza się na lokalny shell. Wywołania Ollama/MCP nie mogą uruchamiać poleceń SSH.

Pozostałe terminale (Linux, Python, hyperspace i agenci) zachowują swoje dotychczasowe lokalne funkcje. Polecenie `/exec raport systemu` nadal generuje raport `SVL_System`; nie jest specjalnie przechwytywane w terminalu SSH, gdzie każde wpisane polecenie trafia na host `Ship`.
