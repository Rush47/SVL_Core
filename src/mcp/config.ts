// Konfiguracja samodzielnego serwera MCP SVL (pełny odczyt/zapis + tunel wychodzący).
// Wszystko z env (.env / systemd EnvironmentFile); brak ustawień = bezpieczne wartości domyślne.

import os from 'node:os';
import path from 'node:path';

export type TunnelKind = 'auto' | 'cloudflared' | 'ngrok' | 'tailscale' | 'ssh-reverse' | 'none';

export interface McpConfig {
  host: string;
  port: number;
  root: string;
  nodeName: string;
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
  cloudflaredProtocol: '' | 'quic' | 'http2';
  sshReverseTarget: string; // np. user@relay.example.com (tunel zwrotny SSH)
  sshReverseRemotePort: number;
  publicUrlOverride: string; // np. stały adres nazwanego tunelu / Tailscale
  svlBaseUrl: string;
  svlOperatorToken: string;
  ollamaHost: string;
  comfyuiHost: string;
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
  if (s === 'auto' || s === 'zero-ip' || s === 'mesh') return 'auto';
  if (s === 'ngrok') return 'ngrok';
  if (s === 'tailscale' || s === 'funnel') return 'tailscale';
  if (s === 'ssh-reverse' || s === 'reverse-ssh' || s === 'ssh') return 'ssh-reverse';
  if (s === 'none' || s === 'off' || s === '0' || s === 'false') return 'none';
  throw new Error(`MCP_TUNNEL: nieznana wartość "${s}" (dozwolone: auto | cloudflared | tailscale | ngrok | ssh-reverse | none)`);
}

function parseCloudflaredProtocol(v: unknown): '' | 'quic' | 'http2' {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'http2' || s === 'tcp') return 'http2';
  if (s === 'quic' || s === 'udp') return 'quic';
  return '';
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
    nodeName: String(env.MCP_NODE_NAME || os.hostname() || 'svl-node').trim(),
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
    cloudflaredProtocol: parseCloudflaredProtocol(env.MCP_CLOUDFLARED_PROTOCOL),
    sshReverseTarget: String(env.MCP_SSH_REVERSE_TARGET || '').trim(),
    sshReverseRemotePort: int(env.MCP_SSH_REVERSE_PORT, 3334, 1, 65535),
    publicUrlOverride: String(env.MCP_PUBLIC_URL || '').trim().replace(/\/+$/, ''),
    svlBaseUrl: String(env.SVL_BASE_URL || `http://127.0.0.1:${env.PORT || 3000}`).trim().replace(/\/+$/, ''),
    svlOperatorToken: String(env.SVL_OPERATOR_TOKEN || '').trim(),
    ollamaHost: String(env.OLLAMA_HOST || 'http://127.0.0.1:11434').trim().replace(/\/+$/, ''),
    comfyuiHost: String(env.COMFYUI_HOST || 'http://127.0.0.1:8188').trim().replace(/\/+$/, ''),
    logDir: String(env.SVL_LOG_DIR || path.resolve(cwd, 'logi')),
  };
}
