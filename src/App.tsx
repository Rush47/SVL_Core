/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { ChatWorkspace } from './components/ChatWorkspace';
import { AgentsPanel } from './components/AgentsPanel';
import { TerminalsWorkspace } from './components/TerminalsWorkspace';
import { KernelDiagnosticsView } from './components/KernelDiagnosticsView';
import { LinuxDeployDashboard } from './components/LinuxDeployDashboard';
import { Svl364CommandCenter } from './components/Svl364CommandCenter';
import { InfrastructureWorkspace } from './components/InfrastructureWorkspace';
import { SvlSyncProvider, useSvlSync } from './utils/svlSyncStore';
import { CANONICAL_AGENTS, getSvlOperatorAccessToken, safeFetchJson, setSvlOperatorAccessToken } from './utils/svlLogic';
import { setGuiLoggerContext, trackGuiEvent } from './utils/guiLogger';

type ActiveWorkspaceTab = 'chat' | 'svl364' | 'infrastructure' | 'agents' | 'terminals' | 'kernel' | 'linux';

function SVLWorkspaceShell() {
  const [activeTab, setActiveTab] = useState<ActiveWorkspaceTab>('chat');
  const [operatorToken, setOperatorToken] = useState(() => getSvlOperatorAccessToken());
  const [operatorAuthVisible, setOperatorAuthVisible] = useState(false);
  const [operatorAuthStatus, setOperatorAuthStatus] = useState<'none' | 'checking' | 'authorized' | 'denied'>('checking');
  const firstAuthCheckRef = React.useRef(true);

  if (getSvlOperatorAccessToken() !== operatorToken) {
    setSvlOperatorAccessToken(operatorToken);
  }

  useEffect(() => {
    setSvlOperatorAccessToken(operatorToken);
  }, [operatorToken]);

  useEffect(() => {
    const onTokenChanged = () => {
      const latest = getSvlOperatorAccessToken();
      setOperatorToken((prev) => (prev === latest ? prev : latest));
    };
    window.addEventListener('svl-operator-token-changed', onTokenChanged);
    return () => window.removeEventListener('svl-operator-token-changed', onTokenChanged);
  }, []);

  const handleSaveOperatorToken = () => {
    const trimmed = operatorToken.trim();
    trackGuiEvent({
      kind: 'operator_auth',
      level: 'INFO',
      action: trimmed ? 'Zapisano token operatora w sesji GUI' : 'Wyczyszczono token operatora w sesji GUI',
      immediate: true,
    });
    setOperatorToken(trimmed);
    setSvlOperatorAccessToken(trimmed);
    setOperatorAuthVisible(false);
    reconnectWebSocket();
    if (trimmed) {
      void refreshAllDomains('operator_token_saved');
    }
  };
  const {
    agentsData,
    isSyncing,
    refreshAllDomains,
    refreshDomainModules,
    reconnectWebSocket,
  } = useSvlSync();

  useEffect(() => {
    setGuiLoggerContext({ tab: activeTab });
    if (activeTab === 'chat') {
      void refreshDomainModules(['chat', 'agents', 'health', 'workspace']);
    } else if (activeTab === 'svl364') {
      void refreshDomainModules(['modules', 'kernel', 'agents', 'health', 'chat', 'terminals']);
    } else if (activeTab === 'infrastructure') {
      void refreshDomainModules(['modules', 'agents', 'health', 'kernel']);
    } else if (activeTab === 'agents') {
      void refreshDomainModules(['agents', 'health', 'workspace']);
    } else if (activeTab === 'terminals') {
      void refreshDomainModules(['terminals', 'health']);
    } else if (activeTab === 'kernel') {
      void refreshDomainModules(['kernel', 'agents']);
    } else if (activeTab === 'linux') {
      void refreshDomainModules(['health', 'agents']);
    }
  }, [activeTab, refreshDomainModules]);

  useEffect(() => {
    let cancelled = false;
    if (!operatorToken) {
      firstAuthCheckRef.current = false;
      setOperatorAuthStatus('none');
      reconnectWebSocket();
      return;
    }
    setOperatorAuthStatus('checking');
    const isInitial = firstAuthCheckRef.current;
    firstAuthCheckRef.current = false;
    const handle = setTimeout(async () => {
      const result = await safeFetchJson<{ok: boolean; authenticated?: boolean}>(
        '/api/operator/status',
        {
          timeoutMs: 8000,
          maxRetries: 0,
          headers: {'X-SVL-Operator-Token': operatorToken},
        },
      );
      if (cancelled) return;
      const authorized = result.ok && result.data?.ok && result.data?.authenticated === true;
      setOperatorAuthStatus(authorized ? 'authorized' : 'denied');
      reconnectWebSocket();
      if (authorized) {
        void refreshAllDomains('operator_token_authorized');
      }
    }, isInitial ? 20 : 350);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [operatorToken, refreshAllDomains, reconnectWebSocket]);

  const agentsList: any[] = agentsData?.agents || [];
  const activeWorkersCount = agentsList.filter((a) =>
    ['ONLINE_LOCAL_WORKER', 'BUSY_LOCAL_WORKER'].includes(a.status),
  ).length;

  return (
    <div className="flex flex-col h-[100dvh] w-screen overflow-hidden bg-[#0B0D13] text-[#F1F5F9]">
      {/* Compact Responsive 3-Zone Top Bar for Desktop & Android */}
      <header className="relative flex flex-wrap md:flex-nowrap items-center justify-between gap-x-2 gap-y-1.5 md:gap-5 px-2.5 md:px-5 py-1.5 border-b border-slate-800/90 bg-[#111520] shrink-0">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab('chat');
          }}
          className="order-1 text-sm md:text-base font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0"
        >
          SVL Python OS
        </a>

        {/* Zone 2: Horizontal navigation bar (full row on <md for spacious Android touch targets) */}
        <nav
          aria-label="Główna nawigacja systemu"
          className="order-3 md:order-2 w-full md:w-auto flex items-center gap-3 md:gap-5 text-xs font-medium text-slate-400 overflow-x-auto no-scrollbar border-t border-slate-800/60 md:border-t-0 pt-1 md:pt-0"
        >
          <button
            type="button"
            onClick={() => setActiveTab('chat')}
            className={`min-h-[32px] md:min-h-0 py-1 md:py-0.5 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              activeTab === 'chat'
                ? 'text-violet-300 border-violet-500 font-semibold'
                : 'border-transparent hover:text-slate-100'
            }`}
          >
            Czat
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('svl364')}
            className={`min-h-[32px] md:min-h-0 py-1 md:py-0.5 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              activeTab === 'svl364'
                ? 'text-violet-300 border-violet-500 font-semibold'
                : 'border-transparent hover:text-slate-100'
            }`}
          >
            SVL-364
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('infrastructure')}
            className={`min-h-[32px] md:min-h-0 py-1 md:py-0.5 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              activeTab === 'infrastructure'
                ? 'text-emerald-300 border-emerald-400 font-semibold'
                : 'border-transparent hover:text-slate-100'
            }`}
          >
            Infrastruktura
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('agents')}
            className={`min-h-[32px] md:min-h-0 py-1 md:py-0.5 transition-colors whitespace-nowrap shrink-0 border-b-2 font-mono tabular-nums ${
              activeTab === 'agents'
                ? 'text-violet-300 border-violet-500 font-semibold'
                : 'border-transparent hover:text-slate-100'
            }`}
          >
            Agenci ({CANONICAL_AGENTS.length > 0 ? `${activeWorkersCount}/${CANONICAL_AGENTS.length}` : '0'})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('terminals')}
            className={`min-h-[32px] md:min-h-0 py-1 md:py-0.5 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              activeTab === 'terminals'
                ? 'text-violet-300 border-violet-500 font-semibold'
                : 'border-transparent hover:text-slate-100'
            }`}
          >
            Terminale (5)
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('kernel')}
            className={`min-h-[32px] md:min-h-0 py-1 md:py-0.5 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              activeTab === 'kernel'
                ? 'text-violet-300 border-violet-500 font-semibold'
                : 'border-transparent hover:text-slate-100'
            }`}
          >
            Jądro SVL
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('linux')}
            className={`min-h-[32px] md:min-h-0 py-1 md:py-0.5 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              activeTab === 'linux'
                ? 'text-violet-300 border-violet-500 font-semibold'
                : 'border-transparent hover:text-slate-100'
            }`}
          >
            Linux
          </button>
        </nav>

        {/* Zone 3: Operator authorization (memory only) + Primary CTA */}
        <div className="order-2 md:order-3 flex items-center gap-1.5 shrink-0 ml-auto md:ml-0">
          <button
            type="button"
            aria-expanded={operatorAuthVisible}
            aria-label="Otwórz autoryzację operatora"
            onClick={() => setOperatorAuthVisible((visible) => !visible)}
            className={`min-h-[34px] md:min-h-0 px-2.5 py-1 rounded-md border text-[11px] font-medium whitespace-nowrap transition-colors ${operatorAuthStatus === 'authorized'
              ? 'border-emerald-700 bg-emerald-950/30 text-emerald-300'
              : operatorAuthStatus === 'denied'
                ? 'border-rose-700 bg-rose-950/30 text-rose-300'
                : 'border-slate-700 bg-[#0B0D13] text-slate-300 hover:border-slate-600'}`}
            title={operatorAuthStatus === 'authorized'
              ? 'Token operatora potwierdzony przez backend'
              : operatorAuthStatus === 'denied'
                ? 'Serwer odrzucił token operatora'
                : 'Wpisz prywatny SVL_OPERATOR_TOKEN'}
          >{operatorAuthStatus === 'authorized' ? '🔐 SVL' : '🔒 SVL'}</button>
          {operatorAuthVisible && (
            <div className="hidden md:flex items-center gap-1.5">
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={operatorToken}
                aria-label="Prywatny SVL_OPERATOR_TOKEN"
                placeholder="SVL_OPERATOR_TOKEN"
                onChange={(event) => {
                  const value = event.target.value.trim();
                  setOperatorToken(value);
                  setSvlOperatorAccessToken(value);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    handleSaveOperatorToken();
                  }
                }}
                className="min-w-0 w-44 bg-[#0B0D13] border border-slate-700 rounded-md px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-violet-500"
              />
              <button
                type="button"
                onClick={handleSaveOperatorToken}
                className="px-2.5 py-1 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-semibold whitespace-nowrap"
              >
                Zapisz
              </button>
            </div>
          )}
          <span className="sr-only" role="status" aria-live="polite">
            {operatorAuthStatus === 'authorized' ? 'Token operatora zweryfikowany'
              : operatorAuthStatus === 'denied' ? 'Token operatora nieprawidłowy'
                : operatorAuthStatus === 'checking' ? 'Sprawdzanie tokenu operatora' : 'Brak autoryzacji operatora'}
          </span>

          <button
            type="button"
            onClick={() => void refreshAllDomains('operator_header_sync')}
            disabled={isSyncing}
            className="min-h-[34px] md:min-h-0 px-2.5 py-1 text-[11px] md:text-xs font-semibold text-white bg-violet-600 hover:bg-violet-500 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            {isSyncing ? 'Sync...' : 'Synchronizuj'}
          </button>
        </div>

        {/* Full-width mobile operator token drawer when toggled */}
        {operatorAuthVisible && (
          <div className="order-4 w-full md:hidden flex items-center gap-2 pt-1.5 pb-0.5 border-t border-slate-800/70">
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={operatorToken}
              aria-label="Prywatny SVL_OPERATOR_TOKEN (mobile)"
              placeholder="Wpisz prywatny SVL_OPERATOR_TOKEN (min. 32 znaki)"
              onChange={(event) => {
                const value = event.target.value.trim();
                setOperatorToken(value);
                setSvlOperatorAccessToken(value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  handleSaveOperatorToken();
                }
              }}
              className="flex-1 min-w-0 min-h-[38px] bg-[#0B0D13] border border-slate-700 rounded-md px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-violet-500"
            />
            <button
              type="button"
              onClick={handleSaveOperatorToken}
              className="min-h-[38px] px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold whitespace-nowrap shrink-0"
            >
              Zapisz
            </button>
            <span className={`text-[11px] font-mono shrink-0 ${
              operatorAuthStatus === 'authorized'
                ? 'text-emerald-400'
                : operatorAuthStatus === 'denied'
                  ? 'text-rose-400'
                  : 'text-slate-400'
            }`}>
              {operatorAuthStatus === 'authorized' ? 'Zapisano ✓' : operatorAuthStatus === 'denied' ? 'Błąd' : 'Sesja'}
            </span>
          </div>
        )}
      </header>

      {/* Main Workspace Viewport */}
      <main className="flex-1 min-h-0 w-full overflow-hidden">
        {activeTab === 'chat' && <ChatWorkspace onNavigateTab={setActiveTab} />}
        {activeTab === 'svl364' && <Svl364CommandCenter onNavigate={setActiveTab} />}
        {activeTab === 'infrastructure' && <InfrastructureWorkspace onNavigateTab={setActiveTab} />}
        {activeTab === 'agents' && (
          <AgentsPanel
            onNavigateToChat={() => setActiveTab('chat')}
          />
        )}
        {activeTab === 'terminals' && <TerminalsWorkspace />}
        {activeTab === 'kernel' && <KernelDiagnosticsView />}
        {activeTab === 'linux' && <LinuxDeployDashboard />}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <SvlSyncProvider>
      <SVLWorkspaceShell />
    </SvlSyncProvider>
  );
}

