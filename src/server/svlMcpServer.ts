// Serwer MCP całego systemu SVL Python OS (/mcp/svl) — dla klientów MCP i agentów SVL.
// Narzędzia korzystają z tych samych endpointów co interfejs aplikacji
// (wywołania przez loopback z tokenem operatora), więc działają identycznie jak przyciski w GUI.

import fs from 'node:fs/promises';
import path from 'node:path';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

export interface SvlMcpContext {
  baseUrl: string; // np. http://127.0.0.1:3000
  operatorToken: string;
  logDir: string;
  universalMcpUrl?: string; // np. http://127.0.0.1:3334/mcp
  universalMcpToken?: string;
}

const AGENTS = ['Jyn', 'SI_Sphere', 'JEDI_Omni_OS'] as const;
const CHANNELS: Record<string, string> = {
  wszyscy: 'conv-rodzina-mitek-wszyscy',
  jyn: 'conv-jyn',
  svl364_root: 'conv-svl364-mcp-root',
  svl364: 'conv-svl364-mcp-root',
  ship_root: 'conv-svl364-mcp-root',
  si_sphere: 'conv-si-sphere',
  jedi: 'conv-jedi-omni-os',
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
      'X-SVL-Origin': 'mcp-svl',
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
    description: 'Stan systemu SVL: jądro Python, Dual-Ollama i modele, moduły, rewizja synchronizacji, GitHub (Rush47/SVL_Core).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'svl_mcp_hub_status',
    description: 'Stan Universal MCP Hub i dostępu bez stałego IP (tunel Cloudflare / Tailscale / ngrok / ssh-reverse, wykryte adresy mesh, wszystkie punkty MCP i usługi).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'svl_ollama_router',
    description: 'Stan routera Dual-Ollama (lokalna + statek SVL-364 przez SSH/MCP), lista modeli na obu węzłach i aktywne routowanie.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'svl_services_overview',
    description: 'Przekrojowy stan wszystkich skonfigurowanych usług systemu SVL oraz hosta SVL-364 (brama, jądro Python, Ollama, ComfyUI, MCP, tunel zero-IP, SSH).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'svl_chat',
    description:
      'Wysyła wiadomość lub polecenie do Jyn, SI_Sphere lub JEDI_Omni_OS (ROOT) przez maszynę wirtualną JEDI Omni-OS v12 w czacie SVL i zwraca odpowiedź. ' +
      'Wiadomość i odpowiedź są zapisane w kanale (widoczne w aplikacji, podpisane „SVL MCP”). ' +
      'Obsługuje też polecenia czatu, np. "/jedi status", "/status", "/moduly", "/github status", "/gh pr list".',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', minLength: 1, maxLength: 8000 },
        agent: { type: 'string', enum: [...AGENTS], description: 'Domyślnie Jyn.' },
        channel: { type: 'string', enum: Object.keys(CHANNELS), description: 'jyn | si_sphere | jedi | wszyscy (domyślnie kanał agenta).' },
      },
      required: ['message'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'svl_conversation',
    description: 'Ostatnie wiadomości z kanału czatu (jyn / si_sphere / jedi / wszyscy), w tym powiadomienia Jyn.',
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
    name: 'svl_ssh_status',
    description: 'Status mostka OpenSSH SVL-364: cel, port, dostępność TCP, konfiguracja i aktywność MCP.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'svl_ssh_configure',
    description:
      'Konfiguruje OpenSSH dla SVL-364 i może wygenerować klucz Ed25519. Zwraca tylko klucz publiczny; prywatny pozostaje w ~/.ssh.',
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string', minLength: 1, maxLength: 63, description: 'Alias OpenSSH, np. Ship.' },
        hostname: { type: 'string', minLength: 1, maxLength: 253, description: 'Adres IP, mesh IP (Tailscale/ZeroTier) lub domena statku.' },
        port: { type: 'number', minimum: 1, maximum: 65535 },
        user: { type: 'string', minLength: 1, maxLength: 63 },
        generate_key: { type: 'boolean', default: true },
      },
      required: ['hostname', 'user'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'svl_ssh_public_key',
    description: 'Odczytuje publiczny klucz SSH SVL-364 do dodania na statku. Nigdy nie zwraca klucza prywatnego.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'svl_ssh_test',
    description: 'Testuje konfigurację OpenSSH, DNS/TCP i uwierzytelnienie kluczem do SVL-364.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'svl_ssh_exec',
    description: 'Wykonuje polecenie na SVL-364 przez OpenSSH tylko przy jawnym confirmed=true.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 1, maxLength: 4000 },
        confirmed: { type: 'boolean', const: true },
        timeout_sec: { type: 'number', minimum: 2, maximum: 60 },
      },
      required: ['command', 'confirmed'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'svl_ollama_tunnel',
    description:
      'Steruje bieżącym tunelem SSH do Ollamy statku (local port-forward). Zmiana jest aktywna do restartu gatewaya.',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        target: { type: 'string', maxLength: 253, description: 'Alias OpenSSH; np. Ship.' },
        shipPort: { type: 'number', minimum: 1, maximum: 65535 },
        localPort: { type: 'number', minimum: 1, maximum: 65535 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'svl_ship_root_exec',
    description:
      'Wykonuje DOWOLNE polecenie powłoki Linux na komputerze statku SVL-364 z uprawnieniami ROOT (uid=0 / sudo -n) przez zdalny MCP Zero-IP albo OpenSSH (wymaga confirmed=true).',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 1, maxLength: 4000, description: 'Dowolne polecenie do wykonania jako root na SVL-364.' },
        confirmed: { type: 'boolean', const: true },
        transport: { type: 'string', enum: ['auto', 'remote-mcp', 'ssh'], description: 'auto (Remote MCP -> SSH) | remote-mcp | ssh' },
        timeout_sec: { type: 'number', minimum: 2, maximum: 60 },
      },
      required: ['command', 'confirmed'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'svl_ship_mcp_bridge',
    description:
      'Konfiguruje i testuje zdalne połączenie MCP (Zero-IP HTTPS / Tailscale / Mesh) z komputerem pokładowym statku SVL-364 oraz obsługuje kanał conv-svl364-mcp-root.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'configure', 'test', 'disconnect', 'call'] },
        url: { type: 'string', maxLength: 512, description: 'Adres zdalnego serwera MCP na SVL-364 (np. https://xxx.trycloudflare.com/mcp).' },
        token: { type: 'string', maxLength: 512, description: 'Bearer token zdalnego serwera MCP (zapisywany w pliku 0600).' },
        root_exec_enabled: { type: 'boolean', description: 'Domyślna eskalacja poleceń do ROOT (uid=0).' },
        remote_tool: { type: 'string', maxLength: 128, description: 'Nazwa narzędzia zdalnego MCP dla action=call.' },
        remote_arguments: { type: 'object', description: 'Argumenty JSON dla narzędzia zdalnego MCP.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'svl_ship_manage',
    description:
      'Zarządza hostem SVL-364 przez narzędzia MCP: zasoby, usługi, Ollama, pliki/backup, sieć, aktualizacje, tunel Zero-IP/Mesh, kontenery Docker/Podman, ComfyUI oraz dowolne polecenia ROOT (svl364_root_exec, svl364_mcp_connect).',
    inputSchema: {
      type: 'object',
      properties: {
        tool: {
          type: 'string',
          enum: [
            'svl364_root_exec',
            'svl364_mcp_connect',
            'svl364_resources',
            'svl364_service_control',
            'svl364_ollama_control',
            'svl364_file_control',
            'svl364_network_control',
            'svl364_update_control',
            'svl364_tunnel_control',
            'svl364_container_control',
            'svl364_comfyui_control',
            'svl364_linux_telemetry',
            'svl364_emit_system_report',
            'svl364_navigation',
            'svl364_incident_report',
            'svl364_infrastructure_registry',
          ],
        },
        command: { type: 'string', maxLength: 4000 },
        transport: { type: 'string', enum: ['auto', 'remote-mcp', 'ssh'] },
        url: { type: 'string', maxLength: 512 },
        token: { type: 'string', maxLength: 512 },
        area: { type: 'string', maxLength: 32 },
        action: { type: 'string', maxLength: 32 },
        service: { type: 'string', maxLength: 128 },
        model: { type: 'string', maxLength: 160 },
        container: { type: 'string', maxLength: 128 },
        path: { type: 'string', maxLength: 512 },
        package: { type: 'string', maxLength: 128 },
        target: { type: 'string', maxLength: 253 },
        directive: { type: 'string', maxLength: 400 },
        lines: { type: 'number', minimum: 10, maximum: 500 },
        confirmed: { type: 'boolean' },
      },
      required: ['tool'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'svl_infrastructure_registry',
    description:
      'Odczytuje lub aktualizuje przez MCP dokładną liczbę i lokalizacje placówek, statków i infrastruktury SVL, ' +
      'aktywne misje, badania naukowe oraz stan modułów botanicznych w poszczególnych obiektach.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['overview', 'sync_mcp', 'upsert_asset', 'upsert_mission', 'upsert_research', 'update_botany', 'order_upgrade'],
        },
        payload: {
          type: 'object',
          description: 'Dane obiektu do zapisania lub zaktualizowania (placówka/statek/infrastruktura, misja, badanie, botanika).',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
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
    description: 'Publikuje powiadomienie od Jyn na kanale „Rodzina Mitek (wszyscy)”.',
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
    description: 'Uruchamia skan antywirusowy SVL-365 (pliki + baza); wynik publikuje Jyn na kanale „wszyscy”.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'svl_report',
    description: 'Generuje pełny raport SVL_System (host, moduły, pamięć); publikuje go Jyn na kanale „wszyscy”.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false },
  },
];

export const SVL_MCP_TOOL_COUNT = TOOLS.length;

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
    { name: 'svl-core', version: '2.0.0' },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        'SVL Python OS (Rush47/SVL_Core): czat z AI Jyn / SI_Sphere / JEDI_Omni_OS (ROOT) przetwarzanym przez VM JEDI Omni-OS v12, ' +
        'terminale ROOT, Dual-Ollama (lokalna + SVL-364), statek SVL-364 przez SSH i MCP, tunel Zero-IP/Mesh, logi, pamięć 128D, GitHub. ' +
        'Wiadomości wysłane przez svl_chat są widoczne w aplikacji jako „SVL MCP”.',
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: 'svl://mcp/hub', name: 'Status Universal MCP Hub i tunelu Zero-IP', mimeType: 'application/json' },
      { uri: 'svl://system/status', name: 'Stan systemu SVL, Dual-Ollama i GitHub', mimeType: 'application/json' },
      { uri: 'svl://ship/telemetry', name: 'Telemetria hosta i statku SVL-364', mimeType: 'application/json' },
    ],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = String(req.params.uri || 'svl://mcp/hub');
    const data =
      uri === 'svl://ship/telemetry'
        ? await call(ctx, 'GET', '/api/py/svl364/telemetry?ship=1', undefined, 60000)
        : uri === 'svl://system/status'
          ? await call(ctx, 'GET', '/api/py/health')
          : await call(ctx, 'GET', '/api/mcp/hub/status');
    return {
      contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2).slice(0, 60000) }],
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args: Record<string, unknown> = (request.params.arguments as Record<string, unknown>) || {};
    try {
      switch (request.params.name) {
        case 'svl_status': {
          const [health, github, ollamaRouter] = await Promise.all([
            call(ctx, 'GET', '/api/py/health'),
            call(ctx, 'GET', '/api/github/status?fetch=0').catch((e) => ({ error: String(e.message || e) })),
            call(ctx, 'GET', '/api/ollama/router').catch(() => null),
          ]);
          return asText({
            kernel: { serverRevision: health.serverRevision, version: health.version || health.kernel_version },
            ollama: ollamaRouter || {
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
        case 'svl_mcp_hub_status':
          return asText(await call(ctx, 'GET', '/api/mcp/hub/status'));
        case 'svl_ollama_router':
          return asText(await call(ctx, 'GET', '/api/ollama/router'));
        case 'svl_services_overview': {
          const [telemetry, mcpHub] = await Promise.all([
            call(ctx, 'GET', '/api/py/svl364/telemetry?ship=1', undefined, 60000).catch((e) => ({ error: String(e.message || e) })),
            call(ctx, 'GET', '/api/mcp/hub/status').catch((e) => ({ error: String(e.message || e) })),
          ]);
          return asText({ telemetry, mcpHub });
        }
        case 'svl_chat': {
          const agent = AGENTS.includes(String(args.agent) as any) ? String(args.agent) : 'Jyn';
          const defaultChannel = agent === 'SI_Sphere' ? 'si_sphere' : agent === 'JEDI_Omni_OS' ? 'jedi' : 'jyn';
          const channelKey = String(args.channel || defaultChannel);
          const conversationId = CHANNELS[channelKey] || CHANNELS.jyn;
          const message = str(args.message, 8000);
          const msgId = `user-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          await call(ctx, 'POST', '/api/py/chat/conversations/message', {
            conversation_id: conversationId,
            title: '',
            model: 'svl-hybrid-router',
            origin: 'mcp-svl',
            eventId: `evt-${msgId}`,
            message: {
              id: msgId,
              role: 'user',
              sender: 'SVL MCP',
              timestamp: new Date().toISOString(),
              content: message,
            },
          });
          const reply = await call(
            ctx,
            'POST',
            '/api/chat',
            { message, targetAgent: agent, conversationId, origin: 'mcp-svl', history: [] },
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
            { terminalType: terminal, command: str(args.command), origin: 'mcp-svl' },
            120000,
          ).catch((e) => ({ ok: false, stderr: String(e.message || e) }));
          return asText([r.stdout, r.stderr ? `STDERR:\n${r.stderr}` : ''].filter(Boolean).join('\n') || '(brak wyjścia)');
        }
        case 'svl_ship_telemetry':
          return asText(await call(ctx, 'GET', '/api/py/svl364/telemetry?ship=1', undefined, 60000));
        case 'svl_ssh_status':
          return asText(await call(ctx, 'GET', '/api/svl364/ssh-mcp/status'));
        case 'svl_ssh_configure':
          return asText(await call(ctx, 'POST', '/api/svl364/ssh-mcp/config', {
            action: 'configure',
            alias: str(args.alias || 'Ship', 63),
            hostname: str(args.hostname, 253),
            port: Math.max(1, Math.min(65535, Number(args.port) || 22)),
            user: str(args.user, 63),
            generate_key: args.generate_key !== false,
          }, 60000));
        case 'svl_ssh_public_key':
          return asText(await call(ctx, 'GET', '/api/py/svl364/ssh/public-key'));
        case 'svl_ssh_test':
          return asText(await call(ctx, 'POST', '/api/py/svl364/ssh/test', {}, 60000));
        case 'svl_ssh_exec': {
          if (args.confirmed !== true) {
            return {
              content: [{ type: 'text' as const, text: 'Wykonanie SSH wymaga confirmed=true.' }],
              isError: true,
            };
          }
          return asText(await call(ctx, 'POST', '/api/svl364/ssh/exec', {
            command: str(args.command, 4000),
            confirmed: true,
            raw: true,
            timeout_sec: Math.max(2, Math.min(60, Number(args.timeout_sec) || 15)),
          }, 120000));
        }
        case 'svl_ollama_tunnel':
          if (args.enabled === undefined) {
            return asText(await call(ctx, 'GET', '/api/svl364/ollama-tunnel'));
          }
          return asText(await call(ctx, 'POST', '/api/svl364/ollama-tunnel', {
            enabled: args.enabled === true,
            ...(args.target ? { target: str(args.target, 253) } : {}),
            ...(args.shipPort ? { shipPort: Math.max(1, Math.min(65535, Number(args.shipPort))) } : {}),
            ...(args.localPort ? { localPort: Math.max(1, Math.min(65535, Number(args.localPort))) } : {}),
          }, 30000));
        case 'svl_ship_root_exec': {
          if (args.confirmed !== true) {
            return {
              content: [{ type: 'text' as const, text: 'Wykonanie polecenia ROOT na SVL-364 wymaga confirmed=true.' }],
              isError: true,
            };
          }
          return asText(await call(ctx, 'POST', '/api/svl364/root/exec', {
            command: str(args.command, 4000),
            confirmed: true,
            raw: true,
            transport: String(args.transport || 'auto'),
            timeout_sec: Math.max(2, Math.min(60, Number(args.timeout_sec) || 30)),
          }, 120000));
        }
        case 'svl_ship_mcp_bridge': {
          const action = String(args.action || 'status').trim().toLowerCase();
          if (action === 'status') return asText(await call(ctx, 'GET', '/api/svl364/mcp-bridge/status'));
          if (action === 'test') return asText(await call(ctx, 'POST', '/api/svl364/mcp-bridge/test', { timeout_sec: 12 }, 30000));
          if (action === 'configure' || action === 'disconnect') {
            return asText(await call(ctx, 'POST', '/api/svl364/mcp-bridge/config', {
              disconnect: action === 'disconnect',
              ...(args.url !== undefined ? { url: str(args.url, 512) } : {}),
              ...(args.token !== undefined ? { token: str(args.token, 512) } : {}),
              ...(args.root_exec_enabled !== undefined ? { root_exec_enabled: Boolean(args.root_exec_enabled) } : {}),
            }));
          }
          const r = await call(ctx, 'POST', '/api/mcp/svl364', {
            jsonrpc: '2.0',
            id: `mcp-bridge-${Date.now()}`,
            method: 'tools/call',
            params: {
              name: 'svl364_mcp_connect',
              arguments: {
                action: 'call',
                remote_tool: str(args.remote_tool, 128),
                remote_arguments: args.remote_arguments && typeof args.remote_arguments === 'object' ? args.remote_arguments : {},
              },
            },
          }, 120000);
          return asText(r?.result?.content?.[0]?.text || r);
        }
        case 'svl_ship_manage': {
          const { tool, ...toolArgs } = args;
          const r = await call(ctx, 'POST', '/api/mcp/svl364', {
            jsonrpc: '2.0',
            id: `mcp-${Date.now()}`,
            method: 'tools/call',
            params: { name: str(tool, 80), arguments: toolArgs },
          }, 180000);
          return asText(r?.result?.content?.[0]?.text || r);
        }
        case 'svl_infrastructure_registry': {
          const action = String(args.action || 'overview').trim().toLowerCase();
          const payload = args.payload && typeof args.payload === 'object' ? args.payload : {};
          if (action === 'overview' || action === 'sync_mcp') {
            const q = action === 'sync_mcp' ? '?sync=1' : '';
            return asText(await call(ctx, 'GET', `/api/infrastructure/overview${q}`, undefined, 30000));
          }
          if (action === 'upsert_asset') return asText(await call(ctx, 'POST', '/api/infrastructure/assets', payload));
          if (action === 'upsert_mission') return asText(await call(ctx, 'POST', '/api/infrastructure/missions', payload));
          if (action === 'upsert_research') return asText(await call(ctx, 'POST', '/api/infrastructure/research', payload));
          if (action === 'update_botany') return asText(await call(ctx, 'POST', '/api/infrastructure/botany', payload));
          if (action === 'order_upgrade') return asText(await call(ctx, 'POST', '/api/infrastructure/procurement', payload));
          return { content: [{ type: 'text' as const, text: `Nieznana akcja svl_infrastructure_registry: ${action}` }], isError: true };
        }
        case 'svl_logs':
          return asText(await readLogTail(ctx.logDir, String(args.file || 'system'), Number(args.lines) || 80, str(args.contains, 200), str(args.level, 10)));
        case 'svl_memory_search': {
          const r = await call(ctx, 'POST', '/api/py/agents/memory/search', {
            agent: String(args.agent || 'Jyn'),
            query: str(args.query, 500),
            limit: Math.max(1, Math.min(50, Number(args.limit) || 12)),
          });
          return asText((r.memories || []).map((m: any) => `- [${m.kind}] ${m.content}`).join('\n') || '(brak wspomnień)');
        }
        case 'svl_memory_add': {
          const r = await call(ctx, 'POST', '/api/py/agents/memory', {
            agent: String(args.agent || 'Jyn'),
            kind: String(args.kind || 'fact'),
            content: str(args.content, 2000),
            source: 'mcp-svl',
            origin: 'mcp-svl',
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
            { action: String(args.action || 'status'), message: str(args.message || 'SVL: synchronizacja przez MCP', 200) },
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
            origin: 'mcp-svl',
          });
          return asText(r.deduplicated ? 'Takie powiadomienie już istnieje.' : 'Jyn opublikował powiadomienie na kanale „wszyscy”.');
        }
        case 'svl_antivirus_scan': {
          const r = await call(ctx, 'POST', '/api/security/antivirus/scan', { emitToChat: true, origin: 'mcp-svl' }, 120000);
          return asText(r.reportMarkdown || r);
        }
        case 'svl_report': {
          const r = await call(ctx, 'POST', '/api/py/kernel/markdown-report', {
            directive: 'Raport SVL_System na żądanie SVL MCP',
            emitToChat: true,
            origin: 'mcp-svl',
          });
          return asText(r.report || r);
        }
        default: {
          const toolName = String(request.params.name || '').trim();
          if (toolName.startsWith('svl364_')) {
            const r = await call(ctx, 'POST', '/api/mcp/svl364', {
              jsonrpc: '2.0',
              id: `svl-fed-${Date.now()}`,
              method: 'tools/call',
              params: { name: toolName, arguments: args },
            }, 180000);
            return asText(r?.result?.content?.[0]?.text || r);
          }
          const hubUrl = ctx.universalMcpUrl || 'http://127.0.0.1:3334/mcp';
          const hubToken = ctx.universalMcpToken || ctx.operatorToken;
          if (hubUrl && toolName) {
            const hubRes = await fetch(hubUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
                ...(hubToken ? { Authorization: `Bearer ${hubToken}` } : {}),
              },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: `svl-hub-${Date.now()}`,
                method: 'tools/call',
                params: { name: toolName, arguments: args },
              }),
              signal: AbortSignal.timeout(120000),
            });
            const rawText = await hubRes.text();
            let parsed: any = null;
            for (const line of rawText.split('\n')) {
              const s = line.trim().replace(/^data:\s*/, '');
              if (s.startsWith('{') && s.endsWith('}')) {
                try {
                  parsed = JSON.parse(s);
                } catch {
                  // ignore
                }
              }
            }
            if (!parsed) {
              try {
                parsed = JSON.parse(rawText);
              } catch {
                // ignore
              }
            }
            if (parsed?.result?.content) {
              return {
                content: parsed.result.content,
                isError: Boolean(parsed.result.isError),
              };
            }
          }
          return { content: [{ type: 'text' as const, text: `Nieznane narzędzie: ${request.params.name}` }], isError: true };
        }
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
