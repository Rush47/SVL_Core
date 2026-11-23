// Tunel wychodzący: serwer MCP osiągalny z internetu bez stałego IP i bez własnej domeny.
// Domyślnie Cloudflare Quick Tunnel (bez konta): adres https://<losowy>.trycloudflare.com.
// Tunel startuje, gdy jest sieć, i jest restartowany po zerwaniu (backoff + watchdog).

import { spawn, type ChildProcess } from 'node:child_process';
import dns from 'node:dns/promises';
import type { TunnelKind } from './config.ts';

export type TunnelState = 'off' | 'waiting_network' | 'starting' | 'up' | 'down';

export interface TunnelOptions {
  kind: TunnelKind;
  port: number;
  bin?: string;
  cloudflaredToken?: string; // nazwany tunel Cloudflare (stały adres)
  publicUrl?: string; // znany stały adres (nazwany tunel / domena ngrok)
}

export interface TunnelStatus {
  kind: TunnelKind;
  state: TunnelState;
  publicUrl: string | null;
  mcpUrl: string | null;
  since: string | null;
  restarts: number;
  lastError: string | null;
}

export function buildTunnelCommand(o: TunnelOptions): { bin: string; args: string[]; env: Record<string, string> } | null {
  const target = `http://127.0.0.1:${o.port}`;
  switch (o.kind) {
    case 'cloudflared':
      if (o.cloudflaredToken) {
        // Token przez env (nie widać go w `ps`).
        return { bin: o.bin || 'cloudflared', args: ['tunnel', '--no-autoupdate', 'run'], env: { TUNNEL_TOKEN: o.cloudflaredToken } };
      }
      return { bin: o.bin || 'cloudflared', args: ['tunnel', '--no-autoupdate', '--url', target], env: {} };
    case 'ngrok':
      return {
        bin: o.bin || 'ngrok',
        args: ['http', String(o.port), '--log', 'stdout', '--log-format', 'json', ...(o.publicUrl ? ['--url', o.publicUrl] : [])],
        env: {},
      };
    case 'tailscale':
      // Tailscale Funnel: stały adres https://<host>.<tailnet>.ts.net (wymaga zalogowanego tailscaled).
      return { bin: o.bin || 'tailscale', args: ['funnel', String(o.port)], env: {} };
    default:
      return null;
  }
}

/** Wyciąga publiczny adres https z linii wyjścia narzędzia tunelu. */
export function parseTunnelUrl(kind: TunnelKind, line: string): string | null {
  const patterns: Record<string, RegExp> = {
    cloudflared: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i,
    ngrok: /"url":"(https:\/\/[^"]+)"/i,
    tailscale: /https:\/\/[a-z0-9.-]+\.ts\.net/i,
  };
  const re = patterns[kind];
  if (!re) return null;
  const m = re.exec(line);
  if (!m) return null;
  return (m[1] || m[0]).replace(/\/+$/, '');
}

/** cloudflared: linia potwierdzająca połączenie z krawędzią Cloudflare. */
export function isRegisteredLine(line: string): boolean {
  return /Registered tunnel connection/i.test(line);
}

export function restartDelayMs(attempt: number): number {
  return Math.min(60_000, 2_000 * 2 ** Math.max(0, Math.min(attempt, 5)));
}

export async function hasInternet(lookup: (h: string) => Promise<unknown> = (h) => dns.lookup(h)): Promise<boolean> {
  for (const host of ['api.trycloudflare.com', 'one.one.one.one', 'dns.google']) {
    try {
      await lookup(host);
      return true;
    } catch {
      // następny
    }
  }
  return false;
}

export class TunnelManager {
  private proc: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private failedChecks = 0;
  private stopped = false;
  private attempt = 0;
  readonly status: TunnelStatus;

  constructor(
    private readonly opts: TunnelOptions,
    private readonly events: {
      onUrl?: (status: TunnelStatus) => void;
      onLog?: (level: 'INFO' | 'WARN' | 'ERROR', message: string) => void;
    } = {},
    private readonly deps: { hasInternet?: () => Promise<boolean>; fetchImpl?: typeof fetch; spawnImpl?: typeof spawn } = {},
  ) {
    this.status = {
      kind: opts.kind,
      state: opts.kind === 'none' ? 'off' : 'waiting_network',
      publicUrl: opts.publicUrl || null,
      mcpUrl: opts.publicUrl ? `${opts.publicUrl}/mcp` : null,
      since: null,
      restarts: 0,
      lastError: null,
    };
  }

  start(): void {
    if (this.opts.kind === 'none') return;
    this.stopped = false;
    void this.launch();
    this.watchdog = setInterval(() => void this.checkHealth(), 60_000);
    this.watchdog.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.proc?.kill('SIGTERM');
    this.proc = null;
  }

  private schedule(delay: number): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.launch();
    }, delay);
    this.timer.unref?.();
  }

  private setUrl(url: string): void {
    this.status.publicUrl = url;
    this.status.mcpUrl = `${url}/mcp`;
    this.status.state = 'up';
    this.status.since = new Date().toISOString();
    this.status.lastError = null;
    this.attempt = 0;
    this.failedChecks = 0;
    this.events.onUrl?.({ ...this.status });
  }

  private async launch(): Promise<void> {
    if (this.stopped || this.proc) return;
    const online = await (this.deps.hasInternet || hasInternet)();
    if (!online) {
      this.status.state = 'waiting_network';
      this.schedule(10_000);
      return;
    }
    const cmd = buildTunnelCommand(this.opts);
    if (!cmd) return;
    this.status.state = 'starting';
    let child: ChildProcess;
    try {
      child = (this.deps.spawnImpl || spawn)(cmd.bin, cmd.args, { env: { ...process.env, ...cmd.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      return;
    }
    this.proc = child;
    // cloudflared drukuje adres zanim połączenie z krawędzią Cloudflare jest gotowe —
    // „up” dopiero po „Registered tunnel connection”. Brak rejestracji w 90 s → restart.
    const needsRegistration = this.opts.kind === 'cloudflared';
    let pendingUrl: string | null = null;
    let registered = !needsRegistration;
    const regTimer = needsRegistration
      ? setTimeout(() => {
          if (this.proc === child && !registered) {
            this.status.lastError = 'cloudflared nie połączył się z Cloudflare w 90 s (zablokowany port 7844 TCP/UDP?).';
            child.kill('SIGTERM');
          }
        }, 90_000)
      : null;
    regTimer?.unref?.();
    const onData = (buf: Buffer) => {
      for (const line of buf.toString('utf8').split('\n')) {
        const url = parseTunnelUrl(this.opts.kind, line);
        if (url) {
          pendingUrl = url;
          this.status.publicUrl = url;
          this.status.mcpUrl = `${url}/mcp`;
        }
        if (needsRegistration && isRegisteredLine(line)) {
          registered = true;
          if (regTimer) clearTimeout(regTimer);
        }
        const finalUrl = pendingUrl || (registered ? this.opts.publicUrl || null : null);
        if (registered && finalUrl && (this.status.state !== 'up' || this.status.since === null)) this.setUrl(finalUrl);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    // Tailscale ze stałym adresem: nie zawsze drukuje URL — uznaj za gotowy po starcie procesu.
    if (this.opts.publicUrl && this.opts.kind === 'tailscale') {
      setTimeout(() => this.proc === child && this.status.state === 'starting' && this.setUrl(this.opts.publicUrl!), 5_000).unref?.();
    }
    child.on('error', (e: NodeJS.ErrnoException) => {
      const msg = e.code === 'ENOENT' ? `Brak programu „${cmd.bin}” — zainstaluj go (deploy/MCP.md).` : e.message;
      if (this.proc === child) this.proc = null;
      this.fail(msg);
    });
    child.on('exit', (code, signal) => {
      if (regTimer) clearTimeout(regTimer);
      if (this.proc !== child) return;
      this.proc = null;
      this.fail(`Tunel ${this.opts.kind} zakończył się (kod ${code ?? signal}).`);
    });
  }

  private fail(message: string): void {
    this.status.state = 'down';
    this.status.since = null;
    this.status.lastError = this.status.lastError && /90 s/.test(this.status.lastError) ? `${this.status.lastError} ${message}` : message;
    this.status.restarts += 1;
    this.events.onLog?.('WARN', message);
    if (!this.stopped) this.schedule(restartDelayMs(this.attempt++));
  }

  /** Watchdog: sprawdza publiczny adres; po 3 nieudanych próbach restartuje tunel (np. zerwane łącze). */
  async checkHealth(): Promise<void> {
    if (this.stopped || this.status.state !== 'up' || !this.status.publicUrl) return;
    let ok = false;
    try {
      const res = await (this.deps.fetchImpl || fetch)(`${this.status.publicUrl}/healthz`, { signal: AbortSignal.timeout(15_000) });
      ok = res.ok;
    } catch {
      ok = false;
    }
    if (ok) {
      this.failedChecks = 0;
      return;
    }
    this.failedChecks += 1;
    if (this.failedChecks >= 3) {
      this.failedChecks = 0;
      this.events.onLog?.('WARN', 'Publiczny adres tunelu nie odpowiada — restart tunelu.');
      this.proc?.kill('SIGTERM'); // exit → fail() → restart z backoffem
    }
  }
}
