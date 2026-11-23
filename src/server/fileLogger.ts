import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export type LogLayer = 'GATEWAY' | 'PYTHON' | 'GUI' | 'WS' | 'SYSTEM';
export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

export interface StructuredLogEntry {
  timestamp?: string;
  layer: LogLayer;
  level: LogLevel;
  category: string;
  message: string;
  correlationId?: string;
  origin?: string;
  details?: Record<string, unknown> | string | null;
}

export interface GuiLogInput {
  kind?: unknown;
  level?: unknown;
  action?: unknown;
  target?: unknown;
  tab?: unknown;
  detail?: unknown;
  url?: unknown;
  origin?: unknown;
  correlationId?: unknown;
  timestamp?: unknown;
}

const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB rotation threshold

export const LOG_FILE_NAMES = {
  master: 'system_wszystko.txt',
  gateway: 'backend_gateway.txt',
  python: 'backend_python.txt',
  gui: 'gui_zdarzenia.txt',
} as const;

const ENV_SECRET_KEYS = [
  'SVL_OPERATOR_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'OPENAI_API_KEY',
];

const SENSITIVE_FIELD_RE = /(token|secret|password|passwd|haslo|hasło|apikey|api_key|authorization|private[_-]?key|credential)/i;

export function resolveLogDirectory(customDir?: string): string {
  const configured = (customDir ?? process.env.SVL_LOG_DIR ?? '').trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.resolve(process.cwd(), 'logi');
}

export function scrubSensitiveText(input: unknown, extraSecrets: string[] = []): string {
  let cleaned = String(input ?? '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

  for (const key of ENV_SECRET_KEYS) {
    const val = process.env[key];
    if (val && val.length >= 8) {
      cleaned = cleaned.split(val).join('[REDACTED]');
    }
  }
  for (const secret of extraSecrets) {
    if (secret && secret.length >= 8) {
      cleaned = cleaned.split(secret).join('[REDACTED]');
    }
  }

  cleaned = cleaned
    .replace(/\bBearer\s+[A-Za-z0-9_.\-=+/]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\bBasic\s+[A-Za-z0-9+/=]{12,}/gi, 'Basic [REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\bsvl-auth\.[A-Za-z0-9_-]{4,}/gi, 'svl-auth.[REDACTED]')
    .replace(/(x-svl-operator-token|authorization)\s*[:=]\s*['"]?[^\s,'";\]]+/gi, '$1=[REDACTED]')
    .replace(
      /\b(api[_-]?key|password|passwd|operator[_-]?token|secret|token)\s*[:=]\s*['"]?([^\s,'";\]\}]{4,})/gi,
      '$1=[REDACTED]',
    )
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]{32,}/gi, '[DATA_IMAGE_BASE64]');

  return cleaned.trim().slice(0, 2400);
}

export function scrubDetailsObject(
  value: unknown,
  extraSecrets: string[] = [],
  depth = 0,
): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 4) return '[MAX_DEPTH]';
  if (typeof value === 'string') return scrubSensitiveText(value, extraSecrets);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 25).map((item) => scrubDetailsObject(item, extraSecrets, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
      if (SENSITIVE_FIELD_RE.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = scrubDetailsObject(v, extraSecrets, depth + 1);
      }
    }
    return out;
  }
  return scrubSensitiveText(String(value), extraSecrets);
}

export function formatTxtLogLine(entry: StructuredLogEntry, extraSecrets: string[] = []): string {
  const ts = entry.timestamp || new Date().toISOString();
  const layer = String(entry.layer || 'SYSTEM').toUpperCase().slice(0, 16);
  const level = String(entry.level || 'INFO').toUpperCase().slice(0, 8);
  const category = scrubSensitiveText(entry.category || 'general', extraSecrets).slice(0, 48) || 'general';
  const message = scrubSensitiveText(entry.message || '', extraSecrets) || '(brak treści)';

  const tags: string[] = [`[${ts}]`, `[${layer}]`, `[${level}]`, `[${category}]`];
  if (entry.correlationId) {
    const corr = scrubSensitiveText(entry.correlationId, extraSecrets).slice(0, 80);
    if (corr) tags.push(`[corr=${corr}]`);
  }
  if (entry.origin) {
    const origin = scrubSensitiveText(entry.origin, extraSecrets).slice(0, 80);
    if (origin) tags.push(`[origin=${origin}]`);
  }

  let detailsSuffix = '';
  if (entry.details !== undefined && entry.details !== null && entry.details !== '') {
    if (typeof entry.details === 'string') {
      const cleaned = scrubSensitiveText(entry.details, extraSecrets);
      if (cleaned) detailsSuffix = ` | ${cleaned}`;
    } else if (typeof entry.details === 'object') {
      const cleanedObj = scrubDetailsObject(entry.details, extraSecrets);
      try {
        const serialized = JSON.stringify(cleanedObj);
        if (serialized && serialized !== '{}' && serialized !== '[]') {
          detailsSuffix = ` | ${serialized.slice(0, 1200)}`;
        }
      } catch {
        // ignore unserializable details
      }
    }
  }

  return `${tags.join(' ')} ${message}${detailsSuffix}\n`;
}

export function normalizeGuiLogBatch(rawBody: unknown): StructuredLogEntry[] {
  const rawEvents: GuiLogInput[] = Array.isArray((rawBody as any)?.events)
    ? (rawBody as any).events.slice(0, 40)
    : rawBody && typeof rawBody === 'object'
      ? [rawBody as GuiLogInput]
      : [];

  const out: StructuredLogEntry[] = [];
  for (const item of rawEvents) {
    if (!item || typeof item !== 'object') continue;
    const rawLevel = String(item.level || 'INFO').toUpperCase();
    const level: LogLevel =
      rawLevel === 'ERROR' ? 'ERROR' : rawLevel === 'WARN' ? 'WARN' : rawLevel === 'DEBUG' ? 'DEBUG' : 'INFO';

    const kind = scrubSensitiveText(item.kind || 'gui_event').slice(0, 40) || 'gui_event';
    const action = scrubSensitiveText(item.action || kind).slice(0, 180);
    const target = scrubSensitiveText(item.target || '').slice(0, 180);
    const tab = scrubSensitiveText(item.tab || '').slice(0, 40);
    const url = scrubSensitiveText(item.url || '').slice(0, 180);
    const origin = scrubSensitiveText(item.origin || 'browser-gui').slice(0, 80) || 'browser-gui';
    const correlationId = scrubSensitiveText(item.correlationId || '').slice(0, 80) || undefined;

    let rawTs = typeof item.timestamp === 'string' ? item.timestamp.trim() : '';
    if (!rawTs || Number.isNaN(Date.parse(rawTs))) {
      rawTs = new Date().toISOString();
    }

    const detailValue =
      item.detail && typeof item.detail === 'object'
        ? scrubDetailsObject(item.detail)
        : item.detail
          ? scrubSensitiveText(item.detail).slice(0, 600)
          : undefined;

    const parts = [action];
    if (target) parts.push(`cel="${target}"`);
    if (tab) parts.push(`zakladka=${tab}`);
    if (url) parts.push(`url=${url}`);

    out.push({
      timestamp: rawTs,
      layer: 'GUI',
      level,
      category: kind,
      origin,
      correlationId,
      message: parts.filter(Boolean).join(' · '),
      details: detailValue as any,
    });
  }
  return out;
}

export class SvlFileLogger {
  public readonly logDir: string;
  private readonly maxFileBytes: number;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: { logDir?: string; maxFileBytes?: number } = {}) {
    this.logDir = resolveLogDirectory(options.logDir);
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.ensureReadySync();
  }

  public ensureReadySync(): void {
    fsSync.mkdirSync(this.logDir, { recursive: true });
    for (const fileName of Object.values(LOG_FILE_NAMES)) {
      const fullPath = path.join(this.logDir, fileName);
      if (!fsSync.existsSync(fullPath)) {
        const header =
          `=== SVL COREOS 2: APEX · LOG SYSTEMOWY (${fileName}) · Utworzono: ${new Date().toISOString()} ===\n`;
        fsSync.writeFileSync(fullPath, header, { encoding: 'utf8' });
      }
    }
  }

  private rotateIfTooLargeSync(filePath: string): void {
    try {
      const stat = fsSync.statSync(filePath);
      if (stat.size >= this.maxFileBytes) {
        const backupPath = filePath.replace(/\.txt$/i, '.prev.txt');
        try {
          fsSync.rmSync(backupPath, { force: true });
        } catch {
          // ignore
        }
        fsSync.renameSync(filePath, backupPath);
      }
    } catch {
      // file does not exist yet
    }
  }

  private targetFilesForEntry(entry: StructuredLogEntry): string[] {
    const targets: string[] = [LOG_FILE_NAMES.master];
    if (entry.layer === 'GUI') {
      targets.push(LOG_FILE_NAMES.gui);
    } else if (entry.layer === 'PYTHON') {
      targets.push(LOG_FILE_NAMES.python);
    } else if (entry.layer === 'GATEWAY' || entry.layer === 'WS') {
      targets.push(LOG_FILE_NAMES.gateway);
    } else {
      targets.push(LOG_FILE_NAMES.gateway);
    }
    return targets;
  }

  public logSync(entry: StructuredLogEntry, extraSecrets: string[] = []): void {
    try {
      this.ensureReadySync();
      const line = formatTxtLogLine(entry, extraSecrets);
      for (const fileName of this.targetFilesForEntry(entry)) {
        const fullPath = path.join(this.logDir, fileName);
        this.rotateIfTooLargeSync(fullPath);
        fsSync.appendFileSync(fullPath, line, { encoding: 'utf8' });
      }
    } catch {
      // Never throw from logging path
    }
  }

  public log(entry: StructuredLogEntry, extraSecrets: string[] = []): void {
    const line = formatTxtLogLine(entry, extraSecrets);
    const files = this.targetFilesForEntry(entry);
    this.writeQueue = this.writeQueue
      .then(async () => {
        await fs.mkdir(this.logDir, { recursive: true });
        for (const fileName of files) {
          const fullPath = path.join(this.logDir, fileName);
          this.rotateIfTooLargeSync(fullPath);
          await fs.appendFile(fullPath, line, { encoding: 'utf8' });
        }
      })
      .catch(() => {
        // Fallback sync if async queue hits transient issue
        this.logSync(entry, extraSecrets);
      });
  }

  public logBatch(entries: StructuredLogEntry[], extraSecrets: string[] = []): number {
    if (!Array.isArray(entries) || entries.length === 0) return 0;
    const perFileLines = new Map<string, string[]>();
    for (const entry of entries) {
      const line = formatTxtLogLine(entry, extraSecrets);
      for (const fileName of this.targetFilesForEntry(entry)) {
        const bucket = perFileLines.get(fileName);
        if (bucket) bucket.push(line);
        else perFileLines.set(fileName, [line]);
      }
    }

    this.writeQueue = this.writeQueue
      .then(async () => {
        await fs.mkdir(this.logDir, { recursive: true });
        for (const [fileName, lines] of perFileLines.entries()) {
          const fullPath = path.join(this.logDir, fileName);
          this.rotateIfTooLargeSync(fullPath);
          await fs.appendFile(fullPath, lines.join(''), { encoding: 'utf8' });
        }
      })
      .catch(() => {
        for (const entry of entries) {
          this.logSync(entry, extraSecrets);
        }
      });
    return entries.length;
  }

  public async flush(): Promise<void> {
    await this.writeQueue;
  }

  /**
   * Ostatnie wpisy WARN/ERROR z pliku zbiorczego — podstawa diagnostyki Jyn
   * (naprawa i poprawa systemu na podstawie prawdziwych zdarzeń, nie zmyślonych).
   */
  public async getRecentIssues(limit = 40): Promise<Array<{ level: string; category: string; message: string; at: string | null }>> {
    await this.flush();
    this.ensureReadySync();
    const fullPath = path.join(this.logDir, LOG_FILE_NAMES.master);
    let content = '';
    try {
      content = await fs.readFile(fullPath, 'utf8');
    } catch {
      return [];
    }
    const out: Array<{ level: string; category: string; message: string; at: string | null }> = [];
    const lines = content.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && out.length < Math.max(1, Math.min(200, limit)); i -= 1) {
      const line = lines[i];
      if (!/\[(?:WARN|ERROR)\]/.test(line)) continue;
      const at = line.match(/^\[([^\]]+)\]/)?.[1] || null;
      const level = line.match(/\[(WARN|ERROR)\]/)?.[1] || 'WARN';
      const category = line.match(/\[(?:WARN|ERROR)\]\s+\[([a-z0-9_.-]+)\]/i)?.[1] || 'system';
      const message = line.replace(/^.*?\[(?:WARN|ERROR)\]\s+(?:\[[^\]]+\]\s+)*/i, '').split('|')[0].trim().slice(0, 240);
      out.push({ level, category, message, at });
    }
    return out;
  }

  public async getSummary(): Promise<{
    logDir: string;
    files: Array<{ name: string; bytes: number; lines: number; updatedAt: string | null }>;
  }> {
    await this.flush();
    this.ensureReadySync();
    const files: Array<{ name: string; bytes: number; lines: number; updatedAt: string | null }> = [];
    for (const fileName of Object.values(LOG_FILE_NAMES)) {
      const fullPath = path.join(this.logDir, fileName);
      try {
        const stat = await fs.stat(fullPath);
        const content = await fs.readFile(fullPath, 'utf8');
        const lines = content ? content.split('\n').filter(Boolean).length : 0;
        files.push({
          name: fileName,
          bytes: stat.size,
          lines,
          updatedAt: stat.mtime.toISOString(),
        });
      } catch {
        files.push({ name: fileName, bytes: 0, lines: 0, updatedAt: null });
      }
    }
    return { logDir: this.logDir, files };
  }
}
