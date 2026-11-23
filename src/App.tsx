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
import { GalleryPanel } from './components/GalleryPanel';
import { Svl364CommandCenter } from './components/Svl364CommandCenter';
import { InfrastructureWorkspace } from './components/InfrastructureWorkspace';
import { ApexCommandDock } from './components/ApexCommandDock';
import { SvlSyncProvider, useSvlSync } from './utils/svlSyncStore';
import { getEffectiveCanonicalAgents, getSvlOperatorAccessToken, safeFetchJson, setSvlOperatorAccessToken, setSvlOperatorTokenRequired } from './utils/svlLogic';
import { setGuiLoggerContext, trackGuiEvent } from './utils/guiLogger';

type ActiveWorkspaceTab = 'chat' | 'apex' | 'svl364' | 'infrastructure' | 'agents' | 'gallery' | 'terminals' | 'kernel' | 'linux';

const WORKSPACE_TABS: Array<{ id: ActiveWorkspaceTab; label: string; shortLabel?: string; accent?: string }> = [
  { id: 'chat', label: 'Czat' },
  { id: 'apex', label: '⚡ Apex OS', accent: 'cyan' },
  { id: 'svl364', label: 'SVL-364' },
  { id: 'infrastructure', label: 'Infrastruktura', shortLabel: 'Infra', accent: 'emerald' },
  { id: 'agents', label: 'Agenci' },
  { id: 'gallery', label: 'Galeria', accent: 'violet' },
  { id: 'terminals', label: 'Terminale (5)', shortLabel: 'Terminale' },
  { id: 'kernel', label: 'Jądro SVL', shortLabel: 'Jądro' },
  { id: 'linux', label: 'Linux' },
];

function SVLWorkspaceShell() {
  const [activeTab, setActiveTab] = useState<ActiveWorkspaceTab>('chat');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [operatorToken, setOperatorToken] = useState(() => getSvlOperatorAccessToken());
  const [operatorAuthVisible, setOperatorAuthVisible] = useState(false);
  const [operatorAuthStatus, setOperatorAuthStatus] = useState<'none' | 'checking' | 'authorized' | 'denied'>('checking');
  const [operatorRootInfo, setOperatorRootInfo] = useState<{ operator: string; role: string; uid: number; scopesCount: number } | null>(null);
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
    workspaceState,
    refreshAllDomains,
    refreshDomainModules,
    reconnectWebSocket,
  } = useSvlSync();

  const workspaceValue = (key: 'gui_theme' | 'gui_accent' | 'active_workspace_tab'): string | undefined => {
    const raw = workspaceState[key] as string | { value?: unknown } | undefined;
    const value = typeof raw === 'object' && raw !== null ? raw.value : raw;
    return typeof value === 'string' ? value : undefined;
  };
  const guiTheme = workspaceValue('gui_theme') || 'apex';
  const guiAccent = workspaceValue('gui_accent') || 'cyan';
  const syncedWorkspaceTab = workspaceValue('active_workspace_tab');

  useEffect(() => {
    if (
      syncedWorkspaceTab === 'chat' || syncedWorkspaceTab === 'apex' || syncedWorkspaceTab === 'svl364' ||
      syncedWorkspaceTab === 'infrastructure' || syncedWorkspaceTab === 'agents' ||
      syncedWorkspaceTab === 'gallery' || syncedWorkspaceTab === 'terminals' || syncedWorkspaceTab === 'kernel' ||
      syncedWorkspaceTab === 'linux'
    ) {
      setActiveTab(syncedWorkspaceTab);
    }
  }, [syncedWorkspaceTab]);

  useEffect(() => {
    setGuiLoggerContext({ tab: activeTab });
    if (activeTab === 'chat') {
      void refreshDomainModules(['chat', 'agents', 'health', 'workspace']);
    } else if (activeTab === 'apex') {
      void refreshDomainModules(['health', 'modules', 'kernel', 'agents']);
    } else if (activeTab === 'svl364') {
      void refreshDomainModules(['modules', 'kernel', 'agents', 'health', 'chat', 'terminals']);
    } else if (activeTab === 'infrastructure') {
      void refreshDomainModules(['modules', 'agents', 'health', 'kernel']);
    } else if (activeTab === 'agents') {
      void refreshDomainModules(['agents', 'health', 'workspace']);
    } else if (activeTab === 'gallery') {
      void refreshDomainModules(['health']);
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
    // Status sprawdzamy też bez tokenu: serwer domyślnie go nie wymaga (tokenRequired: false).
    setOperatorAuthStatus('checking');
    const isInitial = firstAuthCheckRef.current;
    firstAuthCheckRef.current = false;
    const handle = setTimeout(async () => {
      const result = await safeFetchJson<{
        ok: boolean;
        authenticated?: boolean;
        operator?: string;
        role?: string;
        uid?: number;
        scopes?: string[];
        tokenRequired?: boolean;
      }>(
        '/api/operator/status',
        {
          timeoutMs: 8000,
          maxRetries: 0,
          headers: operatorToken ? {'X-SVL-Operator-Token': operatorToken} : {},
        },
      );
      if (cancelled) return;
      if (typeof result.data?.tokenRequired === 'boolean') {
        setSvlOperatorTokenRequired(result.data.tokenRequired);
      }
      const authorized = result.ok && result.data?.ok && result.data?.authenticated === true;
      setOperatorAuthStatus(authorized ? 'authorized' : operatorToken ? 'denied' : 'none');
      setOperatorRootInfo(
        authorized
          ? {
              operator: result.data?.operator || 'Mateusz Mitek',
              role: result.data?.role || 'root',
              uid: typeof result.data?.uid === 'number' ? result.data.uid : 0,
              scopesCount: Array.isArray(result.data?.scopes) ? result.data.scopes.length : 0,
            }
          : null,
      );
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
  const effectiveAgents = getEffectiveCanonicalAgents(agentsList);
  const activeWorkersCount = agentsList.filter((a) =>
    ['ONLINE_LOCAL_WORKER', 'BUSY_LOCAL_WORKER'].includes(a.status),
  ).length;
  const agentsTabLabel = `Agenci (${effectiveAgents.length > 0 ? `${activeWorkersCount}/${effectiveAgents.length}` : '0'})`;

  const selectWorkspaceTab = (tab: ActiveWorkspaceTab) => {
    setActiveTab(tab);
    setMobileNavOpen(false);
  };

  return (
    <div
      className="svl-workspace flex flex-col h-[100dvh] w-full max-w-full overflow-hidden bg-[#050810] text-[#F1F5F9]"
      data-theme={guiTheme}
      data-accent={guiAccent}
    >
      {/* Apex-Dark Responsive Top Bar */}
      <header className="relative z-20 flex flex-wrap lg:flex-nowrap items-center justify-between gap-x-2 gap-y-1 lg:gap-4 px-2.5 sm:px-4 lg:px-5 py-1.5 border-b border-cyan-500/30 bg-[#090F1E] shrink-0">
        {/* Zone 1: Wordmark */}
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            selectWorkspaceTab('chat');
          }}
          className="order-1 min-h-[38px] lg:min-h-0 flex items-center text-sm md:text-base font-bold tracking-tight text-cyan-300 whitespace-nowrap shrink-0"
        >
          ⚡ SVL CoreOS 2: Apex
        </a>

        {/* Zone 2: Horizontal navigation bar (Desktop/Tablet inline scrollable + Mobile scrollable + Menu drawer trigger) */}
        <div className="order-3 lg:order-2 w-full lg:w-auto lg:min-w-0 lg:flex-1 flex items-center gap-1.5 border-t border-cyan-500/20 lg:border-t-0 pt-1 lg:pt-0">
          <nav
            aria-label="Główna nawigacja systemu"
            className="flex-1 min-w-0 flex items-center gap-2.5 md:gap-3.5 text-xs font-medium text-slate-400 overflow-x-auto no-scrollbar pr-4 lg:pr-2 [mask-image:linear-gradient(to_right,black_0%,black_calc(100%-24px),transparent_100%)] lg:[mask-image:none]"
          >
            {WORKSPACE_TABS.map((tab) => {
              const isActive = activeTab === tab.id;
              const displayLabel = tab.id === 'agents' ? agentsTabLabel : tab.label;
              const activeBorder =
                tab.accent === 'emerald'
                  ? 'text-emerald-300 border-emerald-400 font-semibold'
                  : tab.accent === 'violet'
                    ? 'text-violet-300 border-violet-400 font-semibold'
                    : 'text-cyan-300 border-cyan-400 font-semibold';
              const idleClass =
                tab.accent === 'cyan'
                  ? 'text-cyan-400/90 border-transparent hover:text-cyan-200'
                  : 'border-transparent hover:text-slate-100';
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => selectWorkspaceTab(tab.id)}
                  className={`min-h-[36px] lg:min-h-0 py-1 px-0.5 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
                    tab.id === 'apex' || tab.id === 'agents' ? 'font-mono tabular-nums ' : ''
                  }${isActive ? activeBorder : idleClass}`}
                >
                  {displayLabel}
                </button>
              );
            })}
          </nav>

          {/* Compact mobile/tablet all-tabs menu button so overflow tabs are always 1 tap away */}
          <button
            type="button"
            aria-expanded={mobileNavOpen}
            aria-label="Wszystkie moduły nawigacji"
            onClick={() => setMobileNavOpen((v) => !v)}
            className={`lg:hidden min-h-[36px] px-2 py-1 rounded-md border text-[11px] font-mono whitespace-nowrap shrink-0 transition-colors ${
              mobileNavOpen
                ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200'
                : 'border-slate-700 bg-[#0B0D13] text-slate-300 hover:border-cyan-500/50'
            }`}
          >
            Moduły ({WORKSPACE_TABS.length}) {mobileNavOpen ? '▴' : '▾'}
          </button>
        </div>

        {/* Full mobile/tablet module grid drawer when toggled */}
        {mobileNavOpen && (
          <div
            aria-label="Szybki wybór modułu systemu"
            className="order-5 lg:hidden w-full grid grid-cols-3 gap-1.5 pt-2 pb-1 border-t border-cyan-500/20"
          >
            {WORKSPACE_TABS.map((tab) => {
              const isActive = activeTab === tab.id;
              const labelText = tab.id === 'agents' ? agentsTabLabel : tab.label;
              return (
                <button
                  key={`drawer-${tab.id}`}
                  type="button"
                  onClick={() => selectWorkspaceTab(tab.id)}
                  className={`min-h-[42px] px-2 py-1.5 rounded-lg border text-xs font-medium text-center truncate transition-colors ${
                    isActive
                      ? 'border-cyan-400/70 bg-cyan-500/20 text-cyan-200 font-semibold'
                      : 'border-slate-800 bg-[#0B0D13] text-slate-300 hover:border-slate-700'
                  }`}
                >
                  {labelText}
                </button>
              );
            })}
          </div>
        )}

        {/* Zone 3: Operator authorization (memory only) + Primary CTA */}
        <div className="order-2 lg:order-3 flex items-center gap-1.5 shrink-0 ml-auto lg:ml-0">
          <button
            type="button"
            aria-expanded={operatorAuthVisible}
            aria-label="Otwórz autoryzację operatora"
            onClick={() => setOperatorAuthVisible((visible) => !visible)}
            className={`min-h-[38px] lg:min-h-[30px] px-2.5 py-1 rounded-md border text-[11px] font-medium whitespace-nowrap transition-colors ${operatorAuthStatus === 'authorized'
              ? 'border-emerald-700 bg-emerald-950/30 text-emerald-300'
              : operatorAuthStatus === 'denied'
                ? 'border-rose-700 bg-rose-950/30 text-rose-300'
                : 'border-slate-700 bg-[#0B0D13] text-slate-300 hover:border-slate-600'}`}
            title={operatorAuthStatus === 'authorized'
              ? `Operator ROOT: ${operatorRootInfo?.operator || 'Mateusz Mitek'} (uid=${operatorRootInfo?.uid ?? 0} · ${operatorRootInfo?.scopesCount || 22} zakresów ROOT · System_SI_1, SI_System_2 & JEDI Omni-OS v12 VM)`
              : operatorAuthStatus === 'denied'
                ? 'Serwer odrzucił token operatora'
                : 'Wpisz prywatny SVL_OPERATOR_TOKEN'}
          >{operatorAuthStatus === 'authorized' ? '🔐 ROOT · SVL' : '🔒 SVL'}</button>
          {operatorAuthVisible && (
            <div className="hidden lg:flex items-center gap-1.5">
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
            className="min-h-[38px] lg:min-h-[30px] px-2.5 py-1 text-[11px] md:text-xs font-semibold text-white bg-violet-600 hover:bg-violet-500 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            {isSyncing ? 'Sync...' : 'Synchronizuj'}
          </button>
        </div>

        {/* Full-width mobile operator token drawer when toggled */}
        {operatorAuthVisible && (
          <div className="order-4 w-full lg:hidden flex items-center gap-2 pt-1.5 pb-0.5 border-t border-slate-800/70">
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
              className="flex-1 min-w-0 min-h-[40px] bg-[#0B0D13] border border-slate-700 rounded-md px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-violet-500"
            />
            <button
              type="button"
              onClick={handleSaveOperatorToken}
              className="min-h-[40px] px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold whitespace-nowrap shrink-0"
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
        {activeTab === 'apex' && <ApexCommandDock onNavigateTab={setActiveTab} />}
        {activeTab === 'svl364' && <Svl364CommandCenter onNavigate={setActiveTab} />}
        {activeTab === 'infrastructure' && <InfrastructureWorkspace onNavigateTab={setActiveTab} />}
        {activeTab === 'agents' && (
          <AgentsPanel
            onNavigateToChat={() => setActiveTab('chat')}
          />
        )}
        {activeTab === 'gallery' && <GalleryPanel />}
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

