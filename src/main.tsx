import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { initGuiTelemetryLogger, trackGuiEvent } from './utils/guiLogger.ts';

declare global {
  interface Window {
    __SVL_DEV_DIAGNOSTICS__?: {
      hmrState: 'active' | 'disabled' | 'proxy_unavailable';
      hmrMessage?: string;
      detectedAt?: string;
    };
  }
}

initGuiTelemetryLogger();

const STALE_RELOAD_KEY = 'svl:stale-bundle-reload-at';
/** Błędy typowe dla nieaktualnych paczek Vite po ich przebudowie w trakcie sesji. */
function isStaleBundleError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error || '');
  return /reading 'use[A-Z][A-Za-z]*'|Invalid hook call|dynamically imported module|Importing a module script failed|Outdated Optimize Dep/i.test(msg);
}

class GuiErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; errorMessage: string }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, errorMessage: error?.message || String(error) };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Nieaktualne paczki Vite (dwie kopie Reacta / nieudany import leniwej zakładki) naprawia
    // jednorazowe przeładowanie strony — bez pętli przeładowań (znacznik w sessionStorage).
    if (isStaleBundleError(error)) {
      try {
        const last = Number(sessionStorage.getItem(STALE_RELOAD_KEY) || 0);
        if (Date.now() - last > 30000) {
          sessionStorage.setItem(STALE_RELOAD_KEY, String(Date.now()));
          window.location.reload();
          return;
        }
      } catch {
        // sessionStorage niedostępny — zostaje ekran z przyciskiem „Odśwież interfejs”
      }
    }
    trackGuiEvent({
      kind: 'react_error_boundary',
      level: 'ERROR',
      action: `Błąd renderowania GUI: ${error?.message || String(error)}`,
      detail: { componentStack: String(info?.componentStack || '').slice(0, 500) },
      immediate: true,
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen w-screen flex-col items-center justify-center bg-[#0B0D13] p-6 text-center text-slate-200">
          <h1 className="mb-2 text-lg font-bold text-rose-400">Wystąpił błąd interfejsu SVL Python OS</h1>
          <p className="mb-4 max-w-lg text-xs text-slate-400">{this.state.errorMessage}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md bg-violet-600 px-4 py-2 text-xs font-semibold text-white hover:bg-violet-500"
          >
            Odśwież interfejs
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__SVL_DEV_DIAGNOSTICS__ = window.__SVL_DEV_DIAGNOSTICS__ || { hmrState: 'active' };
  let hmrNoticeLogged = false;

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const msg =
      typeof reason === 'string'
        ? reason
        : reason instanceof Error
          ? reason.message
          : String(reason?.message || reason || '');
    const stack = reason instanceof Error ? String(reason.stack || '') : '';

    const isViteHmrWsFailure =
      msg.includes('WebSocket closed without opened') &&
      !msg.includes('/ws/svl') &&
      !stack.includes('svlSyncStore');

    if (isViteHmrWsFailure) {
      event.preventDefault();
      window.__SVL_DEV_DIAGNOSTICS__ = {
        hmrState: 'proxy_unavailable',
        hmrMessage: msg,
        detectedAt: new Date().toISOString(),
      };
      window.dispatchEvent(new CustomEvent('svl:hmr-diagnostic', { detail: window.__SVL_DEV_DIAGNOSTICS__ }));
      if (!hmrNoticeLogged) {
        hmrNoticeLogged = true;
        console.info(
          '[SVL Dev Diagnostic] Vite HMR WebSocket został zamknięty przez warstwę proxy środowiska podglądu (brak wpływu na aplikacyjny kanał synchronizacji /ws/svl).',
        );
      }
    }
  });
}

createRoot(document.getElementById('root')!).render(
  <GuiErrorBoundary>
    <App />
  </GuiErrorBoundary>,
);
