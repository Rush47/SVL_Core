// Samodzielny serwer MCP SVL (pełny odczyt/zapis) + automatyczny tunel do internetu.
//   npm run mcp          → Streamable HTTP na 127.0.0.1:MCP_PORT (/mcp) + tunel (MCP_TUNNEL)
//   npm run mcp:stdio    → transport stdio (lokalne klienty: Claude Desktop, Gemini CLI „command”)
// Token: MCP_TOKEN albo wygenerowany i zapisany w data/svl_mcp_token.secret (0600). Nigdy nie trafia do logów.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadMcpConfig, type McpConfig } from './config.ts';
import { ensureToken, extractToken, tokenMatches } from './auth.ts';
import { createFullMcpServer, visibleTools, type ToolContext } from './tools.ts';
import { TunnelManager, type TunnelStatus } from './tunnel.ts';
import { SvlFileLogger, scrubSensitiveText } from '../server/fileLogger.ts';

export function connectorInfo(cfg: McpConfig, token: string, tunnel: TunnelStatus | null) {
  const localUrl = `http://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${cfg.port}/mcp`;
  const mcpUrl = tunnel?.mcpUrl || null;
  const url = mcpUrl || localUrl;
  return {
    updatedAt: new Date().toISOString(),
    localUrl,
    publicUrl: mcpUrl,
    urlWithKey: cfg.allowUrlToken ? `${url}/k/${token}` : null,
    authorizationHeader: `Bearer ${token}`,
    geminiCli: { mcpServers: { svl: { httpUrl: url, headers: { Authorization: `Bearer ${token}` }, timeout: 600000 } } },
    claudeCode: `claude mcp add --transport http svl ${url} --header "Authorization: Bearer ${token}"`,
  };
}

function writeSecretJson(file: string, data: unknown, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

export function createMcpHttpApp(cfg: McpConfig, token: string, ctx: ToolContext, log: (level: 'INFO' | 'WARN' | 'ERROR', msg: string) => void) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64mb' }));

  // Bez autoryzacji i bez szczegółów — tylko do watchdoga tunelu / monitoringu.
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'svl-mcp' });
  });

  const authorized = (req: Request) =>
    tokenMatches(extractToken(req.headers), token) || (cfg.allowUrlToken && tokenMatches(String(req.params?.key || ''), token));

  app.get(['/status', '/status/k/:key'], (req, res) => {
    if (!authorized(req)) {
      res.status(401).json({ ok: false, error: 'Wymagany token: Authorization: Bearer <MCP_TOKEN>.' });
      return;
    }
    res.json({ ok: true, root: cfg.root, readOnly: cfg.readOnly, allowShell: cfg.allowShell, tools: visibleTools(ctx).map((t) => t.name), status: ctx.getStatus?.() });
  });

  const handle = async (req: Request, res: Response) => {
    if (!authorized(req)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="svl-mcp"');
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: Authorization: Bearer <MCP_TOKEN>' }, id: null });
      return;
    }
    const server = createFullMcpServer(ctx, (name, ok) => log(ok ? 'INFO' : 'WARN', `MCP narzędzie ${name}: ${ok ? 'OK' : 'błąd'}`));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      log('ERROR', `MCP: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  };
  // Klienci OAuth (np. Claude.ai) szukają metadanych — jawne 404 = „bez OAuth, użyj tokenu”.
  app.get('/.well-known/{*any}', (_req, res) => {
    res.status(404).json({ error: 'OAuth nieobsługiwany — użyj Authorization: Bearer <MCP_TOKEN> albo /mcp/k/<MCP_TOKEN>.' });
  });
  app.all(['/mcp', '/mcp/k/:key'], (req, res) => void handle(req, res));
  return app;
}

async function main(): Promise<void> {
  const cfg = loadMcpConfig();
  const stdio = process.argv.includes('--stdio');
  const { token, source } = ensureToken(cfg.token, cfg.tokenFile);
  const logger = new SvlFileLogger({ logDir: cfg.logDir });
  const log = (level: 'INFO' | 'WARN' | 'ERROR', message: string) => {
    const clean = scrubSensitiveText(message, [token]);
    logger.log({ layer: 'GATEWAY', level, category: 'mcp_full', message: clean } as any, [token]);
    // stdio: stdout należy do protokołu MCP — komunikaty tylko na stderr.
    console.error(`[svl-mcp] ${clean}`);
  };

  let tunnel: TunnelManager | null = null;
  const ctx: ToolContext = {
    root: cfg.root,
    readOnly: cfg.readOnly,
    allowShell: cfg.allowShell,
    shellTimeoutMs: cfg.shellTimeoutMs,
    maxReadBytes: cfg.maxReadBytes,
    svlBaseUrl: cfg.svlBaseUrl,
    svlOperatorToken: cfg.svlOperatorToken,
    logDir: cfg.logDir,
    getStatus: () => ({ tunnel: tunnel ? { ...tunnel.status } : { kind: 'none', state: stdio ? 'stdio' : 'off' } }),
  };
  fs.mkdirSync(cfg.root, { recursive: true });

  if (stdio) {
    const server = createFullMcpServer(ctx);
    await server.connect(new StdioServerTransport());
    log('INFO', `MCP (stdio) gotowy, root=${cfg.root}, readOnly=${cfg.readOnly}, shell=${cfg.allowShell}`);
    return;
  }

  const persist = () => {
    const status = tunnel ? { ...tunnel.status } : null;
    writeSecretJson(cfg.stateFile, { ...(status || { kind: 'none', state: 'off' }), localUrl: `http://${cfg.host}:${cfg.port}/mcp`, updatedAt: new Date().toISOString() }, 0o644);
    writeSecretJson(cfg.connectorFile, connectorInfo(cfg, token, status), 0o600);
  };

  const app = createMcpHttpApp(cfg, token, ctx, log);
  const httpServer = app.listen(cfg.port, cfg.host, () => {
    log('INFO', `MCP (pełny R/W) nasłuchuje na http://${cfg.host}:${cfg.port}/mcp · root=${cfg.root} · readOnly=${cfg.readOnly} · shell=${cfg.allowShell}`);
    log('INFO', `Token MCP: ${source === 'env' ? 'z MCP_TOKEN (.env)' : `w pliku ${cfg.tokenFile} (0600)`}. Dane konektora: ${cfg.connectorFile}`);
    tunnel = new TunnelManager(
      { kind: cfg.tunnel, port: cfg.port, bin: cfg.tunnelBin, cloudflaredToken: cfg.cloudflaredTunnelToken, publicUrl: cfg.publicUrlOverride },
      {
        onUrl: (s) => {
          persist();
          log('INFO', `Tunel ${s.kind} aktywny: ${s.mcpUrl} (adres zapisany w ${cfg.stateFile})`);
        },
        onLog: (level, message) => {
          log(level, message);
          persist();
        },
      },
    );
    tunnel.start();
    persist();
  });

  const shutdown = () => {
    tunnel?.stop();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isEntry) {
  main().catch((error) => {
    console.error(`[svl-mcp] ${scrubSensitiveText(error instanceof Error ? error.message : String(error))}`);
    process.exit(1);
  });
}
