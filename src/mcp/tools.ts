// Uniwersalny serwer MCP SVL (Universal MCP Hub): pełny odczyt/zapis plików w MCP_ROOT, powłoka,
// zarządzanie wszystkimi usługami systemu SVL (brama, jądro Python, Ollama lokalna + SVL-364,
// ComfyUI, terminale, czat, pamięć 128D, GitHub, antywirus, raporty, mostek SSH/MCP statku SVL-364,
// tunele zero-IP/mesh, zasoby MCP oraz prompty operacyjne).
// Handlery są zwykłymi funkcjami (łatwe testy); createFullMcpServer() rejestruje je w SDK MCP.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { resolveInRoot, toRootRelative } from './pathGuard.ts';
import { readLogTail } from '../server/svlMcpServer.ts';

export interface ToolContext {
  root: string;
  readOnly: boolean;
  allowShell: boolean;
  shellTimeoutMs: number;
  maxReadBytes: number;
  svlBaseUrl: string;
  svlOperatorToken: string;
  logDir: string;
  nodeName?: string;
  ollamaHost?: string;
  comfyuiHost?: string;
  getStatus?: () => unknown;
  fetchImpl?: typeof fetch;
}

export const SVL_KNOWN_SERVICES = [
  'svl-coreos2.service',
  'svl-python-os.service',
  'svl-gateway.service',
  'svl-sentinel.service',
  'svl-mcp.service',
  'svl-comfyui.service',
  'svl-ship-ollama-tunnel.service',
  'ollama.service',
  'tailscaled.service',
  'cloudflared.service',
  'docker.service',
  'ssh.service',
] as const;

const CHAT_AGENTS = ['Jyn', 'SI_Sphere', 'JEDI_Omni_OS'] as const;
const CHAT_CHANNELS: Record<string, string> = {
  wszyscy: 'conv-rodzina-mitek-wszyscy',
  jyn: 'conv-ai-jyn-20261125',
  svl364_root: 'conv-svl364-mcp-root',
  svl364: 'conv-svl364-mcp-root',
  si_sphere: 'conv-ai-si-sphere-20261125',
  jedi: 'conv-jedi-omni-os',
};
const TERMINALS = ['linux', 'python', 'ssh', 'github', 'hyperspace', 'agents'] as const;

type Args = Record<string, any>;
type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

export class ReadOnlyError extends Error {
  constructor(tool: string) {
    super(`Tryb tylko do odczytu (MCP_READ_ONLY=1): narzędzie ${tool} jest zablokowane.`);
    this.name = 'ReadOnlyError';
  }
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', 'venv']);
const MAX_OUTPUT = 200_000;

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object' as const,
  properties,
  required,
  additionalProperties: false,
});
const S = (description: string) => ({ type: 'string', description });
const N = (description: string) => ({ type: 'number', description });
const B = (description: string) => ({ type: 'boolean', description });

interface ToolDef {
  name: string;
  description: string;
  inputSchema: ReturnType<typeof obj>;
  write: boolean; // true = modyfikuje system (blokowane w trybie read-only)
  handler: (ctx: ToolContext, args: Args) => Promise<string>;
}

function clip(text: string, max = MAX_OUTPUT): string {
  return text.length > max ? `${text.slice(0, max)}\n… [obcięto ${text.length - max} znaków]` : text;
}

async function callSvlApi(
  ctx: ToolContext,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  apiPath: string,
  body?: unknown,
  timeoutMs = 60_000,
): Promise<any> {
  const res = await (ctx.fetchImpl || fetch)(`${ctx.svlBaseUrl}${apiPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-SVL-Origin': 'mcp-full',
      ...(ctx.svlOperatorToken ? { 'X-SVL-Operator-Token': ctx.svlOperatorToken } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    // odpowiedź tekstowa
  }
  if (!res.ok || (data && typeof data === 'object' && data.ok === false)) {
    const err = (data && typeof data === 'object' && (data.error || data.summary)) || `HTTP ${res.status}`;
    throw new Error(`SVL ${apiPath} HTTP ${res.status}: ${String(err).slice(0, 600)}`);
  }
  return data;
}

async function probeHttpService(fetchImpl: typeof fetch, url: string, timeoutMs = 4000): Promise<{ reachable: boolean; status?: number; error?: string }> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { reachable: res.ok || res.status < 500, status: res.status };
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function readFileTool(ctx: ToolContext, a: Args): Promise<string> {
  const p = await resolveInRoot(ctx.root, a.path);
  const stat = await fs.stat(p);
  if (stat.isDirectory()) throw new Error(`${a.path} jest katalogiem — użyj list_dir.`);
  if (stat.size > ctx.maxReadBytes) throw new Error(`Plik ma ${stat.size} B (limit MCP_MAX_READ_BYTES=${ctx.maxReadBytes}).`);
  const buf = await fs.readFile(p);
  if (a.encoding === 'base64') return buf.toString('base64');
  let text = buf.toString('utf8');
  const offset = Math.max(1, Number(a.offset) || 1);
  const limit = Number(a.limit) > 0 ? Number(a.limit) : 0;
  if (offset > 1 || limit) {
    const lines = text.split('\n');
    text = lines.slice(offset - 1, limit ? offset - 1 + limit : undefined).join('\n');
  }
  return clip(text);
}

async function listDirTool(ctx: ToolContext, a: Args): Promise<string> {
  const base = await resolveInRoot(ctx.root, a.path);
  const depth = Math.max(1, Math.min(10, Number(a.depth) || 1));
  const out: string[] = [];
  const walk = async (dir: string, level: number) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((x, y) => x.name.localeCompare(y.name));
    for (const e of entries) {
      if (out.length >= 5000) return;
      if (!a.all && e.name.startsWith('.') && e.name !== '.env.example') continue;
      const full = path.join(dir, e.name);
      const rel = toRootRelative(ctx.root, full);
      if (e.isDirectory()) {
        out.push(`${rel}/`);
        if (level < depth && !SKIP_DIRS.has(e.name)) await walk(full, level + 1);
      } else {
        let size = '';
        try {
          size = ` (${(await fs.stat(full)).size} B)`;
        } catch {
          // zerwany symlink
        }
        out.push(`${rel}${size}`);
      }
    }
  };
  await walk(base, 1);
  return out.join('\n') || '(pusty katalog)';
}

async function searchTool(ctx: ToolContext, a: Args): Promise<string> {
  const base = await resolveInRoot(ctx.root, a.path);
  const query = String(a.query || '');
  if (!query) throw new Error('Brak query.');
  const re = a.regex ? new RegExp(query, a.case_sensitive ? '' : 'i') : null;
  const needle = a.case_sensitive ? query : query.toLowerCase();
  const nameRe = a.glob ? globToRegExp(String(a.glob)) : null;
  const max = Math.max(1, Math.min(2000, Number(a.max_results) || 200));
  const hits: string[] = [];
  const matches = (s: string) => (re ? re.test(s) : (a.case_sensitive ? s : s.toLowerCase()).includes(needle));
  const walk = async (dir: string) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (hits.length >= max) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(full);
        continue;
      }
      if (!e.isFile() || (nameRe && !nameRe.test(e.name))) continue;
      const rel = toRootRelative(ctx.root, full);
      if (a.names_only) {
        if (matches(e.name)) hits.push(rel);
        continue;
      }
      let st;
      try {
        st = await fs.stat(full);
      } catch {
        continue;
      }
      if (st.size > 2_000_000) continue;
      const buf = await fs.readFile(full);
      if (buf.includes(0)) continue; // binarny
      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length && hits.length < max; i++) {
        if (matches(lines[i])) hits.push(`${rel}:${i + 1}: ${lines[i].slice(0, 300)}`);
      }
    }
  };
  const st = await fs.stat(base);
  if (st.isDirectory()) await walk(base);
  else {
    const lines = (await fs.readFile(base, 'utf8')).split('\n');
    lines.forEach((l, i) => matches(l) && hits.length < max && hits.push(`${toRootRelative(ctx.root, base)}:${i + 1}: ${l.slice(0, 300)}`));
  }
  return hits.length ? hits.join('\n') : '(brak wyników)';
}

export function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

async function writeFileTool(ctx: ToolContext, a: Args): Promise<string> {
  const p = await resolveInRoot(ctx.root, a.path);
  if (typeof a.content !== 'string') throw new Error('Brak content.');
  try {
    if ((await fs.stat(p)).isDirectory()) throw new Error(`${a.path} jest katalogiem.`);
    if (a.create_only) throw new Error(`Plik ${a.path} już istnieje (create_only).`);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await fs.mkdir(path.dirname(p), { recursive: true });
  const data = a.encoding === 'base64' ? Buffer.from(a.content, 'base64') : a.content;
  if (a.append) await fs.appendFile(p, data);
  else await fs.writeFile(p, data);
  const size = (await fs.stat(p)).size;
  return `${a.append ? 'Dopisano do' : 'Zapisano'} ${toRootRelative(ctx.root, p)} (${size} B).`;
}

async function editFileTool(ctx: ToolContext, a: Args): Promise<string> {
  const p = await resolveInRoot(ctx.root, a.path);
  const oldStr = String(a.old_string ?? '');
  const newStr = String(a.new_string ?? '');
  if (!oldStr) throw new Error('old_string nie może być pusty.');
  const text = await fs.readFile(p, 'utf8');
  const count = text.split(oldStr).length - 1;
  if (count === 0) throw new Error('Nie znaleziono old_string w pliku.');
  if (count > 1 && !a.replace_all) throw new Error(`old_string występuje ${count} razy — doprecyzuj albo ustaw replace_all.`);
  const next = a.replace_all ? text.split(oldStr).join(newStr) : text.replace(oldStr, () => newStr);
  await fs.writeFile(p, next);
  return `Zmieniono ${toRootRelative(ctx.root, p)} (${a.replace_all ? count : 1} zamian).`;
}

async function deleteTool(ctx: ToolContext, a: Args): Promise<string> {
  const p = await resolveInRoot(ctx.root, a.path);
  if (p === (await fs.realpath(ctx.root))) throw new Error('Nie można usunąć katalogu głównego MCP_ROOT.');
  const st = await fs.lstat(p);
  if (st.isDirectory() && !a.recursive) {
    await fs.rmdir(p);
  } else {
    await fs.rm(p, { recursive: Boolean(a.recursive), force: false });
  }
  return `Usunięto ${toRootRelative(ctx.root, p)}.`;
}

async function moveTool(ctx: ToolContext, a: Args): Promise<string> {
  const from = await resolveInRoot(ctx.root, a.from);
  const to = await resolveInRoot(ctx.root, a.to);
  if (!a.overwrite) {
    try {
      await fs.access(to);
      throw new Error(`Cel ${a.to} istnieje (ustaw overwrite).`);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  await fs.mkdir(path.dirname(to), { recursive: true });
  if (a.copy) await fs.cp(from, to, { recursive: true, force: Boolean(a.overwrite) });
  else await fs.rename(from, to);
  return `${a.copy ? 'Skopiowano' : 'Przeniesiono'} ${toRootRelative(ctx.root, from)} → ${toRootRelative(ctx.root, to)}.`;
}

async function mkdirTool(ctx: ToolContext, a: Args): Promise<string> {
  const p = await resolveInRoot(ctx.root, a.path);
  await fs.mkdir(p, { recursive: true });
  return `Utworzono katalog ${toRootRelative(ctx.root, p)}.`;
}

async function statTool(ctx: ToolContext, a: Args): Promise<string> {
  const p = await resolveInRoot(ctx.root, a.path);
  const st = await fs.lstat(p);
  return JSON.stringify(
    {
      path: toRootRelative(ctx.root, p),
      type: st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : 'other',
      size: st.size,
      mode: (st.mode & 0o7777).toString(8),
      modified: st.mtime.toISOString(),
    },
    null,
    2,
  );
}

export function runShell(command: string, cwd: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-lc', command], { cwd, env: process.env, detached: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = (s: string, d: Buffer) => (s.length < MAX_OUTPUT ? s + d.toString('utf8') : s);
    child.stdout.on('data', (d: Buffer) => (stdout = cap(stdout, d)));
    child.stderr.on('data', (d: Buffer) => (stderr = cap(stderr, d)));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, 'SIGKILL'); // cała grupa procesów
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${e.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: clip(stdout), stderr: clip(stderr), timedOut });
    });
  });
}

async function shellTool(ctx: ToolContext, a: Args): Promise<string> {
  if (!ctx.allowShell) throw new Error('Powłoka wyłączona (MCP_ALLOW_SHELL=0 albo MCP_READ_ONLY=1).');
  const command = String(a.command || '').trim();
  if (!command) throw new Error('Brak command.');
  const cwd = await resolveInRoot(ctx.root, a.cwd);
  const timeout = Math.max(1000, Math.min(ctx.shellTimeoutMs, Number(a.timeout_ms) || ctx.shellTimeoutMs));
  const r = await runShell(command, cwd, timeout);
  return [
    `exit_code: ${r.code}${r.timedOut ? ` (przerwano po ${timeout} ms)` : ''}`,
    r.stdout ? `--- stdout ---\n${r.stdout}` : '',
    r.stderr ? `--- stderr ---\n${r.stderr}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

async function svlChatTool(ctx: ToolContext, a: Args): Promise<string> {
  const message = String(a.message || '').slice(0, 8000);
  if (!message) throw new Error('Brak message.');
  const rawAgent = String(a.agent || 'Jyn').trim();
  const agent = CHAT_AGENTS.includes(rawAgent as any) ? rawAgent : 'Jyn';
  const channelKey = String(a.channel || '').trim().toLowerCase();
  const conversationId = channelKey ? (CHAT_CHANNELS[channelKey] || undefined) : undefined;
  const res = await (ctx.fetchImpl || fetch)(`${ctx.svlBaseUrl}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-SVL-Origin': 'mcp-full',
      ...(ctx.svlOperatorToken ? { 'X-SVL-Operator-Token': ctx.svlOperatorToken } : {}),
    },
    body: JSON.stringify({
      message,
      targetAgent: agent,
      ...(conversationId ? { conversationId } : {}),
      origin: 'mcp-full',
      history: [],
    }),
    signal: AbortSignal.timeout(240_000),
  });
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    // tekst
  }
  if (!res.ok) throw new Error(`SVL /api/chat HTTP ${res.status}: ${String(data?.error || text).slice(0, 500)}`);
  return `${data.sender || agent} [${data.modelUsed || '?'}]\n\n${data.reply ?? text}`;
}

async function svlStatusTool(ctx: ToolContext): Promise<string> {
  const [health, github, ollamaRouter] = await Promise.all([
    callSvlApi(ctx, 'GET', '/api/py/health').catch((e) => ({ error: String(e.message || e) })),
    callSvlApi(ctx, 'GET', '/api/github/status?fetch=0').catch((e) => ({ error: String(e.message || e) })),
    callSvlApi(ctx, 'GET', '/api/ollama/router').catch((e) => ({ error: String(e.message || e) })),
  ]);
  return JSON.stringify(
    {
      node: ctx.nodeName || os.hostname(),
      mcp: ctx.getStatus ? ctx.getStatus() : undefined,
      kernel: health?.error ? health : { serverRevision: health.serverRevision, version: health.version || health.kernel_version },
      ollama: ollamaRouter?.error
        ? (health?.ollama || ollamaRouter)
        : ollamaRouter,
      modules: Array.isArray(health?.system_modules)
        ? health.system_modules.map((m: any) => `${m.id} (${m.status})`)
        : [],
      github: github?.error
        ? github
        : { repository: github.repository, branch: github.branch, tokenValid: github.token?.valid, sync: github.sync },
    },
    null,
    2,
  );
}

async function svlServicesStatusTool(ctx: ToolContext, a: Args): Promise<string> {
  const fetchImpl = ctx.fetchImpl || fetch;
  const ollamaUrl = ctx.ollamaHost || 'http://127.0.0.1:11434';
  const comfyUrl = ctx.comfyuiHost || 'http://127.0.0.1:8188';
  const [gateway, ollama, comfyui] = await Promise.all([
    probeHttpService(fetchImpl, `${ctx.svlBaseUrl}/api/health`),
    probeHttpService(fetchImpl, `${ollamaUrl}/api/version`),
    probeHttpService(fetchImpl, `${comfyUrl}/system_stats`),
  ]);
  const units = Array.isArray(a.services) && a.services.length > 0
    ? a.services.map((s: unknown) => String(s).trim()).filter((s: string) => /^[A-Za-z0-9_.@-]{1,128}$/.test(s))
    : [...SVL_KNOWN_SERVICES];
  let systemdStates: Record<string, string> = {};
  if (!a.skip_systemd) {
    const quoted = units.map((u) => `'${u.replace(/'/g, "'\\''")}'`).join(' ');
    const r = await runShell(
      `if command -v systemctl >/dev/null 2>&1; then for u in ${quoted}; do printf '%s=%s\\n' "$u" "$(systemctl is-active "$u" 2>/dev/null || echo inactive)"; done; else echo "systemd=unavailable"; fi`,
      ctx.root,
      8_000,
    );
    for (const line of r.stdout.split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) systemdStates[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return JSON.stringify(
    {
      node: ctx.nodeName || os.hostname(),
      endpoints: {
        svlGateway: { url: ctx.svlBaseUrl, ...gateway },
        ollama: { url: ollamaUrl, ...ollama },
        comfyui: { url: comfyUrl, ...comfyui },
      },
      systemd: systemdStates,
      mcp: ctx.getStatus ? ctx.getStatus() : undefined,
    },
    null,
    2,
  );
}

async function svlServiceControlTool(ctx: ToolContext, a: Args): Promise<string> {
  const service = String(a.service || '').trim();
  const action = String(a.action || 'status').trim().toLowerCase();
  if (!/^[A-Za-z0-9_.@-]{1,128}$/.test(service)) {
    throw new Error('Nieprawidłowa nazwa usługi systemd.');
  }
  if (!['status', 'start', 'restart', 'stop', 'enable', 'disable', 'logs'].includes(action)) {
    throw new Error('Dozwolone akcje: status | start | restart | stop | enable | disable | logs.');
  }
  if (action !== 'status' && action !== 'logs' && !ctx.allowShell) {
    throw new Error('Sterowanie usługami wymaga MCP_ALLOW_SHELL=1.');
  }
  const lines = Math.max(10, Math.min(300, Number(a.lines) || 60));
  const safeSvc = `'${service.replace(/'/g, "'\\''")}'`;
  const cmd = action === 'logs'
    ? `journalctl -u ${safeSvc} -n ${lines} --no-pager`
    : action === 'status'
      ? `systemctl status ${safeSvc} --no-pager`
      : `systemctl ${action} ${safeSvc} && systemctl is-active ${safeSvc}`;
  const r = await runShell(cmd, ctx.root, Math.min(ctx.shellTimeoutMs, 30_000));
  return clip([`exit_code: ${r.code}`, r.stdout, r.stderr ? `STDERR:\n${r.stderr}` : ''].filter(Boolean).join('\n'));
}

async function svlConversationTool(ctx: ToolContext, a: Args): Promise<string> {
  const channelKey = String(a.channel || 'wszyscy').toLowerCase();
  const conversationId = CHAT_CHANNELS[channelKey] || CHAT_CHANNELS.wszyscy;
  const data = await callSvlApi(ctx, 'GET', '/api/py/chat/conversations');
  const conv = (data.conversations || []).find((c: any) => c.id === conversationId);
  const limit = Math.max(1, Math.min(100, Number(a.limit) || 20));
  const msgs = (conv?.messages || []).slice(-limit).map(
    (m: any) => `[${m.timestamp}] ${m.sender}${m.role === 'system' ? ' (powiadomienie)' : ''}: ${String(m.content || '').slice(0, 1500)}`,
  );
  return msgs.join('\n\n') || '(kanał pusty)';
}

async function svlTerminalTool(ctx: ToolContext, a: Args): Promise<string> {
  const terminal = TERMINALS.includes(String(a.terminal) as any) ? String(a.terminal) : 'linux';
  const command = String(a.command || '').slice(0, 4000).trim();
  if (!command) throw new Error('Brak command.');
  const r = await callSvlApi(
    ctx,
    'POST',
    '/api/terminal/exec',
    { terminalType: terminal, command, origin: 'mcp-full' },
    120_000,
  );
  return clip([r.stdout, r.stderr ? `STDERR:\n${r.stderr}` : ''].filter(Boolean).join('\n') || '(brak wyjścia)');
}

async function svlOllamaTool(ctx: ToolContext, a: Args): Promise<string> {
  const action = String(a.action || 'status').trim().toLowerCase();
  if (action === 'status' || action === 'router') {
    const data = await callSvlApi(ctx, 'GET', '/api/ollama/router');
    return JSON.stringify(data, null, 2);
  }
  if (action === 'models') {
    const data = await callSvlApi(ctx, 'GET', '/api/ollama/models').catch(() => callSvlApi(ctx, 'GET', '/api/ollama/router'));
    return JSON.stringify(data, null, 2);
  }
  if (action === 'tunnel_status') {
    const data = await callSvlApi(ctx, 'GET', '/api/svl364/ollama-tunnel');
    return JSON.stringify(data, null, 2);
  }
  if (action === 'tunnel_enable' || action === 'tunnel_disable') {
    const data = await callSvlApi(ctx, 'POST', '/api/svl364/ollama-tunnel', {
      enabled: action === 'tunnel_enable',
      ...(a.target ? { target: String(a.target).slice(0, 253) } : {}),
      ...(a.shipPort ? { shipPort: Math.max(1, Math.min(65535, Number(a.shipPort))) } : {}),
      ...(a.localPort ? { localPort: Math.max(1, Math.min(65535, Number(a.localPort))) } : {}),
    });
    return JSON.stringify(data, null, 2);
  }
  if (action === 'pull') {
    const model = String(a.model || '').trim();
    if (!model) throw new Error('Brak nazwy modelu do pobrania.');
    const data = await callSvlApi(ctx, 'POST', '/api/ollama/pull', { model }, 300_000);
    return JSON.stringify(data, null, 2);
  }
  throw new Error('Nieznana akcja svl_ollama (dozwolone: status | router | models | tunnel_status | tunnel_enable | tunnel_disable | pull).');
}

async function svlShipTelemetryTool(ctx: ToolContext): Promise<string> {
  const data = await callSvlApi(ctx, 'GET', '/api/py/svl364/telemetry?ship=1', undefined, 60_000);
  return JSON.stringify(data, null, 2);
}

async function svlShipSshTool(ctx: ToolContext, a: Args): Promise<string> {
  const action = String(a.action || 'status').trim().toLowerCase();
  if (action === 'status') return JSON.stringify(await callSvlApi(ctx, 'GET', '/api/svl364/ssh-mcp/status'), null, 2);
  if (action === 'public_key') return JSON.stringify(await callSvlApi(ctx, 'GET', '/api/py/svl364/ssh/public-key'), null, 2);
  if (action === 'test') return JSON.stringify(await callSvlApi(ctx, 'POST', '/api/py/svl364/ssh/test', {}, 60_000), null, 2);
  if (action === 'configure') {
    if (!a.hostname || !a.user) throw new Error('Konfiguracja SSH wymaga hostname i user.');
    return JSON.stringify(
      await callSvlApi(ctx, 'POST', '/api/svl364/ssh-mcp/config', {
        action: 'configure',
        alias: String(a.alias || 'Ship').slice(0, 63),
        hostname: String(a.hostname).slice(0, 253),
        port: Math.max(1, Math.min(65535, Number(a.port) || 22)),
        user: String(a.user).slice(0, 63),
        generate_key: a.generate_key !== false,
      }, 60_000),
      null,
      2,
    );
  }
  if (action === 'exec') {
    if (a.confirmed !== true) throw new Error('Wykonanie SSH na SVL-364 wymaga confirmed=true.');
    const command = String(a.command || '').slice(0, 4000).trim();
    if (!command) throw new Error('Brak command.');
    return JSON.stringify(
      await callSvlApi(ctx, 'POST', '/api/svl364/ssh/exec', {
        command,
        confirmed: true,
        raw: true,
        timeout_sec: Math.max(2, Math.min(60, Number(a.timeout_sec) || 15)),
      }, 120_000),
      null,
      2,
    );
  }
  throw new Error('Nieznana akcja svl_ship_ssh (status | test | public_key | configure | exec).');
}

async function svlShipManageTool(ctx: ToolContext, a: Args): Promise<string> {
  const { tool, ...toolArgs } = a;
  const r = await callSvlApi(
    ctx,
    'POST',
    '/api/mcp/svl364',
    {
      jsonrpc: '2.0',
      id: `mcp-full-${Date.now()}`,
      method: 'tools/call',
      params: { name: String(tool || '').slice(0, 80), arguments: toolArgs },
    },
    180_000,
  );
  const text = r?.result?.content?.[0]?.text;
  return typeof text === 'string' ? clip(text) : JSON.stringify(r, null, 2);
}

async function svlShipRootExecTool(ctx: ToolContext, a: Args): Promise<string> {
  if (a.confirmed !== true) throw new Error('Wykonanie polecenia ROOT na SVL-364 wymaga confirmed=true.');
  const command = String(a.command || '').slice(0, 4000).trim();
  if (!command) throw new Error('Brak command.');
  const data = await callSvlApi(
    ctx,
    'POST',
    '/api/svl364/root/exec',
    {
      command,
      confirmed: true,
      raw: a.raw !== false,
      transport: String(a.transport || 'auto'),
      timeout_sec: Math.max(2, Math.min(60, Number(a.timeout_sec) || 30)),
    },
    120_000,
  );
  return clip(String(data?.output || JSON.stringify(data, null, 2)));
}

async function svlShipMcpBridgeTool(ctx: ToolContext, a: Args): Promise<string> {
  const action = String(a.action || 'status').trim().toLowerCase();
  if (action === 'status') {
    return JSON.stringify(await callSvlApi(ctx, 'GET', '/api/svl364/mcp-bridge/status'), null, 2);
  }
  if (action === 'test') {
    return JSON.stringify(await callSvlApi(ctx, 'POST', '/api/svl364/mcp-bridge/test', { timeout_sec: 12 }, 30_000), null, 2);
  }
  if (action === 'configure' || action === 'disconnect') {
    return JSON.stringify(
      await callSvlApi(ctx, 'POST', '/api/svl364/mcp-bridge/config', {
        disconnect: action === 'disconnect',
        ...(a.url !== undefined ? { url: String(a.url) } : {}),
        ...(a.token !== undefined ? { token: String(a.token) } : {}),
        ...(a.root_exec_enabled !== undefined ? { root_exec_enabled: Boolean(a.root_exec_enabled) } : {}),
      }),
      null,
      2,
    );
  }
  if (action === 'call') {
    const remoteTool = String(a.remote_tool || '').trim();
    if (!remoteTool) throw new Error('action=call wymaga parametru remote_tool.');
    const r = await callSvlApi(
      ctx,
      'POST',
      '/api/mcp/svl364',
      {
        jsonrpc: '2.0',
        id: `mcp-bridge-call-${Date.now()}`,
        method: 'tools/call',
        params: {
          name: 'svl364_mcp_connect',
          arguments: {
            action: 'call',
            remote_tool: remoteTool,
            remote_arguments: a.remote_arguments && typeof a.remote_arguments === 'object' ? a.remote_arguments : {},
          },
        },
      },
      120_000,
    );
    const text = r?.result?.content?.[0]?.text;
    return typeof text === 'string' ? clip(text) : JSON.stringify(r, null, 2);
  }
  throw new Error('Nieznana akcja svl_ship_mcp_bridge (status | configure | test | disconnect | call).');
}

async function svlMemorySearchTool(ctx: ToolContext, a: Args): Promise<string> {
  const agent = CHAT_AGENTS.includes(String(a.agent || 'Jyn') as any) ? String(a.agent) : 'Jyn';
  const r = await callSvlApi(ctx, 'POST', '/api/py/agents/memory/search', {
    agent,
    query: String(a.query || '').slice(0, 500),
    limit: Math.max(1, Math.min(50, Number(a.limit) || 12)),
  });
  return (r.memories || []).map((m: any) => `- [${m.kind}] ${m.content}`).join('\n') || '(brak wspomnień)';
}

async function svlMemoryAddTool(ctx: ToolContext, a: Args): Promise<string> {
  const agent = CHAT_AGENTS.includes(String(a.agent || 'Jyn') as any) ? String(a.agent) : 'Jyn';
  const content = String(a.content || '').slice(0, 2000).trim();
  if (!content) throw new Error('Brak content.');
  const r = await callSvlApi(ctx, 'POST', '/api/py/agents/memory', {
    agent,
    kind: String(a.kind || 'fact'),
    content,
    source: 'mcp-full',
    origin: 'mcp-full',
  });
  return r.deduplicated ? 'Ten wpis już był w pamięci.' : 'Zapisano w pamięci długotrwałej.';
}

async function svlGithubTool(ctx: ToolContext, a: Args): Promise<string> {
  if (a.gh) {
    const r = await callSvlApi(ctx, 'POST', '/api/github/cli', { args: String(a.gh).slice(0, 2000) }, 120_000);
    return clip(String(r.output ?? JSON.stringify(r)));
  }
  const r = await callSvlApi(
    ctx,
    'POST',
    '/api/github/sync',
    {
      action: String(a.action || 'status'),
      message: String(a.message || 'SVL: synchronizacja przez Universal MCP').slice(0, 200),
    },
    180_000,
  );
  return clip(String(r.summary ?? JSON.stringify(r, null, 2)));
}

async function svlComfyUiTool(ctx: ToolContext, a: Args): Promise<string> {
  const action = String(a.action || 'status').trim().toLowerCase();
  const base = (ctx.comfyuiHost || 'http://127.0.0.1:8188').replace(/\/+$/, '');
  const fetchImpl = ctx.fetchImpl || fetch;
  const endpoint = action === 'queue' ? '/queue' : action === 'history' ? '/history?max_items=10' : '/system_stats';
  const res = await fetchImpl(`${base}${endpoint}`, { signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`ComfyUI ${endpoint} HTTP ${res.status}: ${text.slice(0, 400)}`);
  return clip(text);
}

async function svlSecurityReportTool(ctx: ToolContext, a: Args): Promise<string> {
  const action = String(a.action || 'report').trim().toLowerCase();
  if (action === 'antivirus') {
    const r = await callSvlApi(ctx, 'POST', '/api/security/antivirus/scan', { emitToChat: true, origin: 'mcp-full' }, 120_000);
    return clip(String(r.reportMarkdown || JSON.stringify(r, null, 2)));
  }
  if (action === 'notify') {
    const title = String(a.title || '').slice(0, 200).trim();
    if (!title) throw new Error('Powiadomienie wymaga pola title.');
    const r = await callSvlApi(ctx, 'POST', '/api/py/notifications/emit', {
      title,
      message: String(a.message || '').slice(0, 3000),
      severity: String(a.severity || 'INFO'),
      category: 'mcp',
      origin: 'mcp-full',
    });
    return r.deduplicated ? 'Takie powiadomienie już istnieje.' : 'Opublikowano powiadomienie na kanale „wszyscy”.';
  }
  const r = await callSvlApi(ctx, 'POST', '/api/py/kernel/markdown-report', {
    directive: String(a.directive || 'Raport SVL_System na żądanie Universal MCP').slice(0, 500),
    emitToChat: true,
    origin: 'mcp-full',
  });
  return clip(String(r.report || JSON.stringify(r, null, 2)));
}

async function svlInfrastructureRegistryTool(ctx: ToolContext, a: Args): Promise<string> {
  const action = String(a.action || 'overview').trim().toLowerCase();
  const payload = a.payload && typeof a.payload === 'object' ? (a.payload as Record<string, unknown>) : {};
  if (action === 'overview' || action === 'sync_mcp') {
    const q = action === 'sync_mcp' ? '?sync=1' : '';
    const r = await callSvlApi(ctx, 'GET', `/api/infrastructure/overview${q}`, undefined, 30_000);
    return clip(JSON.stringify(r, null, 2));
  }
  if (ctx.readOnly) {
    throw new Error(`Tryb MCP_READONLY blokuje akcję zapisu '${action}' w rejestrze infrastruktury.`);
  }
  if (action === 'upsert_asset') {
    const r = await callSvlApi(ctx, 'POST', '/api/infrastructure/assets', payload);
    return clip(JSON.stringify(r, null, 2));
  }
  if (action === 'upsert_mission') {
    const r = await callSvlApi(ctx, 'POST', '/api/infrastructure/missions', payload);
    return clip(JSON.stringify(r, null, 2));
  }
  if (action === 'upsert_research') {
    const r = await callSvlApi(ctx, 'POST', '/api/infrastructure/research', payload);
    return clip(JSON.stringify(r, null, 2));
  }
  if (action === 'update_botany') {
    const r = await callSvlApi(ctx, 'POST', '/api/infrastructure/botany', payload);
    return clip(JSON.stringify(r, null, 2));
  }
  if (action === 'order_upgrade') {
    const r = await callSvlApi(ctx, 'POST', '/api/infrastructure/procurement', payload);
    return clip(JSON.stringify(r, null, 2));
  }
  throw new Error(`Nieznana akcja svl_infrastructure_registry: ${action}`);
}

export function isLoopbackUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
  } catch {
    return false;
  }
}

async function svlHttpLocalTool(ctx: ToolContext, a: Args): Promise<string> {
  const url = String(a.url || '').trim();
  if (!isLoopbackUrl(url)) {
    throw new Error('svl_http_local dopuszcza wyłącznie lokalne usługi hosta (http://127.0.0.1:* lub http://localhost:*).');
  }
  const method = String(a.method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    throw new Error('Nieobsługiwana metoda HTTP.');
  }
  const headers: Record<string, string> = {
    'X-SVL-Origin': 'mcp-full',
    ...(ctx.svlOperatorToken ? { 'X-SVL-Operator-Token': ctx.svlOperatorToken } : {}),
  };
  if (a.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await (ctx.fetchImpl || fetch)(url, {
    method,
    headers,
    ...(a.body !== undefined ? { body: typeof a.body === 'string' ? a.body : JSON.stringify(a.body) } : {}),
    signal: AbortSignal.timeout(Math.max(1000, Math.min(60_000, Number(a.timeout_ms) || 15_000))),
  });
  const bodyText = await res.text();
  return clip(`HTTP ${res.status} ${res.statusText}\n${bodyText}`);
}

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'read_file',
    description: 'Czyta plik z MCP_ROOT (UTF-8 lub base64). Opcjonalnie offset/limit w liniach.',
    inputSchema: obj({ path: S('Ścieżka względna do MCP_ROOT'), offset: N('Pierwsza linia (od 1)'), limit: N('Liczba linii'), encoding: { type: 'string', enum: ['utf8', 'base64'] } }, ['path']),
    write: false,
    handler: readFileTool,
  },
  {
    name: 'list_dir',
    description: 'Lista plików i katalogów (rekurencyjnie do depth, pomija node_modules/.git).',
    inputSchema: obj({ path: S('Katalog (domyślnie .)'), depth: N('Głębokość 1–10'), all: B('Pokaż ukryte pliki') }),
    write: false,
    handler: listDirTool,
  },
  {
    name: 'search',
    description: 'Szuka tekstu (lub regex) w plikach albo nazwach plików pod podaną ścieżką.',
    inputSchema: obj(
      { query: S('Szukany tekst / wyrażenie'), path: S('Katalog lub plik (domyślnie .)'), regex: B('query to regex'), case_sensitive: B('Rozróżniaj wielkość liter'), glob: S('Filtr nazw plików, np. *.ts'), names_only: B('Szukaj tylko w nazwach plików'), max_results: N('Limit wyników') },
      ['query'],
    ),
    write: false,
    handler: searchTool,
  },
  { name: 'stat', description: 'Metadane pliku/katalogu.', inputSchema: obj({ path: S('Ścieżka') }, ['path']), write: false, handler: statTool },
  {
    name: 'write_file',
    description: 'Tworzy lub nadpisuje plik (tworzy katalogi nadrzędne). append=true dopisuje.',
    inputSchema: obj({ path: S('Ścieżka'), content: S('Treść'), encoding: { type: 'string', enum: ['utf8', 'base64'] }, append: B('Dopisz na końcu'), create_only: B('Błąd, jeśli plik istnieje') }, ['path', 'content']),
    write: true,
    handler: writeFileTool,
  },
  {
    name: 'edit_file',
    description: 'Zamienia dokładny fragment old_string na new_string (jedno wystąpienie lub replace_all).',
    inputSchema: obj({ path: S('Ścieżka'), old_string: S('Dokładny tekst do zamiany'), new_string: S('Nowy tekst'), replace_all: B('Zamień wszystkie wystąpienia') }, ['path', 'old_string', 'new_string']),
    write: true,
    handler: editFileTool,
  },
  { name: 'make_dir', description: 'Tworzy katalog (z nadrzędnymi).', inputSchema: obj({ path: S('Ścieżka') }, ['path']), write: true, handler: mkdirTool },
  {
    name: 'delete_path',
    description: 'Usuwa plik lub katalog (katalog z zawartością tylko z recursive=true).',
    inputSchema: obj({ path: S('Ścieżka'), recursive: B('Usuń katalog z zawartością') }, ['path']),
    write: true,
    handler: deleteTool,
  },
  {
    name: 'move_path',
    description: 'Przenosi/zmienia nazwę (lub kopiuje z copy=true) pliku albo katalogu w MCP_ROOT.',
    inputSchema: obj({ from: S('Źródło'), to: S('Cel'), overwrite: B('Nadpisz cel'), copy: B('Kopiuj zamiast przenosić') }, ['from', 'to']),
    write: true,
    handler: moveTool,
  },
  {
    name: 'run_command',
    description: 'Uruchamia polecenie bash (cwd w MCP_ROOT, limit czasu). UWAGA: powłoka ma pełne prawa użytkownika usługi i może wyjść poza MCP_ROOT.',
    inputSchema: obj({ command: S('Polecenie bash'), cwd: S('Katalog roboczy (względny)'), timeout_ms: N('Limit czasu w ms') }, ['command']),
    write: true,
    handler: shellTool,
  },
  {
    name: 'svl_status',
    description: 'Pełny stan systemu SVL: jądro Python, dual-Ollama (lokalna + SVL-364), moduły, GitHub Rush47/SVL_Core i status tunelu zero-IP.',
    inputSchema: obj({}),
    write: false,
    handler: svlStatusTool,
  },
  {
    name: 'svl_services_status',
    description: 'Sprawdza status wszystkich usług systemu SVL (svl-coreos2, svl-python-os, svl-gateway, svl-sentinel, svl-mcp, svl-comfyui, ollama, tailscaled, cloudflared, docker, ssh) oraz lokalnych portów HTTP.',
    inputSchema: obj({ services: { type: 'array', items: { type: 'string' }, description: 'Opcjonalna lista nazw usług systemd' }, skip_systemd: B('Pomiń sprawdzanie systemctl') }),
    write: false,
    handler: svlServicesStatusTool,
  },
  {
    name: 'svl_service_control',
    description: 'Steruje usługą systemd na hoście (status | start | restart | stop | enable | disable | logs).',
    inputSchema: obj({ service: S('Nazwa usługi, np. svl-coreos2.service, ollama.service, svl-mcp.service'), action: { type: 'string', enum: ['status', 'start', 'restart', 'stop', 'enable', 'disable', 'logs'] }, lines: N('Liczba linii dla action=logs') }, ['service', 'action']),
    write: true,
    handler: svlServiceControlTool,
  },
  {
    name: 'svl_chat',
    description: 'Wysyła polecenie do AI lub kanału systemu SVL (/api/chat: JEDI Omni-OS v12 VM → Dual-Ollama → Gemini · obsługuje kanał svl364_root dla poleceń ROOT na statku SVL-364) i zwraca odpowiedź.',
    inputSchema: obj({
      message: S('Polecenie / pytanie'),
      agent: { type: 'string', enum: [...CHAT_AGENTS] },
      channel: { type: 'string', enum: Object.keys(CHAT_CHANNELS), description: 'Opcjonalny kanał: jyn | svl364_root | si_sphere | jedi | wszyscy' },
    }, ['message']),
    write: true,
    handler: svlChatTool,
  },
  {
    name: 'svl_conversation',
    description: 'Czyta ostatnie wiadomości z kanałów czatu SVL (jyn | svl364_root | si_sphere | jedi | wszyscy).',
    inputSchema: obj({ channel: { type: 'string', enum: Object.keys(CHAT_CHANNELS) }, limit: N('Liczba wiadomości (1-100)') }),
    write: false,
    handler: svlConversationTool,
  },
  {
    name: 'svl_terminal',
    description: 'Wykonuje polecenie w wybranym terminalu SVL (linux | python | ssh | github | hyperspace | agents).',
    inputSchema: obj({ terminal: { type: 'string', enum: [...TERMINALS] }, command: S('Polecenie do wykonania') }, ['terminal', 'command']),
    write: true,
    handler: svlTerminalTool,
  },
  {
    name: 'svl_ollama',
    description: 'Zarządza Dual-Ollama (lokalna + SVL-364 przez SSH/MCP): status, router, lista modeli, tunel SSH Ollamy i pobieranie modeli.',
    inputSchema: obj({ action: { type: 'string', enum: ['status', 'router', 'models', 'tunnel_status', 'tunnel_enable', 'tunnel_disable', 'pull'] }, model: S('Nazwa modelu dla pull'), target: S('Alias SSH statku'), shipPort: N('Port Ollamy na statku'), localPort: N('Lokalny port tunelu') }, ['action']),
    write: true,
    handler: svlOllamaTool,
  },
  {
    name: 'svl_ship_telemetry',
    description: 'Prawdziwa telemetria hosta aplikacji i statku SVL-364 (CPU, RAM, dysk, GPU, zapora, Ollama, ComfyUI, SSH).',
    inputSchema: obj({}),
    write: false,
    handler: svlShipTelemetryTool,
  },
  {
    name: 'svl_ship_ssh',
    description: 'Steruje mostkiem OpenSSH do hosta SVL-364: status, test połączenia, klucz publiczny, konfiguracja aliasu i wykonanie polecenia (wymaga confirmed=true).',
    inputSchema: obj({ action: { type: 'string', enum: ['status', 'test', 'public_key', 'configure', 'exec'] }, alias: S('Alias OpenSSH'), hostname: S('Host / domena / mesh IP'), port: N('Port SSH'), user: S('Użytkownik SSH'), generate_key: B('Wygeneruj klucz Ed25519'), command: S('Polecenie dla exec'), confirmed: B('Wymagane true dla exec'), timeout_sec: N('Limit czasu (2-60 s)') }, ['action']),
    write: true,
    handler: svlShipSshTool,
  },
  {
    name: 'svl_ship_root_exec',
    description: 'Wykonuje DOWOLNE polecenie powłoki Linux na komputerze statku SVL-364 jako ROOT (uid=0 / sudo -n) przez zdalny MCP Zero-IP lub OpenSSH (wymaga confirmed=true).',
    inputSchema: obj({
      command: S('Dowolne polecenie Linux do wykonania jako root na statku SVL-364'),
      confirmed: B('Wymagane true dla wykonania jako root'),
      transport: { type: 'string', enum: ['auto', 'remote-mcp', 'ssh'] },
      raw: B('Domyślnie true (tryb dosłowny)'),
      timeout_sec: N('Limit czasu 2-60 s'),
    }, ['command', 'confirmed']),
    write: true,
    handler: svlShipRootExecTool,
  },
  {
    name: 'svl_ship_mcp_bridge',
    description: 'Zarządza dostępem MCP do komputera pokładowego statku SVL-364 (Zero-IP HTTPS / Tailscale / Mesh): status, konfiguracja URL/tokenu, test połączenia, rozłączenie i zdalne wywołania narzędzi.',
    inputSchema: obj({
      action: { type: 'string', enum: ['status', 'configure', 'test', 'disconnect', 'call'] },
      url: S('Adres zdalnego serwera MCP na SVL-364'),
      token: S('Bearer token zdalnego MCP (plik 0600)'),
      root_exec_enabled: B('Domyślna eskalacja poleceń do ROOT (uid=0)'),
      remote_tool: S('Nazwa narzędzia zdalnego MCP dla action=call'),
      remote_arguments: { type: 'object', description: 'Argumenty JSON narzędzia zdalnego MCP' },
    }, ['action']),
    write: true,
    handler: svlShipMcpBridgeTool,
  },
  {
    name: 'svl_ship_manage',
    description: 'Wywołuje dowolne narzędzie zarządcze hosta SVL-364 (/api/mcp/svl364): dowolne polecenia ROOT, mostek Remote MCP, zasoby, usługi, Ollama, pliki/backup, sieć, aktualizacje, tunel zero-IP, kontenery Docker/Podman, ComfyUI i raporty.',
    inputSchema: obj({
      tool: {
        type: 'string',
        enum: [
          'svl364_root_exec',
          'svl364_mcp_connect',
          'svl364_resources',
          'svl364_service_control',
          'svl364_ollama_control',
          'svl364_file_control',
          'svl364_network_control',
          'svl364_update_control',
          'svl364_tunnel_control',
          'svl364_container_control',
          'svl364_comfyui_control',
          'svl364_linux_telemetry',
          'svl364_emit_system_report',
          'svl364_navigation',
          'svl364_incident_report',
          'svl364_infrastructure_registry',
        ],
      },
      command: S('Polecenie ROOT dla svl364_root_exec'),
      transport: S('Transport: auto | remote-mcp | ssh'),
      url: S('URL dla svl364_mcp_connect'),
      token: S('Token dla svl364_mcp_connect'),
      area: S('Obszar dla svl364_resources'),
      action: S('Akcja narzędzia'),
      service: S('Nazwa usługi systemd'),
      model: S('Nazwa modelu Ollama'),
      container: S('Nazwa/ID kontenera Docker/Podman'),
      path: S('Ścieżka na SVL-364'),
      package: S('Pakiet apt'),
      target: S('Cel sieciowy lub jednostka logów'),
      directive: S('Dyrektywa raportu'),
      lines: N('Liczba linii logów'),
      confirmed: B('Potwierdzenie dla operacji modyfikujących'),
    }, ['tool']),
    write: true,
    handler: svlShipManageTool,
  },
  {
    name: 'svl_infrastructure_registry',
    description:
      'Przez MCP zwraca lub aktualizuje dokładną liczbę i lokalizacje naszych placówek, statków i infrastruktury SVL, ' +
      'odświeżane misje, trwające badania oraz stan modułów botanicznych w poszczególnych obiektach.',
    inputSchema: obj({
      action: { type: 'string', enum: ['overview', 'sync_mcp', 'upsert_asset', 'upsert_mission', 'upsert_research', 'update_botany', 'order_upgrade'] },
      payload: { type: 'object', description: 'Dane dla operacji zapisu (placówka/statek/infrastruktura, misja, badanie, botanika, zamówienie pozaziemskie)' },
    }, ['action']),
    write: false,
    handler: svlInfrastructureRegistryTool,
  },
  {
    name: 'svl_memory_search',
    description: 'Wyszukuje wpisy w pamięci długotrwałej 128D + SQLite (Jyn | SI_Sphere | JEDI_Omni_OS).',
    inputSchema: obj({ query: S('Zapytanie wyszukiwania'), agent: { type: 'string', enum: [...CHAT_AGENTS] }, limit: N('Limit wyników (1-50)') }, ['query']),
    write: false,
    handler: svlMemorySearchTool,
  },
  {
    name: 'svl_memory_add',
    description: 'Zapisuje fakt, preferencję, decyzję lub zadanie w pamięci długotrwałej agenta.',
    inputSchema: obj({ content: S('Treść do zapamiętania'), agent: { type: 'string', enum: [...CHAT_AGENTS] }, kind: { type: 'string', enum: ['fact', 'preference', 'decision', 'task'] } }, ['content']),
    write: true,
    handler: svlMemoryAddTool,
  },
  {
    name: 'svl_github',
    description: 'GitHub Rush47/SVL_Core: synchronizacja obustronna (status | pull | push | sync) lub dowolne polecenie gh CLI.',
    inputSchema: obj({ action: { type: 'string', enum: ['status', 'pull', 'push', 'sync'] }, gh: S('Argumenty polecenia gh (np. "pr list")'), message: S('Opis commitu dla push/sync') }),
    write: true,
    handler: svlGithubTool,
  },
  {
    name: 'svl_comfyui',
    description: 'Sprawdza status, kolejkę i historię usługi ComfyUI na hoście (COMFYUI_HOST).',
    inputSchema: obj({ action: { type: 'string', enum: ['status', 'queue', 'history'] } }),
    write: false,
    handler: svlComfyUiTool,
  },
  {
    name: 'svl_security_report',
    description: 'Uruchamia skan antywirusowy SVL-365 (antivirus), pełny raport systemu (report) albo wysyła powiadomienie (notify).',
    inputSchema: obj({ action: { type: 'string', enum: ['report', 'antivirus', 'notify'] }, directive: S('Dyrektywa raportu'), title: S('Tytuł powiadomienia'), message: S('Treść powiadomienia'), severity: { type: 'string', enum: ['INFO', 'WARN', 'ALERT'] } }, ['action']),
    write: true,
    handler: svlSecurityReportTool,
  },
  {
    name: 'svl_http_local',
    description: 'Wykonuje kontrolowane żądanie HTTP do lokalnej usługi na hoście (wyłącznie 127.0.0.1 / localhost) — pozwala obsłużyć dowolne lokalne API/usługę.',
    inputSchema: obj({ url: S('Lokalny URL, np. http://127.0.0.1:8085/health'), method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }, body: { description: 'Opcjonalne ciało JSON lub tekst' }, timeout_ms: N('Timeout 1000-60000 ms') }, ['url']),
    write: true,
    handler: svlHttpLocalTool,
  },
  {
    name: 'svl_logs',
    description: 'Ostatnie linie logów SVL (system | gateway | python | gui), z filtrem tekstu i poziomu.',
    inputSchema: obj({ file: { type: 'string', enum: ['system', 'gateway', 'python', 'gui'] }, lines: N('Liczba linii (domyślnie 80)'), contains: S('Filtr tekstu'), level: { type: 'string', enum: ['INFO', 'WARN', 'ERROR', 'DEBUG'] } }),
    write: false,
    handler: (ctx, a) => readLogTail(ctx.logDir, String(a.file || 'system'), Number(a.lines) || 80, String(a.contains || ''), String(a.level || '')),
  },
  {
    name: 'mcp_info',
    description: 'Stan serwera MCP: węzeł, katalog główny, tryb, powłoka, tunel zero-IP, interfejsy mesh, lista narzędzi i usług.',
    inputSchema: obj({}),
    write: false,
    handler: async (ctx) =>
      JSON.stringify(
        {
          node: ctx.nodeName || os.hostname(),
          root: ctx.root,
          readOnly: ctx.readOnly,
          allowShell: ctx.allowShell,
          toolsCount: visibleTools(ctx).length,
          servicesCatalog: SVL_KNOWN_SERVICES,
          ...(ctx.getStatus ? { status: ctx.getStatus() } : {}),
        },
        null,
        2,
      ),
  },
];

export function visibleTools(ctx: ToolContext): ToolDef[] {
  return TOOL_DEFS.filter((t) => !(ctx.readOnly && t.write) && !(t.name === 'run_command' && !ctx.allowShell));
}

export async function callTool(ctx: ToolContext, name: string, args: Args = {}): Promise<ToolResult> {
  const def = TOOL_DEFS.find((t) => t.name === name);
  try {
    if (!def) throw new Error(`Nieznane narzędzie: ${name}`);
    if (def.write && ctx.readOnly) throw new ReadOnlyError(name);
    const text = await def.handler(ctx, args || {});
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
  }
}

const MCP_RESOURCES = [
  { uri: 'svl://mcp/info', name: 'Status Universal MCP Hub i tunelu Zero-IP', mimeType: 'application/json' },
  { uri: 'svl://services/catalog', name: 'Katalog i stan usług systemu SVL + SVL-364', mimeType: 'application/json' },
  { uri: 'svl://system/status', name: 'Stan jądra SVL, Dual-Ollama i GitHub', mimeType: 'application/json' },
  { uri: 'svl://ship/telemetry', name: 'Telemetria hosta i statku SVL-364', mimeType: 'application/json' },
  { uri: 'svl://logs/system', name: 'Ostatnie 100 linii logów systemowych SVL', mimeType: 'text/plain' },
];

const MCP_PROMPTS = [
  {
    name: 'svl_full_audit',
    description: 'Kompletny audyt systemu SVL i hosta SVL-364 (usługi, tunel bez stałego IP, Dual-Ollama, telemetria, logi).',
    arguments: [],
  },
  {
    name: 'svl_ship_diagnostics',
    description: 'Diagnostyka statku SVL-364: SSH, tunel Zero-IP/Mesh, zasoby, kontenery Docker i Ollama.',
    arguments: [],
  },
  {
    name: 'svl_zero_ip_check',
    description: 'Weryfikacja połączenia internetowego bez stałego IP (Cloudflare Tunnel / Tailscale Funnel / Mesh) dla serwera MCP.',
    arguments: [],
  },
];

export function createFullMcpServer(ctx: ToolContext, onCall?: (name: string, ok: boolean) => void): Server {
  const server = new Server(
    { name: 'svl-universal-mcp', version: '2.0.0' },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions:
        'SVL Universal MCP Hub (system + host SVL-364, dostęp internetowy bez stałego IP): pliki, powłoka, wszystkie usługi systemd, ' +
        'Dual-Ollama, ComfyUI, terminale, czat AI (Jyn / SI_Sphere / JEDI_Omni_OS), pamięć 128D, GitHub, antywirus, raporty i sterowanie SVL-364.',
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: visibleTools(ctx).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: { readOnlyHint: !t.write, destructiveHint: t.write },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await callTool(ctx, req.params.name, (req.params.arguments || {}) as Args);
    onCall?.(req.params.name, !result.isError);
    return result;
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: MCP_RESOURCES }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = String(req.params.uri || 'svl://mcp/info');
    if (uri === 'svl://services/catalog') {
      const text = await svlServicesStatusTool(ctx, {});
      return { contents: [{ uri, mimeType: 'application/json', text }] };
    }
    if (uri === 'svl://system/status') {
      const text = await svlStatusTool(ctx);
      return { contents: [{ uri, mimeType: 'application/json', text }] };
    }
    if (uri === 'svl://ship/telemetry') {
      const text = await svlShipTelemetryTool(ctx);
      return { contents: [{ uri, mimeType: 'application/json', text }] };
    }
    if (uri === 'svl://logs/system') {
      const text = await readLogTail(ctx.logDir, 'system', 100, '', '');
      return { contents: [{ uri, mimeType: 'text/plain', text }] };
    }
    const text = (await callTool(ctx, 'mcp_info', {})).content[0].text;
    return { contents: [{ uri, mimeType: 'application/json', text }] };
  });
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: MCP_PROMPTS }));
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const name = String(req.params.name || 'svl_full_audit');
    const promptText =
      name === 'svl_ship_diagnostics'
        ? 'Wykonaj pełną diagnostykę hosta SVL-364 używając narzędzi svl_ship_telemetry, svl_ship_ssh (status/test) oraz svl_ship_manage (svl364_resources, svl364_tunnel_control, svl364_ollama_control).'
        : name === 'svl_zero_ip_check'
          ? 'Sprawdź dostępność serwera MCP przez internet bez stałego IP używając mcp_info, svl_services_status oraz svl_ship_manage (svl364_tunnel_control) i wskaż działające adresy HTTPS oraz Mesh.'
          : 'Wykonaj kompletny audyt systemu SVL i hosta SVL-364 używając mcp_info, svl_status, svl_services_status, svl_ollama (router) oraz svl_logs (ERROR/WARN).';
    return {
      description: MCP_PROMPTS.find((p) => p.name === name)?.description || 'Prompt operacyjny SVL MCP',
      messages: [{ role: 'user', content: { type: 'text', text: promptText } }],
    };
  });
  return server;
}
