import React, { useCallback, useEffect, useState } from 'react';
import {
  Boxes,
  Clock,
  HardDrive,
  ListChecks,
  Network,
  Plus,
  Radar,
  RefreshCw,
  Server,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useSvlSync } from '../utils/svlSyncStore';
import { hasSvlOperatorAccessToken, safeFetchJson } from '../utils/svlLogic';
import { SvlAvatar } from './AgentAvatar';

interface InfrastructureWorkspaceProps {
  onNavigateTab: (
    tab: 'chat' | 'svl364' | 'infrastructure' | 'agents' | 'terminals' | 'kernel' | 'linux',
  ) => void;
}

interface TcpProbe {
  reachable: boolean;
  rtt_ms: number | null;
  error: string | null;
}

/** Odpowiedź GET /api/py/infrastructure — wyłącznie prawdziwe źródła. */
interface InfrastructureReport {
  ok: boolean;
  collected_at: string;
  hostname: string;
  ssh_hosts: {
    source: string;
    reason: string | null;
    hosts: Array<{ alias: string; hostname: string; port: number; user: string | null; probe: TcpProbe }>;
  };
  monitored: Array<{
    id: string;
    name: string;
    status: string;
    address: string | null;
    probe: TcpProbe | null;
    note: string | null;
  }>;
  discovered: {
    hosts: Array<{
      key: string;
      addresses: string[];
      names: string[];
      mac: string | null;
      interface: string | null;
      neighbor_state: string | null;
      sources: string[];
      ssh_port: number | null;
      probe: TcpProbe | null;
      first_seen: string;
      last_seen: string;
      seen_now: boolean;
      tracked: boolean;
    }>;
    sources: { neighbors: string; known_hosts: string; etc_hosts: string };
    hashed_known_hosts: number;
    retention_hours: number;
  };
  systemd: {
    available: boolean;
    reason: string | null;
    units: Array<{
      unit: string;
      active_state?: string | null;
      sub_state?: string | null;
      main_pid?: number | null;
      active_since?: string | null;
      error: string | null;
    }>;
  };
  docker: {
    available: boolean;
    reason: string | null;
    containers: Array<{ name: string; image: string; state: string; status: string }>;
  };
  listening_ports: Array<{ address: string; port: number; service: string | null }>;
  mounts: Array<{
    device: string;
    mountpoint: string;
    fstype: string;
    total_gb?: number;
    free_gb?: number;
    percent?: number | null;
    error: string | null;
  }>;
  tasks: Array<{
    id: string;
    target_agent: string;
    title: string;
    status: string;
    error: string | null;
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
  }>;
}

const REFRESH_INTERVAL_MS = 30000;
const SOURCE_LABEL: Record<string, string> = {
  arp: 'sąsiad w sieci (ARP/NDP)',
  known_hosts: 'known_hosts',
  etc_hosts: '/etc/hosts',
  dns: 'odwrotny DNS',
};
const ADDRESS_RE = /^(?:\[[0-9A-Fa-f:]+\]|[A-Za-z0-9._-]{1,253}):\d{1,5}$/;

const fmtTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'medium' }) : '—';

const durationBetween = (from: string | null, to: string | null) => {
  if (!from) return '—';
  const ms = (to ? new Date(to).getTime() : Date.now()) - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} s`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min ${sec % 60} s`;
  return `${Math.floor(sec / 3600)} h ${Math.floor((sec % 3600) / 60)} min`;
};

const ProbeBadge: React.FC<{ probe: TcpProbe | null; note?: string | null }> = ({ probe, note }) => {
  if (!probe) return <span className="text-[11px] font-mono text-slate-500">{note || 'brak pomiaru'}</span>;
  return probe.reachable ? (
    <span className="text-[11px] font-mono text-emerald-300">OSIĄGALNY · {probe.rtt_ms} ms</span>
  ) : (
    <span className="text-[11px] font-mono text-rose-300 break-all" title={probe.error || undefined}>
      NIEOSIĄGALNY · {probe.error}
    </span>
  );
};

const Unavailable: React.FC<{ reason: string | null }> = ({ reason }) => (
  <p className="text-xs text-slate-400 rounded-lg border border-slate-800 bg-[#070C16] px-3 py-2">{reason || 'Brak danych.'}</p>
);

export const InfrastructureWorkspace: React.FC<InfrastructureWorkspaceProps> = ({ onNavigateTab }) => {
  const { systemModules, agentsData, serverRevision, upsertSystemModule, deleteSystemModule, refreshDomainModules } =
    useSvlSync();

  const [report, setReport] = useState<InfrastructureReport | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [newHostName, setNewHostName] = useState('');
  const [newHostAddress, setNewHostAddress] = useState('');
  const [isSavingHost, setIsSavingHost] = useState(false);
  const [isEmittingReport, setIsEmittingReport] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const loadReport = useCallback(async () => {
    if (!hasSvlOperatorAccessToken()) {
      setReportError('Wymagana autoryzacja SVL_OPERATOR_TOKEN (🔒 SVL w pasku górnym).');
      return;
    }
    setIsLoading(true);
    try {
      const res = await safeFetchJson<InfrastructureReport>('/api/py/infrastructure', { timeoutMs: 20000 });
      if (res.ok && res.data?.ok) {
        setReport(res.data);
        setReportError(null);
      } else {
        setReportError(res.error || `Nie udało się pobrać danych infrastruktury (HTTP ${res.status}).`);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadReport();
    const timer = setInterval(() => void loadReport(), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [loadReport]);

  const agentsList: any[] = Array.isArray(agentsData?.agents) ? agentsData.agents : [];
  const otherModules = systemModules.filter(
    (m) => !(m.config && typeof m.config === 'object' && (m.config as any).category === 'infrastructure'),
  );

  const handleAddHost = async (e: React.FormEvent) => {
    e.preventDefault();
    await addMonitoredHost(newHostName.trim(), newHostAddress.trim(), true);
  };

  const handleMonitorDiscovered = async (host: InfrastructureReport['discovered']['hosts'][number]) => {
    const target = host.addresses[0] || host.names[0];
    const portText = window.prompt(
      `Który port TCP sprawdzać dla ${host.names[0] || target}? (np. 22 SSH, 80 HTTP, 445 SMB)`,
      String(host.ssh_port || 22),
    );
    if (!portText) return;
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setStatusMsg(`Nieprawidłowy port: ${portText}`);
      return;
    }
    const address = target.includes(':') ? `[${target}]:${port}` : `${target}:${port}`;
    await addMonitoredHost(host.names[0] || target, address, false);
  };

  const addMonitoredHost = async (name: string, address: string, fromForm: boolean) => {
    if (!name || isSavingHost) return;
    if (!ADDRESS_RE.test(address)) {
      setStatusMsg('Podaj adres w formacie host:port, np. nas.local:445 albo 192.168.1.10:22.');
      return;
    }
    setIsSavingHost(true);
    setStatusMsg(null);
    try {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36);
      const id = `svl-infra-${slug || Date.now()}`;
      const res = await upsertSystemModule({
        id,
        name,
        kind: 'Monitored Host',
        status: 'ACTIVE',
        description: `Host monitorowany przez połączenie TCP z ${address}.`,
        config: { category: 'infrastructure', address },
      });
      if (res.ok) {
        if (fromForm) {
          setNewHostName('');
          setNewHostAddress('');
        }
        setStatusMsg(`Dodano host „${name}” (${address}) do monitorowania.`);
        await loadReport();
      } else {
        setStatusMsg(res.error || 'Nie udało się zapisać hosta.');
      }
    } finally {
      setIsSavingHost(false);
    }
  };

  const handleRemoveMonitored = async (id: string, name: string) => {
    if (!window.confirm(`Usunąć „${name}” (${id}) z monitorowanych hostów?`)) return;
    const res = await deleteSystemModule(id);
    setStatusMsg(res.ok ? `Usunięto „${name}” z monitorowania.` : res.error || 'Nie udało się usunąć wpisu.');
    await loadReport();
  };

  const handleEmitReport = async () => {
    if (isEmittingReport) return;
    setIsEmittingReport(true);
    setStatusMsg(null);
    try {
      const res = await safeFetchJson<{ ok: boolean; serverRevision?: number }>('/api/py/kernel/markdown-report', {
        method: 'POST',
        timeoutMs: 15000,
        body: JSON.stringify({ directive: 'Raport infrastruktury hosta', origin: 'infrastructure-workspace' }),
      });
      await refreshDomainModules(['chat', 'modules']);
      setStatusMsg(
        res.ok && res.data?.ok
          ? `Wysłano raport na kanał Rodzina Mitek (wszyscy) · rev ${res.data.serverRevision || serverRevision}`
          : res.error || 'Nie udało się wygenerować raportu.',
      );
    } finally {
      setIsEmittingReport(false);
    }
  };

  const reachableHosts =
    (report?.ssh_hosts.hosts.filter((h) => h.probe.reachable).length ?? 0) +
    (report?.monitored.filter((m) => m.probe?.reachable).length ?? 0);
  const totalHosts = (report?.ssh_hosts.hosts.length ?? 0) + (report?.monitored.filter((m) => m.probe).length ?? 0);
  const runningUnits = report?.systemd.units.filter((u) => u.active_state === 'active').length ?? 0;
  const runningContainers = report?.docker.containers.filter((c) => c.state === 'running').length ?? 0;
  const activeTasks = report?.tasks.filter((t) => t.status === 'QUEUED' || t.status === 'RUNNING').length ?? 0;

  return (
    <div className="h-full overflow-y-auto bg-[#070B14] text-slate-100">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 py-5 space-y-5">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-emerald-500/25 pb-4">
          <div className="space-y-1">
            <p className="flex items-center gap-2 text-xs uppercase tracking-[0.22em] text-emerald-400 font-mono">
              <Server size={15} /> Infrastruktura
            </p>
            <h1 className="text-xl sm:text-2xl font-bold text-slate-50">Hosty, usługi, dyski i zadania</h1>
            <p className="text-xs sm:text-sm text-slate-400">
              Prawdziwe dane z hosta backendu <span className="text-cyan-300 font-mono">{report?.hostname || '…'}</span>
              {report ? ` · pomiar ${fmtTime(report.collected_at)} · odświeżanie co 30 s` : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void handleEmitReport()}
              disabled={isEmittingReport}
              className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/50 bg-cyan-500/15 px-3 py-2 text-xs font-semibold text-cyan-100 hover:bg-cyan-500/25 disabled:opacity-40"
            >
              <Sparkles size={14} />
              {isEmittingReport ? 'Wysyłanie raportu...' : 'Wyślij raport (czat)'}
            </button>
            <button
              type="button"
              onClick={() => onNavigateTab('svl364')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/40 bg-violet-500/15 px-3 py-2 text-xs font-medium text-violet-100 hover:bg-violet-500/25"
            >
              <Radar size={14} /> Telemetria SVL-364
            </button>
            <button
              type="button"
              onClick={() => void loadReport()}
              disabled={isLoading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 py-2 text-xs font-medium text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-40"
            >
              <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} /> Odśwież
            </button>
          </div>
        </header>

        {statusMsg && (
          <div className="rounded-lg border border-emerald-500/40 bg-emerald-950/30 px-3.5 py-2 text-xs font-mono text-emerald-200">
            {statusMsg}
          </div>
        )}
        {reportError && (
          <p role="status" className="text-sm text-amber-300">
            {reportError}
          </p>
        )}

        {/* Podsumowanie */}
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3" aria-label="Podsumowanie infrastruktury">
          {[
            { label: 'Hosty osiągalne', value: report ? `${reachableHosts} / ${totalHosts}` : '…', icon: Network },
            {
              label: 'Usługi systemd aktywne',
              value: report ? (report.systemd.available ? `${runningUnits} / ${report.systemd.units.length}` : 'n/d') : '…',
              icon: Server,
            },
            {
              label: 'Kontenery uruchomione',
              value: report ? (report.docker.available ? `${runningContainers} / ${report.docker.containers.length}` : 'n/d') : '…',
              icon: Boxes,
            },
            { label: 'Zadania w toku', value: report ? String(activeTasks) : '…', icon: ListChecks },
          ].map(({ label, value, icon: Icon }) => (
            <div key={label} className="rounded-xl border border-slate-800 bg-[#0B1220] p-3.5">
              <p className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-slate-400">
                <Icon size={14} /> {label}
              </p>
              <p className="mt-1 text-xl font-bold font-mono text-slate-100 tabular-nums">{value}</p>
            </div>
          ))}
        </section>

        {/* Hosty */}
        <section className="rounded-xl border border-cyan-500/30 bg-[#0B1220] p-4 space-y-3" aria-label="Hosty">
          <h2 className="flex items-center gap-2 font-bold text-cyan-300 text-sm sm:text-base">
            <Network size={17} /> Hosty (pomiar połączenia TCP)
          </h2>

          <div className="space-y-2">
            <p className="text-[11px] font-mono text-slate-400">
              Z pliku {report?.ssh_hosts.source || '~/.ssh/config'} użytkownika backendu:
            </p>
            {report && report.ssh_hosts.hosts.length === 0 ? (
              <Unavailable reason={report.ssh_hosts.reason} />
            ) : (
              <div className="grid gap-2 md:grid-cols-2">
                {report?.ssh_hosts.hosts.map((h) => (
                  <div key={h.alias} className="rounded-lg border border-slate-800 bg-[#070C16] px-3 py-2 text-xs font-mono">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-100">{h.alias}</span>
                      <ProbeBadge probe={h.probe} />
                    </div>
                    <p className="text-slate-400">
                      {h.user ? `${h.user}@` : ''}
                      {h.hostname}:{h.port}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-2 pt-1">
            <p className="text-[11px] font-mono text-slate-400">
              Wykryte automatycznie (bez skanowania sieci — {report?.discovered.sources.neighbors || 'tablica sąsiadów'}, known_hosts,
              /etc/hosts; pamiętane {report?.discovered.retention_hours ?? 24} h):
            </p>
            {report && report.discovered.hosts.length === 0 && (
              <Unavailable reason="Jądro nie zna jeszcze żadnych sąsiadów w sieci, a known_hosts i /etc/hosts nie zawierają innych hostów." />
            )}
            <div className="grid gap-2 md:grid-cols-2">
              {report?.discovered.hosts.map((h) => (
                <div
                  key={h.key}
                  className={`rounded-lg border px-3 py-2 text-xs font-mono space-y-0.5 ${
                    h.seen_now ? 'border-slate-800 bg-[#070C16]' : 'border-slate-800/60 bg-[#070C16]/60 opacity-70'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-slate-100 truncate">{h.names[0] || h.addresses[0]}</span>
                    {h.tracked ? (
                      <span className="text-[11px] text-emerald-300 shrink-0">śledzony</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handleMonitorDiscovered(h)}
                        disabled={isSavingHost}
                        className="shrink-0 rounded border border-emerald-500/40 bg-emerald-950/40 px-2 py-0.5 text-[11px] text-emerald-200 hover:bg-emerald-900/50 disabled:opacity-40"
                      >
                        Monitoruj
                      </button>
                    )}
                  </div>
                  <p className="text-slate-400 break-all">
                    {[...h.addresses, ...h.names.slice(1)].join(' · ')}
                    {h.mac ? ` · MAC ${h.mac}` : ''}
                    {h.interface ? ` · ${h.interface}` : ''}
                  </p>
                  <p className="text-slate-500">
                    Źródło: {h.sources.map((src) => SOURCE_LABEL[src] || src).join(', ')}
                    {h.neighbor_state ? ` · stan: ${h.neighbor_state}` : ''}
                  </p>
                  {h.probe && (
                    <p>
                      SSH :{h.ssh_port} <ProbeBadge probe={h.probe} />
                    </p>
                  )}
                  <p className="text-slate-500">
                    {h.seen_now ? 'widoczny teraz' : `ostatnio widziany ${fmtTime(h.last_seen)}`} · pierwszy raz {fmtTime(h.first_seen)}
                  </p>
                </div>
              ))}
            </div>
            {report && report.discovered.hashed_known_hosts > 0 && (
              <p className="text-[11px] text-slate-500">
                Pominięto {report.discovered.hashed_known_hosts} zahaszowanych wpisów known_hosts (HashKnownHosts) — ich nazw nie da się odczytać.
              </p>
            )}
          </div>

          <div className="space-y-2 pt-1">
            <p className="text-[11px] font-mono text-slate-400">Hosty dodane do monitorowania:</p>
            {report && report.monitored.length === 0 && (
              <Unavailable reason="Brak — dodaj host formularzem poniżej." />
            )}
            <div className="grid gap-2 md:grid-cols-2">
              {report?.monitored.map((m) => (
                <div key={m.id} className="rounded-lg border border-slate-800 bg-[#070C16] px-3 py-2 text-xs font-mono space-y-0.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-slate-100 truncate">{m.name}</span>
                    <button
                      type="button"
                      onClick={() => void handleRemoveMonitored(m.id, m.name)}
                      className="text-slate-500 hover:text-rose-300"
                      aria-label={`Usuń ${m.name}`}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                  <p className="text-slate-400">{m.address || m.id}</p>
                  <ProbeBadge probe={m.probe} note={m.note} />
                </div>
              ))}
            </div>
            <form onSubmit={handleAddHost} className="flex flex-wrap gap-2 pt-1">
              <input
                value={newHostName}
                onChange={(e) => setNewHostName(e.target.value)}
                placeholder="Nazwa (np. NAS)"
                aria-label="Nazwa hosta"
                className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-[#070C16] px-3 py-1.5 text-xs"
              />
              <input
                value={newHostAddress}
                onChange={(e) => setNewHostAddress(e.target.value)}
                placeholder="adres:port (np. 192.168.1.10:22)"
                aria-label="Adres hosta"
                className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-[#070C16] px-3 py-1.5 text-xs font-mono"
              />
              <button
                type="submit"
                disabled={isSavingHost || !newHostName.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/50 bg-emerald-600/20 px-3 py-1.5 text-xs font-semibold text-emerald-100 hover:bg-emerald-500/30 disabled:opacity-40"
              >
                <Plus size={14} /> {isSavingHost ? 'Zapisywanie...' : 'Dodaj host'}
              </button>
            </form>
          </div>
        </section>

        {/* Usługi i kontenery */}
        <section className="grid gap-3 lg:grid-cols-2" aria-label="Usługi i kontenery">
          <div className="rounded-xl border border-emerald-500/30 bg-[#0B1220] p-4 space-y-2">
            <h2 className="flex items-center gap-2 font-bold text-emerald-300 text-sm">
              <Server size={16} /> Usługi systemd
            </h2>
            {report && (!report.systemd.available || report.systemd.units.length === 0) ? (
              <Unavailable reason={report.systemd.reason} />
            ) : (
              report?.systemd.units.map((u) => (
                <div key={u.unit} className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-[#070C16] px-3 py-2 text-xs font-mono">
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-100">{u.unit}.service</p>
                    <p className="text-slate-400 truncate">
                      {u.main_pid ? `PID ${u.main_pid} · ` : ''}od {u.active_since || '—'}
                    </p>
                  </div>
                  <span className={u.active_state === 'active' ? 'text-emerald-300' : 'text-rose-300'}>
                    {u.error || `${u.active_state} (${u.sub_state})`}
                  </span>
                </div>
              ))
            )}
          </div>

          <div className="rounded-xl border border-violet-500/30 bg-[#0B1220] p-4 space-y-2">
            <h2 className="flex items-center gap-2 font-bold text-violet-300 text-sm">
              <Boxes size={16} /> Kontenery Docker
            </h2>
            {report && (!report.docker.available || report.docker.containers.length === 0) ? (
              <Unavailable reason={report.docker.available ? 'Brak kontenerów.' : report.docker.reason} />
            ) : (
              report?.docker.containers.map((c) => (
                <div key={c.name} className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-[#070C16] px-3 py-2 text-xs font-mono">
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-100 truncate">{c.name}</p>
                    <p className="text-slate-400 truncate">{c.image}</p>
                  </div>
                  <span className={c.state === 'running' ? 'text-emerald-300' : 'text-amber-300'}>{c.status}</span>
                </div>
              ))
            )}
          </div>
        </section>

        {/* Porty i dyski */}
        <section className="grid gap-3 lg:grid-cols-2" aria-label="Porty i dyski">
          <div className="rounded-xl border border-slate-800 bg-[#0B1220] p-4 space-y-2">
            <h2 className="flex items-center gap-2 font-semibold text-slate-100 text-sm">
              <Network size={16} className="text-cyan-400" /> Porty nasłuchujące (/proc/net/tcp)
            </h2>
            {report && report.listening_ports.length === 0 ? (
              <Unavailable reason="Brak portów TCP w stanie LISTEN." />
            ) : (
              <table className="w-full text-left text-xs font-mono">
                <thead className="text-slate-500">
                  <tr>
                    <th className="font-normal">Port</th>
                    <th className="font-normal">Adres</th>
                    <th className="font-normal" title="Nazwa wynika z numeru portu, nie z identyfikacji procesu">Typowa usługa dla portu</th>
                  </tr>
                </thead>
                <tbody>
                  {report?.listening_ports.map((p) => (
                    <tr key={`${p.address}:${p.port}`} className="text-slate-200">
                      <td className="text-cyan-300 tabular-nums">{p.port}</td>
                      <td>{p.address}</td>
                      <td className="text-slate-400">{p.service || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="rounded-xl border border-slate-800 bg-[#0B1220] p-4 space-y-2">
            <h2 className="flex items-center gap-2 font-semibold text-slate-100 text-sm">
              <HardDrive size={16} className="text-emerald-400" /> Dyski (/proc/mounts)
            </h2>
            {report?.mounts.map((m) => (
              <div key={m.device} className="rounded-lg border border-slate-800 bg-[#070C16] px-3 py-2 text-xs font-mono space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-100 font-semibold">{m.mountpoint}</span>
                  <span className="text-slate-400">
                    {m.device} · {m.fstype}
                  </span>
                </div>
                {m.error ? (
                  <p className="text-amber-300">{m.error}</p>
                ) : (
                  <>
                    <div className="w-full h-1.5 rounded-full bg-slate-900 overflow-hidden">
                      <div
                        className={`h-full ${(m.percent ?? 0) > 90 ? 'bg-rose-400' : 'bg-emerald-400'}`}
                        style={{ width: `${Math.min(100, m.percent ?? 0)}%` }}
                      />
                    </div>
                    <p className="text-slate-400">
                      zajęte {m.percent}% · wolne {m.free_gb} GB z {m.total_gb} GB
                    </p>
                  </>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* Zadania agentów */}
        <section className="rounded-xl border border-violet-500/30 bg-[#0B1220] p-4 space-y-3" aria-label="Zadania agentów">
          <h2 className="flex items-center gap-2 font-bold text-violet-300 text-sm sm:text-base">
            <Clock size={17} /> Zadania agentów (SQLite agent_tasks)
          </h2>
          {report && report.tasks.length === 0 ? (
            <Unavailable reason="Brak zadań. Zlecisz je w czacie: „Zleć zadanie: tytuł | opis”." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead className="text-slate-500">
                  <tr>
                    <th className="font-normal">Zadanie</th>
                    <th className="font-normal">Agent</th>
                    <th className="font-normal">Status</th>
                    <th className="font-normal">Utworzone</th>
                    <th className="font-normal">Czas</th>
                  </tr>
                </thead>
                <tbody>
                  {report?.tasks.map((t) => (
                    <tr key={t.id} className="text-slate-200 align-top">
                      <td className="pr-2">
                        {t.title}
                        {t.error && <span className="block text-rose-300">{t.error}</span>}
                      </td>
                      <td className="pr-2">{t.target_agent}</td>
                      <td
                        className={`pr-2 ${
                          t.status === 'COMPLETED' ? 'text-emerald-300' : t.status === 'FAILED' ? 'text-rose-300' : 'text-amber-300'
                        }`}
                      >
                        {t.status}
                      </td>
                      <td className="pr-2 text-slate-400">{fmtTime(t.created_at)}</td>
                      <td className="text-slate-400">{durationBetween(t.started_at || t.created_at, t.completed_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Moduły SQLite */}
        <section className="rounded-xl border border-slate-800 bg-[#0B1220] p-4 space-y-3" aria-label="Moduły systemowe w SQLite">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 font-semibold text-slate-100 text-sm sm:text-base">
              <Radar size={17} className="text-emerald-400" /> Moduły systemowe w SQLite ({otherModules.length})
            </h2>
            <span className="text-xs font-mono text-slate-400">Źródło: tabela system_modules · rev {serverRevision}</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {otherModules.map((mod) => {
              const entries = mod.config ? Object.entries(mod.config) : [];
              return (
                <article key={mod.id} className="rounded-xl border border-slate-800 bg-[#070C16] p-3.5 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-slate-100">{mod.name}</h3>
                    <span className="text-[11px] font-mono text-emerald-300 tabular-nums shrink-0">
                      {mod.status} · rev {mod.revision}
                    </span>
                  </div>
                  <p className="text-[11px] font-mono text-violet-300">
                    {mod.id} · {mod.kind} · źródło: {mod.source}
                  </p>
                  {mod.description && <p className="text-xs text-slate-300 leading-relaxed">{mod.description}</p>}
                  {entries.length > 0 && (
                    <div className="rounded-lg border border-slate-800/80 bg-[#0B101D] p-2 text-[11px] font-mono text-slate-400 grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1">
                      {entries.slice(0, 6).map(([k, v]) => (
                        <div key={k} className="truncate" title={`${k}: ${JSON.stringify(v)}`}>
                          <span className="text-slate-500">{k}:</span>{' '}
                          <span className="text-slate-200">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>

        {/* Workery agentów */}
        <section className="rounded-xl border border-slate-800 bg-[#0B1220] p-4 space-y-3" aria-label="Workery agentów">
          <h2 className="flex items-center gap-2 font-semibold text-slate-100 text-sm sm:text-base">
            <HardDrive size={17} className="text-violet-400" /> Workery agentów
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {agentsList.map((ag) => (
              <div key={ag.id || ag.canonical_name} className="rounded-lg border border-slate-800 bg-[#070C16] p-3 space-y-1.5 text-xs">
                <div className="flex items-center gap-2.5 min-w-0">
                  <SvlAvatar sender={ag.display_name || ag.canonical_name} agentId={ag.id} size={32} />
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-100 truncate">{ag.display_name || ag.canonical_name}</p>
                    <p className="font-mono text-emerald-300 text-[11px] tabular-nums truncate">
                      PID {ag.pid ?? 'brak'} · {ag.status} · pamięć: {ag.memory_entries_count ?? 0} wpisów
                    </p>
                  </div>
                </div>
                {ag.preserved_role && <p className="text-[11px] text-slate-400">{ag.preserved_role}</p>}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};
