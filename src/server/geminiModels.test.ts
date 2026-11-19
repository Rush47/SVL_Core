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
