import React, { useCallback, useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, GitBranch, Github, Link2, RefreshCw } from 'lucide-react';
import { safeFetchJson } from '../utils/svlLogic';
import { useSvlSync } from '../utils/svlSyncStore';

type SyncAction = 'status' | 'pull' | 'push' | 'sync' | 'init';

interface GitHubStatus {
  ok: boolean;
  repository: string;
  branch: string;
  ghCli: 'gh' | 'rest';
  autoSyncSec: number;
  lastAutoSync: { at: string; ok: boolean; summary: string } | null;
  token: {
    configured: boolean;
    kind?: string;
    valid?: boolean;
    login?: string | null;
    scopes?: string[];
    repositoryAccessible?: boolean;
    permissions?: { admin: boolean; push: boolean; pull: boolean };
    error?: string | null;
    warning?: string;
    message?: string;
  };
  sync: {
    ok: boolean;
    isRepo: boolean;
    head?: string;
    remoteHead?: string | null;
    localBranch?: string;
    ahead?: number;
    behind?: number;
    dirtyFiles?: string[];
    error?: string;
  };
  error?: string;
}

const ACTION_LABELS: Record<SyncAction, string> = {
  status: 'Sprawdzanie stanu',
  pull: 'Pobieranie z GitHuba',
  push: 'Wysyłanie na GitHub',
  sync: 'Synchronizacja obustronna',
  init: 'Łączenie katalogu z repozytorium',
};

/** Panel GitHub: token z .env, stan synchronizacji z Rush47/SVL_Core, akcje pobierz/wyślij/synchronizuj. */
export const GitHubPanel: React.FC = () => {
  const { serverRevision } = useSvlSync();
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [busy, setBusy] = useState<SyncAction | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async (fetchRemote = true) => {
    const res = await safeFetchJson<GitHubStatus>(`/api/github/status?fetch=${fetchRemote ? 1 : 0}`, { timeoutMs: 60000 });
    if (res.ok && res.data?.ok) setStatus(res.data);
    else setResult({ ok: false, text: res.data?.error || res.error || `HTTP ${res.status}` });
  }, []);

  useEffect(() => {
    void load(false).then(() => load(true));
  }, [load]);

  useEffect(() => {
    if (serverRevision > 0) {
      void load(false);
    }
  }, [serverRevision, load]);

  const run = async (action: SyncAction) => {
    setBusy(action);
    setResult(null);
    const res = await safeFetchJson<{ ok: boolean; summary?: string; error?: string }>('/api/github/sync', {
      method: 'POST',
      timeoutMs: 180000,
      body: JSON.stringify({ action }),
    });
    setResult({ ok: Boolean(res.data?.ok), text: res.data?.summary || res.data?.error || res.error || `HTTP ${res.status}` });
    setBusy(null);
    await load(false);
  };

  const token = status?.token;
  const sync = status?.sync;
  const dirty = sync?.dirtyFiles?.length || 0;

  return (
    <div className="p-5 rounded-xl bg-[#111520] border border-slate-800 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-100 inline-flex items-center gap-2">
          <Github className="w-4 h-4" aria-hidden="true" /> GitHub · {status?.repository || 'Rush47/SVL_Core'}
        </h2>
        <button
          type="button"
          onClick={() => void load(true)}
          className="text-[11px] text-slate-400 hover:text-slate-200 inline-flex items-center gap-1"
          aria-label="Odśwież stan GitHub"
        >
          <RefreshCw className="w-3 h-3" aria-hidden="true" /> Odśwież
        </button>
      </div>

      <div className="space-y-1.5 text-xs font-mono tabular-nums text-slate-300">
        <div className="flex justify-between gap-2 py-1 border-b border-slate-800/70">
          <span className="text-slate-400">Token (GITHUB_TOKEN):</span>
          <span className={token?.valid ? 'text-emerald-400' : 'text-amber-300'}>
            {!token
              ? '…'
              : !token.configured
                ? 'brak w .env'
                : token.valid
                  ? `${token.login} · ${token.kind === 'classic' ? 'classic' : token.kind}`
                  : 'nieprawidłowy'}
          </span>
        </div>
        {token?.valid && (
          <div className="flex justify-between gap-2 py-1 border-b border-slate-800/70">
            <span className="text-slate-400">Uprawnienia repo:</span>
            <span className={token.permissions?.admin ? 'text-emerald-400' : 'text-amber-300'}>
              {token.permissions?.admin ? 'admin' : token.permissions?.push ? 'zapis' : token.permissions?.pull ? 'odczyt' : 'brak dostępu'}
              {token.scopes && token.scopes.length > 0 ? ` · ${token.scopes.join(', ')}` : ''}
            </span>
          </div>
        )}
        <div className="flex justify-between gap-2 py-1 border-b border-slate-800/70">
          <span className="text-slate-400 inline-flex items-center gap-1"><GitBranch className="w-3 h-3" aria-hidden="true" /> Gałąź:</span>
          <span className="text-cyan-300">
            {status?.branch || 'main'}
            {sync?.isRepo ? ` · lokalnie ${sync.head || '?'} / GitHub ${sync.remoteHead || '—'}` : ''}
          </span>
        </div>
        {sync?.isRepo && (
          <div className="flex justify-between gap-2 py-1 border-b border-slate-800/70">
            <span className="text-slate-400">Różnice:</span>
            <span className={(sync.ahead || sync.behind || dirty) ? 'text-amber-300' : 'text-emerald-400'}>
              do wysłania {sync.ahead ?? 0} · do pobrania {sync.behind ?? 0} · niezapisanych {dirty}
            </span>
          </div>
        )}
        <div className="flex justify-between gap-2 py-1 border-b border-slate-800/70">
          <span className="text-slate-400">GitHub CLI / auto-sync:</span>
          <span className="text-slate-300">
            {status?.ghCli === 'gh' ? 'gh zainstalowane' : 'wbudowane (REST)'} ·{' '}
            {status?.autoSyncSec ? `co ${status.autoSyncSec} s` : 'auto-sync wyłączony'}
          </span>
        </div>
      </div>

      {token && !token.configured && (
        <div className="p-3 rounded-lg bg-amber-950/30 border border-amber-500/30 text-xs text-amber-100 space-y-1">
          <p>Wpisz klasyczny token GitHub w pliku <code>.env</code> na serwerze i uruchom aplikację ponownie:</p>
          <pre className="font-mono text-[11px] text-amber-200">GITHUB_TOKEN="ghp_…"</pre>
          <p>Zakresy tokenu: <code>repo</code>, <code>workflow</code> (opcjonalnie <code>admin:repo_hook</code>, <code>delete_repo</code>).</p>
        </div>
      )}
      {token?.configured && (token.error || token.warning) && (
        <div className="p-2.5 rounded-lg bg-amber-950/30 border border-amber-500/30 text-xs text-amber-100">
          {token.error || token.warning}
        </div>
      )}
      {sync && !sync.ok && sync.error && (
        <div className="p-2.5 rounded-lg bg-[#0B0D13] border border-slate-800 text-xs text-slate-300">{sync.error}</div>
      )}

      <div className="flex flex-wrap gap-2">
        {sync && !sync.isRepo ? (
          <button
            type="button"
            disabled={Boolean(busy) || !token?.valid}
            onClick={() => void run('init')}
            className="px-3 py-1.5 rounded-md bg-violet-600/80 hover:bg-violet-500 text-white text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <Link2 className="w-3.5 h-3.5" aria-hidden="true" /> Połącz katalog z repozytorium
          </button>
        ) : (
          <>
            <button
              type="button"
              disabled={Boolean(busy) || !token?.valid}
              onClick={() => void run('sync')}
              className="px-3 py-1.5 rounded-md bg-emerald-600/80 hover:bg-emerald-500 text-white text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /> Synchronizuj obustronnie
            </button>
            <button
              type="button"
              disabled={Boolean(busy) || !token?.valid}
              onClick={() => void run('pull')}
              className="px-3 py-1.5 rounded-md border border-slate-700 hover:bg-slate-800 text-slate-200 text-xs inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              <ArrowDownToLine className="w-3.5 h-3.5" aria-hidden="true" /> Pobierz
            </button>
            <button
              type="button"
              disabled={Boolean(busy) || !token?.valid}
              onClick={() => void run('push')}
              className="px-3 py-1.5 rounded-md border border-slate-700 hover:bg-slate-800 text-slate-200 text-xs inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              <ArrowUpFromLine className="w-3.5 h-3.5" aria-hidden="true" /> Wyślij
            </button>
          </>
        )}
      </div>

      {busy && <p className="text-xs text-slate-400" role="status">{ACTION_LABELS[busy]}…</p>}
      {result && (
        <div
          role={result.ok ? 'status' : 'alert'}
          className={`p-2.5 rounded-lg text-xs border ${result.ok ? 'border-emerald-500/30 bg-emerald-950/20 text-emerald-100' : 'border-rose-500/30 bg-rose-950/20 text-rose-100'}`}
        >
          {result.text}
        </div>
      )}
      <p className="text-[11px] text-slate-500">
        Bielik i Maya mogą zarządzać tym repozytorium z czatu (np. „pokaż otwarte PR na GitHubie”, „/gh issue list”).
        Operacje nieodwracalne wymagają Twojego potwierdzenia przyciskiem.
      </p>
    </div>
  );
};
