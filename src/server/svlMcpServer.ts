// Serwer MCP całego systemu SVL Python OS (/mcp/svl) — dla Claude (Claude Code, Claude Desktop)
// i innych klientów MCP. Narzędzia korzystają z tych samych endpointów co interfejs aplikacji
// (wywołania przez loopback z tokenem operatora), więc działają identycznie jak przyciski w GUI.

import fs from 'node:fs/promises';
import path from 'node:path';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export interface SvlMcpContext {
  baseUrl: string; // np. http://127.0.0.1:3000
  operatorToken: string;
  logDir: string;
}

const AGENTS = ['Bielik', 'Maya'] as const;
const CHANNELS: Record<string, string> = {
  wszyscy: 'conv-rodzina-mitek-wszyscy',
  bielik: 'conv-agent-bielik',
  maya: 'conv-agent-maya',
};
const LOG_FILES: Record<string, string> = {
  system: 'system_wszystko.txt',
  gateway: 'backend_gateway.txt',
  python: 'backend_python.txt',
  gui: 'gui_zdarzenia.txt',
};
const TERMINALS = ['linux', 'python', 'ssh', 'github', 'hyperspace', 'agents'];

const str = (v: unknown, max = 4000) => String(v ?? '').slice(0, max);

async function call(ctx: SvlMcpContext, method: 'GET' | 'POST', apiPath: string, body?: unknown, timeoutMs = 60000) {
  const res = await fetch(`${ctx.baseUrl}${apiPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-SVL-Operator-Token': ctx.operatorToken,
      'X-SVL-Origin': 'mcp-claude',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    // odpowiedź tekstowa
  }
  if (!res.ok || (data && typeof data === 'object' && data.ok === false)) {
    const err = (data && typeof data === 'object' && (data.error || data.summary)) || `HTTP ${res.status}`;
    throw new Error(String(err).slice(0, 600));
  }
  return data;
}

const asText = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2).slice(0, 60000) }],
});

const TOOLS = [
  {
    name: 'svl_status',
    description: 'Stan systemu SVL: jądro Python, Ollama i modele, moduły, rewizja synchronizacji, GitHub (Rush47/SVL_Core).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'svl_chat',
    description:
      'Wysyła wiadomość do Bielika lub Mayi w czacie SVL i zwraca odpowiedź. Wiadomość i odpowiedź są zapisane w kanale (widoczne w aplikacji, podpisane „Claude (MCP)”). ' +
      'Obsługuje też polecenia czatu, np. "/status", "/moduly", "/github status", "/gh pr list".',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', minLength: 1, maxLength: 8000 },
        agent: { type: 'string', enum: [...AGENTS], description: 'Domyślnie Bielik.' },
        channel: { type: 'string', enum: Object.keys(CHANNELS), description: 'wszyscy | bielik | maya (domyślnie kanał agenta).' },
      },
      required: ['message'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'svl_conversation',
    description: 'Ostatnie wiadomości z kanału czatu (wszyscy / bielik / maya), w tym powiadomienia Mayi.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', enum: Object.keys(CHANNELS) },
        limit: { type: 'number', minimum: 1, maximum: 100 },
      },
      required: ['channel'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'svl_terminal',
    description:
      'Wykonuje polecenie w terminalu SVL (te same terminale co w aplikacji): linux (powłoka ROOT hosta), python (REPL z jądrem), ' +
      'ssh (host statku SVL-364), github (gh / status / synchronizuj), hyperspace, agents. Wynik zapisuje się w historii terminala.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: { type: 'string', enum: TERMINALS },
        command: { type: 'string', minLength: 1, maxLength: 4000 },
      },
      required: ['terminal', 'command'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'svl_ship_telemetry',
    description: 'Prawdziwe pomiary: host aplikacji (CPU, RAM, dysk, GPU, sieć, zapora), usługi (Ollama, ComfyUI) i jednostka SVL-364 przez SSH.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'svl_logs',
    description: 'Ostatnie wpisy z logów systemu (katalog logi/): system, gateway, python, gui. Opcjonalny filtr tekstu i poziomu.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', enum: Object.keys(LOG_FILES) },
        lines: { type: 'number', minimum: 1, maximum: 500 },
        contains: { type: 'string', maxLength: 200, description: 'np. ai_chat, github, ship_monitor' },
        level: { type: 'string', enum: ['INFO', 'WARN', 'ERROR'], description: 'Minimalny poziom.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'svl_memory_search',
    description: 'Wyszukuje w pamięci długotrwałej agenta (SQLite + hiperprzestrzeń 128D).',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: [...AGENTS] },
        query: { type: 'string', maxLength: 500 },
        limit: { type: 'number', minimum: 1, maximum: 50 },
      },
      required: ['agent', 'query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'svl_memory_add',
    description: 'Zapisuje fakt / preferencję / decyzję w pamięci długotrwałej agenta.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: [...AGENTS] },
        content: { type: 'string', minLength: 1, maxLength: 2000 },
        kind: { type: 'string', enum: ['fact', 'preference', 'decision', 'task'] },
      },
      required: ['agent', 'content'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'svl_github',
    description:
      'GitHub Rush47/SVL_Core: synchronizacja obustronna katalogu projektu (status | pull | push | sync) albo polecenie gh (pole gh, np. "pr list"). ' +
      'Tylko to repozytorium; token z .env serwera.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'pull', 'push', 'sync'] },
        gh: { type: 'string', maxLength: 2000, description: 'Argumenty gh (zamiast action).' },
        message: { type: 'string', maxLength: 200, description: 'Opis commitu dla push/sync.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'svl_notify',
    description: 'Publikuje powiadomienie od Mayi na kanale „Rodzina Mitek (wszyscy)”.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200 },
        message: { type: 'string', maxLength: 3000 },
        severity: { type: 'string', enum: ['INFO', 'WARN', 'ALERT'] },
      },
      required: ['title'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'svl_antivirus_scan',
    description: 'Uruchamia skan antywirusowy SVL-365 (pliki + baza); wynik publikuje Maya Mitek na kanale „wszyscy”.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'svl_report',
    description: 'Generuje pełny raport SVL_System (host, moduły, pamięć); publikuje go Maya Mitek na kanale „wszyscy”.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false },
  },
];

const LEVEL_RANK: Record<string, number> = { INFO: 0, WARN: 1, ERROR: 2 };

export async function readLogTail(
  logDir: string,
  file = 'system',
  lines = 80,
  contains = '',
  level = '',
): Promise<string> {
  const name = LOG_FILES[file] || LOG_FILES.system;
  const full = path.join(logDir, name);
  let content = '';
  try {
    const stat = await fs.stat(full);
    const handle = await fs.open(full, 'r');
    try {
      const size = Math.min(stat.size, 2 * 1024 * 1024); // ostatnie 2 MB
      const buf = Buffer.alloc(size);
      await handle.read(buf, 0, size, stat.size - size);
      content = buf.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return `Brak pliku logów ${name}.`;
  }
  const minRank = LEVEL_RANK[String(level).toUpperCase()] ?? -1;
  const needle = String(contains || '').toLowerCase();
  const rows = content.split('\n').filter((row) => {
    if (!row.startsWith('[')) return false;
    if (needle && !row.toLowerCase().includes(needle)) return false;
    if (minRank >= 0) {
      const m = /\]\s\[(INFO|WARN|ERROR|DEBUG)\]/.exec(row);
      if (!m || (LEVEL_RANK[m[1]] ?? 0) < minRank) return false;
    }
    return true;
  });
  return rows.slice(-Math.max(1, Math.min(500, Number(lines) || 80))).join('\n') || '(brak pasujących wpisów)';
}

export function createSvlMcpServer(ctx: SvlMcpContext): McpServer {
  const server = new McpServer(
    { name: 'svl-core', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'SVL Python OS (Rush47/SVL_Core): czat z AI Bielik i Maya Mitek, terminale ROOT, statek SVL-364 przez SSH, logi, pamięć, GitHub. ' +
        'Wiadomości wysłane przez svl_chat są widoczne w aplikacji jako „Claude (MCP)”.',
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args: Record<string, unknown> = (request.params.arguments as Record<string, unknown>) || {};
    try {
      switch (request.params.name) {
        case 'svl_status': {
          const [health, github] = await Promise.all([
            call(ctx, 'GET', '/api/py/health'),
            call(ctx, 'GET', '/api/github/status?fetch=0').catch((e) => ({ error: String(e.message || e) })),
          ]);
          return asText({
            kernel: { serverRevision: health.serverRevision, version: health.version || health.kernel_version },
            ollama: {
              host: health.ollama?.ollama_host,
              reachable: health.ollama?.daemon_reachable,
              busy: health.ollama?.busy,
              models: (health.ollama?.models || []).map((m: any) => m.name),
            },
            modules: (health.system_modules || []).map((m: any) => `${m.id} (${m.status})`),
            github: github?.error
              ? github
              : { repository: github.repository, branch: github.branch, tokenValid: github.token?.valid, sync: github.sync },
          });
        }
        case 'svl_chat': {
          const agent = AGENTS.includes(String(args.agent) as any) ? String(args.agent) : 'Bielik';
          const channelKey = String(args.channel || agent.toLowerCase());
          const conversationId = CHANNELS[channelKey] || CHANNELS[agent.toLowerCase()];
          const message = str(args.message, 8000);
          const msgId = `user-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          await call(ctx, 'POST', '/api/py/chat/conversations/message', {
            conversation_id: conversationId,
            title: '',
            model: 'svl-hybrid-router',
            origin: 'mcp-claude',
            eventId: `evt-${msgId}`,
            message: {
              id: msgId,
              role: 'user',
              sender: 'Claude (MCP)',
              timestamp: new Date().toISOString(),
              content: message,
            },
          });
          const reply = await call(
            ctx,
            'POST',
            '/api/chat',
            { message, targetAgent: agent, conversationId, origin: 'mcp-claude', history: [] },
            180000,
          );
          return asText(`${reply.sender} [${reply.modelUsed}]\n\n${reply.reply}`);
        }
        case 'svl_conversation': {
          const conversationId = CHANNELS[String(args.channel)] || CHANNELS.wszyscy;
          const data = await call(ctx, 'GET', '/api/py/chat/conversations');
          const conv = (data.conversations || []).find((c: any) => c.id === conversationId);
          const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));
          const msgs = (conv?.messages || []).slice(-limit).map(
            (m: any) => `[${m.timestamp}] ${m.sender}${m.role === 'system' ? ' (powiadomienie)' : ''}: ${str(m.content, 1500)}`,
          );
          return asText(msgs.join('\n\n') || '(kanał pusty)');
        }
        case 'svl_terminal': {
          const terminal = TERMINALS.includes(String(args.terminal)) ? String(args.terminal) : 'linux';
          const r = await call(
            ctx,
            'POST',
            '/api/terminal/exec',
            { terminalType: terminal, command: str(args.command), origin: 'mcp-claude' },
            120000,
          ).catch((e) => ({ ok: false, stderr: String(e.message || e) }));
          return asText([r.stdout, r.stderr ? `STDERR:\n${r.stderr}` : ''].filter(Boolean).join('\n') || '(brak wyjścia)');
        }
        case 'svl_ship_telemetry':
          return asText(await call(ctx, 'GET', '/api/py/svl364/telemetry?ship=1', undefined, 60000));
        case 'svl_logs':
          return asText(await readLogTail(ctx.logDir, String(args.file || 'system'), Number(args.lines) || 80, str(args.contains, 200), str(args.level, 10)));
        case 'svl_memory_search': {
          const r = await call(ctx, 'POST', '/api/py/agents/memory/search', {
            agent: String(args.agent || 'Bielik'),
            query: str(args.query, 500),
            limit: Math.max(1, Math.min(50, Number(args.limit) || 12)),
          });
          return asText((r.memories || []).map((m: any) => `- [${m.kind}] ${m.content}`).join('\n') || '(brak wspomnień)');
        }
        case 'svl_memory_add': {
          const r = await call(ctx, 'POST', '/api/py/agents/memory', {
            agent: String(args.agent || 'Bielik'),
            kind: String(args.kind || 'fact'),
            content: str(args.content, 2000),
            source: 'mcp-claude',
            origin: 'mcp-claude',
          });
          return asText(r.deduplicated ? 'Ten wpis już był w pamięci.' : 'Zapisano w pamięci.');
        }
        case 'svl_github': {
          if (args.gh) {
            const r = await call(ctx, 'POST', '/api/github/cli', { args: str(args.gh, 2000) }, 120000);
            return asText(r.output);
          }
          const r = await call(
            ctx,
            'POST',
            '/api/github/sync',
            { action: String(args.action || 'status'), message: str(args.message || 'SVL: synchronizacja przez MCP (Claude)', 200) },
            180000,
          );
          return asText(r.summary);
        }
        case 'svl_notify': {
          const r = await call(ctx, 'POST', '/api/py/notifications/emit', {
            title: str(args.title, 200),
            message: str(args.message, 3000),
            severity: String(args.severity || 'INFO'),
            category: 'mcp',
            origin: 'mcp-claude',
          });
          return asText(r.deduplicated ? 'Takie powiadomienie już istnieje.' : 'Maya Mitek opublikowała powiadomienie na kanale „wszyscy”.');
        }
        case 'svl_antivirus_scan': {
          const r = await call(ctx, 'POST', '/api/security/antivirus/scan', { emitToChat: true, origin: 'mcp-claude' }, 120000);
          return asText(r.reportMarkdown || r);
        }
        case 'svl_report': {
          const r = await call(ctx, 'POST', '/api/py/kernel/markdown-report', {
            directive: 'Raport SVL_System na żądanie Claude (MCP)',
            emitToChat: true,
            origin: 'mcp-claude',
          });
          return asText(r.report || r);
        }
        default:
          return { content: [{ type: 'text' as const, text: `Nieznane narzędzie: ${request.params.name}` }], isError: true };
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  });
  return server;
}
