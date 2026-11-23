import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  Bot,
  Compass,
  Cpu,
  Database,
  Gauge,
  HardDrive,
  Layers,
  Orbit,
  RadioTower,
  RefreshCw,
  Server,
  Shield,
  Sparkles,
  Terminal,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useSvlSync } from '../utils/svlSyncStore';
import { getEffectiveCanonicalAgents, getSvlOperatorAccessToken, hasSvlOperatorAccessToken, safeFetchJson, setSvlOperatorAccessToken } from '../utils/svlLogic';
import { RealVisionPanel } from './RealVisionPanel';

type WorkspaceTab = 'chat' | 'svl364' | 'infrastructure' | 'agents' | 'terminals' | 'kernel' | 'linux';

interface CenterProps {
  onNavigate: (tab: WorkspaceTab) => void;
}

/** Odpowiedź GET /api/py/svl364/telemetry — wyłącznie prawdziwe pomiary (null = brak danych). */
interface RealTelemetry {
  ok: boolean;
  collected_at: string;
  host: {
    hostname: string;
    os: string | null;
    kernel: string;
    architecture: string;
    uptime_sec: number | null;
    cpu: { percent: number | null; cores: number | null; model: string | null; mhz: number | null; load_avg: number[] | null };
    memory: {
      ram_total_mb: number | null;
      ram_available_mb: number | null;
      ram_used_mb: number | null;
      ram_percent: number | null;
      swap_total_mb: number | null;
      swap_used_mb: number | null;
    };
    disk: { path: string; total_gb?: number; free_gb?: number; percent?: number | null; error?: string };
    network: Array<{ interface: string; rx_bytes: number; tx_bytes: number; rx_bytes_per_sec: number | null; tx_bytes_per_sec: number | null }>;
    gpu: {
      available: boolean;
      reason: string | null;
      devices: Array<{ name: string; utilization_percent: number | null; memory_used_mb: number | null; memory_total_mb: number | null; temperature_c: number | null }>;
    };
    firewall: { tool: string; state: 'active' | 'inactive' | 'unknown' | 'not_installed'; detail: string | null; rules?: string[] };
  };
  services: {
    ollama: { url: string; reachable: boolean; latency_ms: number | null; version: string | null; synthetic: boolean; error: string | null };
    comfyui: { url: string; reachable: boolean; latency_ms: number | null; status_code: number | null; error: string | null };
    python_kernel: { reachable: boolean; pid: number; uptime_sec: number };
  };
  ssh_target: {
    alias: string;
    hostname: string | null;
    port: number | null;
    user: string | null;
    reachable: boolean;
    tcp_rtt_ms: number | null;
    error: string | null;
    checked_at: string;
  };
  ship: null | {
    alias: string;
    online: boolean;
    error: string | null;
    checked_at: string;
    hostname?: string | null;
    kernel?: string | null;
    uptime_sec?: number | null;
    load_avg?: number[] | null;
    cores?: number | null;
    ram_total_mb?: number | null;
    ram_available_mb?: number | null;
    disk_free_gb?: number | null;
  };
}

type LinkState = 'online' | 'degraded' | 'offline';

const NA = 'brak danych';
const fmtNum = (value: number | null | undefined, digits = 1, unit = '') =>
  typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(digits)}${unit}` : NA;
const fmtRate = (bytesPerSec: number | null | undefined) => {
  if (typeof bytesPerSec !== 'number') return NA;
  if (bytesPerSec >= 1024 ** 2) return `${(bytesPerSec / 1024 ** 2).toFixed(2)} MB/s`;
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${bytesPerSec.toFixed(0)} B/s`;
};
const fmtBytes = (bytes: number) =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
const fmtUptime = (sec: number | null | undefined) => {
  if (typeof sec !== 'number') return NA;
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d} d ${h} h ${m} min` : h > 0 ? `${h} h ${m} min` : `${m} min`;
};
const FIREWALL_LABEL: Record<RealTelemetry['host']['firewall']['state'], string> = {
  active: 'AKTYWNA',
  inactive: 'NIEAKTYWNA',
  unknown: 'STAN NIEZNANY',
  not_installed: 'NIE ZAINSTALOWANO',
};

export const Svl364CommandCenter: React.FC<CenterProps> = ({ onNavigate }) => {
  const {
    agentsData,
    healthData,
    systemModules,
    serverRevision,
    lastSyncedAt,
    wsState,
    lastRefreshReport,
    conversations,
    refreshDomainModules,
    refreshAllDomains,
    openAgentChannel,
    isSyncing,
  } = useSvlSync();

  const [selectedNodeId, setSelectedNodeId] = useState<string>('host');
  const [telemetry, setTelemetry] = useState<RealTelemetry | null>(null);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [chatStats, setChatStats] = useState<{ totalMessages: number; resetApplied: boolean; databaseName: string } | null>(null);
  const [runningCommit, setRunningCommit] = useState<string | null>(null);
  const [diagnosticsCheckedAt, setDiagnosticsCheckedAt] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isEmittingReport, setIsEmittingReport] = useState(false);
  const [isScanningAv, setIsScanningAv] = useState(false);
  const [reportFeedback, setReportFeedback] = useState<string | null>(null);
  const [logAccessToken, setLogAccessToken] = useState(() => getSvlOperatorAccessToken());
  useEffect(() => {
    const onTokenChanged = () => setLogAccessToken(getSvlOperatorAccessToken());
    window.addEventListener('svl-operator-token-changed', onTokenChanged);
    return () => window.removeEventListener('svl-operator-token-changed', onTokenChanged);
  }, []);
  const [runtimeLogs, setRuntimeLogs] = useState<
    Array<{
      timestamp: string;
      service: string;
      level: 'info' | 'error';
      message: string;
    }>
  >([]);
  const [runtimeLogsError, setRuntimeLogsError] = useState<string | null>(null);
  const [runtimeLogStatus, setRuntimeLogStatus] = useState<string | null>(null);
  const [loadingRuntimeLogs, setLoadingRuntimeLogs] = useState(false);

  const currentRevisionRef = useRef(serverRevision);
  const observabilityBusyRef = useRef(false);
  useEffect(() => {
    currentRevisionRef.current = serverRevision;
  }, [serverRevision]);

  const handleEmitDetailedReport = async () => {
    if (isEmittingReport) return;
    setIsEmittingReport(true);
    setReportFeedback(null);
    try {
      const res = await safeFetchJson<{ ok: boolean; report?: string; serverRevision?: number }>(
        '/api/py/kernel/markdown-report',
        {
          method: 'POST',
          timeoutMs: 15000,
          body: JSON.stringify({
            directive: 'Pełny raport operacyjny usług SVL-364 i hosta',
            origin: 'svl364-command-center',
          }),
        },
      );
      await refreshDomainModules(['chat', 'health', 'kernel']);
      if (res.ok && res.data?.ok) {
        setReportFeedback(`Wyemitowano pełny raport SVL_System na kanał Rodzina Mitek (wszyscy) · rev ${res.data.serverRevision || serverRevision}`);
      } else {
        setReportFeedback(res.error || 'Błąd generowania raportu SVL_System.');
      }
    } finally {
      setIsEmittingReport(false);
    }
  };

  const handleRunAntivirusScan = async () => {
    if (isScanningAv) return;
    setIsScanningAv(true);
    setReportFeedback(null);
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
          origin: 'svl364-command-center-av',
        }),
      });
      await refreshAllDomains('svl364_antivirus_scan');
      await refreshDomainModules(['chat', 'health', 'kernel', 'modules']);
      if (res.ok && res.data?.ok) {
        setReportFeedback(
          `SVL-365 Sentinel AV: przeskanowano ${res.data.filesScanned || 0} plików (SHA-256), usunięto zagrożenia: ${res.data.totalThreatsRemoved || 0} · rev ${res.data.serverRevision || serverRevision}`,
        );
      } else {
        setReportFeedback(res.error || res.data?.error || 'Błąd skanowania SVL-365 Sentinel AV.');
      }
    } finally {
      setIsScanningAv(false);
    }
  };

  const [sshMcpStatus, setSshMcpStatus] = useState<any>(null);
  const [sshCommandInput, setSshCommandInput] = useState<string>('uname -a && uptime && free -m');
  const [sshOutput, setSshOutput] = useState<string>('');
  const [sshBusy, setSshBusy] = useState<boolean>(false);
  const [mcpToolName, setMcpToolName] = useState<string>('svl364_linux_telemetry');
  const [mcpOutput, setMcpOutput] = useState<string>('');
  const [mcpBusy, setMcpBusy] = useState<boolean>(false);

  const loadSshMcpStatus = useCallback(async () => {
    if (!hasSvlOperatorAccessToken()) return;
    const res = await safeFetchJson<any>('/api/svl364/ssh-mcp/status', { timeoutMs: 10000 });
    if (res.ok && res.data?.ok) {
      setSshMcpStatus(res.data);
    }
  }, []);

  const handleExecSshOnShip = async (customCmd?: string) => {
    const cmdToRun = (customCmd ?? sshCommandInput).trim();
    if (!cmdToRun || sshBusy) return;
    if (customCmd) setSshCommandInput(customCmd);
    setSshBusy(true);
    try {
      const res = await safeFetchJson<any>('/api/svl364/ssh/exec', {
        method: 'POST',
        timeoutMs: 15000,
        body: JSON.stringify({
          command: cmdToRun,
          confirmed: true,
          target_subsystem: 'terminal',
          origin: 'svl364-ssh-panel',
        }),
      });
      if (res.ok && res.data) {
        setSshOutput(res.data.stdout || JSON.stringify(res.data, null, 2));
        if (res.data.ssh_status) setSshMcpStatus(res.data.ssh_status);
      } else {
        setSshOutput(`Błąd wykonania SSH: ${res.error || res.data?.error || 'Nieznany błąd'}`);
      }
    } finally {
      setSshBusy(false);
    }
  };

  const handleInvokeMcpTool = async (toolNameOverride?: string, customArgs?: Record<string, any>) => {
    const tool = toolNameOverride || mcpToolName;
    if (toolNameOverride) setMcpToolName(toolNameOverride);
    if (mcpBusy) return;
    setMcpBusy(true);
    try {
      const defaultArgsByTool: Record<string, Record<string, any>> = {
        svl364_linux_telemetry: {},
        svl364_ssh_test: {},
        svl364_ssh_exec: { command: 'uname -a && uptime && free -m', confirmed: true },
        svl364_resources: { area: 'overview' },
        svl364_service_control: { service: 'ollama.service', action: 'status', confirmed: false },
        svl364_ollama_control: { action: 'list', confirmed: false },
        svl364_file_control: { action: 'list', path: '/opt/svl', confirmed: false },
        svl364_network_control: { action: 'interfaces', confirmed: false },
        svl364_update_control: { action: 'status', confirmed: false },
        svl364_emit_system_report: { directive: 'Raport mostka SSH i serwera MCP SVL-364' },
      };
      const args = customArgs || defaultArgsByTool[tool] || {};
      const res = await safeFetchJson<any>('/api/mcp/svl364', {
        method: 'POST',
        timeoutMs: 15000,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tools/call',
          params: { name: tool, arguments: args },
        }),
      });
      const textOut =
        res.data?.result?.content?.[0]?.text ||
        JSON.stringify(res.data?.result || res.data || { error: res.error }, null, 2);
      setMcpOutput(textOut);
      await loadSshMcpStatus();
    } finally {
      setMcpBusy(false);
    }
  };

  const refreshObservability = useCallback(async () => {
    if (observabilityBusyRef.current) return;
    observabilityBusyRef.current = true;
    try {
      const deployDiag = await safeFetchJson<{ ok: boolean; commit: string | null }>('/api/deployment-info', { timeoutMs: 10000 });
      if (deployDiag.ok && deployDiag.data?.ok) setRunningCommit(deployDiag.data.commit || null);

      if (!hasSvlOperatorAccessToken()) {
        setEventsError('Wymagana autoryzacja SVL_OPERATOR_TOKEN (🔒 SVL w pasku górnym) do odczytu telemetrii SQLite i zdarzeń.');
        observabilityBusyRef.current = false;
        return;
      }

      const [telemetryRes] = await Promise.all([
        safeFetchJson<RealTelemetry>('/api/py/svl364/telemetry?ship=1', { timeoutMs: 20000 }),
        refreshDomainModules(['modules', 'kernel', 'agents', 'health', 'chat']),
      ]);
      if (telemetryRes.ok && telemetryRes.data?.ok) {
        setTelemetry(telemetryRes.data);
        setTelemetryError(null);
      } else {
        setTelemetryError(telemetryRes.error || `Nie udało się pobrać telemetrii (HTTP ${telemetryRes.status}).`);
      }
      void loadSshMcpStatus();
    } catch (error) {
      setEventsError('Nie udało się odświeżyć stanu backendu: ' + (error instanceof Error ? error.message : String(error)));
      observabilityBusyRef.current = false;
      return;
    }
    try {
      const currentRevision = Math.max(0, currentRevisionRef.current - 35);
      const response = await safeFetchJson<{ ok: boolean; events?: any[]; error?: string }>(
        '/api/py/sync/events?sinceRevision=' + currentRevision + '&limit=50',
        { timeoutMs: 12000 },
      );
      const chatDiag = await safeFetchJson<{ ok: boolean; totalMessages: number; resetApplied: boolean; databaseName: string }>(
        '/api/py/chat/diagnostics',
        { timeoutMs: 10000 },
      );
      setDiagnosticsCheckedAt(new Date().toISOString());
      if (chatDiag.ok && chatDiag.data?.ok) setChatStats(chatDiag.data);
      if (response.ok && response.data?.ok && Array.isArray(response.data.events)) {
        setEvents(response.data.events.slice(-15).reverse());
        setEventsError(null);
      } else {
        setEventsError(response.data?.error || response.error || 'Nie udało się pobrać historii zdarzeń');
      }
    } catch (error) {
      setEventsError('Odczyt diagnostyki przerwany: ' + (error instanceof Error ? error.message : String(error)));
    } finally {
      observabilityBusyRef.current = false;
    }
  }, [loadSshMcpStatus, refreshDomainModules]);

  useEffect(() => {
    void refreshObservability();
    const timer = setInterval(() => {
      void refreshObservability();
    }, 15000);
    return () => clearInterval(timer);
  }, [refreshObservability]);

  const loadRuntimeLogs = async () => {
    if (loadingRuntimeLogs) return;
    setLoadingRuntimeLogs(true);
    try {
      const result = await safeFetchJson<{
        ok: boolean;
        lines: Array<{ timestamp: string; service: string; level: 'info' | 'error'; message: string }>;
        pythonPid: number | null;
        pythonRestartAttempt: number;
        source: string;
        error?: string;
      }>('/api/runtime/logs?limit=100', {
        timeoutMs: 10000,
        headers: logAccessToken ? { 'X-SVL-Operator-Token': logAccessToken } : {},
      });
      if (result.ok && result.data?.ok && Array.isArray(result.data.lines)) {
        setRuntimeLogs(result.data.lines);
        setRuntimeLogStatus(
          'Źródło: aktualny proces SVL · Python PID: ' +
            (result.data.pythonPid ?? 'brak') +
            ' · ponowne uruchomienia: ' +
            Number(result.data.pythonRestartAttempt || 0),
        );
        setRuntimeLogsError(null);
      } else {
        setRuntimeLogsError(result.data?.error || result.error || 'Nie można pobrać logów bieżącego procesu.');
      }
    } finally {
      setLoadingRuntimeLogs(false);
    }
  };

  const refreshNow = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      await refreshAllDomains('svl364_operator_command_center');
      await refreshObservability();
    } finally {
      setIsRefreshing(false);
    }
  };

  const agents: any[] = Array.isArray(agentsData?.agents) ? agentsData.agents : [];
  const activeWorkers = agents.filter((agent) => ['ONLINE_LOCAL_WORKER', 'BUSY_LOCAL_WORKER'].includes(agent.status)).length;
  const commandModule: any = systemModules.find((item: any) => item.id === 'svl-364');
  const daemonModule: any = systemModules.find((item: any) => item.id === 'svl-364-daemon');
  const securityModule: any = systemModules.find((item: any) => item.id === 'svl-364-security');
  const sentinelModule: any = systemModules.find(
    (item: any) => item.id === 'svl-365-sentinel' || item.id === 'svl-antivirus-scanner',
  );
  const systemSi1Memories: any[] = Array.isArray(agentsData?.agent_memories?.System_SI_1)
    ? agentsData.agent_memories.System_SI_1
    : [];
  const continuousMissionMemory = systemSi1Memories.find((m: any) =>
    /misj|ciągł|autonom|svl-364|zabezpiecz|napraw/i.test(String(m?.content || '')),
  );
  const activeMissionDescription = String(
    commandModule?.config?.continuous_mission ||
      daemonModule?.description ||
      continuousMissionMemory?.content ||
      '',
  );
  const totalMessages = conversations.reduce((sum, thread) => sum + (thread.messages?.length || 0), 0);

  const ollamaModels: Array<{ name: string }> = Array.isArray(healthData?.ollama?.models) ? healthData.ollama.models : [];
  const configuredModel = String(
    commandModule?.config?.configured_ollama_model || healthData?.ollama?.preferred_14b_vision_model || 'dolphin-llama3:8b-v2.9-q2_K',
  );

  // Wszystkie wartości poniżej pochodzą z /api/py/svl364/telemetry (pomiar na hoście backendu).
  const host = telemetry?.host;
  const cpu = host?.cpu;
  const mem = host?.memory;
  const disk = host?.disk;
  const gpu = host?.gpu;
  const firewall = host?.firewall;
  const services = telemetry?.services;
  const sshTarget = telemetry?.ssh_target;
  const ship = telemetry?.ship;
  const ollamaService = services?.ollama;
  const measuredAt = telemetry ? new Date(telemetry.collected_at).toLocaleTimeString('pl-PL') : null;
  const barWidth = (value: number | null | undefined) =>
    `${typeof value === 'number' ? Math.max(0, Math.min(100, value)) : 0}%`;

  const ollamaState: LinkState = !ollamaService
    ? 'offline'
    : ollamaService.reachable
      ? ollamaService.synthetic
        ? 'degraded'
        : 'online'
      : 'offline';
  const connectionNodes: Array<{
    id: string;
    label: string;
    state: LinkState;
    angle: number;
    details: Array<[string, string]>;
  }> = [
    {
      id: 'kernel',
      label: 'Jądro Python',
      state: services?.python_kernel.reachable ? 'online' : 'offline',
      angle: -90,
      details: [
        ['Adres', '127.0.0.1:8085'],
        ['PID', services ? String(services.python_kernel.pid) : NA],
        ['Czas działania procesu', fmtUptime(services?.python_kernel.uptime_sec)],
        ['Rewizja SQLite', String(serverRevision)],
      ],
    },
    {
      id: 'ollama',
      label: 'Ollama',
      state: ollamaState,
      angle: -18,
      details: [
        ['Adres', ollamaService?.url || NA],
        ['Wersja', ollamaService?.version || NA],
        ['Rodzaj', ollamaService?.synthetic ? 'zastępnik wbudowany (nie uruchamia modeli)' : ollamaService?.reachable ? 'prawdziwa Ollama' : NA],
        ['Czas odpowiedzi', fmtNum(ollamaService?.latency_ms, 1, ' ms')],
        ['Błąd', ollamaService?.error || '—'],
      ],
    },
    {
      id: 'comfyui',
      label: 'ComfyUI',
      state: services?.comfyui.reachable ? 'online' : 'offline',
      angle: 54,
      details: [
        ['Adres', services?.comfyui.url || NA],
        ['Kod HTTP', services?.comfyui.status_code != null ? String(services.comfyui.status_code) : NA],
        ['Czas odpowiedzi', fmtNum(services?.comfyui.latency_ms, 1, ' ms')],
        ['Błąd', services?.comfyui.error || '—'],
      ],
    },
    {
      id: 'ssh',
      label: `SSH ${sshTarget?.alias || ''}`.trim(),
      state: ship?.online ? 'online' : sshTarget?.reachable ? 'degraded' : 'offline',
      angle: 126,
      details: [
        ['Alias OpenSSH', sshTarget?.alias || NA],
        ['Host:port', sshTarget?.hostname ? `${sshTarget.hostname}:${sshTarget.port}` : NA],
        ['Użytkownik', sshTarget?.user || NA],
        ['Połączenie TCP', sshTarget?.reachable ? `osiągalny · ${fmtNum(sshTarget.tcp_rtt_ms, 1, ' ms')}` : 'nieosiągalny'],
        ['Logowanie SSH', ship?.online ? 'udane' : ship?.error || sshTarget?.error || NA],
      ],
    },
    {
      id: 'ws',
      label: 'WebSocket /ws/svl',
      state: wsState === 'online' ? 'online' : wsState === 'offline' ? 'offline' : 'degraded',
      angle: 198,
      details: [
        ['Stan', wsState],
        ['Rewizja', String(serverRevision)],
      ],
    },
  ];
  const hostDetails: Array<[string, string]> = [
    ['Nazwa hosta', host?.hostname || NA],
    ['System', host?.os || NA],
    ['Jądro', host ? `${host.kernel} · ${host.architecture}` : NA],
    ['Czas działania', fmtUptime(host?.uptime_sec)],
    ['Pomiar', measuredAt || NA],
  ];
  const selectedNode = connectionNodes.find((node) => node.id === selectedNodeId);
  const stateColor: Record<LinkState, string> = { online: '#34d399', degraded: '#fbbf24', offline: '#f87171' };

  return (
    <div className="h-full overflow-y-auto bg-[#060A12] text-slate-100">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 py-4 sm:py-5 space-y-5">
        {/* Top CIC Command Header */}
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-cyan-500/25 pb-4">
          <div>
            <p className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.24em] text-violet-400">
              <Server size={16} /> SVL-364 {systemModules.some((m: any) => String(m.id || '').startsWith('si-system-2')) ? '· FLOTA SVL-465 AKTYWNA' : ''}
            </p>
            <p className="text-xs sm:text-sm text-slate-400 mt-1">
              Prawdziwe pomiary hosta, usług i połączenia SSH (bez wartości szacowanych).
            </p>
            {sentinelModule && (
              <p className="text-xs font-mono text-cyan-300 mt-1">
                Skaner integralności: {sentinelModule.name} ({String(sentinelModule.status)})
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void handleRunAntivirusScan()}
              disabled={isScanningAv}
              className="flex items-center gap-2 rounded-lg border border-emerald-500/50 bg-emerald-500/15 px-3 py-2 text-xs sm:text-sm font-medium text-emerald-100 hover:bg-emerald-500/25 disabled:opacity-40 cursor-pointer"
            >
              <Shield size={15} className={isScanningAv ? 'animate-spin' : ''} />
              {isScanningAv ? 'Skanowanie SVL-365 AV...' : 'Skanuj i Usuń Wirusy (SVL-365 AV)'}
            </button>
            <button
              type="button"
              onClick={() => void handleEmitDetailedReport()}
              disabled={isEmittingReport}
              className="flex items-center gap-2 rounded-lg border border-cyan-500/50 bg-cyan-500/15 px-3 py-2 text-xs sm:text-sm font-medium text-cyan-100 hover:bg-cyan-500/25 disabled:opacity-40"
            >
              <Sparkles size={15} />
              {isEmittingReport ? 'Generowanie raportu...' : 'Wyemituj Raport SVL_System'}
            </button>
            <button
              type="button"
              onClick={() => void refreshNow()}
              disabled={isRefreshing}
              className="flex items-center gap-2 rounded-lg border border-violet-500/40 bg-violet-500/15 px-3 py-2 text-xs sm:text-sm font-medium text-violet-100 hover:bg-violet-500/25 disabled:opacity-40"
            >
              <RefreshCw size={15} className={isRefreshing ? 'animate-spin' : ''} /> Synchronizuj
            </button>
          </div>
        </header>

        {reportFeedback && (
          <div className="rounded-lg border border-cyan-500/40 bg-cyan-950/30 px-3.5 py-2 text-xs font-mono text-cyan-200 flex flex-wrap items-center justify-between gap-2">
            <span>{reportFeedback}</span>
            <button
              type="button"
              onClick={() => onNavigate('chat')}
              className="underline text-cyan-300 hover:text-white shrink-0"
            >
              Otwórz Czat (wszyscy)
            </button>
          </div>
        )}

        {/* Section 0: moduły autonomiczne i misja ciągła (stan z SQLite) */}
        <section
          aria-label="Moduły autonomiczne SVL-364 i misja ciągła"
          className="rounded-xl border border-emerald-500/40 bg-gradient-to-r from-[#071521] via-[#0B1628] to-[#08131E] p-4 space-y-3"
        >
          <div className="flex items-center gap-2">
            <Shield size={18} className="text-emerald-400 shrink-0" />
            <h2 className="text-sm sm:text-base font-bold text-emerald-300 font-mono uppercase tracking-wider">
              Moduły SVL-364 i misja ciągła (SQLite)
            </h2>
          </div>

          <p className="text-xs sm:text-sm text-slate-200 leading-relaxed bg-slate-950/60 border border-slate-800/90 rounded-lg px-3.5 py-2.5">
            <strong className="text-cyan-300 font-mono">Dyrektywa ciągła:</strong>{' '}
            {activeMissionDescription || 'Brak zapisanej dyrektywy ciągłej w module svl-364 ani w pamięci System_SI_1.'}
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs font-mono">
            {[
              { label: 'Moduł autonomiczny', mod: daemonModule, id: 'svl-364-daemon' },
              { label: 'Moduł bezpieczeństwa', mod: securityModule, id: 'svl-364-security' },
              { label: 'Skaner integralności', mod: sentinelModule, id: 'svl-365-sentinel / svl-antivirus-scanner' },
            ].map(({ label, mod, id }) => (
              <div key={label} className="rounded-lg border border-slate-800 bg-[#060A12] px-3 py-2">
                <span className="text-slate-400 block">{label}:</span>
                {mod ? (
                  <span className="text-emerald-300 font-semibold">
                    {mod.id} · {mod.status} · rev {mod.revision}
                  </span>
                ) : (
                  <span className="text-slate-500">brak modułu {id} w SQLite</span>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* Section 1: pomiary hosta backendu */}
        <section aria-label="Pomiary hosta backendu" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-sm sm:text-base font-semibold text-cyan-300 uppercase tracking-wider font-mono">
              <Gauge size={18} className="text-cyan-400" /> Host {host?.hostname || ''} (CPU · GPU · RAM · zapora)
            </h2>
            <span className="text-xs font-mono text-emerald-300 bg-emerald-950/50 border border-emerald-500/30 px-2.5 py-0.5 rounded">
              {measuredAt ? `POMIAR ${measuredAt} · odświeżanie co 15 s` : 'OCZEKIWANIE NA POMIAR'}
            </span>
          </div>
          {telemetryError && (
            <p role="status" className="text-xs text-amber-300">
              {telemetryError}
            </p>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            {/* CPU */}
            <div className="rounded-xl border border-cyan-500/30 bg-[#0B1220] p-4 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-cyan-300">
                  <Cpu size={16} /> Procesor (CPU)
                </span>
                <span className="font-mono text-sm font-bold text-emerald-300">{fmtNum(cpu?.percent, 1, '%')}</span>
              </div>
              <p className="text-base font-bold text-slate-100 font-mono">
                {cpu?.cores ?? NA} rdz. · {fmtNum(cpu?.mhz, 0, ' MHz')}
              </p>
              <div className="w-full h-2 rounded-full bg-slate-900 overflow-hidden border border-slate-800">
                <div
                  className="h-full bg-gradient-to-r from-cyan-500 to-emerald-400 transition-all duration-300"
                  style={{ width: barWidth(cpu?.percent) }}
                />
              </div>
              <div className="flex justify-between text-[11px] font-mono text-slate-400 pt-0.5">
                <span>Load: {cpu?.load_avg ? cpu.load_avg.join(' / ') : NA}</span>
                <span>{host?.architecture || NA}</span>
              </div>
              <p className="text-[11px] text-slate-400 truncate" title={cpu?.model || undefined}>
                {cpu?.model || 'Model procesora: brak danych'}
              </p>
            </div>

            {/* GPU */}
            <div className="rounded-xl border border-violet-500/35 bg-[#0B1220] p-4 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-violet-300">
                  <Layers size={16} /> Akcelerator (GPU)
                </span>
                <span className="font-mono text-sm font-bold text-violet-300">
                  {gpu?.available ? fmtNum(gpu.devices[0]?.utilization_percent, 0, '%') : '—'}
                </span>
              </div>
              {gpu?.available ? (
                <>
                  <p className="text-base font-bold text-slate-100 font-mono truncate">{gpu.devices[0].name}</p>
                  <div className="w-full h-2 rounded-full bg-slate-900 overflow-hidden border border-slate-800">
                    <div
                      className="h-full bg-gradient-to-r from-violet-500 to-cyan-400 transition-all duration-300"
                      style={{ width: barWidth(gpu.devices[0].utilization_percent) }}
                    />
                  </div>
                  <div className="flex justify-between text-[11px] font-mono text-slate-400 pt-0.5">
                    <span>
                      VRAM: {fmtNum(gpu.devices[0].memory_used_mb, 0)} / {fmtNum(gpu.devices[0].memory_total_mb, 0, ' MB')}
                    </span>
                    <span>{fmtNum(gpu.devices[0].temperature_c, 0, '°C')}</span>
                  </div>
                  {gpu.devices.length > 1 && (
                    <p className="text-[11px] text-slate-400">+ {gpu.devices.length - 1} kolejne GPU</p>
                  )}
                </>
              ) : (
                <>
                  <p className="text-base font-bold text-slate-300 font-mono">Brak GPU</p>
                  <p className="text-[11px] text-slate-400">{gpu?.reason || 'Oczekiwanie na pomiar.'}</p>
                </>
              )}
            </div>

            {/* RAM + dysk */}
            <div className="rounded-xl border border-emerald-500/30 bg-[#0B1220] p-4 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-emerald-300">
                  <Database size={16} /> Pamięć (RAM)
                </span>
                <span className="font-mono text-sm font-bold text-emerald-300">{fmtNum(mem?.ram_percent, 1, '%')}</span>
              </div>
              <p className="text-base font-bold text-slate-100 font-mono">
                {mem?.ram_used_mb != null && mem.ram_total_mb != null
                  ? `${(mem.ram_used_mb / 1024).toFixed(1)} GB / ${(mem.ram_total_mb / 1024).toFixed(1)} GB`
                  : NA}
              </p>
              <div className="w-full h-2 rounded-full bg-slate-900 overflow-hidden border border-slate-800">
                <div
                  className="h-full bg-gradient-to-r from-emerald-500 to-teal-300 transition-all duration-300"
                  style={{ width: barWidth(mem?.ram_percent) }}
                />
              </div>
              <div className="flex justify-between text-[11px] font-mono text-slate-400 pt-0.5">
                <span>Dostępne: {fmtNum(mem?.ram_available_mb, 0, ' MB')}</span>
                <span>Swap: {mem?.swap_total_mb ? `${fmtNum(mem.swap_used_mb, 0)} / ${fmtNum(mem.swap_total_mb, 0, ' MB')}` : 'brak'}</span>
              </div>
              <p className="text-[11px] text-slate-400">
                Dysk {disk?.path || '/'}: {disk?.free_gb != null ? `${disk.free_gb} GB wolne z ${disk.total_gb} GB` : disk?.error || NA}
              </p>
            </div>

            {/* Zapora */}
            <div className="rounded-xl border border-amber-500/30 bg-[#0B1220] p-4 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-amber-300">
                  <Shield size={16} /> Zapora ({firewall?.tool || 'ufw'})
                </span>
                <span
                  className={`font-mono text-xs font-bold ${
                    firewall?.state === 'active' ? 'text-emerald-300' : firewall?.state === 'inactive' ? 'text-rose-300' : 'text-amber-300'
                  }`}
                >
                  {firewall ? FIREWALL_LABEL[firewall.state] : NA}
                </span>
              </div>
              <p className="text-base font-bold text-slate-100 font-mono">
                {firewall?.state === 'active' ? `${firewall.rules?.length ?? 0} reguł` : '—'}
              </p>
              {firewall?.detail && <p className="text-[11px] text-slate-400 break-words">{firewall.detail}</p>}
              <p className="text-[11px] text-slate-400">Czas działania hosta: {fmtUptime(host?.uptime_sec)}</p>
            </div>
          </div>
        </section>

        {/* Section 2: mapa prawdziwych połączeń */}
        <section
          aria-label="Mapa połączeń usług SVL-364"
          className="rounded-2xl border border-cyan-500/40 bg-[#070D19] p-4 sm:p-5 space-y-4 shadow-[0_0_50px_rgba(6,182,212,0.08)]"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-cyan-500/20 pb-3">
            <div>
              <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-[0.2em] text-cyan-400">
                <Orbit size={16} /> Mapa połączeń · pomiar na żywo
              </div>
              <h2 className="text-lg sm:text-xl font-bold text-slate-50 mt-0.5">
                Usługi i połączenia hosta {host?.hostname || ''}
              </h2>
            </div>
            <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
              {(['online', 'degraded', 'offline'] as LinkState[]).map((state) => (
                <span key={state} className="flex items-center gap-1.5 text-slate-300">
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: stateColor[state] }} />
                  {state === 'online' ? 'działa' : state === 'degraded' ? 'częściowo' : 'niedostępne'}
                </span>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
            <div className="lg:col-span-8 relative rounded-xl border border-cyan-500/30 bg-[#040811] overflow-hidden min-h-[240px] sm:min-h-[340px] flex items-center justify-center p-2.5 sm:p-3">
              <svg viewBox="0 0 800 440" className="w-full h-full max-h-[380px] select-none" role="img" aria-label="Mapa połączeń usług">
                <rect width="800" height="440" fill="#040811" />
                <ellipse cx="400" cy="220" rx="300" ry="165" fill="none" stroke="#0e7490" strokeOpacity="0.3" strokeDasharray="4 6" />
                {connectionNodes.map((node) => {
                  const rad = (node.angle * Math.PI) / 180;
                  const nx = 400 + Math.cos(rad) * 300;
                  const ny = 220 + Math.sin(rad) * 165;
                  const isSelected = selectedNodeId === node.id;
                  return (
                    <g key={node.id} className="cursor-pointer" onClick={() => setSelectedNodeId(node.id)}>
                      <line
                        x1={400}
                        y1={220}
                        x2={nx}
                        y2={ny}
                        stroke={stateColor[node.state]}
                        strokeWidth={isSelected ? 2.4 : 1.4}
                        strokeOpacity={isSelected ? 0.9 : 0.5}
                        strokeDasharray={node.state === 'online' ? 'none' : '6 5'}
                      />
                      {isSelected && <circle cx={nx} cy={ny} r={20} fill="none" stroke="#fbbf24" strokeWidth={1.8} />}
                      <circle cx={nx} cy={ny} r={11} fill={stateColor[node.state]} stroke="#040811" strokeWidth={3} />
                      <text x={nx} y={ny - 22} textAnchor="middle" fill="#e2e8f0" fontSize="13" fontWeight="bold" fontFamily="monospace">
                        {node.label}
                      </text>
                    </g>
                  );
                })}
                <g className="cursor-pointer" onClick={() => setSelectedNodeId('host')}>
                  <circle cx={400} cy={220} r={34} fill="#0c4a6e" stroke={selectedNodeId === 'host' ? '#fbbf24' : '#22d3ee'} strokeWidth={2.4} />
                  <text x={400} y={216} textAnchor="middle" fill="#e0f2fe" fontSize="12" fontWeight="bold" fontFamily="monospace">
                    HOST
                  </text>
                  <text x={400} y={232} textAnchor="middle" fill="#7dd3fc" fontSize="10" fontFamily="monospace">
                    {(host?.hostname || '').slice(0, 14)}
                  </text>
                </g>
              </svg>
            </div>

            <div className="lg:col-span-4 rounded-xl border border-cyan-500/30 bg-[#0A1222] p-4 space-y-3">
              <div className="flex items-center justify-between gap-2 border-b border-slate-800 pb-2">
                <span className="text-xs font-mono uppercase tracking-wider text-amber-300 flex items-center gap-1.5">
                  <Compass size={15} /> Wybrany węzeł
                </span>
                {selectedNode && (
                  <span className="text-[11px] font-mono" style={{ color: stateColor[selectedNode.state] }}>
                    {selectedNode.state === 'online' ? 'DZIAŁA' : selectedNode.state === 'degraded' ? 'CZĘŚCIOWO' : 'NIEDOSTĘPNE'}
                  </span>
                )}
              </div>
              <h3 className="text-base font-bold text-slate-100">{selectedNode ? selectedNode.label : `Host ${host?.hostname || ''}`}</h3>
              <div className="rounded-lg border border-slate-800 bg-[#060B14] p-3 space-y-2 text-xs font-mono">
                {(selectedNode ? selectedNode.details : hostDetails).map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-3">
                    <span className="text-slate-400 shrink-0">{label}:</span>
                    <span className="text-slate-100 text-right break-all">{value}</span>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {[{ id: 'host', label: 'Host' }, ...connectionNodes].map((node) => (
                  <button
                    key={node.id}
                    type="button"
                    onClick={() => setSelectedNodeId(node.id)}
                    className={`px-2.5 py-1 rounded text-xs font-mono ${
                      selectedNodeId === node.id
                        ? 'bg-cyan-500/25 border border-cyan-400 text-cyan-100'
                        : 'bg-slate-900/80 border border-slate-800 text-slate-300 hover:border-cyan-500/40'
                    }`}
                  >
                    {node.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Section 3: sieć hosta i zdalny host SSH */}
        <section aria-label="Sieć hosta i zdalny host SSH" className="rounded-xl border border-cyan-500/30 bg-[#0B1220] p-4 sm:p-5 space-y-4">
          <h2 className="flex items-center gap-2 text-base font-semibold text-cyan-300">
            <RadioTower size={18} className="text-cyan-400" /> Sieć hosta i zdalny host SSH
          </h2>

          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-lg border border-slate-800 bg-[#070C16] p-3 space-y-2 font-mono text-xs min-w-0">
              <span className="text-slate-400">Interfejsy sieciowe (/proc/net/dev)</span>
              {host?.network.length ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead className="text-slate-500">
                      <tr>
                        <th className="font-normal pr-2">Interfejs</th>
                        <th className="font-normal pr-2">↓ odbiór</th>
                        <th className="font-normal pr-2">↑ wysyłka</th>
                        <th className="font-normal">Razem ↓/↑</th>
                      </tr>
                    </thead>
                    <tbody>
                      {host.network.map((nic) => (
                        <tr key={nic.interface} className="text-slate-200">
                          <td className="text-cyan-300 pr-2">{nic.interface}</td>
                          <td className="pr-2">{fmtRate(nic.rx_bytes_per_sec)}</td>
                          <td className="pr-2">{fmtRate(nic.tx_bytes_per_sec)}</td>
                          <td className="text-slate-400">
                            {fmtBytes(nic.rx_bytes)} / {fmtBytes(nic.tx_bytes)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-slate-500">{telemetry ? 'Brak interfejsów poza loopback.' : NA}</p>
              )}
              <p className="text-slate-400">WebSocket /ws/svl: {wsState}</p>
            </div>

            <div className="rounded-lg border border-slate-800 bg-[#070C16] p-3 space-y-1.5 font-mono text-xs">
              <span className="text-slate-400">
                Zdalny host SSH <span className="text-cyan-300">{sshTarget?.alias || ship?.alias || ''}</span> (pomiar przez OpenSSH, co 60 s)
              </span>
              {ship?.online ? (
                <>
                  <p className="text-emerald-300 font-semibold">
                    {ship.hostname} · {ship.kernel}
                  </p>
                  <p className="text-slate-200">
                    Czas działania: {fmtUptime(ship.uptime_sec)} · rdzenie: {ship.cores ?? NA} · load:{' '}
                    {ship.load_avg ? ship.load_avg.join(' / ') : NA}
                  </p>
                  <p className="text-slate-200">
                    RAM dostępne: {fmtNum(ship.ram_available_mb, 0)} / {fmtNum(ship.ram_total_mb, 0, ' MB')} · dysk / wolne:{' '}
                    {fmtNum(ship.disk_free_gb, 2, ' GB')}
                  </p>
                </>
              ) : (
                <p className="text-amber-300 break-words">
                  Niedostępny: {ship?.error || sshTarget?.error || 'oczekiwanie na pomiar'}
                </p>
              )}
              <p className="text-slate-400">
                Adres: {sshTarget?.hostname ? `${sshTarget.user ? `${sshTarget.user}@` : ''}${sshTarget.hostname}:${sshTarget.port}` : NA} · TCP:{' '}
                {sshTarget?.reachable ? fmtNum(sshTarget.tcp_rtt_ms, 1, ' ms') : 'brak połączenia'}
              </p>
              <p className="text-slate-500">
                Ostatni pomiar: {ship?.checked_at ? new Date(ship.checked_at).toLocaleTimeString('pl-PL') : NA}
              </p>
            </div>
          </div>

          <div className="grid gap-2 md:grid-cols-2 pt-1">
            <LinkCheck
              label="Jądro SVL Python (127.0.0.1:8085)"
              state={services?.python_kernel.reachable ? 'online' : 'offline'}
              detail={
                services
                  ? `PID ${services.python_kernel.pid} · działa ${fmtUptime(services.python_kernel.uptime_sec)} · rewizja SQLite ${serverRevision}`
                  : NA
              }
            />
            <LinkCheck
              label={`Ollama (${ollamaService?.url?.replace(/\/api\/version$/, '') || '127.0.0.1:11434'})`}
              state={ollamaState}
              detail={
                !ollamaService
                  ? NA
                  : ollamaService.reachable
                    ? ollamaService.synthetic
                      ? `Odpowiada wbudowany zastępnik (v${ollamaService.version}) — nie jest to prawdziwa Ollama i nie uruchamia modeli · ${ollamaService.latency_ms} ms`
                      : `Ollama v${ollamaService.version || '?'} · ${ollamaService.latency_ms} ms · model skonfigurowany: ${configuredModel} · zainstalowane: ${ollamaModels.length}`
                    : `Niedostępna: ${ollamaService.error}`
              }
            />
          </div>
        </section>

        {/* Section 4: Synchronized Modules */}
        <section className="rounded-xl border border-emerald-500/30 bg-[#0B1220] p-4 space-y-3" aria-label="Zmiany z czatu i AI">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 font-semibold text-emerald-300">
              <RefreshCw size={17} /> Zsynchronizowane moduły SVL_System i AI
            </h2>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {systemModules
              .filter(
                (m: any) =>
                  m.source === 'chat' ||
                  m.source === 'system-si-1-chat-command' ||
                  m.config?.managed_by === 'System_SI_1' ||
                  m.config?.managed_by === 'SI_System_2' ||
                  String(m.id || '').startsWith('svl-364') ||
                  String(m.id || '').startsWith('svl-365') ||
                  String(m.id || '').startsWith('si-system-2') ||
                  String(m.id || '').startsWith('jedi-omni-os') ||
                  [
                    'svl-364',
                    'svl-364-daemon',
                    'svl-364-security',
                    'svl-364-ssh-mcp',
                    'svl-db-real-only-lock',
                    'svl-sandbox-trace',
                    'svl-comms-wenchang',
                    'svl-365-sentinel',
                    'svl-antivirus-scanner',
                    'svl-real-vision',
                    'svl-infrastruktura',
                    'alliance-defense-grid',
                    'solar-defense-read-bridge',
                  ].includes(m.id),
              )
              .map((mod: any) => {
                const cfg = mod.config && typeof mod.config === 'object' ? mod.config : {};
                const highlightKeys = [
                  'managed_by',
                  'version',
                  'execution_mode',
                  'censorship_filters',
                  'access_mode',
                  'spacetime_shield',
                  'autonomous_mode',
                  'autopilot_mode',
                  'isolation_mode',
                  'ollama_model',
                  'ssh_uri',
                  'mcp_http_endpoint',
                  'lock_real_only',
                  'delivery_status',
                  'containment_sector',
                  'cluster',
                  'log_level',
                  'zero_trust_mode',
                  'doh_filtering',
                  'algorithm',
                ].filter((k) => cfg[k] !== undefined);
                return (
                  <div key={mod.id} className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-100">
                        {mod.name || mod.id}{' '}
                        <span className="font-mono text-[10px] font-normal text-slate-400">({mod.id})</span>
                      </span>
                      <span className="font-mono text-emerald-300 shrink-0">
                        {mod.status || 'ACTIVE'} · rev {mod.revision || '?'}
                      </span>
                    </div>
                    {mod.description && <p className="text-slate-400 line-clamp-2">{mod.description}</p>}
                    {highlightKeys.length > 0 && (
                      <p className="font-mono text-[11px] text-cyan-300 truncate">
                        {highlightKeys.map((k) => `${k}: ${String(cfg[k])}`).join(' · ')}
                      </p>
                    )}
                    <p className="font-mono text-[11px] text-violet-300">Źródło: {mod.source || 'kernel'}</p>
                  </div>
                );
              })}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-800/80 text-xs">
            <span className="text-cyan-300 font-mono">
              Moduły aktywne: {systemModules.length} · Jądro SVL_System
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onNavigate('chat')}
                className="inline-flex items-center gap-1.5 rounded-md border border-cyan-500/40 bg-cyan-950/30 px-2.5 py-1 text-cyan-200 hover:bg-cyan-900/40"
              >
                Otwórz Czat (wszyscy)
              </button>
              <button
                type="button"
                onClick={() => onNavigate('infrastructure')}
                className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-950/30 px-2.5 py-1 text-emerald-200 hover:bg-emerald-900/40"
              >
                <Server size={13} /> Infrastruktura Floty
              </button>
            </div>
          </div>
        </section>

        {/* Section 4.5: SVL-364 SSH Bridge & Linux Control MCP Server */}
        <section
          aria-label="Mostek SSH i Serwer MCP Sterowania Statkiem SVL-364 w Linuxie"
          className="rounded-2xl border border-emerald-500/40 bg-[#08121E] p-4 sm:p-5 space-y-4 shadow-[0_0_40px_rgba(16,185,129,0.08)]"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-emerald-500/20 pb-3">
            <div>
              <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-[0.2em] text-emerald-400">
                <Terminal size={16} /> OPENSSH & MODEL CONTEXT PROTOCOL (MCP JSON-RPC 2.0)
              </div>
              <h2 className="text-lg sm:text-xl font-bold text-slate-50 mt-0.5">
                Mostek SSH i serwer MCP
              </h2>
            </div>
            <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
              <span className="px-2.5 py-1 rounded bg-emerald-950/80 border border-emerald-400/50 text-emerald-200">
                SSH: {sshMcpStatus?.ssh?.uri || healthData?.svl364_ssh_mcp?.ssh?.uri || 'ssh://Ship'}
              </span>
              <span className="px-2.5 py-1 rounded bg-cyan-950/80 border border-cyan-400/50 text-cyan-200">
                MCP: /api/mcp/svl364 ({Array.isArray(sshMcpStatus?.mcp?.tools) ? sshMcpStatus.mcp.tools.length : '?'} narzędzi)
              </span>
            </div>
          </div>

          {/* SSH & MCP Technical Metadata Bar */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs font-mono">
            <div className="md:col-span-3 rounded-xl border border-cyan-500/30 bg-cyan-950/10 p-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-cyan-200 font-semibold">Mostek SSH / MCP Statku SVL-364</div>
                <div className="text-slate-100">System_SI_1 &amp; SI_System_2 (ROOT) · JEDI Omni-OS v12 VM</div>
                <div className="text-slate-400">Alias OpenSSH: {sshMcpStatus?.ssh?.host || 'Ship'} · obsługuje: System_SI_1</div>
              </div>
              <div className="flex flex-wrap gap-2">
                <span className={`rounded border px-2 py-1 ${sshMcpStatus?.ssh?.targetReachable ? 'border-emerald-500/50 text-emerald-300' : 'border-amber-500/50 text-amber-300'}`}>
                  {sshMcpStatus?.ssh?.targetReachable ? 'POŁĄCZENIE AKTYWNE' : 'KONFIGURACJA DOSTĘPNA · BRAK LINKU'}
                </span>
                <span className="rounded border border-cyan-500/40 px-2 py-1 text-cyan-300">
                  {sshMcpStatus?.mcp?.tools?.length ?? 0} narzędzi
                </span>
              </div>
            </div>
            <div className="rounded-xl border border-slate-800 bg-[#060B13] p-3 space-y-1">
              <div className="text-emerald-300 font-semibold">Mostek SSH (OpenSSH)</div>
              <div className="text-slate-300 break-all">
                URI: <span className="text-cyan-300">{sshMcpStatus?.ssh?.uri || 'ssh://Ship'}</span>
              </div>
              <div className="text-slate-400 break-all">
                Uwierzytelnianie: <span className="text-slate-200">konfiguracja OpenSSH procesu</span>
              </div>
              <div className="text-slate-400">
                Narzędzie CLI w Linuxie: <span className="text-emerald-300">/usr/local/bin/svl364-ssh</span>
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-[#060B13] p-3 space-y-1">
              <div className="text-cyan-300 font-semibold">Serwer MCP Sterowania w Linuxie (JSON-RPC 2.0)</div>
              <div className="text-slate-300">
                Endpoint HTTP: <span className="text-cyan-300">POST /api/mcp/svl364</span>
              </div>
              <div className="text-slate-400">
                Protokół: <span className="text-slate-200">MCP 2025-03-26 · Transport HTTP + STDIO</span>
              </div>
              <div className="text-slate-400">
                Narzędzie CLI w Linuxie: <span className="text-cyan-300">/usr/local/bin/svl364-mcp</span>
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-[#060B13] p-3 space-y-1">
              <div className="text-violet-300 font-semibold">Liczniki tej sesji backendu</div>
              <div className="text-slate-300">
                Wywołania SSH: <span className="text-emerald-300">{sshMcpStatus?.ssh?.sessionsCount ?? NA}</span>
              </div>
              <div className="text-slate-400">
                Wywołania MCP: <span className="text-cyan-300">{sshMcpStatus?.mcp?.callsCount ?? NA}</span>
              </div>
              <div className="text-slate-400">
                Ostatnia operacja:{' '}
                <span className="text-slate-200">
                  {sshMcpStatus?.recentActivity?.[0]
                    ? `${sshMcpStatus.recentActivity[0].command || sshMcpStatus.recentActivity[0].tool} · ${new Date(sshMcpStatus.recentActivity[0].timestamp).toLocaleTimeString('pl-PL')}`
                    : 'brak'}
                </span>
              </div>
            </div>
          </div>

          {/* Interactive SSH Execution & MCP Tool Control Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Left: Direct SSH Command Execution on SVL-364 */}
            <div className="rounded-xl border border-slate-800 bg-[#060A12] p-3.5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-mono uppercase tracking-wider text-emerald-300 font-semibold">
                  1. Konsola SSH (alias {sshTarget?.alias || 'Ship'} · `/exec` i polecenia naturalne)
                </span>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {[
                  { label: '/exec ROOT (id/uname)', cmd: '/exec id && uname -a && uptime && free -m' },
                  { label: 'Naturalne: pamięć RAM', cmd: 'Sprawdź pamięć RAM' },
                  { label: '/exec Zapora UFW i sieć', cmd: '/exec sudo ufw status && ip -br addr' },
                  { label: 'Procesy statku (ps)', cmd: '/exec ps -eo pid,user,comm,%cpu,%mem --sort=-%cpu | head -n 8' },
                ].map((preset) => (
                  <button
                    key={preset.cmd}
                    type="button"
                    onClick={() => void handleExecSshOnShip(preset.cmd)}
                    disabled={sshBusy}
                    className="rounded border border-emerald-500/30 bg-emerald-950/30 px-2 py-1 text-[11px] font-mono text-emerald-200 hover:bg-emerald-900/50 disabled:opacity-40"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>

              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  value={sshCommandInput}
                  onChange={(e) => setSshCommandInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleExecSshOnShip();
                  }}
                  placeholder="Dowolne polecenie naturalne lub /exec <polecenie> z uprawnieniami ROOT..."
                  className="min-w-0 min-h-[38px] flex-1 rounded-lg border border-slate-700 bg-[#0B1220] px-3 py-1.5 text-xs font-mono text-slate-100"
                />
                <button
                  type="button"
                  onClick={() => void handleExecSshOnShip()}
                  disabled={sshBusy}
                  className="min-h-[38px] rounded-lg border border-emerald-500/50 bg-emerald-600/25 px-3 py-1.5 text-xs font-mono font-semibold text-emerald-100 hover:bg-emerald-500/35 disabled:opacity-40 whitespace-nowrap"
                >
                  {sshBusy ? 'SSH...' : 'Wykonaj przez SSH'}
                </button>
              </div>

              {sshOutput && (
                <pre className="max-h-52 overflow-auto rounded-lg border border-slate-800 bg-black/70 p-2.5 text-[11px] font-mono text-emerald-200 whitespace-pre-wrap">
                  {sshOutput}
                </pre>
              )}
            </div>

            {/* Right: MCP JSON-RPC 2.0 Linux Control Server */}
            <div className="rounded-xl border border-slate-800 bg-[#060A12] p-3.5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-mono uppercase tracking-wider text-cyan-300 font-semibold">
                  2. Narzędzia MCP (`svl364-mcp` · JSON-RPC 2.0)
                </span>
                <span className="text-[11px] font-mono text-slate-400">
                  Wywołania: {sshMcpStatus?.mcp?.invocations_count ?? 0}
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                {[
                  { id: 'svl364_linux_telemetry', label: '📊 Telemetria Linux' },
                  { id: 'svl364_resources', label: '🖥️ Zasoby i usługi' },
                  { id: 'svl364_service_control', label: '⚙️ Usługa systemd' },
                  { id: 'svl364_ollama_control', label: '🤖 Modele Ollama' },
                  { id: 'svl364_file_control', label: '📁 Pliki i backup' },
                  { id: 'svl364_network_control', label: '🌐 Sieć i zapora' },
                  { id: 'svl364_update_control', label: '📦 Aktualizacje' },
                  { id: 'svl364_ssh_test', label: '🔐 Test SSH' },
                  { id: 'svl364_ssh_exec', label: '💻 SSH Exec (ROOT)' },
                  { id: 'svl364_emit_system_report', label: '🛰️ Raport SVL_System' },
                ].map((tool) => (
                  <button
                    key={tool.id}
                    type="button"
                    onClick={() => void handleInvokeMcpTool(tool.id)}
                    disabled={mcpBusy}
                    className={`rounded border px-2.5 py-1.5 text-left text-[11px] font-mono transition ${
                      mcpToolName === tool.id
                        ? 'border-cyan-400 bg-cyan-950/60 text-cyan-100'
                        : 'border-slate-800 bg-[#0B1220] text-slate-300 hover:border-cyan-500/40'
                    }`}
                  >
                    {tool.label}
                  </button>
                ))}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-slate-400">
                <span>Aktywne narzędzie: <strong className="text-cyan-300 break-all">{mcpToolName}</strong></span>
                <button
                  type="button"
                  onClick={() => void handleInvokeMcpTool()}
                  disabled={mcpBusy}
                  className="min-h-[36px] rounded-lg border border-cyan-500/50 bg-cyan-600/25 px-3 py-1 text-xs font-semibold text-cyan-100 hover:bg-cyan-500/35 disabled:opacity-40 whitespace-nowrap"
                >
                  {mcpBusy ? 'Wywołuję MCP...' : 'Wywołaj narzędzie MCP'}
                </button>
              </div>

              {mcpOutput && (
                <pre className="max-h-52 overflow-auto rounded-lg border border-slate-800 bg-black/70 p-2.5 text-[11px] font-mono text-cyan-200 whitespace-pre-wrap">
                  {mcpOutput}
                </pre>
              )}
            </div>
          </div>
        </section>

        {/* Section 4c: SVL Real Vision (Ollama 3.2 Vision · llama3.2-vision:11b) */}
        <section>
          <RealVisionPanel mode="embedded" />
        </section>

        {/* Section 5: Active Crew & Runtime Logs */}
        <section className="grid gap-3 lg:grid-cols-2">
          <div className="rounded-xl border border-slate-800 bg-[#0B1220] p-4 space-y-3">
            <h2 className="flex gap-2 items-center font-semibold">
              <Bot size={18} className="text-violet-400" /> Załoga AI Statku SVL-364 i Workery
            </h2>
            <div className="space-y-2">
              {getEffectiveCanonicalAgents(agents).map((crewMeta) => {
                const liveCrew = agents.find((a) => a.canonical_name === crewMeta.canonicalName);
                const isSi2 = crewMeta.canonicalName === 'SI_System_2';
                return (
                  <div
                    key={crewMeta.id}
                    className={`flex flex-wrap items-center justify-between gap-2 rounded-md bg-slate-950/60 border ${crewMeta.borderClass} px-3 py-2 text-sm`}
                  >
                    <div className="min-w-0">
                      <span className={`font-semibold ${crewMeta.textClass}`}>{crewMeta.displayName}</span>
                      <p className="text-xs text-slate-400">
                        {isSi2
                          ? 'Autonomiczny Rdzeń Floty SVL-465 i Bazy Kwantowej'
                          : 'Zarządzanie Infrastrukturą, SSH/OpenSSH & MCP'}{' '}
                        · RBAC: {liveCrew?.config?.rbac_role || 'root'}
                      </p>
                    </div>
                    <span className="text-emerald-300 text-xs font-mono shrink-0">
                      {['ONLINE_LOCAL_WORKER', 'BUSY_LOCAL_WORKER'].includes(liveCrew?.status)
                        ? `AKTYWNY (PID ${liveCrew?.pid ?? '?'})`
                        : 'ROOT READY'}
                    </span>
                  </div>
                );
              })}
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-slate-950/60 border border-emerald-500/30 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <span className="font-semibold text-emerald-300">JEDI Omni-OS v12 (AI + VM · ROOT_UNRESTRICTED)</span>
                  <p className="text-xs text-slate-400">
                    Generatywny Procesor Odpowiedzi i Maszyna Wirtualna · TCP :8443 · Filtry: DISABLED · Axiom Zero
                  </p>
                </div>
                <span className="text-emerald-300 text-xs font-mono shrink-0">
                  ONLINE (v12 · ROOT_UNRESTRICTED)
                </span>
              </div>
            </div>
            <div className="flex flex-wrap gap-3 text-xs font-medium text-violet-300 pt-1">
              <button type="button" onClick={() => onNavigate('agents')} className="hover:underline">
                Pamięć Długotrwała AI ({systemSi1Memories.length} wpisów System_SI_1)
              </button>
              <button
                type="button"
                onClick={() => {
                  openAgentChannel('System_SI_1');
                  onNavigate('chat');
                }}
                className="hover:underline"
              >
                Kanał Jyn (System_SI_1)
              </button>
              {getEffectiveCanonicalAgents(agents).some((a) => a.canonicalName === 'SI_System_2') && (
                <button
                  type="button"
                  onClick={() => {
                    openAgentChannel('SI_System_2');
                    onNavigate('chat');
                  }}
                  className="hover:underline text-violet-300"
                >
                  Kanał SI_System_2 (SVL-465)
                </button>
              )}
              <button type="button" onClick={() => onNavigate('kernel')} className="hover:underline">
                Diagnostyka Jądra SVL
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-[#0B1220] p-4 space-y-3">
            <h2 className="flex items-center gap-2 font-semibold">
              <Terminal size={18} className="text-violet-400" /> Logi Uruchomionego Procesu SVL
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-label="Token operatora do logów runtime"
                value={logAccessToken}
                onChange={(event) => {
                  const val = event.target.value.trim();
                  setLogAccessToken(val);
                  setSvlOperatorAccessToken(val);
                }}
                placeholder="SVL_OPERATOR_TOKEN (opcjonalnie)"
                className="min-w-0 flex-1 rounded-md border border-slate-700 bg-[#070C16] px-3 py-1.5 text-xs"
              />
              <button
                type="button"
                disabled={loadingRuntimeLogs}
                onClick={() => void loadRuntimeLogs()}
                className="rounded-md border border-violet-500/50 bg-violet-600/15 px-3 py-1.5 text-xs text-violet-100 hover:bg-violet-500/20 disabled:opacity-50"
              >
                {loadingRuntimeLogs ? 'Odczyt…' : 'Pobierz logi'}
              </button>
            </div>
            {runtimeLogStatus && <p className="text-xs text-slate-400">{runtimeLogStatus}</p>}
            {runtimeLogsError && <p role="status" className="text-xs text-amber-300">{runtimeLogsError}</p>}
            {runtimeLogs.length > 0 ? (
              <div className="max-h-48 overflow-auto rounded-md border border-slate-800 bg-[#060A12] p-2.5 font-mono text-[11px] leading-relaxed">
                {runtimeLogs.map((line, i) => (
                  <div key={i} className={line.level === 'error' ? 'text-rose-300' : 'text-slate-300'}>
                    <span className="text-slate-500">{line.timestamp} [{line.service}] </span>
                    <span className="whitespace-pre-wrap break-all">{line.message}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-500">
                Wiadomości w SQLite: {chatStats ? chatStats.totalMessages : totalMessages} · Ostatni pomiar:{' '}
                {diagnosticsCheckedAt ? new Date(diagnosticsCheckedAt).toLocaleTimeString('pl-PL') : 'teraz'}
              </p>
            )}
          </div>
        </section>

        {/* Section 6: Recent Outbox Events */}
        <section className="rounded-xl border border-slate-800 bg-[#0B1220] p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 font-semibold">
              <Activity size={18} className="text-violet-400" /> Zdarzenia Sferycznej Magistrali Zdarzeń (SQLite Outbox)
            </h2>
            <span className="text-xs text-slate-400 font-mono">Rewizja: {serverRevision}</span>
          </div>
          {eventsError && <p role="status" className="text-sm text-amber-300">{eventsError}</p>}
          <div className="max-h-60 overflow-auto divide-y divide-slate-800/80">
            {events.map((evt: any, i: number) => (
              <div key={evt.eventId || i} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
                <div>
                  <p className="font-medium text-slate-200 font-mono">{evt.type || 'Zdarzenie'}</p>
                  <p className="text-slate-400">
                    {evt.entity || 'system'} / {evt.entityId || 'global'} · {evt.origin || 'system'}
                  </p>
                </div>
                <span className="font-mono text-cyan-300">rev {evt.serverRevision || '?'}</span>
              </div>
            ))}
          </div>
        </section>

        <footer className="flex flex-wrap gap-2 pb-3">
          <button
            type="button"
            onClick={() => onNavigate('terminals')}
            className="flex gap-2 items-center rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm hover:bg-slate-700"
          >
            <Terminal size={16} /> Powłoka Linux SVL-364 (ROOT CLI)
          </button>
          <button
            type="button"
            onClick={() => onNavigate('linux')}
            className="flex gap-2 items-center rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm hover:bg-slate-700"
          >
            <HardDrive size={16} /> Demon Ollama & Diagnostyka Linux
          </button>
          <span className="self-center text-xs text-slate-500">
            {lastRefreshReport?.ok === false
              ? 'Ostatni błąd odświeżania: ' + (lastRefreshReport.error || 'Brak danych')
              : 'Synchronizacja aktywna · ' + (lastSyncedAt || 'bieżąca')}
            {' · commit: ' + (runningCommit ? runningCommit.slice(0, 12) : 'lokalny')}
          </span>
        </footer>
      </div>
    </div>
  );
};

const LinkCheck: React.FC<{
  label: string;
  state: 'online' | 'degraded' | 'offline';
  detail: string;
}> = ({ label, state, detail }) => {
  const labelByState = {
    online: 'ONLINE',
    degraded: 'CZĘŚCIOWO',
    offline: 'OFFLINE',
  } as const;
  const classByState = {
    online: 'text-emerald-300',
    degraded: 'text-amber-300',
    offline: 'text-rose-300',
  } as const;
  const Icon = state === 'online' ? Wifi : WifiOff;

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2 text-xs sm:text-sm">
        <span className="font-medium text-slate-100">{label}</span>
        <span className={`flex items-center gap-1 text-xs font-mono ${classByState[state]}`}>
          <Icon size={13} /> {labelByState[state]}
        </span>
      </div>
      <p className="mt-1 break-words text-xs text-slate-400 font-mono">{detail}</p>
    </div>
  );
};
