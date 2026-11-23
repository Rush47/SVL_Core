// Uwierzytelnianie serwera MCP: obowiązkowy token Bearer (porównanie w stałym czasie).

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const MIN_TOKEN_LENGTH = 32;

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Zwraca token: z env (MCP_TOKEN), z pliku albo nowo wygenerowany i zapisany z prawami 0600.
 * Nigdy nie loguje samego tokenu — zwraca tylko źródło.
 */
export function ensureToken(envToken: string, tokenFile: string): { token: string; source: 'env' | 'file' | 'generated' } {
  const fromEnv = String(envToken || '').trim();
  if (fromEnv) {
    if (fromEnv.length < MIN_TOKEN_LENGTH) {
      throw new Error(`MCP_TOKEN musi mieć co najmniej ${MIN_TOKEN_LENGTH} znaki.`);
    }
    return { token: fromEnv, source: 'env' };
  }
  try {
    const saved = fs.readFileSync(tokenFile, 'utf8').trim();
    if (saved.length >= MIN_TOKEN_LENGTH) {
      try {
        fs.chmodSync(tokenFile, 0o600);
      } catch {
        // system plików bez chmod
      }
      return { token: saved, source: 'file' };
    }
  } catch {
    // brak pliku — wygeneruj
  }
  const token = generateToken();
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(tokenFile, 0o600);
  return { token, source: 'generated' };
}

/** Porównanie w stałym czasie (hash SHA-256 wyrównuje długości). */
export function tokenMatches(candidate: unknown, expected: string): boolean {
  const c = typeof candidate === 'string' ? candidate.trim() : '';
  if (!c || !expected || expected.length < MIN_TOKEN_LENGTH) return false;
  const a = createHash('sha256').update(c).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b) && c.length === expected.length;
}

/** Wyciąga token z nagłówka Authorization: Bearer … albo X-MCP-Token. */
export function extractToken(headers: Record<string, string | string[] | undefined>): string {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || '';
  const auth = first(headers.authorization).trim();
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) return m[1].trim();
  return first(headers['x-mcp-token']).trim();
}
