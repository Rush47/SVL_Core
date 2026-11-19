import express from 'express';
import { createServer as createHttpServer, IncomingMessage } from 'node:http';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
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
  FULL_ROOT_SCOPES,
  getGitHubAgentPermissions,
  isGitHubChatRequest,
  guardUnverifiedMissionCompletion,
  normalizeAgentCanonicalName,
  normalizeAiInteractiveMarkup,
  enforceFactualExecutionGuard,
  unverifiedExecutionNote,
  parseBielikChatCommand,
  parseSshShipTerminalInput,
  resolveChatTargetAgent,
  resolveInstalledOllamaModel,
  selectOllamaModelName,
  type BielikSlashCommand,
  type ChatAppliedAction,
} from './src/utils/svlLogic.ts';
import {
  containsLikelySecret,
  DEFAULT_GITHUB_FILE_BRANCH,
  GitHubFileService,
  isAllowedGitHubFilePath,
} from './src/utils/githubFiles.ts';
import { commandKey, isMutatingCommand, parseChatDirectives } from './src/server/chatDirectives.ts';
import { buildAgentSystemContext } from './src/server/interactiveElements.ts';
import {
  parseShipOllamaTunnelEnv,
  buildSshTunnelArgs,
  tunnelOllamaUrl,
  tunnelRestartDelayMs,
  describeTunnelStatus,
  type ShipOllamaTunnelConfig,
  type TunnelStatus,
} from './src/server/shipOllamaTunnel.ts';
import {
  buildMayaMissionPlan,
  type MissionInput,
  type MissionSeverity,
  type MissionFinding,
  type MissionSafeAction,
  type MissionProposal,
} from './src/server/mayaMission.ts';
import { createSvlMcpServer } from './src/server/svlMcpServer.ts';
import {
  clearOllamaReadyCache,
  getOllamaRuntimeOptions,
  warmOllamaModels,
  isAutoGitSyncAllowed,
  resolveCachedOllamaModel,
  selectChatMaxOutputTokens,
  shouldEnableGitHubToolsForMessage,
  trimHistoryForOllama,
} from './src/server/ollamaOptimizer.ts';
import {
  GITHUB_REPOSITORY,
  assessGhCommand,
  cancelConfirmation,
  describeOp,
  describeStatus,
  destructiveReason,
  executeOp,
  getGitHubToken,
  ghCliAvailable,
  gitSync,
  gitSyncStatus,
  githubApi,
  isAllowedApiPath,
  queueConfirmation,
  runGhCommand,
  setGitHubLogger,
  splitArgs,
  syncBranch,
  takeConfirmation,
  verifyGitHubToken,
  type GitSyncAction,
} from './src/server/githubAdmin.ts';
import {
  createGeminiDeadline,
  describeGeminiError,
  disableThinkingConfigFor,
  discoverGeminiModels,
  geminiThinkingConfig,
  isGeminiQuotaExhaustedError,
  isGeminiSlowOrBusyError,
  isGeminiTimeoutError,
  isThinkingConfigError,
  noteGeminiQuotaExhausted,
  noteGeminiSlowOrBusy,
  noteGeminiSuccess,
  noteGeminiTimeout,
  geminiCandidatesFor,
  getSoonestGeminiRetryMs,
  isGeminiModelGoneError,
  markGeminiModelGone,
  setGeminiModelLogger,
  setGeminiModelStatePath,
  summarizeGeminiFailures,
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
const GITHUB_TOKEN_SECRET_FILE = path.join(__dirname, 'data', 'svl_github_token.secret');

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
  const existingTokenOnDisk = fsSync.existsSync(OPERATOR_TOKEN_SECRET_FILE)
    ? fsSync.readFileSync(OPERATOR_TOKEN_SECRET_FILE, 'utf8').trim()
    : '';
  if (existingTokenOnDisk !== process.env.SVL_OPERATOR_TOKEN) {
    fsSync.mkdirSync(path.dirname(OPERATOR_TOKEN_SECRET_FILE), { recursive: true });
    fsSync.writeFileSync(OPERATOR_TOKEN_SECRET_FILE, process.env.SVL_OPERATOR_TOKEN, { mode: 0o600 });
  }
} catch {
  // ignore read-only fs
}

// Klucz MCP w adresie (konektor aplikacji Claude): z .env albo wygenerowany raz i zapisany w data/ (poza gitem).
const MCP_URL_KEY_FILE = path.join(__dirname, 'data', 'svl_mcp_url_key.secret');
if (!String(process.env.SVL_MCP_URL_KEY || '').trim() || String(process.env.SVL_MCP_URL_KEY).trim().length < 32) {
  try {
    const saved = fsSync.existsSync(MCP_URL_KEY_FILE) ? fsSync.readFileSync(MCP_URL_KEY_FILE, 'utf8').trim() : '';
    if (saved.length >= 32) {
      process.env.SVL_MCP_URL_KEY = saved;
    } else {
      process.env.SVL_MCP_URL_KEY = randomBytes(32).toString('base64url');
      fsSync.mkdirSync(path.dirname(MCP_URL_KEY_FILE), { recursive: true });
      fsSync.writeFileSync(MCP_URL_KEY_FILE, process.env.SVL_MCP_URL_KEY, { mode: 0o600 });
    }
  } catch {
    // system plików tylko do odczytu — konektor przez adres niedostępny, nagłówek Bearer działa nadal
  }
}

// Load GITHUB_TOKEN / GH_TOKEN from env/.env or persisted data/svl_github_token.secret
const explicitGithubToken = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
if (explicitGithubToken) {
  process.env.GITHUB_TOKEN = explicitGithubToken;
  process.env.GH_TOKEN = explicitGithubToken;
  try {
    const existingGhOnDisk = fsSync.existsSync(GITHUB_TOKEN_SECRET_FILE)
      ? fsSync.readFileSync(GITHUB_TOKEN_SECRET_FILE, 'utf8').trim()
      : '';
    if (existingGhOnDisk !== explicitGithubToken) {
      fsSync.mkdirSync(path.dirname(GITHUB_TOKEN_SECRET_FILE), { recursive: true });
      fsSync.writeFileSync(GITHUB_TOKEN_SECRET_FILE, explicitGithubToken, { mode: 0o600 });
    }
  } catch {
    // ignore read-only fs
  }
} else {
  try {
    const savedGhToken = fsSync.readFileSync(GITHUB_TOKEN_SECRET_FILE, 'utf8').trim();
    if (savedGhToken.length >= 20) {
      process.env.GITHUB_TOKEN = savedGhToken;
      process.env.GH_TOKEN = savedGhToken;
    }
  } catch {
    // optional GitHub token not configured yet
  }
}

// Domyślnie zapisujemy logi runtime poza katalogiem roboczym (/tmp/svl-runtime-logs),
// aby ciągły zapis logów nie wywoływał w AI Studio automatycznych checkpointów „Manual edit”.
const resolvedLogDir =
  process.env.SVL_LOG_DIR ||
  (process.env.SVL_LOG_IN_WORKSPACE === '1' ? path.join(__dirname, 'logi') : '/tmp/svl-runtime-logs');
const svlFileLogger = new SvlFileLogger({ logDir: resolvedLogDir });
setGeminiModelLogger((level, message, details) =>
  svlFileLogger.log({ layer: 'GATEWAY', level, category: 'ai_models', message, details }),
);
// Stan modeli Gemini (wycofane / bez kwoty) przetrwa restart serwera; poza katalogiem projektu,
// żeby zapis nie tworzył punktów kontrolnych w AI Studio.
setGeminiModelStatePath(
  process.env.SVL_GEMINI_STATE_FILE || path.join(os.tmpdir(), 'svl-gemini-model-state.json'),
  fsSync,
);
setGitHubLogger((level, message, details) =>
  svlFileLogger.log({ layer: 'GATEWAY', level, category: 'github', message, details }),
);
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
        description: 'Read an allowed source file from Rush47/SVL_Core on the svl-sync branch.',
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

let ollamaWarmupRunning = false;
/** Ładuje do pamięci Ollamy modele skonfigurowane dla Bielika i Mayi (bez zgadywania: tylko zainstalowane). */
async function warmConfiguredOllamaModels(): Promise<void> {
  if (ollamaWarmupRunning) return;
  ollamaWarmupRunning = true;
  try {
    const [healthRes, agentsRes] = await Promise.all([
      callPythonBackend('GET', '/api/py/health?fast=1'),
      callPythonBackend('GET', '/api/py/agents/status'),
    ]);
    const host = String(healthRes.data?.ollama?.ollama_host || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
    const modules: any[] = Array.isArray(healthRes.data?.system_modules) ? healthRes.data.system_modules : [];
    const agents: any[] = Array.isArray(agentsRes.data?.agents) ? agentsRes.data.agents : [];
    const wanted = [
      process.env.OLLAMA_PREFERRED_MODEL || 'llama3.2-vision:11b',
      ...String(process.env.OLLAMA_WARM_MODELS || '').split(','),
      ...agents.map((a) => a?.config?.ollama_model),
      modules.find((m) => m?.id === 'svl-364')?.config?.configured_ollama_model,
    ].map((m) => String(m || '').trim()).filter(Boolean);
    const installed: string[] = [];
    for (const name of wanted) {
      const ready = await resolveCachedOllamaModel(host, name);
      if (!ready.ok) {
        svlFileLogger.log({ layer: 'GATEWAY', level: 'INFO', category: 'ai_models', message: `Rozgrzewanie Ollamy pominięte: ${ready.reason}` });
        return;
      }
      if (!installed.includes(ready.model)) installed.push(ready.model);
    }
    const opts = getOllamaRuntimeOptions(process.env);
    const results = await warmOllamaModels(host, installed, { keepAlive: opts.keep_alive, perf: opts.perf });
    svlFileLogger.log({
      layer: 'GATEWAY',
      level: results.every((r) => r.ok) ? 'INFO' : 'WARN',
      category: 'ai_models',
      message: `Ollama (${host}) — modele w pamięci: ${results.map((r) => `${r.model}: ${r.ok ? 'OK' : r.detail}`).join(', ') || 'brak'}`,
    });
  } catch (error) {
    svlFileLogger.log({ layer: 'GATEWAY', level: 'WARN', category: 'ai_models', message: `Rozgrzewanie Ollamy nieudane: ${error instanceof Error ? error.message : String(error)}` });
  } finally {
    ollamaWarmupRunning = false;
  }
}

type OllamaChatResult = { ok: true; text: string; model: string } | { ok: false; reason: string };

/** Czy pod `base` działa prawdziwa Ollama; zwraca model faktycznie zainstalowany dla `model` (z 30 s cache). */
async function ollamaReadyModel(
  base: string,
  model: string,
  requireVision = false,
): Promise<{ ok: true; model: string } | { ok: false; reason: string }> {
  const res = await resolveCachedOllamaModel(base, model, { requireVision });
  if (!res.ok) return res;
  return { ok: true, model: res.model };
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
  const runtimeOpts = getOllamaRuntimeOptions(process.env);
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
        keep_alive: runtimeOpts.keep_alive,
        options: {
          temperature: options.temperature,
          num_predict: Math.min(options.numPredict, runtimeOpts.num_predict),
          stop: options.stop,
          num_ctx: runtimeOpts.num_ctx,
          ...runtimeOpts.perf,
        },
      }),
    });
    if (!res.ok) {
      clearOllamaReadyCache(base);
      return { ok: false, reason: `Ollama /api/generate zwróciła kod ${res.status}` };
    }
    const data: any = await res.json();
    return { ok: true, text: String(data?.response || ''), model: installedModel };
  } catch (error) {
    clearOllamaReadyCache(base);
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
    // @google/genai 3.x domyślnie używa API `v1`, w którym nie ma modeli preview, aliasów *-latest
    // ani części funkcji (np. wyszukiwania Google) — stąd 404 „not found for API version v1”.
    apiVersion: process.env.GOOGLE_GENAI_API_VERSION || 'v1beta',
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
  cleaned = cleaned.replace(/\bBearer\s+[A-Za-z0-9_.\-=+/]{12,}/gi, 'Bearer [REDACTED]');
  cleaned = cleaned.replace(/\bBasic\s+[A-Za-z0-9+/=]{12,}/gi, 'Basic [REDACTED]');
  cleaned = cleaned.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_GITHUB_TOKEN]');
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
      PYTHONDONTWRITEBYTECODE: '1',
      SVL_LOG_DIR: resolvedLogDir,
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

  const ghToken = getGitHubToken();
  const gitShellEnv: Record<string, string> = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: ghToken ? '2' : '1',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: __dirname,
    ...(ghToken
      ? {
          GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader',
          GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${ghToken}`).toString('base64')}`,
        }
      : {}),
  };

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
          ...gitShellEnv,
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

/** Klucz MCP w adresie (konektor aplikacji Claude): osobny sekret SVL_MCP_URL_KEY, min. 32 znaki. */
function mcpUrlKeyMatches(candidate: string): boolean {
  const secret = String(process.env.SVL_MCP_URL_KEY || '').trim();
  const value = String(candidate || '').trim();
  if (secret.length < 32 || value.length !== secret.length) return false;
  try {
    return timingSafeEqual(Buffer.from(value, 'utf8'), Buffer.from(secret, 'utf8'));
  } catch {
    return false;
  }
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

// ======================= OLLAMA ZE STATKU SVL-364 PRZEZ SSH =======================
// Gdy SVL_SHIP_OLLAMA=1, cały system używa Ollamy ze statku: gateway zestawia tunel SSH
// (local port-forward) i ustawia OLLAMA_HOST na jego lokalny koniec PRZED startem backendu
// Pythona, więc czat, rozgrzewanie modeli i misja Mayi widzą tę samą Ollamę ze statku.
const shipTunnelCfg: ShipOllamaTunnelConfig = parseShipOllamaTunnelEnv(process.env);
const shipTunnel = {
  cfg: shipTunnelCfg,
  status: (shipTunnelCfg.enabled ? 'starting' : 'off') as TunnelStatus,
  lastError: null as string | null,
  attempts: 0,
  startedAt: null as string | null,
  lastCheckAt: null as string | null,
  proc: null as ChildProcess | null,
  stopping: false,
  restartTimer: null as ReturnType<typeof setTimeout> | null,
};

function getShipTunnelStatus() {
  return {
    enabled: shipTunnel.cfg.enabled,
    status: shipTunnel.status,
    target: shipTunnel.cfg.target,
    shipPort: shipTunnel.cfg.shipPort,
    localUrl: tunnelOllamaUrl(shipTunnel.cfg),
    attempts: shipTunnel.attempts,
    startedAt: shipTunnel.startedAt,
    lastCheckAt: shipTunnel.lastCheckAt,
    error: shipTunnel.lastError,
    description: describeTunnelStatus(shipTunnel.status, shipTunnel.cfg, shipTunnel.lastError),
  };
}

async function probeTunnelOllama(): Promise<boolean> {
  try {
    const res = await fetch(`${tunnelOllamaUrl(shipTunnel.cfg)}/api/version`, { signal: AbortSignal.timeout(6000) });
    return res.ok;
  } catch {
    return false;
  }
}

function scheduleTunnelRestart(): void {
  if (shipTunnel.stopping || shipTunnel.restartTimer) return;
  shipTunnel.attempts += 1;
  const delay = tunnelRestartDelayMs(shipTunnel.attempts);
  shipTunnel.restartTimer = setTimeout(() => {
    shipTunnel.restartTimer = null;
    spawnShipTunnel();
  }, delay);
  shipTunnel.restartTimer.unref?.();
}

function spawnShipTunnel(): void {
  if (shipTunnel.stopping || shipTunnel.proc) return;
  const args = buildSshTunnelArgs(shipTunnel.cfg);
  svlFileLogger.log({ layer: 'GATEWAY', level: 'INFO', category: 'ship_ollama', message: `Zestawiam tunel SSH do Ollamy statku: ssh ${args.join(' ')}` });
  let proc: ChildProcess;
  try {
    proc = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    shipTunnel.status = 'down';
    shipTunnel.lastError = error instanceof Error ? error.message : String(error);
    svlFileLogger.log({ layer: 'GATEWAY', level: 'ERROR', category: 'ship_ollama', message: `Nie udało się uruchomić ssh: ${shipTunnel.lastError}` });
    scheduleTunnelRestart();
    return;
  }
  shipTunnel.proc = proc;
  shipTunnel.status = 'starting';
  let stderr = '';
  proc.stderr?.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-500);
  });
  proc.on('error', (error) => {
    shipTunnel.lastError = /ENOENT/.test(error.message)
      ? 'OpenSSH (ssh) nie jest zainstalowany na hoście gatewaya'
      : error.message;
    shipTunnel.status = 'down';
  });
  proc.on('spawn', () => {
    // ExitOnForwardFailure sprawia, że przy zajętym/niedostępnym porcie ssh szybko się zakończy.
    setTimeout(async () => {
      if (shipTunnel.proc !== proc) return;
      const up = await probeTunnelOllama();
      shipTunnel.lastCheckAt = new Date().toISOString();
      if (up) {
        shipTunnel.status = 'up';
        shipTunnel.attempts = 0;
        shipTunnel.lastError = null;
        shipTunnel.startedAt = shipTunnel.startedAt || new Date().toISOString();
        svlFileLogger.log({ layer: 'GATEWAY', level: 'INFO', category: 'ship_ollama', message: `Ollama ze statku SVL-364 dostępna przez tunel SSH (${tunnelOllamaUrl(shipTunnel.cfg)}).` });
      } else if (shipTunnel.status !== 'down') {
        shipTunnel.status = 'starting';
      }
    }, 3500).unref?.();
  });
  proc.on('exit', (code) => {
    if (shipTunnel.proc === proc) shipTunnel.proc = null;
    if (shipTunnel.stopping) return;
    shipTunnel.status = 'down';
    shipTunnel.lastError = shipTunnel.lastError || (stderr.trim().split('\n').pop() || `ssh zakończył się kodem ${code}`);
    svlFileLogger.log({ layer: 'GATEWAY', level: 'WARN', category: 'ship_ollama', message: `Tunel SSH do Ollamy statku przerwany: ${shipTunnel.lastError}. Ponawiam.` });
    scheduleTunnelRestart();
  });
}

/** Ustawia OLLAMA_HOST na tunel i startuje go (wywołać PRZED startem backendu Pythona). */
function initShipOllamaTunnel(): void {
  if (!shipTunnel.cfg.enabled) return;
  const url = tunnelOllamaUrl(shipTunnel.cfg);
  process.env.OLLAMA_HOST = url; // dziedziczone przez proces Pythona i używane przez cały system
  svlFileLogger.log({ layer: 'GATEWAY', level: 'INFO', category: 'ship_ollama', message: `Standardowa Ollama ustawiona na statek SVL-364 przez SSH: OLLAMA_HOST=${url}, cel ${shipTunnel.cfg.target}.` });
  spawnShipTunnel();
  // Okresowa weryfikacja łącza (co 30 s) — wykrywa cichą utratę tunelu.
  setInterval(async () => {
    if (shipTunnel.stopping || !shipTunnel.proc) return;
    const up = await probeTunnelOllama();
    shipTunnel.lastCheckAt = new Date().toISOString();
    if (up) {
      if (shipTunnel.status !== 'up') { shipTunnel.status = 'up'; shipTunnel.attempts = 0; shipTunnel.lastError = null; }
    } else if (shipTunnel.status === 'up') {
      shipTunnel.status = 'starting';
    }
  }, 30000).unref?.();
}

function stopShipOllamaTunnel(): void {
  shipTunnel.stopping = true;
  if (shipTunnel.restartTimer) clearTimeout(shipTunnel.restartTimer);
  try { shipTunnel.proc?.kill('SIGTERM'); } catch { /* proces mógł już zniknąć */ }
}

async function startServer() {
  // Never start a synthetic Ollama daemon: an unavailable real model must stay offline.
  // Ollama ze statku SVL-364 przez SSH musi ustawić OLLAMA_HOST, zanim wystartuje backend Pythona.
  initShipOllamaTunnel();
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

  // MCP całego systemu SVL (Claude Code / Claude Desktop / inne klienty MCP): Bearer SVL_OPERATOR_TOKEN.
  // Dwa sposoby logowania: nagłówek Bearer <SVL_OPERATOR_TOKEN> (Claude Code / Desktop) albo
  // osobny klucz w adresie /mcp/svl/<SVL_MCP_URL_KEY> (konektor w aplikacji Claude — bez nagłówków).
  app.all(['/mcp/svl', '/mcp/svl/:urlKey'], asyncRoute(async (req, res) => {
    const authorization = req.headers.authorization;
    const bearer = typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice(7).trim()
      : '';
    const urlKeyOk = mcpUrlKeyMatches(String(req.params.urlKey || ''));
    if (!hasOperatorAuthorization(bearer) && !urlKeyOk) {
      res.status(401).json({
        ok: false,
        error: 'SVL MCP wymaga nagłówka Authorization: Bearer <SVL_OPERATOR_TOKEN> albo adresu /mcp/svl/<SVL_MCP_URL_KEY>.',
      });
      return;
    }
    const token = hasOperatorAuthorization(bearer) ? bearer : String(process.env.SVL_OPERATOR_TOKEN || '').trim();
    const svlMcp = createSvlMcpServer({
      baseUrl: `http://127.0.0.1:${PORT}`,
      operatorToken: token,
      logDir: svlFileLogger.logDir,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await svlMcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } finally {
      await transport.close();
      await svlMcp.close();
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
      res.status(401).json({ ok: false, authenticated: false, error: 'Nieprawidłowy token operatora.' });
      return;
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const euid = typeof process.geteuid === 'function' ? process.geteuid() : uid;
    res.json({
      ok: true,
      authenticated: true,
      operator: 'Mateusz Mitek',
      role: 'root',
      autonomyMode: 'ROOT_AUTHORIZED',
      uid,
      euid,
      scopes: FULL_ROOT_SCOPES,
      agentsRoot: ['Bielik', 'Maya Mitek'],
    });
  });

  // Zbiorczy podgląd silników AI i dostępnych modeli (Ollama ze statku SVL-364, Gemini, obraz).
  app.get('/api/ai/engines', asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ ok: false, error: 'Podgląd silników AI wymaga SVL_OPERATOR_TOKEN.' });
      return;
    }
    const corrId: string = (req as any).correlationId || '';
    const healthRes = await callPythonBackend('GET', '/api/py/health?fast=1', undefined, corrId);
    const ollama = healthRes.data?.ollama || {};
    const image = healthRes.data?.image_engine || {};
    const ship = getShipTunnelStatus();

    const gemini = getGeminiClient();
    let geminiModels: string[] = [];
    if (gemini) {
      try {
        geminiModels = await discoverGeminiModels(gemini);
      } catch {
        geminiModels = [];
      }
    }

    const ollamaModels = (Array.isArray(ollama.models) ? ollama.models : []).map((m: any) => ({
      name: String(m?.name || m?.model || ''),
      size: typeof m?.size === 'number' ? m.size : null,
      parameterSize: m?.details?.parameter_size || m?.parameter_size || null,
      vision: Boolean(m?.vision_supported),
    })).filter((m: { name: string }) => m.name);

    res.json({
      ok: true,
      checkedAt: new Date().toISOString(),
      engines: {
        ollama: {
          // Główny lokalny silnik; gdy włączony tunel, to Ollama ze statku SVL-364 przez SSH.
          source: ship.enabled ? 'statek SVL-364 (SSH)' : 'lokalny',
          host: String(ollama.ollama_host || process.env.OLLAMA_HOST || ''),
          reachable: Boolean(ollama.daemon_reachable),
          busy: Boolean(ollama.busy),
          shipTunnel: ship,
          models: ollamaModels,
          loadedModels: Array.isArray(ollama.loaded_models) ? ollama.loaded_models : [],
          visionModels: Array.isArray(ollama.vision_models_available) ? ollama.vision_models_available : [],
          preferredModel: process.env.OLLAMA_PREFERRED_MODEL || 'llama3.2-vision:11b',
          ramAvailableMb: typeof ollama.host_ram_available_mb === 'number' ? ollama.host_ram_available_mb : null,
          diskFreeGb: typeof ollama.host_disk_free_gb === 'number' ? ollama.host_disk_free_gb : null,
          error: ollama.error || null,
        },
        gemini: {
          configured: Boolean(gemini),
          models: geminiModels,
          modelCount: geminiModels.length,
          forcedModel: process.env.GEMINI_MODEL || null,
        },
        image: {
          engine: String(image.engine || process.env.SVL_IMAGE_ENGINE || 'comfyui'),
          available: image.available === undefined ? null : Boolean(image.available),
          detail: image.detail || image.status || null,
        },
      },
    });
  }));

  app.get('/api/ship/ollama', (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ ok: false, error: 'Status Ollamy statku wymaga SVL_OPERATOR_TOKEN.' });
      return;
    }
    res.json({ ok: true, ...getShipTunnelStatus() });
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

  app.get('/api/apex/status', asyncRoute(async (req, res) => {
    const corrId: string = (req as any).correlationId || '';
    const result = await callPythonBackend('GET', '/api/py/apex/status', undefined, corrId);
    res.status(result.status).json(result.data);
  }));

  app.post('/api/apex/control', express.json(), asyncRoute(async (req, res) => {
    const corrId: string = (req as any).correlationId || '';
    const result = await callPythonBackend('POST', '/api/py/apex/control', req.body || {}, corrId);
    if (result.status >= 200 && result.status < 300 && result.data?.ok) {
      void pollAndRelayOutbox();
      broadcastResyncRequired('apex_control', Number(result.data?.serverRevision || 0));
    }
    res.status(result.status).json(result.data);
  }));

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
  const broadcastResyncRequired = (reason = 'global_sync', srvRev?: number, origin?: string) => {
    const rev = Math.max(Number(srvRev || 0), lastRelayedServerRevision);
    const frame = JSON.stringify({
      type: 'svl.resync_required',
      reason,
      serverRevision: rev,
      ...(origin ? { origin } : {}),
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

  // Automatyczna synchronizacja z GitHubem w tle jest domyślnie WYŁĄCZONA (zapobiega automatycznym
  // edycjom plików i checkpointom „Manual edit” w AI Studio). Wymaga jawnego SVL_ALLOW_AUTO_GIT_SYNC=1.
  const githubAutoSyncSec = isAutoGitSyncAllowed(process.env)
    ? Math.max(0, Number(process.env.SVL_GITHUB_AUTOSYNC_SEC || 0) || 0)
    : 0;
  let lastGitHubAutoSync: { at: string; ok: boolean; summary: string } | null = null;
  let githubAutoSyncRunning = false;
  if (githubAutoSyncSec > 0) {
    const minInterval = Math.max(60, githubAutoSyncSec);
    setInterval(async () => {
      if (githubAutoSyncRunning || !getGitHubToken()) return;
      githubAutoSyncRunning = true;
      try {
        const r = await gitSync(__dirname, 'sync', 'SVL: automatyczna synchronizacja z GitHubem');
        const changed = !/pobrano 0, wysłano 0/.test(r.summary);
        lastGitHubAutoSync = { at: new Date().toISOString(), ok: r.ok, summary: r.summary };
        if (!r.ok || changed) {
          void emitFamilyNotification(
            {
              severity: r.ok ? 'INFO' : 'WARN',
              category: 'github',
              title: r.ok ? `GitHub ${GITHUB_REPOSITORY}: zsynchronizowano` : `GitHub ${GITHUB_REPOSITORY}: synchronizacja nieudana`,
              message: r.summary,
              sourceEventId: `gh-autosync-${Date.now()}`,
              origin: 'github-autosync',
            },
          );
          if (r.ok) broadcastResyncRequired('github_autosync');
        }
      } finally {
        githubAutoSyncRunning = false;
      }
    }, minInterval * 1000).unref?.();
  }

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

  // ======================= MISJA CIĄGŁA MAYA MITEK =======================
  // Automatyczne działanie w tle: analiza stanu z prawdziwych pomiarów, bezpieczne samonaprawy,
  // propozycje do potwierdzenia Operatora. Panel pokazuje, co Maya zrobiła, jej logi i co robi teraz.
  type MayaMissionLogEntry = { at: string; level: 'INFO' | 'WARN' | 'ERROR'; message: string };
  type MayaMissionRun = {
    at: string;
    trigger: string;
    severity: MissionSeverity;
    headline: string;
    findings: MissionFinding[];
    actionsTaken: Array<{ title: string; ok: boolean; detail: string }>;
    proposals: MissionProposal[];
    notified: boolean;
    durationMs: number;
  };
  const MAYA_STATE_FILE = process.env.SVL_MAYA_STATE_FILE || path.join(os.tmpdir(), 'svl-maya-mission.json');
  const mayaMission = {
    enabled: !['0', 'false', 'no', 'off'].includes(String(process.env.SVL_MAYA_AUTONOMY ?? '1').trim().toLowerCase()),
    intervalSec: Math.max(120, Number(process.env.SVL_MAYA_AUTONOMY_INTERVAL_SEC || 900)),
    status: 'idle' as 'idle' | 'running',
    currentActivity: 'Oczekiwanie na kolejny cykl misji.',
    startedAt: new Date().toISOString(),
    lastRunAt: null as string | null,
    nextRunAt: null as string | null,
    lastSignature: '',
    runs: [] as MayaMissionRun[],
    log: [] as MayaMissionLogEntry[],
    missionStatement:
      'Ciągła poprawa, naprawa, ulepszanie i rozwój systemu SVL oraz przygotowywanie wdrożeń nowych funkcji — ' +
      'na podstawie prawdziwych pomiarów; operacje nieodwracalne czekają na potwierdzenie Operatora.',
  };
  let mayaRunning = false;
  // Karencja per rodzaj samonaprawy — niektóre warunki (np. brak zapisu skanu AV w stanie)
  // nie znikają po akcji, więc bez karencji misja powtarzałaby je w kółko.
  const MAYA_ACTION_COOLDOWN_MS: Record<string, number> = {
    antivirus_scan: Number(process.env.SVL_MAYA_AV_COOLDOWN_SEC || 21600) * 1000,
    reconnect_agents: 10 * 60_000,
    warm_ollama: 10 * 60_000,
    generate_report: 60 * 60_000,
  };
  const mayaActionLastRun: Record<string, number> = {};

  const mayaLog = (level: MayaMissionLogEntry['level'], message: string) => {
    const entry: MayaMissionLogEntry = { at: new Date().toISOString(), level, message };
    mayaMission.log.push(entry);
    if (mayaMission.log.length > 200) mayaMission.log.splice(0, mayaMission.log.length - 200);
    svlFileLogger.log({ layer: 'GATEWAY', level, category: 'maya_mission', message });
  };
  const mayaSetActivity = (text: string) => {
    mayaMission.currentActivity = text;
    mayaLog('INFO', text);
  };
  const persistMayaState = () => {
    try {
      fsSync.writeFileSync(
        MAYA_STATE_FILE,
        JSON.stringify(
          { enabled: mayaMission.enabled, lastSignature: mayaMission.lastSignature, runs: mayaMission.runs.slice(0, 30), log: mayaMission.log.slice(-120) },
          null,
          2,
        ),
      );
    } catch {
      // zapis pomocniczy — błąd nie może przerwać misji
    }
  };
  try {
    const saved = JSON.parse(fsSync.readFileSync(MAYA_STATE_FILE, 'utf8'));
    if (Array.isArray(saved?.runs)) mayaMission.runs = saved.runs;
    if (Array.isArray(saved?.log)) mayaMission.log = saved.log;
    if (typeof saved?.lastSignature === 'string') mayaMission.lastSignature = saved.lastSignature;
    if (typeof saved?.enabled === 'boolean' && process.env.SVL_MAYA_AUTONOMY === undefined) mayaMission.enabled = saved.enabled;
  } catch {
    // brak zapisanego stanu — start od zera
  }

  /** Wykonuje bezpieczną (odwracalną) samonaprawę zaplanowaną przez misję. */
  const runMayaSafeAction = async (
    action: MissionSafeAction,
    corrId: string,
  ): Promise<{ title: string; ok: boolean; detail: string }> => {
    try {
      if (action.kind === 'reconnect_agents') {
        const r = await callPythonBackend('POST', '/api/py/agents/connect', { triggered_by: 'maya-mission' }, corrId);
        void pollAndRelayOutbox();
        const ok = r.status === 200 && Boolean(r.data?.ok);
        const names = (r.data?.connection_report?.agents || []).map((a: any) => `${a.display_name}(PID ${a.pid})`).join(', ');
        return { title: action.title, ok, detail: ok ? `Podłączono: ${names || 'OK'}` : 'Nie udało się podłączyć workerów' };
      }
      if (action.kind === 'antivirus_scan') {
        const r = await callPythonBackend('POST', '/api/py/security/antivirus/scan', {}, corrId);
        const ok = r.status === 200 && Boolean(r.data?.ok);
        return {
          title: action.title,
          ok,
          detail: ok ? `Przeskanowano plików: ${Number(r.data?.filesScanned || 0)}, zagrożenia: ${Number(r.data?.threatsFoundAndPurged || 0)}` : 'Skan nie powiódł się',
        };
      }
      if (action.kind === 'warm_ollama') {
        await warmConfiguredOllamaModels();
        return { title: action.title, ok: true, detail: 'Zlecono załadowanie modeli do pamięci.' };
      }
      return { title: action.title, ok: false, detail: 'Nieznana akcja.' };
    } catch (error) {
      return { title: action.title, ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  };

  /** Jeden cykl misji: pomiar → plan → samonaprawy → raport na kanale „wszyscy”. */
  const runMayaMission = async (trigger: string): Promise<MayaMissionRun | null> => {
    if (mayaRunning) return null;
    mayaRunning = true;
    mayaMission.status = 'running';
    const corrId = `maya-${Date.now().toString(36)}`;
    const startedAt = Date.now();
    try {
      mayaSetActivity('Zbieram pomiary systemu (health, Apex, agenci, logi).');
      const [healthRes, apexRes, agentsRes] = await Promise.all([
        callPythonBackend('GET', '/api/py/health?fast=1', undefined, corrId),
        callPythonBackend('GET', '/api/py/apex/status', undefined, corrId),
        callPythonBackend('GET', '/api/py/agents/status', undefined, corrId),
      ]);
      const recentIssues = await svlFileLogger.getRecentIssues(50);
      const ollama = healthRes.data?.ollama || {};
      const apex = apexRes.data || {};
      const input: MissionInput = {
        ollamaReachable: Boolean(ollama.daemon_reachable),
        geminiConfigured: Boolean(getGeminiClient()),
        diskFreeGb: typeof ollama.host_disk_free_gb === 'number' ? ollama.host_disk_free_gb : null,
        ramAvailableMb: typeof ollama.host_ram_available_mb === 'number' ? ollama.host_ram_available_mb : null,
        modules: Array.isArray(healthRes.data?.system_modules) ? healthRes.data.system_modules : [],
        agents: Array.isArray(agentsRes.data?.agents) ? agentsRes.data.agents : [],
        apex: {
          serviceStatus: apex.service_status,
          sentinelAvStatus: apex.sentinel_av_status,
          lastAvScanAt: apex.last_av_scan_at || null,
          distro: apex.distro,
        },
        recentIssues,
        github: {
          tokenPresent: Boolean(getGitHubToken()),
          lastSyncOk: lastGitHubAutoSync ? lastGitHubAutoSync.ok : null,
          lastSyncSummary: lastGitHubAutoSync ? lastGitHubAutoSync.summary : null,
        },
        shipOllama: shipTunnel.cfg.enabled
          ? { enabled: true, status: getShipTunnelStatus().status, description: getShipTunnelStatus().description }
          : undefined,
      };
      mayaSetActivity('Analizuję stan i planuję działania.');
      const plan = buildMayaMissionPlan(input);

      const actionsTaken: Array<{ title: string; ok: boolean; detail: string }> = [];
      for (const action of plan.safeActions) {
        const cooldownMs = MAYA_ACTION_COOLDOWN_MS[action.kind] ?? 10 * 60_000;
        const last = mayaActionLastRun[action.kind] || 0;
        if (Date.now() - last < cooldownMs) {
          mayaLog('INFO', `Pomijam „${action.title}” — wykonana niedawno (karencja ${Math.round(cooldownMs / 60000)} min).`);
          continue;
        }
        mayaSetActivity(`Samonaprawa: ${action.title}.`);
        const result = await runMayaSafeAction(action, corrId);
        if (result.ok) mayaActionLastRun[action.kind] = Date.now();
        actionsTaken.push(result);
        mayaLog(result.ok ? 'INFO' : 'WARN', `${result.title}: ${result.detail}`);
      }

      // Powiadomienie na kanale „wszyscy” tylko, gdy stan się zmienił albo coś naprawiono (bez spamu).
      const changed = plan.signature !== mayaMission.lastSignature || actionsTaken.length > 0;
      let notified = false;
      if (changed) {
        mayaSetActivity('Publikuję raport misji na kanale „Rodzina Mitek (wszyscy)”.');
        const actionsBlock = actionsTaken.length
          ? '\n\n**Wykonane samonaprawy:**\n' + actionsTaken.map((a) => `- ${a.ok ? '✅' : '❌'} ${a.title} — ${a.detail}`).join('\n')
          : '';
        await emitFamilyNotification(
          {
            severity: plan.severity === 'OK' || plan.severity === 'INFO' ? 'INFO' : plan.severity,
            category: 'maya_mission',
            title: `Misja Maya Mitek: ${plan.headline}`,
            message: plan.reportMarkdown + actionsBlock,
            sourceEventId: `maya-mission-${plan.signature}-${Math.floor(Date.now() / 60000)}`,
            origin: 'maya-mission',
          },
          corrId,
        );
        notified = true;
        mayaMission.lastSignature = plan.signature;
      }

      const run: MayaMissionRun = {
        at: new Date().toISOString(),
        trigger,
        severity: plan.severity,
        headline: plan.headline,
        findings: plan.findings,
        actionsTaken,
        proposals: plan.proposals,
        notified,
        durationMs: Date.now() - startedAt,
      };
      mayaMission.runs.unshift(run);
      if (mayaMission.runs.length > 50) mayaMission.runs.length = 50;
      mayaMission.lastRunAt = run.at;
      mayaLog('INFO', `Cykl zakończony (${trigger}): ${plan.headline} · ustaleń ${plan.findings.length}, samonapraw ${actionsTaken.length}.`);
      persistMayaState();
      return run;
    } catch (error) {
      mayaLog('ERROR', `Błąd cyklu misji: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    } finally {
      mayaRunning = false;
      mayaMission.status = 'idle';
      mayaMission.nextRunAt = mayaMission.enabled ? new Date(Date.now() + mayaMission.intervalSec * 1000).toISOString() : null;
      mayaSetActivity(mayaMission.enabled ? 'Nadzór aktywny — czekam na kolejny cykl misji.' : 'Misja wstrzymana przez Operatora.');
    }
  };

  // Podgląd misji: stan, co robi teraz, historia działań i logi.
  app.get('/api/maya/mission', (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ ok: false, error: 'Podgląd misji Maya Mitek wymaga SVL_OPERATOR_TOKEN.' });
      return;
    }
    res.json({
      ok: true,
      enabled: mayaMission.enabled,
      status: mayaMission.status,
      currentActivity: mayaMission.currentActivity,
      missionStatement: mayaMission.missionStatement,
      intervalSec: mayaMission.intervalSec,
      startedAt: mayaMission.startedAt,
      lastRunAt: mayaMission.lastRunAt,
      nextRunAt: mayaMission.nextRunAt,
      runs: mayaMission.runs.slice(0, 30),
      log: mayaMission.log.slice(-120).reverse(),
    });
  });

  app.post('/api/maya/mission/run', asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ ok: false, error: 'Uruchomienie misji wymaga SVL_OPERATOR_TOKEN.' });
      return;
    }
    if (mayaRunning) {
      res.status(409).json({ ok: false, error: 'Misja właśnie trwa — poczekaj na zakończenie cyklu.' });
      return;
    }
    const run = await runMayaMission('operator_manual');
    res.json({ ok: Boolean(run), run });
  }));

  app.post('/api/maya/mission/toggle', express.json({ limit: '8kb' }), (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ ok: false, error: 'Zmiana trybu misji wymaga SVL_OPERATOR_TOKEN.' });
      return;
    }
    mayaMission.enabled = Boolean(req.body?.enabled);
    mayaLog('INFO', mayaMission.enabled ? 'Operator włączył automatyczną misję Maya Mitek.' : 'Operator wstrzymał automatyczną misję Maya Mitek.');
    mayaMission.nextRunAt = mayaMission.enabled ? new Date(Date.now() + mayaMission.intervalSec * 1000).toISOString() : null;
    persistMayaState();
    res.json({ ok: true, enabled: mayaMission.enabled });
  });

  // Pętla misji w tle: pierwszy cykl 20 s po starcie, potem co `intervalSec`.
  setTimeout(() => {
    if (mayaMission.enabled && Boolean(process.env.SVL_OPERATOR_TOKEN)) void runMayaMission('startup');
  }, 20000).unref?.();
  setInterval(() => {
    if (mayaMission.enabled && !mayaRunning && Boolean(process.env.SVL_OPERATOR_TOKEN)) void runMayaMission('scheduled');
  }, Math.max(120, mayaMission.intervalSec) * 1000).unref?.();


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
      github: `gh(${GITHUB_REPOSITORY})$`,
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
    if (terminalType === 'github') {
      // Terminal GitHub CLI: `gh …` albo skróty synchronizacji (status/pobierz/wyślij/synchronizuj/init).
      const syncVerb: Record<string, GitSyncAction> = {
        status: 'status', pobierz: 'pull', pull: 'pull', 'wyślij': 'push', wyslij: 'push', push: 'push',
        synchronizuj: 'sync', sync: 'sync', init: 'init',
      };
      const lowerCmd = effectiveCmd.toLowerCase();
      if (syncVerb[lowerCmd]) {
        const r = await gitSync(__dirname, syncVerb[lowerCmd], 'SVL: synchronizacja z terminala GitHub');
        if (r.ok && r.action !== 'status') void pollAndRelayOutbox();
        await respondAndPersist({
          ok: r.ok, terminalType, command: trimmed,
          stdout: r.ok ? `${r.summary}${r.action !== 'status' && r.status?.isRepo ? `\n${describeStatus(r.status)}` : ''}` : '',
          stderr: r.ok ? '' : r.summary,
        });
        return;
      }
      const ghArgs = splitArgs(effectiveCmd.replace(/^\s*gh\s+/i, ''));
      const verdict = assessGhCommand(ghArgs);
      if (!verdict.allowed) {
        await respondAndPersist({ ok: false, terminalType, command: trimmed, stdout: '', stderr: verdict.reason });
        return;
      }
      const r = await runGhCommand(__dirname, ghArgs);
      await respondAndPersist({
        ok: r.ok, terminalType, command: trimmed,
        stdout: r.ok ? r.output : '', stderr: r.ok ? '' : r.output,
      });
      return;
    }
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

  // GitHub (Rush47/SVL_Core): stan tokenu i synchronizacji, akcje synchronizacji, GitHub CLI.
  app.get('/api/github/status', asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ ok: false, error: 'Wymagana autoryzacja SVL_OPERATOR_TOKEN.' });
      return;
    }
    const hasLocalGit = fsSync.existsSync(path.join(__dirname, '.git'));
    const [token, sync] = await Promise.all([
      verifyGitHubToken(),
      hasLocalGit
        ? gitSyncStatus(__dirname, String(req.query.fetch || '0') === '1')
        : Promise.resolve({
            initialized: false,
            branch: syncBranch(),
            head: '',
            remoteHead: '',
            ahead: 0,
            behind: 0,
            dirty: 0,
            changedFiles: [],
            summary: 'Lokalne .git nie jest zainicjalizowane (tryb bezpieczny AI Studio — brak automatycznych modyfikacji).',
          }),
    ]);
    res.json({
      ok: true,
      repository: GITHUB_REPOSITORY,
      branch: syncBranch(),
      token,
      sync,
      ghCli: ghCliAvailable() ? 'gh' : 'rest',
      autoSyncSec: githubAutoSyncSec,
      lastAutoSync: lastGitHubAutoSync,
    });
  }));

  app.post('/api/github/sync', asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ ok: false, error: 'Wymagana autoryzacja SVL_OPERATOR_TOKEN.' });
      return;
    }
    const action = String(req.body?.action || 'status') as GitSyncAction;
    if (!['status', 'pull', 'push', 'sync', 'init'].includes(action)) {
      res.status(400).json({ ok: false, error: 'action: status | pull | push | sync | init' });
      return;
    }
    const r = await gitSync(__dirname, action, String(req.body?.message || 'SVL: synchronizacja z panelu GitHub'));
    if (r.ok && action !== 'status') {
      void pollAndRelayOutbox();
      broadcastResyncRequired('github_sync');
    }
    res.json({ ...r, ok: r.ok, error: r.ok ? undefined : r.summary });
  }));

  app.post('/api/github/cli', asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ ok: false, error: 'Wymagana autoryzacja SVL_OPERATOR_TOKEN.' });
      return;
    }
    const ghArgs = splitArgs(String(req.body?.args || '').replace(/^\s*gh\s+/i, ''));
    const verdict = assessGhCommand(ghArgs);
    if (!verdict.allowed) {
      res.status(400).json({ ok: false, error: verdict.reason });
      return;
    }
    const r = await runGhCommand(__dirname, ghArgs);
    res.json({ ok: r.ok, output: r.output, engine: r.engine, ...(r.ok ? {} : { error: r.output.slice(0, 300) }) });
  }));

  // Dane konektora MCP dla aplikacji Claude (tylko dla operatora; klucz nie trafia do logów).
  app.get('/api/mcp/connector', (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ ok: false, error: 'Wymagana autoryzacja SVL_OPERATOR_TOKEN.' });
      return;
    }
    const key = String(process.env.SVL_MCP_URL_KEY || '').trim();
    res.json({
      ok: true,
      urlKeyPath: key.length >= 32 ? `/mcp/svl/${key}` : null,
      bearerPath: '/mcp/svl',
      tools: 12,
    });
  });

  app.post('/api/system/global-sync', asyncRoute(async (req, res) => {
    if (!hasOperatorAuthorization(req.headers['x-svl-operator-token'])) {
      res.status(401).json({ ok: false, error: 'Wymagana autoryzacja SVL_OPERATOR_TOKEN.' });
      return;
    }
    const corrId: string = (req as any).correlationId || '';
    const reqOrigin = typeof req.body?.origin === 'string' ? req.body.origin.trim() : '';
    cachedChatContextMeta = null;
    clearOllamaReadyCache();

    const hasLocalGit = fsSync.existsSync(path.join(__dirname, '.git'));
    const [healthRes, agentsRes, modsRes, kernelRes, chatRes, apexRes, ghSync] = await Promise.all([
      callPythonBackend('GET', '/api/py/health?fast=1', undefined, corrId),
      callPythonBackend('GET', '/api/py/agents/status', undefined, corrId),
      callPythonBackend('GET', '/api/py/modules', undefined, corrId),
      callPythonBackend('GET', '/api/py/kernel/report', undefined, corrId),
      callPythonBackend('GET', '/api/py/chat/conversations', undefined, corrId),
      callPythonBackend('GET', '/api/py/apex/status', undefined, corrId),
      hasLocalGit && getGitHubToken() && Boolean(req.body?.fetchGitHub)
        ? gitSyncStatus(__dirname, true).catch(() => null)
        : Promise.resolve(null),
    ]);
    await pollAndRelayOutbox();
    const srvRev = Math.max(
      Number(healthRes.data?.serverRevision || 0),
      Number(agentsRes.data?.serverRevision || 0),
      Number(modsRes.data?.serverRevision || 0),
      Number(kernelRes.data?.serverRevision || 0),
      Number(chatRes.data?.serverRevision || 0),
    );
    const conversations = Array.isArray(chatRes.data?.conversations) ? chatRes.data.conversations : [];
    const totalMessages = conversations.reduce(
      (sum: number, c: any) => sum + (Array.isArray(c?.messages) ? c.messages.length : 0),
      0,
    );
    const agentsList = Array.isArray(agentsRes.data?.agents) ? agentsRes.data.agents : [];
    const totalMemories = agentsList.reduce(
      (sum: number, a: any) => sum + Number(a?.memory_entries_count || 0),
      0,
    );
    broadcastResyncRequired(String(req.body?.reason || 'operator_global_sync'), srvRev, reqOrigin || undefined);
    res.json({
      ok: true,
      serverRevision: srvRev,
      modulesCount: Array.isArray(modsRes.data?.modules) ? modsRes.data.modules.length : 0,
      conversationsCount: conversations.length,
      messagesCount: totalMessages,
      agentMemoriesCount: totalMemories,
      apexActive: Boolean(apexRes.data?.active),
      autoGitSyncDisabled: githubAutoSyncSec === 0,
      github: ghSync ? { repository: GITHUB_REPOSITORY, branch: syncBranch(), head: ghSync.head, remoteHead: ghSync.remoteHead, ahead: ghSync.ahead, behind: ghSync.behind } : null,
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
    if (cachedChatContextMeta && Date.now() - cachedChatContextMeta.at < 15000) {
      return cachedChatContextMeta;
    }
    const [healthRes, agentsRes] = await Promise.all([
      callPythonBackend('GET', '/api/py/health?fast=1', undefined, corrId),
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
    const chatStartedAt = Date.now();
    // Przyciski potwierdzeń operacji GitHub zleconych przez AI (dopisywane pod odpowiedzią).
    const githubConfirmationButtons: string[] = [];
    (res as any).json = (body: any) => {
      // Każda odpowiedź czatu trafia do logi/: agent, model, pochodzenie treści, czas, błąd.
      const failed = !body || body.ok !== true || body.provenance === 'error';
      svlFileLogger.log({
        layer: 'GATEWAY',
        level: failed ? 'WARN' : 'INFO',
        category: 'ai_chat',
        correlationId: corrId,
        origin: String(origin || 'client'),
        message:
          `${String(body?.sender || targetAgent || '?')} · kanał ${replyConversationId || '-'} · ` +
          `model: ${String(body?.modelUsed || '-')} · ${failed ? 'BRAK ODPOWIEDZI MODELU' : 'odpowiedź OK'} ` +
          `(${Date.now() - chatStartedAt} ms, HTTP ${res.statusCode})`,
        details: failed
          ? { error: body?.error || null, provenance: body?.provenance || null, reasons: body?.failureReasons || null }
          : { provenance: body?.provenance || null, replyChars: String(body?.reply || '').length },
      });
      if (body && typeof body === 'object') delete body.failureReasons;
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
      // Odpowiedź modelu twierdząca, że coś wykonano, bez żadnej operacji serwera → wyraźny baner + notatka weryfikacji.
      if (body.provenance === 'model_unverified' && !body.verificationNote) {
        const verifiedActions = Array.isArray(body.appliedActions) ? body.appliedActions.filter((a: any) => a?.ok).length : 0;
        const guarded = enforceFactualExecutionGuard(body.reply, verifiedActions);
        body.reply = guarded.reply;
        if (guarded.verificationNote) body.verificationNote = guarded.verificationNote;
      }
      if (githubConfirmationButtons.length > 0) {
        body.reply = `${body.reply}\n\n**Wymaga Twojego potwierdzenia (GitHub ${GITHUB_REPOSITORY}):**\n${githubConfirmationButtons.join('\n')}`;
      }
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
    // Narzędzia GitHub (Rush47/SVL_Core) dołączamy tylko wtedy, gdy wiadomość dotyczy GitHuba / repozytorium / plików,
    // żeby zwykłe wiadomości czatu nie wysyłały 5 dużych schematów narzędzi i odpowiadały wielokrotnie szybciej.
    const requestsGitHubTools = shouldEnableGitHubToolsForMessage(cleanMsg, Boolean(getGitHubToken()));
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

    // Bezpośrednia obsługa przycisków czatu dla odbezpieczenia widoczności plików GUI/SVL_CoreOS_2, logów instalacji, Debootstrap Debian 13 oraz procedury Hot-Swap
    const wantsUnlockRepoFiles =
      /\b(?:odbezpiecz\s+pliki|odbezpiecz\s+podgląd|pokaż\s+pliki\s+w\s+repozytorium|pokaż\s+wszystkie\s+pliki\s+svl_coreos_2|lista\s+plików\s+svl_coreos_2)(?=[\s.,!?]|$)/i.test(cleanMsg);
    const wantsHotSwapApex =
      /\b(?:inicjuj\s+atomową\s+podmianę|wykonaj\s+hot-?swap|uruchom\s+hot-?swap|finalizuj\s+hot-?swap)(?=[\s.,!?]|$)/i.test(cleanMsg);
    const wantsInstallLogs =
      /\b(?:pokaż\s+logi\s+instalacji\s+svl\s+coreos\s*2|logi\s+instalacyjne\s+svl_coreos_2|pokaż\s+install\.log)(?=[\s.,!?]|$)/i.test(cleanMsg);
    const wantsDebootstrapExpand =
      /\b(?:rozbuduj\s+skrypt\s+instalacyjny\s+o\s+pełny\s+debootstrap|pełny\s+debootstrap\s+debian\s*13)(?=[\s.,!?]|$)/i.test(cleanMsg);

    if (wantsUnlockRepoFiles || wantsHotSwapApex || wantsInstallLogs || wantsDebootstrapExpand) {
      const coreOsDir = path.join(__dirname, 'SVL_CoreOS_2');
      const collectedFiles: Array<{ relPath: string; size: number }> = [];
      const walkCoreOs = (dir: string) => {
        if (!fsSync.existsSync(dir)) return;
        for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith('.') && entry.name !== '.gitkeep') continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walkCoreOs(full);
          } else if (entry.isFile()) {
            collectedFiles.push({
              relPath: path.relative(__dirname, full).split(path.sep).join('/'),
              size: fsSync.statSync(full).size,
            });
          }
        }
      };
      walkCoreOs(coreOsDir);
      collectedFiles.sort((a, b) => a.relPath.localeCompare(b.relPath));

      // Odpowiedzi WYŁĄCZNIE o stanie faktycznym: lista plików z dysku, prawdziwy log instalatora.
      // Bez samoczynnego commita/pusha i bez ogłaszania operacji, których serwer nie wykonał.
      const coreOsReply = (text: string, tool: string, ok: boolean) =>
        res.json({
          ok: true,
          sender: 'Maya Mitek',
          agentId: 'Maya',
          modelUsed: 'Maya Mitek · SVL CoreOS 2 (wynik serwera)',
          reply: text,
          provenance: ok ? 'server_verified' : 'error',
          followUpMessages: [],
          appliedActions: [{ tool, entity: 'file', entityId: 'SVL_CoreOS_2', summary: text.split('\n')[0].replace(/^#+\s*/, '').slice(0, 200), ok }],
        });
      const fileLines = collectedFiles.map((f) => `- \`${f.relPath}\` *(${f.size} B)*`).join('\n');
      const installLogFile = process.env.SVL_LOG_FILE || '/var/log/svl-coreos2-install.log';

      if (wantsInstallLogs) {
        const logText = fsSync.existsSync(installLogFile)
          ? fsSync.readFileSync(installLogFile, 'utf8').trim().split('\n').slice(-200).join('\n')
          : '';
        return void coreOsReply(
          logText
            ? `### 📄 Log instalatora SVL CoreOS 2 (\`${installLogFile}\`)\n\n\`\`\`log\n${logText.slice(-12000)}\n\`\`\``
            : `### 📄 Brak logu instalacji\n\nInstalator SVL CoreOS 2 nie był uruchamiany na tym hoście (brak \`${installLogFile}\`). ` +
              'Log powstanie po uruchomieniu `SVL_CoreOS_2/debian13/install_coreos2_svl364.sh` na Debianie 13.',
          'svl_coreos2_install_logs',
          Boolean(logText),
        );
      }
      if (wantsHotSwapApex) {
        return void coreOsReply(
          '### ⛔ Podmiana systemu (hot-swap) NIE została wykonana\n\n' +
            'SVL nie ma mechanizmu podmiany działającego systemu operacyjnego — wcześniejsze komunikaty „AKTYWNA (100%)” ' +
            'były wpisane na sztywno i nic nie wykonywały. Instalacja SVL CoreOS 2 to uruchomienie instalatora na hoście ' +
            'z Debianem 13 (jako root):\n\n```bash\nsudo bash SVL_CoreOS_2/debian13/install_coreos2_svl364.sh\n```\n\n' +
            'Postęp i wynik zobaczysz w logu instalatora. [btn: 📄 Log instalacji|send:Pokaż logi instalacji SVL CoreOS 2] [btn: 🐧 Terminal Linux|tab:terminals]',
          'svl_coreos2_hot_swap',
          false,
        );
      }
      if (wantsDebootstrapExpand) {
        const debFiles = collectedFiles.filter((f) => f.relPath.includes('/debian13/'));
        return void coreOsReply(
          `### 🐧 Skrypty Debian 13 w repozytorium (${debFiles.length})\n\n` +
            `${debFiles.map((f) => `- \`${f.relPath}\` *(${f.size} B)*`).join('\n') || '(brak)'}\n\n` +
            'To pliki w repozytorium — debootstrap **nie był uruchamiany** przez serwer. ' +
            'Zbudowanie systemu wymaga uruchomienia skryptu jako root na Debianie 13.',
          'svl_coreos2_debootstrap',
          true,
        );
      }
      return void coreOsReply(
        `### 📂 Pliki \`SVL_CoreOS_2/\` na serwerze (${collectedFiles.length})\n\n${fileLines || '(brak)'}\n\n` +
          'To pliki w katalogu projektu (nic nie jest uruchamiane ani wysyłane przez to polecenie). ' +
          'Wysłanie na GitHub: [btn: ⬆️ Synchronizuj z GitHub|send:/github synchronizuj] [btn: 📋 Stan GitHub|send:/github status]',
        'svl_coreos2_files',
        true,
      );
    }

    // Polecenia GitHub wykonywane przez serwer (bez modelu): /gh <polecenie>, /github <akcja> (obsługuje też łańcuchy &&).
    const githubSlash = /^\/(gh|github)(?:\s+([\s\S]*))?$/i.exec(cleanMsg);
    if (githubSlash) {
      const ghRoute = resolveChatTargetAgent({
        message: cleanMsg,
        conversationId: String(conversationId || ''),
        targetAgent: String(targetAgent || ''),
      });
      const ghAgent = ghRoute.explicit ? ghRoute.agent : 'Maya';
      const ghSender = formatAgentDisplayName(ghAgent);
      const replyGitHub = (ok: boolean, text: string) =>
        res.json({
          ok: true,
          sender: ghSender,
          agentId: ghAgent,
          modelUsed: `${ghSender} · GitHub ${GITHUB_REPOSITORY} (wynik serwera)`,
          reply: text,
          provenance: ok ? 'server_verified' : 'error',
          followUpMessages: [],
          appliedActions: [],
        });

      const resolveSafeRepoRelPath = (rawRel: string): { ok: boolean; relPath: string; absPath: string; isDirHint: boolean; error?: string } => {
        const trimmed = String(rawRel || '').trim().replace(/^['"]+|['"]+$/g, '');
        const isDirHint = trimmed.endsWith('/');
        const cleanRel = trimmed.replace(/^\/+|\/+$/g, '');
        if (!cleanRel || cleanRel.includes('\\') || cleanRel.split('/').some((p) => !p || p === '.' || p === '..' || p === '.git')) {
          return { ok: false, relPath: cleanRel, absPath: '', isDirHint, error: 'Nieprawidłowa ścieżka względna w repozytorium.' };
        }
        const absPath = path.resolve(__dirname, cleanRel);
        if (!absPath.startsWith(__dirname + path.sep)) {
          return { ok: false, relPath: cleanRel, absPath: '', isDirHint, error: 'Ścieżka wykracza poza katalog repozytorium.' };
        }
        return { ok: true, relPath: cleanRel, absPath, isDirHint };
      };

      const runSingleGitHubSubcommand = async (subCmd: string): Promise<{ ok: boolean; text: string }> => {
        const parsedSub = /^\/?(gh|github)(?:\s+([\s\S]*))?$/i.exec(subCmd.trim());
        const toolKind = parsedSub ? parsedSub[1].toLowerCase() : 'github';
        const rest = String(parsedSub ? parsedSub[2] || '' : subCmd).trim();

        if (toolKind === 'gh') {
          const ghArgs = splitArgs(rest);
          const verdict = assessGhCommand(ghArgs);
          if (!verdict.allowed) return { ok: false, text: `⛔ ${verdict.reason}` };
          const r = await runGhCommand(__dirname, ghArgs);
          return {
            ok: r.ok,
            text: `**\`gh ${rest}\`** (${r.engine === 'gh' ? 'GitHub CLI' : 'REST API'})\n\n\`\`\`\n${r.output.slice(0, 7000)}\n\`\`\``,
          };
        }

        const tokens = rest.split(/\s+/).filter(Boolean);
        const verb = (tokens[0] || 'status').toLowerCase();
        const arg = tokens[1] || '';
        const tailContent = tokens.slice(2).join(' ').trim();

        const verbMap: Record<string, GitSyncAction> = {
          status: 'status', stan: 'status', '': 'status',
          pobierz: 'pull', pull: 'pull',
          wyślij: 'push', wyslij: 'push', push: 'push',
          synchronizuj: 'sync', sync: 'sync',
          init: 'init', połącz: 'init', polacz: 'init',
        };

        if (verb === 'potwierdź' || verb === 'potwierdz' || verb === 'confirm') {
          const entry = takeConfirmation(arg || '');
          if (!entry) return { ok: false, text: `Nie ma oczekującej operacji o identyfikatorze \`${arg || '?'}\` (mogła wygasnąć po 15 min).` };
          const r = await executeOp(__dirname, entry.op);
          svlFileLogger.log({
            layer: 'GATEWAY', level: r.ok ? 'WARN' : 'ERROR', category: 'github',
            correlationId: corrId, message: `Operator potwierdził [${arg}]: ${describeOp(entry.op)} (${entry.reason}) → ${r.ok ? 'OK' : 'błąd'}`,
          });
          return {
            ok: r.ok,
            text: `${r.ok ? '✅' : '❌'} **${entry.reason}** — \`${describeOp(entry.op)}\`\n\n\`\`\`\n${r.output.slice(0, 5000)}\n\`\`\``,
          };
        }

        if (verb === 'anuluj' || verb === 'cancel') {
          return {
            ok: true,
            text: cancelConfirmation(arg || '') ? `Anulowano operację \`${arg}\`.` : `Brak oczekującej operacji \`${arg || '?'}\`.`,
          };
        }

        if (['dodaj', 'add', 'utwórz', 'utworz', 'stwórz', 'stworz', 'mkdir'].includes(verb)) {
          if (!arg) {
            return { ok: false, text: 'Podaj ścieżkę pliku lub katalogu, np. `/github dodaj SVL_CoreOS_2/README.md`.' };
          }
          const resolved = resolveSafeRepoRelPath(arg);
          if (!resolved.ok) return { ok: false, text: `⛔ ${resolved.error}` };
          try {
            const existsNow = fsSync.existsSync(resolved.absPath);
            const isDir =
              verb === 'mkdir' ||
              resolved.isDirHint ||
              (existsNow && fsSync.statSync(resolved.absPath).isDirectory()) ||
              (!existsNow && !path.basename(resolved.relPath).includes('.'));
            let targetFileRel = resolved.relPath;
            if (isDir) {
              fsSync.mkdirSync(resolved.absPath, { recursive: true });
              const entries = fsSync.readdirSync(resolved.absPath);
              if (entries.length === 0) {
                const keepPath = path.join(resolved.absPath, 'README.md');
                fsSync.writeFileSync(
                  keepPath,
                  `# ${path.basename(resolved.relPath)}\n\nKatalog utworzony i zsynchronizowany przez SVL CoreOS 2 (Maya Mitek · SVL-364).\n`,
                  'utf8',
                );
                targetFileRel = `${resolved.relPath}/README.md`;
              }
            } else {
              fsSync.mkdirSync(path.dirname(resolved.absPath), { recursive: true });
              if (!existsNow || tailContent) {
                const defaultBody =
                  tailContent ||
                  (resolved.relPath.endsWith('.log')
                    ? `[${new Date().toISOString()}] [SVL-COREOS-2] Inicjalizacja pliku ${resolved.relPath} (Maya Mitek · SVL-364)\n`
                    : `# ${path.basename(resolved.relPath)}\n\nUtworzono przez SVL CoreOS 2 (${new Date().toISOString()}).\n`);
                fsSync.writeFileSync(resolved.absPath, defaultBody, 'utf8');
              }
            }
            const syncRes = await gitSync(__dirname, 'sync', `SVL: dodano ${targetFileRel} z czatu`);
            void pollAndRelayOutbox();
            broadcastResyncRequired('github_chat_add');
            return {
              ok: syncRes.ok,
              text: `${syncRes.ok ? '✅' : '⚠️'} Przygotowano \`${resolved.relPath}\` i zsynchronizowano z \`${GITHUB_REPOSITORY}@${syncBranch()}\`:\n${syncRes.summary}`,
            };
          } catch (e: any) {
            return { ok: false, text: `❌ Błąd przygotowania \`${resolved.relPath}\`: ${e?.message || e}` };
          }
        }

        const action = verbMap[verb];
        if (!action) {
          return {
            ok: false,
            text:
              'Polecenia: `/github status [ścieżka]`, `/github dodaj <ścieżka>`, `/github pobierz`, `/github wyślij`, `/github synchronizuj`, `/github init`, `/gh <polecenie>` (np. `/gh pr list`).',
          };
        }

        const r = await gitSync(__dirname, action, `SVL: ${action} z czatu`);
        if (r.ok && action !== 'status') {
          void pollAndRelayOutbox();
          broadcastResyncRequired('github_chat_sync');
        }

        let pathDetails = '';
        if (action === 'status' && arg) {
          const resolved = resolveSafeRepoRelPath(arg);
          if (resolved.ok && fsSync.existsSync(resolved.absPath)) {
            const st = fsSync.statSync(resolved.absPath);
            if (st.isDirectory()) {
              const items = fsSync.readdirSync(resolved.absPath, { withFileTypes: true });
              const listLines = items.map((d) => `  - \`${resolved.relPath}/${d.name}${d.isDirectory() ? '/' : ''}\``).join('\n');
              pathDetails = `\n\n📂 **Zawartość katalogu \`${resolved.relPath}/\` (${items.length} elementów):**\n${listLines || '  *(pusty)*'}`;
            } else {
              pathDetails = `\n\n📄 **Plik \`${resolved.relPath}\`:** obecny (${st.size} B)`;
            }
          } else if (resolved.ok) {
            pathDetails = `\n\n⚠️ Ścieżka \`${resolved.relPath}\` nie istnieje jeszcze lokalnie.`;
          }
        }

        return {
          ok: r.ok,
          text:
            `${r.ok ? '✅' : '⚠️'} ${r.summary}${action !== 'status' && r.status && r.status.isRepo ? `\n\n${describeStatus(r.status)}` : ''}${pathDetails}`,
        };
      };

      const subCommands = cleanMsg
        .split(/\s*(?:&&|;)\s*/)
        .map((s) => s.trim())
        .filter(Boolean);
      const results: Array<{ ok: boolean; text: string }> = [];
      for (const sc of subCommands) {
        results.push(await runSingleGitHubSubcommand(sc));
      }
      const allOk = results.every((r) => r.ok);
      const combinedText =
        results.map((r) => r.text).join('\n\n---\n\n') +
        '\n\n[btn: 🔄 Synchronizuj|send:/github synchronizuj] [btn: 📂 SVL_CoreOS_2|send:/github status SVL_CoreOS_2/] [btn: ⬆️ Wyślij|send:/github wyślij] [btn: 📋 Stan|send:/github status]';
      return void replyGitHub(allOk, combinedText);
    }

    const parsedSlashCmd = parseBielikChatCommand(cleanMsg);
    const isBielikChannel = String(conversationId || '').trim() === 'conv-agent-bielik';
    const isMayaChannel = String(conversationId || '').trim() === 'conv-agent-maya';
    const targetResolution = resolveChatTargetAgent({
      message: cleanMsg,
      conversationId: String(conversationId || ''),
      targetAgent: String(targetAgent || ''),
      hasSlashCommand: Boolean(parsedSlashCmd),
    });
    const mentionsBielik = targetResolution.mentionsBielik;
    const mentionsMaya = targetResolution.mentionsMaya;
    const selectedAgent: string = targetResolution.agent;
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
    const agentScopes = new Set<string>(
      Array.isArray(agentConfig.allowed_scopes)
        ? agentConfig.allowed_scopes.map((s: any) => String(s || '').trim().toLowerCase()).filter(Boolean)
        : [],
    );
    const hasAgentRootAuthority =
      hasOperatorAuth &&
      (String(agentConfig.rbac_role || 'root').toLowerCase() === 'root' || agentScopes.has('system.root'));
    const requestsRootSystemTools =
      hasAgentRootAuthority &&
      /\b(?:root|sudo|shell|bash|linux|ssh|sshd|demon\p{L}*|usług\p{L}*|uslug\p{L}*|serwis\p{L}*|moduł\p{L}*|modul\p{L}*|pamię[ćc]\p{L}*|pamiec\p{L}*|zapamięt\p{L}*|zapamiet\p{L}*|wirus\p{L}*|antywirus\p{L}*|skan\p{L}*|raport\p{L}*|synchroniz\p{L}*|diagnost\p{L}*|status|proces\p{L}*|dysk|ram|cpu|port\p{L}*|jądr\p{L}*|jadr\p{L}*|apex|svl-?364|zadani\p{L}*|sprawdź|sprawdz|uruchom|napraw|wykonaj)\b/iu.test(
        cleanMsg,
      );
    const githubPermissions = getGitHubAgentPermissions(agentConfig.allowed_scopes);
    // Narzędzia GitHub tylko dla wiadomości o GitHubie (też w kontekście ostatnich wypowiedzi).
    // Wcześniej sam token GitHub włączał je dla każdej wiadomości: Ollama była wtedy zawsze
    // pomijana (brak odpowiedzi, gdy Gemini zawiodło), a wyszukiwanie w internecie wyłączone.
    const githubTopic =
      isGitHubChatRequest(cleanMsg) ||
      historyTurns.slice(-2).some((turn) => turn.role === 'user' && isGitHubChatRequest(turn.content));
    const wantsGitHubTools = requestsGitHubTools && githubTopic && githubPermissions.read;
    const wantsGitHubWrite = wantsGitHubTools && githubPermissions.writeSync;
    if (requestsGitHubTools && githubTopic && !githubPermissions.read) {
      res.status(403).json({
        ok: false,
        error: `Brak skonfigurowanego agenta z wymaganym uprawnieniem GitHub.`,
      });
      return;
    }

    const effectiveTemperature =
      typeof agentConfig.temperature === 'number' && !Number.isNaN(agentConfig.temperature)
        ? Math.min(agentConfig.temperature, 0.7)
        : 0.4;

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

    // Operacje nieodwracalne zlecone przez AI czekają na potwierdzenie (przyciski w odpowiedzi).
    const githubConfirmations: Array<{ id: string; reason: string; label: string }> = [];
    const recordGitHubAction = (tool: string, ok: boolean, summary: string) =>
      appliedActions.push({ tool, entity: 'github', entityId: GITHUB_REPOSITORY, summary: summary.slice(0, 300), ok });
    const needsConfirmation = (tool: string, label: string, reason: string, op: Parameters<typeof queueConfirmation>[0]) => {
      if (!githubPermissions.admin) {
        recordGitHubAction(tool, false, `Brak uprawnienia github.admin: ${label}`);
        return { ok: false, error: `Operacja administracyjna (${reason}) wymaga uprawnienia github.admin.` };
      }
      const id = queueConfirmation(op, reason);
      githubConfirmations.push({ id, reason, label });
      const shortLabel = label.replace(/[|\]\n]/g, ' ').slice(0, 70);
      githubConfirmationButtons.push(
        `- ${reason}: \`${shortLabel}\` [btn: ✅ Potwierdź|send:/github potwierdź ${id}] [btn: ✖ Anuluj|send:/github anuluj ${id}]`,
      );
      recordGitHubAction(tool, true, `Czeka na potwierdzenie operatora: ${label}`);
      return {
        ok: false,
        requiresConfirmation: true,
        confirmationId: id,
        message: `Operacja „${label}” (${reason}) czeka na potwierdzenie operatora — przycisk pojawi się pod odpowiedzią.`,
      };
    };

    const executeChatTool = async (toolName: string, rawArgs: Record<string, any>): Promise<Record<string, any>> => {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
      if (toolName.startsWith('github_') && !githubPermissions.read) {
        const error = 'Brak uprawnień dla operacji GitHub: ' + toolName;
        recordGitHubAction(toolName, false, error);
        return { ok: false, error };
      }
      if (toolName === 'github_read_file') {
        const filePath = String(args.path || '').trim().replace(/^\/+/, '');
        return runGitHubTool(toolName, async () => {
          try {
            return await createGitHubFileService().readFile(filePath);
          } catch (err) {
            if (isAllowedGitHubFilePath(filePath)) {
              const absLocal = path.resolve(__dirname, filePath);
              if (absLocal.startsWith(__dirname + path.sep) && fsSync.existsSync(absLocal) && fsSync.statSync(absLocal).isFile()) {
                const localContent = fsSync.readFileSync(absLocal, 'utf8');
                if (!containsLikelySecret(localContent)) {
                  return { path: filePath, branch: syncBranch(), content: localContent };
                }
              }
            }
            throw err;
          }
        });
      }
      if (toolName === 'github_update_file') {
        if (!githubPermissions.writeSync) return { ok: false, error: 'Brak uprawnienia github.write_sync.' };
        const filePath = String(args.path || '').trim().replace(/^\/+/, '');
        const fileContent = String(args.content ?? '');
        const commitMessage = String(args.commit_message || `SVL (${selectedDisplayName}): aktualizacja ${filePath}`);
        return runGitHubTool(toolName, async () => {
          if (!isAllowedGitHubFilePath(filePath)) {
            throw new Error('File path is not allowed for GitHub access.');
          }
          if (containsLikelySecret(fileContent)) {
            throw new Error('File content appears to contain a secret; it was not sent to GitHub.');
          }
          // 1) Zapisz na dysku lokalnym i zsynchronizuj z domyślną gałęzią main (Rush47/SVL_Core), aby folder/plik był od razu widoczny na GitHubie
          const absLocal = path.resolve(__dirname, filePath);
          if (absLocal.startsWith(__dirname + path.sep)) {
            fsSync.mkdirSync(path.dirname(absLocal), { recursive: true });
            fsSync.writeFileSync(absLocal, fileContent, 'utf8');
          }
          const syncRes = await gitSync(__dirname, 'sync', commitMessage);
          pendingMutations = true;
          // 2) Równolegle zaktualizuj gałąź svl-sync przez GitHubFileService (z zachowaniem pełnej kompatybilności)
          const branchRes = await createGitHubFileService()
            .updateFile(filePath, fileContent, commitMessage)
            .catch(() => null);
          return {
            path: filePath,
            branch: syncBranch(),
            syncBranch: branchRes?.branch || DEFAULT_GITHUB_FILE_BRANCH,
            commitSha: branchRes?.commitSha || syncRes.status?.head || '',
            summary: syncRes.summary,
          };
        });
      }
      if (toolName === 'github_api') {
        const method = String(args.method || 'GET').toUpperCase();
        const apiPath = String(args.path || '');
        let body: any = undefined;
        if (typeof args.body === 'string' && args.body.trim()) {
          try {
            body = JSON.parse(args.body);
          } catch {
            // Jeśli model przekazał zwykły tekst zamiast JSON-a dla Contents API, opakujemy go poniżej
            body = { _rawText: args.body };
          }
        } else if (args.body && typeof args.body === 'object') {
          body = args.body;
        }
        if (!isAllowedApiPath(method, apiPath)) {
          return { ok: false, error: `Dozwolone jest wyłącznie repozytorium ${GITHUB_REPOSITORY}.` };
        }
        if (method !== 'GET' && !githubPermissions.writeSync) return { ok: false, error: 'Brak uprawnienia github.write_sync.' };

        // Automatyczna naprawa wywołań PUT /repos/Rush47/SVL_Core/contents/<ścieżka>, gdy AI pominie body lub sha
        const contentsMatch = method === 'PUT' ? /^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/i.exec(apiPath.split('?')[0]) : null;
        if (contentsMatch) {
          const rawRelPath = decodeURIComponent(contentsMatch[1]).replace(/^\/+|\/+$/g, '');
          const isDirPath = rawRelPath.endsWith('/') || !path.basename(rawRelPath).includes('.');
          const effectiveRelPath = isDirPath ? `${rawRelPath}/README.md` : rawRelPath;
          const absLocal = path.resolve(__dirname, effectiveRelPath);
          let plainTextContent = '';
          if (typeof body?._rawText === 'string') {
            plainTextContent = body._rawText;
          } else if (typeof (args as any).content === 'string') {
            plainTextContent = String((args as any).content);
          } else if (typeof body?.content === 'string') {
            // Sprawdź, czy body.content jest już poprawnym base64 czy zwykłym tekstem
            const looksBase64 = /^[A-Za-z0-9+/=\r\n]+$/.test(body.content) && body.content.length % 4 === 0;
            plainTextContent = looksBase64 ? Buffer.from(body.content, 'base64').toString('utf8') : body.content;
          } else if (absLocal.startsWith(__dirname + path.sep) && fsSync.existsSync(absLocal) && fsSync.statSync(absLocal).isFile()) {
            plainTextContent = fsSync.readFileSync(absLocal, 'utf8');
          } else {
            plainTextContent = `# ${path.basename(effectiveRelPath)}\n\nUtworzono przez SVL CoreOS 2 (${selectedDisplayName} · ${new Date().toISOString()}).\n`;
          }
          if (containsLikelySecret(plainTextContent)) {
            return { ok: false, error: 'Zawartość pliku wygląda na sekret i została zablokowana.' };
          }
          if (absLocal.startsWith(__dirname + path.sep) && isAllowedGitHubFilePath(effectiveRelPath)) {
            fsSync.mkdirSync(path.dirname(absLocal), { recursive: true });
            fsSync.writeFileSync(absLocal, plainTextContent, 'utf8');
          }
          const targetBranch = String(body?.branch || syncBranch());
          const encodedRel = effectiveRelPath.split('/').map(encodeURIComponent).join('/');
          const targetApiPath = `/repos/${GITHUB_REPOSITORY}/contents/${encodedRel}`;
          const existingFile = await githubApi('GET', `${targetApiPath}?ref=${encodeURIComponent(targetBranch)}`);
          const existingSha = existingFile.ok && (existingFile.data as any)?.sha ? String((existingFile.data as any).sha) : undefined;
          const fixedBody: Record<string, unknown> = {
            message: String(body?.message || `SVL (${selectedDisplayName}): aktualizacja ${effectiveRelPath}`).slice(0, 120),
            content: Buffer.from(plainTextContent, 'utf8').toString('base64'),
            branch: targetBranch,
            ...(existingSha ? { sha: existingSha } : {}),
          };
          const r = await githubApi('PUT', targetApiPath, fixedBody);
          if (r.ok) {
            pendingMutations = true;
          }
          recordGitHubAction(toolName, r.ok, `PUT ${targetApiPath} → ${r.ok ? `HTTP ${r.status}` : r.error}`);
          return r.ok
            ? { ok: true, status: r.status, path: effectiveRelPath, branch: targetBranch, data: JSON.stringify(r.data).slice(0, 12000) }
            : { ok: false, status: r.status, error: r.error };
        }

        if (body && typeof body === 'object' && '_rawText' in body) {
          return { ok: false, error: 'Pole body musi być poprawnym JSON-em.' };
        }
        const danger = destructiveReason(method, apiPath, body);
        if (danger) {
          return needsConfirmation(toolName, `${method} ${apiPath}`, danger, { kind: 'api', method, path: apiPath, body });
        }
        const r = await githubApi(method, apiPath, body);
        if (method !== 'GET') recordGitHubAction(toolName, r.ok, `${method} ${apiPath} → ${r.ok ? `HTTP ${r.status}` : r.error}`);
        return r.ok
          ? { ok: true, status: r.status, data: JSON.stringify(r.data).slice(0, 12000) }
          : { ok: false, status: r.status, error: r.error };
      }
      if (toolName === 'github_sync') {
        const action = String(args.action || 'status').toLowerCase() as GitSyncAction;
        if (!['status', 'pull', 'push', 'sync'].includes(action)) return { ok: false, error: 'action: status | pull | push | sync' };
        if (action !== 'status' && !githubPermissions.writeSync) return { ok: false, error: 'Brak uprawnienia github.write_sync.' };
        const r = await gitSync(__dirname, action, String(args.message || `SVL (${selectedDisplayName}): synchronizacja z czatu`));
        if (action !== 'status') {
          recordGitHubAction(toolName, r.ok, r.summary);
          if (r.ok) pendingMutations = true;
        }
        return { ok: r.ok, summary: r.summary };
      }
      if (toolName === 'github_cli') {
        const ghArgs = splitArgs(String(args.args || '').replace(/^\s*gh\s+/, ''));
        const verdict = assessGhCommand(ghArgs);
        if (!verdict.allowed) return { ok: false, error: verdict.reason };
        if (verdict.destructive) {
          return needsConfirmation(toolName, `gh ${ghArgs.join(' ')}`, verdict.destructive, { kind: 'gh', args: ghArgs });
        }
        if (!githubPermissions.writeSync && !/^(api|auth|repo view|pr list|pr view|issue list|issue view|run list|run view|release list|branch list|workflow list)/.test(ghArgs.join(' '))) {
          return { ok: false, error: 'Brak uprawnienia github.write_sync dla tego polecenia gh.' };
        }
        const r = await runGhCommand(__dirname, ghArgs);
        recordGitHubAction(toolName, r.ok, `gh ${ghArgs.slice(0, 4).join(' ')} (${r.engine})`);
        return { ok: r.ok, output: r.output.slice(0, 12000) };
      }
      if (toolName === 'svl_system_status') {
        if (!hasAgentRootAuthority) return { ok: false, error: 'Wymagane uprawnienia ROOT i autoryzacja operatora.' };
        const [hRes, aRes, mRes, apexRes, sshRes] = await Promise.all([
          callPythonBackend('GET', '/api/py/health', undefined, corrId),
          callPythonBackend('GET', '/api/py/agents/status', undefined, corrId),
          callPythonBackend('GET', '/api/py/modules', undefined, corrId),
          callPythonBackend('GET', '/api/py/apex/status', undefined, corrId),
          callPythonBackend('GET', '/api/py/svl364/ssh-mcp/status', undefined, corrId),
        ]);
        appliedActions.push({
          tool: toolName,
          entity: 'kernel',
          entityId: 'status',
          serverRevision: Number(hRes.data?.serverRevision || latestActionSrvRev),
          summary: `${selectedDisplayName} ROOT: odczytano pełny stan systemu SVL`,
          ok: hRes.status === 200,
        });
        return {
          ok: hRes.status === 200,
          serverRevision: hRes.data?.serverRevision,
          ollama: hRes.data?.ollama,
          modulesCount: Array.isArray(mRes.data?.modules) ? mRes.data.modules.length : 0,
          modules: Array.isArray(mRes.data?.modules)
            ? mRes.data.modules.map((m: any) => ({ id: m.id, name: m.name, status: m.status }))
            : [],
          agents: Array.isArray(aRes.data?.agents)
            ? aRes.data.agents.map((a: any) => ({
                name: formatAgentDisplayName(a.canonical_name),
                status: a.status,
                pid: a.pid,
                rbac_role: a.config?.rbac_role,
                scopes_count: Array.isArray(a.config?.allowed_scopes) ? a.config.allowed_scopes.length : 0,
                memories: a.memory_entries_count,
              }))
            : [],
          apex: apexRes.data,
          ssh: sshRes.data?.ssh,
        };
      }
      if (toolName === 'svl_root_exec') {
        if (!hasAgentRootAuthority) return { ok: false, error: 'Wymagane uprawnienia ROOT i autoryzacja operatora.' };
        const shellCmd = String(args.command || '').trim().slice(0, 1000);
        const isCatastrophic =
          /rm\s+-[a-z]*r[a-z]*f\s+\/(?:\s|$|\*)/i.test(shellCmd) ||
          /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(shellCmd) ||
          /\b(?:mkfs(?:\.[a-z0-9]+)?|dd\s+if=.*of=\/dev\/[sh]d|shutdown|reboot|poweroff|halt)\b/i.test(shellCmd);
        if (!shellCmd || isCatastrophic) {
          return { ok: false, error: 'Zablokowano puste lub katastrofalne polecenie ROOT.' };
        }
        const shellRes = await executeLinuxShellCommand(shellCmd);
        const cleanStdout = scrubRuntimeLog(shellRes.stdout || '').trimEnd();
        const cleanStderr = scrubRuntimeLog(shellRes.stderr || '').trimEnd();
        const actorPrefix = selectedAgent === 'Maya' ? 'maya@root#' : 'bielik@root#';
        await persistTerminalOutput('linux', 'input', `${actorPrefix} ${shellCmd}`, shellCmd, `${selectedAgent.toLowerCase()}-root`, corrId);
        if (cleanStdout) await persistTerminalOutput('linux', 'stdout', cleanStdout, shellCmd, `${selectedAgent.toLowerCase()}-root`, corrId);
        if (cleanStderr) await persistTerminalOutput('linux', 'stderr', cleanStderr, shellCmd, `${selectedAgent.toLowerCase()}-root`, corrId);
        appliedActions.push({
          tool: toolName,
          entity: 'linux',
          entityId: 'root',
          serverRevision: latestActionSrvRev,
          summary: `${selectedDisplayName} ROOT (${shellRes.ok ? 'OK' : `EXIT ${shellRes.exitCode}`}): ${shellCmd.slice(0, 72)}`,
          ok: shellRes.ok,
        });
        return {
          ok: shellRes.ok,
          exitCode: shellRes.exitCode,
          durationMs: shellRes.durationMs,
          stdout: cleanStdout.slice(0, 4000),
          stderr: cleanStderr.slice(0, 1500),
        };
      }
      if (toolName === 'svl_ssh_exec') {
        if (!hasAgentRootAuthority) return { ok: false, error: 'Wymagane uprawnienia ROOT i autoryzacja operatora.' };
        const sshCmd = String(args.command || '').trim().slice(0, 1000);
        if (!sshCmd) return { ok: false, error: 'Wymagane polecenie SSH.' };
        const sshRes = await callPythonBackend(
          'POST',
          '/api/py/svl364/ssh/exec',
          { command: sshCmd, confirmed: true, origin: `${selectedAgent.toLowerCase()}-root-tool`, correlationId: corrId },
          corrId,
        );
        const ok = sshRes.status === 200 && Boolean(sshRes.data?.ok);
        appliedActions.push({
          tool: toolName,
          entity: 'ssh',
          entityId: 'svl-364-ship',
          serverRevision: latestActionSrvRev,
          summary: `${selectedDisplayName} SSH: ${sshCmd.slice(0, 72)} (${ok ? 'OK' : 'ERR'})`,
          ok,
        });
        return {
          ok,
          exitCode: sshRes.data?.exitCode,
          output: String(sshRes.data?.output || sshRes.data?.error || '').slice(0, 4000),
        };
      }
      if (toolName === 'svl_module_upsert') {
        if (!hasAgentRootAuthority) return { ok: false, error: 'Wymagane uprawnienia ROOT i autoryzacja operatora.' };
        const modId = String(args.id || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 64);
        if (!modId) return { ok: false, error: 'Wymagany identyfikator modułu (id).' };
        const rawStatus = String(args.status || 'ACTIVE').toUpperCase();
        const modStatus = ['ACTIVE', 'CONFIGURED', 'STANDBY'].includes(rawStatus) ? rawStatus : 'ACTIVE';
        const modRes = await callPythonBackend(
          'POST',
          '/api/py/modules/upsert',
          {
            id: modId,
            name: String(args.name || modId).slice(0, 120),
            kind: String(args.kind || 'ROOT AI Module').slice(0, 64),
            status: modStatus,
            description: String(args.description || `Zaktualizowano przez ${selectedDisplayName} (ROOT)`).slice(0, 500),
            source: selectedAgent.toLowerCase(),
            origin,
            correlationId: corrId,
          },
          corrId,
        );
        if (modRes.data?.event) publishOutboxEvent(modRes.data.event);
        latestActionSrvRev = Math.max(latestActionSrvRev, Number(modRes.data?.serverRevision || 0));
        const ok = modRes.status === 200 && Boolean(modRes.data?.ok);
        if (ok) pendingMutations = true;
        appliedActions.push({
          tool: toolName,
          entity: 'module',
          entityId: modId,
          serverRevision: latestActionSrvRev,
          summary: ok ? `${selectedDisplayName} ROOT: moduł ${modId} -> ${modStatus}` : String(modRes.data?.error || 'Błąd modułu'),
          ok,
        });
        return { ok, moduleId: modId, status: modStatus, serverRevision: latestActionSrvRev, error: modRes.data?.error };
      }
      if (toolName === 'svl_memory_save') {
        if (!hasAgentRootAuthority) return { ok: false, error: 'Wymagane uprawnienia ROOT i autoryzacja operatora.' };
        const content = String(args.content || '').trim().slice(0, 800);
        if (!content) return { ok: false, error: 'Wymagana treść wpisu pamięci.' };
        const scope = String(args.scope || 'global').trim() === 'agent' ? `agent:${selectedAgent}` : 'global';
        const kind = ['fact', 'decision', 'note', 'episode'].includes(String(args.kind || '').toLowerCase())
          ? String(args.kind).toLowerCase()
          : 'fact';
        const memRes = await callPythonBackend(
          'POST',
          '/api/py/agents/memory',
          { agent: selectedAgent, scope, kind, content, origin, correlationId: corrId },
          corrId,
        );
        if (memRes.data?.event) publishOutboxEvent(memRes.data.event);
        latestActionSrvRev = Math.max(latestActionSrvRev, Number(memRes.data?.serverRevision || 0));
        const ok = memRes.status === 200 && Boolean(memRes.data?.ok);
        if (ok) pendingMutations = true;
        appliedActions.push({
          tool: toolName,
          entity: 'agent_memory',
          entityId: selectedAgent,
          serverRevision: latestActionSrvRev,
          summary: ok ? `Zapisano w pamięci (${scope}): "${content.slice(0, 60)}"` : String(memRes.data?.error || 'Błąd pamięci'),
          ok,
        });
        return { ok, scope, kind, serverRevision: latestActionSrvRev };
      }
      if (toolName === 'svl_antivirus_scan') {
        if (!hasAgentRootAuthority) return { ok: false, error: 'Wymagane uprawnienia ROOT i autoryzacja operatora.' };
        const avRes = await callPythonBackend(
          'POST',
          '/api/py/security/antivirus/scan',
          { emitToChat: false, origin, correlationId: corrId },
          corrId,
        );
        latestActionSrvRev = Math.max(latestActionSrvRev, Number(avRes.data?.serverRevision || 0));
        const ok = avRes.status === 200 && Boolean(avRes.data?.ok);
        if (ok) pendingMutations = true;
        appliedActions.push({
          tool: toolName,
          entity: 'security',
          entityId: 'svl-365-av',
          serverRevision: latestActionSrvRev,
          summary: ok
            ? `Skan AV: ${avRes.data?.filesScanned ?? 0} plików, zagrożeń: ${avRes.data?.threatsFoundAndPurged ?? 0}`
            : String(avRes.data?.error || 'Błąd skanu AV'),
          ok,
        });
        return {
          ok,
          status: avRes.data?.status,
          filesScanned: avRes.data?.filesScanned,
          threatsFoundAndPurged: avRes.data?.threatsFoundAndPurged,
        };
      }
      if (toolName === 'svl_kernel_report') {
        if (!hasAgentRootAuthority) return { ok: false, error: 'Wymagane uprawnienia ROOT i autoryzacja operatora.' };
        const directive = String(args.directive || 'Pełny raport operacyjny SVL_System').slice(0, 240);
        const repRes = await callPythonBackend(
          'POST',
          '/api/py/kernel/markdown-report',
          { directive, emitToChat: false, origin, correlationId: corrId },
          corrId,
        );
        const ok = repRes.status === 200 && Boolean(repRes.data?.ok);
        appliedActions.push({
          tool: toolName,
          entity: 'kernel',
          entityId: 'markdown-report',
          serverRevision: Number(repRes.data?.serverRevision || latestActionSrvRev),
          summary: ok ? `Wygenerowano raport SVL_System (${directive.slice(0, 48)})` : 'Błąd raportu',
          ok,
        });
        return { ok, reportMarkdown: String(repRes.data?.reportMarkdown || '').slice(0, 8000) };
      }
      if (toolName === 'svl_global_sync') {
        if (!hasAgentRootAuthority) return { ok: false, error: 'Wymagane uprawnienia ROOT i autoryzacja operatora.' };
        pendingMutations = true;
        cachedChatContextMeta = null;
        void pollAndRelayOutbox();
        broadcastResyncRequired('ai_root_global_sync', latestActionSrvRev);
        appliedActions.push({
          tool: toolName,
          entity: 'sync',
          entityId: 'global',
          serverRevision: latestActionSrvRev,
          summary: `${selectedDisplayName} ROOT: uruchomiono globalną synchronizację domen`,
          ok: true,
        });
        return { ok: true, serverRevision: latestActionSrvRev };
      }
      if (toolName === 'svl_agent_task') {
        if (!hasAgentRootAuthority) return { ok: false, error: 'Wymagane uprawnienia ROOT i autoryzacja operatora.' };
        const taskTarget = normalizeAgentCanonicalName(String(args.target_agent || selectedAgent)) || selectedAgent;
        const title = String(args.title || 'Zadanie ROOT z czatu').slice(0, 200);
        const payload = String(args.payload || title).slice(0, 2000);
        const taskRes = await callPythonBackend(
          'POST',
          '/api/py/agents/task',
          { sender: selectedDisplayName, target_agent: taskTarget, title, payload, ai_provider: 'ollama', origin, correlationId: corrId },
          corrId,
        );
        const ok = taskRes.status === 200 && Boolean(taskRes.data?.ok);
        if (ok) pendingMutations = true;
        appliedActions.push({
          tool: toolName,
          entity: 'agent_task',
          entityId: String(taskRes.data?.task?.id || taskTarget),
          serverRevision: Number(taskRes.data?.serverRevision || latestActionSrvRev),
          summary: ok ? `Zlecono zadanie dla ${formatAgentDisplayName(taskTarget)}: ${title.slice(0, 50)}` : String(taskRes.data?.error || 'Błąd zadania'),
          ok,
        });
        return { ok, taskId: taskRes.data?.task?.id, targetAgent: formatAgentDisplayName(taskTarget) };
      }
      return { ok: false, error: `Narzędzie wycofane lub niedostępne: ${toolName}` };
    };

    const chatToolDeclarations: FunctionDeclaration[] = [];

    if (requestsRootSystemTools) {
      chatToolDeclarations.push(
        {
          name: 'svl_system_status',
          description: 'Odczytuje na żywo pełny stan systemu SVL (jądro, moduły SQLite, agenci Bielik i Maya Mitek, Ollama, Apex OS, SSH).',
          parameters: { type: Type.OBJECT, properties: {} },
        },
        {
          name: 'svl_root_exec',
          description: 'Wykonuje polecenie w lokalnej powłoce Linux z uprawnieniami ROOT (uid=0) w uwierzytelnionej sesji operatora. Używaj do diagnostyki i operacji systemowych.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              command: { type: Type.STRING, description: 'Polecenie powłoki Linux do wykonania jako root.' },
            },
            required: ['command'],
          },
        },
        {
          name: 'svl_ssh_exec',
          description: 'Wykonuje polecenie przez mostek OpenSSH SVL-364 (alias Ship) z uprawnieniami ROOT.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              command: { type: Type.STRING, description: 'Polecenie do wykonania na hoście SSH Ship.' },
            },
            required: ['command'],
          },
        },
        {
          name: 'svl_module_upsert',
          description: 'Tworzy, aktywuje lub aktualizuje moduł systemowy SVL w bazie SQLite WAL.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING, description: 'Identyfikator modułu, np. svl-guard.' },
              name: { type: Type.STRING, description: 'Nazwa wyświetlana modułu.' },
              status: { type: Type.STRING, description: 'ACTIVE, CONFIGURED lub STANDBY.' },
              description: { type: Type.STRING, description: 'Opis działania modułu.' },
            },
            required: ['id'],
          },
        },
        {
          name: 'svl_memory_save',
          description: 'Zapisuje ważny fakt, decyzję lub notatkę w trwałej pamięci długotrwałej 128D SQLite WAL.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              content: { type: Type.STRING, description: 'Treść wpisu pamięci do zapisania.' },
              scope: { type: Type.STRING, description: 'global (wspólna pamięć Rodziny Mitek) lub agent (pamięć własna).' },
              kind: { type: Type.STRING, description: 'fact, decision, note lub episode.' },
            },
            required: ['content'],
          },
        },
        {
          name: 'svl_antivirus_scan',
          description: 'Uruchamia realny skan antywirusowy SVL-365 Sentinel AV i zwraca liczbę przeskanowanych plików oraz wykrytych zagrożeń.',
          parameters: { type: Type.OBJECT, properties: {} },
        },
        {
          name: 'svl_kernel_report',
          description: 'Generuje aktualny raport operacyjny SVL_System z rzeczywistych danych jądra i hosta.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              directive: { type: Type.STRING, description: 'Zakres lub temat raportu.' },
            },
          },
        },
        {
          name: 'svl_global_sync',
          description: 'Uruchamia globalną synchronizację wszystkich domen SVL (SQLite WAL + WebSocket).',
          parameters: { type: Type.OBJECT, properties: {} },
        },
        {
          name: 'svl_agent_task',
          description: 'Zleca zadanie w tle do kolejki workera Bielik lub Maya Mitek.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              target_agent: { type: Type.STRING, description: 'Bielik lub Maya.' },
              title: { type: Type.STRING, description: 'Krótki tytuł zadania.' },
              payload: { type: Type.STRING, description: 'Szczegółowy opis zadania.' },
            },
            required: ['title'],
          },
        },
      );
    }

    if (wantsGitHubTools && githubPermissions.read) {
      chatToolDeclarations.push(
        {
          name: 'github_api',
          description:
            `Wywołuje REST API GitHuba dla repozytorium ${GITHUB_REPOSITORY} (np. GET /repos/${GITHUB_REPOSITORY}/pulls, ` +
            `POST /repos/${GITHUB_REPOSITORY}/issues). Dozwolone wyłącznie ścieżki /repos/${GITHUB_REPOSITORY}/… oraz GET /user. ` +
            'Operacje nieodwracalne (usuwanie, ustawienia repo, dostęp, ochrona gałęzi, scalanie PR) czekają na potwierdzenie operatora.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              method: { type: Type.STRING, description: 'GET, POST, PUT, PATCH lub DELETE.' },
              path: { type: Type.STRING, description: `Ścieżka API, np. /repos/${GITHUB_REPOSITORY}/branches.` },
              body: { type: Type.STRING, description: 'Opcjonalne ciało żądania jako JSON.' },
            },
            required: ['method', 'path'],
          },
        },
        {
          name: 'github_sync',
          description:
            `Synchronizacja obustronna katalogu projektu SVL z ${GITHUB_REPOSITORY} (gałąź ${syncBranch()}): ` +
            'status | pull (pobierz) | push (zapisz lokalne zmiany i wyślij) | sync (zapisz, scal, wyślij). Nigdy nie nadpisuje siłą.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              action: { type: Type.STRING, description: 'status, pull, push lub sync.' },
              message: { type: Type.STRING, description: 'Opis commitu dla lokalnych zmian (opcjonalnie).' },
            },
            required: ['action'],
          },
        },
        {
          name: 'github_cli',
          description:
            `Uruchamia GitHub CLI (gh) dla ${GITHUB_REPOSITORY}, np. "pr list", "issue create --title X --body Y", ` +
            '"run list", "workflow run nazwa.yml", "release create v1.0 --notes ...". Tylko to repozytorium.',
          parameters: {
            type: Type.OBJECT,
            properties: { args: { type: Type.STRING, description: 'Argumenty polecenia gh (bez słowa gh).' } },
            required: ['args'],
          },
        },
        {
          name: 'github_read_file',
          description: `Odczytuje plik źródłowy z gałęzi svl-sync repozytorium ${GITHUB_REPOSITORY}.`,
          parameters: {
            type: Type.OBJECT,
            properties: { path: { type: Type.STRING, description: 'Ścieżka względna pliku źródłowego.' } },
            required: ['path'],
          },
        },
      );
    }
    if (wantsGitHubWrite) {
      chatToolDeclarations.push({
        name: 'github_update_file',
        description:
          `Zapisuje plik źródłowy jako commit na gałęzi svl-sync repozytorium ${GITHUB_REPOSITORY}. Nie przyjmuje sekretów.`,
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
        ? `Maya Mitek · AI Statku SVL-364 (ROOT · ${modelName})`
        : isExplicitOllama || isBielikAgent
          ? `Bielik · Ollama (${modelName} · ROOT)`
          : model === 'svl-hybrid-router'
            ? `SVL-364 · Ollama (${modelName})`
            : effectiveModel;
    let displayModelBadge = badgeForModel(selectedOllamaModelName);

    const executeBielikCommand = async (cmd: BielikSlashCommand): Promise<{ text: string }> => {
      if (cmd.kind === 'help') {
        const icon = selectedAgent === 'Maya' ? '🛰️' : '🦅';
        return {
          text:
            `### ${icon} ${selectedDisplayName} (ROOT) — Procesor Poleceń Czatu (wykonuje serwer SVL, bez modelu AI)\n\n` +
            `Dostępne polecenia w czacie:\n` +
            `- \`/pomoc\` lub \`/help\` — lista poleceń procesora ${selectedDisplayName}\n` +
            `- \`/status\` — telemetria jądra SVL, rola RBAC, RAM/CPU/dysk oraz status Ollama 11434\n` +
            `- \`/ollama\` — wersja demona, lista pobranych modeli i aktywnie załadowane modele (\`/api/ps\`)\n` +
            `- \`/root <polecenie>\` lub \`/exec <polecenie>\` — wykonanie polecenia w powłoce Linux z uprawnieniami ROOT (wymaga \`SVL_OPERATOR_TOKEN\`)\n` +
            `- \`/moduly\` — lista zarejestrowanych modułów SVL w SQLite WAL\n` +
            `- \`/modul <id> [ACTIVE|CONFIGURED|STANDBY] [opis]\` — bezpieczny zapis modułu SVL\n` +
            `- \`/pamiec [lista | dodaj <treść>]\` — odczyt lub zapis pamięci długotrwałej ${selectedDisplayName} w SQLite\n` +
            `- \`/topologia [xStart] [xEnd]\` — zwartość topologiczna Algebry 97 (\`TopologicalInfinityEngine\`)\n` +
            `- \`/polacz\` — uruchomienie/synchronizacja lokalnych workerów procesowych AI\n` +
            `- \`/zadanie <tytuł> | <opis>\` — zlecenie zadania w kolejce workera Ollama\n\n` +
            `Możesz też pisać naturalnie po polsku do **${selectedDisplayName}** (np. *„Zapisz w pamięci że…”*, *„Sprawdź status Ollama”* lub załączyć obraz do analizy Vision).`,
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
        const activeLiveAgent = (freshAgents.data?.agents || []).find((a: any) => a.canonical_name === selectedAgent) || {};
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
        const icon = selectedAgent === 'Maya' ? '🛰️' : '🦅';
        return {
          text:
            `### ${icon} ${selectedDisplayName} · Diagnostyka Ollama & SVL Python OS\n\n` +
            `- **Ollama Daemon (\`${ollamaHost}\`):** ${versionJson ? `\`ONLINE · v${(versionJson as any).version}\`` : '`OFFLINE`'}\n` +
            `- **Zainstalowane modele (${modelsList.length}):**\n${modelsLines}\n` +
            `- **Załadowane w pamięci (${runningList.length}):**\n${runningLines}\n` +
            `- **Worker ${selectedDisplayName}:** \`${activeLiveAgent.status || 'DEFINITION_READY'}\`${activeLiveAgent.pid ? ` (PID ${activeLiveAgent.pid})` : ''} · rola RBAC: \`${activeLiveAgent.config?.rbac_role || 'root'}\` · pamięć: \`${activeLiveAgent.memory_entries_count ?? 0}\` wpisów\n` +
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
        const memDisplayLabel = formatAgentDisplayName(memAgent);
        const targetLabel = isGroupChannel
          ? 'wspólnej pamięci Rodziny Mitek (Bielik + Maya Mitek)'
          : `pamięci długotrwałej **${memDisplayLabel}**`;
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
        const rootPromptTag = selectedAgent === 'Maya' ? 'maya@root#' : 'bielik@root#';
        const rootOriginTag = selectedAgent === 'Maya' ? 'maya-root' : 'bielik-root';
        const rootHeadingIcon = selectedAgent === 'Maya' ? '🛰️' : '🦅';
        await persistTerminalOutput('linux', 'input', `${rootPromptTag} ${shellCmd}`, shellCmd, rootOriginTag, corrId);
        if (cleanStdout) {
          await persistTerminalOutput('linux', 'stdout', cleanStdout, shellCmd, rootOriginTag, corrId);
        }
        if (cleanStderr) {
          await persistTerminalOutput('linux', 'stderr', cleanStderr, shellCmd, rootOriginTag, corrId);
        }

        appliedActions.push({
          tool: `${selectedAgent.toLowerCase()}_root_exec`,
          entity: 'linux',
          entityId: 'root',
          serverRevision: latestActionSrvRev,
          summary: `${selectedDisplayName} ${shellRes.ok ? 'ROOT OK' : `EXIT ${shellRes.exitCode}`}: ${shellCmd.slice(0, 72)}`,
          ok: shellRes.ok,
        });

        const parts = [
          `### ${rootHeadingIcon} ${selectedDisplayName} ROOT Exec (\`exit ${shellRes.exitCode}\` · ${shellRes.durationMs} ms)`,
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
            ? `✅ Zsynchronizowano i uruchomiono lokalnych workerów **Bielik i Maya Mitek (ROOT)** (${spawned.map((a: any) => `${formatAgentDisplayName(a.display_name || a.canonical_name)}: PID \`${a.pid}\`, model \`${a.ollama_model}\``).join('; ')}).`
            : `❌ Błąd połączenia workerów: ${connRes.data?.error || 'błąd backendu'}`,
        };
      }

      if (cmd.kind === 'agent_task') {
        const taskRes = await callPythonBackend(
          'POST',
          '/api/py/agents/task',
          {
            sender: 'operator',
            target_agent: selectedAgent,
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
          entityId: String(taskRes.data?.task?.id || selectedAgent),
          serverRevision: latestActionSrvRev,
          summary: ok ? `Zlecono zadanie ${selectedDisplayName}: ${cmd.title}` : String(taskRes.data?.error || 'Błąd kolejki'),
          ok,
        });
        return {
          text: ok
            ? `✅ Zlecono zadanie **„${cmd.title}”** do kolejki workera **${selectedDisplayName}** (\`ID: ${String(taskRes.data?.task?.id || '').slice(0, 8)}\`, stan: \`${taskRes.data?.resilience?.status || 'QUEUED'}\`).`
            : `❌ Błąd zlecenia zadania: ${taskRes.data?.error || 'błąd backendu'}`,
        };
      }

      return { text: `Nieznane polecenie ${selectedDisplayName}.` };
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
        modelUsed: `${selectedDisplayName} · Procesor Poleceń ROOT (serwer SVL, bez modelu AI)`,
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
    // Kontekst systemowy: tożsamość agenta + zasady prawdomówności + elementy interaktywne + pamięć długotrwała.
    const agentMemoryContext = buildAgentSystemContext(
      formatMemoryPromptContext(recalledMemories, selectedDisplayName, 14),
      selectedDisplayName,
    );

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
        const avBadge = 'Maya Mitek · skaner sygnatur SVL-365 (wynik serwera)';
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
          sender: 'Maya Mitek',
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
    // Wbudowane narzędzia Gemini: czytanie stron z linków w wiadomości i wykonywanie kodu (obliczenia).
    const wantsUrlContext = /https?:\/\/\S+/i.test(cleanMsg) && !wantsGitHubTools;
    const wantsCodeExecution =
      !wantsGitHubTools &&
      /\b(?:oblicz|policz|wylicz|przelicz|wykonaj kod|uruchom kod|napisz i uruchom|python|symulacj\p{L}*|statystyk\p{L}*|średni\p{L}*|procent\p{L}*|równani\p{L}*)/iu.test(cleanMsg);
    const builtinGeminiTools: Array<Record<string, object>> = [
      ...(wantsWebSources ? [{ googleSearch: {} }] : []),
      ...(wantsUrlContext ? [{ urlContext: {} }] : []),
      ...(wantsCodeExecution && !wantsWebSources && !wantsUrlContext ? [{ codeExecution: {} }] : []),
    ];
    const webSearchUnavailableNote =
      'Pytanie dotyczy aktualnych informacji, ale wyszukiwanie w internecie jest niedostępne (brak GEMINI_API_KEY). ' +
      'Odpowiedź pochodzi wyłącznie z wiedzy modelu i może być nieaktualna lub błędna.';
    const shouldTryOllama =
      !wantsGitHubTools && !(wantsWebSources && ai) &&
      (isBielikAgent || isExplicitOllama || (!ai && model === 'svl-hybrid-router'));
    let ollamaFailure = shouldTryOllama
      ? ''
      : wantsGitHubTools
        ? 'pominięta — sprawy GitHuba obsługuje Gemini z narzędziami GitHub (Ollama nie ma do nich dostępu)'
        : 'nie użyto dla tego zapytania';
    let geminiFailure = ai ? '' : 'brak klucza GEMINI_API_KEY';
    let geminiFailureDetails = '';
    const ollamaChatTimeoutMs = Number(process.env.OLLAMA_CHAT_TIMEOUT_MS || 75000);
    let ollamaGenerationStarted = false;
    let ollamaTimedOut = false;
    // Ollama: pierwsza dla Bielika i jawnego wyboru, zapasowa, gdy Gemini zawiedzie.
    const tryOllama = async (): Promise<boolean> => {
      try {
        const ready = await resolveCachedOllamaModel(ollamaHost, selectedOllamaModelName, {
          requireVision: Boolean(imageBase64),
        });
        if (!ready.ok) {
          throw new Error(ready.reason);
        }
        selectedOllamaModelName = ready.model;
        displayModelBadge = badgeForModel(selectedOllamaModelName);
        const ollamaOpts = getOllamaRuntimeOptions(process.env);
        const compactOllamaHistory = trimHistoryForOllama(
          agentHistory,
          ollamaOpts.historyTurns,
          ollamaOpts.maxTurnChars,
        );
        const ollamaMessages = [
          ...(agentMemoryContext ? [{ role: 'system', content: agentMemoryContext }] : []),
          ...compactOllamaHistory,
          {
            role: 'user',
            content: cleanMsg ? labelOperatorText(cleanMsg) : '',
            ...(imageBase64 ? { images: [imageBase64.replace(/^data:[^;]+;base64,/, '')] } : {}),
          },
        ];
        const ollamaTimeoutMs = ollamaChatTimeoutMs;
        ollamaGenerationStarted = true;
        const oResp = await fetch(`${ollamaHost}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(ollamaTimeoutMs),
          body: JSON.stringify({
            model: selectedOllamaModelName,
            stream: false,
            keep_alive: ollamaOpts.keep_alive,
            options: {
              temperature: effectiveTemperature,
              num_ctx: ollamaOpts.num_ctx,
              num_predict: ollamaOpts.num_predict,
              ...ollamaOpts.perf,
            },
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
            return true;
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
            ? /fetch failed|ECONNREFUSED/i.test(reason)
              ? `nie działa pod ${ollamaHost} (brak połączenia)` +
                (/127\.0\.0\.1|localhost/.test(ollamaHost)
                  ? ' — na tym serwerze nie uruchomiono Ollamy (w AI Studio jej nie ma); ustaw OLLAMA_HOST na adres komputera z Ollamą'
                  : '')
              : `nie odpowiedziała pod ${ollamaHost} w wyznaczonym czasie (${reason})`
            : reason;
        }
      }
      return false;
    };
    if (shouldTryOllama && (await tryOllama())) return;

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

      const geminiCompactHistory = trimHistoryForOllama(agentHistory, 16, 1800);
      const coalescedHistory: Array<{ role: 'user' | 'model'; parts: any[] }> = [];
      for (const turn of geminiCompactHistory) {
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

      // Wspólny budżet czasu (20 s na kandydata, 55 s łącznie) + zwięzły limit tokenów odpowiedzi + hedging po 4,5 s.
      const geminiDeadline = createGeminiDeadline();
      const chatMaxOutputTokens = selectChatMaxOutputTokens(cleanMsg);
      const callModelWithRetry = async (
        candidate: string,
        contentsPayload: any[],
        includeTools: boolean,
        useSearchGrounding = builtinGeminiTools.length > 0,
        allowTransient503Retry = false,
        externalSignal?: AbortSignal,
      ): Promise<GenerateContentResponse> => {
        const tempCfg = candidate === 'gemini-3.1-flash-lite' ? { temperature: effectiveTemperature } : {};
        for (let attempt = 0; attempt < 2; attempt++) {
          if (externalSignal?.aborted) throw new Error('cancelled_by_hedge_winner');
          const timeoutMs = geminiDeadline.attemptTimeout();
          if (timeoutMs < 3000) throw new Error('przekroczono łączny limit czasu odpowiedzi (timeout)');
          const attemptCtrl = new AbortController();
          const timer = setTimeout(() => attemptCtrl.abort(new Error('TimeoutError')), timeoutMs);
          const onExternalAbort = () => attemptCtrl.abort(new Error('cancelled_by_hedge_winner'));
          externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
          try {
            return await ai.models.generateContent({
              model: candidate,
              contents: contentsPayload,
              config: {
                ...tempCfg,
                maxOutputTokens: chatMaxOutputTokens,
                ...geminiThinkingConfig(candidate),
                ...(agentMemoryContext ? { systemInstruction: agentMemoryContext } : {}),
                ...(includeTools
                  ? { tools: [{ functionDeclarations: chatToolDeclarations }] }
                  : useSearchGrounding
                    ? { tools: builtinGeminiTools }
                    : {}),
                abortSignal: attemptCtrl.signal,
              },
            });
          } catch (err: any) {
            if (externalSignal?.aborted) throw new Error('cancelled_by_hedge_winner');
            const msgStr = String(err?.message || err);
            if (isThinkingConfigError(msgStr) && Object.keys(geminiThinkingConfig(candidate)).length > 0) {
              disableThinkingConfigFor(candidate);
              continue;
            }
            // Narzędzia wbudowane pomijamy tylko, gdy model ich nie obsługuje — nie przy przeciążeniu/czasie/kwocie.
            if (useSearchGrounding && !includeTools && !isGeminiSlowOrBusyError(msgStr)) {
              return await callModelWithRetry(
                candidate,
                contentsPayload,
                false,
                false,
                allowTransient503Retry,
                externalSignal,
              );
            }
            // 429 (brak kwoty) oraz timeout NIGDY nie ponawiamy z uśpieniem — natychmiast przechodzimy do kolejnego modelu.
            if (
              allowTransient503Retry &&
              attempt === 0 &&
              !isGeminiQuotaExhaustedError(msgStr) &&
              !isGeminiTimeoutError(msgStr) &&
              /503|UNAVAILABLE/.test(msgStr)
            ) {
              await new Promise((r) => setTimeout(r, 450));
              continue;
            }
            throw err;
          } finally {
            clearTimeout(timer);
            externalSignal?.removeEventListener('abort', onExternalAbort);
          }
        }
        throw new Error('Retry exhausted');
      };

      const finishGeminiSuccess = (
        candidate: string,
        response: GenerateContentResponse,
        replyTextRaw: string,
        elapsedMs: number,
      ) => {
        noteGeminiSuccess(candidate, elapsedMs);
        flushChatSync('ai_root_tool_applied');
        let replyText = cleanReplyFor(replyTextRaw);
        const webSources = wantsWebSources ? collectWebSources(response as any) : [];
        replyText = withDirectiveReceipts(
          appendWebSources(guardUnverifiedMissionCompletion(missionVerificationContext, replyText), webSources),
        );
        const geminiBadge = `${selectedDisplayName} · Gemini (${candidate})${imageBase64 ? ' · Vision' : ''}`;
        // Zapis epizodu pamięci w tle (nie blokuje odesłania odpowiedzi do użytkownika).
        if (agentState?.canonical_name && cleanMsg) {
          void callPythonBackend(
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
          )
            .then((memRes) => {
              if (memRes.data?.event) publishOutboxEvent(memRes.data.event);
            })
            .catch(() => undefined);
        }
        const hasVerifiedToolAction = appliedActions.some((a) => a.ok);
        res.json({
          ok: true,
          sender: selectedDisplayName,
          agentId: selectedAgent,
          modelUsed: geminiBadge,
          reply: replyText,
          provenance: hasVerifiedToolAction
            ? 'server_verified'
            : webSources.length > 0
              ? 'web_sources'
              : 'model_unverified',
          ...(wantsWebSources && webSources.length === 0
            ? { verificationNote: 'Wyszukiwanie nie zwróciło źródeł — odpowiedź pochodzi z wiedzy modelu i nie została zweryfikowana.' }
            : {}),
          followUpMessages: [],
          appliedActions,
          latestServerRevision: latestActionSrvRev,
        });
      };

      const extractReplyFromResponse = async (
        candidate: string,
        response: GenerateContentResponse,
        externalSignal?: AbortSignal,
      ): Promise<string> => {
        let replyText = (response.text || '').trim();
        const executedCode = String((response as any).executableCode || '').trim();
        const executedResult = String((response as any).codeExecutionResult || '').trim();
        if (replyText && executedCode) {
          replyText +=
            `\n\n**Wykonany kod (Gemini):**\n\`\`\`python\n${executedCode.slice(0, 4000)}\n\`\`\`` +
            (executedResult ? `\n**Wynik:**\n\`\`\`\n${executedResult.slice(0, 3000)}\n\`\`\`` : '');
        }
        if (!replyText && !externalSignal?.aborted) {
          const plainRes = await callModelWithRetry(candidate, baseContents, false, false, false, externalSignal);
          replyText = (plainRes.text || '').trim();
        }
        return replyText;
      };

      const recordCandidateFailure = (candidate: string, error: unknown) => {
        const errMsg = error instanceof Error ? error.message : String(error);
        if (errMsg === 'cancelled_by_hedge_winner') return;
        if (isGeminiModelGoneError(errMsg)) markGeminiModelGone(candidate);
        else if (isGeminiQuotaExhaustedError(errMsg)) noteGeminiQuotaExhausted(candidate, errMsg);
        else if (isGeminiTimeoutError(errMsg)) noteGeminiTimeout(candidate);
        else if (isGeminiSlowOrBusyError(errMsg)) noteGeminiSlowOrBusy(candidate, errMsg);
        geminiErrors.push(`${candidate}: ${describeGeminiError(errMsg, geminiDeadline.perAttemptMs)}`);
      };

      const geminiErrors: string[] = [];

      // Dla zwykłych rozmów (bez narzędzi funkcyjnych) uruchamiamy hedged failover:
      // jeśli kandydat #1 nie odpowie w 4,5 s, równolegle startuje kandydat #2 — wygrywa szybszy!
      if (!wantsSystemTool && candidateModels.length >= 2) {
        // Drugie równoległe zapytanie zużywa limit klucza — tylko gdy pierwszy model długo milczy.
        const hedgeDelayMs = Number(process.env.GEMINI_HEDGE_DELAY_MS || 12000);
        for (let idx = 0; idx < candidateModels.length; idx += 2) {
          if (geminiDeadline.expired()) {
            geminiErrors.push('przekroczono łączny limit czasu odpowiedzi');
            break;
          }
          const primary = candidateModels[idx];
          const secondary = candidateModels[idx + 1];
          const pairCtrl = new AbortController();
          let winnerFound = false;

          const runOne = async (cand: string, isLast: boolean) => {
            const startedAt = Date.now();
            const turnContents: any[] = baseContents.map((c) => ({ role: c.role, parts: [...c.parts] }));
            const response = await callModelWithRetry(
              cand,
              turnContents,
              false,
              builtinGeminiTools.length > 0,
              isLast,
              pairCtrl.signal,
            );
            const replyText = await extractReplyFromResponse(cand, response, pairCtrl.signal);
            if (!replyText) throw new Error('pusta odpowiedź');
            return { candidate: cand, response, replyText, elapsedMs: Date.now() - startedAt };
          };

          if (!secondary) {
            try {
              const win = await runOne(primary, true);
              finishGeminiSuccess(win.candidate, win.response, win.replyText, win.elapsedMs);
              return;
            } catch (err) {
              recordCandidateFailure(primary, err);
              continue;
            }
          }

          let hedgeTimer: ReturnType<typeof setTimeout> | null = null;
          let secondaryStarted = false;
          let resolveTrigger!: () => void;
          const secondaryTrigger = new Promise<void>((resolve) => {
            resolveTrigger = resolve;
          });
          const triggerSecondary = () => {
            if (!secondaryStarted && !winnerFound && !geminiDeadline.expired()) {
              secondaryStarted = true;
              resolveTrigger();
            }
          };
          hedgeTimer = setTimeout(triggerSecondary, hedgeDelayMs);

          const p1 = runOne(primary, false).catch((err) => {
            if (!winnerFound) {
              recordCandidateFailure(primary, err);
              triggerSecondary();
            }
            throw err;
          });
          const p2 = secondaryTrigger.then(() => {
            if (winnerFound || geminiDeadline.expired()) throw new Error('cancelled_by_hedge_winner');
            return runOne(secondary, idx + 1 === candidateModels.length - 1).catch((err) => {
              if (!winnerFound) recordCandidateFailure(secondary, err);
              throw err;
            });
          });

          try {
            const win = await Promise.any([p1, p2]);
            winnerFound = true;
            if (hedgeTimer) clearTimeout(hedgeTimer);
            resolveTrigger();
            pairCtrl.abort();
            finishGeminiSuccess(win.candidate, win.response, win.replyText, win.elapsedMs);
            return;
          } catch {
            if (hedgeTimer) clearTimeout(hedgeTimer);
            resolveTrigger();
            pairCtrl.abort();
            continue;
          }
        }
      } else {
        for (let candIdx = 0; candIdx < candidateModels.length; candIdx += 1) {
          const candidate = candidateModels[candIdx];
          const isLastCandidate = candIdx === candidateModels.length - 1;
          if (geminiDeadline.expired()) {
            geminiErrors.push('przekroczono łączny limit czasu odpowiedzi');
            break;
          }
          const attemptStartedAt = Date.now();
          try {
            const turnContents: any[] = baseContents.map((c) => ({ role: c.role, parts: [...c.parts] }));
            let response: GenerateContentResponse = await callModelWithRetry(
              candidate,
              turnContents,
              wantsSystemTool,
              builtinGeminiTools.length > 0,
              isLastCandidate,
            );

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

                response = await callModelWithRetry(candidate, turnContents, true, false, isLastCandidate);
              }
            }

            const replyText = await extractReplyFromResponse(candidate, response);
            if (replyText) {
              finishGeminiSuccess(candidate, response, replyText, Date.now() - attemptStartedAt);
              return;
            }
            geminiErrors.push(`${candidate}: pusta odpowiedź`);
          } catch (error) {
            recordCandidateFailure(candidate, error);
            continue;
          }
        }
      }
      geminiFailure = geminiErrors.length
        ? summarizeGeminiFailures(geminiErrors)
        : 'żaden model Gemini nie zwrócił odpowiedzi';
      geminiFailureDetails = geminiErrors.join(' | ');
    }

    // Gemini nie odpowiedziało (albo brak klucza), a Ollamy jeszcze nie pytano — próbujemy jej,
    // zanim zgłosimy brak modelu (np. Maya na kanale z hybrydowym routerem).
    if (!shouldTryOllama && !wantsGitHubTools) {
      ollamaFailure = '';
      if (await tryOllama()) return;
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
        sender: 'Maya Mitek',
        agentId: 'Maya',
        modelUsed: 'Maya Mitek · raport SVL_System (wynik serwera)',
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
      failureReasons: { ollama: ollamaFailure || null, gemini: geminiFailure || null, geminiDetails: geminiFailureDetails || null },
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
    if (id === 'conv-agent-maya') return 'Maya Mitek — AI Statku SVL-364 (ROOT)';
    return 'Sesja SVL Python OS';
  }

  // 3b. Rozmowa obustronna bez promptów: modele dostają wyłącznie zapis rozmowy.
  // Najpierw model dopisuje „[…”, czyli sam wskazuje, kto mówi następny; potem wskazana AI
  // dopisuje swoją kwestię własnym modelem. Gdy model wskaże Operatora — AI czekają.
  const SAFETY_MAX_AI_TURNS = Number(process.env.SVL_DUPLEX_MAX_AI_TURNS || 6);
  const AUTONOMOUS_MIN_INTERVAL_MS = 3200;
  const proactiveInFlight = new Set<string>();
  const lastProactiveAt = new Map<string, number>();
  const SKIP_MESSAGES: Record<string, string> = {
    waiting_for_operator: 'Model wskazał, że teraz Twoja kolej — AI czekają na Twoją wiadomość.',
    no_decision: 'Model nie wskazał kolejnego mówcy — rozmowa czeka na Ciebie.',
    ai_turn_limit: `Bezpiecznik kosztów: ${SAFETY_MAX_AI_TURNS} wypowiedzi AI z rzędu bez Twojej wiadomości.`,
    busy: 'Inna karta lub poprzednie wywołanie właśnie generuje wypowiedź.',
    quota_cooldown: 'Limit modeli Gemini chwilowo wyczerpany — rozmowa obustronna wznowi się automatycznie.',
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
    const proactiveDeadline = createGeminiDeadline(Number(process.env.GEMINI_PROACTIVE_BUDGET_MS || 45000));
    for (const candidate of await geminiCandidatesFor(gemini, requestedModel, 8, { skipCooling: true })) {
      if (proactiveDeadline.attemptTimeout() < 3000) break;
      const startedAt = Date.now();
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
            ...geminiThinkingConfig(candidate),
            abortSignal: AbortSignal.timeout(proactiveDeadline.attemptTimeout()),
          },
        });
        noteGeminiSuccess(candidate, Date.now() - startedAt);
        // Model odpowiedział — wynik (także brak wskazania) jest decyzją; kolejne modele niepotrzebne.
        return { predicted: parsePredictedSpeaker(gen.text || ''), providerOnline: true };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        if (isGeminiModelGoneError(errMsg)) markGeminiModelGone(candidate);
        else if (isGeminiQuotaExhaustedError(errMsg)) noteGeminiQuotaExhausted(candidate, errMsg);
        else if (isGeminiTimeoutError(errMsg)) noteGeminiTimeout(candidate);
        else if (isGeminiSlowOrBusyError(errMsg)) noteGeminiSlowOrBusy(candidate, errMsg);
        else if (isThinkingConfigError(errMsg)) disableThinkingConfigFor(candidate);
        failures.push(`Gemini ${candidate}: ${describeGeminiError(errMsg, Number(process.env.GEMINI_TIMEOUT_MS || 18000))}`);
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
    const perspective = toAgentPerspective(turns, speaker, 16);
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
    const proactiveDeadline = createGeminiDeadline(Number(process.env.GEMINI_PROACTIVE_BUDGET_MS || 45000));
    for (const candidate of await geminiCandidatesFor(gemini, requestedModel, 8, { skipCooling: true })) {
      if (proactiveDeadline.attemptTimeout() < 3000) break;
      const startedAt = Date.now();
      try {
        const gen = await gemini.models.generateContent({
          model: candidate,
          contents,
          config: {
            temperature: 0.8,
            maxOutputTokens: 1100,
            ...(memoryContext ? { systemInstruction: memoryContext } : {}),
            stopSequences: ['\n[Mateusz', '\n[Operator', '\n[Bielik]:', '\n[Maya]:', '\n[Maya Mitek]:'],
            ...geminiThinkingConfig(candidate),
            abortSignal: AbortSignal.timeout(proactiveDeadline.attemptTimeout()),
          },
        });
        const text = (gen.text || '').trim();
        if (text) {
          noteGeminiSuccess(candidate, Date.now() - startedAt);
          return { text, label: `Gemini (${candidate})` };
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        if (isGeminiModelGoneError(errMsg)) markGeminiModelGone(candidate);
        else if (isGeminiQuotaExhaustedError(errMsg)) noteGeminiQuotaExhausted(candidate, errMsg);
        else if (isGeminiTimeoutError(errMsg)) noteGeminiTimeout(candidate);
        else if (isGeminiSlowOrBusyError(errMsg)) noteGeminiSlowOrBusy(candidate, errMsg);
        else if (isThinkingConfigError(errMsg)) disableThinkingConfigFor(candidate);
        failures.push(`Gemini ${candidate}: ${describeGeminiError(errMsg, Number(process.env.GEMINI_TIMEOUT_MS || 18000))}`);
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

    const skip = (reason: string, detail?: string, retryAfterMs?: number) => {
      svlFileLogger.log({
        layer: 'GATEWAY',
        level: reason === 'no_model' ? 'ERROR' : 'INFO',
        category: 'ai_proactive',
        correlationId: corrId,
        origin: String(origin || 'client'),
        message: `Rozmowa obustronna (${convId}) pominięta: ${reason}${detail ? ` — ${detail}` : ''}`,
      });
      // Pominięcie tury to zwykły wynik (klient pokazuje powód) — nie błąd HTTP w konsoli.
      res.status(reason === 'no_model' && !isAutonomous ? 503 : 200).json({
        ok: false,
        skipped: true,
        reason,
        error: detail || SKIP_MESSAGES[reason] || reason,
        ...(retryAfterMs ? { retryAfterMs } : {}),
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
      // Pomijamy dodatkowy pełny round-trip predykcji mówcy, gdy cel jest jawny lub w kanale jest 1 agent.
      if (transcript && !explicitTarget && participants.length > 1) {
        const pred = await predictNextSpeaker(
          modelFor(participants[0]), ollamaHost, transcript, participants, requestedModel, failures,
        );
        if (!pred.providerOnline) {
          const retryMs = getSoonestGeminiRetryMs();
          if (retryMs && retryMs > 0) {
            return skip(
              'quota_cooldown',
              `Limit modeli Gemini chwilowo wyczerpany — rozmowa obustronna wznowi się za ${Math.ceil(retryMs / 1000)} s. Twoje wiadomości nadal mają pierwszeństwo.`,
              retryMs,
            );
          }
          return noModel();
        }
        predicted = pred.predicted;
      } else if (explicitTarget) {
        predicted = explicitTarget;
      } else if (participants.length === 1) {
        predicted = participants[0];
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
      const speakerDisplayName = formatAgentDisplayName(speaker);
      const speakerMemoryContext = buildAgentSystemContext(
        formatMemoryPromptContext(speakerMemories, speakerDisplayName, 12),
        speakerDisplayName,
      );

      // 2) Wskazana AI dopisuje swoją kwestię własnym modelem (lub inicjuje rozmowę na pustym kanale).
      const line = await generateAgentProactiveLine(
        modelFor(speaker), ollamaHost, turns, transcript, speaker, requestedModel, speakerMemoryContext, failures,
      );
      if (!line) {
        // Wszystkie modele Gemini na karencji 429/503, a Ollamy nie ma → nie przepalamy limitu
        // w tle; mówimy, za ile spróbować (klient wstrzymuje rozmowę obustronną na ten czas).
        const retryMs = getSoonestGeminiRetryMs();
        if (retryMs && retryMs > 0) {
          return skip(
            'quota_cooldown',
            `Limit modeli Gemini chwilowo wyczerpany — rozmowa obustronna wznowi się za ${Math.ceil(retryMs / 1000)} s. Twoje wiadomości nadal mają pierwszeństwo.`,
            retryMs,
          );
        }
        return noModel();
      }
      const rawText = normalizeAiInteractiveMarkup(cleanAgentReply(line.text, speaker));
      if (!rawText || isRepetitive(rawText, turns.slice(-8).map((t) => t.content))) {
        return skip('nothing_new', `${speakerDisplayName} nie miał(a) nic nowego do powiedzenia — wypowiedź pominięta.`);
      }
      const guardedProactive = enforceFactualExecutionGuard(rawText, 0);
      const text = guardedProactive.reply;

      const assistantMsg = {
        id: `asst-proactive-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: 'assistant',
        sender: speakerDisplayName,
        agentId: speaker,
        modelUsed: `${line.label} · rozmowa obustronna`,
        provenance: 'model_unverified',
        ...(guardedProactive.verificationNote ? { verificationNote: guardedProactive.verificationNote } : {}),
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
      svlFileLogger.log({
        layer: 'GATEWAY',
        level: 'INFO',
        category: 'ai_proactive',
        correlationId: corrId,
        origin: String(origin || 'client'),
        message: `Rozmowa obustronna (${convId}): ${speaker} · ${line.label} · ${text.length} znaków`,
        details: failures.length > 0 ? { earlierFailures: failures.slice(0, 4) } : undefined,
      });
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
    const rawRelPath = typeof req.query.path === 'string' ? req.query.path.trim() : '';
    const relPath = rawRelPath || 'SVL_CoreOS_2';
    const segments = relPath.split(/[\\/]/).filter(Boolean);
    const deniedNames = new Set([
      'data', 'node_modules', 'dist', 'coverage', 'logs', 'secrets',
      '.git', '.github', '.codex', '.venv', '__pycache__',
    ]);
    const forbiddenSegment = segments.some((segment) =>
      segment === '..' ||
      (segment.startsWith('.') && segment !== '.env.example' && segment !== '.gitkeep') ||
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
      const relative = path.relative(root, targetPath).split(path.sep).join('/');
      if (!relative || relative === '..' || relative.startsWith('../') ||
          path.isAbsolute(relative) ||
          relative.split('/').some((part) =>
            (part.startsWith('.') && part !== '.env.example' && part !== '.gitkeep') ||
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
            (!item.name.startsWith('.') || item.name === '.gitkeep') &&
            !deniedNames.has(item.name.toLowerCase()) &&
            !item.isSymbolicLink()
          )
          .slice(0, 300)
          .map((item) => ({
            name: item.name,
            path: path.relative(root, path.join(targetPath, item.name)).split(path.sep).join('/'),
            type: item.isDirectory() ? 'directory' : 'file',
          }));

        // Rekurencyjna lista wszystkich plików i podkatalogów wewnątrz wybranego katalogu (np. SVL_CoreOS_2)
        const treeFiles: Array<{ name: string; path: string; size: number; type: 'file' }> = [];
        const treeDirs: Array<{ name: string; path: string; type: 'directory' }> = [];
        const walkDir = async (dirAbs: string, depth: number) => {
          if (depth > 5 || treeFiles.length >= 300) return;
          const subEntries = await fs.readdir(dirAbs, { withFileTypes: true });
          for (const sub of subEntries) {
            if ((sub.name.startsWith('.') && sub.name !== '.gitkeep') || deniedNames.has(sub.name.toLowerCase()) || sub.isSymbolicLink()) {
              continue;
            }
            const subAbs = path.join(dirAbs, sub.name);
            const subRel = path.relative(root, subAbs).split(path.sep).join('/');
            if (sub.isDirectory()) {
              treeDirs.push({ name: sub.name, path: subRel, type: 'directory' });
              await walkDir(subAbs, depth + 1);
            } else if (sub.isFile()) {
              const st = await fs.stat(subAbs);
              treeFiles.push({ name: sub.name, path: subRel, size: st.size, type: 'file' });
            }
          }
        };
        await walkDir(targetPath, 0);
        treeFiles.sort((a, b) => a.path.localeCompare(b.path));
        treeDirs.sort((a, b) => a.path.localeCompare(b.path));

        const treeContentSummary =
          `# Katalog repozytorium: ${relative}/ (${treeDirs.length} podkatalogów, ${treeFiles.length} plików)\n\n` +
          `Podkatalogi:\n` +
          (treeDirs.map((d) => `  📁 ${d.path}/`).join('\n') || '  (brak podkatalogów)') +
          `\n\nPliki (${treeFiles.length}):\n` +
          (treeFiles.map((f) => `  📄 ${f.path} (${f.size} B)`).join('\n') || '  (brak plików)');

        res.json({
          ok: true,
          kind: 'directory',
          path: relative,
          items,
          treeDirs,
          treeFiles,
          content: treeContentSummary,
        });
        return;
      }
      if (!stat.isFile() || stat.size > 256 * 1024) {
        res.status(413).json({ ok: false, error: 'Nieobsługiwany plik lub zbyt duży rozmiar.' });
        return;
      }
      const baseName = path.basename(relative);
      const permitted =
        isAllowedGitHubFilePath(relative) ||
        /\.(ts|tsx|js|jsx|mjs|cjs|py|md|json|css|html|yml|yaml|toml|sh|service|txt|log|conf|cfg|ini|sys)$/i.test(relative) ||
        /^modelfile(?:\.[a-z0-9._-]+)?$/i.test(baseName) ||
        baseName === '.env.example' ||
        baseName === '.gitkeep';
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
        // WebSocket Vite zawsze na tym samym serwerze i porcie co aplikacja. Klient Vite 8 łączy się
        // zawsze — bez serwera (port 24678) każde wczytanie strony dawało nieobsłużony błąd
        // „WebSocket closed without opened”. Przy DISABLE_HMR obserwowanie plików jest wyłączone
        // (vite.config.ts: watch null), więc połączenie nie powoduje przeładowań.
        ws: { server: httpServer },
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
        if (process.env.NODE_ENV === 'production') {
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
    stopShipOllamaTunnel();
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
    // Wstępne pobranie listy modeli Gemini w tle, żeby pierwsza wiadomość na czacie nie czekała na models.list().
    const startupAi = getGeminiClient();
    if (startupAi) {
      void discoverGeminiModels(startupAi).catch(() => undefined);
    }
    // Modele Bielika i Mayi ładowane do pamięci Ollamy zaraz po starcie (i ponownie co 10 min,
    // np. po restarcie Ollamy) — pierwsza odpowiedź nie czeka na wczytanie modelu z dysku.
    const warmupOff = ['0', 'false', 'no'].includes(String(process.env.OLLAMA_WARMUP || '').trim().toLowerCase());
    if (!warmupOff) {
      setTimeout(() => void warmConfiguredOllamaModels(), 8000).unref();
      setInterval(() => void warmConfiguredOllamaModels(), 10 * 60_000).unref();
    }
  });
}

startServer();
