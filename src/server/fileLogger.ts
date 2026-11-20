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
  gateway: 'backend_gateway.ts'.replace('.ts', '.txt'),
  python: 'backend_python.txt',
  gui: 'gui_zdarzenia.txt',
} as const;
