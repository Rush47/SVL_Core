/**
 * Klientowy zbieracz zdarzeń GUI dla SVL Python OS.
 * Strumieniuje na bieżąco do `/api/logs/gui` (zapisywanego w `logi/gui_zdarzenia.txt` i `logi/system_wszystko.txt`):
 *  - kliknięcia przycisków, zakładek, linków i kontrolek
 *  - wysyłki formularzy i zmiany opcji (z pełnym maskowaniem pól haseł i tokenów)
 *  - przełączenia zakładek i nawigację URL
 *  - wszystkie wywołania HTTP/API z GUI (`trackGuiApiCall`)
 *  - błędy JS (`window.onerror`), `unhandledrejection`, błędy renderowania React oraz wpisy `console.*`
 */

export type GuiLogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

export interface GuiLogEvent {
  kind: string;
  level: GuiLogLevel;
  action: string;
  target?: string;
  tab?: string;
  detail?: unknown;
  url?: string;
  origin?: string;
  correlationId?: string;
  timestamp: string;
}

const nativeFetch: typeof fetch | null =
  typeof window !== 'undefined' && typeof window.fetch === 'function' ? window.fetch.bind(window) : null;

const MAX_QUEUE_SIZE = 200;
const FLUSH_INTERVAL_MS = 350;

let initialized = false;
let currentTab = 'chat';
let tabOrigin = `gui-${Date.now().toString(36)}`;
let eventQueue: GuiLogEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let isFlushing = false;
let internalConsoleDepth = 0;

const SENSITIVE_HINT_RE = /(token|secret|password|passwd|haslo|hasło|klucz|apikey|api_key|authorization)/i;

function scrubGuiString(raw: unknown, maxLen = 600): string {
  let text = String(raw ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\bBearer\s+[A-Za-z0-9_.\-=+/]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\bsvl-auth\.[A-Za-z0-9_-]{4,}/gi, 'svl-auth.[REDACTED]')
    .replace(/(x-svl-operator-token|authorization)\s*[:=]\s*['"]?[^\s,'";\]]+/gi, '$1=[REDACTED]')
    .replace(
      /\b(api[_-]?key|password|passwd|operator[_-]?token|secret|token)\s*[:=]\s*['"]?([^\s,'";\]\}]{4,})/gi,
      '$1=[REDACTED]',
    )
    .replace(/data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]{32,}/gi, '[DATA_IMAGE_BASE64]');

  try {
    const token = typeof window !== 'undefined' ? window.localStorage?.getItem('svl_operator_token') : null;
    if (token && token.length >= 8) {
      text = text.split(token).join('[REDACTED]');
    }
  } catch {
    // ignore storage restriction
  }
  return text.trim().slice(0, maxLen);
}

function isSensitiveElement(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLInputElement) {
    if (el.type === 'password') return true;
    const hints = `${el.name || ''} ${el.id || ''} ${el.placeholder || ''} ${el.getAttribute('aria-label') || ''}`;
    if (SENSITIVE_HINT_RE.test(hints)) return true;
  }
  if (el instanceof HTMLTextAreaElement) {
    const hints = `${el.name || ''} ${el.id || ''} ${el.placeholder || ''} ${el.getAttribute('aria-label') || ''}`;
    if (SENSITIVE_HINT_RE.test(hints)) return true;
  }
  return false;
}

function describeElement(el: Element | null): string {
  if (!el) return '';
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role');
  const aria = el.getAttribute('aria-label');
  const id = el.id ? `#${el.id}` : '';
  const name = el.getAttribute('name');
  const testId = el.getAttribute('data-testid');

  let label = '';
  if (!isSensitiveElement(el)) {
    const textContent = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (textContent) {
      label = scrubGuiString(textContent, 80);
    }
  } else {
    label = '[MASKED_SECRET_INPUT]';
  }

  const parts = [tag + id];
  if (role) parts.push(`role=${role}`);
  if (aria) parts.push(`aria="${scrubGuiString(aria, 60)}"`);
  if (name) parts.push(`name="${scrubGuiString(name, 40)}"`);
  if (testId) parts.push(`testid="${scrubGuiString(testId, 40)}"`);
  if (label && label !== aria) parts.push(`"${label}"`);
  return parts.join(' ').slice(0, 180);
}

function scheduleFlush(immediate = false): void {
  if (typeof window === 'undefined') return;
  if (immediate) {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    void flushGuiLogQueue();
    return;
  }
  if (flushTimer === null) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushGuiLogQueue();
    }, FLUSH_INTERVAL_MS);
  }
}

export async function flushGuiLogQueue(useBeacon = false): Promise<void> {
  if (typeof window === 'undefined' || eventQueue.length === 0) return;

  if (useBeacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    const batch = eventQueue.splice(0, 40);
    try {
      const blob = new Blob([JSON.stringify({ events: batch })], { type: 'application/json' });
      navigator.sendBeacon('/api/logs/gui', blob);
    } catch {
      // ignore unload failure
    }
    return;
  }

  if (isFlushing || !nativeFetch) return;
  isFlushing = true;
  try {
    while (eventQueue.length > 0) {
      const batch = eventQueue.splice(0, 40);
      try {
        await nativeFetch('/api/logs/gui', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ events: batch }),
          keepalive: true,
        });
      } catch {
        // Drop failed batch cleanly without recursive console errors
        break;
      }
    }
  } finally {
    isFlushing = false;
  }
}

export function setGuiLoggerContext(ctx: { tab?: string; origin?: string }): void {
  if (ctx.origin) tabOrigin = scrubGuiString(ctx.origin, 80);
  if (ctx.tab && ctx.tab !== currentTab) {
    const prev = currentTab;
    currentTab = scrubGuiString(ctx.tab, 40);
    trackGuiEvent({
      kind: 'navigation',
      level: 'INFO',
      action: `Zmiana zakładki GUI: ${prev} -> ${currentTab}`,
      tab: currentTab,
      detail: { from: prev, to: currentTab },
    });
  }
}

export function trackGuiEvent(input: {
  kind: string;
  level?: GuiLogLevel;
  action: string;
  target?: string;
  tab?: string;
  detail?: unknown;
  correlationId?: string;
  immediate?: boolean;
}): void {
  if (typeof window === 'undefined') return;
  const evt: GuiLogEvent = {
    kind: scrubGuiString(input.kind, 40) || 'gui_event',
    level: input.level || 'INFO',
    action: scrubGuiString(input.action, 220),
    target: input.target ? scrubGuiString(input.target, 180) : undefined,
    tab: input.tab ? scrubGuiString(input.tab, 40) : currentTab,
    detail: input.detail,
    url: scrubGuiString(`${window.location.pathname}${window.location.hash}`, 180),
    origin: tabOrigin,
    correlationId: input.correlationId ? scrubGuiString(input.correlationId, 80) : undefined,
    timestamp: new Date().toISOString(),
  };

  eventQueue.push(evt);
  if (eventQueue.length > MAX_QUEUE_SIZE) {
    eventQueue.splice(0, eventQueue.length - MAX_QUEUE_SIZE);
  }
  scheduleFlush(Boolean(input.immediate) || evt.level === 'ERROR' || eventQueue.length >= 25);
}

export function trackGuiApiCall(info: {
  method: string;
  url: string;
  status: number;
  ok: boolean;
  durationMs: number;
  correlationId?: string;
  error?: string | null;
}): void {
  if (info.url.startsWith('/api/logs/gui')) return;
  trackGuiEvent({
    kind: 'gui_http',
    level: info.ok ? 'INFO' : info.status === 0 || info.status >= 500 ? 'ERROR' : 'WARN',
    action: `${info.method} ${scrubGuiString(info.url, 140)} -> HTTP ${info.status} (${Math.round(info.durationMs)} ms)`,
    correlationId: info.correlationId,
    detail: info.error ? { error: scrubGuiString(info.error, 300) } : undefined,
    immediate: !info.ok,
  });
}

function serializeConsoleArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (arg instanceof Error) {
        return `${arg.name}: ${arg.message}`;
      }
      if (typeof arg === 'string') return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ')
    .slice(0, 600);
}

export function initGuiTelemetryLogger(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;

  trackGuiEvent({
    kind: 'gui_boot',
    level: 'INFO',
    action: 'Uruchomiono interfejs GUI SVL Python OS',
    detail: {
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      userAgent: navigator.userAgent.slice(0, 140),
    },
    immediate: true,
  });

  // 1. Przechwytywanie kliknięć na interaktywnych elementach i nawigacji
  document.addEventListener(
    'click',
    (evt) => {
      const targetEl = evt.target instanceof Element ? evt.target : null;
      const interactive =
        targetEl?.closest('button, a, [role="button"], [role="tab"], input, select, summary') || targetEl;
      if (!interactive) return;
      trackGuiEvent({
        kind: 'gui_click',
        level: 'INFO',
        action: 'Kliknięcie elementu GUI',
        target: describeElement(interactive),
      });
    },
    { capture: true, passive: true },
  );

  // 2. Przechwytywanie zmian pól (select/checkbox/radio/input z pełnym maskowaniem sekretów)
  document.addEventListener(
    'change',
    (evt) => {
      const targetEl = evt.target instanceof Element ? evt.target : null;
      if (!targetEl) return;
      let summary = '';
      if (isSensitiveElement(targetEl)) {
        summary = '[MASKED_SECRET_VALUE]';
      } else if (targetEl instanceof HTMLInputElement) {
        if (targetEl.type === 'checkbox' || targetEl.type === 'radio') {
          summary = `checked=${String(targetEl.checked)}`;
        } else if (targetEl.type === 'file') {
          summary = `files=${targetEl.files?.length || 0}`;
        } else {
          summary = `len=${targetEl.value.length}`;
        }
      } else if (targetEl instanceof HTMLSelectElement) {
        summary = `value="${scrubGuiString(targetEl.value, 80)}"`;
      } else if (targetEl instanceof HTMLTextAreaElement) {
        summary = `len=${targetEl.value.length}`;
      }
      trackGuiEvent({
        kind: 'gui_change',
        level: 'INFO',
        action: `Zmiana pola GUI (${summary})`,
        target: describeElement(targetEl),
      });
    },
    { capture: true, passive: true },
  );

  // 3. Wysyłki formularzy
  document.addEventListener(
    'submit',
    (evt) => {
      const formEl = evt.target instanceof Element ? evt.target : null;
      trackGuiEvent({
        kind: 'gui_submit',
        level: 'INFO',
        action: 'Wysłanie formularza GUI',
        target: describeElement(formEl),
        immediate: true,
      });
    },
    { capture: true, passive: true },
  );

  // 4. Błędy runtime JS i nieobsłużone Promise
  window.addEventListener('error', (evt) => {
    trackGuiEvent({
      kind: 'gui_js_error',
      level: 'ERROR',
      action: `Błąd JS: ${scrubGuiString(evt.message || 'Unknown error', 220)}`,
      detail: {
        filename: evt.filename ? scrubGuiString(evt.filename, 140) : undefined,
        lineno: evt.lineno,
        colno: evt.colno,
      },
      immediate: true,
    });
  });

  window.addEventListener('unhandledrejection', (evt) => {
    const reason = evt.reason;
    const msg =
      reason instanceof Error ? `${reason.name}: ${reason.message}` : scrubGuiString(reason, 220);
    // Ignoruj powtarzany szum z zamknięcia HMR proxy, bo main.tsx obsługuje go raz
    if (msg.includes('WebSocket closed without opened')) return;
    trackGuiEvent({
      kind: 'gui_unhandled_rejection',
      level: 'ERROR',
      action: `Nieobsłużony Promise: ${msg}`,
      immediate: true,
    });
  });

  // 5. Zapisywanie console.log / info / warn / error do gui_zdarzenia.txt
  const consoleMethods: Array<{ fn: 'log' | 'info' | 'warn' | 'error'; level: GuiLogLevel }> = [
    { fn: 'error', level: 'ERROR' },
    { fn: 'warn', level: 'WARN' },
    { fn: 'info', level: 'INFO' },
    { fn: 'log', level: 'DEBUG' },
  ];
  for (const { fn, level } of consoleMethods) {
    const original = console[fn].bind(console);
    console[fn] = (...args: unknown[]) => {
      original(...args);
      if (internalConsoleDepth > 0) return;
      internalConsoleDepth += 1;
      try {
        const text = serializeConsoleArgs(args);
        if (text && !text.includes('/api/logs/gui')) {
          trackGuiEvent({
            kind: `console_${fn}`,
            level,
            action: scrubGuiString(text, 240),
            immediate: level === 'ERROR',
          });
        }
      } finally {
        internalConsoleDepth -= 1;
      }
    };
  }

  // 6. Wysyłka końcowa przy zamknięciu lub ukryciu karty
  window.addEventListener('pagehide', () => {
    trackGuiEvent({
      kind: 'gui_lifecycle',
      level: 'INFO',
      action: 'Zamknięcie lub ukrycie karty GUI (pagehide)',
    });
    void flushGuiLogQueue(true);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      void flushGuiLogQueue(true);
    }
  });
}
