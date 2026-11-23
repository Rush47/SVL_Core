import fs from 'node:fs';
import path from 'node:path';
import type { GoogleGenAI } from '@google/genai';

export type AntigravityEngineMode = 'gemini-interactions' | 'ollama';

export const FREE_GEMINI_INTERACTION_MODELS = [
  'gemini-4-hydrogen',
  'gemini-3.1-flash-lite',
] as const;

export type FreeGeminiInteractionModel = (typeof FREE_GEMINI_INTERACTION_MODELS)[number];

export interface AntigravityToolFlags {
  googleSearch?: boolean;
  urlContext?: boolean;
  workspaceTools?: boolean;
}

export interface AntigravityProofStep {
  id: string;
  type:
    | 'thought'
    | 'google_search'
    | 'url_context'
    | 'function_call'
    | 'function_result'
    | 'code_execution'
    | 'model_output';
  title: string;
  detail: string;
  status: 'ok' | 'error';
}

export interface AntigravityRunRequest {
  prompt: string;
  engine?: AntigravityEngineMode;
  model?: string;
  previousInteractionId?: string | null;
  tools?: AntigravityToolFlags;
  thinkingLevel?: 'low' | 'medium' | 'high';
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface AntigravityRunResult {
  ok: boolean;
  engine: AntigravityEngineMode;
  model: string;
  interactionId: string | null;
  outputText: string;
  steps: AntigravityProofStep[];
  usage?: {
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
  durationMs: number;
  error?: string;
  statusCode?: number;
}

export interface AntigravityShellResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface AntigravityRuntimeDeps {
  projectRoot: string;
  getGeminiClient: () => GoogleGenAI | null;
  ollamaHost: () => string;
  ollamaDefaultModel: () => string;
  runShell: (command: string) => Promise<AntigravityShellResult>;
  scrubOutput?: (text: string) => string;
  fetcher?: typeof fetch;
}

const FORBIDDEN_WORKSPACE_RE =
  /(^|\/)\.env($|\.)|\.secret$|\.pem$|\.key$|id_rsa|id_ed25519|\.sqlite3|\.db($|-)|\.svl_operator_token|github_rest_sync_ledger\.json$/i;

const SKIP_LIST_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '__pycache__',
  '.playwright-cli',
  '.aistudio',
]);

export function resolveSafeWorkspacePath(projectRoot: string, rawPath: string): { ok: true; absPath: string; relPath: string } | { ok: false; error: string } {
  const root = path.resolve(projectRoot);
  const cleaned = String(rawPath || '.').trim().replace(/^\/+/, '');
  const candidate = path.resolve(root, cleaned || '.');
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    return { ok: false, error: 'Ścieżka wykracza poza katalog roboczy projektu.' };
  }
  const relPath = path.relative(root, candidate).replace(/\\/g, '/');
  if (relPath && FORBIDDEN_WORKSPACE_RE.test(relPath)) {
    return { ok: false, error: `Dostęp do pliku wrażliwego (${relPath}) jest zablokowany.` };
  }
  return { ok: true, absPath: candidate, relPath: relPath || '.' };
}

export function executeWorkspaceListTool(projectRoot: string, dirPath = '.'): { ok: boolean; output: string } {
  const resolved = resolveSafeWorkspacePath(projectRoot, dirPath);
  if (!resolved.ok) return { ok: false, output: resolved.error };
  try {
    const stat = fs.statSync(resolved.absPath);
    if (!stat.isDirectory()) {
      return { ok: false, output: `Ścieżka ${resolved.relPath} nie jest katalogiem.` };
    }
    const entries = fs.readdirSync(resolved.absPath, { withFileTypes: true })
      .filter((entry) => !SKIP_LIST_DIRS.has(entry.name) && !FORBIDDEN_WORKSPACE_RE.test(entry.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .slice(0, 120)
      .map((entry) => `${entry.isDirectory() ? '[DIR] ' : '[FILE]'} ${entry.name}`);
    return {
      ok: true,
      output: entries.length > 0 ? entries.join('\n') : '(pusty katalog)',
    };
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
}

export function executeWorkspaceReadTool(
  projectRoot: string,
  filePath: string,
  maxLines = 120,
  scrubOutput?: (text: string) => string,
): { ok: boolean; output: string } {
  const resolved = resolveSafeWorkspacePath(projectRoot, filePath);
  if (!resolved.ok) return { ok: false, output: resolved.error };
  try {
    const stat = fs.statSync(resolved.absPath);
    if (!stat.isFile()) {
      return { ok: false, output: `Ścieżka ${resolved.relPath} nie jest plikiem.` };
    }
    if (stat.size > 512 * 1024) {
      return { ok: false, output: `Plik ${resolved.relPath} przekracza limit odczytu 512 KB.` };
    }
    const buf = fs.readFileSync(resolved.absPath);
    if (buf.includes(0)) {
      return { ok: false, output: `Plik ${resolved.relPath} jest binarny (${buf.length} B).` };
    }
    const clampedLines = Math.max(10, Math.min(250, Math.floor(Number(maxLines) || 120)));
    const lines = buf.toString('utf8').split(/\r?\n/);
    const slice = lines.slice(0, clampedLines).join('\n');
    const rawOut = lines.length > clampedLines
      ? `${slice}\n... (obcięto: pokazano ${clampedLines} z ${lines.length} linii)`
      : slice;
    return {
      ok: true,
      output: (scrubOutput ? scrubOutput(rawOut) : rawOut).slice(0, 12000),
    };
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
}

export function extractInteractionSteps(steps: unknown): {
  proofSteps: AntigravityProofStep[];
  outputText: string;
  functionCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
} {
  const arr = Array.isArray(steps) ? steps : [];
  const proofSteps: AntigravityProofStep[] = [];
  const functionCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
  let outputText = '';
  let idx = 0;

  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const step = raw as Record<string, any>;
    const type = String(step.type || '');
    idx += 1;
    const stepId = `step-${idx}-${type || 'unknown'}`;

    if (type === 'thought') {
      const summaryArr = Array.isArray(step.summary) ? step.summary : [];
      const thoughtText = summaryArr
        .map((part: any) => (part && typeof part.text === 'string' ? part.text : ''))
        .join('')
        .trim();
      if (thoughtText) {
        proofSteps.push({
          id: stepId,
          type: 'thought',
          title: 'Rozumowanie agenta',
          detail: thoughtText.slice(0, 1800),
          status: 'ok',
        });
      }
      continue;
    }

    if (type === 'google_search_call') {
      const queries = Array.isArray(step.arguments?.queries)
        ? step.arguments.queries.map(String).join(' · ')
        : JSON.stringify(step.arguments || {});
      proofSteps.push({
        id: stepId,
        type: 'google_search',
        title: 'Wyszukiwarka Google',
        detail: queries.slice(0, 600),
        status: 'ok',
      });
      continue;
    }

    if (type === 'google_search_result') {
      const results = Array.isArray(step.result) ? step.result : [];
      const titles = results
        .map((r: any) => (r?.title ? `${r.title}${r.url ? ` (${r.url})` : ''}` : r?.url || ''))
        .filter(Boolean)
        .slice(0, 6);
      if (titles.length > 0) {
        proofSteps.push({
          id: stepId,
          type: 'google_search',
          title: `Źródła Google (${titles.length})`,
          detail: titles.join('\n'),
          status: 'ok',
        });
      }
      continue;
    }

    if (type === 'url_context_call' || type === 'url_context_result') {
      const detail =
        typeof step.arguments?.urls !== 'undefined'
          ? JSON.stringify(step.arguments.urls)
          : typeof step.result === 'string'
            ? step.result.slice(0, 800)
            : JSON.stringify(step.result || step.arguments || {}).slice(0, 800);
      proofSteps.push({
        id: stepId,
        type: 'url_context',
        title: type === 'url_context_call' ? 'Odczyt URL' : 'Wynik kontekstu URL',
        detail,
        status: 'ok',
      });
      continue;
    }

    if (type === 'code_execution_call' || type === 'code_execution_result') {
      let detail = '';
      if (type === 'code_execution_call') {
        detail = String(step.arguments?.code || JSON.stringify(step.arguments || {})).slice(0, 1400);
      } else if (typeof step.result === 'string') {
        detail = step.result.slice(0, 1400);
      } else if (Array.isArray(step.result)) {
        detail = step.result
          .map((c: any) => (c && typeof c.text === 'string' ? c.text : ''))
          .filter(Boolean)
          .join('\n')
          .slice(0, 1400);
      }
      proofSteps.push({
        id: stepId,
        type: 'code_execution',
        title: type === 'code_execution_call' ? 'Wykonanie kodu' : 'Wynik wykonania kodu',
        detail: detail || '(brak wyjścia)',
        status: step.is_error ? 'error' : 'ok',
      });
      continue;
    }

    if (type === 'function_call') {
      const callId = String(step.id || `call-${idx}`);
      const name = String(step.name || 'unknown_tool');
      const args = (step.arguments && typeof step.arguments === 'object' ? step.arguments : {}) as Record<string, unknown>;
      functionCalls.push({ id: callId, name, arguments: args });
      proofSteps.push({
        id: stepId,
        type: 'function_call',
        title: `Narzędzie: ${name}`,
        detail: JSON.stringify(args).slice(0, 600),
        status: 'ok',
      });
      continue;
    }

    if (type === 'model_output') {
      const contents = Array.isArray(step.content) ? step.content : [];
      for (const part of contents) {
        if (part && part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
          outputText += (outputText ? '\n\n' : '') + part.text;
        }
      }
    }
  }

  return { proofSteps, outputText: outputText.trim(), functionCalls };
}

export function buildFreeInteractionTools(flags: AntigravityToolFlags): Array<Record<string, unknown>> {
  const tools: Array<Record<string, unknown>> = [];
  if (flags.googleSearch) {
    tools.push({ type: 'google_search' });
  }
  if (flags.urlContext) {
    tools.push({ type: 'url_context' });
  }
  if (flags.workspaceTools !== false) {
    tools.push(
      {
        type: 'function',
        name: 'list_workspace_files',
        description: 'List files and directories inside the SVL_Core project workspace.',
        parameters: {
          type: 'object',
          properties: {
            dirPath: {
              type: 'string',
              description: 'Relative directory path inside the project (default ".").',
            },
          },
        },
      },
      {
        type: 'function',
        name: 'read_workspace_file',
        description: 'Read a text source file from the SVL_Core workspace (secrets like .env are blocked).',
        parameters: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Relative file path inside the workspace, e.g. "package.json" or "backend/real_telemetry.py".',
            },
            maxLines: {
              type: 'number',
              description: 'Maximum lines to return (10-250, default 120).',
            },
          },
          required: ['filePath'],
        },
      },
      {
        type: 'function',
        name: 'run_linux_command',
        description: 'Execute a Linux command in the local SVL Debian 13 environment (account jyn_root) and return stdout/stderr.',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'Shell command to run (e.g., "uname -a", "df -h", "git status").',
            },
          },
          required: ['command'],
        },
      },
    );
  }
  return tools;
}

export function resolveFreeGeminiModel(requested?: string): FreeGeminiInteractionModel {
  const cleaned = String(requested || '').trim();
  if ((FREE_GEMINI_INTERACTION_MODELS as readonly string[]).includes(cleaned)) {
    return cleaned as FreeGeminiInteractionModel;
  }
  return 'gemini-4-hydrogen';
}

const ANTIGRAVITY_SYSTEM_INSTRUCTION =
  'Jesteś autonomicznym agentem inżynieryjnym Antigravity (tryb bez płatnego klucza) w systemie SVL Python OS (Debian 13 / konto jyn_root). ' +
  'Odpowiadaj zwięźle i rzeczowo po polsku. Korzystaj z dostępnych narzędzi (list_workspace_files, read_workspace_file, run_linux_command, Google Search, URL Context), aby zawsze weryfikować fakty przed odpowiedzią. ' +
  'Nigdy nie wymyślaj wyników poleceń ani zawartości plików; podawaj wyłącznie prawdziwe dane z narzędzi.';

function parseGeminiApiError(err: unknown): { message: string; statusCode: number } {
  const raw = err instanceof Error ? err.message : String(err || 'Nieznany błąd API Gemini');
  const status = Number((err as any)?.status || (err as any)?.statusCode || 0);
  if (status === 403 || /PERMISSION_DENIED/i.test(raw)) {
    return {
      statusCode: 403,
      message: 'Brak uprawnień klucza Gemini API (403 PERMISSION_DENIED). Sprawdź GEMINI_API_KEY w Settings > Secrets.',
    };
  }
  if (status === 429 || /RESOURCE_EXHAUSTED/i.test(raw)) {
    return {
      statusCode: 429,
      message: 'Przekroczono darmowy limit zapytań Gemini API (429 RESOURCE_EXHAUSTED). Spróbuj ponownie za chwilę lub przełącz silnik na lokalną Ollamę.',
    };
  }
  if (status === 400 && /API_KEY_INVALID/i.test(raw)) {
    return {
      statusCode: 400,
      message: 'Nieprawidłowy klucz GEMINI_API_KEY (400 API_KEY_INVALID). Sprawdź Settings > Secrets.',
    };
  }
  return {
    statusCode: status >= 400 && status < 600 ? status : 502,
    message: raw.slice(0, 500),
  };
}

export async function runAntigravityTask(
  req: AntigravityRunRequest,
  deps: AntigravityRuntimeDeps,
): Promise<AntigravityRunResult> {
  const started = Date.now();
  const prompt = String(req.prompt || '').trim();
  const engine: AntigravityEngineMode = req.engine === 'ollama' ? 'ollama' : 'gemini-interactions';

  if (!prompt) {
    return {
      ok: false,
      engine,
      model: req.model || 'gemini-4-hydrogen',
      interactionId: req.previousInteractionId || null,
      outputText: '',
      steps: [],
      durationMs: Date.now() - started,
      error: 'Wpisz zadanie dla agenta Antigravity.',
      statusCode: 400,
    };
  }

  // Tryb lokalnej Ollamy (100% lokalny, zero zewnętrznych kluczy)
  if (engine === 'ollama') {
    const base = deps.ollamaHost().replace(/\/+$/, '');
    const model = String(req.model || deps.ollamaDefaultModel() || 'llama3.2-vision:11b').trim();
    const fetcher = deps.fetcher || fetch;
    const messages = [
      { role: 'system', content: ANTIGRAVITY_SYSTEM_INSTRUCTION },
      ...(Array.isArray(req.history) ? req.history.slice(-8) : []),
      { role: 'user', content: prompt },
    ];
    try {
      const response = await fetcher(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: false }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        return {
          ok: false,
          engine,
          model,
          interactionId: null,
          outputText: '',
          steps: [],
          durationMs: Date.now() - started,
          error: `Ollama (${base}) zwróciła HTTP ${response.status}${errText ? `: ${errText.slice(0, 220)}` : ''}.`,
          statusCode: 502,
        };
      }
      const data = (await response.json()) as Record<string, any>;
      const text = String(data?.message?.content || data?.response || '').trim();
      const totalTokens =
        typeof data?.prompt_eval_count === 'number' || typeof data?.eval_count === 'number'
          ? Number(data?.prompt_eval_count || 0) + Number(data?.eval_count || 0)
          : undefined;
      return {
        ok: true,
        engine,
        model: String(data?.model || model),
        interactionId: null,
        outputText: text || '(Ollama zwróciła pustą odpowiedź)',
        steps: [
          {
            id: 'ollama-1',
            type: 'model_output',
            title: `Lokalna Ollama (${String(data?.model || model)})`,
            detail: `Wykonano lokalnie pod adresem ${base}`,
            status: 'ok',
          },
        ],
        usage: totalTokens ? { totalTokens } : undefined,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      return {
        ok: false,
        engine,
        model,
        interactionId: null,
        outputText: '',
        steps: [],
        durationMs: Date.now() - started,
        error: `Ollama (${base}) jest nieosiągalna: ${err instanceof Error ? err.message : String(err)}`,
        statusCode: 503,
      };
    }
  }

  // Tryb darmowego Gemini Interactions API (gemini-4-hydrogen / gemini-3.1-flash-lite)
  const ai = deps.getGeminiClient();
  const model = resolveFreeGeminiModel(req.model);
  if (!ai) {
    return {
      ok: false,
      engine,
      model,
      interactionId: req.previousInteractionId || null,
      outputText: '',
      steps: [],
      durationMs: Date.now() - started,
      error: 'Brak klucza GEMINI_API_KEY po stronie serwera. Skonfiguruj klucz w Settings > Secrets lub przełącz silnik na lokalną Ollamę.',
      statusCode: 503,
    };
  }

  const tools = buildFreeInteractionTools(req.tools || { googleSearch: true, urlContext: false, workspaceTools: true });
  const generationConfig: Record<string, unknown> = {};
  if (model === 'gemini-4-hydrogen' && req.thinkingLevel && ['low', 'medium', 'high'].includes(req.thinkingLevel)) {
    generationConfig.thinking_level = req.thinkingLevel;
  }

  const allProofSteps: AntigravityProofStep[] = [];
  let combinedOutput = '';
  let previousId: string | undefined = req.previousInteractionId ? String(req.previousInteractionId) : undefined;
  let nextInput: unknown = prompt;
  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const maxRounds = 6;

  try {
    for (let round = 0; round < maxRounds; round += 1) {
      const payload: Record<string, unknown> = {
        model,
        input: nextInput,
        system_instruction: ANTIGRAVITY_SYSTEM_INSTRUCTION,
      };
      if (previousId) {
        payload.previous_interaction_id = previousId;
      }
      if (tools.length > 0) {
        payload.tools = tools;
      }
      if (Object.keys(generationConfig).length > 0) {
        payload.generation_config = generationConfig;
      }

      const interaction: any = await (ai as any).interactions.create(payload);
      if (interaction?.id) {
        previousId = String(interaction.id);
      }
      if (interaction?.usage) {
        totalTokens += Number(interaction.usage.total_tokens || 0);
        inputTokens += Number(interaction.usage.total_input_tokens || interaction.usage.input_tokens || 0);
        outputTokens += Number(interaction.usage.total_output_tokens || interaction.usage.output_tokens || 0);
      }

      const extracted = extractInteractionSteps(interaction?.steps);
      allProofSteps.push(...extracted.proofSteps);
      if (extracted.outputText) {
        combinedOutput += (combinedOutput ? '\n\n' : '') + extracted.outputText;
      } else if (!extracted.functionCalls.length && typeof interaction?.output_text === 'string' && interaction.output_text.trim()) {
        combinedOutput += (combinedOutput ? '\n\n' : '') + interaction.output_text.trim();
      }

      if (extracted.functionCalls.length === 0) {
        break;
      }

      // Wykonaj prawdziwe wywołania narzędzi SVL (workspace + powłoka Linux jyn_root)
      const toolResults: Array<Record<string, unknown>> = [];
      for (const call of extracted.functionCalls) {
        let toolOk = true;
        let toolOut = '';
        if (call.name === 'list_workspace_files') {
          const r = executeWorkspaceListTool(deps.projectRoot, String(call.arguments?.dirPath || '.'));
          toolOk = r.ok;
          toolOut = r.output;
        } else if (call.name === 'read_workspace_file') {
          const r = executeWorkspaceReadTool(
            deps.projectRoot,
            String(call.arguments?.filePath || ''),
            Number(call.arguments?.maxLines || 120),
            deps.scrubOutput,
          );
          toolOk = r.ok;
          toolOut = r.output;
        } else if (call.name === 'run_linux_command') {
          const cmd = String(call.arguments?.command || '').trim();
          if (!cmd) {
            toolOk = false;
            toolOut = 'Brak polecenia do wykonania.';
          } else {
            const shellRes = await deps.runShell(cmd);
            toolOk = shellRes.ok && shellRes.exitCode === 0;
            const rawJoined = [shellRes.stdout, shellRes.stderr].filter(Boolean).join('\n').trim() || `(exit=${shellRes.exitCode})`;
            toolOut = (deps.scrubOutput ? deps.scrubOutput(rawJoined) : rawJoined).slice(0, 8000);
          }
        } else {
          toolOk = false;
          toolOut = `Nieznane narzędzie: ${call.name}`;
        }

        allProofSteps.push({
          id: `tool-res-${round}-${call.id}`,
          type: 'function_result',
          title: `Wynik: ${call.name}`,
          detail: toolOut.slice(0, 1200),
          status: toolOk ? 'ok' : 'error',
        });

        toolResults.push({
          type: 'function_result',
          call_id: call.id,
          name: call.name,
          result: toolOut,
          is_error: !toolOk,
        });
      }

      nextInput = toolResults;
    }

    return {
      ok: true,
      engine,
      model,
      interactionId: previousId || null,
      outputText: combinedOutput.trim() || '(Agent zakończył pracę bez tekstu wynikowego)',
      steps: allProofSteps,
      usage: totalTokens > 0 ? { totalTokens, inputTokens, outputTokens } : undefined,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    const parsed = parseGeminiApiError(err);
    return {
      ok: false,
      engine,
      model,
      interactionId: previousId || null,
      outputText: combinedOutput.trim(),
      steps: allProofSteps,
      durationMs: Date.now() - started,
      error: parsed.message,
      statusCode: parsed.statusCode,
    };
  }
}
