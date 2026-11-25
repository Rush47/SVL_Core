import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AvatarProfileKey,
  SvlAvatarMap,
  SyncableConversation,
  SyncableMessage,
  SystemModule,
  SvlSyncEvent,
  TargetAgentSelection,
  TerminalLogLine,
  TerminalTabId,
  WorkspaceUiState,
  WsConnectionState,
  createUniqueId,
  isForbiddenAgentSender,
  mergeConversationThreads,
  safeFetchJson,
  getSvlOperatorAccessToken,
  hasSvlOperatorAccessToken,
} from './svlLogic';
import { setGuiLoggerContext, trackGuiEvent } from './guiLogger';
import { dispatchLiveRepoFrame } from './liveRepoEvents';
import {
  countTotalConversationMessages,
  evaluateChatSnapshotAcceptance,
  shouldPreserveLocalConversationsOnEmptyServer,
  shouldSkipResyncEcho,
} from './syncGuards';

const BROADCAST_CHANNEL_NAME = 'svl_python_os_sync';
const STORAGE_SIGNAL_KEY = 'svl_sync_signal_v1';
const CONVERSATIONS_CACHE_KEY = 'svl_python_os_conversations_v1';
const DURABLE_RECOVERY_BACKUP_KEY = 'svl_durable_chat_backup_v2';

const DEFAULT_TERMINAL_LOGS: Record<TerminalTabId, TerminalLogLine[]> = {
  linux: [],
  ssh: [],
  python: [],
  github: [],
  hyperspace: [],
  agents: [],
};

export const INITIAL_WELCOME_CONVERSATIONS: SyncableConversation[] = [
  { id: 'conv-jyn', title: 'Jyn — Zarządzanie Infrastrukturą (ROOT)', updatedAt: '', revision: 1, messages: [] },
  { id: 'conv-svl364-mcp-root', title: 'SVL-364 — Komputer Pokładowy (MCP · ROOT)', updatedAt: '', revision: 1, messages: [] },
  { id: 'conv-rodzina-mitek-wszyscy', title: 'Rodzina Mitek (wszyscy)', updatedAt: '', revision: 1, messages: [] },
];

export interface RefreshExecutionReport {
  ok: boolean;
  serverRevision: number;
  timestamp: string;
  durationMs: number;
  error?: string;
}

export interface ViteHmrDiagnostic {
  hmrState: 'active' | 'disabled' | 'proxy_unavailable';
  hmrMessage?: string;
  detectedAt?: string;
}

export interface DomainRefreshReport {
  ok: boolean;
  error?: string;
}

function formatUpdatedAt(raw?: string): string {
  if (!raw) return '';
  if (raw.includes('T')) {
    const dt = new Date(raw);
    if (!Number.isNaN(dt.getTime())) {
      return dt.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
    }
  }
  return raw;
}

function stripObsoleteDiagnosticMessages(msgs: any[]): SyncableMessage[] {
  if (!Array.isArray(msgs)) return [];
  return msgs.filter(Boolean);
}

const REMOVED_AGENT_CONVERSATION_IDS = new Set([
  'conv-agent-agata',
  'conv-agent-aria',
  'conv-agent-alex',
  'conv-agent-astyria',
  'conv-agent-aurelius',
  'conv-agent-bielik',
  'conv-agent-maya',
  'conv-svl364-komputer-pokladowy',
]);

export function getCanonicalConversationTitle(id: string, fallbackTitle?: string): string {
  if (id === 'conv-jyn') return 'Jyn — Zarządzanie Infrastrukturą (ROOT)';
  if (id === 'conv-svl364-mcp-root') return 'SVL-364 — Komputer Pokładowy (MCP · ROOT)';
  if (id === 'conv-si-sphere') return 'SI_Sphere — Rdzeń Floty SVL-465 (ROOT)';
  if (id === 'conv-rodzina-mitek-wszyscy') return 'Rodzina Mitek (wszyscy)';
  return fallbackTitle || 'Sesja SVL Python OS';
}

function normalizeConversationsFromServer(rawList: any[]): SyncableConversation[] {
  return (rawList || [])
    .filter((c: any) => !REMOVED_AGENT_CONVERSATION_IDS.has(String(c?.id || '')))
    .map((c: any) => {
      const cleaned = stripObsoleteDiagnosticMessages(c.messages).filter(
        (m: any) => !isForbiddenAgentSender(m?.sender) && !isForbiddenAgentSender(m?.agentId),
      );
      return {
        id: String(c.id),
        title: getCanonicalConversationTitle(String(c.id), c.title),
        updatedAt: formatUpdatedAt(c.updatedAt),
        revision: typeof c.revision === 'number' ? c.revision : Number(c.revision || 1),
        messages: cleaned,
      };
    });
}

interface SvlSyncContextValue {
  tabOrigin: string;
  wsState: WsConnectionState;
  wsAttempt: number;
  wsLastError: string | null;
  viteHmrDiagnostic: ViteHmrDiagnostic;
  serverRevision: number;
  schemaVersion: string;
  lastSyncedAt: string | null;
  isSyncing: boolean;
  lastRefreshReport: RefreshExecutionReport | null;

  healthData: any;
  kernelData: any;
  agentsData: any;
  systemModules: SystemModule[];
  avatars: SvlAvatarMap;
  conversations: SyncableConversation[];
  terminalLogsByTab: Record<TerminalTabId, TerminalLogLine[]>;
  workspaceState: WorkspaceUiState;

  activeConvId: string;
  targetAgent: TargetAgentSelection;
  selectedAgentPanel: string;

  refreshAllDomains: (reason?: string) => Promise<RefreshExecutionReport>;
  refreshDomainModules: (modules: Array<'health' | 'kernel' | 'agents' | 'chat' | 'terminals' | 'workspace' | 'modules' | 'avatars'>) => Promise<DomainRefreshReport>;
  reconnectWebSocket: () => void;

  setActiveConvId: (convId: string) => void;
  setTargetAgent: (agent: TargetAgentSelection) => void;
  setSelectedAgentPanel: (agent: string) => void;
  openFamilyChannel: () => void;
  openSvl364RootChannel: () => void;
  openAgentChannel: (agent: string) => void;

  createConversation: () => SyncableConversation;
  deleteConversation: (convId: string) => Promise<{ ok: boolean; error?: string }>;
  clearAllConversationsAndBuffers: (accessToken?: string) => Promise<{ ok: boolean; error?: string }>;
  appendAndPersistChatMessage: (
    convId: string,
    convTitle: string,
    model: string,
    msg: SyncableMessage,
    opts?: { alreadyPersisted?: boolean; serverRevision?: number },
  ) => Promise<{ ok: boolean; error?: string }>;
  upsertSystemModule: (mod: { id: string; name: string; kind?: string; status?: string; description?: string; config?: Record<string, any> }) => Promise<{ ok: boolean; module?: SystemModule; error?: string }>;
  deleteSystemModule: (modId: string) => Promise<{ ok: boolean; error?: string }>;
  saveAgentAvatar: (agent: AvatarProfileKey, image: string) => Promise<{ ok: boolean; avatars?: SvlAvatarMap; error?: string }>;
  resetAgentAvatar: (agent: AvatarProfileKey) => Promise<{ ok: boolean; avatars?: SvlAvatarMap; error?: string }>;
  clearTerminalTab: (tab: TerminalTabId) => Promise<{ ok: boolean; error?: string }>;
  refreshTerminals: () => Promise<void>;
  notifyLocalMutation: (entity: string, entityId: string, serverRevision?: number, event?: SvlSyncEvent | null) => void;
}

const SvlSyncContext = createContext<SvlSyncContextValue | null>(null);

export const SvlSyncProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const tabOriginRef = useRef<string>(createUniqueId('tab'));
  const tabOrigin = tabOriginRef.current;

  const [wsState, setWsState] = useState<WsConnectionState>('connecting');
  const [wsAttempt, setWsAttempt] = useState(0);
  const [wsLastError, setWsLastError] = useState<string | null>(null);

  useEffect(() => {
    setGuiLoggerContext({ origin: tabOrigin });
  }, [tabOrigin]);

  useEffect(() => {
    trackGuiEvent({
      kind: 'gui_ws_state',
      // Brak tokenu przed zalogowaniem to stan oczekiwany, nie ostrzeżenie.
      level:
        wsLastError && wsState !== 'online' && !/SVL_OPERATOR_TOKEN/.test(wsLastError) ? 'WARN' : 'INFO',
      action: `Stan WebSocket /ws/svl: ${wsState}`,
      detail: wsLastError ? { lastError: wsLastError } : undefined,
    });
  }, [wsState, wsLastError]);
  const [viteHmrDiagnostic, setViteHmrDiagnostic] = useState<ViteHmrDiagnostic>(() => {
    if (typeof window !== 'undefined' && window.__SVL_DEV_DIAGNOSTICS__) {
      return window.__SVL_DEV_DIAGNOSTICS__;
    }
    return { hmrState: import.meta.env.DEV ? 'active' : 'disabled' };
  });

  const [serverRevision, setServerRevision] = useState(0);
  const serverRevisionRef = useRef(0);
  const [schemaVersion, setSchemaVersion] = useState('2026.11.sync.v1');
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastRefreshReport, setLastRefreshReport] = useState<RefreshExecutionReport | null>(null);

  const [healthData, setHealthData] = useState<any>(null);
  const [kernelData, setKernelData] = useState<any>(null);
  const [agentsData, setAgentsData] = useState<any>(null);
  const [systemModules, setSystemModules] = useState<SystemModule[]>([]);
  const [avatars, setAvatars] = useState<SvlAvatarMap>({});
  const [conversations, setConversations] = useState<SyncableConversation[]>(() => {
    let list = INITIAL_WELCOME_CONVERSATIONS;
    try {
      const raw = localStorage.getItem(DURABLE_RECOVERY_BACKUP_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.version === 2 && !parsed.clearedAt && Array.isArray(parsed.conversations) && parsed.conversations.length > 0) {
          list = parsed.conversations
            .filter((c: any) => c && !REMOVED_AGENT_CONVERSATION_IDS.has(String(c.id || '')))
            .map((c: any) => ({
              ...c,
              messages: Array.isArray(c.messages)
                ? c.messages.filter((m: any) => !isForbiddenAgentSender(m?.sender) && !isForbiddenAgentSender(m?.agentId))
                : [],
            }));
        }
      }
    } catch {
      // ignore storage unavailable
    }
    if (!list.some((c) => c.id === 'conv-jyn')) {
      list = [
        { id: 'conv-jyn', title: 'Jyn — Zarządzanie Infrastrukturą (ROOT)', updatedAt: '', revision: 1, messages: [] },
        ...list,
      ];
    }
    if (!list.some((c) => c.id === 'conv-svl364-mcp-root')) {
      list = [
        ...list,
        { id: 'conv-svl364-mcp-root', title: 'SVL-364 — Komputer Pokładowy (MCP · ROOT)', updatedAt: '', revision: 1, messages: [] },
      ];
    }
    if (!list.some((c) => c.id === 'conv-rodzina-mitek-wszyscy')) {
      list = [
        ...list,
        { id: 'conv-rodzina-mitek-wszyscy', title: 'Rodzina Mitek (wszyscy)', updatedAt: '', revision: 1, messages: [] },
      ];
    }
    return list;
  });
  const explicitlyClearedRef = useRef(false);
  useEffect(() => {
    try { localStorage.removeItem(CONVERSATIONS_CACHE_KEY); } catch { /* unavailable */ }
  }, []);
  useEffect(() => {
    if (explicitlyClearedRef.current) return;
    if (countTotalConversationMessages(conversations) === 0) return;
    try {
      localStorage.setItem(
        DURABLE_RECOVERY_BACKUP_KEY,
        JSON.stringify({
          version: 2,
          savedAt: new Date().toISOString(),
          clearedAt: null,
          conversations,
        }),
      );
    } catch {
      // ignore storage quota errors
    }
  }, [conversations]);

  const conversationsRef = useRef<SyncableConversation[]>(conversations);
  conversationsRef.current = conversations;

  const [terminalLogsByTab, setTerminalLogsByTab] = useState<Record<TerminalTabId, TerminalLogLine[]>>(DEFAULT_TERMINAL_LOGS);
  const [workspaceState, setWorkspaceState] = useState<WorkspaceUiState>({
    active_conversation_id: null,
    selected_target_agent: 'Jyn',
    selected_agent_panel_id: 'Jyn',
    revisions: {},
  });

  const [activeConvIdState, setActiveConvIdState] = useState<string>(
    () => conversations[0]?.id || 'conv-jyn',
  );
  const activeConvIdRef = useRef<string>(activeConvIdState);
  activeConvIdRef.current = activeConvIdState;
  const [targetAgentState, setTargetAgentState] = useState<TargetAgentSelection>('Jyn');
  const [selectedAgentPanelState, setSelectedAgentPanelState] = useState<string>('Jyn');

  const pendingMsgIdsRef = useRef<Set<string>>(new Set());
  // Recently saved message IDs kept for 30s so slightly lagged snapshots cannot erase them.
  const recentlyPersistedMsgExpiryRef = useRef<Map<string, number>>(new Map());
  // Keep a newly-created EMPTY thread visible while SQLite create is in-flight.
  const pendingConvIdsRef = useRef<Set<string>>(new Set());
  const deletedConvIdsRef = useRef<Set<string>>(new Set());
  const appliedChatServerRevRef = useRef(0);
  const chatMutationEpochRef = useRef(0);
  const chatRefreshRetriesRef = useRef(0);
  const refreshDomainModulesRef = useRef<
    ((
      modules: Array<'health' | 'kernel' | 'agents' | 'chat' | 'terminals' | 'workspace' | 'modules' | 'avatars'>,
      options?: { forceApply?: boolean },
    ) => Promise<DomainRefreshReport>) | null
  >(null);
  const seenEventIdsRef = useRef<Set<string>>(new Set());
  const seenEventOrderRef = useRef<string[]>([]);
  const seenSignalIdsRef = useRef<Set<string>>(new Set());
  const seenSignalOrderRef = useRef<string[]>([]);
  const inflightRefreshRef = useRef<Promise<RefreshExecutionReport> | null>(null);
  // A refresh requested while another is running gets exactly one follow-up run,
  // because the running one may have read server state from before the change.
  const followUpRefreshRef = useRef<Promise<RefreshExecutionReport> | null>(null);
  const refreshAllDomainsRef = useRef<((reason?: string) => Promise<RefreshExecutionReport>) | null>(null);
  // Parallel refreshes can resolve out of order; only the newest response may write a state slot.
  const refreshSeqRef = useRef(0);
  const appliedSeqRef = useRef<Record<string, number>>({});
  const inflightCatchupRef = useRef<Promise<void> | null>(null);
  const broadcastChannelRef = useRef<BroadcastChannel | null>(null);
  const wsReconnectNowRef = useRef<(() => void) | null>(null);

  const getProtectedMsgIds = useCallback((): Set<string> => {
    const now = Date.now();
    const ids = new Set<string>(pendingMsgIdsRef.current);
    for (const [id, expiresAt] of recentlyPersistedMsgExpiryRef.current.entries()) {
      if (expiresAt > now) {
        ids.add(id);
      } else {
        recentlyPersistedMsgExpiryRef.current.delete(id);
      }
    }
    return ids;
  }, []);

  // Server SQLite is authoritative. Do not persist old messages in localStorage.

  // Listen to Vite HMR diagnostics emitted in main.tsx
  useEffect(() => {
    const onHmrDiag = (evt: Event) => {
      const custom = evt as CustomEvent<ViteHmrDiagnostic>;
      if (custom?.detail) setViteHmrDiagnostic(custom.detail);
    };
    window.addEventListener('svl:hmr-diagnostic', onHmrDiag);
    return () => window.removeEventListener('svl:hmr-diagnostic', onHmrDiag);
  }, []);

  const recordSeenEventId = useCallback((eventId?: string): boolean => {
    if (!eventId) return true;
    if (seenEventIdsRef.current.has(eventId)) return false;
    seenEventIdsRef.current.add(eventId);
    seenEventOrderRef.current.push(eventId);
    if (seenEventOrderRef.current.length > 1200) {
      const oldest = seenEventOrderRef.current.shift();
      if (oldest) seenEventIdsRef.current.delete(oldest);
    }
    return true;
  }, []);

  const recordSeenSignalId = useCallback((signalId?: string): boolean => {
    if (!signalId) return true;
    if (seenSignalIdsRef.current.has(signalId)) return false;
    seenSignalIdsRef.current.add(signalId);
    seenSignalOrderRef.current.push(signalId);
    if (seenSignalOrderRef.current.length > 1200) {
      const oldest = seenSignalOrderRef.current.shift();
      if (oldest) seenSignalIdsRef.current.delete(oldest);
    }
    return true;
  }, []);

  const advanceServerRevision = useCallback((rev?: number) => {
    const num = Number(rev || 0);
    if (num > serverRevisionRef.current) {
      serverRevisionRef.current = num;
      setServerRevision(num);
    }
  }, []);

  const emitCrossTabSignal = useCallback(
    (entity: string, entityId: string, srvRev?: number, eventId?: string) => {
      const sig = {
        type: 'svl_sync_signal',
        origin: tabOrigin,
        signalId: createUniqueId('sig'),
        eventId: eventId || undefined,
        entity,
        entityId,
        serverRevision: Number(srvRev || serverRevisionRef.current || 0),
        at: Date.now(),
      };
      recordSeenSignalId(sig.signalId);
      try {
        broadcastChannelRef.current?.postMessage(sig);
      } catch {
        // ignore closed channel
      }
      try {
        localStorage.setItem(STORAGE_SIGNAL_KEY, JSON.stringify(sig));
      } catch {
        // ignore storage restrictions
      }
    },
    [recordSeenSignalId, tabOrigin],
  );

  const refreshDomainModules = useCallback(
    async (
      modules: Array<'health' | 'kernel' | 'agents' | 'chat' | 'terminals' | 'workspace' | 'modules' | 'avatars'>,
      options?: { forceApply?: boolean },
    ): Promise<DomainRefreshReport> => {
      const hasOperator = hasSvlOperatorAccessToken();
      const forceApply = Boolean(options?.forceApply);
      const unique = Array.from(new Set(modules)).filter((mod) => {
        if (mod === 'avatars') return true;
        return hasOperator;
      });
      if (unique.length === 0) {
        return {
          ok: false,
          error: 'Wymagana autoryzacja SVL_OPERATOR_TOKEN.',
        };
      }
      const requestSeq = ++refreshSeqRef.current;
      const chatReqEpoch = chatMutationEpochRef.current;
      /** True when this response is newer than the last one applied to `slot`. */
      const isFresh = (slot: string) => {
        if ((appliedSeqRef.current[slot] || 0) > requestSeq) return false;
        appliedSeqRef.current[slot] = requestSeq;
        return true;
      };
      const tasks: Promise<void>[] = [];
      const taskDomains: string[] = [];
      let chatRefreshDropped = false;
      let refreshedConversationIds: Set<string> | null = null;
      let refreshedActiveConversation: unknown;
      const addTask = (domain: string, task: Promise<void>) => {
        taskDomains.push(domain);
        tasks.push(task);
      };

      if (unique.includes('avatars')) {
        addTask('avatars',
          safeFetchJson<{
            ok: boolean;
            avatars?: SvlAvatarMap;
            serverRevision?: number;
            error?: string;
          }>('/api/avatars', { timeoutMs: 10000 }).then((r) => {
            if (!r.ok || !r.data?.ok || !r.data.avatars || typeof r.data.avatars !== 'object') {
              throw new Error(r.data?.error || r.error || `HTTP ${r.status}`);
            }
            if (isFresh('avatars')) setAvatars(r.data.avatars);
            advanceServerRevision(r.data.serverRevision);
          }),
        );
      }

      if (unique.includes('health')) {
        addTask('health',
          safeFetchJson('/api/py/health', { timeoutMs: 12000 }).then((r) => {
            if (!r.ok || !r.data || r.data.ok === false) {
              throw new Error(r.data?.error || r.error || `HTTP ${r.status}`);
            }
            if (isFresh('health')) setHealthData(r.data);
            if (typeof r.data.schemaVersion === 'string') setSchemaVersion(r.data.schemaVersion);
            if (Array.isArray(r.data.system_modules) && isFresh('systemModules')) {
              setSystemModules(r.data.system_modules);
            }
            advanceServerRevision(r.data.serverRevision);
          }),
        );
      }
      if (unique.includes('kernel')) {
        addTask('kernel',
          safeFetchJson('/api/py/kernel/report', { timeoutMs: 12000 }).then((r) => {
            if (!r.ok || !r.data || r.data.ok === false) {
              throw new Error(r.data?.error || r.error || `HTTP ${r.status}`);
            }
            if (isFresh('kernel')) setKernelData(r.data);
            if (Array.isArray(r.data.system_modules) && isFresh('systemModules')) {
              setSystemModules(r.data.system_modules);
            }
            advanceServerRevision(r.data.serverRevision);
          }),
        );
      }
      if (unique.includes('modules')) {
        addTask('modules',
          safeFetchJson<{ ok: boolean; modules?: SystemModule[]; serverRevision?: number; error?: string }>('/api/py/modules', {
            timeoutMs: 12000,
          }).then((r) => {
            if (!r.ok || !r.data?.ok || !Array.isArray(r.data.modules)) {
              throw new Error(r.data?.error || r.error || `HTTP ${r.status}`);
            }
            if (isFresh('systemModules')) setSystemModules(r.data.modules);
            advanceServerRevision(r.data.serverRevision);
          }),
        );
      }
      if (unique.includes('agents')) {
        addTask('agents',
          safeFetchJson('/api/py/agents/status', { timeoutMs: 12000 }).then((r) => {
            if (!r.ok || !r.data || r.data.ok === false) {
              throw new Error(r.data?.error || r.error || `HTTP ${r.status}`);
            }
            if (isFresh('agents')) setAgentsData(r.data);
            advanceServerRevision(r.data.serverRevision);
          }),
        );
      }
      if (unique.includes('chat')) {
        addTask('chat',
          safeFetchJson('/api/py/chat/conversations', { timeoutMs: 12000 }).then((r) => {
            if (!r.ok || !r.data?.ok || !Array.isArray(r.data.conversations)) {
              throw new Error(r.data?.error || r.error || `HTTP ${r.status}`);
            }
            const respSrvRev = Number(r.data.serverRevision || 0);
            advanceServerRevision(respSrvRev);
            if (!isFresh('chat')) return;
            const decision = evaluateChatSnapshotAcceptance({
              responseServerRevision: respSrvRev,
              appliedChatServerRevision: appliedChatServerRevRef.current,
              requestEpoch: chatReqEpoch,
              currentEpoch: chatMutationEpochRef.current,
              forceApply,
            });
            if (!decision.accept) {
              chatRefreshDropped = true;
              return;
            }
            chatRefreshRetriesRef.current = 0;
            if (decision.resetAppliedRevision || respSrvRev > appliedChatServerRevRef.current) {
              appliedChatServerRevRef.current = respSrvRev;
            }
            const hydrated = normalizeConversationsFromServer(r.data.conversations);
            if (
              shouldPreserveLocalConversationsOnEmptyServer(
                hydrated,
                conversationsRef.current,
                explicitlyClearedRef.current,
              )
            ) {
              // Nie nadpisuj niepustej historii rozmów, jeśli serwer chwilowo zwrócił pusty stan bez jawnego clear-all.
              return;
            }
            refreshedConversationIds = new Set(hydrated.map((conversation) => conversation.id));
            for (const conversation of hydrated) {
              deletedConvIdsRef.current.delete(conversation.id);
            }
            const protectedMsgIds = getProtectedMsgIds();
            setConversations((prev) =>
              mergeConversationThreads(hydrated, prev, protectedMsgIds, deletedConvIdsRef.current, pendingConvIdsRef.current),
            );
          }),
        );
      }
      if (unique.includes('terminals')) {
        addTask('terminals',
          safeFetchJson('/api/py/terminal/history', { timeoutMs: 12000 }).then((r) => {
            if (!r.ok || !r.data?.ok || !r.data.terminalLogs) {
              throw new Error(r.data?.error || r.error || `HTTP ${r.status}`);
            }
            advanceServerRevision(r.data.serverRevision);
            if (isFresh('terminals')) setTerminalLogsByTab((prev) => ({ ...prev, ...r.data.terminalLogs }));
          }),
        );
      }
      if (unique.includes('workspace')) {
        addTask('workspace',
          safeFetchJson('/api/py/workspace/state', { timeoutMs: 12000 }).then((r) => {
            if (!r.ok || !r.data?.ok || !r.data.workspaceState) {
              throw new Error(r.data?.error || r.error || `HTTP ${r.status}`);
            }
            advanceServerRevision(r.data.serverRevision);
            if (!isFresh('workspace')) return;
            const ws = r.data.workspaceState as any;
            setWorkspaceState(ws);
            const rawConv = ws.active_conversation_id?.value ?? ws.active_conversation_id;
            refreshedActiveConversation = rawConv;
            const rawTarget = ws.selected_target_agent?.value ?? ws.selected_target_agent;
            if (
              rawTarget === 'Auto' ||
              rawTarget === 'Rodzina Mitek' ||
              rawTarget === 'Jyn' ||
              rawTarget === 'SI_Sphere' ||
              rawTarget === 'JEDI_Omni_OS'
            ) {
              setTargetAgentState(rawTarget);
            }
            const rawPanel = ws.selected_agent_panel_id?.value ?? ws.selected_agent_panel_id;
            if (rawPanel === 'Jyn' || rawPanel === 'SI_Sphere') {
              setSelectedAgentPanelState(rawPanel);
            }
          }),
        );
      }

      const results = await Promise.allSettled(tasks);
      if (chatRefreshDropped && chatRefreshRetriesRef.current < 6) {
        chatRefreshRetriesRef.current += 1;
        setTimeout(() => void refreshDomainModulesRef.current?.(['chat']), 300 * chatRefreshRetriesRef.current);
      }
      const failures = results.flatMap((result, index) => {
        if (result.status !== 'rejected') return [];
        const detail = result.reason instanceof Error ? result.reason.message : String(result.reason);
        return [`${taskDomains[index]}: ${detail}`];
      });
      const anySucceeded = results.some((result) => result.status === 'fulfilled');

      if (refreshedActiveConversation !== undefined && !pendingConvIdsRef.current.has(activeConvIdRef.current)) {
        const knownConversationIds = refreshedConversationIds ??
          new Set(conversationsRef.current.map((conversation) => conversation.id));
        if (
          typeof refreshedActiveConversation === 'string' &&
          refreshedActiveConversation &&
          !REMOVED_AGENT_CONVERSATION_IDS.has(refreshedActiveConversation) &&
          knownConversationIds.has(refreshedActiveConversation)
        ) {
          setActiveConvIdState(refreshedActiveConversation);
        }
      }

      if (anySucceeded) {
        setLastSyncedAt(new Date().toLocaleTimeString('pl-PL', { hour12: false }));
      }
      if (failures.length > 0) {
        return { ok: false, error: failures.join('; ') };
      }
      return { ok: true };
    },
    [advanceServerRevision, getProtectedMsgIds],
  );
  refreshDomainModulesRef.current = refreshDomainModules;

  const refreshAllDomains = useCallback(
    async (reason = 'operator_refresh'): Promise<RefreshExecutionReport> => {
      if (inflightRefreshRef.current) {
        if (!followUpRefreshRef.current) {
          followUpRefreshRef.current = inflightRefreshRef.current
            .catch(() => undefined)
            .then(() => {
              followUpRefreshRef.current = null;
              return refreshAllDomainsRef.current!(reason);
            });
        }
        return followUpRefreshRef.current;
      }

      const task = (async (): Promise<RefreshExecutionReport> => {
        const startedAt = performance.now();
        setIsSyncing(true);
        try {
          const isRemoteTrigger =
            reason.startsWith('ws_') ||
            reason.startsWith('cross_tab_') ||
            reason === 'boot_initial_load' ||
            reason === 'operator_token_authorized' ||
            reason === 'remote_system_mutation';
          if (!isRemoteTrigger && hasSvlOperatorAccessToken()) {
            const gsRes = await safeFetchJson<{ ok: boolean; serverRevision?: number }>('/api/system/global-sync', {
              method: 'POST',
              timeoutMs: 15000,
              body: JSON.stringify({ reason, origin: tabOrigin }),
            }).catch(() => null);
            if (gsRes?.ok && gsRes.data?.serverRevision) {
              advanceServerRevision(gsRes.data.serverRevision);
            }
          }
          const result = await refreshDomainModules(
            [
              'health',
              'kernel',
              'agents',
              'chat',
              'terminals',
              'workspace',
              'modules',
              'avatars',
            ],
            { forceApply: true },
          );
          if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
            window.dispatchEvent(
              new CustomEvent('svl:global-synced', {
                detail: { reason, serverRevision: serverRevisionRef.current, ok: result.ok },
              }),
            );
          }
          if (!isRemoteTrigger) {
            emitCrossTabSignal('system', 'global_sync', serverRevisionRef.current);
          }
          const report: RefreshExecutionReport = {
            ok: result.ok,
            serverRevision: serverRevisionRef.current,
            timestamp: new Date().toISOString(),
            durationMs: Math.round(performance.now() - startedAt),
            ...(result.error ? { error: result.error } : {}),
          };
          setLastRefreshReport(report);
          trackGuiEvent({
            kind: 'gui_sync',
            level: report.ok ? 'INFO' : 'WARN',
            action: `Synchronizacja globalna (${reason}): ok=${String(report.ok)} rev=${report.serverRevision} (${report.durationMs} ms)`,
            detail: report.error ? { error: report.error } : undefined,
          });
          return report;
        } finally {
          setIsSyncing(false);
          inflightRefreshRef.current = null;
        }
      })();

      inflightRefreshRef.current = task;
      return task;
    },
    [emitCrossTabSignal, refreshDomainModules, tabOrigin],
  );
  refreshAllDomainsRef.current = refreshAllDomains;

  // Coalesced domain refresh queue for incoming outbox events
  const queuedDomainsRef = useRef<Set<'health' | 'kernel' | 'agents' | 'chat' | 'terminals' | 'workspace' | 'modules' | 'avatars'>>(new Set());
  const domainFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleDomainRefresh = useCallback(
    (domains: Array<'health' | 'kernel' | 'agents' | 'chat' | 'terminals' | 'workspace' | 'modules' | 'avatars'>) => {
      for (const d of domains) queuedDomainsRef.current.add(d);
      if (domainFlushTimerRef.current) return;
      domainFlushTimerRef.current = setTimeout(() => {
        domainFlushTimerRef.current = null;
        const batch = Array.from(queuedDomainsRef.current);
        queuedDomainsRef.current.clear();
        if (batch.length > 0) {
          void refreshDomainModules(batch).then((report) => {
            if (!report.ok) void refreshAllDomains('domain_refresh_failed');
          });
        }
      }, 25);
    },
    [refreshDomainModules, refreshAllDomains],
  );

  const applySyncEvent = useCallback(
    (evt: SvlSyncEvent) => {
      if (!evt || typeof evt !== 'object' || !evt.eventId) return;
      const isNew = recordSeenEventId(evt.eventId);
      if (!isNew) return;

      const incomingSrvRev = Number(evt.serverRevision || 0);
      if (serverRevisionRef.current > 0 && incomingSrvRev > serverRevisionRef.current + 1) {
        // A missing event requires refreshing current server domains before advancing revision.
        void refreshAllDomains('sequence_gap_catchup');
        return;
      }
      advanceServerRevision(incomingSrvRev);
      setLastSyncedAt(new Date().toLocaleTimeString('pl-PL', { hour12: false }));

      // Apply immediate deterministic deltas where safe
      if (evt.entity === 'terminal') {
        const tab = (evt.payload?.tab || evt.entityId) as TerminalTabId;
        if ((evt.type === 'terminal.cleared' || evt.type === 'terminal.tab_cleared') && tab) {
          setTerminalLogsByTab((prev) => ({ ...prev, [tab]: [] }));
          return;
        }
        if ((evt.type === 'terminal.logged' || evt.type === 'terminal.entry_logged') && evt.payload?.entry && tab) {
          const entry = evt.payload.entry as TerminalLogLine;
          setTerminalLogsByTab((prev) => {
            const existing = prev[tab] || [];
            if (existing.some((line) => line.id === entry.id)) return prev;
            return { ...prev, [tab]: [...existing, entry].slice(-250) };
          });
          return;
        }
        scheduleDomainRefresh(['terminals']);
        return;
      }

      if (evt.entity === 'chat') {
        if (evt.type === 'chat.all_cleared') {
          pendingMsgIdsRef.current.clear();
          recentlyPersistedMsgExpiryRef.current.clear();
          pendingConvIdsRef.current.clear();
          deletedConvIdsRef.current.clear();
          chatMutationEpochRef.current += 1;
          appliedChatServerRevRef.current = Math.max(appliedChatServerRevRef.current, incomingSrvRev);
          setConversations(INITIAL_WELCOME_CONVERSATIONS);
          try { localStorage.removeItem(CONVERSATIONS_CACHE_KEY); } catch { /* unavailable */ }
          scheduleDomainRefresh(['chat']);
          return;
        }
        if (
          (evt.type === 'chat.thread_deleted' || evt.type === 'chat.conversation_deleted') &&
          evt.entityId
        ) {
          chatMutationEpochRef.current += 1;
          deletedConvIdsRef.current.add(evt.entityId);
          setConversations((prev) => prev.filter((c) => c.id !== evt.entityId));
        }
        scheduleDomainRefresh(['chat']);
        return;
      }

      if (evt.entity === 'module') {
        if (evt.type === 'module.deleted' && evt.entityId) {
          setSystemModules((prev) => prev.filter((m) => m.id !== evt.entityId));
        }
        scheduleDomainRefresh(['modules', 'kernel', 'health', 'agents']);
        return;
      }

      if (evt.entity === 'workspace_state') {
        const key = evt.entityId;
        const val = evt.payload?.value;
        setWorkspaceState((prev) => ({
          ...prev,
          [key]: val,
          revisions: { ...(prev.revisions || {}), [key]: evt.revision },
        }));
        if (key === 'active_conversation_id' && typeof val === 'string' && val && !REMOVED_AGENT_CONVERSATION_IDS.has(val)) {
          setActiveConvIdState(val);
        } else if (
          key === 'selected_target_agent' &&
          ['Auto', 'Rodzina Mitek', 'Jyn', 'SI_Sphere', 'JEDI_Omni_OS'].includes(String(val))
        ) {
          setTargetAgentState(val as TargetAgentSelection);
        } else if (
          key === 'selected_agent_panel_id' &&
          (val === 'Jyn' || val === 'SI_Sphere')
        ) {
          setSelectedAgentPanelState(val);
        }
        return;
      }

      if (evt.entity === 'agent_config' || evt.entity === 'agent_memory' || evt.entity === 'agent_runtime' || evt.entity === 'agent_task') {
        scheduleDomainRefresh(['agents']);
        return;
      }

      if (evt.entity === 'autonomy') {
        scheduleDomainRefresh(['agents', 'health', 'modules']);
        return;
      }

      if (evt.entity === 'ollama') {
        scheduleDomainRefresh(['health', 'agents']);
        return;
      }

      if (evt.entity === 'kernel') {
        scheduleDomainRefresh(['kernel', 'health']);
        return;
      }

      if (evt.entity === 'notification') {
        scheduleDomainRefresh(['chat']);
        return;
      }

      if (evt.entity === 'avatar' || evt.entity === 'avatars') {
        scheduleDomainRefresh(['avatars']);
        return;
      }

      if (evt.entity === 'system' && evt.origin !== tabOrigin) {
        void refreshAllDomains('remote_system_mutation');
        return;
      }

      scheduleDomainRefresh(['health', 'kernel', 'agents', 'chat', 'terminals', 'workspace', 'modules', 'avatars']);
    },
    [advanceServerRevision, recordSeenEventId, refreshAllDomains, scheduleDomainRefresh, tabOrigin],
  );

  const catchUpFromEvents = useCallback(
    async (sourceReason = 'signal') => {
      if (inflightCatchupRef.current) return inflightCatchupRef.current;
      const run = (async () => {
        try {
          let res = await safeFetchJson<{
            ok: boolean;
            serverRevision: number;
            events: SvlSyncEvent[];
            gapDetected?: boolean;
            hasMore?: boolean;
          }>(`/api/py/sync/events?sinceRevision=${serverRevisionRef.current}&limit=100`, { timeoutMs: 12000 });
          let hasMore = Boolean(res.data?.hasMore);
          if (res.ok && res.data?.ok) {
            let pages = 0;
            while (true) {
              if (res.data.gapDetected) {
                await refreshAllDomains(`${sourceReason}_gap`);
                return;
              }
              const evts = Array.isArray(res.data.events) ? res.data.events : [];
              const beforeRevision = serverRevisionRef.current;
              for (const ev of evts) applySyncEvent(ev);
              hasMore = Boolean(res.data.hasMore);

              if (!hasMore) {
                advanceServerRevision(res.data.serverRevision);
                return;
              }

              if (serverRevisionRef.current <= beforeRevision || evts.length === 0) {
                await refreshAllDomains(`${sourceReason}_pagination_stalled`);
                return;
              }

              pages += 1;
              if (pages >= 20) break;
              res = await safeFetchJson<{
                ok: boolean;
                serverRevision: number;
                events: SvlSyncEvent[];
                gapDetected?: boolean;
                hasMore?: boolean;
              }>(
                `/api/py/sync/events?sinceRevision=${serverRevisionRef.current}&limit=100`,
                { timeoutMs: 12000 },
              );
              if (!res.ok || !res.data?.ok) return;
            }

            if (hasMore) {
              setTimeout(() => void catchUpFromEvents(`${sourceReason}_pagination`), 0);
            }
          }
        } finally {
          inflightCatchupRef.current = null;
        }
      })();
      inflightCatchupRef.current = run;
      return run;
    },
    [advanceServerRevision, applySyncEvent, refreshAllDomains],
  );

  // Load each server domain independently on boot.
  useEffect(() => {
    void refreshAllDomains('boot_initial_load');
  }, [refreshAllDomains]);

  // Cross-tab BroadcastChannel + localStorage 'storage' event fallback (signal-only)
  useEffect(() => {
    let bcCatchupTimer: ReturnType<typeof setTimeout> | null = null;

    const handleSignal = (raw: any) => {
      if (!raw || typeof raw !== 'object') return;
      if (raw.origin === tabOrigin) return;
      const dedupeKey = raw.signalId || raw.eventId;
      if (dedupeKey && !recordSeenSignalId(String(dedupeKey))) return;
      if (bcCatchupTimer) clearTimeout(bcCatchupTimer);
      bcCatchupTimer = setTimeout(() => {
        if (raw.entity === 'system' && raw.entityId === 'global_sync') {
          void refreshAllDomains('cross_tab_global_sync');
        } else {
          void catchUpFromEvents('cross_tab_signal');
        }
      }, 110);
    };

    let bc: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      bc = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
      broadcastChannelRef.current = bc;
      bc.onmessage = (evt) => handleSignal(evt.data);
    }

    const onStorage = (evt: StorageEvent) => {
      if (evt.key !== STORAGE_SIGNAL_KEY || !evt.newValue) return;
      try {
        handleSignal(JSON.parse(evt.newValue));
      } catch {
        // ignore invalid storage payload
      }
    };
    window.addEventListener('storage', onStorage);

    return () => {
      if (bcCatchupTimer) clearTimeout(bcCatchupTimer);
      window.removeEventListener('storage', onStorage);
      bc?.close();
      broadcastChannelRef.current = null;
    };
  }, [catchUpFromEvents, recordSeenSignalId, refreshAllDomains, tabOrigin]);

  // Hardened Application WebSocket (/ws/svl) with handshake, heartbeat, backoff+jitter & gap recovery
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let unmounted = false;
    let consecutiveFailures = 0;
    let lastServerActivityAt = Date.now();
    const MAX_RAPID_ATTEMPTS = 10;

    const clearTimers = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    const scheduleReconnect = () => {
      if (unmounted) return;
      if (!hasSvlOperatorAccessToken()) {
        setWsState('offline');
        setWsLastError('Do synchronizacji WebSocket wymagany jest SVL_OPERATOR_TOKEN.');
        return;
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setWsState('offline');
        setWsLastError('Brak połączenia sieciowego przeglądarki (navigator.onLine = false).');
        return;
      }
      consecutiveFailures += 1;
      setWsAttempt(consecutiveFailures);
      if (consecutiveFailures > MAX_RAPID_ATTEMPTS) {
        setWsState('offline');
        setWsLastError('Przekroczono limit prób reconnect /ws/svl. Kliknij „Synchronizuj aplikację” lub wznów połączenie.');
        return;
      }
      setWsState('reconnecting');
      const baseMs = Math.min(30000, 1000 * Math.pow(1.75, consecutiveFailures - 1));
      const jitterMs = Math.round(Math.random() * 600);
      reconnectTimer = setTimeout(connect, baseMs + jitterMs);
    };

    const connect = () => {
      if (unmounted) return;
      clearTimers();
      // Detach first: the old onclose handler must never schedule a second
      // reconnect for a connection being deliberately replaced.
      const previousSocket = ws;
      ws = null;
      if (previousSocket && previousSocket.readyState < WebSocket.CLOSING) {
        try { previousSocket.close(1000, 'Reconnect'); } catch { /* already closed */ }
      }
      const operatorSecret = getSvlOperatorAccessToken();
      if (!hasSvlOperatorAccessToken()) {
        setWsState('offline');
        setWsLastError('Wpisz SVL_OPERATOR_TOKEN, aby włączyć synchronizację WebSocket.');
        return;
      }
      setWsState(consecutiveFailures === 0 ? 'connecting' : 'reconnecting');

      try {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const revParam = serverRevisionRef.current;
        const url = `${proto}//${window.location.host}/ws/svl?origin=${encodeURIComponent(tabOrigin)}&lastRevision=${revParam}`;
        const protocols = ['svl-v1'];
        if (operatorSecret) {
          const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(operatorSecret)))
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
          protocols.push(`svl-auth.${encoded}`);
        }
        ws = new WebSocket(url, protocols);
      } catch (err: any) {
        setWsLastError(err?.message || 'Nie udało się utworzyć WebSocket /ws/svl.');
        scheduleReconnect();
        return;
      }

      const activeSocket = ws;

      activeSocket.onopen = () => {
        lastServerActivityAt = Date.now();
        // Wait for svl.hello handshake before marking 'online'
        heartbeatTimer = setInterval(() => {
          if (activeSocket.readyState !== WebSocket.OPEN) return;
          if (Date.now() - lastServerActivityAt > 52000) {
            setWsLastError('Timeout heartbeat WebSocket /ws/svl (brak pong > 52s).');
            try {
              activeSocket.close(4000, 'Heartbeat timeout');
            } catch {
              // ignore
            }
            return;
          }
          try {
            activeSocket.send(JSON.stringify({ type: 'ping', timestamp: new Date().toISOString() }));
          } catch {
            // ignore
          }
        }, 20000);
      };

      activeSocket.onmessage = (evt) => {
        lastServerActivityAt = Date.now();
        let frame: any;
        try {
          frame = JSON.parse(String(evt.data || '{}'));
        } catch {
          return;
        }
        if (!frame || typeof frame !== 'object') return;
        if (dispatchLiveRepoFrame(frame)) {
          return;
        }

        if (frame.type === 'svl.hello') {
          const wasReconnect = consecutiveFailures > 0;
          consecutiveFailures = 0;
          setWsAttempt(0);
          setWsLastError(null);
          setWsState('online');
          if (frame.schemaVersion) setSchemaVersion(String(frame.schemaVersion));
          const srvRev = Number(frame.serverRevision || 0);
          if (srvRev > serverRevisionRef.current && serverRevisionRef.current === 0) {
            void refreshAllDomains('ws_hello_initial');
          } else if (wasReconnect && srvRev > serverRevisionRef.current) {
            void catchUpFromEvents('ws_reconnect_hello');
          }
          return;
        }

        if (frame.type === 'svl.ping') {
          try {
            activeSocket.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
          } catch {
            // ignore
          }
          advanceServerRevision(frame.serverRevision);
          return;
        }

        if (frame.type === 'pong') {
          advanceServerRevision(frame.serverRevision);
          return;
        }

        if (frame.type === 'svl.catchup') {
          const evts = Array.isArray(frame.events) ? frame.events : [];
          for (const ev of evts) {
            applySyncEvent(ev);
          }
          if (frame.hasMore) {
            void catchUpFromEvents('ws_catchup_pagination');
          } else {
            advanceServerRevision(frame.serverRevision);
          }
          return;
        }

        if (frame.type === 'svl.resync_required') {
          if (shouldSkipResyncEcho(frame.origin, tabOrigin)) {
            return;
          }
          void refreshAllDomains(`ws_${frame.reason || 'resync_required'}`);
          return;
        }

        if (frame.type === 'svl.event' || (frame.eventId && frame.entity)) {
          applySyncEvent(frame as SvlSyncEvent);
          return;
        }

        if (frame.type === 'svl.error') {
          setWsLastError(String(frame.message || frame.code || 'Błąd ramki /ws/svl'));
        }
      };

      activeSocket.onerror = () => {
        setWsLastError('Błąd połączenia WebSocket /ws/svl.');
      };

      activeSocket.onclose = (ev) => {
        // A deliberate reconnect must not spawn an extra reconnect timer from
        // the old socket, otherwise multiple parallel sockets can be created.
        if (ws !== activeSocket) return;
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        if (unmounted) return;
        if (ev.reason) {
          setWsLastError(ev.reason);
        }
        scheduleReconnect();
      };
    };

    wsReconnectNowRef.current = () => {
      consecutiveFailures = 0;
      setWsAttempt(0);
      setWsLastError(null);
      // connect() deliberately closes any existing socket and detaches its
      // old close handler. Avoid a parallel reconnect timer.
      connect();
    };

    const onBrowserOnline = () => {
      consecutiveFailures = 0;
      setWsAttempt(0);
      setWsLastError(null);
      connect();
      void catchUpFromEvents('browser_online');
    };
    const onBrowserOffline = () => {
      setWsState('offline');
      setWsLastError('Przeglądarka jest w trybie offline.');
    };
    window.addEventListener('online', onBrowserOnline);
    window.addEventListener('offline', onBrowserOffline);

    connect();

    return () => {
      unmounted = true;
      wsReconnectNowRef.current = null;
      window.removeEventListener('online', onBrowserOnline);
      window.removeEventListener('offline', onBrowserOffline);
      clearTimers();
      try {
        ws?.close(1000, 'Unmount');
      } catch {
        // ignore
      }
    };
  }, [advanceServerRevision, applySyncEvent, catchUpFromEvents, refreshAllDomains, tabOrigin]);

  // Fallback SSE /api/events + low-frequency heartbeat when WS is offline/reconnecting
  useEffect(() => {
    if (wsState === 'online') return;
    let es: EventSource | null = null;
    if (typeof EventSource !== 'undefined' && hasSvlOperatorAccessToken()) {
      const token = getSvlOperatorAccessToken();
      const url = token ? `/api/events?token=${encodeURIComponent(token)}` : '/api/events';
      try {
        es = new EventSource(url);
        es.onmessage = (evt) => {
          try {
            const frame = JSON.parse(String(evt.data || '{}'));
            if (!frame || typeof frame !== 'object') return;
            if (dispatchLiveRepoFrame(frame)) return;
            if (frame.type === 'svl.resync_required') {
              if (!shouldSkipResyncEcho(frame.origin, tabOrigin)) {
                void refreshAllDomains(`sse_${frame.reason || 'resync_required'}`);
              }
              return;
            }
            if (frame.type === 'svl.event' || (frame.eventId && frame.entity)) {
              applySyncEvent(frame as SvlSyncEvent);
            }
          } catch {
            // ignore malformed SSE frame
          }
        };
      } catch {
        es = null;
      }
    }
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (hasSvlOperatorAccessToken()) {
        void refreshDomainModules(['health', 'agents', 'chat', 'workspace', 'modules', 'kernel']);
      }
    }, 20000);
    const onVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible' && hasSvlOperatorAccessToken()) {
        void refreshDomainModules(['health', 'agents', 'chat', 'workspace']);
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }
    return () => {
      clearInterval(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
      try {
        es?.close();
      } catch {
        // ignore
      }
    };
  }, [applySyncEvent, refreshAllDomains, refreshDomainModules, tabOrigin, wsState]);

  const reconnectWebSocket = useCallback(() => {
    wsReconnectNowRef.current?.();
  }, []);

  const notifyLocalMutation = useCallback(
    (entity: string, entityId: string, srvRev?: number, event?: SvlSyncEvent | null) => {
      const effectiveRev = Number(event?.serverRevision || srvRev || 0);
      if (event) {
        recordSeenEventId(event.eventId);
        advanceServerRevision(event.serverRevision);
      } else if (srvRev) {
        advanceServerRevision(srvRev);
      }
      if (entity === 'chat') {
        chatMutationEpochRef.current += 1;
        if (effectiveRev > appliedChatServerRevRef.current) {
          appliedChatServerRevRef.current = effectiveRev;
        }
      }
      setLastSyncedAt(new Date().toLocaleTimeString('pl-PL', { hour12: false }));
      emitCrossTabSignal(entity, entityId, effectiveRev || undefined, event?.eventId);
    },
    [advanceServerRevision, emitCrossTabSignal, recordSeenEventId],
  );

  const persistWorkspaceKey = useCallback(
    async (key: 'active_conversation_id' | 'selected_target_agent' | 'selected_agent_panel_id', value: string) => {
      if (!hasSvlOperatorAccessToken()) return;
      const eventId = createUniqueId('ws-state');
      const res = await safeFetchJson<{
        ok: boolean;
        serverRevision?: number;
        revision?: number;
        event?: SvlSyncEvent;
        workspaceState?: WorkspaceUiState;
      }>('/api/py/workspace/state', {
        method: 'POST',
        timeoutMs: 10000,
        body: JSON.stringify({
          key,
          value,
          origin: tabOrigin,
          eventId,
        }),
      });
      if (res.ok && res.data?.ok) {
        if (res.data.workspaceState) setWorkspaceState(res.data.workspaceState);
        notifyLocalMutation('workspace_state', key, res.data.serverRevision, res.data.event);
      }
    },
    [notifyLocalMutation, tabOrigin],
  );

  const setActiveConvId = useCallback(
    (convId: string) => {
      if (REMOVED_AGENT_CONVERSATION_IDS.has(convId)) return;
      setActiveConvIdState(convId);
      void persistWorkspaceKey('active_conversation_id', convId);
      if (convId === 'conv-rodzina-mitek-wszyscy') {
        setTargetAgentState('Rodzina Mitek');
        void persistWorkspaceKey('selected_target_agent', 'Rodzina Mitek');
      } else if (convId === 'conv-jyn' || convId === 'conv-svl364-mcp-root') {
        setTargetAgentState('Jyn');
        void persistWorkspaceKey('selected_target_agent', 'Jyn');
      } else if (convId === 'conv-si-sphere') {
        setTargetAgentState('SI_Sphere');
        void persistWorkspaceKey('selected_target_agent', 'SI_Sphere');
      }
    },
    [persistWorkspaceKey],
  );

  const setTargetAgent = useCallback(
    (agent: TargetAgentSelection) => {
      setTargetAgentState(agent);
      void persistWorkspaceKey('selected_target_agent', agent);
    },
    [persistWorkspaceKey],
  );

  const setSelectedAgentPanel = useCallback(
    (agent: string) => {
      setSelectedAgentPanelState(agent);
      void persistWorkspaceKey('selected_agent_panel_id', agent);
    },
    [persistWorkspaceKey],
  );

  const openFamilyChannel = useCallback(() => {
    const familyConvId = 'conv-rodzina-mitek-wszyscy';
    deletedConvIdsRef.current.delete(familyConvId);
    const exists = conversationsRef.current.some((c) => c.id === familyConvId);
    if (!exists) {
      const template =
        INITIAL_WELCOME_CONVERSATIONS.find((c) => c.id === familyConvId) || {
          id: familyConvId,
          title: 'Rodzina Mitek (wszyscy)',
          updatedAt: '',
          revision: 1,
          messages: [],
        };
      setConversations((prev) => [template, ...prev]);
    }
    setActiveConvIdState(familyConvId);
    setTargetAgentState('Rodzina Mitek');
    void persistWorkspaceKey('active_conversation_id', familyConvId);
    void persistWorkspaceKey('selected_target_agent', 'Rodzina Mitek');
  }, [persistWorkspaceKey]);

  const openSvl364RootChannel = useCallback(() => {
    const shipConvId = 'conv-svl364-mcp-root';
    deletedConvIdsRef.current.delete(shipConvId);
    const exists = conversationsRef.current.some((c) => c.id === shipConvId);
    if (!exists) {
      const template =
        INITIAL_WELCOME_CONVERSATIONS.find((c) => c.id === shipConvId) || {
          id: shipConvId,
          title: 'SVL-364 — Komputer Pokładowy (MCP · ROOT)',
          updatedAt: '',
          revision: 1,
          messages: [],
        };
      setConversations((prev) => [template, ...prev]);
    }
    setActiveConvIdState(shipConvId);
    setTargetAgentState('Jyn');
    void persistWorkspaceKey('active_conversation_id', shipConvId);
    void persistWorkspaceKey('selected_target_agent', 'Jyn');
  }, [persistWorkspaceKey]);

  const openAgentChannel = useCallback(
    (agent: string) => {
      const low = agent.trim().toLowerCase();
      if (
        low === 'jyn' ||
        low === 'jyn' ||
        low === 'jyn' ||
        low === 'system_si' ||
        low === 'system-si' ||
        low === 'system si' ||
        low === 'si_1' ||
        low === 'si'
      ) {
        const sysConvId = 'conv-jyn';
        deletedConvIdsRef.current.delete(sysConvId);
        const exists = conversationsRef.current.some((c) => c.id === sysConvId);
        if (!exists) {
          const template = INITIAL_WELCOME_CONVERSATIONS.find((c) => c.id === sysConvId) || {
            id: sysConvId,
            title: 'Jyn — Zarządzanie Infrastrukturą (ROOT)',
            updatedAt: '',
            revision: 1,
            messages: [],
          };
          setConversations((prev) => [template, ...prev]);
        }
        setActiveConvIdState(sysConvId);
        setTargetAgentState('Jyn');
        void persistWorkspaceKey('active_conversation_id', sysConvId);
        void persistWorkspaceKey('selected_target_agent', 'Jyn');
        return;
      }
      if (
        low === 'si_sphere' ||
        low === 'si-sphere' ||
        low === 'si sphere' ||
        low === 'sisphere' ||
        low === 'system_si_2' ||
        low === 'system-si-2' ||
        low === 'si2'
      ) {
        const si2ConvId = 'conv-si-sphere';
        deletedConvIdsRef.current.delete(si2ConvId);
        const exists = conversationsRef.current.some((c) => c.id === si2ConvId);
        if (!exists) {
          setConversations((prev) => [
            {
              id: si2ConvId,
              title: 'SI_Sphere — Rdzeń Floty SVL-465 (ROOT)',
              updatedAt: '',
              revision: 1,
              messages: [],
            },
            ...prev,
          ]);
        }
        setActiveConvIdState(si2ConvId);
        setTargetAgentState('SI_Sphere');
        void persistWorkspaceKey('active_conversation_id', si2ConvId);
        void persistWorkspaceKey('selected_target_agent', 'SI_Sphere');
        return;
      }
      if (low === 'jedi_omni_os' || low === 'jedi' || low === 'vm') {
        const sysConvId = 'conv-jyn';
        deletedConvIdsRef.current.delete(sysConvId);
        setActiveConvIdState(sysConvId);
        setTargetAgentState('JEDI_Omni_OS');
        void persistWorkspaceKey('active_conversation_id', sysConvId);
        void persistWorkspaceKey('selected_target_agent', 'JEDI_Omni_OS');
        return;
      }
      openFamilyChannel();
    },
    [openFamilyChannel, persistWorkspaceKey],
  );

  const appendAndPersistChatMessage = useCallback(
    async (
      convId: string,
      convTitle: string,
      model: string,
      msg: SyncableMessage,
      opts?: { alreadyPersisted?: boolean; serverRevision?: number },
    ) => {
      chatMutationEpochRef.current += 1;
      pendingMsgIdsRef.current.add(msg.id);
      setConversations((prev) =>
        prev.map((c) => {
          if (c.id !== convId) return c;
          if (c.messages.some((existing) => existing.id === msg.id)) return c;
          return {
            ...c,
            title: getCanonicalConversationTitle(convId, convTitle),
            updatedAt: msg.timestamp,
            messages: [...c.messages, msg],
          };
        }),
      );

      // Jeśli serwer (/api/chat) już zapisał odpowiedź w SQLite, nie wysyłamy zbędnego drugiego POST-a.
      if (opts?.alreadyPersisted) {
        chatMutationEpochRef.current += 1;
        recentlyPersistedMsgExpiryRef.current.set(msg.id, Date.now() + 30000);
        const srvRev = Number(opts.serverRevision || 0);
        if (srvRev > appliedChatServerRevRef.current) {
          appliedChatServerRevRef.current = srvRev;
        }
        pendingConvIdsRef.current.delete(convId);
        pendingMsgIdsRef.current.delete(msg.id);
        if (srvRev > 0) {
          notifyLocalMutation('chat', convId, srvRev);
        }
        return { ok: true };
      }

      const eventId = createUniqueId('evt-msg');
      try {
        // The SQLite store deduplicates on msg.id. A retry with the same
        // message and event identifiers cannot create a second chat entry.
        const payload = JSON.stringify({
          conversation_id: convId,
          title: convTitle,
          model,
          message: msg,
          origin: tabOrigin,
          eventId,
        });
        const persistOnce = () => safeFetchJson<{
          ok: boolean;
          revision?: number;
          serverRevision?: number;
          event?: SvlSyncEvent;
          conversations?: any[];
          error?: string;
        }>('/api/py/chat/conversations/message', {
          method: 'POST',
          timeoutMs: 15000,
          maxRetries: 0,
          body: payload,
        });
        let res = await persistOnce();
        for (let retry = 0; retry < 2; retry += 1) {
          const transient = !res.ok &&
            (res.status === 0 || res.status === 502 || res.status === 503 || res.status === 504 || Boolean(res.proxyHtml));
          if (!transient || !pendingMsgIdsRef.current.has(msg.id)) break;
          await new Promise<void>((resolve) => setTimeout(resolve, 450 * (retry + 1)));
          // A server-side clear-all invalidates pending messages. Never replay
          // old writes into an intentionally emptied conversation.
          if (!pendingMsgIdsRef.current.has(msg.id)) break;
          res = await persistOnce();
        }

        if (res.ok && res.data?.ok) {
          chatMutationEpochRef.current += 1;
          recentlyPersistedMsgExpiryRef.current.set(msg.id, Date.now() + 30000);
          const srvRev = Number(res.data.serverRevision || 0);
          if (srvRev > appliedChatServerRevRef.current) {
            appliedChatServerRevRef.current = srvRev;
          }
          if (Array.isArray(res.data.conversations)) {
            const hydrated = normalizeConversationsFromServer(res.data.conversations);
            for (const conversation of hydrated) {
              deletedConvIdsRef.current.delete(conversation.id);
            }
            const protectedMsgIds = getProtectedMsgIds();
            setConversations((prev) =>
              mergeConversationThreads(hydrated, prev, protectedMsgIds, deletedConvIdsRef.current, pendingConvIdsRef.current),
            );
          }
          pendingConvIdsRef.current.delete(convId);
          notifyLocalMutation('chat', convId, res.data.serverRevision, res.data.event);
          return { ok: true };
        }

        // Roll back optimistic message on failed persistence instead of showing ghost messages.
        setConversations((prev) => prev.map((c) =>
          c.id === convId ? { ...c, messages: c.messages.filter((entry) => entry.id !== msg.id) } : c,
        ));
        return { ok: false, error: res.error || res.data?.error || `Błąd zapisu wiadomości HTTP ${res.status}` };
      } catch (error: any) {
        setConversations((prev) => prev.map((c) =>
          c.id === convId ? { ...c, messages: c.messages.filter((entry) => entry.id !== msg.id) } : c,
        ));
        return { ok: false, error: error?.message || String(error) };
      } finally {
        pendingMsgIdsRef.current.delete(msg.id);
      }
    },
    [getProtectedMsgIds, notifyLocalMutation, tabOrigin],
  );

  const createConversation = useCallback((): SyncableConversation => {
    const newId = createUniqueId('conv');
    const nowTime = new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
    // New sessions do not create synthetic greeting messages.
    const newThread: SyncableConversation = {
      id: newId,
      title: `Nowa sesja (${nowTime})`,
      updatedAt: nowTime,
      revision: 1,
      messages: [],
    };
    pendingConvIdsRef.current.add(newId);
    setConversations((prev) => [newThread, ...prev]);
    setActiveConvIdState(newId);
    void safeFetchJson<{ok: boolean; serverRevision?: number; event?: SvlSyncEvent}>(
      '/api/py/chat/conversations/create',
      {
        method: 'POST',
        timeoutMs: 12000,
        body: JSON.stringify({
          conversation_id: newId,
          title: newThread.title,
          model: 'svl-hybrid-router',
          origin: tabOrigin,
          eventId: createUniqueId('evt-create-conv'),
        }),
      },
    ).then((response) => {
      if (response.ok && response.data?.ok) {
        pendingConvIdsRef.current.delete(newId);
        notifyLocalMutation('chat', newId, response.data.serverRevision, response.data.event);
        if (activeConvIdRef.current === newId && hasSvlOperatorAccessToken()) {
          void persistWorkspaceKey('active_conversation_id', newId);
        }
      } else {
        // The operator can still type and the next message can create the thread.
        // Do not silently discard the selected conversation on a stale domain response.
        console.warn('[SVL] Zapis pustej sesji nie powiódł się; zachowuję lokalną sesję do pierwszej wiadomości.');
      }
    });
    return newThread;
  }, [notifyLocalMutation, persistWorkspaceKey, tabOrigin]);

  const deleteConversation = useCallback(
    async (convId: string) => {
      if (conversationsRef.current.length <= 1) {
        return { ok: false, error: 'Nie można usunąć ostatniej aktywnej sesji.' };
      }
      // SQLite is authoritative: do not hide or blacklist a thread before
      // the backend confirms that it has actually been deleted.
      const eventId = createUniqueId('evt-del');
      const res = await safeFetchJson<{
        ok: boolean;
        serverRevision?: number;
        event?: SvlSyncEvent;
        conversations?: any[];
        error?: string;
      }>('/api/py/chat/conversations/delete', {
        method: 'POST',
        timeoutMs: 12000,
        body: JSON.stringify({
          conversation_id: convId,
          origin: tabOrigin,
          eventId,
        }),
      });

      if (res.ok && res.data?.ok) {
        chatMutationEpochRef.current += 1;
        const srvRev = Number(res.data.serverRevision || 0);
        if (srvRev > appliedChatServerRevRef.current) {
          appliedChatServerRevRef.current = srvRev;
        }
        pendingConvIdsRef.current.delete(convId);
        deletedConvIdsRef.current.add(convId);
        const remaining = conversationsRef.current.filter((c) => c.id !== convId);
        setConversations((prev) => prev.filter((c) => c.id !== convId));
        if (activeConvIdState === convId && remaining[0]) {
          setActiveConvId(remaining[0].id);
        }
        if (Array.isArray(res.data.conversations)) {
          const hydrated = normalizeConversationsFromServer(res.data.conversations);
          for (const conversation of hydrated) {
            deletedConvIdsRef.current.delete(conversation.id);
          }
          const protectedMsgIds = getProtectedMsgIds();
          setConversations((prev) =>
            mergeConversationThreads(hydrated, prev, protectedMsgIds, deletedConvIdsRef.current, pendingConvIdsRef.current),
          );
        }
        notifyLocalMutation('chat', convId, res.data.serverRevision, res.data.event);
        return { ok: true };
      }
      return { ok: false, error: res.error || res.data?.error || 'Nie udało się usunąć sesji w bazie SQLite.' };
    },
    [activeConvIdState, getProtectedMsgIds, notifyLocalMutation, setActiveConvId, tabOrigin],
  );

  const clearAllConversationsAndBuffers = useCallback(async () => {
    const accessToken = getSvlOperatorAccessToken();
    // SQLite is authoritative. Until the server confirms the destructive action
    // do NOT erase messages or the pending-write tracking sets.
    const eventId = createUniqueId('evt-clear-all');
    const res = await safeFetchJson<{
      ok: boolean;
      conversations?: any[];
      serverRevision?: number;
      error?: string;
    }>('/api/py/chat/conversations/clear-all', {
      method: 'POST',
      timeoutMs: 12000,
      headers: accessToken ? { 'X-SVL-Operator-Token': accessToken } : {},
      body: JSON.stringify({ origin: tabOrigin, eventId }),
    });

    if (res.ok && res.data?.ok && Array.isArray(res.data.conversations)) {
      chatMutationEpochRef.current += 1;
      const srvRev = Number(res.data.serverRevision || 0);
      if (srvRev > appliedChatServerRevRef.current) {
        appliedChatServerRevRef.current = srvRev;
      }
      pendingConvIdsRef.current.clear();
      pendingMsgIdsRef.current.clear();
      recentlyPersistedMsgExpiryRef.current.clear();
      deletedConvIdsRef.current.clear();
      explicitlyClearedRef.current = true;
      const hydrated = normalizeConversationsFromServer(res.data.conversations);
      setConversations(hydrated);
      setActiveConvIdState('conv-rodzina-mitek-wszyscy');
      setTargetAgentState('Rodzina Mitek');
      try {
        localStorage.removeItem(CONVERSATIONS_CACHE_KEY);
        localStorage.setItem(
          DURABLE_RECOVERY_BACKUP_KEY,
          JSON.stringify({
            version: 2,
            savedAt: new Date().toISOString(),
            clearedAt: new Date().toISOString(),
            conversations: [],
          }),
        );
      } catch { /* unavailable */ }
      notifyLocalMutation('chat', 'all', res.data.serverRevision);
      return { ok: true };
    }
    // On transport failure / 401, preserve the untouched local state.
    return { ok: false, error: res.data?.error || res.error || 'Nie udało się wyczyścić rozmów w SQLite.' };
  }, [notifyLocalMutation, tabOrigin]);

  const clearTerminalTab = useCallback(
    async (tab: TerminalTabId) => {
      const eventId = createUniqueId('evt-tclr');
      const res = await safeFetchJson<{
        ok: boolean;
        serverRevision?: number;
        event?: SvlSyncEvent;
        error?: string;
      }>('/api/py/terminal/clear', {
        method: 'POST',
        timeoutMs: 10000,
        body: JSON.stringify({
          tab,
          origin: tabOrigin,
          eventId,
        }),
      });
      if (res.ok && res.data?.ok) {
        setTerminalLogsByTab((prev) => ({ ...prev, [tab]: [] }));
        notifyLocalMutation('terminal', tab, res.data.serverRevision, res.data.event);
        return { ok: true };
      }
      return { ok: false, error: res.error || res.data?.error || 'Nie udało się wyczyścić historii terminala.' };
    },
    [notifyLocalMutation, tabOrigin],
  );

  const refreshTerminals = useCallback(async () => {
    await refreshDomainModules(['terminals', 'agents', 'health']);
  }, [refreshDomainModules]);

  const upsertSystemModule = useCallback(
    async (mod: {
      id: string;
      name: string;
      kind?: string;
      status?: string;
      description?: string;
      config?: Record<string, any>;
    }) => {
      const eventId = createUniqueId('evt-mod');
      const res = await safeFetchJson<{
        ok: boolean;
        module?: SystemModule;
        modules?: SystemModule[];
        serverRevision?: number;
        event?: SvlSyncEvent;
        error?: string;
      }>('/api/py/modules/upsert', {
        method: 'POST',
        timeoutMs: 12000,
        body: JSON.stringify({
          ...mod,
          source: 'ui',
          origin: tabOrigin,
          eventId,
        }),
      });
      if (res.ok && res.data?.ok) {
        if (Array.isArray(res.data.modules)) setSystemModules(res.data.modules);
        notifyLocalMutation('module', mod.id, res.data.serverRevision, res.data.event);
        await refreshDomainModules(['modules', 'kernel']);
        return { ok: true, module: res.data.module };
      }
      return { ok: false, error: res.error || res.data?.error || 'Nie udało się zapisać modułu.' };
    },
    [notifyLocalMutation, refreshDomainModules, tabOrigin],
  );

  const deleteSystemModule = useCallback(
    async (modId: string) => {
      const eventId = createUniqueId('evt-mdel');
      const res = await safeFetchJson<{
        ok: boolean;
        modules?: SystemModule[];
        serverRevision?: number;
        event?: SvlSyncEvent;
        error?: string;
      }>('/api/py/modules/delete', {
        method: 'POST',
        timeoutMs: 12000,
        body: JSON.stringify({
          id: modId,
          origin: tabOrigin,
          eventId,
        }),
      });
      if (res.ok && res.data?.ok) {
        if (Array.isArray(res.data.modules)) setSystemModules(res.data.modules);
        notifyLocalMutation('module', modId, res.data.serverRevision, res.data.event);
        await refreshDomainModules(['modules', 'kernel']);
        return { ok: true };
      }
      return { ok: false, error: res.error || res.data?.error || 'Nie udało się usunąć modułu.' };
    },
    [notifyLocalMutation, refreshDomainModules, tabOrigin],
  );

  const saveAgentAvatar = useCallback(
    async (agent: AvatarProfileKey, image: string) => {
      const eventId = createUniqueId('evt-avatar');
      const res = await safeFetchJson<{
        ok: boolean;
        avatars?: SvlAvatarMap;
        serverRevision?: number;
        event?: SvlSyncEvent;
        error?: string;
      }>('/api/avatars', {
        method: 'POST',
        timeoutMs: 15000,
        body: JSON.stringify({ agent, image, origin: tabOrigin, eventId }),
      });
      if (res.ok && res.data?.ok) {
        if (res.data.avatars) setAvatars(res.data.avatars);
        notifyLocalMutation('avatar', agent, res.data.serverRevision, res.data.event);
        return { ok: true, avatars: res.data.avatars };
      }
      return { ok: false, error: res.error || res.data?.error || 'Nie udało się zapisać awatara.' };
    },
    [notifyLocalMutation, tabOrigin],
  );

  const resetAgentAvatar = useCallback(
    async (agent: AvatarProfileKey) => {
      const res = await safeFetchJson<{
        ok: boolean;
        avatars?: SvlAvatarMap;
        serverRevision?: number;
        event?: SvlSyncEvent;
        error?: string;
      }>(`/api/avatars/${encodeURIComponent(agent)}`, {
        method: 'DELETE',
        timeoutMs: 12000,
      });
      if (res.ok && res.data?.ok) {
        if (res.data.avatars) setAvatars(res.data.avatars);
        notifyLocalMutation('avatar', agent, res.data.serverRevision, res.data.event);
        return { ok: true, avatars: res.data.avatars };
      }
      return { ok: false, error: res.error || res.data?.error || 'Nie udało się przywrócić awatara.' };
    },
    [notifyLocalMutation],
  );

  const value = useMemo<SvlSyncContextValue>(
    () => ({
      tabOrigin,
      wsState,
      wsAttempt,
      wsLastError,
      viteHmrDiagnostic,
      serverRevision,
      schemaVersion,
      lastSyncedAt,
      isSyncing,
      lastRefreshReport,
      healthData,
      kernelData,
      agentsData,
      systemModules,
      avatars,
      conversations,
      terminalLogsByTab,
      workspaceState,
      activeConvId: activeConvIdState,
      targetAgent: targetAgentState,
      selectedAgentPanel: selectedAgentPanelState,
      refreshAllDomains,
      refreshDomainModules,
      reconnectWebSocket,
      setActiveConvId,
      setTargetAgent,
      setSelectedAgentPanel,
      openFamilyChannel,
      openSvl364RootChannel,
      openAgentChannel,
      createConversation,
      deleteConversation,
      clearAllConversationsAndBuffers,
      appendAndPersistChatMessage,
      upsertSystemModule,
      deleteSystemModule,
      saveAgentAvatar,
      resetAgentAvatar,
      clearTerminalTab,
      refreshTerminals,
      notifyLocalMutation,
    }),
    [
      activeConvIdState,
      agentsData,
      appendAndPersistChatMessage,
      avatars,
      clearAllConversationsAndBuffers,
      clearTerminalTab,
      conversations,
      createConversation,
      deleteConversation,
      deleteSystemModule,
      healthData,
      isSyncing,
      kernelData,
      lastRefreshReport,
      lastSyncedAt,
      notifyLocalMutation,
      openAgentChannel,
      openFamilyChannel,
      openSvl364RootChannel,
      reconnectWebSocket,
      refreshDomainModules,
      refreshTerminals,
      resetAgentAvatar,
      saveAgentAvatar,
      schemaVersion,
      selectedAgentPanelState,
      serverRevision,
      setActiveConvId,
      setSelectedAgentPanel,
      setTargetAgent,
      systemModules,
      tabOrigin,
      targetAgentState,
      terminalLogsByTab,
      refreshAllDomains,
      upsertSystemModule,
      viteHmrDiagnostic,
      workspaceState,
      wsAttempt,
      wsLastError,
      wsState,
    ],
  );

  return <SvlSyncContext.Provider value={value}>{children}</SvlSyncContext.Provider>;
};

export function useSvlSync(): SvlSyncContextValue {
  const ctx = useContext(SvlSyncContext);
  if (!ctx) {
    throw new Error('useSvlSync must be used within SvlSyncProvider');
  }
  return ctx;
}
