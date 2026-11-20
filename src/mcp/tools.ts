// Narzędzia serwera MCP SVL: pełny odczyt/zapis plików w MCP_ROOT, powłoka i funkcje SVL (czat, logi).
// Handlery są zwykłymi funkcjami (łatwe testy); createFullMcpServer() rejestruje je w SDK MCP.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
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
  getStatus?: () => unknown;
  fetchImpl?: typeof fetch;
}

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
  const agent = ['Bielik', 'Maya'].includes(String(a.agent)) ? String(a.agent) : 'Bielik';
  const res = await (ctx.fetchImpl || fetch)(`${ctx.svlBaseUrl}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-SVL-Origin': 'mcp-full',
      ...(ctx.svlOperatorToken ? { 'X-SVL-Operator-Token': ctx.svlOperatorToken } : {}),
    },
    body: JSON.stringify({ message, targetAgent: agent, origin: 'mcp-full', history: [] }),
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
    name: 'svl_chat',
    description: 'Wysyła polecenie do AI systemu SVL (/api/chat: Grok → Ollama → Gemini) jako Bielik lub Maya i zwraca odpowiedź.',
    inputSchema: obj({ message: S('Polecenie / pytanie'), agent: { type: 'string', enum: ['Bielik', 'Maya'] } }, ['message']),
    write: true, // AI SVL może wykonywać akcje w systemie
    handler: svlChatTool,
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
    description: 'Stan serwera MCP: katalog główny, tryb, powłoka, tunel i publiczny adres.',
    inputSchema: obj({}),
    write: false,
    handler: async (ctx) => JSON.stringify({ root: ctx.root, readOnly: ctx.readOnly, allowShell: ctx.allowShell, ...(ctx.getStatus ? { status: ctx.getStatus() } : {}) }, null, 2),
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

export function createFullMcpServer(ctx: ToolContext, onCall?: (name: string, ok: boolean) => void): Server {
  const server = new Server({ name: 'svl-full-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });
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
  return server;
}
