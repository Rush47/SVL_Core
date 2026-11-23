// Obserwator repozytorium: zmiany plików (git pull, czat, MCP, agenci, edytor) i HEAD gita.
//
// Wcześniej działająca aplikacja nie wiedziała, że pliki na dysku się zmieniły — nowe elementy
// pojawiały się dopiero po ręcznej synchronizacji / restarcie. Ten moduł wykrywa zmiany
// (fs.watch, bez zależności), grupuje je (debounce) i klasyfikuje: frontend / serwer / Python.

import fsSync from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export type RepoChangeKind = 'frontend' | 'server' | 'python' | 'deps' | 'content';

/** Katalogi i pliki pomijane zawsze (szum: zależności, buildy, dane runtime, logi). */
export const DEFAULT_IGNORED_SEGMENTS = [
  'node_modules', '.git', 'data', 'logi', 'logs', 'coverage', 'out', 'build',
  '__pycache__', '.venv', 'venv', '.cache', '.vite', '.playwright-cli', '.aistudio', '.pytest_cache',
];

const IGNORED_FILE_RE = /(\.log|\.sqlite3?(-wal|-shm|-journal)?|\.db(-wal|-shm|-journal)?|\.pyc|\.swp|\.swx|\.tmp|~|\.DS_Store|\.secret)$/i;

function normalizeRel(relPath: string): string {
  return String(relPath || '').split(path.sep).join('/').replace(/^\.\/+/, '').replace(/^\/+/, '');
}

/** true = ścieżka (względna wobec katalogu projektu) jest szumem i nie wywołuje odświeżenia. */
export function isIgnoredRepoPath(relPath: string, extraIgnored: string[] = []): boolean {
  const rel = normalizeRel(relPath);
  if (!rel || rel === '.' || rel.startsWith('../')) return true;
  const segments = rel.split('/');
  const top = segments[0];
  // dist, dist.__next, dist.__prev — wynik budowania frontendu (również naszego automatycznego).
  if (top === 'dist' || top.startsWith('dist.')) return true;
  if (top === '.env' || top.startsWith('.env.') && top !== '.env.example') return true;
  const ignored = new Set([...DEFAULT_IGNORED_SEGMENTS, ...extraIgnored.map((s) => s.trim()).filter(Boolean)]);
  if (segments.some((seg) => ignored.has(seg))) return true;
  for (const extra of extraIgnored) {
    const e = normalizeRel(extra).replace(/\/+$/, '');
    if (e.includes('/') && (rel === e || rel.startsWith(`${e}/`))) return true;
  }
  const base = segments[segments.length - 1];
  if (IGNORED_FILE_RE.test(base)) return true;
  // Pliki tymczasowe edytorów / zapisów atomowych (np. .plik.ts.swp, plik.ts.tmp-123, 4913 vima).
  if (/^\.#|^#.*#$|\.tmp-\d+$|^\d{4,}$|^sed[A-Za-z0-9]{6}$/.test(base)) return true;
  return false;
}

/** Do czego należy zmieniony plik — decyduje, co trzeba odświeżyć / przebudować / zrestartować. */
export function classifyRepoPath(relPath: string): RepoChangeKind[] {
  const rel = normalizeRel(relPath);
  const kinds = new Set<RepoChangeKind>();
  const isTest = /\.test\.(t|j)sx?$/.test(rel) || /(^|\/)tests?\//.test(rel);
  if (rel === 'package.json' || rel === 'package-lock.json') kinds.add('deps');
  if (rel === 'server.ts' || rel.startsWith('src/server/') || rel.startsWith('src/mcp/')) {
    if (!isTest) kinds.add('server');
  } else if (rel.startsWith('src/utils/')) {
    // Moduły wspólne (np. svlLogic.ts) importuje zarówno GUI, jak i serwer.
    if (!isTest) {
      kinds.add('frontend');
      kinds.add('server');
    }
  } else if (rel.startsWith('src/') || rel.startsWith('public/') || rel === 'index.html' ||
             /^(vite|tailwind|postcss)\.config\.(t|j|mj|cj)s$/.test(rel) || rel === 'tsconfig.json') {
    if (!isTest) kinds.add('frontend');
  } else if (rel.startsWith('backend/') && rel.endsWith('.py')) {
    if (!isTest) kinds.add('python');
  } else if (/^[^/]+\.py$/.test(rel)) {
    kinds.add('python');
  }
  kinds.add('content');
  return Array.from(kinds);
}

export interface RepoChangeBatch {
  paths: string[];
  kinds: RepoChangeKind[];
  sources: string[];
  at: string;
}

/**
 * Grupuje serię zdarzeń w jedną paczkę: czeka `debounceMs` ciszy, ale nie dłużej niż `maxWaitMs`
 * od pierwszego zdarzenia (git pull zmieniający setki plików = jedno odświeżenie).
 */
export class RepoChangeAggregator {
  private pending = new Map<string, Set<string>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstAt = 0;
  constructor(
    private readonly onFlush: (batch: RepoChangeBatch) => void,
    private readonly debounceMs = 300,
    private readonly maxWaitMs = 2000,
    private readonly maxPaths = 500,
  ) {}

  add(relPaths: string[] | string, source = 'watcher'): void {
    const list = Array.isArray(relPaths) ? relPaths : [relPaths];
    let added = false;
    for (const raw of list) {
      const rel = normalizeRel(raw);
      if (!rel) continue;
      if (!this.pending.has(rel) && this.pending.size >= this.maxPaths) continue;
      const sources = this.pending.get(rel) || new Set<string>();
      sources.add(source);
      this.pending.set(rel, sources);
      added = true;
    }
    if (!added) return;
    const now = Date.now();
    if (!this.timer) this.firstAt = now;
    if (this.timer) clearTimeout(this.timer);
    const elapsed = now - this.firstAt;
    const wait = Math.max(0, Math.min(this.debounceMs, this.maxWaitMs - elapsed));
    this.timer = setTimeout(() => this.flush(), wait);
    (this.timer as any).unref?.();
  }

  get size(): number {
    return this.pending.size;
  }

  flush(): RepoChangeBatch | null {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending.size === 0) return null;
    const paths = Array.from(this.pending.keys()).sort();
    const sources = new Set<string>();
    for (const s of this.pending.values()) for (const v of s) sources.add(v);
    const kinds = new Set<RepoChangeKind>();
    for (const p of paths) for (const k of classifyRepoPath(p)) kinds.add(k);
    this.pending.clear();
    const batch: RepoChangeBatch = { paths, kinds: Array.from(kinds), sources: Array.from(sources).sort(), at: new Date().toISOString() };
    this.onFlush(batch);
    return batch;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }
}

export interface RepoWatcherHandle {
  close: () => void;
  watchedDirs: () => string[];
  mode: 'fs.watch' | 'off';
  error?: string;
}

/**
 * Obserwuje katalog projektu: katalog główny nierekurencyjnie + każdy nieignorowany podkatalog
 * najwyższego poziomu rekurencyjnie (node_modules/.git/dist/data nigdy nie są obserwowane,
 * więc nie zużywamy tysięcy uchwytów inotify). Nowe katalogi najwyższego poziomu dochodzą same.
 */
export function startRepoWatcher(opts: {
  root: string;
  onPath: (relPath: string) => void;
  extraIgnored?: string[];
  log?: (level: 'INFO' | 'WARN', message: string) => void;
}): RepoWatcherHandle {
  const { root, onPath, extraIgnored = [], log = () => undefined } = opts;
  const watchers = new Map<string, fsSync.FSWatcher>();
  let closed = false;

  const emit = (rel: string) => {
    const n = normalizeRel(rel);
    if (!n || isIgnoredRepoPath(n, extraIgnored)) return;
    onPath(n);
  };

  const watchDir = (name: string) => {
    if (closed || watchers.has(name)) return;
    if (isIgnoredRepoPath(`${name}/x`, extraIgnored) || name.startsWith('.')) return;
    const abs = path.join(root, name);
    try {
      if (!fsSync.statSync(abs).isDirectory()) return;
      const w = fsSync.watch(abs, { recursive: true }, (_evt, filename) => {
        if (!filename) {
          emit(`${name}/`);
          return;
        }
        emit(`${name}/${String(filename)}`);
      });
      w.on('error', (err) => {
        log('WARN', `Obserwator ${name}/ zatrzymany: ${(err as Error).message}`);
        try { w.close(); } catch { /* już zamknięty */ }
        watchers.delete(name);
      });
      watchers.set(name, w);
    } catch (err) {
      log('WARN', `Nie można obserwować ${name}/: ${(err as Error).message}`);
    }
  };

  try {
    const rootWatcher = fsSync.watch(root, { recursive: false }, (_evt, filename) => {
      if (!filename) return;
      const name = String(filename);
      const abs = path.join(root, name);
      let isDir = false;
      try { isDir = fsSync.statSync(abs).isDirectory(); } catch { /* usunięty */ }
      if (isDir) {
        if (!watchers.has(name)) {
          watchDir(name);
          emit(`${name}/`);
        }
        return;
      }
      if (watchers.has(name)) {
        // katalog usunięty
        try { watchers.get(name)!.close(); } catch { /* ignore */ }
        watchers.delete(name);
      }
      emit(name);
    });
    rootWatcher.on('error', (err) => log('WARN', `Obserwator katalogu głównego: ${(err as Error).message}`));
    watchers.set('.', rootWatcher);
    for (const entry of fsSync.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) watchDir(entry.name);
    }
  } catch (err) {
    for (const w of watchers.values()) { try { w.close(); } catch { /* ignore */ } }
    watchers.clear();
    return { close: () => undefined, watchedDirs: () => [], mode: 'off', error: (err as Error).message };
  }

  return {
    mode: 'fs.watch',
    watchedDirs: () => Array.from(watchers.keys()).filter((k) => k !== '.').sort(),
    close: () => {
      closed = true;
      for (const w of watchers.values()) { try { w.close(); } catch { /* ignore */ } }
      watchers.clear();
    },
  };
}

/** Czyta SHA bieżącego HEAD prosto z .git (bez uruchamiania gita — tanie odpytywanie co 1–2 s). */
export function readGitHead(root: string): { sha: string; ref: string } | null {
  try {
    const gitDir = path.join(root, '.git');
    const head = fsSync.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40,64}$/i.test(head)) return { sha: head.toLowerCase(), ref: 'HEAD' };
    const m = /^ref:\s*(\S+)$/.exec(head);
    if (!m) return null;
    const ref = m[1];
    try {
      const sha = fsSync.readFileSync(path.join(gitDir, ref), 'utf8').trim();
      if (/^[0-9a-f]{40,64}$/i.test(sha)) return { sha: sha.toLowerCase(), ref };
    } catch {
      // ref w packed-refs
    }
    const packed = fsSync.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
    for (const line of packed.split('\n')) {
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref && /^[0-9a-f]{40,64}$/i.test(sha || '')) return { sha: sha.toLowerCase(), ref };
    }
    return null;
  } catch {
    return null;
  }
}

/** Lista plików zmienionych między dwoma commitami (np. po git pull spoza aplikacji). */
export function gitChangedFiles(root: string, fromSha: string, toSha: string, timeoutMs = 15000): Promise<string[]> {
  return new Promise((resolve) => {
    if (!/^[0-9a-f]{7,64}$/i.test(fromSha) || !/^[0-9a-f]{7,64}$/i.test(toSha)) {
      resolve([]);
      return;
    }
    execFile('git', ['-c', `safe.directory=${root}`, 'diff', '--name-only', `${fromSha}`, `${toSha}`], { cwd: root, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        resolve([]);
        return;
      }
      resolve(String(stdout || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 2000));
    });
  });
}

/** Odpytuje HEAD co `intervalMs`; wywołuje onChange przy każdej zmianie commita (pull, commit, checkout). */
export function startGitHeadWatcher(opts: {
  root: string;
  intervalMs?: number;
  onChange: (prev: string, next: string, ref: string) => void;
  read?: (root: string) => { sha: string; ref: string } | null;
}): { close: () => void; current: () => string } {
  const read = opts.read || readGitHead;
  let last = read(opts.root)?.sha || '';
  const timer = setInterval(() => {
    const now = read(opts.root);
    if (!now || !now.sha || now.sha === last) return;
    const prev = last;
    last = now.sha;
    if (prev) opts.onChange(prev, now.sha, now.ref);
  }, Math.max(250, opts.intervalMs ?? 1500));
  (timer as any).unref?.();
  return { close: () => clearInterval(timer), current: () => last };
}
