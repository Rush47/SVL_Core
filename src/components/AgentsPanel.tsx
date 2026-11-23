import { AiEnginesCard } from './AiEnginesCard';
import React, { useState, useEffect, useRef } from 'react';
import {
  Send,
  RefreshCw,
  MessageSquare,
  AlertTriangle,
  Trash2,
  ShieldCheck,
} from 'lucide-react';
import {
  FULL_ROOT_SCOPES,
  createUniqueId,
  formatAgentDisplayName,
  getEffectiveCanonicalAgents,
  getSvlOperatorAccessToken,
  hasSvlOperatorAccessToken,
  safeFetchJson,
  setSvlOperatorAccessToken,
  summarizeAutonomousDaemon,
} from '../utils/svlLogic';
import { useSvlSync } from '../utils/svlSyncStore';
import { SvlAvatar } from './AgentAvatar';

interface AgentsPanelProps {
  onNavigateToChat?: () => void;
}

type AgentAvatar = {
  title: string;
  image_url: string;
  source_url: string;
  license: string;
  author: string;
};

export const AgentsPanel: React.FC<AgentsPanelProps> = ({ onNavigateToChat }) => {
  const {
    tabOrigin,
    agentsData,
    healthData,
    refreshDomainModules,
    selectedAgentPanel,
    setSelectedAgentPanel: setSelectedAgent,
    openAgentChannel,
    notifyLocalMutation,
    serverRevision,
    systemModules,
  } = useSvlSync();
  const agentsList: any[] = agentsData?.agents || [];
  const effectiveAgents = getEffectiveCanonicalAgents(agentsList);
  const selectedAgent = selectedAgentPanel || effectiveAgents[0]?.canonicalName || 'Jyn';

  const [senderActor, setSenderActor] = useState<'operator'>('operator');
  const [taskTitle, setTaskTitle] = useState('');
  const [taskPayload, setTaskPayload] = useState('');
  const [agentOperatorToken, setAgentOperatorToken] = useState(() => getSvlOperatorAccessToken());
  useEffect(() => {
    const onTokenChanged = () => setAgentOperatorToken(getSvlOperatorAccessToken());
    window.addEventListener('svl-operator-token-changed', onTokenChanged);
    return () => window.removeEventListener('svl-operator-token-changed', onTokenChanged);
  }, []);
  const [memoryContent, setMemoryContent] = useState('');
  const [memoryKind, setMemoryKind] = useState<'fact' | 'decision' | 'task' | 'episode'>('fact');
  const [dispatchStatus, setDispatchStatus] = useState<string | null>(null);
  const [memoryStatus, setMemoryStatus] = useState<string | null>(null);
  const [configStatus, setConfigStatus] = useState<{ ok: boolean; msg: string; conflict?: boolean } | null>(null);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [avatarQuery, setAvatarQuery] = useState('');
  const [avatarCandidates, setAvatarCandidates] = useState<AgentAvatar[]>([]);
  const [avatarStatus, setAvatarStatus] = useState<string | null>(null);
  const [isSearchingAvatars, setIsSearchingAvatars] = useState(false);
  const [savingAvatar, setSavingAvatar] = useState(false);
  const [isConnectingWorkers, setIsConnectingWorkers] = useState(false);
  const [connectWorkersMsg, setConnectWorkersMsg] = useState<string | null>(null);
  const [isGrantingAllRoot, setIsGrantingAllRoot] = useState(false);
  const [rootGrantStatus, setRootGrantStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [autonomyBusy, setAutonomyBusy] = useState(false);
  const [autonomyFeedback, setAutonomyFeedback] = useState<string | null>(null);

  const agentLogs: Record<string, any[]> = agentsData?.agent_logs || {};
  const agentQueues: Record<string, any[]> = agentsData?.agent_queues || {};
  const agentMemories: Record<string, any[]> = agentsData?.agent_memories || {};
  const rawAutonomy = agentsData?.autonomous_daemon || healthData?.autonomous_daemon || null;
  const autonomySummary = summarizeAutonomousDaemon(rawAutonomy);
  const sphericalBus = agentsData?.spherical_bus || {};
  const ollamaModels: any[] = healthData?.ollama?.models || [];
  const pullState = healthData?.ollama?.pull_state;
  const svl364ConfiguredModel = String(
    systemModules.find((m) => m.id === 'svl-364')?.config?.configured_ollama_model || '',
  ).trim();
  const hasConfiguredModelPulled = Boolean(
    svl364ConfiguredModel &&
      ollamaModels.some(
        (m: any) =>
          m.name === svl364ConfiguredModel ||
          String(m.name || '').startsWith(`${svl364ConfiguredModel.split(':')[0]}:`),
      ),
  );

  const activeAgentObj = agentsList.find((a) => a.canonical_name === selectedAgent) || {};
  const activeAgentCfg = activeAgentObj.config || {};
  const selectedAgentTasks = agentQueues[selectedAgent] || [];
  const currentConfigRevision: number | undefined =
    typeof activeAgentObj.config_revision === 'number'
      ? activeAgentObj.config_revision
      : typeof activeAgentCfg.revision === 'number'
        ? activeAgentCfg.revision
        : undefined;

  const [cfgPreferredModel, setCfgPreferredModel] = useState('svl-hybrid-router');
  const [cfgOllamaModel, setCfgOllamaModel] = useState('dolphin-llama3:8b-v2.9-q2_K');
  const [cfgFallbackModel, setCfgFallbackModel] = useState('gemini-3.1-flash-lite');
  const [cfgTemperature, setCfgTemperature] = useState('0.7');
  const [cfgRbacRole, setCfgRbacRole] = useState('');
  const [cfgVisionEnabled, setCfgVisionEnabled] = useState(true);
  const [cfgSystemPrompt, setCfgSystemPrompt] = useState('');

  const [isConfigDirty, setIsConfigDirty] = useState(false);
  const [remoteConfigChangedWhileDirty, setRemoteConfigChangedWhileDirty] = useState(false);
  const loadedRevisionRef = useRef<{ agent: string; rev?: number }>({ agent: selectedAgent, rev: undefined });

  const hydrateConfigFormFromServer = () => {
    setCfgPreferredModel(activeAgentCfg.preferred_model || 'svl-hybrid-router');
    setCfgOllamaModel(activeAgentCfg.ollama_model || 'dolphin-llama3:8b-v2.9-q2_K');
    setCfgFallbackModel(activeAgentCfg.fallback_model || 'gemini-3.1-flash-lite');
    setCfgTemperature(String(activeAgentCfg.temperature ?? 0.7));
    setCfgRbacRole(activeAgentCfg.rbac_role || '');
    setCfgVisionEnabled(activeAgentCfg.vision_enabled !== false);
    setCfgSystemPrompt(activeAgentCfg.system_prompt || '');
    setIsConfigDirty(false);
    setRemoteConfigChangedWhileDirty(false);
    loadedRevisionRef.current = { agent: selectedAgent, rev: currentConfigRevision };
  };

  useEffect(() => {
    const agentChanged = loadedRevisionRef.current.agent !== selectedAgent;
    if (agentChanged) {
      hydrateConfigFormFromServer();
      setConfigStatus(null);
      return;
    }

    const revChanged =
      currentConfigRevision !== undefined && currentConfigRevision !== loadedRevisionRef.current.rev;

    if (!isConfigDirty) {
      hydrateConfigFormFromServer();
    } else if (revChanged) {
      setRemoteConfigChangedWhileDirty(true);
    }
  }, [
    selectedAgent,
    currentConfigRevision,
    activeAgentCfg.preferred_model,
    activeAgentCfg.ollama_model,
    activeAgentCfg.fallback_model,
    activeAgentCfg.temperature,
    activeAgentCfg.rbac_role,
    activeAgentCfg.vision_enabled,
    activeAgentCfg.system_prompt,
    isConfigDirty,
  ]);

  const markDirty = () => {
    if (!isConfigDirty) setIsConfigDirty(true);
  };

  const handleDispatchTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAgent) {
      setDispatchStatus('Brak aktywnych agentów AI. Poprzednie polecenia zostały wycofane.');
      return;
    }
    if (!taskTitle.trim()) {
      setDispatchStatus('Błąd: Tytuł zadania nie może być pusty.');
      return;
    }
    setDispatchStatus('Wysyłanie zadania przez Sferyczną Magistralę Zdarzeń...');
    const res = await safeFetchJson<any>('/api/py/agents/task', {
      method: 'POST',
      timeoutMs: 15000,
      headers: agentOperatorToken ? {'X-SVL-Operator-Token': agentOperatorToken} : {},
      body: JSON.stringify({
        sender: senderActor,
        target_agent: selectedAgent,
        title: taskTitle.trim(),
        payload: taskPayload.trim() || taskTitle.trim(),
        ai_provider: 'ollama',
        origin: tabOrigin,
        eventId: createUniqueId('evt-task'),
      }),
    });
    const data = res.data;
    if (res.ok && data?.ok) {
      const providerLabel = 'Ollama';
      const workerAccepted = data.resilience?.workerAccepted === true;
      setDispatchStatus(
        `Zadanie zapisano dla ${selectedAgent} (${providerLabel}, ID: ${String(data.task?.id || '').slice(0, 8)}). ` +
        (workerAccepted
          ? `Przekazano do workera (${data.resilience?.engine || 'nieznany silnik'}). Oczekiwanie na odpowiedź AI.`
          : 'Worker nie przejął jeszcze zadania; pozostaje w kolejce SQLite.'),
      );
      setTaskTitle('');
      setTaskPayload('');
      notifyLocalMutation('agent_task', selectedAgent, data.serverRevision, data.event);
      await refreshDomainModules(['agents']);
    } else {
      setDispatchStatus(`Błąd: ${res.error || data?.error || 'Nie udało się wykonać zadania'}`);
    }
  };

  const [deletingMemoryId, setDeletingMemoryId] = useState<string | null>(null);

  const handleAddMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAgent) {
      setMemoryStatus('Brak aktywnych agentów AI.');
      return;
    }
    if (!memoryContent.trim()) {
      setMemoryStatus('Błąd: Wpis pamięci nie może być pusty.');
      return;
    }
    const res = await safeFetchJson<any>('/api/py/agents/memory', {
      method: 'POST',
      timeoutMs: 12000,
      body: JSON.stringify({
        agent: selectedAgent,
        kind: memoryKind,
        content: memoryContent.trim(),
        origin: tabOrigin,
        eventId: createUniqueId('evt-mem'),
      }),
    });
    const data = res.data;
    if (res.ok && data?.ok) {
      setMemoryStatus(`Zapisano w trwałej pamięci SQLite (zakres: agent:${selectedAgent}).`);
      setMemoryContent('');
      notifyLocalMutation('agent_memory', selectedAgent, data.serverRevision, data.event);
      await refreshDomainModules(['agents']);
    } else {
      setMemoryStatus(`Błąd: ${res.error || data?.error || 'Nie udało się zapisać pamięci.'}`);
    }
  };

  const handleDeleteMemory = async (memId: string) => {
    if (!selectedAgent || !memId || deletingMemoryId) return;
    setDeletingMemoryId(memId);
    try {
      const res = await safeFetchJson<any>('/api/py/agents/memory/delete', {
        method: 'POST',
        timeoutMs: 12000,
        body: JSON.stringify({
          agent: selectedAgent,
          memory_id: memId,
          origin: tabOrigin,
          eventId: createUniqueId('evt-mem-del'),
        }),
      });
      const data = res.data;
      if (res.ok && data?.ok) {
        setMemoryStatus(`Usunięto wpis pamięci z SQLite (${memId.slice(0, 8)}).`);
        notifyLocalMutation('agent_memory', selectedAgent, data.serverRevision, data.event);
        await refreshDomainModules(['agents']);
      } else {
        setMemoryStatus(`Błąd: ${res.error || data?.error || 'Nie udało się usunąć wpisu pamięci.'}`);
      }
    } finally {
      setDeletingMemoryId(null);
    }
  };

  const handleSaveAgentConfig = async (e: React.FormEvent, forceLatestRevision = false) => {
    e.preventDefault();
    if (!selectedAgent) {
      setConfigStatus({ ok: false, msg: 'Brak aktywnego agenta do konfiguracji.' });
      return;
    }
    setIsSavingConfig(true);
    setConfigStatus(null);
    try {
      const expectedRev = forceLatestRevision ? currentConfigRevision : loadedRevisionRef.current.rev;
      const res = await safeFetchJson<any>('/api/py/agents/config', {
        method: 'POST',
        timeoutMs: 12000,
        body: JSON.stringify({
          agent: selectedAgent,
          expectedRevision: expectedRev,
          origin: tabOrigin,
          eventId: createUniqueId('evt-cfg'),
          config: {
            preferred_model: cfgPreferredModel,
            ollama_model: cfgOllamaModel,
            fallback_model: cfgFallbackModel,
            temperature: Number(cfgTemperature) || 0.7,
            rbac_role: cfgRbacRole,
            vision_enabled: cfgVisionEnabled,
            system_prompt: cfgSystemPrompt,
          },
        }),
      });
      const data = res.data;
      if (res.ok && data?.ok) {
        loadedRevisionRef.current = { agent: selectedAgent, rev: data.revision };
        setIsConfigDirty(false);
        setRemoteConfigChangedWhileDirty(false);
        setConfigStatus({
          ok: true,
          msg: `Zapisano pełną konfigurację dla ${selectedAgent} w SQLite (rewizja ${data.revision ?? '?'}).`,
        });
        notifyLocalMutation('agent_config', selectedAgent, data.serverRevision, data.event);
        await refreshDomainModules(['agents']);
      } else if (res.conflict || res.status === 409) {
        setRemoteConfigChangedWhileDirty(true);
        setConfigStatus({
          ok: false,
          conflict: true,
          msg:
            `Konflikt rewizji (HTTP 409): konfiguracja ${selectedAgent} została zmieniona w innej sesji (serwer rev ${data?.currentRevision ?? '?'}). ` +
            `Twoje niezapisane pola zachowano.`,
        });
        await refreshDomainModules(['agents']);
      } else {
        setConfigStatus({
          ok: false,
          msg: `Błąd zapisu: ${res.error || data?.error || 'Nieznany błąd zapisu'}`,
        });
      }
    } finally {
      setIsSavingConfig(false);
    }
  };

  const handleGrantFullRootAllAgents = async () => {
    if (isGrantingAllRoot) return;
    if (!hasSvlOperatorAccessToken()) {
      setRootGrantStatus({
        ok: false,
        msg: 'Odblokuj dostęp przyciskiem 🔒 SVL w górnym pasku, aby nadać uprawnienia ROOT w SQLite.',
      });
      return;
    }
    setIsGrantingAllRoot(true);
    setRootGrantStatus(null);
    try {
      const results: string[] = [];
      for (const agent of effectiveAgents) {
        const res = await safeFetchJson<any>('/api/py/agents/config', {
          method: 'POST',
          timeoutMs: 12000,
          body: JSON.stringify({
            agent: agent.canonicalName,
            origin: tabOrigin,
            eventId: createUniqueId(`evt-root-${agent.id}`),
            config: {
              rbac_role: 'root',
              autonomy_mode: 'ROOT_AUTHORIZED',
              allowed_scopes: [...FULL_ROOT_SCOPES],
            },
          }),
        });
        if (!res.ok || !res.data?.ok) {
          throw new Error(
            `${agent.displayName}: ${res.error || res.data?.error || `HTTP ${res.status}`}`,
          );
        }
        results.push(`${agent.displayName} (rev ${res.data.revision ?? '?'})`);
        notifyLocalMutation('agent_config', agent.canonicalName, res.data.serverRevision, res.data.event);
      }
      setCfgRbacRole('root');
      await refreshDomainModules(['agents', 'health']);
      setRootGrantStatus({
        ok: true,
        msg: `Przyznano pełne uprawnienia ROOT (${FULL_ROOT_SCOPES.length} zakresów) dla: ${results.join(', ')}.`,
      });
    } catch (err: any) {
      setRootGrantStatus({
        ok: false,
        msg: `Błąd nadawania uprawnień ROOT: ${err?.message || String(err)}`,
      });
    } finally {
      setIsGrantingAllRoot(false);
    }
  };

  const handleSearchAvatars = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsSearchingAvatars(true);
    setAvatarStatus(null);
    setAvatarCandidates([]);
    try {
      const result = await safeFetchJson<{ ok: boolean; candidates?: AgentAvatar[]; error?: string }>(
        '/api/agents/avatar-search',
        {
          method: 'POST',
          timeoutMs: 30000,
          body: JSON.stringify({ agent: selectedAgent, query: avatarQuery.trim() }),
        },
      );
      if (!result.ok || !result.data?.ok) {
        setAvatarStatus(result.error || result.data?.error || 'Nie udało się wyszukać avatarów.');
        return;
      }
      setAvatarCandidates(result.data.candidates || []);
      if (!result.data.candidates?.length) {
        setAvatarStatus('Nie znaleziono pasujących obrazów z dozwoloną licencją.');
      }
    } finally {
      setIsSearchingAvatars(false);
    }
  };

  const handleChooseAvatar = async (avatar: AgentAvatar) => {
    setSavingAvatar(true);
    setAvatarStatus(null);
    try {
      const res = await safeFetchJson<any>('/api/py/agents/config', {
        method: 'POST',
        timeoutMs: 12000,
        body: JSON.stringify({
          agent: selectedAgent,
          expectedRevision: currentConfigRevision,
          origin: tabOrigin,
          eventId: createUniqueId('evt-avatar'),
          config: { avatar },
        }),
      });
      if (!res.ok || !res.data?.ok) {
        setAvatarStatus(res.error || res.data?.error || 'Nie udało się zapisać avatara.');
        return;
      }
      setAvatarCandidates([]);
      setAvatarStatus(`Zapisano avatar ${selectedAgent}: ${avatar.title} (${avatar.license}).`);
      notifyLocalMutation('agent_config', selectedAgent, res.data.serverRevision, res.data.event);
      await refreshDomainModules(['agents']);
    } finally {
      setSavingAvatar(false);
    }
  };

  const handleConnectWorkers = async () => {
    setIsConnectingWorkers(true);
    setConnectWorkersMsg(null);
    try {
      const res = await safeFetchJson<any>('/api/py/agents/connect', {
        method: 'POST',
        timeoutMs: 15000,
        body: JSON.stringify({ triggered_by: tabOrigin }),
      });
      if (res.ok && res.data?.ok) {
        const spawned = res.data?.connection_report?.agents || [];
        setConnectWorkersMsg(
          spawned.length > 0
            ? `Połączono worker ${spawned.map((a: any) => `${a.display_name} (PID ${a.pid})`).join(', ')}.`
            : 'Zsynchronizowano stan agentów AI.',
        );
        notifyLocalMutation('agent_runtime', 'workers', res.data.serverRevision);
        await refreshDomainModules(['agents', 'health']);
      } else {
        setConnectWorkersMsg(`Błąd uruchamiania workera: ${res.error || res.data?.error || 'HTTP ' + res.status}`);
      }
    } finally {
      setIsConnectingWorkers(false);
    }
  };

  const handleToggleAutonomy = async () => {
    setAutonomyBusy(true);
    setAutonomyFeedback(null);
    try {
      const nextEnabled = !autonomySummary.enabled;
      const res = await safeFetchJson<any>('/api/autonomy/config', {
        method: 'POST',
        timeoutMs: 15000,
        body: JSON.stringify({
          enabled: nextEnabled,
          root_commands_enabled: true,
          full_visibility: true,
          origin: tabOrigin,
        }),
      });
      if (res.ok && res.data?.ok) {
        setAutonomyFeedback(
          nextEnabled
            ? `Włączono autonomię AI w tle (ROOT · cykle: ${res.data.cycles_completed ?? autonomySummary.cyclesCompleted}).`
            : 'Wstrzymano automatyczną pętlę AI w tle.',
        );
        notifyLocalMutation('autonomy', 'autonomous_daemon', res.data.serverRevision);
        await refreshDomainModules(['agents', 'health', 'modules']);
      } else {
        setAutonomyFeedback(`Błąd konfiguracji autonomii: ${res.error || res.data?.error || 'HTTP ' + res.status}`);
      }
    } finally {
      setAutonomyBusy(false);
    }
  };

  const handleRunAutonomyCycle = async () => {
    setAutonomyBusy(true);
    setAutonomyFeedback(null);
    try {
      const res = await safeFetchJson<any>('/api/autonomy/run-cycle', {
        method: 'POST',
        timeoutMs: 20000,
        body: JSON.stringify({ trigger: 'agents_panel_manual', origin: tabOrigin }),
      });
      if (res.ok && res.data?.ok) {
        setAutonomyFeedback(
          `Wykonano cykl #${res.data.cycles_completed ?? 1} · usługi aktywne: ${Array.isArray(res.data.services) ? res.data.services.length : 6}.`,
        );
        notifyLocalMutation('autonomy', 'autonomous_daemon', res.data.serverRevision);
        await refreshDomainModules(['agents', 'health', 'modules']);
      } else {
        setAutonomyFeedback(`Błąd cyklu autonomii: ${res.error || res.data?.error || 'HTTP ' + res.status}`);
      }
    } finally {
      setAutonomyBusy(false);
    }
  };

  return (
    <div className="flex-1 min-h-0 h-full overflow-y-auto svl-scroll-smooth p-3 sm:p-4 md:p-6 space-y-5 sm:space-y-6 bg-[#0B0D13]">
      {/* Header Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-slate-800">
        <div>
          <h1 className="text-xl font-bold text-slate-100">
            {effectiveAgents.length > 0
              ? `01. Panel Agentów AI — Aktywni agenci (${effectiveAgents.length})`
              : '01. Panel Agentów AI — Brak aktywnych agentów'}
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            {effectiveAgents.length > 0
              ? `Aktywny procesor AI i poleceń czatu: JEDI Omni-OS v12 (ROOT_UNRESTRICTED · VM + AI) + ${effectiveAgents.map((a) => a.canonicalName).join(' + ')} (ROOT · SQLite WAL rev ${serverRevision}).`
              : `Wszystkie wcześniejsze polecenia i profile agentów AI zostały usunięte i wycofane z SQLite WAL (rev ${serverRevision}).`}
          </p>
          {connectWorkersMsg && (
            <p className="text-xs text-amber-300 font-mono mt-1">{connectWorkersMsg}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          {effectiveAgents.length > 0 && (
            <button
              type="button"
              disabled={isConnectingWorkers}
              onClick={() => void handleConnectWorkers()}
              className="min-h-[40px] px-3.5 py-2 rounded-lg bg-amber-600/20 hover:bg-amber-600/35 border border-amber-500/40 text-xs font-semibold text-amber-200 flex items-center gap-2 transition-colors whitespace-nowrap disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isConnectingWorkers ? 'animate-spin' : ''}`} />
              {isConnectingWorkers ? 'Łączenie...' : 'Połącz / Uruchom AI'}
            </button>
          )}
          <button
            type="button"
            onClick={() => void refreshDomainModules(['agents', 'health'])}
            className="min-h-[40px] px-3.5 py-2 rounded-lg bg-[#111520] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-2 transition-colors whitespace-nowrap"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Odśwież telemetrię
          </button>
          {onNavigateToChat && (
            <button
              type="button"
              onClick={onNavigateToChat}
              className="min-h-[40px] px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-xs font-semibold text-white flex items-center gap-2 transition-colors whitespace-nowrap"
            >
              <MessageSquare className="w-4 h-4" />
              Przejdź do Czatu
            </button>
          )}
        </div>
      </div>

      <AiEnginesCard />

      {/* Autonomous Background AI & Built-in System Services (ROOT) */}
      <section className="rounded-xl border border-emerald-500/30 bg-[#0D1321] p-4 sm:p-5 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
              <h2 className="text-sm sm:text-base font-bold text-slate-100">
                Autonomia AI w Tle & Wbudowane Usługi Systemowe (ROOT)
              </h2>
              <span
                className={`px-2 py-0.5 rounded text-[11px] font-mono font-semibold border ${
                  autonomySummary.enabled
                    ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-300'
                    : 'bg-slate-900 border-slate-700 text-slate-300'
                }`}
              >
                {autonomySummary.statusLabel}
              </span>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">{autonomySummary.continuousMission}</p>
            {autonomyFeedback && <p className="text-xs font-mono text-emerald-300">{autonomyFeedback}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={autonomyBusy}
              onClick={() => void handleToggleAutonomy()}
              className={`min-h-[38px] px-3.5 py-1.5 rounded-lg text-xs font-semibold border transition-colors whitespace-nowrap disabled:opacity-50 ${
                autonomySummary.enabled
                  ? 'bg-amber-600/20 hover:bg-amber-600/30 border-amber-500/40 text-amber-200'
                  : 'bg-emerald-600/25 hover:bg-emerald-600/35 border-emerald-500/50 text-emerald-200'
              }`}
            >
              {autonomyBusy ? 'Zapisywanie...' : autonomySummary.enabled ? 'Wstrzymaj pętlę tła' : 'Włącz autonomię AI (ROOT)'}
            </button>
            <button
              type="button"
              disabled={autonomyBusy}
              onClick={() => void handleRunAutonomyCycle()}
              className="min-h-[38px] px-3.5 py-1.5 rounded-lg bg-cyan-600/20 hover:bg-cyan-600/35 border border-cyan-500/40 text-xs font-semibold text-cyan-200 transition-colors whitespace-nowrap disabled:opacity-50"
            >
              Wykonaj cykl teraz
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs font-mono">
          <div className="rounded-lg border border-slate-800 bg-[#080C16] p-2.5">
            <div className="text-slate-400 text-[11px]">Cykle autonomii</div>
            <div className="text-slate-100 font-bold mt-0.5">{autonomySummary.cyclesCompleted}</div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-[#080C16] p-2.5">
            <div className="text-slate-400 text-[11px]">Usługi / Workery</div>
            <div className="text-emerald-300 font-bold mt-0.5">
              {autonomySummary.servicesActiveCount} / {autonomySummary.servicesTotal || 6} aktywne
            </div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-[#080C16] p-2.5">
            <div className="text-slate-400 text-[11px]">Interwał pętli</div>
            <div className="text-cyan-300 font-bold mt-0.5">{autonomySummary.intervalSec}s (ROOT)</div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-[#080C16] p-2.5">
            <div className="text-slate-400 text-[11px]">Inwentarz kodu</div>
            <div className="text-slate-100 font-bold mt-0.5">
              FE {autonomySummary.frontendComponentsCount} · BE {autonomySummary.backendModulesCount} · T {autonomySummary.testFilesCount}
            </div>
          </div>
        </div>

        {autonomySummary.services.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
            {autonomySummary.services.map((svc) => (
              <div key={svc.id} className="rounded-lg border border-slate-800/90 bg-[#080C16] p-3 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-100 truncate">{svc.name}</span>
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
                      ['ACTIVE', 'READY', 'ONLINE', 'RUNNING'].includes(svc.status.toUpperCase())
                        ? 'bg-emerald-950/70 text-emerald-300 border border-emerald-500/30'
                        : 'bg-amber-950/70 text-amber-300 border border-amber-500/30'
                    }`}
                  >
                    {svc.status}
                  </span>
                </div>
                <div className="text-[11px] text-slate-400 font-mono">
                  {svc.kind} · {svc.owner}
                </div>
                <p className="text-xs text-slate-300 leading-snug">{svc.summary}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      {effectiveAgents.length === 0 && (
      <div className="p-5 rounded-xl bg-[#111520] border border-slate-800 text-xs text-slate-300 space-y-2">
          <div className="font-semibold text-slate-100">
            Rejestr agentów AI jest pusty
          </div>
          <p className="text-slate-400 leading-relaxed">
            Wcześniejsze profile agentów AI, kolejki zadań, dyrektywy i historia poleceń zostały usunięte oraz wycofane. System działa w trybie bezpiecznego czatu z Asystentem SVL.
          </p>
        </div>
      )}

      {/* Canonical agent cards grid */}
      <div
        className={`grid gap-4 ${
          effectiveAgents.length <= 2
            ? 'grid-cols-1 lg:grid-cols-2'
            : 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3'
        }`}
      >
        {effectiveAgents.map((meta) => {
          const live = agentsList.find((a) => a.canonical_name === meta.canonicalName) || {};
          const cb = sphericalBus.circuit_breakers?.[meta.canonicalName] || { state: 'CLOSED', failure_count: 0 };
          const isOnline = ['ONLINE_LOCAL_WORKER', 'BUSY_LOCAL_WORKER', 'DEGRADED_LOCAL_WORKER'].includes(live.status);
          const isSelected = selectedAgent === meta.canonicalName;

          return (
            <article
              key={meta.id}
              onClick={() => setSelectedAgent(meta.canonicalName)}
              className={`p-4 rounded-xl bg-[#111520] border transition-colors flex flex-col justify-between space-y-4 ${
                isSelected ? 'border-violet-500 ring-1 ring-violet-500/40' : 'border-slate-800/90 hover:border-slate-700'
              }`}
            >
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedAgent(meta.canonicalName);
                    }}
                    className="flex min-w-0 items-center gap-2 text-left rounded focus:outline-none focus:ring-1 focus:ring-violet-500"
                  >
                    {live.config?.avatar?.image_url ? (
                      <img
                        src={live.config.avatar.image_url}
                        alt={`Avatar ${meta.displayName}`}
                        referrerPolicy="no-referrer"
                        className="h-10 w-10 shrink-0 rounded-full border border-slate-700 object-cover"
                      />
                    ) : (
                      <SvlAvatar sender={meta.displayName} agentId={meta.id} size={40} />
                    )}
                    <span className={`truncate text-base font-bold ${meta.textClass}`}>
                      {meta.displayName}
                    </span>
                  </button>
                  <span className="text-xs font-mono text-slate-400 shrink-0">
                    id: {meta.id}
                  </span>
                </div>

                <div className="text-[11px] font-mono tabular-nums text-slate-400">
                  <span>{isOnline ? `${live.status} (PID ${live.pid} · UID ${live.uid ?? '?'})` : `STAN: ${live.status || 'BRAK DANYCH'}`}</span>
                  <span aria-hidden="true"> · </span>
                  <span>CB: {cb.state}</span>
                </div>
                <div className="text-[11px] font-mono text-slate-500">
                  Faza: {live.worker_phase || '—'} · kolejka: {live.queue_depth ?? 0}
                </div>

                <p className="text-xs text-slate-300 leading-relaxed">
                  {meta.preservedRole}
                </p>
              </div>

              <div className="pt-3 border-t border-slate-800/80 space-y-1.5 text-[11px] font-mono tabular-nums text-slate-400">
                <div className="flex flex-wrap justify-between gap-2">
                  <span>Silnik / Ollama:</span>
                  <span className="text-emerald-300 truncate max-w-[170px]">
                    {live.config?.ollama_model || 'dolphin-llama3:8b-v2.9-q2_K'}
                  </span>
                </div>
                <div className="flex flex-wrap justify-between gap-2">
                  <span>Uprawnienia / Temp:</span>
                  <span className="text-emerald-300 truncate max-w-[170px]">
                    {live.config?.rbac_role || 'root'} · {live.config?.temperature ?? 0.35}
                  </span>
                </div>
                <div className="flex flex-wrap justify-between gap-2">
                  <span>Pamięć SQLite ({live.memory_scope || `agent:${meta.canonicalName}`}):</span>
                  <span className="text-violet-300">{live.memory_entries_count ?? 0} wpisów</span>
                </div>
                <div className="flex flex-wrap justify-between gap-2">
                  <span>Kanał grupowy:</span>
                  <span className="text-slate-300">Rodzina Mitek (wszyscy)</span>
                </div>
                {onNavigateToChat && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      openAgentChannel(meta.canonicalName);
                      onNavigateToChat();
                    }}
                    className="mt-2 w-full py-1.5 px-2.5 rounded-lg bg-amber-600/20 hover:bg-amber-600/35 border border-amber-500/40 text-amber-200 text-xs font-sans font-medium flex items-center justify-center gap-1.5 transition-colors"
                  >
                    <MessageSquare className="w-3.5 h-3.5" />
                    Rozmawiaj z {meta.displayName}
                  </button>
                )}
              </div>
            </article>
          );
        })}

        {effectiveAgents.length >= 1 && (
          <section className={`p-4 rounded-xl bg-[#111520] border border-cyan-500/30 flex flex-col justify-between space-y-3 ${effectiveAgents.length > 1 ? 'lg:col-span-2' : ''}`}>
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-cyan-300">
                  Procesor AI i Poleceń — JEDI Omni-OS v12 (ROOT_UNRESTRICTED · AI + VM) &amp; {effectiveAgents.map((a) => a.canonicalName).join(' / ')}
                </h2>
                <span className="text-[11px] font-mono text-emerald-300">
                  v12 · ROOT_UNRESTRICTED · AI + VM RT
                </span>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                Każde zapytanie kierowane do <strong className="text-emerald-300">JEDI Omni-OS v12</strong> generuje pełną odpowiedź AI bez blokad (Ollama/Gemini z pamięcią SQLite), a polecenia systemowe i synchronizacja (<code className="text-cyan-300">/synchronizuj</code>, <code className="text-emerald-300">/jedi status</code>, <code className="text-emerald-300">/jedi apply-v12-core</code>) uruchamiają maszynę wirtualną <code className="text-emerald-300">JEDI_Omni_OS_Magnum_Opus_v12</code> w czasie rzeczywistym:
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-[11px] font-mono text-slate-300 bg-[#0B0D13] p-3 rounded-lg border border-slate-800">
                <div><span className="text-emerald-300">/jedi status</span> · stan VM i metryki</div>
                <div><span className="text-emerald-300">/synchronizuj</span> · pełny sync OS i modułów</div>
                <div><span className="text-cyan-300">/pomoc</span> · lista komend</div>
                <div><span className="text-cyan-300">/status</span> · telemetria i Ollama</div>
                <div><span className="text-cyan-300">/moduly</span> · moduły SQLite</div>
                <div><span className="text-cyan-300">/pamiec dodaj ...</span> · fakt SQLite</div>
                <div><span className="text-cyan-300">/root polecenie</span> · powłoka Linux ROOT</div>
                <div><span className="text-cyan-300">/zadanie tyt | opis</span> · worker</div>
              </div>
            </div>
            <div className="text-[11px] text-slate-400 flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800/80 font-mono">
              <span>VM TCP: 0.0.0.0:8443 · Ollama: 127.0.0.1:11434</span>
              <span>Modele lokalne: {ollamaModels.length}</span>
            </div>
          </section>
        )}
      </div>

      <div className="rounded-xl border border-slate-800 bg-[#111520] p-3.5 sm:p-5 space-y-3 min-w-0">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">Avatar agenta: {selectedAgent}</h2>
          <p className="mt-1 text-[11px] text-slate-400">
            Google Search znajduje strony Wikimedia Commons; zapis jest dozwolony wyłącznie dla Public Domain, CC0, CC BY i CC BY-SA.
          </p>
        </div>
        <form onSubmit={(event) => void handleSearchAvatars(event)} className="flex flex-wrap gap-2">
          <input
            value={avatarQuery}
            onChange={(event) => setAvatarQuery(event.target.value)}
            maxLength={120}
            placeholder={`Motyw avatara dla ${selectedAgent}...`}
            aria-label={`Wyszukaj avatar ${selectedAgent}`}
            className="min-w-0 sm:min-w-[220px] flex-1 rounded-lg border border-slate-700 bg-[#0B0D13] px-3 py-2 text-xs text-slate-100"
          />
          <button
            type="submit"
            disabled={isSearchingAvatars || avatarQuery.trim().length < 2}
            className="rounded-lg bg-violet-600 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50"
          >
            {isSearchingAvatars ? 'Wyszukiwanie...' : 'Szukaj w Google'}
          </button>
        </form>
        {avatarStatus && <p role="status" className="text-xs text-slate-300">{avatarStatus}</p>}
        {avatarCandidates.length > 0 && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {avatarCandidates.map((avatar) => (
              <div key={avatar.source_url} className="flex gap-3 rounded-lg border border-slate-800 bg-[#0B0D13] p-3">
                <img
                  src={avatar.image_url}
                  alt={avatar.title}
                  referrerPolicy="no-referrer"
                  className="h-16 w-16 shrink-0 rounded-full border border-slate-700 object-cover"
                />
                <div className="min-w-0 space-y-1">
                  <p className="truncate text-xs font-semibold text-slate-100">{avatar.title}</p>
                  <p className="text-[11px] text-slate-400">{avatar.license} · {avatar.author || 'autor niepodany'}</p>
                  <a
                    href={avatar.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block truncate text-[11px] text-violet-300 underline"
                  >
                    Oryginalna strona i warunki licencji
                  </a>
                  <button
                    type="button"
                    onClick={() => void handleChooseAvatar(avatar)}
                    disabled={savingAvatar}
                    className="mt-1 rounded bg-emerald-700 px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-50"
                  >
                    {savingAvatar ? 'Zapisywanie...' : 'Ustaw avatar'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Interactive Agent-to-Agent Task Queue & Memory Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="p-3.5 sm:p-5 rounded-xl bg-[#111520] border border-slate-800 space-y-4 min-w-0">
          <h2 className="text-sm font-semibold text-slate-100">
            02. Asynchroniczna Kolejka Zadań i Komunikacja Agent-Agent (Sferyczny Event Bus)
          </h2>
          <form onSubmit={(e) => void handleDispatchTask(e)} className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="task-sender-select" className="block text-xs text-slate-400 mb-1">
                  Nadawca komunikatu / zadania:
                </label>
                <select
                  id="task-sender-select"
                  value={senderActor}
                  onChange={(e) => setSenderActor(e.target.value as 'operator')}
                  className="w-full bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200"
                >
                  <option value="operator">Mateusz Mitek (Operator)</option>
                </select>
              </div>
              <div>
                <label htmlFor="task-target-select" className="block text-xs text-slate-400 mb-1">
                  Docelowy worker agenta:
                </label>
                <select
                  id="task-target-select"
                  value={selectedAgent}
                  onChange={(e) => setSelectedAgent(e.target.value)}
                  disabled={effectiveAgents.length === 0}
                  className="w-full bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 disabled:opacity-50"
                >
                  {effectiveAgents.length === 0 ? (
                    <option value="">Brak skonfigurowanych agentów</option>
                  ) : (
                    effectiveAgents.map((meta) => (
                      <option key={meta.id} value={meta.canonicalName}>
                        {meta.displayName} (id: {meta.id})
                      </option>
                    ))
                  )}
                </select>
              </div>
            </div>

            <div>
              <label htmlFor="task-title-input" className="block text-xs text-slate-400 mb-1">
                Polecenie / tytuł zadania:
              </label>
              <input
                id="task-title-input"
                type="text"
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
                placeholder="np. Zweryfikuj konfigurację Ollama i uprawnienia SVLProtectedVariable"
                className="w-full bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100"
              />
            </div>

            <div>
              <label htmlFor="task-payload-input" className="block text-xs text-slate-400 mb-1">
                Parametry wykonawcze (opcjonalnie):
              </label>
              <textarea
                id="task-payload-input"
                rows={2}
                value={taskPayload}
                onChange={(e) => setTaskPayload(e.target.value)}
                placeholder="Szczegóły zadania przekazywane przez asyncio Event Bus..."
                className="w-full bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100"
              />
            </div>

            <label className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
              Token operatora (dla zadań agentów)
              <input type="password" autoComplete="off" spellCheck={false}
                value={agentOperatorToken}
                onChange={(event) => {
                  const val = event.target.value.trim();
                  setAgentOperatorToken(val);
                  setSvlOperatorAccessToken(val);
                }}
                placeholder="SVL_OPERATOR_TOKEN"
                aria-label="Token operatora dla zadań agentów"
                className="min-w-0 w-48 max-w-full rounded-md border border-slate-700 bg-[#0B0D13] px-2 py-1 text-xs text-slate-100"
              />
            </label>
            {dispatchStatus && (
              <div className="p-2.5 rounded bg-[#0B0D13] border border-slate-800 text-xs font-mono text-violet-300">
                {dispatchStatus}
              </div>
            )}

            <button
              type="submit"
              className="min-h-[40px] px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold flex items-center gap-2 transition-colors whitespace-nowrap"
            >
              <Send className="w-3.5 h-3.5" />
              Wyślij zadanie do {formatAgentDisplayName(selectedAgent)}
            </button>
          </form>

          <div className="pt-3 border-t border-slate-800 space-y-2">
            <div className="text-xs font-semibold text-slate-300">
              Dziennik zdarzeń workera: {formatAgentDisplayName(selectedAgent)} ({(agentLogs[selectedAgent] || []).length} wpisów)
            </div>
            <div className="max-h-44 overflow-y-auto space-y-1.5 bg-[#0B0D13] p-3 rounded-lg border border-slate-800 font-mono text-[11px]">
              {(agentLogs[selectedAgent] || []).length === 0 ? (
                <div className="text-slate-500">
                  Brak wpisów w dzienniku.
                </div>
              ) : (
                (agentLogs[selectedAgent] || []).slice().reverse().map((lg: any) => (
                  <div key={lg.id} className="text-slate-300">
                    <span className="text-slate-500 tabular-nums">
                      [{new Date(lg.timestamp).toLocaleTimeString('pl-PL')}]
                    </span>{' '}
                    <span className="text-violet-400">[{lg.level}]</span> {lg.message}
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="pt-3 border-t border-slate-800 space-y-2">
            <div className="text-xs font-semibold text-slate-300">
              Zadania trwałe: {selectedAgentTasks.length}
            </div>
            <p className="text-[11px] text-amber-300/80">
              „Odpowiedź gotowa” oznacza, że model zwrócił tekst; nie potwierdza wykonania misji ani działań poza aplikacją.
            </p>
            <div className="max-h-56 overflow-y-auto space-y-2">
              {selectedAgentTasks.length === 0 ? (
                <div className="text-xs text-slate-500">Brak zapisanych zadań dla tego agenta.</div>
              ) : (
                selectedAgentTasks.slice().reverse().slice(0, 12).map((task: any) => (
                  <div key={task.id} className="p-2.5 rounded-lg bg-[#0B0D13] border border-slate-800 text-xs space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-200 truncate">{task.title}</span>
                      <span className={`shrink-0 font-mono ${
                        task.status === 'ANSWER_READY' || task.status === 'COMPLETED' ? 'text-emerald-400' :
                          task.status === 'FAILED' ? 'text-rose-400' :
                            task.status === 'RUNNING' ? 'text-violet-300' : 'text-amber-300'
                      }`}>{task.status === 'ANSWER_READY' || task.status === 'COMPLETED' ? 'ODPOWIEDŹ GOTOWA' : task.status}</span>
                    </div>
                    {task.status === 'RUNNING' && task.current_tool && (
                      <p className="text-[11px] font-mono text-cyan-300">
                        Aktywne narzędzie MCP: {task.current_tool}
                      </p>
                    )}
                    {task.result && <p className="text-slate-300 whitespace-pre-wrap break-words">{task.result}</p>}
                    {task.error && <p className="text-rose-300 whitespace-pre-wrap break-words">{task.error}</p>}
                    <div className="text-[10px] font-mono text-slate-500">
                      {task.completed_at || task.started_at || task.created_at || ''}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Right: Persistent SQLite Agent Memory Inspector */}
        <div className="p-3.5 sm:p-5 rounded-xl bg-[#111520] border border-slate-800 space-y-4 min-w-0">
          <h2 className="text-sm font-semibold text-slate-100">
            03. Izolowana Pamięć Agenta w SQLite (Zakres: agent:{selectedAgent})
          </h2>

          <form onSubmit={(e) => void handleAddMemory(e)} className="space-y-3">
            <div className="flex flex-col sm:flex-row gap-2">
              <select
                aria-label="Typ rekordu pamięci"
                value={memoryKind}
                onChange={(e) => setMemoryKind(e.target.value as any)}
                className="bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200"
              >
                <option value="fact">Fakt (fact)</option>
                <option value="decision">Decyzja (decision)</option>
                <option value="task">Zadanie (task)</option>
                <option value="episode">Epizod (episode)</option>
              </select>
              <input
                type="text"
                value={memoryContent}
                onChange={(e) => setMemoryContent(e.target.value)}
                placeholder={`Dodaj trwały wpis do pamięci agenta ${selectedAgent}...`}
                aria-label="Treść nowego wpisu pamięci"
                className="flex-1 min-w-0 bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100"
              />
              <button
                type="submit"
                className="min-h-[38px] px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs font-medium whitespace-nowrap shrink-0"
              >
                Zapisz w SQLite
              </button>
            </div>
            {memoryStatus && (
              <div className={`text-xs font-mono ${memoryStatus.startsWith('Błąd') ? 'text-rose-400' : 'text-emerald-400'}`}>
                {memoryStatus}
              </div>
            )}
          </form>

          <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
            {(agentMemories[selectedAgent] || []).length === 0 ? (
              <div className="p-4 rounded-lg bg-[#0B0D13] border border-slate-800 text-xs text-slate-500">
                Pamięć agentów w SQLite jest pusta.
              </div>
            ) : (
              (agentMemories[selectedAgent] || []).map((mem: any) => (
                <div
                  key={mem.id}
                  className="p-3 rounded-lg bg-[#0B0D13] border border-slate-800/90 text-xs space-y-1"
                >
                  <div className="flex items-center justify-between gap-2 text-[11px] font-mono text-slate-400 tabular-nums">
                    <span className="truncate">
                      {mem.scope} · {mem.kind} · źródło: {mem.source}
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                      <span>{new Date(mem.created_at).toLocaleTimeString('pl-PL')}</span>
                      <button
                        type="button"
                        onClick={() => void handleDeleteMemory(mem.id)}
                        disabled={deletingMemoryId === mem.id}
                        aria-label={`Usuń wpis pamięci ${mem.id}`}
                        className="inline-flex items-center gap-1 rounded border border-rose-500/35 bg-rose-950/30 px-1.5 py-0.5 text-[10px] text-rose-300 hover:bg-rose-900/40 disabled:opacity-50"
                      >
                        <Trash2 className="w-3 h-3" />
                        <span>{deletingMemoryId === mem.id ? 'Usuwanie...' : 'Usuń'}</span>
                      </button>
                    </div>
                  </div>
                  <div className="text-slate-200 leading-relaxed">{mem.content}</div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* 04. Full Per-Agent Model, RBAC & Prompt Configuration */}
      <div className="p-3.5 sm:p-5 rounded-xl bg-[#111520] border border-slate-800 space-y-4 min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <h2 className="text-sm font-semibold text-slate-100">
              04. Pełna Konfiguracja Agenta: {formatAgentDisplayName(selectedAgent)} (id: {activeAgentObj.id || selectedAgent})
            </h2>
            {isConfigDirty && (
              <span className="text-[11px] font-mono text-amber-400">
                Niezapisane zmiany lokalne
              </span>
            )}
          </div>
          <span className="text-xs font-mono text-slate-400">
            rev: {currentConfigRevision ?? 1} · Rola: <strong className="text-emerald-300">{String(activeAgentCfg.rbac_role || 'root').toUpperCase()}</strong> · Zakresy: {(activeAgentCfg.allowed_scopes || []).length}/{FULL_ROOT_SCOPES.length}
          </span>
        </div>

        {/* ROOT Authority Matrix: Operator + Jyn */}
        <div className="p-3.5 rounded-lg bg-[#0B0D13] border border-emerald-500/30 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs">
              <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
              <span className="font-semibold text-emerald-200">
                Uprawnienia ROOT · Operator (Mateusz Mitek) + {effectiveAgents.map((a) => a.canonicalName).join(' + ')}
              </span>
            </div>
            <button
              type="button"
              onClick={() => void handleGrantFullRootAllAgents()}
              disabled={isGrantingAllRoot}
              className="px-3 py-1.5 rounded-lg bg-emerald-600/25 hover:bg-emerald-600/35 border border-emerald-500/50 text-emerald-200 text-xs font-semibold transition-colors disabled:opacity-50 cursor-pointer whitespace-nowrap"
            >
              {isGrantingAllRoot
                ? 'Nadawanie ROOT...'
                : `Przyznaj pełne uprawnienia ROOT (${effectiveAgents.map((a) => a.canonicalName).join(', ')})`}
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5 text-[11px] font-mono">
            {(activeAgentCfg.allowed_scopes && activeAgentCfg.allowed_scopes.length > 0
              ? activeAgentCfg.allowed_scopes
              : FULL_ROOT_SCOPES
            ).map((scope: string) => (
              <span
                key={scope}
                className="px-2 py-0.5 rounded bg-emerald-950/35 border border-emerald-500/30 text-emerald-300"
              >
                {scope}
              </span>
            ))}
          </div>
          {rootGrantStatus && (
            <div
              className={`text-xs font-mono ${rootGrantStatus.ok ? 'text-emerald-400' : 'text-rose-400'}`}
            >
              {rootGrantStatus.msg}
            </div>
          )}
        </div>

        {remoteConfigChangedWhileDirty && (
          <div className="p-3 rounded-lg bg-amber-950/30 border border-amber-500/40 text-xs text-amber-200 flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
              Konfiguracja tego agenta w bazie SQLite uległa zmianie w tle (rewizja {currentConfigRevision}). Twoje lokalne pola edycji zostały bezpiecznie zachowane.
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={hydrateConfigFormFromServer}
                className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium"
              >
                Pobierz wersję z serwera
              </button>
              <button
                type="button"
                onClick={(e) => void handleSaveAgentConfig(e, true)}
                className="px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white font-semibold"
              >
                Nadpisz moimi zmianami
              </button>
            </div>
          </div>
        )}

        <form onSubmit={(e) => void handleSaveAgentConfig(e, false)} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
            <div>
              <label htmlFor="cfg-preferred-model" className="block text-xs text-slate-400 mb-1">
                Preferowany tryb routingu:
              </label>
              <select
                id="cfg-preferred-model"
                value={cfgPreferredModel}
                onChange={(e) => {
                  markDirty();
                  setCfgPreferredModel(e.target.value);
                }}
                className="w-full bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200"
              >
                <option value="svl-hybrid-router">SVL Router (Ollama -&gt; Gemini)</option>
                {ollamaModels.map((m: any) => (
                  <option key={m.name} value={`ollama:${m.name}`}>
                    Tylko Ollama: {m.name} ({m.parameter_size || 'LLM'})
                  </option>
                ))}
                {svl364ConfiguredModel && !hasConfiguredModelPulled && (
                  <option value={`ollama:${svl364ConfiguredModel}`}>
                    Tylko Ollama: {svl364ConfiguredModel} (
                    {pullState?.active &&
                    String(pullState?.model || '').split(':')[0] === svl364ConfiguredModel.split(':')[0]
                      ? `Pobieranie ${pullState?.percent ?? 0}%`
                      : 'Do pobrania'}
                    )
                  </option>
                )}
                {!ollamaModels.some((m: any) => m.name === 'llama3.2-vision:11b') && (
                  <option value="ollama:llama3.2-vision:11b">Tylko Ollama: llama3.2-vision:11b</option>
                )}
                <option value="gemini-3.1-flash-lite">Gemini 3.1 Flash-Lite</option>
                <option value="gemini-3-flash-preview">Gemini 3 Flash (Preview)</option>
              </select>
            </div>

            <div>
              <label htmlFor="cfg-ollama-model" className="block text-xs text-slate-400 mb-1">
                Model lokalny Ollama:
              </label>
              <input
                id="cfg-ollama-model"
                type="text"
                list="ollama-pulled-models"
                value={cfgOllamaModel}
                onChange={(e) => {
                  markDirty();
                  setCfgOllamaModel(e.target.value);
                }}
                className="w-full bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-100"
              />
              <datalist id="ollama-pulled-models">
                <option value="dolphin-llama3:8b-v2.9-q2_K" />
                <option value="llama3.2-vision:11b" />
                {svl364ConfiguredModel && !hasConfiguredModelPulled && (
                  <option value={svl364ConfiguredModel} />
                )}
                {ollamaModels.map((m: any) => (
                  <option key={m.name} value={m.name} />
                ))}
              </datalist>
            </div>

            <div>
              <label htmlFor="cfg-temperature" className="block text-xs text-slate-400 mb-1">
                Temperatura odpowiedzi (0.0 – 1.5):
              </label>
              <input
                id="cfg-temperature"
                type="number"
                step="0.05"
                min="0"
                max="1.5"
                value={cfgTemperature}
                onChange={(e) => {
                  markDirty();
                  setCfgTemperature(e.target.value);
                }}
                className="w-full bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-100"
              />
            </div>

            <div>
              <label htmlFor="cfg-rbac-role" className="block text-xs text-slate-400 mb-1">
                Rola uprawnień RBAC:
              </label>
              <input
                id="cfg-rbac-role"
                type="text"
                value={cfgRbacRole}
                onChange={(e) => {
                  markDirty();
                  setCfgRbacRole(e.target.value);
                }}
                className="w-full bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-100"
              />
            </div>
          </div>

          <div>
            <label htmlFor="cfg-system-prompt" className="block text-xs text-slate-400 mb-1">
              Instrukcja systemowa (System Prompt) agenta {selectedAgent}:
            </label>
            <textarea
              id="cfg-system-prompt"
              rows={3}
              value={cfgSystemPrompt}
              onChange={(e) => {
                markDirty();
                setCfgSystemPrompt(e.target.value);
              }}
              className="w-full bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 leading-relaxed"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={cfgVisionEnabled}
                onChange={(e) => {
                  markDirty();
                  setCfgVisionEnabled(e.target.checked);
                }}
                className="rounded border-slate-700 bg-[#0B0D13] text-violet-500"
              />
              Obsługa analizy obrazów (Vision) włączona
            </label>

            <button
              type="submit"
              disabled={isSavingConfig}
              className="min-h-[40px] px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-xs font-semibold transition-colors whitespace-nowrap"
            >
              {isSavingConfig ? 'Zapisywanie...' : `Zapisz konfigurację dla ${selectedAgent}`}
            </button>
          </div>

          {configStatus && (
            <div className={`p-2.5 rounded bg-[#0B0D13] border border-slate-800 text-xs font-mono ${configStatus.ok ? 'text-emerald-400' : 'text-rose-400'}`}>
              {configStatus.msg}
            </div>
          )}
        </form>
      </div>
    </div>
  );
};
