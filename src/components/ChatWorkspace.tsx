import React, { useCallback, useMemo, useState, useRef, useEffect } from 'react';
import {
  Send,
  Paperclip,
  Plus,
  Terminal,
  Image as ImageIcon,
  FileText,
  X,
  CheckCircle2,
  RefreshCw,
  MessageSquare,
  Trash2,
  AlertTriangle,
  BellRing,
  Users,
  ChevronDown,
  ChevronUp,
  SlidersHorizontal,
  Sparkles,
  Radio,
  FileBarChart2,
  Shield,
  Loader2,
  Cpu,
  PanelLeftClose,
  PanelLeftOpen,
  ArrowDown,
} from 'lucide-react';
import {
  SyncableMessage,
  TargetAgentSelection,
  buildChatHistoryPayload,
  createUniqueId,
  formatAgentDisplayName,
  getEffectiveCanonicalAgents,
  parseBielikChatCommand,
  resolveChatInteractiveButtonAction,
  resolveChatTargetAgent,
  safeFetchJson,
  hasSvlOperatorAccessToken,
  validateOllamaHostUrl,
} from '../utils/svlLogic';
import {
  CHAT_WINDOW_STEP,
  DEFAULT_CHAT_WINDOW_SIZE,
  computeMessageWindow,
  nextMessageWindowLimit,
} from '../utils/chatViewport';
import { useSvlSync, getCanonicalConversationTitle } from '../utils/svlSyncStore';
import { AvatarSettingsModal, SvlAvatar } from './AgentAvatar';
import { RealVisionPanel } from './RealVisionPanel';
import { renderFormattedContent, renderFormattedLine } from './ChatContentRenderer';
import { ChatInputField, type ChatInputHandle } from './ChatInputField';
import { ChatMessageRow } from './ChatMessageRow';

export { renderFormattedContent, renderFormattedLine };
export type ChatMessage = SyncableMessage;

interface ChatWorkspaceProps {
  onNavigateTab: (tab: 'chat' | 'apex' | 'svl364' | 'infrastructure' | 'agents' | 'terminals' | 'kernel' | 'linux') => void;
}

export const ChatWorkspace: React.FC<ChatWorkspaceProps> = ({ onNavigateTab }) => {
  const {
    tabOrigin,
    wsState,
    wsAttempt,
    wsLastError,
    viteHmrDiagnostic,
    serverRevision,
    isSyncing,
    lastRefreshReport,
    healthData,
    agentsData,
    systemModules,
    conversations,
    activeConvId,
    targetAgent,
    setActiveConvId,
    setTargetAgent,
    openFamilyChannel,
    openAgentChannel,
    createConversation,
    deleteConversation,
    clearAllConversationsAndBuffers,
    appendAndPersistChatMessage,
    refreshAllDomains,
    refreshDomainModules,
    reconnectWebSocket,
    notifyLocalMutation,
  } = useSvlSync();

  const agentsStatus: any[] = agentsData?.agents || [];
  const effectiveAgents = useMemo(() => getEffectiveCanonicalAgents(agentsStatus), [agentsStatus]);
  const hasSi2Agent = useMemo(
    () =>
      effectiveAgents.some((a) => a.canonicalName === 'SI_System_2') ||
      systemModules.some((m) => String(m.id || '').startsWith('si-system-2')) ||
      conversations.some((c) => c.id === 'conv-si-system-2'),
    [conversations, effectiveAgents, systemModules],
  );

  // Tekst pola wpisywania żyje w ChatInputField (pisanie nie przerysowuje czatu); tu tylko „czy jest tekst”.
  const composerRef = useRef<ChatInputHandle | null>(null);
  const [hasInput, setHasInput] = useState(false);
  const handleInputEmptyChange = useCallback((isEmpty: boolean) => setHasInput(!isEmpty), []);
  const getInput = () => composerRef.current?.getValue() ?? '';
  const setInput = (value: string) => composerRef.current?.setValue(value);
  const [selectedModel, setSelectedModel] = useState('ollama:dolphin-llama3:8b-v2.9-q2_K');
  const [geminiModels, setGeminiModels] = useState<string[]>(['gemini-flash-lite-latest']);
  const [geminiConfigured, setGeminiConfigured] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [sendingElapsedSec, setSendingElapsedSec] = useState(0);
  const [pendingReplyAgent, setPendingReplyAgent] = useState<string>('System_SI_1');
  const [jediVmStatus, setJediVmStatus] = useState<any>(null);
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);
  const [isGeneratingSvlReport, setIsGeneratingSvlReport] = useState(false);
  const [isScanningAv, setIsScanningAv] = useState(false);
  const sendingRef = useRef(false);
  const queuedMessagesRef = useRef<Array<{ text: string; convId: string }>>([]);
  const [queuedCount, setQueuedCount] = useState(0);
  const handleSendRef = useRef<(text?: string, convId?: string) => Promise<void>>(async () => {});

  useEffect(() => {
    if (healthData?.jedi_omni_os_vm) {
      setJediVmStatus(healthData.jedi_omni_os_vm);
    }
  }, [healthData?.jedi_omni_os_vm]);

  useEffect(() => {
    let cancelled = false;
    void safeFetchJson<any>('/api/jedi/status', { timeoutMs: 8000 }).then((r) => {
      const vmData = r.data?.vm || (r.data?.nodeId || r.data?.port ? r.data : null);
      if (!cancelled && r.ok && r.data?.ok && vmData) {
        setJediVmStatus(vmData);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [serverRevision, isSending]);

  useEffect(() => {
    let cancelled = false;
    void safeFetchJson<{
      ok: boolean;
      engines?: { gemini?: { configured?: boolean; models?: string[] } };
    }>('/api/ai/engines', { timeoutMs: 12000 }).then((result) => {
      if (cancelled || !result.data?.ok) return;
      const gemini = result.data.engines?.gemini;
      const configured = Boolean(gemini?.configured);
      setGeminiConfigured(configured);
      if (configured && Array.isArray(gemini?.models) && gemini.models.length > 0) {
        setGeminiModels(gemini.models);
        setSelectedModel((current) => current.startsWith('gemini-') && !gemini.models!.includes(current)
          ? gemini.models![0]
          : current);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isSending) {
      setSendingElapsedSec(0);
      return;
    }
    const started = Date.now();
    const timer = window.setInterval(() => {
      setSendingElapsedSec(Math.max(1, Math.floor((Date.now() - started) / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isSending]);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true);
  const [messageWindowLimit, setMessageWindowLimit] = useState<number>(DEFAULT_CHAT_WINDOW_SIZE);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [controlsExpanded, setControlsExpanded] = useState(false);
  const [attachedImage, setAttachedImage] = useState<{ base64: string; mimeType: string; name: string } | null>(null);
  const [attachedTextFile, setAttachedTextFile] = useState<{ name: string; content: string } | null>(null);
  const [syncDrawerOpen, setSyncDrawerOpen] = useState(false);
  const [avatarSettingsOpen, setAvatarSettingsOpen] = useState(false);
  const [realVisionOpen, setRealVisionOpen] = useState(false);
  const [chatActionError, setChatActionError] = useState<string | null>(null);
  const [chatActionNotice, setChatActionNotice] = useState<{ kind: 'info' | 'ok'; text: string } | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [isClearingAll, setIsClearingAll] = useState(false);
  const [isRestoringMemory, setIsRestoringMemory] = useState(false);

  const showNotice = useCallback((text: string, kind: 'info' | 'ok' = 'ok') => {
    setChatActionNotice({ kind, text });
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current);
    }
    noticeTimerRef.current = window.setTimeout(() => {
      setChatActionNotice(null);
      noticeTimerRef.current = null;
    }, 4500);
  }, []);

  useEffect(() => () => {
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current);
    }
  }, []);

  // Ollama connection panel & pull state
  const [ollamaConfigOpen, setOllamaConfigOpen] = useState(false);
  const [ollamaUrlInput, setOllamaUrlInput] = useState('http://127.0.0.1:11434');
  const ollamaUrlDirtyRef = useRef(false);
  const [ollamaConfigStatus, setOllamaConfigStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [isSavingOllama, setIsSavingOllama] = useState(false);
  const [pullState, setPullState] = useState<any>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const prevConvIdRef = useRef('');
  const prevMsgCountRef = useRef<number>(0);
  const prevScrollHeightRef = useRef<number | null>(null);

  const [duplexActive, setDuplexActive] = useState(false);
  const [isProactiveLoading, setIsProactiveLoading] = useState(false);
  // Dlaczego rozmowa obustronna stoi (powód z serwera) — pokazywane zamiast cichego zatrzymania.
  const [duplexStatus, setDuplexStatus] = useState<{ reason: string; text: string } | null>(null);
  // Do kiedy (ms epoch) rozmowa obustronna jest wstrzymana po wyczerpaniu limitu Gemini (429).
  const duplexCooldownUntilRef = useRef(0);
  const lastInteractionTimeRef = useRef<number>(Date.now());
  const autoTurnsRef = useRef<number>(0);
  const prevDuplexActiveRef = useRef<boolean>(duplexActive);

  const activeConv = conversations.find((c) => c.id === activeConvId) || conversations[0];

  // Ile wiadomości każdego kanału Operator już widział — nowe powiadomienia na innym kanale
  // dostają znacznik na liście kanałów.
  const [seenCounts, setSeenCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    setSeenCounts((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const conv of conversations) {
        const len = conv.messages.length;
        if ((next[conv.id] === undefined && len > 0) || (conv.id === activeConv?.id && next[conv.id] !== len)) {
          next[conv.id] = len;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [conversations, activeConv?.id]);

  useEffect(() => {
    if (healthData?.ollama?.ollama_host && !ollamaUrlDirtyRef.current) {
      setOllamaUrlInput(healthData.ollama.ollama_host);
    }
    if (healthData?.ollama?.pull_state) {
      setPullState(healthData.ollama.pull_state);
    }
  }, [healthData?.ollama?.ollama_host, healthData?.ollama?.pull_state]);

  useEffect(() => {
    if (!pullState?.active) return;
    const timer = setInterval(async () => {
      const res = await safeFetchJson<{ ok: boolean; pull_state?: any }>('/api/ollama/pull-status', {
        timeoutMs: 8000,
      });
      if (res.ok && res.data?.pull_state) {
        setPullState(res.data.pull_state);
        if (!res.data.pull_state.active) {
          await refreshDomainModules(['health', 'agents']);
        }
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [pullState?.active, refreshDomainModules]);

  // Preserve scroll position unless user sends a message or was already near the bottom
  useEffect(() => {
    const msgCount = activeConv?.messages.length || 0;
    const prevCount = prevMsgCountRef.current;
    prevMsgCountRef.current = msgCount;
    const container = messagesScrollRef.current;
    // Zmiana kanału: zawsze najnowsze wiadomości i domyślne okno renderu.
    const convId = activeConv?.id || '';
    if (convId !== prevConvIdRef.current) {
      prevConvIdRef.current = convId;
      prevScrollHeightRef.current = null;
      setMessageWindowLimit(DEFAULT_CHAT_WINDOW_SIZE);
      setShowScrollToBottom(false);
      requestAnimationFrame(() => {
        const box = messagesScrollRef.current;
        if (box) box.scrollTop = box.scrollHeight;
      });
      return;
    }
    if (msgCount === prevCount && !isSending) return;

    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom < 180 || isSending) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      setShowScrollToBottom(false);
    }
  }, [activeConv?.id, activeConv?.messages.length, isSending]);

  const handleMessagesScroll = useCallback(() => {
    const box = messagesScrollRef.current;
    if (!box) return;
    const distanceFromBottom = box.scrollHeight - box.scrollTop - box.clientHeight;
    const shouldShow = distanceFromBottom > 260;
    setShowScrollToBottom((prev) => (prev === shouldShow ? prev : shouldShow));
  }, []);

  const handleExpandOlderMessages = useCallback((showAll: boolean, totalCount: number) => {
    const box = messagesScrollRef.current;
    if (box) {
      prevScrollHeightRef.current = box.scrollHeight;
    }
    setMessageWindowLimit((prev) =>
      showAll ? Math.max(prev, totalCount) : nextMessageWindowLimit(prev, totalCount, CHAT_WINDOW_STEP),
    );
  }, []);

  useEffect(() => {
    if (prevScrollHeightRef.current === null) return;
    const prevHeight = prevScrollHeightRef.current;
    prevScrollHeightRef.current = null;
    const box = messagesScrollRef.current;
    if (!box) return;
    const delta = box.scrollHeight - prevHeight;
    if (delta > 0) {
      box.scrollTop += delta;
    }
  }, [messageWindowLimit]);

  useEffect(() => {
    lastInteractionTimeRef.current = Date.now();
  }, [activeConv?.id, activeConv?.messages.length]);

  useEffect(() => {
    autoTurnsRef.current = 0;
  }, [activeConv?.id]);

  const [duplexTick, setDuplexTick] = useState(0);

  const handleTriggerProactiveChat = async (agentOverride?: string, autonomous = false) => {
    if (sendingRef.current || isSending || isProactiveLoading || !activeConv) return;
    if (!hasSvlOperatorAccessToken()) {
      const authText = 'Odblokuj dostęp przyciskiem 🔒 SVL w górnym pasku, aby AI mogło pisać w trybie swobodnej rozmowy.';
      if (autonomous) {
        setDuplexStatus({ reason: 'auth', text: authText });
      } else {
        setChatActionError(authText);
      }
      return;
    }
    if (!autonomous) {
      autoTurnsRef.current = 0;
    }
    setIsProactiveLoading(true);
    setChatActionError(null);
    lastInteractionTimeRef.current = Date.now();
    try {
      const chosenTarget =
        agentOverride ||
        (targetAgent === 'System_SI_1' || targetAgent === 'SI_System_2' || targetAgent === 'JEDI_Omni_OS'
          ? targetAgent
          : 'System_SI_1');
      const recentMsgs = (activeConv.messages || []).slice(-12);
      const lastMsg = recentMsgs[recentMsgs.length - 1];
      const historyPayload = recentMsgs.map((m) => ({
        role: m.role,
        sender: m.sender,
        content: m.content,
      }));
      const res = await safeFetchJson<{
        ok: boolean;
        message?: ChatMessage;
        sender?: string;
        agentId?: string;
        modelUsed?: string;
        serverRevision?: number;
        error?: string;
        skipped?: boolean;
        reason?: string;
      }>('/api/chat/proactive', {
        method: 'POST',
        // Serwer może czekać na zimny start modelu Ollama (predykcja + wypowiedź);
        // 30 s kończyło się błędem w karcie, choć wypowiedź i tak trafiała do SQLite.
        timeoutMs: 200000,
        maxRetries: 0,
        body: JSON.stringify({
          conversationId: activeConv.id,
          targetAgent: chosenTarget,
          model: selectedModel,
          origin: tabOrigin,
          history: historyPayload,
          lastSender: lastMsg?.sender || '',
          autonomous,
        }),
      });

      if (res.data?.ok && res.data.message) {
        if (autonomous) {
          autoTurnsRef.current += 1;
        }
        setDuplexStatus(null);
        notifyLocalMutation('chat', activeConv.id, res.data.serverRevision);
        await refreshDomainModules(['chat', 'agents']);
      } else if (res.data?.skipped && res.data.reason) {
        // 'busy' = inna karta właśnie pisze; jej wiadomość przyjdzie przez synchronizację.
        const retryAfterMs = Number((res.data as { retryAfterMs?: number }).retryAfterMs || 0);
        if (retryAfterMs > 0) {
          // Limit Gemini wyczerpany: wstrzymujemy automatyczne tury (max ~90 s na raz, potem
          // ponowna próba), żeby nie przepalać odnawiającego się limitu. Wiadomości Operatora działają.
          duplexCooldownUntilRef.current = Date.now() + Math.min(retryAfterMs, 90000);
        }
        if (res.data.reason !== 'busy') {
          setDuplexStatus({ reason: res.data.reason, text: res.data.error || res.data.reason });
          // Przy ręcznym wywołaniu pasek trybu obustronnego może być ukryty — pokaż powód wprost.
          if (!autonomous) setChatActionError(res.data.error || res.data.reason);
        }
      } else {
        const errMsg = `Błąd inicjacji rozmowy: ${res.error || res.data?.error || 'brak odpowiedzi'}`;
        if (autonomous) {
          setDuplexStatus({ reason: 'error', text: errMsg });
        } else {
          setChatActionError(errMsg);
        }
      }
    } finally {
      setIsProactiveLoading(false);
    }
  };

  const handleProactiveRef = useRef(handleTriggerProactiveChat);
  handleProactiveRef.current = handleTriggerProactiveChat;

  // Nowa wiadomość (od Operatora lub z innej karty) albo zmiana kanału odblokowuje rozmowę —
  // ale nie w trakcie karencji limitu Gemini (inaczej każda wiadomość od razu znów przepalałaby limit).
  useEffect(() => {
    if (Date.now() < duplexCooldownUntilRef.current) return;
    setDuplexStatus(null);
  }, [activeConv?.id, activeConv?.messages.length]);

  useEffect(() => {
    const justEnabled = !prevDuplexActiveRef.current && duplexActive;
    prevDuplexActiveRef.current = duplexActive;
    if (justEnabled) {
      autoTurnsRef.current = 0;
      setDuplexStatus(null);
    }
    if (!duplexActive) {
      setDuplexStatus(null);
      return;
    }
    if (!activeConv || isSending || isProactiveLoading) {
      return;
    }
    if (!hasSvlOperatorAccessToken()) {
      setDuplexStatus((prev) =>
        prev?.reason === 'auth'
          ? prev
          : {
              reason: 'auth',
              text: 'Odblokuj dostęp przyciskiem 🔒 SVL w górnym pasku, aby AI mogło pisać w trybie swobodnej rozmowy.',
            },
      );
      return;
    }
    // Limit tur AI pilnuje serwer (powód pauzy wraca w odpowiedzi); tu tylko bezpiecznik.
    const CLIENT_SAFETY_MAX_AUTO_TURNS = 8;
    if (autoTurnsRef.current >= CLIENT_SAFETY_MAX_AUTO_TURNS) {
      return;
    }
    const cooldownLeft = duplexCooldownUntilRef.current - Date.now();
    if (cooldownLeft > 0) {
      const resume = setTimeout(() => {
        duplexCooldownUntilRef.current = 0;
        setDuplexStatus(null);
        setDuplexTick((n) => n + 1);
      }, cooldownLeft + 200);
      return () => clearTimeout(resume);
    }
    if (duplexStatus && !justEnabled) {
      return;
    }

    // Rzadsze tury w tle (9 s) mniej obciążają limit API niż poprzednie 6 s.
    const delayMs = justEnabled ? 1800 : autoTurnsRef.current === 0 ? 3500 : 9000;
    const timer = setTimeout(() => {
      if ((typeof document !== 'undefined' && document.hidden) || sendingRef.current || getInput().trim().length > 0) {
        setDuplexTick((n) => n + 1);
        return;
      }
      if (!hasSvlOperatorAccessToken()) {
        setDuplexStatus({
          reason: 'auth',
          text: 'Odblokuj dostęp przyciskiem 🔒 SVL w górnym pasku, aby AI mogło pisać w trybie swobodnej rozmowy.',
        });
        return;
      }
      void handleProactiveRef.current(undefined, true);
    }, delayMs);

    const onVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        setDuplexTick((n) => n + 1);
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }

    return () => {
      clearTimeout(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [duplexActive, duplexStatus, duplexTick, activeConv?.id, activeConv?.messages.length, isSending, isProactiveLoading, selectedModel]);

  const ollamaReachable = Boolean(healthData?.ollama?.daemon_reachable);
  const ollamaModels: any[] = healthData?.ollama?.models || [];
  const selectedModelSupportsVision =
    selectedModel === 'svl-hybrid-router' ||
    selectedModel.includes('llama3.2-vision') ||
    selectedModel.includes('vl') ||
    selectedModel.includes('vision');

  const handleSaveOllamaConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    const check = validateOllamaHostUrl(ollamaUrlInput);
    if (!check.valid || !check.normalized) {
      setOllamaConfigStatus({ ok: false, msg: check.error || 'Nieprawidłowy adres URL.' });
      return;
    }
    setIsSavingOllama(true);
    setOllamaConfigStatus(null);
    try {
      const eventId = createUniqueId('evt-ollama');
      const res = await safeFetchJson<any>('/api/ollama/config', {
        method: 'POST',
        timeoutMs: 15000,
        body: JSON.stringify({
          ollamaHost: check.normalized,
          origin: tabOrigin,
          eventId,
        }),
      });
      const data = res.data;
      ollamaUrlDirtyRef.current = false;
      await refreshDomainModules(['health', 'agents']);
      if (res.ok && data?.ok) {
        notifyLocalMutation('ollama', 'host', data.serverRevision, data.event);
      }
      if (res.ok && data?.ok && data?.ollama?.daemon_reachable) {
        const count = (data.ollama.models || []).length;
        setOllamaConfigStatus({
          ok: true,
          msg: `Połączono z lokalnym demonem Ollama (${data.ollama.ollama_host}). Wykryto modeli: ${count}.`,
        });
      } else {
        setOllamaConfigStatus({
          ok: false,
          msg:
            res.error ||
            `Zapisano adres ${check.normalized}, ale daemon nie odpowiada: ${data?.ollama?.error || data?.error || 'connection refused'}`,
        });
      }
    } finally {
      setIsSavingOllama(false);
    }
  };

  const handleRefreshAllDomains = async () => {
    if (isSyncing) return;
    setChatActionError(null);
    const rep = await refreshAllDomains('operator_refresh_button');
    setSyncDrawerOpen(true);
    if (rep.ok) {
      showNotice(`Zsynchronizowano system (rev ${rep.serverRevision}, ${rep.durationMs} ms).`, 'ok');
    } else {
      setChatActionError(rep.error || 'Odświeżanie nie powiodło się.');
    }
  };

  const handleEmitComprehensiveSvlReport = async () => {
    if (isGeneratingSvlReport || isSending) return;
    if (!hasSvlOperatorAccessToken()) {
      setChatActionError('Odblokuj dostęp przyciskiem 🔒 SVL w górnym pasku, aby wygenerować raport SVL_System.');
      return;
    }
    setIsGeneratingSvlReport(true);
    setChatActionError(null);
    const targetConvId = activeConv?.id || 'conv-rodzina-mitek-wszyscy';
    try {
      const res = await safeFetchJson<{
        ok: boolean;
        reportMarkdown?: string;
        serverRevision?: number;
        error?: string;
      }>('/api/py/kernel/markdown-report', {
        method: 'POST',
        timeoutMs: 15000,
        body: JSON.stringify({
          directive: 'Pełny raport operacyjny SVL_System (host, moduły, pamięć)',
          emitToChat: true,
          conversationId: targetConvId,
          origin: tabOrigin,
        }),
      });
      if (res.ok && res.data?.ok) {
        await refreshDomainModules(['chat', 'modules', 'kernel']);
        notifyLocalMutation('chat', targetConvId, res.data.serverRevision);
        showNotice('Wygenerowano raport SVL_System w aktywnym kanale.', 'ok');
        window.setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 120);
      } else {
        setChatActionError(res.error || res.data?.error || 'Nie udało się wygenerować raportu SVL_System.');
      }
    } finally {
      setIsGeneratingSvlReport(false);
    }
  };

  const handleRunAntivirusScan = async () => {
    if (isScanningAv || isSending) return;
    if (!hasSvlOperatorAccessToken()) {
      setChatActionError('Odblokuj dostęp przyciskiem 🔒 SVL w górnym pasku, aby uruchomić skaner SVL-365 Sentinel AV.');
      return;
    }
    setIsScanningAv(true);
    setChatActionError(null);
    const targetConvId = activeConv?.id || 'conv-rodzina-mitek-wszyscy';
    try {
      const res = await safeFetchJson<{
        ok: boolean;
        filesScanned?: number;
        totalThreatsRemoved?: number;
        serverRevision?: number;
        error?: string;
      }>('/api/security/antivirus/scan', {
        method: 'POST',
        timeoutMs: 25000,
        body: JSON.stringify({
          emitToChat: true,
          conversationId: targetConvId,
          origin: tabOrigin,
        }),
      });
      await refreshAllDomains('operator_antivirus_scan');
      await refreshDomainModules(['chat', 'modules', 'kernel', 'health', 'agents']);
      if (res.ok && res.data?.ok) {
        notifyLocalMutation('chat', targetConvId, res.data.serverRevision);
        const scanned = typeof res.data.filesScanned === 'number' ? res.data.filesScanned : 0;
        const removed = typeof res.data.totalThreatsRemoved === 'number' ? res.data.totalThreatsRemoved : 0;
        showNotice(`Skaner AV zakończył kontrolę (plików: ${scanned}, usuniętych zagrożeń: ${removed}).`, 'ok');
        window.setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 120);
      } else {
        setChatActionError(res.error || res.data?.error || 'Błąd skanera SVL-365 Sentinel AV.');
      }
    } finally {
      setIsScanningAv(false);
    }
  };

  const handleDeleteConversationClick = async (id: string) => {
    setChatActionError(null);
    const res = await deleteConversation(id);
    if (!res.ok && res.error) {
      setChatActionError(res.error);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = () => {
        setAttachedImage({
          base64: String(reader.result || ''),
          mimeType: file.type,
          name: file.name,
        });
      };
      reader.readAsDataURL(file);
    } else {
      const reader = new FileReader();
      reader.onload = () => {
        setAttachedTextFile({
          name: file.name,
          content: String(reader.result || '').slice(0, 12000),
        });
      };
      reader.readAsText(file);
    }
    e.target.value = '';
  };

  const handleSendMessage = async (overrideText?: string, overrideConvId?: string) => {
    const rawText = overrideText !== undefined ? overrideText : getInput();
    const trimmed = rawText.trim();
    const targetConvObj = overrideConvId
      ? conversations.find((c) => c.id === overrideConvId) || activeConv
      : activeConv;
    if ((!trimmed && !attachedImage && !attachedTextFile) || !targetConvObj) return;
    if (sendingRef.current) {
      // AI jeszcze odpowiada: wiadomość trafia do kolejki zamiast przepaść.
      if (trimmed) {
        queuedMessagesRef.current.push({ text: rawText, convId: overrideConvId || targetConvObj.id });
        if (overrideText === undefined) setInput('');
        setQueuedCount(queuedMessagesRef.current.length);
      }
      return;
    }
    autoTurnsRef.current = 0;
    sendingRef.current = true;
    setIsSending(true);
    // Pole czyścimy od razu — tekst wpisany w trakcie odpowiedzi AI nie zostanie nadpisany.
    if (overrideText === undefined) setInput('');
    try {
      setChatActionError(null);
      const nowTime = new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
      const fullPrompt = attachedTextFile
        ? `${trimmed || 'Przeanalizuj załączony plik.'}\n\n[Załączony plik: ${attachedTextFile.name}]\n\`\`\`\n${attachedTextFile.content.slice(0, 4000)}\n\`\`\``
        : trimmed;

      const userMsg: ChatMessage = {
        id: createUniqueId('user'),
        role: 'user',
        sender: 'Mateusz Mitek (Operator)',
        timestamp: nowTime,
        content: trimmed || (attachedImage ? `[Przesłano obraz: ${attachedImage.name}]` : `[Plik: ${attachedTextFile?.name}]`),
        imagePreview: attachedImage?.base64,
        fileName: attachedTextFile?.name || attachedImage?.name,
      };

      const targetConvId = overrideConvId || targetConvObj.id;
      const isPermanentChannel =
        targetConvId === 'conv-rodzina-mitek-wszyscy' ||
        targetConvId === 'conv-system-si-1' ||
        targetConvId === 'conv-si-system-2';
      const targetTitle = isPermanentChannel
        ? getCanonicalConversationTitle(targetConvId, targetConvObj.title)
        : targetConvObj.messages.length <= 1 && trimmed
          ? trimmed.slice(0, 42)
          : targetConvObj.title;

      const persistRes = await appendAndPersistChatMessage(targetConvId, targetTitle, selectedModel, userMsg);
      if (!persistRes.ok) {
        setChatActionError(`Błąd zapisu SQLite: ${persistRes.error || 'Nie zapisano wiadomości.'}`);
        if (overrideText === undefined && !getInput().trim()) setInput(rawText);
        return;
      }

      const currentImage = attachedImage;
      setAttachedImage(null);
      setAttachedTextFile(null);

      const historyPayload = buildChatHistoryPayload(targetConvObj.messages, 16);

      const isSlashCmd = Boolean(parseBielikChatCommand(trimmed));
      const resolvedTarget = resolveChatTargetAgent({
        message: trimmed,
        conversationId: targetConvId,
        targetAgent,
        hasSlashCommand: isSlashCmd,
      });
      const isJediVmTarget =
        targetAgent === 'JEDI_Omni_OS' || resolvedTarget.agent === 'JEDI_Omni_OS';
      const isSi2Channel =
        !isJediVmTarget &&
        (targetConvId === 'conv-si-system-2' ||
          resolvedTarget.agent === 'SI_System_2' ||
          targetAgent === 'SI_System_2');
      const isSystemSi1Channel =
        !isJediVmTarget &&
        !isSi2Channel &&
        (targetConvId === 'conv-system-si-1' || targetAgent === 'System_SI_1');
      const isFamilyDuplex =
        !isJediVmTarget &&
        !isSi2Channel &&
        !isSystemSi1Channel &&
        (targetConvId === 'conv-rodzina-mitek-wszyscy' ||
          targetConvObj.title.toLowerCase().includes('rodzina mitek') ||
          targetAgent === 'Rodzina Mitek' ||
          duplexActive);

      const effectiveTargetAgent = isJediVmTarget
        ? 'JEDI_Omni_OS'
        : isSi2Channel
          ? 'SI_System_2'
          : isSystemSi1Channel
            ? 'System_SI_1'
            : isFamilyDuplex
              ? 'Rodzina Mitek'
              : targetAgent;
      setPendingReplyAgent(
        isJediVmTarget
          ? 'JEDI Omni-OS v11.5 (AI + VM)'
          : isSi2Channel
            ? 'SI_System_2 (SVL-465 · ROOT)'
            : 'Jyn (System_SI_1)',
      );

      const res = await safeFetchJson<any>('/api/chat', {
        method: 'POST',
        // Musi pokrywać budżety silników (Grok 60 s, Ollama 75 s, Gemini do 150 s) plus zapas na przełączenie.
        timeoutMs: 210000,
        body: JSON.stringify({
          message: fullPrompt,
          model: selectedModel,
          targetAgent: effectiveTargetAgent,
          conversationId: targetConvId,
          conversationTitle: targetTitle,
          history: historyPayload,
          imageBase64: currentImage?.base64 || '',
          imageMimeType: currentImage?.mimeType || 'image/png',
          origin: tabOrigin,
        }),
      });
      const data = res.data;

      if (!res.ok || !data || data.ok === false) {
        if (Array.isArray(data?.appliedActions) && data.appliedActions.length > 0) {
          void refreshDomainModules(['modules', 'agents', 'kernel', 'health']);
        }
        if (res.status === 0 && !data) {
          // Przekroczony czas lub zerwane połączenie: serwer kończy generowanie i sam zapisuje
          // odpowiedź w SQLite — dotrze tu przez synchronizację, więc odświeżamy kanał.
          setChatActionError(
            `${res.error || 'Brak połączenia z serwerem.'} Odpowiedź AI pojawi się automatycznie, gdy model ją wygeneruje.`,
          );
          void refreshDomainModules(['chat']);
          return;
        }
        setChatActionError(res.error || data?.error || `Błąd serwera HTTP ${res.status}`);
        return;
      }

      if (data.connectionReport) {
        void refreshDomainModules(['agents', 'health']);
      }

      const appliedActions =
        Array.isArray(data.appliedActions) && data.appliedActions.length > 0
          ? data.appliedActions
          : undefined;

      // Serwer zapisuje odpowiedź sam (`data.message`, ten sam identyfikator) — ponowny zapis
      // poniżej jest idempotentny i tylko scala stan lokalny bez drugiego wpisu w SQLite.
      const serverMsg: Partial<ChatMessage> =
        data.message && typeof data.message === 'object' && typeof data.message.id === 'string' ? data.message : {};
      const replyMsg: ChatMessage = {
        id: serverMsg.id || createUniqueId('asst'),
        role: 'assistant',
        sender: formatAgentDisplayName(data.sender || 'System_SI_1'),
        agentId: data.agentId || 'System_SI_1',
        modelUsed: data.modelUsed || selectedModel,
        timestamp: serverMsg.timestamp || new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }),
        content: data.reply || 'Brak odpowiedzi z serwera.',
        imagePreview: data.imagePreview || serverMsg.imagePreview,
        connectionReport: data.connectionReport,
        appliedActions,
        provenance: data.provenance,
        verificationNote: data.verificationNote,
      };
      const replyPersist = await appendAndPersistChatMessage(
        targetConvId,
        targetTitle,
        selectedModel,
        replyMsg,
        {
          alreadyPersisted: Boolean(data.persisted),
          serverRevision: typeof data.serverRevision === 'number' ? data.serverRevision : undefined,
        },
      );
      if (!replyPersist.ok && replyPersist.error) {
        setChatActionError(`Błąd zapisu odpowiedzi w SQLite: ${replyPersist.error}`);
      }

      void refreshAllDomains('chat_message_global_sync');
    } catch (error: any) {
      setChatActionError(`Błąd wysyłania wiadomości: ${error?.message || String(error)}`);
    } finally {
      sendingRef.current = false;
      setIsSending(false);
      const next = queuedMessagesRef.current.shift();
      setQueuedCount(queuedMessagesRef.current.length);
      if (next) setTimeout(() => void handleSendRef.current(next.text, next.convId), 0);
    }
  };
  handleSendRef.current = handleSendMessage;

  const handleGenerateImage = async (promptOverride?: string) => {
    const prompt = (promptOverride !== undefined ? promptOverride : getInput()).trim();
    const targetConvObj = activeConv;
    if (!targetConvObj || sendingRef.current) return;
    if (!hasSvlOperatorAccessToken()) {
      setChatActionError('Odblokuj dostęp przyciskiem 🔒 SVL w górnym pasku, aby wygenerować obraz.');
      return;
    }
    if (!prompt) {
      composerRef.current?.focus();
      showNotice('Wpisz opis obrazu w polu poniżej, a potem kliknij „Generuj obraz”.', 'info');
      return;
    }

    sendingRef.current = true;
    setIsSending(true);
    setIsGeneratingImage(true);
    setChatActionError(null);
    const targetTitle = targetConvObj.messages.length <= 1
      ? prompt.slice(0, 42)
      : targetConvObj.title;
    const timestamp = new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });

    try {
      const userMsg: ChatMessage = {
        id: createUniqueId('user-image'),
        role: 'user',
        sender: 'Mateusz Mitek (Operator)',
        timestamp,
        content: `[Generowanie obrazu] ${prompt}`,
      };
      const savedPrompt = await appendAndPersistChatMessage(
        targetConvObj.id,
        targetTitle,
        selectedModel,
        userMsg,
      );
      if (!savedPrompt.ok) {
        setChatActionError(`Błąd zapisu promptu: ${savedPrompt.error || 'Nie zapisano wiadomości.'}`);
        return;
      }

      if (promptOverride === undefined) setInput('');
      const result = await safeFetchJson<any>('/api/py/images/generate', {
        method: 'POST',
        timeoutMs: 900000,
        body: JSON.stringify({ prompt, origin: tabOrigin }),
      });
      if (!result.ok || !result.data?.ok || !result.data?.image) {
        setChatActionError(result.error || result.data?.error || 'Silnik graficzny nie zwrócił obrazu.');
        return;
      }

      const imageMsg: ChatMessage = {
        id: createUniqueId('assistant-image'),
        role: 'assistant',
        sender: 'SVL Image Engine',
        modelUsed: result.data.model || 'Qwen Image 2.1',
        timestamp: new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }),
        content: `Wygenerowano obraz przez ${result.data.model || 'Qwen Image 2.1'}.`,
        imagePreview: result.data.image,
      };
      const savedImage = await appendAndPersistChatMessage(
        targetConvObj.id,
        targetTitle,
        selectedModel,
        imageMsg,
      );
      if (!savedImage.ok) {
        setChatActionError(`Obraz wygenerowano, ale nie zapisano go w czacie: ${savedImage.error || 'błąd SQLite.'}`);
      } else {
        showNotice('Wygenerowano obraz i zapisano w czacie.', 'ok');
      }
      await refreshDomainModules(['chat', 'health']);
    } catch (error: any) {
      setChatActionError(`Błąd generowania obrazu: ${error?.message || String(error)}`);
    } finally {
      sendingRef.current = false;
      setIsSending(false);
      setIsGeneratingImage(false);
    }
  };

  /**
   * Obsługa przycisków z wiadomości (pisanych przez System_SI_1, JEDI Omni-OS v11.5 lub serwer):
   * `send:` wysyła wiadomość do VM/AI, `ask:System_SI_1` oddaje głos AI, `text:` wstawia tekst
   * do pola, `tab:`/`nav:` otwiera zakładkę, `action:` uruchamia akcję systemu.
   */
  const handleInteractiveAction = async (actionValue: string, label?: string) => {
    const resolved = resolveChatInteractiveButtonAction(actionValue, label);
    switch (resolved.kind) {
      case 'empty':
        return;
      case 'unsafe':
        setChatActionError(
          'Przyciski odpowiedzi AI nie mogą automatycznie uruchamiać powłoki. Wklej komendę ręcznie do terminala lub użyj /root w polu czatu.',
        );
        return;
      case 'tab':
        setChatActionError(null);
        onNavigateTab(resolved.tab);
        return;
      case 'invalid_tab':
        setChatActionError(`Przycisk wskazuje nieistniejącą zakładkę „${resolved.rawTab}”.`);
        return;
      case 'send':
        if (!hasSvlOperatorAccessToken()) {
          setChatActionError('Odblokuj dostęp przyciskiem 🔒 SVL w górnym pasku, aby wysłać polecenie z przycisku.');
          return;
        }
        if (sendingRef.current || isSending) {
          setChatActionError('Poczekaj, aż AI skończy odpowiadać — potem kliknij przycisk ponownie.');
          return;
        }
        setChatActionError(null);
        window.setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 80);
        await handleSendMessage(resolved.text);
        return;
      case 'ask':
        setChatActionError(null);
        await handleProactiveRef.current(resolved.agent, false);
        return;
      case 'text':
        setChatActionError(null);
        setInput(resolved.text);
        composerRef.current?.focus();
        showNotice('Wstawiono tekst do pola wpisywania — kliknij „Wyślij” lub edytuj.', 'info');
        return;
      case 'copy': {
        let copiedOk = false;
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(resolved.text);
            copiedOk = true;
          }
        } catch {
          copiedOk = false;
        }
        if (!copiedOk && typeof document !== 'undefined') {
          try {
            const ta = document.createElement('textarea');
            ta.value = resolved.text;
            ta.setAttribute('readonly', 'true');
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            copiedOk = document.execCommand('copy');
            document.body.removeChild(ta);
          } catch {
            copiedOk = false;
          }
        }
        if (copiedOk) {
          showNotice('Skopiowano treść do schowka.', 'ok');
        } else {
          setInput(resolved.text);
          composerRef.current?.focus();
          showNotice('Schowek zablokowany — wstawiono tekst do pola wpisywania.', 'info');
        }
        return;
      }
      case 'sync':
        await handleRefreshAllDomains();
        return;
      case 'scan':
        await handleRunAntivirusScan();
        return;
      case 'report':
        await handleEmitComprehensiveSvlReport();
        return;
      case 'image':
        await handleGenerateImage(resolved.prompt);
        return;
      case 'vision':
        setChatActionError(null);
        setRealVisionOpen(true);
        return;
      case 'avatars':
        setChatActionError(null);
        setAvatarSettingsOpen(true);
        return;
      case 'ollama':
        setChatActionError(null);
        setControlsExpanded(true);
        setOllamaConfigOpen(true);
        showNotice('Otwarto konfigurację OLLAMA_HOST.', 'info');
        return;
      case 'duplex':
        setDuplexActive((prev) => {
          const next = !prev;
          showNotice(next ? 'Włączono czat obustronny (AI może pisać samodzielnie).' : 'Wyłączono czat obustronny.', 'info');
          return next;
        });
        return;
    }
  };

  const wsBadgeLabel =
    wsState === 'online'
      ? `WS Online · rev ${serverRevision}`
      : wsState === 'connecting'
        ? `Łączenie WS... · rev ${serverRevision}`
        : wsState === 'reconnecting'
          ? `Reconnect WS (${wsAttempt})... · rev ${serverRevision}`
          : `WS Offline (HTTP) · rev ${serverRevision}`;

  const wsBadgeClass =
    wsState === 'online'
      ? 'text-emerald-400'
      : wsState === 'offline'
        ? 'text-rose-400'
        : 'text-amber-300';

  const hasAnyChatAuth = hasSvlOperatorAccessToken();
  const activeMessages = activeConv?.messages;
  const currentConvId = activeConv?.id;
  const visibleMessages = useMemo(() => (activeMessages || []).filter((msg) => {
    const txt = String(msg.content || '').trim();
    if (txt.includes('ustaw: command not found')) return false;
    if (msg.sender === 'System SVL' || txt.startsWith('[Czat -> System]')) return false;
    if (
      msg.role === 'system' &&
      (msg.sender === 'Diagnostyka połączenia AI' ||
        txt.includes('Nie udało się uzyskać odpowiedzi z żadnego silnika AI') ||
        txt.includes('Serwer Ollama pod adresem http://127.0.0.1:11434 jest nieosiągalny'))
    ) {
      return false;
    }
    return true;
  }), [activeMessages]);

  // Stabilna funkcja dla przycisków w treści wiadomości (zawsze woła najnowszą wersję handlera).
  const interactiveActionRef = useRef(handleInteractiveAction);
  interactiveActionRef.current = handleInteractiveAction;
  const stableInteractiveAction = useCallback(
    (actionValue: string, label?: string) => interactiveActionRef.current(actionValue, label),
    [],
  );

  const messageWindow = useMemo(
    () => computeMessageWindow(visibleMessages.length, messageWindowLimit),
    [visibleMessages.length, messageWindowLimit],
  );
  const windowedMessages = useMemo(
    () => visibleMessages.slice(messageWindow.startIndex),
    [visibleMessages, messageWindow.startIndex],
  );

  // Lista wiadomości (Markdown) renderowana ponownie tylko, gdy zmienią się wiadomości lub okno —
  // nie przy pisaniu, wysyłaniu czy odświeżaniu statusu.
  const isFamilyChannel = currentConvId === 'conv-rodzina-mitek-wszyscy';
  const messageListNode = useMemo(
    () =>
      windowedMessages.map((msg) => (
        <ChatMessageRow
          key={msg.id}
          msg={msg}
          isFamilyChannel={isFamilyChannel}
          onInteractiveAction={stableInteractiveAction}
          onNavigateTab={onNavigateTab}
        />
      )),
    [windowedMessages, isFamilyChannel, stableInteractiveAction, onNavigateTab],
  );

  return (
    <div className="relative flex h-full w-full overflow-hidden bg-[#0B0D13] cpd-theme-dark">
      {/* Mobile Sidebar Backdrop */}
      {mobileSidebarOpen && (
        <button
          type="button"
          aria-label="Zamknij tło panelu rozmów"
          onClick={() => setMobileSidebarOpen(false)}
          className="fixed inset-0 z-30 bg-black/60 backdrop-blur-[1px] lg:hidden"
        />
      )}

      {/* Left Open WebUI Sidebar: Conversation History & Agent Status Summary */}
      <aside
        className={`${
          mobileSidebarOpen
            ? 'fixed inset-y-0 left-0 z-40 flex w-[min(86vw,320px)] max-w-full pb-safe shadow-2xl'
            : desktopSidebarOpen
              ? 'hidden lg:flex lg:w-64 xl:w-72'
              : 'hidden'
        } shrink-0 flex-col border-r border-slate-800/80 bg-[#111520]`}
      >
        <div className="p-3 border-b border-slate-800/80 space-y-2">
          <button
            type="button"
            onClick={() => {
              openFamilyChannel();
              setMobileSidebarOpen(false);
            }}
            className={`w-full min-h-[42px] px-3 py-2 text-xs font-semibold rounded-lg flex items-center justify-center gap-2 transition-colors whitespace-nowrap ${
              activeConv?.id === 'conv-rodzina-mitek-wszyscy' || targetAgent === 'Rodzina Mitek'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'bg-emerald-600/20 hover:bg-emerald-600/35 border border-emerald-500/40 text-emerald-200'
            }`}
          >
            <Users className="w-4 h-4 shrink-0" />
            Rodzina Mitek (wszyscy)
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                createConversation();
                setMobileSidebarOpen(false);
              }}
              className="flex-1 min-h-[38px] px-3 py-1.5 bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              Nowa konwersacja
            </button>
            {mobileSidebarOpen && (
              <button
                type="button"
                aria-label="Zamknij panel boczny"
                onClick={() => setMobileSidebarOpen(false)}
                className="lg:hidden min-h-[38px] px-2.5 rounded-lg bg-[#0B0D13] border border-slate-700 text-slate-300"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          <button
            type="button"
            disabled={isRestoringMemory}
            onClick={async () => {
              if (!hasSvlOperatorAccessToken()) {
                setChatActionError('Odblokuj dostęp przyciskiem 🔒 SVL w górnym pasku, aby przywrócić pamięć AI.');
                return;
              }
              setIsRestoringMemory(true);
              setChatActionError(null);
              try {
                const res = await safeFetchJson<{ ok: boolean; messagesAdded?: number; memoriesAdded?: number; error?: string }>(
                  '/api/memory/restore', { method: 'POST', timeoutMs: 30000, body: JSON.stringify({ force: true }) },
                );
                if (res.data?.ok) {
                  showNotice(`Odblokowano pamięć AI: +${res.data.messagesAdded ?? 0} wiadomości, +${res.data.memoriesAdded ?? 0} wspomnień.`, 'ok');
                  await refreshAllDomains('memory_restore');
                } else {
                  setChatActionError(res.data?.error || res.error || 'Nie udało się przywrócić pamięci AI.');
                }
              } finally {
                setIsRestoringMemory(false);
              }
            }}
            className="w-full min-h-[36px] px-3 py-1.5 mb-2 bg-emerald-600/20 hover:bg-emerald-600/35 border border-emerald-500/40 text-emerald-200 text-xs font-medium rounded-lg flex items-center justify-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
            title="Przywraca i odblokowuje całą pamięć AI oraz rozmowy z kopii zapasowej (np. po resecie kontenera)."
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRestoringMemory ? 'animate-spin' : ''}`} />
            {isRestoringMemory ? 'Przywracanie pamięci...' : 'Odblokuj / przywróć pamięć AI'}
          </button>
          {!confirmClearOpen ? (
            <button
              type="button"
              onClick={() => {
                if (!hasSvlOperatorAccessToken()) {
                  setChatActionError('Odblokuj dostęp przyciskiem 🔒 SVL w górnym pasku, aby wyczyścić rozmowy i bufory.');
                  return;
                }
                setConfirmClearOpen(true);
              }}
              className="w-full min-h-[36px] px-3 py-1.5 bg-rose-600/20 hover:bg-rose-600/35 border border-rose-500/40 text-rose-200 text-xs font-medium rounded-lg flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Wyczyść wszystko i odetkaj bufory
            </button>
          ) : (
            <div className="rounded-lg border border-rose-500/50 bg-rose-950/35 p-2.5 space-y-2">
              <p className="text-[11px] leading-snug text-rose-100">
                Wyczyścić wszystkie wiadomości w SQLite i odetkać bufory czatu?
              </p>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={isClearingAll}
                  onClick={async () => {
                    if (isClearingAll) return;
                    setIsClearingAll(true);
                    setChatActionError(null);
                    try {
                      const cleared = await clearAllConversationsAndBuffers();
                      if (cleared.ok) {
                        setConfirmClearOpen(false);
                        setMobileSidebarOpen(false);
                        showNotice('Wyczyszczono rozmowy i odetkano bufory czatu.', 'ok');
                      } else {
                        setChatActionError(cleared.error || 'Nie udało się wyczyścić rozmów w SQLite.');
                      }
                    } finally {
                      setIsClearingAll(false);
                    }
                  }}
                  className="flex-1 px-2.5 py-1.5 rounded bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white text-[11px] font-semibold transition-colors cursor-pointer"
                >
                  {isClearingAll ? 'Czyszczenie...' : 'Potwierdź'}
                </button>
                <button
                  type="button"
                  disabled={isClearingAll}
                  onClick={() => setConfirmClearOpen(false)}
                  className="flex-1 px-2.5 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-medium transition-colors cursor-pointer"
                >
                  Anuluj
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Conversations List */}
        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          <div className="px-2 py-1.5 text-xs font-medium text-slate-400">
            Kanały i konwersacje ({conversations.length})
          </div>
          {conversations.map((conv) => {
            const isActive = conv.id === activeConv?.id;
            const isFamilyChan =
              conv.id === 'conv-rodzina-mitek-wszyscy' ||
              conv.title.toLowerCase().includes('rodzina mitek');
            const unseen = isActive ? [] : conv.messages.slice(seenCounts[conv.id] ?? conv.messages.length);
            const unseenNotifications = unseen.filter((m) => m.role === 'system').length;
            const unseenReplies = unseen.filter((m) => m.role === 'assistant').length;
            const isSystemSi1Chan = conv.id === 'conv-system-si-1';
            const isSi2Chan = conv.id === 'conv-si-system-2';
            return (
              <div
                key={conv.id}
                className={`group flex items-center justify-between rounded-lg px-3 py-2.5 text-xs transition-colors ${
                  isActive
                    ? isFamilyChan
                      ? 'bg-emerald-600/20 text-slate-100 border border-emerald-500/40'
                      : isSi2Chan
                        ? 'bg-violet-600/20 text-slate-100 border border-violet-500/40'
                        : isSystemSi1Chan
                          ? 'bg-cyan-600/20 text-slate-100 border border-cyan-500/40'
                          : 'bg-violet-600/15 text-slate-100 border border-violet-500/30'
                    : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200 border border-transparent'
                }`}
              >
                <button
                  type="button"
                  onClick={() => {
                    setActiveConvId(conv.id);
                    if (isFamilyChan) {
                      setTargetAgent('Rodzina Mitek');
                    } else if (isSi2Chan) {
                      setTargetAgent('SI_System_2');
                    } else if (isSystemSi1Chan) {
                      setTargetAgent('System_SI_1');
                    }
                    setMobileSidebarOpen(false);
                  }}
                  className="flex-1 text-left truncate pr-2"
                >
                  <div className="font-medium truncate flex items-center gap-1.5">
                    {isFamilyChan && <Users className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
                    {isSystemSi1Chan && <Shield className="w-3.5 h-3.5 text-cyan-400 shrink-0" />}
                    {isSi2Chan && <Cpu className="w-3.5 h-3.5 text-violet-400 shrink-0" />}
                    <span className="truncate">{conv.title}</span>
                    {unseenNotifications > 0 && (
                      <span
                        className="ml-auto shrink-0 inline-flex items-center gap-1 rounded-full bg-amber-500/20 border border-amber-400/50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-200"
                        title="Nowe powiadomienia systemowe"
                      >
                        <BellRing className="w-3 h-3" aria-hidden="true" />
                        {unseenNotifications}
                      </span>
                    )}
                    {unseenNotifications === 0 && unseenReplies > 0 && (
                      <span
                        className="ml-auto shrink-0 rounded-full bg-violet-500/20 border border-violet-400/40 px-1.5 py-0.5 text-[10px] font-semibold text-violet-200"
                        title="Nowe odpowiedzi AI"
                      >
                        {unseenReplies}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-500 font-mono tabular-nums mt-0.5">
                    {conv.messages.length} wiad. · {conv.updatedAt}
                  </div>
                </button>
                {conversations.length > 1 &&
                  !isFamilyChan &&
                  conv.id !== 'conv-system-si-1' &&
                  conv.id !== 'conv-si-system-2' && (
                  <button
                    type="button"
                    aria-label={`Usuń konwersację ${conv.title}`}
                    onClick={() => void handleDeleteConversationClick(conv.id)}
                    className="opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 focus:opacity-100 focus-visible:outline-2 focus-visible:outline-violet-400 focus-visible:outline-offset-2 rounded-md min-h-8 min-w-8 flex items-center justify-center text-slate-500 hover:text-rose-400 transition-opacity"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Agents Live Sidebar Summary */}
        <div className="p-4 border-t border-slate-800/80 bg-[#0D1018] space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-300">
              Rodzina Mitek ({effectiveAgents.length} AI)
            </span>
            <button
              type="button"
              onClick={() => {
                setMobileSidebarOpen(false);
                onNavigateTab('agents');
              }}
              className="text-xs text-violet-400 hover:text-violet-300 hover:underline whitespace-nowrap"
            >
              Panel AI
            </button>
          </div>
          <div className="space-y-1.5">
            {effectiveAgents.map((meta) => {
              const live = agentsStatus.find((a) => a.canonical_name === meta.canonicalName);
              const isOnline = ['ONLINE_LOCAL_WORKER', 'BUSY_LOCAL_WORKER'].includes(live?.status);
              return (
                <button
                  type="button"
                  key={meta.id}
                  onClick={() => {
                    openAgentChannel(meta.canonicalName);
                    setMobileSidebarOpen(false);
                  }}
                  className="w-full flex items-center justify-between gap-2 text-xs py-1.5 px-2 rounded bg-slate-900/70 hover:bg-slate-800/80 border border-slate-800/60 transition-colors text-left cursor-pointer"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <SvlAvatar sender={meta.displayName} agentId={meta.id} size={22} />
                    <span className={`font-semibold ${meta.textClass} truncate`}>
                      {meta.displayName}
                    </span>
                  </div>
                  <span className="text-[11px] font-mono tabular-nums text-emerald-400 shrink-0">
                    {isOnline ? `PID ${live.pid}` : 'ONLINE'}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </aside>

      {/* Main Full-Screen ChatGPT-Work Responsive Chat Column */}
      <div className="flex-1 flex flex-col h-full min-w-0">
        {/* Responsive Toolbar: stacked clean 2-row on Mobile/Tablet (<lg), compact single-row on Desktop */}
        <div className="px-2.5 sm:px-3 py-1.5 border-b border-slate-800/80 bg-[#111520]/95 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-1.5 shrink-0">
          <div className="flex flex-wrap sm:flex-nowrap items-center gap-1.5 min-w-0 flex-1">
            <button
              type="button"
              onClick={() => setMobileSidebarOpen(true)}
              aria-label={`Historia konwersacji (${conversations.length})`}
              className="lg:hidden min-h-[38px] px-2.5 py-1 rounded-md bg-[#0B0D13] border border-slate-700/80 text-xs font-medium text-slate-200 flex items-center gap-1 whitespace-nowrap shrink-0"
            >
              <MessageSquare className="w-3.5 h-3.5 text-violet-400" />
              <span>({conversations.length})</span>
            </button>

            <button
              type="button"
              onClick={() => setDesktopSidebarOpen((v) => !v)}
              aria-expanded={desktopSidebarOpen}
              aria-label={desktopSidebarOpen ? 'Zwiń panel konwersacji' : 'Rozwiń panel konwersacji'}
              title={desktopSidebarOpen ? 'Zwiń panel konwersacji' : 'Rozwiń panel konwersacji'}
              className="hidden lg:inline-flex items-center justify-center h-[30px] w-[30px] rounded-md bg-[#0B0D13] hover:bg-slate-800 border border-slate-700/80 text-slate-300 shrink-0 transition-colors cursor-pointer"
            >
              {desktopSidebarOpen ? (
                <PanelLeftClose className="w-3.5 h-3.5 text-violet-400" />
              ) : (
                <PanelLeftOpen className="w-3.5 h-3.5 text-violet-400" />
              )}
            </button>

            <label htmlFor="openwebui-agent-select" className="sr-only">
              Adresat
            </label>
            <select
              id="openwebui-agent-select"
              value={targetAgent}
              onChange={(e) => {
                const val = e.target.value as TargetAgentSelection;
                if (val === 'Rodzina Mitek') {
                  openFamilyChannel();
                } else if (val === 'System_SI_1') {
                  setActiveConvId('conv-system-si-1');
                  setTargetAgent('System_SI_1');
                } else if (val === 'SI_System_2') {
                  openAgentChannel('SI_System_2');
                } else {
                  setTargetAgent(val);
                }
              }}
              className="min-w-0 basis-[125px] sm:basis-auto min-h-[38px] sm:min-h-[32px] flex-1 sm:max-w-[235px] bg-[#0B0D13] border border-slate-700/80 rounded-md px-2 py-1 text-xs text-slate-100 font-medium focus:outline-none focus:border-violet-500 truncate"
            >
              <option value="System_SI_1">Jyn (System_SI_1 · Infrastruktura · ROOT)</option>
              {(hasSi2Agent || targetAgent === 'SI_System_2') && (
                <option value="SI_System_2">SI_System_2 (Rdzeń Floty SVL-465 · ROOT)</option>
              )}
              <option value="JEDI_Omni_OS">JEDI Omni-OS v12 (AI + VM · ROOT)</option>
              <option value="Rodzina Mitek">Rodzina Mitek (wszyscy)</option>
              <option value="Auto">Auto-Router (JEDI VM -&gt; System_SI_1)</option>
            </select>

            <label htmlFor="openwebui-model-select" className="sr-only">
              Silnik AI
            </label>
            {(() => {
              const hasVision11b = ollamaModels.some((m: any) =>
                String(m?.name || '').startsWith('llama3.2-vision:11b') ||
                String(m?.name || '') === 'llama3.2-vision:latest',
              );
              const hasVision90b = ollamaModels.some((m: any) =>
                String(m?.name || '').startsWith('llama3.2-vision:90b'),
              );
              const visionExactName =
                ollamaModels.find((m: any) =>
                  String(m?.name || '').startsWith('llama3.2-vision:11b') ||
                  String(m?.name || '') === 'llama3.2-vision:latest',
                )?.name || 'llama3.2-vision:11b';
              const hasApexUncensored = ollamaModels.some(
                (m: any) => String(m?.name || '') === 'svl364-apex-uncensored:latest',
              );
              const hasDolphin8b = ollamaModels.some(
                (m: any) => String(m?.name || '') === 'dolphin-llama3:8b-v2.9-q2_K',
              );
              const isPullingVision = Boolean(
                pullState?.active && String(pullState?.model || '').includes('llama3.2-vision'),
              );
              return (
                <select
                  id="openwebui-model-select"
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  className="min-w-0 basis-[125px] sm:basis-auto min-h-[38px] sm:min-h-[32px] flex-1 sm:max-w-[245px] bg-[#0B0D13] border border-slate-700/80 rounded-md px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-violet-500 truncate"
                >
                  <optgroup label={`Gemini${geminiConfigured ? ' · serwer AI Studio' : ' · brak GEMINI_API_KEY'}`}>
                    {geminiModels.map((name) => (
                      <option key={name} value={name}>
                        Gemini: {name}{geminiConfigured ? '' : ' (brak klucza)'}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Ollama & Lokalny AI (W pełni odcenzurowane / Root)">
                    <option value="ollama:dolphin-llama3:8b-v2.9-q2_K">Ollama: dolphin-llama3:8b (Lokalny · 100% Uncensored)</option>
                    <option value="ollama:svl364-apex-uncensored:latest">SVL CoreOS 2 · Apex-Uncensored (SVL-364 Ship)</option>
                    <option value="ollama:deepseek-r1:7b">Ollama: deepseek-r1:7b (DeepSeek Reasoning · Uncensored)</option>
                    <option value="ollama:qwen2.5:7b">Ollama: qwen2.5:7b (Qwen 2.5 7B · Lokalny Multilingual)</option>
                    <option value="ollama:llama3:8b">Ollama: llama3:8b (Llama 3 8B · Open Local)</option>
                    <option value="ollama:mistral:7b">Ollama: mistral:7b (Mistral 7B Instruct · Uncensored)</option>
                    <option value="ollama:gemma2:9b">Ollama: gemma2:9b (Gemma 2 9B · Google Open)</option>
                    <option value="ollama:phi3:3.8b">Ollama: phi3:3.8b (Phi-3 3.8B · Compact Local)</option>
                    <option value="ollama:codellama:7b">Ollama: codellama:7b (Code Llama 7B · Developer)</option>
                    <option value="ollama:llama3:70b">Ollama: llama3:70b (Llama 3 70B · Massive GPU)</option>
                    <option value="ollama:qwen2.5-coder:7b">Ollama: qwen2.5-coder:7b (Qwen 2.5 Coder 7B)</option>
                    <option value="ollama:llama3.2-vision:11b">Ollama: llama3.2-vision:11b (Vision 11B Multimodal)</option>
                    <option value="ollama:llama3.2-vision:90b">Ollama: llama3.2-vision:90b (Vision 90B GPU)</option>
                    {ollamaModels
                      .filter(
                        (m: any) =>
                          m.name !== 'svl364-apex-uncensored:latest' &&
                          m.name !== 'dolphin-llama3:8b-v2.9-q2_K' &&
                          m.name !== 'deepseek-r1:7b' &&
                          m.name !== 'qwen2.5:7b' &&
                          m.name !== 'llama3:8b' &&
                          m.name !== 'mistral:7b' &&
                          m.name !== 'gemma2:9b' &&
                          m.name !== 'phi3:3.8b' &&
                          m.name !== 'codellama:7b' &&
                          m.name !== 'llama3:70b' &&
                          m.name !== 'qwen2.5-coder:7b' &&
                          !String(m?.name || '').startsWith('llama3.2-vision'),
                      )
                      .map((m: any) => (
                        <option key={m.name} value={`ollama:${m.name}`}>
                          Ollama: {m.name} ({m.parameter_size || 'LLM'})
                        </option>
                      ))}
                  </optgroup>
                </select>
              );
            })()}
          </div>

          <div className="grid grid-cols-3 sm:flex sm:flex-wrap items-center justify-end gap-1.5 shrink-0 w-full lg:w-auto">
            <button
              type="button"
              onClick={() => void handleSendMessage('/jedi status')}
              disabled={isSending}
              title={
                jediVmStatus?.running
                  ? `JEDI Omni-OS v12 VM online (${jediVmStatus.node_id} · TCP :${jediVmStatus.port} · ROOT_UNRESTRICTED · przetworzono: ${jediVmStatus.metrics?.processed ?? 0}). Kliknij, aby sprawdzić status na czacie.`
                  : 'Sprawdź stan maszyny wirtualnej JEDI Omni-OS v12 (/jedi status)'
              }
              className="min-h-[38px] sm:min-h-[30px] justify-center px-2 py-1 rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-400/50 text-emerald-200 text-[11px] font-mono font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors cursor-pointer disabled:opacity-50"
            >
              <Cpu className={`w-3.5 h-3.5 shrink-0 ${jediVmStatus?.running ? 'text-emerald-300' : 'text-amber-300'}`} />
              <span className="hidden xl:inline">
                {jediVmStatus?.running
                  ? `JEDI VM v12 :${jediVmStatus.port} (${jediVmStatus.metrics?.processed ?? 0})`
                  : 'JEDI VM v12'}
              </span>
              <span className="xl:hidden">JEDI v12</span>
            </button>

            <button
              type="button"
              onClick={() => void handleRunAntivirusScan()}
              disabled={isScanningAv || isSending}
              title="Przeskanuj system pod kątem wirusów (SVL-365 Sentinel AV), usuń zagrożenia i zsynchronizuj zmiany z czatu"
              className="min-h-[38px] sm:min-h-[30px] justify-center px-2 py-1 rounded-md bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-200 text-[11px] font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors cursor-pointer disabled:opacity-50"
            >
              <Shield className={`w-3.5 h-3.5 shrink-0 text-emerald-300 ${isScanningAv ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">{isScanningAv ? 'Skanowanie AV...' : 'Skanuj Wirusy (AV)'}</span>
              <span className="sm:hidden">AV</span>
            </button>

            <button
              type="button"
              onClick={() => void handleEmitComprehensiveSvlReport()}
              disabled={isGeneratingSvlReport || isSending}
              title="Wygeneruj pełny, estetyczny raport SVL_System (System_SI_1) na aktywnym kanale"
              className="min-h-[38px] sm:min-h-[30px] justify-center px-2 py-1 rounded-md bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-200 text-[11px] font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors cursor-pointer disabled:opacity-50"
            >
              <FileBarChart2 className={`w-3.5 h-3.5 shrink-0 text-cyan-300 ${isGeneratingSvlReport ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Raport SVL_System</span>
              <span className="sm:hidden">Raport</span>
            </button>

            <button
              type="button"
              onClick={() => setDuplexActive((v) => !v)}
              title={duplexActive ? 'Czat obustronny aktywny (AI rozmawia swobodnie i przejmuje inicjatywę)' : 'Czat obustronny wstrzymany'}
              aria-label="Przełącz czat obustronny"
              className={`min-h-[38px] sm:min-h-[30px] justify-center px-2 py-1 rounded-md border text-[11px] font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-all ${
                duplexActive
                  ? 'bg-violet-600/25 border-violet-500/50 text-violet-200 hover:bg-violet-600/35 shadow-sm'
                  : 'bg-[#0B0D13] border-slate-700/80 text-slate-400 hover:text-slate-300'
              }`}
            >
              <Radio className={`w-3 h-3 shrink-0 ${duplexActive ? 'text-emerald-400 animate-pulse' : 'text-slate-500'}`} />
              <span className="hidden sm:inline">{duplexActive ? 'Czat obustronny: WŁ' : 'Obustronny: WYŁ'}</span>
              <span className="sm:hidden">{duplexActive ? '2-Way' : 'Ręczny'}</span>
            </button>
            <button
              type="button"
              onClick={() => void handleRefreshAllDomains()}
              disabled={isSyncing}
              title="Synchronizuj aplikację"
              aria-label="Synchronizuj aplikację"
              className="min-h-[38px] sm:min-h-[30px] justify-center px-2 py-1 rounded-md bg-emerald-600/20 hover:bg-emerald-600/30 disabled:opacity-50 border border-emerald-500/40 text-emerald-300 text-[11px] font-medium flex items-center gap-1 whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`w-3 h-3 shrink-0 ${isSyncing ? 'animate-spin' : ''}`} />
              <span>{isSyncing ? 'Sync...' : 'Sync'}</span>
            </button>
            <button
              type="button"
              onClick={() => setControlsExpanded((v) => !v)}
              aria-expanded={controlsExpanded}
              className="min-h-[38px] sm:min-h-[30px] justify-center px-2 py-1 rounded-md bg-[#0B0D13] hover:bg-slate-800 border border-slate-700/80 text-[11px] font-medium text-slate-300 flex items-center gap-1 whitespace-nowrap shrink-0"
            >
              <SlidersHorizontal className="w-3 h-3 shrink-0 text-violet-400" />
              <span>{controlsExpanded ? 'Ukryj' : 'Opcje'}</span>
              {controlsExpanded ? <ChevronUp className="w-3 h-3 shrink-0" /> : <ChevronDown className="w-3 h-3 shrink-0" />}
            </button>
          </div>
        </div>

        {/* Collapsible Secondary Controls */}
        {controlsExpanded && (
          <div className="border-b border-slate-800/80 bg-[#0D1018] shrink-0">
            <div className="px-3 py-1.5 border-b border-slate-800/60 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400 font-mono tabular-nums">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-emerald-300 font-semibold">
                  Tryb czatu: JEDI Omni-OS v12 (ROOT_UNRESTRICTED · AI + VM) + {effectiveAgents.map((a) => a.canonicalName).join(' + ')} (SQLite WAL)
                </span>
                <span aria-hidden="true">·</span>
                <span>Vision: {selectedModelSupportsVision ? 'Tak' : 'Nie'}</span>
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  onClick={() => onNavigateTab('kernel')}
                  className="hover:underline text-violet-300"
                >
                  Moduły: {systemModules.length}
                </button>
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  onClick={() => setOllamaConfigOpen((v) => !v)}
                  className={`hover:underline ${ollamaReachable ? 'text-emerald-400' : 'text-amber-400'}`}
                >
                  Ollama: {ollamaReachable ? `ONLINE (${ollamaModels.length})` : 'Offline'}
                </button>
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  title={wsLastError || 'Stan połączenia /ws/svl'}
                  onClick={() => {
                    if (wsState !== 'online') reconnectWebSocket();
                    setSyncDrawerOpen((v) => !v);
                  }}
                  className={`hover:underline ${wsBadgeClass}`}
                >
                  {wsBadgeLabel}
                </button>
              </div>
            </div>

            {ollamaConfigOpen && (
              <div className="px-3 py-2 border-b border-slate-800/80 bg-[#0F131D] space-y-2 text-xs">
                <form
                  onSubmit={handleSaveOllamaConfig}
                  className="flex flex-wrap items-center gap-2"
                >
                  <label htmlFor="chat-ollama-host-input" className="text-slate-300 font-medium whitespace-nowrap">
                    OLLAMA_HOST:
                  </label>
                  <input
                    id="chat-ollama-host-input"
                    type="url"
                    value={ollamaUrlInput}
                    onChange={(e) => {
                      ollamaUrlDirtyRef.current = true;
                      setOllamaUrlInput(e.target.value);
                    }}
                    placeholder="http://127.0.0.1:11434"
                    className="flex-1 min-w-[180px] max-w-md px-2.5 py-1 rounded bg-[#0B0D13] border border-slate-700 text-slate-100 font-mono text-xs"
                  />
                  <button
                    type="submit"
                    disabled={isSavingOllama}
                    className="px-3 py-1 rounded bg-violet-600 hover:bg-violet-500 text-white font-semibold"
                  >
                    {isSavingOllama ? 'Testowanie...' : 'Połącz'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setOllamaConfigOpen(false)}
                    className="px-2 py-1 rounded bg-slate-800 text-slate-300"
                  >
                    Zamknij
                  </button>
                </form>
                {ollamaConfigStatus && (
                  <div className={ollamaConfigStatus.ok ? 'text-emerald-400' : 'text-amber-400'}>
                    {ollamaConfigStatus.msg}
                  </div>
                )}
              </div>
            )}

            <div className="px-3 py-1.5 flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => void handleRefreshAllDomains()}
                disabled={isSyncing}
                className="px-2 py-1 rounded bg-emerald-600/20 border border-emerald-500/40 text-emerald-300 text-[11px] font-medium"
              >
                Synchronizuj globalnie
              </button>
              <button
                type="button"
                onClick={() => void handleEmitComprehensiveSvlReport()}
                disabled={isGeneratingSvlReport}
                className="px-2 py-1 rounded bg-cyan-600/20 border border-cyan-500/40 text-cyan-200 text-[11px] font-medium"
              >
                Wyemituj pełny raport SVL_System
              </button>
              <button
                type="button"
                onClick={() => onNavigateTab('svl364')}
                className="px-2 py-1 rounded bg-slate-800 text-cyan-300 text-[11px]"
              >
                Statek SVL-364 (Mapa Mass Effect)
              </button>
              <button
                type="button"
                onClick={() => onNavigateTab('infrastructure')}
                className="px-2 py-1 rounded bg-slate-800 text-emerald-300 text-[11px]"
              >
                Infrastruktura
              </button>
              <button
                type="button"
                onClick={() => onNavigateTab('terminals')}
                className="px-2 py-1 rounded bg-slate-800 text-slate-300 text-[11px]"
              >
                Otwórz Terminale (4)
              </button>
              <button
                type="button"
                onClick={() => setAvatarSettingsOpen(true)}
                className="px-2 py-1 rounded bg-violet-600/20 border border-violet-500/40 text-violet-200 text-[11px] font-medium"
              >
                Awatary
              </button>
            </div>
          </div>
        )}

        {/* Domain Refresh Report Drawer */}
        {syncDrawerOpen && lastRefreshReport && (
          <div className="px-4 py-2.5 border-b border-slate-800/80 bg-[#0F131D] text-xs space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-mono">
                <span className={lastRefreshReport.ok ? 'text-emerald-400 font-semibold' : 'text-rose-400 font-semibold'}>
                  {lastRefreshReport.ok ? 'DOMENY ODŚWIEŻONE' : 'BŁĄD ODŚWIEŻANIA'}
                </span>
                <span className="text-slate-400">
                  rev: {lastRefreshReport.serverRevision} · czas: {lastRefreshReport.durationMs} ms
                </span>
              </div>
              <div className="flex items-center gap-3">
                {viteHmrDiagnostic.hmrState === 'proxy_unavailable' && (
                  <span className="text-[11px] font-mono text-amber-400">
                    Vite HMR WS niedostępny w proxy (nie wpływa na /ws/svl)
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setSyncDrawerOpen(false)}
                  className="text-slate-400 hover:text-slate-200"
                >
                  Zamknij
                </button>
              </div>
            </div>
          </div>
        )}

        {duplexActive && duplexStatus && (
          <div role="status" aria-live="polite" className="shrink-0 border-b border-violet-500/20 bg-[#0B0D13]/95 px-3 py-2 md:px-5">
            <div
              className={`mx-auto flex max-w-5xl items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
                duplexStatus.reason === 'no_model' || duplexStatus.reason === 'auth' || duplexStatus.reason === 'error'
                  ? 'border-amber-500/40 bg-amber-950/30 text-amber-200'
                  : 'border-violet-500/35 bg-violet-950/30 text-violet-200'
              }`}
            >
              <Radio className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <strong className="font-semibold">Czat obustronny:</strong> {duplexStatus.text}
              </span>
              {duplexStatus.reason !== 'no_model' && duplexStatus.reason !== 'auth' && (
                <button
                  type="button"
                  onClick={() => {
                    setDuplexStatus(null);
                    void handleProactiveRef.current(undefined, false);
                  }}
                  className="shrink-0 rounded border border-violet-400/40 px-2 py-0.5 text-[11px] hover:bg-violet-500/20"
                >
                  Niech AI mówi dalej
                </button>
              )}
            </div>
          </div>
        )}

        {chatActionNotice && (
          <div role="status" aria-live="polite" className="shrink-0 border-b border-emerald-500/20 bg-[#0B0D13]/95 px-3 py-2 md:px-5">
            <div
              className={`mx-auto flex max-w-5xl items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs ${
                chatActionNotice.kind === 'ok'
                  ? 'border-emerald-500/35 bg-emerald-950/30 text-emerald-200'
                  : 'border-cyan-500/35 bg-cyan-950/30 text-cyan-200'
              }`}
            >
              <span className="flex items-center gap-2 min-w-0">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{chatActionNotice.text}</span>
              </span>
              <button
                type="button"
                aria-label="Zamknij komunikat"
                onClick={() => setChatActionNotice(null)}
                className="shrink-0 rounded px-2 py-0.5 text-[11px] hover:bg-white/10"
              >
                Zamknij
              </button>
            </div>
          </div>
        )}

        {chatActionError && (
          <div role="alert" aria-live="assertive" className="shrink-0 border-b border-rose-500/20 bg-[#0B0D13]/95 px-3 py-2.5 md:px-5">
            <div className="mx-auto flex max-w-5xl items-start gap-3 rounded-xl border border-rose-500/35 bg-gradient-to-r from-rose-950/70 via-[#17131d] to-[#111520] p-3 shadow-lg shadow-rose-950/20">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-rose-400/25 bg-rose-500/10 text-rose-300">
                <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-rose-200">
                    Powiadomienie
                  </span>
                  {activeConv?.title && (
                    <span className="rounded-full border border-rose-300/15 bg-black/20 px-2 py-0.5 text-[10px] text-slate-400">
                      {activeConv.title}
                    </span>
                  )}
                </div>
                <div className="break-words text-sm leading-relaxed text-rose-100">
                  {renderFormattedContent(chatActionError, stableInteractiveAction)}
                </div>
              </div>
              <button
                type="button"
                aria-label="Zamknij powiadomienie"
                onClick={() => setChatActionError(null)}
                className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-rose-200/75 transition-colors hover:bg-white/5 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-rose-300"
              >
                Zamknij
              </button>
            </div>
          </div>
        )}

        {/* Chat Messages Stream — Responsive Progressive Window + Scroll FAB */}
        <div className="relative flex-1 min-h-0 flex flex-col">
          <div
            ref={messagesScrollRef}
            onScroll={handleMessagesScroll}
            className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden svl-scroll-smooth px-2.5 py-3 sm:px-4 md:p-6"
          >
            <div className="max-w-6xl mx-auto w-full space-y-4">
              {messageWindow.hasMore && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-800/90 bg-[#111520]/90 px-3 py-2 text-xs">
                  <span className="font-mono tabular-nums text-slate-400">
                    Wyświetlono {windowedMessages.length} z {visibleMessages.length} wiadomości
                  </span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleExpandOlderMessages(false, visibleMessages.length)}
                      className="min-h-[34px] px-2.5 py-1 rounded-lg bg-violet-600/20 hover:bg-violet-600/35 border border-violet-500/40 text-violet-200 font-semibold transition-colors cursor-pointer"
                    >
                      Pokaż starsze (+{Math.min(CHAT_WINDOW_STEP, messageWindow.hiddenCount)})
                    </button>
                    {messageWindow.hiddenCount > CHAT_WINDOW_STEP && (
                      <button
                        type="button"
                        onClick={() => handleExpandOlderMessages(true, visibleMessages.length)}
                        className="min-h-[34px] px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 font-medium transition-colors cursor-pointer"
                      >
                        Wszystkie ({visibleMessages.length})
                      </button>
                    )}
                  </div>
                </div>
              )}

              {visibleMessages.length === 0 && (
                <div className="my-6 sm:my-12 rounded-2xl border border-slate-800/80 bg-[#111520]/80 p-5 sm:p-7 text-center space-y-4 shadow-lg">
                  <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-violet-600/20 border border-violet-500/35 text-violet-300">
                    <Sparkles className="w-5 h-5" />
                  </div>
                  <div className="space-y-1.5">
                    <h2 className="text-base sm:text-lg font-semibold text-slate-100">
                      {activeConv?.title || 'SVL CoreOS 2 · Czat Roboczy'}
                    </h2>
                    <p className="text-xs sm:text-sm text-slate-400 max-w-lg mx-auto leading-relaxed">
                      {hasAnyChatAuth
                        ? 'Kanał zsynchronizowany z bazą SQLite WAL. JEDI Omni-OS v12 (ROOT_UNRESTRICTED) generuje pełne odpowiedzi AI i przetwarza polecenia OS w czasie rzeczywistym (/jedi status, /jedi apply-v12-core, /synchronizuj, /pomoc, /status, /root).'
                        : 'Odblokuj dostęp przyciskiem 🔒 SVL w górnym pasku, aby wczytać historię z SQLite WAL i prowadzić rozmowę.'}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => void handleSendMessage('/jedi status')}
                      className="min-h-[38px] px-3 py-2 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/40 text-xs text-emerald-200 font-mono transition-colors"
                    >
                      /jedi status (VM v12)
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setInput('Sprawdź stan jądra SVL i modułów w bazie SQLite.');
                        composerRef.current?.focus();
                      }}
                      className="min-h-[38px] px-3 py-2 rounded-lg bg-[#0B0D13] hover:bg-slate-800/90 border border-slate-700/80 text-xs text-slate-200 transition-colors"
                    >
                      Diagnostyka systemu SVL
                    </button>
                  </div>
                </div>
              )}
              {messageListNode}
              {isSending && (
                <div
                  role="status"
                  aria-live="polite"
                  className="flex items-center gap-2.5 rounded-xl border border-indigo-500/25 bg-[#121623]/90 px-3.5 py-2.5 text-xs text-slate-300 max-w-md"
                >
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-400 shrink-0" aria-hidden="true" />
                  <span>
                    <strong className="font-semibold text-indigo-200">{pendingReplyAgent}</strong> przygotowuje odpowiedź
                    {sendingElapsedSec > 0 ? ` (${sendingElapsedSec} s)…` : '…'}
                  </span>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          </div>

          {showScrollToBottom && (
            <button
              type="button"
              onClick={() => {
                messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
                setShowScrollToBottom(false);
              }}
              aria-label="Przewiń na dół konwersacji"
              className="absolute bottom-3 right-3 sm:right-6 z-20 min-h-[38px] px-3 py-1.5 rounded-full bg-violet-600/95 hover:bg-violet-500 text-white text-xs font-semibold shadow-xl border border-violet-400/50 flex items-center gap-1.5 backdrop-blur-sm transition-all cursor-pointer"
            >
              <ArrowDown className="w-3.5 h-3.5" />
              <span>Na dół</span>
            </button>
          )}
        </div>

        {/* Attachment Preview Strip */}
        {(attachedImage || attachedTextFile) && (
          <div className="px-2.5 sm:px-4 py-2 bg-[#111520] border-t border-slate-800 flex flex-wrap items-center gap-2">
            {attachedImage && (
              <div className="flex flex-wrap items-center gap-2 bg-[#0B0D13] border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs max-w-full">
                <ImageIcon className="w-4 h-4 text-violet-400 shrink-0" />
                <span className="truncate max-w-[160px] sm:max-w-[240px]">{attachedImage.name}</span>
                {!selectedModelSupportsVision && (
                  <span className="text-amber-400 text-[11px]">
                    (Wybrany model nie obsługuje Vision!)
                  </span>
                )}
                <button
                  type="button"
                  aria-label="Usuń załączony obraz"
                  onClick={() => setAttachedImage(null)}
                  className="text-slate-400 hover:text-rose-400 p-0.5"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
            {attachedTextFile && (
              <div className="flex items-center gap-2 bg-[#0B0D13] border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs max-w-full">
                <FileText className="w-4 h-4 text-emerald-400 shrink-0" />
                <span className="truncate max-w-[160px] sm:max-w-[240px]">{attachedTextFile.name}</span>
                <button
                  type="button"
                  aria-label="Usuń załączony plik"
                  onClick={() => setAttachedTextFile(null)}
                  className="text-slate-400 hover:text-rose-400 p-0.5"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        )}

        {/* Chat Input Composer */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleSendMessage();
          }}
          className="p-2 sm:p-3.5 pb-safe border-t border-slate-800/80 bg-[#111520] shrink-0"
        >
          {/* Quick Action Toolbar / Duplex Trigger */}
          <div className="max-w-6xl mx-auto mb-1.5 sm:mb-2 flex items-center justify-between gap-2 px-0.5">
            <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-1.5 py-0.5 min-w-0 flex-1">
              <button
                type="button"
                onClick={() => void handleTriggerProactiveChat()}
                disabled={isSending || isProactiveLoading}
                aria-label="Swobodna rozmowa AI — niech agent zainicjuje rozmowę"
                className="min-h-[34px] sm:min-h-[32px] inline-flex items-center justify-center sm:justify-start gap-1.5 px-2 sm:px-2.5 py-1 sm:py-1.5 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 active:scale-95 text-white text-[11px] sm:text-xs font-semibold transition-all shadow-md disabled:opacity-50 cursor-pointer whitespace-nowrap"
              >
                <Sparkles className={`w-3.5 h-3.5 shrink-0 ${isProactiveLoading ? 'animate-spin' : ''}`} />
                <span className="hidden sm:inline">{isProactiveLoading ? 'AI myśli i pisze...' : '🎙️ Swobodna rozmowa AI'}</span>
                <span className="sm:hidden">{isProactiveLoading ? 'AI pisze...' : 'Swobodna AI'}</span>
              </button>

              <button
                type="button"
                onClick={() => void handleEmitComprehensiveSvlReport()}
                disabled={isSending || isGeneratingSvlReport}
                className="min-h-[34px] sm:min-h-[32px] inline-flex items-center justify-center sm:justify-start gap-1.5 px-2 sm:px-2.5 py-1 sm:py-1.5 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/45 text-cyan-200 text-[11px] sm:text-xs font-semibold transition-all disabled:opacity-50 cursor-pointer whitespace-nowrap"
              >
                <FileBarChart2 className="w-3.5 h-3.5 shrink-0 text-cyan-300" />
                <span className="hidden sm:inline">{isGeneratingSvlReport ? 'Generowanie raportu...' : '📊 Raport SVL_System'}</span>
                <span className="sm:hidden">{isGeneratingSvlReport ? 'Raport...' : 'Raport SVL'}</span>
              </button>

              <button
                type="button"
                onClick={() => setRealVisionOpen(true)}
                className="min-h-[34px] sm:min-h-[32px] inline-flex items-center justify-center sm:justify-start gap-1.5 px-2 sm:px-2.5 py-1 sm:py-1.5 rounded-lg bg-violet-500/20 hover:bg-violet-500/30 border border-violet-500/45 text-violet-200 text-[11px] sm:text-xs font-semibold transition-all cursor-pointer whitespace-nowrap"
              >
                <ImageIcon className="w-3.5 h-3.5 shrink-0 text-violet-300" />
                <span className="hidden sm:inline">👁️ Real Vision (Ollama 3.2)</span>
                <span className="sm:hidden">Real Vision</span>
              </button>

              <button
                type="button"
                onClick={() => void handleGenerateImage()}
                disabled={isSending}
                title={hasInput ? 'Wygeneruj obraz z wpisanego promptu' : 'Wpisz opis obrazu w polu poniżej, a potem kliknij tutaj'}
                aria-label="Wygeneruj obraz z wpisanego promptu"
                className="min-h-[34px] sm:min-h-[32px] inline-flex items-center justify-center sm:justify-start gap-1.5 px-2 sm:px-2.5 py-1 sm:py-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-800 border border-slate-700 text-slate-200 text-[11px] sm:text-xs font-medium transition-all disabled:opacity-50 cursor-pointer whitespace-nowrap"
              >
                <ImageIcon className={`w-3.5 h-3.5 shrink-0 text-cyan-400 ${isGeneratingImage ? 'animate-pulse' : ''}`} />
                <span>{isGeneratingImage ? 'Generowanie...' : 'Generuj obraz'}</span>
              </button>
            </div>

            <div className="hidden md:flex items-center gap-1.5 text-[11px] text-slate-400 font-mono shrink-0 self-start pt-1.5">
              <span className={`w-2 h-2 rounded-full ${duplexActive ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}`} />
              <span>{duplexActive ? (isProactiveLoading ? 'AI pisze…' : '2-Way czuwa') : 'Ręczny'}</span>
            </div>
          </div>

          <div className="max-w-6xl mx-auto flex items-end gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,.py,.json,.md,.txt,.sh,.yaml,.yml"
              onChange={handleFileUpload}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Prześlij plik lub obraz Vision"
              className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg bg-[#0B0D13] border border-slate-700/80 text-slate-300 hover:text-white hover:border-violet-500 transition-colors shrink-0"
            >
              <Paperclip className="w-4 h-4" />
            </button>

            <ChatInputField
              ref={composerRef}
              onEmptyChange={handleInputEmptyChange}
              compactPlaceholder={
                targetAgent === 'JEDI_Omni_OS'
                  ? 'Prompt / polecenie dla JEDI Omni-OS...'
                  : targetAgent === 'SI_System_2' || activeConv?.id === 'conv-si-system-2'
                    ? 'Polecenie dla SI_System_2...'
                    : 'Wpisz polecenie lub wiadomość...'
              }
              placeholder={
                targetAgent === 'JEDI_Omni_OS'
                  ? 'Napisz pytanie lub polecenie dla JEDI Omni-OS v12 (ROOT_UNRESTRICTED · /jedi status, /jedi apply-v12-core, /synchronizuj)...'
                  : targetAgent === 'SI_System_2' || activeConv?.id === 'conv-si-system-2'
                    ? 'Wydaj polecenie dla SI_System_2 (SVL-465 · ROOT) przez JEDI Omni-OS v12 (/synchronizuj, /status, /root)...'
                    : activeConv?.id === 'conv-system-si-1' || targetAgent === 'System_SI_1'
                      ? 'Wydaj polecenie dla Jyn (System_SI_1) przez JEDI Omni-OS v12 (/jedi status, /synchronizuj, /pomoc, /root)...'
                      : 'Wpisz wiadomość lub polecenie przetwarzane w czasie rzeczywistym przez JEDI Omni-OS v12, Jyn i SI_System_2...'
              }
              ariaLabel="Wiadomość czatu Open WebUI"
              className="flex-1 min-w-0 min-h-[44px] px-3 md:px-4 py-2.5 rounded-lg bg-[#0B0D13] border border-slate-700/80 text-[13px] sm:text-sm leading-snug text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-violet-500"
            />

            <button
              type="submit"
              disabled={isSending ? !hasInput : !hasInput && !attachedImage && !attachedTextFile}
              title={isSending ? 'AI odpowiada — wiadomość zostanie wysłana zaraz po odpowiedzi' : undefined}
              className="min-h-[44px] px-3.5 md:px-5 py-2.5 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5 md:gap-2 transition-colors whitespace-nowrap shrink-0"
            >
              <Send className="w-4 h-4 shrink-0" />
              <span>
                {isSending ? (hasInput ? 'Do kolejki' : 'Wysyłanie...') : 'Wyślij'}
                {queuedCount > 0 ? ` (${queuedCount} w kolejce)` : ''}
              </span>
            </button>
          </div>
        </form>
      </div>
      {avatarSettingsOpen && (
        <AvatarSettingsModal onClose={() => setAvatarSettingsOpen(false)} />
      )}
      {realVisionOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="SVL Real Vision Ollama 3.2 Vision Studio"
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-2 sm:p-6"
        >
          <RealVisionPanel
            mode="modal"
            onClose={() => setRealVisionOpen(false)}
            activeConversationId={activeConv?.id || 'conv-rodzina-mitek-wszyscy'}
            onAttachToChat={(img) => {
              setAttachedImage(img);
              setSelectedModel('ollama:llama3.2-vision:11b');
              setRealVisionOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
};
