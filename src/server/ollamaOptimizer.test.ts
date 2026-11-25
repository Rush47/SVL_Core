import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCompactOllamaSystemContext,
  warmOllamaModels,
  clearOllamaReadyCache,
  getOllamaRuntimeOptions,
  isAutoGitSyncAllowed,
  resolveCachedOllamaModel,
  selectChatMaxOutputTokens,
  selectOllamaTurnOptions,
  shouldEnableGitHubToolsForMessage,
  trimHistoryForOllama,
} from './ollamaOptimizer';

test('isAutoGitSyncAllowed is false by default even if interval is configured', () => {
  assert.equal(isAutoGitSyncAllowed({}), false);
  assert.equal(isAutoGitSyncAllowed({ SVL_GITHUB_AUTOSYNC_SEC: '120' }), false);
  assert.equal(
    isAutoGitSyncAllowed({ SVL_GITHUB_AUTOSYNC_SEC: '120', SVL_ALLOW_AUTO_GIT_SYNC: '0' }),
    false,
  );
  assert.equal(
    isAutoGitSyncAllowed({ SVL_GITHUB_AUTOSYNC_SEC: '120', SVL_ALLOW_AUTO_GIT_SYNC: '1' }),
    true,
  );
});

test('getOllamaRuntimeOptions returns fast tuned defaults and respects overrides', () => {
  const defaults = getOllamaRuntimeOptions({});
  assert.equal(defaults.num_ctx, 2048);
  assert.equal(defaults.num_predict, 768);
  assert.equal(defaults.keep_alive, -1);
  assert.deepEqual(defaults.perf, {});
  assert.equal(defaults.historyTurns, 12);
  assert.equal(defaults.maxTurnChars, 2000);

  const custom = getOllamaRuntimeOptions({
    OLLAMA_NUM_CTX: '4096',
    OLLAMA_NUM_PREDICT: '1024',
    OLLAMA_KEEP_ALIVE: '45m',
    OLLAMA_HISTORY_TURNS: '8',
    OLLAMA_MAX_TURN_CHARS: '1500',
  });
  assert.equal(custom.num_ctx, 4096);
  assert.equal(custom.num_predict, 1024);
  assert.equal(custom.keep_alive, '45m');
  assert.deepEqual(getOllamaRuntimeOptions({ OLLAMA_KEEP_ALIVE: '-1', OLLAMA_NUM_THREAD: '16', OLLAMA_NUM_GPU: '999', OLLAMA_USE_MLOCK: '1' }).perf, {
    num_thread: 16,
    num_gpu: 999,
    use_mlock: true,
  });
  assert.equal(getOllamaRuntimeOptions({ OLLAMA_KEEP_ALIVE: '-1' }).keep_alive, -1);
  assert.equal(custom.historyTurns, 8);
  assert.equal(custom.maxTurnChars, 1500);
});

test('trimHistoryForOllama keeps most recent turns and truncates oversized messages', () => {
  const turns = Array.from({ length: 20 }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: i === 19 ? 'x'.repeat(500) : `msg-${i}`,
  }));
  const trimmed = trimHistoryForOllama(turns, 4, 200);
  assert.equal(trimmed.length, 4);
  assert.equal(trimmed[0].content, 'msg-16');
  assert.equal(trimmed[2].content, 'msg-18');
  assert.equal(trimmed[3].content.length, 200);
  assert.ok(trimmed[3].content.endsWith('…'));
});

test('resolveCachedOllamaModel caches version/tags probes within TTL and invalidates on clear', async () => {
  clearOllamaReadyCache();
  let fetchCalls = 0;
  const mockFetch = (async (url: string) => {
    fetchCalls += 1;
    if (String(url).endsWith('/api/version')) {
      return new Response(JSON.stringify({ version: '0.6.5' }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ models: [{ name: 'llama3.2-vision:11b' }, { name: 'bielik:11b' }] }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const first = await resolveCachedOllamaModel('http://127.0.0.1:11434', 'bielik:11b', {
    fetchImpl: mockFetch,
    ttlMs: 30_000,
  });
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.equal(first.model, 'bielik:11b');
    assert.equal(first.cached, false);
  }
  assert.equal(fetchCalls, 2);

  const second = await resolveCachedOllamaModel('http://127.0.0.1:11434', 'llama3.2-vision:11b', {
    fetchImpl: mockFetch,
    ttlMs: 30_000,
  });
  assert.equal(second.ok, true);
  if (second.ok) {
    assert.equal(second.model, 'llama3.2-vision:11b');
    assert.equal(second.cached, true);
  }
  assert.equal(fetchCalls, 2);

  clearOllamaReadyCache('http://127.0.0.1:11434');
  const third = await resolveCachedOllamaModel('http://127.0.0.1:11434', 'bielik:11b', {
    fetchImpl: mockFetch,
    ttlMs: 30_000,
  });
  assert.equal(third.ok, true);
  assert.equal(fetchCalls, 4);
});

test('resolveCachedOllamaModel negatively caches unreachable Ollama hosts within offlineTtlMs', async () => {
  clearOllamaReadyCache();
  let fetchCalls = 0;
  const offlineFetch = (async () => {
    fetchCalls += 1;
    throw new Error('fetch failed');
  }) as unknown as typeof fetch;

  const first = await resolveCachedOllamaModel('http://127.0.0.1:11434', 'bielik:11b', {
    fetchImpl: offlineFetch,
    offlineTtlMs: 15_000,
  });
  assert.equal(first.ok, false);
  assert.equal(fetchCalls, 2);

  const second = await resolveCachedOllamaModel('http://127.0.0.1:11434', 'bielik:11b', {
    fetchImpl: offlineFetch,
    offlineTtlMs: 15_000,
  });
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.cached, true);
  assert.equal(fetchCalls, 2);
});

test('shouldEnableGitHubToolsForMessage skips normal chat and activates for GitHub/repo/file tasks', () => {
  assert.equal(shouldEnableGitHubToolsForMessage('Cześć Maya Mitek, jak się masz?', true), false);
  assert.equal(shouldEnableGitHubToolsForMessage('Zrób krótką tabelę z planem dnia', true), false);
  assert.equal(shouldEnableGitHubToolsForMessage('Sprawdź ostatnie commity na GitHub', true), true);
  assert.equal(shouldEnableGitHubToolsForMessage('Utwórz nowy plik w SVL_CoreOS_2/test.md', true), true);
  assert.equal(shouldEnableGitHubToolsForMessage('Sprawdź ostatnie commity na GitHub', false), false);
});

test('selectChatMaxOutputTokens keeps normal chat concise and expands for detailed/code requests', () => {
  assert.equal(selectChatMaxOutputTokens('Cześć, jaki jest status?'), 1100);
  assert.equal(selectChatMaxOutputTokens('Napisz skrypt bash do instalacji i pełny raport'), 2400);
});

test('warmOllamaModels ładuje każdy model raz z keep_alive i raportuje błędy', async () => {
  const calls: any[] = [];
  const fakeFetch = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.model === 'zly:model') return new Response('{}', { status: 404 });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const res = await warmOllamaModels('http://ollama:11434/', ['a:1', 'a:1', 'zly:model', ''], { fetchImpl: fakeFetch });
  assert.deepEqual(res.map((r) => [r.model, r.ok]), [['a:1', true], ['zly:model', false]]);
  assert.equal(calls[0].keep_alive, -1);
  assert.equal(calls[0].prompt, '');
});

test('selectOllamaTurnOptions tunes short, normal, detailed and tool turns while keeping num_batch fast', () => {
  const base = getOllamaRuntimeOptions({});
  const shortOpts = selectOllamaTurnOptions('Cześć Jyn!', base, { env: {} });
  assert.equal(shortOpts.num_predict, 160);
  assert.equal(shortOpts.historyTurns, 8);
  assert.equal(shortOpts.maxTurnChars, 1200);
  assert.equal(shortOpts.perf.num_batch, 512);

  const detailedOpts = selectOllamaTurnOptions('Napisz szczegółowy raport i kod skryptu dla jądra', base, { env: {} });
  assert.equal(detailedOpts.num_predict, 1536);

  const toolOpts = selectOllamaTurnOptions('Sprawdź status', base, { env: {}, hasTools: true });
  assert.equal(toolOpts.num_ctx, 2048);
  assert.equal(selectOllamaTurnOptions('Raport', base, { env: {}, estimatedPromptChars: 9000 }).num_ctx, 2048);
});

test('buildCompactOllamaSystemContext strips volatile per-turn telemetry so Ollama KV cache prefix hits', () => {
  const turn1 =
    '[TRYB JYN ROOT]\n\n[JEDI OMNI-OS v12 VM (CZAS RZECZYWISTY · ROOT_UNRESTRICTED): latency=5120ns, scenario=#111, pkt=0xAAA, processed=10.]\n' +
    'cykle_wykonane=12, aktywne_moduły_SQLite(34)=[a, b, c, d]';
  const turn2 =
    '[TRYB JYN ROOT]\n\n[JEDI OMNI-OS v12 VM (CZAS RZECZYWISTY · ROOT_UNRESTRICTED): latency=9876ns, scenario=#999, pkt=0xBBB, processed=11.]\n' +
    'cykle_wykonane=13, aktywne_moduły_SQLite(34)=[a, b, c, d]';
  const c1 = buildCompactOllamaSystemContext(turn1);
  const c2 = buildCompactOllamaSystemContext(turn2);
  assert.equal(c1, c2);
  assert.ok(!c1.includes('latency='));
  assert.ok(c1.includes('aktywne_moduły_SQLite=34'));
});
