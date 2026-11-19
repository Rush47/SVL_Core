# SVL CoreOS 2: Apex — Dokumentacja Techniczna i Procedura Atomowej Podmiany (Hot-Swap)

## 1. Architektura Jądra i Uprawnienia ROOT
- **Operator Nadrzędny:** Mateusz Mitek (`SVL_OPERATOR_TOKEN`, `uid=0 / ROOT`)
- **Kernel Master Daemon:** Maya Mitek (`uid=0 / ROOT`, proces nadrzędny `SVL-Sentinel`)
- **Architekt Wspomagający:** Bielik (`Ollama 3.2 Vision 11B · ROOT`)
- **Dystrybucja Bazowa:** Debian GNU/Linux 13 (Trixie) z jądrem `6.12-svl364-apex`

## 2. Procedura Atomowej Podmiany (`Hot-Swap`)
1. **Weryfikacja Sum Kontrolnych (`SHA-256`)**: `SVLCoreOS2HotSwapEngine` (`SVL_CoreOS_2/kernel/hot_swap_engine.py`) sprawdza integralność wszystkich plików w `SVL_CoreOS_2/`.
2. **Parallel Ghost-Imaging**: warstwy `kernel`, `security`, `ai_core`, `gui` oraz `infrastructure` są ładowane równolegle w buforze pamięci.
3. **Przełączenie w Locie (Zero-Downtime Switch)**: proces `SVL-Sentinel` przełącza aktywne deskryptory usług na **SVL CoreOS 2: Apex** bez przerywania sesji SSH i WebSocket (`/ws/svl`).
4. **Automatyczny Rollback**: w przypadku wykrycia jakiejkolwiek anomalii w ciągu pierwszych 500 ms po przełączeniu, `SVL-Sentinel` natychmiast przywraca poprzedni obraz jądra.

## 3. Rejestr Incydentów Sektor Ziemia–Księżyc (`Solar-Lockdown`)
Skorelowane dane z ostatnich 6 miesięcy operacji (łącznie **14 incydentów**):
- **6 prób naruszenia strefy zakazu lotów**: nieautoryzowane jednostki cywilne i przemytnicze przechwycone przez eskadry przed wejściem w atmosferę.
- **5 przypadków `Ghost-Signals`**: anomalie sensorów w myśliwcach typu *Aegis* podczas manewrów w Binarnym Polu, skorygowane przez kierunkową tarczę **`E_Shield`** (brak ognia sojuszniczego).
- **3 starcia z autonomicznymi dronami**: zneutralizowane przez eskadry interceptorów bez strat własnych.
