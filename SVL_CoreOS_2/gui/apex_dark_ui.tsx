import React from 'react';

/**
 * SVL CoreOS 2: Apex — Odbezpieczony komponent interfejsu Apex-Dark UI (UI-Refactor).
 * Plik wypakowany bezpośrednio w repozytorium (SVL_CoreOS_2/gui/apex_dark_ui.tsx)
 * z rzeczywistymi wskaźnikami systemu SVL-364 i daemona SVL-Sentinel.
 */

export interface ApexDarkTelemetryProps {
  shipName?: string;
  kernelVersion?: string;
  computeThrustStatus?: string;
  doubleVpnActive?: boolean;
}

export const ApexDarkCoreOS2View: React.FC<ApexDarkTelemetryProps> = ({
  shipName = 'SVL-364 Ebon Apex',
  kernelVersion = 'Debian 13 (Trixie) · 6.12-svl364-apex',
  computeThrustStatus = 'FULL_BURN_NPU_CLUSTER_ONLINE',
  doubleVpnActive = true,
}) => {
  return (
    <section className="rounded-xl border border-cyan-500/30 bg-[#07090F] p-5 text-slate-100 space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
        <div>
          <h2 className="text-base font-bold text-cyan-300">
            SVL CoreOS 2: Apex — Silnik Renderujący Apex-Dark UI (Odbezpieczony w Repozytorium)
          </h2>
          <p className="text-xs text-slate-400 font-mono">
            {shipName} · {kernelVersion} · Nadzór: Maya Mitek (Kernel Master Daemon & SVL-Sentinel)
          </p>
        </div>
        <span className="px-2.5 py-1 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-xs font-mono">
          HOT-SWAP READY · 100%
        </span>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs font-mono">
        <div className="p-3 rounded-lg bg-[#0D111C] border border-slate-800">
          <div className="text-slate-400">Klaster Compute-Thrust & Hiperprzestrzeń 128D</div>
          <div className="text-violet-300 font-semibold mt-1">{computeThrustStatus}</div>
          <div className="text-[11px] text-slate-400 mt-1">
            Model pokładowy: ollama:svl364-apex-uncensored:latest
          </div>
        </div>
        <div className="p-3 rounded-lg bg-[#0D111C] border border-slate-800">
          <div className="text-slate-400">Pakiet Bezpieczeństwa Sentinel</div>
          <div className="text-cyan-300 font-semibold mt-1">
            {doubleVpnActive ? 'Double VPN + Hamachi + Firewall DPI + AV AKTYWNE' : 'STANDBY'}
          </div>
          <div className="text-[11px] text-slate-400 mt-1">
            Alarmy krytyczne: Kanał „Rodzina Mitek (wszyscy)”
          </div>
        </div>
      </div>
    </section>
  );
};
