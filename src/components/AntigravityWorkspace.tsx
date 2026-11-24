import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cpu,
  Globe,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  Terminal,
  Wrench,
  XCircle,
} from 'lucide-react';
import { safeFetchJson } from '../utils/svlLogic';

type EngineMode = 'gemini-interactions' | 'ollama';

interface ProofStep {
  id: string;
  type:
    | 'thought'
    | 'google_search'
    | 'url_context'
    | 'function_call'
    | 'function_result'
    | 'code_execution'
    | 'model_output';
  title: string;
  detail: string;
  status: 'ok' | 'error';
}

interface AntigravityStatus {
  ok: boolean;
  mode: string;
  requiresPaidKey: boolean;
  gemini: {
    configured: boolean;
    models: string[];
    defaultModel: string;
  };
  ollama: {
    host: string;
    reachable: boolean;
    defaultModel: string;
    models: string[];
  };
  tools: string[];
  recentRunsCount: number;
  checkedAt: string;
}

interface TurnEntry {
  id: string;
  prompt: string;
  engine: EngineMode;
  model: string;
  ok: boolean;
  outputText: string;
  error?: string;
  steps: ProofStep[];
  interactionId: string | null;
  durationMs: number;
  totalTokens?: number;
  createdAt: string;
}

const QUICK_TASKS = [
  'Sprawdź stan systemu Linux Debian 13, wersję jądra i wolne miejsce na dysku.',
  'Wylistuj katalog główny projektu i sprawdź skrypty w package.json.',
  'Wyszukaj w Google najnowsze wydania Node.js LTS i Pythona oraz podaj ich wersje.',
];

export const AntigravityWorkspace: React.FC = () => {
  const [status, setStatus] = useState<AntigravityStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [engine, setEngine] = useState<EngineMode>('gemini-interactions');
  const [model, setModel] = useState<string>('gemini-4-hydrogen');
  const [thinkingLevel, setThinkingLevel] = useState<'low' | 'medium' | 'high'>('medium');
  const [googleSearch, setGoogleSearch] = useState(true);
  const [urlContext, setUrlContext] = useState(false);
  const [workspaceTools, setWorkspaceTools] = useState(true);
  const [prompt, setPrompt] = useState('');
  const [running, setRunning] = useState(false);
  const [interactionId, setInteractionId] = useState<string | null>(null);
  const [turns, setTurns] = useState<TurnEntry[]>([]);
  const [expandedTurns, setExpandedTurns] = useState<Record<string, boolean>>({});
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const loadStatus = useCallback(async () => {
    const res = await safeFetchJson<AntigravityStatus>('/api/antigravity/status', { timeoutMs: 10000 });
    if (res.ok && res.data?.ok) {
      setStatus(res.data);
      setStatusError(null);
      if (!res.data.gemini.configured && res.data.ollama.reachable) {
        setEngine('ollama');
        setModel(res.data.ollama.defaultModel || 'llama3.2-vision:11b');
      }
    } else {
      setStatusError(res.data?.mode || res.error || 'Nie udało się pobrać statusu integracji Antigravity.');
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [turns, running]);

  const handleEngineChange = (nextEngine: EngineMode) => {
    setEngine(nextEngine);
    if (nextEngine === 'gemini-interactions') {
      setModel(status?.gemini.defaultModel || 'gemini-4-hydrogen');
    } else {
      setModel(status?.ollama.models[0] || status?.ollama.defaultModel || 'llama3.2-vision:11b');
    }
  };

  const handleResetSession = () => {
    setInteractionId(null);
    setTurns([]);
    setExpandedTurns({});
  };

  const handleSubmit = async (customPrompt?: string) => {
    const text = String(customPrompt ?? prompt).trim();
    if (!text || running) return;
    if (!customPrompt) setPrompt('');
    setRunning(true);

    const history = turns
      .filter((t) => t.ok && t.outputText)
      .slice(-6)
      .flatMap((t) => [
        { role: 'user' as const, content: t.prompt },
        { role: 'assistant' as const, content: t.outputText },
      ]);

    const res = await safeFetchJson<{
      ok: boolean;
      engine: EngineMode;
      model: string;
      interactionId: string | null;
      outputText: string;
      steps: ProofStep[];
      usage?: { totalTokens?: number };
      durationMs: number;
      error?: string;
    }>('/api/antigravity/run', {
      method: 'POST',
      timeoutMs: 120_000,
      body: JSON.stringify({
        prompt: text,
        engine,
        model,
        previousInteractionId: engine === 'gemini-interactions' ? interactionId : null,
        thinkingLevel,
        tools: {
          googleSearch,
          urlContext,
          workspaceTools,
        },
        history,
      }),
    });

    const data = res.data;
    const turnId = `turn-${Date.now().toString(36)}`;
    const entry: TurnEntry = {
      id: turnId,
      prompt: text,
      engine: data?.engine || engine,
      model: data?.model || model,
      ok: Boolean(res.ok && data?.ok),
      outputText: data?.outputText || '',
      error: !res.ok || !data?.ok ? data?.error || res.error || `HTTP ${res.status}` : undefined,
      steps: Array.isArray(data?.steps) ? data.steps : [],
      interactionId: data?.interactionId || null,
      durationMs: Number(data?.durationMs || 0),
      totalTokens: data?.usage?.totalTokens,
      createdAt: new Date().toISOString(),
    };

    if (entry.interactionId && engine === 'gemini-interactions') {
      setInteractionId(entry.interactionId);
    }
    setTurns((prev) => [...prev, entry]);
    if (entry.steps.length > 0) {
      setExpandedTurns((prev) => ({ ...prev, [turnId]: true }));
    }
    setRunning(false);
    void loadStatus();
  };

  const renderStepIcon = (step: ProofStep) => {
    if (step.status === 'error') return <XCircle className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" />;
    switch (step.type) {
      case 'thought':
        return <Sparkles className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />;
      case 'google_search':
        return <Search className="w-3.5 h-3.5 text-sky-400 shrink-0 mt-0.5" />;
      case 'url_context':
        return <Globe className="w-3.5 h-3.5 text-indigo-400 shrink-0 mt-0.5" />;
      case 'function_call':
        return <Wrench className="w-3.5 h-3.5 text-cyan-400 shrink-0 mt-0.5" />;
      case 'function_result':
      case 'code_execution':
        return <Terminal className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />;
      default:
        return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />;
    }
  };

  const geminiModels = status?.gemini.models?.length ? status.gemini.models : ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'];
  const ollamaModels = status?.ollama.models?.length
    ? status.ollama.models
    : [status?.ollama.defaultModel || 'llama3.2-vision:11b'];

  return (
    <div className="h-full w-full flex flex-col bg-[#0B0D13] text-slate-100 overflow-hidden">
      {/* Top Toolbar */}
      <div className="shrink-0 border-b border-slate-800 bg-[#111520] px-4 py-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Bot className="w-5 h-5 text-cyan-400 shrink-0" />
          <h1 className="text-sm font-semibold text-slate-100 truncate">Antigravity · Tryb bez płatnego klucza</h1>
        </div>

        <div className="flex flex-wrap items-center gap-2 ml-auto">
          <label className="flex items-center gap-1.5 text-xs text-slate-300">
            <span>Silnik</span>
            <select
              aria-label="Silnik Antigravity"
              value={engine}
              onChange={(e) => handleEngineChange(e.target.value as EngineMode)}
              className="rounded-md border border-slate-700 bg-[#0B0D13] px-2 py-1 text-xs text-slate-100 focus:outline-none focus:border-cyan-500"
            >
              <option value="gemini-interactions">Gemini Interactions API (darmowy)</option>
              <option value="ollama">Ollama (lokalny / SVL-364)</option>
            </select>
          </label>

          <label className="flex items-center gap-1.5 text-xs text-slate-300">
            <span>Model</span>
            <select
              aria-label="Model Antigravity"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="rounded-md border border-slate-700 bg-[#0B0D13] px-2 py-1 text-xs font-mono text-slate-100 focus:outline-none focus:border-cyan-500"
            >
              {(engine === 'gemini-interactions' ? geminiModels : ollamaModels).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>

          {engine === 'gemini-interactions' && model === 'gemini-4-hydrogen' && (
            <label className="flex items-center gap-1.5 text-xs text-slate-300">
              <span>Rozumowanie</span>
              <select
                aria-label="Poziom rozumowania"
                value={thinkingLevel}
                onChange={(e) => setThinkingLevel(e.target.value as 'low' | 'medium' | 'high')}
                className="rounded-md border border-slate-700 bg-[#0B0D13] px-2 py-1 text-xs text-slate-100 focus:outline-none focus:border-cyan-500"
              >
                <option value="low">Szybkie</option>
                <option value="medium">Zrównoważone</option>
                <option value="high">Głębokie</option>
              </select>
            </label>
          )}

          <button
            type="button"
            onClick={() => void loadStatus()}
            aria-label="Odśwież status Antigravity"
            className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-[#0B0D13] px-2.5 py-1 text-xs text-slate-300 hover:border-slate-500 hover:text-white"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Odśwież
          </button>

          <button
            type="button"
            onClick={handleResetSession}
            className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-[#0B0D13] px-2.5 py-1 text-xs text-slate-300 hover:border-slate-500 hover:text-white"
          >
            <RotateCcw className="w-3.5 h-3.5" /> Nowa sesja
          </button>
        </div>
      </div>

      {/* Live Engine Status & Tool Controls */}
      <div className="shrink-0 border-b border-slate-800/80 bg-[#0E121B] px-4 py-2 flex flex-wrap items-center gap-4 text-xs">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 text-slate-300">
            {status?.gemini.configured ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <XCircle className="w-3.5 h-3.5 text-amber-400" />
            )}
            Gemini Free API: <strong className="font-mono text-slate-100">{status?.gemini.configured ? 'AKTYWNY' : 'BRAK KLUCZA'}</strong>
          </span>
          <span className="inline-flex items-center gap-1.5 text-slate-300">
            {status?.ollama.reachable ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <XCircle className="w-3.5 h-3.5 text-slate-500" />
            )}
            Ollama: <strong className="font-mono text-slate-100">{status?.ollama.reachable ? status.ollama.host : 'OFFLINE'}</strong>
          </span>
          {interactionId && (
            <span className="font-mono text-[11px] text-cyan-300">
              Sesja: {interactionId.slice(0, 14)}…
            </span>
          )}
        </div>

        {engine === 'gemini-interactions' && (
          <div className="flex flex-wrap items-center gap-3 ml-auto">
            <label className="inline-flex items-center gap-1.5 cursor-pointer text-slate-300">
              <input
                type="checkbox"
                checked={workspaceTools}
                onChange={(e) => setWorkspaceTools(e.target.checked)}
                className="accent-cyan-500"
              />
              <span>Linux & Pliki (jyn_root)</span>
            </label>
            <label className="inline-flex items-center gap-1.5 cursor-pointer text-slate-300">
              <input
                type="checkbox"
                checked={googleSearch}
                onChange={(e) => setGoogleSearch(e.target.checked)}
                className="accent-cyan-500"
              />
              <span>Google Search</span>
            </label>
            <label className="inline-flex items-center gap-1.5 cursor-pointer text-slate-300">
              <input
                type="checkbox"
                checked={urlContext}
                onChange={(e) => setUrlContext(e.target.checked)}
                className="accent-cyan-500"
              />
              <span>Kontekst URL</span>
            </label>
          </div>
        )}
      </div>

      {statusError && (
        <div className="mx-4 mt-3 rounded-lg border border-rose-700/60 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">
          {statusError}
        </div>
      )}

      {/* Main Agent Timeline / Output Viewport */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4">
        {turns.length === 0 && !running && (
          <div className="max-w-3xl mx-auto py-8 space-y-4">
            <div className="flex items-center gap-2 text-slate-300 text-sm font-medium">
              <Cpu className="w-4 h-4 text-cyan-400" />
              <span>Wybierz szybkie zadanie lub wpisz własne polecenie poniżej</span>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              {QUICK_TASKS.map((task) => (
                <button
                  key={task}
                  type="button"
                  onClick={() => void handleSubmit(task)}
                  className="text-left rounded-lg border border-slate-800 bg-[#111520] hover:border-cyan-500/60 hover:bg-[#151b2b] p-3 text-xs text-slate-200 transition-colors"
                >
                  {task}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="max-w-4xl mx-auto space-y-4">
          {turns.map((turn) => {
            const isExpanded = Boolean(expandedTurns[turn.id]);
            return (
              <section key={turn.id} className="rounded-xl border border-slate-800 bg-[#111520] overflow-hidden">
                {/* Operator Prompt */}
                <div className="border-b border-slate-800/80 bg-[#151a28] px-4 py-2.5 flex items-start justify-between gap-3">
                  <div className="text-xs text-slate-100 whitespace-pre-wrap">{turn.prompt}</div>
                  <div className="shrink-0 text-[11px] font-mono text-slate-400">
                    {turn.model} · {(turn.durationMs / 1000).toFixed(1)}s
                    {typeof turn.totalTokens === 'number' ? ` · ${turn.totalTokens} tok` : ''}
                  </div>
                </div>

                {/* Proof of Work Steps */}
                {turn.steps.length > 0 && (
                  <div className="border-b border-slate-800/80 bg-[#0d111a]">
                    <button
                      type="button"
                      onClick={() => setExpandedTurns((prev) => ({ ...prev, [turn.id]: !prev[turn.id] }))}
                      aria-expanded={isExpanded}
                      className="w-full px-4 py-2 flex items-center gap-2 text-xs font-medium text-cyan-300 hover:bg-[#131926] text-left"
                    >
                      {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                      <span>Kroki wykonania ({turn.steps.length})</span>
                    </button>
                    {isExpanded && (
                      <ol className="px-4 pb-3 space-y-2">
                        {turn.steps.map((step) => (
                          <li
                            key={step.id}
                            className="rounded-lg border border-slate-800 bg-[#0B0D13] p-2.5 text-xs space-y-1"
                          >
                            <div className="flex items-start gap-2 font-medium text-slate-200">
                              {renderStepIcon(step)}
                              <span>{step.title}</span>
                            </div>
                            <pre className="text-[11px] font-mono text-slate-400 whitespace-pre-wrap break-words pl-5 max-h-48 overflow-y-auto">
                              {step.detail}
                            </pre>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                )}

                {/* Agent Final Output or Real Error */}
                <div className="px-4 py-3">
                  {turn.error ? (
                    <div className="rounded-lg border border-rose-700/60 bg-rose-950/30 px-3 py-2 text-xs text-rose-200 flex items-start gap-2">
                      <XCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                      <span>{turn.error}</span>
                    </div>
                  ) : (
                    <div className="text-sm text-slate-100 whitespace-pre-wrap leading-relaxed">{turn.outputText}</div>
                  )}
                </div>
              </section>
            );
          })}

          {running && (
            <div className="rounded-xl border border-cyan-700/50 bg-cyan-950/20 px-4 py-3 flex items-center gap-2.5 text-xs text-cyan-200">
              <Loader2 className="w-4 h-4 animate-spin text-cyan-400" />
              <span>Agent wykonuje zadanie ({model}) i zbiera wyniki narzędzi…</span>
            </div>
          )}
        </div>
      </div>

      {/* Prompt Composer */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleSubmit();
        }}
        className="shrink-0 border-t border-slate-800 bg-[#111520] px-4 py-3"
      >
        <div className="max-w-4xl mx-auto flex items-end gap-2">
          <div className="flex-1 min-w-0">
            <label htmlFor="antigravity-prompt-input" className="sr-only">
              Zadanie dla agenta Antigravity
            </label>
            <textarea
              id="antigravity-prompt-input"
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void handleSubmit();
                }
              }}
              placeholder="Opisz zadanie dla agenta (np. zbadaj logi, sprawdź pliki projektu, wyszukaj informacje w sieci)…"
              className="w-full resize-none rounded-lg border border-slate-700 bg-[#0B0D13] px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-cyan-500"
            />
          </div>
          <button
            type="submit"
            disabled={running || !prompt.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 px-4 py-2.5 text-xs font-semibold text-white transition-colors shrink-0"
          >
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            Uruchom agenta
          </button>
        </div>
      </form>
    </div>
  );
};
