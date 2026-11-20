import React, { useCallback, useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, GitBranch, Link2, RefreshCw } from 'lucide-react';
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
const INITIAL_COREOS2_FILES: Array<{ name: string; path: string; size: number }> = [
  { name: 'README.md', path: 'SVL_CoreOS_2/README.md', size: 3250 },
  { name: 'ARCHITECTURE_DOCS.md', path: 'SVL_CoreOS_2/ARCHITECTURE_DOCS.md', size: 1816 },
  { name: 'build_manifest.json', path: 'SVL_CoreOS_2/build_manifest.json', size: 2450 },
  { name: 'svl_sentinel_daemon.py', path: 'SVL_CoreOS_2/kernel/svl_sentinel_daemon.py', size: 3307 },
  { name: 'binary_hyperspace_void.py', path: 'SVL_CoreOS_2/kernel/binary_hyperspace_void.py', size: 2005 },
  { name: 'hot_swap_engine.py', path: 'SVL_CoreOS_2/kernel/hot_swap_engine.py', size: 1626 },
  { name: 'svl_sentinel_av.py', path: 'SVL_CoreOS_2/security/svl_sentinel_av.py', size: 2299 },
  { name: 'svl_apex_firewall.py', path: 'SVL_CoreOS_2/security/svl_apex_firewall.py', size: 3294 },
  { name: 'network_suite.py', path: 'SVL_CoreOS_2/security/network_suite.py', size: 3428 },
  { name: 'Modelfile.apex-uncensored', path: 'SVL_CoreOS_2/ai_core/Modelfile.apex-uncensored', size: 605 },
  { name: 'ollama_svl364_config.json', path: 'SVL_CoreOS_2/ai_core/ollama_svl364_config.json', size: 392 },
  { name: 'huggingface_swarm_toolkit.py', path: 'SVL_CoreOS_2/ai_core/huggingface_swarm_toolkit.py', size: 3599 },
  { name: 'apex_dark_ui.tsx', path: 'SVL_CoreOS_2/gui/apex_dark_ui.tsx', size: 3143 },
  { name: 'apex_dark_theme.css', path: 'SVL_CoreOS_2/gui/apex_dark_theme.css', size: 1009 },
  { name: 'remote_desktop_server.py', path: 'SVL_CoreOS_2/gui/remote_desktop_server.py', size: 1451 },
  { name: 'realtime_telemetry_hub.py', path: 'SVL_CoreOS_2/infrastructure/realtime_telemetry_hub.py', size: 2022 },
  { name: 'apex_ui_manifest.json', path: 'SVL_CoreOS_2/system/assets/apex_ui_manifest.json', size: 1054 },
  { name: 'install_coreos2_svl364.sh', path: 'SVL_CoreOS_2/debian13/install_coreos2_svl364.sh', size: 3520 },
  { name: 'debootstrap_trixie_stage1_stage2.sh', path: 'SVL_CoreOS_2/debian13/debootstrap_trixie_stage1_stage2.sh', size: 1680 },
  { name: 'debian13_trixie_rootfs_manifest.json', path: 'SVL_CoreOS_2/debian13/debian13_trixie_rootfs_manifest.json', size: 1840 },
  { name: 'svl-sentinel.service', path: 'SVL_CoreOS_2/debian13/svl-sentinel.service', size: 524 },
  { name: 'svl-coreos2-sysctl.conf', path: 'SVL_CoreOS_2/debian13/svl-coreos2-sysctl.conf', size: 292 },
  { name: 'packages_manifest.txt', path: 'SVL_CoreOS_2/debian13/packages_manifest.txt', size: 980 },
];

const INITIAL_COREOS2_DIRS: Array<{ name: string; path: string }> = [
  { name: 'kernel', path: 'SVL_CoreOS_2/kernel' },
  { name: 'security', path: 'SVL_CoreOS_2/security' },
  { name: 'ai_core', path: 'SVL_CoreOS_2/ai_core' },
  { name: 'gui', path: 'SVL_CoreOS_2/gui' },
  { name: 'infrastructure', path: 'SVL_CoreOS_2/infrastructure' },
  { name: 'system', path: 'SVL_CoreOS_2/system' },
  { name: 'assets', path: 'SVL_CoreOS_2/system/assets' },
  { name: 'debian13', path: 'SVL_CoreOS_2/debian13' },
];

export const GitHubPanel: React.FC<{ onSelectRepoFile?: (filePath: string) => void }> = ({ onSelectRepoFile }) => {
  const { serverRevision } = useSvlSync();
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [busy, setBusy] = useState<SyncAction | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [coreOsFiles, setCoreOsFiles] = useState<Array<{ name: string; path: string; size: number }>>(INITIAL_COREOS2_FILES);
  const [coreOsDirs, setCoreOsDirs] = useState<Array<{ name: string; path: string }>>(INITIAL_COREOS2_DIRS);

  const load = useCallback(async (fetchRemote = true) => {
    void safeFetchJson<{
      ok: boolean;
      treeFiles?: Array<{ name: string; path: string; size: number }>;
      treeDirs?: Array<{ name: string; path: string }>;
    }>('/api/files?path=SVL_CoreOS_2&tree=1', { timeoutMs: 12000 }).then((treeRes) => {
      if (treeRes.ok && treeRes.data?.ok) {
        if (Array.isArray(treeRes.data.treeFiles) && treeRes.data.treeFiles.length > 0) {
          setCoreOsFiles(treeRes.data.treeFiles);
        }
        if (Array.isArray(treeRes.data.treeDirs) && treeRes.data.treeDirs.length > 0) {
          setCoreOsDirs(treeRes.data.treeDirs);
        }
      }
    });
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
          <GitBranch className="w-4 h-4" aria-hidden="true" /> GitHub · {status?.repository || 'Rush47/SVL_Core'}
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
          <span className="text-slate-400">Folder w repozytorium:</span>
          <span className="text-emerald-300">
            SVL_CoreOS_2/ ({coreOsDirs.length} kat. · {coreOsFiles.length} plików)
          </span>
        </div>
      </div>

      {coreOsFiles.length > 0 && (
        <div className="p-2.5 rounded-lg bg-[#0B0D13] border border-slate-800/90 space-y-1.5">
          <div className="flex items-center justify-between text-[11px] font-semibold text-cyan-300">
            <span>📂 SVL_CoreOS_2/ (pliki utworzone z czatu: {coreOsFiles.length})</span>
            <a
              href={`https://github.com/${status?.repository || 'Rush47/SVL_Core'}/tree/${status?.branch || 'main'}/SVL_CoreOS_2`}
              target="_blank"
              rel="noreferrer"
              className="text-violet-300 hover:underline font-mono"
            >
              Otwórz na GitHub ↗
            </a>
          </div>
          <div className="max-h-36 overflow-y-auto space-y-1 pr-1 font-mono text-[11px]">
            {coreOsFiles.map((f) => (
              <button
                key={f.path}
                type="button"
                onClick={() => onSelectRepoFile?.(f.path)}
                className="w-full text-left flex items-center justify-between gap-2 px-2 py-1 rounded hover:bg-slate-800/80 text-slate-200 transition-colors"
              >
                <span className="truncate text-emerald-300">{f.path}</span>
                <span className="text-slate-400 shrink-0">{f.size} B</span>
              </button>
            ))}
          </div>
        </div>
      )}

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
        Bielik i Maya Mitek synchronizują folder <code>SVL_CoreOS_2/</code> oraz całe repozytorium <code>Rush47/SVL_Core</code> z czatu i terminala.
      </p>
    </div>
  );
};
