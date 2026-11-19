// Dobór modeli Gemini dostępnych dla bieżącego klucza API.
//
// Nazwy modeli Gemini szybko się zmieniają (np. `gemini-2.5-flash` „niedostępny dla nowych
// użytkowników”, `gemini-3-flash-preview` → 404). Zamiast sztywnej listy serwer pobiera listę
// modeli z API (`models.list()`), wybiera te obsługujące `generateContent`, układa je
// (szybkie → stabilne → nowsze) i pamięta modele, które zwróciły 404, żeby ich nie ponawiać.

/** Zapas, gdy listy modeli nie da się pobrać (szybkie i stabilne modele lite na początku). */
export const GEMINI_STATIC_FALLBACK = [
  'gemini-flash-lite-latest',
  'gemini-3.1-flash-lite',
  'gemini-flash-latest',
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

/** Czy błąd oznacza wyczerpaną kwotę (429 / RESOURCE_EXHAUSTED) — nie warto ponawiać po 1,5 s. */
export function isGeminiQuotaExhaustedError(message: string): boolean {
  return /\b429\b|RESOURCE_EXHAUSTED|exceeded your current quota|quota/i.test(String(message || ''));
}

/** Czy błąd oznacza przekroczenie czasu (timeout / abort). */
export function isGeminiTimeoutError(message: string): boolean {
  return /aborted|AbortError|TimeoutError|timed? ?out/i.test(String(message || ''));
}

/** Czytelny opis błędu Gemini (zamiast surowego JSON-a z API). */
export function describeGeminiError(message: string, timeoutMs = 18000): string {
  const raw = String(message || '').trim();
  if (isGeminiTimeoutError(raw)) {
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

type GeminiModelLogger = (level: 'INFO' | 'WARN' | 'ERROR', message: string, details?: Record<string, unknown>) => void;
let modelLogger: GeminiModelLogger | null = null;

/** Podpięcie loggera plików (logi/): wykryte modele, błędy listy, modele wycofane. */
export function setGeminiModelLogger(logger: GeminiModelLogger | null): void {
  modelLogger = logger;
}

export function markGeminiModelGone(model: string): void {
  if (!goneModels.has(model)) {
    modelLogger?.('WARN', `Model Gemini ${model} niedostępny (404 / wycofany) — pomijany do restartu serwera`);
  }
  workingModels.delete(model);
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
      modelLogger?.(
        ranked.length > 0 ? 'INFO' : 'WARN',
        `Modele Gemini dostępne dla klucza: ${ranked.length} (z ${all.length} zwróconych przez API)`,
        { top: ranked.slice(0, 8) },
      );
      return ranked;
    } catch (error) {
      discovered = { at: Date.now() - DISCOVERY_TTL_MS + 60_000, models: [] }; // ponów za minutę
      modelLogger?.('WARN', 'Nie udało się pobrać listy modeli Gemini — używana lista zapasowa', {
        error: describeGeminiError(error instanceof Error ? error.message : String(error)),
        fallback: GEMINI_STATIC_FALLBACK,
      });
      return [];
    } finally {
      discovering = null;
    }
  })();
  return discovering;
}

const COOLDOWN_MS = 5 * 60 * 1000;
const TIMEOUT_COOLDOWN_MS = 15 * 60 * 1000;
const QUOTA_COOLDOWN_MS = 30 * 60 * 1000;
const WORKING_TTL_MS = 45 * 60 * 1000;
const coolingDown = new Map<string, number>();
const workingModels = new Map<string, { at: number; avgMs: number }>();
const noThinkingConfig = new Set<string>();

/** Resetuje stan zdrowia modeli (używane głównie w testach jednostkowych). */
export function resetGeminiModelHealth(): void {
  coolingDown.clear();
  workingModels.clear();
  goneModels.clear();
  noThinkingConfig.clear();
  discovered = null;
  discovering = null;
}

/** Zapamiętuje sprawdzony szybki model — w kolejnych zapytaniach będzie wywoływany jako pierwszy. */
export function noteGeminiSuccess(model: string, durationMs = 2000): void {
  coolingDown.delete(model);
  const prev = workingModels.get(model);
  const safeMs = Math.max(100, Math.round(durationMs));
  const avgMs = prev ? Math.round(prev.avgMs * 0.6 + safeMs * 0.4) : safeMs;
  workingModels.set(model, { at: Date.now(), avgMs });
}

/** Przekroczona kwota (429) → model na 30 minut na koniec kolejki, bez ponawiania po 1,5 s. */
export function noteGeminiQuotaExhausted(model: string): void {
  workingModels.delete(model);
  coolingDown.set(model, Date.now() + QUOTA_COOLDOWN_MS);
  modelLogger?.('WARN', `Model Gemini ${model} ma wyczerpaną kwotę (429) — pomijany przez 30 min`);
}

/** Model zawiesił się (timeout) → na 15 minut na koniec kolejki. */
export function noteGeminiTimeout(model: string): void {
  workingModels.delete(model);
  coolingDown.set(model, Date.now() + TIMEOUT_COOLDOWN_MS);
  modelLogger?.('WARN', `Model Gemini ${model} przekroczył czas odpowiedzi — pomijany przez 15 min`);
}

/** Przekroczony czas / 503 / 429 → model na koniec kolejki (z właściwym czasem karencji). */
export function noteGeminiSlowOrBusy(model: string, errorMessage?: string): void {
  if (errorMessage && isGeminiQuotaExhaustedError(errorMessage)) {
    noteGeminiQuotaExhausted(model);
    return;
  }
  if (errorMessage && isGeminiTimeoutError(errorMessage)) {
    noteGeminiTimeout(model);
    return;
  }
  workingModels.delete(model);
  coolingDown.set(model, Date.now() + COOLDOWN_MS);
  modelLogger?.('WARN', `Model Gemini ${model} jest chwilowo przeciążony — na 5 min na koniec kolejki`);
}

export function isGeminiSlowOrBusyError(message: string): boolean {
  return /aborted|AbortError|TimeoutError|timed? ?out|\b503\b|UNAVAILABLE|high demand|\b429\b|RESOURCE_EXHAUSTED|overloaded/i.test(
    String(message || ''),
  );
}

/** Kandydaci do zapytania: GEMINI_MODEL, jawnie wybrany model, sprawdzone szybkie modele, wykryte modele, zapas. */
export async function geminiCandidatesFor(client: any, requestedModel?: string, max = 8): Promise<string[]> {
  const requested = String(requestedModel || '').trim();
  const fromApi = await discoverGeminiModels(client);
  const now = Date.now();
  const provenFast = [...workingModels.entries()]
    .filter(([m, info]) => !goneModels.has(m) && now - info.at < WORKING_TTL_MS && !(coolingDown.get(m) && now < (coolingDown.get(m) as number)))
    .sort((a, b) => a[1].avgMs - b[1].avgMs)
    .map(([m]) => m);

  const ordered = [
    process.env.GEMINI_MODEL,
    requested.startsWith('gemini-') ? requested : null,
    ...provenFast,
    // Wykryte modele najpierw; zapas zawsze na końcu, gdyby lista z API była niepełna.
    ...diversify(fromApi),
    ...GEMINI_STATIC_FALLBACK,
  ].filter((entry): entry is string => Boolean(entry && entry.trim()));
  const unique = [...new Set(ordered)].filter((m) => !goneModels.has(m));
  // Modele, które przed chwilą przekroczyły czas / były przeciążone (503) / bez kwoty (429), idą na koniec.
  const healthy = unique.filter((m) => !(coolingDown.get(m) && now < (coolingDown.get(m) as number)));
  const cooling = unique.filter((m) => !healthy.includes(m));
  const pinned = [
    process.env.GEMINI_MODEL,
    requested.startsWith('gemini-') ? requested : null,
    ...provenFast,
  ].filter((m): m is string => Boolean(m && healthy.includes(m)));
  const pinnedSet = new Set(pinned);
  const remainingHealthy = healthy.filter((m) => !pinnedSet.has(m));
  return [...pinned, ...diversify(remainingHealthy), ...cooling].slice(0, max);
}

/**
 * Różne rodziny po kolei (flash → flash-lite → alias → pro → reszta), żeby po przekroczeniu
 * czasu przez najnowszy flash nie próbować trzech kolejnych równie wolnych modeli flash.
 */
export function diversify(models: string[]): string[] {
  const family = (m: string) => (/-latest$/i.test(m) ? 'alias' : /flash-lite/i.test(m) ? 'lite' : /flash/i.test(m) ? 'flash' : /pro/i.test(m) ? 'pro' : 'other');
  const buckets = new Map<string, string[]>();
  for (const m of models) {
    const f = family(m);
    if (!buckets.has(f)) buckets.set(f, []);
    buckets.get(f)!.push(m);
  }
  const order = ['flash', 'lite', 'alias', 'pro', 'other'];
  const out: string[] = [];
  while (out.length < models.length) {
    for (const f of order) {
      const next = buckets.get(f)?.shift();
      if (next) out.push(next);
    }
  }
  // Wymuszony GEMINI_MODEL zawsze pierwszy.
  const forced = process.env.GEMINI_MODEL;
  return forced && out.includes(forced) ? [forced, ...out.filter((m) => m !== forced)] : out;
}

/**
 * Ograniczenie „myślenia” modeli Gemini 3.x (domyślnie myślą długo — czat przekraczał 30 s).
 * Dla szybkich modeli `flash-lite` domyślnie używamy `MINIMAL`, dla pozostałych `LOW`.
 * GEMINI_THINKING_LEVEL: MINIMAL | LOW | MEDIUM | HIGH | OFF.
 */
export function geminiThinkingConfig(model: string): Record<string, unknown> {
  const envLevel = String(process.env.GEMINI_THINKING_LEVEL || '').trim().toUpperCase();
  const level = envLevel || (/flash-lite/i.test(model) ? 'MINIMAL' : 'LOW');
  if (level === 'OFF' || noThinkingConfig.has(model)) return {};
  if (!['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'].includes(level)) return {};
  return { thinkingConfig: { thinkingLevel: level } };
}

/** Model odrzucił thinkingConfig (400) — dla niego wysyłamy zapytania bez tego ustawienia. */
export function isThinkingConfigError(message: string): boolean {
  return /\b400\b|INVALID_ARGUMENT/i.test(message) && /thinking/i.test(message);
}

export function disableThinkingConfigFor(model: string): void {
  noThinkingConfig.add(model);
}

/** Wspólny budżet czasu dla całego zapytania (wszystkich kandydatów). */
export function createGeminiDeadline(totalMs = Number(process.env.GEMINI_TOTAL_BUDGET_MS || 55000)) {
  const endsAt = Date.now() + totalMs;
  const perAttempt = Number(process.env.GEMINI_TIMEOUT_MS || 20000);
  return {
    perAttemptMs: perAttempt,
    remaining: () => Math.max(0, endsAt - Date.now()),
    /** Limit pojedynczej próby: min(GEMINI_TIMEOUT_MS, pozostały czas). */
    attemptTimeout: () => Math.max(0, Math.min(perAttempt, endsAt - Date.now())),
    expired: () => Date.now() >= endsAt - 1000,
  };
}
