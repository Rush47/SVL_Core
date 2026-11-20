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
    assert.ok(!(await callTool(ctx, 'write_file', { path: 'src/a.txt', content: 'linia1\nlinia2 Grok\nlinia3\n' })).isError);
    assert.equal(text(await callTool(ctx, 'read_file', { path: 'src/a.txt', offset: 2, limit: 1 })), 'linia2 Grok');
    assert.ok((await callTool(ctx, 'write_file', { path: 'src/a.txt', content: 'x', create_only: true })).isError);
    assert.ok(!(await callTool(ctx, 'edit_file', { path: 'src/a.txt', old_string: 'Grok', new_string: 'Ollama' })).isError);
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
    return new Response(JSON.stringify({ sender: 'Maya', modelUsed: 'grok-4.7', reply: 'Gotowe' }), { status: 200 });
  }) as unknown as typeof fetch;
  const ctx = mkCtx({ fetchImpl, svlOperatorToken: 'op' });
  try {
    const r = text(await callTool(ctx, 'svl_chat', { message: 'status', agent: 'Maya' }));
    assert.equal(seen.url, 'http://svl.test/api/chat');
    assert.equal(seen.body.targetAgent, 'Maya');
    assert.equal(seen.headers['X-SVL-Operator-Token'], 'op');
    assert.match(r, /Maya \[grok-4\.7\][\s\S]*Gotowe/);
    assert.equal(seen.body.conversationId, 'conv-agent-maya');
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

test('mcp tools: svl_chat keeps System_SI_1 and its aliases', async () => {
  const seen: any[] = [];
  const fetchImpl = (async (_url: string, init: any) => {
    seen.push(JSON.parse(init.body));
    return new Response(
      JSON.stringify({ sender: 'System_SI_1', modelUsed: 'System_SI_1 · Ollama (llama3.2:1b · ROOT)', reply: 'Tu System_SI_1.' }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const ctx = mkCtx({ fetchImpl, svlOperatorToken: 'op' });
  try {
    for (const agent of ['System_SI_1', 'system_si_1', 'system-si-1']) {
      const r = text(await callTool(ctx, 'svl_chat', { message: 'Przedstaw się.', agent }));
      assert.match(r, /^System_SI_1 \[System_SI_1 · Ollama \(llama3\.2:1b · ROOT\)\]/);
    }
    assert.deepEqual(
      seen.map((body) => body.targetAgent),
      ['System_SI_1', 'System_SI_1', 'System_SI_1'],
    );
    assert.ok(seen.every((body) => body.conversationId === 'conv-system-si-1'));
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
  let unknownBody: any = null;
  const unknownCtx = mkCtx({
    fetchImpl: (async (_url: string, init: any) => {
      unknownBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ sender: 'Bielik', modelUsed: 'x', reply: 'ok' }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  try {
    await callTool(unknownCtx, 'svl_chat', { message: 'hej', agent: 'nieznany' });
    assert.equal(unknownBody.targetAgent, 'Bielik');
    assert.equal(unknownBody.conversationId, 'conv-agent-bielik');
  } finally {
    fs.rmSync(unknownCtx.root, { recursive: true, force: true });
  }
});

test('mcp tools: glob helper and unknown tool', async () => {
  assert.ok(globToRegExp('*.ts').test('a.ts'));
  assert.ok(!globToRegExp('*.ts').test('a.tsx'));
  const ctx = mkCtx();
  assert.ok((await callTool(ctx, 'nope', {})).isError);
  fs.rmSync(ctx.root, { recursive: true, force: true });
});
