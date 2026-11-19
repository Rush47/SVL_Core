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
  keep_alive: string;
  historyTurns: number;
  maxTurnChars: number;
}

const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_OFFLINE_CACHE_TTL_MS = 15_000;
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
    keep_alive: String(env.OLLAMA_KEEP_ALIVE || '30m').trim() || '30m',
    historyTurns: parsePosInt(env.OLLAMA_HISTORY_TURNS, 12, 2, 48),
    maxTurnChars: parsePosInt(env.OLLAMA_MAX_TURN_CHARS, 2000, 200, 12000),
  };
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
): Promise<{ ok: true; model: string; cached: boolean } | { ok: false; reason: string; cached?: boolean }> {
  const base = baseUrl.replace(/\/$/, '');
  const ttlMs = opts.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const offlineTtlMs = opts.offlineTtlMs ?? DEFAULT_OFFLINE_CACHE_TTL_MS;
  const probeTimeoutMs = opts.probeTimeoutMs ?? 1500;
  const fetchFn = opts.fetchImpl ?? fetch;

  const cached = ollamaTagsCache.get(base);
  if (!opts.forceRefresh && cached && Date.now() - cached.checkedAt < ttlMs) {
    const resolved = resolveInstalledOllamaModel(
      requestedModel,
      cached.models,
      Boolean(opts.requireVision),
    );
    if (resolved.installedCount > 0) {
      return { ok: true, model: resolved.name, cached: true };
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
    return { ok: true, model: resolved.name, cached: false };
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
