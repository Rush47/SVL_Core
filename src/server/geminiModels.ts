// Dobór modeli Gemini dostępnych dla bieżącego klucza API.
//
// Nazwy modeli Gemini szybko się zmieniają (np. `gemini-2.5-flash` „niedostępny dla nowych
// użytkowników”, `gemini-3-flash-preview` → 404). Zamiast sztywnej listy serwer pobiera listę
// modeli z API (`models.list()`), wybiera te obsługujące `generateContent`, układa je
// (szybkie → stabilne → nowsze) i pamięta modele, które zwróciły 404, żeby ich nie ponawiać.

/** Zapas, gdy listy modeli nie da się pobrać (szybkie i stabilne modele darmowe na początku). */
export const GEMINI_STATIC_FALLBACK = [
  'gemma-4-26b-a4b-it',
  'gemma-4-31b-it',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-4-hydrogen',
  'gemini-flash-latest',
];

const EXCLUDED = /(embed|embedding|aqa|imagen|image|tts|audio|live|native-audio|veo|lyria|robotics|computer-use|learnlm|gemma(?!-4-)|transcribe|banana|omni|customtools|thinking-exp|4-neon|4-carbon|4-argon)/i;
/**
 * Tylko modele czatu: gemma-4-* instruction oraz darmowy gemini-4-hydrogen i gemini-[wersja-]flash|flash-lite|pro[-latest|-preview…|-001].
 * Odrzuca modele specjalne i płatne warianty (np. transcribe, nano-banana, 4-neon, 4-carbon, 4-argon),
 * które w logach zwracały 400/429 i zjadały czas zapytania.
 */
const CHAT_MODEL_NAME = /^(?:gemma-4-(?:26b-a4b|31b)-it|gemini-4-hydrogen|gemini-(?:\d+(?:\.\d+)?-)?(?:flash-lite|flash|pro)(?:-latest|-preview(?:-[\w.-]+)?|-\d{3})?)$/i;

export function isGeminiChatModelName(name: string): boolean {
  const n = String(name || '').replace(/^models\//, '').trim();
  return CHAT_MODEL_NAME.test(n) && !EXCLUDED.test(n);
}

/** Gemini 4 nie przyjmuje parametrów temperature/topP/topK — pomijamy je dla modeli gemini-4-*. Modele gemma-4 obsługują temperature. */
export function isGeminiTemperatureSupported(model: string): boolean {
  const clean = String(model || '').replace(/^models\//, '').trim();
  return !/^gemini-4-/i.test(clean);
}

/** Czy błąd 400 dotyczy deklaracji narzędzi (wtedy ponawiamy zapytanie bez narzędzi). */
export function isGeminiToolSchemaError(message: string): boolean {
  return /\b400\b|INVALID_ARGUMENT/i.test(String(message || '')) &&
    /(function_declarations|parameters\.properties|duplicate function|tool|schema)/i.test(String(message || ''));
}

/**
 * Deduplikuje deklaracje narzędzi po nazwie i usuwa puste `parameters: { type: OBJECT, properties: {} }`,
 * które Gemini API odrzuca błędem 400 INVALID_ARGUMENT.
 */
export function sanitizeGeminiToolDeclarations<T extends { name?: string; parameters?: any }>(declarations: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const decl of declarations) {
    const name = String(decl?.name || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const params = decl?.parameters;
    const isEmptyObjectSchema =
      params &&
      typeof params === 'object' &&
      String(params.type || '').toUpperCase() === 'OBJECT' &&
      (!params.properties ||
        (typeof params.properties === 'object' && Object.keys(params.properties as Record<string, unknown>).length === 0));
    if (isEmptyObjectSchema) {
      const { parameters: _omit, ...rest } = decl;
      out.push(rest as T);
    } else {
      out.push(decl);
    }
  }
  return out;
}

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
    .filter((n) => isGeminiChatModelName(n));
  const unique = [...new Set(names)];
  const score = (n: string) => {
    const tier = /flash-lite|gemma/i.test(n) ? 1 : /flash|4-hydrogen/i.test(n) ? 0 : /pro/i.test(n) ? 2 : 3;
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
  persistModelState();
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

const COOLDOWN_MS = 10 * 1000;
const TIMEOUT_COOLDOWN_MS = 30 * 1000;
const QUOTA_COOLDOWN_MS = 60 * 1000;
const QUOTA_DAILY_COOLDOWN_MS = 15 * 60 * 1000;
const WORKING_TTL_MS = 45 * 60 * 1000;
const coolingDown = new Map<string, number>();
const quotaCoolingModels = new Set<string>();
const workingModels = new Map<string, { at: number; avgMs: number }>();
const noThinkingConfig = new Set<string>();

/** Resetuje stan zdrowia modeli (używane głównie w testach jednostkowych). */
export function resetGeminiModelHealth(): void {
  coolingDown.clear();
  quotaCoolingModels.clear();
  workingModels.clear();
  goneModels.clear();
  noThinkingConfig.clear();
  discovered = null;
  discovering = null;
}

/** Zapamiętuje sprawdzony szybki model — w kolejnych zapytaniach będzie wywoływany jako pierwszy. */
export function noteGeminiSuccess(model: string, durationMs = 2000): void {
  coolingDown.delete(model);
  quotaCoolingModels.delete(model);
  const prev = workingModels.get(model);
  const safeMs = Math.max(100, Math.round(durationMs));
  const avgMs = prev ? Math.round(prev.avgMs * 0.6 + safeMs * 0.4) : safeMs;
  workingModels.set(model, { at: Date.now(), avgMs });
}

/**
 * Czas „spróbuj ponownie za” z błędu 429 (`retryDelay: "37s"` lub „Please retry in 37.2s”).
 * Limit minutowy mija po kilkudziesięciu sekundach — nie ma sensu wyłączać modelu na 30 min.
 */
export function parseGeminiRetryDelayMs(message: string): number | null {
  const raw = String(message || '');
  const m = raw.match(/retryDelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)s/i) || raw.match(/retry in (\d+(?:\.\d+)?)\s*s/i);
  return m ? Math.round(Number(m[1]) * 1000) : null;
}

/** Przekroczona kwota (429) → na koniec kolejki: na czas z retryDelay (limit minutowy) albo 60 s / 15 min perDay. */
export function noteGeminiQuotaExhausted(model: string, errorMessage?: string): void {
  workingModels.delete(model);
  const retryMs = parseGeminiRetryDelayMs(errorMessage || '');
  const perDay = /per ?day|PerDay|daily/i.test(errorMessage || '');
  const cooldown = retryMs !== null && !perDay ? Math.min(QUOTA_COOLDOWN_MS, Math.max(10_000, retryMs)) : (perDay ? QUOTA_DAILY_COOLDOWN_MS : QUOTA_COOLDOWN_MS);
  coolingDown.set(model, Date.now() + cooldown);
  quotaCoolingModels.add(model);
  persistModelState();
  modelLogger?.('WARN', `Model Gemini ${model} ma wyczerpaną kwotę (429) — pomijany przez ${Math.round(cooldown / 1000)} s`);
}

// Stan modeli (wycofane 404 i karencje 429) zapisany na dysku: AI Studio często restartuje serwer,
// a bez tego po każdym restarcie znów próbowano wycofanych modeli i modeli bez kwoty.
let statePath: string | null = null;
type FsLike = { readFileSync: (p: string, e: 'utf8') => string; writeFileSync: (p: string, d: string) => void };
let stateFs: FsLike | null = null;

export function setGeminiModelStatePath(filePath: string | null, fs?: FsLike): void {
  statePath = filePath;
  stateFs = fs || null;
  if (!statePath || !stateFs) return;
  try {
    const data = JSON.parse(stateFs.readFileSync(statePath, 'utf8'));
    const now = Date.now();
    for (const m of Array.isArray(data?.gone) ? data.gone : []) if (typeof m === 'string') goneModels.add(m);
    for (const [m, until] of Object.entries(data?.cooling || {})) {
      if (typeof until === 'number' && until > now) {
        coolingDown.set(m, until);
        if (until - now > 2 * 60 * 1000) quotaCoolingModels.add(m);
      }
    }
  } catch {
    // brak pliku lub uszkodzony — start bez zapamiętanego stanu
  }
}

function persistModelState(): void {
  if (!statePath || !stateFs) return;
  try {
    const now = Date.now();
    const cooling = Object.fromEntries([...coolingDown.entries()].filter(([, until]) => until > now));
    stateFs.writeFileSync(statePath, JSON.stringify({ gone: [...goneModels], cooling, savedAt: new Date().toISOString() }, null, 2));
  } catch {
    // zapis stanu jest pomocniczy — błąd nie może przerwać czatu
  }
}

/**
 * Krótkie, zrozumiałe podsumowanie błędów wszystkich modeli Gemini (zamiast długiej listy).
 */
export function summarizeGeminiFailures(errors: string[]): string {
  const counts = { quota: 0, busy: 0, timeout: 0, gone: 0, other: 0 };
  for (const e of errors) {
    if (isGeminiQuotaExhaustedError(e)) counts.quota += 1;
    else if (/\b503\b|high demand|UNAVAILABLE|overloaded/i.test(e)) counts.busy += 1;
    else if (/limit czasu|timeout|aborted/i.test(e)) counts.timeout += 1;
    else if (isGeminiModelGoneError(e)) counts.gone += 1;
    else counts.other += 1;
  }
  const parts: string[] = [];
  if (counts.quota) parts.push(`wyczerpany limit klucza API (429) w ${counts.quota} modelach`);
  if (counts.busy) parts.push(`przeciążenie serwerów Google (503) w ${counts.busy}`);
  if (counts.timeout) parts.push(`przekroczony czas w ${counts.timeout}`);
  if (counts.gone) parts.push(`modele wycofane (404): ${counts.gone}`);
  if (counts.other) parts.push(`inne błędy: ${counts.other}`);
  let hint = '';
  if (counts.quota > 0 && counts.quota >= counts.busy + counts.timeout) {
    hint = ' — darmowy limit klucza Gemini jest wyczerpany; odnowi się sam (limit minutowy po ok. minucie, dzienny następnego dnia) albo włącz płatności w Google AI Studio';
  } else if (counts.busy + counts.timeout >= errors.length / 2) {
    hint = ' — chwilowe przeciążenie Gemini, spróbuj ponownie za chwilę';
  }
  return (parts.join(', ') || 'brak odpowiedzi') + hint;
}

/** Model zawiesił się (timeout) → dla darmowych modeli flash-lite tylko 30 s, dla pozostałych 15 min. */
export function noteGeminiTimeout(model: string): void {
  workingModels.delete(model);
  const isFreePriority = FREE_TIER_PRIORITY_MODELS.includes(model);
  const cooldown = isFreePriority ? 30 * 1000 : TIMEOUT_COOLDOWN_MS;
  coolingDown.set(model, Date.now() + cooldown);
  persistModelState();
  modelLogger?.('WARN', `Model Gemini ${model} przekroczył czas odpowiedzi — pomijany przez ${Math.round(cooldown / 1000)} s`);
}

/** Przekroczony czas / 503 / 429 → model na koniec kolejki (z właściwym czasem karencji). */
export function noteGeminiSlowOrBusy(model: string, errorMessage?: string): void {
  if (errorMessage && isGeminiQuotaExhaustedError(errorMessage)) {
    noteGeminiQuotaExhausted(model, errorMessage);
    return;
  }
  if (errorMessage && isGeminiTimeoutError(errorMessage)) {
    noteGeminiTimeout(model);
    return;
  }
  const isFreePriority = FREE_TIER_PRIORITY_MODELS.includes(model);
  if (!isFreePriority) {
    workingModels.delete(model);
  }
  const cooldown = isFreePriority ? 8_000 : COOLDOWN_MS;
  coolingDown.set(model, Date.now() + cooldown);
  persistModelState();
  modelLogger?.('WARN', `Model Gemini ${model} jest chwilowo przeciążony (503) — na ${Math.round(cooldown / 1000)} s na koniec kolejki`);
}

/** Najbliższy moment (ms od teraz), gdy któryś model Gemini wyjdzie z karencji; null = brak karencji. */
export function getSoonestGeminiRetryMs(): number | null {
  const now = Date.now();
  const future = [...coolingDown.values()].filter((until) => until > now);
  if (future.length === 0) return null;
  return Math.min(...future) - now;
}

export function isGeminiTransient503Error(message: string): boolean {
  const raw = String(message || '');
  return /\b503\b|UNAVAILABLE|high demand|overloaded/i.test(raw) && !isGeminiQuotaExhaustedError(raw);
}

export function isGeminiSlowOrBusyError(message: string): boolean {
  return /aborted|AbortError|TimeoutError|timed? ?out|\b503\b|UNAVAILABLE|high demand|\b429\b|RESOURCE_EXHAUSTED|overloaded/i.test(
    String(message || ''),
  );
}

/** Modele darmowe o najwyższej dostępności w darmowym kluczu Gemini API. */
export const FREE_TIER_PRIORITY_MODELS = [
  'gemma-4-26b-a4b-it',
  'gemma-4-31b-it',
  'gemini-3.1-flash-lite',
  'gemini-3.1-flash-lite-preview',
  'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest',
];

/** Kandydaci do zapytania: GEMINI_MODEL, jawnie wybrany model, sprawdzone szybkie modele, darmowe flash-lite, wykryte modele, zapas. */
export async function geminiCandidatesFor(
  client: any,
  requestedModel?: string,
  max = 16,
  opts: { skipCooling?: boolean } = {},
): Promise<string[]> {
  const requested = String(requestedModel || '').trim();
  const fromApi = await discoverGeminiModels(client);
  const now = Date.now();
  const isCooling = (m: string) => {
    const until = coolingDown.get(m);
    if (!until) return false;
    if (now >= until) {
      coolingDown.delete(m);
      quotaCoolingModels.delete(m);
      return false;
    }
    return true;
  };
  const provenFast = [...workingModels.entries()]
    .filter(([m, info]) => !goneModels.has(m) && now - info.at < WORKING_TTL_MS && !isCooling(m))
    .sort((a, b) => a[1].avgMs - b[1].avgMs)
    .map(([m]) => m);

  const availableFreePriority = FREE_TIER_PRIORITY_MODELS.filter((m) => fromApi.length === 0 || fromApi.includes(m));
  const ordered = [
    process.env.GEMINI_MODEL,
    requested.startsWith('gemini-') ? requested : null,
    ...provenFast,
    ...availableFreePriority,
    // Wykryte modele najpierw; zapas zawsze na końcu, gdyby lista z API była niepełna.
    ...diversify(fromApi),
    ...GEMINI_STATIC_FALLBACK,
  ].filter((entry): entry is string => Boolean(entry && entry.trim()));
  const unique = [...new Set(ordered)].filter((m) => !goneModels.has(m) && (m === process.env.GEMINI_MODEL || isGeminiChatModelName(m)));
  // Modele, które przed chwilą przekroczyły czas / były przeciążone (503) / bez kwoty (429), idą na koniec.
  const healthy = unique.filter((m) => !isCooling(m));
  const cooling = unique.filter((m) => !healthy.includes(m));
  // Modele po 503 przed modelami z wyczerpaną kwotą 429
  const transientCooling = cooling.filter((m) => !quotaCoolingModels.has(m));
  const quotaCooling = cooling.filter((m) => quotaCoolingModels.has(m));
  const orderedCooling = [...transientCooling, ...quotaCooling];
  const pinned = [
    process.env.GEMINI_MODEL,
    requested.startsWith('gemini-') ? requested : null,
    ...provenFast,
    ...availableFreePriority.filter((m) => healthy.includes(m)),
  ].filter((m): m is string => Boolean(m && healthy.includes(m)));
  const uniquePinned = [...new Set(pinned)];
  const pinnedSet = new Set(uniquePinned);
  const remainingHealthy = healthy.filter((m) => !pinnedSet.has(m));
  // skipCooling: zapytania w tle (rozmowa obustronna) nie dotykają modeli na karencji 429/503,
  // żeby nie przepalać odnawiającego się limitu minutowego potrzebnego dla wiadomości Operatora.
  const tail = opts.skipCooling ? [] : orderedCooling;
  return [...uniquePinned, ...diversify(remainingHealthy), ...tail].slice(0, max);
}

/**
 * Różne rodziny po kolei (flash → flash-lite → alias → pro → reszta), żeby po przekroczeniu
 * czasu przez najnowszy flash nie próbować trzech kolejnych równie wolnych modeli flash.
 */
export function diversify(models: string[]): string[] {
  const family = (m: string) => (/-pro\b|gemini-pro/i.test(m) ? 'pro' : /-latest$/i.test(m) ? 'alias' : /flash-lite/i.test(m) ? 'lite' : /gemma/i.test(m) ? 'gemma' : /flash/i.test(m) ? 'flash' : 'other');
  const buckets = new Map<string, string[]>();
  for (const m of models) {
    const f = family(m);
    if (!buckets.has(f)) buckets.set(f, []);
    buckets.get(f)!.push(m);
  }
  // Modele pro na samym końcu: w darmowym limicie klucza zwykle od razu zwracają 429.
  const order = ['flash', 'lite', 'gemma', 'alias', 'other'];
  const out: string[] = [];
  const nonPro = models.length - (buckets.get('pro')?.length || 0);
  while (out.length < nonPro) {
    for (const f of order) {
      const next = buckets.get(f)?.shift();
      if (next) out.push(next);
    }
  }
  out.push(...(buckets.get('pro') || []));
  // Wymuszony GEMINI_MODEL zawsze pierwszy.
  const forced = process.env.GEMINI_MODEL;
  return forced && out.includes(forced) ? [forced, ...out.filter((m) => m !== forced)] : out;
}

/**
 * Ograniczenie „myślenia” modeli Gemini 3.x/4.x (domyślnie myślą długo — czat przekraczał 30 s).
 * Dla `flash-lite` domyślnie używamy `MINIMAL`, dla pozostałych (w tym `gemini-4-hydrogen`, który
 * nie obsługuje `MINIMAL`) używamy `LOW`.
 * GEMINI_THINKING_LEVEL: MINIMAL | LOW | MEDIUM | HIGH | OFF.
 */
export function geminiThinkingConfig(model: string): Record<string, unknown> {
  const clean = String(model || '').replace(/^models\//, '').trim();
  if (/^gemma-/i.test(clean)) return {};
  const isGemini4 = /^gemini-4-/i.test(clean);
  const envLevel = String(process.env.GEMINI_THINKING_LEVEL || '').trim().toUpperCase();
  let level = envLevel || (/flash-lite/i.test(clean) ? 'MINIMAL' : 'LOW');
  if (isGemini4 && level === 'MINIMAL') level = 'LOW';
  if (level === 'OFF' || noThinkingConfig.has(clean)) return {};
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
    /** Limit pojedynczej próby: min(overrideMs || GEMINI_TIMEOUT_MS, pozostały czas). */
    attemptTimeout: (overrideMs?: number) => Math.max(0, Math.min(overrideMs ?? perAttempt, endsAt - Date.now())),
    expired: () => Date.now() >= endsAt - 1000,
  };
}

/**
 * Wybiera najlepszy dostępny model klasy Pro (dla płatnego klucza Tier-2/Tier-3).
 * Preferuje stabilne wersje `gemini-X.Y-pro` (najwyższa wersja) -> `gemini-pro-latest` -> `*-pro-preview*`.
 */
export function selectBestGeminiProModel(models: string[]): string {
  const clean = models
    .map((m) => String(m || '').replace(/^models\//, '').trim())
    .filter(Boolean);
  const proModels = clean.filter((m) => /-pro\b|gemini-pro/i.test(m));
  if (proModels.length === 0) {
    return clean[0] || 'gemini-2.5-pro';
  }
  const scored = [...new Set(proModels)].sort((a, b) => {
    const previewA = /(preview|exp|experimental)/i.test(a) ? 1 : 0;
    const previewB = /(preview|exp|experimental)/i.test(b) ? 1 : 0;
    if (previewA !== previewB) return previewA - previewB;
    const verA = versionOf(a);
    const verB = versionOf(b);
    if (verA !== verB) return verB - verA;
    const latestA = /-latest$/i.test(a) ? 0 : 1;
    const latestB = /-latest$/i.test(b) ? 0 : 1;
    return latestA - latestB || a.localeCompare(b);
  });
  return scored[0] || 'gemini-2.5-pro';
}

