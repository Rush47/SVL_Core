// Tunel wychodzący i sieć mesh (bez stałego IP, bez przekierowania portów — jak Hamachi):
// Obsługuje: auto, Cloudflare Tunnel (Quick + Named, automatyczny fallback QUIC → HTTP/2 TCP:443),
// Tailscale Funnel / WireGuard Mesh, ngrok oraz tunel zwrotny SSH (`ssh-reverse`).
// Dodatkowo wykrywa aktywne interfejsy overlay/mesh (Tailscale 100.64.0.0/10, ZeroTier, WireGuard, Hamachi).

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import dns from 'node:dns/promises';
import os from 'node:os';
import type { TunnelKind } from './config.ts';

export type TunnelState = 'off' | 'waiting_network' | 'starting' | 'up' | 'down';

export interface MeshEndpoint {
  network: 'tailscale' | 'zerotier' | 'wireguard' | 'hamachi';
  iface: string;
  address: string;
  mcpUrl: string;
}

export interface TunnelOptions {
  kind: TunnelKind;
  port: number;
  bin?: string;
  cloudflaredToken?: string; // nazwany tunel Cloudflare (stały adres)
  cloudflaredProtocol?: '' | 'quic' | 'http2';
  sshReverseTarget?: string; // user@relay-host dla trybu ssh-reverse
  sshReverseRemotePort?: number;
  publicUrl?: string; // znany stały adres (nazwany tunel / domena ngrok / Tailscale)
}

export interface TunnelStatus {
  kind: TunnelKind;
  effectiveKind?: Exclude<TunnelKind, 'auto'>;
  state: TunnelState;
  publicUrl: string | null;
  mcpUrl: string | null;
  meshEndpoints?: MeshEndpoint[];
  protocol?: string;
  since: string | null;
  restarts: number;
  lastError: string | null;
}

function isTailscaleCgnatIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return false;
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function isHamachiIpv4(ip: string): boolean {
  return /^25\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip);
}

/** Wykrywa lokalne interfejsy VPN mesh bez stałego IP (Tailscale, ZeroTier, WireGuard, Hamachi). */
export function detectMeshInterfaces(
  port: number,
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): MeshEndpoint[] {
  const found: MeshEndpoint[] = [];
  for (const [iface, addrs] of Object.entries(interfaces || {})) {
    if (!addrs) continue;
    const low = iface.toLowerCase();
    for (const entry of addrs) {
      if (!entry || entry.internal || entry.family !== 'IPv4' || !entry.address) continue;
      let network: MeshEndpoint['network'] | null = null;
      if (low.startsWith('tailscale') || low.startsWith('utun') && isTailscaleCgnatIpv4(entry.address) || isTailscaleCgnatIpv4(entry.address)) {
        network = 'tailscale';
      } else if (low.startsWith('zt')) {
        network = 'zerotier';
      } else if (low.startsWith('wg')) {
        network = 'wireguard';
      } else if (low.startsWith('ham') || isHamachiIpv4(entry.address)) {
        network = 'hamachi';
      }
      if (network) {
        found.push({
          network,
          iface,
          address: entry.address,
          mcpUrl: `http://${entry.address}:${port}/mcp`,
        });
      }
    }
  }
  return found;
}

function defaultHasBinary(bin: string): boolean {
  try {
    const r = spawnSync('which', [bin], { stdio: 'ignore', timeout: 2000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Automatyczny wybór najlepszego transportu bez stałego IP (jak Hamachi):
 * 1. Nazwany tunel Cloudflare (jeśli podano token i jest `cloudflared`),
 * 2. Tailscale Funnel (jeśli `publicUrl` ma `.ts.net` lub jest interfejs Tailscale i brak cloudflared),
 * 3. Cloudflare Quick Tunnel (`cloudflared` — zero konta, zero stałego IP),
 * 4. ngrok,
 * 5. Tunel zwrotny SSH (`ssh-reverse`, jeśli podano `sshReverseTarget`),
 * 6. Domyślnie `cloudflared` (z czytelną instrukcją instalacji).
 */
export function resolveAutoTunnelKind(
  opts: TunnelOptions,
  hasBinary: (bin: string) => boolean = defaultHasBinary,
  meshEndpoints: MeshEndpoint[] = detectMeshInterfaces(opts.port),
): Exclude<TunnelKind, 'auto'> {
  if (opts.kind !== 'auto') return opts.kind;
  const cfBin = opts.bin || 'cloudflared';
  if (opts.cloudflaredToken && hasBinary(cfBin)) return 'cloudflared';
  if (opts.publicUrl && /\.ts\.net/i.test(opts.publicUrl) && hasBinary('tailscale')) return 'tailscale';
  if (hasBinary(cfBin)) return 'cloudflared';
  if (meshEndpoints.some((m) => m.network === 'tailscale') && hasBinary('tailscale')) return 'tailscale';
  if (hasBinary('ngrok')) return 'ngrok';
  if (opts.sshReverseTarget && hasBinary('ssh')) return 'ssh-reverse';
  return 'cloudflared';
}

export function buildTunnelCommand(
  o: TunnelOptions,
  hasBinary: (bin: string) => boolean = defaultHasBinary,
): { bin: string; args: string[]; env: Record<string, string> } | null {
  const effectiveKind = o.kind === 'auto' ? resolveAutoTunnelKind(o, hasBinary) : o.kind;
  const target = `http://127.0.0.1:${o.port}`;
  switch (effectiveKind) {
    case 'cloudflared': {
      const protoArgs = o.cloudflaredProtocol ? ['--protocol', o.cloudflaredProtocol] : [];
      if (o.cloudflaredToken) {
        // Token przez env (nie widać go w `ps`).
        return {
          bin: o.bin || 'cloudflared',
          args: ['tunnel', '--no-autoupdate', ...protoArgs, 'run'],
          env: { TUNNEL_TOKEN: o.cloudflaredToken },
        };
      }
      return {
        bin: o.bin || 'cloudflared',
        args: ['tunnel', '--no-autoupdate', ...protoArgs, '--url', target],
        env: {},
      };
    }
    case 'ngrok':
      return {
        bin: o.bin || 'ngrok',
        args: ['http', String(o.port), '--log', 'stdout', '--log-format', 'json', ...(o.publicUrl ? ['--url', o.publicUrl] : [])],
        env: {},
      };
    case 'tailscale':
      // Tailscale Funnel: stały adres https://<host>.<tailnet>.ts.net (wymaga zalogowanego tailscaled).
      return { bin: o.bin || 'tailscale', args: ['funnel', String(o.port)], env: {} };
    case 'ssh-reverse': {
      const relayTarget = String(o.sshReverseTarget || '').trim();
      if (!relayTarget) return null;
      const remotePort = o.sshReverseRemotePort || o.port;
      return {
        bin: o.bin || 'ssh',
        args: [
          '-NT',
          '-o', 'BatchMode=yes',
          '-o', 'ExitOnForwardFailure=yes',
          '-o', 'ServerAliveInterval=15',
          '-o', 'ServerAliveCountMax=3',
          '-R', `0.0.0.0:${remotePort}:127.0.0.1:${o.port}`,
          relayTarget,
        ],
        env: {},
      };
    }
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
    'ssh-reverse': /https?:\/\/[a-z0-9.-]+(?::\d+)?/i,
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
  private forceCloudflaredHttp2 = false;
  readonly status: TunnelStatus;

  constructor(
    private readonly opts: TunnelOptions,
    private readonly events: {
      onUrl?: (status: TunnelStatus) => void;
      onLog?: (level: 'INFO' | 'WARN' | 'ERROR', message: string) => void;
    } = {},
    private readonly deps: {
      hasInternet?: () => Promise<boolean>;
      fetchImpl?: typeof fetch;
      spawnImpl?: typeof spawn;
      hasBinary?: (bin: string) => boolean;
      detectMesh?: (port: number) => MeshEndpoint[];
    } = {},
  ) {
    const meshEndpoints = (deps.detectMesh || detectMeshInterfaces)(opts.port);
    const effectiveKind = opts.kind === 'auto'
      ? resolveAutoTunnelKind(opts, deps.hasBinary || defaultHasBinary, meshEndpoints)
      : opts.kind;
    this.status = {
      kind: opts.kind,
      effectiveKind,
      state: opts.kind === 'none' ? 'off' : 'waiting_network',
      publicUrl: opts.publicUrl || null,
      mcpUrl: opts.publicUrl ? `${opts.publicUrl}/mcp` : null,
      meshEndpoints,
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
    this.status.meshEndpoints = (this.deps.detectMesh || detectMeshInterfaces)(this.opts.port);
    const online = await (this.deps.hasInternet || hasInternet)();
    if (!online) {
      this.status.state = 'waiting_network';
      this.schedule(10_000);
      return;
    }
    const effectiveKind = this.opts.kind === 'auto'
      ? resolveAutoTunnelKind(this.opts, this.deps.hasBinary || defaultHasBinary, this.status.meshEndpoints)
      : this.opts.kind;
    this.status.effectiveKind = effectiveKind;
    const protocol = effectiveKind === 'cloudflared'
      ? (this.opts.cloudflaredProtocol || (this.forceCloudflaredHttp2 ? 'http2' : ''))
      : '';
    this.status.protocol = protocol || (effectiveKind === 'cloudflared' ? 'auto' : effectiveKind);

    const cmd = buildTunnelCommand(
      { ...this.opts, kind: effectiveKind, cloudflaredProtocol: protocol },
      this.deps.hasBinary || defaultHasBinary,
    );
    if (!cmd) {
      if (effectiveKind === 'ssh-reverse') {
        this.fail('Tryb ssh-reverse wymaga ustawienia MCP_SSH_REVERSE_TARGET (np. user@vps.example.com).');
      }
      return;
    }
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
    // „up” dopiero po „Registered tunnel connection”. Brak rejestracji w 90 s → restart z fallbackiem HTTP/2 (TCP 443).
    const needsRegistration = effectiveKind === 'cloudflared';
    let pendingUrl: string | null = null;
    let registered = !needsRegistration;
    const regTimer = needsRegistration
      ? setTimeout(() => {
          if (this.proc === child && !registered) {
            this.forceCloudflaredHttp2 = !this.forceCloudflaredHttp2;
            this.status.lastError =
              'cloudflared nie połączył się z Cloudflare w 90 s (zablokowany port 7844 TCP/UDP?) — przełączam protokół na HTTP/2.';
            child.kill('SIGTERM');
          }
        }, 90_000)
      : null;
    regTimer?.unref?.();
    const onData = (buf: Buffer) => {
      for (const line of buf.toString('utf8').split('\n')) {
        const url = parseTunnelUrl(effectiveKind, line);
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
    // Tailscale lub ssh-reverse ze stałym adresem: nie zawsze drukuje URL — uznaj za gotowy po starcie procesu.
    if (this.opts.publicUrl && (effectiveKind === 'tailscale' || effectiveKind === 'ssh-reverse')) {
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
      this.fail(`Tunel ${effectiveKind} zakończył się (kod ${code ?? signal}).`);
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

  /** Watchdog: sprawdza publiczny adres; po 3 nieudanych próbach restartuje tunel (np. zerwane łącze lub zmiana IP). */
  async checkHealth(): Promise<void> {
    this.status.meshEndpoints = (this.deps.detectMesh || detectMeshInterfaces)(this.opts.port);
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
