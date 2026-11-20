// Klient xAI Grok (OpenAI-compatible chat completions).
// Klucz tylko z process.env.XAI_API_KEY — nigdy nie logować ani nie zwracać jego wartości.

export const XAI_API_BASE = 'https://api.x.ai/v1';
export const DEFAULT_XAI_MODEL = 'grok-4.7';
export const DEFAULT_XAI_TIMEOUT_MS = 60_000;
export const XAI_MAX_RETRIES = 2;

const PLACEHOLDER_KEY_RE =
  /^(your_?xai_?api_?key|my_?xai_?api_?key|xai_?api_?key|your_?api_?key|api_?key|changeme|change_?me|replace_?me|insert_?key|placeholder|example|sample|todo|none|null|undefined|xxx+)$/i;

export interface XaiChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<Record<string, unknown>>;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

export interface XaiChatToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type XaiChatResult =
  | { ok: true; text: string; model: string; toolCalls: XaiChatToolCall[]; finishReason: string }
  | { ok: false; reason: string; status?: number; retryable?: boolean };

export interface XaiCompleteOptions {
  messages: XaiChatMessage[];
  tools?: Array<Record<string, unknown>>;
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  model?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

function normalizeKey(raw: unknown): string {
  return String(raw || '').trim();
}

function isPlaceholderKey(key: string): boolean {
  if (!key) return true;
  if (key.length < 10) return true;
  if (PLACEHOLDER_KEY_RE.test(key)) return true;
  if (/^xai[-_]?your/i.test(key)) return true;
  return false;
}

/** True only when a real-looking XAI_API_KEY is present (empty and placeholders are rejected). */
export function isXaiConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isPlaceholderKey(normalizeKey(env.XAI_API_KEY));
}

export function getXaiApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = normalizeKey(env.XAI_API_KEY);
  return isPlaceholderKey(key) ? null : key;
}

export function getXaiModel(env: NodeJS.ProcessEnv = process.env): string {
  const model = String(env.XAI_MODEL || '').trim();
  return model || DEFAULT_XAI_MODEL;
}

export function getXaiTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.XAI_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed >= 1000 ? Math.floor(parsed) : DEFAULT_XAI_TIMEOUT_MS;
}

export function isXaiRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export function scrubXaiSecrets(input: string, apiKey?: string | null): string {
  let cleaned = String(input || '');
  const key = String(apiKey || '').trim();
  if (key.length >= 8) cleaned = cleaned.split(key).join('[REDACTED]');
  cleaned = cleaned.replace(/\bBearer\s+[A-Za-z0-9_.\-=+/]{8,}/gi, 'Bearer [REDACTED]');
  return cleaned;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryBackoffMs(attemptIndex: number): number {
  // attemptIndex is 0 after the first failure: 500 ms, then 1500 ms
  return attemptIndex === 0 ? 500 : 1500;
}

function parseToolCalls(raw: unknown): XaiChatToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: XaiChatToolCall[] = [];
  for (const item of raw) {
    const fn = item?.function || item;
    const name = String(fn?.name || '').trim();
    if (!name) continue;
    let args: Record<string, unknown> = {};
    const rawArgs = fn?.arguments;
    if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
      args = rawArgs as Record<string, unknown>;
    } else if (typeof rawArgs === 'string' && rawArgs.trim()) {
      try {
        const parsed = JSON.parse(rawArgs);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
      } catch {
        args = {};
      }
    }
    out.push({ id: String(item?.id || name), name, arguments: args });
  }
  return out;
}

export const XAI_CREDITS_EXHAUSTED_MESSAGE = 'Grok: brak kredytów na koncie xAI';

export type SvlChatEngine = 'auto' | 'ollama' | 'grok';

/**
 * Który silnik czatu jest pierwszy.
 * `SVL_CHAT_ENGINE=ollama` (albo `local`) nie woła Groka w ogóle.
 * `auto` (domyślnie) i `grok` próbują xAI, gdy jest klucz, a przy 401/402/403 wracają do Ollamy.
 */
export function getSvlChatEngine(env: NodeJS.ProcessEnv = process.env): SvlChatEngine {
  const raw = String(env.SVL_CHAT_ENGINE || '').trim().toLowerCase();
  if (raw === 'ollama' || raw === 'local') return 'ollama';
  if (raw === 'grok' || raw === 'xai') return 'grok';
  return 'auto';
}

/** Czy w tym żądaniu w ogóle wołać API xAI. */
export function shouldAttemptGrok(
  env: NodeJS.ProcessEnv,
  opts: { explicitOllama: boolean; explicitGemini: boolean; webSearchViaGemini: boolean },
): boolean {
  if (getSvlChatEngine(env) === 'ollama') return false;
  if (!isXaiConfigured(env)) return false;
  if (opts.explicitOllama || opts.explicitGemini || opts.webSearchViaGemini) return false;
  return true;
}

/** 401 (zły klucz), 402 i 403 (brak kredytów / limit) — czat ma przejść na Ollamę, nie kończyć błędem. */
export function isXaiAuthOrBillingStatus(status: number | undefined): boolean {
  return status === 401 || status === 402 || status === 403;
}

/** 403/402 związane z kredytami lub limitem wydatków — nie ponawiać, wrócić do Ollamy. */
export function isXaiCreditsExhaustedError(status: number | undefined, bodyOrMessage: string): boolean {
  const raw = String(bodyOrMessage || '');
  if (
    /\b(?:no credits?|out of credits?|used up .{0,80}credits?|does not have any credits?|exceeded .{0,60}(?:spending|spend) limit|(?:spending|spend) limit|insufficient (?:credits?|funds)|kredyt)/i.test(
      raw,
    )
  ) {
    return true;
  }
  if (status === 402) return true;
  // Aktualne API xAI zwraca 403 permission-denied, gdy zespół nie ma kredytów / przekroczył limit wydatków.
  if (status === 403 && /permission[-_ ]?denied|PERMISSION_DENIED/i.test(raw)) return true;
  return false;
}

function describeHttpError(status: number, bodyText: string, timeoutMs: number, apiKey: string | null): string {
  const cleanedBody = scrubXaiSecrets(bodyText, apiKey).replace(/\s+/g, ' ').trim();
  let detail = cleanedBody.slice(0, 160);
  const jsonStart = cleanedBody.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(cleanedBody.slice(jsonStart));
      const err = parsed?.error || parsed;
      if (err?.message) detail = String(err.message).slice(0, 160);
      else if (typeof err?.code === 'string') detail = err.code.slice(0, 160);
    } catch {
      // keep truncated body
    }
  }
  if (isXaiCreditsExhaustedError(status, `${cleanedBody} ${detail}`)) {
    return XAI_CREDITS_EXHAUSTED_MESSAGE;
  }
  if (status === 401 || status === 403) {
    return `xAI odrzuciło klucz API (HTTP ${status}${detail ? `: ${detail}` : ''})`;
  }
  if (status === 429) {
    return `xAI: wyczerpany limit zapytań (HTTP 429${detail ? `: ${detail}` : ''})`;
  }
  if (!detail) return `xAI /chat/completions zwróciło HTTP ${status}`;
  return `xAI HTTP ${status}: ${detail}`;
}

function describeCaughtError(error: unknown, timeoutMs: number, apiKey: string | null): string {
  const raw = scrubXaiSecrets(error instanceof Error ? error.message : String(error), apiKey);
  if (/aborted|AbortError|TimeoutError|timed? ?out/i.test(raw)) {
    return `przekroczono limit czasu Grok (${Math.round(timeoutMs / 1000)} s)`;
  }
  return `Grok niedostępny: ${raw.slice(0, 160)}`;
}

/** Jedno wywołanie /v1/chat/completions z 1–2 ponowieniami przy 429/5xx. */
export async function completeXaiChat(options: XaiCompleteOptions): Promise<XaiChatResult> {
  const env = options.env || process.env;
  const apiKey = getXaiApiKey(env);
  if (!apiKey) {
    return { ok: false, reason: 'brak klucza XAI_API_KEY' };
  }

  const model = options.model || getXaiModel(env);
  const timeoutMs = options.timeoutMs ?? getXaiTimeoutMs(env);
  const fetchImpl = options.fetchImpl || fetch;
  const sleep = options.sleep || defaultSleep;
  const payload: Record<string, unknown> = {
    model,
    messages: options.messages,
    stream: false,
  };
  if (typeof options.temperature === 'number' && Number.isFinite(options.temperature)) {
    payload.temperature = options.temperature;
  }
  if (typeof options.maxTokens === 'number' && Number.isFinite(options.maxTokens) && options.maxTokens > 0) {
    payload.max_tokens = Math.floor(options.maxTokens);
  }
  if (Array.isArray(options.stop) && options.stop.length > 0) {
    payload.stop = options.stop;
  }
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    payload.tools = options.tools;
    payload.tool_choice = 'auto';
  }

  let lastFailure: XaiChatResult = { ok: false, reason: 'Grok nie odpowiedział' };
  const maxAttempts = 1 + XAI_MAX_RETRIES;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetchImpl(`${XAI_API_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify(payload),
      });
      const raw = await response.text();
      if (!response.ok) {
        const reason = describeHttpError(response.status, raw, timeoutMs, apiKey);
        const retryable = isXaiRetryableStatus(response.status);
        lastFailure = { ok: false, reason, status: response.status, retryable };
        if (retryable && attempt < maxAttempts - 1) {
          await sleep(retryBackoffMs(attempt));
          continue;
        }
        return lastFailure;
      }
      let data: any = {};
      try {
        data = raw && !raw.trim().startsWith('<') ? JSON.parse(raw) : {};
      } catch {
        return { ok: false, reason: 'xAI zwróciło niepoprawny JSON', status: response.status };
      }
      const choice = Array.isArray(data?.choices) ? data.choices[0] : undefined;
      const message = choice?.message || {};
      const text = String(message?.content || '').trim();
      const toolCalls = parseToolCalls(message?.tool_calls);
      const usedModel = String(data?.model || model);
      if (!text && toolCalls.length === 0) {
        return { ok: false, reason: 'model Grok zwrócił pustą odpowiedź', status: response.status };
      }
      return {
        ok: true,
        text,
        model: usedModel,
        toolCalls,
        finishReason: String(choice?.finish_reason || (toolCalls.length > 0 ? 'tool_calls' : 'stop')),
      };
    } catch (error) {
      lastFailure = { ok: false, reason: describeCaughtError(error, timeoutMs, apiKey) };
      // Ponawiamy tylko 429/5xx — błędy sieci/timeout nie są w tym zakresie.
      return lastFailure;
    }
  }

  return lastFailure;
}
