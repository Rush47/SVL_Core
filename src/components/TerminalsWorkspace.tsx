import React, { useState, useRef, useEffect } from 'react';
import {
  Play,
  Trash2,
} from 'lucide-react';
import {
  TerminalLogLine,
  TerminalTabId,
  getSvlOperatorAccessToken,
  safeFetchJson,
  setSvlOperatorAccessToken,
} from '../utils/svlLogic';
import { useSvlSync } from '../utils/svlSyncStore';

const TERMINAL_TABS: Array<{
  id: TerminalTabId;
  label: string;
  subtitle: string;
  defaultPrompt: string;
  welcomeText: string;
  quickCommands: string[];
}> = [
  {
    id: 'ssh',
    label: 'SSH · Ship (ROOT)',
    subtitle: 'Mostek OpenSSH root@svl-364-ship · przetwarza dowolne polecenia naturalne oraz /exec <polecenie> z uprawnieniami ROOT (uid=0).',
    defaultPrompt: 'root@svl-364-ship#',
    welcomeText:
      'Zdalny terminal SSH · Ship (root@svl-364-ship) z uprawnieniami ROOT (uid=0). Obsługuje: (1) /exec <dowolne polecenie> oraz /root <dowolne polecenie>, (2) dowolne polecenia w języku naturalnym (Maya & Bielik ROOT), oraz (3) bezpośrednie komendy powłoki Linux.',
    quickCommands: [
      '/exec id && uname -a && uptime',
      '/exec ip -br addr && ss -tlnp',
      '/exec raport systemu',
      'Pokaż aktywne procesy root, dysk i moduły SQLite',
    ],
  },
  {
    id: 'linux',
    label: 'Powłoka Linux (ROOT)',
    subtitle: 'Powłoka Bash z uprawnieniami ROOT (uid=0). Obsługuje /exec <polecenie>, polecenia naturalne oraz komendy systemowe.',
    defaultPrompt: 'root@svl-debian13:/app/applet#',
    welcomeText:
      'Powłoka Linux działa z uprawnieniami ROOT (uid=0) po autoryzacji SVL_OPERATOR_TOKEN. Obsługuje /exec <polecenie>, polecenia naturalne oraz bezpośrednie komendy Bash.',
    quickCommands: [
      '/exec id && uname -a',
      'sudo ufw status',
      'df -h / && free -m',
      'ollama list',
    ],
  },
  {
    id: 'python',
    label: 'Python 3 Console',
    subtitle: 'Interaktywna sesja REPL z załadowanym SVLSystemKernel i TopologicalInfinityEngine',
    defaultPrompt: 'svl-py3>>>',
    welcomeText:
      'Python 3 Interactive Kernel REPL. Dostępne obiekty w przestrzeni nazw: kernel, VisualScope, SVLProtectedVariable, TopologicalInfinityEngine, BinaryHyperspaceKernel, WithoutNlpHarmonicEngine.',
    quickCommands: [
      'print(kernel.generate_comprehensive_svl_system_markdown_report("raport systemu"))',
      'print(kernel.generate_system_status_report())',
      'TopologicalInfinityEngine(float("-inf"), float("inf")).evaluate_diagnostics()',
      'VisualScope.get_registry_entries()',
      'hyperspace.resolve_intent("status systemu i diagnostyka")',
    ],
  },
  {
    id: 'github',
    label: 'GitHub CLI',
    subtitle: 'GitHub CLI (gh) i synchronizacja obustronna z repozytorium Rush47/SVL_Core (token GITHUB_TOKEN z .env)',
    defaultPrompt: 'gh(Rush47/SVL_Core)$',
    welcomeText:
      'GitHub CLI dla repozytorium Rush47/SVL_Core. Wpisz polecenie gh (np. "pr list", "issue list", "run list", "api /repos/Rush47/SVL_Core") albo synchronizację: status, pobierz, wyślij, synchronizuj, init.',
    quickCommands: [
      'status',
      'synchronizuj',
      'auth status',
      'pr list',
      'issue list',
      'run list',
    ],
  },
  {
    id: 'hyperspace',
    label: 'Konsola obliczeń 128-bit',
    subtitle: 'Moduł obliczeniowy 128-bit BinaryHyperspaceKernel (Hamming) + Analiza Harmoniczna Eulera/Fouriera',
    defaultPrompt: 'hyper128>',
    welcomeText:
      'Konsola wywołuje silnik obliczeń wektorowych i harmonicznych dostępny w backendzie.',
    quickCommands: [
      'system status and diagnostics',
      'vector similarity with Hamming distance',
      'spectral analysis of a sample signal',
    ],
  },
  {
    id: 'agents',
    label: 'Konsola agentów',
    subtitle: 'Kolejka zadań i dyrektyw agentów została wycofana.',
    defaultPrompt: 'agents>',
    welcomeText:
      'Kolejka zadań i dyrektywy agentów AI zostały wycofane.',
    quickCommands: [],
  },
];

export const TerminalsWorkspace: React.FC = () => {
  const {
    tabOrigin,
    wsState,
    wsAttempt,
    wsLastError,
    serverRevision,
    terminalLogsByTab,
    clearTerminalTab,
    refreshTerminals,
    refreshDomainModules,
    reconnectWebSocket,
  } = useSvlSync();

  const [activeTab, setActiveTab] = useState<TerminalTabId>('ssh');
  const [commandInput, setCommandInput] = useState('');
  const [isExecuting, setIsExecuting] = useState(false);
  const [terminalActionError, setTerminalActionError] = useState<string | null>(null);
  const [localFallbackLogs, setLocalFallbackLogs] = useState<Record<TerminalTabId, TerminalLogLine[]>>({
    linux: [],
    ssh: [],
    python: [],
    github: [],
    hyperspace: [],
    agents: [],
  });

  const [operatorTokenInput, setOperatorTokenInput] = useState(() => getSvlOperatorAccessToken());
  const [sshBridgeStatus, setSshBridgeStatus] = useState<any>(null);
  const [sshTargetInput, setSshTargetInput] = useState('');
  const [sshConfigStatus, setSshConfigStatus] = useState<string | null>(null);
  const [isSavingSshConfig, setIsSavingSshConfig] = useState(false);

  const loadSshBridgeStatus = async () => {
    if (!getSvlOperatorAccessToken()) return;
    const res = await safeFetchJson<any>('/api/svl364/ssh-mcp/status', { timeoutMs: 8000 });
    if (res.ok && res.data?.ok) {
      setSshBridgeStatus(res.data.ssh || null);
      if (res.data.ssh?.host) {
        setSshTargetInput((prev) => prev || String(res.data.ssh.host));
      }
    }
  };

  useEffect(() => {
    const onTokenChanged = () => {
      setOperatorTokenInput(getSvlOperatorAccessToken());
      if (activeTab === 'ssh') {
        void loadSshBridgeStatus();
      }
    };
    window.addEventListener('svl-operator-token-changed', onTokenChanged);
    return () => window.removeEventListener('svl-operator-token-changed', onTokenChanged);
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === 'ssh') {
      void loadSshBridgeStatus();
    }
  }, [activeTab, serverRevision]);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const prevLogLenRef = useRef<number>(0);

  const currentTabMeta = TERMINAL_TABS.find((t) => t.id === activeTab)!;
  const persistedLogs = terminalLogsByTab[activeTab] || [];
  const mergedTabLogs: TerminalLogLine[] =
    persistedLogs.length > 0 || (localFallbackLogs[activeTab] || []).length > 0
      ? [
          ...persistedLogs,
          ...(localFallbackLogs[activeTab] || []).filter(
            (loc) => !persistedLogs.some((srv) => srv.id === loc.id),
          ),
        ]
      : [
          {
            id: `banner-${activeTab}`,
            timestamp: new Date().toLocaleTimeString('pl-PL', { hour12: false }),
            kind: 'system',
            text: currentTabMeta.welcomeText,
          },
        ];

  useEffect(() => {
    const curLen = mergedTabLogs.length;
    const prevLen = prevLogLenRef.current;
    prevLogLenRef.current = curLen;
    if (curLen === prevLen && !isExecuting) return;

    const el = viewportRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (dist < 180 || isExecuting) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [activeTab, mergedTabLogs.length, isExecuting]);

  const appendLocalOnlyLog = (tab: TerminalTabId, kind: TerminalLogLine['kind'], text: string) => {
    const now = new Date().toLocaleTimeString('pl-PL', { hour12: false });
    setLocalFallbackLogs((prev) => ({
      ...prev,
      [tab]: [
        ...prev[tab],
        {
          id: `${tab}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          timestamp: now,
          kind,
          text,
        },
      ],
    }));
  };

  const executeTerminalCommand = async (rawCmd: string) => {
    const trimmed = rawCmd.trim();
    if (!trimmed || isExecuting) return;
    setTerminalActionError(null);
    setIsExecuting(true);

    try {
      const res = await safeFetchJson<any>('/api/terminal/exec', {
        method: 'POST',
        timeoutMs: 22000,
        body: JSON.stringify({
          terminalType: activeTab,
          command: trimmed,
          operatorToken: operatorTokenInput,
          origin: tabOrigin,
          confirmed: true,
        }),
      });
      const data = res.data;

      if (!res.ok || !data || data.ok === false) {
        const errMsg =
          (typeof data?.stderr === 'string' && data.stderr.trim()) ||
          (typeof data?.error === 'string' && data.error.trim()) ||
          res.error ||
          `Błąd wykonania HTTP ${res.status}`;
        if (data?.sshStatus) {
          setSshBridgeStatus(data.sshStatus.ssh || data.sshStatus);
        }
        if (data) {
          // Backend zapisał już wpis błędu w SQLite — odśwież historię zamiast dublować komunikat lokalny.
          setLocalFallbackLogs((prev) => ({ ...prev, [activeTab]: [] }));
          await refreshTerminals();
        } else {
          appendLocalOnlyLog(activeTab, 'stderr', errMsg);
        }
        setTerminalActionError(errMsg);
        return;
      }
      if (data?.sshStatus) {
        setSshBridgeStatus(data.sshStatus.ssh || data.sshStatus);
      }
      setCommandInput('');

      // Sync persisted terminal logs, agents, modules & chat state immediately from SQLite
      setLocalFallbackLogs((prev) => ({ ...prev, [activeTab]: [] }));
      await Promise.all([
        refreshTerminals(),
        refreshDomainModules(['agents', 'modules', 'kernel', 'chat']),
      ]);
    } finally {
      setIsExecuting(false);
    }
  };

  const handleSaveSshTarget = async (e: React.FormEvent) => {
    e.preventDefault();
    const target = sshTargetInput.trim();
    if (!target || isSavingSshConfig) return;
    setIsSavingSshConfig(true);
    setSshConfigStatus(null);
    try {
      const res = await safeFetchJson<any>('/api/svl364/ssh-mcp/config', {
        method: 'POST',
        timeoutMs: 10000,
        body: JSON.stringify({ ssh_host: target, origin: tabOrigin }),
      });
      if (res.ok && res.data?.ok) {
        setSshBridgeStatus(res.data.ssh || null);
        setSshConfigStatus(`Zapisano cel SSH: ssh://${res.data.ssh?.host || target}`);
        await refreshDomainModules(['modules', 'health']);
      } else {
        setSshConfigStatus(`Błąd: ${res.error || res.data?.error || 'Nie udało się zapisać celu SSH.'}`);
      }
    } finally {
      setIsSavingSshConfig(false);
    }
  };

  const handleClearActiveTab = async () => {
    setTerminalActionError(null);
    setLocalFallbackLogs((prev) => ({ ...prev, [activeTab]: [] }));
    const res = await clearTerminalTab(activeTab);
    if (!res.ok && res.error) {
      setTerminalActionError(res.error);
    }
  };

  const wsLabel =
    wsState === 'online'
      ? `WebSocket online · Terminal chroniony tokenem · rev ${serverRevision}`
      : wsState === 'connecting'
        ? `Łączenie /ws/svl · Terminal chroniony tokenem · rev ${serverRevision}`
        : wsState === 'reconnecting'
          ? `Reconnect /ws/svl (próba ${wsAttempt}) · rev ${serverRevision}`
          : `WebSocket offline (Sync HTTP) · rev ${serverRevision}`;

  const wsClass =
    wsState === 'online'
      ? 'text-emerald-400'
      : wsState === 'offline'
        ? 'text-rose-400'
        : 'text-amber-400';

  return (
    <div className="flex flex-col h-full bg-[#0B0D13] overflow-hidden">
      {/* Terminal Selector Bar */}
      <div className="px-4 py-3 border-b border-slate-800 bg-[#111520] flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
          {TERMINAL_TABS.map((tab) => {
            const isActive = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  isActive
                    ? 'bg-violet-600 text-white'
                    : 'bg-[#0B0D13] text-slate-400 hover:text-slate-200 border border-slate-800'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono tabular-nums text-slate-400 w-full sm:w-auto">
          <button
            type="button"
            title={wsLastError || 'Stan połączenia /ws/svl'}
            onClick={() => {
              if (wsState !== 'online') reconnectWebSocket();
            }}
            className={`${wsClass} text-left ${wsState !== 'online' ? 'hover:underline cursor-pointer' : 'cursor-default'}`}
          >
            /ws/svl: {wsLabel}
          </button>
          <span aria-hidden="true" className="hidden sm:inline">·</span>
          <button
            type="button"
            onClick={() => void handleClearActiveTab()}
            className="text-slate-400 hover:text-rose-400 flex items-center gap-1 whitespace-nowrap shrink-0"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Wyczyść SQLite</span>
          </button>
        </div>
      </div>

      {/* Active Terminal Subtitle & Quick Presets */}
      <div className="px-4 py-2 bg-[#0D1018] border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-slate-400">{currentTabMeta.subtitle}</span>
        <div className="flex items-center gap-1.5 overflow-x-auto">
          {currentTabMeta.quickCommands.map((qCmd) => (
            <button
              key={qCmd}
              type="button"
              onClick={() => void executeTerminalCommand(qCmd)}
              disabled={isExecuting}
              className="px-2.5 py-1 rounded bg-slate-800/90 hover:bg-slate-700 text-slate-200 text-[11px] font-mono whitespace-nowrap shrink-0 transition-colors"
            >
              {qCmd.length > 44 ? `${qCmd.slice(0, 44)}...` : qCmd}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'ssh' && (
        <div className="px-4 py-2 bg-[#090D15] border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono">
          <div className="flex flex-wrap items-center gap-2 text-slate-300">
            <span className={sshBridgeStatus?.sshInstalled ? 'text-emerald-400' : 'text-amber-300'}>
              {sshBridgeStatus?.sshInstalled
                ? `OpenSSH: OK (${sshBridgeStatus.sshBinaryPath || '/usr/bin/ssh'})`
                : 'OpenSSH: brak pakietu ssh na hoście backendu'}
            </span>
            <span aria-hidden="true" className="text-slate-600">·</span>
            <span className={sshBridgeStatus?.targetReachable ? 'text-emerald-300' : 'text-amber-300'}>
              Cel: {sshBridgeStatus?.uri || 'ssh://Ship'} ({sshBridgeStatus?.targetReachable ? 'osiągalny' : 'nieosiągalny'})
            </span>
            {(!sshBridgeStatus?.sshInstalled || !sshBridgeStatus?.targetReachable) && (
              <button
                type="button"
                onClick={() => {
                  setTerminalActionError(null);
                  setActiveTab('linux');
                }}
                className="px-2 py-0.5 rounded bg-violet-600/25 hover:bg-violet-600/35 border border-violet-500/40 text-violet-200 whitespace-nowrap"
              >
                Przełącz na Powłokę Linux (ROOT lokalny)
              </button>
            )}
          </div>
          <form onSubmit={(e) => void handleSaveSshTarget(e)} className="flex items-center gap-1.5">
            <input
              type="text"
              value={sshTargetInput}
              onChange={(e) => setSshTargetInput(e.target.value)}
              placeholder="user@host lub alias z ~/.ssh/config"
              aria-label="Docelowy host SSH"
              className="w-48 max-w-full rounded border border-slate-700 bg-[#0B0D13] px-2 py-0.5 text-[11px] text-slate-100"
            />
            <button
              type="submit"
              disabled={isSavingSshConfig || !sshTargetInput.trim()}
              className="px-2 py-0.5 rounded bg-emerald-700/80 hover:bg-emerald-600 disabled:opacity-50 text-white whitespace-nowrap"
            >
              {isSavingSshConfig ? 'Zapis...' : 'Ustaw cel SSH'}
            </button>
          </form>
          {sshConfigStatus && (
            <span className={sshConfigStatus.startsWith('Błąd') ? 'text-rose-300' : 'text-emerald-300'}>
              {sshConfigStatus}
            </span>
          )}
        </div>
      )}

      {terminalActionError && (
        <div className="px-4 py-2 bg-rose-950/40 border-b border-rose-500/40 text-xs font-mono text-rose-300">
          {terminalActionError}
        </div>
      )}

      {/* Terminal Output Viewport */}
      <div ref={viewportRef} className="flex-1 overflow-y-auto p-4 font-mono text-xs space-y-2 bg-[#07090E]">
        {mergedTabLogs.map((line) => {
          let textStyle = 'text-slate-200';
          if (line.kind === 'input') textStyle = 'text-violet-300 font-semibold';
          else if (line.kind === 'stderr') textStyle = 'text-rose-400';
          else if (line.kind === 'system') textStyle = 'text-emerald-400';

          return (
            <div key={line.id} className={`${textStyle} whitespace-pre-wrap break-words leading-relaxed`}>
              <span className="text-slate-600 select-none mr-2 tabular-nums">[{line.timestamp}]</span>
              {line.text}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <div className="px-3 py-2 border-t border-slate-800 bg-[#111520]">
        <label className="text-[11px] text-slate-400 flex flex-wrap items-center gap-2">
          <span>Autoryzacja terminala</span>
          <input type="password" autoComplete="off" spellCheck={false}
            aria-label="Prywatny token operatora SVL"
            value={operatorTokenInput}
            onChange={(event) => {
              const val = event.target.value.trim();
              setOperatorTokenInput(val);
              setSvlOperatorAccessToken(val);
            }}
            placeholder="SVL_OPERATOR_TOKEN"
            className="min-w-0 w-48 max-w-full rounded-md border border-slate-700 bg-[#0B0D13] px-2 py-1 text-xs text-slate-100"
          />
          <span>Token zostaje zapisany automatycznie po wpisaniu.</span>
        </label>
      </div>
      {/* Command Input Bar */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void executeTerminalCommand(commandInput);
        }}
        className="p-2.5 sm:p-3 bg-[#111520] border-t border-slate-800 flex items-center gap-2"
      >
        <span className="hidden sm:inline text-xs font-mono text-violet-400 shrink-0 select-none">
          {currentTabMeta.defaultPrompt}
        </span>
        <span className="sm:hidden text-xs font-mono text-violet-400 shrink-0 select-none">
          $
        </span>
        <input
          type="text"
          value={commandInput}
          onChange={(e) => setCommandInput(e.target.value)}
          placeholder={`Dowolne polecenie naturalne lub /exec <polecenie> dla ${currentTabMeta.label}...`}
          aria-label={`Wejście terminala ${currentTabMeta.label}`}
          className="flex-1 min-w-0 min-h-[40px] bg-[#0B0D13] border border-slate-700/80 rounded-lg px-3 py-2 text-xs font-mono text-slate-100 focus:outline-none focus:border-violet-500"
        />
        <button
          type="submit"
          disabled={isExecuting || !commandInput.trim()}
          className="min-h-[40px] px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0"
        >
          <Play className="w-3.5 h-3.5" />
          <span>{isExecuting ? 'Wykonywanie...' : 'Uruchom'}</span>
        </button>
      </form>
    </div>
  );
};
