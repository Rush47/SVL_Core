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
  service_status?: string;
  sentinel?: { checked_at: string; stale?: boolean; issues?: string[] } | null;
  hot_swap_status: string;
  debootstrap_status: string;
  operator_root: string;
  kernel_master_daemon: string;
  secondary_daemon: string;
  kernel_throughput_boost: string;
  neural_kernel_link_boost: string;
  calibration_boost: string;
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

  useEffect(() => {
    const onGlobalSynced = () => {
      void fetchStatus();
    };
    window.addEventListener('svl:global-synced', onGlobalSynced);
    return () => window.removeEventListener('svl:global-synced', onGlobalSynced);
  }, [fetchStatus]);

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
 * Pełny interaktywny kokpit SVL CoreOS 2: Apex (Dark-Apex UI).
 */
export const ApexCommandDock: React.FC<{ onNavigateTab?: (tab: any) => void }> = ({ onNavigateTab }) => {
  const { apex, busyAction, lastNotice, sendControl, fetchStatus } = useApexState();

  return (
    <div className="h-full overflow-y-auto p-3 sm:p-4 md:p-6 space-y-5 sm:space-y-6 bg-[#060911] text-slate-100">
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
          <p className="text-xs text-slate-400">
            Jądro: <span className="font-mono text-slate-200">{apex.kernel_release}</span> · Usługa:{' '}
            <span className="text-slate-200">{apex.service_status || 'wczytywanie…'}</span> · SVL-Sentinel:{' '}
            <span className={apex.sentinel && !apex.sentinel.stale ? 'text-emerald-300' : 'text-amber-300'}>
              {!apex.sentinel
                ? 'nie działa na tym hoście'
                : apex.sentinel.stale
                  ? 'brak świeżego pomiaru'
                  : apex.sentinel.issues && apex.sentinel.issues.length > 0
                    ? `problemy: ${apex.sentinel.issues.join('; ')}`
                    : `OK (pomiar ${new Date(apex.sentinel.checked_at).toLocaleTimeString('pl-PL')})`}
            </span>
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
        <div className="p-3.5 rounded-xl bg-cyan-950/35 border border-cyan-400/40 text-xs font-mono text-cyan-100 flex flex-wrap items-center justify-between gap-3">
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

      {/* Row 2: Interactive Network Daemons (5) & Open-Source AI Swarm Packages (4) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* 5 Network & Virtualization Daemons */}
        <div className="p-3.5 sm:p-5 rounded-xl bg-[#0B101E] border border-slate-800 space-y-3 min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-100">
              04. Daemony Sieciowe i Wirtualizacji (Kliknij, aby przełączyć ONLINE / STANDBY)
            </h2>
            <span className="text-xs font-mono text-cyan-300 break-all">SVL_CoreOS_2/security/network_suite.py</span>
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
                    className={`min-h-[36px] px-3 py-1 rounded text-xs font-mono font-semibold border transition-colors cursor-pointer shrink-0 ${
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
        <div className="p-3.5 sm:p-5 rounded-xl bg-[#0B101E] border border-slate-800 space-y-3 min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-100">
              05. Pakiety Open-Source AI (Hugging Face / GitHub / GitLab)
            </h2>
            <span className="text-xs font-mono text-violet-300 break-all">SVL_CoreOS_2/ai_core/huggingface_swarm_toolkit.py</span>
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
                    className={`min-h-[36px] px-3 py-1 rounded text-xs font-mono font-semibold border transition-colors cursor-pointer shrink-0 ${
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
