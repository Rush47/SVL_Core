// Dobór modeli Gemini dostępnych dla bieżącego klucza API.
//
// Nazwy modeli Gemini szybko się zmieniają (np. `gemini-2.5-flash` „niedostępny dla nowych
// użytkowników”, `gemini-3-flash-preview` → 404). Zamiast sztywnej listy serwer pobiera listę
// modeli z API (`models.list()`), wybiera te obsługujące `generateContent`, układa je
// (szybkie → stabilne → nowsze) i pamięta modele, które zwróciły 404, żeby ich nie ponawiać.

/** Zapas, gdy listy modeli nie da się pobrać. */
export const GEMINI_STATIC_FALLBACK = [
  'gemini-flash-latest',
  'gemini-3.1-flash-lite', // odpowiadał (bez 404) w AI Studio — tylko przekraczał krótki limit czasu
  'gemini-flash-lite-latest',
  'gemini-3-flash-preview',
];

const EXCLUDED = /(embed|embedding|aqa|imagen|image|tts|audio|live|native-audio|veo|lyria|robotics|computer-use|learnlm|gemma)/i;

export interface GeminiModelInfo {
  name?: string;
  supportedActions?: string[];
}

function versionOf(name: string): number {
  const match = name.match(/gemini-(\d+(?:\.\d+)?)/i);
  return match ? Number(match[1]) : 0;
}

/** Ranking: flash/flash-lite (szybkie) przed pro, stabilne przed preview/exp, nowsze przed starszymi. */
export function rankGeminiChatModels(models: GeminiModelInfo[]): string[] {
  const names = models
    .filter((m) => {
      const actions = Array.isArray(m.supportedActions) ? m.supportedActions : [];
      return actions.length === 0 || actions.includes('generateContent');
    })
    .map((m) => String(m.name || '').replace(/^models\//, '').trim())
    .filter((n) => /^gemini/i.test(n) && !EXCLUDED.test(n));
  const unique = [...new Set(names)];
  const score = (n: string) => {
    const tier = /flash-lite/i.test(n) ? 1 : /flash/i.test(n) ? 0 : /pro/i.test(n) ? 2 : 3;
    const unstable = /(preview|exp|experimental)/i.test(n) ? 1 : 0;
    const alias = /-latest$/i.test(n) ? 0 : 1; // aliasy *-latest zawsze wskazują działający model
    return { tier, unstable, alias, version: versionOf(n) };
  };
  return unique.sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    return (
      sa.tier - sb.tier ||
      sa.unstable - sb.unstable ||
      sa.alias - sb.alias ||
      sb.version - sa.version ||
      a.localeCompare(b)
    );
  });
}

/** Czy błąd oznacza, że modelu nie ma / jest wycofany (nie ponawiać w tej sesji). */
export function isGeminiModelGoneError(message: string): boolean {
  return /\b404\b|NOT_FOUND|is not found|no longer available|not supported for generateContent|deprecated/i.test(
    String(message || ''),
  );
}

/** Czytelny opis błędu Gemini (zamiast surowego JSON-a z API). */
export function describeGeminiError(message: string, timeoutMs = 30000): string {
  const raw = String(message || '').trim();
  if (/aborted|AbortError|TimeoutError|timed? ?out/i.test(raw)) {
    return `przekroczono limit czasu (${Math.round(timeoutMs / 1000)} s)`;
  }
  const jsonStart = raw.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart));
      const err = parsed?.error || parsed;
      if (err?.message) return `${err.code ? `${err.code}: ` : ''}${String(err.message).slice(0, 160)}`;
    } catch {
      // nie-JSON — zwracamy skrót surowego komunikatu
    }
  }
  return raw.slice(0, 160);
}

const DISCOVERY_TTL_MS = 30 * 60 * 1000;
let discovered: { at: number; models: string[] } | null = null;
let discovering: Promise<string[]> | null = null;
const goneModels = new Set<string>();

export function markGeminiModelGone(model: string): void {
  goneModels.add(model);
}

/** Lista modeli z API (z pamięcią podręczną). Błąd → pusta lista (użyty zostanie zapas). */
export async function discoverGeminiModels(client: any): Promise<string[]> {
  if (discovered && Date.now() - discovered.at < DISCOVERY_TTL_MS) return discovered.models;
  if (discovering) return discovering;
  discovering = (async () => {
    try {
      const pager = await client.models.list({ config: { pageSize: 200 } });
      const all: GeminiModelInfo[] = [];
      for await (const model of pager) {
        all.push(model as GeminiModelInfo);
        if (all.length >= 500) break;
      }
      const ranked = rankGeminiChatModels(all);
      discovered = { at: Date.now(), models: ranked };
      return ranked;
    } catch {
      discovered = { at: Date.now() - DISCOVERY_TTL_MS + 60_000, models: [] }; // ponów za minutę
      return [];
    } finally {
      discovering = null;
    }
  })();
  return discovering;
}

/** Kandydaci do zapytania: GEMINI_MODEL, jawnie wybrany model, wykryte modele, zapas. */
export async function geminiCandidatesFor(client: any, requestedModel?: string, max = 5): Promise<string[]> {
  const requested = String(requestedModel || '').trim();
  const fromApi = await discoverGeminiModels(client);
  const ordered = [
    process.env.GEMINI_MODEL,
    requested.startsWith('gemini-') ? requested : null,
    // Wykryte modele najpierw; zapas zawsze na końcu, gdyby lista z API była niepełna.
    ...fromApi.slice(0, Math.max(1, max - 2)),
    ...GEMINI_STATIC_FALLBACK,
  ].filter((entry): entry is string => Boolean(entry && entry.trim()));
  return [...new Set(ordered)].filter((m) => !goneModels.has(m)).slice(0, max);
}
