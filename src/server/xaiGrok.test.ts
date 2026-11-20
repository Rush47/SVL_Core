import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_XAI_MODEL,
  DEFAULT_XAI_TIMEOUT_MS,
  XAI_API_BASE,
  completeXaiChat,
  getXaiApiKey,
  getXaiModel,
  getXaiTimeoutMs,
  XAI_CREDITS_EXHAUSTED_MESSAGE,
  getSvlChatEngine,
  isXaiAuthOrBillingStatus,
  isXaiConfigured,
  isXaiCreditsExhaustedError,
  isXaiRetryableStatus,
  scrubXaiSecrets,
  shouldAttemptGrok,
} from './xaiGrok.ts';

const REAL_LOOKING_KEY = 'xai-test-secret-key-ABCDEFGHIJKLMNOP-9000';

async function withEnvAsync(overrides: Record<string, string | undefined>, fn: () => Promise<void>) {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    prev[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

test('isXaiConfigured rejects empty and placeholder keys', () => {
  for (const value of ['', '   ', 'short', 'changeme', 'YOUR_XAI_API_KEY', 'my_xai_api_key', 'placeholder', 'xxx', 'XAI_API_KEY']) {
    assert.equal(isXaiConfigured({ XAI_API_KEY: value }), false, `should reject ${JSON.stringify(value)}`);
    assert.equal(getXaiApiKey({ XAI_API_KEY: value }), null);
  }
  assert.equal(isXaiConfigured({}), false);
  assert.equal(isXaiConfigured({ XAI_API_KEY: REAL_LOOKING_KEY }), true);
  assert.equal(getXaiApiKey({ XAI_API_KEY: `  ${REAL_LOOKING_KEY}  ` }), REAL_LOOKING_KEY);
});

test('getXaiModel and timeout use defaults when unset', () => {
  assert.equal(getXaiModel({}), DEFAULT_XAI_MODEL);
  assert.equal(getXaiModel({ XAI_MODEL: 'grok-4' }), 'grok-4');
  assert.equal(getXaiTimeoutMs({}), DEFAULT_XAI_TIMEOUT_MS);
  assert.equal(getXaiTimeoutMs({ XAI_TIMEOUT_MS: '90000' }), 90000);
  assert.equal(getXaiTimeoutMs({ XAI_TIMEOUT_MS: 'nope' }), DEFAULT_XAI_TIMEOUT_MS);
  assert.equal(isXaiRetryableStatus(429), true);
  assert.equal(isXaiRetryableStatus(503), true);
  assert.equal(isXaiRetryableStatus(401), false);
  assert.equal(isXaiRetryableStatus(403), false);
  assert.equal(isXaiRetryableStatus(400), false);
  assert.equal(isXaiCreditsExhaustedError(403, 'permission-denied: The team of the api key does not have any credits or has exceeded their spending limit'), true);
  assert.equal(isXaiCreditsExhaustedError(403, '{"error":{"type":"permission_denied","message":"spending limit"}}'), true);
  assert.equal(isXaiCreditsExhaustedError(402, 'Payment Required'), true);
  assert.equal(isXaiCreditsExhaustedError(403, 'model is not available to this key'), false);
  assert.equal(isXaiCreditsExhaustedError(401, 'invalid api key'), false);
});

test('SVL_CHAT_ENGINE=ollama skips Grok even when a key is set; 401/402/403 fall back to Ollama', () => {
  const opts = { explicitOllama: false, explicitGemini: false, webSearchViaGemini: false };
  assert.equal(getSvlChatEngine({}), 'auto');
  assert.equal(getSvlChatEngine({ SVL_CHAT_ENGINE: 'OLLAMA' }), 'ollama');
  assert.equal(getSvlChatEngine({ SVL_CHAT_ENGINE: 'local' }), 'ollama');
  assert.equal(getSvlChatEngine({ SVL_CHAT_ENGINE: 'grok' }), 'grok');
  assert.equal(getSvlChatEngine({ SVL_CHAT_ENGINE: 'xai' }), 'grok');
  assert.equal(getSvlChatEngine({ SVL_CHAT_ENGINE: 'cos-innego' }), 'auto');
  assert.equal(shouldAttemptGrok({ XAI_API_KEY: REAL_LOOKING_KEY }, opts), true);
  assert.equal(shouldAttemptGrok({ XAI_API_KEY: REAL_LOOKING_KEY, SVL_CHAT_ENGINE: 'ollama' }, opts), false);
  assert.equal(shouldAttemptGrok({ XAI_API_KEY: REAL_LOOKING_KEY, SVL_CHAT_ENGINE: 'grok' }, opts), true);
  assert.equal(shouldAttemptGrok({ XAI_API_KEY: '' }, opts), false);
  assert.equal(shouldAttemptGrok({ XAI_API_KEY: REAL_LOOKING_KEY }, { ...opts, explicitOllama: true }), false);
  assert.equal(isXaiAuthOrBillingStatus(401), true);
  assert.equal(isXaiAuthOrBillingStatus(402), true);
  assert.equal(isXaiAuthOrBillingStatus(403), true);
  assert.equal(isXaiAuthOrBillingStatus(429), false);
  assert.equal(isXaiAuthOrBillingStatus(500), false);
  assert.equal(isXaiAuthOrBillingStatus(undefined), false);
});

test('completeXaiChat skips the network when no key is configured', async () => {
  let called = 0;
  const fetchImpl: typeof fetch = async () => {
    called += 1;
    throw new Error('network should not be used');
  };
  const result = await completeXaiChat({
    messages: [{ role: 'user', content: 'hello' }],
    env: { XAI_API_KEY: '' },
    fetchImpl,
    sleep: async () => undefined,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'brak klucza XAI_API_KEY');
  }
  assert.equal(called, 0);
});

test('completeXaiChat retries retryable 429/5xx then succeeds, and never leaks the key', async () => {
  await withEnvAsync({ XAI_API_KEY: REAL_LOOKING_KEY, XAI_MODEL: 'grok-4.7' }, async () => {
    const statuses: number[] = [];
    const delays: number[] = [];
    let seenAuth = '';
    let seenUrl = '';
    const fetchImpl: typeof fetch = async (input, init) => {
      seenUrl = String(input);
      const auth = String((init?.headers as any)?.Authorization || (init?.headers as any)?.authorization || '');
      seenAuth = auth;
      const attempt = statuses.length;
      if (attempt === 0) {
        statuses.push(429);
        return new Response(JSON.stringify({ error: { message: `rate limited for ${REAL_LOOKING_KEY}` } }), { status: 429 });
      }
      if (attempt === 1) {
        statuses.push(503);
        return new Response('temporary overload', { status: 503 });
      }
      statuses.push(200);
      return new Response(
        JSON.stringify({
          model: 'grok-4.7',
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Cześć z Groka' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    const result = await completeXaiChat({
      messages: [{ role: 'user', content: 'hej' }],
      fetchImpl,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.text, 'Cześć z Groka');
      assert.equal(result.model, 'grok-4.7');
      assert.deepEqual(result.toolCalls, []);
    }
    assert.deepEqual(statuses, [429, 503, 200]);
    assert.deepEqual(delays, [500, 1500]);
    assert.equal(seenUrl, `${XAI_API_BASE}/chat/completions`);
    assert.match(seenAuth, new RegExp(`^Bearer ${REAL_LOOKING_KEY}$`));
    assert.equal(JSON.stringify(result).includes(REAL_LOOKING_KEY), false);
    assert.doesNotMatch(JSON.stringify(result), /Bearer /);
  });
});

test('completeXaiChat stops after retries on 5xx and scrubs the key from the reason', async () => {
  await withEnvAsync({ XAI_API_KEY: REAL_LOOKING_KEY }, async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      calls += 1;
      assert.equal(String(input), `${XAI_API_BASE}/chat/completions`);
      return new Response(JSON.stringify({ error: { message: `boom ${REAL_LOOKING_KEY}` } }), { status: 500 });
    };
    const result = await completeXaiChat({
      messages: [{ role: 'user', content: 'ping' }],
      fetchImpl,
      sleep: async () => undefined,
    });
    assert.equal(result.ok, false);
    assert.equal(calls, 3);
    if (!result.ok) {
      assert.equal(result.status, 500);
      assert.equal(result.retryable, true);
      assert.doesNotMatch(result.reason, new RegExp(REAL_LOOKING_KEY));
      assert.match(result.reason, /\[REDACTED\]|HTTP 500/);
    }
    assert.equal(JSON.stringify(result).includes(REAL_LOOKING_KEY), false);
    const leaked = scrubXaiSecrets(`Authorization: Bearer ${REAL_LOOKING_KEY}`, REAL_LOOKING_KEY);
    assert.doesNotMatch(leaked, new RegExp(REAL_LOOKING_KEY));
    assert.match(leaked, /Bearer \[REDACTED\]/);
  });
});

test('completeXaiChat does not retry 401 and does not leak the key', async () => {
  await withEnvAsync({ XAI_API_KEY: REAL_LOOKING_KEY }, async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: `invalid key ${REAL_LOOKING_KEY}` } }), { status: 401 });
    };
    const result = await completeXaiChat({
      messages: [{ role: 'user', content: 'ping' }],
      fetchImpl,
      sleep: async () => {
        throw new Error('should not sleep on 401');
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 401);
      assert.equal(result.retryable, false);
      assert.doesNotMatch(result.reason, new RegExp(REAL_LOOKING_KEY));
    }
  });
});

test('completeXaiChat treats 403 credits/spending-limit as non-retryable Polish failure', async () => {
  await withEnvAsync({ XAI_API_KEY: REAL_LOOKING_KEY }, async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          error: {
            type: 'permission_denied',
            message: `The team of the api key does not have any credits or has exceeded their spending limit (${REAL_LOOKING_KEY})`,
          },
        }),
        { status: 403 },
      );
    };
    const result = await completeXaiChat({
      messages: [{ role: 'user', content: 'ping' }],
      fetchImpl,
      sleep: async () => {
        throw new Error('should not sleep or retry a 403 credits error');
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 403);
      assert.equal(result.retryable, false);
      assert.equal(result.reason, XAI_CREDITS_EXHAUSTED_MESSAGE);
      assert.doesNotMatch(result.reason, new RegExp(REAL_LOOKING_KEY));
    }
    assert.equal(JSON.stringify(result).includes(REAL_LOOKING_KEY), false);
  });
});
