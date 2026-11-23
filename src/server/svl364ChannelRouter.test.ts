import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeDirectShellCommand,
  parseSvl364ChannelInput,
  formatSvl364RootExecMarkdown,
  formatSvl364BridgeStatusMarkdown,
} from './svl364ChannelRouter.ts';

describe('svl364ChannelRouter', () => {
  it('routes arbitrary shell commands directly as ROOT without any command allowlist', () => {
    const cases = [
      'uname -a && id',
      'systemctl restart ollama.service && systemctl status ollama.service --no-pager',
      'docker ps -a | grep svl',
      'cat /etc/os-release',
      'OLLAMA_HOST=127.0.0.1:11434 ollama list',
      '/opt/svl/custom_tool --flag=1',
      './deploy/install-mcp.sh --check',
      'apt-get update && apt-get install -y htop',
    ];
    for (const cmd of cases) {
      assert.equal(looksLikeDirectShellCommand(cmd), true, `expected shell command: ${cmd}`);
      const parsed = parseSvl364ChannelInput(cmd);
      assert.equal(parsed.kind, 'root_exec', `expected root_exec for: ${cmd}`);
      if (parsed.kind === 'root_exec') {
        assert.equal(parsed.command, cmd);
        assert.equal(parsed.transport, 'auto');
      }
    }
  });

  it('routes explicit /root, /exec, /sh, !, #, and /ssh prefixes verbatim', () => {
    const r1 = parseSvl364ChannelInput('/root my-custom-binary --arg "hello world" | tee /tmp/out.log');
    assert.deepEqual(r1, {
      kind: 'root_exec',
      command: 'my-custom-binary --arg "hello world" | tee /tmp/out.log',
      transport: 'auto',
      explicit: true,
    });

    const r2 = parseSvl364ChannelInput('! whoami && ls -la /root');
    assert.deepEqual(r2, {
      kind: 'root_exec',
      command: 'whoami && ls -la /root',
      transport: 'auto',
      explicit: true,
    });

    const r3 = parseSvl364ChannelInput('/ssh journalctl -u svl-mcp.service -n 50');
    assert.deepEqual(r3, {
      kind: 'root_exec',
      command: 'journalctl -u svl-mcp.service -n 50',
      transport: 'ssh',
      explicit: true,
    });
  });

  it('parses /mcp connect, status, test, tools, and managed subcommands', () => {
    assert.deepEqual(parseSvl364ChannelInput('/mcp status'), { kind: 'mcp_status' });
    assert.deepEqual(parseSvl364ChannelInput('/mcp test'), { kind: 'mcp_test' });
    assert.deepEqual(parseSvl364ChannelInput('/mcp tools'), { kind: 'mcp_tools' });
    assert.deepEqual(parseSvl364ChannelInput('/mcp disconnect'), { kind: 'mcp_disconnect' });
    assert.deepEqual(parseSvl364ChannelInput('/mcp connect https://ship.trycloudflare.com/mcp secret123'), {
      kind: 'mcp_connect',
      url: 'https://ship.trycloudflare.com/mcp',
      token: 'secret123',
    });
    assert.deepEqual(parseSvl364ChannelInput('/mcp ollama list'), {
      kind: 'mcp_tool',
      tool: 'svl364_ollama_control',
      arguments: { action: 'list', confirmed: true },
    });
    assert.deepEqual(parseSvl364ChannelInput('/mcp remote read_file {"path":"/etc/hostname"}'), {
      kind: 'mcp_tool',
      tool: 'read_file',
      arguments: { path: '/etc/hostname' },
      remote: true,
    });
  });

  it('routes natural-language queries in Polish to natural_root_query for AI + MCP ROOT processing', () => {
    const queries = [
      'Sprawdź zużycie pamięci RAM i powiedz które procesy zająć się w pierwszej kolejności',
      'Jakie usługi działają na statku SVL-364 i czy tunel Zero-IP jest aktywny?',
      'Zainstaluj i skonfiguruj monitoring dysku na statku',
      'Wyjaśnij ostatnie błędy z logów svl-mcp',
    ];
    for (const q of queries) {
      const parsed = parseSvl364ChannelInput(q);
      assert.equal(parsed.kind, 'natural_root_query', `expected natural_root_query for: ${q}`);
    }
  });

  it('formats root execution and status markdown cleanly', () => {
    const md = formatSvl364RootExecMarkdown({
      command: 'id && hostname',
      ok: true,
      exitCode: 0,
      transport: 'remote-mcp-root',
      endpoint: 'https://ship.trycloudflare.com/mcp',
      durationMs: 42.5,
      output: 'uid=0(root)\nsvl-364',
    });
    assert.match(md, /Remote MCP Zero-IP · ROOT/);
    assert.match(md, /uid=0\(root\)/);
    assert.match(md, /\[btn:/);

    const statusMd = formatSvl364BridgeStatusMarkdown({
      remoteMcp: { configured: true, enabled: true, connected: true, url: 'https://ship.trycloudflare.com/mcp', tokenConfigured: true, rootExecEnabled: true },
      ssh: { uri: 'ssh://Ship', port: 22, targetReachable: true },
      mcp: { endpoint: '/api/mcp/svl364', tools: [{ name: 'svl364_root_exec' }] },
    });
    assert.match(statusMd, /ship\.trycloudflare\.com\/mcp/);
    assert.match(statusMd, /conv-svl364-mcp-root/);
  });
});
