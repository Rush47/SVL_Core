import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Cpu, Satellite, Sparkles, Image as ImageIcon, RefreshCw, CheckCircle2, XCircle, DownloadCloud } from 'lucide-react';
import { safeFetchJson, getSvlOperatorAccessToken, hasSvlOperatorAccessToken } from '../utils/svlLogic';

interface OllamaModel { name: string; size: number | null; parameterSize: string | null; vision: boolean; endpointId?: string; endpointLabel?: string }
interface OllamaEndpointInfo {
  id: 'local' | 'ship' | 'secondary';
  label: string;
  source: string;
  host: string;
  enabled: boolean;
  explicit: boolean;
  reachable: boolean;
  version: string | null;
  models: OllamaModel[];
  loadedModels: string[];
  error: string | null;
}
interface ShipTunnel { enabled: boolean; status: string; target: string; shipPort?: number; localUrl: string; description: string; error: string | null }
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
      endpoints?: OllamaEndpointInfo[];
      explicitFallbackToGemini?: boolean;
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
    gemini: {
      configured: boolean;
      models: string[];
      modelCount: number;
      forcedModel: string | null;
      tier?: string;
      allServicesEnabled?: boolean;
      services?: string[];
    };
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
  const [tunnelTarget, setTunnelTarget] = useState('Ship');
  const [tunnelLocalPort, setTunnelLocalPort] = useState('11435');
  const [tunnelShipPort, setTunnelShipPort] = useState('11434');
  const [shipDirectUrl, setShipDirectUrl] = useState('');
  const [tunnelSaving, setTunnelSaving] = useState(false);
  const [tunnelMsg, setTunnelMsg] = useState<string | null>(null);
  const [creatingApex, setCreatingApex] = useState(false);
  const [apexMsg, setApexMsg] = useState<string | null>(null);
  const [geminiApiKeyInput, setGeminiApiKeyInput] = useState('');
  const [geminiSaving, setGeminiSaving] = useState(false);
  const [geminiMsg, setGeminiMsg] = useState<string | null>(null);

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

  const applyShipTunnel = async (enabled: boolean) => {
    setTunnelSaving(true);
    setTunnelMsg(null);
    const res = await safeFetchJson<any>('/api/svl364/ollama-tunnel', {
      method: 'POST',
      timeoutMs: 12000,
      body: JSON.stringify({
        enabled,
        target: tunnelTarget.trim() || 'Ship',
        shipPort: Number(tunnelShipPort) || 11434,
        localPort: Number(tunnelLocalPort) || 11435,
        ...(shipDirectUrl.trim() ? { shipUrl: shipDirectUrl.trim() } : { shipUrl: '' }),
      }),
    });
    if (res.ok && res.data?.ok) {
      setTunnelMsg(res.data.note || (enabled ? 'Tunel SSH Ollamy włączony.' : 'Tunel SSH Ollamy wyłączony.'));
      await refresh();
      await refreshShip();
    } else {
      setTunnelMsg(res.data?.error || res.error || 'Nie udało się zmienić konfiguracji tunelu SSH.');
    }
    setTunnelSaving(false);
  };

  const buildApexUncensored = async () => {
    setCreatingApex(true);
    setApexMsg('Budowanie svl364-apex-uncensored:latest na aktywnym węźle Ollama…');
    const res = await safeFetchJson<any>('/api/ollama/create-apex', {
      method: 'POST',
      timeoutMs: 125000,
      body: JSON.stringify({ target: 'auto' }),
    });
    if (res.ok && res.data?.ok) {
      setApexMsg(`Zbudowano ${res.data.model} (baza: ${res.data.baseModel}) na ${res.data.endpointLabel} (${res.data.host}).`);
      await refresh();
      await refreshShip();
    } else {
      setApexMsg(res.data?.error || res.error || 'Nie udało się zbudować svl364-apex-uncensored:latest.');
    }
    setCreatingApex(false);
  };

  const configureGeminiKey = async () => {
    const clean = geminiApiKeyInput.trim();
    if (!clean) {
      setGeminiMsg('Wklej klucz GEMINI_API_KEY z Google AI Studio (np. AIza...).');
      return;
    }
    setGeminiSaving(true);
    setGeminiMsg('Weryfikacja klucza Google API i aktywacja najlepszego modelu Pro oraz usług…');
    const res = await safeFetchJson<any>('/api/gemini/configure', {
      method: 'POST',
      timeoutMs: 20000,
      body: JSON.stringify({ apiKey: clean, tier: 'paid_pro' }),
    });
    if (res.ok && res.data?.ok) {
      setGeminiApiKeyInput('');
      setGeminiMsg(
        `✅ Aktywowano! Główny model: ${res.data.primaryModel} · Modele: ${res.data.modelCount} · Pełny pakiet usług Google aktywny.`,
      );
      await refresh();
    } else {
      setGeminiMsg(`❌ ${res.data?.error || res.error || 'Błąd weryfikacji klucza Google Gemini API.'}`);
    }
    setGeminiSaving(false);
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
  const endpoints = e?.ollama.endpoints || [];
  const hasApexInstalled = Boolean(e?.ollama.models.some((m) => m.name === 'svl364-apex-uncensored:latest'));

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
        <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {/* Ollama (lokalna + druga Ollama ze statku SVL-364 przez SSH/URL) */}
          <div className="rounded-lg border border-slate-800 bg-[#0d1017] p-3 space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-200">
              {ship?.enabled ? <Satellite className="w-3.5 h-3.5 text-violet-400" /> : <Cpu className="w-3.5 h-3.5 text-cyan-400" />}
              Ollama — {e.ollama.source}
              <span className="ml-auto"><Dot ok={e.ollama.reachable} /></span>
            </div>
            <div className="text-[10px] rounded px-2 py-0.5 border border-cyan-500/30 bg-cyan-950/20 text-cyan-200">
              {e.ollama.explicitFallbackToGemini
                ? '⚠️ Jawne modele Ollama: fallback do Gemini włączony (env)'
                : '🔒 STRICT OLLAMA: wybrany model Ollama nie podmienia się na Gemini'}
            </div>

            {/* Lista wszystkich węzłów Ollama (Lokalna + SVL-364 SSH) */}
            {endpoints.length > 0 ? (
              <div className="space-y-1">
                {endpoints.map((ep) => (
                  <div
                    key={`${ep.id}-${ep.host}`}
                    className={`rounded border px-2 py-1 text-[10px] ${
                      ep.reachable
                        ? 'border-emerald-600/35 bg-emerald-950/15 text-emerald-200'
                        : 'border-slate-800 bg-slate-900/40 text-slate-400'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 font-semibold">
                      <Dot ok={ep.reachable} />
                      <span>{ep.label}</span>
                      <span className="ml-auto font-mono text-[9px] text-slate-400">
                        {ep.reachable ? `v${ep.version || '?'} · ${ep.models.length} mod.` : 'offline'}
                      </span>
                    </div>
                    <div className="font-mono text-[9px] text-slate-500 break-all">{ep.host}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[11px] text-slate-500 font-mono break-all">{e.ollama.host || '—'}</div>
            )}

            {ship?.enabled && (
              <div className={`text-[11px] rounded px-2 py-1 border ${ship.status === 'up' ? 'border-emerald-600/40 bg-emerald-950/20 text-emerald-300' : 'border-amber-600/40 bg-amber-950/20 text-amber-300'}`}>
                🛰️ Tunel SSH ({ship.target}): <strong>{ship.status.toUpperCase()}</strong> ({ship.localUrl})
                {ship.error ? ` — ${ship.error}` : ''}
              </div>
            )}

            <div className="text-[11px] text-slate-400">
              Dostępne modele (łącznie): <span className="text-slate-200 font-semibold">{e.ollama.models.length}</span>
              {e.ollama.busy ? ' · zajęta (generuje)' : ''}
            </div>
            <ul className="max-h-40 overflow-y-auto space-y-0.5">
              {e.ollama.models.length === 0 && <li className="text-[11px] text-slate-500">Brak pobranych modeli (lub żaden węzeł Ollama nieosiągalny).</li>}
              {e.ollama.models.map((m) => (
                <li key={`${m.endpointId || 'local'}:${m.name}`} className="text-[11px] text-slate-300 flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${e.ollama.loadedModels.includes(m.name) ? 'bg-emerald-400' : 'bg-slate-600'}`} title={e.ollama.loadedModels.includes(m.name) ? 'Załadowany do pamięci' : 'Na dysku'} />
                  <span className="font-mono truncate">{m.name}</span>
                  {m.endpointId && (
                    <span className={`text-[9px] px-1 rounded ${m.endpointId === 'ship' ? 'bg-violet-950/70 text-violet-300' : 'bg-slate-800 text-slate-400'}`}>
                      {m.endpointId === 'ship' ? 'SVL-364' : 'Lokalna'}
                    </span>
                  )}
                  {m.parameterSize && <span className="text-slate-500">· {m.parameterSize}</span>}
                  {m.vision && <span className="text-violet-400">· vision</span>}
                  <span className="ml-auto text-slate-600">{fmtSize(m.size)}</span>
                </li>
              ))}
            </ul>
            <div className="text-[10px] text-slate-500 flex items-center justify-between gap-1">
              <span>Preferowany: <span className="font-mono text-slate-300">{e.ollama.preferredModel}</span></span>
              {!hasApexInstalled && e.ollama.models.length > 0 && (
                <button
                  type="button"
                  onClick={() => void buildApexUncensored()}
                  disabled={creatingApex}
                  className="rounded border border-cyan-500/40 bg-cyan-600/20 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-200 hover:bg-cyan-600/35 disabled:opacity-50"
                >
                  {creatingApex ? 'Buduję…' : 'Zbuduj Apex'}
                </button>
              )}
            </div>
            {apexMsg && <div className="text-[10px] text-cyan-300">{apexMsg}</div>}

            {/* Konfigurator drugiej Ollamy (Tunel SSH SVL-364 / URL) */}
            <div className="rounded border border-slate-800 bg-slate-950/40 p-2 space-y-1.5">
              <div className="text-[10px] font-semibold text-slate-300 flex items-center justify-between">
                <span>🛰️ Druga Ollama (SVL-364 SSH / Zdalna)</span>
                <span className="text-[9px] text-slate-500">port 11435 = brak kolizji z 11434</span>
              </div>
              <div className="grid grid-cols-3 gap-1">
                <input
                  type="text"
                  value={tunnelTarget}
                  onChange={(ev) => setTunnelTarget(ev.target.value)}
                  placeholder="Alias SSH (Ship)"
                  className="rounded border border-slate-700 bg-[#0b0e16] px-1.5 py-0.5 text-[10px] text-slate-200 font-mono"
                />
                <input
                  type="number"
                  value={tunnelLocalPort}
                  onChange={(ev) => setTunnelLocalPort(ev.target.value)}
                  placeholder="Port lok. 11435"
                  title="Lokalny port tunelu (11435 pozwala na pracę równolegle z lokalną Ollamą na 11434)"
                  className="rounded border border-slate-700 bg-[#0b0e16] px-1.5 py-0.5 text-[10px] text-slate-200 font-mono"
                />
                <input
                  type="number"
                  value={tunnelShipPort}
                  onChange={(ev) => setTunnelShipPort(ev.target.value)}
                  placeholder="Port statku 11434"
                  title="Port Ollamy na statku SVL-364"
                  className="rounded border border-slate-700 bg-[#0b0e16] px-1.5 py-0.5 text-[10px] text-slate-200 font-mono"
                />
              </div>
              <input
                type="text"
                value={shipDirectUrl}
                onChange={(ev) => setShipDirectUrl(ev.target.value)}
                placeholder="Opcjonalny bezpośredni URL (np. http://10.0.0.5:11434)"
                className="w-full rounded border border-slate-700 bg-[#0b0e16] px-1.5 py-0.5 text-[10px] text-slate-200 font-mono"
              />
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void applyShipTunnel(true)}
                  disabled={tunnelSaving}
                  className="rounded border border-violet-500/50 bg-violet-600/25 px-2 py-0.5 text-[10px] font-semibold text-violet-100 hover:bg-violet-600/40 disabled:opacity-50"
                >
                  {tunnelSaving ? 'Zapisuję…' : 'Połącz tunel SSH'}
                </button>
                {ship?.enabled && (
                  <button
                    type="button"
                    onClick={() => void applyShipTunnel(false)}
                    disabled={tunnelSaving}
                    className="rounded border border-slate-700 bg-slate-800/60 px-2 py-0.5 text-[10px] text-slate-300 hover:bg-slate-700/60 disabled:opacity-50"
                  >
                    Wyłącz tunel
                  </button>
                )}
              </div>
              {tunnelMsg && <div className="text-[10px] text-violet-300">{tunnelMsg}</div>}
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
              <Sparkles className="w-3.5 h-3.5 text-amber-400" /> Gemini Pro &amp; Usługi Google
              <span className="ml-auto"><Dot ok={e.gemini.configured} /></span>
            </div>
            <div className="text-[11px] text-slate-400">
              {e.gemini.configured ? (
                <>Dostępne modele: <span className="text-slate-200 font-semibold">{e.gemini.modelCount}</span> · Tryb: <span className="text-amber-300 font-semibold uppercase">{e.gemini.tier || 'paid_pro'}</span></>
              ) : (
                'Oczekuje na klucz GEMINI_API_KEY (profil Pro + wszystkie usługi gotowy)'
              )}
            </div>
            {e.gemini.forcedModel && (
              <div className="text-[10px] text-emerald-400">
                Główny model: <span className="font-mono font-semibold">{e.gemini.forcedModel}</span>
              </div>
            )}
            <div className="flex flex-wrap gap-1 pt-0.5">
              {(e.gemini.services || ['Search Grounding', 'URL Context', 'Code Exec', 'Vision/Audio', 'MCP']).map((svc) => (
                <span key={svc} className="rounded border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 text-[9px] text-amber-200">
                  {svc}
                </span>
              ))}
            </div>
            <div className="space-y-1.5 pt-1 border-t border-slate-800/80">
              <div className="flex gap-1.5">
                <a
                  href="https://aistudio.google.com/app/apikey"
                  target="_blank"
                  rel="noreferrer"
                  className="rounded border border-amber-500/40 bg-amber-500/15 px-2 py-1 text-[10px] font-semibold text-amber-200 hover:bg-amber-500/25"
                >
                  🔑 Pobierz klucz AI Studio
                </a>
                <a
                  href="https://console.cloud.google.com/billing"
                  target="_blank"
                  rel="noreferrer"
                  className="rounded border border-sky-500/40 bg-sky-500/15 px-2 py-1 text-[10px] font-semibold text-sky-200 hover:bg-sky-500/25"
                >
                  💳 Doładuj Billing ($1000)
                </a>
              </div>
              <div className="flex gap-1.5">
                <input
                  type="password"
                  value={geminiApiKeyInput}
                  onChange={(ev) => setGeminiApiKeyInput(ev.target.value)}
                  placeholder="Wklej GEMINI_API_KEY (AIza...)"
                  className="flex-1 min-w-0 rounded border border-slate-700 bg-slate-900/90 px-2 py-1 text-[11px] text-slate-200 font-mono placeholder:text-slate-500 focus:border-amber-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => void configureGeminiKey()}
                  disabled={geminiSaving}
                  className="rounded border border-emerald-500/50 bg-emerald-600/25 px-2.5 py-1 text-[10px] font-semibold text-emerald-200 hover:bg-emerald-600/40 disabled:opacity-50 whitespace-nowrap"
                >
                  {geminiSaving ? 'Aktywacja…' : 'Aktywuj Pro'}
                </button>
              </div>
              {geminiMsg && <div className="text-[10px] text-slate-300 leading-snug">{geminiMsg}</div>}
            </div>
            <ul className="max-h-32 overflow-y-auto space-y-0.5">
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
