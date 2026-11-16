import React, { useState, useRef, useEffect } from 'react';
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
  Rocket,
  Brain,
  FileBarChart2,
  Shield,
  KeyRound,
} from 'lucide-react';
import {
  CANONICAL_AGENTS,
  SyncableMessage,
  buildChatHistoryPayload,
  createUniqueId,
  formatAgentDisplayName,
  isUnsafeChatInteractiveAction,
  parseBielikChatCommand,
  safeFetchJson,
  getSvlCodexAccessToken,
  getSvlOperatorAccessToken,
  hasSvlCodexAccessToken,
  hasSvlOperatorAccessToken,
  setSvlCodexAccessToken,
  setSvlOperatorAccessToken,
  validateOllamaHostUrl,
} from '../utils/svlLogic';
import { useSvlSync, getCanonicalConversationTitle } from '../utils/svlSyncStore';
import { AvatarSettingsModal, SvlAvatar } from './AgentAvatar';
import { RealVisionPanel } from './RealVisionPanel';
import { renderFormattedContent, renderFormattedLine } from './ChatContentRenderer';

export { renderFormattedContent, renderFormattedLine };
export type ChatMessage = SyncableMessage;

interface ChatWorkspaceProps {
  onNavigateTab: (tab: 'chat' | 'svl364' | 'infrastructure' | 'agents' | 'terminals' | 'kernel' | 'linux') => void;
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

  const [input, setInput] = useState('');
  const [selectedModel, setSelectedModel] = useState('svl-hybrid-router');
  const [codexAccessInput, setCodexAccessInput] = useState(() => getSvlCodexAccessToken());
  const [codexStatus, setCodexStatus] = useState<{
    checking: boolean;
    enabled?: boolean;
    authenticated?: boolean;
    runtimeLoggedIn?: boolean;
    model?: string | null;
    reason?: string | null;
    message?: string | null;
  }>({ checking: false });
  const [isSending, setIsSending] = useState(false);
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);
  const [isGeneratingSvlReport, setIsGeneratingSvlReport] = useState(false);
  const [isScanningAv, setIsScanningAv] = useState(false);
  const sendingRef = useRef(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [controlsExpanded, setControlsExpanded] = useState(false);
  const [attachedImage, setAttachedImage] = useState<{ base64: string; mimeType: string; name: string } | null>(null);
  const [attachedTextFile, setAttachedTextFile] = useState<{ name: string; content: string } | null>(null);
  const [syncDrawerOpen, setSyncDrawerOpen] = useState(false);
  const [avatarSettingsOpen, setAvatarSettingsOpen] = useState(false);
  const [realVisionOpen, setRealVisionOpen] = useState(false);
  const [chatActionError, setChatActionError] = useState<string | null>(null);

  // Ollama connection panel & pull state
  const [ollamaConfigOpen, setOllamaConfigOpen] = useState(false);
  const [ollamaUrlInput, setOllamaUrlInput] = useState('http://127.0.0.1:11434');
  const ollamaUrlDirtyRef = useRef(false);
  const [ollamaConfigStatus, setOllamaConfigStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [isSavingOllama, setIsSavingOllama] = useState(false);
  const [pullState, setPullState] = useState<any>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const inputFieldRef = useRef<HTMLInputElement | null>(null);
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const prevMsgCountRef = useRef<number>(0);

  const [duplexActive, setDuplexActive] = useState(false);
  const [isProactiveLoading, setIsProactiveLoading] = useState(false);
  // Dlaczego rozmowa obustronna stoi (powód z serwera) — pokazywane zamiast cichego zatrzymania.
  const [duplexStatus, setDuplexStatus] = useState<{ reason: string; text: string } | null>(null);
  const lastInteractionTimeRef = useRef<number>(Date.now());
  const autoTurnsRef = useRef<number>(0);
  const prevDuplexActiveRef = useRef<boolean>(duplexActive);
  const inputValueRef = useRef<string>(input);
  inputValueRef.current = input;

  const activeConv = conversations.find((c) => c.id === activeConvId) || conversations[0];

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
    if (msgCount === prevCount && !isSending) return;

    const container = messagesScrollRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom < 180 || isSending) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [activeConv?.id, activeConv?.messages.length, isSending]);

  useEffect(() => {
    lastInteractionTimeRef.current = Date.now();
  }, [activeConv?.id, activeConv?.messages.length]);

  useEffect(() => {
    autoTurnsRef.current = 0;
  }, [activeConv?.id]);

  const handleTriggerProactiveChat = async (agentOverride?: string, autonomous = false) => {
    if (sendingRef.current || isSending || isProactiveLoading || !activeConv) return;
    if (!autonomous) {
      autoTurnsRef.current = 0;
    }
    setIsProactiveLoading(true);
    setChatActionError(null);
    lastInteractionTimeRef.current = Date.now();
    try {
      const chosenTarget = agentOverride || 'Auto';
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
        timeoutMs: 30000,
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
        await refreshDomainModules(['chat']);
        notifyLocalMutation('chat', activeConv.id, res.data.serverRevision);
      } else if (res.data?.skipped && res.data.reason) {
        // 'busy' = inna karta właśnie pisze; jej wiadomość przyjdzie przez synchronizację.
        if (res.data.reason !== 'busy') {
          setDuplexStatus({ reason: res.data.reason, text: res.data.error || res.data.reason });
          // Przy ręcznym wywołaniu pasek trybu obustronnego może być ukryty — pokaż powód wprost.
          if (!autonomous) setChatActionError(res.data.error || res.data.reason);
        }
      } else if (!autonomous) {
        setChatActionError(`Błąd inicjacji rozmowy: ${res.error || res.data?.error || 'brak odpowiedzi'}`);
      }
    } finally {
      setIsProactiveLoading(false);
    }
  };

  const handleProactiveRef = useRef(handleTriggerProactiveChat);
  handleProactiveRef.current = handleTriggerProactiveChat;

  useEffect(() => {
    const justEnabled = !prevDuplexActiveRef.current && duplexActive;
    prevDuplexActiveRef.current = duplexActive;
    if (justEnabled) {
      autoTurnsRef.current = 0;
    }

    if (!duplexActive || !activeConv || isSending || isProactiveLoading || !hasSvlOperatorAccessToken()) {
      return;
    }
    // Limit tur AI pilnuje serwer (powód pauzy wraca w odpowiedzi); tu tylko bezpiecznik.
    const CLIENT_SAFETY_MAX_AUTO_TURNS = 12;
    if (autoTurnsRef.current >= CLIENT_SAFETY_MAX_AUTO_TURNS) {
      return;
    }
    if (duplexStatus && !justEnabled) {
      return;
    }

    const delayMs = justEnabled ? 2500 : autoTurnsRef.current === 0 ? 4000 : 7000;
    const timer = setTimeout(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (sendingRef.current || inputValueRef.current.trim().length > 0) return;
      if (!hasSvlOperatorAccessToken()) return;
      void handleProactiveRef.current(undefined, true);
    }, delayMs);

    return () => clearTimeout(timer);
  }, [duplexActive, duplexStatus, activeConv?.id, activeConv?.messages.length, isSending, isProactiveLoading, selectedModel]);

  // Nowa wiadomość (od Operatora lub z innej karty) albo zmiana kanału odblokowuje rozmowę.
  useEffect(() => {
    setDuplexStatus(null);
  }, [activeConv?.id, activeConv?.messages.length, duplexActive]);

  useEffect(() => {
    setSvlCodexAccessToken(codexAccessInput);
  }, [codexAccessInput]);

  useEffect(() => {
    if (selectedModel !== 'codex-cli') return;
    let cancelled = false;
    setCodexStatus((prev) => ({ ...prev, checking: true }));
    const timer = setTimeout(async () => {
      const res = await safeFetchJson<{
        ok: boolean;
        enabled?: boolean;
        authenticated?: boolean;
        runtimeLoggedIn?: boolean;
        model?: string | null;
        reason?: string | null;
        message?: string | null;
      }>('/api/codex-chat/status', {
        timeoutMs: 10000,
        maxRetries: 0,
      });
      if (cancelled) return;
      if (res.ok && res.data?.ok) {
        setCodexStatus({
          checking: false,
          enabled: res.data.enabled,
          authenticated: res.data.authenticated,
          runtimeLoggedIn: res.data.runtimeLoggedIn,
          model: res.data.model || null,
          reason: res.data.reason || null,
          message: res.data.message || null,
        });
        if (res.data.authenticated) {
          void refreshDomainModules(['chat']);
        }
      } else {
        setCodexStatus({
          checking: false,
          enabled: false,
          authenticated: false,
          runtimeLoggedIn: false,
          message: res.error || 'Nie udało się sprawdzić statusu Codex CLI.',
        });
      }
    }, codexAccessInput ? 250 : 20);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [selectedModel, codexAccessInput, refreshDomainModules]);

  const ollamaReachable = Boolean(healthData?.ollama?.daemon_reachable);
  const ollamaModels: any[] = healthData?.ollama?.models || [];
  const selectedModelSupportsVision =
    selectedModel !== 'codex-cli' &&
    (
      selectedModel === 'svl-hybrid-router' ||
      selectedModel.startsWith('gemini-') ||
      selectedModel.includes('llama3.2-vision') ||
      selectedModel.includes('vl') ||
      selectedModel.includes('vision')
    );

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
    if (!rep.ok) {
      setChatActionError(rep.error || 'Odświeżanie nie powiodło się.');
    }
  };

  const handleEmitComprehensiveSvlReport = async () => {
    if (isGeneratingSvlReport || isSending) return;
    setIsGeneratingSvlReport(true);
    setChatActionError(null);
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
          emitToIris: false,
          title: 'Pełny Raport Operacyjny SVL_System (host, moduły, pamięć)',
          category: 'svl_system',
          origin: tabOrigin,
        }),
      });
      if (res.ok && res.data?.ok) {
        await refreshDomainModules(['chat', 'modules', 'kernel']);
        notifyLocalMutation('chat', 'conv-rodzina-mitek-wszyscy', res.data.serverRevision);
      } else {
        setChatActionError(res.error || res.data?.error || 'Nie udało się wygenerować raportu SVL_System.');
      }
    } finally {
      setIsGeneratingSvlReport(false);
    }
  };

  const handleRunAntivirusScan = async () => {
    if (isScanningAv || isSending) return;
    setIsScanningAv(true);
    setChatActionError(null);
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
          emitToIris: false,
          origin: tabOrigin,
        }),
      });
      await refreshAllDomains('operator_antivirus_scan');
      await refreshDomainModules(['chat', 'modules', 'kernel', 'health', 'agents']);
      if (res.ok && res.data?.ok) {
        notifyLocalMutation('chat', 'conv-rodzina-mitek-wszyscy', res.data.serverRevision);
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
    const rawText = overrideText !== undefined ? overrideText : input;
    const trimmed = rawText.trim();
    const targetConvObj = overrideConvId
      ? conversations.find((c) => c.id === overrideConvId) || activeConv
      : activeConv;
    if ((!trimmed && !attachedImage && !attachedTextFile) || sendingRef.current || !targetConvObj) return;
    autoTurnsRef.current = 0;
    sendingRef.current = true;
    setIsSending(true);
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
        targetConvId === 'conv-rodzina-mitek-wszyscy' || targetConvId.startsWith('conv-agent-');
      const targetTitle = isPermanentChannel
        ? getCanonicalConversationTitle(targetConvId, targetConvObj.title)
        : targetConvObj.messages.length <= 1 && trimmed
          ? trimmed.slice(0, 42)
          : targetConvObj.title;

      const persistRes = await appendAndPersistChatMessage(targetConvId, targetTitle, selectedModel, userMsg);
      if (!persistRes.ok) {
        setChatActionError(`Błąd zapisu SQLite: ${persistRes.error || 'Nie zapisano wiadomości.'}`);
        return;
      }
      void refreshDomainModules(['modules', 'kernel'])
        .then((report) => {
          if (!report.ok) {
            setChatActionError(`Błąd synchronizacji zmian z czatu: ${report.error}`);
          }
        })
        .catch((error: unknown) => {
          setChatActionError(
            `Błąd synchronizacji zmian z czatu: ${error instanceof Error ? error.message : String(error)}`,
          );
        });

      if (overrideText === undefined) setInput('');
      const currentImage = attachedImage;
      setAttachedImage(null);
      setAttachedTextFile(null);

      const historyPayload = buildChatHistoryPayload(targetConvObj.messages, 16);

      const mentionsBielik = /(?:^|\s)@bielik\b/i.test(trimmed);
      const mentionsMaya = /(?:^|\s)@maya\b/i.test(trimmed);
      const isBielikChannel = targetConvId === 'conv-agent-bielik';
      const isMayaChannel = targetConvId === 'conv-agent-maya';
      const isBielikSlashCmd = Boolean(parseBielikChatCommand(trimmed));
      const isExplicitMaya = isMayaChannel || targetAgent === 'Maya' || mentionsMaya;
      const isExplicitBielik = !isExplicitMaya && (isBielikChannel || targetAgent === 'Bielik' || mentionsBielik || isBielikSlashCmd);

      const isFamilyDuplex =
        !isExplicitBielik &&
        !isExplicitMaya &&
        (targetConvId === 'conv-rodzina-mitek-wszyscy' ||
          targetConvObj.title.toLowerCase().includes('rodzina mitek') ||
          targetAgent === 'Rodzina Mitek' ||
          duplexActive);

      const effectiveTargetAgent = isExplicitMaya
        ? 'Maya'
        : isExplicitBielik
          ? 'Bielik'
          : isFamilyDuplex
            ? 'Rodzina Mitek'
            : targetAgent;

      const res = await safeFetchJson<any>('/api/chat', {
        method: 'POST',
        timeoutMs: 180000,
        body: JSON.stringify({
          message: fullPrompt,
          model: (isExplicitBielik || isExplicitMaya) && selectedModel === 'svl-hybrid-router'
            ? 'ollama:llama3.2-vision:11b'
            : selectedModel,
          targetAgent: effectiveTargetAgent,
          conversationId: targetConvId,
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

      const replyMsg: ChatMessage = {
        id: createUniqueId('asst'),
        role: 'assistant',
        sender: formatAgentDisplayName(data.sender || 'Asystent SVL'),
        agentId: data.agentId || 'assistant',
        modelUsed: data.modelUsed || selectedModel,
        timestamp: new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }),
        content: data.reply || 'Brak odpowiedzi z serwera.',
        connectionReport: data.connectionReport,
        appliedActions,
      };
      const replyPersist = await appendAndPersistChatMessage(targetConvId, targetTitle, selectedModel, replyMsg);
      if (!replyPersist.ok && replyPersist.error) {
        setChatActionError(`Błąd zapisu odpowiedzi w SQLite: ${replyPersist.error}`);
      }

      if (appliedActions || data.connectionReport) {
        notifyLocalMutation('module', 'chat', data.latestServerRevision || undefined);
        void refreshAllDomains('chat_command_applied');
      } else {
        void refreshDomainModules(['modules', 'agents', 'kernel', 'health', 'terminals', 'chat'])
          .then((report) => {
            if (!report.ok) {
              setChatActionError(`Błąd synchronizacji zmian z czatu: ${report.error}`);
            } else {
              setChatActionError((current) =>
                current?.startsWith('Błąd synchronizacji zmian z czatu:') ? null : current,
              );
            }
          })
          .catch((error: unknown) => {
            setChatActionError(
              `Błąd synchronizacji zmian z czatu: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
      }
    } catch (error: any) {
      setChatActionError(`Błąd wysyłania wiadomości: ${error?.message || String(error)}`);
    } finally {
      sendingRef.current = false;
      setIsSending(false);
    }
  };

  const handleGenerateImage = async () => {
    const prompt = input.trim();
    const targetConvObj = activeConv;
    if (!prompt || sendingRef.current || !targetConvObj) return;

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

      setInput('');
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

  const handleInteractiveAction = async (actionValue: string, label?: string) => {
    const val = actionValue.trim();
    if (!val) return;
    if (isUnsafeChatInteractiveAction(val)) {
      setChatActionError('Przyciski odpowiedzi AI nie mogą automatycznie uruchamiać powłoki. Wklej komendę ręcznie do terminala po sprawdzeniu.');
      return;
    }

    if (val.startsWith('tab:')) {
      const tabName = val.slice(4).trim();
      if (!['chat', 'svl364', 'infrastructure', 'agents', 'terminals', 'kernel', 'linux'].includes(tabName)) return;
      onNavigateTab(tabName as 'chat' | 'svl364' | 'infrastructure' | 'agents' | 'terminals' | 'kernel' | 'linux');
      return;
    }

    if (val === 'action:sync' || val === 'sync') {
      await handleRefreshAllDomains();
      return;
    }

    if (val.startsWith('send:')) {
      const textToSend = val.slice(5).trim();
      void handleSendMessage(textToSend);
      return;
    }

    let textToFill = val.startsWith('text:') ? val.slice(5).trim() : val;
    if (/^[a-z0-9_-]+$/i.test(textToFill) && label && !['action:sync', 'action:connect_ai'].includes(val)) {
      textToFill = label;
    }
    setInput(textToFill);
    inputFieldRef.current?.focus();
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

  const activeMemoriesCount = agentsStatus.reduce(
    (sum, a) => sum + Number(a?.memory_entries_count || 0),
    0,
  );
  const hasAnyChatAuth = hasSvlOperatorAccessToken() || (selectedModel === 'codex-cli' && hasSvlCodexAccessToken());
  const visibleMessages = (activeConv?.messages || []).filter((msg) => {
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
  });

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
          mobileSidebarOpen ? 'fixed inset-y-0 left-0 z-40 flex shadow-2xl' : 'hidden lg:flex'
        } w-72 shrink-0 flex-col border-r border-slate-800/80 bg-[#111520]`}
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
            onClick={async () => {
              if (window.confirm('Czy na pewno chcesz wyczyścić wszystkie wiadomości i odetkać bufory czatu?')) {
                const credential = getSvlOperatorAccessToken() ||
                  window.prompt('Podaj SVL_OPERATOR_TOKEN, aby wyczyścić historię wszystkich rozmów:') || '';
                if (credential) setSvlOperatorAccessToken(credential);
                const cleared = await clearAllConversationsAndBuffers();
                if (cleared.ok) setMobileSidebarOpen(false);
                else setChatActionError(cleared.error || 'Nie udało się wyczyścić rozmów w SQLite.');
              }
            }}
            className="w-full min-h-[36px] px-3 py-1.5 bg-rose-600/20 hover:bg-rose-600/35 border border-rose-500/40 text-rose-200 text-xs font-medium rounded-lg flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Wyczyść wszystko i odetkaj bufory
          </button>
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
            return (
              <div
                key={conv.id}
                className={`group flex items-center justify-between rounded-lg px-3 py-2.5 text-xs transition-colors ${
                  isActive
                    ? isFamilyChan
                      ? 'bg-emerald-600/20 text-slate-100 border border-emerald-500/40'
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
                    } else if (conv.id === 'conv-agent-bielik') {
                      setTargetAgent('Bielik');
                    } else if (conv.id === 'conv-agent-maya') {
                      setTargetAgent('Maya');
                    }
                    setMobileSidebarOpen(false);
                  }}
                  className="flex-1 text-left truncate pr-2"
                >
                  <div className="font-medium truncate flex items-center gap-1.5">
                    {isFamilyChan && <Users className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
                    <span className="truncate">{conv.title}</span>
                  </div>
                  <div className="text-[11px] text-slate-500 font-mono tabular-nums mt-0.5">
                    {conv.messages.length} wiad. · {conv.updatedAt}
                  </div>
                </button>
                {conversations.length > 1 && !isFamilyChan && !conv.id.startsWith('conv-agent-') && (
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
              Rodzina Mitek ({CANONICAL_AGENTS.length} AI)
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
            {CANONICAL_AGENTS.map((meta) => {
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
        {/* Responsive Toolbar: stacked clean 2-row on Android (<sm), compact single-row on Desktop (sm+) */}
        <div className="px-2.5 sm:px-3 py-1.5 border-b border-slate-800/80 bg-[#111520]/95 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1.5 shrink-0">
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            <button
              type="button"
              onClick={() => setMobileSidebarOpen(true)}
              aria-label={`Historia konwersacji (${conversations.length})`}
              className="lg:hidden min-h-[38px] sm:min-h-0 px-2.5 py-1 rounded-md bg-[#0B0D13] border border-slate-700/80 text-xs font-medium text-slate-200 flex items-center gap-1 whitespace-nowrap shrink-0"
            >
              <MessageSquare className="w-3.5 h-3.5 text-violet-400" />
              <span>({conversations.length})</span>
            </button>

            <label htmlFor="openwebui-agent-select" className="sr-only">
              Adresat
            </label>
            <select
              id="openwebui-agent-select"
              value={targetAgent}
              onChange={(e) => {
                const val = e.target.value as 'Auto' | 'Rodzina Mitek' | 'Bielik' | 'Maya';
                if (val === 'Rodzina Mitek') {
                  openFamilyChannel();
                } else {
                  setTargetAgent(val);
                }
              }}
              className="min-w-0 min-h-[38px] sm:min-h-0 flex-1 sm:max-w-[220px] bg-[#0B0D13] border border-slate-700/80 rounded-md px-2 py-1 text-xs text-slate-100 font-medium focus:outline-none focus:border-violet-500 truncate"
            >
              <option value="Rodzina Mitek">Rodzina Mitek (wszyscy)</option>
              <option value="Bielik">Bielik (3.2 Vision 11B · ROOT)</option>
              <option value="Maya">Maya (AI Statku SVL-364 · ROOT)</option>
              <option value="Auto">Auto-Router</option>
            </select>

            <label htmlFor="openwebui-model-select" className="sr-only">
              Silnik AI
            </label>
            <select
              id="openwebui-model-select"
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="min-w-0 min-h-[38px] sm:min-h-0 flex-1 sm:max-w-[235px] bg-[#0B0D13] border border-slate-700/80 rounded-md px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-violet-500 truncate"
            >
              <option value="svl-hybrid-router">
                SVL Hybrid Router ({ollamaReachable ? `Ollama (${ollamaModels.length}) + Gemini` : 'Auto'})
              </option>
              {ollamaModels.map((m: any) => (
                <option key={m.name} value={`ollama:${m.name}`}>
                  Ollama: {m.name} ({m.parameter_size || 'LLM'})
                </option>
              ))}
              <option value="gemini-4-hydrogen">Gemini 4 Hydrogen</option>
              <option value="gemini-3.1-flash-lite">Gemini 3.1 Flash-Lite</option>
              <option value="codex-cli">Codex CLI · konto ChatGPT</option>
            </select>
          </div>

          <div className="flex items-center justify-between sm:justify-end gap-1.5 shrink-0 overflow-x-auto no-scrollbar">
            <button
              type="button"
              onClick={() => void handleRunAntivirusScan()}
              disabled={isScanningAv || isSending}
              title="Przeskanuj system pod kątem wirusów (SVL-365 Sentinel AV), usuń zagrożenia i zsynchronizuj zmiany z czatu"
              className="min-h-[36px] sm:min-h-0 px-2.5 py-1 rounded-md bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-200 text-[11px] font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors cursor-pointer disabled:opacity-50"
            >
              <Shield className={`w-3.5 h-3.5 text-emerald-300 ${isScanningAv ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">{isScanningAv ? 'Skanowanie AV...' : 'Skanuj Wirusy (AV)'}</span>
              <span className="sm:hidden">AV</span>
            </button>

            <button
              type="button"
              onClick={() => void handleEmitComprehensiveSvlReport()}
              disabled={isGeneratingSvlReport || isSending}
              title="Wygeneruj pełny, estetyczny raport SVL_System (Bielik / System) na kanale wszyscy"
              className="min-h-[36px] sm:min-h-0 px-2.5 py-1 rounded-md bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-200 text-[11px] font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors cursor-pointer disabled:opacity-50"
            >
              <FileBarChart2 className={`w-3.5 h-3.5 text-cyan-300 ${isGeneratingSvlReport ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Raport SVL_System</span>
              <span className="sm:hidden">Raport</span>
            </button>

            <button
              type="button"
              onClick={() => setDuplexActive((v) => !v)}
              title={duplexActive ? 'Czat obustronny aktywny (AI rozmawia swobodnie i przejmuje inicjatywę)' : 'Czat obustronny wstrzymany'}
              aria-label="Przełącz czat obustronny"
              className={`min-h-[36px] sm:min-h-0 px-2 py-1 rounded-md border text-[11px] font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-all ${
                duplexActive
                  ? 'bg-violet-600/25 border-violet-500/50 text-violet-200 hover:bg-violet-600/35 shadow-sm'
                  : 'bg-[#0B0D13] border-slate-700/80 text-slate-400 hover:text-slate-300'
              }`}
            >
              <Radio className={`w-3 h-3 ${duplexActive ? 'text-emerald-400 animate-pulse' : 'text-slate-500'}`} />
              <span className="hidden sm:inline">{duplexActive ? 'Czat obustronny: WŁ' : 'Obustronny: WYŁ'}</span>
              <span className="sm:hidden">{duplexActive ? '2-Way' : 'Ręczny'}</span>
            </button>
            <button
              type="button"
              onClick={() => void handleRefreshAllDomains()}
              disabled={isSyncing}
              title="Synchronizuj aplikację"
              aria-label="Synchronizuj aplikację"
              className="min-h-[36px] sm:min-h-0 px-2 py-1 rounded-md bg-emerald-600/20 hover:bg-emerald-600/30 disabled:opacity-50 border border-emerald-500/40 text-emerald-300 text-[11px] font-medium flex items-center gap-1 whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`w-3 h-3 ${isSyncing ? 'animate-spin' : ''}`} />
              <span>{isSyncing ? 'Sync...' : 'Sync'}</span>
            </button>
            <button
              type="button"
              onClick={() => setControlsExpanded((v) => !v)}
              aria-expanded={controlsExpanded}
              className="min-h-[36px] sm:min-h-0 px-2 py-1 rounded-md bg-[#0B0D13] hover:bg-slate-800 border border-slate-700/80 text-[11px] font-medium text-slate-300 flex items-center gap-1 whitespace-nowrap shrink-0"
            >
              <SlidersHorizontal className="w-3 h-3 text-violet-400" />
              <span>{controlsExpanded ? 'Ukryj' : 'Opcje'}</span>
              {controlsExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
          </div>
        </div>

        {/* Codex CLI Access & External Host Status Bar (only when Codex CLI selected) */}
        {selectedModel === 'codex-cli' && (
          <div className="shrink-0 border-b border-cyan-500/30 bg-[#0C1320] px-3 py-2 text-xs flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2 min-w-0 flex-1">
              <label htmlFor="svl-codex-access-input" className="inline-flex items-center gap-1.5 text-cyan-300 font-semibold whitespace-nowrap">
                <KeyRound className="w-3.5 h-3.5" />
                <span>Dostęp SVL:</span>
              </label>
              <input
                id="svl-codex-access-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={codexAccessInput}
                onChange={(e) => setCodexAccessInput(e.target.value)}
                placeholder="SVL_CODEX_CHAT_ACCESS_TOKEN (tylko pamięć)"
                className="min-w-0 flex-1 max-w-xs min-h-[34px] bg-[#0B0D13] border border-slate-700 rounded-md px-2.5 py-1 text-xs text-slate-100 focus:outline-none focus:border-cyan-500"
              />
            </div>
            <div className="font-mono text-[11px] text-slate-300 flex flex-wrap items-center gap-2">
              {codexStatus.checking ? (
                <span className="text-amber-300">Sprawdzanie Codex CLI...</span>
              ) : !codexStatus.enabled ? (
                <span className="text-amber-300">
                  Codex CLI wyłączony na tym serwerze (wymagany host z SVL_CODEX_CHAT_ENABLED=true i zalogowanym ChatGPT OAuth)
                </span>
              ) : !codexStatus.authenticated ? (
                <span className="text-amber-300">Podaj kod Dostęp SVL, aby zweryfikować sesję Codex CLI</span>
              ) : codexStatus.runtimeLoggedIn ? (
                <span className="text-emerald-400">
                  Codex CLI ChatGPT OAuth: ZALOGOWANY ({codexStatus.model || 'domyślny'})
                </span>
              ) : (
                <span className="text-rose-400">
                  Codex CLI niezal.: {codexStatus.reason || 'zaloguj się przez `codex login` na hoście'}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Status Bar: Deep Long-Term Memory 128D + Local Ollama Daemon + SVL-364 Link */}
        <div className="shrink-0 border-b border-slate-800/70 bg-[#090D16] px-3 py-1.5 text-[11px] text-slate-400 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 font-mono">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
            <span className="flex items-center gap-1.5 text-emerald-300 font-medium truncate">
              <Brain className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span className="truncate">
                Pamięć 128D: AKTYWNA ({activeMemoriesCount} wspomnień SQLite WAL)
              </span>
            </span>
            <span aria-hidden="true" className="text-slate-600 hidden sm:inline">·</span>
            <span className={`${ollamaReachable ? 'text-cyan-300' : 'text-amber-300'} hidden sm:inline`}>
              Demon Ollama: {ollamaReachable ? `ONLINE 11434 (${ollamaModels.length} modeli)` : 'Offline (host)'}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => onNavigateTab('svl364')}
              className="text-cyan-400 hover:text-cyan-300 hover:underline flex items-center gap-1"
            >
              <Rocket className="w-3 h-3" />
              <span>SVL-364</span>
            </button>
          </div>
        </div>

        {/* Collapsible Secondary Controls */}
        {controlsExpanded && (
          <div className="border-b border-slate-800/80 bg-[#0D1018] shrink-0">
            <div className="px-3 py-1.5 border-b border-slate-800/60 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400 font-mono tabular-nums">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-emerald-300 font-semibold">Tryb czatu: SQLite WAL (Asystent SVL)</span>
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
                duplexStatus.reason === 'no_model'
                  ? 'border-amber-500/40 bg-amber-950/30 text-amber-200'
                  : 'border-violet-500/35 bg-violet-950/30 text-violet-200'
              }`}
            >
              <Radio className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <strong className="font-semibold">Czat obustronny:</strong> {duplexStatus.text}
              </span>
              {duplexStatus.reason !== 'no_model' && (
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
                  {renderFormattedContent(chatActionError, handleInteractiveAction)}
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

        {/* Chat Messages Stream — Fullscreen ChatGPT-Work Column */}
        <div ref={messagesScrollRef} className="flex-1 min-h-0 overflow-y-auto px-2.5 py-3 md:p-6">
          <div className="max-w-3xl mx-auto w-full space-y-4">
          {visibleMessages.length === 0 && (
            <div className="my-6 sm:my-12 rounded-2xl border border-slate-800/80 bg-[#111520]/80 p-5 sm:p-7 text-center space-y-4 shadow-lg">
              <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-violet-600/20 border border-violet-500/35 text-violet-300">
                <Sparkles className="w-5 h-5" />
              </div>
              <div className="space-y-1.5">
                <h2 className="text-base sm:text-lg font-semibold text-slate-100">
                  {activeConv?.title || 'SVL Python OS · Czat Roboczy'}
                </h2>
                <p className="text-xs sm:text-sm text-slate-400 max-w-lg mx-auto leading-relaxed">
                  {hasAnyChatAuth
                    ? 'Kanał zsynchronizowany z bazą SQLite WAL. Możesz prowadzić rozmowę z Bielikiem i wydawać mu polecenia (/pomoc, /status, /root).'
                    : 'Odblokuj dostęp przyciskiem 🔒 SVL w górnym pasku (lub Dostęp SVL dla Codex CLI), aby wczytać historię z SQLite WAL i prowadzić rozmowę.'}
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setInput('Sprawdź stan jądra SVL i modułów w bazie SQLite.');
                    inputFieldRef.current?.focus();
                  }}
                  className="px-3 py-2 rounded-lg bg-[#0B0D13] hover:bg-slate-800/90 border border-slate-700/80 text-xs text-slate-200 transition-colors"
                >
                  Diagnostyka systemu SVL
                </button>
              </div>
            </div>
          )}
          {visibleMessages.map((msg) => {
              const isUser = msg.role === 'user';
              const isNotification = msg.role === 'system';
              const isFamilyChannel = activeConv?.id === 'conv-rodzina-mitek-wszyscy';
              const formattedSender = isUser ? msg.sender : formatAgentDisplayName(msg.sender);
              const agentMeta = CANONICAL_AGENTS.find(
                (a) =>
                  a.canonicalName === msg.sender ||
                  a.displayName === formattedSender ||
                  a.id === msg.agentId,
              );

              return (
                <div
                  key={msg.id}
                  className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
                >
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 mb-1.5 px-1">
                    <SvlAvatar
                      sender={formattedSender}
                      agentId={isUser ? 'operator' : msg.agentId || agentMeta?.id}
                      size={26}
                    />
                    <span
                      className={`font-semibold ${
                        agentMeta
                          ? agentMeta.textClass
                          : isUser
                            ? 'text-violet-300'
                            : 'text-slate-200'
                      }`}
                    >
                      {formattedSender}
                    </span>
                    {msg.modelUsed && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono text-slate-500">{msg.modelUsed}</span>
                      </>
                    )}
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums text-slate-500">
                      {/^\d{4}-\d{2}-\d{2}T/.test(String(msg.timestamp || ''))
                        ? new Date(msg.timestamp).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })
                        : msg.timestamp}
                    </span>
                    {msg.sourceOrigin && (
                      <span
                        className="max-w-[120px] truncate font-mono text-slate-500/80"
                        title="Źródło zgłoszone przez klienta aplikacji. Identyfikator nie potwierdza tożsamości autora."
                      >
                        sesja: {msg.sourceOrigin.slice(0, 16)}
                      </span>
                    )}
                  </div>

                  <div
                    className={`max-w-4xl w-full rounded-xl p-4 border shadow-md ${
                      isUser
                        ? 'bg-violet-950/30 border-violet-500/35 text-slate-100 max-w-2xl'
                        : isNotification
                          ? isFamilyChannel
                            ? 'bg-gradient-to-br from-amber-950/45 via-[#171520] to-[#111520] border-amber-400/40 text-amber-50 shadow-lg shadow-amber-950/10'
                            : 'bg-amber-950/20 border-amber-500/40 text-amber-100'
                          : 'bg-[#111520] border-slate-800/90 text-slate-200'
                    }`}
                  >
                    {isNotification && (
                      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-amber-300/15 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-200/80">
                        <span className="inline-flex items-center gap-1.5">
                          <BellRing className="h-3.5 w-3.5" aria-hidden="true" />
                          {isFamilyChannel ? 'Powiadomienie · kanał grupowy' : 'Wiadomość systemowa'}
                        </span>
                        {isFamilyChannel && (
                          <span className="rounded-full border border-amber-200/20 bg-amber-200/5 px-2 py-0.5 text-[9px]">
                            Wszyscy
                          </span>
                        )}
                      </div>
                    )}
                    {msg.imagePreview && (
                      <div className="mb-3">
                        <img
                          src={msg.imagePreview}
                          alt={msg.fileName || 'Załączony obraz Vision'}
                          referrerPolicy="no-referrer"
                          className="max-h-56 rounded-lg border border-slate-700 object-contain"
                        />
                      </div>
                    )}

                    <div className="text-xs sm:text-sm break-words space-y-1">
                      {renderFormattedContent(msg.content, handleInteractiveAction)}
                    </div>

                    {msg.connectionReport && (
                      <div className="mt-4 pt-4 border-t border-slate-800 space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-emerald-400 flex items-center gap-1.5">
                            <CheckCircle2 className="w-4 h-4" />
                            Raport środowiska SVL_System
                          </span>
                          <button
                            type="button"
                            onClick={() => onNavigateTab('agents')}
                            className="px-3 py-1 bg-violet-600 hover:bg-violet-500 text-white rounded text-xs font-medium transition-colors whitespace-nowrap"
                          >
                            Przejdź do Panelu Agentów
                          </button>
                        </div>
                      </div>
                    )}

                    {Array.isArray(msg.appliedActions) && msg.appliedActions.length > 0 && (
                      <div className="mt-4 pt-3 border-t border-slate-800 space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-emerald-400 flex items-center gap-1.5">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            Zapisane zmiany w SQLite (czat -&gt; system):
                          </span>
                          <button
                            type="button"
                            onClick={() => onNavigateTab('kernel')}
                            className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-violet-300 text-[11px] font-medium whitespace-nowrap"
                          >
                            Otwórz Jądro SVL &amp; Sfera
                          </button>
                        </div>
                        <div className="space-y-1 font-mono text-[11px]">
                          {msg.appliedActions.map((act, actIdx) => (
                            <div
                              key={`${act.entity}-${act.entityId}-${actIdx}`}
                              className={`flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5 rounded border ${
                                act.ok
                                  ? 'bg-emerald-950/20 border-emerald-500/30 text-emerald-200'
                                  : 'bg-rose-950/20 border-rose-500/30 text-rose-200'
                              }`}
                            >
                              <span className="font-semibold text-violet-300">
                                {act.entity}:{act.entityId}
                              </span>
                              <span className="flex-1 text-slate-300 truncate">{act.summary}</span>
                              <span className="tabular-nums text-slate-400">
                                {act.revision ? `rev ${act.revision} · ` : ''}
                                {act.ok ? 'OK' : 'ERR'}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Attachment Preview Strip */}
        {(attachedImage || attachedTextFile) && (
          <div className="px-4 py-2 bg-[#111520] border-t border-slate-800 flex items-center gap-3">
            {attachedImage && (
              <div className="flex items-center gap-2 bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-1.5 text-xs">
                <ImageIcon className="w-4 h-4 text-violet-400" />
                <span className="truncate max-w-[180px]">{attachedImage.name}</span>
                {!selectedModelSupportsVision && (
                  <span className="text-amber-400 text-[11px]">
                    (Wybrany model nie obsługuje Vision!)
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setAttachedImage(null)}
                  className="text-slate-400 hover:text-rose-400"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
            {attachedTextFile && (
              <div className="flex items-center gap-2 bg-[#0B0D13] border border-slate-700 rounded-lg px-3 py-1.5 text-xs">
                <FileText className="w-4 h-4 text-emerald-400" />
                <span className="truncate max-w-[180px]">{attachedTextFile.name}</span>
                <button
                  type="button"
                  onClick={() => setAttachedTextFile(null)}
                  className="text-slate-400 hover:text-rose-400"
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
          className="p-2.5 sm:p-3.5 border-t border-slate-800/80 bg-[#111520] shrink-0"
        >
          {/* Quick Action Toolbar / Duplex Trigger */}
          <div className="max-w-3xl mx-auto mb-2 flex items-center justify-between gap-2 px-0.5">
            <div className="flex items-center gap-1.5 overflow-x-auto sm:overflow-visible sm:flex-wrap py-0.5 no-scrollbar min-w-0 flex-1">
              <button
                type="button"
                onClick={() => void handleTriggerProactiveChat()}
                disabled={isSending || isProactiveLoading}
                aria-label="Swobodna rozmowa AI — niech agent zainicjuje rozmowę"
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 active:scale-95 text-white text-xs font-semibold transition-all shadow-md disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
              >
                <Sparkles className={`w-3.5 h-3.5 ${isProactiveLoading ? 'animate-spin' : ''}`} />
                <span>{isProactiveLoading ? 'AI myśli i pisze...' : '🎙️ Swobodna rozmowa AI'}</span>
              </button>

              <button
                type="button"
                onClick={() => void handleEmitComprehensiveSvlReport()}
                disabled={isSending || isGeneratingSvlReport}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/45 text-cyan-200 text-xs font-semibold transition-all disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
              >
                <FileBarChart2 className="w-3.5 h-3.5 text-cyan-300" />
                <span>{isGeneratingSvlReport ? 'Generowanie raportu...' : '📊 Raport SVL_System'}</span>
              </button>

              <button
                type="button"
                onClick={() => setRealVisionOpen(true)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-violet-500/20 hover:bg-violet-500/30 border border-violet-500/45 text-violet-200 text-xs font-semibold transition-all cursor-pointer whitespace-nowrap shrink-0"
              >
                <ImageIcon className="w-3.5 h-3.5 text-violet-300" />
                <span>👁️ Real Vision (Ollama 3.2)</span>
              </button>

              <button
                type="button"
                onClick={() => void handleGenerateImage()}
                disabled={isSending || !input.trim()}
                aria-label="Wygeneruj obraz z wpisanego promptu"
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs font-medium transition-all disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
              >
                <ImageIcon className={`w-3.5 h-3.5 text-cyan-400 ${isGeneratingImage ? 'animate-pulse' : ''}`} />
                <span>{isGeneratingImage ? 'Generowanie...' : 'Generuj obraz'}</span>
              </button>
            </div>

            <div className="hidden md:flex items-center gap-1.5 text-[11px] text-slate-400 font-mono shrink-0 self-start pt-1.5">
              <span className={`w-2 h-2 rounded-full ${duplexActive ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}`} />
              <span>{duplexActive ? (isProactiveLoading ? 'AI pisze…' : '2-Way czuwa') : 'Ręczny'}</span>
            </div>
          </div>

          <div className="max-w-3xl mx-auto flex items-center gap-2">
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

            <input
              ref={inputFieldRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                targetAgent === 'Bielik' || activeConv?.id === 'conv-agent-bielik'
                  ? 'Wydaj polecenie dla Bielik (/pomoc, /status, /root, /pamiec, /modul...) lub zadaj pytanie...'
                  : targetAgent === 'Maya' || activeConv?.id === 'conv-agent-maya'
                    ? 'Wydaj polecenie dla Maya (AI Statku SVL-364 · ROOT) lub zadaj pytanie...'
                    : 'Wpisz wiadomość, @Bielik, @Maya lub polecenie dla systemu SVL...'
              }
              aria-label="Wiadomość czatu Open WebUI"
              className="flex-1 min-w-0 min-h-[44px] px-3 md:px-4 py-2.5 rounded-lg bg-[#0B0D13] border border-slate-700/80 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-violet-500"
            />

            <button
              type="submit"
              disabled={isSending || (!input.trim() && !attachedImage && !attachedTextFile)}
              className="min-h-[44px] px-3.5 md:px-5 py-2.5 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5 md:gap-2 transition-colors whitespace-nowrap shrink-0"
            >
              <Send className="w-4 h-4" />
              <span>{isSending ? 'Wysyłanie...' : 'Wyślij'}</span>
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
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-3 md:p-6"
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
