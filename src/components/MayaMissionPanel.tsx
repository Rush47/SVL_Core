import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Play, Pause, RefreshCw, CheckCircle2, AlertTriangle, ShieldCheck, Wrench, Lightbulb } from 'lucide-react';
import { safeFetchJson, getSvlOperatorAccessToken } from '../utils/svlLogic';

type Severity = 'OK' | 'INFO' | 'WARN' | 'ALERT';
interface MissionFinding { severity: Severity; category: string; title: string; detail: string }
interface MissionProposal { id: string; title: string; detail: string; action: string; actionLabel: string }
interface MissionRun {
  at: string;
  trigger: string;
  severity: Severity;
  headline: string;
  findings: MissionFinding[];
  actionsTaken: Array<{ title: string; ok: boolean; detail: string }>;
  proposals: MissionProposal[];
  notified: boolean;
  durationMs: number;
}
interface MissionLogEntry { at: string; level: 'INFO' | 'WARN' | 'ERROR'; message: string }
interface MissionState {
  ok: boolean;
  enabled: boolean;
  status: 'idle' | 'running';
  currentActivity: string;
  missionStatement: string;
  intervalSec: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  runs: MissionRun[];
  log: MissionLogEntry[];
}

const SEV_CLASS: Record<Severity, string> = {
  OK: 'text-emerald-300 border-emerald-500/40 bg-emerald-950/30',
  INFO: 'text-sky-300 border-sky-500/40 bg-sky-950/30',
  WARN: 'text-amber-300 border-amber-500/40 bg-amber-950/30',
  ALERT: 'text-rose-300 border-rose-500/40 bg-rose-950/30',
};
const SEV_ICON: Record<Severity, string> = { OK: '✅', INFO: 'ℹ️', WARN: '⚠️', ALERT: '🚨' };

const timeOf = (iso: string | null) =>
  iso && /^\d{4}-\d{2}-\d{2}T/.test(iso) ? new Date(iso).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';

export const MayaMissionPanel: React.FC = () => {
  const [state, setState] = useState<MissionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    if (!getSvlOperatorAccessToken()) {
      setError('Odblokuj dostęp przyciskiem 🔒 SVL w górnym pasku, aby zobaczyć misję Maya Mitek.');
      setState(null);
      return;
    }
    const res = await safeFetchJson<MissionState>('/api/maya/mission', { timeoutMs: 8000 });
    if (res.ok && res.data?.ok) {
      setState(res.data);
      setError(null);
    } else {
      setError(res.data ? (res.data as { error?: string }).error || 'Błąd odczytu misji.' : res.error || `HTTP ${res.status}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
    timerRef.current = setInterval(() => void refresh(), 4000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [refresh]);

  const runNow = async () => {
    setBusy(true);
    await safeFetchJson('/api/maya/mission/run', { method: 'POST', timeoutMs: 120000 });
    await refresh();
    setBusy(false);
  };
  const toggle = async (enabled: boolean) => {
    setBusy(true);
    await safeFetchJson('/api/maya/mission/toggle', { method: 'POST', timeoutMs: 8000, body: JSON.stringify({ enabled }) });
    await refresh();
    setBusy(false);
  };

  const latest = state?.runs?.[0];

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 space-y-4 text-slate-200">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-violet-400" aria-hidden="true" />
          <h1 className="text-lg font-semibold text-slate-100">Misja Maya Mitek — nadzór i rozwój systemu</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void runNow()}
            disabled={busy || state?.status === 'running'}
            className="inline-flex items-center gap-1.5 rounded-md border border-violet-600 bg-violet-600/20 px-3 py-1.5 text-xs font-semibold text-violet-200 hover:bg-violet-600/35 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${state?.status === 'running' ? 'animate-spin' : ''}`} /> Uruchom cykl teraz
          </button>
          {state?.enabled ? (
            <button
              type="button"
              onClick={() => void toggle(false)}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md border border-amber-600 bg-amber-600/20 px-3 py-1.5 text-xs font-semibold text-amber-200 hover:bg-amber-600/35 disabled:opacity-50"
            >
              <Pause className="w-3.5 h-3.5" /> Wstrzymaj misję
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void toggle(true)}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md border border-emerald-600 bg-emerald-600/20 px-3 py-1.5 text-xs font-semibold text-emerald-200 hover:bg-emerald-600/35 disabled:opacity-50"
            >
              <Play className="w-3.5 h-3.5" /> Włącz misję
            </button>
          )}
        </div>
      </div>

      {error && <div className="rounded-lg border border-amber-500/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">{error}</div>}

      {state && (
        <>
          {/* Status + co robi teraz */}
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-xl border border-slate-800 bg-[#111520] p-4">
              <div className="text-[11px] uppercase tracking-wide text-slate-500">Tryb automatyczny</div>
              <div className={`mt-1 text-sm font-semibold ${state.enabled ? 'text-emerald-300' : 'text-slate-400'}`}>
                {state.enabled ? 'WŁĄCZONY (działa w tle)' : 'WSTRZYMANY'}
              </div>
              <div className="mt-1 text-[11px] text-slate-500">
                Cykl co {Math.round(state.intervalSec / 60)} min · następny: {timeOf(state.nextRunAt)}
              </div>
            </div>
            <div className="rounded-xl border border-violet-700/50 bg-violet-950/20 p-4 md:col-span-2">
              <div className="text-[11px] uppercase tracking-wide text-violet-300/80 inline-flex items-center gap-1.5">
                <Activity className="w-3.5 h-3.5" /> Co Maya robi teraz
              </div>
              <div className="mt-1 flex items-center gap-2 text-sm text-slate-100">
                {state.status === 'running' && <RefreshCw className="w-3.5 h-3.5 animate-spin text-violet-300" />}
                {state.currentActivity}
              </div>
              <div className="mt-1 text-[11px] text-slate-500">Ostatni cykl: {timeOf(state.lastRunAt)}</div>
            </div>
          </div>

          <div className="rounded-lg border border-slate-800 bg-[#0d1017] px-3 py-2 text-[11px] text-slate-400">
            <span className="font-semibold text-slate-300">Misja:</span> {state.missionStatement}
          </div>

          {/* Najnowszy wynik */}
          {latest && (
            <div className={`rounded-xl border p-4 ${SEV_CLASS[latest.severity]}`}>
              <div className="flex items-center gap-2 text-sm font-semibold">
                <span>{SEV_ICON[latest.severity]}</span> {latest.headline}
                <span className="ml-auto text-[11px] font-normal opacity-70">{timeOf(latest.at)} · {latest.trigger}</span>
              </div>
              <div className="mt-2 grid gap-3 md:grid-cols-3">
                <div>
                  <div className="text-[11px] uppercase tracking-wide opacity-70 inline-flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Ustalenia</div>
                  <ul className="mt-1 space-y-1">
                    {latest.findings.map((f, i) => (
                      <li key={i} className="text-[11px] text-slate-300"><span className="font-semibold">{SEV_ICON[f.severity]} {f.title}</span> — {f.detail}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide opacity-70 inline-flex items-center gap-1"><Wrench className="w-3 h-3" /> Wykonane samonaprawy</div>
                  <ul className="mt-1 space-y-1">
                    {latest.actionsTaken.length === 0 && <li className="text-[11px] text-slate-500">Brak w tym cyklu.</li>}
                    {latest.actionsTaken.map((a, i) => (
                      <li key={i} className="text-[11px] text-slate-300">{a.ok ? '✅' : '❌'} {a.title} — {a.detail}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide opacity-70 inline-flex items-center gap-1"><Lightbulb className="w-3 h-3" /> Propozycje (do potwierdzenia)</div>
                  <ul className="mt-1 space-y-1">
                    {latest.proposals.map((p, i) => (
                      <li key={i} className="text-[11px] text-slate-300"><span className="font-semibold">🧩 {p.title}</span> — {p.detail}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            {/* Logi Mayi */}
            <div className="rounded-xl border border-slate-800 bg-[#111520] p-4">
              <h2 className="text-sm font-semibold text-slate-100 inline-flex items-center gap-2 mb-2">
                <ShieldCheck className="w-4 h-4 text-cyan-400" /> Logi Maya Mitek (na żywo)
              </h2>
              <div className="max-h-[320px] overflow-y-auto font-mono text-[11px] space-y-0.5">
                {state.log.length === 0 && <div className="text-slate-500">Brak wpisów.</div>}
                {state.log.map((e, i) => (
                  <div key={i} className="flex gap-2">
                    <span className="text-slate-600 tabular-nums shrink-0">{timeOf(e.at)}</span>
                    <span className={`shrink-0 ${e.level === 'ERROR' ? 'text-rose-400' : e.level === 'WARN' ? 'text-amber-400' : 'text-slate-500'}`}>{e.level}</span>
                    <span className="text-slate-300">{e.message}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Historia cykli */}
            <div className="rounded-xl border border-slate-800 bg-[#111520] p-4">
              <h2 className="text-sm font-semibold text-slate-100 inline-flex items-center gap-2 mb-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" /> Historia cykli misji
              </h2>
              <div className="max-h-[320px] overflow-y-auto space-y-1.5">
                {state.runs.length === 0 && <div className="text-[11px] text-slate-500">Jeszcze żaden cykl nie został wykonany.</div>}
                {state.runs.map((r, i) => (
                  <div key={i} className="rounded-lg border border-slate-800/80 bg-[#0d1017] px-3 py-2">
                    <div className="flex items-center gap-2 text-[11px]">
                      <span>{SEV_ICON[r.severity]}</span>
                      <span className="text-slate-200 font-medium truncate">{r.headline}</span>
                      <span className="ml-auto text-slate-500 shrink-0">{timeOf(r.at)}</span>
                    </div>
                    <div className="mt-0.5 text-[10px] text-slate-500">
                      {r.trigger} · ustaleń {r.findings.length} · samonapraw {r.actionsTaken.length} · {r.notified ? 'ogłoszono na „wszyscy”' : 'bez zmian'} · {Math.round(r.durationMs)} ms
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
