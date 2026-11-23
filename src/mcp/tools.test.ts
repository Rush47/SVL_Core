import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callTool, visibleTools, globToRegExp, type ToolContext } from './tools.ts';

function mkCtx(over: Partial<ToolContext> = {}): ToolContext {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'svl-mcp-tools-')));
  return { root, readOnly: false, allowShell: true, shellTimeoutMs: 10_000, maxReadBytes: 1_000_000, svlBaseUrl: 'http://svl.test', svlOperatorToken: '', logDir: root, ...over };
}
const text = (r: { content: { text: string }[] }) => r.content[0].text;

test('mcp tools: write, read, edit, list, search, move, delete', async () => {
  const ctx = mkCtx();
  try {
    assert.ok(!(await callTool(ctx, 'write_file', { path: 'src/a.txt', content: 'linia1\nlinia2 Gemini\nlinia3\n' })).isError);
    assert.equal(text(await callTool(ctx, 'read_file', { path: 'src/a.txt', offset: 2, limit: 1 })), 'linia2 Gemini');
    assert.ok((await callTool(ctx, 'write_file', { path: 'src/a.txt', content: 'x', create_only: true })).isError);
    assert.ok(!(await callTool(ctx, 'edit_file', { path: 'src/a.txt', old_string: 'Gemini', new_string: 'Ollama' })).isError);
    assert.match(fs.readFileSync(path.join(ctx.root, 'src/a.txt'), 'utf8'), /linia2 Ollama/);
    assert.ok((await callTool(ctx, 'edit_file', { path: 'src/a.txt', old_string: 'linia', new_string: 'L' })).isError, 'ambiguous edit rejected');
    assert.match(text(await callTool(ctx, 'list_dir', { depth: 3 })), /src\/a\.txt/);
    assert.match(text(await callTool(ctx, 'search', { query: 'ollama' })), /src\/a\.txt:2:/);
    assert.match(text(await callTool(ctx, 'search', { query: 'a.txt', names_only: true, glob: '*.txt' })), /src\/a\.txt/);
    assert.ok(!(await callTool(ctx, 'move_path', { from: 'src/a.txt', to: 'dst/b.txt' })).isError);
    assert.ok(fs.existsSync(path.join(ctx.root, 'dst/b.txt')));
    assert.ok((await callTool(ctx, 'delete_path', { path: 'dst' })).isError, 'non-empty dir needs recursive');
    assert.ok(!(await callTool(ctx, 'delete_path', { path: 'dst', recursive: true })).isError);
    assert.ok((await callTool(ctx, 'delete_path', { path: '.' })).isError, 'root cannot be deleted');
    assert.ok((await callTool(ctx, 'read_file', { path: '../../etc/passwd' })).isError);
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

test('mcp tools: read-only mode hides and blocks write tools', async () => {
  const ctx = mkCtx({ readOnly: true, allowShell: false });
  try {
    const names = visibleTools(ctx).map((t) => t.name);
    assert.ok(names.includes('read_file'));
    for (const w of ['write_file', 'edit_file', 'delete_path', 'move_path', 'run_command', 'make_dir', 'svl_chat']) {
      assert.ok(!names.includes(w), `${w} hidden`);
    }
    const r = await callTool(ctx, 'write_file', { path: 'x.txt', content: 'x' });
    assert.ok(r.isError);
    assert.match(text(r), /tylko do odczytu/);
    assert.ok(!fs.existsSync(path.join(ctx.root, 'x.txt')));
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

test('mcp tools: run_command with timeout and shell toggle', async () => {
  const ctx = mkCtx({ shellTimeoutMs: 1500 });
  try {
    const ok = text(await callTool(ctx, 'run_command', { command: 'echo hej && pwd' }));
    assert.match(ok, /exit_code: 0/);
    assert.match(ok, /hej/);
    assert.ok(ok.includes(ctx.root));
    const slow = text(await callTool(ctx, 'run_command', { command: 'sleep 5', timeout_ms: 1000 }));
    assert.match(slow, /przerwano/);
    const off = await callTool({ ...ctx, allowShell: false }, 'run_command', { command: 'echo x' });
    assert.ok(off.isError);
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

test('mcp tools: svl_chat calls SVL /api/chat', async () => {
  let seen: any = null;
  const fetchImpl = (async (url: string, init: any) => {
    seen = { url, body: JSON.parse(init.body), headers: init.headers };
    return new Response(JSON.stringify({ sender: 'Jyn', modelUsed: 'jedi-omni-os-v11.5-vm', reply: 'Gotowe' }), { status: 200 });
  }) as unknown as typeof fetch;
  const ctx = mkCtx({ fetchImpl, svlOperatorToken: 'op' });
  try {
    const r = text(await callTool(ctx, 'svl_chat', { message: 'status', agent: 'Jyn' }));
    assert.equal(seen.url, 'http://svl.test/api/chat');
    assert.equal(seen.body.targetAgent, 'Jyn');
    assert.equal(seen.headers['X-SVL-Operator-Token'], 'op');
    assert.match(r, /Jyn \[jedi-omni-os-v11\.5-vm\][\s\S]*Gotowe/);
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

test('mcp tools: glob helper and unknown tool', async () => {
  assert.ok(globToRegExp('*.ts').test('a.ts'));
  assert.ok(!globToRegExp('*.ts').test('a.tsx'));
  const ctx = mkCtx();
  assert.ok((await callTool(ctx, 'nope', {})).isError);
  fs.rmSync(ctx.root, { recursive: true, force: true });
});

test('mcp tools: Universal Hub tools (services, ollama, ship_manage, loopback http guard)', async () => {
  const seenUrls: string[] = [];
  const fetchImpl = (async (url: string, init?: any) => {
    seenUrls.push(`${init?.method || 'GET'} ${url}`);
    if (url.endsWith('/api/ollama/router')) {
      return new Response(JSON.stringify({ ok: true, active: 'ship' }), { status: 200 });
    }
    if (url.endsWith('/api/mcp/svl364')) {
      return new Response(JSON.stringify({ result: { content: [{ text: 'SVL-364 tunnel OK' }] } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, service: 'local-api' }), { status: 200 });
  }) as unknown as typeof fetch;

  const ctx = mkCtx({ fetchImpl, svlOperatorToken: 'op', nodeName: 'svl-364' });
  try {
    const svc = JSON.parse(text(await callTool(ctx, 'svl_services_status', { skip_systemd: true })));
    assert.equal(svc.node, 'svl-364');
    assert.equal(svc.endpoints.svlGateway.reachable, true);

    const oll = text(await callTool(ctx, 'svl_ollama', { action: 'router' }));
    assert.match(oll, /"active": "ship"/);

    const ship = text(await callTool(ctx, 'svl_ship_manage', { tool: 'svl364_tunnel_control', action: 'status', confirmed: false }));
    assert.match(ship, /SVL-364 tunnel OK/);

    const okLocal = await callTool(ctx, 'svl_http_local', { url: 'http://127.0.0.1:8085/health' });
    assert.ok(!okLocal.isError);
    assert.match(text(okLocal), /HTTP 200/);

    const blockedRemote = await callTool(ctx, 'svl_http_local', { url: 'https://example.com/secret' });
    assert.ok(blockedRemote.isError);
    assert.match(text(blockedRemote), /wyłącznie lokalne usługi/);
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

test('mcp tools: svl_ship_root_exec, svl_ship_mcp_bridge, and svl364_root chat channel', async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl = (async (url: string, init?: any) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    if (url.endsWith('/api/svl364/root/exec')) {
      return new Response(JSON.stringify({ ok: true, output: 'uid=0(root)\nsvl-364' }), { status: 200 });
    }
    if (url.endsWith('/api/svl364/mcp-bridge/config')) {
      return new Response(JSON.stringify({ ok: true, url: body?.url, tokenConfigured: true }), { status: 200 });
    }
    if (url.endsWith('/api/chat')) {
      return new Response(JSON.stringify({ ok: true, sender: 'Jyn', modelUsed: 'SVL-364 ROOT', reply: 'uid=0(root)' }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;

  const ctx = mkCtx({ fetchImpl, svlOperatorToken: 'op' });
  try {
    const denied = await callTool(ctx, 'svl_ship_root_exec', { command: 'id', confirmed: false });
    assert.ok(denied.isError);

    const execOut = text(await callTool(ctx, 'svl_ship_root_exec', { command: 'id && hostname', confirmed: true }));
    assert.match(execOut, /uid=0\(root\)/);

    const bridgeOut = text(await callTool(ctx, 'svl_ship_mcp_bridge', {
      action: 'configure',
      url: 'https://ship.trycloudflare.com/mcp',
      token: 'secret-token',
      root_exec_enabled: true,
    }));
    assert.match(bridgeOut, /ship\.trycloudflare\.com\/mcp/);

    const chatOut = text(await callTool(ctx, 'svl_chat', { message: '/root id', channel: 'svl364_root' }));
    assert.match(chatOut, /uid=0\(root\)/);
    const chatCall = calls.find((c) => c.url.endsWith('/api/chat'));
    assert.equal(chatCall?.body?.conversationId, 'conv-svl364-mcp-root');
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

test('mcp tools: svl_infrastructure_registry overview, sync_mcp, mutations and readOnly guard', async () => {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  const fetchImpl = (async (url: string, init?: any) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init?.method || 'GET', body });
    if (url.includes('/api/infrastructure/overview')) {
      return new Response(
        JSON.stringify({ ok: true, totals: { outpostsCount: 6, shipsCount: 10002, infrastructureObjectsCount: 500, botanyModulesCount: 5 } }),
        { status: 200 },
      );
    }
    if (url.endsWith('/api/infrastructure/missions')) {
      return new Response(JSON.stringify({ ok: true, mission: { id: 'm1', title: body?.title, progressPct: 50 } }), { status: 200 });
    }
    if (url.endsWith('/api/infrastructure/botany')) {
      return new Response(JSON.stringify({ ok: true, botany: { id: body?.id, o2OutputPct: 115 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;

  const ctx = mkCtx({ fetchImpl, svlOperatorToken: 'op' });
  const roCtx = mkCtx({ fetchImpl, svlOperatorToken: 'op', readOnly: true });
  try {
    const ov = text(await callTool(ctx, 'svl_infrastructure_registry', { action: 'sync_mcp' }));
    assert.match(ov, /10002/);
    assert.ok(calls.some((c) => c.url.endsWith('/api/infrastructure/overview?sync=1')));

    const mis = text(
      await callTool(ctx, 'svl_infrastructure_registry', {
        action: 'upsert_mission',
        payload: { title: 'Testowa misja MCP', progressPct: 50 },
      }),
    );
    assert.match(mis, /Testowa misja MCP/);

    const bot = text(
      await callTool(ctx, 'svl_infrastructure_registry', {
        action: 'update_botany',
        payload: { id: 'botany-apex-citadel', o2OutputPct: 115 },
      }),
    );
    assert.match(bot, /115/);

    const roDenied = await callTool(roCtx, 'svl_infrastructure_registry', {
      action: 'upsert_mission',
      payload: { title: 'Blocked' },
    });
    assert.ok(roDenied.isError);
    assert.match(text(roDenied), /MCP_READONLY/);
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
    fs.rmSync(roCtx.root, { recursive: true, force: true });
  }
});


