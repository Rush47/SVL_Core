// Konfiguracja samodzielnego serwera MCP SVL (pełny odczyt/zapis + tunel wychodzący).
// Wszystko z env (.env / systemd EnvironmentFile); brak ustawień = bezpieczne wartości domyślne.

import path from 'node:path';

export type TunnelKind = 'cloudflared' | 'ngrok' | 'tailscale' | 'none';

export interface McpConfig {
  host: string;
  port: number;
  root: string;
  token: string; // pusty = wygeneruj / wczytaj z tokenFile
  tokenFile: string;
  stateFile: string; // aktualny publiczny adres tunelu (JSON, bez tokenu)
  connectorFile: string; // gotowe dane konektora (z tokenem) — plik 0600
  readOnly: boolean;
  allowShell: boolean;
  allowUrlToken: boolean;
  shellTimeoutMs: number;
  maxReadBytes: number;
  tunnel: TunnelKind;
  tunnelBin: string;
  cloudflaredTunnelToken: string; // nazwany tunel Cloudflare (stały adres)
  publicUrlOverride: string; // np. stały adres nazwanego tunelu / Tailscale
  svlBaseUrl: string;
  svlOperatorToken: string;
  logDir: string;
}

const truthy = (v: unknown) => /^(1|true|yes|on|tak)$/i.test(String(v ?? '').trim());
const falsy = (v: unknown) => /^(0|false|no|off|nie)$/i.test(String(v ?? '').trim());

function int(v: unknown, def: number, min: number, max: number): number {
  const n = Number.parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

export function parseTunnelKind(v: unknown): TunnelKind {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === '' || s === 'cloudflared' || s === 'cloudflare') return 'cloudflared';
  if (s === 'ngrok') return 'ngrok';
  if (s === 'tailscale' || s === 'funnel') return 'tailscale';
  if (s === 'none' || s === 'off' || s === '0' || s === 'false') return 'none';
  throw new Error(`MCP_TUNNEL: nieznana wartość "${s}" (dozwolone: cloudflared | ngrok | tailscale | none)`);
}

export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): McpConfig {
  const dataDir = path.resolve(cwd, 'data');
  const readOnly = truthy(env.MCP_READ_ONLY);
  // Powłoka jest domyślnie włączona (pełny zapis), ale zawsze wyłączona w trybie tylko do odczytu.
  const allowShell = !readOnly && !falsy(env.MCP_ALLOW_SHELL);
  const tunnel = parseTunnelKind(env.MCP_TUNNEL);
  return {
    host: String(env.MCP_HOST || '127.0.0.1').trim(),
    port: int(env.MCP_PORT, 3334, 1, 65535),
    root: path.resolve(cwd, String(env.MCP_ROOT || cwd).trim()),
    token: String(env.MCP_TOKEN || '').trim(),
    tokenFile: path.resolve(cwd, String(env.MCP_TOKEN_FILE || path.join(dataDir, 'svl_mcp_token.secret'))),
    stateFile: path.resolve(cwd, String(env.MCP_STATE_FILE || path.join(dataDir, 'svl_mcp_tunnel.json'))),
    connectorFile: path.resolve(cwd, String(env.MCP_CONNECTOR_FILE || path.join(dataDir, 'svl_mcp_connector.secret'))),
    readOnly,
    allowShell,
    allowUrlToken: !falsy(env.MCP_ALLOW_URL_TOKEN),
    shellTimeoutMs: int(env.MCP_SHELL_TIMEOUT_MS, 120_000, 1_000, 3_600_000),
    maxReadBytes: int(env.MCP_MAX_READ_BYTES, 2_000_000, 1_024, 100_000_000),
    tunnel,
    tunnelBin: String(env.MCP_TUNNEL_BIN || '').trim(),
    cloudflaredTunnelToken: String(env.MCP_CLOUDFLARED_TOKEN || '').trim(),
    publicUrlOverride: String(env.MCP_PUBLIC_URL || '').trim().replace(/\/+$/, ''),
    svlBaseUrl: String(env.SVL_BASE_URL || `http://127.0.0.1:${env.PORT || 3000}`).trim().replace(/\/+$/, ''),
    svlOperatorToken: String(env.SVL_OPERATOR_TOKEN || '').trim(),
    logDir: String(env.SVL_LOG_DIR || path.resolve(cwd, 'logi')),
  };
}
