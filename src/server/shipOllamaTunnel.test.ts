import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseShipOllamaTunnelEnv,
  buildSshTunnelArgs,
  tunnelOllamaUrl,
  tunnelRestartDelayMs,
  describeTunnelStatus,
} from './shipOllamaTunnel.ts';

test('parseShipOllamaTunnelEnv: domyślne i własne wartości', () => {
  const off = parseShipOllamaTunnelEnv({});
  assert.equal(off.enabled, false);
  assert.equal(off.target, 'Ship');
  assert.equal(off.shipPort, 11434);
  assert.equal(off.localPort, 11434);

  const on = parseShipOllamaTunnelEnv({
    SVL_SHIP_OLLAMA: '1',
    SVL_SSH_TARGET: 'maya@svl-364',
    SVL_SHIP_OLLAMA_PORT: '11500',
    SVL_SHIP_OLLAMA_LOCAL_PORT: '11435',
  });
  assert.equal(on.enabled, true);
  assert.equal(on.target, 'maya@svl-364');
  assert.equal(on.shipPort, 11500);
  assert.equal(on.localPort, 11435);
});

test('parseShipOllamaTunnelEnv: błędny port → wartość domyślna', () => {
  const cfg = parseShipOllamaTunnelEnv({ SVL_SHIP_OLLAMA: 'yes', SVL_SHIP_OLLAMA_PORT: '70000' });
  assert.equal(cfg.shipPort, 11434);
});

test('buildSshTunnelArgs tworzy bezpieczny tunel port-forward', () => {
  const cfg = parseShipOllamaTunnelEnv({ SVL_SHIP_OLLAMA: '1', SVL_SSH_TARGET: 'Ship' });
  const args = buildSshTunnelArgs(cfg);
  assert.ok(args.includes('-N'));
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.includes('ExitOnForwardFailure=yes'));
  assert.ok(args.includes('-L'));
  assert.ok(args.includes('127.0.0.1:11434:127.0.0.1:11434'));
  assert.equal(args[args.length - 1], 'Ship'); // cel na końcu
  // Bez powłoki zdalnej — nie wykonujemy poleceń na statku, tylko tunel.
  assert.ok(!args.some((a) => a.includes('&&') || a.includes(';')));
});

test('tunnelOllamaUrl wskazuje lokalny koniec tunelu', () => {
  const cfg = parseShipOllamaTunnelEnv({ SVL_SHIP_OLLAMA: '1', SVL_SHIP_OLLAMA_LOCAL_PORT: '11435' });
  assert.equal(tunnelOllamaUrl(cfg), 'http://127.0.0.1:11435');
});

test('tunnelRestartDelayMs narasta i jest ograniczony', () => {
  assert.equal(tunnelRestartDelayMs(1), 2000);
  assert.equal(tunnelRestartDelayMs(3), 6000);
  assert.equal(tunnelRestartDelayMs(100), 60000);
});

test('describeTunnelStatus daje czytelne komunikaty', () => {
  const cfg = parseShipOllamaTunnelEnv({ SVL_SHIP_OLLAMA: '1', SVL_SSH_TARGET: 'Ship' });
  assert.match(describeTunnelStatus('up', cfg), /aktywna przez SSH/);
  assert.match(describeTunnelStatus('down', cfg, 'ssh: brak'), /nie działa: ssh: brak/);
  assert.match(describeTunnelStatus('off', parseShipOllamaTunnelEnv({})), /wyłączony/);
});

test('resolveShipPullModels: domyślnie zestaw UNCENSORED GPU; env nadpisuje; bez apex/duplikatów', async () => {
  const { resolveShipPullModels, SHIP_UNCENSORED_GPU_MODELS } = await import('./shipOllamaTunnel.ts');
  // Domyślnie: wyłącznie modele uncensored pod GPU (bez modelu wizyjnego).
  assert.deepEqual(resolveShipPullModels({}), [...SHIP_UNCENSORED_GPU_MODELS]);
  // Nadpisanie przez env + filtr apex-uncensored i duplikatów.
  const list = resolveShipPullModels(
    { SVL_SHIP_OLLAMA_MODELS: 'dolphin-llama3:70b, dolphin-llama3:70b' },
    ['svl364-apex-uncensored:latest', 'wizard-vicuna-uncensored:13b'],
  );
  assert.deepEqual(list, ['dolphin-llama3:70b', 'wizard-vicuna-uncensored:13b']);
});
