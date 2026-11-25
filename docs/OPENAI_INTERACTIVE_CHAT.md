# OpenAI Apps SDK UI — interaktywny czat SVL

Oficjalny pakiet @openai/apps-sdk-ui 0.2.1 (MIT), https://github.com/openai/apps-sdk-ui. Własny backend Ollama, brak wymogu OpenAI API i brak strumieniowania inferencji. Opcjonalny kontrakt danych svl-ui; Markdown działa bez widgetów. Komponenty: Button, Badge, Alert, Input, Textarea, Checkbox, Switch, Select, RadioGroup, SegmentedControl, Slider, Markdown. Daty i liczby przez Input. Tabele i wykres SVG to lokalne renderowanie danych, nie komponenty OpenAI. Stare tokeny przycisków są odczytywane dla zachowania historii, bez starego renderera. Formularz wstawia dane do edytora, operator wysyła je sam. Nowy widget nie może wykonywać kodu, poleceń powłoki ani operacji ROOT bez istniejących ścieżek autoryzacji. 

Przykład:

```svl-ui
{"title":"Parametry symulacji","fields":[{"type":"slider","name":"speed","label":"Tempo","min":1,"max":100,"step":1,"value":10},{"type":"select","name":"mode","label":"Tryb","options":[{"label":"Normalny","value":"normal"},{"label":"Szybki","value":"fast"}]}],"buttons":[{"label":"Wyjaśnij parametry","action":"send:Wyjaśnij parametry symulacji"}],"chart":{"type":"line","labels":["A","B","C"],"values":[1,3,2]}}
```

Instalacja: npm ci, npm run dev (Node 22+). Nie wymaga klucza OpenAI. Backend pozostaje wspólny dla obu projektów.