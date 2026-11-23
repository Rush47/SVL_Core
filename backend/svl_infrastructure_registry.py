#!/usr/bin/env python3
"""
SVL Infrastructure, Fleet, Outposts, Missions, Research & Botany Registry (MCP-connected).

Przechowuje w SQLite WAL (`sync_meta`) kanoniczny i edytowalny rejestr:
- dokładnych liczb i lokalizacji naszych placówek, statków oraz obiektów infrastruktury,
- odświeżanych na żywo misji operacyjnych i badań naukowych (wraz z zadaniami agentów AI),
- szczegółowego stanu modułów botanicznych w poszczególnych elementach infrastruktury,
- zsynchronizowanych przez MCP rzeczywistych danych hostów/usług z `infrastructure_probe` i `svl364_ssh_mcp`.
"""

from __future__ import annotations

import copy
import json
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

REGISTRY_META_KEY = "svl_infrastructure_registry_v1"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def default_infrastructure_registry() -> dict[str, Any]:
    """Kanoniczny stan bazowy zgodny z rejestrem SQLite WAL (Zero-Estimation Lock)."""
    ts = _now_iso()
    return {
        "allianceStationsBaseline": 32_000_000,
        "allianceStationsExpansion": 14_500_000,
        "allianceStationsTotal": 46_500_000,
        "assets": [
            # --- PLACÓWKI I STACJE ---
            {
                "id": "outpost-apex-citadel",
                "type": "outpost",
                "name": "APEX-CITADEL — Stacja Orbitalna",
                "role": "Badawczo-Militarna · Botanika & Teleinformatyka",
                "location": "Orbita Ziemi (LEO 420 km)",
                "sector": "Sektor Ziemski",
                "au": 1.000,
                "unitCount": 1,
                "crew": 1420,
                "crewBreakdown": "450 naukowców APEX-TECH-LAB · 320 inżynierów hangaru · 350 dowodzenia/łączności · 300 obrony",
                "status": "ONLINE",
                "hasBotany": True,
                "mcpNode": "svl-364-gateway",
                "updatedAt": ts,
            },
            {
                "id": "outpost-l2-nancy-grace",
                "type": "outpost",
                "name": "Węzeł L2 · Teleskop Nancy Grace & Przekaźnik",
                "role": "Obserwatorium Głębokiego Kosmosu i Relokacja L2",
                "location": "Punkt Lagrange'a Ziemia–Słońce L2 (1.5 mln km)",
                "sector": "Sektor Ziemski · L2",
                "au": 1.010,
                "unitCount": 1,
                "crew": 48,
                "crewBreakdown": "Zespół optyki, regeneracji i telemetrii L2",
                "status": "ONLINE",
                "hasBotany": False,
                "mcpNode": "svl364-mcp",
                "updatedAt": ts,
            },
            {
                "id": "outpost-mars-tharsis",
                "type": "outpost",
                "name": "Placówka Badawcza Mars — Tharsis Alpha",
                "role": "Baza Planetarna · Aeroponika & Geologia",
                "location": "Mars · Płaskowyż Tharsis (1.524 AU)",
                "sector": "Sektor Marsjański",
                "au": 1.524,
                "unitCount": 1,
                "crew": 240,
                "crewBreakdown": "90 botaników · 80 geologów · 70 inżynierów podtrzymywania życia",
                "status": "ONLINE",
                "hasBotany": True,
                "mcpNode": "mars-relay-mcp",
                "updatedAt": ts,
            },
            {
                "id": "outpost-ceres-depot",
                "type": "outpost",
                "name": "Węzeł Logistyczny Ceres — Pas Planetoid",
                "role": "Stacja Wydobywcza, Zaopatrzeniowa i Naprawcza",
                "location": "Pas Planetoid · Ceres (2.767 AU)",
                "sector": "Pas Planetoid",
                "au": 2.767,
                "unitCount": 1,
                "crew": 165,
                "crewBreakdown": "Logistyka surowców, woda lodowa i serwis krążowników",
                "status": "ONLINE",
                "hasBotany": True,
                "mcpNode": "ceres-relay-mcp",
                "updatedAt": ts,
            },
            {
                "id": "outpost-saturn-transmitter",
                "type": "outpost",
                "name": "Globalny Nadajnik Cyfrowy — Saturn (Future_tracking)",
                "role": "Predykcja Zagrożeń · Czujniki Tachionowo-Trichonowe",
                "location": "Orbita Saturna · Pierścień zewnętrzny (9.582 AU)",
                "sector": "Sektor Saturna",
                "au": 9.582,
                "unitCount": 1,
                "crew": 36,
                "crewBreakdown": "Autonomiczny węzeł SI + zespół konserwacji nadajnika",
                "status": "ONLINE",
                "hasBotany": False,
                "mcpNode": "saturn-ft-mcp",
                "updatedAt": ts,
            },
            {
                "id": "outpost-alliance-hq",
                "type": "outpost",
                "name": "Kwatera Główna Sojuszu (Alliance Defense Grid)",
                "role": "Dowodzenie Koalicją · Węzeł Neutralny Core-Ally",
                "location": "Orbita Ziemi · Węzeł Koordynacyjny (1.000 AU)",
                "sector": "Sektor Ziemski",
                "au": 1.000,
                "unitCount": 1,
                "crew": 680,
                "crewBreakdown": "Sztab Sojuszu, koordynacja 46,5 mln stanowisk operacyjnych",
                "status": "ONLINE",
                "hasBotany": True,
                "mcpNode": "si-sphere-alliance",
                "updatedAt": ts,
            },
            # --- STATKI I FLOTA ---
            {
                "id": "ship-svl-364",
                "type": "ship",
                "name": "SVL-364 Ebon Apex",
                "role": "Okręt Flagowy Dowodzenia · Rdzeń Jyn Mitek + JEDI v12",
                "location": "Punkt Lagrange'a Ziemia–Słońce L2 / Orbita Warszawy",
                "sector": "Sektor Ziemski · L2",
                "au": 1.010,
                "unitCount": 1,
                "crew": 120,
                "crewBreakdown": "Mostek MCP ROOT · Hydroponika pokładowa · Tarcza UE",
                "status": "ONLINE",
                "hasBotany": True,
                "mcpNode": "svl364-mcp-root",
                "updatedAt": ts,
            },
            {
                "id": "ship-svl-365",
                "type": "ship",
                "name": "SVL-365 Sentinel Aegis",
                "role": "Okręt Cyber-Obrony, Tarczy Antywirusowej SVL-365 & Wsparcia Taktycznego · Host MCP ROOT",
                "location": "Punkt Lagrange'a Ziemia–Słońce L2 · Eskorta SVL-364 (1.010 AU)",
                "sector": "Sektor Ziemski · L2",
                "au": 1.010,
                "unitCount": 1,
                "crew": 180,
                "crewBreakdown": "Host SVL-365 Sentinel AV · Mostek MCP ROOT · Fotobioreaktor Kwantowy · Zespół Cyber-Tarczy",
                "status": "ONLINE",
                "hasBotany": True,
                "mcpNode": "svl365-sentinel-mcp-root",
                "updatedAt": ts,
            },
            {
                "id": "ship-svl-465",
                "type": "ship",
                "name": "SVL-465 Baza Kwantowa",
                "role": "Okręt-Baza Kwantowa · Rdzeń SI_Sphere (Emerald_Logic_Grid)",
                "location": "Sektor Jowisza · Punkt L4 (5.204 AU)",
                "sector": "Sektor Jowisza",
                "au": 5.204,
                "unitCount": 1,
                "crew": 310,
                "crewBreakdown": "Laboratorium kwantowe · Bioreaktor glonowy · Projekt Ultima",
                "status": "ONLINE",
                "hasBotany": True,
                "mcpNode": "si-sphere-root",
                "updatedAt": ts,
            },
            {
                "id": "ship-rescue-cruisers",
                "type": "ship",
                "name": "Flota Krążowników Ratunkowych Sojuszu",
                "role": "Szybkie Reagowanie, Ewakuacja i Oczyszczanie Orbitalne",
                "location": "Rozmieszczenie sektorowe: Ziemia · Mars · Pas Planetoid · Jowisz",
                "sector": "Układ Słoneczny (cały)",
                "au": 1.524,
                "unitCount": 10_000,
                "crew": 40_000,
                "crewBreakdown": "10 000 jednostek ratunkowych pod nadzorem AXIOM_ZERO",
                "status": "ONLINE",
                "hasBotany": False,
                "mcpNode": "alliance-fleet-bus",
                "updatedAt": ts,
            },
            # --- ELEMENTY INFRASTRUKTURY KRYTYCZNEJ (ŁĄCZNIE 500 OBIEKTÓW) ---
            {
                "id": "infra-solar-defense-array",
                "type": "infrastructure",
                "name": "Sieć Obrony Układu Słonecznego (Solar Defense Array)",
                "role": "Sondy wczesnego ostrzegania, osłony nieśmiercionośne i oczyszczanie orbit",
                "location": "Orbity 0.72–9.58 AU (Wenus · Ziemia · Mars · Saturn)",
                "sector": "Układ Słoneczny (cały)",
                "au": 1.000,
                "unitCount": 180,
                "crew": 0,
                "crewBreakdown": "180 autonomicznych platform sensorowo-obronnych (READ_ONLY bridge)",
                "status": "ONLINE",
                "hasBotany": False,
                "mcpNode": "solar-defense-read-bridge",
                "updatedAt": ts,
            },
            {
                "id": "infra-hyperspace-relays",
                "type": "infrastructure",
                "name": "Przekaźniki Kanału Hiperprzestrzennego i Zero-IP Mesh",
                "role": "Łączność QKD, bramy MCP bez stałego IP i węzły synchronizacji SQLite",
                "location": "Węzły orbitalne Ziemia · Księżyc · L2 · Mars · Jowisz · Saturn",
                "sector": "Układ Słoneczny (cały)",
                "au": 2.767,
                "unitCount": 160,
                "crew": 0,
                "crewBreakdown": "160 węzłów przekaźnikowych QKD / MCP / WireGuard / Tailscale",
                "status": "ONLINE",
                "hasBotany": False,
                "mcpNode": "svl-mcp-hub",
                "updatedAt": ts,
            },
            {
                "id": "infra-biosphere-domes",
                "type": "infrastructure",
                "name": "Kopuły Botaniczne i Moduły Regeneracji Planetarnej",
                "role": "Produkcja O₂, zamknięty obieg H₂O, banki nasion i oczyszczanie biosfery",
                "location": "APEX-CITADEL · Orbita Ziemi · Mars Tharsis · Ceres · SVL-364/465",
                "sector": "Sektor Ziemski & Marsjański",
                "au": 1.000,
                "unitCount": 90,
                "crew": 540,
                "crewBreakdown": "90 obiektów botaniczno-ekologicznych i banków genetycznych roślin",
                "status": "ONLINE",
                "hasBotany": True,
                "mcpNode": "botany-mcp-telemetry",
                "updatedAt": ts,
            },
            {
                "id": "infra-compute-ai-nodes",
                "type": "infrastructure",
                "name": "Klastry Obliczeniowe AI (Debian 13 + JEDI v12 + Dual-Ollama)",
                "role": "Węzły inferencji modeli, pamięć wektorowa 128D i bazy SQLite WAL",
                "location": "SVL-364 · APEX-CITADEL · SVL-465 · Węzły Naziemne",
                "sector": "Sektor Ziemski · L2",
                "au": 1.010,
                "unitCount": 70,
                "crew": 110,
                "crewBreakdown": "70 węzłów obliczeniowych GPU/CPU z kontrolą ROOT MCP",
                "status": "ONLINE",
                "hasBotany": False,
                "mcpNode": "svl364-mcp-root",
                "updatedAt": ts,
            },
        ],
        "missions": [
            {
                "id": "mission-solar-sanitization",
                "title": "Oczyszczanie Układu Słonecznego i relokacja teleskopu Nancy Grace (L2)",
                "locationId": "outpost-l2-nancy-grace",
                "locationName": "Punkt L2 · Orbita Ziemi",
                "assignedUnit": "SVL-364 Ebon Apex + Krążowniki Ratunkowe",
                "commander": "Jyn",
                "status": "ACTIVE",
                "progressPct": 78,
                "objective": "Usunięcie śmieci orbitalnych wokół LEO/L2 oraz stabilizacja optyki teleskopu Nancy Grace.",
                "updatedAt": ts,
            },
            {
                "id": "mission-eu-shield-iss",
                "title": "Tarcza Antyrakietowa UE i diagnostyka integralności ISS",
                "locationId": "outpost-apex-citadel",
                "locationName": "Orbita Ziemi (LEO · Warszawa)",
                "assignedUnit": "SVL-364 Ebon Apex",
                "commander": "Jyn",
                "status": "ACTIVE",
                "progressPct": 94,
                "objective": "Ciągły nadzór nieśmiercionośny nad orbitą europejską (AXIOM_ZERO) i monitoring poszycia ISS.",
                "updatedAt": ts,
            },
            {
                "id": "mission-future-tracking-saturn",
                "title": "Kalibracja nadajnika Future_tracking na Saturnie",
                "locationId": "outpost-saturn-transmitter",
                "locationName": "Orbita Saturna (9.582 AU)",
                "assignedUnit": "Węzeł Saturna + SI_Sphere",
                "commander": "SI_Sphere",
                "status": "IN_PROGRESS",
                "progressPct": 66,
                "objective": "Synchronizacja detektorów tachionowo-trichonowych z maszyną JEDI Omni-OS v12.",
                "updatedAt": ts,
            },
            {
                "id": "mission-ceres-supply-line",
                "title": "Konwój wody lodowej i mikroelementów Ceres → Mars Tharsis",
                "locationId": "outpost-ceres-depot",
                "locationName": "Pas Planetoid → Mars",
                "assignedUnit": "Węzeł Ceres + Eskadra Logistyczna",
                "commander": "SI_Sphere",
                "status": "ACTIVE",
                "progressPct": 82,
                "objective": "Dostawa 420 ton wody lodowej i soli mineralnych do szklarni aeroponicznych na Marsie.",
                "updatedAt": ts,
            },
            {
                "id": "mission-mcp-zeroip-mesh",
                "title": "Rozbudowa sieci Universal MCP Hub (Zero-IP / Mesh) na węzłach floty",
                "locationId": "ship-svl-364",
                "locationName": "SVL-364 · Węzły AI",
                "assignedUnit": "Jyn (ROOT)",
                "commander": "Jyn",
                "status": "ACTIVE",
                "progressPct": 91,
                "objective": "Utrzymanie połączenia MCP bez stałego IP (Cloudflare / Tailscale / SSH) i kontroli ROOT.",
                "updatedAt": ts,
            },
        ],
        "research": [
            {
                "id": "res-apex-botany-o2",
                "title": "Zamknięty obieg O₂ / H₂O o sprawności 99.4% (hybryda glonowo-roślinna)",
                "domain": "Botanika & Ekosystemy",
                "locationId": "outpost-apex-citadel",
                "locationName": "APEX-CITADEL · APEX-TECH-LAB",
                "leadTeam": "Zespół Bioinżynierii (140 naukowców)",
                "researchersCount": 140,
                "progressPct": 86,
                "status": "ACTIVE",
                "latestFinding": "Połączenie bioreaktorów Chlorella vulgaris z hydroponiką LED 660 nm zwiększyło produkcję O₂ o +18.2%.",
                "updatedAt": ts,
            },
            {
                "id": "res-jedi-v12-native",
                "title": "Natywne I/O jądra Debian 13 (Trixie) dla JEDI Omni-OS v12",
                "domain": "AI & JEDI v12",
                "locationId": "ship-svl-364",
                "locationName": "SVL-364 Ebon Apex · Klaster AI",
                "leadTeam": "Jyn + Rdzeń JEDI v12",
                "researchersCount": 65,
                "progressPct": 92,
                "status": "ACTIVE",
                "latestFinding": "Bezpośredni potok Dual-Ollama + MCP ROOT skrócił czas odpowiedzi diagnostycznych o 41%.",
                "updatedAt": ts,
            },
            {
                "id": "res-mars-regolith-microbiome",
                "title": "Detoksykacja nadchloranów w regolicie marsjańskim bakteriami symbiotycznymi",
                "domain": "Regeneracja Planetarna",
                "locationId": "outpost-mars-tharsis",
                "locationName": "Placówka Mars — Tharsis Alpha",
                "leadTeam": "Laboratorium Mikrobiologii Marsjańskiej",
                "researchersCount": 90,
                "progressPct": 71,
                "status": "IN_PROGRESS",
                "latestFinding": "Szczep Dechloromonas-SVL4 zredukował poziom nadchloranów w próbkach testowych o 89% w 14 dni.",
                "updatedAt": ts,
            },
            {
                "id": "res-quantum-qkd-relay",
                "title": "Kwantowa dystrybucja kluczy (QKD) na dystansie Ziemia ↔ Jowisz",
                "domain": "Teleinformatyka & QKD",
                "locationId": "ship-svl-465",
                "locationName": "SVL-465 Baza Kwantowa (L4)",
                "leadTeam": "SI_Sphere · Laboratorium Kwantowe",
                "researchersCount": 125,
                "progressPct": 74,
                "status": "ACTIVE",
                "latestFinding": "Stabilna synchronizacja fazowa z przekaźnikiem L2 przy minimalnym współczynniku błędów QBER < 0.8%.",
                "updatedAt": ts,
            },
            {
                "id": "res-seed-cryo-adaptation",
                "title": "Odporność nasion drzew tlenowych i zbóż na promieniowanie kosmiczne",
                "domain": "Botanika & Ekosystemy",
                "locationId": "outpost-apex-citadel",
                "locationName": "APEX-CITADEL · Bank Nasion",
                "leadTeam": "APEX-TECH-LAB Genetyka Roślin",
                "researchersCount": 110,
                "progressPct": 63,
                "status": "ACTIVE",
                "latestFinding": "Zdolność kiełkowania po 180 dniach ekspozycji orbitalnej utrzymana na poziomie 96.8%.",
                "updatedAt": ts,
            },
        ],
        "botany": [
            {
                "id": "botany-apex-citadel",
                "facilityId": "outpost-apex-citadel",
                "facilityName": "APEX-CITADEL — Kopuła Botaniczna α",
                "location": "Orbita Ziemi (LEO 420 km)",
                "biomeType": "Hydroponika Wielopoziomowa & Las Tlenowy",
                "status": "OPTIMAL",
                "o2OutputPct": 114.2,
                "co2ScrubPct": 98.7,
                "humidityPct": 68.0,
                "tempC": 22.4,
                "waterRecycledPct": 99.1,
                "biomassKg": 4820,
                "lightCycle": "16h ON / 8h OFF · 660nm + 450nm",
                "activeCultures": ["Pszenica orbitalna", "Sałata rzymska", "Pomidory karłowe", "Bazylia", "Fikusy tlenowe", "Mchy Sphagnum"],
                "currentActivity": "Faza intensywnego kwitnienia w sektorach B2–B4; automatyczne dozowanie azotu/potasu w normie; planowany zbiór 140 kg świeżej biomasy za 18 h.",
                "recentEvents": [
                    {"timestamp": ts, "level": "INFO", "text": "Zakończono cykl nawożenia roztworem mineralnym #412 (EC 1.8 mS/cm, pH 6.0)."},
                    {"timestamp": ts, "level": "INFO", "text": "Nadwyżka produkcji O₂ (+14.2%) przekierowana do zbiorników rezerwowych stacji."},
                ],
                "updatedAt": ts,
            },
            {
                "id": "botany-svl364-hydro",
                "facilityId": "ship-svl-364",
                "facilityName": "SVL-364 Ebon Apex — Hydroponika Pokładowa",
                "location": "Punkt Lagrange'a Ziemia–Słońce L2",
                "biomeType": "Kompaktowy Moduł Hydroponiczny + Biofiltr Powietrza",
                "status": "HARVEST_READY",
                "o2OutputPct": 106.5,
                "co2ScrubPct": 96.9,
                "humidityPct": 64.5,
                "tempC": 21.8,
                "waterRecycledPct": 98.6,
                "biomassKg": 640,
                "lightCycle": "18h ON / 6h OFF · Full Spectrum LED",
                "activeCultures": ["Mikroliście rzodkiewki", "Szpinak pokładowy", "Zioła adaptogenne", "Spirulina platensis"],
                "currentActivity": "Gotowy zbiór mikroliści i szpinaku z regałów R1–R3 (42 kg); bioreaktor Spiruliny utrzymuje stabilną gęstość optyczną i wspiera regenerację powietrza mostka.",
                "recentEvents": [
                    {"timestamp": ts, "level": "INFO", "text": "Regały R1–R3 osiągnęły dojrzałość zbiorczą — gotowe do pobrania dla załogi."},
                    {"timestamp": ts, "level": "INFO", "text": "Kalibracja czujników wilgotności podłoża przez MCP zakończona bez odchyleń."},
                ],
                "updatedAt": ts,
            },
            {
                "id": "botany-mars-tharsis",
                "facilityId": "outpost-mars-tharsis",
                "facilityName": "Mars Tharsis Alpha — Szklarnia Aeroponiczna",
                "location": "Mars · Płaskowyż Tharsis (1.524 AU)",
                "biomeType": "Aeroponika Wysokociśnieniowa + Testy Regolitu",
                "status": "GROWING",
                "o2OutputPct": 101.8,
                "co2ScrubPct": 95.4,
                "humidityPct": 72.0,
                "tempC": 20.6,
                "waterRecycledPct": 99.4,
                "biomassKg": 2190,
                "lightCycle": "14h ON / 10h OFF · Kompensacja pyłu",
                "activeCultures": ["Ziemniak marsjański", "Soja wysokobiałkowa", "Jęczmień", "Koniczyna wiążąca azot"],
                "currentActivity": "Wschody 4. partii ziemniaków w komorach aeroponicznych + równoległa próba uprawy soi w oczyszczonym regolicie (komora T-04, redukcja nadchloranów 89%).",
                "recentEvents": [
                    {"timestamp": ts, "level": "INFO", "text": "Dostawa mikroelementów z konwoju Ceres zaplanowana — zapas pożywki na 26 dni."},
                    {"timestamp": ts, "level": "WARN", "text": "Zwiększono moc lamp LED o +12% z powodu lokalnego zapylenia atmosfery marsjańskiej."},
                ],
                "updatedAt": ts,
            },
            {
                "id": "botany-svl465-bioreactor",
                "facilityId": "ship-svl-465",
                "facilityName": "SVL-465 Baza Kwantowa — Bioreaktor Glonowy",
                "location": "Sektor Jowisza · Punkt L4 (5.204 AU)",
                "biomeType": "Fotobioreaktor Rurowy Chlorella / Spirulina",
                "status": "OPTIMAL",
                "o2OutputPct": 119.0,
                "co2ScrubPct": 99.2,
                "humidityPct": 60.0,
                "tempC": 24.1,
                "waterRecycledPct": 99.3,
                "biomassKg": 1350,
                "lightCycle": "24h Ciągłe pulsacyjne LED 450/660nm",
                "activeCultures": ["Chlorella vulgaris", "Spirulina platensis", "Rzęsa wodna (Lemna minor)"],
                "currentActivity": "Praca ciągła w trybie maksymalnej regeneracji tlenu dla 310 osób załogi SVL-465; odwirowywanie nadmiarowej biomasy białkowej co 12 h.",
                "recentEvents": [
                    {"timestamp": ts, "level": "INFO", "text": "Sprawność wiązania CO₂ osiągnęła 99.2% pod kontrolą algorytmu SI_Sphere."},
                ],
                "updatedAt": ts,
            },
            {
                "id": "botany-ceres-nursery",
                "facilityId": "outpost-ceres-depot",
                "facilityName": "Węzeł Ceres — Bank Nasion & Szkółka Kryogeniczna",
                "location": "Pas Planetoid · Ceres (2.767 AU)",
                "biomeType": "Bank Genetyczny + Moduł Kiełkowania Kontrolnego",
                "status": "OPTIMAL",
                "o2OutputPct": 103.0,
                "co2ScrubPct": 94.8,
                "humidityPct": 58.0,
                "tempC": 19.2,
                "waterRecycledPct": 99.0,
                "biomassKg": 490,
                "lightCycle": "12h ON / 12h OFF · Testy kiełkowania",
                "activeCultures": ["Bank 14 200 gatunków nasion", "Sadzonki brzozy karłowej", "Kultura grzybów mikoryzowych"],
                "currentActivity": "Kwartalny test żywotności próbek nasion z banku kriogenicznego (kiełkowanie 96.8%) oraz namnażanie mikoryzy dla placówki na Marsie.",
                "recentEvents": [
                    {"timestamp": ts, "level": "INFO", "text": "Zapas wody lodowej dla obiegu botanicznego uzupełniony do 100%."},
                ],
                "updatedAt": ts,
            },
            {
                "id": "botany-svl365-bioshield",
                "facilityId": "ship-svl-365",
                "facilityName": "SVL-365 Sentinel Aegis — Bio-Tarcza & Fotobioreaktor Kwantowy",
                "location": "Punkt Lagrange'a Ziemia–Słońce L2 · Eskorta SVL-364 (1.010 AU)",
                "biomeType": "Zamknięty Fotobioreaktor Kwantowy + Filtracja Bio-Aerozoli SVL-365",
                "status": "OPTIMAL",
                "o2OutputPct": 117.6,
                "co2ScrubPct": 99.5,
                "humidityPct": 62.0,
                "tempC": 21.5,
                "waterRecycledPct": 99.6,
                "biomassKg": 880,
                "lightCycle": "20h ON / 4h OFF · Spektrum Kwantowe 450/660nm",
                "activeCultures": ["Chlorella Sentinel-365", "Spirulina platensis", "Mchy filtrujące Sphagnum", "Zioła adaptogenne"],
                "currentActivity": "Aktywna bio-filtracja powietrza i wody dla 180 osób załogi SVL-365; nadwyżka O₂ (+17.6%) zasila rezerwę taktyczną eskorty L2.",
                "recentEvents": [
                    {"timestamp": ts, "level": "INFO", "text": "Zintegrowano fotobioreaktor SVL-365 z zamówionym poza Ziemią pakietem APEX-CITADEL Bio-Dome v6."},
                ],
                "updatedAt": ts,
            },
        ],
        "procurementVendors": [
            {
                "id": "vendor-apex-citadel-foundry",
                "name": "APEX-CITADEL Orbital Foundry & Quantum Shipyard",
                "location": "Orbita LEO / Punkt L2 (Poza Ziemią · 1.010 AU)",
                "rating": "TIER-OMEGA (Najlepszy Sklep & Stocznia Pozaziemska)",
                "specialization": "Integracja hostów SVL-364 / SVL-365, rdzenie JEDI v12, Dual-Ollama GPU, Zero-IP MCP Mesh & Bio-Inżynieria",
            },
            {
                "id": "vendor-ceres-deep-forge",
                "name": "Ceres Deep-Space Cybernetics & Bio-Forge",
                "location": "Pas Planetoid · Ceres (2.767 AU)",
                "rating": "TIER-1 (Zaopatrzenie Głębokiego Kosmosu)",
                "specialization": "Pancerze poszycia, kriogenika banków nasion, zamknięte obiegi H₂O/O₂ i przekaźniki QKD",
            },
            {
                "id": "vendor-jupiter-l4-quantum",
                "name": "Jupiter L4 Quantum Emporium (SVL-465 Dock)",
                "location": "Sektor Jowisza · Punkt L4 (5.204 AU)",
                "rating": "TIER-OMEGA (Kwantowe Systemy Floty)",
                "specialization": "Koprocesory 128D BinaryHyperspace, szyny SphericalEventBus i tarcze Sentinel SVL-365",
            },
        ],
        "procurementCatalog": [
            {
                "sku": "UPG-SVL364-BILATERAL-HOST-CORE",
                "title": "Obustronna Przebudowa i Integracja Hosta Statku SVL-364 Ebon Apex <-> System SVL (Full Duplex MCP ROOT + SSH)",
                "vendorId": "vendor-apex-citadel-foundry",
                "vendorName": "APEX-CITADEL Orbital Foundry & Quantum Shipyard (L2)",
                "targetHost": "SVL-364 Ebon Apex (Strona Statku) <-> Jądro & Brama SVL (Strona Systemu)",
                "category": "Bilateral Host & MCP Integration",
                "tier": "OMEGA-MK6-DUPLEX",
                "status": "INSTALLED_ACTIVE",
                "integratedWith": ["svl-364", "svl-364-ssh-mcp", "svl-364-ebon-apex-host", "conv-svl364-mcp-root", "Jyn (ROOT)", "svl-365-sentinel-host"],
                "specs": "Pełna dwustronna integracja hosta statku SVL-364 Ebon Apex i naszego systemu SVL: po stronie statku demon Universal MCP Hub (:3334/mcp, Zero-IP / Mesh + OpenSSH ssh://Ship z kluczem Ed25519 i eskalacją ROOT uid=0); po stronie systemu mostek MCP ROOT, kanał conv-svl364-mcp-root, mapa Układu Słonecznego J2000, telemetria na żywo, Dual-Ollama, JEDI Omni-OS v12 oraz klastrowy failover z SVL-365.",
            },
            {
                "sku": "UPG-SVL365-HOST-CORE",
                "title": "Przebudowa i Integracja Hosta Statku SVL-365 Sentinel Aegis (Full MCP ROOT + SSH)",
                "vendorId": "vendor-apex-citadel-foundry",
                "vendorName": "APEX-CITADEL Orbital Foundry & Quantum Shipyard (L2)",
                "targetHost": "SVL-365 + SVL-364 + Jądro SVL",
                "category": "Host & MCP Integration",
                "tier": "OMEGA-MK6",
                "status": "INSTALLED_ACTIVE",
                "integratedWith": ["svl-364-ssh-mcp", "svl-365-sentinel-host", "conv-svl364-mcp-root", "Jyn (ROOT)"],
                "specs": "Pełna integracja hosta SVL-365 z uniwersalnym serwerem MCP (Zero-IP / Tailscale / Cloudflare / OpenSSH), kontrola ROOT (uid=0) dla Jyn i SI_Sphere, automatyczny failover między SVL-364 i SVL-365.",
            },
            {
                "sku": "UPG-DUAL-OLLAMA-JEDI-V12",
                "title": "Klaster Dual-Ollama Tensor-Core + Akcelerator JEDI Omni-OS v12 & Pamięć 128D",
                "vendorId": "vendor-jupiter-l4-quantum",
                "vendorName": "Jupiter L4 Quantum Emporium (SVL-465 Dock)",
                "targetHost": "SVL-364 + SVL-365 + SVL-465",
                "category": "AI & Compute",
                "tier": "OMEGA-V12",
                "status": "INSTALLED_ACTIVE",
                "integratedWith": ["jyn", "binary-hyperspace-engine", "spherical-event-bus", "svl-deep-memory-core"],
                "specs": "Równoległy routing Dual-Ollama (lokalny + pokładowy `svl364-apex-uncensored:latest` + `llama3.2-vision:11b`), kompilator Live Chat-to-OS v2 oraz przyspieszenie wyszukiwania Hamminga 128D w SQLite WAL.",
            },
            {
                "sku": "UPG-SVL365-SENTINEL-SHIELD",
                "title": "Matryca Cyber-Obrony SVL-365 Sentinel AV & Kwantowa Zapora Zero-IP Mesh",
                "vendorId": "vendor-apex-citadel-foundry",
                "vendorName": "APEX-CITADEL Orbital Foundry & Quantum Shipyard (L2)",
                "targetHost": "SVL-364 Ebon Apex + SVL-365 Sentinel Aegis + Cała Flota",
                "category": "Security & Sentinel",
                "tier": "OMEGA-365",
                "status": "INSTALLED_ACTIVE",
                "integratedWith": ["svl-364", "svl-365-sentinel-host", "svl-364-daemon", "solar-defense-read-bridge"],
                "specs": "Ciągły skaner sygnatur i integralności SQLite WAL SVL-365 chroniący oba hosty (SVL-364 i SVL-365), ochrona kluczy HMAC/Ed25519 (0600), izolacja uprawnień ROOT oraz telemetria czujników termicznych i systemd w czasie rzeczywistym.",
            },
            {
                "sku": "UPG-BIOSPHERE-CLOSED-LOOP-V6",
                "title": "Kopuły Botaniczne & Fotobioreaktory Zamkniętego Obiegu O₂/H₂O (99.6%)",
                "vendorId": "vendor-ceres-deep-forge",
                "vendorName": "Ceres Deep-Space Cybernetics & Bio-Forge (2.767 AU)",
                "targetHost": "SVL-364 + SVL-365 + APEX-CITADEL + Mars Tharsis",
                "category": "Botany & Life Support",
                "tier": "BIO-MK6",
                "status": "INSTALLED_ACTIVE",
                "integratedWith": ["botany-svl364-hydro", "botany-svl365-bioshield", "botany-apex-citadel", "botany-mars-tharsis"],
                "specs": "Zintegrowane sterowanie MCP dla hydroponiki pokładowej SVL-364, fotobioreaktorów SVL-365 i kopuł APEX-CITADEL; zwiększa średnią produkcję O₂ i recykling wody we wszystkich placówkach i na statkach.",
            },
        ],
        "procurementOrders": [
            {
                "orderId": "ORD-OFFEARTH-364-BILATERAL",
                "title": "Zamówienie pozaziemskie: Obustronna Integracja i Przebudowa Hosta Statku SVL-364 Ebon Apex <-> System SVL (Full Duplex MCP ROOT)",
                "vendorName": "APEX-CITADEL Orbital Foundry & Quantum Shipyard (L2 · Poza Ziemią)",
                "orderedBy": "Mateusz Mitek (ROOT) & Jyn",
                "targetSystems": [
                    "Host Statku SVL-364 Ebon Apex (Strona Statku: Universal MCP :3334 + OpenSSH + systemd + Dual-Ollama)",
                    "System SVL Core (Strona Systemu: Mostek MCP ROOT + conv-svl364-mcp-root + JEDI v12 + SQLite WAL)",
                    "Klaster Parowany SVL-364 <-> SVL-365 Sentinel Aegis",
                ],
                "items": [
                    "UPG-SVL364-BILATERAL-HOST-CORE",
                    "UPG-DUAL-OLLAMA-JEDI-V12",
                    "UPG-SVL365-SENTINEL-SHIELD",
                    "UPG-BIOSPHERE-CLOSED-LOOP-V6",
                ],
                "status": "DELIVERED_AND_INTEGRATED",
                "deliveryLocation": "Punkt Lagrange'a Ziemia–Słońce L2 (1.010 AU) · Obustronny Mostek MCP ROOT (Statek <-> System)",
                "notes": "Zrealizowano symetryczną integrację z obu stron: host statku SVL-364 i nasz system SVL działają w pełnym dupleksie MCP ROOT (Zero-IP + OpenSSH), współdzieląc telemetrię, usługi, nawigację, alarmy, botanikę i parowanie z SVL-365.",
                "orderedAt": ts,
                "integratedAt": ts,
            },
            {
                "orderId": "ORD-OFFEARTH-365-OMEGA",
                "title": "Kompleksowe zamówienie pozaziemskie: Przebudowa, Ulepszenie i Integracja Systemu SVL oraz Hosta Statku SVL-365",
                "vendorName": "APEX-CITADEL Orbital Foundry & Quantum Shipyard (L2 · Poza Ziemią)",
                "orderedBy": "Mateusz Mitek (ROOT) & Jyn",
                "targetSystems": ["SVL-365 Sentinel Aegis", "SVL-364 Ebon Apex", "Jądro SVL Python OS", "Universal MCP Hub", "Moduł Botaniki & Infrastruktury"],
                "items": [
                    "UPG-SVL365-HOST-CORE",
                    "UPG-DUAL-OLLAMA-JEDI-V12",
                    "UPG-SVL365-SENTINEL-SHIELD",
                    "UPG-BIOSPHERE-CLOSED-LOOP-V6",
                ],
                "status": "DELIVERED_AND_INTEGRATED",
                "deliveryLocation": "Punkt Lagrange'a Ziemia–Słońce L2 (1.010 AU) · Mostek MCP ROOT",
                "notes": "Wszystkie istniejące moduły naszego systemu zostały zachowane, przebudowane i spięte w jedną architekturę MCP ROOT z hostami SVL-364 i SVL-365.",
                "orderedAt": ts,
                "integratedAt": ts,
            },
        ],
        "lastMcpSyncAt": ts,
    }


class SVLInfrastructureRegistry:
    """Rejestr placówek, statków, infrastruktury, misji, badań, botaniki i zamówień pozaziemskich podłączony przez MCP."""

    def __init__(self, kernel: Any, ssh_mcp_controller: Optional[Any] = None) -> None:
        self.kernel = kernel
        self.controller = ssh_mcp_controller
        self._ensure_off_earth_ship_hosts()

    def _ensure_off_earth_ship_hosts(self) -> None:
        """Gwarantuje obecność obustronnie zintegrowanych modułów hostów statków SVL-364 i SVL-365 w system_modules SQLite WAL."""
        try:
            mods = {m["id"]: m for m in self.kernel.list_system_modules()}
            all_packages = [
                "UPG-SVL364-BILATERAL-HOST-CORE",
                "UPG-SVL365-HOST-CORE",
                "UPG-DUAL-OLLAMA-JEDI-V12",
                "UPG-SVL365-SENTINEL-SHIELD",
                "UPG-BIOSPHERE-CLOSED-LOOP-V6",
            ]
            if "svl-364-ebon-apex-host" not in mods:
                self.kernel.upsert_system_module(
                    module_id="svl-364-ebon-apex-host",
                    name="SVL-364 Ebon Apex — Obustronnie Zintegrowany Host Statku & Systemu (Full Duplex MCP ROOT)",
                    kind="Flagship Bilateral Host & System Core",
                    status="ACTIVE",
                    description=(
                        "Zamówiona poza Ziemią (APEX-CITADEL Orbital Foundry · L2) pełna obustronna integracja hosta statku "
                        "SVL-364 Ebon Apex i systemu SVL: strona statku (Universal MCP Hub :3334/mcp, Zero-IP Mesh, OpenSSH ssh://Ship, "
                        "systemd, Dual-Ollama, hydroponika) <-> strona systemu (Mostek MCP ROOT, conv-svl364-mcp-root, Jyn ROOT, "
                        "JEDI Omni-OS v12, SQLite WAL, mapa Układu Słonecznego i parowanie z SVL-365)."
                    ),
                    config={
                        "ship_id": "SVL-364",
                        "ship_name": "SVL-364 Ebon Apex",
                        "host_alias": "Ship",
                        "paired_escort": "SVL-365 Sentinel Aegis",
                        "vendor": "APEX-CITADEL Orbital Foundry & Quantum Shipyard (L2 · Off-Earth)",
                        "upgrade_tier": "OMEGA-MK6-DUPLEX",
                        "integration_mode": "BILATERAL_FULL_DUPLEX",
                        "ship_side_services": [
                            "svl-mcp.service (:3334/mcp)",
                            "ssh.service (ssh://Ship · Ed25519 ROOT)",
                            "ollama.service (svl364-apex-uncensored:latest + llama3.2-vision:11b)",
                            "botany-svl364-hydro (Hydroponika Pokładowa)",
                        ],
                        "system_side_services": [
                            "/api/mcp/svl364 (Streamable HTTP JSON-RPC 2.0)",
                            "conv-svl364-mcp-root (Kanał ROOT uid=0)",
                            "SVL364ShipHub (Telemetria, Mapa J2000, Sensory, Alarmy)",
                            "SVLInfrastructureRegistry (SQLite WAL + MCP Sync)",
                        ],
                        "mcp_endpoint": "/api/mcp/svl364",
                        "remote_mcp_url": "http://127.0.0.1:3334/mcp",
                        "root_channel_id": "conv-svl364-mcp-root",
                        "managed_by": ["Jyn", "SI_Sphere", "JEDI_Omni_OS"],
                        "botany_module_id": "botany-svl364-hydro",
                        "installed_packages": all_packages,
                    },
                    source="kernel",
                    origin="off-earth-upgrade-svl364-bilateral",
                )
            if "svl-365-sentinel-host" not in mods:
                self.kernel.upsert_system_module(
                    module_id="svl-365-sentinel-host",
                    name="SVL-365 Sentinel Aegis — Host Statku, Cyber-Obrona & MCP ROOT",
                    kind="Starship Host & Sentinel Security Core",
                    status="ACTIVE",
                    description=(
                        "Zmodernizowany poza Ziemią (APEX-CITADEL Orbital Foundry · L2) host statku SVL-365 Sentinel Aegis: "
                        "zintegrowany obustronnie z SVL-364, Universal MCP Hub (Zero-IP / OpenSSH ROOT), skanerem SVL-365 Sentinel AV, "
                        "JEDI Omni-OS v12, Dual-Ollama oraz fotobioreaktorem pokładowym."
                    ),
                    config={
                        "ship_id": "SVL-365",
                        "ship_name": "SVL-365 Sentinel Aegis",
                        "host_alias": "SVL-365",
                        "paired_flagship": "SVL-364 Ebon Apex",
                        "vendor": "APEX-CITADEL Orbital Foundry & Quantum Shipyard (L2 · Off-Earth)",
                        "upgrade_tier": "OMEGA-MK6",
                        "integration_mode": "BILATERAL_FULL_DUPLEX",
                        "mcp_endpoint": "/api/mcp/svl364",
                        "remote_mcp_shared": True,
                        "root_channel_id": "conv-svl364-mcp-root",
                        "managed_by": ["Jyn", "SI_Sphere", "JEDI_Omni_OS"],
                        "sentinel_av_active": True,
                        "botany_module_id": "botany-svl365-bioshield",
                        "installed_packages": all_packages,
                    },
                    source="kernel",
                    origin="off-earth-upgrade-svl365",
                )
        except Exception:
            pass

    def _read_registry(self) -> dict[str, Any]:
        default_data = default_infrastructure_registry()

        def _read(conn: Any) -> Any:
            row = conn.execute("SELECT value FROM sync_meta WHERE key = ?", (REGISTRY_META_KEY,)).fetchone()
            if not row or not row["value"]:
                return None
            try:
                return json.loads(row["value"])
            except (TypeError, ValueError):
                return None

        run_db = getattr(self.kernel, "run_db", None)
        saved = None
        if callable(run_db):
            try:
                saved = run_db(_read, write=False)
            except Exception:
                saved = None

        if not isinstance(saved, dict):
            self._write_registry(default_data)
            return default_data

        # Upewnij się, że wszystkie klucze oraz nowe ulepszenia SVL-365 i zamówienia pozaziemskie istnieją
        merged = copy.deepcopy(default_data)
        for key in ("allianceStationsBaseline", "allianceStationsExpansion", "allianceStationsTotal", "lastMcpSyncAt"):
            if key in saved and saved[key] is not None:
                merged[key] = saved[key]
        for list_key in ("assets", "missions", "research", "botany", "procurementVendors", "procurementCatalog", "procurementOrders"):
            if isinstance(saved.get(list_key), list) and len(saved[list_key]) > 0:
                existing_list = list(saved[list_key])
                # Доłącz brakujące kanoniczne wpisy (np. ship-svl-365, botany-svl365-bioshield, pakiety zamówień)
                id_field = "sku" if list_key == "procurementCatalog" else ("orderId" if list_key == "procurementOrders" else "id")
                present_ids = {str(item.get(id_field)) for item in existing_list if isinstance(item, dict) and item.get(id_field)}
                for def_item in default_data.get(list_key, []):
                    if isinstance(def_item, dict) and str(def_item.get(id_field)) not in present_ids:
                        existing_list.append(def_item)
                merged[list_key] = existing_list
        return merged

    def _write_registry(self, data: dict[str, Any]) -> None:
        run_db = getattr(self.kernel, "run_db", None)
        if not callable(run_db):
            return
        payload = json.dumps(data, ensure_ascii=False)
        try:
            run_db(
                lambda conn: conn.execute(
                    "INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)",
                    (REGISTRY_META_KEY, payload),
                ),
                write=True,
            )
        except Exception:
            pass

    def _compute_totals(self, reg: dict[str, Any], host_probe: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        assets = reg.get("assets") or []
        outposts = [a for a in assets if a.get("type") == "outpost"]
        ships = [a for a in assets if a.get("type") == "ship"]
        infra = [a for a in assets if a.get("type") == "infrastructure"]
        missions = reg.get("missions") or []
        research = reg.get("research") or []
        botany = reg.get("botany") or []
        catalog = reg.get("procurementCatalog") or []
        orders = reg.get("procurementOrders") or []

        outposts_total = sum(max(1, int(a.get("unitCount") or 1)) for a in outposts)
        ships_total = sum(max(1, int(a.get("unitCount") or 1)) for a in ships)
        infra_objects_total = sum(max(1, int(a.get("unitCount") or 1)) for a in infra)
        total_crew = sum(max(0, int(a.get("crew") or 0)) for a in assets)
        total_researchers = sum(max(0, int(r.get("researchersCount") or 0)) for r in research)

        avg_o2 = round(sum(float(b.get("o2OutputPct") or 0) for b in botany) / max(1, len(botany)), 1)
        total_biomass_kg = round(sum(float(b.get("biomassKg") or 0) for b in botany), 1)
        avg_water_recycled = round(sum(float(b.get("waterRecycledPct") or 0) for b in botany) / max(1, len(botany)), 1)

        monitored_hosts = len((host_probe or {}).get("monitored") or [])
        ssh_hosts = len(((host_probe or {}).get("ssh_hosts") or {}).get("hosts") or [])
        discovered_hosts = len(((host_probe or {}).get("discovered") or {}).get("hosts") or [])

        return {
            "outpostsCount": outposts_total,
            "outpostEntries": len(outposts),
            "shipsCount": ships_total,
            "shipEntries": len(ships),
            "infrastructureObjectsCount": infra_objects_total,
            "infrastructureGroups": len(infra),
            "allianceStationsTotal": int(reg.get("allianceStationsTotal") or 46_500_000),
            "allianceStationsBaseline": int(reg.get("allianceStationsBaseline") or 32_000_000),
            "allianceStationsExpansion": int(reg.get("allianceStationsExpansion") or 14_500_000),
            "totalCrew": total_crew,
            "activeMissions": sum(1 for m in missions if str(m.get("status") or "").upper() in {"ACTIVE", "IN_PROGRESS"}),
            "totalMissions": len(missions),
            "activeResearch": sum(1 for r in research if str(r.get("status") or "").upper() in {"ACTIVE", "IN_PROGRESS"}),
            "totalResearch": len(research),
            "totalResearchers": total_researchers,
            "botanyModulesCount": len(botany),
            "botanyOptimalCount": sum(1 for b in botany if str(b.get("status") or "").upper() in {"OPTIMAL", "HARVEST_READY", "GROWING"}),
            "botanyAvgO2Pct": avg_o2,
            "botanyAvgWaterRecycledPct": avg_water_recycled,
            "botanyTotalBiomassKg": total_biomass_kg,
            "installedUpgradesCount": len(catalog),
            "completedOrdersCount": len(orders),
            "liveMonitoredHosts": monitored_hosts,
            "liveSshHosts": ssh_hosts,
            "liveDiscoveredHosts": discovered_hosts,
        }

    def get_overview(self, *, sync_mcp: bool = False) -> dict[str, Any]:
        reg = self._read_registry()
        now = _now_iso()

        # Połącz z rzeczywistym raportem hosta (infrastructure_probe)
        try:
            from infrastructure_probe import build_infrastructure_report
        except ImportError:
            from backend.infrastructure_probe import build_infrastructure_report

        host_report = build_infrastructure_report(self.kernel)

        # Synchronizacja przez MCP ze statkami SVL-364 i SVL-365 (pozycja z nawigacji + status mostka MCP)
        mcp_sync_info: dict[str, Any] = {
            "connected": False,
            "transport": "sqlite-registry",
            "syncedAt": now,
            "remoteMcpUrl": "",
            "sshUri": "ssh://Ship",
            "shipLocation": "",
        }
        if self.controller is not None:
            st = self.controller.get_status()
            remote = st.get("remoteMcp") or {}
            ssh = st.get("ssh") or {}
            mcp_sync_info["remoteMcpUrl"] = str(remote.get("url") or "")
            mcp_sync_info["sshUri"] = str(ssh.get("uri") or "ssh://Ship")
            mcp_sync_info["connected"] = bool(remote.get("connected") or ssh.get("targetReachable"))
            mcp_sync_info["transport"] = "remote-mcp-root" if remote.get("enabled") else ("openssh-root" if ssh.get("targetReachable") else "local-mcp-sqlite")

            # Zsynchronizuj bieżącą pozycję SVL-364 oraz eskortującego SVL-365 z mapą Układu Słonecznego!
            try:
                nav = self.controller.ship_hub.get_navigation()
                mcp_sync_info["shipLocation"] = f"{nav.get('sector')} ({nav.get('au')} AU)"
                for asset in reg["assets"]:
                    if asset.get("id") == "ship-svl-364":
                        asset["location"] = f"{nav.get('currentBodyName') or nav.get('sector')} ({nav.get('au')} AU)"
                        asset["sector"] = str(nav.get("sector") or asset.get("sector"))
                        asset["au"] = float(nav.get("au") or 1.01)
                    elif asset.get("id") == "ship-svl-365":
                        asset["location"] = f"{nav.get('currentBodyName') or nav.get('sector')} · Eskorta SVL-364 ({nav.get('au')} AU)"
                        asset["sector"] = str(nav.get("sector") or asset.get("sector"))
                        asset["au"] = float(nav.get("au") or 1.01)
                for b in reg["botany"]:
                    if b.get("facilityId") in {"ship-svl-364", "ship-svl-365"}:
                        b["location"] = f"{nav.get('currentBodyName') or nav.get('sector')} ({nav.get('au')} AU)"
            except Exception:
                pass

            if sync_mcp:
                try:
                    probe = self.controller.ship_hub.probe_ship_via_mcp(force=True)
                    mcp_sync_info["probeOk"] = bool(probe.get("ok"))
                    mcp_sync_info["probeDurationMs"] = probe.get("durationMs")
                    mcp_sync_info["probeError"] = probe.get("error") or ""
                    if probe.get("ok"):
                        mcp_sync_info["connected"] = True
                        mcp_sync_info["transport"] = str(probe.get("transport") or mcp_sync_info["transport"])
                except Exception as exc:
                    mcp_sync_info["probeOk"] = False
                    mcp_sync_info["probeError"] = str(exc)
                reg["lastMcpSyncAt"] = now
                self._write_registry(reg)

        # Podłącz zadania agentów AI z SQLite (z host_report["tasks"]) jako żywe podmisje
        live_agent_tasks = list(host_report.get("tasks") or [])[:20]

        # Pogrupuj lokalizacje według sektorów
        sectors_map: dict[str, dict[str, Any]] = {}
        for a in reg["assets"]:
            sec = str(a.get("sector") or "Inne")
            bucket = sectors_map.setdefault(sec, {"sector": sec, "au": a.get("au", 1.0), "outposts": 0, "ships": 0, "infrastructure": 0, "crew": 0, "items": []})
            cnt = max(1, int(a.get("unitCount") or 1))
            if a.get("type") == "outpost":
                bucket["outposts"] += cnt
            elif a.get("type") == "ship":
                bucket["ships"] += cnt
            else:
                bucket["infrastructure"] += cnt
            bucket["crew"] += max(0, int(a.get("crew") or 0))
            bucket["items"].append(a["id"])

        totals = self._compute_totals(reg, host_report)
        return {
            "ok": True,
            "collectedAt": now,
            "lastMcpSyncAt": reg.get("lastMcpSyncAt") or now,
            "mcpSync": mcp_sync_info,
            "totals": totals,
            "sectors": sorted(sectors_map.values(), key=lambda x: float(x.get("au") or 0)),
            "assets": reg["assets"],
            "missions": reg["missions"],
            "research": reg["research"],
            "botany": reg["botany"],
            "procurementVendors": reg.get("procurementVendors") or [],
            "procurementCatalog": reg.get("procurementCatalog") or [],
            "procurementOrders": reg.get("procurementOrders") or [],
            "liveAgentTasks": live_agent_tasks,
            "hostInfrastructure": host_report,
            "serverRevision": self.kernel.get_server_revision(),
        }

    def upsert_asset(self, payload: dict[str, Any], origin: str = "operator") -> dict[str, Any]:
        name = str(payload.get("name") or "").strip()[:140]
        if not name:
            raise ValueError("Wymagana nazwa placówki, statku lub obiektu (name).")
        asset_type = str(payload.get("type") or "outpost").strip().lower()
        if asset_type not in {"outpost", "ship", "infrastructure"}:
            asset_type = "outpost"
        reg = self._read_registry()
        now = _now_iso()
        asset_id = str(payload.get("id") or f"{asset_type}-{uuid.uuid4().hex[:8]}").strip()[:80]
        unit_count = max(1, min(10_000_000, int(payload.get("unitCount") or 1)))
        crew = max(0, min(100_000_000, int(payload.get("crew") or 0)))
        try:
            au = max(0.1, min(100.0, round(float(payload.get("au") or 1.0), 3)))
        except (TypeError, ValueError):
            au = 1.0

        item = {
            "id": asset_id,
            "type": asset_type,
            "name": name,
            "role": str(payload.get("role") or "Jednostka operacyjna SVL").strip()[:180],
            "location": str(payload.get("location") or "Orbita Ziemi (1.000 AU)").strip()[:160],
            "sector": str(payload.get("sector") or "Sektor Ziemski").strip()[:100],
            "au": au,
            "unitCount": unit_count,
            "crew": crew,
            "crewBreakdown": str(payload.get("crewBreakdown") or "").strip()[:200],
            "status": str(payload.get("status") or "ONLINE").strip().upper()[:24],
            "hasBotany": bool(payload.get("hasBotany", False)),
            "mcpNode": str(payload.get("mcpNode") or "svl364-mcp").strip()[:80],
            "updatedAt": now,
            "updatedBy": origin,
        }
        assets = reg["assets"]
        idx = next((i for i, a in enumerate(assets) if a.get("id") == asset_id), None)
        if idx is not None:
            assets[idx] = {**assets[idx], **item}
        else:
            assets.append(item)
        reg["lastMcpSyncAt"] = now
        self._write_registry(reg)
        return {"ok": True, "asset": item, "totals": self._compute_totals(reg), "serverRevision": self.kernel.get_server_revision()}

    def upsert_mission(self, payload: dict[str, Any], origin: str = "operator") -> dict[str, Any]:
        reg = self._read_registry()
        now = _now_iso()
        mission_id = str(payload.get("id") or "").strip()
        missions = reg["missions"]
        existing_idx = next((i for i, m in enumerate(missions) if m.get("id") == mission_id), None) if mission_id else None

        if existing_idx is not None:
            cur = dict(missions[existing_idx])
            if payload.get("title"):
                cur["title"] = str(payload["title"]).strip()[:180]
            if payload.get("status"):
                cur["status"] = str(payload["status"]).strip().upper()[:24]
            if payload.get("progressPct") is not None:
                cur["progressPct"] = max(0, min(100, int(payload["progressPct"])))
                if cur["progressPct"] >= 100:
                    cur["status"] = "COMPLETED"
            if payload.get("objective"):
                cur["objective"] = str(payload["objective"]).strip()[:400]
            cur["updatedAt"] = now
            cur["updatedBy"] = origin
            missions[existing_idx] = cur
            saved_item = cur
        else:
            title = str(payload.get("title") or "").strip()[:180]
            if not title:
                raise ValueError("Wymagany tytuł misji (title).")
            saved_item = {
                "id": mission_id or f"mission-{uuid.uuid4().hex[:8]}",
                "title": title,
                "locationId": str(payload.get("locationId") or "ship-svl-364").strip()[:80],
                "locationName": str(payload.get("locationName") or "Sektor Ziemski · L2").strip()[:140],
                "assignedUnit": str(payload.get("assignedUnit") or "SVL-364 Ebon Apex").strip()[:120],
                "commander": str(payload.get("commander") or "Jyn").strip()[:60],
                "status": str(payload.get("status") or "ACTIVE").strip().upper()[:24],
                "progressPct": max(0, min(100, int(payload.get("progressPct") or 10))),
                "objective": str(payload.get("objective") or title).strip()[:400],
                "updatedAt": now,
                "updatedBy": origin,
            }
            missions.insert(0, saved_item)

        reg["lastMcpSyncAt"] = now
        self._write_registry(reg)
        return {"ok": True, "mission": saved_item, "serverRevision": self.kernel.get_server_revision()}

    def upsert_research(self, payload: dict[str, Any], origin: str = "operator") -> dict[str, Any]:
        reg = self._read_registry()
        now = _now_iso()
        res_id = str(payload.get("id") or "").strip()
        items = reg["research"]
        existing_idx = next((i for i, r in enumerate(items) if r.get("id") == res_id), None) if res_id else None

        if existing_idx is not None:
            cur = dict(items[existing_idx])
            if payload.get("title"):
                cur["title"] = str(payload["title"]).strip()[:180]
            if payload.get("status"):
                cur["status"] = str(payload["status"]).strip().upper()[:24]
            if payload.get("progressPct") is not None:
                cur["progressPct"] = max(0, min(100, int(payload["progressPct"])))
            if payload.get("latestFinding"):
                cur["latestFinding"] = str(payload["latestFinding"]).strip()[:500]
            cur["updatedAt"] = now
            cur["updatedBy"] = origin
            items[existing_idx] = cur
            saved_item = cur
        else:
            title = str(payload.get("title") or "").strip()[:180]
            if not title:
                raise ValueError("Wymagany tytuł badania (title).")
            saved_item = {
                "id": res_id or f"res-{uuid.uuid4().hex[:8]}",
                "title": title,
                "domain": str(payload.get("domain") or "Botanika & Ekosystemy").strip()[:80],
                "locationId": str(payload.get("locationId") or "outpost-apex-citadel").strip()[:80],
                "locationName": str(payload.get("locationName") or "APEX-CITADEL · APEX-TECH-LAB").strip()[:140],
                "leadTeam": str(payload.get("leadTeam") or "APEX-TECH-LAB").strip()[:120],
                "researchersCount": max(1, min(10_000, int(payload.get("researchersCount") or 25))),
                "progressPct": max(0, min(100, int(payload.get("progressPct") or 15))),
                "status": str(payload.get("status") or "ACTIVE").strip().upper()[:24],
                "latestFinding": str(payload.get("latestFinding") or "Inicjalizacja pomiarów i konfiguracja aparatury.").strip()[:500],
                "updatedAt": now,
                "updatedBy": origin,
            }
            items.insert(0, saved_item)

        reg["lastMcpSyncAt"] = now
        self._write_registry(reg)
        return {"ok": True, "research": saved_item, "serverRevision": self.kernel.get_server_revision()}

    def update_botany(self, payload: dict[str, Any], origin: str = "operator") -> dict[str, Any]:
        reg = self._read_registry()
        now = _now_iso()
        botany_id = str(payload.get("id") or payload.get("botanyId") or "").strip()
        facility_id = str(payload.get("facilityId") or "").strip()
        items = reg["botany"]
        idx = next(
            (i for i, b in enumerate(items) if (botany_id and b.get("id") == botany_id) or (facility_id and b.get("facilityId") == facility_id)),
            None,
        )
        if idx is None:
            facility_name = str(payload.get("facilityName") or "").strip()[:140]
            if not facility_name:
                raise ValueError("Nie znaleziono modułu botanicznego — podaj id lub facilityName.")
            new_entry = {
                "id": botany_id or f"botany-{uuid.uuid4().hex[:8]}",
                "facilityId": facility_id or f"facility-{uuid.uuid4().hex[:6]}",
                "facilityName": facility_name,
                "location": str(payload.get("location") or "Orbita Ziemi").strip()[:140],
                "biomeType": str(payload.get("biomeType") or "Hydroponika Zamknięta").strip()[:120],
                "status": str(payload.get("status") or "GROWING").strip().upper()[:24],
                "o2OutputPct": float(payload.get("o2OutputPct") or 102.0),
                "co2ScrubPct": float(payload.get("co2ScrubPct") or 96.0),
                "humidityPct": float(payload.get("humidityPct") or 65.0),
                "tempC": float(payload.get("tempC") or 22.0),
                "waterRecycledPct": float(payload.get("waterRecycledPct") or 98.5),
                "biomassKg": float(payload.get("biomassKg") or 300.0),
                "lightCycle": str(payload.get("lightCycle") or "16h ON / 8h OFF").strip()[:80],
                "activeCultures": payload.get("activeCultures") if isinstance(payload.get("activeCultures"), list) else ["Kultury tlenowe"],
                "currentActivity": str(payload.get("currentActivity") or "Rozruch modułu botanicznego.").strip()[:400],
                "recentEvents": [{"timestamp": now, "level": "INFO", "text": str(payload.get("eventText") or "Utworzono moduł botaniczny.").strip()[:300]}],
                "updatedAt": now,
            }
            items.append(new_entry)
            saved_item = new_entry
        else:
            cur = dict(items[idx])
            if payload.get("status"):
                cur["status"] = str(payload["status"]).strip().upper()[:24]
            if payload.get("currentActivity"):
                cur["currentActivity"] = str(payload["currentActivity"]).strip()[:400]
            for num_key in ("o2OutputPct", "co2ScrubPct", "humidityPct", "tempC", "waterRecycledPct", "biomassKg"):
                if payload.get(num_key) is not None:
                    try:
                        cur[num_key] = round(float(payload[num_key]), 1)
                    except (TypeError, ValueError):
                        pass
            event_text = str(payload.get("eventText") or "").strip()[:300]
            if event_text:
                events = list(cur.get("recentEvents") or [])
                events.insert(0, {
                    "timestamp": now,
                    "level": str(payload.get("eventLevel") or "INFO").strip().upper()[:12],
                    "text": event_text,
                })
                cur["recentEvents"] = events[:15]
            cur["updatedAt"] = now
            cur["updatedBy"] = origin
            items[idx] = cur
            saved_item = cur

        reg["lastMcpSyncAt"] = now
        self._write_registry(reg)
        return {"ok": True, "botany": saved_item, "serverRevision": self.kernel.get_server_revision()}

    def order_off_earth_upgrade(self, payload: dict[str, Any], origin: str = "operator") -> dict[str, Any]:
        """Składa i natychmiast integruje zamówienie ulepszeń systemowych poza Ziemią (APEX-CITADEL / Ceres / L4)."""
        reg = self._read_registry()
        now = _now_iso()
        title = str(payload.get("title") or "").strip()[:200]
        if not title:
            raise ValueError("Wymagany tytuł zamówienia pozaziemskiego (title).")
        vendor_name = str(
            payload.get("vendorName")
            or "APEX-CITADEL Orbital Foundry & Quantum Shipyard (L2 · Poza Ziemią)"
        ).strip()[:160]
        target_host = str(payload.get("targetHost") or "SVL-365 Sentinel Aegis + SVL-364 Ebon Apex + Jądro SVL").strip()[:160]
        category = str(payload.get("category") or "Host & System Integration").strip()[:80]
        specs = str(
            payload.get("specs")
            or f"Zintegrowano pakiet pozaziemski „{title}” z hostami SVL-365/SVL-364, Universal MCP Hub (ROOT) i bazą SQLite WAL."
        ).strip()[:500]
        sku = str(payload.get("sku") or f"UPG-SVL365-{uuid.uuid4().hex[:6].upper()}").strip()[:40]

        catalog_item = {
            "sku": sku,
            "title": title,
            "vendorId": "vendor-apex-citadel-foundry",
            "vendorName": vendor_name,
            "targetHost": target_host,
            "category": category,
            "tier": str(payload.get("tier") or "OMEGA-CUSTOM").strip()[:32],
            "status": "INSTALLED_ACTIVE",
            "integratedWith": ["svl-365-sentinel-host", "svl-364-ssh-mcp", "jyn", "conv-svl364-mcp-root"],
            "specs": specs,
        }
        reg.setdefault("procurementCatalog", []).insert(0, catalog_item)

        order_item = {
            "orderId": f"ORD-OFFEARTH-{uuid.uuid4().hex[:6].upper()}",
            "title": title,
            "vendorName": vendor_name,
            "orderedBy": "Mateusz Mitek (ROOT) & Jyn",
            "targetSystems": [target_host, "Universal MCP Hub", "SQLite WAL"],
            "items": [sku],
            "status": "DELIVERED_AND_INTEGRATED",
            "deliveryLocation": "Punkt Lagrange'a Ziemia–Słońce L2 (1.010 AU) · Mostek MCP ROOT",
            "notes": specs,
            "orderedAt": now,
            "integratedAt": now,
        }
        reg.setdefault("procurementOrders", []).insert(0, order_item)
        reg["lastMcpSyncAt"] = now
        self._write_registry(reg)
        self._ensure_off_earth_ship_hosts()
        return {
            "ok": True,
            "order": order_item,
            "upgrade": catalog_item,
            "totals": self._compute_totals(reg),
            "serverRevision": self.kernel.get_server_revision(),
        }

