// Administracja GitHubem dla SVL Python OS — wyłącznie repozytorium Rush47/SVL_Core.
//
// Uwierzytelnianie: klasyczny token GitHub (ghp_…) w zmiennej GITHUB_TOKEN (plik .env).
// Token nigdy nie trafia do przeglądarki, argumentów procesów ani logów.
//
// Zawiera:
// - REST API GitHuba (dowolna metoda), ograniczone do ścieżek /repos/Rush47/SVL_Core…
//   (+ odczyt /user i /rate_limit),
// - GitHub CLI: prawdziwe `gh` (z GH_TOKEN / GH_REPO), a bez niego wbudowana obsługa
//   `gh api …` i najczęstszych poleceń przez REST,
// - synchronizację obustronną katalogu projektu z gałęzią na GitHubie (git: pobierz /
//   wyślij / synchronizuj), bez nadpisywania siłą; konflikt = przerwanie i raport,
// - klasyfikację operacji nieodwracalnych, które AI może wykonać dopiero po potwierdzeniu
//   operatora.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import path from 'node:path';
import { containsLikelySecret } from '../utils/githubFiles.ts';

export const GITHUB_REPOSITORY = 'Rush47/SVL_Core';
const API_BASE = 'https://api.github.com';
const REPO_PATH_RE = new RegExp(`^/repos/${GITHUB_REPOSITORY.replace('/', '\\/')}(?:[/?#]|$)`, 'i');
const GLOBAL_READ_PATHS = /^\/(?:user|rate_limit)(?:[/?]|$)/i;

export type GitHubLogger = (level: 'INFO' | 'WARN' | 'ERROR', message: string, details?: Record<string, unknown>) => void;
let logger: GitHubLogger = () => undefined;
export function setGitHubLogger(fn: GitHubLogger): void {
  logger = fn;
}

export function getGitHubToken(): string {
  return String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
}

export function tokenKind(token: string): 'classic' | 'fine_grained' | 'other' | 'none' {
  if (!token) return 'none';
  if (/^ghp_[A-Za-z0-9]{20,}$/.test(token)) return 'classic';
  if (/^github_pat_/.test(token)) return 'fine_grained';
  return 'other';
}

export function syncBranch(): string {
  const raw = String(process.env.SVL_GITHUB_SYNC_BRANCH || 'main').trim();
  return /^[A-Za-z0-9._/-]{1,100}$/.test(raw) && !raw.includes('..') ? raw : 'main';
}

function remoteUrl(): string {
  return String(process.env.SVL_GITHUB_REMOTE_URL || `https://github.com/${GITHUB_REPOSITORY}.git`).trim();
}

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

export function normalizeApiPath(rawPath: string): string {
  let p = String(rawPath || '').trim();
  p = p.replace(/^https?:\/\/api\.github\.com/i, '');
  if (!p.startsWith('/')) p = `/${p}`;
  // Skróty jak w `gh api`: {owner}/{repo}
  p = p.replace(/\{owner\}\/\{repo\}/g, GITHUB_REPOSITORY);
  return p;
}

/** Czy ścieżka mieści się w dozwolonym zakresie (tylko Rush47/SVL_Core). */
export function isAllowedApiPath(method: string, apiPath: string): boolean {
  const p = normalizeApiPath(apiPath);
  if (p.includes('..')) return false;
  if (REPO_PATH_RE.test(p)) return true;
  return method.toUpperCase() === 'GET' && GLOBAL_READ_PATHS.test(p);
}

/**
 * Operacje nieodwracalne lub zmieniające dostęp/bezpieczeństwo — AI wykonuje je dopiero
 * po potwierdzeniu operatora. Zwraca opis ryzyka albo null.
 */
export function destructiveReason(method: string, apiPath: string, body?: unknown): string | null {
  const m = method.toUpperCase();
  const p = normalizeApiPath(apiPath).split('?')[0];
  const repoRoot = new RegExp(`^/repos/${GITHUB_REPOSITORY.replace('/', '\\/')}/?$`, 'i');
  if (m === 'GET' || m === 'HEAD') return null;
  if (m === 'DELETE') return repoRoot.test(p) ? 'USUNIĘCIE CAŁEGO REPOZYTORIUM' : 'usunięcie zasobu';
  if (repoRoot.test(p)) return 'zmiana ustawień repozytorium (nazwa, widoczność, archiwizacja)';
  if (/\/(collaborators|invitations|keys|hooks|transfer|rulesets|environments)(\/|$)/i.test(p)) {
    return 'zmiana dostępu lub integracji repozytorium';
  }
  if (/\/actions\/(secrets|variables|permissions)/i.test(p)) return 'zmiana sekretów/uprawnień GitHub Actions';
  if (/\/branches\/[^/]+\/protection/i.test(p)) return 'zmiana ochrony gałęzi';
  if (/\/pulls\/\d+\/merge$/i.test(p)) return 'scalenie pull requesta';
  if (/\/git\/refs\//i.test(p) && body && typeof body === 'object' && (body as any).force) {
    return 'wymuszone nadpisanie gałęzi (force)';
  }
  return null;
}

export interface GitHubApiResult {
  ok: boolean;
  status: number;
  data: unknown;
  scopes?: string;
  rateRemaining?: string;
  error?: string;
}

export async function githubApi(
  method: string,
  apiPath: string,
  body?: unknown,
  fetcher: typeof fetch = fetch,
): Promise<GitHubApiResult> {
  const token = getGitHubToken();
  const m = String(method || 'GET').toUpperCase();
  const p = normalizeApiPath(apiPath);
  if (!token) return { ok: false, status: 0, data: null, error: 'Brak GITHUB_TOKEN w pliku .env serwera.' };
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) {
    return { ok: false, status: 0, data: null, error: `Nieobsługiwana metoda ${m}.` };
  }
  if (!isAllowedApiPath(m, p)) {
    return { ok: false, status: 0, data: null, error: `Dozwolone jest wyłącznie repozytorium ${GITHUB_REPOSITORY} (ścieżka ${p}).` };
  }
  const payload = typeof body === 'string' && body.trim() ? safeJson(body) : body;
  try {
    const res = await fetcher(`${API_BASE}${p}`, {
      method: m,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'SVL-Core-GitHub-Admin',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${token}`,
        ...(payload !== undefined && payload !== null && m !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(payload !== undefined && payload !== null && m !== 'GET' ? { body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    const data = text ? safeJson(text) ?? text : null;
    const result: GitHubApiResult = {
      ok: res.ok,
      status: res.status,
      data,
      scopes: res.headers.get('x-oauth-scopes') ?? undefined,
      rateRemaining: res.headers.get('x-ratelimit-remaining') ?? undefined,
      ...(res.ok ? {} : { error: `GitHub API ${res.status}: ${String((data as any)?.message || text || '').slice(0, 200)}` }),
    };
    logger(res.ok ? 'INFO' : 'WARN', `GitHub API ${m} ${p} -> ${res.status}`);
    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger('ERROR', `GitHub API ${m} ${p} — błąd połączenia: ${msg}`);
    return { ok: false, status: 0, data: null, error: `Brak połączenia z GitHub API: ${msg}` };
  }
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Weryfikacja tokenu: login, uprawnienia (classic: X-OAuth-Scopes), dostęp do repozytorium. */
export async function verifyGitHubToken(fetcher: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const token = getGitHubToken();
  const kind = tokenKind(token);
  if (!token) {
    return { configured: false, kind, repository: GITHUB_REPOSITORY, message: 'Wpisz klasyczny token (ghp_…) jako GITHUB_TOKEN w pliku .env i uruchom serwer ponownie.' };
  }
  const user = await githubApi('GET', '/user', undefined, fetcher);
  const repo = await githubApi('GET', `/repos/${GITHUB_REPOSITORY}`, undefined, fetcher);
  const perms = (repo.data as any)?.permissions || {};
  return {
    configured: true,
    kind,
    valid: user.ok,
    login: (user.data as any)?.login || null,
    scopes: (user.scopes || '').split(',').map((s) => s.trim()).filter(Boolean),
    rateRemaining: user.rateRemaining || null,
    repository: GITHUB_REPOSITORY,
    repositoryAccessible: repo.ok,
    permissions: { admin: Boolean(perms.admin), push: Boolean(perms.push), pull: Boolean(perms.pull) },
    defaultBranch: (repo.data as any)?.default_branch || null,
    error: user.ok ? (repo.ok ? null : repo.error) : user.error,
    ...(kind === 'fine_grained' ? { warning: 'To token fine-grained — zalecany jest klasyczny token (ghp_…).' } : {}),
  };
}

// ---------------------------------------------------------------------------
// git — synchronizacja obustronna katalogu projektu z GitHubem
// ---------------------------------------------------------------------------

interface RunResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 60000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as any).code === 'number' ? (error as any).code : 1) : 0;
      resolve({ ok: !error, code, stdout: String(stdout || ''), stderr: String(stderr || (error ? error.message : '')) });
    });
  });
}

/** Token przekazywany do gita przez zmienne środowiskowe (nie w argumentach ani w .git/config). */
function gitEnv(): NodeJS.ProcessEnv {
  const token = getGitHubToken();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: process.env.SVL_GIT_AUTHOR_NAME || 'SVL Python OS',
    GIT_AUTHOR_EMAIL: process.env.SVL_GIT_AUTHOR_EMAIL || 'svl-core@users.noreply.github.com',
    GIT_COMMITTER_NAME: process.env.SVL_GIT_AUTHOR_NAME || 'SVL Python OS',
    GIT_COMMITTER_EMAIL: process.env.SVL_GIT_AUTHOR_EMAIL || 'svl-core@users.noreply.github.com',
  };
  if (token && /^https:\/\/github\.com\//i.test(remoteUrl())) {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${basic}`;
  }
  return env;
}

function scrub(text: string): string {
  const token = getGitHubToken();
  let out = String(text || '');
  if (token) out = out.split(token).join('[REDACTED]');
  return out.replace(/AUTHORIZATION: basic [A-Za-z0-9+/=]+/gi, 'AUTHORIZATION: [REDACTED]').trim().slice(0, 4000);
}

const TRACKING_REF = (branch: string) => `refs/remotes/svl-github/${branch}`;

export interface GitSyncStatus {
  ok: boolean;
  isRepo: boolean;
  repository: string;
  branch: string;
  localBranch?: string;
  head?: string;
  remoteHead?: string | null;
  ahead?: number;
  behind?: number;
  dirtyFiles?: string[];
  error?: string;
}

async function git(projectDir: string, args: string[], timeoutMs?: number): Promise<RunResult> {
  return run('git', ['-c', `safe.directory=${projectDir}`, ...args], projectDir, gitEnv(), timeoutMs);
}

async function fetchRemote(projectDir: string, branch: string): Promise<RunResult> {
  return git(projectDir, ['fetch', '--no-tags', remoteUrl(), `+refs/heads/${branch}:${TRACKING_REF(branch)}`], 120000);
}

export async function gitSyncStatus(projectDir: string, doFetch = true): Promise<GitSyncStatus> {
  const branch = syncBranch();
  const base: GitSyncStatus = { ok: false, isRepo: false, repository: GITHUB_REPOSITORY, branch };
  if (!fsSync.existsSync(path.join(projectDir, '.git'))) {
    return { ...base, error: 'Katalog projektu nie jest repozytorium git — użyj akcji „init”.' };
  }
  if (doFetch) {
    const f = await fetchRemote(projectDir, branch);
    if (!f.ok) return { ...base, isRepo: true, error: `Pobranie z GitHuba nie powiodło się: ${scrub(f.stderr)}` };
  }
  const localBranch = (await git(projectDir, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  const head = (await git(projectDir, ['rev-parse', '--short', 'HEAD'])).stdout.trim();
  const remote = await git(projectDir, ['rev-parse', '--short', TRACKING_REF(branch)]);
  const counts = remote.ok
    ? (await git(projectDir, ['rev-list', '--left-right', '--count', `HEAD...${TRACKING_REF(branch)}`])).stdout.trim().split(/\s+/)
    : ['0', '0'];
  const dirty = (await git(projectDir, ['status', '--porcelain'])).stdout.split('\n').filter(Boolean).map((l) => l.slice(3));
  return {
    ok: true,
    isRepo: true,
    repository: GITHUB_REPOSITORY,
    branch,
    localBranch,
    head,
    remoteHead: remote.ok ? remote.stdout.trim() : null,
    ahead: Number(counts[0] || 0),
    behind: Number(counts[1] || 0),
    dirtyFiles: dirty.slice(0, 50),
  };
}

/** Commit lokalnych zmian (z blokadą sekretów). Zwraca null, gdy nie było zmian. */
async function commitLocalChanges(projectDir: string, message: string): Promise<{ ok: boolean; committed: boolean; error?: string }> {
  const dirty = (await git(projectDir, ['status', '--porcelain'])).stdout.trim();
  if (!dirty) return { ok: true, committed: false };
  await git(projectDir, ['add', '-A']);
  const staged = (await git(projectDir, ['diff', '--cached', '--name-only'])).stdout.split('\n').filter(Boolean);
  const forbidden = staged.filter((f) => /(^|\/)\.env($|\.)|\.secret$|\.pem$|id_rsa|id_ed25519/i.test(f) && !/\.env\.example$/.test(f));
  const diff = (await git(projectDir, ['diff', '--cached'])).stdout;
  if (forbidden.length > 0 || containsLikelySecret(diff)) {
    await git(projectDir, ['reset', '-q']);
    const reason = forbidden.length > 0 ? `pliki z sekretami: ${forbidden.join(', ')}` : 'treść wygląda na sekret (token/klucz)';
    logger('ERROR', `Synchronizacja GitHub zablokowana — ${reason}`);
    return { ok: false, committed: false, error: `Zatrzymano: zmiany zawierają ${reason}. Nic nie wysłano.` };
  }
  const c = await git(projectDir, ['commit', '-q', '-m', message.slice(0, 200)]);
  if (!c.ok) return { ok: false, committed: false, error: `Commit nie powiódł się: ${scrub(c.stderr)}` };
  return { ok: true, committed: true };
}

async function mergeRemote(projectDir: string, branch: string): Promise<{ ok: boolean; merged: boolean; error?: string }> {
  const ref = TRACKING_REF(branch);
  const ff = await git(projectDir, ['merge', '--ff-only', ref]);
  if (ff.ok) return { ok: true, merged: !/Already up to date/i.test(ff.stdout) };
  const m = await git(projectDir, ['merge', '--no-edit', ref]);
  if (m.ok) return { ok: true, merged: true };
  const conflicts = (await git(projectDir, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
  await git(projectDir, ['merge', '--abort']);
  return {
    ok: false,
    merged: false,
    error: conflicts.length
      ? `Konflikt scalania w plikach: ${conflicts.join(', ')} — przerwano, nic nie nadpisano.`
      : `Scalanie nie powiodło się: ${scrub(m.stderr)}`,
  };
}

async function pushBranch(projectDir: string, branch: string): Promise<RunResult> {
  return git(projectDir, ['push', remoteUrl(), `HEAD:refs/heads/${branch}`], 120000);
}

export type GitSyncAction = 'status' | 'pull' | 'push' | 'sync' | 'init';

export async function gitSync(
  projectDir: string,
  action: GitSyncAction,
  message = 'SVL: synchronizacja z panelu',
): Promise<{ ok: boolean; action: GitSyncAction; summary: string; status?: GitSyncStatus }> {
  const branch = syncBranch();
  const done = async (ok: boolean, summary: string) => {
    logger(ok ? 'INFO' : 'WARN', `GitHub ${action}: ${summary}`);
    return { ok, action, summary, status: await gitSyncStatus(projectDir, false) };
  };
  if (!getGitHubToken() && /^https:\/\/github\.com\//i.test(remoteUrl()) && action !== 'status') {
    return { ok: false, action, summary: 'Brak GITHUB_TOKEN w pliku .env serwera.' };
  }

  if (action === 'init') {
    const hasGitDir = fsSync.existsSync(path.join(projectDir, '.git'));
    if (hasGitDir) {
      const headOk = await git(projectDir, ['rev-parse', '--verify', 'HEAD']);
      if (headOk.ok) return done(true, 'Repozytorium git już istnieje.');
    } else {
      const init = await git(projectDir, ['init', '-q', '-b', branch]);
      if (!init.ok) return done(false, `git init: ${scrub(init.stderr)}`);
    }
    const f = await fetchRemote(projectDir, branch);
    if (!f.ok) return done(false, `Pobranie z GitHuba: ${scrub(f.stderr)}`);
    // Ustawia historię z GitHuba, NIE zmieniając plików na dysku (różnice widać jako lokalne zmiany).
    const reset = await git(projectDir, ['reset', '-q', '--mixed', TRACKING_REF(branch)]);
    return done(reset.ok, reset.ok ? `Połączono katalog z ${GITHUB_REPOSITORY}@${branch} (pliki bez zmian).` : scrub(reset.stderr));
  }

  if (action === 'status') {
    const status = await gitSyncStatus(projectDir, true);
    return { ok: status.ok, action, summary: status.error || describeStatus(status), status };
  }

  const fetched = await gitSyncStatus(projectDir, true);
  if (!fetched.ok) return { ok: false, action, summary: fetched.error || 'Błąd statusu git.', status: fetched };

  if (action === 'pull') {
    if ((fetched.dirtyFiles || []).length > 0) {
      return done(false, `Masz niezapisane zmiany (${fetched.dirtyFiles!.length} plików) — użyj „synchronizuj” (zapisze je i scali) albo „wyślij”.`);
    }
    const merged = await mergeRemote(projectDir, branch);
    return done(merged.ok, merged.ok ? (merged.merged ? `Pobrano zmiany z GitHuba (${fetched.behind} commitów).` : 'Brak nowych zmian na GitHubie.') : merged.error!);
  }

  const committed = await commitLocalChanges(projectDir, message);
  if (!committed.ok) return done(false, committed.error!);

  if (action === 'push') {
    const pushed = await pushBranch(projectDir, branch);
    if (!pushed.ok) {
      const rejected = /rejected|non-fast-forward|fetch first/i.test(pushed.stderr);
      return done(false, rejected ? 'GitHub ma nowsze zmiany — użyj „synchronizuj” (pobierze, scali i wyśle).' : `Wysłanie nie powiodło się: ${scrub(pushed.stderr)}`);
    }
    return done(true, `Wysłano na GitHub (${GITHUB_REPOSITORY}@${branch})${committed.committed ? ' razem z nowym commitem lokalnych zmian' : ''}.`);
  }

  // sync: lokalne → commit, zdalne → scal, potem wyślij
  const merged = await mergeRemote(projectDir, branch);
  if (!merged.ok) return done(false, merged.error!);
  const after = await gitSyncStatus(projectDir, false);
  if ((after.ahead || 0) > 0) {
    const pushed = await pushBranch(projectDir, branch);
    if (!pushed.ok) return done(false, `Wysłanie nie powiodło się: ${scrub(pushed.stderr)}`);
  }
  return done(true, `Synchronizacja obustronna zakończona: pobrano ${fetched.behind || 0}, wysłano ${after.ahead || 0} commitów${committed.committed ? ' (w tym zapis lokalnych zmian)' : ''}.`);
}

export function describeStatus(s: GitSyncStatus): string {
  if (!s.isRepo) return s.error || 'Brak repozytorium git.';
  const dirty = (s.dirtyFiles || []).length;
  return `${GITHUB_REPOSITORY}@${s.branch}: lokalnie ${s.head} (${s.localBranch}), GitHub ${s.remoteHead || '—'} · do wysłania ${s.ahead ?? 0}, do pobrania ${s.behind ?? 0}, niezapisanych plików ${dirty}`;
}

// ---------------------------------------------------------------------------
// GitHub CLI
// ---------------------------------------------------------------------------

/** Podział argumentów jak w powłoce (cudzysłowy), bez uruchamiania powłoki. */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(input || '')))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] ?? m[3]);
  return out;
}

const FOREIGN_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** Polecenia gh działające w obrębie jednego repozytorium (GH_REPO = Rush47/SVL_Core). */
const GH_ALLOWED_TOP = new Set([
  'api', 'auth', 'repo', 'pr', 'issue', 'run', 'workflow', 'release', 'label', 'secret', 'variable', 'cache', 'ruleset', 'branch',
]);
const GH_REPO_SUBCOMMANDS = new Set(['view', 'edit', 'rename', 'archive', 'unarchive', 'delete', 'deploy-key', 'autolink']);

/** Ocena polecenia `gh`: dozwolone tylko dla Rush47/SVL_Core; nieodwracalne wymagają potwierdzenia. */
export function assessGhCommand(args: string[]): { allowed: boolean; reason?: string; destructive?: string | null } {
  const lower = args.map((a) => a.toLowerCase());
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    const repoArg = (lower[i] === '-r' || lower[i] === '--repo') ? args[i + 1] : a.startsWith('--repo=') ? a.slice(7) : null;
    if (repoArg && repoArg.toLowerCase() !== GITHUB_REPOSITORY.toLowerCase()) {
      return { allowed: false, reason: `Dozwolone jest wyłącznie repozytorium ${GITHUB_REPOSITORY}.` };
    }
    if (i >= 2 && FOREIGN_REPO_RE.test(a) && !a.includes('.') && lower[0] === 'repo' && a.toLowerCase() !== GITHUB_REPOSITORY.toLowerCase()) {
      return { allowed: false, reason: `Dozwolone jest wyłącznie repozytorium ${GITHUB_REPOSITORY}.` };
    }
  }
  const top = lower[0] || '';
  if (!GH_ALLOWED_TOP.has(top)) {
    return { allowed: false, reason: `Polecenie „gh ${top}” nie dotyczy repozytorium ${GITHUB_REPOSITORY} — niedozwolone.` };
  }
  if (top === 'auth' && lower[1] !== 'status') return { allowed: false, reason: 'Logowanie odbywa się tokenem z .env (GITHUB_TOKEN).' };
  if (top === 'repo' && lower[1] && !GH_REPO_SUBCOMMANDS.has(lower[1])) {
    return { allowed: false, reason: `„gh repo ${lower[1]}” wychodzi poza repozytorium ${GITHUB_REPOSITORY} — niedozwolone.` };
  }
  if (lower[0] === 'api') {
    const methodIdx = lower.findIndex((a) => a === '-x' || a === '--method');
    const method = methodIdx >= 0 ? (args[methodIdx + 1] || 'GET').toUpperCase() : args.some((a) => a === '-f' || a === '-F' || a === '--field' || a === '--raw-field') ? 'POST' : 'GET';
    const apiPath = args.slice(1).find((a, idx) => !a.startsWith('-') && !(idx > 0 && /^(-x|--method|-f|-F|--field|--raw-field|-H|--header|--input|--jq|-q)$/i.test(args[idx]))) || '';
    if (!isAllowedApiPath(method, apiPath)) return { allowed: false, reason: `gh api: dozwolone wyłącznie /repos/${GITHUB_REPOSITORY}/…` };
    return { allowed: true, destructive: destructiveReason(method, apiPath) };
  }
  const sub = `${lower[0] || ''} ${lower[1] || ''}`.trim();
  const destructiveSubs: Record<string, string> = {
    'repo delete': 'USUNIĘCIE CAŁEGO REPOZYTORIUM',
    'repo archive': 'archiwizacja repozytorium',
    'repo rename': 'zmiana nazwy repozytorium',
    'repo edit': 'zmiana ustawień repozytorium',
    'pr merge': 'scalenie pull requesta',
    'release delete': 'usunięcie wydania',
    'secret set': 'zmiana sekretów Actions',
    'secret delete': 'usunięcie sekretu Actions',
    'variable set': 'zmiana zmiennych Actions',
    'variable delete': 'usunięcie zmiennej Actions',
    'ruleset delete': 'usunięcie reguł repozytorium',
    'run delete': 'usunięcie przebiegu workflow',
    'cache delete': 'usunięcie cache Actions',
    'label delete': 'usunięcie etykiety',
    'issue delete': 'usunięcie zgłoszenia',
  };
  return { allowed: true, destructive: destructiveSubs[sub] || null };
}

function findGhBinary(): string | null {
  const candidates = [process.env.SVL_GH_BINARY, '/usr/local/bin/gh', '/usr/bin/gh', path.join(process.cwd(), 'data', 'tools', 'gh')];
  for (const dir of String(process.env.PATH || '').split(':')) if (dir) candidates.push(path.join(dir, 'gh'));
  for (const c of candidates) {
    if (c && fsSync.existsSync(c)) return c;
  }
  return null;
}

export function ghCliAvailable(): boolean {
  return findGhBinary() !== null;
}

/** Wbudowane polecenia `gh` przez REST — gdy binarka `gh` nie jest zainstalowana (np. AI Studio). */
async function emulateGh(args: string[]): Promise<{ ok: boolean; output: string }> {
  const [a0, a1] = [args[0] || '', args[1] || ''];
  const fmt = (r: GitHubApiResult, pick?: (d: any) => string) =>
    r.ok ? { ok: true, output: pick ? pick(r.data) : JSON.stringify(r.data, null, 2).slice(0, 12000) } : { ok: false, output: r.error || `HTTP ${r.status}` };
  const R = `/repos/${GITHUB_REPOSITORY}`;
  if (a0 === 'api') {
    const lower = args.map((x) => x.toLowerCase());
    const mIdx = lower.findIndex((x) => x === '-x' || x === '--method');
    const fields: Record<string, string> = {};
    let apiPath = '';
    for (let i = 1; i < args.length; i += 1) {
      const x = args[i];
      if (/^(-x|--method)$/i.test(x)) { i += 1; continue; }
      if (/^(-f|-F|--field|--raw-field)$/.test(x)) { const [k, ...v] = String(args[i + 1] || '').split('='); fields[k] = v.join('='); i += 1; continue; }
      if (!x.startsWith('-') && !apiPath) apiPath = x;
    }
    const method = mIdx >= 0 ? String(args[mIdx + 1] || 'GET').toUpperCase() : Object.keys(fields).length ? 'POST' : 'GET';
    return fmt(await githubApi(method, apiPath, Object.keys(fields).length ? fields : undefined));
  }
  if (a0 === 'auth' && a1 === 'status') {
    const v = await verifyGitHubToken();
    return { ok: Boolean(v.valid), output: JSON.stringify(v, null, 2) };
  }
  if (a0 === 'repo' && (a1 === 'view' || !a1)) return fmt(await githubApi('GET', R), (d) => `${d.full_name} · ${d.private ? 'prywatne' : 'publiczne'} · domyślna gałąź ${d.default_branch}\n${d.description || ''}\n${d.html_url}`);
  const list = (kind: string, p: string, line: (x: any) => string) =>
    async () => fmt(await githubApi('GET', p), (d) => (Array.isArray(d) ? d : d?.workflow_runs || []).map(line).join('\n') || `(brak: ${kind})`);
  const handlers: Record<string, () => Promise<{ ok: boolean; output: string }>> = {
    'pr list': list('pull requesty', `${R}/pulls?state=open&per_page=30`, (x) => `#${x.number}\t${x.title}\t${x.head?.ref} → ${x.base?.ref}`),
    'issue list': list('zgłoszenia', `${R}/issues?state=open&per_page=30`, (x) => `#${x.number}\t${x.pull_request ? '[PR] ' : ''}${x.title}`),
    'run list': list('przebiegi', `${R}/actions/runs?per_page=20`, (x) => `${x.id}\t${x.status}/${x.conclusion || '-'}\t${x.name}\t${x.head_branch}`),
    'release list': list('wydania', `${R}/releases?per_page=20`, (x) => `${x.tag_name}\t${x.name || ''}\t${x.published_at || ''}`),
    'branch list': list('gałęzie', `${R}/branches?per_page=100`, (x) => `${x.name}\t${x.commit?.sha?.slice(0, 7)}`),
    'workflow list': list('workflowy', `${R}/actions/workflows`, (x) => `${x.id}\t${x.state}\t${x.name}`),
  };
  const h = handlers[`${a0} ${a1}`];
  if (h) return h();
  return {
    ok: false,
    output:
      'Binarka `gh` nie jest zainstalowana na tym serwerze. Dostępne wbudowane polecenia: ' +
      '`gh api [-X METODA] <ścieżka> [-f klucz=wartość]`, `gh auth status`, `gh repo view`, `gh pr list`, ' +
      '`gh issue list`, `gh run list`, `gh release list`, `gh branch list`, `gh workflow list`.',
  };
}

export async function runGhCommand(projectDir: string, rawArgs: string | string[]): Promise<{ ok: boolean; output: string; engine: 'gh' | 'rest' }> {
  const args = Array.isArray(rawArgs) ? rawArgs : splitArgs(String(rawArgs).replace(/^\s*gh\s+/, ''));
  if (args.length === 0) return { ok: false, output: 'Podaj polecenie, np. `gh pr list`.', engine: 'rest' };
  if (!getGitHubToken()) return { ok: false, output: 'Brak GITHUB_TOKEN w pliku .env serwera.', engine: 'rest' };
  const bin = findGhBinary();
  if (!bin) {
    const r = await emulateGh(args);
    logger(r.ok ? 'INFO' : 'WARN', `gh (REST) ${args.slice(0, 4).join(' ')} -> ${r.ok ? 'OK' : 'błąd'}`);
    return { ...r, output: scrub(r.output), engine: 'rest' };
  }
  const r = await run(
    bin,
    args,
    projectDir,
    {
      ...process.env,
      GH_TOKEN: getGitHubToken(),
      GH_REPO: GITHUB_REPOSITORY,
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      NO_COLOR: '1',
      CLICOLOR: '0',
    },
    90000,
  );
  logger(r.ok ? 'INFO' : 'WARN', `gh ${args.slice(0, 4).join(' ')} -> kod ${r.code}`);
  return { ok: r.ok, output: scrub([r.stdout, r.stderr].filter(Boolean).join('\n')) || '(brak wyjścia)', engine: 'gh' };
}

// ---------------------------------------------------------------------------
// Potwierdzenia operacji nieodwracalnych (zlecanych przez AI)
// ---------------------------------------------------------------------------

export type PendingGitHubOp =
  | { kind: 'api'; method: string; path: string; body?: unknown }
  | { kind: 'gh'; args: string[] };

const pending = new Map<string, { op: PendingGitHubOp; reason: string; createdAt: number }>();
const PENDING_TTL_MS = 15 * 60 * 1000;

export function queueConfirmation(op: PendingGitHubOp, reason: string): string {
  const now = Date.now();
  for (const [id, entry] of pending) if (now - entry.createdAt > PENDING_TTL_MS) pending.delete(id);
  const id = randomUUID().slice(0, 8);
  pending.set(id, { op, reason, createdAt: now });
  logger('WARN', `Operacja GitHub czeka na potwierdzenie operatora [${id}]: ${reason}`, { op: describeOp(op) });
  return id;
}

export function describeOp(op: PendingGitHubOp): string {
  return op.kind === 'api' ? `${op.method.toUpperCase()} ${normalizeApiPath(op.path)}` : `gh ${op.args.join(' ')}`;
}

export function takeConfirmation(id: string): { op: PendingGitHubOp; reason: string } | null {
  const entry = pending.get(String(id || '').trim());
  if (!entry || Date.now() - entry.createdAt > PENDING_TTL_MS) return null;
  pending.delete(String(id).trim());
  return { op: entry.op, reason: entry.reason };
}

export function cancelConfirmation(id: string): boolean {
  return pending.delete(String(id || '').trim());
}

export async function executeOp(projectDir: string, op: PendingGitHubOp): Promise<{ ok: boolean; output: string }> {
  if (op.kind === 'api') {
    const r = await githubApi(op.method, op.path, op.body);
    return { ok: r.ok, output: r.ok ? JSON.stringify(r.data, null, 2)?.slice(0, 6000) || `HTTP ${r.status}` : r.error || `HTTP ${r.status}` };
  }
  const r = await runGhCommand(projectDir, op.args);
  return { ok: r.ok, output: r.output };
}
