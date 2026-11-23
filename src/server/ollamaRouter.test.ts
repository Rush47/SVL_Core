import test from 'node:test';
import assert from 'node:assert/strict';
import { clearOllamaReadyCache } from './ollamaOptimizer.ts';
import {
  buildApexCreatePayload,
  buildOllamaEndpoints,
  formatGeminiBadge,
  formatOllamaBadge,
  isShipPreferredModel,
  parseOllamaModelSpec,
  resolveOllamaAcrossEndpoints,
  resolveShipOllamaBaseUrl,
  selectBaseModelForApex,
  shouldAllowExplicitOllamaFallbackToGemini,
} from './ollamaRouter.ts';
import { parseShipOllamaTunnelEnv } from './shipOllamaTunnel.ts';

test('parseOllamaModelSpec rozpoznaje jawne węzły, modele statku, router i Gemini', () => {
  const apex = parseOllamaModelSpec('ollama:svl364-apex-uncensored:latest');
  assert.equal(apex.kind, 'ollama');
  assert.equal(apex.modelName, 'svl364-apex-uncensored:latest');
  assert.equal(apex.preferredEndpoint, 'ship');
  assert.equal(apex.strictEndpoint, false);

  const shipScoped = parseOllamaModelSpec('ollama:ship:dolphin-llama3:70b');
  assert.equal(shipScoped.kind, 'ollama');
  assert.equal(shipScoped.modelName, 'dolphin-llama3:70b');
  assert.equal(shipScoped.preferredEndpoint, 'ship');
  assert.equal(shipScoped.strictEndpoint, true);

  const localScoped = parseOllamaModelSpec('ollama:local:qwen2.5:7b');
  assert.equal(localScoped.kind, 'ollama');
  assert.equal(localScoped.modelName, 'qwen2.5:7b');
  assert.equal(localScoped.preferredEndpoint, 'local');
  assert.equal(localScoped.strictEndpoint, true);

  const gem = parseOllamaModelSpec('gemini-2.5-flash');
  assert.equal(gem.kind, 'gemini');
  assert.equal(gem.modelName, 'gemini-2.5-flash');

  const router = parseOllamaModelSpec('svl-hybrid-router');
  assert.equal(router.kind, 'router');
});

test('isShipPreferredModel identyfikuje modele SVL-364 i duże modele GPU', () => {
  assert.equal(isShipPreferredModel('svl364-apex-uncensored:latest'), true);
  assert.equal(isShipPreferredModel('dolphin-mixtral:8x22b'), true);
  assert.equal(isShipPreferredModel('dolphin-llama3:70b'), true);
  assert.equal(isShipPreferredModel('qwen2.5:7b'), false);
});

test('shouldAllowExplicitOllamaFallbackToGemini jest domyślnie false (brak cichego przełączenia na Gemini)', () => {
  assert.equal(shouldAllowExplicitOllamaFallbackToGemini({}), false);
  assert.equal(shouldAllowExplicitOllamaFallbackToGemini({ SVL_ALLOW_EXPLICIT_OLLAMA_GEMINI_FALLBACK: '0' }), false);
  assert.equal(shouldAllowExplicitOllamaFallbackToGemini({ SVL_ALLOW_EXPLICIT_OLLAMA_GEMINI_FALLBACK: '1' }), true);
});

test('buildOllamaEndpoints utrzymuje jednocześnie lokalną Ollamę (11434) i drugą Ollamę statku (11435 / SSH)', () => {
  const cfg = parseShipOllamaTunnelEnv({
    SVL_SHIP_OLLAMA: '1',
    SVL_SSH_TARGET: 'Ship',
    SVL_SHIP_OLLAMA_LOCAL_PORT: '11435',
  });
  const endpoints = buildOllamaEndpoints({
    primaryHost: 'http://127.0.0.1:11434',
    env: {},
    shipTunnel: { cfg, status: 'up' },
  });
  assert.equal(endpoints.length, 2);
  assert.equal(endpoints[0].id, 'local');
  assert.equal(endpoints[0].host, 'http://127.0.0.1:11434');
  assert.equal(endpoints[1].id, 'ship');
  assert.equal(endpoints[1].host, 'http://127.0.0.1:11435');
  assert.match(endpoints[1].label, /SVL-364/);
});

test('buildOllamaEndpoints deduplikuje gdy tunel statku zajmuje ten sam port 11434 i obsługuje SVL_SHIP_OLLAMA_URL', () => {
  const cfgSame = parseShipOllamaTunnelEnv({ SVL_SHIP_OLLAMA: '1', SVL_SHIP_OLLAMA_LOCAL_PORT: '11434' });
  const samePort = buildOllamaEndpoints({
    primaryHost: 'http://127.0.0.1:11434',
    env: {},
    shipTunnel: { cfg: cfgSame, status: 'up' },
    includeDefaultSecondaryPort: false,
  });
  assert.equal(samePort.length, 1);
  assert.equal(samePort[0].id, 'ship');

  const cfgOff = parseShipOllamaTunnelEnv({});
  const withUrl = buildOllamaEndpoints({
    primaryHost: 'http://127.0.0.1:11434',
    env: { SVL_SHIP_OLLAMA_URL: 'http://10.0.0.50:11434' },
    shipTunnel: { cfg: cfgOff, status: 'off' },
  });
  assert.equal(withUrl.length, 2);
  assert.equal(withUrl[1].id, 'ship');
  assert.equal(withUrl[1].host, 'http://10.0.0.50:11434');
  assert.equal(resolveShipOllamaBaseUrl({ env: { SVL_SHIP_OLLAMA_URL: 'http://10.0.0.50:11434' }, shipTunnelCfg: cfgOff }), 'http://10.0.0.50:11434');
});

test('resolveOllamaAcrossEndpoints wybiera drugą Ollamę (SSH), gdy ma dokładny svl364-apex-uncensored:latest zamiast podmieniać lokalnym modelem', async () => {
  clearOllamaReadyCache();
  const cfg = parseShipOllamaTunnelEnv({
    SVL_SHIP_OLLAMA: '1',
    SVL_SHIP_OLLAMA_LOCAL_PORT: '11435',
  });
  const endpoints = buildOllamaEndpoints({
    primaryHost: 'http://127.0.0.1:11434',
    env: {},
    shipTunnel: { cfg, status: 'up' },
  });

  const mockFetch = (async (url: string) => {
    const u = String(url);
    if (u.startsWith('http://127.0.0.1:11434/api/version')) {
      return new Response(JSON.stringify({ version: '0.6.5' }), { status: 200 });
    }
    if (u.startsWith('http://127.0.0.1:11434/api/tags')) {
      return new Response(JSON.stringify({ models: [{ name: 'qwen2.5:7b' }] }), { status: 200 });
    }
    if (u.startsWith('http://127.0.0.1:11435/api/version')) {
      return new Response(JSON.stringify({ version: '0.6.8' }), { status: 200 });
    }
    if (u.startsWith('http://127.0.0.1:11435/api/tags')) {
      return new Response(
        JSON.stringify({ models: [{ name: 'svl364-apex-uncensored:latest' }, { name: 'dolphin-llama3:70b' }] }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected ${u}`);
  }) as unknown as typeof fetch;

  const res = await resolveOllamaAcrossEndpoints(endpoints, 'svl364-apex-uncensored:latest', {
    fetchImpl: mockFetch,
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.endpoint.id, 'ship');
    assert.equal(res.endpoint.host, 'http://127.0.0.1:11435');
    assert.equal(res.model, 'svl364-apex-uncensored:latest');
    assert.equal(res.exactMatch, true);
    assert.equal(res.substituted, false);
  }
});

test('resolveOllamaAcrossEndpoints spada na lokalną Ollamę z jawnym substituted=true, gdy statek offline a lokalna działa', async () => {
  clearOllamaReadyCache();
  const cfg = parseShipOllamaTunnelEnv({
    SVL_SHIP_OLLAMA: '1',
    SVL_SHIP_OLLAMA_LOCAL_PORT: '11435',
  });
  const endpoints = buildOllamaEndpoints({
    primaryHost: 'http://127.0.0.1:11434',
    env: {},
    shipTunnel: { cfg, status: 'down' },
  });

  const mockFetch = (async (url: string) => {
    const u = String(url);
    if (u.startsWith('http://127.0.0.1:11435')) {
      throw new Error('ECONNREFUSED');
    }
    if (u.endsWith('/api/version')) {
      return new Response(JSON.stringify({ version: '0.6.5' }), { status: 200 });
    }
    return new Response(JSON.stringify({ models: [{ name: 'dolphin-llama3:8b-v2.9-q2_K' }] }), { status: 200 });
  }) as unknown as typeof fetch;

  const res = await resolveOllamaAcrossEndpoints(endpoints, 'svl364-apex-uncensored:latest', {
    fetchImpl: mockFetch,
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.endpoint.id, 'local');
    assert.equal(res.model, 'dolphin-llama3:8b-v2.9-q2_K');
    assert.equal(res.substituted, true);
  }
});

test('formatOllamaBadge i formatGeminiBadge uczciwie rozróżniają Ollamę od Gemini', () => {
  const exact = formatOllamaBadge({
    speakerName: 'Jyn Mitek',
    endpointLabel: 'Statek SVL-364 (SSH)',
    actualModel: 'svl364-apex-uncensored:latest',
    roleTag: 'ROOT',
  });
  assert.equal(exact, 'Jyn Mitek · Ollama [Statek SVL-364 (SSH)] (svl364-apex-uncensored:latest · ROOT)');
  assert.ok(!exact.includes('Gemini'));

  const sub = formatOllamaBadge({
    speakerName: 'Jyn Mitek',
    endpointLabel: 'Lokalna',
    actualModel: 'dolphin-llama3:8b',
    requestedModel: 'svl364-apex-uncensored:latest',
    substituted: true,
    roleTag: 'ROOT',
  });
  assert.match(sub, /zamiennik za svl364-apex-uncensored:latest/);
  assert.ok(!sub.includes('Gemini'));

  const gemFallback = formatGeminiBadge({
    speakerName: 'Jyn Mitek',
    geminiModel: 'gemini-2.5-flash',
    isFallbackFromOllama: true,
  });
  assert.match(gemFallback, /Gemini \(gemini-2\.5-flash · fallback, Ollama niedostępna\)/);
  assert.ok(!gemFallback.includes('svl364-apex-uncensored'));
});

test('selectBaseModelForApex i buildApexCreatePayload budują poprawny payload /api/create', () => {
  assert.equal(
    selectBaseModelForApex(['svl364-apex-uncensored:latest', 'qwen2.5:7b', 'dolphin-llama3:8b-v2.9-q2_K']),
    'dolphin-llama3:8b-v2.9-q2_K',
  );
  assert.equal(
    selectBaseModelForApex(['llama3.2-vision:11b', 'dolphin-llama3:70b']),
    'dolphin-llama3:70b',
  );
  const payload = buildApexCreatePayload(
    'FROM llama3.2-vision:11b\nPARAMETER num_ctx 16384\nPARAMETER temperature 0.75\nSYSTEM """\nRdzeń Apex.\n"""',
    'dolphin-llama3:70b',
  );
  assert.equal(payload.model, 'svl364-apex-uncensored:latest');
  assert.equal(payload.from, 'dolphin-llama3:70b');
  assert.equal(payload.parameters.num_ctx, 16384);
  assert.equal(payload.parameters.temperature, 0.75);
  assert.equal(payload.system, 'Rdzeń Apex.');
});
