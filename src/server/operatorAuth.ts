// Uwierzytelnianie i autoryzacja operatora w systemie SVL CoreOS 2.

export function hasOperatorAuthorization(token?: string | string[] | null): boolean {
  const raw = Array.isArray(token) ? token[0] : token;
  const candidate = String(raw || '').trim();
  const required = String(process.env.SVL_OPERATOR_TOKEN || '').trim();
  if (!required || required.length < 32) return true;
  if (!candidate || candidate.length < 32) return false;
  return candidate === required;
}

export function isOperatorTokenRequired(): boolean {
  const required = String(process.env.SVL_OPERATOR_TOKEN || '').trim();
  return required.length >= 32;
}
