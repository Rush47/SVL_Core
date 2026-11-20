// Synchronizacja na żywo między repozytorium na dysku a otwartymi oknami GUI.
//
// Źródła zmian: git pull (panel, terminal, auto-pull, autosynchronizacja), narzędzia czatu,
// MCP (w aplikacji i samodzielny), agenci, ręczna edycja. Każda zmiana trafia na szynę
// liveSyncBus (WebSocket + SSE), a w zależności od rodzaju pliku:
//   • pliki repo / SVL_CoreOS_2   → panele (GitHub, drzewa plików) odświeżają się same,
//   • GUI (src/, index.html)       → produkcja: przebudowa dist + automatyczne przeładowanie kart,
//                                    dev bez HMR: unieważnienie modułów Vite + przeładowanie,
//   • backend/*.py                 → restart jądra Python (gateway działa dalej),
//   • server.ts / src/server       → restart gatewaya (automatycznie pod systemd/pm2, inaczej przycisk).

import path from 'node:path';
import {
  RepoChangeAggregator,
  gitChangedFiles,
  startGitHeadWatcher,
  startRepoWatcher,
  type RepoChangeBatch,
  type RepoChangeKind,
} from './repoWatcher.ts';
import { FrontendRebuilder, viteBuildRunner, type BuildRunner } from './frontendRebuilder.ts';

const truthy = (v: unknown) => /^(1|true|yes|on|tak)$/i.test(String(v ?? '').trim());
const falsy = (v: unknown) => /^(0|false|no|off|nie)$/i.test(String(v ?? '').trim());
function int(v: unknown, def: number, min: number, max: number): number {
  const n = Number.parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

export type ReloadPolicy = 'auto' | 'prompt' | 'off';
export type RestartPolicy = 'auto' | 'always' | 'off';

export interface LiveRepoSyncConfig {
  enabled: boolean;
  debounceMs: number;
  maxWaitMs: number;
  extraIgnored: string[];
  headPollMs: number;
  frontendRebuild: boolean;
  rebuildDebounceMs: number;
  clientReload: ReloadPolicy;
  pythonRestart: boolean;
  serverRestart: RestartPolicy;
  restartDelayMs: number;
  autoNpmInstall: boolean;
  autoPullSec: number;
  supervised: boolean;
  supervisor: string | null;
}

/** Wykrywa nadzorcę procesu, który po wyjściu uruchomi gateway ponownie. */
export function detectSupervisor(env: NodeJS.ProcessEnv): string | null {
  if (truthy(env.SVL_SUPERVISED)) return 'SVL_SUPERVISED';
  if (falsy(env.SVL_SUPERVISED)) return null;
  // Usługa systemd ma INVOCATION_ID i nie ma terminala; terminal uruchomiony przez systemd --user
  // też dziedziczy INVOCATION_ID, ale ma TERM — tam wyjście procesu zakończyłoby aplikację.
  if (env.INVOCATION_ID && !env.TERM) return 'systemd';
  if (env.pm_id !== undefined || env.PM2_HOME) return 'pm2';
  if (env.SVL_RUN_LOOP) return 'pętla run-loop';
  return null;
}

export function loadLiveRepoSyncConfig(env: NodeJS.ProcessEnv, opts: { isProd: boolean; aiStudio: boolean; hasGit: boolean }): LiveRepoSyncConfig {
  const reload = String(env.SVL_LIVE_CLIENT_RELOAD || '').trim().toLowerCase();
  const restart = String(env.SVL_LIVE_SERVER_RESTART || '').trim().toLowerCase();
  const supervisor = detectSupervisor(env);
  // Auto-pull domyślnie co 60 s na serwerze produkcyjnym z repozytorium git; wyłączony w AI Studio
  // (tam zmiany plików tworzą checkpointy „Manual edit”). SVL_GITHUB_AUTOPULL_SEC=0 wyłącza.
  const autoPullDefault = opts.isProd && !opts.aiStudio && opts.hasGit ? 60 : 0;
  const autoPullRaw = env.SVL_GITHUB_AUTOPULL_SEC;
  const autoPullSec = autoPullRaw === undefined || String(autoPullRaw).trim() === ''
    ? autoPullDefault
    : int(autoPullRaw, autoPullDefault, 0, 86400);
  return {
    enabled: !falsy(env.SVL_LIVE_REPO_SYNC),
    debounceMs: int(env.SVL_LIVE_WATCH_DEBOUNCE_MS, 300, 50, 10000),
    maxWaitMs: int(env.SVL_LIVE_WATCH_MAX_WAIT_MS, 2000, 100, 60000),
    extraIgnored: String(env.SVL_LIVE_WATCH_IGNORE || '').split(',').map((s) => s.trim()).filter(Boolean),
    headPollMs: int(env.SVL_LIVE_GIT_HEAD_POLL_MS, 1500, 250, 60000),
    frontendRebuild: opts.isProd && !falsy(env.SVL_LIVE_FRONTEND_REBUILD),
    rebuildDebounceMs: int(env.SVL_LIVE_REBUILD_DEBOUNCE_MS, 800, 0, 60000),
    clientReload: reload === 'prompt' || reload === 'off' || reload === 'auto'
      ? reload
      : (opts.aiStudio ? 'prompt' : 'auto'),
    pythonRestart: !falsy(env.SVL_LIVE_PYTHON_RESTART),
    serverRestart: restart === 'always' || restart === 'off' || restart === 'auto' ? restart : 'auto',
    restartDelayMs: int(env.SVL_LIVE_RESTART_DELAY_MS, 4000, 0, 600000),
    autoNpmInstall: truthy(env.SVL_LIVE_AUTO_NPM_INSTALL),
    autoPullSec: autoPullSec > 0 ? Math.max(15, autoPullSec) : 0,
    supervised: Boolean(supervisor),
    supervisor,
  };
}

export interface LiveRepoSyncDeps {
  root: string;
  config: LiveRepoSyncConfig;
  isProd: boolean;
  /** Wysyła ramkę JSON do wszystkich klientów (WebSocket + SSE). */
  publish: (frame: Record<string, unknown>) => void;
  /** Pełne odświeżenie domen danych w GUI (svl.resync_required). */
  broadcastResync: (reason: string) => void;
  restartPython?: () => void;
  /** Dev bez HMR: unieważnia cache modułów Vite, żeby przeładowana strona dostała nowy kod. */
  invalidateDevModules?: (absPaths: string[]) => void;
  /** Dev z aktywnym HMR: Vite sam aktualizuje GUI. */
  devHmrActive?: boolean;
  /** Restart gatewaya (exit pod nadzorcą albo ponowne uruchomienie procesu). */
  restartServer?: (reason: string) => void;
  runAutoPull?: () => Promise<{ ok: boolean; changed: boolean; skipped?: string; error?: string; newHead?: string }>;
  runNpmInstall?: () => Promise<{ ok: boolean; output: string }>;
  buildRunner?: BuildRunner;
  log?: (level: 'INFO' | 'WARN' | 'ERROR', message: string) => void;
  /** Wyłącza fs.watch / odpytywanie HEAD (testy). */
  startWatchers?: boolean;
}

export interface LiveRepoSyncStatus {
  enabled: boolean;
  watcher: { mode: string; dirs: string[]; error?: string };
  head: string;
  lastChange: { at: string; paths: number; kinds: RepoChangeKind[]; sources: string[] } | null;
  lastHeadChange: { at: string; prev: string; next: string; files: number } | null;
  frontend: ReturnType<FrontendRebuilder['status']> | { state: 'disabled' | 'dev-hmr' | 'dev'; buildId: string };
  appBuildId: string;
  clientReload: ReloadPolicy;
  restartRequired: { since: string; reasons: string[]; depsChanged: boolean } | null;
  restartPolicy: RestartPolicy;
  supervisor: string | null;
  autoPull: { intervalSec: number; lastAt: string | null; lastResult: string | null; running: boolean };
  pythonRestart: boolean;
}

const MAX_FRAME_PATHS = 200;

export class LiveRepoSync {
  readonly aggregator: RepoChangeAggregator;
  private rebuilder: FrontendRebuilder | null = null;
  private watcher: ReturnType<typeof startRepoWatcher> | null = null;
  private headWatcher: ReturnType<typeof startGitHeadWatcher> | null = null;
  private autoPullTimer: ReturnType<typeof setInterval> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private pythonTimer: ReturnType<typeof setTimeout> | null = null;
  private lastChange: LiveRepoSyncStatus['lastChange'] = null;
  private lastHeadChange: LiveRepoSyncStatus['lastHeadChange'] = null;
  private restartRequired: LiveRepoSyncStatus['restartRequired'] = null;
  private autoPullState = { lastAt: null as string | null, lastResult: null as string | null, running: false };
  private devBuildId = `dev-${Date.now().toString(36)}`;
  private pendingHeadSource: string | null = null;
  private ignoreDepsUntil = 0;
  private log: NonNullable<LiveRepoSyncDeps['log']>;

  constructor(private readonly deps: LiveRepoSyncDeps) {
    const c = deps.config;
    this.log = deps.log || (() => undefined);
    this.aggregator = new RepoChangeAggregator((batch) => this.onBatch(batch), c.debounceMs, c.maxWaitMs);
    if (deps.isProd && c.frontendRebuild) {
      this.rebuilder = new FrontendRebuilder({
        distDir: path.join(deps.root, 'dist'),
        runner: deps.buildRunner || viteBuildRunner(deps.root),
        debounceMs: c.rebuildDebounceMs,
        onStart: (reasons) => deps.publish({ type: 'svl.app_building', reasons: reasons.slice(0, 20), timestamp: new Date().toISOString() }),
        onBuilt: (buildId, info) => {
          this.log('INFO', `GUI przebudowane (${buildId}, ${info.durationMs} ms) — przeładowanie kart: ${c.clientReload}`);
          deps.publish({
            type: 'svl.app_updated',
            mode: 'prod',
            buildId,
            durationMs: info.durationMs,
            reload: c.clientReload,
            reasons: info.reasons.slice(0, 20),
            timestamp: new Date().toISOString(),
          });
        },
        onFailed: (error) => {
          this.log('ERROR', `Przebudowa GUI nieudana — zostaje poprzednia wersja: ${error.slice(0, 400)}`);
          deps.publish({ type: 'svl.app_build_failed', error: error.slice(0, 1500), timestamp: new Date().toISOString() });
        },
      });
    }
  }

  start(): void {
    const c = this.deps.config;
    if (!c.enabled) return;
    if (this.deps.startWatchers !== false) {
      this.watcher = startRepoWatcher({
        root: this.deps.root,
        extraIgnored: c.extraIgnored,
        onPath: (rel) => this.aggregator.add(rel, 'watcher'),
        log: (level, msg) => this.log(level, msg),
      });
      if (this.watcher.mode === 'off') this.log('WARN', `Obserwator plików wyłączony: ${this.watcher.error}`);
      this.headWatcher = startGitHeadWatcher({
        root: this.deps.root,
        intervalMs: c.headPollMs,
        onChange: (prev, next, ref) => void this.onHeadChange(prev, next, ref),
      });
    }
    if (c.autoPullSec > 0 && this.deps.runAutoPull) {
      this.autoPullTimer = setInterval(() => void this.autoPull('auto-pull'), c.autoPullSec * 1000);
      (this.autoPullTimer as any).unref?.();
    }
  }

  stop(): void {
    this.watcher?.close();
    this.headWatcher?.close();
    if (this.autoPullTimer) clearInterval(this.autoPullTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.pythonTimer) clearTimeout(this.pythonTimer);
    this.aggregator.dispose();
    this.rebuilder?.dispose();
  }

  /** Jawne zgłoszenie zmian (narzędzia czatu, MCP, git pull w aplikacji) — nie czeka na fs.watch. */
  notify(paths: string[], source: string): void {
    if (!this.deps.config.enabled) return;
    const rel = paths
      .map((p) => String(p || '').trim())
      .filter(Boolean)
      .map((p) => (path.isAbsolute(p) ? path.relative(this.deps.root, p) : p))
      .filter((p) => p && !p.startsWith('..'));
    if (rel.length === 0) return;
    this.aggregator.add(rel, source.slice(0, 60));
  }

  /** Oznacza źródło najbliższej zmiany HEAD (np. „panel GitHub”, „auto-pull”). */
  markHeadSource(source: string): void {
    this.pendingHeadSource = source;
  }

  async autoPull(source = 'auto-pull'): Promise<string> {
    if (!this.deps.runAutoPull || this.autoPullState.running) return 'pominięto';
    this.autoPullState.running = true;
    try {
      this.pendingHeadSource = source;
      const r = await this.deps.runAutoPull();
      const summary = r.error || r.skipped || (r.changed ? `pobrano → ${String(r.newHead || '').slice(0, 7)}` : 'brak nowych zmian');
      const prevResult = this.autoPullState.lastResult;
      this.autoPullState.lastAt = new Date().toISOString();
      this.autoPullState.lastResult = summary;
      if ((r.error || r.skipped) && prevResult !== summary) this.log(r.error ? 'WARN' : 'INFO', `Auto-pull GitHub: ${summary}`);
      if (!r.changed) this.pendingHeadSource = null;
      return summary;
    } finally {
      this.autoPullState.running = false;
    }
  }

  private async onHeadChange(prev: string, next: string, ref: string): Promise<void> {
    const source = this.pendingHeadSource || 'git';
    this.pendingHeadSource = null;
    const files = await gitChangedFiles(this.deps.root, prev, next);
    this.lastHeadChange = { at: new Date().toISOString(), prev, next, files: files.length };
    this.log('INFO', `HEAD ${prev.slice(0, 7)} → ${next.slice(0, 7)} (${source}, ${files.length} plików)`);
    this.deps.publish({
      type: 'svl.git_head',
      prev,
      next,
      ref,
      source,
      changedPaths: files.slice(0, MAX_FRAME_PATHS),
      totalPaths: files.length,
      timestamp: new Date().toISOString(),
    });
    // Pliki z commita przechodzą tą samą ścieżką co zmiany z dysku (fs.watch je też złapie — paczka scali duplikaty).
    if (files.length > 0) this.aggregator.add(files, `git:${source}`);
    this.deps.broadcastResync('git_head_changed');
  }

  private onBatch(batch: RepoChangeBatch): void {
    this.lastChange = { at: batch.at, paths: batch.paths.length, kinds: batch.kinds, sources: batch.sources };
    this.deps.publish({
      type: 'svl.repo_changed',
      paths: batch.paths.slice(0, MAX_FRAME_PATHS),
      totalPaths: batch.paths.length,
      kinds: batch.kinds,
      sources: batch.sources,
      head: this.headWatcher?.current() || '',
      timestamp: batch.at,
    });
    const kinds = new Set(batch.kinds);
    const pathsOf = (k: RepoChangeKind) => batch.paths.filter((p) => {
      if (k === 'frontend') return /^(src\/(?!server\/|mcp\/)|public\/|index\.html$|vite\.config|tailwind\.config|postcss\.config|tsconfig\.json$)/.test(p);
      if (k === 'python') return /\.py$/.test(p);
      if (k === 'server') return /^(server\.ts$|src\/server\/|src\/mcp\/|src\/utils\/)/.test(p) && !/\.test\./.test(p);
      if (k === 'deps') return /^package(-lock)?\.json$/.test(p);
      return true;
    });

    if (kinds.has('deps')) this.handleDeps(pathsOf('deps'));
    if (kinds.has('frontend')) this.handleFrontend(pathsOf('frontend'));
    if (kinds.has('python')) this.handlePython(pathsOf('python'));
    if (kinds.has('server')) this.markRestartRequired(pathsOf('server').map((p) => `kod serwera: ${p}`), false);
  }

  private handleFrontend(paths: string[]): void {
    const reason = `GUI: ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ` (+${paths.length - 3})` : ''}`;
    if (this.rebuilder) {
      if (this.restartRequired?.depsChanged && !this.deps.config.autoNpmInstall) return; // build mógłby się wysypać bez npm install
      this.rebuilder.request(reason);
      return;
    }
    if (!this.deps.isProd && !this.deps.devHmrActive) {
      try {
        this.deps.invalidateDevModules?.(paths.map((p) => path.join(this.deps.root, p)));
      } catch (err) {
        this.log('WARN', `Unieważnienie modułów Vite nieudane: ${(err as Error).message}`);
      }
      this.devBuildId = `dev-${Date.now().toString(36)}`;
      this.deps.publish({
        type: 'svl.app_updated',
        mode: 'dev',
        buildId: this.devBuildId,
        reload: this.deps.config.clientReload,
        reasons: [reason],
        timestamp: new Date().toISOString(),
      });
    }
    // Dev z HMR: Vite aktualizuje GUI sam.
  }

  private handlePython(paths: string[]): void {
    if (!this.deps.config.pythonRestart || !this.deps.restartPython) {
      this.markRestartRequired(paths.map((p) => `jądro Python: ${p}`), false);
      return;
    }
    if (this.pythonTimer) clearTimeout(this.pythonTimer);
    this.pythonTimer = setTimeout(() => {
      this.pythonTimer = null;
      this.log('INFO', `Zmiana backendu Python (${paths.slice(0, 3).join(', ')}) — restart jądra Python`);
      this.deps.publish({ type: 'svl.python_restarting', paths: paths.slice(0, 50), timestamp: new Date().toISOString() });
      this.deps.restartPython!();
      // Po starcie nowego jądra GUI pobiera świeże dane.
      const t = setTimeout(() => this.deps.broadcastResync('python_reloaded'), 3500);
      (t as any).unref?.();
    }, 300);
    (this.pythonTimer as any).unref?.();
  }

  private handleDeps(paths: string[]): void {
    // npm install sam przepisuje package-lock.json — nie zapętlamy się na własnej zmianie.
    if (Date.now() < this.ignoreDepsUntil) return;
    if (this.deps.config.autoNpmInstall && this.deps.runNpmInstall) {
      this.log('INFO', 'Zmiana package.json — npm install w tle');
      this.ignoreDepsUntil = Number.MAX_SAFE_INTEGER;
      void this.deps.runNpmInstall().then((r) => {
        this.ignoreDepsUntil = Date.now() + 10_000;
        if (!r.ok) this.log('ERROR', `npm install nieudany: ${r.output.slice(-400)}`);
        this.rebuilder?.request('zależności npm');
        this.markRestartRequired(['zależności npm (package.json)'], false);
      });
      return;
    }
    this.markRestartRequired(paths.map((p) => `zależności: ${p} (npm install)`), true);
  }

  private markRestartRequired(reasons: string[], depsChanged: boolean): void {
    const c = this.deps.config;
    const prev = this.restartRequired;
    const merged = Array.from(new Set([...(prev?.reasons || []), ...reasons])).slice(0, 30);
    this.restartRequired = { since: prev?.since || new Date().toISOString(), reasons: merged, depsChanged: Boolean(prev?.depsChanged || depsChanged) };
    const auto = c.serverRestart === 'always' || (c.serverRestart === 'auto' && c.supervised);
    const autoRestartInMs = auto && this.deps.restartServer ? c.restartDelayMs : null;
    this.deps.publish({
      type: 'svl.restart_required',
      reasons: merged,
      depsChanged: this.restartRequired.depsChanged,
      supervisor: c.supervisor,
      autoRestartInMs,
      timestamp: new Date().toISOString(),
    });
    if (autoRestartInMs !== null) this.scheduleRestart('automatyczny restart po zmianie kodu serwera', autoRestartInMs);
  }

  /** Planuje restart gatewaya (najpierw dokańcza ewentualną przebudowę GUI). */
  scheduleRestart(reason: string, delayMs = 0): void {
    if (!this.deps.restartServer) return;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.deps.publish({ type: 'svl.restarting', reason, inMs: delayMs, timestamp: new Date().toISOString() });
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      if (this.restartRequired?.depsChanged && this.deps.runNpmInstall) {
        const r = await this.deps.runNpmInstall();
        if (!r.ok) {
          this.log('ERROR', `npm install przed restartem nieudany: ${r.output.slice(-400)}`);
          this.deps.publish({ type: 'svl.app_build_failed', error: `npm install: ${r.output.slice(-800)}`, timestamp: new Date().toISOString() });
          return;
        }
      }
      if (this.rebuilder && (this.rebuilder.isBuilding || this.rebuilder.status().state === 'scheduled' || this.restartRequired?.depsChanged)) {
        await this.rebuilder.runNow();
      }
      this.deps.restartServer!(reason);
    }, Math.max(0, delayMs));
  }

  /** Ręczna przebudowa GUI (np. z panelu). */
  rebuildFrontend(reason = 'ręcznie'): boolean {
    if (!this.rebuilder) return false;
    this.rebuilder.request(reason);
    return true;
  }

  appBuildId(): string {
    return this.rebuilder ? this.rebuilder.status().buildId : this.devBuildId;
  }

  status(): LiveRepoSyncStatus {
    const c = this.deps.config;
    return {
      enabled: c.enabled,
      watcher: { mode: this.watcher?.mode || 'off', dirs: this.watcher?.watchedDirs() || [], ...(this.watcher?.error ? { error: this.watcher.error } : {}) },
      head: this.headWatcher?.current() || '',
      lastChange: this.lastChange,
      lastHeadChange: this.lastHeadChange,
      frontend: this.rebuilder
        ? this.rebuilder.status()
        : { state: this.deps.isProd ? 'disabled' : this.deps.devHmrActive ? 'dev-hmr' : 'dev', buildId: this.devBuildId },
      appBuildId: this.appBuildId(),
      clientReload: c.clientReload,
      restartRequired: this.restartRequired,
      restartPolicy: c.serverRestart,
      supervisor: c.supervisor,
      autoPull: { intervalSec: c.autoPullSec, ...this.autoPullState },
      pythonRestart: c.pythonRestart,
    };
  }
}
