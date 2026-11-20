import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createMcpHttpApp, connectorInfo } from './main.ts';
import { loadMcpConfig } from './config.ts';
import type { ToolContext } from './tools.ts';

test('mcp http: bearer required, tools/list + tools/call over Streamable HTTP', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'svl-mcp-http-')));
  const token = 't'.repeat(43);
  const cfg = { ...loadMcpConfig({ MCP_ROOT: root, MCP_TUNNEL: 'none' } as any, root), port: 0 };
  const ctx: ToolContext = { root, readOnly: false, allowShell: false, shellTimeoutMs: 5000, maxReadBytes: 100000, svlBaseUrl: 'http://x', svlOperatorToken: '', logDir: root };
  const server = createMcpHttpApp(cfg, token, ctx, () => {}).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const rpc = (url: string, body: unknown, auth?: string) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(auth ? { Authorization: auth } : {}) },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await rpc(`${base}/mcp`, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
    assert.equal((await rpc(`${base}/mcp`, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'Bearer wrong')).status, 401);
    const list = await rpc(`${base}/mcp`, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, `Bearer ${token}`);
    assert.equal(list.status, 200);
    const names = (await list.json()).result.tools.map((t: any) => t.name);
    assert.ok(names.includes('write_file'));
    assert.ok(!names.includes('run_command'), 'shell disabled → hidden');
    const call = await rpc(`${base}/mcp/k/${token}`, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'write_file', arguments: { path: 'hej.txt', content: 'SVL' } } });
    assert.equal(call.status, 200);
    assert.equal(fs.readFileSync(path.join(root, 'hej.txt'), 'utf8'), 'SVL');
    assert.equal((await fetch(`${base}/status`)).status, 401);
    assert.equal((await fetch(`${base}/status`, { headers: { 'X-MCP-Token': token } })).status, 200);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('mcp connector info: public URL and Gemini CLI snippet', () => {
  const cfg = loadMcpConfig({ MCP_TUNNEL: 'none' } as any, '/tmp');
  const info = connectorInfo(cfg, 'k'.repeat(43), { kind: 'cloudflared', state: 'up', publicUrl: 'https://a.trycloudflare.com', mcpUrl: 'https://a.trycloudflare.com/mcp', since: null, restarts: 0, lastError: null });
  assert.equal(info.publicUrl, 'https://a.trycloudflare.com/mcp');
  assert.equal(info.geminiCli.mcpServers.svl.httpUrl, 'https://a.trycloudflare.com/mcp');
  assert.equal(info.geminiCli.mcpServers.svl.headers.Authorization, `Bearer ${'k'.repeat(43)}`);
  assert.equal(info.urlWithKey, `https://a.trycloudflare.com/mcp/k/${'k'.repeat(43)}`);
});
