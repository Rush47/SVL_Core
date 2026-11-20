// Ochrona przed wyjściem poza MCP_ROOT (../, ścieżki bezwzględne, dowiązania symboliczne).

import fs from 'node:fs/promises';
import path from 'node:path';

export class PathOutsideRootError extends Error {
  constructor(p: string) {
    super(`Ścieżka poza katalogiem głównym MCP_ROOT: ${p}`);
    this.name = 'PathOutsideRootError';
  }
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Najgłębszy istniejący przodek ścieżki po rozwiązaniu dowiązań symbolicznych. */
async function realpathOfExistingAncestor(p: string): Promise<string> {
  let current = p;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch (error: any) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) return p;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Zamienia ścieżkę z narzędzia (względną do root albo bezwzględną) na bezpieczną ścieżkę wewnątrz root.
 * Rzuca PathOutsideRootError, jeśli cel (także po rozwiązaniu symlinków) leży poza root.
 */
export async function resolveInRoot(root: string, input: unknown): Promise<string> {
  const raw = String(input ?? '').trim() || '.';
  if (raw.includes('\0')) throw new PathOutsideRootError(raw);
  const realRoot = await fs.realpath(root);
  const candidate = path.resolve(realRoot, raw);
  if (!isInside(realRoot, candidate)) throw new PathOutsideRootError(raw);
  const real = await realpathOfExistingAncestor(candidate);
  if (!isInside(realRoot, real)) throw new PathOutsideRootError(raw);
  return candidate;
}

export function toRootRelative(root: string, abs: string): string {
  return path.relative(root, abs) || '.';
}
