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
  'XAI_API_KEY',
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
