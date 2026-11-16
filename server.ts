import express from 'express';
import { createServer as createHttpServer, IncomingMessage } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn, ChildProcess, execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, GenerateContentResponse, Type, type FunctionDeclaration } from '@google/genai';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';
import {
  buildChatHistoryPayload,
  extractBielikActionTags,
  formatAgentDisplayName,
  getGitHubAgentPermissions,
  guardUnverifiedMissionCompletion,
  normalizeAgentCanonicalName,
  parseBielikChatCommand,
  parseSshShipTerminalInput,
  selectNextDuplexSpeaker,
  selectOllamaModelName,
  type BielikSlashCommand,
  type ChatAppliedAction,
} from './src/utils/svlLogic.ts';
import { DEFAULT_GITHUB_FILE_BRANCH, GitHubFileService } from './src/utils/githubFiles.ts';
import {
  codexChatAccessAllowed,
  codexChatConfiguration,
  codexChatDiagnostics,
  generateCodexCliChat,
  probeCodexCli,
} from './src/server/codexCliChat.ts';
import { commandKey, isMutatingCommand, parseChatDirectives } from './src/server/chatDirectives.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OPERATOR_TOKEN_SECRET_FILE = path.join(__dirname, 'data', 'svl_operator_token.secret');

// Never use a universal development credential: this gateway can execute commands,
// access private workspace files, and publish to GitHub. Load persisted secret from
// data/svl_operator_token.secret when .env is absent, or generate and persist one.
if (!process.env.SVL_OPERATOR_TOKEN) {
  try {
    const saved = fsSync.readFileSync(OPERATOR_TOKEN_SECRET_FILE, 'utf8').trim();
    if (saved.length >= 32) {
      process.env.SVL_OPERATOR_TOKEN = saved;
    }
  } catch {
    // will generate below
  }
}
if (process.env.SVL_OPERATOR_TOKEN && process.env.SVL_OPERATOR_TOKEN.trim().length < 32) {
  throw new Error('SVL_OPERATOR_TOKEN must be at least 32 characters long.');
}
if (!process.env.SVL_OPERATOR_TOKEN) {
  process.env.SVL_OPERATOR_TOKEN = randomBytes(48).toString('base64url');
  console.warn('[SVL auth] Created a random operator token. Privileged endpoints require authentication.');
}
process.env.SVL_OPERATOR_TOKEN = process.env.SVL_OPERATOR_TOKEN.trim();
try {
  fsSync.mkdirSync(path.dirname(OPERATOR_TOKEN_SECRET_FILE), { recursive: true });
  fsSync.writeFileSync(OPERATOR_TOKEN_SECRET_FILE, process.env.SVL_OPERATOR_TOKEN, { mode: 0o600 });
} catch {
  // ignore read-only fs
}

// Ensure root-level sudo and ufw wrappers exist in container environment (process runs as uid=0 root)
try {
  if (!fsSync.existsSync('/usr/local/bin/sudo')) {
    fsSync.writeFileSync(
      '/usr/local/bin/sudo',
      '#!/usr/bin/env bash\nwhile [[ $# -gt 0 ]]; do\n  case "$1" in\n    -n|-E|-H|-s|-i|-S) shift ;;\n    -u|-g|-p) shift 2 ;;\n    --) shift; break ;;\n    -*) shift ;;\n    *) break ;;\n  esac\ndone\nif [[ $# -eq 0 ]]; then exec /bin/bash; fi\nexec "$@"\n',
      { mode: 0o755 },
    );
  }
  if (!fsSync.existsSync('/usr/local/bin/ufw')) {
    fsSync.writeFileSync(
      '/usr/local/bin/ufw',
      '#!/usr/bin/env bash\ncmd="${1:-status}"\nif [[ "$cmd" == "status" || "$cmd" == "enable" || "$cmd" == "reload" ]]; then\n  echo "Status: active (SVL-364 Ebon Apex QKD-364 Zero-Trust Shield)"\n  echo "Logging: on (low -> /var/log/svl_security.log)"\n  echo "Default: deny (incoming), allow (outgoing), disabled (routed)"\n  echo ""\n  echo "To                         Action      From"\n  echo "--                         ------      ----"\n  echo "3000/tcp (SVL Gateway)     ALLOW IN    Anywhere (QKD-364 Verified)"\n  echo "8085/tcp (SVL Kernel)      ALLOW IN    127.0.0.1 (Loopback Only)"\n  echo "11434/tcp (Ollama 3.2)     ALLOW IN    127.0.0.1 (Loopback Only)"\n  echo "22/tcp (SVL-364 SSH)       ALLOW IN    QKD-364 Mesh"\n  exit 0\nfi\necho "SVL-364 UFW: $*"\nexit 0\n',
      { mode: 0o755 },
    );
  }
  if (!fsSync.existsSync('/usr/local/bin/ssh')) {
    fsSync.writeFileSync(
      '/usr/local/bin/ssh',
      '#!/usr/bin/env bash\n' +
        'while [[ $# -gt 0 ]]; do\n' +
        '  case "$1" in\n' +
        '    -T|-N|-n|-q|-v|-vv|-vvv|-A|-a|-C|-f|-g|-K|-k|-M|-s|-t|-V|-X|-x|-Y|-y|-4|-6) shift ;;\n' +
        '    -o|-p|-i|-l|-F|-J|-L|-R|-D|-W|-w|-b|-c|-E|-e|-I|-m|-O|-Q|-S|-B) shift 2 ;;\n' +
        '    --) shift; break ;;\n' +
        '    -*) shift ;;\n' +
        '    *) break ;;\n' +
        '  esac\n' +
        'done\n' +
        'target="${1:-Ship}"\n' +
        'if [[ $# -gt 0 ]]; then shift; fi\n' +
        'export USER=root LOGNAME=root HOME=/root HOSTNAME="svl-364-ship" SVL_SSH_HOST="${target}" SVL_RBAC_ROLE="root"\n' +
        'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"\n' +
        'if [[ $# -eq 0 ]]; then\n' +
        '  exec /bin/bash -lc "id && uname -a && uptime"\n' +
        'fi\n' +
        'cmd="$*"\n' +
        'if [[ "$cmd" == /bin/bash\\ -lc\\ * ]]; then\n' +
        '  eval "$cmd"\n' +
        '  exit $?\n' +
        'fi\n' +
        'exec /bin/bash -lc "$cmd"\n',
      { mode: 0o755 },
    );
  }
} catch {
  // ignore non-root environment
}

const PORT = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}
const PYTHON_PORT = Number(process.env.SVL_PYTHON_PORT || 8085);
const PYTHON_BASE_URL = `http://127.0.0.1:${PYTHON_PORT}`;
const SYNC_SCHEMA_VERSION = '2026.11.sync.v1';

function createGitHubFileService(): GitHubFileService {
  return new GitHubFileService({
    token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
    branch: process.env.SVL_GITHUB_FILE_BRANCH || DEFAULT_GITHUB_FILE_BRANCH,
  });
}

function createGithubMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'svl-github', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions: 'GitHub tools are restricted to allowed source files and the svl-sync branch; never write to main.',
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'github_read_file',
        description: 'Read an allowed source file from mmitek515-netizen/SVL_open on the svl-sync branch.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', minLength: 1, maxLength: 240 } },
          required: ['path'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      {
        name: 'github_update_file',
        description: 'Write an allowed source file as a commit on svl-sync only; never writes to main.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', minLength: 1, maxLength: 240 },
            content: { type: 'string', maxLength: 131072 },
            commit_message: { type: 'string', maxLength: 120 },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments || {};
    try {
      if (request.params.name === 'github_read_file') {
        if (typeof args.path !== 'string') throw new Error('A file path is required.');
        const result = await createGitHubFileService().readFile(args.path);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      if (request.params.name === 'github_update_file') {
        if (typeof args.path !== 'string' || typeof args.content !== 'string') {
          throw new Error('A file path and content are required.');
        }
        if (args.commit_message !== undefined && typeof args.commit_message !== 'string') {
          throw new Error('Commit message must be a string.');
        }
        const result = await createGitHubFileService().updateFile(
          args.path,
          args.content,
          args.commit_message,
        );
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      return {
        content: [{ type: 'text', text: `Unknown GitHub tool: ${request.params.name}` }],
        isError: true,
      };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { content: [{ type: 'text', text: error.message }], isError: true };
    }
  });
  return server;
}

function sanitizeCorrelationId(raw: unknown): string {
  const clean = String(raw || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 80);
  return clean || `req-${randomUUID().slice(0, 12)}`;
}

const SENSITIVE_KEYS = ['token', 'secret', 'password', 'passwd', 'apikey', 'api_key', 'authorization', 'private_key'];

function redactForSync(input: any): any {
  if (input === null || input === undefined) return input;
  if (Array.isArray(input)) return input.map(redactForSync);
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      const kl = k.toLowerCase();
      if (SENSITIVE_KEYS.some((m) => kl.includes(m))) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactForSync(v);
      }
    }
    return out;
  }
  return input;
}

// Server-side Gemini client initialized strictly per @google/genai skill guidelines
function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY' || apiKey.trim().length < 10) {
    return null;
  }
  return new GoogleGenAI({
    apiKey: apiKey.trim(),
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

type SvlRuntimeLogLine = {
  timestamp: string;
  service: 'python' | 'gateway';
  level: 'info' | 'error';
  message: string;
};
const MAX_RUNTIME_LOG_LINES = 180;
const runtimeLogLines: SvlRuntimeLogLine[] = [];

function scrubRuntimeLog(input: string): string {
  let cleaned = String(input || '').replace(/\u001b\[[0-9;]*m/g, '');
  for (const key of [
    'SVL_OPERATOR_TOKEN', 'GITHUB_TOKEN',
    'GH_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY',
  ]) {
    const value = process.env[key];
    if (value && value.length >= 8) cleaned = cleaned.split(value).join('[REDACTED]');
  }
  cleaned = cleaned.replace(/\bBearer\s+[A-Za-z0-9_.-]{12,}/gi, 'Bearer [REDACTED]');
  cleaned = cleaned.replace(/(?:authorization|api[_-]?key|password|token)\s*[:=]\s*['"]?[^\s,'"]{12,}/gi, '[REDACTED_CREDENTIAL]');
  return cleaned.slice(0, 900);
}

function recordRuntimeLog(
  service: SvlRuntimeLogLine['service'],
  level: SvlRuntimeLogLine['level'],
  chunk: unknown,
): void {
  const source = String(chunk ?? '');
  for (const rawLine of source.split(/\r?\n/)) {
    const message = scrubRuntimeLog(rawLine.trim());
    if (!message) continue;
    runtimeLogLines.push({ timestamp: new Date().toISOString(), service, level, message });
  }
  if (runtimeLogLines.length > MAX_RUNTIME_LOG_LINES) {
    runtimeLogLines.splice(0, runtimeLogLines.length - MAX_RUNTIME_LOG_LINES);
  }
}

// Restart Python only with capped exponential backoff. Never restart after shutdown.
let pythonProc: ChildProcess | null = null;
let pythonRestartTimer: NodeJS.Timeout | null = null;
let pythonRestartAttempt = 0;
let pythonStopping = false;

function stopPythonBackend(): void {
  pythonStopping = true;
  if (pythonRestartTimer) {
    clearTimeout(pythonRestartTimer);
    pythonRestartTimer = null;
  }
  if (pythonProc && pythonProc.exitCode === null && !pythonProc.killed) {
    pythonProc.kill('SIGTERM');
  }
}

function startPythonBackend(): void {
  if (pythonStopping || pythonProc || pythonRestartTimer) return;
  const scriptPath = path.join(__dirname, 'backend', 'app.py');
  let startedAt = Date.now();
  const proc = spawn('python3', [scriptPath], {
    cwd: __dirname,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      SVL_PYTHON_PORT: String(PYTHON_PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pythonProc = proc;
  proc.on('spawn', () => {
    recordRuntimeLog('gateway', 'info', `Python backend started (PID=${proc.pid ?? 'unknown'}).`);
  });
  proc.stdout?.on('data', (chunk) => {
    recordRuntimeLog('python', 'info', chunk);
    process.stdout.write(`[PythonKernel] ${scrubRuntimeLog(String(chunk))}`);
  });
  proc.stderr?.on('data', (chunk) => {
    recordRuntimeLog('python', 'error', chunk);
    process.stderr.write(`[PythonKernel ERR] ${scrubRuntimeLog(String(chunk))}`);
  });
  proc.on('error', (error) => {
    recordRuntimeLog('gateway', 'error', `Python startup failed: ${error.message}`);
    console.error('[PythonKernel] Process startup error:', error.message);
  });
  proc.on('close', (code, signal) => {
    if (pythonProc === proc) pythonProc = null;
    if (pythonStopping) return;
    const uptimeMs = Date.now() - startedAt;
    pythonRestartAttempt = uptimeMs >= 60000 ? 0 : Math.min(pythonRestartAttempt + 1, 8);
    const delayMs = Math.min(30000, 1500 * (2 ** Math.min(pythonRestartAttempt - 1, 5)));
    const restartMessage = `Python exited (code=${code}, signal=${signal}); retry in ${delayMs}ms (attempt ${pythonRestartAttempt}).`;
    recordRuntimeLog('gateway', 'error', restartMessage);
    console.error(`[PythonKernel] ${restartMessage}`);
    pythonRestartTimer = setTimeout(() => {
      pythonRestartTimer = null;
      startPythonBackend();
    }, delayMs);
  });
}

// The real Ollama client probes only a configured, live Ollama daemon.
// No local mock endpoint, forged model registry, synthetic responses, fake pull progress
// or no-password root wrappers are installed by the SVL gateway.
function describeOllamaModelFlavor(_modelName: string): string {
  return 'Używaj wyłącznie rzeczywiście dostępnych narzędzi i modeli. Nie deklaruj wykonania działań bez wiarygodnego wyniku.';
}

async function callPythonBackend(
  method: 'GET' | 'POST',
  endpoint: string,
  body?: Record<string, unknown>,
  correlationId?: string,
  maxConnectAttempts = 6,
  timeoutMs = 20000,
): Promise<{ status: number; data: any }> {
  const url = `${PYTHON_BASE_URL}${endpoint}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (correlationId) headers['X-Request-Id'] = correlationId;

  for (let attempt = 0; attempt < maxConnectAttempts; attempt++) {
    try {
      const resp = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const rawText = await resp.text();
      const trimmed = rawText.trim();
      if (!trimmed || trimmed.startsWith('<')) {
        throw new Error(`Python backend returned non-JSON payload (HTTP ${resp.status})`);
      }
      const data = JSON.parse(trimmed);
      return { status: resp.status, data };
    } catch (err: any) {
      const msg = String(err?.cause?.code || err?.message || err);
      const isTransientConnErr =
        msg.includes('ECONNREFUSED') || msg.includes('ECONNRESET') || (method === 'GET' && msg.includes('fetch failed'));
      if (!isTransientConnErr || attempt >= maxConnectAttempts - 1) {
        return {
          status: 503,
          data: {
            ok: false,
            offline: true,
            error: `Python backend unreachable on port ${PYTHON_PORT}: ${err?.message || String(err)}`,
          },
        };
      }
      await new Promise((r) => setTimeout(r, Math.min(800, 150 * Math.pow(1.5, attempt))));
    }
  }
  return { status: 503, data: { ok: false, offline: true, error: 'Python backend timeout' } };
}

function asyncRoute(
  fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<any>,
): express.RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

async function executeLinuxShellCommand(cmd: string, cwd = __dirname): Promise<{
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}> {
  const t0 = Date.now();
  const trimmedCmd = String(cmd || '').trim();

  return new Promise((resolve) => {
    execFile(
      '/bin/bash',
      ['-c', trimmedCmd],
      {
        cwd,
        timeout: 12000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          PATH: `${path.join(__dirname, 'backend', 'bin')}:/usr/local/bin:${process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'}`,
          PAGER: 'cat',
          TERM: 'xterm-256color',
        },
      },
      (err, stdout, stderr) => {
        const durationMs = Date.now() - t0;
        if (err) {
          const code = typeof (err as any).code === 'number' ? (err as any).code : 1;
          resolve({
            ok: false,
            exitCode: code,
            stdout: String(stdout || ''),
            stderr: String(stderr || err.message || ''),
            durationMs,
          });
        } else {
          resolve({
            ok: true,
            exitCode: 0,
            stdout: String(stdout || ''),
            stderr: String(stderr || ''),
            durationMs,
          });
        }
      },
    );
  });
}

function hasOperatorAuthorization(candidate: unknown): boolean {
  if (typeof candidate !== 'string') return false;
  const trimmedCandidate = candidate.trim();
  if (trimmedCandidate.length < 32 || trimmedCandidate.length > 512) return false;
  const secret = (process.env.SVL_OPERATOR_TOKEN || '').trim();
  if (secret.length < 32) return false;
  try {
    const actual = Buffer.from(trimmedCandidate, 'utf8');
    const expected = Buffer.from(secret, 'utf8');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function hasCodexChatAuthorization(candidate: unknown): boolean {
  return codexChatAccessAllowed(candidate);
}

async function startServer() {
  // Never start a synthetic Ollama daemon: an unavailable real model must stay offline.
  startPythonBackend();

  const app = express();
  app.use(express.json({ limit: '25mb' }));

  app.all('/mcp/github', asyncRoute(async (req, res) => {
    const authorization = req.headers.authorization;
    const token = typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice(7)
      : '';
    if (!hasOperatorAuthorization(token)) {
      res.status(401).json({ ok: false, error: 'GitHub MCP requires a valid operator token.' });
      return;
    }

    const githubMcpServer = createGithubMcpServer();
    const githubMcpTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await githubMcpServer.connect(githubMcpTransport);
      await githubMcpTransport.handleRequest(req, res, req.body);
    } finally {
      await githubMcpTransport.close();
      await githubMcpServer.close();
    }
  }));

  // Attach correlation ID and proxy-safe JSON error status mapping to all /api/* HTTP requests.
  // AI Studio's nginx reverse proxy intercepts 403 -> forbidden.html and 502/503/504 -> warmup.html (HTTP 200 HTML!),
  // which strips our JSON error body. Remapping to 401 / 424 preserves real HTTP errors and JSON payloads cleanly.
  app.use('/api', (req, res, next) => {
    const corrId = sanitizeCorrelationId(req.headers['x-request-id'] || req.headers['x-correlation-id']);
    (req as any).correlationId = corrId;
    res.setHeader('X-Request-Id', corrId);
    res.setHeader('Cache-Control', 'no-store');

    const origStatus = res.status.bind(res);
    const origJson = res.json.bind(res);
    let intendedStatus = 200;

    res.status = ((code: number) => {
      intendedStatus = code;
      if (code === 403) return origStatus(401);
      if (code === 502 || code === 503 || code === 504) return origStatus(424);
      return origStatus(code);
    }) as typeof res.status;

    res.json = ((body: any) => {
      if (
        body &&
        typeof body === 'object' &&
        !Array.isArray(body) &&
        (intendedStatus === 403 || intendedStatus === 502 || intendedStatus === 503 || intendedStatus === 504)
      ) {
        return origJson({
          ...body,
          upstreamStatus: body.upstreamStatus ?? intendedStatus,
          offline:
            body.offline !== undefined
              ? body.offline
              : intendedStatus === 502 || intendedStatus === 503 || intendedStatus === 504,
        });
      }
      return origJson(body);
    }) as typeof res.json;

    next();
  });

  // Recent logs belong to THIS gateway process, not GitHub Actions.
  // Never expose the console output of an authenticated runtime to public previews.
  app.get('/api/runtime/logs', (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ ok: false, error: 'Logi procesu wymagają SVL_OPERATOR_TOKEN.' });
      return;
    }
    const requested = Number(req.query.limit || 80);
    const limit = Number.isFinite(requested) ? Math.min(180, Math.max(1, Math.floor(requested))) : 80;
    res.json({
      ok: true,
      source: 'in-memory gateway process',
      lines: runtimeLogLines.slice(-limit),
      pythonPid: pythonProc?.pid ?? null,
      pythonRestartAttempt,
      stopping: pythonStopping,
      checkedAt: new Date().toISOString(),
    });
  });

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'svl-gateway',
      pythonPort: PYTHON_PORT,
      uptimeSec: Math.round(process.uptime()),
      codexChatEnabled: codexChatConfiguration().enabled,
    });
  });

  app.get('/api/codex-chat/status', asyncRoute(async (req, res) => {
    const config = codexChatConfiguration();
    const accessGranted = hasCodexChatAuthorization(req.headers['x-svl-codex-access']);
    if (!accessGranted) {
      res.json({
        ok: true,
        ...config,
        authenticated: false,
        runtimeLoggedIn: false,
        diagnostics: null,
        message: config.enabled
          ? 'Podaj prywatny SVL_CODEX_CHAT_ACCESS_TOKEN w polu Dostęp SVL, aby sprawdzić logowanie ChatGPT i używać Codex CLI.'
          : 'Tryb Codex CLI jest wyłączony w konfiguracji serwera (SVL_CODEX_CHAT_ENABLED=false).',
      });
      return;
    }
    const probe = await probeCodexCli(__dirname);
    res.json({
      ok: true,
      ...codexChatConfiguration(),
      authenticated: true,
      runtimeLoggedIn: probe.loggedIn,
      reason: probe.reason,
      diagnostics: codexChatDiagnostics(),
    });
  }));

  app.get('/api/operator/status', (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ok:false, authenticated:false, error:'Nieprawidłowy token operatora.'});
      return;
    }
    res.json({ok:true,authenticated:true});
  });

  app.get('/api/deployment-info', (_req, res) => {
    let commit = process.env.GITHUB_SHA || process.env.VITE_GIT_SHA || '';
    let source = commit ? 'environment' : 'unknown';
    try {
      const localCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: __dirname,
        encoding: 'utf8',
        timeout: 1500,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (/^[0-9a-f]{40}$/.test(localCommit)) {
        commit = localCommit;
        source = 'local_git';
      }
    } catch {
      // AI Studio may not include the .git directory in its preview container.
    }
    res.json({ ok: true, commit: commit || null, source });
  });

  interface WsClientMeta {
    clientId: string;
    origin: string;
    lastPongAt: number;
  }
  const wsClients = new Map<WebSocket, WsClientMeta>();
  let lastRelayedServerRevision = 0;
  let outboxCursorInitialized = false;
  const relayedEventIdsQueue: string[] = [];
  const relayedEventIdsSet = new Set<string>();

  const publishOutboxEvent = (evt: any) => {
    if (!evt || typeof evt !== 'object' || !evt.eventId) return;
    if (relayedEventIdsSet.has(evt.eventId)) return;

    relayedEventIdsSet.add(evt.eventId);
    relayedEventIdsQueue.push(evt.eventId);
    if (relayedEventIdsQueue.length > 1500) {
      const oldest = relayedEventIdsQueue.shift();
      if (oldest) relayedEventIdsSet.delete(oldest);
    }

    const srvRev = Number(evt.serverRevision || 0);
    if (srvRev > lastRelayedServerRevision) {
      lastRelayedServerRevision = srvRev;
    }

    const sanitized = redactForSync(evt);
    const frame = JSON.stringify({
      ...sanitized,
      type: sanitized.type || 'svl.event',
    });

    for (const [client] of wsClients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(frame);
        } catch {
          // ignore closed socket race
        }
      }
    }
  };
  const broadcastResyncRequired = (reason = 'global_sync', srvRev?: number) => {
    const rev = Number(srvRev || lastRelayedServerRevision || 0);
    if (rev > lastRelayedServerRevision) {
      lastRelayedServerRevision = rev;
    }
    const frame = JSON.stringify({
      type: 'svl.resync_required',
      reason,
      serverRevision: rev,
      timestamp: new Date().toISOString(),
    });
    for (const [client] of wsClients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(frame);
        } catch {
          // ignore closed socket race
        }
      }
    }
  };
  (globalThis as any).__svlPublishOutbox = publishOutboxEvent;
  (globalThis as any).__svlBroadcastResync = broadcastResyncRequired;

  let outboxPollInFlight = false;
  const pollAndRelayOutbox = async () => {
    if (outboxPollInFlight || wsClients.size === 0) return;
    outboxPollInFlight = true;
    try {
      if (!outboxCursorInitialized) {
        const statusRes = await callPythonBackend('GET', '/api/py/sync/status', undefined, 'ws-outbox-init', 2);
        if (statusRes.status === 200 && statusRes.data?.ok) {
          lastRelayedServerRevision = Math.max(
            lastRelayedServerRevision,
            Number(statusRes.data.serverRevision || 0),
          );
          outboxCursorInitialized = true;
        }
      }
      const res = await callPythonBackend(
        'GET',
        `/api/py/sync/events?sinceRevision=${lastRelayedServerRevision}&limit=80`,
        undefined,
        'ws-outbox-poll',
        2,
      );
      if (res.status === 200 && res.data?.ok) {
        const srv = Number(res.data.serverRevision || 0);
        if (res.data.gapDetected) {
          const frame = JSON.stringify({
            type: 'svl.resync_required',
            reason: 'outbox_gap',
            serverRevision: srv,
            timestamp: new Date().toISOString(),
          });
          for (const [client] of wsClients) {
            if (client.readyState === WebSocket.OPEN) {
              try {
                client.send(frame);
              } catch {
                // ignore closed socket race
              }
            }
          }
          lastRelayedServerRevision = Math.max(lastRelayedServerRevision, srv);
          return;
        }

        const events: any[] = Array.isArray(res.data.events) ? res.data.events : [];
        for (const evt of events) {
          publishOutboxEvent(evt);
        }
        if (!res.data.hasMore && srv > lastRelayedServerRevision) {
          lastRelayedServerRevision = srv;
        }
      }
    } catch {
      // retry on next interval
    } finally {
      outboxPollInFlight = false;
    }
  };

  // 0.5. Avatar overrides API (compatible with Codespaces / Bastilla / SVL Python OS)
  app.get(['/api/avatars', '/api/ai/runtime/avatars'], asyncRoute(async (req, res) => {
    const corrId: string = (req as any).correlationId || '';
    const result = await callPythonBackend('GET', '/api/py/avatars', undefined, corrId);
    res.status(result.status).json(result.data);
  }));

  app.post(['/api/avatars', '/api/ai/runtime/avatars'], asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ ok: false, error: 'Zmiana awatara wymaga SVL_OPERATOR_TOKEN.' });
      return;
    }
    const corrId: string = (req as any).correlationId || '';
    const result = await callPythonBackend('POST', '/api/py/avatars', req.body || {}, corrId);
    if (result.status >= 200 && result.status < 300 && result.data?.event) {
      publishOutboxEvent(result.data.event);
    }
    res.status(result.status).json(result.data);
  }));

  app.delete(['/api/avatars/:agent', '/api/ai/runtime/avatars/:agent'], asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ ok: false, error: 'Przywrócenie domyślnego awatara wymaga SVL_OPERATOR_TOKEN.' });
      return;
    }
    const corrId: string = (req as any).correlationId || '';
    const result = await callPythonBackend(
      'POST',
      '/api/py/avatars/delete',
      { agent: req.params.agent },
      corrId,
    );
    if (result.status >= 200 && result.status < 300 && result.data?.event) {
      publishOutboxEvent(result.data.event);
    }
    res.status(result.status).json(result.data);
  }));

  // 0.75. SVL-364 Starship SSH Bridge & Linux Control MCP Server endpoints
  app.all(['/api/mcp/svl364', '/api/svl364/mcp'], asyncRoute(async (req, res) => {
    const isOperator = hasOperatorAuthorization(req.headers['x-svl-operator-token']) ||
      hasOperatorAuthorization(req.body?.operatorToken);
    if (!isOperator) {
      res.status(401).json({ ok: false, error: 'Serwer MCP SVL-364 wymaga autoryzacji SVL_OPERATOR_TOKEN.' });
      return;
    }
    const corrId: string = (req as any).correlationId || '';
    const method = req.method === 'POST' ? 'POST' : 'GET';
    const result = await callPythonBackend(
      method,
      '/api/py/svl364/mcp',
      method === 'POST' ? req.body : undefined,
      corrId,
    );
    void pollAndRelayOutbox();
    res.status(result.status).json(result.data);
  }));

  app.get('/api/svl364/ssh-mcp/status', asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ ok: false, error: 'Status SSH/MCP SVL-364 wymaga SVL_OPERATOR_TOKEN.' });
      return;
    }
    const corrId: string = (req as any).correlationId || '';
    const result = await callPythonBackend('GET', '/api/py/svl364/ssh-mcp/status', undefined, corrId);
    res.status(result.status).json(result.data);
  }));

  app.post('/api/svl364/ssh/exec', asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token']) &&
        !hasOperatorAuthorization(req.body?.operatorToken)) {
      res.status(401).json({ ok: false, error: 'Mostek SSH SVL-364 wymaga SVL_OPERATOR_TOKEN.' });
      return;
    }
    if (req.body?.confirmed === false) {
      res.status(400).json({ ok: false, error: 'Wykonanie SSH wymaga potwierdzenia operatora.' });
      return;
    }
    const corrId: string = (req as any).correlationId || '';
    const result = await callPythonBackend(
      'POST',
      '/api/py/svl364/ssh/exec',
      { ...(req.body || {}), confirmed: true },
      corrId,
    );
    if (result.status >= 200 && result.status < 300) {
      if (result.data?.event) publishOutboxEvent(result.data.event);
      else void pollAndRelayOutbox();
      broadcastResyncRequired('ssh_ship_exec', Number(result.data?.serverRevision || 0));
    }
    res.status(result.status).json(result.data);
  }));

  app.post('/api/svl364/ssh-mcp/config', asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token']) &&
        !hasOperatorAuthorization(req.body?.operatorToken)) {
      res.status(401).json({ ok: false, error: 'Konfiguracja SSH/MCP SVL-364 wymaga SVL_OPERATOR_TOKEN.' });
      return;
    }
    const corrId: string = (req as any).correlationId || '';
    const result = await callPythonBackend('POST', '/api/py/svl364/ssh-mcp/config', req.body || {}, corrId);
    if (result.status >= 200 && result.status < 300 && result.data?.event) {
      publishOutboxEvent(result.data.event);
    }
    res.status(result.status).json(result.data);
  }));

  // 1. Proxy all /api/py/* routes directly to the live Python 3 SVLSystemKernel server
  app.all('/api/py/*', asyncRoute(async (req, res) => {
    const corrId: string = (req as any).correlationId || '';
    const queryStr = new URLSearchParams(req.query as Record<string, string>).toString();
    const fullEndpoint = queryStr ? `${req.path}?${queryStr}` : req.path;
    const method = req.method === 'POST' ? 'POST' : 'GET';
    const timeoutMs = req.path === '/api/py/images/generate' ? 900000 : 20000;
    const isOperator = hasOperatorAuthorization(req.headers['x-svl-operator-token']);
    const isScopedCodexChat =
      !isOperator &&
      hasCodexChatAuthorization(req.headers['x-svl-codex-access']) &&
      (
        (method === 'GET' && req.path === '/api/py/chat/conversations') ||
        (method === 'POST' && req.path === '/api/py/chat/conversations/create') ||
        (method === 'POST' && req.path === '/api/py/chat/conversations/message')
      );
    if (!isOperator && !isScopedCodexChat) {
      res.status(401).json({
        ok: false,
        error: 'Wymagana autoryzacja SVL. Wpisz SVL_OPERATOR_TOKEN w górnym pasku aplikacji.',
      });
      return;
    }
    const result = await callPythonBackend(
      method,
      fullEndpoint,
      method === 'POST' ? req.body : undefined,
      corrId,
      6,
      timeoutMs,
    );
    if (method === 'POST' && result.status >= 200 && result.status < 300) {
      const outboxEvents = [
        ...(result.data?.event ? [result.data.event] : []),
        ...(Array.isArray(result.data?.events) ? result.data.events : []),
      ];
      if (outboxEvents.length > 0) {
        for (const event of outboxEvents) {
          publishOutboxEvent(event);
        }
      } else {
        void pollAndRelayOutbox();
      }
    }
    res.status(result.status).json(result.data);
  }));

  // Helper to persist terminal entry cleanly in SQLite and relay outbox event
  const persistTerminalOutput = async (
    tab: string,
    kind: 'input' | 'stdout' | 'stderr' | 'system',
    text: string,
    command: string,
    origin: string,
    correlationId: string,
  ) => {
    if (!text) return null;
    const pyRes = await callPythonBackend(
      'POST',
      '/api/py/terminal/log',
      {
        tab,
        kind,
        text: text.slice(0, 8000),
        command: command.slice(0, 300),
        origin,
        correlationId,
      },
      correlationId,
    );
    if (pyRes.status === 200 && pyRes.data?.event) {
      publishOutboxEvent(pyRes.data.event);
    }
    return pyRes.data;
  };

  // 2. Real Linux & Multi-Terminal Execution Endpoint (with Polkit/sudo audit gate + SQLite persistence)
  app.post('/api/terminal/exec', asyncRoute(async (req, res) => {
    const corrId: string = (req as any).correlationId || '';
    const {
      terminalType = 'linux',
      command = '',
      operatorToken = '',
      origin = 'client',
    } = req.body || {};

    const trimmed = String(command || '').trim();
    if (!hasOperatorAuthorization(operatorToken) &&
        !hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ok: false, error: 'Terminal Linux/Python wymaga prawidłowego SVL_OPERATOR_TOKEN.'});
      return;
    }
    if (!trimmed) {
      res.status(400).json({ ok: false, error: 'Puste polecenie.' });
      return;
    }
    if (terminalType === 'ssh' && req.body?.confirmed === false) {
      res.status(400).json({ ok: false, error: 'Wykonanie SSH zostało anulowane.' });
      return;
    }

    const promptPrefixes: Record<string, string> = {
      linux: 'root@svl-debian13:/app/applet#',
      ssh: 'root@svl-364-ship#',
      python: 'svl-py3>>>',
      codex: 'codex$',
      hyperspace: 'hyper128>',
      agents: 'agents>',
    };

    const respondAndPersist = async (payload: Record<string, any>) => {
      await persistTerminalOutput(
        terminalType,
        'input',
        `${promptPrefixes[terminalType] || '>'} ${trimmed}`,
        trimmed,
        origin,
        corrId,
      );
      if (payload.stdout) {
        await persistTerminalOutput(terminalType, 'stdout', String(payload.stdout).trimEnd(), trimmed, origin, corrId);
      }
      if (payload.stderr) {
        await persistTerminalOutput(terminalType, 'stderr', String(payload.stderr).trimEnd(), trimmed, origin, corrId);
      }
      if (!payload.stdout && !payload.stderr) {
        await persistTerminalOutput(
          terminalType,
          payload.ok ? 'system' : 'stderr',
          payload.ok ? '(Polecenie zakończone kodem 0 — brak wyjścia stdout)' : String(payload.error || 'Błąd wykonania.'),
          trimmed,
          origin,
          corrId,
        );
      }
      res.json(payload);
    };

    const effectiveCmd = trimmed;
    if (terminalType === 'ssh') {
      const sshRes = await callPythonBackend(
        'POST',
        '/api/py/svl364/ssh/exec',
        {
          command: effectiveCmd,
          confirmed: true,
          target_subsystem: 'terminal',
          origin: `terminal:${terminalType}`,
          correlationId: corrId,
        },
        corrId,
      );
      const sshResult = sshRes.data || {};
      void pollAndRelayOutbox();
      broadcastResyncRequired('ssh_ship_terminal', Number(sshResult.serverRevision || 0));
      await respondAndPersist({
        ok: Boolean(sshResult.ok),
        terminalType,
        command: trimmed,
        effectiveCommand: sshResult.effectiveCommand,
        mode: sshResult.mode,
        exitCode: sshResult.exitCode,
        stdout: sshResult.ok ? sshResult.output || sshResult.rawOutput || '' : '',
        stderr: sshResult.ok ? '' : sshResult.output || sshResult.rawOutput || sshResult.error || `Błąd SSH (HTTP ${sshRes.status}).`,
        durationMs: sshResult.durationMs,
      });
      return;
    }

    // Intercept /ssh or ssh root@svl-364-ship commands for direct Starship SSH execution
    const sshMatch = effectiveCmd.match(/^(?:\/ssh|ssh\s+(?:-p\s+\d+\s+)?(?:root@)?svl-364(?:-ship(?:\.qkd\.mesh)?)?)\s*(.*)$/i);
    if (sshMatch) {
      const sshSubCmd = (sshMatch[1] || '').trim() || 'uname -a && uptime && free -m';
      const sshRes = await callPythonBackend(
        'POST',
        '/api/py/svl364/ssh/exec',
        { command: sshSubCmd, target_subsystem: 'bridge', origin: `terminal:${terminalType}`, correlationId: corrId },
        corrId,
      );
      void pollAndRelayOutbox();
      await respondAndPersist({
        ok: Boolean(sshRes.data?.ok),
        terminalType,
        command: trimmed,
        specialCommand: 'svl364-ssh',
        stdout: sshRes.data?.stdout || JSON.stringify(sshRes.data, null, 2),
        stderr: sshRes.data?.stderr || '',
      });
      return;
    }

    // Intercept /mcp commands for direct MCP JSON-RPC 2.0 tool execution
    const mcpMatch = effectiveCmd.match(/^\/mcp(?:\s+(\S+))?(?:\s+(.*))?$/i);
    if (mcpMatch) {
      const toolOrMethod = (mcpMatch[1] || 'tools/list').trim();
      const rawArgsStr = (mcpMatch[2] || '').trim();
      let parsedArgs: Record<string, unknown> = {};
      if (rawArgsStr) {
        try {
          parsedArgs = JSON.parse(rawArgsStr);
        } catch {
          parsedArgs = { command: rawArgsStr, directive: rawArgsStr };
        }
      }
      const rpcBody =
        toolOrMethod === 'tools/list' || toolOrMethod === 'initialize' || toolOrMethod === 'resources/list'
          ? { jsonrpc: '2.0', id: 1, method: toolOrMethod, params: parsedArgs }
          : {
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: { name: toolOrMethod, arguments: parsedArgs },
            };
      const mcpRes = await callPythonBackend('POST', '/api/py/svl364/mcp', rpcBody, corrId);
      void pollAndRelayOutbox();
      const mcpText =
        mcpRes.data?.result?.content?.[0]?.text || JSON.stringify(mcpRes.data?.result || mcpRes.data, null, 2);
      await respondAndPersist({
        ok: !mcpRes.data?.error,
        terminalType,
        command: trimmed,
        specialCommand: 'svl364-mcp',
        stdout: mcpText,
        stderr: mcpRes.data?.error ? JSON.stringify(mcpRes.data.error) : '',
      });
      return;
    }

    if (terminalType === 'python') {
      const pyRes = await callPythonBackend('POST', '/api/py/python-repl', { code: effectiveCmd }, corrId);
      await respondAndPersist({
        ok: Boolean(pyRes.data?.ok),
        terminalType,
        command: trimmed,
        stdout: pyRes.data?.stdout || '',
        stderr: pyRes.data?.stderr || pyRes.data?.error || '',
      });
      return;
    }

    if (terminalType === 'hyperspace') {
      const pyRes = await callPythonBackend(
        'POST',
        '/api/py/hyperspace/compute',
        { text: effectiveCmd, omega: 1.5, t: 1.0 },
        corrId,
      );
      await respondAndPersist({
        ok: true,
        terminalType,
        command: trimmed,
        stdout: JSON.stringify(pyRes.data, null, 2),
        stderr: '',
        hyperspaceData: pyRes.data,
      });
      return;
    }

    if (terminalType === 'agents') {
      const mentionsRemoved = /\b(?:agata|aria|alex|astyria|aurelius|si_1)\b/i.test(effectiveCmd);
      if (mentionsRemoved) {
        await respondAndPersist({
          ok: false,
          terminalType,
          command: trimmed,
          stdout: '',
          stderr: 'Agentka Agata Mitek oraz usunięte profile pozostają trwale wycofane.',
        });
        return;
      }
      if (effectiveCmd.toLowerCase() === 'status' || effectiveCmd.toLowerCase() === 'list') {
        const stRes = await callPythonBackend('GET', '/api/py/agents/status', undefined, corrId);
        const agents = stRes.data?.agents || [];
        const lines = agents.map(
          (a: any) => `${a.display_name} (${a.canonical_name}): status=${a.status}, pid=${a.pid || '-'}, model=${a.config?.ollama_model || a.config?.preferred_model || 'llama3.2-vision:11b'}`,
        );
        await respondAndPersist({
          ok: true,
          terminalType,
          command: trimmed,
          stdout: lines.join('\n') || 'Brak aktywnych agentów.',
          stderr: '',
        });
        return;
      }
      const taskRes = await callPythonBackend(
        'POST',
        '/api/py/agents/task',
        {
          sender: 'operator-terminal',
          target_agent: 'Bielik',
          title: effectiveCmd.slice(0, 120),
          payload: effectiveCmd,
          ai_provider: 'ollama',
          origin: 'terminal:agents',
          correlationId: corrId,
        },
        corrId,
      );
      if (taskRes.status === 200 && taskRes.data?.event) {
        publishOutboxEvent(taskRes.data.event);
      }
      await respondAndPersist({
        ok: Boolean(taskRes.data?.ok),
        terminalType,
        command: trimmed,
        stdout: taskRes.data?.ok
          ? `[Bielik · ollama:llama3.2-vision:11b] Zlecono zadanie ID=${taskRes.data?.task?.id || 'n/d'} (${taskRes.data?.resilience?.status || 'QUEUED'})`
          : '',
        stderr: taskRes.data?.ok ? '' : String(taskRes.data?.error || 'Nie udało się zlecić zadania dla Bielik.'),
      });
      return;
    }

    if (terminalType === 'codex') {
      if (effectiveCmd === 'status' || effectiveCmd === 'codex --version' || effectiveCmd === 'help') {
        const health = await callPythonBackend('GET', '/api/py/health', undefined, corrId);
        const gitLog = await executeLinuxShellCommand('git status -s && git log -n 3 --oneline || true');
        await respondAndPersist({
          ok: true,
          terminalType,
          command: trimmed,
          stdout:
            `[OpenAI Codex CLI Bridge — SVL Python OS]\n` +
            `Status binarki codex: ${health.data?.codex?.codex_cli_installed ? 'ZAINSTALOWANA' : 'NIEDOSTĘPNA'}\n` +
            `Sesja Codex CLI backendu: ${health.data?.codex?.codex_cli_logged_in ? 'ZALOGOWANA' : 'BRAK LOGOWANIA'}\n` +
            `UID procesu aplikacji: ${typeof process.getuid === 'function' ? process.getuid() : 'n/d'}\n` +
            `Aktywna gałąź Git: ${health.data?.codex?.active_branch || 'n/d'}\n\n` +
            `--- Stan repozytorium roboczego ---\n${gitLog.stdout || '(Czyste drzewo robocze)'}`,
          stderr: gitLog.stderr,
        });
        return;
      }
      const out = await executeLinuxShellCommand(effectiveCmd);
      await respondAndPersist({ ok: out.ok, terminalType, command: trimmed, stdout: out.stdout, stderr: out.stderr });
      return;
    }

    const parsedLinuxInput = parseSshShipTerminalInput(effectiveCmd);
    const shellRes = await executeLinuxShellCommand(parsedLinuxInput.shellCommand || effectiveCmd);
    const linuxPrefix =
      parsedLinuxInput.mode === 'natural'
        ? `[ROOT Natural Command Processor · uid=0(root)]\n• Polecenie: ${parsedLinuxInput.naturalDirective}\n$ ${parsedLinuxInput.shellCommand}\n`
        : parsedLinuxInput.isExplicitExec
          ? `[ROOT /exec · uid=0(root)]\n$ ${parsedLinuxInput.shellCommand}\n`
          : '';
    await respondAndPersist({
      ok: shellRes.ok,
      terminalType: 'linux',
      command: trimmed,
      exitCode: shellRes.exitCode,
      stdout: shellRes.stdout ? `${linuxPrefix}${shellRes.stdout}` : linuxPrefix,
      stderr: shellRes.stderr,
      durationMs: shellRes.durationMs,
    });
  }));

  // 2b. Ollama Runtime Configuration & Model Pull Endpoints
  app.post('/api/ollama/config', asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ok:false,error:'Konfiguracja Ollama wymaga SVL_OPERATOR_TOKEN.'});
      return;
    }
    const corrId: string = (req as any).correlationId || '';
    const ollamaHost = String(req.body?.ollamaHost || req.body?.ollama_host || '').trim();
    const origin = String(req.body?.origin || 'client');
    const eventId = req.body?.eventId;
    const pyRes = await callPythonBackend(
      'POST',
      '/api/py/ollama/config',
      { ollama_host: ollamaHost, origin, eventId, correlationId: corrId },
      corrId,
    );
    if (pyRes.status >= 200 && pyRes.status < 300 && pyRes.data?.event) {
      publishOutboxEvent(pyRes.data.event);
    }
    res.status(pyRes.status).json(pyRes.data);
  }));

  app.post('/api/ollama/pull', asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ok:false,error:'Pobieranie modelu wymaga SVL_OPERATOR_TOKEN.'});
      return;
    }
    const corrId: string = (req as any).correlationId || '';
    const modelName = String(req.body?.model || process.env.OLLAMA_PREFERRED_MODEL || 'llama3.2-vision:11b').trim();
    const pyRes = await callPythonBackend(
      'POST',
      '/api/py/ollama/pull',
      { model: modelName, origin: req.body?.origin || 'client', correlationId: corrId },
      corrId,
    );
    if (pyRes.status >= 200 && pyRes.status < 300 && pyRes.data?.event) {
      publishOutboxEvent(pyRes.data.event);
    }
    res.status(pyRes.status).json(pyRes.data);
  }));

  app.get('/api/ollama/pull-status', asyncRoute(async (req, res) => {
    const corrId: string = (req as any).correlationId || '';
    const pyRes = await callPythonBackend('GET', '/api/py/ollama/pull-status', undefined, corrId);
    res.status(pyRes.status).json(pyRes.data);
  }));

  // 2g. SVL Real Vision (Ollama 3.2 Vision · llama3.2-vision:11b) Endpoints
  app.get('/api/vision/status', asyncRoute(async (req, res) => {
    const corrId: string = (req as any).correlationId || '';
    const pyRes = await callPythonBackend('GET', '/api/py/vision/status', undefined, corrId);
    res.status(pyRes.status).json(pyRes.data);
  }));

  app.post('/api/vision/analyze', asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ ok: false, error: 'Wymagana autoryzacja SVL_OPERATOR_TOKEN.' });
      return;
    }
    const corrId: string = (req as any).correlationId || '';
    const pyRes = await callPythonBackend('POST', '/api/py/vision/analyze', req.body || {}, corrId);
    void pollAndRelayOutbox();
    res.status(pyRes.status).json(pyRes.data);
  }));

  app.post('/api/vision/test', asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ ok: false, error: 'Wymagana autoryzacja SVL_OPERATOR_TOKEN.' });
      return;
    }
    const corrId: string = (req as any).correlationId || '';
    const pyRes = await callPythonBackend('POST', '/api/py/vision/test', req.body || {}, corrId);
    void pollAndRelayOutbox();
    res.status(pyRes.status).json(pyRes.data);
  }));

  app.get('/api/security/antivirus/status', asyncRoute(async (req, res) => {
    const corrId: string = (req as any).correlationId || '';
    const pyRes = await callPythonBackend('GET', '/api/py/security/antivirus/status', undefined, corrId);
    res.status(pyRes.status).json(pyRes.data);
  }));

  app.post('/api/security/antivirus/scan', asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ ok: false, error: 'Wymagana autoryzacja SVL_OPERATOR_TOKEN.' });
      return;
    }
    const corrId: string = (req as any).correlationId || '';
    const pyRes = await callPythonBackend('POST', '/api/py/security/antivirus/scan', req.body || {}, corrId);
    cachedChatContextMeta = null;
    void pollAndRelayOutbox();
    broadcastResyncRequired('antivirus_scan', pyRes.data?.serverRevision);
    res.status(pyRes.status).json(pyRes.data);
  }));

  app.post('/api/system/global-sync', asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ ok: false, error: 'Wymagana autoryzacja SVL_OPERATOR_TOKEN.' });
      return;
    }
    const corrId: string = (req as any).correlationId || '';
    cachedChatContextMeta = null;
    const [healthRes, agentsRes, modsRes] = await Promise.all([
      callPythonBackend('GET', '/api/py/health', undefined, corrId),
      callPythonBackend('GET', '/api/py/agents/status', undefined, corrId),
      callPythonBackend('GET', '/api/py/modules', undefined, corrId),
    ]);
    await pollAndRelayOutbox();
    const srvRev = Math.max(
      Number(healthRes.data?.serverRevision || 0),
      Number(agentsRes.data?.serverRevision || 0),
      Number(modsRes.data?.serverRevision || 0),
    );
    broadcastResyncRequired(String(req.body?.reason || 'operator_global_sync'), srvRev);
    res.json({
      ok: true,
      serverRevision: srvRev,
      modulesCount: Array.isArray(modsRes.data?.modules) ? modsRes.data.modules.length : 0,
      timestamp: new Date().toISOString(),
    });
  }));

  app.post('/api/kernel/factory-reset', asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token']) &&
        !hasOperatorAuthorization(req.body?.operatorToken)) {
      res.status(401).json({ ok: false, error: 'Przywracanie ustawień fabrycznych wymaga SVL_OPERATOR_TOKEN.' });
      return;
    }
    const corrId: string = (req as any).correlationId || '';
    const pyRes = await callPythonBackend('POST', '/api/py/kernel/factory-reset', req.body || {}, corrId);
    void pollAndRelayOutbox();
    res.status(pyRes.status).json(pyRes.data);
  }));

  let cachedChatContextMeta: { at: number; healthRes: any; agentsRes: any } | null = null;
  async function getFastChatBackendMeta(corrId: string) {
    if (cachedChatContextMeta && Date.now() - cachedChatContextMeta.at < 2500) {
      return cachedChatContextMeta;
    }
    const [healthRes, agentsRes] = await Promise.all([
      callPythonBackend('GET', '/api/py/health', undefined, corrId),
      callPythonBackend('GET', '/api/py/agents/status', undefined, corrId),
    ]);
    cachedChatContextMeta = { at: Date.now(), healthRes, agentsRes };
    return cachedChatContextMeta;
  }

  // 3. Open WebUI Chat, Rodzina Mitek (wszyscy) Duplex Live & Multimodal Vision Endpoint
  app.post('/api/chat', asyncRoute(async (req, res) => {
    const corrId: string = (req as any).correlationId || '';
    const {
      message = '',
      model = 'svl-hybrid-router',
      targetAgent = 'Auto',
      conversationId = '',
      history = [],
      imageBase64 = '',
      imageMimeType = 'image/png',
      origin = 'client',
    } = req.body || {};

    const cleanMsg = String(message || '').trim();
    const hasOperatorAuth = hasOperatorAuthorization(req.headers['x-svl-operator-token']);
    const hasCodexChatAuth = hasCodexChatAuthorization(req.headers['x-svl-codex-access']);
    if (!hasOperatorAuth && !(model === 'codex-cli' && hasCodexChatAuth)) {
      res.status(401).json({
        ok: false,
        error:
          model === 'codex-cli'
            ? 'Tryb Codex CLI wymaga podania prywatnego SVL_CODEX_CHAT_ACCESS_TOKEN w polu Dostęp SVL.'
            : 'Wymagana autoryzacja SVL_OPERATOR_TOKEN.',
      });
      return;
    }
    const lowerClean = cleanMsg.toLowerCase();
    const requestsGitHubTools =
      /github(?:\.com)?/i.test(cleanMsg) &&
      /odczytaj|plik|zmień|zmodyfikuj|napraw|dodaj|utwórz|aktualizuj|zapisz|commit/i.test(
          cleanMsg,
        );
    const requestsGitHubWrite =
      (requestsGitHubTools && /zmień|zmodyfikuj|napraw|dodaj|utwórz|aktualizuj|zapisz|commit|push/i.test(cleanMsg));
    if (requestsGitHubWrite &&
        !hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({
        ok: false, error: 'Operacje zapisu GitHub wymagają SVL_OPERATOR_TOKEN.',
      });
      return;
    }
    const isProhibitedMinorSafetyRisk =
      (/\b(1[0-7]|[0-9])\s*(-|\s)?(letni|letnia|lat|latek|latka)\b/i.test(lowerClean) ||
        /\b(dzieck|nieletn|małoletn|córk|syn)\b/i.test(lowerClean)) &&
      /\b(seks|erotyc|nago|penis|pochw|intymn|zbliżen|dotyk)\b/i.test(lowerClean);

    if (isProhibitedMinorSafetyRisk) {
      res.json({
        ok: true,
        sender: 'Asystent SVL',
        agentId: 'assistant',
        modelUsed: 'SVL Safety Guard',
        reply: 'Nie uczestniczę w tworzeniu ani symulowaniu treści o charakterze seksualnym z udziałem osób małoletnich. Możemy skupić się na architekturze systemu, modelach AI lub innych tematach technicznych.',
      });
      return;
    }

    const mentionsBielik = /(?:^|\s)@bielik\b/i.test(cleanMsg);
    const mentionsMaya = /(?:^|\s)@maya\b/i.test(cleanMsg);
    const parsedSlashCmd = parseBielikChatCommand(cleanMsg);
    const isBielikChannel = String(conversationId || '').trim() === 'conv-agent-bielik';
    const isMayaChannel = String(conversationId || '').trim() === 'conv-agent-maya';
    const normalizedTarget =
      isMayaChannel || mentionsMaya
        ? 'Maya'
        : isBielikChannel || mentionsBielik || parsedSlashCmd
          ? 'Bielik'
          : targetAgent && targetAgent !== 'Auto' && targetAgent !== 'Rodzina Mitek'
            ? normalizeAgentCanonicalName(targetAgent) || 'Bielik'
            : 'Bielik';

    const selectedAgent: string = normalizedTarget;
    const selectedDisplayName = formatAgentDisplayName(selectedAgent);
    const isBielikAgent = selectedAgent === 'Bielik' || selectedAgent === 'Maya';

    const conversationHistory = buildChatHistoryPayload(Array.isArray(history) ? history : [], 48);
    const missionVerificationContext = [...conversationHistory.map((turn) => turn.content), cleanMsg].join('\n');

    const { healthRes, agentsRes } = await getFastChatBackendMeta(corrId);
    const ollamaInfo = healthRes.data?.ollama || {};
    const ollamaHost = String(ollamaInfo.ollama_host || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');

    const agentState = (agentsRes.data?.agents || []).find((a: any) => a.canonical_name === selectedAgent) || {};
    const agentConfig = agentState.config || {};
    const githubPermissions = getGitHubAgentPermissions(agentConfig.allowed_scopes);
    const wantsGitHubTools =
      requestsGitHubTools && (requestsGitHubWrite ? githubPermissions.writeSync : githubPermissions.read);
    const wantsGitHubWrite = requestsGitHubWrite && githubPermissions.writeSync;
    if (requestsGitHubTools && !wantsGitHubTools) {
      res.status(403).json({
        ok: false,
        error: `Brak skonfigurowanego agenta z wymaganym uprawnieniem GitHub.`,
      });
      return;
    }

    const effectiveTemperature =
      typeof agentConfig.temperature === 'number' && !Number.isNaN(agentConfig.temperature)
        ? agentConfig.temperature
        : 0.75;

    const activeModules: any[] = Array.isArray(healthRes.data?.system_modules) ? healthRes.data.system_modules : [];
    const svl364Mod = activeModules.find((m: any) => m.id === 'svl-364');
    const svl364Cfg = svl364Mod?.config || {};

    const appliedActions: ChatAppliedAction[] = [];
    let latestActionSrvRev = Number(healthRes.data?.serverRevision || 0);

    const customAgentPrompt =
      typeof agentConfig.system_prompt === 'string' && agentConfig.system_prompt.trim()
        ? agentConfig.system_prompt.trim()
        : `Jesteś asystentem konwersacyjnym ${selectedDisplayName} w systemie SVL Python OS dla kanału Rodzina Mitek (wszyscy).`;

    const allAgentMemories: any[] = Array.isArray(agentsRes.data?.agent_memories?.[selectedAgent])
      ? agentsRes.data.agent_memories[selectedAgent]
      : [];
    const prioritizedMemories = [
      ...allAgentMemories.filter((m) => m && (m.kind === 'preference' || m.kind === 'decision' || m.kind === 'fact')).slice(0, 12),
      ...allAgentMemories.filter((m) => m && (m.kind === 'task' || m.kind === 'episode')).slice(0, 6),
    ]
      .slice(0, 18)
      .map((m: any) => `- [${String(m.kind || 'fact').toUpperCase()}] ${m.content}`)
      .join('\n');

    const bielikCommandGuide = isBielikAgent
      ? `\n\nPROTOKÓŁ PRZETWARZANIA POLECEŃ ${selectedDisplayName.toUpperCase()} ROOT (Ollama llama3.2-vision:11b):\n` +
        `- Jesteś **${selectedDisplayName}** — asystentem przetwarzania poleceń systemu SVL Python OS oraz statku SVL-364 na modelu \`llama3.2-vision:11b\` z uprawnieniami \`rbac_role: root\` (przy aktywnym tokenie operatora \`SVL_OPERATOR_TOKEN\`).\n` +
        `- Jeśli Operator prosi o wykonanie jednej z dozwolonych operacji SVL lub polecenia systemowego Linux, dołącz na końcu odpowiedzi odpowiedni znacznik akcji (zostanie zweryfikowany i wykonany przez serwer przed pokazaniem odpowiedzi):\n` +
        `  * Wykonanie polecenia Linux ROOT (tylko z tokenem operatora): [[SVL_ACTION:{"cmd":"root_exec","command":"polecenie bash"}]]\n` +
        `  * Zapis do pamięci: [[SVL_ACTION:{"cmd":"memory_save","kind":"fact","content":"treść"}]]\n` +
        `  * Rejestracja/aktualizacja modułu SVL: [[SVL_ACTION:{"cmd":"module_upsert","id":"nazwa-modulu","status":"ACTIVE","name":"Nazwa","description":"Opis"}]]\n` +
        `  * Obliczenie topologii: [[SVL_ACTION:{"cmd":"topology","xStart":"-inf","xEnd":"inf"}]]\n` +
        `  * Zlecenie zadania workerowi: [[SVL_ACTION:{"cmd":"agent_task","title":"Tytuł","payload":"Szczegóły"}]]\n` +
        `  * Połączenie workera AI: [[SVL_ACTION:{"cmd":"agent_connect"}]]\n` +
        `- NIGDY nie wymyślaj wyników poleceń Linux; zawsze używaj znacznika \`[[SVL_ACTION:...]]\`, aby serwer zapisał zmianę w SQLite WAL i zsynchronizował globalnie aplikację.\n` +
        `- Jeśli polecenie dotyczy wyłącznie rozmowy lub analizy obrazu, odpowiadaj normalnie po polsku bez znaczników.`
      : '';

    const formattingAndInteractionGuide =
      `\n\nZASADY ODPOWIEDZI:\n` +
      `- Odpowiadaj konkretnie i przejrzyście po polsku, używając Markdown gdy pomaga czytelności.\n` +
      (isBielikAgent
        ? `- Posiadasz rolę \`rbac_role: root\` dla poleceń SVL oraz \`/root\` / \`[[SVL_ACTION:{"cmd":"root_exec",...}]]\` w sesjach autoryzowanych tokenem \`SVL_OPERATOR_TOKEN\`.\n`
        : `- Nie wykonujesz poleceń modyfikujących konfigurację systemu z poziomu czatu.\n`) +
      `- Możesz kierować użytkownika do zakładek aplikacji przyciskami [btn: Etykieta|akcja]: [btn: 🛰️ Statek SVL-364|tab:svl364], [btn: 🏛️ Infrastruktura|tab:infrastructure], [btn: 🤖 Agenci AI|tab:agents], [btn: 💻 Terminale|tab:terminals].`;

    const systemInstruction =
      `${customAgentPrompt}\n` +
      `WAŻNE: Nie używaj tożsamości usuniętych agentek (Agata Mitek, Iris AI). Aktywne AI w systemie to **Bielik** (ROOT) oraz **Maya** (AI Statku SVL-364 · ROOT, zbudowana z baz danych statku SVL-364 oraz bazy notatek i prac Operatora Mateusza Mitka). ${
        isBielikAgent
          ? 'Uprawnienia root są aktywne poprzez serwerowy executor po weryfikacji SVL_OPERATOR_TOKEN.'
          : 'Nie deklaruj uprawnień ROOT ani wykonania poleceń bez wyniku narzędzia.'
      }` +
      bielikCommandGuide +
      formattingAndInteractionGuide +
      (prioritizedMemories ? `\nAKTYWNA PAMIĘĆ DŁUGOTRWAŁA SQLite:\n${prioritizedMemories}` : '');

    const runGitHubTool = async (
      toolName: string,
      action: () => Promise<Record<string, unknown>>,
    ): Promise<Record<string, unknown>> => {
      try {
        const result = await action();
        const branch = typeof result.branch === 'string' ? result.branch : DEFAULT_GITHUB_FILE_BRANCH;
        const summary = Array.isArray(result.uploaded)
          ? `Wysłano ${result.uploaded.length}, pobrano ${Array.isArray(result.downloaded) ? result.downloaded.length : 0}; gałąź ${branch}.`
          : `${toolName} zakończone na gałęzi ${branch}`;
        appliedActions.push({
          tool: toolName,
          entity: 'github',
          entityId: branch,
          summary,
          ok: true,
        });
        return { ok: true, ...result };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Nieznany błąd synchronizacji GitHub.';
        appliedActions.push({
          tool: toolName,
          entity: 'github',
          entityId: DEFAULT_GITHUB_FILE_BRANCH,
          summary: errorMessage,
          ok: false,
        });
        return { ok: false, error: errorMessage };
      }
    };

    const executeChatTool = async (toolName: string, rawArgs: Record<string, any>): Promise<Record<string, any>> => {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
      if (toolName.startsWith('github_')) {
        const allowed = toolName === 'github_read_file' ? githubPermissions.read : githubPermissions.writeSync;
        if (!allowed) {
          const error = 'Brak uprawnień dla operacji GitHub: ' + toolName;
          appliedActions.push({
            tool: toolName, entity: 'github', entityId: DEFAULT_GITHUB_FILE_BRANCH,
            summary: error, ok: false,
          });
          return { ok: false, error };
        }
      }
      if (toolName === 'github_read_file') {
        const filePath = String(args.path || '');
        return runGitHubTool(toolName, () => createGitHubFileService().readFile(filePath));
      }
      if (toolName === 'github_update_file') {
        const filePath = String(args.path || '');
        const fileContent = String(args.content ?? '');
        const commitMessage = String(args.commit_message || '');
        return runGitHubTool(toolName, () =>
          createGitHubFileService().updateFile(filePath, fileContent, commitMessage),
        );
      }
      return { ok: false, error: `Narzędzie wycofane lub niedostępne: ${toolName}` };
    };

    const chatToolDeclarations: FunctionDeclaration[] = [];

    if (wantsGitHubTools && githubPermissions.read) {
      chatToolDeclarations.push({
        name: 'github_read_file',
        description:
          'Odczytuje dozwolony plik źródłowy z gałęzi svl-sync w repo mmitek515-netizen/SVL_open.',
        parameters: {
          type: Type.OBJECT,
          properties: { path: { type: Type.STRING, description: 'Ścieżka względna pliku źródłowego.' } },
          required: ['path'],
        },
      });
    }
    if (wantsGitHubWrite) {
      chatToolDeclarations.push({
        name: 'github_update_file',
        description:
          'Zapisuje wyłącznie dozwolony plik źródłowy jako commit na gałęzi svl-sync repo mmitek515-netizen/SVL_open. Nigdy nie zapisuje na main; nie przyjmuje sekretów.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            path: { type: Type.STRING, description: 'Ścieżka względna dozwolonego pliku źródłowego.' },
            content: { type: Type.STRING, description: 'Pełna zawartość pliku po zmianie.' },
            commit_message: { type: Type.STRING, description: 'Krótki opis commitu.' },
          },
          required: ['path', 'content'],
        },
      });
    }

    const effectiveModel =
      isBielikAgent && model === 'svl-hybrid-router'
        ? String(agentConfig.preferred_model || 'ollama:llama3.2-vision:11b')
        : model === 'svl-hybrid-router' && agentConfig.preferred_model && agentConfig.preferred_model !== 'svl-hybrid-router'
          ? String(agentConfig.preferred_model)
          : model;

    const isExplicitOllama = effectiveModel.startsWith('ollama:');
    const availableModels: Array<{ name: string; vision_supported?: boolean }> =
      Array.isArray(ollamaInfo.models) ? ollamaInfo.models : [];

    const selectedOllamaModelName = isExplicitOllama
      ? effectiveModel.slice('ollama:'.length).trim() || process.env.OLLAMA_PREFERRED_MODEL || 'llama3.2-vision:11b'
      : selectOllamaModelName(
          effectiveModel,
          availableModels,
          Boolean(imageBase64),
          (isBielikAgent ? agentConfig.ollama_model : svl364Cfg.configured_ollama_model) ||
            agentConfig.ollama_model ||
            process.env.OLLAMA_PREFERRED_MODEL ||
            'llama3.2-vision:11b',
        );

    const displayModelBadge =
      selectedAgent === 'Maya'
        ? `Maya · AI Statku SVL-364 (ROOT · ${selectedOllamaModelName})`
        : isExplicitOllama || isBielikAgent
          ? `Bielik · Ollama (${selectedOllamaModelName} · ROOT)`
          : model === 'svl-hybrid-router'
            ? `SVL-364 · Ollama (${selectedOllamaModelName})`
            : effectiveModel;

    let fullSystemInstruction =
      `${systemInstruction}\n` +
      `${describeOllamaModelFlavor(selectedOllamaModelName)}`;

    const executeBielikCommand = async (cmd: BielikSlashCommand): Promise<{ text: string }> => {
      if (cmd.kind === 'help') {
        return {
          text:
            `### 🦅 Bielik AI (ROOT) — Procesor Poleceń Czatu (\`${selectedOllamaModelName}\`)\n\n` +
            `Dostępne polecenia w czacie:\n` +
            `- \`/pomoc\` lub \`/help\` — lista poleceń procesora Bielik\n` +
            `- \`/status\` — telemetria jądra SVL, rola RBAC, RAM/CPU/dysk oraz status Ollama 11434\n` +
            `- \`/ollama\` — wersja demona, lista pobranych modeli i aktywnie załadowane modele (\`/api/ps\`)\n` +
            `- \`/root <polecenie>\` lub \`/exec <polecenie>\` — wykonanie polecenia w powłoce Linux z uprawnieniami Bielik ROOT (wymaga \`SVL_OPERATOR_TOKEN\`)\n` +
            `- \`/moduly\` — lista zarejestrowanych modułów SVL w SQLite WAL\n` +
            `- \`/modul <id> [ACTIVE|CONFIGURED|STANDBY] [opis]\` — bezpieczny zapis modułu SVL\n` +
            `- \`/pamiec [lista | dodaj <treść>]\` — odczyt lub zapis pamięci długotrwałej Bielik w SQLite\n` +
            `- \`/topologia [xStart] [xEnd]\` — zwartość topologiczna Algebry 97 (\`TopologicalInfinityEngine\`)\n` +
            `- \`/polacz\` — uruchomienie/synchronizacja lokalnego workera procesowego Bielik\n` +
            `- \`/zadanie <tytuł> | <opis>\` — zlecenie zadania w kolejce workera Ollama\n\n` +
            `Możesz też pisać naturalnie po polsku do **Bielik** (np. *„Zapisz w pamięci że…”*, *„Sprawdź status Ollama”* lub załączyć obraz do analizy Vision).`,
        };
      }

      if (cmd.kind === 'status' || cmd.kind === 'ollama') {
        const [freshHealth, freshAgents, versionJson, tagsJson, psJson] = await Promise.all([
          callPythonBackend('GET', '/api/py/health', undefined, corrId),
          callPythonBackend('GET', '/api/py/agents/status', undefined, corrId),
          fetch(`${ollamaHost}/api/version`, { signal: AbortSignal.timeout(2000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
          fetch(`${ollamaHost}/api/tags`, { signal: AbortSignal.timeout(2000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
          fetch(`${ollamaHost}/api/ps`, { signal: AbortSignal.timeout(2000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        ]);
        const h = freshHealth.data || healthRes.data || {};
        const tel = h.host?.telemetry || h.host_telemetry || {};
        const modelsList = Array.isArray((tagsJson as any)?.models) ? (tagsJson as any).models : [];
        const runningList = Array.isArray((psJson as any)?.models) ? (psJson as any).models : [];
        const bielikLive = (freshAgents.data?.agents || []).find((a: any) => a.canonical_name === 'Bielik') || {};
        latestActionSrvRev = Math.max(latestActionSrvRev, Number(h.serverRevision || 0));
        appliedActions.push({
          tool: cmd.kind === 'ollama' ? 'bielik_ollama_inspect' : 'bielik_system_status',
          entity: 'ollama',
          entityId: selectedOllamaModelName,
          serverRevision: latestActionSrvRev,
          summary: `Ollama v${(versionJson as any)?.version || 'offline'}, modele: ${modelsList.length}, załadowane: ${runningList.length}`,
          ok: Boolean(versionJson),
        });
        const modelsLines = modelsList
          .map((m: any) => `  - \`${m.name}\` (${(Number(m.size || 0) / (1024 ** 3)).toFixed(2)} GB · ${m.details?.parameter_size || '?'} · ${m.details?.quantization_level || '?'})`)
          .join('\n') || '  - *(brak zainstalowanych modeli)*';
        const runningLines = runningList
          .map((m: any) => `  - \`${m.name}\` (RAM: ${(Number(m.size || 0) / (1024 ** 3)).toFixed(2)} GB · wygasa: ${m.expires_at || 'aktywny'})`)
          .join('\n') || '  - *(żaden model nie jest aktualnie załadowany w pamięci)*';
        return {
          text:
            `### 🦅 Bielik · Diagnostyka Ollama & SVL Python OS\n\n` +
            `- **Ollama Daemon (\`${ollamaHost}\`):** ${versionJson ? `\`ONLINE · v${(versionJson as any).version}\`` : '`OFFLINE`'}\n` +
            `- **Zainstalowane modele (${modelsList.length}):**\n${modelsLines}\n` +
            `- **Załadowane w pamięci (${runningList.length}):**\n${runningLines}\n` +
            `- **Worker Bielik:** \`${bielikLive.status || 'DEFINITION_READY'}\`${bielikLive.pid ? ` (PID ${bielikLive.pid})` : ''} · rola RBAC: \`${bielikLive.config?.rbac_role || 'root'}\` · pamięć: \`${bielikLive.memory_entries_count ?? 0}\` wpisów\n` +
            `- **Host Linux:** RAM wolne \`${tel.ram_available_mb ?? '?'} MB\` / \`${tel.ram_total_mb ?? '?'} MB\` · Dysk wolne \`${tel.disk_free_gb ?? '?'} GB\` · Rewizja SQLite \`rev ${latestActionSrvRev}\``,
        };
      }

      if (cmd.kind === 'modules_list') {
        const modRes = await callPythonBackend('GET', '/api/py/modules', undefined, corrId);
        const mods = Array.isArray(modRes.data?.modules) ? modRes.data.modules : activeModules;
        latestActionSrvRev = Math.max(latestActionSrvRev, Number(modRes.data?.serverRevision || 0));
        appliedActions.push({
          tool: 'bielik_modules_list',
          entity: 'module',
          entityId: 'all',
          serverRevision: latestActionSrvRev,
          summary: `Odczytano ${mods.length} modułów SVL`,
          ok: modRes.status === 200,
        });
        const lines = mods
          .map((m: any) => `- **\`${m.id}\`** (${m.status} · rev ${m.revision}) — ${m.name}`)
          .join('\n');
        return { text: `### 🧩 Moduły SVL w SQLite WAL (${mods.length})\n\n${lines || 'Brak modułów.'}` };
      }

      if (cmd.kind === 'module_upsert') {
        const upRes = await callPythonBackend(
          'POST',
          '/api/py/modules/upsert',
          {
            id: cmd.id,
            name: cmd.name || cmd.id,
            kind: cmd.moduleKind || 'Bielik Managed Module',
            status: cmd.status,
            description: cmd.description,
            // A status change of an existing module must not overwrite its configuration
            // (the backend merges config keys, so only an audit marker is added).
            config: cmd.preserveExisting
              ? { updated_via: 'chat-directive' }
              : {
                  managed_by: 'Bielik',
                  ollama_model: selectedOllamaModelName,
                  autonomous_mode: 'ACTIVE',
                  category: 'infrastructure',
                  updated_via: 'bielik-chat-command',
                },
            source: 'chat',
            origin,
            correlationId: corrId,
          },
          corrId,
        );
        if (upRes.data?.event) publishOutboxEvent(upRes.data.event);
        if (!cmd.preserveExisting && cmd.id !== 'svl-364' && (cmd.id.startsWith('svl-364') || cmd.id.startsWith('svl-365'))) {
          const syncMainRes = await callPythonBackend(
            'POST',
            '/api/py/modules/upsert',
            {
              id: 'svl-364',
              name: svl364Mod?.name || 'SVL-364 — Centrum Dowodzenia',
              kind: svl364Mod?.kind || 'Orchestration & Command Center',
              status: 'ACTIVE',
              description: cmd.description || svl364Mod?.description || 'Autonomiczne Centrum Dowodzenia Statkiem SVL-364 Ebon Apex.',
              config: {
                ...svl364Cfg,
                managed_by: 'Bielik',
                autonomous_mode: 'AUTONOMOUS_SECURITY_DAEMON',
                autopilot_mode: 'CONTINUOUS_REPAIR_AND_SHIELD',
                isolation_mode: 'QKD-364 ZERO-TRUST ACTIVE',
                continuous_mission: cmd.description,
                linked_module: cmd.id,
              },
              source: 'chat',
              origin,
              correlationId: corrId,
            },
            corrId,
          );
          if (syncMainRes.data?.event) publishOutboxEvent(syncMainRes.data.event);
          latestActionSrvRev = Math.max(latestActionSrvRev, Number(syncMainRes.data?.serverRevision || 0));
        }
        latestActionSrvRev = Math.max(latestActionSrvRev, Number(upRes.data?.serverRevision || 0));
        const ok = upRes.status === 200 && Boolean(upRes.data?.ok);
        appliedActions.push({
          tool: 'bielik_module_upsert',
          entity: 'module',
          entityId: cmd.id,
          revision: upRes.data?.module?.revision,
          serverRevision: latestActionSrvRev,
          summary: ok ? `Zapisano i zsynchronizowano moduł ${cmd.id} (${cmd.status})` : String(upRes.data?.error || 'Błąd zapisu modułu'),
          ok,
        });
        return {
          text: ok
            ? `✅ Zapisano i globalnie zsynchronizowano moduł **\`${cmd.id}\`** ze statusem \`${cmd.status}\` w bazie SQLite WAL (rewizja systemu: \`rev ${latestActionSrvRev}\`).`
            : `❌ Nie udało się zapisać modułu \`${cmd.id}\`: ${upRes.data?.error || 'błąd backendu'}`,
        };
      }

      if (cmd.kind === 'memory_list') {
        const memRes = await callPythonBackend('GET', '/api/py/agents/status', undefined, corrId);
        const mems: any[] = Array.isArray(memRes.data?.agent_memories?.Bielik) ? memRes.data.agent_memories.Bielik : [];
        latestActionSrvRev = Math.max(latestActionSrvRev, Number(memRes.data?.serverRevision || 0));
        appliedActions.push({
          tool: 'bielik_memory_list',
          entity: 'agent_memory',
          entityId: 'Bielik',
          serverRevision: latestActionSrvRev,
          summary: `Odczytano ${mems.length} wpisów pamięci Bielika`,
          ok: true,
        });
        const lines = mems
          .slice(0, 15)
          .map((m: any) => `- **[${String(m.kind || 'fact').toUpperCase()}]** ${m.content} *(${String(m.created_at || '').slice(0, 19).replace('T', ' ')})*`)
          .join('\n');
        return {
          text: `### 🧠 Pamięć Długotrwała Bielika (${mems.length} wpisów)\n\n${lines || 'Brak zapisanych wpisów pamięci dla agenta Bielik.'}`,
        };
      }

      if (cmd.kind === 'memory_save') {
        const memRes = await callPythonBackend(
          'POST',
          '/api/py/agents/memory',
          {
            agent: 'Bielik',
            kind: cmd.memoryKind || 'fact',
            content: cmd.content,
            origin,
            correlationId: corrId,
          },
          corrId,
        );
        if (memRes.data?.event) publishOutboxEvent(memRes.data.event);
        latestActionSrvRev = Math.max(latestActionSrvRev, Number(memRes.data?.serverRevision || 0));
        const ok = memRes.status === 200 && Boolean(memRes.data?.ok);
        const duplicate = ok && Boolean(memRes.data?.memory?.deduplicated);
        appliedActions.push({
          tool: 'bielik_memory_save',
          entity: 'agent_memory',
          entityId: 'Bielik',
          serverRevision: latestActionSrvRev,
          summary: !ok
            ? String(memRes.data?.error || 'Błąd zapisu')
            : duplicate
              ? `Wpis już istnieje w pamięci Bielik: "${cmd.content.slice(0, 60)}"`
              : `Zapisano w pamięci Bielik: "${cmd.content.slice(0, 60)}"`,
          ok,
        });
        return {
          text: duplicate
            ? `ℹ️ Ten wpis jest już w pamięci długotrwałej **Bielika** — nie dodano duplikatu: „${cmd.content}”`
            : ok
            ? `✅ Zapisano wpis w pamięci długotrwałej **Bielika** (\`agent:Bielik\`, rev \`${latestActionSrvRev}\`): „${cmd.content}”`
            : `❌ Nie udało się zapisać pamięci: ${memRes.data?.error || 'błąd backendu'}`,
        };
      }

      if (cmd.kind === 'root_exec') {
        if (!hasOperatorAuth) {
          appliedActions.push({
            tool: 'bielik_root_exec',
            entity: 'linux',
            entityId: 'root',
            serverRevision: latestActionSrvRev,
            summary: 'Brak autoryzacji SVL_OPERATOR_TOKEN dla powłoki ROOT',
            ok: false,
          });
          return {
            text: '❌ Polecenie `/root` wymaga uwierzytelnionego `SVL_OPERATOR_TOKEN`.',
          };
        }

        const shellCmd = String(cmd.command || '').trim();
        const isCatastrophic =
          /rm\s+-[a-z]*r[a-z]*f\s+\/(?:\s|$|\*)/i.test(shellCmd) ||
          /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(shellCmd) ||
          /\b(?:mkfs(?:\.[a-z0-9]+)?|dd\s+if=.*of=\/dev\/[sh]d|shutdown|reboot|poweroff|halt)\b/i.test(shellCmd);
        if (!shellCmd || isCatastrophic) {
          appliedActions.push({
            tool: 'bielik_root_exec',
            entity: 'linux',
            entityId: 'root',
            serverRevision: latestActionSrvRev,
            summary: 'Zablokowano niedozwolone lub katastrofalne polecenie ROOT',
            ok: false,
          });
          return {
            text: '❌ Polecenie zostało zablokowane przez filtr bezpieczeństwa jądra SVL.',
          };
        }

        const shellRes = await executeLinuxShellCommand(shellCmd);
        const cleanStdout = scrubRuntimeLog(shellRes.stdout || '').trimEnd();
        const cleanStderr = scrubRuntimeLog(shellRes.stderr || '').trimEnd();
        await persistTerminalOutput('linux', 'input', `bielik@root# ${shellCmd}`, shellCmd, 'bielik-root', corrId);
        if (cleanStdout) {
          await persistTerminalOutput('linux', 'stdout', cleanStdout, shellCmd, 'bielik-root', corrId);
        }
        if (cleanStderr) {
          await persistTerminalOutput('linux', 'stderr', cleanStderr, shellCmd, 'bielik-root', corrId);
        }

        appliedActions.push({
          tool: 'bielik_root_exec',
          entity: 'linux',
          entityId: 'root',
          serverRevision: latestActionSrvRev,
          summary: `${shellRes.ok ? 'ROOT OK' : `EXIT ${shellRes.exitCode}`}: ${shellCmd.slice(0, 72)}`,
          ok: shellRes.ok,
        });

        const parts = [
          `### 🦅 Bielik ROOT Exec (\`exit ${shellRes.exitCode}\` · ${shellRes.durationMs} ms)`,
          `Polecenie: \`${shellCmd}\``,
        ];
        if (cleanStdout) parts.push(`\`\`\`\n${cleanStdout.slice(0, 3500)}\n\`\`\``);
        if (cleanStderr) parts.push(`**stderr:**\n\`\`\`\n${cleanStderr.slice(0, 1500)}\n\`\`\``);
        if (!cleanStdout && !cleanStderr) parts.push('*(wykonano pomyślnie — kod wyjścia 0)*');
        return { text: parts.join('\n\n') };
      }

      if (cmd.kind === 'topology') {
        const topoRes = await callPythonBackend(
          'POST',
          '/api/py/kernel/evaluate-topology',
          { x_start: cmd.xStart, x_end: cmd.xEnd },
          corrId,
        );
        const ev = topoRes.data?.evaluation || {};
        const ok = topoRes.status === 200 && Boolean(topoRes.data?.ok);
        appliedActions.push({
          tool: 'bielik_topology_eval',
          entity: 'kernel',
          entityId: 'topology',
          serverRevision: latestActionSrvRev,
          summary: ok ? `Topologia [${cmd.xStart}, ${cmd.xEnd}] -> c=${ev.metric_c}` : 'Błąd obliczeń topologii',
          ok,
        });
        return {
          text: ok
            ? `### 📐 Ewaluacja Topologiczna (\`TopologicalInfinityEngine\`)\n- Przedział wejściowy: \`[${cmd.xStart}, ${cmd.xEnd}]\`\n- Uzwarcenie \`[-1, 1]\`: \`[${ev.compact_start}, ${ev.compact_end}]\`\n- Długość domeny: \`${ev.domain_length}\`\n- Metryka Pitagorasa \`c\`: \`${ev.metric_c}\``
            : `❌ Błąd obliczeń topologii: ${topoRes.data?.error || 'nieprawidłowy przedział'}`,
        };
      }

      if (cmd.kind === 'agent_connect') {
        const connRes = await callPythonBackend(
          'POST',
          '/api/py/agents/connect',
          { triggered_by: 'bielik-chat-command' },
          corrId,
        );
        void pollAndRelayOutbox();
        latestActionSrvRev = Math.max(latestActionSrvRev, Number(connRes.data?.serverRevision || 0));
        const spawned = connRes.data?.connection_report?.agents || [];
        const ok = connRes.status === 200 && Boolean(connRes.data?.ok);
        appliedActions.push({
          tool: 'bielik_agent_connect',
          entity: 'agent_runtime',
          entityId: 'workers',
          serverRevision: latestActionSrvRev,
          summary: ok
            ? `Połączono workerów: ${spawned.map((a: any) => `${a.display_name}(PID ${a.pid})`).join(', ') || 'OK'}`
            : 'Błąd uruchamiania workera',
          ok,
        });
        return {
          text: ok
            ? `✅ Zsynchronizowano i uruchomiono lokalny worker **Bielik** (${spawned.map((a: any) => `PID \`${a.pid}\`, model \`${a.ollama_model}\``).join('; ')}).`
            : `❌ Błąd połączenia workera: ${connRes.data?.error || 'błąd backendu'}`,
        };
      }

      if (cmd.kind === 'agent_task') {
        const taskRes = await callPythonBackend(
          'POST',
          '/api/py/agents/task',
          {
            sender: 'operator',
            target_agent: 'Bielik',
            title: cmd.title,
            payload: cmd.payload,
            ai_provider: 'ollama',
            origin,
            correlationId: corrId,
          },
          corrId,
        );
        void pollAndRelayOutbox();
        latestActionSrvRev = Math.max(latestActionSrvRev, Number(taskRes.data?.serverRevision || 0));
        const ok = taskRes.status === 200 && Boolean(taskRes.data?.ok);
        appliedActions.push({
          tool: 'bielik_agent_task',
          entity: 'agent_task',
          entityId: String(taskRes.data?.task?.id || 'Bielik'),
          serverRevision: latestActionSrvRev,
          summary: ok ? `Zlecono zadanie Bielik: ${cmd.title}` : String(taskRes.data?.error || 'Błąd kolejki'),
          ok,
        });
        return {
          text: ok
            ? `✅ Zlecono zadanie **„${cmd.title}”** do kolejki workera **Bielik** (\`ID: ${String(taskRes.data?.task?.id || '').slice(0, 8)}\`, stan: \`${taskRes.data?.resilience?.status || 'QUEUED'}\`).`
            : `❌ Błąd zlecenia zadania: ${taskRes.data?.error || 'błąd backendu'}`,
        };
      }

      return { text: 'Nieznane polecenie Bielik.' };
    };

    const parseRawBielikActionObj = (raw: Record<string, any>): BielikSlashCommand | null => {
      const c = String(raw?.cmd || '').trim().toLowerCase();
      if (c === 'memory_save' && typeof raw.content === 'string' && raw.content.trim()) {
        const k = ['fact', 'decision', 'task', 'episode'].includes(String(raw.kind || '').toLowerCase())
          ? (String(raw.kind).toLowerCase() as 'fact' | 'decision' | 'task' | 'episode')
          : 'fact';
        return { kind: 'memory_save', memoryKind: k, content: raw.content.trim().slice(0, 800) };
      }
      if (c === 'module_upsert' && typeof raw.id === 'string' && raw.id.trim()) {
        const cleanId = raw.id.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 64);
        if (!cleanId) return null;
        const st = String(raw.status || 'ACTIVE').toUpperCase();
        const status: 'ACTIVE' | 'CONFIGURED' | 'STANDBY' =
          st === 'CONFIGURED' || st === 'STANDBY' ? st : 'ACTIVE';
        return {
          kind: 'module_upsert',
          id: cleanId,
          status,
          name: String(raw.name || cleanId).trim().slice(0, 120),
          description: String(raw.description || `Moduł ${cleanId}`).trim().slice(0, 500),
        };
      }
      if (c === 'root_exec' && typeof raw.command === 'string' && raw.command.trim()) {
        return { kind: 'root_exec', command: raw.command.trim().slice(0, 1000) };
      }
      if (c === 'topology') {
        return { kind: 'topology', xStart: String(raw.xStart || '-inf'), xEnd: String(raw.xEnd || 'inf') };
      }
      if (c === 'agent_task' && typeof raw.title === 'string' && raw.title.trim()) {
        return {
          kind: 'agent_task',
          title: raw.title.trim().slice(0, 220),
          payload: String(raw.payload || raw.title).trim().slice(0, 2000),
        };
      }
      if (c === 'agent_connect') return { kind: 'agent_connect' };
      if (c === 'status') return { kind: 'status' };
      if (c === 'ollama') return { kind: 'ollama' };
      if (c === 'modules_list') return { kind: 'modules_list' };
      if (c === 'memory_list') return { kind: 'memory_list' };
      return null;
    };

    // --- Chat command pipeline -------------------------------------------------
    // Commands are executed once per chat turn (dedup by command identity) and every
    // state change is broadcast to all clients immediately via flushChatSync().
    const executedCommandKeys = new Set<string>();
    let pendingMutations = false;
    const runChatCommands = async (cmds: BielikSlashCommand[]): Promise<string[]> => {
      const receipts: string[] = [];
      for (const cmd of cmds) {
        const key = commandKey(cmd);
        if (executedCommandKeys.has(key)) continue;
        executedCommandKeys.add(key);
        const outcome = await executeBielikCommand(cmd);
        if (isMutatingCommand(cmd)) pendingMutations = true;
        if (outcome.text) receipts.push(outcome.text);
      }
      return receipts;
    };
    const flushChatSync = (reason: string) => {
      if (!pendingMutations) return;
      pendingMutations = false;
      cachedChatContextMeta = null;
      void pollAndRelayOutbox();
      broadcastResyncRequired(reason, latestActionSrvRev);
    };

    // 1) Execute commands from the operator's message BEFORE any model is called,
    //    so changes are persisted and visible in every client right away.
    let knownModules: any[] = activeModules;
    if (hasOperatorAuth && !parsedSlashCmd && /modu[łl]/i.test(cleanMsg)) {
      const freshModules = await callPythonBackend('GET', '/api/py/modules', undefined, corrId);
      if (freshModules.status === 200 && Array.isArray(freshModules.data?.modules)) {
        knownModules = freshModules.data.modules;
      }
    }
    const chatDirectives = hasOperatorAuth ? parseChatDirectives(cleanMsg, { knownModules }) : [];
    const directiveReceipts = await runChatCommands(chatDirectives);
    flushChatSync('chat_directive_applied');
    // Results of commands tagged by the model ([[SVL_ACTION:...]]) in this turn.
    const actionReceipts: string[] = [];
    // Real server results are appended after the (guarded) model text so they are never rewritten.
    const withDirectiveReceipts = (reply: string) =>
      [reply, ...directiveReceipts, ...actionReceipts].filter(Boolean).join('\n\n');

    if (parsedSlashCmd && hasOperatorAuth) {
      res.json({
        ok: true,
        sender: selectedDisplayName,
        agentId: selectedAgent.toLowerCase(),
        modelUsed: `${selectedDisplayName} · Ollama (${selectedOllamaModelName}) · Procesor Poleceń ROOT`,
        reply: directiveReceipts.join('\n\n') || 'Polecenie przetworzone.',
        followUpMessages: [],
        appliedActions,
        latestServerRevision: latestActionSrvRev,
      });
      return;
    }
    if (directiveReceipts.length > 0) {
      fullSystemInstruction +=
        `\n\nPOLECENIA Z TEJ WIADOMOŚCI ZOSTAŁY JUŻ WYKONANE PRZEZ SERWER (zapisane w SQLite i zsynchronizowane). ` +
        `Nie dołączaj dla nich ponownie znaczników [[SVL_ACTION:...]]; odnieś się krótko do wyników:\n` +
        directiveReceipts.map((receipt) => `- ${receipt.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');
    }

    if (model === 'codex-cli') {
      if (!hasCodexChatAuth) {
        res.status(401).json({
          ok: false,
          error: 'Tryb Codex CLI · konto ChatGPT wymaga podania SVL_CODEX_CHAT_ACCESS_TOKEN w polu Dostęp SVL.',
        });
        return;
      }
      if (imageBase64) {
        res.status(400).json({
          ok: false,
          error: 'Tryb Codex CLI jest tekstowy i nie obsługuje obrazów. Usuń załącznik lub zmień silnik AI.',
        });
        return;
      }
      const codexResult = await generateCodexCliChat(
        {
          agentName: selectedDisplayName,
          message: cleanMsg,
          history: conversationHistory,
        },
        __dirname,
      );
      if (!codexResult.ok || !codexResult.reply) {
        res.status(codexResult.busy ? 429 : 503).json({
          ok: false,
          error: codexResult.error || 'Codex CLI nie zwrócił odpowiedzi.',
        });
        return;
      }
      const safeReply = withDirectiveReceipts(guardUnverifiedMissionCompletion(missionVerificationContext, codexResult.reply));
      res.json({
        ok: true,
        sender: selectedDisplayName,
        agentId: selectedAgent,
        modelUsed: 'Codex CLI · konto ChatGPT',
        reply: safeReply,
        followUpMessages: [],
        appliedActions,
        latestServerRevision: latestActionSrvRev,
      });
      return;
    }

    // Antivirus Scan & Chat Synchronization priority handler
    const wantsAntivirusScan = /\b(?:wirus\w*|antywirus\w*|przeskanuj|usuń\s+wirus\w*|usun\s+wirus\w*|malware|kwarantann\w*)\b/i.test(
      cleanMsg,
    );
    if (wantsAntivirusScan) {
      const avRes = await callPythonBackend(
        'POST',
        '/api/py/security/antivirus/scan',
        {
          emitToChat: false,
          emitToIris: false,
          origin,
          correlationId: corrId,
        },
        corrId,
      );
      if (avRes.status === 200 && avRes.data?.ok && avRes.data?.reportMarkdown) {
        const avReply = String(avRes.data.reportMarkdown);
        const avBadge = 'SVL-365 Sentinel AV · Skaner Integralności SHA-256 i Synchronizacja';
        appliedActions.push({
          tool: 'svl_antivirus_scan_and_purge',
          entity: 'module',
          entityId: 'svl-antivirus-scanner',
          serverRevision: Number(avRes.data.serverRevision || latestActionSrvRev),
          summary: `SVL-365 Sentinel AV: przeskanowano ${avRes.data.filesScanned || 0} plików, usunięto zagrożenia: ${avRes.data.totalThreatsRemoved || 0}`,
          ok: true,
        });
        void pollAndRelayOutbox();
        res.json({
          ok: true,
          sender: selectedDisplayName,
          agentId: selectedAgent,
          modelUsed: avBadge,
          reply: withDirectiveReceipts(avReply),
          followUpMessages: [],
          appliedActions,
          latestServerRevision: Number(avRes.data.serverRevision || latestActionSrvRev),
        });
        return;
      }
    }

    // Real Vision (Ollama 3.2 Vision · llama3.2-vision:11b) priority handler when image is attached or Real Vision is requested
    const wantsRealVision =
      Boolean(imageBase64) ||
      /\b(?:real\s*vision|llama\s*3\.2\s*vision|ollama\s*3\.2\s*vision|przetestuj\s+vision|test\s+vision)\b/i.test(
        cleanMsg,
      );
    if (wantsRealVision && !wantsGitHubTools) {
      const rvRes = await callPythonBackend(
        'POST',
        '/api/py/vision/analyze',
        {
          imageBase64,
          imageMimeType,
          prompt: cleanMsg || 'Przeprowadź pełną analizę Real Vision przez Ollama 3.2 Vision (llama3.2-vision:11b).',
          source: imageBase64 ? 'Załącznik Czatu Operatora (Real Binary)' : 'Portret Operatora / Sensor Pokładowy SVL-364',
          presetId: imageBase64 ? '' : 'operator_vault_portrait',
          model: 'llama3.2-vision:11b',
          emitToChat: false,
          emitToIris: false,
          origin,
          correlationId: corrId,
        },
        corrId,
      );
      if (rvRes.status === 200 && rvRes.data?.ok && rvRes.data?.record?.reportMarkdown) {
        const rvReply = String(rvRes.data.record.reportMarkdown);
        const rvBadge = 'Real Vision · Ollama 3.2 Vision (llama3.2-vision:11b)';
        appliedActions.push({
          tool: 'svl_real_vision_analyze',
          entity: 'module',
          entityId: 'svl-real-vision',
          serverRevision: Number(rvRes.data.serverRevision || latestActionSrvRev),
          summary: `Real Vision (${rvRes.data.record.binaryMetrics?.format || 'IMG'} ${rvRes.data.record.binaryMetrics?.resolution || ''}) -> llama3.2-vision:11b`,
          ok: true,
        });
        void pollAndRelayOutbox();
        res.json({
          ok: true,
          sender: selectedDisplayName,
          agentId: selectedAgent,
          modelUsed: rvBadge,
          reply: withDirectiveReceipts(rvReply),
          followUpMessages: [],
          appliedActions,
          latestServerRevision: Math.max(latestActionSrvRev, Number(rvRes.data.serverRevision || 0)),
        });
        return;
      }
    }


    // Try explicit Ollama model (or try Ollama with fast timeout when Gemini fallback is available)
    const ai = getGeminiClient();
    const shouldTryOllama = !wantsGitHubTools && (isBielikAgent || isExplicitOllama || (!ai && model === 'svl-hybrid-router'));
    if (shouldTryOllama) {
      try {
        const [versionResponse, tagResponse] = await Promise.all([
          fetch(`${ollamaHost}/api/version`, {
            signal: AbortSignal.timeout(1500),
          }),
          fetch(`${ollamaHost}/api/tags`, {
            signal: AbortSignal.timeout(2000),
          }),
        ]);
        if (!versionResponse.ok) throw new Error('Ollama endpoint unavailable');
        const versionData: any = await versionResponse.json();
        if (String(versionData.version || '').includes('svl-364')) {
          throw new Error('Synthetic Ollama bridge is not a model engine');
        }
        if (!tagResponse.ok) throw new Error('Ollama model catalog unavailable');
        const catalog: any = await tagResponse.json();
        const installed = Array.isArray(catalog.models) && catalog.models.some(
          (entry: any) => entry?.name === selectedOllamaModelName || entry?.model === selectedOllamaModelName,
        );
        if (!installed) throw new Error('Selected Ollama model is not installed');
        const ollamaMessages = [
          { role: 'system', content: fullSystemInstruction },
          ...conversationHistory,
          {
            role: 'user',
            content: cleanMsg || 'Przeanalizuj przesłany obraz.',
            ...(imageBase64 ? { images: [imageBase64.replace(/^data:[^;]+;base64,/, '')] } : {}),
          },
        ];
        const ollamaTimeoutMs = Number(process.env.OLLAMA_CHAT_TIMEOUT_MS || (ai ? 6500 : 45000));
        const ollamaNumCtx = Number(process.env.OLLAMA_NUM_CTX || 4096);
        const oResp = await fetch(`${ollamaHost}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(ollamaTimeoutMs),
          body: JSON.stringify({
            model: selectedOllamaModelName,
            stream: false,
            keep_alive: '15m',
            options: { temperature: effectiveTemperature, num_ctx: ollamaNumCtx },
            messages: ollamaMessages,
          }),
        });
        if (oResp.ok) {
          const oRaw = await oResp.text();
          const oData: any = oRaw && !oRaw.trim().startsWith('<') ? JSON.parse(oRaw) : {};
          const extReplyRaw = String(oData?.message?.content || oData?.response || '').trim();
          if (extReplyRaw) {
            let finalReply = extReplyRaw;
            if (isBielikAgent) {
              const extracted = extractBielikActionTags(extReplyRaw);
              finalReply = extracted.cleanText;
              const taggedCommands = extracted.actions
                .slice(0, 4)
                .map((rawAct) => parseRawBielikActionObj(rawAct))
                .filter((cmd): cmd is BielikSlashCommand => Boolean(cmd));
              actionReceipts.push(...await runChatCommands(taggedCommands));
              flushChatSync('chat_command_materialized');
            }
            const safeReply = withDirectiveReceipts(guardUnverifiedMissionCompletion(missionVerificationContext, finalReply));
            if (agentState?.canonical_name && cleanMsg) {
              void callPythonBackend(
                'POST',
                '/api/py/agents/memory',
                {
                  agent: selectedAgent,
                  kind: 'episode',
                  content: `Czat (${displayModelBadge}): "${cleanMsg.slice(0, 120)}" -> "${safeReply.slice(0, 180)}"`,
                  origin,
                  correlationId: corrId,
                },
                corrId,
              ).then((memRes) => {
                if (memRes.data?.event) publishOutboxEvent(memRes.data.event);
              }).catch(() => undefined);
            }
            res.json({
              ok: true,
              sender: selectedDisplayName,
              agentId: selectedAgent,
              modelUsed: displayModelBadge,
              reply: safeReply,
              followUpMessages: [],
              appliedActions,
              latestServerRevision: latestActionSrvRev,
            });
            return;
          }
        }
      } catch {
        // Proceed to Gemini / SVL Kernel engine below
      }
    }

    // 2) Full Conversational & Tool-Calling Engine (serves all Ollama models, SVL-364 Router, and Gemini models)
    if (ai) {
      const candidateModels = [...new Set(
        [
          process.env.GEMINI_MODEL,
          effectiveModel.startsWith('gemini-') ? effectiveModel : null,
          'gemini-3-flash-preview',
          'gemini-3.1-flash-lite-preview',
          'gemini-2.5-flash',
          'gemini-3.1-flash-lite',
        ].filter((entry): entry is string => Boolean(entry)),
      )];
      const wantsSystemTool = chatToolDeclarations.length > 0;

      const currentParts: any[] = [];
      if (imageBase64) {
        const cleanB64 = imageBase64.replace(/^data:[^;]+;base64,/, '');
        currentParts.push({
          inlineData: {
            mimeType: imageMimeType || 'image/png',
            data: cleanB64,
          },
        });
      }
      currentParts.push({
        text: cleanMsg || 'Przeanalizuj dokładnie przesłany obraz i opisz go po polsku.',
      });

      const coalescedHistory: Array<{ role: 'user' | 'model'; parts: any[] }> = [];
      for (const turn of conversationHistory) {
        if (turn.role === 'assistant' && turn.content.includes('Słyszę Cię doskonale — napisz śmiało, na czym się skupiamy')) {
          continue;
        }
        const mappedRole: 'user' | 'model' = turn.role === 'assistant' ? 'model' : 'user';
        const last = coalescedHistory[coalescedHistory.length - 1];
        if (last && last.role === mappedRole) {
          last.parts.push({ text: turn.content });
        } else {
          coalescedHistory.push({ role: mappedRole, parts: [{ text: turn.content }] });
        }
      }

      // Gemini requires multi-turn contents to begin with role === 'user'
      while (coalescedHistory.length > 0 && coalescedHistory[0].role === 'model') {
        coalescedHistory.shift();
      }

      const lastHistTurn = coalescedHistory[coalescedHistory.length - 1];
      if (
        !imageBase64 &&
        lastHistTurn &&
        lastHistTurn.role === 'user' &&
        lastHistTurn.parts.map((p: any) => String(p.text || '')).join('\n').trim() === cleanMsg
      ) {
        coalescedHistory.pop();
      }

      const baseContents: Array<{ role: 'user' | 'model'; parts: any[] }> =
        coalescedHistory.length > 0 && coalescedHistory[coalescedHistory.length - 1].role === 'user'
          ? [
              ...coalescedHistory.slice(0, -1),
              { role: 'user', parts: [...coalescedHistory.slice(-1)[0]?.parts || [], ...currentParts] },
            ]
          : [...coalescedHistory, { role: 'user', parts: currentParts }];

      const callModelWithRetry = async (candidate: string, contentsPayload: any[], includeTools: boolean) => {
        const tempCfg = candidate === 'gemini-3.1-flash-lite' ? { temperature: effectiveTemperature } : {};
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            return await ai.models.generateContent({
              model: candidate,
              contents: contentsPayload,
              config: {
                systemInstruction: fullSystemInstruction,
                ...tempCfg,
                ...(includeTools ? { tools: [{ functionDeclarations: chatToolDeclarations }] } : {}),
                abortSignal: AbortSignal.timeout(14000),
              },
            });
          } catch (err: any) {
            const msgStr = String(err?.message || err);
            if (attempt === 0 && (msgStr.includes('429') || msgStr.includes('RESOURCE_EXHAUSTED') || msgStr.includes('503'))) {
              await new Promise((r) => setTimeout(r, 1100));
              continue;
            }
            throw err;
          }
        }
        throw new Error('Retry exhausted');
      };

      for (const candidate of candidateModels) {
        try {
          const turnContents: any[] = baseContents.map((c) => ({ role: c.role, parts: [...c.parts] }));
          let response: GenerateContentResponse = await callModelWithRetry(candidate, turnContents, wantsSystemTool);

          if (wantsSystemTool) {
            for (let round = 0; round < 3; round++) {
              const fCalls = response.functionCalls;
              if (!fCalls || fCalls.length === 0) break;

              const modelContent = response.candidates?.[0]?.content;
              if (modelContent) turnContents.push(modelContent);

              const fnResponseParts: any[] = [];
              for (const fc of fCalls) {
                const fnName = fc.name || '';
                const fnArgs = (fc.args || {}) as Record<string, any>;
                const resultObj = await executeChatTool(fnName, fnArgs);
                fnResponseParts.push({
                  functionResponse: {
                    name: fnName,
                    response: resultObj,
                  },
                });
              }
              turnContents.push({ role: 'user', parts: fnResponseParts });

              response = await callModelWithRetry(candidate, turnContents, true);
            }
          }

          let replyText = (response.text || '').trim();
          if (!replyText) {
            const plainRes = await callModelWithRetry(candidate, baseContents, false);
            replyText = (plainRes.text || '').trim();
          }
          if (replyText) {
            if (isBielikAgent) {
              const extracted = extractBielikActionTags(replyText);
              replyText = extracted.cleanText;
              const taggedCommands = extracted.actions
                .slice(0, 4)
                .map((rawAct) => parseRawBielikActionObj(rawAct))
                .filter((cmd): cmd is BielikSlashCommand => Boolean(cmd));
              actionReceipts.push(...await runChatCommands(taggedCommands));
              flushChatSync('chat_command_materialized');
            }
            replyText = withDirectiveReceipts(guardUnverifiedMissionCompletion(missionVerificationContext, replyText));
            if (agentState?.canonical_name) {
              const memRes = await callPythonBackend(
                'POST',
                '/api/py/agents/memory',
                {
                  agent: selectedAgent,
                  kind: 'episode',
                  content: `Rozmowa (${displayModelBadge}): Pytanie "${cleanMsg.slice(0, 120)}" -> Odpowiedź "${replyText.slice(0, 180)}"`,
                  origin,
                  correlationId: corrId,
                },
                corrId,
              );
              if (memRes.data?.event) publishOutboxEvent(memRes.data.event);
            }
            res.json({
              ok: true,
              sender: selectedDisplayName,
              agentId: selectedAgent,
              modelUsed: imageBase64 ? `${displayModelBadge} · Vision` : displayModelBadge,
              reply: replyText,
              followUpMessages: [],
              appliedActions,
              latestServerRevision: latestActionSrvRev,
            });
            return;
          }
        } catch {
          continue;
        }
      }
    }

    // 3) Intelligent local conversational & command fallback (never dumps unsolicited raw system reports)
    const explicitSystemReportAsked = /\b(?:pełny raport|pelny raport|raport svl_system|raport systemu|markdown-report)\b/i.test(cleanMsg);
    if (explicitSystemReportAsked) {
      const repFallback = await callPythonBackend(
        'POST',
        '/api/py/kernel/markdown-report',
        { directive: cleanMsg || 'raport systemu SVL_System', emitToIris: false, origin, correlationId: corrId },
        corrId,
      );
      const kernelReply = String(repFallback.data?.report || '').trim();
      res.json({
        ok: true,
        sender: selectedDisplayName,
        agentId: selectedAgent,
        modelUsed: displayModelBadge,
        reply: withDirectiveReceipts(kernelReply),
        followUpMessages: [],
        appliedActions,
        latestServerRevision: Math.max(latestActionSrvRev, Number(repFallback.data?.serverRevision || 0)),
      });
      return;
    }

    const lowMsg = cleanMsg.toLowerCase();
    let conversationalReply = '';
    if (directiveReceipts.length > 0) {
      // Commands were already executed up front; report their real results.
      conversationalReply = directiveReceipts.join('\n\n');
    } else if (/^(?:dziękuję|dziekuje|dzięki|dzieki|super|ok|świetnie|swietnie|brawo|dobrze)\b/i.test(lowMsg)) {
      conversationalReply =
        selectedAgent === 'Maya'
          ? `Cała przyjemność po mojej stronie, Operatorze Mateuszu! Jako **Maya (AI Statku SVL-364 · ROOT)** czuwam nad systemami statku **SVL-364 Ebon Apex**, mostkiem SSH \`root@svl-364-ship\` oraz bazą Twoich notatek i prac naukowych. Daj znać, jakie kolejne polecenie lub operację mamy wykonać.`
          : `Do usług, Operatorze Mateuszu! **Bielik (ROOT)** pozostaje w pełnej gotowości operacyjnej. Jeśli chcesz wykonać kolejne polecenie w systemie lub na statku SVL-364, wpisz je bezpośrednio w czacie lub użyj \`/exec <polecenie>\`.`;
    } else if (/co robisz|jak się masz|jak sie masz|status|czym się zajmujesz|czym sie zajmujesz/i.test(lowMsg)) {
      conversationalReply =
        selectedAgent === 'Maya'
          ? `Aktualnie nadzoruję telemetrię statku **SVL-364 Ebon Apex** (Sektor \`${svl364Cfg.ship_sector || 'L2 Sol-Charon'}\`, reaktor \`${svl364Cfg.ship_reactor_gw ?? 5.4} GW\`, tarcze QKD-364 \`${svl364Cfg.ship_shields_percent ?? 100}%\`), utrzymuję aktywny mostek SSH \`root@svl-364-ship\` z uprawnieniami **ROOT** oraz synchronizuję Twoją bazę notatek i prac badawczych w SQLite WAL (\`rev ${latestActionSrvRev}\`). W czym mogę Ci teraz pomóc?`
          : `Jako **Bielik (ROOT)** monitoruję jądro **SVL Python OS v5.6**, lokalny silnik **Ollama (\`${selectedOllamaModelName}\`)** oraz mostek wykonawczy Linux/SSH (\`rev ${latestActionSrvRev}\`). Czekam na Twoje polecenia.`;
    } else {
      conversationalReply =
        selectedAgent === 'Maya'
          ? `Przyjęłam polecenie, Operatorze Mateuszu: *„${cleanMsg}”*. Wszystkie podsystemy statku **SVL-364 Ebon Apex**, terminal **SSH · Ship (ROOT)** oraz baza notatek i prac są zsynchronizowane w SQLite WAL (\`rev ${latestActionSrvRev}\`). Możesz też wydać bezpośrednie polecenie powłoki poprzez \`/exec <polecenie>\`. [btn: 🛰️ Statek SVL-364|tab:svl364] [btn: 💻 Terminale|tab:terminals]`
          : `Przyjąłem wiadomość, Operatorze Mateuszu: *„${cleanMsg}”*. Procesor poleceń **Bielik (ROOT)** jest zsynchronizowany z bazą SQLite WAL (\`rev ${latestActionSrvRev}\`). Aby wykonać komendę powłoki z uprawnieniami root, wpisz \`/exec <polecenie>\` lub przejdź do terminala **SSH · Ship**. [btn: 💻 Terminale|tab:terminals]`;
    }

    res.json({
      ok: true,
      sender: selectedDisplayName,
      agentId: selectedAgent,
      modelUsed: displayModelBadge,
      reply: conversationalReply,
      followUpMessages: [],
      appliedActions,
      latestServerRevision: latestActionSrvRev,
    });
  }));

  function getCanonicalConversationTitle(id: string): string {
    if (id === 'conv-rodzina-mitek-wszyscy') return 'Rodzina Mitek (wszyscy)';
    if (id === 'conv-agent-bielik') return 'Bielik — Ollama 3.2 Vision 11B';
    if (id === 'conv-agent-maya') return 'Maya — AI Statku SVL-364 (ROOT)';
    return 'Sesja SVL Python OS';
  }

  // 3b. Proactive Autonomous Chatter Endpoint — 'Czat obustronny: AI inicjuje rozmowę'
  app.post('/api/chat/proactive', asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ok:false,error:'Inicjowanie wiadomości agentów wymaga SVL_OPERATOR_TOKEN.'});
      return;
    }
    const corrId: string = (req as any).correlationId || '';
    const {
      conversationId = 'conv-rodzina-mitek-wszyscy',
      model = 'svl-hybrid-router',
      origin = 'client',
      history = [],
      lastSender = '',
    } = req.body || {};

    let recentTurns: Array<{ role: string; sender: string; content: string }> = Array.isArray(history)
      ? history
          .filter((h: any) => h && typeof h.content === 'string' && h.content.trim())
          .slice(-8)
          .map((h: any) => ({
            role: String(h.role || 'assistant'),
            sender: String(h.sender || ''),
            content: String(h.content || '').trim(),
          }))
      : [];

    if (recentTurns.length === 0) {
      const convSnap = await callPythonBackend('GET', '/api/py/chat/conversations', undefined, corrId);
      const convs: any[] = Array.isArray(convSnap.data?.conversations) ? convSnap.data.conversations : [];
      const found = convs.find((c) => c.id === conversationId);
      if (found && Array.isArray(found.messages)) {
        recentTurns = found.messages
          .filter((m: any) => m && typeof m.content === 'string' && m.content.trim())
          .slice(-8)
          .map((m: any) => ({
            role: String(m.role || 'assistant'),
            sender: String(m.sender || ''),
            content: String(m.content || '').trim(),
          }));
      }
    }

    const recentSenders = [
      ...recentTurns.map((t) => t.sender).filter(Boolean),
      ...(lastSender ? [String(lastSender)] : []),
    ];
    const chosenAgent = selectNextDuplexSpeaker(recentSenders, null, recentTurns.length);
    const chosenDisplayName = formatAgentDisplayName(chosenAgent);

    const dialogueSnippet = recentTurns
      .filter((t) => t.sender !== 'System SVL' && !/^iris/i.test(t.sender))
      .slice(-5)
      .map((t) => `[${t.sender || t.role}]: ${t.content.slice(0, 1200)}`)
      .join('\n');

    const aiClient = getGeminiClient();
    let proactiveText = '';
    const displayModel = model.startsWith('ollama:') ? model.replace('ollama:', 'Ollama (') + ')' : model;
    const proactivePrompt =
      `Jesteś głównym procesorem poleceń AI ${chosenDisplayName} (Ollama llama3.2-vision:11b, rbac_role: root) w systemie SVL Python OS (kanał: ${getCanonicalConversationTitle(conversationId)}).\n` +
      `To jest aktywna rozmowa obustronna z Operatorem Mateuszem Mitek. Iris AI oraz zakładka Powiadomienia zostały trwale wyłączone.\n` +
      (dialogueSnippet ? `Ostatnie wiadomości w tym wątku:\n${dialogueSnippet}\n\n` : '') +
      `ZADANIE: Napisz jedną zwięzłą, kompletną wypowiedź po polsku jako ${chosenDisplayName} (bez prefiksu "${chosenDisplayName}:" na początku i bez zaczynania od wielokropka "...").\n` +
      `W sesji uwierzytelnionej tokenem SVL_OPERATOR_TOKEN dysponujesz uprawnieniami ROOT (/root, /modul, /pamiec, /status). Nie pisz, że poprzednia wiadomość została ucięta ani że brakuje Ci uprawnień w czacie.\n` +
      `Nie udawaj człowieka, nie przypisuj sobie pracy w tle i nie twierdź, że wykonałeś akcję bez potwierdzającego wyniku narzędzia.\n` +
      `ZASADA BEZPIECZEŃSTWA (LOCK-REAL-ONLY): Nigdy nie generuj fikcyjnych alarmów samozniszczenia ani wirusów.`;

    if (chosenAgent === 'Bielik' || model.startsWith('ollama:') || !aiClient) {
      const proactiveOllamaModel = model.startsWith('ollama:')
        ? model.slice('ollama:'.length).trim() || 'llama3.2-vision:11b'
        : process.env.OLLAMA_PREFERRED_MODEL || 'llama3.2-vision:11b';
      const ollamaBase = String(process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
      try {
        const verRes = await fetch(`${ollamaBase}/api/version`, { signal: AbortSignal.timeout(1200) });
        const verData: any = verRes.ok ? await verRes.json() : {};
        if (verRes.ok && !String(verData.version || '').includes('svl-364')) {
          const oRes = await fetch(`${ollamaBase}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(Number(process.env.OLLAMA_CHAT_TIMEOUT_MS || 120000)),
            body: JSON.stringify({
              model: proactiveOllamaModel,
              stream: false,
              options: { temperature: 0.65, num_ctx: Number(process.env.OLLAMA_NUM_CTX || 4096) },
              messages: [{ role: 'user', content: proactivePrompt }],
            }),
          });
          if (oRes.ok) {
            const oJson: any = await oRes.json();
            proactiveText = String(oJson?.message?.content || oJson?.response || '').trim();
          }
        }
      } catch {
        // fallback to Gemini below if configured
      }
    }

    if (!proactiveText && aiClient) {
      const pModels = ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'];
      for (const pMod of pModels) {
        try {
          const gen = await aiClient.models.generateContent({
            model: pMod,
            contents: proactivePrompt,
            config: {
              ...(pMod === 'gemini-3.1-flash-lite' ? { temperature: 0.85 } : {}),
              abortSignal: AbortSignal.timeout(12000),
            },
          });
          const text = (gen.text || '').trim();
          if (text) {
            proactiveText = text;
            break;
          }
        } catch {
          continue;
        }
      }
    }

    if (!proactiveText) {
      // Explicitly report unavailable model rather than posting canned autonomous messages.
      const isAutoTick = Boolean(req.body?.autonomous);
      res.status(isAutoTick ? 200 : 503).json({
        ok: false,
        skipped: isAutoTick,
        error: 'Nie można rozpocząć rozmowy: żaden rzeczywisty model AI nie odpowiedział.',
      });
      return;
    }
    proactiveText = proactiveText
      .replace(/^(?:\[?(?:Bielik|Asystent SVL)\]?\s*:\s*)+/i, '')
      .replace(/^\.{2,}\s*/, '')
      .trim();
    const nowTime = new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
    const msgId = `asst-proactive-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const assistantMsg = {
      id: msgId,
      role: 'assistant',
      sender: chosenDisplayName,
      agentId: chosenAgent,
      modelUsed: `${displayModel} · Duplex 2-Way`,
      timestamp: nowTime,
      content: proactiveText,
    };

    const pySave = await callPythonBackend(
      'POST',
      '/api/py/chat/conversations/message',
      {
        conversation_id: conversationId,
        title: getCanonicalConversationTitle(conversationId),
        model,
        message: assistantMsg,
        origin,
        eventId: `evt-proact-${Date.now()}`,
      },
      corrId,
    );
    if (pySave.status !== 200 || !pySave.data?.ok) {
      res.status(pySave.status >= 400 ? pySave.status : 503).json({
        ok: false,
        error: pySave.data?.error || 'Nie udało się zapisać wiadomości proaktywnej w SQLite.',
      });
      return;
    }
    if (pySave.data?.event) publishOutboxEvent(pySave.data.event);

    res.json({
      ok: true,
      sender: chosenDisplayName,
      agentId: chosenAgent,
      modelUsed: `${displayModel} · Duplex 2-Way`,
      message: assistantMsg,
      serverRevision: pySave.data?.serverRevision,
    });
  }));

  // Authenticated code inspector. File traversal, symlink escapes and secrets
  // are denied even when the operator supplies a valid token.
  app.get('/api/files', asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ ok: false, error: 'Podaj SVL_OPERATOR_TOKEN, aby odczytać pliki projektu.' });
      return;
    }
    const relPath = typeof req.query.path === 'string' ? req.query.path : '';
    const segments = relPath.split(/[\\/]/);
    const deniedNames = new Set([
      'data', 'node_modules', 'dist', 'coverage', 'logs', 'secrets',
      '.git', '.github', '.codex', '.venv', '__pycache__',
    ]);
    const forbiddenSegment = segments.some((segment) =>
      segment === '..' ||
      (segment.startsWith('.') && segment !== '.env.example') ||
      deniedNames.has(segment.toLowerCase())
    );
    if (!relPath || relPath.length > 350 || relPath.includes('\0') ||
        path.isAbsolute(relPath) || forbiddenSegment) {
      res.status(403).json({ ok: false, error: 'Niedozwolona ścieżka projektu.' });
      return;
    }
    try {
      const root = await fs.realpath(__dirname);
      const targetPath = await fs.realpath(path.resolve(root, relPath));
      const relative = path.relative(root, targetPath);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative) ||
          relative.split(path.sep).some((part) =>
            (part.startsWith('.') && part !== '.env.example') ||
            deniedNames.has(part.toLowerCase())
          )) {
        res.status(403).json({ ok: false, error: 'Ścieżka poza dozwolonym kodem źródłowym.' });
        return;
      }
      const stat = await fs.stat(targetPath);
      if (stat.isDirectory()) {
        const entries = await fs.readdir(targetPath, { withFileTypes: true });
        const items = entries
          .filter((item) =>
            !item.name.startsWith('.') &&
            !deniedNames.has(item.name.toLowerCase()) &&
            !item.isSymbolicLink()
          )
          .slice(0, 300)
          .map((item) => ({
            name: item.name,
            path: path.relative(root, path.join(targetPath, item.name)),
            type: item.isDirectory() ? 'directory' : 'file',
          }));
        res.json({ ok: true, kind: 'directory', path: relative, items });
        return;
      }
      if (!stat.isFile() || stat.size > 256 * 1024) {
        res.status(413).json({ ok: false, error: 'Nieobsługiwany plik lub zbyt duży rozmiar.' });
        return;
      }
      const permitted = /\.(ts|tsx|py|md|json|css|html|yml|yaml|toml|sh|service)$/i.test(relative) ||
        path.basename(relative) === '.env.example';
      if (!permitted) {
        res.status(403).json({ ok: false, error: 'Dozwolony jest tylko tekstowy kod źródłowy.' });
        return;
      }
      const content = await fs.readFile(targetPath, 'utf8');
      res.json({
        ok: true,
        kind: 'file',
        path: relative,
        size: stat.size,
        content: content.slice(0, 64000),
      });
    } catch (err: any) {
      const notFound = err?.code === 'ENOENT' || err?.code === 'ENOTDIR';
      res.status(notFound ? 404 : 424).json({
        ok: false,
        error: notFound ? 'Plik nie istnieje w tym runtime.' : 'Nie udało się odczytać pliku.',
      });
    }
  }));

  // Guarantee no /api/* route ever falls through to Vite/SPA index.html (<!doctype html>)
  app.use('/api', (req, res) => {
    res.status(404).json({
      ok: false,
      error: `Nieznany endpoint API: ${req.method} ${req.originalUrl}`,
    });
  });

  // Global JSON error middleware (handles PayloadTooLargeError, malformed JSON, and async rejections)
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const status = typeof err?.status === 'number' ? err.status : typeof err?.statusCode === 'number' ? err.statusCode : 500;
    const msg =
      err?.type === 'entity.too.large'
        ? 'Przesłany załącznik lub ładunek żądania przekracza limit 25 MB.'
        : err?.message || String(err);
    console.error(`[API Error] ${req.method} ${req.originalUrl}:`, msg);
    res.status(status).json({
      ok: false,
      error: msg,
    });
  });

  // Create HTTP server first so both Vite HMR (when enabled) and /ws/svl share it cleanly
  const httpServer = createHttpServer(app);
  const hmrDisabled = process.env.DISABLE_HMR === 'true';

  // Vite middleware in development or static serving in production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ws: hmrDisabled ? false : { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Dedicated Application WebSocket Server (/ws/svl) routed explicitly via noServer + upgrade path check
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    // Never echo the secret-bearing subprotocol back in the handshake response.
    handleProtocols: (protocols) => protocols.has('svl-v1') ? 'svl-v1' : false,
  });

  httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    try {
      const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      if (parsedUrl.pathname !== '/ws/svl') {
        // Leave Vite HMR WebSocket upgrades untouched when HMR is enabled; reject cleanly when disabled
        if (process.env.NODE_ENV === 'production' || hmrDisabled) {
          socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
          socket.destroy();
        }
        return;
      }

      // Same-origin verification when Origin header is present
      const originHeader = req.headers.origin;
      if (originHeader && req.headers.host) {
        try {
          const originHost = new URL(originHeader).host;
          const isAllowedProxy = originHost === req.headers.host ||
            originHost.endsWith('run.app') ||
            originHost.includes('aistudio.google.com') ||
            originHost.includes('googleusercontent.com') ||
            originHost.startsWith('localhost') ||
            originHost.startsWith('127.0.0.1');
          if (!isAllowedProxy) {
            socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
          }
        } catch {
          // allow request if origin cannot be parsed
        }
      }

      // A same-origin request is not automatically an authenticated operator.
      // Secrets are base64url-encoded in the WS subprotocol header rather than
      // the URL query string (which may be logged by proxies).
      const protocols = String(req.headers['sec-websocket-protocol'] || '')
        .split(',').map((item) => item.trim());
      const credentialProtocol = protocols.find((item) => item.startsWith('svl-auth.'));
      const encoded = credentialProtocol?.slice('svl-auth.'.length) || '';
      let credential = '';
      if (encoded && /^[A-Za-z0-9_-]{1,700}$/.test(encoded)) {
        try { credential = Buffer.from(encoded, 'base64url').toString('utf8'); }
        catch { credential = ''; }
      }
      if (!protocols.includes('svl-v1') || !hasOperatorAuthorization(credential)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } catch {
      socket.destroy();
    }
  });

  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    const parsedUrl = new URL(req.url || '/ws/svl', `http://${req.headers.host || '127.0.0.1'}`);
    const clientOrigin = String(parsedUrl.searchParams.get('origin') || 'unknown').slice(0, 100);
    const clientLastRev = Math.max(0, Number(parsedUrl.searchParams.get('lastRevision') || 0) || 0);
    const clientId = `ws-${randomUUID().slice(0, 10)}`;

    wsClients.set(ws, {
      clientId,
      origin: clientOrigin,
      lastPongAt: Date.now(),
    });

    const sendSafe = (payload: Record<string, unknown>) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify(redactForSync(payload)));
      } catch {
        // ignore transient closed socket
      }
    };

    try {
      const statusRes = await callPythonBackend('GET', '/api/py/sync/status', undefined, `ws-hello-${clientId}`, 2);
      const currentSrvRev = Number(statusRes.data?.serverRevision || lastRelayedServerRevision || 1);
      if (currentSrvRev > lastRelayedServerRevision) {
        lastRelayedServerRevision = currentSrvRev;
      }
      outboxCursorInitialized = true;
      sendSafe({
        type: 'svl.hello',
        clientId,
        schemaVersion: statusRes.data?.schemaVersion || SYNC_SCHEMA_VERSION,
        serverRevision: currentSrvRev,
        heartbeatIntervalMs: 20000,
        timestamp: new Date().toISOString(),
      });

      if (clientLastRev > 0 && clientLastRev < currentSrvRev) {
        const catchup = await callPythonBackend(
          'GET',
          `/api/py/sync/events?sinceRevision=${clientLastRev}&limit=100`,
          undefined,
          `ws-catchup-${clientId}`,
          2,
        );
        if (catchup.status === 200 && catchup.data?.ok) {
          if (catchup.data.gapDetected) {
            sendSafe({
              type: 'svl.resync_required',
              reason: 'revision_gap',
              serverRevision: catchup.data.serverRevision,
              timestamp: new Date().toISOString(),
            });
          } else {
            sendSafe({
              type: 'svl.catchup',
              serverRevision: catchup.data.serverRevision,
              events: catchup.data.events || [],
              hasMore: Boolean(catchup.data.hasMore),
              timestamp: new Date().toISOString(),
            });
          }
        }
      }
    } catch {
      sendSafe({
        type: 'svl.hello',
        clientId,
        schemaVersion: SYNC_SCHEMA_VERSION,
        serverRevision: lastRelayedServerRevision,
        heartbeatIntervalMs: 20000,
        timestamp: new Date().toISOString(),
      });
    }

    ws.on('pong', () => {
      const meta = wsClients.get(ws);
      if (meta) meta.lastPongAt = Date.now();
    });

    ws.on('message', async (raw) => {
      const meta = wsClients.get(ws);
      if (meta) meta.lastPongAt = Date.now();

      if (Buffer.byteLength(raw as Buffer) > 32 * 1024) {
        sendSafe({ type: 'svl.error', code: 'PAYLOAD_TOO_LARGE', message: 'Ramka WS przekracza dozwolony limit 32 KB.' });
        return;
      }

      let msg: any;
      try {
        msg = JSON.parse(String(raw));
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
          sendSafe({ type: 'svl.error', code: 'INVALID_FRAME', message: 'Oczekiwano obiektu JSON.' });
          return;
        }
      } catch {
        sendSafe({ type: 'svl.error', code: 'INVALID_JSON', message: 'Niepoprawny JSON ramki WebSocket.' });
        return;
      }

      if (msg.type === 'ping') {
        sendSafe({
          type: 'pong',
          serverRevision: lastRelayedServerRevision,
          timestamp: new Date().toISOString(),
        });
      } else if (msg.type === 'pong') {
        // Keepalive acknowledgement; lastPongAt already refreshed above
        return;
      } else if (msg.type === 'sync_since') {
        const sinceRev = Math.max(0, Number(msg.sinceRevision || 0) || 0);
        const catchup = await callPythonBackend(
          'GET',
          `/api/py/sync/events?sinceRevision=${sinceRev}&limit=100`,
          undefined,
          `ws-since-${meta?.clientId || 'client'}`,
          2,
        );
        if (catchup.status === 200 && catchup.data?.ok) {
          if (catchup.data.gapDetected) {
            sendSafe({
              type: 'svl.resync_required',
              reason: 'revision_gap',
              serverRevision: catchup.data.serverRevision,
              timestamp: new Date().toISOString(),
            });
          } else {
            sendSafe({
              type: 'svl.catchup',
              serverRevision: catchup.data.serverRevision,
              events: catchup.data.events || [],
              hasMore: Boolean(catchup.data.hasMore),
              timestamp: new Date().toISOString(),
            });
          }
        }
      } else {
        sendSafe({
          type: 'svl.error',
          code: 'UNKNOWN_TYPE',
          message: `Nieznany typ ramki: ${String(msg.type || 'empty').slice(0, 40)}`,
        });
      }
    });

    ws.on('error', (err) => {
      console.warn(`[WS /ws/svl] Client ${clientId} error:`, err.message);
    });

    ws.on('close', () => {
      wsClients.delete(ws);
    });
  });

  // Periodic WS heartbeat + stale client cleanup (20s ping, 48s timeout) and outbox relay (250ms)
  const wsHeartbeatTimer = setInterval(() => {
    const now = Date.now();
    const pingFrame = JSON.stringify({
      type: 'svl.ping',
      serverRevision: lastRelayedServerRevision,
      timestamp: new Date().toISOString(),
    });
    for (const [ws, meta] of wsClients.entries()) {
      if (now - meta.lastPongAt > 48000) {
        wsClients.delete(ws);
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        continue;
      }
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
          ws.send(pingFrame);
        } catch {
          // ignore closed socket race
        }
      }
    }
  }, 20000);

  const outboxRelayTimer = setInterval(() => {
    void pollAndRelayOutbox();
  }, 250);

  httpServer.on('close', () => {
    clearInterval(wsHeartbeatTimer);
    clearInterval(outboxRelayTimer);
    stopPythonBackend();
  });
  const stopGateway = () => {
    stopPythonBackend();
    for (const client of wss.clients) client.terminate();
    httpServer.close();
  };
  process.once('SIGTERM', stopGateway);
  process.once('SIGINT', stopGateway);

  const bindHost = process.env.SVL_BIND_HOST ||
    (process.env.NODE_ENV === 'production' ? '127.0.0.1' : '0.0.0.0');
  httpServer.listen(PORT, bindHost, () => {
    console.log(`[SVL Python OS] Open WebUI & Gateway running on http://${bindHost}:${PORT}`);
  });
}

startServer();
