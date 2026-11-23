import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGeminiDeadline,
  describeGeminiError,
  diversify,
  geminiCandidatesFor,
  geminiThinkingConfig,
  isGeminiModelGoneError,
  isGeminiQuotaExhaustedError,
  isGeminiSlowOrBusyError,
  isGeminiTimeoutError,
  isThinkingConfigError,
  noteGeminiQuotaExhausted,
  noteGeminiSuccess,
  noteGeminiTimeout,
  rankGeminiChatModels,
  resetGeminiModelHealth,
} from './geminiModels.ts';

test('rankGeminiChatModels keeps only chat models and prefers fast, stable, newer ones', () => {
  const ranked = rankGeminiChatModels([
    { name: 'models/gemini-2.0-pro', supportedActions: ['generateContent'] },
    { name: 'models/gemini-3-flash-preview', supportedActions: ['generateContent'] },
    { name: 'models/gemini-3.5-flash', supportedActions: ['generateContent', 'countTokens'] },
    { name: 'models/gemini-3.5-flash-lite', supportedActions: ['generateContent'] },
    { name: 'models/text-embedding-004', supportedActions: ['embedContent'] },
    { name: 'models/gemini-3.5-flash-image', supportedActions: ['generateContent'] },
    { name: 'models/gemini-embedding-001', supportedActions: ['embedContent'] },
    { name: 'models/gemini-flash-latest', supportedActions: ['generateContent'] },
  ]);
  assert.deepEqual(ranked, [
    'gemini-flash-latest',
    'gemini-3.5-flash',
    'gemini-3-flash-preview',
    'gemini-3.5-flash-lite',
    'gemini-2.0-pro',
  ]);
});

test('Gemini errors from the screenshot are recognised and described readably', () => {
  const notFound = '{"error":{"code":404,"message":"models/gemini-3-flash-preview is not found for API version v1, or is not supported for generateContent","status":"NOT_FOUND"}}';
  const retired = '{"error":{"code":404,"message":"This model models/gemini-2.5-flash is no longer available to new users. Please update your code"}}';
  assert.equal(isGeminiModelGoneError(notFound), true);
  assert.equal(isGeminiModelGoneError(retired), true);
  assert.equal(isGeminiModelGoneError('This operation was aborted'), false);
  assert.equal(isGeminiQuotaExhaustedError('429: You exceeded your current quota'), true);
  assert.equal(isGeminiQuotaExhaustedError('503: high demand'), false);
  assert.equal(isGeminiTimeoutError('The operation was aborted due to timeout'), true);
  assert.match(describeGeminiError(retired), /^404: This model models\/gemini-2\.5-flash is no longer available/);
  assert.equal(describeGeminiError('This operation was aborted', 30000), 'przekroczono limit czasu (30 s)');
});

test('diversify puts a fast flash-lite right after the newest flash, not four slow flash models in a row', () => {
  const prev = process.env.GEMINI_MODEL;
  delete process.env.GEMINI_MODEL;
  try {
    assert.deepEqual(
      diversify(['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-flash-latest']),
      ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-flash-latest', 'gemini-3.7-flash', 'gemini-3.6-flash'],
    );
  } finally {
    if (prev !== undefined) process.env.GEMINI_MODEL = prev;
  }
  assert.equal(isGeminiSlowOrBusyError('503: This model is currently experiencing high demand.'), true);
  assert.equal(isGeminiSlowOrBusyError('This operation was aborted'), true);
  assert.equal(isGeminiSlowOrBusyError('404: not found'), false);
  assert.deepEqual(geminiThinkingConfig('gemini-3.8-flash'), { thinkingConfig: { thinkingLevel: 'LOW' } });
  assert.equal(isThinkingConfigError('400 INVALID_ARGUMENT: thinking_level is not supported'), true);
});

test('geminiCandidatesFor prioritizes proven-fast working models and demotes 429/timed-out models', async () => {
  resetGeminiModelHealth();
  const prev = process.env.GEMINI_MODEL;
  delete process.env.GEMINI_MODEL;
  const mockClient = {
    models: {
      list: async () => ({
        async *[Symbol.asyncIterator]() {
          yield { name: 'models/gemini-3.8-flash', supportedActions: ['generateContent'] };
          yield { name: 'models/gemini-3.5-flash-lite', supportedActions: ['generateContent'] };
          yield { name: 'models/gemini-3.1-flash-lite', supportedActions: ['generateContent'] };
          yield { name: 'models/gemini-flash-lite-latest', supportedActions: ['generateContent'] };
        },
      }),
    },
  };

  try {
    noteGeminiQuotaExhausted('gemini-3.8-flash');
    noteGeminiTimeout('gemini-3.5-flash-lite');
    noteGeminiSuccess('gemini-3.1-flash-lite', 2400);

    const top5 = await geminiCandidatesFor(mockClient, 'svl-hybrid-router', 5);
    assert.equal(top5[0], 'gemini-3.1-flash-lite');
    assert.ok(top5.indexOf('gemini-3.8-flash') === -1 || top5.indexOf('gemini-3.8-flash') > 0);
    assert.ok(top5.indexOf('gemini-3.5-flash-lite') === -1 || top5.indexOf('gemini-3.5-flash-lite') > 0);

    const all = await geminiCandidatesFor(mockClient, 'svl-hybrid-router', 10);
    assert.equal(all[0], 'gemini-3.1-flash-lite');
    assert.ok(all.indexOf('gemini-3.8-flash') > all.indexOf('gemini-3.1-flash-lite'));
    assert.ok(all.indexOf('gemini-3.5-flash-lite') > all.indexOf('gemini-3.1-flash-lite'));
  } finally {
    if (prev !== undefined) process.env.GEMINI_MODEL = prev;
    resetGeminiModelHealth();
  }
});

test('createGeminiDeadline uses fast 20s per-attempt and 55s total default budgets and MINIMAL thinking on flash-lite', () => {
  const prevTotal = process.env.GEMINI_TOTAL_BUDGET_MS;
  const prevTimeout = process.env.GEMINI_TIMEOUT_MS;
  const prevThinking = process.env.GEMINI_THINKING_LEVEL;
  delete process.env.GEMINI_TOTAL_BUDGET_MS;
  delete process.env.GEMINI_TIMEOUT_MS;
  delete process.env.GEMINI_THINKING_LEVEL;
  try {
    assert.deepEqual(geminiThinkingConfig('gemini-3.1-flash-lite'), { thinkingConfig: { thinkingLevel: 'MINIMAL' } });
    assert.deepEqual(geminiThinkingConfig('gemini-3.8-flash'), { thinkingConfig: { thinkingLevel: 'LOW' } });
    const deadline = createGeminiDeadline();
    const attempt = deadline.attemptTimeout();
    const remaining = deadline.remaining();
    assert.ok(attempt > 17000 && attempt <= 20000, `expected <=20000ms attempt timeout, got ${attempt}`);
    assert.ok(remaining > 52000 && remaining <= 55000, `expected <=55000ms total budget, got ${remaining}`);
  } finally {
    if (prevTotal !== undefined) process.env.GEMINI_TOTAL_BUDGET_MS = prevTotal;
    if (prevTimeout !== undefined) process.env.GEMINI_TIMEOUT_MS = prevTimeout;
    if (prevThinking !== undefined) process.env.GEMINI_THINKING_LEVEL = prevThinking;
  }
});

test('isGeminiChatModelName przepuszcza tylko modele czatu (z logów AI Studio)', async () => {
  const {
    isGeminiChatModelName,
    isGeminiTemperatureSupported,
    isGeminiToolSchemaError,
    sanitizeGeminiToolDeclarations,
  } = await import('./geminiModels.ts');
  for (const ok of ['gemini-4-hydrogen', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-3.1-flash-lite-preview', 'gemini-3.1-pro-preview', 'models/gemini-2.5-flash']) {
    assert.equal(isGeminiChatModelName(ok), true, ok);
  }
  for (const bad of ['gemini-3.5-transcribe', 'gemini-nano-banana-2.1', 'gemini-omni-1.1-flash', 'gemini-omni-flash-preview', 'gemini-4-neon', 'gemini-4-carbon', 'gemini-4-argon', 'gemini-3.1-pro-preview-customtools', 'gemini-embedding-001']) {
    assert.equal(isGeminiChatModelName(bad), false, bad);
  }
  assert.equal(isGeminiTemperatureSupported('gemini-4-hydrogen'), false);
  assert.equal(isGeminiTemperatureSupported('gemini-3.1-flash-lite'), true);
  assert.deepEqual(geminiThinkingConfig('gemini-4-hydrogen'), { thinkingConfig: { thinkingLevel: 'LOW' } });
  assert.equal(isGeminiToolSchemaError('400 INVALID_ARGUMENT: parameters.properties: should be non-empty for OBJECT type'), true);
  assert.equal(isGeminiToolSchemaError('400 INVALID_ARGUMENT: Duplicate function declaration name: svl_set_avatar'), true);

  const cleaned = sanitizeGeminiToolDeclarations([
    { name: 'svl_system_status', description: 'status', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'svl_set_avatar', description: 'first', parameters: { type: 'OBJECT', properties: { agent: { type: 'STRING' } } } },
    { name: 'svl_set_avatar', description: 'duplicate', parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' } } } },
  ]);
  assert.equal(cleaned.length, 2);
  assert.equal('parameters' in cleaned[0], false);
  assert.equal(cleaned[1].description, 'first');
});

test('diversify stawia modele pro na końcu (darmowy limit zwraca dla nich 429)', async () => {
  const { diversify } = await import('./geminiModels.ts');
  const out = diversify(['gemini-3.1-pro-preview', 'gemini-3.6-flash', 'gemini-pro-latest', 'gemini-3.5-flash-lite', 'gemini-flash-latest']);
  assert.deepEqual(out.slice(-2).sort(), ['gemini-3.1-pro-preview', 'gemini-pro-latest']);
});

test('parseGeminiRetryDelayMs i summarizeGeminiFailures', async () => {
  const { parseGeminiRetryDelayMs, summarizeGeminiFailures } = await import('./geminiModels.ts');
  assert.equal(parseGeminiRetryDelayMs('{"error":{"code":429,"details":[{"retryDelay":"37s"}]}}'), 37000);
  assert.equal(parseGeminiRetryDelayMs('Please retry in 12.5s.'), 12500);
  assert.equal(parseGeminiRetryDelayMs('503 high demand'), null);
  const summary = summarizeGeminiFailures([
    'gemini-3.8-flash: 429: You exceeded your current quota',
    'gemini-flash-latest: 429: You exceeded your current quota',
    'gemini-3.5-flash-lite: przekroczono limit czasu (20 s)',
  ]);
  assert.match(summary, /wyczerpany limit klucza API \(429\) w 2 modelach/);
  assert.match(summary, /darmowy limit klucza Gemini jest wyczerpany/);
});

test('stan modeli (wycofane i karencje) przetrwa restart', async () => {
  const gm = await import('./geminiModels.ts');
  const files = new Map<string, string>();
  const fakeFs = { readFileSync: (p: string) => { const v = files.get(p); if (v === undefined) throw new Error('ENOENT'); return v; }, writeFileSync: (p: string, d: string) => void files.set(p, d) };
  gm.resetGeminiModelHealth();
  gm.setGeminiModelStatePath('/stan.json', fakeFs);
  gm.markGeminiModelGone('gemini-2.5-flash');
  gm.noteGeminiQuotaExhausted('gemini-3.8-flash', '429 quota retryDelay: "40s"');
  gm.resetGeminiModelHealth();
  gm.setGeminiModelStatePath('/stan.json', fakeFs);
  const saved = JSON.parse(files.get('/stan.json') as string);
  assert.deepEqual(saved.gone, ['gemini-2.5-flash']);
  assert.ok(saved.cooling['gemini-3.8-flash'] > Date.now() + 30_000);
  gm.setGeminiModelStatePath(null);
  gm.resetGeminiModelHealth();
});

test('geminiCandidatesFor skipCooling pomija modele na karencji, a getSoonestGeminiRetryMs podaje czas', async () => {
  const gm = await import('./geminiModels.ts');
  gm.resetGeminiModelHealth();
  const fakeClient = {
    models: {
      list: async () => ({
        async *[Symbol.asyncIterator]() {
          for (const n of ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-flash-latest']) {
            yield { name: 'models/' + n, supportedActions: ['generateContent'] };
          }
        },
      }),
    },
  };
  gm.noteGeminiQuotaExhausted('gemini-3.6-flash', '429 quota retryDelay: "40s"');
  const retry = gm.getSoonestGeminiRetryMs();
  assert.ok(retry && retry > 30_000 && retry <= 40_000, `retry=${retry}`);
  const withCooling = await gm.geminiCandidatesFor(fakeClient, '', 8);
  assert.ok(withCooling.includes('gemini-3.6-flash'), 'domyślnie model na karencji jest na końcu listy');
  const skipped = await gm.geminiCandidatesFor(fakeClient, '', 8, { skipCooling: true });
  assert.ok(!skipped.includes('gemini-3.6-flash'), 'skipCooling pomija model na karencji');
  gm.resetGeminiModelHealth();
});

test('geminiCandidatesFor domyślnie zwraca do 16 modeli i rozpoznaje przejściowy 503 bez mylenia z 429', async () => {
  const gm = await import('./geminiModels.ts');
  gm.resetGeminiModelHealth();
  const pool = [
    'gemini-flash-latest', 'gemini-4-hydrogen', 'gemini-3.8-flash', 'gemini-3.7-flash',
    'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-3-flash-preview',
    'gemini-flash-lite-latest', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite',
    'gemini-3.1-flash-lite-preview', 'gemini-pro-latest', 'gemini-2.5-pro', 'gemini-3.1-pro-preview',
  ];
  const fakeClient = {
    models: {
      list: async () => ({
        async *[Symbol.asyncIterator]() {
          for (const n of pool) yield { name: 'models/' + n, supportedActions: ['generateContent'] };
        },
      }),
    },
  };
  const candidates = await gm.geminiCandidatesFor(fakeClient, 'svl-hybrid-router');
  assert.ok(candidates.length >= 15, `expected >=15 candidates by default, got ${candidates.length}`);
  assert.ok(candidates.includes('gemini-3.7-flash'));
  assert.ok(candidates.includes('gemini-3.6-flash'));
  assert.equal(gm.isGeminiTransient503Error('503 UNAVAILABLE: high demand'), true);
  assert.equal(gm.isGeminiTransient503Error('429 RESOURCE_EXHAUSTED: quota exceeded'), false);
  gm.resetGeminiModelHealth();
});

