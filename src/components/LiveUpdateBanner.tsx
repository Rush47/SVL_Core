import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, RotateCcw, AlertTriangle, X } from 'lucide-react';
import { safeFetchJson, hasSvlOperatorAccessToken } from '../utils/svlLogic';
import { APP_BUILD_EVENT, decideReload, isUserTyping, saveReloadState } from '../utils/liveRepoEvents';

type Banner =
  | { kind: 'building'; text: string }
  | { kind: 'reloading'; text: string }
  | { kind: 'prompt'; text: string }
  | { kind: 'failed'; text: string }
  | { kind: 'restart'; text: string; reasons: string[]; autoInMs: number | null }
  | { kind: 'restarting'; text: string }
  | null;

/**
 * Baner synchronizacji na żywo: nowa wersja GUI (po git pull / edycji przez AI) przeładowuje
 * kartę sama (chyba że właśnie piszesz — wtedy czeka), zmiana kodu serwera pokazuje przycisk
 * restartu (albo odliczanie, gdy działa nadzorca systemd/pm2).
 */
export const LiveUpdateBanner: React.FC<{ getViewState?: () => Record<string, unknown> }> = ({ getViewState }) => {
  const [banner, setBanner] = useState<Banner>(null);
  const knownBuildRef = useRef<string | null>(null);
  const waitTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const restartingRef = useRef(false);
  const viewStateRef = useRef(getViewState);
  viewStateRef.current = getViewState;

  const doReload = useCallback(() => {
    saveReloadState({ ...(viewStateRef.current?.() || {}), scrollY: window.scrollY });
    window.location.reload();
  }, []);

  const handleNewBuild = useCallback((buildId: string, policy: string | undefined) => {
    const decision = decideReload({ policy, newBuildId: buildId, knownBuildId: knownBuildRef.current, typing: isUserTyping() });
    if (decision === 'ignore') {
      if (!knownBuildRef.current) knownBuildRef.current = buildId;
      return;
    }
    if (decision === 'prompt') {
      setBanner({ kind: 'prompt', text: 'Jest nowa wersja interfejsu (zmiany z GitHuba / od AI).' });
      return;
    }
    if (decision === 'reload') {
      setBanner({ kind: 'reloading', text: 'Nowa wersja interfejsu — wczytuję…' });
      setTimeout(doReload, 600);
      return;
    }
    // wait: użytkownik pisze — przeładuj, gdy skończy (najdłużej 2 min, potem tylko przycisk)
    setBanner({ kind: 'prompt', text: 'Nowa wersja interfejsu — wczytam ją, gdy skończysz pisać.' });
    if (waitTimerRef.current) clearInterval(waitTimerRef.current);
    const started = Date.now();
    waitTimerRef.current = setInterval(() => {
      if (!isUserTyping()) {
        if (waitTimerRef.current) clearInterval(waitTimerRef.current);
        waitTimerRef.current = null;
        doReload();
      } else if (Date.now() - started > 120_000) {
        if (waitTimerRef.current) clearInterval(waitTimerRef.current);
        waitTimerRef.current = null;
      }
    }, 1500);
  }, [doReload]);

  useEffect(() => {
    if (!hasSvlOperatorAccessToken()) return;
    void safeFetchJson<{ ok: boolean; appBuildId?: string | null; restartRequired?: any; supervisor?: string | null }>('/api/live/status', { timeoutMs: 8000 })
      .then((res) => {
        if (!res.ok || !res.data?.ok) return;
        if (res.data.appBuildId && !knownBuildRef.current) knownBuildRef.current = res.data.appBuildId;
        const rr = res.data.restartRequired;
        if (rr && Array.isArray(rr.reasons) && rr.reasons.length > 0) {
          setBanner({ kind: 'restart', text: 'Zmienił się kod serwera — potrzebny restart.', reasons: rr.reasons, autoInMs: null });
        }
      });
  }, []);

  useEffect(() => {
    const onBuildId = (e: Event) => {
      const id = String((e as CustomEvent).detail?.buildId || '');
      if (!id) return;
      if (!knownBuildRef.current) {
        knownBuildRef.current = id;
        return;
      }
      if (knownBuildRef.current !== id) handleNewBuild(id, restartingRef.current ? 'auto' : undefined);
    };
    const onBuilding = () => setBanner((b) => (b && b.kind === 'restart' ? b : { kind: 'building', text: 'Przebudowuję interfejs po zmianach w repozytorium…' }));
    const onUpdated = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      handleNewBuild(String(d.buildId || ''), d.reload);
    };
    const onFailed = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      setBanner({ kind: 'failed', text: `Przebudowa interfejsu nie powiodła się — działa poprzednia wersja. ${String(d.error || '').slice(0, 300)}` });
    };
    const onRestartRequired = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      setBanner({
        kind: 'restart',
        text: d.autoRestartInMs != null ? 'Zmienił się kod serwera — restart nastąpi automatycznie.' : 'Zmienił się kod serwera — potrzebny restart, żeby zmiany zadziałały.',
        reasons: Array.isArray(d.reasons) ? d.reasons : [],
        autoInMs: typeof d.autoRestartInMs === 'number' ? d.autoRestartInMs : null,
      });
    };
    const onRestarting = () => {
      restartingRef.current = true;
      setBanner({ kind: 'restarting', text: 'Serwer uruchamia się ponownie — strona odświeży się sama.' });
    };
    window.addEventListener(APP_BUILD_EVENT, onBuildId);
    window.addEventListener('svl:app-building', onBuilding);
    window.addEventListener('svl:app-updated', onUpdated);
    window.addEventListener('svl:app-build-failed', onFailed);
    window.addEventListener('svl:restart-required', onRestartRequired);
    window.addEventListener('svl:restarting', onRestarting);
    return () => {
      window.removeEventListener(APP_BUILD_EVENT, onBuildId);
      window.removeEventListener('svl:app-building', onBuilding);
      window.removeEventListener('svl:app-updated', onUpdated);
      window.removeEventListener('svl:app-build-failed', onFailed);
      window.removeEventListener('svl:restart-required', onRestartRequired);
      window.removeEventListener('svl:restarting', onRestarting);
      if (waitTimerRef.current) clearInterval(waitTimerRef.current);
    };
  }, [handleNewBuild]);

  // Po restarcie serwera (bez zmiany GUI) odśwież stronę, gdy znów odpowiada.
  useEffect(() => {
    if (banner?.kind !== 'restarting') return;
    const started = Date.now();
    const t = setInterval(async () => {
      if (Date.now() - started < 2500) return;
      const res = await safeFetchJson<{ ok: boolean }>('/api/live/status', { timeoutMs: 3000, maxRetries: 0 });
      if (res.ok && res.data?.ok) {
        clearInterval(t);
        doReload();
      } else if (Date.now() - started > 180_000) {
        clearInterval(t);
        setBanner({ kind: 'failed', text: 'Serwer nie wrócił po restarcie w ciągu 3 minut — sprawdź logi na hoście.' });
      }
    }, 1500);
    return () => clearInterval(t);
  }, [banner?.kind, doReload]);

  const requestRestart = async () => {
    setBanner({ kind: 'restarting', text: 'Restartuję serwer…' });
    restartingRef.current = true;
    const res = await safeFetchJson<{ ok: boolean; error?: string }>('/api/live/restart', { method: 'POST', timeoutMs: 10000, body: '{}' });
    if (!res.ok || !res.data?.ok) {
      restartingRef.current = false;
      setBanner({ kind: 'failed', text: `Restart nie powiódł się: ${res.data?.error || res.error || `HTTP ${res.status}`}` });
    }
  };

  if (!banner) return null;
  const tone =
    banner.kind === 'failed'
      ? 'border-rose-500/40 bg-rose-950/80 text-rose-100'
      : banner.kind === 'restart'
        ? 'border-amber-500/40 bg-amber-950/80 text-amber-100'
        : 'border-cyan-500/40 bg-[#0B1424]/95 text-cyan-100';
  return (
    <div
      role={banner.kind === 'failed' ? 'alert' : 'status'}
      className={`fixed bottom-3 right-3 z-[9999] max-w-md rounded-lg border px-3 py-2 text-xs shadow-lg ${tone}`}
    >
      <div className="flex items-start gap-2">
        {banner.kind === 'failed' || banner.kind === 'restart' ? (
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
        ) : (
          <RefreshCw className={`w-4 h-4 shrink-0 mt-0.5 ${banner.kind === 'building' || banner.kind === 'reloading' || banner.kind === 'restarting' ? 'animate-spin' : ''}`} aria-hidden="true" />
        )}
        <div className="flex-1 space-y-1.5">
          <p>{banner.text}</p>
          {banner.kind === 'restart' && banner.reasons.length > 0 && (
            <ul className="font-mono text-[10px] opacity-80 max-h-20 overflow-y-auto">
              {banner.reasons.slice(0, 6).map((r) => <li key={r}>• {r}</li>)}
              {banner.reasons.length > 6 && <li>… i {banner.reasons.length - 6} więcej</li>}
            </ul>
          )}
          <div className="flex gap-2">
            {banner.kind === 'prompt' && (
              <button type="button" onClick={doReload} className="px-2 py-1 rounded bg-cyan-600/80 hover:bg-cyan-500 text-white font-semibold inline-flex items-center gap-1">
                <RefreshCw className="w-3 h-3" aria-hidden="true" /> Wczytaj teraz
              </button>
            )}
            {banner.kind === 'restart' && banner.autoInMs == null && (
              <button type="button" onClick={() => void requestRestart()} className="px-2 py-1 rounded bg-amber-600/80 hover:bg-amber-500 text-white font-semibold inline-flex items-center gap-1">
                <RotateCcw className="w-3 h-3" aria-hidden="true" /> Uruchom serwer ponownie
              </button>
            )}
          </div>
        </div>
        {banner.kind !== 'reloading' && banner.kind !== 'restarting' && (
          <button type="button" onClick={() => setBanner(null)} aria-label="Zamknij" className="opacity-70 hover:opacity-100">
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
};
