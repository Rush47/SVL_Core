import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GoogleGenAI } from '@google/genai';
import {
  buildFreeInteractionTools,
  executeWorkspaceListTool,
  executeWorkspaceReadTool,
  extractInteractionSteps,
  resolveFreeGeminiModel,
  resolveSafeWorkspacePath,
  runAntigravityTask,
} from './antigravityEngine.ts';

test('resolveFreeGeminiModel only permits free-tier models and defaults to gemini-4-hydrogen', () => {
  assert.equal(resolveFreeGeminiModel('gemini-4-hydrogen'), 'gemini-4-hydrogen');
  assert.equal(resolveFreeGeminiModel('gemini-3.1-flash-lite'), 'gemini-3.1-flash-lite');
  assert.equal(resolveFreeGeminiModel('gemini-4-carbon'), 'gemini-4-hydrogen');
  assert.equal(resolveFreeGeminiModel('antigravity-preview-09-2026'), 'gemini-4-hydrogen');
  assert.equal(resolveFreeGeminiModel(undefined), 'gemini-4-hydrogen');
});

test('workspace path guard blocks traversal and secret files while allowing normal source reads', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svl-ag-ws-'));
  try {
    fs.writeFileSync(path.join(root, '.env'), 'GITHUB_TOKEN=secret\n', 'utf8');
    fs.writeFileSync(path.join(root, 'notes.txt'), 'line1\nline2\n', 'utf8');

    assert.equal(resolveSafeWorkspacePath(root, '../etc/passwd').ok, false);
    assert.equal(resolveSafeWorkspacePath(root, '.env').ok, false);
    assert.equal(resolveSafeWorkspacePath(root, 'data/token.secret').ok, false);

    const listRes = executeWorkspaceListTool(root, '.');
    assert.equal(listRes.ok, true);
    assert.match(listRes.output, /notes\.txt/);
    assert.doesNotMatch(listRes.output, /\.env/);

    const readOk = executeWorkspaceReadTool(root, 'notes.txt');
    assert.equal(readOk.ok, true);
    assert.match(readOk.output, /line1/);

    const readSecret = executeWorkspaceReadTool(root, '.env');
    assert.equal(readSecret.ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('extractInteractionSteps extracts thoughts, search, narrowed code_execution, function_calls, and combined model_output', () => {
  const extracted = extractInteractionSteps([
    { type: 'thought', summary: [{ type: 'text', text: 'Sprawdzam stan jądra.' }] },
    { type: 'google_search_call', arguments: { queries: ['debian 13 trixie release'] } },
    { type: 'code_execution_result', result: [{ type: 'text', text: '42' }] },
    { type: 'function_call', id: 'fc-1', name: 'run_linux_command', arguments: { command: 'uname -a' } },
    { type: 'model_output', content: [{ type: 'text', text: 'Część 1.' }] },
    { type: 'model_output', content: [{ type: 'text', text: 'Część 2.' }] },
  ]);

  assert.equal(extracted.outputText, 'Część 1.\n\nCzęść 2.');
  assert.equal(extracted.functionCalls.length, 1);
  assert.equal(extracted.functionCalls[0].name, 'run_linux_command');
  assert.equal(extracted.proofSteps.some((s) => s.type === 'thought' && s.detail.includes('Sprawdzam stan')), true);
  assert.equal(extracted.proofSteps.some((s) => s.type === 'google_search'), true);
  assert.equal(extracted.proofSteps.some((s) => s.type === 'code_execution' && s.detail === '42'), true);
});

test('runAntigravityTask executes multi-turn function_call -> function_result loop and chains previous_interaction_id', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svl-ag-loop-'));
  const calls: Array<Record<string, unknown>> = [];
  const shellCommands: string[] = [];

  const fakeAi = {
    interactions: {
      create: async (payload: Record<string, unknown>) => {
        calls.push(payload);
        if (calls.length === 1) {
          return {
            id: 'int_round_1',
            usage: { total_tokens: 120 },
            steps: [
              { type: 'thought', summary: [{ type: 'text', text: 'Wykonam polecenie uname.' }] },
              { type: 'function_call', id: 'call_1', name: 'run_linux_command', arguments: { command: 'uname -s' } },
            ],
          };
        }
        return {
          id: 'int_round_2',
          usage: { total_tokens: 80 },
          steps: [
            { type: 'model_output', content: [{ type: 'text', text: 'System operacyjny to Linux (zweryfikowano).' }] },
          ],
        };
      },
    },
  } as unknown as GoogleGenAI;

  try {
    const result = await runAntigravityTask(
      {
        prompt: 'Sprawdź jądro Linux',
        engine: 'gemini-interactions',
        model: 'gemini-4-hydrogen',
        tools: { googleSearch: true, workspaceTools: true },
      },
      {
        projectRoot: root,
        getGeminiClient: () => fakeAi,
        ollamaHost: () => 'http://127.0.0.1:11434',
        ollamaDefaultModel: () => 'llama3.2-vision:11b',
        runShell: async (command) => {
          shellCommands.push(command);
          return { ok: true, exitCode: 0, stdout: 'Linux\n', stderr: '' };
        },
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.interactionId, 'int_round_2');
    assert.equal(result.outputText, 'System operacyjny to Linux (zweryfikowano).');
    assert.equal(result.usage?.totalTokens, 200);
    assert.deepEqual(shellCommands, ['uname -s']);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].previous_interaction_id, 'int_round_1');
    assert.ok(Array.isArray(calls[1].tools), 'tools must be re-specified on each interaction turn');
    assert.deepEqual(calls[1].input, [
      {
        type: 'function_result',
        call_id: 'call_1',
        name: 'run_linux_command',
        result: 'Linux',
        is_error: false,
      },
    ]);
    assert.equal(result.steps.some((s) => s.type === 'function_result' && s.detail === 'Linux'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runAntigravityTask propagates real API errors without simulated fallback and supports Ollama mode', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svl-ag-err-'));
  const failingAi = {
    interactions: {
      create: async () => {
        const err: any = new Error('429 RESOURCE_EXHAUSTED');
        err.status = 429;
        throw err;
      },
    },
  } as unknown as GoogleGenAI;

  try {
    const errRes = await runAntigravityTask(
      { prompt: 'Test', engine: 'gemini-interactions' },
      {
        projectRoot: root,
        getGeminiClient: () => failingAi,
        ollamaHost: () => 'http://127.0.0.1:11434',
        ollamaDefaultModel: () => 'llama3.2-vision:11b',
        runShell: async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '' }),
      },
    );
    assert.equal(errRes.ok, false);
    assert.equal(errRes.statusCode, 429);
    assert.match(String(errRes.error), /429/);

    const fakeFetch = (async () =>
      new Response(JSON.stringify({ model: 'qwen2.5:14b', message: { content: 'Odpowiedź lokalna Ollama' }, eval_count: 42 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;

    const ollamaRes = await runAntigravityTask(
      { prompt: 'Cześć', engine: 'ollama', model: 'qwen2.5:14b' },
      {
        projectRoot: root,
        getGeminiClient: () => null,
        ollamaHost: () => 'http://127.0.0.1:11434',
        ollamaDefaultModel: () => 'qwen2.5:14b',
        runShell: async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '' }),
        fetcher: fakeFetch,
      },
    );
    assert.equal(ollamaRes.ok, true);
    assert.equal(ollamaRes.engine, 'ollama');
    assert.equal(ollamaRes.outputText, 'Odpowiedź lokalna Ollama');
    assert.equal(buildFreeInteractionTools({ googleSearch: true, urlContext: true, workspaceTools: false }).length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
