// Ramki synchronizacji repozytorium z serwera (WebSocket /ws/svl lub SSE /api/events)
// zamieniane na zdarzenia okna, których słuchają panele GUI i baner aktualizacji.

import { useEffect, useRef } from 'react';

export const LIVE_FRAME_EVENTS: Record<string, string> = {
  'svl.repo_changed': 'svl:repo-changed',
  'svl.git_head': 'svl:git-head',
  'svl.app_building': 'svl:app-building',
  'svl.app_updated': 'svl:app-updated',
  'svl.app_build_failed': 'svl:app-build-failed',
  'svl.restart_required': 'svl:restart-required',
  'svl.restarting': 'svl:restarting',
  'svl.python_restarting': 'svl:python-restarting',
};

export const APP_BUILD_EVENT = 'svl:app-build-id';
const RELOAD_STATE_KEY = 'svl:live-reload-state';

/** Zwraca true, gdy ramka była ramką synchronizacji repozytorium (i rozesłano ją jako zdarzenie okna). */
export function dispatchLiveRepoFrame(frame: any, target: Pick<Window, 'dispatchEvent'> | undefined = typeof window !== 'undefined' ? window : undefined): boolean {
  if (!frame || typeof frame !== 'object') return false;
  if (frame.type === 'svl.hello' && typeof frame.appBuildId === 'string' && frame.appBuildId) {
    target?.dispatchEvent(new CustomEvent(APP_BUILD_EVENT, { detail: { buildId: frame.appBuildId, via: 'hello' } }));
    return false; // hello obsługuje dalej magazyn synchronizacji
  }
  const name = LIVE_FRAME_EVENTS[String(frame.type || '')];
  if (!name) return false;
  target?.dispatchEvent(new CustomEvent(name, { detail: frame }));
  return true;
}

/** Czy użytkownik właśnie coś pisze (wtedy nie przeładowujemy strony bez pytania). */
export function isUserTyping(doc: Document | undefined = typeof document !== 'undefined' ? document : undefined): boolean {
  const el = doc?.activeElement as (HTMLElement & { value?: string }) | null | undefined;
  if (!el) return false;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA' || (tag === 'INPUT' && !/^(button|checkbox|radio|submit|range|color)$/i.test(String((el as HTMLInputElement).type || '')))) {
    return String(el.value || '').trim().length > 0;
  }
  return Boolean(el.isContentEditable);
}

export type ReloadDecision = 'reload' | 'wait' | 'prompt' | 'ignore';

/** Decyzja po nowej wersji GUI: przeładuj od razu, poczekaj aż użytkownik skończy pisać, zapytaj, albo nic. */
export function decideReload(opts: { policy?: string; newBuildId?: string; knownBuildId?: string | null; typing: boolean }): ReloadDecision {
  if (!opts.newBuildId || (opts.knownBuildId && opts.knownBuildId === opts.newBuildId)) return 'ignore';
  const policy = String(opts.policy || 'auto');
  if (policy === 'off') return 'ignore';
  if (policy === 'prompt') return 'prompt';
  return opts.typing ? 'wait' : 'reload';
}

/** Zapisuje lekki stan widoku (zakładka, przewinięcie) przed przeładowaniem po aktualizacji. */
export function saveReloadState(state: Record<string, unknown>, storage: Storage | undefined = typeof sessionStorage !== 'undefined' ? sessionStorage : undefined): void {
  try {
    storage?.setItem(RELOAD_STATE_KEY, JSON.stringify({ ...state, savedAt: Date.now() }));
  } catch {
    // brak sessionStorage
  }
}

/** Odczytuje (jednorazowo) stan zapisany przed przeładowaniem; starszy niż 2 min jest pomijany. */
export function takeReloadState(storage: Storage | undefined = typeof sessionStorage !== 'undefined' ? sessionStorage : undefined): Record<string, any> | null {
  try {
    const raw = storage?.getItem(RELOAD_STATE_KEY);
    if (!raw) return null;
    storage?.removeItem(RELOAD_STATE_KEY);
    const parsed = JSON.parse(raw);
    if (!parsed || Date.now() - Number(parsed.savedAt || 0) > 120_000) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Czy paczka zmian dotyczy którejś z obserwowanych ścieżek (prefiksy, np. 'SVL_CoreOS_2/'). */
export function repoChangeTouches(detail: any, prefixes: string[]): boolean {
  if (!prefixes.length) return true;
  const paths: string[] = [
    ...(Array.isArray(detail?.paths) ? detail.paths : []),
    ...(Array.isArray(detail?.changedPaths) ? detail.changedPaths : []),
  ];
  const total = Number(detail?.totalPaths || 0);
  if (total > paths.length) return true; // lista ucięta — odśwież na wszelki wypadek
  return paths.some((p) => prefixes.some((pre) => String(p).startsWith(pre) || pre.startsWith(String(p))));
}

/**
 * Hook dla paneli: wywołuje `onChange` (z debounce), gdy w repozytorium zmieniły się pliki
 * pasujące do prefiksów, albo zmienił się commit (git pull, commit, checkout).
 */
export function useRepoChangeRefresh(onChange: (detail: any) => void, opts: { prefixes?: string[]; debounceMs?: number } = {}): void {
  const cbRef = useRef(onChange);
  cbRef.current = onChange;
  const prefixKey = (opts.prefixes || []).join('|');
  const debounceMs = opts.debounceMs ?? 250;
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const prefixes = prefixKey ? prefixKey.split('|') : [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastDetail: any = null;
    const handler = (evt: Event) => {
      const detail = (evt as CustomEvent).detail;
      if (evt.type === 'svl:repo-changed' && !repoChangeTouches(detail, prefixes)) return;
      lastDetail = detail;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        cbRef.current(lastDetail);
      }, debounceMs);
    };
    window.addEventListener('svl:repo-changed', handler);
    window.addEventListener('svl:git-head', handler);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('svl:repo-changed', handler);
      window.removeEventListener('svl:git-head', handler);
    };
  }, [prefixKey, debounceMs]);
}
