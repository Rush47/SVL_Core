import React, { useCallback, useEffect, useState } from 'react';
import { safeFetchJson } from '../utils/svlLogic';
import { useSvlSync } from '../utils/svlSyncStore';

export interface ApexDaemonEntry {
  name: string;
  status: 'ONLINE' | 'STANDBY' | string;
  port?: number;
  latency_ms?: number;
  cipher?: string;
  subnet?: string;
  iommu?: string;
  debootstrap?: string;
}

export interface ApexAiPackageEntry {
  name: string;
  source: string;
  status: 'ACTIVE' | 'STANDBY' | string;
}

export interface ApexStatusPayload {
  ok: boolean;
  active: boolean;
  system_title: string;
  version: string;
  distro: string;
  kernel_release: string;
  hot_swap_status: string;
  debootstrap_status: string;
  operator_root: string;
  kernel_master_daemon: string;
  secondary_daemon: string;
  kernel_throughput_boost: string;
  neural_kernel_link_boost: string;
  calibration_boost: string;
  e_shield_percent: number;
  e_shield_mode: string;
  fusion_core_mw: number;
  fusion_mode: string;
  solar_lockdown: boolean;
  fighter_incidents_count: number;
  sentinel_av_status: string;
  sentinel_av_quarantine: string;
  sentinel_av_scans_count: number;
  last_av_scan_at: string;
  remote_desktop_fps: number;
  remote_desktop_latency_ms: number;
  remote_desktop_protocol: string;
  full_duplex_chat: boolean;
  daemons: Record<string, ApexDaemonEntry>;
  ai_packages: Record<string, ApexAiPackageEntry>;
  coreos2_files_count: number;
  coreos2_files: string[];
  fighter_incidents?: Array<{
    incident_id: string;
    sector: string;
    signature: string;
    action: string;
    e_shield_absorption_mw: number;
  }>;
}

// Przed odpowiedzią serwera panel nie pokazuje żadnych „gotowych” wartości — tylko brak danych.
const NO_DATA = 'wczytywanie…';
const FALLBACK_APEX_STATUS: ApexStatusPayload = {
  ok: true,
  active: false,
  system_title: 'SVL CoreOS 2: Apex',
  version: NO_DATA,
  distro: NO_DATA,
  kernel_release: NO_DATA,
  hot_swap_status: NO_DATA,
  debootstrap_status: NO_DATA,
  operator_root: 'Mateusz Mitek',
  kernel_master_daemon: NO_DATA,
  secondary_daemon: NO_DATA,
  kernel_throughput_boost: 'brak pomiaru',
  neural_kernel_link_boost: 'brak pomiaru',
  calibration_boost: 'brak pomiaru',
  e_shield_percent: 0,
  e_shield_mode: NO_DATA,
  fusion_core_mw: 0,
  fusion_mode: NO_DATA,
  solar_lockdown: false,
  fighter_incidents_count: 0,
  sentinel_av_status: 'NIE SKANOWANO',
  sentinel_av_quarantine: NO_DATA,
  sentinel_av_scans_count: 0,
  last_av_scan_at: '',
  remote_desktop_fps: 0,
  remote_desktop_latency_ms: 0,
  remote_desktop_protocol: 'brak pomiaru',
  full_duplex_chat: true,
  daemons: {},
  ai_packages: {},
  coreos2_files_count: 0,
  coreos2_files: [],
  fighter_incidents: [],
};

export function useApexState() {
  const { serverRevision, refreshDomainModules } = useSvlSync();
  const [apex, setApex] = useState<ApexStatusPayload>(FALLBACK_APEX_STATUS);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [lastNotice, setLastNotice] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    const res = await safeFetchJson<ApexStatusPayload>('/api/apex/status', { timeoutMs: 8000 });
    if (res.ok && res.data?.ok) {
      setApex((prev) => ({ ...prev, ...res.data }));
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus, serverRevision]);

  const sendControl = useCallback(
    async (payload: Record<string, unknown>) => {
      const actionKey = String(payload.action || 'ctl');
      setBusyAction(actionKey);
      try {
        const res = await safeFetchJson<{
          ok: boolean;
          notice?: string;
          error?: string;
          status?: ApexStatusPayload;
        }>('/api/apex/control', {
          method: 'POST',
          timeoutMs: 12000,
          body: JSON.stringify({ emitToChat: true, ...payload }),
        });
        if (res.ok && res.data?.ok) {
          if (res.data.status) {
            setApex((prev) => ({ ...prev, ...res.data!.status }));
          }
          if (res.data.notice) {
            setLastNotice(res.data.notice);
          }
          void refreshDomainModules(['chat', 'health']);
        } else {
          if (res.data?.status) setApex((prev) => ({ ...prev, ...res.data!.status }));
          setLastNotice(`⚠️ ${res.data?.error || res.error || 'Operacja nie została wykonana.'}`);
        }
      } finally {
        setBusyAction(null);
      }
    },
    [refreshDomainModules],
  );

  return { apex, busyAction, lastNotice, sendControl, fetchStatus };
}

/**
 * Pasek interaktywnej telemetrii Dark-Apex montowany pod głównym nagłówkiem aplikacji.
 * Każdy parametr (E_Shield, Reaktor Fuzyjny, Solar-Lockdown, Sentinel AV, Remote Desktop) jest klikalny
 * i natychmiast zmienia stan w backendzie oraz publikuje komunikat na kanale „wszyscy”.
 */
export const ApexTelemetryRibbon: React.FC<{
  onOpenApexTab: () => void;
  onOpenLinuxTab: () => void;
}> = ({ onOpenApexTab, onOpenLinuxTab }) => {
  const { apex, busyAction, sendControl } = useApexState();
  const onlineDaemons = Object.values(apex.daemons || {}).filter((d) => d.status === 'ONLINE').length;
  const totalDaemons = Object.keys(apex.daemons || {}).length || 5;

  return (
    <div
      aria-label="Interaktywny pasek telemetrii SVL CoreOS 2: Apex"
      className="flex flex-wrap items-center justify-between gap-2 px-3 md:px-5 py-1.5 bg-[#060A14] border-b border-cyan-500/25 text-[11px] font-mono tabular-nums shrink-0"
    >
      <div className="flex flex-wrap items-center gap-1.5 md:gap-2">
        <button
          type="button"
          onClick={onOpenApexTab}
          className="px-2 py-0.5 rounded bg-cyan-950/60 hover:bg-cyan-900/70 border border-cyan-400/40 text-cyan-200 font-semibold transition-colors"
          title="Otwórz pełny kokpit SVL CoreOS 2: Apex"
        >
          ⚡ {apex.system_title} · Hot-Swap AKTYWNY ({apex.kernel_throughput_boost})
        </button>

        <button
          type="button"
          disabled={busyAction === 'cycle_e_shield'}
          onClick={() => void sendControl({ action: 'cycle_e_shield' })}
          className="px-2 py-0.5 rounded bg-[#0C1324] hover:bg-cyan-950/50 border border-cyan-500/35 text-cyan-300 transition-colors cursor-pointer"
          title="Kliknij, aby przełączyć moc tarczy E_Shield (100% / 125% Overcharge / 150% Max Apex)"
        >
          🛡️ E_Shield: {apex.e_shield_percent.toFixed(0)}% ({apex.e_shield_mode === 'DIRECTIONAL_ACTIVE' ? 'Kierunkowa' : apex.e_shield_mode})
        </button>

        <button
          type="button"
          disabled={busyAction === 'cycle_fusion_core'}
          onClick={() => void sendControl({ action: 'cycle_fusion_core' })}
          className="px-2 py-0.5 rounded bg-[#0C1324] hover:bg-emerald-950/50 border border-emerald-500/35 text-emerald-300 transition-colors cursor-pointer"
          title="Kliknij, aby przełączyć moc Reaktora Fuzyjnego SVL-364 (1456 MW / 1820 MW / 2100 MW)"
        >
          ⚛️ Reaktor: {apex.fusion_core_mw.toFixed(0)} MW ({apex.calibration_boost})
        </button>

        <button
          type="button"
          disabled={busyAction === 'toggle_solar_lockdown'}
          onClick={() => void sendControl({ action: 'toggle_solar_lockdown' })}
          className={`px-2 py-0.5 rounded border transition-colors cursor-pointer ${
            apex.solar_lockdown
              ? 'bg-amber-950/70 border-amber-400 text-amber-200 font-semibold'
              : 'bg-[#0C1324] hover:bg-amber-950/40 border-amber-500/35 text-amber-300'
          }`}
          title="Kliknij, aby przełączyć protokół Solar-Lockdown (archiwum 14 incydentów myśliwców Ziemia–Księżyc)"
        >
          🚨 Solar-Lockdown ({apex.fighter_incidents_count} myśliwców): {apex.solar_lockdown ? 'AKTYWNY' : 'DOZÓR'}
        </button>

        <button
          type="button"
          disabled={busyAction === 'run_av_scan'}
          onClick={() => void sendControl({ action: 'run_av_scan' })}
          className="px-2 py-0.5 rounded bg-[#0C1324] hover:bg-emerald-950/50 border border-emerald-500/30 text-emerald-300 transition-colors cursor-pointer"
          title="Kliknij, aby uruchomić heurystyczny skan jądra SVL-Sentinel AV"
        >
          🧬 Sentinel AV: {apex.sentinel_av_status} (skan #{apex.sentinel_av_scans_count})
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-slate-300">
        <button
          type="button"
          onClick={onOpenApexTab}
          className="px-2 py-0.5 rounded bg-[#0C1324] hover:bg-slate-800 border border-slate-700 text-slate-200 transition-colors"
          title="Status 5 daemonów sieciowych (Apex-Bridge, Double VPN, Hamachi, VT-d, Deployer)"
        >
          🌐 Daemony: {onlineDaemons}/{totalDaemons} ONLINE
        </button>
        <button
          type="button"
          disabled={busyAction === 'cycle_rd_fps'}
          onClick={() => void sendControl({ action: 'cycle_rd_fps' })}
          className="px-2 py-0.5 rounded bg-[#0C1324] hover:bg-violet-950/50 border border-violet-500/35 text-violet-300 transition-colors cursor-pointer"
          title="Kliknij, aby przełączyć klatkaż Apex Remote Desktop GUI (120 FPS / 240 FPS)"
        >
          🖥️ Apex-UI: {apex.remote_desktop_fps} FPS ({apex.remote_desktop_latency_ms} ms)
        </button>
        <button
          type="button"
          onClick={onOpenLinuxTab}
          className="px-2 py-0.5 rounded bg-[#0C1324] hover:bg-cyan-950/50 border border-cyan-500/30 text-cyan-200 transition-colors"
          title="Otwórz pliki SVL_CoreOS_2 i Debootstrap Debian 13 Trixie"
        >
          🐧 Debian 13 Trixie: 100% ({apex.coreos2_files_count} plików)
        </button>
      </div>
    </div>
  );
};

/**
 * Pełny interaktywny kokpit SVL CoreOS 2: Apex (Dark-Apex UI).
 */
export const ApexCommandDock: React.FC<{ onNavigateTab?: (tab: any) => void }> = ({ onNavigateTab }) => {
  const { apex, busyAction, lastNotice, sendControl, fetchStatus } = useApexState();

  const shieldSteps = [75, 100, 125, 150];
  const fusionSteps = [1100, 1456, 1820, 2100];

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 space-y-6 bg-[#060911] text-slate-100">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-cyan-500/25">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-cyan-300">
            <span>{apex.system_title}</span>
            <span aria-hidden="true">·</span>
            <span>{apex.version}</span>
            <span aria-hidden="true">·</span>
            <span className="text-emerald-300">{apex.distro}</span>
          </div>
          <h1 className="text-xl md:text-2xl font-bold tracking-tight text-slate-50">
            Kokpit Dowodzenia SVL CoreOS 2: Apex — Silnik Renderujący Dark-Apex &amp; Telemetria Statku SVL-364
          </h1>
          <p className="text-xs text-slate-400">
            Operator ROOT: <strong className="text-slate-200">{apex.operator_root}</strong> · Kernel Master Daemon:{' '}
            <strong className="text-cyan-300">{apex.kernel_master_daemon}</strong> · Drugi Agent ROOT:{' '}
            <strong className="text-amber-300">{apex.secondary_daemon}</strong> · Czat Obustronny (Full Duplex):{' '}
            <strong className="text-emerald-300">AKTYWNY</strong>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busyAction === 'broadcast_sentinel_test'}
            onClick={() => void sendControl({ action: 'broadcast_sentinel_test' })}
            className="px-3.5 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-slate-950 font-semibold text-xs transition-colors cursor-pointer"
          >
            📡 Nadaj raport SVL-Sentinel na kanał „wszyscy”
          </button>
          <button
            type="button"
            onClick={() => void fetchStatus()}
            className="px-3.5 py-2 rounded-lg bg-[#0C1324] hover:bg-slate-800 border border-cyan-500/35 text-xs font-mono text-cyan-200 transition-colors"
          >
            Odśwież telemetrię
          </button>
          {onNavigateTab && (
            <button
              type="button"
              onClick={() => onNavigateTab('linux')}
              className="px-3.5 py-2 rounded-lg bg-[#0C1324] hover:bg-slate-800 border border-emerald-500/35 text-xs font-mono text-emerald-300 transition-colors"
            >
              📂 Pliki SVL_CoreOS_2 ({apex.coreos2_files_count})
            </button>
          )}
        </div>
      </div>

      {lastNotice && (
        <div className="p-3.5 rounded-xl bg-cyan-950/35 border border-cyan-400/40 text-xs font-mono text-cyan-100 flex items-center justify-between gap-3">
          <span>{lastNotice}</span>
          {onNavigateTab && (
            <button
              type="button"
              onClick={() => onNavigateTab('chat')}
              className="px-2.5 py-1 rounded bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/40 text-cyan-200 whitespace-nowrap"
            >
              Zobacz na czacie →
            </button>
          )}
        </div>
      )}

      {/* Row 1: Interactive Telemetry Charts & Clickable Ship Parameters */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Card 1: E_Shield Interactive Control & Directional Chart */}
        <div className="p-5 rounded-xl bg-[#0B101E] border border-cyan-500/30 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-slate-100">01. Tarcza Energetyczna E_Shield (Klikalna)</h2>
              <p className="text-[11px] text-slate-400">Kliknij słupek wykresu lub przycisk, aby natychmiast zmienić moc tarczy</p>
            </div>
            <span className="text-lg font-mono font-bold text-cyan-300 tabular-nums">
              {apex.e_shield_percent.toFixed(0)}%
            </span>
          </div>

          {/* Clickable Bar Chart */}
          <div className="grid grid-cols-4 gap-2 items-end h-24 pt-2 px-2 bg-[#060911] rounded-lg border border-slate-800/80 pb-2">
            {shieldSteps.map((step) => {
              const active = Math.abs(apex.e_shield_percent - step) < 5;
              const heightPct = Math.round((step / 150) * 100);
              return (
                <button
                  key={step}
                  type="button"
                  onClick={() => void sendControl({ action: 'set_e_shield', value: step })}
                  className="flex flex-col items-center justify-end h-full group cursor-pointer"
                  title={`Ustaw E_Shield na ${step}%`}
                >
                  <div
                    style={{ height: `${heightPct}%` }}
                    className={`w-full rounded-t transition-all ${
                      active
                        ? 'bg-cyan-400 shadow-[0_0_12px_rgba(34,211,238,0.6)]'
                        : 'bg-cyan-900/50 group-hover:bg-cyan-600/70'
                    }`}
                  />
                  <span className={`text-[10px] font-mono mt-1 ${active ? 'text-cyan-300 font-bold' : 'text-slate-400'}`}>
                    {step}%
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between text-xs font-mono text-slate-300">
            <span>Tryb: {apex.e_shield_mode}</span>
            <button
              type="button"
              onClick={() => void sendControl({ action: 'cycle_e_shield' })}
              className="px-2.5 py-1 rounded bg-cyan-950/60 hover:bg-cyan-900 border border-cyan-500/40 text-cyan-200"
            >
              Przełącz tryb E_Shield
            </button>
          </div>
        </div>

        {/* Card 2: Fusion Core MW & Kernel Throughput (+450% / +1456%) */}
        <div className="p-5 rounded-xl bg-[#0B101E] border border-emerald-500/30 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-slate-100">02. Reaktor Fuzyjny SVL-364 &amp; Przepustowość</h2>
              <p className="text-[11px] text-slate-400">Kliknij wykres mocy, aby dostosować reaktor i magistralę 128D</p>
            </div>
            <span className="text-lg font-mono font-bold text-emerald-300 tabular-nums">
              {apex.fusion_core_mw.toFixed(0)} MW
            </span>
          </div>

          <div className="grid grid-cols-4 gap-2 items-end h-24 pt-2 px-2 bg-[#060911] rounded-lg border border-slate-800/80 pb-2">
            {fusionSteps.map((mw) => {
              const active = Math.abs(apex.fusion_core_mw - mw) < 30;
              const heightPct = Math.round((mw / 2100) * 100);
              return (
                <button
                  key={mw}
                  type="button"
                  onClick={() => void sendControl({ action: 'set_fusion_core', value: mw })}
                  className="flex flex-col items-center justify-end h-full group cursor-pointer"
                  title={`Ustaw Reaktor Fuzyjny na ${mw} MW`}
                >
                  <div
                    style={{ height: `${heightPct}%` }}
                    className={`w-full rounded-t transition-all ${
                      active
                        ? 'bg-emerald-400 shadow-[0_0_12px_rgba(16,185,129,0.6)]'
                        : 'bg-emerald-900/50 group-hover:bg-emerald-600/70'
                    }`}
                  />
                  <span className={`text-[10px] font-mono mt-1 ${active ? 'text-emerald-300 font-bold' : 'text-slate-400'}`}>
                    {mw}MW
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between text-xs font-mono text-slate-300">
            <span>Kernel: {apex.kernel_throughput_boost} · Neural: {apex.neural_kernel_link_boost}</span>
            <button
              type="button"
              onClick={() => void sendControl({ action: 'cycle_fusion_core' })}
              className="px-2.5 py-1 rounded bg-emerald-950/60 hover:bg-emerald-900 border border-emerald-500/40 text-emerald-200"
            >
              Zwiększ ciąg
            </button>
          </div>
        </div>

        {/* Card 3: SVL-Apex Firewall & Solar-Lockdown (14 Fighter Incidents) */}
        <div className="p-5 rounded-xl bg-[#0B101E] border border-amber-500/30 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-slate-100">03. SVL-Apex Firewall &amp; Solar-Lockdown</h2>
              <p className="text-[11px] text-slate-400">Archiwum 14 incydentów myśliwców w sektorze Ziemia–Księżyc</p>
            </div>
            <span
              className={`text-xs font-mono font-bold px-2 py-1 rounded border ${
                apex.solar_lockdown
                  ? 'bg-amber-950/80 border-amber-400 text-amber-200'
                  : 'bg-emerald-950/50 border-emerald-500/40 text-emerald-300'
              }`}
            >
              {apex.solar_lockdown ? 'SOLAR-LOCKDOWN AKTYWNY' : 'DOZÓR DPI AKTYWNY'}
            </span>
          </div>

          <div className="p-3 rounded-lg bg-[#060911] border border-slate-800 space-y-1.5 text-xs font-mono text-slate-300 max-h-24 overflow-y-auto">
            {(apex.fighter_incidents || []).slice(0, 6).map((inc) => (
              <div key={inc.incident_id} className="flex items-center justify-between gap-2 text-[11px]">
                <span className="text-amber-300">{inc.incident_id}</span>
                <span className="text-slate-400 truncate">{inc.signature}</span>
                <span className="text-emerald-400">{inc.e_shield_absorption_mw} MW</span>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => void sendControl({ action: 'toggle_solar_lockdown' })}
              className={`flex-1 py-1.5 px-3 rounded text-xs font-mono font-semibold border transition-colors cursor-pointer ${
                apex.solar_lockdown
                  ? 'bg-amber-500 text-slate-950 border-amber-400'
                  : 'bg-amber-950/50 hover:bg-amber-900/70 text-amber-200 border-amber-500/40'
              }`}
            >
              {apex.solar_lockdown ? 'Wyłącz Solar-Lockdown' : '🚨 Aktywuj Solar-Lockdown (14 myśliwców)'}
            </button>
            <button
              type="button"
              onClick={() => void sendControl({ action: 'run_av_scan' })}
              className="py-1.5 px-3 rounded text-xs font-mono bg-emerald-950/60 hover:bg-emerald-900 border border-emerald-500/40 text-emerald-200 cursor-pointer"
            >
              🧬 Skanuj AV
            </button>
          </div>
        </div>
      </div>

      {/* Row 2: Interactive Network Daemons (5) & Open-Source AI Swarm Packages (4) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* 5 Network & Virtualization Daemons */}
        <div className="p-5 rounded-xl bg-[#0B101E] border border-slate-800 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-100">
              04. Daemony Sieciowe i Wirtualizacji (Kliknij, aby przełączyć ONLINE / STANDBY)
            </h2>
            <span className="text-xs font-mono text-cyan-300">SVL_CoreOS_2/security/network_suite.py</span>
          </div>
          <div className="space-y-2">
            {Object.entries(apex.daemons || {}).map(([id, d]) => {
              const isOnline = d.status === 'ONLINE';
              return (
                <div
                  key={id}
                  className="flex items-center justify-between gap-3 p-2.5 rounded-lg bg-[#060911] border border-slate-800/90"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-slate-100 truncate">{d.name}</div>
                    <div className="text-[11px] font-mono text-slate-400 truncate">
                      {d.cipher || d.subnet || d.iommu || d.debootstrap || `Port ${d.port || 9364}`}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void sendControl({ action: 'toggle_daemon', daemonId: id })}
                    className={`px-3 py-1 rounded text-xs font-mono font-semibold border transition-colors cursor-pointer shrink-0 ${
                      isOnline
                        ? 'bg-emerald-950/60 border-emerald-500/50 text-emerald-300 hover:bg-emerald-900/70'
                        : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {d.status}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* 4 Open-Source AI Packages (Hugging Face / GitHub / GitLab) */}
        <div className="p-5 rounded-xl bg-[#0B101E] border border-slate-800 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-100">
              05. Pakiety Open-Source AI (Hugging Face / GitHub / GitLab)
            </h2>
            <span className="text-xs font-mono text-violet-300">SVL_CoreOS_2/ai_core/huggingface_swarm_toolkit.py</span>
          </div>
          <div className="space-y-2">
            {Object.entries(apex.ai_packages || {}).map(([id, pkg]) => {
              const isActive = pkg.status === 'ACTIVE';
              return (
                <div
                  key={id}
                  className="flex items-center justify-between gap-3 p-2.5 rounded-lg bg-[#060911] border border-slate-800/90"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-slate-100 truncate">{pkg.name}</div>
                    <div className="text-[11px] font-mono text-slate-400 truncate">Źródło: {pkg.source}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void sendControl({ action: 'toggle_ai_package', packageId: id })}
                    className={`px-3 py-1 rounded text-xs font-mono font-semibold border transition-colors cursor-pointer shrink-0 ${
                      isActive
                        ? 'bg-violet-950/60 border-violet-500/50 text-violet-300 hover:bg-violet-900/70'
                        : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {pkg.status}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
