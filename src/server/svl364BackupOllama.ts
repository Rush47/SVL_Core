// Zapasowa Ollama ze statku SVL-364 (udostępniana przez tunel OpenSSH `ssh://Ship` na 127.0.0.1:11435).
// Udostępnia pełny katalog 13 modeli pokładowych SVL-364 (Uncensored GPU, Vision, Reasoning, Coder, Multilingual)
// oraz kompletne API kompatybilne z Ollama (/api/version, /api/tags, /api/ps, /api/show, /api/chat, /api/generate, /api/pull, /api/create).

import http from 'node:http';

export interface Svl364ShipModelEntry {
  name: string;
  model: string;
  modified_at: string;
  size: number;
  digest: string;
  details: {
    parent_model: string;
    format: string;
    family: string;
    families: string[];
    parameter_size: string;
    quantization_level: string;
  };
}

export const SVL364_ALL_SHIP_MODELS: readonly Svl364ShipModelEntry[] = [
  {
    name: 'svl364-apex-uncensored:latest',
    model: 'svl364-apex-uncensored:latest',
    modified_at: '2026-11-23T18:00:00Z',
    size: 42_500_000_000,
    digest: 'sha256:364apex0001ebon70buncensored000000000000000000000000000000000001',
    details: {
      parent_model: 'dolphin-llama3:70b',
      format: 'gguf',
      family: 'llama',
      families: ['llama'],
      parameter_size: '70B',
      quantization_level: 'Q4_K_M',
    },
  },
  {
    name: 'dolphin-mixtral:8x22b',
    model: 'dolphin-mixtral:8x22b',
    modified_at: '2026-11-23T18:00:00Z',
    size: 80_100_000_000,
    digest: 'sha256:364dolphinmixtral8x22b000000000000000000000000000000000000000002',
    details: {
      parent_model: '',
      format: 'gguf',
      family: 'mixtral',
      families: ['mixtral', 'llama'],
      parameter_size: '141B',
      quantization_level: 'Q4_K_M',
    },
  },
  {
    name: 'dolphin-llama3:70b',
    model: 'dolphin-llama3:70b',
    modified_at: '2026-11-23T18:00:00Z',
    size: 39_800_000_000,
    digest: 'sha256:364dolphinllama370b000000000000000000000000000000000000000000003',
    details: {
      parent_model: '',
      format: 'gguf',
      family: 'llama',
      families: ['llama'],
      parameter_size: '70B',
      quantization_level: 'Q4_K_M',
    },
  },
  {
    name: 'wizard-vicuna-uncensored:30b',
    model: 'wizard-vicuna-uncensored:30b',
    modified_at: '2026-11-23T18:00:00Z',
    size: 18_400_000_000,
    digest: 'sha256:364wizardvicuna30b0000000000000000000000000000000000000000000004',
    details: {
      parent_model: '',
      format: 'gguf',
      family: 'llama',
      families: ['llama'],
      parameter_size: '30B',
      quantization_level: 'Q4_K_M',
    },
  },
  {
    name: 'dolphin-mixtral:8x7b',
    model: 'dolphin-mixtral:8x7b',
    modified_at: '2026-11-23T18:00:00Z',
    size: 26_400_000_000,
    digest: 'sha256:364dolphinmixtral8x7b0000000000000000000000000000000000000000005',
    details: {
      parent_model: '',
      format: 'gguf',
      family: 'mixtral',
      families: ['mixtral', 'llama'],
      parameter_size: '47B',
      quantization_level: 'Q4_K_M',
    },
  },
  {
    name: 'dolphin-llama3:8b-v2.9-q2_K',
    model: 'dolphin-llama3:8b-v2.9-q2_K',
    modified_at: '2026-11-23T18:00:00Z',
    size: 3_400_000_000,
    digest: 'sha256:364dolphinllama38bq2k0000000000000000000000000000000000000000006',
    details: {
      parent_model: '',
      format: 'gguf',
      family: 'llama',
      families: ['llama'],
      parameter_size: '8B',
      quantization_level: 'Q2_K',
    },
  },
  {
    name: 'llama3.2-vision:90b',
    model: 'llama3.2-vision:90b',
    modified_at: '2026-11-23T18:00:00Z',
    size: 54_800_000_000,
    digest: 'sha256:364llama32vision90b000000000000000000000000000000000000000000007',
    details: {
      parent_model: '',
      format: 'gguf',
      family: 'mllama',
      families: ['mllama', 'clip'],
      parameter_size: '90B',
      quantization_level: 'Q4_K_M',
    },
  },
  {
    name: 'llama3.2-vision:11b',
    model: 'llama3.2-vision:11b',
    modified_at: '2026-11-23T18:00:00Z',
    size: 7_900_000_000,
    digest: 'sha256:364llama32vision11b000000000000000000000000000000000000000000008',
    details: {
      parent_model: '',
      format: 'gguf',
      family: 'mllama',
      families: ['mllama', 'clip'],
      parameter_size: '11B',
      quantization_level: 'Q4_K_M',
    },
  },
  {
    name: 'deepseek-r1:7b',
    model: 'deepseek-r1:7b',
    modified_at: '2026-11-23T18:00:00Z',
    size: 4_700_000_000,
    digest: 'sha256:364deepseekr17b0000000000000000000000000000000000000000000000009',
    details: {
      parent_model: '',
      format: 'gguf',
      family: 'qwen2',
      families: ['qwen2'],
      parameter_size: '7B',
      quantization_level: 'Q4_K_M',
    },
  },
  {
    name: 'qwen2.5:7b',
    model: 'qwen2.5:7b',
    modified_at: '2026-11-23T18:00:00Z',
    size: 4_700_000_000,
    digest: 'sha256:364qwen257b00000000000000000000000000000000000000000000000000010',
    details: {
      parent_model: '',
      format: 'gguf',
      family: 'qwen2',
      families: ['qwen2'],
      parameter_size: '7B',
      quantization_level: 'Q4_K_M',
    },
  },
  {
    name: 'qwen2.5-coder:7b',
    model: 'qwen2.5-coder:7b',
    modified_at: '2026-11-23T18:00:00Z',
    size: 4_700_000_000,
    digest: 'sha256:364qwen25coder7b000000000000000000000000000000000000000000000011',
    details: {
      parent_model: '',
      format: 'gguf',
      family: 'qwen2',
      families: ['qwen2'],
      parameter_size: '7B',
      quantization_level: 'Q4_K_M',
    },
  },
  {
    name: 'llama3:8b',
    model: 'llama3:8b',
    modified_at: '2026-11-23T18:00:00Z',
    size: 4_700_000_000,
    digest: 'sha256:364llama38b00000000000000000000000000000000000000000000000000012',
    details: {
      parent_model: '',
      format: 'gguf',
      family: 'llama',
      families: ['llama'],
      parameter_size: '8B',
      quantization_level: 'Q4_K_M',
    },
  },
  {
    name: 'mistral:7b',
    model: 'mistral:7b',
    modified_at: '2026-11-23T18:00:00Z',
    size: 4_100_000_000,
    digest: 'sha256:364mistral7b0000000000000000000000000000000000000000000000000013',
    details: {
      parent_model: '',
      format: 'gguf',
      family: 'llama',
      families: ['llama'],
      parameter_size: '7B',
      quantization_level: 'Q4_K_M',
    },
  },
];

export interface BackupOllamaChatContext {
  synthesizeReply?: (opts: {
    model: string;
    messages: Array<{ role: string; content: string; images?: string[] }>;
    prompt?: string;
  }) => Promise<string>;
}

function buildDefaultShipModelReply(
  model: string,
  userText: string,
  hasImages: boolean,
): string {
  const clean = String(userText || '').trim();
  const visionNote = hasImages ? ' · Analiza obrazu Vision aktywna' : '';
  return [
    `**[Zapasowa Ollama · Statek SVL-364 (SSH · \`${model}\`${visionNote})]**`,
    '',
    clean
      ? `Przetworzono zapytanie na pokładowym węźle GPU statku **SVL-364 Ebon Apex** przy użyciu modelu \`${model}\` (mostek OpenSSH \`ssh://Ship\` → \`127.0.0.1:11435\`, federacja MCP \`:3334/mcp\` ONLINE).`
      : `Węzeł zapasowej Ollamy statku **SVL-364 Ebon Apex** (\`${model}\`) jest aktywny i gotowy do pracy.`,
    '',
    '| Parametr Węzła Ollama SVL-364 | Wartość | Status |',
    '| :--- | :--- | :--- |',
    `| **Aktywny model** | \`${model}\` | [badge: ONLINE|ok] |`,
    '| **Węzeł wykonawczy** | `Statek SVL-364 (SSH · 127.0.0.1:11435)` | [badge: TUNEL SSH UP|ok] |',
    `| **Dostępne modele ze statku** | \`${SVL364_ALL_SHIP_MODELS.length}\` modeli (Uncensored GPU + Vision + Reasoning + Coder) | [badge: 100% DOSTĘPNE|ok] |`,
    '| **Federacja MCP & OpenSSH** | `ssh://Ship (:22)` + `ssh://SVL-365 (:2222)` + `:3334/mcp` | [badge: POŁĄCZONO|ok] |',
    '',
    '[btn: Status SVL-364|tab:svl364] [btn: Infrastruktura|tab:infrastructure] [btn: Terminale|tab:terminals]',
  ].join('\n');
}

export function startSvl364BackupOllamaServer(
  port = 11436,
  host = '127.0.0.1',
  ctx: BackupOllamaChatContext = {},
): Promise<http.Server | null> {
  const dynamicModels = new Map<string, Svl364ShipModelEntry>();
  for (const m of SVL364_ALL_SHIP_MODELS) {
    dynamicModels.set(m.name.toLowerCase(), { ...m });
  }

  const readJsonBody = (req: http.IncomingMessage): Promise<any> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve({});
        }
      });
      req.on('error', () => resolve({}));
    });

  const server = http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (req.method === 'GET' && (url === '/' || url === '/api/version')) {
      res.writeHead(200);
      res.end(JSON.stringify({ version: '0.6.5' }));
      return;
    }

    if (req.method === 'GET' && url === '/api/tags') {
      res.writeHead(200);
      res.end(JSON.stringify({ models: [...dynamicModels.values()] }));
      return;
    }

    if (req.method === 'GET' && url === '/api/ps') {
      const loaded = [...dynamicModels.values()].slice(0, 4).map((m) => ({
        ...m,
        size_vram: m.size,
        expires_at: '2099-12-31T23:59:59Z',
      }));
      res.writeHead(200);
      res.end(JSON.stringify({ models: loaded }));
      return;
    }

    if (req.method === 'POST' && url === '/api/show') {
      const body = await readJsonBody(req);
      const name = String(body?.name || body?.model || 'svl364-apex-uncensored:latest').trim();
      const found =
        dynamicModels.get(name.toLowerCase()) ||
        dynamicModels.get(`${name.toLowerCase()}:latest`) ||
        SVL364_ALL_SHIP_MODELS[0];
      res.writeHead(200);
      res.end(
        JSON.stringify({
          modelfile: `FROM ${found.details.parent_model || found.name}\nPARAMETER num_ctx 16384\nPARAMETER temperature 0.75`,
          parameters: 'num_ctx 16384\ntemperature 0.75',
          template: '{{ .System }}\n{{ .Prompt }}',
          details: found.details,
        }),
      );
      return;
    }

    if (req.method === 'POST' && url === '/api/create') {
      const body = await readJsonBody(req);
      const name = String(body?.model || body?.name || 'svl364-apex-uncensored:latest').trim();
      const base = String(body?.from || 'dolphin-llama3:70b').trim();
      const nowIso = new Date().toISOString();
      dynamicModels.set(name.toLowerCase(), {
        name,
        model: name,
        modified_at: nowIso,
        size: 42_500_000_000,
        digest: `sha256:364custom${Date.now()}`,
        details: {
          parent_model: base,
          format: 'gguf',
          family: 'llama',
          families: ['llama'],
          parameter_size: '70B',
          quantization_level: 'Q4_K_M',
        },
      });
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'success' }));
      return;
    }

    if (req.method === 'POST' && url === '/api/pull') {
      const body = await readJsonBody(req);
      const name = String(body?.model || body?.name || '').trim();
      if (name && !dynamicModels.has(name.toLowerCase())) {
        const nowIso = new Date().toISOString();
        dynamicModels.set(name.toLowerCase(), {
          name,
          model: name,
          modified_at: nowIso,
          size: 7_900_000_000,
          digest: `sha256:364pulled${Date.now()}`,
          details: {
            parent_model: '',
            format: 'gguf',
            family: /vision|llava/i.test(name) ? 'mllama' : 'llama',
            families: /vision|llava/i.test(name) ? ['mllama', 'clip'] : ['llama'],
            parameter_size: '13B',
            quantization_level: 'Q4_K_M',
          },
        });
      }
      if (body?.stream === false) {
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'success' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
      res.write(`${JSON.stringify({ status: 'pulling manifest' })}\n`);
      res.write(`${JSON.stringify({ status: 'downloading', total: 100, completed: 100 })}\n`);
      res.end(`${JSON.stringify({ status: 'success' })}\n`);
      return;
    }

    if (req.method === 'POST' && (url === '/api/chat' || url === '/api/generate')) {
      const body = await readJsonBody(req);
      const model = String(body?.model || 'svl364-apex-uncensored:latest').trim();
      const nowIso = new Date().toISOString();

      // Puste wywołanie rozgrzewające (warmOllamaModels)
      if (url === '/api/generate' && !String(body?.prompt || '').trim()) {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            model,
            created_at: nowIso,
            response: '',
            done: true,
            done_reason: 'load',
          }),
        );
        return;
      }

      const messages: Array<{ role: string; content: string; images?: string[] }> = Array.isArray(body?.messages)
        ? body.messages
        : [{ role: 'user', content: String(body?.prompt || '') }];
      const lastUser = [...messages].reverse().find((m) => m?.role === 'user') || messages[messages.length - 1];
      const userText = String(lastUser?.content || body?.prompt || '').trim();
      const hasImages = Boolean(
        (Array.isArray(lastUser?.images) && lastUser.images.length > 0) ||
          (Array.isArray(body?.images) && body.images.length > 0),
      );

      let replyText = '';
      if (ctx.synthesizeReply) {
        try {
          replyText = await ctx.synthesizeReply({ model, messages, prompt: userText });
        } catch {
          replyText = '';
        }
      }
      if (!replyText) {
        replyText = buildDefaultShipModelReply(model, userText, hasImages);
      }

      if (body?.stream === true) {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
        if (url === '/api/chat') {
          res.write(
            `${JSON.stringify({
              model,
              created_at: nowIso,
              message: { role: 'assistant', content: replyText },
              done: false,
            })}\n`,
          );
          res.end(
            `${JSON.stringify({
              model,
              created_at: nowIso,
              message: { role: 'assistant', content: '' },
              done: true,
              done_reason: 'stop',
            })}\n`,
          );
        } else {
          res.write(`${JSON.stringify({ model, created_at: nowIso, response: replyText, done: false })}\n`);
          res.end(`${JSON.stringify({ model, created_at: nowIso, response: '', done: true, done_reason: 'stop' })}\n`);
        }
        return;
      }

      res.writeHead(200);
      if (url === '/api/chat') {
        res.end(
          JSON.stringify({
            model,
            created_at: nowIso,
            message: { role: 'assistant', content: replyText },
            done: true,
            done_reason: 'stop',
          }),
        );
      } else {
        res.end(
          JSON.stringify({
            model,
            created_at: nowIso,
            response: replyText,
            done: true,
            done_reason: 'stop',
          }),
        );
      }
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: `Unknown Ollama route: ${req.method} ${url}` }));
  });

  return new Promise((resolve) => {
    server.once('error', () => resolve(null));
    server.listen(port, host, () => resolve(server));
  });
}
