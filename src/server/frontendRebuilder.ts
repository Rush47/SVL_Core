// Bezpieczna przebudowa GUI w trybie produkcyjnym (npm start serwuje gotowy katalog dist/).
//
// Po git pull albo edycji plików GUI przez AI dist/ był nieaktualny aż do restartu —
// nowe elementy interfejsu się nie pojawiały. Teraz budujemy do dist.__next, a dopiero po
// udanym buildzie podmieniamy katalogi (stary dist zostaje, jeśli build się nie uda).
// Zasoby poprzedniej wersji (assets/*) są przenoszone do nowej, więc otwarte karty
// ze starą paczką mogą jeszcze dociągnąć leniwe moduły do czasu przeładowania.

import fsSync from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface BuildRunResult {
  ok: boolean;
  output: string;
}

export type BuildRunner = (outDir: string) => Promise<BuildRunResult>;

export interface RebuildState {
  state: 'idle' | 'scheduled' | 'building' | 'failed';
  buildId: string;
  lastBuildAt: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  builds: number;
  pendingReasons: string[];
}

const MANIFEST = '.svl-build.json';

/** Domyślny runner: `node node_modules/vite/bin/vite.js build --outDir <dir> --emptyOutDir`. */
export function viteBuildRunner(root: string, timeoutMs = 10 * 60_000): BuildRunner {
  return (outDir) => new Promise((resolve) => {
    const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
    if (!fsSync.existsSync(viteBin)) {
      resolve({ ok: false, output: 'Brak node_modules/vite — uruchom npm install.' });
      return;
    }
    const child = spawn(process.execPath, [viteBin, 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'warn'], {
      cwd: root,
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const onData = (c: Buffer) => {
      output = (output + c.toString()).slice(-8000);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const timer = setTimeout(() => {
      output += '\nPrzekroczono limit czasu budowania.';
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `${output}\n${err.message}`.trim() });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: output.trim() });
    });
  });
}

function readManifest(dir: string): { buildId: string; assets: string[] } | null {
  try {
    const m = JSON.parse(fsSync.readFileSync(path.join(dir, MANIFEST), 'utf8'));
    return { buildId: String(m.buildId || ''), assets: Array.isArray(m.assets) ? m.assets.map(String) : [] };
  } catch {
    return null;
  }
}

function listAssets(dir: string): string[] {
  try {
    return fsSync.readdirSync(path.join(dir, 'assets')).filter((n) => !n.startsWith('.'));
  } catch {
    return [];
  }
}

/** Identyfikator bieżącego builda w dist (z manifestu albo z nazwy głównej paczki w index.html). */
export function currentBuildId(distDir: string): string {
  const m = readManifest(distDir);
  if (m?.buildId) return m.buildId;
  try {
    const html = fsSync.readFileSync(path.join(distDir, 'index.html'), 'utf8');
    const match = /assets\/(index-[^"']+?)\.js/.exec(html);
    if (match) return match[1];
    return `html-${fsSync.statSync(path.join(distDir, 'index.html')).mtimeMs.toFixed(0)}`;
  } catch {
    return 'none';
  }
}

export class FrontendRebuilder {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<boolean> | null = null;
  private rerunRequested = false;
  private reasons = new Set<string>();
  private st: RebuildState;

  constructor(
    private readonly opts: {
      distDir: string;
      runner: BuildRunner;
      debounceMs?: number;
      onBuilt?: (buildId: string, info: { durationMs: number; reasons: string[] }) => void;
      onFailed?: (error: string, info: { reasons: string[] }) => void;
      onStart?: (reasons: string[]) => void;
      now?: () => number;
    },
  ) {
    this.st = {
      state: 'idle',
      buildId: currentBuildId(opts.distDir),
      lastBuildAt: null,
      lastDurationMs: null,
      lastError: null,
      builds: 0,
      pendingReasons: [],
    };
  }

  status(): RebuildState {
    return { ...this.st, pendingReasons: Array.from(this.reasons) };
  }

  /** Zgłasza potrzebę przebudowy (debounce). Kolejne zgłoszenia w trakcie budowania = jeden dodatkowy build. */
  request(reason: string): void {
    this.reasons.add(reason.slice(0, 200));
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    if (this.st.state !== 'building') this.st.state = 'scheduled';
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runNow();
    }, Math.max(0, this.opts.debounceMs ?? 400));
    (this.timer as any).unref?.();
  }

  /** Buduje natychmiast (z blokadą — nigdy dwa buildy naraz). Zwraca true przy sukcesie. */
  async runNow(): Promise<boolean> {
    if (this.running) {
      this.rerunRequested = true;
      return this.running;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.running = this.buildOnce().finally(() => {
      this.running = null;
    });
    const ok = await this.running;
    if (this.rerunRequested) {
      this.rerunRequested = false;
      return this.runNow();
    }
    return ok;
  }

  get isBuilding(): boolean {
    return Boolean(this.running);
  }

  private async buildOnce(): Promise<boolean> {
    const reasons = Array.from(this.reasons);
    this.reasons.clear();
    const now = this.opts.now || Date.now;
    const started = now();
    this.st.state = 'building';
    this.opts.onStart?.(reasons);
    const distDir = this.opts.distDir;
    const nextDir = `${distDir}.__next`;
    const prevDir = `${distDir}.__prev`;
    try {
      fsSync.rmSync(nextDir, { recursive: true, force: true });
      const res = await this.opts.runner(nextDir);
      if (!res.ok || !fsSync.existsSync(path.join(nextDir, 'index.html'))) {
        throw new Error(res.output.split('\n').slice(-12).join('\n') || 'Build nie utworzył index.html');
      }
      const newAssets = listAssets(nextDir);
      const buildId = `b${started.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      // Przenieś zasoby poprzedniej wersji (tylko jedno pokolenie wstecz — bez narastania).
      const oldManifest = readManifest(distDir);
      const oldOwn = oldManifest?.assets?.length ? oldManifest.assets : listAssets(distDir);
      for (const name of oldOwn) {
        const src = path.join(distDir, 'assets', name);
        const dst = path.join(nextDir, 'assets', name);
        if (!fsSync.existsSync(dst) && fsSync.existsSync(src)) {
          fsSync.mkdirSync(path.dirname(dst), { recursive: true });
          fsSync.copyFileSync(src, dst);
        }
      }
      fsSync.writeFileSync(
        path.join(nextDir, MANIFEST),
        JSON.stringify({ buildId, builtAt: new Date().toISOString(), assets: newAssets, reasons }, null, 2),
      );
      // Podmiana: dist → dist.__prev, dist.__next → dist (dwie szybkie operacje rename).
      fsSync.rmSync(prevDir, { recursive: true, force: true });
      const hadDist = fsSync.existsSync(distDir);
      if (hadDist) fsSync.renameSync(distDir, prevDir);
      try {
        fsSync.renameSync(nextDir, distDir);
      } catch (err) {
        if (hadDist) fsSync.renameSync(prevDir, distDir);
        throw err;
      }
      fsSync.rmSync(prevDir, { recursive: true, force: true });
      const durationMs = now() - started;
      this.st = {
        ...this.st,
        state: 'idle',
        buildId,
        lastBuildAt: new Date().toISOString(),
        lastDurationMs: durationMs,
        lastError: null,
        builds: this.st.builds + 1,
      };
      this.opts.onBuilt?.(buildId, { durationMs, reasons });
      return true;
    } catch (err) {
      fsSync.rmSync(nextDir, { recursive: true, force: true });
      const message = (err as Error).message || String(err);
      this.st = { ...this.st, state: 'failed', lastError: message.slice(0, 2000), lastBuildAt: new Date().toISOString() };
      this.opts.onFailed?.(message, { reasons });
      return false;
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
