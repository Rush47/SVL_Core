import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLogTail, resolveSvlGatewayChat } from './svlMcpServer.ts';

test('svl_logs: tail with category and minimum level filters', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svl-mcp-logs-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'backend_gateway.txt'),
      [
        '=== nagłówek ===',
        '[2026-11-17T10:00:00Z] [GATEWAY] [INFO] [ai_chat] Maya OK',
        '[2026-11-17T10:00:01Z] [GATEWAY] [WARN] [ai_chat] Maya BRAK ODPOWIEDZI',
        '[2026-11-17T10:00:02Z] [GATEWAY] [ERROR] [github] push odrzucony',
        '',
      ].join('\n'),
    );
    assert.equal((await readLogTail(dir, 'gateway', 10, 'ai_chat')).split('\n').length, 2);
    assert.match(await readLogTail(dir, 'gateway', 10, '', 'WARN'), /BRAK ODPOWIEDZI[\s\S]*push odrzucony/);
    assert.equal(await readLogTail(dir, 'gateway', 1), '[2026-11-17T10:00:02Z] [GATEWAY] [ERROR] [github] push odrzucony');
    assert.match(await readLogTail(dir, 'python'), /Brak pliku logów/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('svl_chat gateway: System_SI_1 i aliasy idą na kanał infrastruktury', () => {
  for (const agent of ['System_SI_1', 'system_si_1', 'system-si-1']) {
    assert.deepEqual(resolveSvlGatewayChat({ agent }), {
      agent: 'System_SI_1',
      conversationId: 'conv-system-si-1',
    });
  }
  assert.deepEqual(resolveSvlGatewayChat({ agent: 'Bielik', channel: 'system-si-1' }), {
    agent: 'System_SI_1',
    conversationId: 'conv-system-si-1',
  });
  assert.deepEqual(resolveSvlGatewayChat({ agent: 'Maya' }), {
    agent: 'Maya',
    conversationId: 'conv-agent-maya',
  });
  assert.equal(resolveSvlGatewayChat({}).agent, 'Bielik');
});
