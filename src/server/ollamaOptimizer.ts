import { resolveInstalledOllamaModel } from '../utils/svlLogic';

export interface ChatHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
  sender?: string;
}

export interface OllamaReadyCacheEntry {
  ok: true;
  model: string;
  installedModels: string[];
  checkedAt: number;
}

export interface OllamaRuntimeOptions {
  num_ctx: number;
  num_predict: number;
  /** Czas trzymania modelu w pamięci; -1 = na stałe (bez ponownego ładowania między wiadomościami). */
  keep_alive: string | number;
  historyTurns: number;
  /** Opcje wydajności Ollamy (wątki CPU, warstwy na GPU, wsad, mlock) — tylko ustawione jawnie. */
  perf: Record<string, number | boolean>;
  maxTurnChars: number;
}

const DEFAULT_CACHE_TTL_MS = 30_000;
// Negatywny cache 25 s zapobiega powtarzaniu wolnych prób połączenia przy każdej wiadomości, gdy Ollama jest wyłączona.
const DEFAULT_OFFLINE_CACHE_TTL_MS = 25_000;
const ollamaTagsCache = new Map<
  string,
  { checkedAt: number; version: string; models: Array<{ name?: string; model?: string; [k: string]: unknown }> }
>();
const ollamaOfflineCache = new Map<string, { checkedAt: number; reason: string }>();

export function clearOllamaReadyCache(base?: string): void {
  if (base) {
    const key = base.replace(/\/$/, '');
    ollamaTagsCache.delete(key);
    ollamaOfflineCache.delete(key);
  } else {
    ollamaTagsCache.clear();
    ollamaOfflineCache.clear();
  }
}

/**
 * Only attach GitHub function declarations when the user's message actually relates to
 * GitHub, repositories, branches, PRs, issues, commits, workflows, or creating/editing repo files.
 * Keeps normal chat messages fast (avoids sending 5 large tool schemas on every turn).
 */
export function shouldEnableGitHubToolsForMessage(message: string, hasToken: boolean): boolean {
  if (!hasToken) return false;
  const text = String(message || '').trim();
  if (!text) return false;
  return (
    /\b(?:github|repo|repozytor\p{L}*|commit\p{L}*|branch\p{L}*|gałą[źz]\p{L}*|galaz\p{L}*|pull\s+request|\bpr\b|issue\p{L}*|workflow\p{L}*|release\p{L}*|push|pull|rush47|svl_core|svl_coreos_2)\b/iu.test(
      text,
    ) ||
    /\b(?:utwórz|utworz|stwórz|stworz|dodaj|zapisz|edytuj|zmień|zmien|usuń|usun|odczytaj|pokaż|pokaz|zsynchronizuj|synchronizuj|wyślij|wyslij)\s+(?:mi\s+)?(?:nowy\s+|nową\s+|nowe\s+)?(?:plik\p{L}*|folder\p{L}*|katalog\p{L}*|skrypt\p{L}*|manifest\p{L}*|kod\p{L}*)\b/iu.test(
      text,
    ) ||
    /(?:^|\s)(?:src|backend|SVL_CoreOS_2|\.github|docs|deploy)\/[\w.-]+/i.test(text)
  );
}

/**
 * Selects a balanced maxOutputTokens cap so regular chat turns finish quickly
 * while detailed technical reports, tables, and code requests get extra room.
 */
export function selectChatMaxOutputTokens(message: string): number {
  const text = String(message || '').trim();
  if (
    text.length > 500 ||
    /\b(?:szczegółow\p{L}*|szczegolow\p{L}*|pełny\s+raport|pelny\s+raport|dokumentacj\p{L}*|architektur\p{L}*|napisz\s+(?:kod|skrypt|program|klasę|funkcję)|przeanalizuj\s+cał\p{L}*|wyjaśnij\s+dokładn\p{L}*|porównaj\s+szczegółow\p{L}*)\b/iu.test(
      text,
    )
  ) {
    return 2400;
  }
  return 1100;
}

export function getOllamaRuntimeOptions(env: Record<string, string | undefined> = process.env): OllamaRuntimeOptions {
  const parsePosInt = (raw: string | undefined, fallback: number, min: number, max: number): number => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
  };

  return {
    num_ctx: parsePosInt(env.OLLAMA_NUM_CTX, 2048, 512, 32768),
    num_predict: parsePosInt(env.OLLAMA_NUM_PREDICT, 512, 64, 4096),
    keep_alive: parseKeepAlive(env.OLLAMA_KEEP_ALIVE),
    historyTurns: parsePosInt(env.OLLAMA_HISTORY_TURNS, 12, 2, 48),
    maxTurnChars: parsePosInt(env.OLLAMA_MAX_TURN_CHARS, 2000, 200, 12000),
    perf: parsePerfOptions(env),
  };
}

export const DEFAULT_OLLAMA_STOP_TOKENS: string[] = [
  '<|eot_id|>',
  '<|end_of_text|>',
  '<|im_end|>',
  '[Mateusz (Operator)]:',
  '[Operator]:',
  '\n[Mateusz (Operator)]:',
  '\n[Operator]:',
  '\nUser:',
  '\nUżytkownik:',
];

export interface OllamaTurnOptions {
  num_ctx: number;
  num_predict: number;
  keep_alive: string | number;
  historyTurns: number;
  maxTurnChars: number;
  perf: Record<string, number | boolean>;
  stop: string[];
}

/**
 * Dobiera adaptacyjne opcje na pojedynczą turę Ollamy:
 * - krótkie pytania / pingi dostają mniejszy num_predict (szybsze zakończenie generacji),
 * - zapytania o kod/raporty dostają większy limit wyjściowy,
 * - domyślny num_batch=512 i num_thread=2 przyspieszają prompt_eval bez zmiany jawnych ustawień z env,
 * - stop tokens zatrzymują model natychmiast po ukończeniu właściwej odpowiedzi zamiast halucynować dalej.
 */
export function selectOllamaTurnOptions(
  message: string,
  baseOpts: OllamaRuntimeOptions,
  opts: {
    env?: Record<string, string | undefined>;
    hasTools?: boolean;
    isVision?: boolean;
    estimatedPromptChars?: number;
  } = {},
): OllamaTurnOptions {
  const env = opts.env ?? process.env;
  const text = String(message || '').trim();
  const isDetailed =
    text.length > 420 ||
    /\b(?:szczegółow\p{L}*|szczegolow\p{L}*|pełny\s+raport|pelny\s+raport|dokumentacj\p{L}*|architektur\p{L}*|napisz\s+(?:kod|skrypt|program|klasę|funkcję)|przeanalizuj\s+cał\p{L}*|wyjaśnij\s+dokładn\p{L}*)\b/iu.test(
      text,
    );
  const isShort = !isDetailed && text.length > 0 && text.length <= 48 && !text.includes('\n');

  let numPredict = baseOpts.num_predict;
  if (opts.isVision) {
    numPredict = Math.max(numPredict, Number(env.OLLAMA_VISION_NUM_PREDICT || 1024));
  } else if (isDetailed) {
    numPredict = Math.min(4096, Math.max(numPredict, 1024));
  } else if (isShort && !env.OLLAMA_NUM_PREDICT) {
    numPredict = Math.min(numPredict, 384);
  }

  let numCtx = baseOpts.num_ctx;
  if (opts.isVision) {
    numCtx = Math.max(numCtx, Number(env.OLLAMA_VISION_NUM_CTX || 4096));
  } else if (!env.OLLAMA_NUM_CTX) {
    const promptChars = opts.estimatedPromptChars ?? 0;
    if (opts.hasTools || promptChars > 4500) {
      numCtx = Math.max(numCtx, 4096);
    }
  }

  const perf: Record<string, number | boolean> = {
    ...(baseOpts.perf.num_batch === undefined ? { num_batch: 512 } : {}),
    ...(baseOpts.perf.num_thread === undefined ? { num_thread: 2 } : {}),
    ...baseOpts.perf,
  };

  const historyTurns = env.OLLAMA_HISTORY_TURNS
    ? baseOpts.historyTurns
    : Math.min(baseOpts.historyTurns, 8);
  const maxTurnChars = env.OLLAMA_MAX_TURN_CHARS
    ? baseOpts.maxTurnChars
    : Math.min(baseOpts.maxTurnChars, 1200);

  return {
    num_ctx: Math.min(32768, numCtx),
    num_predict: numPredict,
    keep_alive: baseOpts.keep_alive,
    historyTurns,
    maxTurnChars,
    perf,
    stop: DEFAULT_OLLAMA_STOP_TOKENS,
  };
}

/**
 * Stabilizuje i skraca kontekst systemowy dla Ollamy, usuwając zmienne z każdej tury
 * (np. latency=5752ns, scenario=#848530, pkt=0x..., cykle_wykonane=N), dzięki czemu
 * prefix promptu pozostaje identyczny między turami i trafia w KV-cache Ollamy.
 */
export function buildCompactOllamaSystemContext(fullContext: string, maxChars = 2800): string {
  const raw = String(fullContext || '').trim();
  if (!raw) return '';
  let compact = raw
    // Usuń blok zmiennej telemetrii JEDI VM z per-turn ns/scenario/grid/pkt, który unieważnia KV-cache
    .replace(/\n*\[JEDI OMNI-OS v12 VM \(CZAS RZECZYWISTY[^\]]*\]/gi, '')
    // Zastąp dynamiczny licznik cykli stałą etykietą w opisie widoczności
    .replace(/cykle_wykonane=\d+/g, 'cykle_wykonane=ACTIVE')
    // Usuń długą listę kilkudziesięciu ID modułów SQLite (zostaw liczbę modułów)
    .replace(/aktywne_moduły_SQLite\((\d+)\)=\[[^\]]*\]/g, 'aktywne_moduły_SQLite=$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (compact.length > maxChars) {
    compact = `${compact.slice(0, maxChars - 1).trimEnd()}…`;
  }
  return compact;
}

/** `-1`/`0`/liczba → sekundy (Ollama: -1 = model zostaje w pamięci na stałe); inaczej czas typu „30m”. */
function parseKeepAlive(raw: string | undefined): string | number {
  const value = String(raw ?? '').trim();
  if (!value) return -1;
  return /^-?\d+$/.test(value) ? Number(value) : value;
}

/**
 * Domyślnie Ollama sama dobiera wątki (rdzenie fizyczne) i liczbę warstw na GPU (ile zmieści VRAM) —
 * to zwykle najszybsze ustawienie. Jawne wartości z env pozwalają wymusić maksimum na danym sprzęcie.
 */
function parsePerfOptions(env: Record<string, string | undefined>): Record<string, number | boolean> {
  const perf: Record<string, number | boolean> = {};
  const int = (key: string, name: string, min: number, max: number) => {
    const n = Number(env[key]);
    if (env[key] !== undefined && env[key] !== '' && Number.isFinite(n) && n >= min) perf[name] = Math.min(max, Math.floor(n));
  };
  int('OLLAMA_NUM_THREAD', 'num_thread', 1, 512);
  int('OLLAMA_NUM_GPU', 'num_gpu', 0, 999);
  int('OLLAMA_NUM_BATCH', 'num_batch', 1, 8192);
  const flag = String(env.OLLAMA_USE_MLOCK || '').trim().toLowerCase();
  if (flag === '1' || flag === 'true') perf.use_mlock = true;
  return perf;
}

/**
 * Wstępne załadowanie modeli do pamięci (pusty prompt + keep_alive), żeby pierwsza odpowiedź
 * nie czekała na wczytanie modelu z dysku. Zwraca wynik dla każdego modelu (bez wyjątków).
 */
export async function warmOllamaModels(
  baseUrl: string,
  models: string[],
  opts: { keepAlive?: string | number; timeoutMs?: number; fetchImpl?: typeof fetch; perf?: Record<string, number | boolean> } = {},
): Promise<Array<{ model: string; ok: boolean; detail: string }>> {
  const base = baseUrl.replace(/\/$/, '');
  const fetchFn = opts.fetchImpl ?? fetch;
  const unique = [...new Set(models.map((m) => String(m || '').trim()).filter(Boolean))];
  const results: Array<{ model: string; ok: boolean; detail: string }> = [];
  for (const model of unique) {
    try {
      const res = await fetchFn(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
        body: JSON.stringify({ model, prompt: '', stream: false, keep_alive: opts.keepAlive ?? -1, options: opts.perf ?? {} }),
      });
      results.push({ model, ok: res.ok, detail: res.ok ? 'załadowany do pamięci' : `HTTP ${res.status}` });
    } catch (error) {
      results.push({ model, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

/**
 * Trims conversation history sent to local Ollama so prompt evaluation stays fast
 * while preserving the most recent turns.
 */
export function trimHistoryForOllama(
  turns: ChatHistoryTurn[],
  maxTurns = 12,
  maxTurnChars = 2000,
): ChatHistoryTurn[] {
  if (!Array.isArray(turns) || turns.length === 0) return [];
  const safeMaxTurns = Math.max(1, maxTurns);
  const safeMaxChars = Math.max(120, maxTurnChars);
  return turns.slice(-safeMaxTurns).map((turn) => {
    const content = String(turn.content || '');
    if (content.length <= safeMaxChars) return { ...turn };
    return {
      ...turn,
      content: `${content.slice(0, safeMaxChars - 1).trimEnd()}…`,
    };
  });
}

/**
 * Auto GitHub sync in AI Studio mutates tracked files on disk and triggers automatic
 * "Manual edit" checkpoints. Require explicit opt-in via SVL_ALLOW_AUTO_GIT_SYNC=1.
 */
export function isAutoGitSyncAllowed(env: Record<string, string | undefined> = process.env): boolean {
  const sec = Math.max(0, Number(env.SVL_GITHUB_AUTOSYNC_SEC || 0) || 0);
  if (sec <= 0) return false;
  const optIn = String(env.SVL_ALLOW_AUTO_GIT_SYNC || '').trim().toLowerCase();
  return optIn === '1' || optIn === 'true' || optIn === 'yes';
}

/**
 * Resolves and validates an installed Ollama model with a 30s TTL cache per host (and 15s negative
 * cache when offline) so consecutive chat/proactive calls skip redundant network probes.
 */
export type ResolveCachedOllamaResult =
  | {
      ok: true;
      model: string;
      cached: boolean;
      exactMatch: boolean;
      substituted: boolean;
      installedModels: string[];
      version: string;
    }
  | { ok: false; reason: string; cached?: boolean };

export async function resolveCachedOllamaModel(
  baseUrl: string,
  requestedModel: string,
  opts: {
    requireVision?: boolean;
    forceRefresh?: boolean;
    ttlMs?: number;
    offlineTtlMs?: number;
    probeTimeoutMs?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<ResolveCachedOllamaResult> {
  const base = baseUrl.replace(/\/$/, '');
  const ttlMs = opts.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const offlineTtlMs = opts.offlineTtlMs ?? DEFAULT_OFFLINE_CACHE_TTL_MS;
  // 1,5 s dawało fałszywe „niedostępna”, gdy Ollama ładowała lub generowała model.
  const probeTimeoutMs = opts.probeTimeoutMs ?? 6000;
  const fetchFn = opts.fetchImpl ?? fetch;

  const extractNames = (list: Array<{ name?: string; model?: string }>): string[] =>
    list.map((m) => String(m?.name || m?.model || '').trim()).filter(Boolean);

  const cached = ollamaTagsCache.get(base);
  if (!opts.forceRefresh && cached && Date.now() - cached.checkedAt < ttlMs) {
    const resolved = resolveInstalledOllamaModel(
      requestedModel,
      cached.models,
      Boolean(opts.requireVision),
    );
    if (resolved.installedCount > 0) {
      return {
        ok: true,
        model: resolved.name,
        cached: true,
        exactMatch: !resolved.substituted,
        substituted: resolved.substituted,
        installedModels: extractNames(cached.models),
        version: cached.version,
      };
    }
  }

  const cachedOffline = ollamaOfflineCache.get(base);
  if (!opts.forceRefresh && cachedOffline && Date.now() - cachedOffline.checkedAt < offlineTtlMs) {
    return { ok: false, reason: cachedOffline.reason, cached: true };
  }

  try {
    const [versionRes, tagsRes] = await Promise.all([
      fetchFn(`${base}/api/version`, { signal: AbortSignal.timeout(probeTimeoutMs) }),
      fetchFn(`${base}/api/tags`, { signal: AbortSignal.timeout(probeTimeoutMs) }),
    ]);
    if (!versionRes.ok) {
      ollamaTagsCache.delete(base);
      const reason = `Ollama (${base}) odpowiada kodem ${versionRes.status}`;
      ollamaOfflineCache.set(base, { checkedAt: Date.now(), reason });
      return { ok: false, reason };
    }
    const version: any = await versionRes.json();
    const versionStr = String(version?.version || '');
    if (versionStr.includes('svl-364')) {
      ollamaTagsCache.delete(base);
      const reason = `pod ${base} działa wbudowany zastępnik Ollamy, który nie uruchamia modeli`;
      ollamaOfflineCache.set(base, { checkedAt: Date.now(), reason });
      return { ok: false, reason };
    }
    if (!tagsRes.ok) {
      ollamaTagsCache.delete(base);
      const reason = `Ollama (${base}) nie zwróciła listy modeli (kod ${tagsRes.status})`;
      ollamaOfflineCache.set(base, { checkedAt: Date.now(), reason });
      return { ok: false, reason };
    }
    const tags: any = await tagsRes.json();
    const models = Array.isArray(tags?.models) ? tags.models : [];
    const resolved = resolveInstalledOllamaModel(requestedModel, models, Boolean(opts.requireVision));
    if (resolved.installedCount === 0) {
      ollamaTagsCache.delete(base);
      const reason = `w Ollamie (${base}) nie ma żadnego pobranego modelu`;
      ollamaOfflineCache.set(base, { checkedAt: Date.now(), reason });
      return { ok: false, reason };
    }
    ollamaOfflineCache.delete(base);
    ollamaTagsCache.set(base, {
      checkedAt: Date.now(),
      version: versionStr,
      models,
    });
    return {
      ok: true,
      model: resolved.name,
      cached: false,
      exactMatch: !resolved.substituted,
      substituted: resolved.substituted,
      installedModels: extractNames(models),
      version: versionStr,
    };
  } catch (error) {
    ollamaTagsCache.delete(base);
    const reason = `Ollama (${base}) niedostępna: ${error instanceof Error ? error.message : String(error)}`;
    ollamaOfflineCache.set(base, { checkedAt: Date.now(), reason });
    return {
      ok: false,
      reason,
    };
  }
}
