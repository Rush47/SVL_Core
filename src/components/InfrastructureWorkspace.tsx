import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Building2,
  CheckCircle2,
  Compass,
  Cpu,
  Droplets,
  FlaskConical,
  HardDrive,
  Leaf,
  MapPin,
  Network,
  Plus,
  Radar,
  RefreshCw,
  Rocket,
  Search,
  Server,
  Sparkles,
  Target,
  Terminal,
  Thermometer,
  Trash2,
  Wind,
} from 'lucide-react';
import { useSvlSync } from '../utils/svlSyncStore';
import { hasSvlOperatorAccessToken, safeFetchJson } from '../utils/svlLogic';

type WorkspaceTab = 'chat' | 'svl364' | 'infrastructure' | 'agents' | 'terminals' | 'kernel' | 'linux';
type SubView = 'assets' | 'missions' | 'botany' | 'upgrades' | 'network';
type AssetFilter = 'all' | 'outpost' | 'ship' | 'infrastructure';

interface InfrastructureWorkspaceProps {
  onNavigateTab: (tab: WorkspaceTab) => void;
}

interface TcpProbe {
  reachable: boolean;
  rtt_ms: number | null;
  error: string | null;
}

interface HostInfrastructureReport {
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

interface InfrastructureAsset {
  id: string;
  type: 'outpost' | 'ship' | 'infrastructure';
  name: string;
  role: string;
  location: string;
  sector: string;
  au: number;
  unitCount: number;
  crew: number;
  crewBreakdown?: string;
  status: string;
  hasBotany: boolean;
  mcpNode: string;
  updatedAt: string;
}

interface InfrastructureMission {
  id: string;
  title: string;
  locationId: string;
  locationName: string;
  assignedUnit: string;
  commander: string;
  status: string;
  progressPct: number;
  objective: string;
  updatedAt: string;
}

interface InfrastructureResearch {
  id: string;
  title: string;
  domain: string;
  locationId: string;
  locationName: string;
  leadTeam: string;
  researchersCount: number;
  progressPct: number;
  status: string;
  latestFinding: string;
  updatedAt: string;
}

interface BotanyEvent {
  timestamp: string;
  level: string;
  text: string;
}

interface InfrastructureBotany {
  id: string;
  facilityId: string;
  facilityName: string;
  location: string;
  biomeType: string;
  status: string;
  o2OutputPct: number;
  co2ScrubPct: number;
  humidityPct: number;
  tempC: number;
  waterRecycledPct: number;
  biomassKg: number;
  lightCycle: string;
  activeCultures: string[];
  currentActivity: string;
  recentEvents: BotanyEvent[];
  updatedAt: string;
}

interface SectorSummary {
  sector: string;
  au: number;
  outposts: number;
  ships: number;
  infrastructure: number;
  crew: number;
  items: string[];
}

interface ProcurementVendor {
  id: string;
  name: string;
  location: string;
  rating: string;
  specialization: string;
}

interface ProcurementCatalogItem {
  sku: string;
  title: string;
  vendorId: string;
  vendorName: string;
  targetHost: string;
  category: string;
  tier: string;
  status: string;
  integratedWith: string[];
  specs: string;
}

interface ProcurementOrder {
  orderId: string;
  title: string;
  vendorName: string;
  orderedBy: string;
  targetSystems: string[];
  items: string[];
  status: string;
  deliveryLocation: string;
  notes: string;
  orderedAt: string;
  integratedAt: string;
}

interface InfrastructureOverviewPayload {
  ok: boolean;
  collectedAt: string;
  lastMcpSyncAt: string;
  mcpSync: {
    connected: boolean;
    transport: string;
    syncedAt: string;
    remoteMcpUrl: string;
    sshUri: string;
    shipLocation: string;
    probeOk?: boolean;
    probeDurationMs?: number;
    probeError?: string;
  };
  totals: {
    outpostsCount: number;
    outpostEntries: number;
    shipsCount: number;
    shipEntries: number;
    infrastructureObjectsCount: number;
    infrastructureGroups: number;
    allianceStationsTotal: number;
    allianceStationsBaseline: number;
    allianceStationsExpansion: number;
    totalCrew: number;
    activeMissions: number;
    totalMissions: number;
    activeResearch: number;
    totalResearch: number;
    totalResearchers: number;
    botanyModulesCount: number;
    botanyOptimalCount: number;
    botanyAvgO2Pct: number;
    botanyAvgWaterRecycledPct: number;
    botanyTotalBiomassKg: number;
    installedUpgradesCount?: number;
    completedOrdersCount?: number;
    liveMonitoredHosts: number;
    liveSshHosts: number;
    liveDiscoveredHosts: number;
  };
  sectors: SectorSummary[];
  assets: InfrastructureAsset[];
  missions: InfrastructureMission[];
  research: InfrastructureResearch[];
  botany: InfrastructureBotany[];
  procurementVendors?: ProcurementVendor[];
  procurementCatalog?: ProcurementCatalogItem[];
  procurementOrders?: ProcurementOrder[];
  liveAgentTasks: HostInfrastructureReport['tasks'];
  hostInfrastructure: HostInfrastructureReport;
  serverRevision: number;
}

const REFRESH_INTERVAL_MS = 20_000;
const ADDRESS_RE = /^(?:\[[0-9A-Fa-f:]+\]|[A-Za-z0-9._-]{1,253}):\d{1,5}$/;

const fmtNum = (n: number | null | undefined) =>
  typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('pl-PL') : '0';

const fmtTime = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'medium' });
};

const ASSET_TYPE_META: Record<InfrastructureAsset['type'], { label: string; badge: string }> = {
  outpost: { label: 'Placówka', badge: 'bg-sky-500/10 text-sky-300 border-sky-500/25' },
  ship: { label: 'Statek / Flota', badge: 'bg-cyan-500/10 text-cyan-300 border-cyan-500/25' },
  infrastructure: { label: 'Infrastruktura', badge: 'bg-amber-500/10 text-amber-300 border-amber-500/25' },
};

const BOTANY_STATUS_META: Record<string, { label: string; cls: string }> = {
  OPTIMAL: { label: 'OPTYMALNY', cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' },
  HARVEST_READY: { label: 'GOTOWY ZBIÓR', cls: 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30' },
  GROWING: { label: 'WZROST', cls: 'bg-sky-500/10 text-sky-300 border-sky-500/30' },
  ATTENTION: { label: 'WYMAGA UWAGI', cls: 'bg-amber-500/10 text-amber-300 border-amber-500/30' },
  ALERT: { label: 'ALARM', cls: 'bg-rose-500/10 text-rose-300 border-rose-500/30' },
};

const ProbeBadge: React.FC<{ probe: TcpProbe | null; note?: string | null }> = ({ probe, note }) => {
  if (!probe) return <span className="text-[11px] font-mono text-slate-500">{note || 'brak pomiaru'}</span>;
  return probe.reachable ? (
    <span className="text-[11px] font-mono text-emerald-300">ONLINE · {probe.rtt_ms} ms</span>
  ) : (
    <span className="text-[11px] font-mono text-rose-300 break-all" title={probe.error || undefined}>
      OFFLINE · {probe.error}
    </span>
  );
};

export const InfrastructureWorkspace: React.FC<InfrastructureWorkspaceProps> = ({ onNavigateTab }) => {
  const { openSvl364RootChannel, upsertSystemModule, deleteSystemModule, refreshDomainModules, serverRevision } =
    useSvlSync();

  const [overview, setOverview] = useState<InfrastructureOverviewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncingMcp, setIsSyncingMcp] = useState(false);
  const [isEmittingReport, setIsEmittingReport] = useState(false);

  const [subView, setSubView] = useState<SubView>('assets');
  const [assetFilter, setAssetFilter] = useState<AssetFilter>('all');
  const [sectorFilter, setSectorFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [focusedBotanyFacilityId, setFocusedBotanyFacilityId] = useState<string | null>(null);

  // Formularz dodawania placówki / statku / infrastruktury
  const [showAddAsset, setShowAddAsset] = useState(false);
  const [assetForm, setAssetForm] = useState({
    type: 'outpost' as InfrastructureAsset['type'],
    name: '',
    role: '',
    location: '',
    sector: 'Sektor Ziemski',
    au: '1.000',
    unitCount: '1',
    crew: '20',
    mcpNode: 'svl364-mcp',
    hasBotany: false,
  });

  // Formularz dodawania misji
  const [showAddMission, setShowAddMission] = useState(false);
  const [missionForm, setMissionForm] = useState({
    title: '',
    locationName: 'Sektor Ziemski · L2',
    assignedUnit: 'SVL-364 Ebon Apex',
    commander: 'Jyn',
    objective: '',
    progressPct: '15',
  });

  // Formularz dodawania badania
  const [showAddResearch, setShowAddResearch] = useState(false);
  const [researchForm, setResearchForm] = useState({
    title: '',
    domain: 'Botanika & Ekosystemy',
    locationName: 'APEX-CITADEL · APEX-TECH-LAB',
    leadTeam: 'APEX-TECH-LAB',
    researchersCount: '30',
    latestFinding: '',
  });

  // Formularz aktualizacji / dodawania botaniki
  const [editingBotanyId, setEditingBotanyId] = useState<string | null>(null);
  const [botanyUpdate, setBotanyUpdate] = useState({
    status: 'OPTIMAL',
    currentActivity: '',
    o2OutputPct: '',
    biomassKg: '',
    eventText: '',
    eventLevel: 'INFO',
  });
  const [showAddBotany, setShowAddBotany] = useState(false);
  const [newBotanyForm, setNewBotanyForm] = useState({
    facilityName: '',
    location: 'Orbita Ziemi',
    biomeType: 'Hydroponika Zamknięta',
    currentActivity: '',
  });

  // Formularz zamówienia ulepszenia pozaziemskiego (APEX-CITADEL / Ceres / L4)
  const [showAddOrder, setShowAddOrder] = useState(false);
  const [orderForm, setOrderForm] = useState({
    title: '',
    vendorName: 'APEX-CITADEL Orbital Foundry & Quantum Shipyard (L2 · Poza Ziemią)',
    targetHost: 'SVL-365 Sentinel Aegis + SVL-364 Ebon Apex + Jądro SVL',
    category: 'Host & System Integration',
    tier: 'OMEGA-MK6',
    specs: '',
  });

  // Formularz monitorowanego hosta TCP (zakładka Hosty & Sieć)
  const [newHostName, setNewHostName] = useState('');
  const [newHostAddress, setNewHostAddress] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const loadOverview = useCallback(async (syncMcp = false) => {
    if (!hasSvlOperatorAccessToken()) {
      setError('Wymagana autoryzacja SVL_OPERATOR_TOKEN (ikona kłódki SVL w pasku górnym).');
      return;
    }
    if (syncMcp) setIsSyncingMcp(true);
    else setIsLoading(true);
    try {
      const url = syncMcp ? '/api/infrastructure/overview?sync=1' : '/api/infrastructure/overview';
      const res = await safeFetchJson<InfrastructureOverviewPayload>(url, { timeoutMs: 25_000 });
      if (res.ok && res.data?.ok) {
        setOverview(res.data);
        setError(null);
        if (syncMcp) {
          const probe = res.data.mcpSync;
          setStatusMsg(
            probe.probeOk
              ? `Zsynchronizowano przez MCP (${probe.transport}${probe.probeDurationMs ? ` · ${probe.probeDurationMs} ms` : ''}).`
              : `Odświeżono rejestr infrastruktury z lokalnego MCP + SQLite${probe.probeError ? ` (mostek zdalny: ${probe.probeError})` : ''}.`,
          );
        }
      } else {
        setError(res.error || `Nie udało się pobrać przeglądu infrastruktury (HTTP ${res.status}).`);
      }
    } finally {
      setIsLoading(false);
      setIsSyncingMcp(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview(false);
    const timer = setInterval(() => void loadOverview(false), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [loadOverview]);

  const filteredAssets = useMemo(() => {
    const assets = overview?.assets || [];
    const q = searchQuery.trim().toLowerCase();
    return assets.filter((a) => {
      if (assetFilter !== 'all' && a.type !== assetFilter) return false;
      if (sectorFilter !== 'ALL' && a.sector !== sectorFilter) return false;
      if (!q) return true;
      return (
        a.name.toLowerCase().includes(q) ||
        a.location.toLowerCase().includes(q) ||
        a.sector.toLowerCase().includes(q) ||
        a.role.toLowerCase().includes(q) ||
        a.mcpNode.toLowerCase().includes(q)
      );
    });
  }, [overview?.assets, assetFilter, sectorFilter, searchQuery]);

  const handleOpenRootChannel = async () => {
    await openSvl364RootChannel();
    onNavigateTab('chat');
  };

  const handleEmitReport = async () => {
    if (isEmittingReport) return;
    setIsEmittingReport(true);
    setStatusMsg(null);
    try {
      const res = await safeFetchJson<{ ok?: boolean; error?: string }>('/api/py/kernel/markdown-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          directive: 'Raport infrastruktury, placówek, floty, misji, badań i botaniki SVL (MCP)',
          emitToChat: true,
          origin: 'infrastructure-workspace',
        }),
      });
      setStatusMsg(res.ok ? 'Raport SVL_System opublikowany na kanale głównym.' : res.error || 'Błąd generowania raportu.');
    } finally {
      setIsEmittingReport(false);
    }
  };

  const handleCreateAsset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!assetForm.name.trim() || isSaving) return;
    setIsSaving(true);
    setStatusMsg(null);
    try {
      const res = await safeFetchJson<{ ok?: boolean; error?: string }>('/api/infrastructure/assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: assetForm.type,
          name: assetForm.name.trim(),
          role: assetForm.role.trim() || 'Jednostka operacyjna SVL',
          location: assetForm.location.trim() || 'Orbita Ziemi (1.000 AU)',
          sector: assetForm.sector.trim() || 'Sektor Ziemski',
          au: Number(assetForm.au) || 1.0,
          unitCount: Math.max(1, Number(assetForm.unitCount) || 1),
          crew: Math.max(0, Number(assetForm.crew) || 0),
          mcpNode: assetForm.mcpNode.trim() || 'svl364-mcp',
          hasBotany: assetForm.hasBotany,
        }),
      });
      if (res.ok && res.data?.ok) {
        setShowAddAsset(false);
        setAssetForm({
          type: 'outpost',
          name: '',
          role: '',
          location: '',
          sector: 'Sektor Ziemski',
          au: '1.000',
          unitCount: '1',
          crew: '20',
          mcpNode: 'svl364-mcp',
          hasBotany: false,
        });
        setStatusMsg('Zapisano nowy obiekt w rejestrze infrastruktury MCP.');
        await loadOverview(false);
      } else {
        setStatusMsg(res.data?.error || res.error || 'Nie udało się zapisać obiektu.');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleMissionAction = async (payload: Record<string, unknown>, message: string) => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      const res = await safeFetchJson<{ ok?: boolean; error?: string }>('/api/infrastructure/missions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok && res.data?.ok) {
        setStatusMsg(message);
        await loadOverview(false);
      } else {
        setStatusMsg(res.data?.error || res.error || 'Nie udało się zaktualizować misji.');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleCreateMission = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!missionForm.title.trim()) return;
    await handleMissionAction(
      {
        title: missionForm.title.trim(),
        locationName: missionForm.locationName.trim(),
        assignedUnit: missionForm.assignedUnit.trim(),
        commander: missionForm.commander.trim(),
        objective: missionForm.objective.trim() || missionForm.title.trim(),
        progressPct: Number(missionForm.progressPct) || 10,
      },
      'Dodano nową misję operacyjną.',
    );
    setShowAddMission(false);
    setMissionForm({
      title: '',
      locationName: 'Sektor Ziemski · L2',
      assignedUnit: 'SVL-364 Ebon Apex',
      commander: 'Jyn',
      objective: '',
      progressPct: '15',
    });
  };

  const handleResearchAction = async (payload: Record<string, unknown>, message: string) => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      const res = await safeFetchJson<{ ok?: boolean; error?: string }>('/api/infrastructure/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok && res.data?.ok) {
        setStatusMsg(message);
        await loadOverview(false);
      } else {
        setStatusMsg(res.data?.error || res.error || 'Nie udało się zaktualizować badania.');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleCreateResearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!researchForm.title.trim()) return;
    await handleResearchAction(
      {
        title: researchForm.title.trim(),
        domain: researchForm.domain.trim(),
        locationName: researchForm.locationName.trim(),
        leadTeam: researchForm.leadTeam.trim(),
        researchersCount: Number(researchForm.researchersCount) || 25,
        latestFinding: researchForm.latestFinding.trim() || 'Inicjalizacja programu badawczego.',
        progressPct: 15,
      },
      'Uruchomiono nowy program badawczy.',
    );
    setShowAddResearch(false);
    setResearchForm({
      title: '',
      domain: 'Botanika & Ekosystemy',
      locationName: 'APEX-CITADEL · APEX-TECH-LAB',
      leadTeam: 'APEX-TECH-LAB',
      researchersCount: '30',
      latestFinding: '',
    });
  };

  const openBotanyEditor = (item: InfrastructureBotany) => {
    setEditingBotanyId(item.id);
    setBotanyUpdate({
      status: item.status,
      currentActivity: item.currentActivity,
      o2OutputPct: String(item.o2OutputPct),
      biomassKg: String(item.biomassKg),
      eventText: '',
      eventLevel: 'INFO',
    });
  };

  const handleSaveBotanyUpdate = async (e: React.FormEvent, botanyId: string) => {
    e.preventDefault();
    if (isSaving) return;
    setIsSaving(true);
    try {
      const res = await safeFetchJson<{ ok?: boolean; error?: string }>('/api/infrastructure/botany', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: botanyId,
          status: botanyUpdate.status,
          currentActivity: botanyUpdate.currentActivity.trim(),
          o2OutputPct: botanyUpdate.o2OutputPct ? Number(botanyUpdate.o2OutputPct) : undefined,
          biomassKg: botanyUpdate.biomassKg ? Number(botanyUpdate.biomassKg) : undefined,
          eventText: botanyUpdate.eventText.trim() || undefined,
          eventLevel: botanyUpdate.eventLevel,
        }),
      });
      if (res.ok && res.data?.ok) {
        setEditingBotanyId(null);
        setStatusMsg('Zaktualizowano telemetrię modułu botanicznego.');
        await loadOverview(false);
      } else {
        setStatusMsg(res.data?.error || res.error || 'Błąd zapisu botaniki.');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleCreateBotany = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBotanyForm.facilityName.trim() || isSaving) return;
    setIsSaving(true);
    try {
      const res = await safeFetchJson<{ ok?: boolean; error?: string }>('/api/infrastructure/botany', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facilityName: newBotanyForm.facilityName.trim(),
          location: newBotanyForm.location.trim(),
          biomeType: newBotanyForm.biomeType.trim(),
          currentActivity: newBotanyForm.currentActivity.trim() || 'Inicjalizacja upraw i kalibracja czujników O₂/H₂O.',
        }),
      });
      if (res.ok && res.data?.ok) {
        setShowAddBotany(false);
        setNewBotanyForm({ facilityName: '', location: 'Orbita Ziemi', biomeType: 'Hydroponika Zamknięta', currentActivity: '' });
        setStatusMsg('Dodano nowy moduł botaniczny.');
        await loadOverview(false);
      } else {
        setStatusMsg(res.data?.error || res.error || 'Nie udało się dodać modułu botanicznego.');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleCreateOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!orderForm.title.trim() || isSaving) return;
    setIsSaving(true);
    try {
      const res = await safeFetchJson<{ ok?: boolean; error?: string }>('/api/infrastructure/procurement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: orderForm.title.trim(),
          vendorName: orderForm.vendorName.trim(),
          targetHost: orderForm.targetHost.trim(),
          category: orderForm.category.trim(),
          tier: orderForm.tier.trim(),
          specs: orderForm.specs.trim(),
        }),
      });
      if (res.ok && res.data?.ok) {
        setShowAddOrder(false);
        setOrderForm({
          title: '',
          vendorName: 'APEX-CITADEL Orbital Foundry & Quantum Shipyard (L2 · Poza Ziemią)',
          targetHost: 'SVL-365 Sentinel Aegis + SVL-364 Ebon Apex + Jądro SVL',
          category: 'Host & System Integration',
          tier: 'OMEGA-MK6',
          specs: '',
        });
        setStatusMsg('Zamówiono poza Ziemią i natychmiast zintegrowano pakiet ulepszeń z hostem SVL-365 i systemem SVL.');
        await refreshDomainModules(['modules', 'kernel']);
        await loadOverview(false);
      } else {
        setStatusMsg(res.data?.error || res.error || 'Błąd składania zamówienia pozaziemskiego.');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const addMonitoredHost = async (name: string, address: string, resetForm: boolean) => {
    if (!name || isSaving) return;
    if (!ADDRESS_RE.test(address)) {
      setStatusMsg('Podaj adres host:port, np. 192.168.1.10:22 lub nas.local:445.');
      return;
    }
    setIsSaving(true);
    try {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36);
      const id = `svl-infra-${slug || Date.now()}`;
      const res = await upsertSystemModule({
        id,
        name,
        status: 'ACTIVE',
        config: { category: 'infrastructure', address, origin: 'operator' },
      });
      if (res.ok) {
        if (resetForm) {
          setNewHostName('');
          setNewHostAddress('');
        }
        setStatusMsg(`Dodano monitorowany host TCP: ${name} (${address}).`);
        await refreshDomainModules(['modules', 'kernel']);
        await loadOverview(false);
      } else {
        setStatusMsg(res.error || 'Błąd zapisu hosta.');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteMonitoredHost = async (id: string, name: string) => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      const res = await deleteSystemModule(id);
      if (res.ok) {
        setStatusMsg(`Usunięto monitorowany host: ${name}.`);
        await refreshDomainModules(['modules', 'kernel']);
        await loadOverview(false);
      } else {
        setStatusMsg(res.error || 'Nie udało się usunąć hosta.');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleMonitorDiscovered = async (host: HostInfrastructureReport['discovered']['hosts'][number]) => {
    const target = host.addresses[0] || host.names[0];
    const portText = window.prompt(
      `Port TCP do monitorowania dla ${host.names[0] || target}? (np. 22, 80, 443, 8787)`,
      String(host.ssh_port || 22),
    );
    if (!portText) return;
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setStatusMsg(`Nieprawidłowy port TCP: ${portText}`);
      return;
    }
    const addr = target.includes(':') ? `[${target}]:${port}` : `${target}:${port}`;
    await addMonitoredHost(host.names[0] || target, addr, false);
  };

  const totals = overview?.totals;
  const hostInfra = overview?.hostInfrastructure;
  const mcpBadge = overview?.mcpSync.connected
    ? { label: `MCP AKTYWNY · ${overview.mcpSync.transport.toUpperCase()}`, cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' }
    : { label: 'MCP LOKALNY + SQLITE WAL', cls: 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30' };

  return (
    <div className="flex-1 min-h-0 h-full overflow-y-auto svl-scroll-smooth bg-[#060A11] text-slate-100 px-4 py-5 md:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto space-y-5">
        {/* NAGŁÓWEK CIC */}
        <header className="rounded-xl border border-slate-800/90 bg-[#0B111B] p-4 md:p-5">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider px-2.5 py-0.5 rounded-full border border-slate-700/80 bg-slate-900/90 text-slate-300">
                  <Compass className="w-3.5 h-3.5 text-cyan-400" />
                  Moduł Infrastruktura · MCP
                </span>
                <span className={`inline-flex items-center gap-1.5 text-[11px] font-mono px-2.5 py-0.5 rounded-full border ${mcpBadge.cls}`}>
                  <span className="w-1.5 h-1.5 rounded-full bg-current" />
                  {mcpBadge.label}
                </span>
                {overview?.mcpSync.shipLocation && (
                  <span className="text-[11px] font-mono text-slate-400">
                    SVL-364: <strong className="text-slate-200">{overview.mcpSync.shipLocation}</strong>
                  </span>
                )}
              </div>
              <h1 className="text-xl md:text-2xl font-semibold tracking-tight text-white">
                Placówki, Flota, Misje, Badania &amp; Botanika SVL
              </h1>
              <p className="text-xs text-slate-400">
                Dokładny rejestr obiektów, lokalizacji w Układzie Słonecznym, aktywnych misji, programów badawczych i biosfery ·
                ostatnia synchronizacja MCP: <span className="font-mono text-slate-300">{fmtTime(overview?.lastMcpSyncAt)}</span> · rev{' '}
                <span className="font-mono text-slate-300">#{overview?.serverRevision ?? serverRevision}</span>
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void loadOverview(true)}
                disabled={isSyncingMcp || isLoading}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-200 border border-cyan-500/35 transition disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isSyncingMcp || isLoading ? 'animate-spin' : ''}`} />
                {isSyncingMcp ? 'Synchronizacja MCP…' : 'Synchronizuj przez MCP'}
              </button>
              <button
                type="button"
                onClick={() => onNavigateTab('svl364')}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-700/80 transition"
              >
                <Rocket className="w-3.5 h-3.5 text-cyan-400" />
                Mostek SVL-364
              </button>
              <button
                type="button"
                onClick={() => void handleOpenRootChannel()}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-700/80 transition"
              >
                <Terminal className="w-3.5 h-3.5 text-emerald-400" />
                Kanał ROOT
              </button>
              <button
                type="button"
                onClick={() => void handleEmitReport()}
                disabled={isEmittingReport}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-700/80 transition disabled:opacity-50"
              >
                <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                {isEmittingReport ? 'Generuję…' : 'Raport SVL'}
              </button>
            </div>
          </div>

          {error && (
            <div className="mt-3 rounded-lg border border-rose-500/35 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
              {error}
            </div>
          )}
          {statusMsg && (
            <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-100">
              <span>{statusMsg}</span>
              <button type="button" onClick={() => setStatusMsg(null)} className="text-cyan-300 hover:text-white text-[11px]">
                Ukryj
              </button>
            </div>
          )}
        </header>

        {/* 5 DOKŁADNYCH KART KPI */}
        <section className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <div className="rounded-xl border border-slate-800/90 bg-[#0B111B] p-3.5">
            <div className="flex items-center justify-between text-[11px] text-slate-400">
              <span>Placówki &amp; Stacje</span>
              <Building2 className="w-4 h-4 text-sky-400" />
            </div>
            <div className="mt-1.5 text-2xl font-semibold font-mono text-white">
              {totals ? fmtNum(totals.outpostsCount) : '—'}
            </div>
            <div className="mt-1 text-[11px] text-slate-400">
              {totals ? `${overview?.sectors.length || 0} sektorów · Załoga ${fmtNum(totals.totalCrew)}` : 'Ładowanie…'}
            </div>
          </div>

          <div className="rounded-xl border border-slate-800/90 bg-[#0B111B] p-3.5">
            <div className="flex items-center justify-between text-[11px] text-slate-400">
              <span>Statki &amp; Flota</span>
              <Rocket className="w-4 h-4 text-cyan-400" />
            </div>
            <div className="mt-1.5 text-2xl font-semibold font-mono text-white">
              {totals ? fmtNum(totals.shipsCount) : '—'}
            </div>
            <div className="mt-1 text-[11px] text-slate-400">
              {totals ? `SVL-364 · SVL-365 · SVL-465 · ${fmtNum(Math.max(0, totals.shipsCount - 3))} krążowników` : 'Ładowanie…'}
            </div>
          </div>

          <div className="rounded-xl border border-slate-800/90 bg-[#0B111B] p-3.5">
            <div className="flex items-center justify-between text-[11px] text-slate-400">
              <span>Infrastruktura</span>
              <Server className="w-4 h-4 text-amber-400" />
            </div>
            <div className="mt-1.5 text-2xl font-semibold font-mono text-white">
              {totals ? fmtNum(totals.infrastructureObjectsCount) : '—'}
            </div>
            <div className="mt-1 text-[11px] text-slate-400">
              {totals ? `${fmtNum(totals.allianceStationsTotal)} stanowisk Sojuszu` : 'Ładowanie…'}
            </div>
          </div>

          <div className="rounded-xl border border-slate-800/90 bg-[#0B111B] p-3.5">
            <div className="flex items-center justify-between text-[11px] text-slate-400">
              <span>Misje &amp; Badania</span>
              <FlaskConical className="w-4 h-4 text-sky-400" />
            </div>
            <div className="mt-1.5 text-2xl font-semibold font-mono text-white">
              {totals ? `${totals.activeMissions} / ${totals.activeResearch}` : '—'}
            </div>
            <div className="mt-1 text-[11px] text-slate-400">
              {totals ? `Aktywne misje / badania · ${fmtNum(totals.totalResearchers)} badaczy` : 'Ładowanie…'}
            </div>
          </div>

          <div className="rounded-xl border border-slate-800/90 bg-[#0B111B] p-3.5 col-span-2 lg:col-span-1">
            <div className="flex items-center justify-between text-[11px] text-slate-400">
              <span>Botanika &amp; Biosfera</span>
              <Leaf className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="mt-1.5 text-2xl font-semibold font-mono text-emerald-300">
              {totals ? `${totals.botanyModulesCount} mod.` : '—'}
            </div>
            <div className="mt-1 text-[11px] text-slate-400">
              {totals ? `Śr. O₂ ${totals.botanyAvgO2Pct}% · ${fmtNum(totals.botanyTotalBiomassKg)} kg biomasy` : 'Ładowanie…'}
            </div>
          </div>
        </section>

        {/* NAWIGACJA PODWIDOKÓW */}
        <nav className="flex flex-wrap items-center gap-1.5 rounded-xl border border-slate-800/90 bg-[#0B111B] p-1.5">
          {[
            {
              id: 'assets' as SubView,
              label: 'Placówki, Statki & Lokalizacje',
              icon: MapPin,
              count: overview ? overview.assets.length : 0,
            },
            {
              id: 'missions' as SubView,
              label: 'Misje & Badania',
              icon: Target,
              count: totals ? totals.activeMissions + totals.activeResearch : 0,
            },
            {
              id: 'botany' as SubView,
              label: 'Botanika & Biosfera',
              icon: Leaf,
              count: totals ? totals.botanyModulesCount : 0,
            },
            {
              id: 'upgrades' as SubView,
              label: 'Stocznia Pozaziemska & SVL-364/365',
              icon: Sparkles,
              count: overview?.procurementCatalog?.length || totals?.installedUpgradesCount || 5,
            },
            {
              id: 'network' as SubView,
              label: 'Hosty & Sieć (MCP / LAN)',
              icon: Network,
              count: totals ? totals.liveMonitoredHosts + totals.liveSshHosts + totals.liveDiscoveredHosts : 0,
            },
          ].map((tab) => {
            const Icon = tab.icon;
            const active = subView === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setSubView(tab.id)}
                className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-medium transition ${
                  active
                    ? 'bg-slate-800/95 text-white border border-slate-700'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/70 border border-transparent'
                }`}
              >
                <Icon className={`w-3.5 h-3.5 ${active ? 'text-cyan-400' : 'text-slate-500'}`} />
                <span>{tab.label}</span>
                <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-slate-950/90 text-slate-300 border border-slate-800">
                  {tab.count}
                </span>
              </button>
            );
          })}
        </nav>

        {/* WIDOK 1: PLACÓWKI, STATKI & LOKALIZACJE */}
        {subView === 'assets' && (
          <div className="space-y-4">
            {/* Rozkład sektorowy */}
            {overview && overview.sectors.length > 0 && (
              <div className="rounded-xl border border-slate-800/90 bg-[#0B111B] p-4">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-2">
                    <Compass className="w-3.5 h-3.5 text-cyan-400" />
                    Rozmieszczenie według sektorów Układu Słonecznego
                  </h2>
                  {sectorFilter !== 'ALL' && (
                    <button
                      type="button"
                      onClick={() => setSectorFilter('ALL')}
                      className="text-[11px] text-cyan-300 hover:text-cyan-200"
                    >
                      Pokaż wszystkie sektory
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
                  {overview.sectors.map((sec) => {
                    const selected = sectorFilter === sec.sector;
                    return (
                      <button
                        key={sec.sector}
                        type="button"
                        onClick={() => setSectorFilter(selected ? 'ALL' : sec.sector)}
                        className={`text-left rounded-lg border p-3 transition ${
                          selected
                            ? 'border-cyan-500/50 bg-cyan-500/10'
                            : 'border-slate-800 bg-[#070C14] hover:border-slate-700'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-medium text-white truncate">{sec.sector}</span>
                          <span className="text-[10px] font-mono text-slate-400 shrink-0">{sec.au} AU</span>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-mono text-slate-300">
                          {sec.outposts > 0 && <span className="text-sky-300">Placówki: {fmtNum(sec.outposts)}</span>}
                          {sec.ships > 0 && <span className="text-cyan-300">Statki: {fmtNum(sec.ships)}</span>}
                          {sec.infrastructure > 0 && (
                            <span className="text-amber-300">Obiekty: {fmtNum(sec.infrastructure)}</span>
                          )}
                        </div>
                        <div className="mt-1 text-[10px] text-slate-500">Załoga: {fmtNum(sec.crew)}</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Filtry + wyszukiwanie + dodaj */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {[
                  { id: 'all' as AssetFilter, label: 'Wszystkie' },
                  { id: 'outpost' as AssetFilter, label: 'Placówki' },
                  { id: 'ship' as AssetFilter, label: 'Statki & Flota' },
                  { id: 'infrastructure' as AssetFilter, label: 'Infrastruktura' },
                ].map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setAssetFilter(f.id)}
                    className={`px-3 py-1.5 rounded-lg text-xs border transition ${
                      assetFilter === f.id
                        ? 'bg-cyan-500/15 text-cyan-200 border-cyan-500/35'
                        : 'bg-[#0B111B] text-slate-400 border-slate-800 hover:text-slate-200'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2">
                <div className="relative flex-1 md:w-64">
                  <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Szukaj nazwy, lokalizacji, węzła MCP…"
                    className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-[#0B111B] border border-slate-800 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-cyan-500/50"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setShowAddAsset((v) => !v)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 border border-emerald-500/30 transition shrink-0"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Dodaj obiekt
                </button>
              </div>
            </div>

            {showAddAsset && (
              <form
                onSubmit={(e) => void handleCreateAsset(e)}
                className="rounded-xl border border-slate-700/90 bg-[#0B111B] p-4 grid grid-cols-1 md:grid-cols-3 gap-3"
              >
                <div className="md:col-span-3 flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-white">Nowa placówka, statek lub obiekt infrastruktury</h3>
                  <button
                    type="button"
                    onClick={() => setShowAddAsset(false)}
                    className="text-xs text-slate-400 hover:text-white"
                  >
                    Anuluj
                  </button>
                </div>
                <select
                  value={assetForm.type}
                  onChange={(e) => setAssetForm((p) => ({ ...p, type: e.target.value as InfrastructureAsset['type'] }))}
                  className="rounded-lg bg-[#060A11] border border-slate-700 px-2.5 py-2 text-xs text-slate-100"
                >
                  <option value="outpost">Placówka / Stacja</option>
                  <option value="ship">Statek / Jednostka Floty</option>
                  <option value="infrastructure">Infrastruktura krytyczna</option>
                </select>
                <input
                  required
                  value={assetForm.name}
                  onChange={(e) => setAssetForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder="Nazwa (np. Baza Księżycowa Kopernik)"
                  className="rounded-lg bg-[#060A11] border border-slate-700 px-2.5 py-2 text-xs text-slate-100"
                />
                <input
                  value={assetForm.location}
                  onChange={(e) => setAssetForm((p) => ({ ...p, location: e.target.value }))}
                  placeholder="Dokładna lokalizacja (np. Księżyc · Krater Kopernik)"
                  className="rounded-lg bg-[#060A11] border border-slate-700 px-2.5 py-2 text-xs text-slate-100"
                />
                <input
                  value={assetForm.sector}
                  onChange={(e) => setAssetForm((p) => ({ ...p, sector: e.target.value }))}
                  placeholder="Sektor (np. Sektor Ziemski)"
                  className="rounded-lg bg-[#060A11] border border-slate-700 px-2.5 py-2 text-xs text-slate-100"
                />
                <input
                  value={assetForm.role}
                  onChange={(e) => setAssetForm((p) => ({ ...p, role: e.target.value }))}
                  placeholder="Rola operacyjna"
                  className="rounded-lg bg-[#060A11] border border-slate-700 px-2.5 py-2 text-xs text-slate-100"
                />
                <div className="grid grid-cols-3 gap-2">
                  <input
                    type="number"
                    step="0.001"
                    value={assetForm.au}
                    onChange={(e) => setAssetForm((p) => ({ ...p, au: e.target.value }))}
                    placeholder="AU"
                    className="rounded-lg bg-[#060A11] border border-slate-700 px-2 py-2 text-xs text-slate-100"
                    title="Odległość od Słońca (AU)"
                  />
                  <input
                    type="number"
                    min="1"
                    value={assetForm.unitCount}
                    onChange={(e) => setAssetForm((p) => ({ ...p, unitCount: e.target.value }))}
                    placeholder="Liczba"
                    className="rounded-lg bg-[#060A11] border border-slate-700 px-2 py-2 text-xs text-slate-100"
                    title="Dokładna liczba jednostek"
                  />
                  <input
                    type="number"
                    min="0"
                    value={assetForm.crew}
                    onChange={(e) => setAssetForm((p) => ({ ...p, crew: e.target.value }))}
                    placeholder="Załoga"
                    className="rounded-lg bg-[#060A11] border border-slate-700 px-2 py-2 text-xs text-slate-100"
                    title="Liczba załogi"
                  />
                </div>
                <div className="md:col-span-3 flex flex-wrap items-center justify-between gap-3">
                  <label className="inline-flex items-center gap-2 text-xs text-slate-300">
                    <input
                      type="checkbox"
                      checked={assetForm.hasBotany}
                      onChange={(e) => setAssetForm((p) => ({ ...p, hasBotany: e.target.checked }))}
                      className="rounded border-slate-600 bg-slate-900"
                    />
                    Obiekt posiada moduł botaniczny
                  </label>
                  <button
                    type="submit"
                    disabled={isSaving}
                    className="px-4 py-2 rounded-lg text-xs font-medium bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200 border border-emerald-500/35 transition disabled:opacity-50"
                  >
                    Zapisz w rejestrze MCP
                  </button>
                </div>
              </form>
            )}

            {/* Lista obiektów */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {filteredAssets.map((asset) => {
                const meta = ASSET_TYPE_META[asset.type] || ASSET_TYPE_META.outpost;
                return (
                  <article
                    key={asset.id}
                    className="rounded-xl border border-slate-800/90 bg-[#0B111B] p-4 flex flex-col justify-between gap-3"
                  >
                    <div>
                      <div className="flex items-start justify-between gap-2">
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className={`text-[10px] font-mono px-2 py-0.5 rounded border ${meta.badge}`}>
                              {meta.label}
                            </span>
                            <span className="text-[10px] font-mono px-2 py-0.5 rounded border border-rose-500/35 bg-rose-500/10 text-rose-200">
                              {(asset as any).insignia || '🇵🇱 Polska · 🌍 Ziemia'}
                            </span>
                            <span className="text-[10px] font-mono px-2 py-0.5 rounded border border-emerald-500/25 bg-emerald-500/10 text-emerald-300">
                              {asset.status}
                            </span>
                            {asset.hasBotany && (
                              <button
                                type="button"
                                onClick={() => {
                                  setFocusedBotanyFacilityId(asset.id);
                                  setSubView('botany');
                                }}
                                className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded border border-emerald-500/30 bg-emerald-950/60 text-emerald-300 hover:bg-emerald-900/50 transition"
                              >
                                <Leaf className="w-3 h-3" />
                                Botanika
                              </button>
                            )}
                          </div>
                          <h3 className="text-sm font-semibold text-white">{asset.name}</h3>
                          <p className="text-xs text-slate-400">{asset.role}</p>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-lg font-mono font-semibold text-white">{fmtNum(asset.unitCount)}</div>
                          <div className="text-[10px] text-slate-500">jedn.</div>
                        </div>
                      </div>

                      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                        <div className="rounded-lg bg-[#070C14] border border-slate-800/80 px-2.5 py-2">
                          <div className="text-[10px] text-slate-500 uppercase tracking-wide">Lokalizacja</div>
                          <div className="text-slate-200 mt-0.5 flex items-center gap-1.5">
                            <MapPin className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                            <span>{asset.location}</span>
                          </div>
                          <div className="text-[10px] font-mono text-slate-500 mt-0.5">
                            {asset.sector} · {asset.au} AU
                          </div>
                        </div>
                        <div className="rounded-lg bg-[#070C14] border border-slate-800/80 px-2.5 py-2">
                          <div className="text-[10px] text-slate-500 uppercase tracking-wide">Załoga &amp; Węzeł MCP</div>
                          <div className="text-slate-200 mt-0.5 font-mono">Załoga: {fmtNum(asset.crew)}</div>
                          <div className="text-[10px] font-mono text-cyan-300/90 mt-0.5 truncate" title={asset.mcpNode}>
                            MCP: {asset.mcpNode}
                          </div>
                        </div>
                      </div>
                    </div>

                    {asset.crewBreakdown && (
                      <div className="text-[11px] text-slate-400 border-t border-slate-800/80 pt-2">
                        {asset.crewBreakdown}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </div>
        )}

        {/* WIDOK 2: MISJE & BADANIA */}
        {subView === 'missions' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* LEWA KOLUMNA: MISJE */}
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                  <Target className="w-4 h-4 text-cyan-400" />
                  Odświeżane Misje Operacyjne ({overview?.missions.length || 0})
                </h2>
                <button
                  type="button"
                  onClick={() => setShowAddMission((v) => !v)}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-200 border border-cyan-500/30"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Nowa misja
                </button>
              </div>

              {showAddMission && (
                <form
                  onSubmit={(e) => void handleCreateMission(e)}
                  className="rounded-xl border border-slate-700 bg-[#0B111B] p-3.5 space-y-2.5"
                >
                  <input
                    required
                    value={missionForm.title}
                    onChange={(e) => setMissionForm((p) => ({ ...p, title: e.target.value }))}
                    placeholder="Tytuł misji"
                    className="w-full rounded-lg bg-[#060A11] border border-slate-700 px-2.5 py-1.5 text-xs text-white"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      value={missionForm.locationName}
                      onChange={(e) => setMissionForm((p) => ({ ...p, locationName: e.target.value }))}
                      placeholder="Lokalizacja"
                      className="rounded-lg bg-[#060A11] border border-slate-700 px-2.5 py-1.5 text-xs text-white"
                    />
                    <input
                      value={missionForm.assignedUnit}
                      onChange={(e) => setMissionForm((p) => ({ ...p, assignedUnit: e.target.value }))}
                      placeholder="Jednostka"
                      className="rounded-lg bg-[#060A11] border border-slate-700 px-2.5 py-1.5 text-xs text-white"
                    />
                  </div>
                  <textarea
                    rows={2}
                    value={missionForm.objective}
                    onChange={(e) => setMissionForm((p) => ({ ...p, objective: e.target.value }))}
                    placeholder="Cel operacyjny misji"
                    className="w-full rounded-lg bg-[#060A11] border border-slate-700 px-2.5 py-1.5 text-xs text-white"
                  />
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={() => setShowAddMission(false)} className="text-xs text-slate-400 px-2">
                      Anuluj
                    </button>
                    <button
                      type="submit"
                      disabled={isSaving}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-cyan-500/20 text-cyan-200 border border-cyan-500/35"
                    >
                      Utwórz misję
                    </button>
                  </div>
                </form>
              )}

              <div className="space-y-2.5">
                {(overview?.missions || []).map((m) => (
                  <article key={m.id} className="rounded-xl border border-slate-800/90 bg-[#0B111B] p-4 space-y-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="flex flex-wrap items-center gap-1.5 mb-1">
                          <span
                            className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
                              m.status === 'COMPLETED'
                                ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                                : 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30'
                            }`}
                          >
                            {m.status}
                          </span>
                          <span className="text-[11px] text-slate-400">{m.locationName}</span>
                        </div>
                        <h3 className="text-sm font-medium text-white">{m.title}</h3>
                      </div>
                      <span className="font-mono text-sm font-semibold text-cyan-300 shrink-0">{m.progressPct}%</span>
                    </div>

                    <div className="h-1.5 rounded-full bg-slate-900 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${
                          m.progressPct >= 100 ? 'bg-emerald-400' : 'bg-cyan-400'
                        }`}
                        style={{ width: `${Math.min(100, Math.max(0, m.progressPct))}%` }}
                      />
                    </div>

                    <p className="text-xs text-slate-400">{m.objective}</p>

                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-800/80 text-[11px] text-slate-400">
                      <span>
                        Jednostka: <strong className="text-slate-200">{m.assignedUnit}</strong> · Dowódca:{' '}
                        <strong className="text-slate-200">{m.commander}</strong>
                      </span>
                      {m.status !== 'COMPLETED' && (
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={isSaving}
                            onClick={() =>
                              void handleMissionAction(
                                { id: m.id, progressPct: Math.min(100, m.progressPct + 10) },
                                `Zwiększono postęp misji „${m.title}”.`,
                              )
                            }
                            className="px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-200 font-mono"
                          >
                            +10%
                          </button>
                          <button
                            type="button"
                            disabled={isSaving}
                            onClick={() =>
                              void handleMissionAction(
                                { id: m.id, progressPct: 100, status: 'COMPLETED' },
                                `Oznaczono misję „${m.title}” jako zakończoną.`,
                              )
                            }
                            className="inline-flex items-center gap-1 px-2 py-1 rounded bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-200"
                          >
                            <CheckCircle2 className="w-3 h-3" />
                            Zakończ
                          </button>
                        </div>
                      )}
                    </div>
                  </article>
                ))}
              </div>

              {/* Zadania agentów AI na żywo z SQLite */}
              <div className="rounded-xl border border-slate-800/90 bg-[#0B111B] p-4 space-y-2.5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-2">
                  <Activity className="w-3.5 h-3.5 text-emerald-400" />
                  Bieżące zadania agentów AI (SQLite WAL)
                </h3>
                {overview && overview.liveAgentTasks.length > 0 ? (
                  <div className="space-y-1.5">
                    {overview.liveAgentTasks.slice(0, 8).map((t) => (
                      <div
                        key={t.id}
                        className="flex items-center justify-between gap-2 rounded-lg bg-[#070C14] border border-slate-800/80 px-3 py-2 text-xs"
                      >
                        <div className="min-w-0">
                          <div className="text-slate-200 truncate">{t.title}</div>
                          <div className="text-[10px] font-mono text-slate-500">
                            {t.target_agent} · {fmtTime(t.created_at)}
                          </div>
                        </div>
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-900 border border-slate-700 text-slate-300 shrink-0">
                          {t.status}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-slate-500">Brak aktywnych zadań agentów w kolejce SQLite.</p>
                )}
              </div>
            </section>

            {/* PRAWA KOLUMNA: BADANIA NAUKOWE */}
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                  <FlaskConical className="w-4 h-4 text-sky-400" />
                  Trwające Badania Naukowe ({overview?.research.length || 0})
                </h2>
                <button
                  type="button"
                  onClick={() => setShowAddResearch((v) => !v)}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs bg-sky-500/15 hover:bg-sky-500/25 text-sky-200 border border-sky-500/30"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Nowe badanie
                </button>
              </div>

              {showAddResearch && (
                <form
                  onSubmit={(e) => void handleCreateResearch(e)}
                  className="rounded-xl border border-slate-700 bg-[#0B111B] p-3.5 space-y-2.5"
                >
                  <input
                    required
                    value={researchForm.title}
                    onChange={(e) => setResearchForm((p) => ({ ...p, title: e.target.value }))}
                    placeholder="Nazwa programu badawczego"
                    className="w-full rounded-lg bg-[#060A11] border border-slate-700 px-2.5 py-1.5 text-xs text-white"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      value={researchForm.domain}
                      onChange={(e) => setResearchForm((p) => ({ ...p, domain: e.target.value }))}
                      placeholder="Dziedzina (np. Botanika, QKD, AI)"
                      className="rounded-lg bg-[#060A11] border border-slate-700 px-2.5 py-1.5 text-xs text-white"
                    />
                    <input
                      value={researchForm.locationName}
                      onChange={(e) => setResearchForm((p) => ({ ...p, locationName: e.target.value }))}
                      placeholder="Placówka / Laboratorium"
                      className="rounded-lg bg-[#060A11] border border-slate-700 px-2.5 py-1.5 text-xs text-white"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      value={researchForm.leadTeam}
                      onChange={(e) => setResearchForm((p) => ({ ...p, leadTeam: e.target.value }))}
                      placeholder="Zespół prowadzący"
                      className="rounded-lg bg-[#060A11] border border-slate-700 px-2.5 py-1.5 text-xs text-white"
                    />
                    <input
                      type="number"
                      min="1"
                      value={researchForm.researchersCount}
                      onChange={(e) => setResearchForm((p) => ({ ...p, researchersCount: e.target.value }))}
                      placeholder="Liczba naukowców"
                      className="rounded-lg bg-[#060A11] border border-slate-700 px-2.5 py-1.5 text-xs text-white"
                    />
                  </div>
                  <textarea
                    rows={2}
                    value={researchForm.latestFinding}
                    onChange={(e) => setResearchForm((p) => ({ ...p, latestFinding: e.target.value }))}
                    placeholder="Bieżący stan / pierwsze wyniki pomiarów"
                    className="w-full rounded-lg bg-[#060A11] border border-slate-700 px-2.5 py-1.5 text-xs text-white"
                  />
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={() => setShowAddResearch(false)} className="text-xs text-slate-400 px-2">
                      Anuluj
                    </button>
                    <button
                      type="submit"
                      disabled={isSaving}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-sky-500/20 text-sky-200 border border-sky-500/35"
                    >
                      Uruchom badanie
                    </button>
                  </div>
                </form>
              )}

              <div className="space-y-2.5">
                {(overview?.research || []).map((r) => (
                  <article key={r.id} className="rounded-xl border border-slate-800/90 bg-[#0B111B] p-4 space-y-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="flex flex-wrap items-center gap-1.5 mb-1">
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded border border-sky-500/30 bg-sky-500/10 text-sky-300">
                            {r.domain}
                          </span>
                          <span className="text-[11px] text-slate-400">{r.locationName}</span>
                        </div>
                        <h3 className="text-sm font-medium text-white">{r.title}</h3>
                      </div>
                      <span className="font-mono text-sm font-semibold text-sky-300 shrink-0">{r.progressPct}%</span>
                    </div>

                    <div className="h-1.5 rounded-full bg-slate-900 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-sky-400 transition-all"
                        style={{ width: `${Math.min(100, Math.max(0, r.progressPct))}%` }}
                      />
                    </div>

                    <div className="rounded-lg bg-[#070C14] border border-slate-800/80 px-3 py-2 text-xs text-slate-300">
                      <span className="text-[10px] font-mono uppercase text-slate-500 block mb-0.5">Najnowszy wynik</span>
                      {r.latestFinding}
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-800/80 text-[11px] text-slate-400">
                      <span>
                        {r.leadTeam} · <strong className="text-slate-200 font-mono">{fmtNum(r.researchersCount)}</strong> badaczy
                      </span>
                      <button
                        type="button"
                        disabled={isSaving || r.progressPct >= 100}
                        onClick={() =>
                          void handleResearchAction(
                            { id: r.id, progressPct: Math.min(100, r.progressPct + 10) },
                            `Zaktualizowano postęp badania „${r.title}”.`,
                          )
                        }
                        className="px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-200 font-mono disabled:opacity-40"
                      >
                        +10% postępu
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </div>
        )}

        {/* WIDOK 3: BOTANIKA & BIOSFERA */}
        {subView === 'botany' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                  <Leaf className="w-4 h-4 text-emerald-400" />
                  Botanika &amp; Biosfera w poszczególnych elementach infrastruktury
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Bieżące procesy biologiczne, produkcja O₂, oczyszczanie CO₂, obieg H₂O i rejestr zdarzeń w każdej placówce i na statkach.
                </p>
              </div>
              <div className="flex items-center gap-2">
                {focusedBotanyFacilityId && (
                  <button
                    type="button"
                    onClick={() => setFocusedBotanyFacilityId(null)}
                    className="px-2.5 py-1.5 rounded-lg text-xs bg-slate-900 text-slate-300 border border-slate-700"
                  >
                    Pokaż wszystkie moduły
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShowAddBotany((v) => !v)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 border border-emerald-500/30"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Nowy moduł botaniczny
                </button>
              </div>
            </div>

            {showAddBotany && (
              <form
                onSubmit={(e) => void handleCreateBotany(e)}
                className="rounded-xl border border-slate-700 bg-[#0B111B] p-4 grid grid-cols-1 md:grid-cols-3 gap-3"
              >
                <input
                  required
                  value={newBotanyForm.facilityName}
                  onChange={(e) => setNewBotanyForm((p) => ({ ...p, facilityName: e.target.value }))}
                  placeholder="Placówka / moduł (np. Baza Księżycowa — Szklarnia #1)"
                  className="rounded-lg bg-[#060A11] border border-slate-700 px-2.5 py-2 text-xs text-white"
                />
                <input
                  value={newBotanyForm.location}
                  onChange={(e) => setNewBotanyForm((p) => ({ ...p, location: e.target.value }))}
                  placeholder="Lokalizacja"
                  className="rounded-lg bg-[#060A11] border border-slate-700 px-2.5 py-2 text-xs text-white"
                />
                <input
                  value={newBotanyForm.biomeType}
                  onChange={(e) => setNewBotanyForm((p) => ({ ...p, biomeType: e.target.value }))}
                  placeholder="Typ biomu (np. Aeroponika / Bioreaktor)"
                  className="rounded-lg bg-[#060A11] border border-slate-700 px-2.5 py-2 text-xs text-white"
                />
                <input
                  value={newBotanyForm.currentActivity}
                  onChange={(e) => setNewBotanyForm((p) => ({ ...p, currentActivity: e.target.value }))}
                  placeholder="Co dzieje się obecnie w module?"
                  className="md:col-span-2 rounded-lg bg-[#060A11] border border-slate-700 px-2.5 py-2 text-xs text-white"
                />
                <div className="flex items-center justify-end gap-2">
                  <button type="button" onClick={() => setShowAddBotany(false)} className="text-xs text-slate-400">
                    Anuluj
                  </button>
                  <button
                    type="submit"
                    disabled={isSaving}
                    className="px-3.5 py-2 rounded-lg text-xs font-medium bg-emerald-500/20 text-emerald-200 border border-emerald-500/35"
                  >
                    Utwórz moduł
                  </button>
                </div>
              </form>
            )}

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {(overview?.botany || [])
                .filter((b) => !focusedBotanyFacilityId || b.facilityId === focusedBotanyFacilityId)
                .map((b) => {
                  const stMeta = BOTANY_STATUS_META[b.status] || BOTANY_STATUS_META.OPTIMAL;
                  const isEditing = editingBotanyId === b.id;
                  return (
                    <article key={b.id} className="rounded-xl border border-slate-800/90 bg-[#0B111B] p-4 space-y-3.5">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="flex flex-wrap items-center gap-2 mb-1">
                            <span className={`text-[10px] font-mono px-2 py-0.5 rounded border ${stMeta.cls}`}>
                              {stMeta.label}
                            </span>
                            <span className="text-[11px] text-slate-400 flex items-center gap-1">
                              <MapPin className="w-3 h-3 text-cyan-400" />
                              {b.location}
                            </span>
                          </div>
                          <h3 className="text-sm font-semibold text-white">{b.facilityName}</h3>
                          <p className="text-[11px] text-slate-400">
                            {b.biomeType} · Światło: <span className="font-mono text-slate-300">{b.lightCycle}</span>
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => (isEditing ? setEditingBotanyId(null) : openBotanyEditor(b))}
                          className="px-2.5 py-1 rounded-lg text-[11px] bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-200 shrink-0"
                        >
                          {isEditing ? 'Zamknij' : 'Aktualizuj'}
                        </button>
                      </div>

                      {/* Co dzieje się teraz */}
                      <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.04] px-3 py-2.5">
                        <div className="text-[10px] font-mono uppercase tracking-wider text-emerald-300 mb-1">
                          Co dzieje się teraz w botanice
                        </div>
                        <p className="text-xs text-slate-200 leading-relaxed">{b.currentActivity}</p>
                      </div>

                      {/* 6 parametrów środowiskowych */}
                      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                        <div className="rounded-lg bg-[#070C14] border border-slate-800/80 p-2 text-center">
                          <Wind className="w-3.5 h-3.5 text-emerald-400 mx-auto mb-0.5" />
                          <div className="text-xs font-mono font-semibold text-emerald-300">{b.o2OutputPct}%</div>
                          <div className="text-[10px] text-slate-500">O₂</div>
                        </div>
                        <div className="rounded-lg bg-[#070C14] border border-slate-800/80 p-2 text-center">
                          <Activity className="w-3.5 h-3.5 text-cyan-400 mx-auto mb-0.5" />
                          <div className="text-xs font-mono font-semibold text-cyan-300">{b.co2ScrubPct}%</div>
                          <div className="text-[10px] text-slate-500">CO₂ scrub</div>
                        </div>
                        <div className="rounded-lg bg-[#070C14] border border-slate-800/80 p-2 text-center">
                          <Droplets className="w-3.5 h-3.5 text-sky-400 mx-auto mb-0.5" />
                          <div className="text-xs font-mono font-semibold text-slate-100">{b.humidityPct}%</div>
                          <div className="text-[10px] text-slate-500">Wilgotn.</div>
                        </div>
                        <div className="rounded-lg bg-[#070C14] border border-slate-800/80 p-2 text-center">
                          <Thermometer className="w-3.5 h-3.5 text-amber-400 mx-auto mb-0.5" />
                          <div className="text-xs font-mono font-semibold text-slate-100">{b.tempC}°C</div>
                          <div className="text-[10px] text-slate-500">Temp</div>
                        </div>
                        <div className="rounded-lg bg-[#070C14] border border-slate-800/80 p-2 text-center">
                          <RefreshCw className="w-3.5 h-3.5 text-sky-300 mx-auto mb-0.5" />
                          <div className="text-xs font-mono font-semibold text-sky-300">{b.waterRecycledPct}%</div>
                          <div className="text-[10px] text-slate-500">Obieg H₂O</div>
                        </div>
                        <div className="rounded-lg bg-[#070C14] border border-slate-800/80 p-2 text-center">
                          <Leaf className="w-3.5 h-3.5 text-emerald-300 mx-auto mb-0.5" />
                          <div className="text-xs font-mono font-semibold text-white">{fmtNum(b.biomassKg)} kg</div>
                          <div className="text-[10px] text-slate-500">Biomasa</div>
                        </div>
                      </div>

                      {/* Kultury roślinne */}
                      <div className="flex flex-wrap gap-1.5">
                        {b.activeCultures.map((culture) => (
                          <span
                            key={culture}
                            className="text-[11px] px-2 py-0.5 rounded-md bg-slate-900 border border-slate-800 text-slate-300"
                          >
                            {culture}
                          </span>
                        ))}
                      </div>

                      {/* Edytor inline */}
                      {isEditing && (
                        <form
                          onSubmit={(e) => void handleSaveBotanyUpdate(e, b.id)}
                          className="rounded-lg border border-slate-700 bg-[#070C14] p-3 space-y-2.5"
                        >
                          <div className="grid grid-cols-3 gap-2">
                            <select
                              value={botanyUpdate.status}
                              onChange={(e) => setBotanyUpdate((p) => ({ ...p, status: e.target.value }))}
                              className="rounded bg-[#060A11] border border-slate-700 px-2 py-1.5 text-xs text-white"
                            >
                              <option value="OPTIMAL">OPTIMAL</option>
                              <option value="HARVEST_READY">HARVEST_READY</option>
                              <option value="GROWING">GROWING</option>
                              <option value="ATTENTION">ATTENTION</option>
                              <option value="ALERT">ALERT</option>
                            </select>
                            <input
                              type="number"
                              step="0.1"
                              value={botanyUpdate.o2OutputPct}
                              onChange={(e) => setBotanyUpdate((p) => ({ ...p, o2OutputPct: e.target.value }))}
                              placeholder="O₂ %"
                              className="rounded bg-[#060A11] border border-slate-700 px-2 py-1.5 text-xs text-white"
                            />
                            <input
                              type="number"
                              step="1"
                              value={botanyUpdate.biomassKg}
                              onChange={(e) => setBotanyUpdate((p) => ({ ...p, biomassKg: e.target.value }))}
                              placeholder="Biomasa kg"
                              className="rounded bg-[#060A11] border border-slate-700 px-2 py-1.5 text-xs text-white"
                            />
                          </div>
                          <textarea
                            rows={2}
                            value={botanyUpdate.currentActivity}
                            onChange={(e) => setBotanyUpdate((p) => ({ ...p, currentActivity: e.target.value }))}
                            placeholder="Opis bieżącej aktywności w module botanicznym"
                            className="w-full rounded bg-[#060A11] border border-slate-700 px-2.5 py-1.5 text-xs text-white"
                          />
                          <div className="flex gap-2">
                            <input
                              value={botanyUpdate.eventText}
                              onChange={(e) => setBotanyUpdate((p) => ({ ...p, eventText: e.target.value }))}
                              placeholder="Opcjonalny wpis do dziennika zdarzeń (np. Zakończono zbiór 40 kg)"
                              className="flex-1 rounded bg-[#060A11] border border-slate-700 px-2.5 py-1.5 text-xs text-white"
                            />
                            <button
                              type="submit"
                              disabled={isSaving}
                              className="px-3 py-1.5 rounded text-xs font-medium bg-emerald-500/20 text-emerald-200 border border-emerald-500/35"
                            >
                              Zapisz
                            </button>
                          </div>
                        </form>
                      )}

                      {/* Dziennik zdarzeń botaniki */}
                      {b.recentEvents.length > 0 && (
                        <div className="border-t border-slate-800/80 pt-2.5 space-y-1.5">
                          <div className="text-[10px] font-mono uppercase text-slate-500">Ostatnie zdarzenia</div>
                          {b.recentEvents.slice(0, 3).map((ev, idx) => (
                            <div key={`${b.id}-ev-${idx}`} className="flex items-start gap-2 text-[11px]">
                              <span
                                className={`font-mono px-1.5 py-0.5 rounded text-[10px] shrink-0 ${
                                  ev.level === 'WARN' || ev.level === 'ALERT'
                                    ? 'bg-amber-500/15 text-amber-300'
                                    : 'bg-slate-900 text-slate-400'
                                }`}
                              >
                                {ev.level}
                              </span>
                              <span className="text-slate-300 flex-1">{ev.text}</span>
                              <span className="font-mono text-[10px] text-slate-500 shrink-0">{fmtTime(ev.timestamp)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </article>
                  );
                })}
            </div>
          </div>
        )}

        {/* WIDOK 4: STOCZNIA POZAZIEMSKA & INTEGRACJA HOSTÓW SVL-364 / SVL-365 */}
        {subView === 'upgrades' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-amber-400" />
                  Stocznia Pozaziemska (APEX-CITADEL / Ceres / L4) — Obustronna Integracja Hostów SVL-364 &amp; SVL-365
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Zamówione poza Ziemią pakiety modernizacji, przebudowy i obustronnej integracji (Statek &lt;-&gt; System SVL) dla hostów{' '}
                  <strong className="text-slate-200">SVL-364 Ebon Apex</strong> oraz{' '}
                  <strong className="text-slate-200">SVL-365 Sentinel Aegis</strong> przez mostek MCP ROOT.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowAddOrder((v) => !v)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-500/15 hover:bg-amber-500/25 text-amber-200 border border-amber-500/35"
              >
                <Plus className="w-3.5 h-3.5" />
                Zamów ulepszenie poza Ziemią
              </button>
            </div>

            {showAddOrder && (
              <form
                onSubmit={(e) => void handleCreateOrder(e)}
                className="rounded-xl border border-slate-700 bg-[#0B111B] p-4 grid grid-cols-1 md:grid-cols-3 gap-3"
              >
                <input
                  required
                  value={orderForm.title}
                  onChange={(e) => setOrderForm((p) => ({ ...p, title: e.target.value }))}
                  placeholder="Nazwa pakietu / ulepszenia (np. Koprocesor QKD + Tarcza SVL-365 Mk7)"
                  className="md:col-span-2 rounded-lg bg-[#060A11] border border-slate-700 px-2.5 py-2 text-xs text-white"
                />
                <input
                  value={orderForm.tier}
                  onChange={(e) => setOrderForm((p) => ({ ...p, tier: e.target.value }))}
                  placeholder="Klasa (np. OMEGA-MK7)"
                  className="rounded-lg bg-[#060A11] border border-slate-700 px-2.5 py-2 text-xs text-white font-mono"
                />
                <select
                  value={orderForm.vendorName}
                  onChange={(e) => setOrderForm((p) => ({ ...p, vendorName: e.target.value }))}
                  className="rounded-lg bg-[#060A11] border border-slate-700 px-2.5 py-2 text-xs text-white"
                >
                  <option value="APEX-CITADEL Orbital Foundry & Quantum Shipyard (L2 · Poza Ziemią)">
                    APEX-CITADEL Orbital Foundry &amp; Quantum Shipyard (L2)
                  </option>
                  <option value="Jupiter L4 Quantum Emporium (SVL-465 Dock)">
                    Jupiter L4 Quantum Emporium (SVL-465 Dock)
                  </option>
                  <option value="Ceres Deep-Space Cybernetics & Bio-Forge (2.767 AU)">
                    Ceres Deep-Space Cybernetics &amp; Bio-Forge (2.767 AU)
                  </option>
                </select>
                <input
                  value={orderForm.targetHost}
                  onChange={(e) => setOrderForm((p) => ({ ...p, targetHost: e.target.value }))}
                  placeholder="Docelowy host / system (np. SVL-365 + SVL-364 + Jądro SVL)"
                  className="rounded-lg bg-[#060A11] border border-slate-700 px-2.5 py-2 text-xs text-white"
                />
                <input
                  value={orderForm.category}
                  onChange={(e) => setOrderForm((p) => ({ ...p, category: e.target.value }))}
                  placeholder="Kategoria (np. Host & MCP Integration)"
                  className="rounded-lg bg-[#060A11] border border-slate-700 px-2.5 py-2 text-xs text-white"
                />
                <textarea
                  rows={2}
                  value={orderForm.specs}
                  onChange={(e) => setOrderForm((p) => ({ ...p, specs: e.target.value }))}
                  placeholder="Specyfikacja integracji z naszym systemem i hostem SVL-365"
                  className="md:col-span-2 rounded-lg bg-[#060A11] border border-slate-700 px-2.5 py-2 text-xs text-white"
                />
                <div className="flex items-center justify-end gap-2">
                  <button type="button" onClick={() => setShowAddOrder(false)} className="text-xs text-slate-400">
                    Anuluj
                  </button>
                  <button
                    type="submit"
                    disabled={isSaving}
                    className="px-4 py-2 rounded-lg text-xs font-medium bg-amber-500/20 text-amber-200 border border-amber-500/35"
                  >
                    Zamów i zintegruj przez MCP
                  </button>
                </div>
              </form>
            )}

            {/* Dostawcy pozaziemscy */}
            {overview?.procurementVendors && overview.procurementVendors.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {overview.procurementVendors.map((v) => (
                  <div key={v.id} className="rounded-xl border border-slate-800/90 bg-[#0B111B] p-3.5 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-500/10 text-amber-300 border border-amber-500/25">
                        {v.rating}
                      </span>
                      <span className="text-[10px] font-mono text-slate-400">{v.location}</span>
                    </div>
                    <h3 className="text-xs font-semibold text-white">{v.name}</h3>
                    <p className="text-[11px] text-slate-400">{v.specialization}</p>
                  </div>
                ))}
              </div>
            )}

            {/* Zainstalowane pakiety przebudowy i integracji */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
              {(overview?.procurementCatalog || []).map((item) => (
                <article key={item.sku} className="rounded-xl border border-slate-800/90 bg-[#0B111B] p-4 space-y-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex flex-wrap items-center gap-1.5 mb-1">
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded border border-cyan-500/30 bg-cyan-500/10 text-cyan-300">
                          {item.sku}
                        </span>
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded border border-amber-500/30 bg-amber-500/10 text-amber-300">
                          {item.tier}
                        </span>
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded border border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
                          {item.status}
                        </span>
                      </div>
                      <h3 className="text-sm font-semibold text-white">{item.title}</h3>
                      <p className="text-[11px] text-slate-400">
                        Sklep / Stocznia: <strong className="text-slate-200">{item.vendorName}</strong> · Host:{' '}
                        <strong className="text-cyan-300">{item.targetHost}</strong>
                      </p>
                    </div>
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed">{item.specs}</p>
                  <div className="flex flex-wrap gap-1.5 pt-1 border-t border-slate-800/80">
                    {item.integratedWith.map((mod) => (
                      <span
                        key={mod}
                        className="text-[10px] font-mono px-2 py-0.5 rounded bg-[#070C14] border border-slate-800 text-slate-300"
                      >
                        {mod}
                      </span>
                    ))}
                  </div>
                </article>
              ))}
            </div>

            {/* Zrealizowane zamówienia pozaziemskie */}
            {overview?.procurementOrders && overview.procurementOrders.length > 0 && (
              <div className="rounded-xl border border-slate-800/90 bg-[#0B111B] p-4 space-y-2.5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                  Dziennik Zamówień i Integracji Pozaziemskich ({overview.procurementOrders.length})
                </h3>
                <div className="space-y-2">
                  {overview.procurementOrders.map((ord) => (
                    <div
                      key={ord.orderId}
                      className="rounded-lg bg-[#070C14] border border-slate-800/80 p-3 flex flex-col md:flex-row md:items-center justify-between gap-2"
                    >
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">
                            {ord.orderId} · {ord.status}
                          </span>
                          <span className="text-xs font-semibold text-white">{ord.title}</span>
                        </div>
                        <p className="text-xs text-slate-400">{ord.notes}</p>
                        <div className="text-[11px] text-slate-500">
                          Stocznia: <span className="text-slate-300">{ord.vendorName}</span> · Dostawa:{' '}
                          <span className="text-slate-300">{ord.deliveryLocation}</span> · Zamawiający:{' '}
                          <span className="text-slate-300">{ord.orderedBy}</span>
                        </div>
                      </div>
                      <div className="text-[11px] font-mono text-slate-400 shrink-0">{fmtTime(ord.integratedAt)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* WIDOK 5: HOSTY & SIEĆ (MCP / LAN) */}
        {subView === 'network' && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Monitorowane hosty TCP */}
              <section className="rounded-xl border border-slate-800/90 bg-[#0B111B] p-4 space-y-3">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-2">
                  <Radar className="w-4 h-4 text-cyan-400" />
                  Monitorowane hosty TCP ({hostInfra?.monitored.length || 0})
                </h2>

                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void addMonitoredHost(newHostName.trim(), newHostAddress.trim(), true);
                  }}
                  className="flex flex-wrap gap-2"
                >
                  <input
                    value={newHostName}
                    onChange={(e) => setNewHostName(e.target.value)}
                    placeholder="Nazwa hosta"
                    className="flex-1 min-w-[120px] rounded-lg bg-[#060A11] border border-slate-700 px-2.5 py-1.5 text-xs text-white"
                  />
                  <input
                    value={newHostAddress}
                    onChange={(e) => setNewHostAddress(e.target.value)}
                    placeholder="host:port (np. 192.168.1.10:22)"
                    className="flex-1 min-w-[160px] rounded-lg bg-[#060A11] border border-slate-700 px-2.5 py-1.5 text-xs text-white font-mono"
                  />
                  <button
                    type="submit"
                    disabled={isSaving}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-200 border border-cyan-500/35"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Dodaj
                  </button>
                </form>

                <div className="space-y-2">
                  {(hostInfra?.monitored || []).length === 0 ? (
                    <p className="text-xs text-slate-500">Brak ręcznie dodanych hostów TCP.</p>
                  ) : (
                    hostInfra!.monitored.map((m) => (
                      <div
                        key={m.id}
                        className="flex items-center justify-between gap-2 rounded-lg bg-[#070C14] border border-slate-800/80 px-3 py-2"
                      >
                        <div className="min-w-0">
                          <div className="text-xs font-medium text-white truncate">{m.name}</div>
                          <div className="text-[11px] font-mono text-slate-400">{m.address || 'brak adresu'}</div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <ProbeBadge probe={m.probe} note={m.note} />
                          <button
                            type="button"
                            onClick={() => void handleDeleteMonitoredHost(m.id, m.name)}
                            className="p-1 text-slate-500 hover:text-rose-300"
                            title="Usuń monitorowany host"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </section>

              {/* Hosty SSH */}
              <section className="rounded-xl border border-slate-800/90 bg-[#0B111B] p-4 space-y-3">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-2">
                  <Server className="w-4 h-4 text-emerald-400" />
                  Hosty OpenSSH ({hostInfra?.ssh_hosts.hosts.length || 0})
                </h2>
                {hostInfra && hostInfra.ssh_hosts.hosts.length > 0 ? (
                  <div className="space-y-2">
                    {hostInfra.ssh_hosts.hosts.map((h) => (
                      <div
                        key={`${h.alias}-${h.hostname}-${h.port}`}
                        className="flex items-center justify-between gap-2 rounded-lg bg-[#070C14] border border-slate-800/80 px-3 py-2"
                      >
                        <div className="min-w-0">
                          <div className="text-xs font-medium text-white font-mono">{h.alias}</div>
                          <div className="text-[11px] font-mono text-slate-400">
                            {h.user ? `${h.user}@` : ''}
                            {h.hostname}:{h.port}
                          </div>
                        </div>
                        <ProbeBadge probe={h.probe} />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-slate-500">{hostInfra?.ssh_hosts.reason || 'Brak skonfigurowanych hostów w ~/.ssh/config.'}</p>
                )}
              </section>
            </div>

            {/* Wykryte hosty w sieci LAN */}
            <section className="rounded-xl border border-slate-800/90 bg-[#0B111B] p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-2">
                  <Network className="w-4 h-4 text-sky-400" />
                  Wykryte hosty sieciowe LAN / ARP / known_hosts ({hostInfra?.discovered.hosts.length || 0})
                </h2>
                <span className="text-[11px] font-mono text-slate-500">Host lokalny: {hostInfra?.hostname || '—'}</span>
              </div>
              {hostInfra && hostInfra.discovered.hosts.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                  {hostInfra.discovered.hosts.slice(0, 18).map((h) => (
                    <div
                      key={h.key}
                      className="rounded-lg bg-[#070C14] border border-slate-800/80 p-3 flex items-center justify-between gap-2"
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-slate-100 truncate">{h.names[0] || h.addresses[0] || h.key}</div>
                        <div className="text-[10px] font-mono text-slate-400 truncate">{h.addresses.join(', ')}</div>
                        <div className="text-[10px] text-slate-500 mt-0.5">{h.sources.join(' · ')}</div>
                      </div>
                      {!h.tracked && (
                        <button
                          type="button"
                          onClick={() => void handleMonitorDiscovered(h)}
                          className="px-2 py-1 rounded text-[11px] bg-slate-900 hover:bg-slate-800 border border-slate-700 text-cyan-300 shrink-0"
                        >
                          Monitoruj
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-slate-500">Brak dodatkowych wykrytych hostów w sieci lokalnej.</p>
              )}
            </section>

            {/* Usługi systemd, porty i dyski */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <section className="rounded-xl border border-slate-800/90 bg-[#0B111B] p-4 space-y-2.5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-2">
                  <Cpu className="w-3.5 h-3.5 text-cyan-400" />
                  Usługi systemd ({hostInfra?.systemd.units.length || 0})
                </h3>
                {hostInfra?.systemd.available && hostInfra.systemd.units.length > 0 ? (
                  <div className="space-y-1.5">
                    {hostInfra.systemd.units.map((u) => (
                      <div
                        key={u.unit}
                        className="flex items-center justify-between text-xs rounded bg-[#070C14] border border-slate-800/80 px-2.5 py-1.5"
                      >
                        <span className="font-mono text-slate-200 truncate">{u.unit}</span>
                        <span
                          className={`text-[10px] font-mono ${
                            u.active_state === 'active' ? 'text-emerald-300' : 'text-slate-400'
                          }`}
                        >
                          {u.active_state || u.error || 'unknown'}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-slate-500">{hostInfra?.systemd.reason || 'Brak usług systemd.'}</p>
                )}
              </section>

              <section className="rounded-xl border border-slate-800/90 bg-[#0B111B] p-4 space-y-2.5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-2">
                  <Activity className="w-3.5 h-3.5 text-emerald-400" />
                  Nasłuchujące porty ({hostInfra?.listening_ports.length || 0})
                </h3>
                {hostInfra && hostInfra.listening_ports.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {hostInfra.listening_ports.slice(0, 24).map((p, idx) => (
                      <span
                        key={`${p.address}-${p.port}-${idx}`}
                        className="text-[11px] font-mono px-2 py-0.5 rounded bg-[#070C14] border border-slate-800 text-slate-300"
                      >
                        :{p.port}
                        {p.service ? ` (${p.service})` : ''}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-slate-500">Brak wykrytych portów nasłuchujących.</p>
                )}
              </section>

              <section className="rounded-xl border border-slate-800/90 bg-[#0B111B] p-4 space-y-2.5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-2">
                  <HardDrive className="w-3.5 h-3.5 text-amber-400" />
                  Dyski &amp; Montowania ({hostInfra?.mounts.length || 0})
                </h3>
                {hostInfra && hostInfra.mounts.length > 0 ? (
                  <div className="space-y-1.5">
                    {hostInfra.mounts.slice(0, 8).map((m) => (
                      <div key={`${m.device}-${m.mountpoint}`} className="rounded bg-[#070C14] border border-slate-800/80 px-2.5 py-1.5 text-xs">
                        <div className="flex items-center justify-between font-mono">
                          <span className="text-slate-200 truncate">{m.mountpoint}</span>
                          <span className="text-slate-400">{m.percent != null ? `${m.percent}%` : '—'}</span>
                        </div>
                        <div className="text-[10px] font-mono text-slate-500">
                          {m.free_gb != null && m.total_gb != null ? `Wolne ${m.free_gb} / ${m.total_gb} GB · ${m.fstype}` : m.device}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-slate-500">Brak informacji o punktach montowania.</p>
                )}
              </section>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
