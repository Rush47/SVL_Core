import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Bell,
  CheckCircle2,
  Cpu,
  Database,
  Eye,
  FileWarning,
  HardDrive,
  Link2,
  PlugZap,
  Radio,
  RefreshCw,
  Send,
  Server,
  Shield,
  Terminal,
  Thermometer,
  Wifi,
  WifiOff,
  Wrench,
} from 'lucide-react';
import { useSvlSync } from '../utils/svlSyncStore';
import { hasSvlOperatorAccessToken, safeFetchJson } from '../utils/svlLogic';
import { RealVisionPanel } from './RealVisionPanel';
import { Svl364SolarMap, type ShipNavigationData } from './Svl364SolarMap';

type WorkspaceTab = 'chat' | 'svl364' | 'infrastructure' | 'agents' | 'terminals' | 'kernel' | 'linux';
type SubView = 'overview' | 'alerts' | 'mcp' | 'sensors';
type FeedFilter = 'all' | 'alarm' | 'transmission' | 'sensor' | 'incident';

interface CenterProps {
  onNavigate: (tab: WorkspaceTab) => void;
}

interface ShipServiceItem {
  id: string;
  name: string;
  category: string;
  unit: string;
  status: 'online' | 'degraded' | 'offline' | 'unknown';
  rawState: string;
  source: string;
  detail: string;
}

interface ShipSensorItem {
  id: string;
  label: string;
  value: string;
  numericValue: number | null;
  unit: string;
  status: 'nominal' | 'warn' | 'critical';
  source: string;
}

interface ShipFeedItem {
  id: string;
  category: 'transmission' | 'alarm' | 'sensor' | 'incident';
  severity: 'CRITICAL' | 'WARN' | 'INFO';
  title: string;
  message: string;
  source: string;
  resolved?: boolean;
  createdAt?: string;
  ephemeral?: boolean;
}

interface ShipOverviewPayload {
  ok: boolean;
  collectedAt: string;
  connectedVia: string;
  mcpBridge: {
    remoteMcp: {
      configured: boolean;
      enabled: boolean;
      url: string;
      tokenConfigured: boolean;
      rootExecEnabled: boolean;
      connected: boolean;
      lastCheckedAt: string;
      lastError: string;
      toolsCount: number;
    };
    ssh: {
      connected: boolean;
      sshInstalled: boolean;
      targetReachable: boolean;
      targetError: string | null;
      host: string;
      port: number | null;
      uri: string;
      sessionsCount: number;
    };
    rootChannel?: {
      id: string;
      title: string;
      active: boolean;
      preferredTransport: string;
    };
    toolsCount: number;
    callsCount: number;
    probe?: {
      ok: boolean;
      transport: string;
      probedAt: string;
      durationMs?: number;
      error?: string;
      shipHost?: {
        hostname?: string;
        kernel?: string;
        uptime_sec?: number;
        load_avg?: number[];
        cores?: number;
        ram_total_mb?: number;
        ram_available_mb?: number;
        disk_total_gb?: number;
        disk_free_gb?: number;
      };
    };
  };
  telemetry: {
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
      firewall: { tool: string; state: string; detail: string | null; rules?: string[] };
    };
    services: {
      ollama: { url: string; reachable: boolean; latency_ms: number | null; version: string | null; synthetic: boolean; error: string | null };
      comfyui: { url: string; reachable: boolean; latency_ms: number | null; status_code: number | null; error: string | null };
      python_kernel: { reachable: boolean; pid: number; uptime_sec: number };
    };
    ship?: {
      alias: string;
      online: boolean;
      error: string | null;
      hostname?: string | null;
      kernel?: string | null;
      uptime_sec?: number | null;
      load_avg?: number[] | null;
      cores?: number | null;
      ram_total_mb?: number | null;
      ram_available_mb?: number | null;
      disk_free_gb?: number | null;
    } | null;
  };
  services: ShipServiceItem[];
  navigation: ShipNavigationData;
  sensors: ShipSensorItem[];
  feed: ShipFeedItem[];
  incidents: ShipFeedItem[];
  summary: {
    servicesOnline: number;
    servicesTotal: number;
    criticalAlarms: number;
    warnings: number;
    transmissions: number;
    openIncidents: number;
  };
  serverRevision: number;
}

const NA = 'brak danych';

function fmtNum(value: number | null | undefined, digits = 1, unit = ''): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(digits)}${unit}` : NA;
}

function fmtUptime(sec: number | null | undefined): string {
  if (typeof sec !== 'number' || !Number.isFinite(sec)) return NA;
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtRate(bytesPerSec: number | null | undefined): string {
  if (typeof bytesPerSec !== 'number') return NA;
  if (bytesPerSec >= 1024 ** 2) return `${(bytesPerSec / 1024 ** 2).toFixed(2)} MB/s`;
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${bytesPerSec.toFixed(0)} B/s`;
}

function fmtTime(iso?: string): string {
  if (!iso) return '—';
  const dt = new Date(iso);
  return Number.isNaN(dt.getTime()) ? iso : dt.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function clampPct(v: number | null | undefined): string {
  return `${typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0}%`;
}

const STATUS_DOT: Record<string, string> = {
  online: 'bg-emerald-400',
  nominal: 'bg-emerald-400',
  degraded: 'bg-amber-400',
  warn: 'bg-amber-400',
  offline: 'bg-rose-400',
  critical: 'bg-rose-500',
  unknown: 'bg-slate-500',
};

const CATEGORY_META: Record<ShipFeedItem['category'], { label: string; badgeClass: string }> = {
  alarm: { label: 'ALARM', badgeClass: 'bg-rose-500/15 text-rose-300 border-rose-500/35' },
  transmission: { label: 'TRANSMISJA', badgeClass: 'bg-cyan-500/15 text-cyan-200 border-cyan-500/35' },
  sensor: { label: 'SENSOR', badgeClass: 'bg-amber-500/15 text-amber-200 border-amber-500/35' },
  incident: { label: 'INCYDENT', badgeClass: 'bg-slate-700/60 text-slate-200 border-slate-600/50' },
};

export const Svl364CommandCenter: React.FC<CenterProps> = ({ onNavigate }) => {
  const {
    serverRevision,
    wsState,
    openSvl364RootChannel,
    refreshDomainModules,
    refreshAllDomains,
  } = useSvlSync();

  const [subView, setSubView] = useState<SubView>('overview');
  const [feedFilter, setFeedFilter] = useState<FeedFilter>('all');
  const [overview, setOverview] = useState<ShipOverviewPayload | null>(null);
  const [mcpHubStatus, setMcpHubStatus] = useState<any>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isProbingMcp, setIsProbingMcp] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null);

  // Inline Remote MCP Bridge connect drawer
  const [connectOpen, setConnectOpen] = useState(false);
  const [mcpUrlInput, setMcpUrlInput] = useState('');
  const [mcpTokenInput, setMcpTokenInput] = useState('');
  const [mcpSaving, setMcpSaving] = useState(false);

  // Course update state
  const [savingCourse, setSavingCourse] = useState(false);

  // Incident / transmission form state
  const [newCategory, setNewCategory] = useState<ShipFeedItem['category']>('incident');
  const [newSeverity, setNewSeverity] = useState<ShipFeedItem['severity']>('WARN');
  const [newTitle, setNewTitle] = useState('');
  const [newMessage, setNewMessage] = useState('');
  const [submittingIncident, setSubmittingIncident] = useState(false);

  // Direct ROOT MCP command deck
  const [rootCmdInput, setRootCmdInput] = useState('id && hostname && uname -a && uptime && free -h');
  const [rootCmdBusy, setRootCmdBusy] = useState(false);
  const [rootCmdOutput, setRootCmdOutput] = useState('');
  const [serviceBusyId, setServiceBusyId] = useState<string | null>(null);
  const [mcpToolBusy, setMcpToolBusy] = useState(false);
  const [mcpToolOutput, setMcpToolOutput] = useState('');
  const [actionBusy, setActionBusy] = useState<'av' | 'report' | null>(null);

  const busyRef = useRef(false);

  const showNotice = useCallback((text: string, kind: 'ok' | 'warn' | 'err' = 'ok') => {
    setNotice({ kind, text });
  }, []);

  const fetchOverview = useCallback(async (forceProbe = false) => {
    if (busyRef.current && !forceProbe) return;
    if (!hasSvlOperatorAccessToken()) {
      setLoadError('Odblokuj dostęp przyciskiem 🔒 SVL w górnym pasku, aby połączyć się z MCP SVL-364.');
      return;
    }
    busyRef.current = true;
    if (forceProbe) setIsProbingMcp(true);
    else setIsLoading(true);
    try {
      const [ovRes, hubRes] = await Promise.all([
        safeFetchJson<ShipOverviewPayload>(`/api/svl364/overview${forceProbe ? '?probe=1' : ''}`, { timeoutMs: 25000 }),
        safeFetchJson<any>('/api/mcp/hub/status', { timeoutMs: 10000 }),
      ]);
      if (ovRes.ok && ovRes.data?.ok) {
        setOverview(ovRes.data);
        setLoadError(null);
        if (ovRes.data.mcpBridge?.remoteMcp?.url && !mcpUrlInput) {
          setMcpUrlInput(ovRes.data.mcpBridge.remoteMcp.url);
        }
      } else {
        setLoadError(ovRes.data ? String((ovRes.data as any).error || 'Błąd odczytu SVL-364') : ovRes.error || 'Błąd połączenia z bramą SVL.');
      }
      if (hubRes.ok && hubRes.data?.ok) {
        setMcpHubStatus(hubRes.data);
      }
    } finally {
      busyRef.current = false;
      setIsLoading(false);
      setIsProbingMcp(false);
    }
  }, [mcpUrlInput]);

  useEffect(() => {
    void fetchOverview(false);
    const timer = window.setInterval(() => void fetchOverview(false), 15000);
    return () => window.clearInterval(timer);
  }, [fetchOverview]);

  const handleSaveRemoteMcp = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanUrl = mcpUrlInput.trim();
    if (!cleanUrl || mcpSaving) return;
    setMcpSaving(true);
    try {
      const cfg = await safeFetchJson<any>('/api/svl364/mcp-bridge/config', {
        method: 'POST',
        timeoutMs: 12000,
        body: JSON.stringify({
          url: cleanUrl,
          ...(mcpTokenInput.trim() ? { token: mcpTokenInput.trim() } : {}),
          enabled: true,
          root_exec_enabled: true,
        }),
      });
      if (!cfg.ok || !cfg.data?.ok) {
        showNotice(`Błąd zapisu MCP: ${cfg.data?.error || cfg.error || 'nieprawidłowy URL'}`, 'err');
        return;
      }
      setMcpTokenInput('');
      const test = await safeFetchJson<any>('/api/svl364/mcp-bridge/test', {
        method: 'POST',
        timeoutMs: 15000,
        body: JSON.stringify({ timeout_sec: 12 }),
      });
      if (test.ok && test.data?.ok) {
        showNotice(`Połączono z MCP SVL-364 (${test.data.latencyMs ?? '?'} ms · narzędzi: ${test.data.toolsCount ?? 0}).`, 'ok');
        setConnectOpen(false);
      } else {
        showNotice(`Zapisano adres MCP (${test.data?.error || test.error || 'host chwilowo niedostępny — działa fallback SSH'}).`, 'warn');
      }
      await fetchOverview(true);
    } finally {
      setMcpSaving(false);
    }
  };

  const handleUpdateCourse = async (payload: {
    currentBody?: string;
    targetBody?: string;
    missionStatus?: string;
    sector?: string;
  }) => {
    setSavingCourse(true);
    try {
      const res = await safeFetchJson<{ ok: boolean; navigation?: ShipNavigationData; error?: string }>(
        '/api/svl364/navigation',
        { method: 'POST', timeoutMs: 12000, body: JSON.stringify(payload) },
      );
      if (res.ok && res.data?.ok && res.data.navigation) {
        setOverview((prev) => (prev ? { ...prev, navigation: res.data!.navigation! } : prev));
        showNotice(`Zaktualizowano nawigację SVL-364: ${res.data.navigation.sector} (${res.data.navigation.missionStatus}).`, 'ok');
        void fetchOverview(false);
      } else {
        showNotice(res.data?.error || res.error || 'Nie udało się zaktualizować kursu.', 'err');
      }
    } finally {
      setSavingCourse(false);
    }
  };

  const handleRecordIncident = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || submittingIncident) return;
    setSubmittingIncident(true);
    try {
      const res = await safeFetchJson<any>('/api/svl364/incidents', {
        method: 'POST',
        timeoutMs: 12000,
        body: JSON.stringify({
          category: newCategory,
          severity: newSeverity,
          title: newTitle.trim(),
          message: newMessage.trim() || newTitle.trim(),
          emitNotification: newSeverity === 'CRITICAL' || newCategory === 'alarm' || newCategory === 'transmission',
        }),
      });
      if (res.ok && res.data?.ok) {
        setNewTitle('');
        setNewMessage('');
        showNotice('Zapisano wpis w rejestrze SVL-364.', 'ok');
        await fetchOverview(false);
      } else {
        showNotice(res.data?.error || res.error || 'Nie udało się zapisać wpisu.', 'err');
      }
    } finally {
      setSubmittingIncident(false);
    }
  };

  const handleResolveIncident = async (incidentId: string) => {
    const res = await safeFetchJson<any>('/api/svl364/incidents/resolve', {
      method: 'POST',
      timeoutMs: 10000,
      body: JSON.stringify({ incidentId }),
    });
    if (res.ok && res.data?.ok) {
      showNotice(`Zamknięto incydent ${incidentId}.`, 'ok');
      await fetchOverview(false);
    }
  };

  const handleExecRootCmd = async (overrideCmd?: string) => {
    const cmd = (overrideCmd ?? rootCmdInput).trim();
    if (!cmd || rootCmdBusy) return;
    if (overrideCmd) setRootCmdInput(overrideCmd);
    setRootCmdBusy(true);
    try {
      const res = await safeFetchJson<any>('/api/svl364/root/exec', {
        method: 'POST',
        timeoutMs: 35000,
        body: JSON.stringify({ command: cmd, confirmed: true, raw: true, transport: 'auto' }),
      });
      setRootCmdOutput(res.data?.output || res.data?.rawOutput || res.data?.error || res.error || '(brak wyjścia)');
      void fetchOverview(false);
    } finally {
      setRootCmdBusy(false);
    }
  };

  const handleServiceAction = async (unit: string, action: 'status' | 'restart') => {
    if (serviceBusyId) return;
    setServiceBusyId(`${unit}:${action}`);
    try {
      const res = await safeFetchJson<any>('/api/mcp/svl364', {
        method: 'POST',
        timeoutMs: 25000,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tools/call',
          params: { name: 'svl364_service_control', arguments: { service: unit, action, confirmed: true } },
        }),
      });
      const out = res.data?.result?.content?.[0]?.text || JSON.stringify(res.data || res.error, null, 2);
      setMcpToolOutput(out);
      showNotice(`MCP systemd ${action} (${unit}) zakończone.`, res.data?.result?.isError ? 'warn' : 'ok');
      if (action === 'restart') void fetchOverview(true);
    } finally {
      setServiceBusyId(null);
    }
  };

  const handleInvokeMcpTool = async (tool: string, args: Record<string, unknown>) => {
    if (mcpToolBusy) return;
    setMcpToolBusy(true);
    try {
      const res = await safeFetchJson<any>('/api/mcp/svl364', {
        method: 'POST',
        timeoutMs: 25000,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tools/call',
          params: { name: tool, arguments: args },
        }),
      });
      const out = res.data?.result?.content?.[0]?.text || JSON.stringify(res.data?.result || res.data || res.error, null, 2);
      setMcpToolOutput(out);
    } finally {
      setMcpToolBusy(false);
    }
  };

  const handleCopyConnector = async () => {
    const res = await safeFetchJson<{ ok: boolean; connector?: any }>('/api/mcp/hub/connector', { timeoutMs: 8000 });
    const payload = res.data?.connector || {
      mcpServers: {
        'svl-364': {
          url: mcpHubStatus?.standaloneMcp?.publicUrl || `${window.location.origin}/api/mcp/svl364`,
          transport: 'streamable-http',
        },
      },
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      showNotice('Skopiowano konfigurację JSON konektora MCP.', 'ok');
    } catch {
      showNotice('Brak uprawnień schowka przeglądarki.', 'warn');
    }
  };

  const handleRunAvScan = async () => {
    if (actionBusy) return;
    setActionBusy('av');
    try {
      const res = await safeFetchJson<any>('/api/security/antivirus/scan', {
        method: 'POST',
        timeoutMs: 30000,
        body: JSON.stringify({ emitToChat: true, origin: 'svl364-cockpit' }),
      });
      if (res.ok && res.data?.ok) {
        showNotice(`Skan SVL-365 AV OK — plików: ${res.data.filesScanned ?? 0}, usuniętych zagrożeń: ${res.data.totalThreatsRemoved ?? 0}.`, 'ok');
      } else {
        showNotice(res.data?.error || res.error || 'Błąd skanowania AV.', 'err');
      }
      await refreshAllDomains('svl364_av_scan');
      await fetchOverview(false);
    } finally {
      setActionBusy(null);
    }
  };

  const handleEmitReport = async () => {
    if (actionBusy) return;
    setActionBusy('report');
    try {
      const res = await safeFetchJson<any>('/api/py/kernel/markdown-report', {
        method: 'POST',
        timeoutMs: 20000,
        body: JSON.stringify({ directive: 'Pełny raport operacyjny statku SVL-364 (MCP, usługi, sensory, incydenty)', emitToChat: true, origin: 'svl364-cockpit' }),
      });
      if (res.ok && res.data?.ok) {
        showNotice('Wyemitowano pełny raport SVL_System na kanał czatu.', 'ok');
        await refreshDomainModules(['chat', 'modules', 'kernel']);
      } else {
        showNotice(res.data?.error || res.error || 'Błąd generowania raportu.', 'err');
      }
    } finally {
      setActionBusy(null);
    }
  };

  // Derived metrics (prefer live SVL-364 ship probe when connected, clearly label source)
  const host = overview?.telemetry?.host;
  const probeShip = overview?.mcpBridge?.probe?.shipHost;
  const sshShip = overview?.telemetry?.ship;
  const hasRemoteShipMetrics = Boolean(probeShip?.hostname || sshShip?.online);
  const shipLabel = probeShip?.hostname || sshShip?.hostname || host?.hostname || 'SVL-364';
  const metricSourceTag =
    overview?.connectedVia === 'remote-mcp-root'
      ? 'SVL-364 · Remote MCP'
      : overview?.connectedVia === 'openssh-root'
        ? 'SVL-364 · OpenSSH'
        : 'Host lokalny';

  const displayRamTotal = probeShip?.ram_total_mb ?? sshShip?.ram_total_mb ?? host?.memory?.ram_total_mb ?? null;
  const displayRamAvail = probeShip?.ram_available_mb ?? sshShip?.ram_available_mb ?? host?.memory?.ram_available_mb ?? null;
  const displayRamUsed =
    displayRamTotal != null && displayRamAvail != null ? Math.max(0, displayRamTotal - displayRamAvail) : host?.memory?.ram_used_mb ?? null;
  const displayRamPct =
    displayRamTotal && displayRamUsed != null ? Math.round((displayRamUsed / displayRamTotal) * 1000) / 10 : host?.memory?.ram_percent ?? null;

  const displayDiskFree = probeShip?.disk_free_gb ?? sshShip?.disk_free_gb ?? host?.disk?.free_gb ?? null;
  const displayDiskTotal = probeShip?.disk_total_gb ?? host?.disk?.total_gb ?? null;
  const displayDiskPct =
    displayDiskTotal && displayDiskFree != null
      ? Math.round(((displayDiskTotal - displayDiskFree) / displayDiskTotal) * 1000) / 10
      : host?.disk?.percent ?? null;

  const displayLoad = probeShip?.load_avg ?? sshShip?.load_avg ?? host?.cpu?.load_avg ?? null;
  const displayCores = probeShip?.cores ?? sshShip?.cores ?? host?.cpu?.cores ?? null;
  const displayUptime = probeShip?.uptime_sec ?? sshShip?.uptime_sec ?? host?.uptime_sec ?? null;
  const gpuDevice = host?.gpu?.available ? host.gpu.devices[0] : null;

  const filteredFeed = useMemo(() => {
    const items = overview?.feed || [];
    if (feedFilter === 'all') return items;
    return items.filter((item) => item.category === feedFilter);
  }, [overview?.feed, feedFilter]);

  const remoteMcp = overview?.mcpBridge?.remoteMcp;
  const sshBridge = overview?.mcpBridge?.ssh;
  const mcpOnline = Boolean(remoteMcp?.connected || overview?.mcpBridge?.probe?.ok || sshShip?.online);

  return (
    <div className="h-full overflow-y-auto bg-[#060A11] text-slate-100">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 py-4 space-y-4">
        {/* Top Command Header */}
        <header className="rounded-xl border border-slate-800/90 bg-[#0B111B] p-4 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-cyan-400">
                  <Server className="h-3.5 w-3.5" />
                  SVL-364 · EBON APEX
                </span>
                <span
                  className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 font-mono text-[11px] font-semibold ${
                    mcpOnline
                      ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/35'
                      : 'bg-amber-500/15 text-amber-200 border border-amber-500/35'
                  }`}
                >
                  {mcpOnline ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                  {remoteMcp?.connected
                    ? 'MCP ZERO-IP ONLINE'
                    : sshShip?.online
                      ? 'OPENSSH ROOT ONLINE'
                      : remoteMcp?.configured
                        ? 'MCP SKONFIGUROWANY (OFFLINE)'
                        : 'GOTOWY NA MCP SVL-364'}
                </span>
                <span className="font-mono text-[11px] text-slate-400">
                  {metricSourceTag} · rev {overview?.serverRevision ?? serverRevision} · WS {wsState}
                </span>
              </div>
              <h1 className="text-lg sm:text-xl font-semibold tracking-tight text-slate-50">
                Centrum Operacyjne Statku SVL-364
              </h1>
              <p className="text-xs text-slate-400">
                Telemetria na żywo przez MCP, dostępność usług, mapa Układu Słonecznego, transmisje, krytyczne alarmy, sensory i raporty incydentów.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  openSvl364RootChannel();
                  onNavigate('chat');
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/45 bg-amber-500/15 hover:bg-amber-500/25 px-3 py-2 text-xs font-semibold text-amber-100 transition-colors cursor-pointer"
              >
                <Terminal className="h-3.5 w-3.5" />
                Kanał SVL-364 (ROOT)
              </button>
              <button
                type="button"
                onClick={() => setConnectOpen((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/45 bg-cyan-500/15 hover:bg-cyan-500/25 px-3 py-2 text-xs font-semibold text-cyan-100 transition-colors cursor-pointer"
              >
                <PlugZap className="h-3.5 w-3.5" />
                {connectOpen ? 'Ukryj MCP' : 'Połącz MCP'}
              </button>
              <button
                type="button"
                disabled={isProbingMcp || isLoading}
                onClick={() => void fetchOverview(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#111927] hover:bg-[#172235] disabled:opacity-40 px-3 py-2 text-xs font-semibold text-slate-100 transition-colors cursor-pointer"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isProbingMcp || isLoading ? 'animate-spin' : ''}`} />
                {isProbingMcp ? 'Sondowanie MCP...' : 'Odśwież MCP'}
              </button>
            </div>
          </div>

          {/* Inline Remote MCP Zero-IP Connect Bar */}
          {connectOpen && (
            <form
              onSubmit={handleSaveRemoteMcp}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-cyan-500/30 bg-[#070B12] p-3 text-xs"
            >
              <input
                type="url"
                value={mcpUrlInput}
                onChange={(e) => setMcpUrlInput(e.target.value)}
                placeholder="https://<tunel-cloudflare-lub-tailscale>/mcp"
                aria-label="Adres URL zdalnego serwera MCP na SVL-364"
                className="min-w-[230px] flex-1 rounded-md border border-slate-700 bg-[#0B111B] px-3 py-1.5 font-mono text-xs text-slate-100 placeholder:text-slate-500"
              />
              <input
                type="password"
                value={mcpTokenInput}
                onChange={(e) => setMcpTokenInput(e.target.value)}
                placeholder={remoteMcp?.tokenConfigured ? 'Token zapisany (0600) — podmień opcjonalnie' : 'Bearer token MCP SVL-364'}
                aria-label="Bearer token zdalnego MCP SVL-364"
                className="w-60 rounded-md border border-slate-700 bg-[#0B111B] px-3 py-1.5 font-mono text-xs text-slate-100 placeholder:text-slate-500"
              />
              <button
                type="submit"
                disabled={mcpSaving || !mcpUrlInput.trim()}
                className="rounded-md bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 px-3.5 py-1.5 font-semibold text-white cursor-pointer"
              >
                {mcpSaving ? 'Łączenie...' : 'Zapisz i testuj MCP'}
              </button>
            </form>
          )}

          {/* Segmented Navigation + Quick Counters */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/80 pt-3">
            <nav className="flex flex-wrap items-center gap-1" aria-label="Widoki modułu SVL-364">
              {(
                [
                  { id: 'overview', label: 'Przegląd Statku', icon: Activity },
                  {
                    id: 'alerts',
                    label: `Alarmy, Transmisje & Incydenty${overview?.summary?.criticalAlarms ? ` (${overview.summary.criticalAlarms})` : ''}`,
                    icon: Bell,
                  },
                  { id: 'mcp', label: 'Usługi & Konsola MCP ROOT', icon: Terminal },
                  { id: 'sensors', label: 'Sensory & Vision', icon: Eye },
                ] as Array<{ id: SubView; label: string; icon: React.ComponentType<{ className?: string }> }>
              ).map((tab) => {
                const Icon = tab.icon;
                const active = subView === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setSubView(tab.id)}
                    className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                      active
                        ? 'bg-cyan-500/15 text-cyan-200 border border-cyan-500/40'
                        : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/60 border border-transparent'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    {tab.label}
                  </button>
                );
              })}
            </nav>

            <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
              <span className="rounded bg-[#070B12] border border-slate-800 px-2 py-1 text-emerald-300">
                Usługi: {overview?.summary?.servicesOnline ?? 0}/{overview?.summary?.servicesTotal ?? 0}
              </span>
              <span className={`rounded bg-[#070B12] border border-slate-800 px-2 py-1 ${(overview?.summary?.criticalAlarms ?? 0) > 0 ? 'text-rose-300' : 'text-slate-400'}`}>
                Alarmy: {overview?.summary?.criticalAlarms ?? 0}
              </span>
              <span className="rounded bg-[#070B12] border border-slate-800 px-2 py-1 text-cyan-300">
                Transmisje: {overview?.summary?.transmissions ?? 0}
              </span>
            </div>
          </div>
        </header>

        {loadError && (
          <div role="alert" className="rounded-lg border border-amber-500/40 bg-amber-950/25 px-3.5 py-2.5 text-xs text-amber-200 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{loadError}</span>
          </div>
        )}

        {notice && (
          <div
            role="status"
            className={`rounded-lg border px-3.5 py-2 text-xs flex items-center justify-between gap-2 ${
              notice.kind === 'ok'
                ? 'border-emerald-500/35 bg-emerald-950/25 text-emerald-200'
                : notice.kind === 'warn'
                  ? 'border-amber-500/35 bg-amber-950/25 text-amber-200'
                  : 'border-rose-500/35 bg-rose-950/25 text-rose-200'
            }`}
          >
            <span>{notice.text}</span>
            <button type="button" onClick={() => setNotice(null)} className="text-slate-400 hover:text-white cursor-pointer">
              Zamknij
            </button>
          </div>
        )}

        {/* ==================== VIEW 1: PRZEGLĄD STATKU ==================== */}
        {subView === 'overview' && (
          <div className="space-y-4">
            {/* Row 1: 4 Key Ship Telemetry Gauges */}
            <section aria-label="Kluczowa telemetria statku SVL-364" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {/* CPU & Load */}
              <div className="rounded-xl border border-slate-800/90 bg-[#0B111B] p-4 space-y-2">
                <div className="flex items-center justify-between text-xs font-mono text-slate-400">
                  <span className="flex items-center gap-1.5 text-cyan-300 uppercase"><Cpu className="h-3.5 w-3.5" /> Procesor · {shipLabel}</span>
                  <span className="text-slate-100 font-semibold tabular-nums">{fmtNum(host?.cpu?.percent, 1, '%')}</span>
                </div>
                <div className="text-base font-mono font-semibold text-slate-50 tabular-nums">
                  {displayCores ?? NA} rdz. · load {displayLoad ? displayLoad[0].toFixed(2) : NA}
                </div>
                <div className="h-1.5 w-full rounded-full bg-slate-900 overflow-hidden">
                  <div className="h-full bg-cyan-400 transition-all" style={{ width: clampPct(host?.cpu?.percent) }} />
                </div>
                <div className="flex justify-between text-[11px] font-mono text-slate-400">
                  <span>Uptime: {fmtUptime(displayUptime)}</span>
                  <span>{hasRemoteShipMetrics ? 'SVL-364' : host?.architecture || 'Linux'}</span>
                </div>
              </div>

              {/* RAM */}
              <div className="rounded-xl border border-slate-800/90 bg-[#0B111B] p-4 space-y-2">
                <div className="flex items-center justify-between text-xs font-mono text-slate-400">
                  <span className="flex items-center gap-1.5 text-emerald-300 uppercase"><Database className="h-3.5 w-3.5" /> Pamięć RAM</span>
                  <span className="text-slate-100 font-semibold tabular-nums">{fmtNum(displayRamPct, 1, '%')}</span>
                </div>
                <div className="text-base font-mono font-semibold text-slate-50 tabular-nums">
                  {displayRamUsed != null && displayRamTotal != null
                    ? `${(displayRamUsed / 1024).toFixed(1)} / ${(displayRamTotal / 1024).toFixed(1)} GB`
                    : NA}
                </div>
                <div className="h-1.5 w-full rounded-full bg-slate-900 overflow-hidden">
                  <div
                    className={`h-full transition-all ${(displayRamPct ?? 0) >= 85 ? 'bg-rose-400' : 'bg-emerald-400'}`}
                    style={{ width: clampPct(displayRamPct) }}
                  />
                </div>
                <div className="flex justify-between text-[11px] font-mono text-slate-400">
                  <span>Wolne: {fmtNum(displayRamAvail, 0, ' MB')}</span>
                  <span>Swap: {host?.memory?.swap_total_mb ? `${fmtNum(host.memory.swap_used_mb, 0)} MB` : 'brak'}</span>
                </div>
              </div>

              {/* Disk */}
              <div className="rounded-xl border border-slate-800/90 bg-[#0B111B] p-4 space-y-2">
                <div className="flex items-center justify-between text-xs font-mono text-slate-400">
                  <span className="flex items-center gap-1.5 text-amber-300 uppercase"><HardDrive className="h-3.5 w-3.5" /> Dysk główny `/`</span>
                  <span className="text-slate-100 font-semibold tabular-nums">{fmtNum(displayDiskPct, 1, '%')}</span>
                </div>
                <div className="text-base font-mono font-semibold text-slate-50 tabular-nums">
                  {displayDiskFree != null ? `${displayDiskFree.toFixed(1)} GB wolne` : NA}
                </div>
                <div className="h-1.5 w-full rounded-full bg-slate-900 overflow-hidden">
                  <div
                    className={`h-full transition-all ${(displayDiskPct ?? 0) >= 85 ? 'bg-amber-400' : 'bg-sky-400'}`}
                    style={{ width: clampPct(displayDiskPct) }}
                  />
                </div>
                <div className="flex justify-between text-[11px] font-mono text-slate-400">
                  <span>Pojemność: {displayDiskTotal != null ? `${displayDiskTotal.toFixed(1)} GB` : NA}</span>
                  <span>Pomiar: {fmtTime(overview?.collectedAt)}</span>
                </div>
              </div>

              {/* GPU / Thermal / Firewall */}
              <div className="rounded-xl border border-slate-800/90 bg-[#0B111B] p-4 space-y-2">
                <div className="flex items-center justify-between text-xs font-mono text-slate-400">
                  <span className="flex items-center gap-1.5 text-slate-200 uppercase"><Shield className="h-3.5 w-3.5 text-cyan-400" /> GPU · Zapora</span>
                  <span className={host?.firewall?.state === 'active' ? 'text-emerald-300 font-semibold' : 'text-amber-300 font-semibold'}>
                    {(host?.firewall?.state || 'unknown').toUpperCase()}
                  </span>
                </div>
                <div className="text-base font-mono font-semibold text-slate-50 truncate">
                  {gpuDevice ? `${gpuDevice.name}` : `Zapora ${host?.firewall?.tool || 'ufw'}`}
                </div>
                <div className="text-[11px] font-mono text-slate-300">
                  {gpuDevice
                    ? `VRAM ${fmtNum(gpuDevice.memory_used_mb, 0)}/${fmtNum(gpuDevice.memory_total_mb, 0, ' MB')} · ${fmtNum(gpuDevice.temperature_c, 0, '°C')}`
                    : host?.firewall?.detail || 'Brak dedykowanego GPU na hoście'}
                </div>
                <div className="text-[11px] font-mono text-slate-500">
                  MCP wywołań: {overview?.mcpBridge?.callsCount ?? 0} · narzędzi: {overview?.mcpBridge?.toolsCount ?? 0}
                </div>
              </div>
            </section>

            {/* Row 2: Interactive Solar System Map */}
            <Svl364SolarMap
              navigation={overview?.navigation || null}
              savingCourse={savingCourse}
              onUpdateCourse={handleUpdateCourse}
            />

            {/* Row 3: Two-Column Live Operations (Services + Notifications/Alarms/Transmissions) */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
              {/* Left 5 cols: Services & Availability */}
              <section
                aria-label="Usługi statku SVL-364 i ich dostępność"
                className="lg:col-span-5 rounded-xl border border-slate-800/90 bg-[#0B111B] flex flex-col"
              >
                <div className="flex items-center justify-between gap-2 border-b border-slate-800/80 px-4 py-3">
                  <div>
                    <h2 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                      <Link2 className="h-4 w-4 text-emerald-400" />
                      Usługi SVL-364 i dostępność
                    </h2>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Online: {overview?.summary?.servicesOnline ?? 0} / {overview?.summary?.servicesTotal ?? 0} · sterowanie przez MCP
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSubView('mcp')}
                    className="text-[11px] font-mono text-cyan-300 hover:text-cyan-200 cursor-pointer"
                  >
                    Konsola ROOT →
                  </button>
                </div>

                <div className="divide-y divide-slate-800/70 flex-1 overflow-y-auto max-h-[420px]">
                  {(overview?.services || []).map((svc) => (
                    <div key={svc.id} className="px-4 py-2.5 flex items-center justify-between gap-3 hover:bg-slate-900/40">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`h-2 w-2 rounded-full shrink-0 ${STATUS_DOT[svc.status] || 'bg-slate-500'}`} />
                          <span className="text-xs font-medium text-slate-100 truncate">{svc.name}</span>
                        </div>
                        <div className="text-[11px] font-mono text-slate-400 truncate mt-0.5">{svc.detail}</div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span
                          className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${
                            svc.status === 'online'
                              ? 'bg-emerald-500/15 text-emerald-300'
                              : svc.status === 'degraded'
                                ? 'bg-amber-500/15 text-amber-200'
                                : 'bg-rose-500/15 text-rose-300'
                          }`}
                        >
                          {svc.rawState}
                        </span>
                        {svc.unit && (
                          <button
                            type="button"
                            disabled={serviceBusyId !== null}
                            onClick={() => void handleServiceAction(svc.unit, 'restart')}
                            title={`Restartuj ${svc.unit} przez MCP`}
                            className="rounded border border-slate-700 hover:border-cyan-500/50 bg-[#070B12] px-1.5 py-0.5 font-mono text-[10px] text-slate-300 hover:text-cyan-200 disabled:opacity-40 cursor-pointer"
                          >
                            {serviceBusyId === `${svc.unit}:restart` ? '...' : 'Restart'}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              {/* Right 7 cols: Live Ship Notifications, Transmissions, Alarms & Incidents */}
              <section
                aria-label="Powiadomienia ze statku, transmisje, krytyczne alarmy i incydenty"
                className="lg:col-span-7 rounded-xl border border-slate-800/90 bg-[#0B111B] flex flex-col"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 px-4 py-3">
                  <div>
                    <h2 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                      <Bell className="h-4 w-4 text-amber-400" />
                      Transmisje, Krytyczne Alarmy, Sensory i Incydenty
                    </h2>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Strumień zdarzeń SVL-364 z MCP, monitora statku, sensorów i rejestru SQLite
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    {(
                      [
                        { id: 'all', label: 'Wszystkie' },
                        { id: 'alarm', label: 'Alarmy' },
                        { id: 'transmission', label: 'Transmisje' },
                        { id: 'sensor', label: 'Sensory' },
                        { id: 'incident', label: 'Incydenty' },
                      ] as Array<{ id: FeedFilter; label: string }>
                    ).map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => setFeedFilter(f.id)}
                        className={`rounded px-2 py-0.5 font-mono text-[10px] transition-colors cursor-pointer ${
                          feedFilter === f.id
                            ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-500/40'
                            : 'bg-[#070B12] text-slate-400 hover:text-slate-200 border border-slate-800'
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="divide-y divide-slate-800/70 flex-1 overflow-y-auto max-h-[420px]">
                  {filteredFeed.length === 0 ? (
                    <div className="p-6 text-center text-xs text-slate-500">
                      Brak wpisów w tej kategorii. Użyj „Odśwież MCP” lub zakładki „Alarmy, Transmisje &amp; Incydenty”, aby dodać raport.
                    </div>
                  ) : (
                    filteredFeed.slice(0, 20).map((item) => {
                      const cat = CATEGORY_META[item.category] || CATEGORY_META.incident;
                      return (
                        <div key={item.id} className="px-4 py-3 space-y-1 hover:bg-slate-900/40">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold shrink-0 ${cat.badgeClass}`}>
                                {cat.label}
                              </span>
                              <span
                                className={`font-mono text-[10px] font-semibold shrink-0 ${
                                  item.severity === 'CRITICAL'
                                    ? 'text-rose-400'
                                    : item.severity === 'WARN'
                                      ? 'text-amber-300'
                                      : 'text-slate-400'
                                }`}
                              >
                                {item.severity}
                              </span>
                              <span className="text-xs font-medium text-slate-100 truncate">{item.title}</span>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="font-mono text-[10px] text-slate-500">{fmtTime(item.createdAt)}</span>
                              {!item.ephemeral && !item.resolved && (
                                <button
                                  type="button"
                                  onClick={() => void handleResolveIncident(item.id)}
                                  className="rounded border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300 cursor-pointer"
                                >
                                  Zamknij
                                </button>
                              )}
                              {item.resolved && (
                                <span className="inline-flex items-center gap-0.5 font-mono text-[10px] text-emerald-400">
                                  <CheckCircle2 className="h-3 w-3" /> OK
                                </span>
                              )}
                            </div>
                          </div>
                          {item.message && item.message !== item.title && (
                            <p className="text-xs text-slate-400 whitespace-pre-wrap line-clamp-3">{item.message}</p>
                          )}
                          <div className="font-mono text-[10px] text-slate-500">Źródło: {item.source}</div>
                        </div>
                      );
                    })
                  )}
                </div>
              </section>
            </div>
          </div>
        )}

        {/* ==================== VIEW 2: ALARMY, TRANSMISJE & INCYDENTY ==================== */}
        {subView === 'alerts' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            {/* Left: Log new incident / transmission / alarm + quick diagnostic triggers */}
            <div className="lg:col-span-4 space-y-4">
              <form
                onSubmit={handleRecordIncident}
                className="rounded-xl border border-slate-800/90 bg-[#0B111B] p-4 space-y-3"
              >
                <h2 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                  <FileWarning className="h-4 w-4 text-amber-400" />
                  Nowy raport incydentu / transmisji
                </h2>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <select
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value as ShipFeedItem['category'])}
                    aria-label="Kategoria zgłoszenia"
                    className="rounded-lg border border-slate-700 bg-[#070B12] px-2.5 py-1.5 text-slate-100"
                  >
                    <option value="transmission">Transmisja</option>
                    <option value="alarm">Krytyczny alarm</option>
                    <option value="sensor">Odczyt z sensora</option>
                    <option value="incident">Raport incydentu</option>
                  </select>
                  <select
                    value={newSeverity}
                    onChange={(e) => setNewSeverity(e.target.value as ShipFeedItem['severity'])}
                    aria-label="Priorytet zgłoszenia"
                    className="rounded-lg border border-slate-700 bg-[#070B12] px-2.5 py-1.5 text-slate-100"
                  >
                    <option value="CRITICAL">CRITICAL</option>
                    <option value="WARN">WARN</option>
                    <option value="INFO">INFO</option>
                  </select>
                </div>
                <input
                  type="text"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="Tytuł transmisji, alarmu lub incydentu..."
                  className="w-full rounded-lg border border-slate-700 bg-[#070B12] px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500"
                />
                <textarea
                  rows={3}
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  placeholder="Szczegóły, dane z sensorów, analiza lub podjęte kroki..."
                  className="w-full rounded-lg border border-slate-700 bg-[#070B12] px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 resize-y"
                />
                <button
                  type="submit"
                  disabled={submittingIncident || !newTitle.trim()}
                  className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 px-3 py-2 text-xs font-semibold text-white cursor-pointer"
                >
                  <Send className="h-3.5 w-3.5" />
                  {submittingIncident ? 'Zapisywanie...' : 'Zapisz raport w SQLite'}
                </button>
              </form>

              <div className="rounded-xl border border-slate-800/90 bg-[#0B111B] p-4 space-y-2.5">
                <h3 className="text-xs font-mono uppercase tracking-wider text-slate-400">
                  Szybkie inspekcje bezpieczeństwa
                </h3>
                <button
                  type="button"
                  disabled={actionBusy !== null}
                  onClick={() => void handleRunAvScan()}
                  className="w-full flex items-center justify-between rounded-lg border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 px-3 py-2 text-xs font-medium text-emerald-200 disabled:opacity-40 cursor-pointer"
                >
                  <span className="flex items-center gap-2"><Shield className="h-4 w-4" /> Skaner SVL-365 Sentinel AV</span>
                  <span className="font-mono text-[10px]">{actionBusy === 'av' ? 'SKAN...' : 'URUCHOM'}</span>
                </button>
                <button
                  type="button"
                  disabled={actionBusy !== null}
                  onClick={() => void handleEmitReport()}
                  className="w-full flex items-center justify-between rounded-lg border border-cyan-500/40 bg-cyan-500/10 hover:bg-cyan-500/20 px-3 py-2 text-xs font-medium text-cyan-200 disabled:opacity-40 cursor-pointer"
                >
                  <span className="flex items-center gap-2"><Radio className="h-4 w-4" /> Pełny raport SVL_System</span>
                  <span className="font-mono text-[10px]">{actionBusy === 'report' ? 'EMISJA...' : 'WYŚLIJ'}</span>
                </button>
                <button
                  type="button"
                  disabled={isProbingMcp}
                  onClick={() => void fetchOverview(true)}
                  className="w-full flex items-center justify-between rounded-lg border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 px-3 py-2 text-xs font-medium text-amber-200 disabled:opacity-40 cursor-pointer"
                >
                  <span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> Pobierz journalctl błędy przez MCP</span>
                  <span className="font-mono text-[10px]">{isProbingMcp ? 'SONDA...' : 'SKANUJ'}</span>
                </button>
              </div>
            </div>

            {/* Right: Full Filterable Feed */}
            <div className="lg:col-span-8 rounded-xl border border-slate-800/90 bg-[#0B111B] flex flex-col">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 px-4 py-3">
                <h2 className="text-sm font-semibold text-slate-100">
                  Pełny rejestr powiadomień, transmisji i incydentów ({filteredFeed.length})
                </h2>
                <div className="flex flex-wrap gap-1">
                  {(['all', 'alarm', 'transmission', 'sensor', 'incident'] as FeedFilter[]).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setFeedFilter(f)}
                      className={`rounded px-2.5 py-1 font-mono text-[11px] cursor-pointer ${
                        feedFilter === f
                          ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-500/40'
                          : 'bg-[#070B12] text-slate-400 border border-slate-800'
                      }`}
                    >
                      {f === 'all' ? 'Wszystkie' : CATEGORY_META[f].label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="divide-y divide-slate-800/70 max-h-[620px] overflow-y-auto">
                {filteredFeed.map((item) => {
                  const cat = CATEGORY_META[item.category] || CATEGORY_META.incident;
                  return (
                    <div key={item.id} className="px-4 py-3 space-y-1.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${cat.badgeClass}`}>
                            {cat.label}
                          </span>
                          <span
                            className={`font-mono text-[10px] font-semibold ${
                              item.severity === 'CRITICAL'
                                ? 'text-rose-400'
                                : item.severity === 'WARN'
                                  ? 'text-amber-300'
                                  : 'text-slate-400'
                            }`}
                          >
                            {item.severity}
                          </span>
                          <span className="text-xs font-semibold text-slate-100">{item.title}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[10px] text-slate-500">{fmtTime(item.createdAt)}</span>
                          {!item.ephemeral && !item.resolved && (
                            <button
                              type="button"
                              onClick={() => void handleResolveIncident(item.id)}
                              className="rounded border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 px-2 py-0.5 font-mono text-[10px] text-emerald-300 cursor-pointer"
                            >
                              Oznacz rozwiązany
                            </button>
                          )}
                        </div>
                      </div>
                      <p className="text-xs text-slate-300 whitespace-pre-wrap">{item.message}</p>
                      <div className="font-mono text-[10px] text-slate-500">Źródło: {item.source}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ==================== VIEW 3: USŁUGI & KONSOLA MCP ROOT ==================== */}
        {subView === 'mcp' && (
          <div className="space-y-4">
            {/* MCP Hub Connection Info */}
            <div className="rounded-xl border border-slate-800/90 bg-[#0B111B] p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold text-slate-100">
                    Połączenie MCP ze statkiem SVL-364 (Zero-IP / Mesh + OpenSSH ROOT)
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Remote MCP: <span className="font-mono text-cyan-300">{remoteMcp?.url || 'nie skonfigurowano'}</span>
                    {' · '}OpenSSH: <span className="font-mono text-emerald-300">{sshBridge?.uri || 'ssh://Ship'}</span>
                    {' · '}Tunel lokalny: <span className="font-mono text-slate-300">{mcpHubStatus?.standaloneMcp?.publicUrl || 'uruchom npm run mcp'}</span>
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleCopyConnector()}
                  className="rounded-lg border border-cyan-500/45 bg-cyan-500/15 hover:bg-cyan-500/25 px-3 py-1.5 text-xs font-mono font-semibold text-cyan-100 cursor-pointer"
                >
                  Kopiuj JSON konektora MCP
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Direct Arbitrary ROOT Command Console */}
              <div className="rounded-xl border border-slate-800/90 bg-[#0B111B] p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-mono uppercase tracking-wider text-amber-300 font-semibold flex items-center gap-1.5">
                    <Terminal className="h-4 w-4" /> Konsola ROOT MCP (dowolne polecenia · uid=0)
                  </h3>
                  <button
                    type="button"
                    onClick={() => {
                      openSvl364RootChannel();
                      onNavigate('chat');
                    }}
                    className="text-[11px] font-mono text-cyan-300 hover:underline cursor-pointer"
                  >
                    Otwórz pełny kanał →
                  </button>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {[
                    { label: 'id & uname', cmd: 'id && hostname && uname -a && uptime && free -h' },
                    { label: 'Usługi SVL', cmd: 'systemctl list-units "svl*" ollama.service --no-pager' },
                    { label: 'Porty & Sieć', cmd: 'ss -tlnp && ip -br addr' },
                    { label: 'Błędy journalctl', cmd: 'journalctl -p err..emerg -n 20 --no-pager' },
                  ].map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      disabled={rootCmdBusy}
                      onClick={() => void handleExecRootCmd(p.cmd)}
                      className="rounded border border-slate-700 bg-[#070B12] hover:border-amber-500/50 px-2 py-1 font-mono text-[11px] text-slate-300 hover:text-amber-200 cursor-pointer"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>

                <div className="flex gap-2">
                  <input
                    type="text"
                    value={rootCmdInput}
                    onChange={(e) => setRootCmdInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleExecRootCmd();
                    }}
                    placeholder="Wpisz dowolne polecenie Linux do wykonania jako ROOT..."
                    className="flex-1 min-w-0 rounded-lg border border-slate-700 bg-[#070B12] px-3 py-2 font-mono text-xs text-slate-100"
                  />
                  <button
                    type="button"
                    disabled={rootCmdBusy}
                    onClick={() => void handleExecRootCmd()}
                    className="rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-40 px-3.5 py-2 text-xs font-mono font-semibold text-white cursor-pointer"
                  >
                    {rootCmdBusy ? 'ROOT...' : 'Wykonaj'}
                  </button>
                </div>

                {rootCmdOutput && (
                  <pre className="max-h-72 overflow-auto rounded-lg border border-slate-800 bg-[#05080F] p-3 font-mono text-[11px] text-emerald-200 whitespace-pre-wrap">
                    {rootCmdOutput}
                  </pre>
                )}
              </div>

              {/* MCP Tool Runner */}
              <div className="rounded-xl border border-slate-800/90 bg-[#0B111B] p-4 space-y-3">
                <h3 className="text-xs font-mono uppercase tracking-wider text-cyan-300 font-semibold flex items-center gap-1.5">
                  <Wrench className="h-4 w-4" /> Narzędzia MCP SVL-364 (JSON-RPC 2.0)
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                  {[
                    { label: 'Telemetria', tool: 'svl364_linux_telemetry', args: {} },
                    { label: 'Zasoby', tool: 'svl364_resources', args: { area: 'overview' } },
                    { label: 'Usługi', tool: 'svl364_resources', args: { area: 'services' } },
                    { label: 'Modele Ollama', tool: 'svl364_ollama_control', args: { action: 'list', confirmed: false } },
                    { label: 'Tunel Zero-IP', tool: 'svl364_tunnel_control', args: { action: 'status', confirmed: false } },
                    { label: 'Kontenery', tool: 'svl364_container_control', args: { action: 'list', confirmed: false } },
                    { label: 'Sieć i zapora', tool: 'svl364_network_control', args: { action: 'interfaces', confirmed: false } },
                    { label: 'ComfyUI', tool: 'svl364_comfyui_control', args: { action: 'status', confirmed: false } },
                    { label: 'Test SSH', tool: 'svl364_ssh_test', args: {} },
                  ].map((btn) => (
                    <button
                      key={btn.label}
                      type="button"
                      disabled={mcpToolBusy}
                      onClick={() => void handleInvokeMcpTool(btn.tool, btn.args)}
                      className="rounded-lg border border-slate-800 bg-[#070B12] hover:border-cyan-500/50 px-2.5 py-2 text-left font-mono text-[11px] text-slate-200 hover:text-cyan-200 disabled:opacity-40 cursor-pointer"
                    >
                      {btn.label}
                    </button>
                  ))}
                </div>
                {mcpToolOutput && (
                  <pre className="max-h-72 overflow-auto rounded-lg border border-slate-800 bg-[#05080F] p-3 font-mono text-[11px] text-cyan-200 whitespace-pre-wrap">
                    {mcpToolOutput}
                  </pre>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ==================== VIEW 4: SENSORY & VISION ==================== */}
        {subView === 'sensors' && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
              {/* Hardware Sensors Grid */}
              <div className="lg:col-span-7 rounded-xl border border-slate-800/90 bg-[#0B111B] p-4 space-y-3">
                <h2 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                  <Thermometer className="h-4 w-4 text-cyan-400" />
                  Sensory sprzętowe i środowiskowe ({overview?.sensors?.length ?? 0})
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {(overview?.sensors || []).map((s) => (
                    <div
                      key={s.id}
                      className="rounded-lg border border-slate-800 bg-[#070B12] px-3 py-2.5 flex items-center justify-between gap-2"
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-slate-200 truncate">{s.label}</div>
                        <div className="font-mono text-[10px] text-slate-500">{s.source}</div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="font-mono text-xs font-semibold text-slate-100 tabular-nums">{s.value}</span>
                        <span className={`h-2.5 w-2.5 rounded-full ${STATUS_DOT[s.status] || 'bg-slate-500'}`} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Network Interfaces */}
              <div className="lg:col-span-5 rounded-xl border border-slate-800/90 bg-[#0B111B] p-4 space-y-3">
                <h2 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                  <Radio className="h-4 w-4 text-emerald-400" />
                  Interfejsy sieciowe (`/proc/net/dev`)
                </h2>
                {host?.network?.length ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left font-mono text-xs">
                      <thead className="text-slate-500 border-b border-slate-800">
                        <tr>
                          <th className="py-1.5 pr-2 font-normal">Interfejs</th>
                          <th className="py-1.5 pr-2 font-normal">↓ RX</th>
                          <th className="py-1.5 font-normal">↑ TX</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/60">
                        {host.network.map((nic) => (
                          <tr key={nic.interface} className="text-slate-200">
                            <td className="py-1.5 pr-2 text-cyan-300">{nic.interface}</td>
                            <td className="py-1.5 pr-2 tabular-nums">{fmtRate(nic.rx_bytes_per_sec)}</td>
                            <td className="py-1.5 tabular-nums">{fmtRate(nic.tx_bytes_per_sec)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-xs text-slate-500">Brak aktywnych interfejsów poza loopback.</p>
                )}
              </div>
            </div>

            {/* Optical Vision Sensors */}
            <RealVisionPanel mode="embedded" />
          </div>
        )}
      </div>
    </div>
  );
};
