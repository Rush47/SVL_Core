import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Cpu, Satellite, Sparkles, Image as ImageIcon, RefreshCw, CheckCircle2, XCircle, DownloadCloud } from 'lucide-react';
import { safeFetchJson, getSvlOperatorAccessToken, hasSvlOperatorAccessToken } from '../utils/svlLogic';

interface OllamaModel { name: string; size: number | null; parameterSize: string | null; vision: boolean }
interface ShipTunnel { enabled: boolean; status: string; target: string; localUrl: string; description: string; error: string | null }
interface EnginesState {
  ok: boolean;
  checkedAt: string;
  engines: {
    ollama: {
      source: string;
      host: string;
      reachable: boolean;
      busy: boolean;
      shipTunnel: ShipTunnel;
      models: OllamaModel[];
      loadedModels: string[];
      visionModels: string[];
      preferredModel: string;
      visionModel?: string;
      visionAliases?: string[];
      visionConfig?: { numCtx: number; numPredict: number; temperature: number; keepAlive: string | number };
      ramAvailableMb: number | null;
      diskFreeGb: number | null;
      error: string | null;
    };
    gemini: { configured: boolean; models: string[]; modelCount: number; forcedModel: string | null };
    image: { engine: string; available: boolean | null; detail: string | null };
  };
}

const fmtSize = (bytes: number | null) => (typeof bytes === 'number' ? `${(bytes / 1e9).toFixed(1)} GB` : '');
const Dot: React.FC<{ ok: boolean }> = ({ ok }) =>
  ok ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 inline" /> : <XCircle className="w-3.5 h-3.5 text-rose-400 inline" />;

export const AiEnginesCard: React.FC = () => {
  const [state, setState] = useState<EnginesState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [shipModels, setShipModels] = useState<{ targetModels: string[]; missingModels: string[]; installed: Array<{ name: string }>; reachable: boolean; pull: { running: boolean; models: Array<{ model: string; status: string; detail: string }> } } | null>(null);
  const [pulling, setPulling] = useState(false);
  const [pullingVision, setPullingVision] = useState(false);
  const [visionPullMsg, setVisionPullMsg] = useState<string | null>(null);

  const refreshShip = useCallback(async () => {
    const r = await safeFetchJson<any>('/api/ship/ollama/models', { timeoutMs: 10000 });
    if (r.ok && r.data?.ok) setShipModels(r.data);
  }, []);

  const pullUncensored = async () => {
    setPulling(true);
    await safeFetchJson('/api/ship/ollama/pull', { method: 'POST', timeoutMs: 15000, body: JSON.stringify({ onlyMissing: true }) });
    await refreshShip();
    setPulling(false);
  };

  const pullLlamaVision = async (targetModel = 'llama3.2-vision:11b') => {
    setPullingVision(true);
    setVisionPullMsg(`Inicjowanie pobierania ${targetModel}…`);
    const res = await safeFetchJson<any>('/api/ollama/pull', {
      method: 'POST',
      timeoutMs: 15000,
      body: JSON.stringify({ model: targetModel, origin: 'ai-engines-card' }),
    });
    if (res.ok && res.data?.ok) {
      setVisionPullMsg(`Pobieranie ${targetModel} aktywne w tle (${res.data?.pull?.status || 'RUNNING'}).`);
    } else {
      setVisionPullMsg(res.data?.error || res.error || 'Ollama nieosiągalna — uruchom daemon Ollama, aby pobrać model.');
    }
    await refresh();
    setPullingVision(false);
  };

  const refresh = useCallback(async () => {
    if (!hasSvlOperatorAccessToken()) {
      setError('Odblokuj dostęp przyciskiem 🔒 SVL, aby zobaczyć silniki AI.');
      setState(null);
      return;
    }
    const res = await safeFetchJson<EnginesState>('/api/ai/engines', { timeoutMs: 10000 });
    if (res.ok && res.data?.ok) {
      setState(res.data);
      setError(null);
    } else {
      setError(res.data ? (res.data as { error?: string }).error || 'Błąd odczytu silników AI.' : res.error || `HTTP ${res.status}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshShip();
    timerRef.current = setInterval(() => { void refresh(); void refreshShip(); }, 10000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [refresh, refreshShip]);

  const e = state?.engines;
  const ship = e?.ollama.shipTunnel;

  return (
    <div className="p-5 rounded-xl bg-[#111520] border border-slate-800 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-100 inline-flex items-center gap-2">
          <Cpu className="w-4 h-4 text-cyan-400" /> Silniki AI i dostępne modele
        </h2>
        <button type="button" onClick={() => void refresh()} className="text-slate-400 hover:text-slate-200" aria-label="Odśwież silniki AI">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {error && <p className="text-xs text-amber-300">{error}</p>}

      {e && (
        <div className="grid gap-3 lg:grid-cols-3">
          {/* Ollama (lokalna lub ze statku SVL-364) */}
          <div className="rounded-lg border border-slate-800 bg-[#0d1017] p-3 space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-200">
              {ship?.enabled ? <Satellite className="w-3.5 h-3.5 text-violet-400" /> : <Cpu className="w-3.5 h-3.5 text-cyan-400" />}
              Ollama — {e.ollama.source}
              <span className="ml-auto"><Dot ok={e.ollama.reachable} /></span>
            </div>
            <div className="text-[11px] text-slate-500 font-mono break-all">{e.ollama.host || '—'}</div>
            {ship?.enabled && (
              <div className={`text-[11px] rounded px-2 py-1 border ${ship.status === 'up' ? 'border-emerald-600/40 bg-emerald-950/20 text-emerald-300' : 'border-amber-600/40 bg-amber-950/20 text-amber-300'}`}>
                🛰️ Tunel SSH ({ship.target}): <strong>{ship.status.toUpperCase()}</strong>
                {ship.error ? ` — ${ship.error}` : ''}
              </div>
            )}
            <div className="text-[11px] text-slate-400">
              Dostępne modele: <span className="text-slate-200 font-semibold">{e.ollama.models.length}</span>
              {e.ollama.busy ? ' · zajęta (generuje)' : ''}
            </div>
            <ul className="max-h-40 overflow-y-auto space-y-0.5">
              {e.ollama.models.length === 0 && <li className="text-[11px] text-slate-500">Brak pobranych modeli (lub Ollama nieosiągalna).</li>}
              {e.ollama.models.map((m) => (
                <li key={m.name} className="text-[11px] text-slate-300 flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${e.ollama.loadedModels.includes(m.name) ? 'bg-emerald-400' : 'bg-slate-600'}`} title={e.ollama.loadedModels.includes(m.name) ? 'Załadowany do pamięci' : 'Na dysku'} />
                  <span className="font-mono truncate">{m.name}</span>
                  {m.parameterSize && <span className="text-slate-500">· {m.parameterSize}</span>}
                  {m.vision && <span className="text-violet-400">· vision</span>}
                  <span className="ml-auto text-slate-600">{fmtSize(m.size)}</span>
                </li>
              ))}
            </ul>
            <div className="text-[10px] text-slate-500">
              Preferowany: <span className="font-mono text-slate-300">{e.ollama.preferredModel}</span>
            </div>
            <div className="rounded border border-violet-500/30 bg-violet-950/15 px-2.5 py-1.5 space-y-1">
              <div className="flex items-center justify-between text-[11px] text-violet-200 font-semibold">
                <span>👁️ Llama 3.2 Vision ({e.ollama.visionModel || 'llama3.2-vision:11b'})</span>
                <span className="text-[10px] font-mono text-violet-300">
                  {e.ollama.models.some((m) => m.name.startsWith('llama3.2-vision')) ? 'ZAINSTALOWANY' : 'SKONFIGUROWANY'}
                </span>
              </div>
              <div className="text-[10px] text-slate-400 font-mono">
                ctx={e.ollama.visionConfig?.numCtx ?? 4096} · predict={e.ollama.visionConfig?.numPredict ?? 1024} · temp={e.ollama.visionConfig?.temperature ?? 0.2} · keep_alive={String(e.ollama.visionConfig?.keepAlive ?? -1)}
              </div>
              {!e.ollama.models.some((m) => m.name.startsWith('llama3.2-vision')) && (
                <div className="pt-0.5 flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void pullLlamaVision('llama3.2-vision:11b')}
                    disabled={pullingVision}
                    className="inline-flex items-center gap-1 rounded border border-violet-500/50 bg-violet-600/25 px-2 py-0.5 text-[10px] font-semibold text-violet-100 hover:bg-violet-600/40 disabled:opacity-50"
                  >
                    <DownloadCloud className="w-3 h-3" /> Pobierz llama3.2-vision:11b
                  </button>
                </div>
              )}
              {visionPullMsg && <div className="text-[10px] text-violet-300">{visionPullMsg}</div>}
            </div>
            {ship?.enabled && shipModels && (() => {
              const installedSet = new Set(shipModels.installed.map((m) => m.name.toLowerCase()));
              const has = (m: string) => installedSet.has(m.toLowerCase()) || installedSet.has(`${m.toLowerCase()}:latest`);
              const pullOf = (m: string) => shipModels.pull.models.find((x) => x.model.toLowerCase() === m.toLowerCase());
              const present = shipModels.targetModels.filter(has).length;
              return (
                <div className="pt-1 border-t border-slate-800 space-y-1">
                  <div className="text-[10px] text-slate-300 font-semibold">
                    Modele UNCENSORED (GPU) na statku: {present}/{shipModels.targetModels.length}
                    {shipModels.pull.running && <span className="text-violet-300"> · pobieranie…</span>}
                    {!shipModels.reachable && <span className="text-amber-400"> · statek nieosiągalny</span>}
                  </div>
                  {/* Zawsze pełna lista modeli docelowych z ich statusem. */}
                  <ul className="space-y-0.5">
                    {shipModels.targetModels.map((m) => {
                      const pj = pullOf(m);
                      const onShip = has(m);
                      const status = onShip ? 'done' : pj ? pj.status : 'missing';
                      const icon = status === 'done' ? '✅' : status === 'pulling' ? '⏬' : status === 'error' ? '❌' : status === 'pending' ? '⏳' : '⬇️';
                      const note = onShip ? 'na statku' : pj ? pj.detail : 'brak — do pobrania';
                      return (
                        <li key={m} className="text-[10px] font-mono truncate text-slate-300" title={note}>
                          {icon} {m} <span className="text-slate-500">— {note}</span>
                        </li>
                      );
                    })}
                  </ul>
                  {!shipModels.pull.running && shipModels.reachable && shipModels.missingModels.length > 0 && (
                    <button
                      type="button"
                      onClick={() => void pullUncensored()}
                      disabled={pulling}
                      className="inline-flex items-center gap-1.5 rounded-md border border-violet-600 bg-violet-600/20 px-2.5 py-1 text-[11px] font-semibold text-violet-200 hover:bg-violet-600/35 disabled:opacity-50"
                    >
                      <DownloadCloud className="w-3.5 h-3.5" /> Pobierz {shipModels.missingModels.length} brakujących (GPU)
                    </button>
                  )}
                  {!shipModels.pull.running && shipModels.reachable && shipModels.missingModels.length === 0 && (
                    <div className="text-[10px] text-emerald-400">✅ Wszystkie modele uncensored są na statku.</div>
                  )}
                </div>
              );
            })()}
          </div>

          {/* Gemini */}
          <div className="rounded-lg border border-slate-800 bg-[#0d1017] p-3 space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-200">
              <Sparkles className="w-3.5 h-3.5 text-amber-400" /> Gemini (jawny silnik)
              <span className="ml-auto"><Dot ok={e.gemini.configured} /></span>
            </div>
            <div className="text-[11px] text-slate-400">
              {e.gemini.configured ? <>Dostępne modele: <span className="text-slate-200 font-semibold">{e.gemini.modelCount}</span></> : 'Brak klucza GEMINI_API_KEY'}
            </div>
            {e.gemini.forcedModel && <div className="text-[10px] text-slate-500">Wymuszony: <span className="font-mono">{e.gemini.forcedModel}</span></div>}
            <ul className="max-h-40 overflow-y-auto space-y-0.5">
              {e.gemini.models.slice(0, 20).map((m) => (
                <li key={m} className="text-[11px] text-slate-300 font-mono truncate">{m}</li>
              ))}
              {e.gemini.configured && e.gemini.models.length === 0 && <li className="text-[11px] text-slate-500">Lista modeli jeszcze nie pobrana.</li>}
            </ul>
          </div>

          {/* Silnik obrazu */}
          <div className="rounded-lg border border-slate-800 bg-[#0d1017] p-3 space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-200">
              <ImageIcon className="w-3.5 h-3.5 text-sky-400" /> Silnik obrazu
              {e.image.available !== null && <span className="ml-auto"><Dot ok={e.image.available} /></span>}
            </div>
            <div className="text-[11px] text-slate-400">Silnik: <span className="font-mono text-slate-200">{e.image.engine}</span></div>
            {e.image.detail && <div className="text-[11px] text-slate-500">{e.image.detail}</div>}
            <div className="text-[10px] text-slate-500 pt-1">
              Zasoby hosta: RAM {e.ollama.ramAvailableMb ? `${Math.round(e.ollama.ramAvailableMb)} MB` : '—'} · dysk {e.ollama.diskFreeGb ? `${e.ollama.diskFreeGb.toFixed(1)} GB` : '—'}
            </div>
          </div>
        </div>
      )}
      {state && <p className="text-[10px] text-slate-600">Odświeżono: {new Date(state.checkedAt).toLocaleTimeString('pl-PL')}</p>}
    </div>
  );
};
