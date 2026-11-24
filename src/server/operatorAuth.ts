// Uwierzytelnianie i autoryzacja operatora w systemie SVL CoreOS 2.
import { timingSafeEqual } from 'node:crypto';

export function isOperatorTokenRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = String(env.SVL_REQUIRE_OPERATOR_TOKEN || '').trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on';
}

function tokensMatchConstantTime(candidate: string, required: string): boolean {
  if (!candidate || !required || candidate.length < 32 || required.length < 32) {
    return false;
  }
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(required, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function hasOperatorAuthorization(
  token?: string | string[] | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = Array.isArray(token) ? token[0] : token;
  const candidate = String(raw || '').trim();
  const required = String(env.SVL_OPERATOR_TOKEN || '').trim();
  const tokenRequired = isOperatorTokenRequired(env);

  if (!tokenRequired) {
    // Domyślnie (SVL_REQUIRE_OPERATOR_TOKEN != 1) podgląd i panel działają bez podawania sekretu,
    // ale podanie nieprawidłowego tokenu ręcznie jest odrzucane.
    if (!candidate) return true;
    if (!required || required.length < 32) return true;
    return tokensMatchConstantTime(candidate, required);
  }

  return tokensMatchConstantTime(candidate, required);
}

export function extractBearerToken(req: any): string {
  const auth = req?.headers?.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  return '';
}

export function hasMcpOrOperatorAuth(req: any, env: NodeJS.ProcessEnv = process.env): boolean {
  const bearer = extractBearerToken(req);
  const xToken = req?.headers?.['x-svl-operator-token'] || req?.headers?.['x-operator-token'];
  const bodyToken = req?.body?.operatorToken || req?.body?.token;
  const candidate = bearer || xToken || bodyToken;
  return hasOperatorAuthorization(candidate, env);
}
