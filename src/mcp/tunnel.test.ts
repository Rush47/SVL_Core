import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { buildTunnelCommand, parseTunnelUrl, restartDelayMs, TunnelManager } from './tunnel.ts';
import { parseTunnelKind } from './config.ts';

test('mcp tunnel: commands per provider', () => {
  assert.deepEqual(buildTunnelCommand({ kind: 'cloudflared', port: 3334 })?.args, ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:3334']);
  const named = buildTunnelCommand({ kind: 'cloudflared', port: 3334, cloudflaredToken: 'secret-token' })!;
  assert.ok(!named.args.join(' ').includes('secret-token'), 'token not in argv');
  assert.equal(named.env.TUNNEL_TOKEN, 'secret-token');
  assert.equal(buildTunnelCommand({ kind: 'ngrok', port: 1 })?.bin, 'ngrok');
  assert.deepEqual(buildTunnelCommand({ kind: 'tailscale', port: 3334 })?.args, ['funnel', '3334']);
  assert.equal(buildTunnelCommand({ kind: 'none', port: 1 }), null);
  assert.equal(parseTunnelKind(''), 'cloudflared');
  assert.equal(parseTunnelKind('off'), 'none');
  assert.throws(() => parseTunnelKind('xyz'));
});

test('mcp tunnel: URL parsing and backoff', () => {
  assert.equal(
    parseTunnelUrl('cloudflared', '2026-11-20T21:00:00Z INF |  https://quiet-river-abc-12.trycloudflare.com  |'),
    'https://quiet-river-abc-12.trycloudflare.com',
  );
  assert.equal(parseTunnelUrl('ngrok', '{"lvl":"info","msg":"started tunnel","url":"https://ab12.ngrok-free.app"}'), 'https://ab12.ngrok-free.app');
  assert.equal(parseTunnelUrl('tailscale', 'Available on the internet:\nhttps://svl.tail1234.ts.net/'), 'https://svl.tail1234.ts.net');
  assert.equal(parseTunnelUrl('cloudflared', 'no url here'), null);
  assert.equal(restartDelayMs(0), 2000);
  assert.equal(restartDelayMs(10), 60000);
});

test('mcp tunnel: manager waits for network, picks URL, restarts after exit', async () => {
  const procs: any[] = [];
  const spawnImpl = (() => {
    const p: any = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.kill = () => p.emit('exit', null, 'SIGTERM');
    procs.push(p);
    return p;
  }) as any;
  let online = false;
  const urls: string[] = [];
  const m = new TunnelManager({ kind: 'cloudflared', port: 3334 }, { onUrl: (s) => urls.push(s.mcpUrl!) }, { hasInternet: async () => online, spawnImpl });
  m.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(m.status.state, 'waiting_network');
  assert.equal(procs.length, 0);
  online = true;
  await (m as any).launch();
  assert.equal(procs.length, 1);
  procs[0].stderr.emit('data', Buffer.from('INF | https://abc-def.trycloudflare.com |\n'));
  assert.equal(m.status.state, 'starting', 'URL known but edge connection not registered yet');
  assert.deepEqual(urls, []);
  procs[0].stderr.emit('data', Buffer.from('INF Registered tunnel connection connIndex=0 location=waw01 protocol=quic\n'));
  assert.equal(m.status.state, 'up');
  assert.deepEqual(urls, ['https://abc-def.trycloudflare.com/mcp']);
  procs[0].emit('exit', 1, null);
  assert.equal(m.status.state, 'down');
  assert.equal(m.status.restarts, 1);
  m.stop();
});
