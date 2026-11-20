// Autoryzacja operatora SVL.
//
// Domyślnie SVL_OPERATOR_TOKEN NIE jest wymagany: panel, API, WebSocket /ws/svl i MCP działają
// bez wpisywania tokenu. Żeby znów go wymagać (np. gdy brama jest wystawiona do internetu),
// ustaw SVL_REQUIRE_OPERATOR_TOKEN=1 w pliku .env.

import { timingSafeEqual } from 'node:crypto';

type Env = Record<string, string | undefined>;

export function isOperatorTokenRequired(env: Env = process.env): boolean {
  return ['1', 'true', 'yes', 'on', 'tak'].includes(String(env.SVL_REQUIRE_OPERATOR_TOKEN || '').trim().toLowerCase());
}

/** Prawdziwe porównanie z sekretem (stały czas), niezależnie od trybu. */
export function operatorTokenMatches(candidate: unknown, env: Env = process.env): boolean {
  if (typeof candidate !== 'string') return false;
  const value = candidate.trim();
  if (value.length < 32 || value.length > 512) return false;
  const secret = String(env.SVL_OPERATOR_TOKEN || '').trim();
  if (secret.length < 32) return false;
  const actual = Buffer.from(value, 'utf8');
  const expected = Buffer.from(secret, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Czy żądanie ma prawa operatora: bez wymogu tokenu — zawsze; z wymogiem — tylko z poprawnym tokenem. */
export function hasOperatorAuthorization(candidate: unknown, env: Env = process.env): boolean {
  if (!isOperatorTokenRequired(env)) return true;
  return operatorTokenMatches(candidate, env);
}
