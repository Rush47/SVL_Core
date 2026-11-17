import express from 'express';
import { createServer as createHttpServer, IncomingMessage } from 'node:http';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
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
  formatAgentDisplayName,
  getGitHubAgentPermissions,
  guardUnverifiedMissionCompletion,
  normalizeAgentCanonicalName,
  normalizeAiInteractiveMarkup,
  parseBielikChatCommand,
  parseSshShipTerminalInput,
  resolveInstalledOllamaModel,
  selectOllamaModelName,
  type BielikSlashCommand,
  type ChatAppliedAction,
} from './src/utils/svlLogic.ts';
import { DEFAULT_GITHUB_FILE_BRANCH, GitHubFileService } from './src/utils/githubFiles.ts';
import { commandKey, isMutatingCommand, parseChatDirectives } from './src/server/chatDirectives.ts';
import { buildAgentSystemContext } from './src/server/interactiveElements.ts';
import {
  describeGeminiError,
  geminiCandidatesFor,
  isGeminiModelGoneError,
  markGeminiModelGone,
} from './src/server/geminiModels.ts';
import { appendWebSources, collectWebSources, isWebSearchRequest } from './src/server/webSearch.ts';
import {
  CONVERSATION_AGENTS,
  OPERATOR_LABEL,
  agentOf,
  buildTranscript,
  cleanAgentReply,
  consecutiveAiTurns,
  isRepetitive,
  parsePredictedSpeaker,
  toAgentPerspective,
  type ConversationAgent,
  type DialogueTurn,
} from './src/server/conversation.ts';
import {
  buildProactiveStarterPrompt,
  formatMemoryPromptContext,
  selectNextFreeSpeaker,
  type AgentMemoryRecord,
} from './src/server/memoryPrompt.ts';
import {
  SvlFileLogger,
  normalizeGuiLogBatch,
  scrubSensitiveText,
} from './src/server/fileLogger.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OPERATOR_TOKEN_SECRET_FILE = path.join(__dirname, 'data', 'svl_operator_token.secret');

function deriveStableWorkspaceOperatorToken(projectDir: string): string {
  let appIdentity = 'svl-python-os-workspace';
  try {
    const pkg = JSON.parse(fsSync.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
    if (pkg?.name) appIdentity = String(pkg.name);
  } catch {
    // fallback identity
  }
  return createHmac('sha512', 'svl-364-stable-operator-key-v1')
    .update(appIdentity)
    .digest('base64url')
    .slice(0, 64);
}

// Never use a weak development credential like '364_OMNIKLUCZ_ROOT'.
// Load explicit SVL_OPERATOR_TOKEN from env/.env, else persisted data/svl_operator_token.secret,
// else derive one stable 64-char cryptographic token for this workspace so it never changes across resets.
const explicitEnvToken = (process.env.SVL_OPERATOR_TOKEN || '').trim();
if (explicitEnvToken && explicitEnvToken.length < 32) {
  throw new Error('SVL_OPERATOR_TOKEN must be at least 32 characters long.');
}
process.env.SVL_OPERATOR_TOKEN = explicitEnvToken;
if (!process.env.SVL_OPERATOR_TOKEN) {
  try {
    const saved = fsSync.readFileSync(OPERATOR_TOKEN_SECRET_FILE, 'utf8').trim();
    if (saved.length >= 32) {
      process.env.SVL_OPERATOR_TOKEN = saved;
    }
  } catch {
    // derive stable token below
  }
}
if (!process.env.SVL_OPERATOR_TOKEN) {
  process.env.SVL_OPERATOR_TOKEN = deriveStableWorkspaceOperatorToken(__dirname);
  console.info('[SVL auth] Initialized single stable SVL_OPERATOR_TOKEN.');
}
process.env.SVL_OPERATOR_TOKEN = process.env.SVL_OPERATOR_TOKEN.trim();
try {
  fsSync.mkdirSync(path.dirname(OPERATOR_TOKEN_SECRET_FILE), { recursive: true });
  fsSync.writeFileSync(OPERATOR_TOKEN_SECRET_FILE, process.env.SVL_OPERATOR_TOKEN, { mode: 0o600 });
} catch {
  // ignore read-only fs
}

const svlFileLogger = new SvlFileLogger();
svlFileLogger.logSync({
  layer: 'SYSTEM',
  level: 'INFO',
  category: 'gateway_init',
  message: 'Zainicjalizowano SvlFileLogger (katalog logi/*.txt aktywny)',
  details: { logDir: svlFileLogger.logDir },
});

process.on('uncaughtException', (err) => {
  svlFileLogger.logSync({
    layer: 'GATEWAY',
    level: 'ERROR',
    category: 'uncaught_exception',
    message: `Nieobsłużony wyjątek Node Gateway: ${err?.message || String(err)}`,
    details: { stack: String(err?.stack || '').slice(0, 800) },
  });
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  svlFileLogger.logSync({
    layer: 'GATEWAY',
    level: 'ERROR',
    category: 'unhandled_rejection',
    message: `Nieobsłużona obietnica Node Gateway: ${msg}`,
    details: reason instanceof Error ? { stack: String(reason.stack || '').slice(0, 800) } : undefined,
  });
});

// Earlier versions wrote fake `sudo`, `ufw` and `ssh` scripts into /usr/local/bin here
// (ssh ran commands locally, ufw always reported an active firewall). They are no longer
// installed; the Python backend removes the old copies (backend/real_telemetry.py).

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

type OllamaChatResult = { ok: true; text: string; model: string } | { ok: false; reason: string };

/** Czy pod `base` działa prawdziwa Ollama; zwraca model faktycznie zainstalowany dla `model`. */
async function ollamaReadyModel(
  base: string,
  model: string,
): Promise<{ ok: true; model: string } | { ok: false; reason: string }> {
  try {
    // Zajęta Ollama (generowanie, ładowanie modelu) odpowiada wolniej — krótkie limity dawały fałszywe „niedostępna”.
    const [versionRes, tagsRes] = await Promise.all([
      fetch(`${base}/api/version`, { signal: AbortSignal.timeout(8000) }),
      fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(8000) }),
    ]);
    if (!versionRes.ok) return { ok: false, reason: `Ollama (${base}) odpowiada kodem ${versionRes.status}` };
    const version: any = await versionRes.json();
    if (String(version.version || '').includes('svl-364')) {
      return { ok: false, reason: `pod ${base} działa wbudowany zastępnik Ollamy, który nie uruchamia modeli` };
    }
    if (!tagsRes.ok) return { ok: false, reason: `Ollama (${base}) nie zwróciła listy modeli (kod ${tagsRes.status})` };
    const tags: any = await tagsRes.json();
    const resolved = resolveInstalledOllamaModel(model, Array.isArray(tags.models) ? tags.models : []);
    if (resolved.installedCount === 0) {
      return { ok: false, reason: `w Ollamie (${base}) nie ma żadnego pobranego modelu` };
    }
    return { ok: true, model: resolved.name };
  } catch (error) {
    return { ok: false, reason: `Ollama (${base}) niedostępna: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Surowe dopisanie tekstu przez Ollamę (`raw: true` — bez szablonu czatu i bez żadnych instrukcji).
 * Model po prostu kontynuuje podany zapis rozmowy.
 */
async function ollamaContinueRaw(
  host: string,
  model: string,
  text: string,
  options: { temperature: number; numPredict: number; stop: string[]; timeoutMs: number },
): Promise<OllamaChatResult> {
  const base = host.replace(/\/$/, '');
  const ready = await ollamaReadyModel(base, model);
  if (!ready.ok) return { ok: false, reason: ready.reason };
  const installedModel = ready.model;
  try {
    const res = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs),
      body: JSON.stringify({
        model: installedModel,
        prompt: text,
        raw: true,
        stream: false,
        keep_alive: '15m',
        options: {
          temperature: options.temperature,
          num_predict: options.numPredict,
          stop: options.stop,
          num_ctx: Number(process.env.OLLAMA_NUM_CTX || 4096),
        },
      }),
    });
    if (!res.ok) return { ok: false, reason: `Ollama /api/generate zwróciła kod ${res.status}` };
    const data: any = await res.json();
    return { ok: true, text: String(data?.response || ''), model: installedModel };
  } catch (error) {
    return { ok: false, reason: `Ollama (${base}) niedostępna: ${error instanceof Error ? error.message : String(error)}` };
  }
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
    const ts = new Date().toISOString();
    runtimeLogLines.push({ timestamp: ts, service, level, message });
    svlFileLogger.log({
      timestamp: ts,
      layer: service === 'python' ? 'PYTHON' : 'GATEWAY',
      level: level === 'error' ? 'ERROR' : 'INFO',
      category: service === 'python' ? 'python_stdio' : 'gateway_runtime',
      message,
    });
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

    let capturedErrorMsg = '';
    const startedAtMs = Date.now();

    res.status = ((code: number) => {
      intendedStatus = code;
      if (code === 403) return origStatus(401);
      if (code === 502 || code === 503 || code === 504) return origStatus(424);
      return origStatus(code);
    }) as typeof res.status;

    res.json = ((body: any) => {
      if (body && typeof body === 'object' && !Array.isArray(body) && typeof body.error === 'string') {
        capturedErrorMsg = body.error;
      }
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

    res.on('finish', () => {
      const cleanPath = req.originalUrl.split('?')[0];
      if (cleanPath === '/api/logs/gui' && res.statusCode < 400) {
        return;
      }
      const durationMs = Date.now() - startedAtMs;
      svlFileLogger.log({
        layer: 'GATEWAY',
        level: res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'WARN' : 'INFO',
        category: 'http_api',
        correlationId: corrId,
        origin: String(req.headers['x-svl-origin'] || req.ip || 'client'),
        message: `${req.method} ${cleanPath} -> HTTP ${res.statusCode} (${durationMs} ms)`,
        details: capturedErrorMsg ? { error: capturedErrorMsg, intendedStatus } : undefined,
      });
    });

    next();
  });

  // Odbiera strumień zdarzeń GUI (kliknięcia, nawigacja, formularze, konsola, błędy JS/React, żądania) do logi/*.txt
  app.post('/api/logs/gui', express.json({ limit: '64kb' }), (req, res) => {
    const entries = normalizeGuiLogBatch(req.body);
    if (entries.length === 0) {
      res.status(400).json({ ok: false, error: 'Brak poprawnych zdarzeń GUI do zapisania.' });
      return;
    }
    const accepted = svlFileLogger.logBatch(entries);
    res.json({ ok: true, accepted });
  });

  app.get('/api/logs/files', asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ ok: false, error: 'Lista plików logi/*.txt wymaga SVL_OPERATOR_TOKEN.' });
      return;
    }
    const summary = await svlFileLogger.getSummary();
    res.json({ ok: true, ...summary });
  }));

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
    });
  });

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

  // Zdarzenia trafiają do klientów WYŁĄCZNIE w kolejności rewizji, przez pollAndRelayOutbox().
  // Wcześniej bezpośrednia publikacja przesuwała kursor relaya poza zdarzenia jeszcze
  // niewysłane (np. zapis pamięci agenta tuż przed wiadomością czatu) — inni klienci
  // nigdy ich nie dostawali, a zmiany z czatu pojawiały się dopiero po ręcznym odświeżeniu.
  const sendOutboxEventToClients = (evt: any) => {
    if (!evt || typeof evt !== 'object' || !evt.eventId) return;
    if (relayedEventIdsSet.has(evt.eventId)) return;

    relayedEventIdsSet.add(evt.eventId);
    relayedEventIdsQueue.push(evt.eventId);
    if (relayedEventIdsQueue.length > 1500) {
      const oldest = relayedEventIdsQueue.shift();
      if (oldest) relayedEventIdsSet.delete(oldest);
    }

    const sanitized = redactForSync(evt);
    const frame = JSON.stringify({
      ...sanitized,
      type: sanitized.type || 'svl.event',
    });

    let delivered = 0;
    for (const [client] of wsClients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(frame);
          delivered += 1;
        } catch {
          // ignore closed socket race
        }
      }
    }
    svlFileLogger.log({
      layer: 'WS',
      level: 'INFO',
      category: 'ws_broadcast',
      correlationId: String(sanitized.correlationId || ''),
      origin: String(sanitized.origin || 'outbox'),
      message: `Broadcast ${String(sanitized.type || 'svl.event')} (${String(sanitized.entity || '')}/${String(sanitized.entityId || '')} srvRev=${String(sanitized.serverRevision ?? '')}) -> ${delivered} klient(ów)`,
    });
  };
  /** Zgłasza nowe zdarzenie z outboxa: natychmiastowy relay w kolejności rewizji. */
  const publishOutboxEvent = (evt: any) => {
    if (!evt || typeof evt !== 'object' || !evt.eventId) return;
    void pollAndRelayOutbox();
  };
  const broadcastResyncRequired = (reason = 'global_sync', srvRev?: number) => {
    const rev = Math.max(Number(srvRev || 0), lastRelayedServerRevision);
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
  // Żądanie relaya w trakcie trwającego odpytania nie może przepaść — wykonujemy jeszcze jedno.
  let outboxPollRequested = false;
  const pollAndRelayOutbox = async (): Promise<void> => {
    if (outboxPollInFlight) {
      outboxPollRequested = true;
      return;
    }
    if (wsClients.size === 0) return;
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
      for (let page = 0; page < 10; page += 1) {
        outboxPollRequested = false;
        const res = await callPythonBackend(
          'GET',
          `/api/py/sync/events?sinceRevision=${lastRelayedServerRevision}&limit=80`,
          undefined,
          'ws-outbox-poll',
          2,
        );
        if (res.status !== 200 || !res.data?.ok) return;
        const srv = Number(res.data.serverRevision || 0);
        if (res.data.gapDetected) {
          lastRelayedServerRevision = Math.max(lastRelayedServerRevision, srv);
          broadcastResyncRequired('outbox_gap', srv);
          return;
        }

        const events: any[] = Array.isArray(res.data.events) ? res.data.events : [];
        for (const evt of events) {
          sendOutboxEventToClients(evt);
          lastRelayedServerRevision = Math.max(lastRelayedServerRevision, Number(evt?.serverRevision || 0));
        }
        if (!res.data.hasMore) {
          // Rewizja bez zdarzenia w outboxie (np. usunięte wpisy) nie blokuje kursora;
          // `serverRevision` jest czytane przed zdarzeniami, więc wszystko ≤ srv już wysłano.
          lastRelayedServerRevision = Math.max(lastRelayedServerRevision, srv);
          if (!outboxPollRequested) return;
        }
      }
    } catch {
      // retry on next interval
    } finally {
      outboxPollInFlight = false;
      if (outboxPollRequested) {
        outboxPollRequested = false;
        setTimeout(() => void pollAndRelayOutbox(), 0);
      }
    }
  };

  const FAMILY_CHANNEL_ID = 'conv-rodzina-mitek-wszyscy';
  /** Powiadomienie systemowe na kanale „wszyscy” (zapis w SQLite + natychmiastowy relay). */
  const emitFamilyNotification = async (
    notification: {
      severity?: 'INFO' | 'WARN' | 'ALERT';
      category: string;
      title: string;
      message?: string;
      sourceEventId?: string;
      origin?: string;
    },
    correlationId = '',
  ): Promise<void> => {
    try {
      const result = await callPythonBackend('POST', '/api/py/notifications/emit', notification, correlationId, 2);
      if (result.status === 200 && result.data?.ok) {
        publishOutboxEvent(result.data.event || { eventId: `notif-${Date.now()}` });
      } else {
        recordRuntimeLog('gateway', 'error', `[powiadomienia] ${result.data?.error || `HTTP ${result.status}`}`);
      }
    } catch (error) {
      recordRuntimeLog('gateway', 'error', `[powiadomienia] ${error instanceof Error ? error.message : String(error)}`);
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
    if (!isOperator) {
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
      const normalizedPayload =
        payload.ok === false && !payload.error
          ? { ...payload, error: String(payload.stderr || 'Błąd wykonania polecenia.') }
          : payload;
      res.json(normalizedPayload);
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
      const errText = sshResult.ok
        ? ''
        : String(sshResult.stderr || sshResult.output || sshResult.rawOutput || sshResult.error || `Błąd SSH (HTTP ${sshRes.status}).`);
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
        stderr: errText,
        ...(sshResult.ok ? {} : { error: String(sshResult.error || errText) }),
        sshStatus: sshResult.ssh_status,
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
        {
          command: sshSubCmd,
          confirmed: true,
          target_subsystem: 'bridge',
          origin: `terminal:${terminalType}`,
          correlationId: corrId,
        },
        corrId,
      );
      void pollAndRelayOutbox();
      const ok = Boolean(sshRes.data?.ok);
      const errText = ok ? '' : String(sshRes.data?.stderr || sshRes.data?.error || sshRes.data?.output || 'Błąd wykonania SSH.');
      await respondAndPersist({
        ok,
        terminalType,
        command: trimmed,
        specialCommand: 'svl364-ssh',
        stdout: ok ? (sshRes.data?.stdout || sshRes.data?.output || JSON.stringify(sshRes.data, null, 2)) : '',
        stderr: errText,
        ...(ok ? {} : { error: errText }),
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
      const mentionsRemoved = /\b(?:agata|iris|aria|alex|astyria|aurelius|si_1|codex)\b/i.test(effectiveCmd);
      if (mentionsRemoved) {
        await respondAndPersist({
          ok: false,
          terminalType,
          command: trimmed,
          stdout: '',
          stderr: 'W systemie działają wyłącznie Bielik i Maya.',
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
    // Przy emitToChat pełny raport skanu publikuje Maya; w przeciwnym razie krótkie powiadomienie Mayi.
    if (pyRes.status === 200 && pyRes.data?.ok && !req.body?.emitToChat) {
      const removed = Number(pyRes.data.threatsFoundAndPurged || 0);
      void emitFamilyNotification(
        {
          severity: removed > 0 ? 'WARN' : 'INFO',
          category: 'antivirus',
          title: removed > 0
            ? `Skan antywirusowy: usunięto zagrożenia (${removed})`
            : 'Skan antywirusowy: system czysty',
          message: `Przeskanowano plików: ${Number(pyRes.data.filesScanned || 0)}.`,
          sourceEventId: `av-${corrId || randomUUID()}`,
          origin: String(req.body?.origin || 'client'),
        },
        corrId,
      );
    }
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
    const [healthRes, agentsRes, modsRes, kernelRes] = await Promise.all([
      callPythonBackend('GET', '/api/py/health', undefined, corrId),
      callPythonBackend('GET', '/api/py/agents/status', undefined, corrId),
      callPythonBackend('GET', '/api/py/modules', undefined, corrId),
      callPythonBackend('GET', '/api/py/kernel/report', undefined, corrId),
    ]);
    await pollAndRelayOutbox();
    const srvRev = Math.max(
      Number(healthRes.data?.serverRevision || 0),
      Number(agentsRes.data?.serverRevision || 0),
      Number(modsRes.data?.serverRevision || 0),
      Number(kernelRes.data?.serverRevision || 0),
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
    if (!hasOperatorAuth) {
      res.status(401).json({ ok: false, error: 'Wymagana autoryzacja SVL_OPERATOR_TOKEN.' });
      return;
    }
    // Odpowiedź AI zapisuje serwer (SQLite + outbox), zanim odeśle ją klientowi. Dzięki temu
    // odpowiedź nie ginie, gdy karta się zamknie lub klient przekroczy czas oczekiwania,
    // a pozostali klienci widzą ją od razu przez /ws/svl.
    const replyConversationId = String(conversationId || '').trim().slice(0, 120);
    const replyConversationTitle = String(req.body?.conversationTitle || '').trim().slice(0, 200);
    const sendChatJson = res.json.bind(res);
    (res as any).json = (body: any) => {
      if (
        res.statusCode !== 200 ||
        !replyConversationId ||
        !body ||
        body.ok !== true ||
        typeof body.reply !== 'string' ||
        !body.reply.trim()
      ) {
        return sendChatJson(body);
      }
      // Przyciski zapisane przez model jako linki Markdown → składnia `[btn: …|…]`.
      body.reply = normalizeAiInteractiveMarkup(body.reply);
      const replyMessage = {
        id: `asst-${Date.now()}-${randomUUID().slice(0, 8)}`,
        role: 'assistant',
        sender: formatAgentDisplayName(String(body.sender || 'Bielik')),
        agentId: String(body.agentId || 'Bielik'),
        modelUsed: String(body.modelUsed || model || ''),
        timestamp: new Date().toISOString(),
        content: body.reply,
        ...(body.connectionReport ? { connectionReport: body.connectionReport } : {}),
        ...(Array.isArray(body.appliedActions) && body.appliedActions.length > 0
          ? { appliedActions: body.appliedActions }
          : {}),
        ...(body.provenance ? { provenance: body.provenance } : {}),
        ...(body.verificationNote ? { verificationNote: body.verificationNote } : {}),
      };
      void callPythonBackend(
        'POST',
        '/api/py/chat/conversations/message',
        {
          conversation_id: replyConversationId,
          title: replyConversationTitle,
          model,
          message: replyMessage,
          origin,
          eventId: `evt-reply-${replyMessage.id}`,
        },
        corrId,
        3,
      )
        .then((saved) => {
          const ok = saved.status === 200 && saved.data?.ok;
          if (ok) publishOutboxEvent(saved.data?.event || { eventId: `evt-reply-${replyMessage.id}` });
          else recordRuntimeLog('gateway', 'error', `[chat] Nie zapisano odpowiedzi AI w SQLite: ${saved.data?.error || saved.status}`);
          sendChatJson({
            ...body,
            message: replyMessage,
            persisted: Boolean(ok),
            ...(ok ? { serverRevision: saved.data?.serverRevision } : {}),
          });
        })
        .catch(() => sendChatJson({ ...body, message: replyMessage, persisted: false }));
      return res;
    };
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
        sender: 'Bielik',
        agentId: 'Bielik',
        modelUsed: 'SVL Safety Guard',
        reply: 'Nie uczestniczę w tworzeniu ani symulowaniu treści o charakterze seksualnym z udziałem osób małoletnich. Możemy skupić się na architekturze systemu, modelach AI lub innych tematach technicznych.',
        provenance: 'server_verified',
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
    // Bielik i Maya widzą rozmowę ze swojej perspektywy: cudze wypowiedzi jako „[Imię]: …”.
    const conversationAgent: ConversationAgent | null =
      selectedAgent === 'Bielik' || selectedAgent === 'Maya' ? selectedAgent : null;
    const historyTurns: DialogueTurn[] = conversationHistory.map((turn) => ({ ...turn }));
    const lastHistoryTurn = historyTurns[historyTurns.length - 1];
    if (lastHistoryTurn?.role === 'user' && lastHistoryTurn.content.trim() === cleanMsg) historyTurns.pop();
    const agentHistory = conversationAgent ? toAgentPerspective(historyTurns, conversationAgent, 48) : conversationHistory;
    const labelOperatorText = (text: string) => (conversationAgent ? `[${OPERATOR_LABEL}]: ${text}` : text);
    const cleanReplyFor = (text: string) => (conversationAgent ? cleanAgentReply(text, conversationAgent) : text);
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

    // Bez promptów: model dostaje wyłącznie rozmowę (historię i bieżącą wiadomość).

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

    const configuredOllamaModelName = isExplicitOllama
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
    // Skonfigurowana nazwa → model faktycznie zainstalowany (np. `:11b` vs `:latest`).
    let selectedOllamaModelName = availableModels.length > 0
      ? resolveInstalledOllamaModel(configuredOllamaModelName, availableModels, Boolean(imageBase64)).name
      : configuredOllamaModelName;

    const badgeForModel = (modelName: string) =>
      selectedAgent === 'Maya'
        ? `Maya · AI Statku SVL-364 (ROOT · ${modelName})`
        : isExplicitOllama || isBielikAgent
          ? `Bielik · Ollama (${modelName} · ROOT)`
          : model === 'svl-hybrid-router'
            ? `SVL-364 · Ollama (${modelName})`
            : effectiveModel;
    let displayModelBadge = badgeForModel(selectedOllamaModelName);

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
        const memAgent = selectedAgent === 'Maya' ? 'Maya' : 'Bielik';
        const memRes = await callPythonBackend('GET', '/api/py/agents/status', undefined, corrId);
        const mems: any[] = Array.isArray(memRes.data?.agent_memories?.[memAgent])
          ? memRes.data.agent_memories[memAgent]
          : [];
        latestActionSrvRev = Math.max(latestActionSrvRev, Number(memRes.data?.serverRevision || 0));
        appliedActions.push({
          tool: 'bielik_memory_list',
          entity: 'agent_memory',
          entityId: memAgent,
          serverRevision: latestActionSrvRev,
          summary: `Odczytano ${mems.length} wpisów pamięci ${memAgent}`,
          ok: true,
        });
        const lines = mems
          .slice(0, 20)
          .map((m: any) => {
            const scopeTag = m.scope === 'global' ? ' · global' : '';
            return `- **[${String(m.kind || 'fact').toUpperCase()}${scopeTag}]** ${m.content} *(${String(m.created_at || '').slice(0, 19).replace('T', ' ')})*`;
          })
          .join('\n');
        return {
          text: `### 🧠 Pamięć Długotrwała (${memAgent}: ${mems.length} wpisów)\n\n${lines || `Brak zapisanych wpisów pamięci dla agenta ${memAgent}.`}`,
        };
      }

      if (cmd.kind === 'memory_save') {
        const isGroupChannel = !isBielikChannel && !isMayaChannel && !mentionsBielik && !mentionsMaya &&
          (targetAgent === 'Rodzina Mitek' || targetAgent === 'Auto' || conversationId === 'conv-rodzina-mitek-wszyscy');
        const memAgent = selectedAgent === 'Maya' ? 'Maya' : 'Bielik';
        const memScope = isGroupChannel ? 'global' : `agent:${memAgent}`;
        const memRes = await callPythonBackend(
          'POST',
          '/api/py/agents/memory',
          {
            agent: memAgent,
            scope: memScope,
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
          entityId: memAgent,
          serverRevision: latestActionSrvRev,
          summary: !ok
            ? String(memRes.data?.error || 'Błąd zapisu')
            : duplicate
              ? `Wpis już istnieje w pamięci (${memScope}): "${cmd.content.slice(0, 60)}"`
              : `Zapisano w pamięci (${memScope}): "${cmd.content.slice(0, 60)}"`,
          ok,
        });
        const targetLabel = isGroupChannel ? 'wspólnej pamięci Rodziny Mitek (Bielik + Maya)' : `pamięci długotrwałej **${memAgent}**`;
        return {
          text: duplicate
            ? `ℹ️ Ten wpis jest już w ${targetLabel} — nie dodano duplikatu: „${cmd.content}”`
            : ok
            ? `✅ Zapisano wpis w ${targetLabel} (\`${memScope}\`, rev \`${latestActionSrvRev}\`): „${cmd.content}”`
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
    const directivesChangedState = pendingMutations;
    flushChatSync('chat_directive_applied');
    // Zmiany stanu wydane z innego kanału ogłaszamy wszystkim na kanale „Rodzina Mitek (wszyscy)”.
    if (directivesChangedState && directiveReceipts.length > 0 && replyConversationId !== FAMILY_CHANNEL_ID) {
      void emitFamilyNotification(
        {
          severity: 'INFO',
          category: 'chat_command',
          title: `Zmiana z czatu: ${replyConversationTitle || getCanonicalConversationTitle(replyConversationId)}`,
          message: directiveReceipts.join('\n\n').slice(0, 3000),
          sourceEventId: `chatcmd-${corrId || randomUUID()}`,
          origin,
        },
        corrId,
      );
    }
    // Wyniki poleceń z wiadomości Operatora (wykonanych przez serwer) dopisujemy po tekście modelu.
    const withDirectiveReceipts = (reply: string) => [reply, ...directiveReceipts].filter(Boolean).join('\n\n');

    if (parsedSlashCmd && hasOperatorAuth) {
      res.json({
        ok: true,
        sender: selectedDisplayName,
        agentId: selectedAgent.toLowerCase(),
        modelUsed: `${selectedDisplayName} · Ollama (${selectedOllamaModelName}) · Procesor Poleceń ROOT`,
        reply: directiveReceipts.join('\n\n') || 'Polecenie przetworzone.',
        provenance: 'server_verified',
        followUpMessages: [],
        appliedActions,
        latestServerRevision: latestActionSrvRev,
      });
      return;
    }
    // Recalled persistent SQLite memory for the active agent (shared 'global' + agent-scoped)
    const memoryAgentName = selectedAgent === 'Maya' ? 'Maya' : 'Bielik';
    let recalledMemories: AgentMemoryRecord[] = [];
    if (hasOperatorAuth) {
      const memSearch = await callPythonBackend(
        'POST',
        '/api/py/agents/memory/search',
        { agent: memoryAgentName, query: cleanMsg, limit: 16 },
        corrId,
      );
      if (memSearch.status === 200 && Array.isArray(memSearch.data?.memories)) {
        recalledMemories = memSearch.data.memories;
      } else if (Array.isArray(agentsRes.data?.agent_memories?.[memoryAgentName])) {
        recalledMemories = agentsRes.data.agent_memories[memoryAgentName];
      }
    }
    // Kontekst systemowy: opis przycisków czatu + pamięć długotrwała agenta.
    const agentMemoryContext = buildAgentSystemContext(formatMemoryPromptContext(recalledMemories, selectedDisplayName, 14));

    // Antivirus Scan & Chat Synchronization priority handler
    const hasAntivirusKeyword =
      /\b(?:wirus\w*|antywirus\w*|usuń\s+wirus\w*|usun\s+wirus\w*|malware|kwarantann\w*)\b/i.test(cleanMsg) ||
      /^\/antivirus\b/i.test(cleanMsg);
    const hasExplicitFileScan =
      /\bprzeskanuj\b/i.test(cleanMsg) &&
      /\b(?:plik|pliki|kod|system|baz[ęe]|baze|katalog|komputer)\b/i.test(cleanMsg);
    const hasSpaceTacticalContext =
      /\b(?:placówk|placowk|statek|sygnał|sygnal|jednostk|ukryci|ukrycia|sond|flot|planet|sektor|anomali|radar)\b/i.test(
        cleanMsg,
      );
    const wantsAntivirusScan = (hasAntivirusKeyword || hasExplicitFileScan) && !hasSpaceTacticalContext;
    if (wantsAntivirusScan) {
      const avRes = await callPythonBackend(
        'POST',
        '/api/py/security/antivirus/scan',
        {
          emitToChat: false,
          origin,
          correlationId: corrId,
        },
        corrId,
      );
      if (avRes.status === 200 && avRes.data?.ok && avRes.data?.reportMarkdown) {
        const avReply = String(avRes.data.reportMarkdown);
        const avBadge = 'Maya · skaner sygnatur SVL-365 (wynik serwera)';
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
          sender: 'Maya',
          agentId: 'Maya',
          modelUsed: avBadge,
          reply: withDirectiveReceipts(avReply),
          provenance: 'server_verified',
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
          prompt: cleanMsg,
          source: imageBase64 ? 'Załącznik czatu Operatora' : 'Portret Operatora (plik z zasobów)',
          presetId: imageBase64 ? '' : 'operator_vault_portrait',
          model: 'llama3.2-vision:11b',
          emitToChat: false,
          origin,
          correlationId: corrId,
        },
        corrId,
      );
      if (rvRes.status === 200 && rvRes.data?.ok && rvRes.data?.record?.reportMarkdown) {
        const rvReply = String(rvRes.data.record.reportMarkdown);
        const rvBadge = `Real Vision · Ollama (${rvRes.data.record.model || 'llama3.2-vision:11b'})`;
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
          provenance: 'model_unverified',
          followUpMessages: [],
          appliedActions,
          latestServerRevision: Math.max(latestActionSrvRev, Number(rvRes.data.serverRevision || 0)),
        });
        return;
      }
    }


    // Try explicit Ollama model (or try Ollama with fast timeout when Gemini fallback is available)
    const ai = getGeminiClient();
    // Pytania o aktualne informacje / źródła idą do Gemini z wyszukiwaniem Google (odpowiedź ze źródłami).
    const wantsWebSources = isWebSearchRequest(cleanMsg) && !wantsGitHubTools;
    const webSearchUnavailableNote =
      'Pytanie dotyczy aktualnych informacji, ale wyszukiwanie w internecie jest niedostępne (brak GEMINI_API_KEY). ' +
      'Odpowiedź pochodzi wyłącznie z wiedzy modelu i może być nieaktualna lub błędna.';
    const shouldTryOllama =
      !wantsGitHubTools && !(wantsWebSources && ai) &&
      (isBielikAgent || isExplicitOllama || (!ai && model === 'svl-hybrid-router'));
    let ollamaFailure = shouldTryOllama ? '' : 'nie użyto dla tego zapytania';
    let geminiFailure = ai ? '' : 'brak klucza GEMINI_API_KEY';
    const ollamaChatTimeoutMs = Number(process.env.OLLAMA_CHAT_TIMEOUT_MS || 75000);
    let ollamaGenerationStarted = false;
    let ollamaTimedOut = false;
    if (shouldTryOllama) {
      try {
        const [versionResponse, tagResponse] = await Promise.all([
          // Zajęta Ollama (generowanie, ładowanie modelu) odpowiada wolniej — krótkie limity
          // dawały fałszywe „niedostępna”.
          fetch(`${ollamaHost}/api/version`, {
            signal: AbortSignal.timeout(8000),
          }),
          fetch(`${ollamaHost}/api/tags`, {
            signal: AbortSignal.timeout(8000),
          }),
        ]);
        if (!versionResponse.ok) throw new Error(`niedostępna (${ollamaHost}, HTTP ${versionResponse.status})`);
        const versionData: any = await versionResponse.json();
        if (String(versionData.version || '').includes('svl-364')) {
          throw new Error(`pod ${ollamaHost} działa wbudowany zastępnik Ollamy, który nie uruchamia modeli`);
        }
        if (!tagResponse.ok) throw new Error('nie udało się odczytać listy modeli');
        const catalog: any = await tagResponse.json();
        const resolvedModel = resolveInstalledOllamaModel(
          selectedOllamaModelName,
          Array.isArray(catalog.models) ? catalog.models : [],
          Boolean(imageBase64),
        );
        if (resolvedModel.installedCount === 0) {
          throw new Error(`w Ollamie (${ollamaHost}) nie ma żadnego pobranego modelu — pobierz model (np. ${selectedOllamaModelName})`);
        }
        selectedOllamaModelName = resolvedModel.name;
        displayModelBadge = badgeForModel(selectedOllamaModelName);
        const ollamaMessages = [
          ...(agentMemoryContext ? [{ role: 'system', content: agentMemoryContext }] : []),
          ...agentHistory,
          {
            role: 'user',
            content: cleanMsg ? labelOperatorText(cleanMsg) : '',
            ...(imageBase64 ? { images: [imageBase64.replace(/^data:[^;]+;base64,/, '')] } : {}),
          },
        ];
        // Bielik/Maya i jawne modele Ollama: model wybrany świadomie, a zimne ładowanie 11B
        // do pamięci trwa dłużej niż kilka sekund — krótki limit kończył się brakiem odpowiedzi.
        const ollamaTimeoutMs = ollamaChatTimeoutMs;
        ollamaGenerationStarted = true;
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
            const finalReply = cleanReplyFor(extReplyRaw);
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
              provenance: 'model_unverified',
              ...(wantsWebSources ? { verificationNote: webSearchUnavailableNote } : {}),
              followUpMessages: [],
              appliedActions,
              latestServerRevision: latestActionSrvRev,
            });
            return;
          }
        } else {
          const errBody = (await oResp.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
          throw new Error(`HTTP ${oResp.status}${errBody ? `: ${errBody}` : ''}`);
        }
        ollamaFailure = ollamaFailure || 'model zwrócił pustą odpowiedź';
      } catch (error) {
        // Dalej: Gemini albo uczciwa informacja o braku modelu.
        const reason = error instanceof Error ? error.message : String(error);
        if (/TimeoutError|timeout|aborted/i.test(reason) && ollamaGenerationStarted) {
          // Ollama działa i przyjęła zapytanie — model po prostu generował dłużej niż limit.
          ollamaTimedOut = true;
          ollamaFailure =
            `model ${selectedOllamaModelName} działa, ale nie skończył odpowiedzi w ${Math.round(ollamaChatTimeoutMs / 1000)} s ` +
            '(ustaw dłuższy OLLAMA_CHAT_TIMEOUT_MS albo mniejszy model)';
        } else {
          ollamaFailure = /fetch failed|ECONNREFUSED|abort|timeout/i.test(reason)
            ? `niedostępna pod ${ollamaHost} (brak połączenia lub przekroczony czas: ${reason})`
            : reason;
        }
      }
    }

    // 2) Full Conversational & Tool-Calling Engine (serves all Ollama models, SVL-364 Router, and Gemini models)
    if (ai) {
      const candidateModels = await geminiCandidatesFor(ai, effectiveModel);
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
      if (cleanMsg || !imageBase64) {
        currentParts.push({ text: labelOperatorText(cleanMsg) });
      }

      const coalescedHistory: Array<{ role: 'user' | 'model'; parts: any[] }> = [];
      for (const turn of agentHistory) {
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

      const callModelWithRetry = async (
        candidate: string,
        contentsPayload: any[],
        includeTools: boolean,
        useSearchGrounding = wantsWebSources,
      ) => {
        const tempCfg = candidate === 'gemini-3.1-flash-lite' ? { temperature: effectiveTemperature } : {};
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            return await ai.models.generateContent({
              model: candidate,
              contents: contentsPayload,
              config: {
                ...tempCfg,
                ...(agentMemoryContext ? { systemInstruction: agentMemoryContext } : {}),
                ...(includeTools
                  ? { tools: [{ functionDeclarations: chatToolDeclarations }] }
                  : useSearchGrounding
                    ? { tools: [{ googleSearch: {} }] }
                    : {}),
                abortSignal: AbortSignal.timeout(Number(process.env.GEMINI_TIMEOUT_MS || 30000)),
              },
            });
          } catch (err: any) {
            const msgStr = String(err?.message || err);
            if (useSearchGrounding && !includeTools) {
              return await callModelWithRetry(candidate, contentsPayload, false, false);
            }
            if (attempt === 0 && (msgStr.includes('429') || msgStr.includes('RESOURCE_EXHAUSTED') || msgStr.includes('503'))) {
              await new Promise((r) => setTimeout(r, 1100));
              continue;
            }
            throw err;
          }
        }
        throw new Error('Retry exhausted');
      };

      const geminiErrors: string[] = [];
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
            const plainRes = await callModelWithRetry(candidate, baseContents, false, false);
            replyText = (plainRes.text || '').trim();
          }
          if (replyText) {
            replyText = cleanReplyFor(replyText);
            const webSources = wantsWebSources ? collectWebSources(response as any) : [];
            replyText = withDirectiveReceipts(
              appendWebSources(guardUnverifiedMissionCompletion(missionVerificationContext, replyText), webSources),
            );
            const geminiBadge = `${selectedDisplayName} · Gemini (${candidate})${imageBase64 ? ' · Vision' : ''}`;
            if (agentState?.canonical_name) {
              const memRes = await callPythonBackend(
                'POST',
                '/api/py/agents/memory',
                {
                  agent: selectedAgent,
                  kind: 'episode',
                  content: `Rozmowa (${geminiBadge}): Pytanie "${cleanMsg.slice(0, 120)}" -> Odpowiedź "${replyText.slice(0, 180)}"`,
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
              modelUsed: geminiBadge,
              reply: replyText,
              provenance: webSources.length > 0 ? 'web_sources' : 'model_unverified',
              ...(wantsWebSources && webSources.length === 0
                ? { verificationNote: 'Wyszukiwanie nie zwróciło źródeł — odpowiedź pochodzi z wiedzy modelu i nie została zweryfikowana.' }
                : {}),
              followUpMessages: [],
              appliedActions,
              latestServerRevision: latestActionSrvRev,
            });
            return;
          }
          geminiErrors.push(`${candidate}: pusta odpowiedź`);
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          if (isGeminiModelGoneError(errMsg)) markGeminiModelGone(candidate);
          geminiErrors.push(`${candidate}: ${describeGeminiError(errMsg, Number(process.env.GEMINI_TIMEOUT_MS || 30000))}`);
          continue;
        }
      }
      geminiFailure = geminiErrors.join(' | ') || 'żaden model Gemini nie zwrócił odpowiedzi';
    }

    // 3) Intelligent local conversational & command fallback (never dumps unsolicited raw system reports)
    const explicitSystemReportAsked = /\b(?:pełny raport|pelny raport|raport svl_system|raport systemu|markdown-report)\b/i.test(cleanMsg);
    if (explicitSystemReportAsked) {
      const repFallback = await callPythonBackend(
        'POST',
        '/api/py/kernel/markdown-report',
        { directive: cleanMsg || 'raport systemu SVL_System', origin, correlationId: corrId },
        corrId,
      );
      const kernelReply = String(repFallback.data?.report || '').trim();
      res.json({
        ok: true,
        sender: 'Maya',
        agentId: 'Maya',
        modelUsed: 'Maya · raport SVL_System (wynik serwera)',
        reply: withDirectiveReceipts(kernelReply),
        provenance: 'server_verified',
        followUpMessages: [],
        appliedActions,
        latestServerRevision: Math.max(latestActionSrvRev, Number(repFallback.data?.serverRevision || 0)),
      });
      return;
    }

    let conversationalReply = '';
    if (directiveReceipts.length > 0) {
      // Commands were already executed up front; report their real results.
      conversationalReply = directiveReceipts.join('\n\n');
    } else {
      // Bez modelu nie ma rozmowy — mówimy to wprost zamiast udawać odpowiedź.
      conversationalReply =
        (ollamaTimedOut
          ? `⚠️ ${selectedDisplayName} nie zdążył(a) odpowiedzieć.\n\n`
          : `⚠️ ${selectedDisplayName} nie może teraz odpowiedzieć: żaden model AI nie odpowiedział.\n\n`) +
        `- **Ollama:** ${ollamaFailure || 'brak odpowiedzi'}\n` +
        `- **Gemini:** ${geminiFailure || 'brak odpowiedzi'}\n\n` +
        'Polecenia czatu działają bez modelu (np. „Zapisz w pamięci, że…”, `/status`, `/moduly`, `/exec <polecenie>`). ' +
        '[btn: 🛰️ Stan usług|tab:svl364]';
    }

    res.json({
      ok: true,
      sender: selectedDisplayName,
      agentId: selectedAgent,
      modelUsed: directiveReceipts.length > 0 ? displayModelBadge : 'Brak dostępnego modelu AI',
      reply: conversationalReply,
      provenance: directiveReceipts.length > 0 ? 'server_verified' : 'error',
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

  // 3b. Rozmowa obustronna bez promptów: modele dostają wyłącznie zapis rozmowy.
  // Najpierw model dopisuje „[…”, czyli sam wskazuje, kto mówi następny; potem wskazana AI
  // dopisuje swoją kwestię własnym modelem. Gdy model wskaże Operatora — AI czekają.
  const SAFETY_MAX_AI_TURNS = Number(process.env.SVL_DUPLEX_MAX_AI_TURNS || 8);
  const AUTONOMOUS_MIN_INTERVAL_MS = 3200;
  const proactiveInFlight = new Set<string>();
  const lastProactiveAt = new Map<string, number>();
  const SKIP_MESSAGES: Record<string, string> = {
    waiting_for_operator: 'Model wskazał, że teraz Twoja kolej — AI czekają na Twoją wiadomość.',
    no_decision: 'Model nie wskazał kolejnego mówcy — rozmowa czeka na Ciebie.',
    ai_turn_limit: `Bezpiecznik kosztów: ${SAFETY_MAX_AI_TURNS} wypowiedzi AI z rzędu bez Twojej wiadomości.`,
    busy: 'Inna karta lub poprzednie wywołanie właśnie generuje wypowiedź.',
  };

  /** Wybór kolejnego mówcy przez Ollamę (`raw: true`) lub Gemini (krótki wybór spośród uczestników). */
  const predictNextSpeaker = async (
    agentModel: string,
    ollamaHost: string,
    transcript: string,
    participants: ConversationAgent[],
    requestedModel: string,
    failures: string[],
  ): Promise<{ predicted: ConversationAgent | 'operator' | null; providerOnline: boolean }> => {
    const fromOllama = await ollamaContinueRaw(ollamaHost, agentModel, `${transcript}\n[`, {
      temperature: 0.7,
      numPredict: 12,
      stop: [']', '\n'],
      // Krótka predykcja (12 tokenów) — dłuższy limit tylko blokował rozmowę.
      timeoutMs: Math.min(Number(process.env.OLLAMA_CHAT_TIMEOUT_MS || 60000), 60000),
    });
    if (fromOllama.ok) {
      return { predicted: parsePredictedSpeaker(fromOllama.text), providerOnline: true };
    }
    failures.push(fromOllama.reason);
    const gemini = getGeminiClient();
    if (!gemini) {
      failures.push('Gemini: brak klucza GEMINI_API_KEY');
      return { predicted: null, providerOnline: false };
    }
    const choices = [...participants, 'Operator'].join(', ');
    for (const candidate of await geminiCandidatesFor(gemini, requestedModel)) {
      try {
        const gen = await gemini.models.generateContent({
          model: candidate,
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text:
                    `${transcript}\n\n` +
                    `Kto naturalnie zabiera głos jako następny (${choices})? Odpowiedz wyłącznie jedną nazwą.`,
                },
              ],
            },
          ],
          config: {
            temperature: 0.5,
            maxOutputTokens: 128,
            abortSignal: AbortSignal.timeout(Number(process.env.GEMINI_TIMEOUT_MS || 30000)),
          },
        });
        const parsed = parsePredictedSpeaker(gen.text || '');
        if (parsed) return { predicted: parsed, providerOnline: true };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        if (isGeminiModelGoneError(errMsg)) markGeminiModelGone(candidate);
        failures.push(`Gemini ${candidate}: ${describeGeminiError(errMsg, Number(process.env.GEMINI_TIMEOUT_MS || 30000))}`);
      }
    }
    return { predicted: null, providerOnline: true };
  };

  /** Wypowiedź wskazanego agenta: najpierw Ollama (`raw: true`), awaryjnie Gemini z pamięcią długotrwałą i perspektywą agenta. */
  const generateAgentProactiveLine = async (
    agentModel: string,
    ollamaHost: string,
    turns: DialogueTurn[],
    transcript: string,
    speaker: ConversationAgent,
    requestedModel: string,
    memoryContext: string,
    failures: string[],
  ): Promise<{ text: string; label: string } | null> => {
    const rawPromptPrefix = memoryContext ? `${memoryContext}\n\n` : '';
    const starterBlock = transcript
      ? `${transcript}\n[${speaker}]: `
      : `${buildProactiveStarterPrompt(speaker, 'Mateusz', memoryContext)}\n[${speaker}]: `;
    const fromOllama = await ollamaContinueRaw(ollamaHost, agentModel, `${rawPromptPrefix}${starterBlock}`, {
      temperature: 0.8,
      numPredict: 400,
      stop: ['\n['],
      timeoutMs: Number(process.env.OLLAMA_CHAT_TIMEOUT_MS || 120000),
    });
    if (fromOllama.ok) return { text: fromOllama.text, label: `Ollama (${fromOllama.model})` };
    failures.push(fromOllama.reason);
    const gemini = getGeminiClient();
    if (!gemini) {
      failures.push('Gemini: brak klucza GEMINI_API_KEY');
      return null;
    }
    const perspective = toAgentPerspective(turns, speaker, 24);
    const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = perspective.map((turn) => ({
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: turn.content }],
    }));
    if (contents.length === 0) {
      contents.push({
        role: 'user',
        parts: [{ text: buildProactiveStarterPrompt(speaker, 'Mateusz', memoryContext) }],
      });
    } else if (contents[contents.length - 1].role === 'model') {
      contents.push({ role: 'user', parts: [{ text: `[Kontynuuj swobodną rozmowę jako ${speaker}.]` }] });
    }
    for (const candidate of await geminiCandidatesFor(gemini, requestedModel)) {
      try {
        const gen = await gemini.models.generateContent({
          model: candidate,
          contents,
          config: {
            temperature: 0.8,
            maxOutputTokens: 1024,
            ...(memoryContext ? { systemInstruction: memoryContext } : {}),
            stopSequences: ['\n[Mateusz', '\n[Operator', '\n[Bielik]:', '\n[Maya]:'],
            abortSignal: AbortSignal.timeout(Number(process.env.GEMINI_TIMEOUT_MS || 30000)),
          },
        });
        const text = (gen.text || '').trim();
        if (text) return { text, label: `Gemini (${candidate})` };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        if (isGeminiModelGoneError(errMsg)) markGeminiModelGone(candidate);
        failures.push(`Gemini ${candidate}: ${describeGeminiError(errMsg, Number(process.env.GEMINI_TIMEOUT_MS || 30000))}`);
      }
    }
    return null;
  };

  app.post('/api/chat/proactive', asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ ok: false, error: 'Inicjowanie wiadomości agentów wymaga SVL_OPERATOR_TOKEN.' });
      return;
    }
    const corrId: string = (req as any).correlationId || '';
    const {
      conversationId = 'conv-rodzina-mitek-wszyscy',
      targetAgent = '',
      model = 'svl-hybrid-router',
      origin = 'client',
      history = [],
      autonomous = false,
    } = req.body || {};
    const convId = String(conversationId || 'conv-rodzina-mitek-wszyscy').slice(0, 120);
    const requestedModel = String(model || '');
    const isAutonomous = Boolean(autonomous);

    const skip = (reason: string, detail?: string) => {
      res.status(isAutonomous ? 200 : reason === 'no_model' ? 503 : 409).json({
        ok: false,
        skipped: true,
        reason,
        error: detail || SKIP_MESSAGES[reason] || reason,
      });
    };

    // Kilka otwartych kart uruchamia własne pętle — serwer dopuszcza jedną wypowiedź naraz.
    if (proactiveInFlight.has(convId)) return skip('busy');
    if (isAutonomous && Date.now() - (lastProactiveAt.get(convId) || 0) < AUTONOMOUS_MIN_INTERVAL_MS) return skip('busy');
    proactiveInFlight.add(convId);
    try {
      // Źródłem prawdy jest SQLite (zawiera nadawców); historia z klienta tylko awaryjnie.
      const convSnap = await callPythonBackend('GET', '/api/py/chat/conversations', undefined, corrId);
      const stored = (Array.isArray(convSnap.data?.conversations) ? convSnap.data.conversations : [])
        .find((c: any) => c.id === convId);
      const source: any[] = Array.isArray(stored?.messages) && stored.messages.length > 0
        ? stored.messages
        : Array.isArray(history)
          ? history
          : [];
      const turns: DialogueTurn[] = source
        .filter((m: any) => m && typeof m.content === 'string')
        .slice(-40)
        .map((m: any) => ({ role: String(m.role || ''), sender: String(m.sender || ''), content: String(m.content) }));

      const transcript = buildTranscript(turns, 30);
      const consecutiveAi = consecutiveAiTurns(turns);
      if (isAutonomous && consecutiveAi >= SAFETY_MAX_AI_TURNS) return skip('ai_turn_limit');

      const channelAgent: ConversationAgent | null =
        convId === 'conv-agent-bielik' ? 'Bielik' : convId === 'conv-agent-maya' ? 'Maya' : null;
      const participants: ConversationAgent[] = channelAgent ? [channelAgent] : CONVERSATION_AGENTS;
      const reqTargetNorm = normalizeAgentCanonicalName(String(targetAgent || ''));
      const explicitTarget: ConversationAgent | null =
        channelAgent ||
        (reqTargetNorm === 'Bielik' || reqTargetNorm === 'Maya' ? reqTargetNorm : null);

      const { healthRes, agentsRes } = await getFastChatBackendMeta(corrId);
      const modelFor = (agent: ConversationAgent): string => {
        if (requestedModel.startsWith('ollama:')) return requestedModel.slice('ollama:'.length);
        const cfg: any = (agentsRes.data?.agents || []).find((a: any) => a.canonical_name === agent)?.config || {};
        if (String(cfg.preferred_model || '').startsWith('ollama:')) return String(cfg.preferred_model).slice('ollama:'.length);
        return String(cfg.ollama_model || process.env.OLLAMA_PREFERRED_MODEL || 'llama3.2-vision:11b');
      };
      const ollamaHost = String(healthRes.data?.ollama?.ollama_host || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434');
      const failures: string[] = [];
      const noModel = () =>
        skip('no_model', `Żaden model AI nie odpowiedział (${[...new Set(failures)].slice(0, 3).join('; ')}).`);

      const lastDialogueTurn = [...turns].reverse().find((t) => (t.role === 'user' || t.role === 'assistant') && Boolean(t.content.trim()));
      const lastAi = [...turns]
        .reverse()
        .map((t) => agentOf(t))
        .find((s): s is ConversationAgent => Boolean(s && participants.includes(s)));

      let predicted: ConversationAgent | 'operator' | null = null;
      if (transcript) {
        const pred = await predictNextSpeaker(
          modelFor(participants[0]), ollamaHost, transcript, participants, requestedModel, failures,
        );
        if (!pred.providerOnline) return noModel();
        predicted = pred.predicted;
      }

      const speakerChoice = selectNextFreeSpeaker({
        predicted,
        participants,
        lastTurnRole: lastDialogueTurn?.role,
        lastAiSpeaker: lastAi || null,
        isAutonomous,
        consecutiveAi,
        hasTurns: Boolean(transcript),
        explicitTarget,
      });
      if (!speakerChoice.speaker) {
        return skip(speakerChoice.skipReason || 'no_decision');
      }
      const speaker = speakerChoice.speaker;

      // Recalled SQLite memory for this speaker so free conversation remembers operator facts & past sessions.
      let speakerMemories: AgentMemoryRecord[] = [];
      const memSearch = await callPythonBackend(
        'POST',
        '/api/py/agents/memory/search',
        { agent: speaker, query: lastDialogueTurn?.content || '', limit: 14 },
        corrId,
      );
      if (memSearch.status === 200 && Array.isArray(memSearch.data?.memories)) {
        speakerMemories = memSearch.data.memories;
      } else if (Array.isArray(agentsRes.data?.agent_memories?.[speaker])) {
        speakerMemories = agentsRes.data.agent_memories[speaker];
      }
      const speakerMemoryContext = buildAgentSystemContext(formatMemoryPromptContext(speakerMemories, speaker, 12));

      // 2) Wskazana AI dopisuje swoją kwestię własnym modelem (lub inicjuje rozmowę na pustym kanale).
      const line = await generateAgentProactiveLine(
        modelFor(speaker), ollamaHost, turns, transcript, speaker, requestedModel, speakerMemoryContext, failures,
      );
      if (!line) return noModel();
      const text = normalizeAiInteractiveMarkup(cleanAgentReply(line.text, speaker));
      if (!text || isRepetitive(text, turns.slice(-8).map((t) => t.content))) {
        return skip('nothing_new', `${speaker} nie miał(a) nic nowego do powiedzenia — wypowiedź pominięta.`);
      }

      const assistantMsg = {
        id: `asst-proactive-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: 'assistant',
        sender: speaker,
        agentId: speaker,
        modelUsed: `${line.label} · rozmowa obustronna`,
        provenance: 'model_unverified',
        timestamp: new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }),
        content: text,
      };
      const pySave = await callPythonBackend(
        'POST',
        '/api/py/chat/conversations/message',
        {
          conversation_id: convId,
          title: (typeof stored?.title === 'string' && stored.title.trim()) ? stored.title : getCanonicalConversationTitle(convId),
          model,
          message: assistantMsg,
          origin,
          eventId: `evt-proact-${assistantMsg.id}`,
        },
        corrId,
      );
      if (pySave.status !== 200 || !pySave.data?.ok) {
        res.status(pySave.status >= 400 ? pySave.status : 503).json({
          ok: false,
          error: pySave.data?.error || 'Nie udało się zapisać wypowiedzi w SQLite.',
        });
        return;
      }
      void callPythonBackend(
        'POST',
        '/api/py/agents/memory',
        {
          agent: speaker,
          kind: 'episode',
          source: 'free_chat',
          content: `Swobodna rozmowa (${speaker}): "${text.slice(0, 200)}"`,
          origin,
          correlationId: corrId,
        },
        corrId,
      ).then((memRes) => {
        if (memRes.data?.event) publishOutboxEvent(memRes.data.event);
      }).catch(() => undefined);

      lastProactiveAt.set(convId, Date.now());
      if (pySave.data?.event) publishOutboxEvent(pySave.data.event);
      res.json({
        ok: true,
        sender: speaker,
        agentId: speaker,
        modelUsed: assistantMsg.modelUsed,
        message: assistantMsg,
        serverRevision: pySave.data?.serverRevision,
      });
    } finally {
      proactiveInFlight.delete(convId);
    }
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
    svlFileLogger.log({
      layer: 'GATEWAY',
      level: 'ERROR',
      category: 'api_error',
      correlationId: (req as any).correlationId || '',
      message: `${req.method} ${req.originalUrl.split('?')[0]} -> HTTP ${status}: ${scrubSensitiveText(msg)}`,
    });
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
        svlFileLogger.log({
          layer: 'WS',
          level: 'WARN',
          category: 'ws_auth_denied',
          message: 'Odrzucono upgrade /ws/svl (HTTP 401 — nieprawidłowy lub brakujący SVL_OPERATOR_TOKEN)',
        });
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
    svlFileLogger.log({
      layer: 'WS',
      level: 'INFO',
      category: 'ws_connect',
      origin: clientOrigin,
      message: `Połączono klienta ${clientId} (lastRevision=${clientLastRev}, aktywnych=${wsClients.size})`,
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
      // Kursor relaya przesuwamy tylko, gdy nikt inny nie czeka na zdarzenia —
      // inaczej nowe połączenie „połykało” zdarzenia jeszcze niewysłane pozostałym klientom.
      if (!outboxCursorInitialized || wsClients.size <= 1) {
        lastRelayedServerRevision = Math.max(lastRelayedServerRevision, currentSrvRev);
        outboxCursorInitialized = true;
      }
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
      svlFileLogger.log({
        layer: 'WS',
        level: 'ERROR',
        category: 'ws_client_error',
        origin: clientOrigin,
        message: `Błąd gniazda ${clientId}: ${err.message}`,
      });
    });

    ws.on('close', (code) => {
      wsClients.delete(ws);
      svlFileLogger.log({
        layer: 'WS',
        level: 'INFO',
        category: 'ws_disconnect',
        origin: clientOrigin,
        message: `Rozłączono klienta ${clientId} (code=${code}, aktywnych=${wsClients.size})`,
      });
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
    svlFileLogger.logSync({
      layer: 'SYSTEM',
      level: 'INFO',
      category: 'gateway_shutdown',
      message: 'Zamykanie serwera Gateway i Python Backend',
    });
    stopPythonBackend();
    for (const client of wss.clients) client.terminate();
    httpServer.close();
  };
  process.once('SIGTERM', stopGateway);
  process.once('SIGINT', stopGateway);

  const bindHost = process.env.SVL_BIND_HOST ||
    (process.env.NODE_ENV === 'production' ? '127.0.0.1' : '0.0.0.0');
  httpServer.listen(PORT, bindHost, () => {
    console.log(`[SVL Python OS] Gateway running on http://${bindHost}:${PORT}`);
    svlFileLogger.log({
      layer: 'GATEWAY',
      level: 'INFO',
      category: 'gateway_listen',
      message: `SVL Gateway nasłuchuje na http://${bindHost}:${PORT}`,
    });
  });
}

startServer();
