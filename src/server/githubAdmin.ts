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
import { createHash, randomUUID } from 'node:crypto';
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
      signal: AbortSignal.timeout(25000),
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
// git & GitHub Git Data REST API — synchronizacja obustronna katalogu projektu z GitHubem
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

export interface GitSyncHistoryItem {
  id: string;
  action: string;
  commitSha: string;
  shortSha: string;
  previousHead?: string;
  pushedFiles: string[];
  pulledFiles: string[];
  message: string;
  timestamp: string;
}

export interface GitSyncStatus {
  ok: boolean;
  isRepo: boolean;
  syncEngine?: 'local_git' | 'github_rest_api';
  repository: string;
  branch: string;
  localBranch?: string;
  head?: string;
  headFull?: string;
  remoteHead?: string | null;
  remoteHeadFull?: string | null;
  ahead?: number;
  behind?: number;
  dirtyFiles?: string[];
  dirtyFilesCount?: number;
  remotePendingFiles?: string[];
  remotePendingCount?: number;
  lastPushedFiles?: string[];
  lastPulledFiles?: string[];
  lastCommitSha?: string | null;
  lastSyncAt?: string | null;
  syncHistory?: GitSyncHistoryItem[];
  error?: string;
}

/** Oblicza kanoniczny skrót SHA-1 obiektu blob Git (`blob <len>\0<content>`). */
export function computeGitBlobSha(buf: Buffer): string {
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  '__pycache__',
  '.playwright-cli',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.venv',
  'venv',
  'coverage',
  '.cache',
]);

const FORBIDDEN_FILE_RE =
  /(^|\/)\.env($|\.)|\.secret$|\.pem$|\.key$|id_rsa|id_ed25519|\.sqlite3|\.db($|-)|\.svl_operator_token|\.pyc$|\.log$|github_rest_sync_ledger\.json$/i;

function isForbiddenSyncPath(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!norm || norm.includes('..')) return true;
  if (norm === '.env.example' || norm.endsWith('/.env.example')) return false;
  const parts = norm.split('/');
  if (parts.some((p) => SKIP_DIRS.has(p))) return true;
  if (parts[0] === 'data' && norm !== 'data/svl_durable_backup.json') return true;
  return FORBIDDEN_FILE_RE.test(norm);
}

const BINARY_ASSET_EXT_RE = /\.(?:jpe?g|png|webp|gif|ico|woff2?|ttf|otf)$/i;
const MAX_TEXT_SYNC_BYTES = 512 * 1024;
const MAX_BINARY_ASSET_SYNC_BYTES = 3 * 1024 * 1024;

export function isAllowedBinaryAssetPath(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!norm || norm.includes('..')) return false;
  if (norm.startsWith('public/assets/aistudio/')) return false;
  if (!(norm.startsWith('src/assets/') || norm.startsWith('public/assets/'))) return false;
  return BINARY_ASSET_EXT_RE.test(norm);
}

interface LocalTrackedFile {
  path: string;
  sha: string;
  mode: '100644' | '100755';
  size: number;
  buf: Buffer;
  isBinary: boolean;
}

function collectTrackedWorkspaceFiles(projectDir: string): {
  files: Map<string, LocalTrackedFile>;
  forbiddenSecretFiles: string[];
} {
  const files = new Map<string, LocalTrackedFile>();
  const forbiddenSecretFiles: string[] = [];
  const realToken = getGitHubToken();

  const walk = (absDir: string, relPrefix: string) => {
    let entries: fsSync.Dirent[] = [];
    try {
      entries = fsSync.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (name === '.' || name === '..') continue;
      const relPath = relPrefix ? `${relPrefix}/${name}` : name;
      const absPath = path.join(absDir, name);

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        if (relPath === 'data') {
          // Z katalogu data śledzimy wyłącznie svl_durable_backup.json
          const durablePath = path.join(absPath, 'svl_durable_backup.json');
          if (fsSync.existsSync(durablePath)) {
            inspectFile(durablePath, 'data/svl_durable_backup.json');
          }
          continue;
        }
        walk(absPath, relPath);
      } else if (entry.isFile()) {
        inspectFile(absPath, relPath);
      }
    }
  };

  const inspectFile = (absPath: string, relPath: string) => {
    if (isForbiddenSyncPath(relPath)) return;
    let stat: fsSync.Stats;
    try {
      stat = fsSync.statSync(absPath);
    } catch {
      return;
    }
    const isBinaryAsset = isAllowedBinaryAssetPath(relPath);
    const maxBytes = isBinaryAsset ? MAX_BINARY_ASSET_SYNC_BYTES : MAX_TEXT_SYNC_BYTES;
    if (stat.size > maxBytes) return;
    let buf: Buffer;
    try {
      buf = fsSync.readFileSync(absPath);
    } catch {
      return;
    }
    const hasNullByte = buf.includes(0);
    // Pomijamy pliki binarne z bajtem zerowym, chyba że są dozwolonymi zasobami statycznymi (np. avatary JPG/PNG)
    if (hasNullByte && !isBinaryAsset) return;
    if (hasNullByte || isBinaryAsset) {
      files.set(relPath, {
        path: relPath,
        sha: computeGitBlobSha(buf),
        mode: '100644',
        size: buf.length,
        buf,
        isBinary: true,
      });
      return;
    }
    const text = buf.toString('utf8');
    const isUnitTestFile = /(\.test\.tsx?|(?:^|\/)test_[^/]+\.py)$/i.test(relPath);
    if ((realToken && text.includes(realToken)) || (!isUnitTestFile && containsLikelySecret(text))) {
      forbiddenSecretFiles.push(relPath);
      return;
    }
    const isExec =
      relPath.endsWith('.sh') ||
      (relPath.endsWith('.py') && text.startsWith('#!'));
    const mode: '100644' | '100755' = isExec ? '100755' : '100644';
    files.set(relPath, {
      path: relPath,
      sha: computeGitBlobSha(buf),
      mode,
      size: buf.length,
      buf,
      isBinary: false,
    });
  };

  walk(projectDir, '');
  return { files, forbiddenSecretFiles };
}

interface RestSyncLedger {
  branch: string;
  lastSyncedHeadSha: string;
  lastSyncedTreeShas: Record<string, string>;
  lastPushedFiles: string[];
  lastPulledFiles: string[];
  lastCommitSha: string;
  lastSyncAt: string;
  history: GitSyncHistoryItem[];
}

function getLedgerPath(projectDir: string): string {
  return path.join(projectDir, 'data', 'github_rest_sync_ledger.json');
}

function readRestSyncLedger(projectDir: string, branch: string): RestSyncLedger {
  const p = getLedgerPath(projectDir);
  try {
    if (fsSync.existsSync(p)) {
      const parsed = JSON.parse(fsSync.readFileSync(p, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        return {
          branch: String(parsed.branch || branch),
          lastSyncedHeadSha: String(parsed.lastSyncedHeadSha || ''),
          lastSyncedTreeShas: parsed.lastSyncedTreeShas && typeof parsed.lastSyncedTreeShas === 'object' ? parsed.lastSyncedTreeShas : {},
          lastPushedFiles: Array.isArray(parsed.lastPushedFiles) ? parsed.lastPushedFiles : [],
          lastPulledFiles: Array.isArray(parsed.lastPulledFiles) ? parsed.lastPulledFiles : [],
          lastCommitSha: String(parsed.lastCommitSha || parsed.lastSyncedHeadSha || ''),
          lastSyncAt: String(parsed.lastSyncAt || ''),
          history: Array.isArray(parsed.history) ? parsed.history.slice(-15) : [],
        };
      }
    }
  } catch {
    // ignore corrupt ledger
  }
  return {
    branch,
    lastSyncedHeadSha: '',
    lastSyncedTreeShas: {},
    lastPushedFiles: [],
    lastPulledFiles: [],
    lastCommitSha: '',
    lastSyncAt: '',
    history: [],
  };
}

function writeRestSyncLedger(projectDir: string, ledger: RestSyncLedger): void {
  const p = getLedgerPath(projectDir);
  try {
    fsSync.mkdirSync(path.dirname(p), { recursive: true });
    fsSync.writeFileSync(p, JSON.stringify(ledger, null, 2), 'utf8');
  } catch {
    // ignore write failure in read-only temp dirs
  }
}

interface RemoteTreeSnapshot {
  fetchedAt: number;
  branch: string;
  headSha: string;
  treeSha: string;
  blobs: Map<string, { path: string; sha: string; mode: string; size: number }>;
}

let cachedRemoteTree: RemoteTreeSnapshot | null = null;

async function fetchRemoteGitTree(
  branch: string,
  forceRefresh = false,
  fetcher: typeof fetch = fetch,
): Promise<{ ok: boolean; snapshot?: RemoteTreeSnapshot; error?: string }> {
  if (
    !forceRefresh &&
    cachedRemoteTree &&
    cachedRemoteTree.branch === branch &&
    Date.now() - cachedRemoteTree.fetchedAt < 6000
  ) {
    return { ok: true, snapshot: cachedRemoteTree };
  }
  const commitRes = await githubApi(
    'GET',
    `/repos/${GITHUB_REPOSITORY}/commits/${encodeURIComponent(branch)}`,
    undefined,
    fetcher,
  );
  if (!commitRes.ok || !commitRes.data || typeof commitRes.data !== 'object') {
    return { ok: false, error: commitRes.error || `Nie udało się pobrać HEAD gałęzi ${branch} z GitHub API.` };
  }
  const headSha = String((commitRes.data as any).sha || '').trim();
  const treeSha = String((commitRes.data as any).commit?.tree?.sha || '').trim();
  if (!headSha || !treeSha) {
    return { ok: false, error: `Niepełna odpowiedź GitHub API dla gałęzi ${branch} (brak sha/tree).` };
  }
  const treeRes = await githubApi(
    'GET',
    `/repos/${GITHUB_REPOSITORY}/git/trees/${treeSha}?recursive=1`,
    undefined,
    fetcher,
  );
  if (!treeRes.ok || !treeRes.data || typeof treeRes.data !== 'object') {
    return { ok: false, error: treeRes.error || `Nie udało się pobrać drzewa Git (${treeSha.slice(0, 7)}).` };
  }
  const blobs = new Map<string, { path: string; sha: string; mode: string; size: number }>();
  const rawTree = Array.isArray((treeRes.data as any).tree) ? (treeRes.data as any).tree : [];
  for (const item of rawTree) {
    if (item && item.type === 'blob' && typeof item.path === 'string' && typeof item.sha === 'string') {
      blobs.set(item.path, {
        path: item.path,
        sha: item.sha,
        mode: String(item.mode || '100644'),
        size: Number(item.size || 0),
      });
    }
  }
  const snapshot: RemoteTreeSnapshot = {
    fetchedAt: Date.now(),
    branch,
    headSha,
    treeSha,
    blobs,
  };
  cachedRemoteTree = snapshot;
  return { ok: true, snapshot };
}

function canUseRestGitEngine(projectDir: string): boolean {
  const hasGitDir = fsSync.existsSync(path.join(projectDir, '.git'));
  if (hasGitDir) return false;
  return Boolean(getGitHubToken()) && /^https:\/\/github\.com\//i.test(remoteUrl());
}

export async function restGitSyncStatus(
  projectDir: string,
  doFetch = true,
  fetcher: typeof fetch = fetch,
): Promise<GitSyncStatus> {
  const branch = syncBranch();
  const ledger = readRestSyncLedger(projectDir, branch);
  const remoteRes = await fetchRemoteGitTree(branch, doFetch, fetcher);
  if (!remoteRes.ok || !remoteRes.snapshot) {
    return {
      ok: false,
      isRepo: false,
      syncEngine: 'github_rest_api',
      repository: GITHUB_REPOSITORY,
      branch,
      error: remoteRes.error || 'Brak połączenia z GitHub Git Data API.',
    };
  }
  const snap = remoteRes.snapshot;
  const { files: localFiles } = collectTrackedWorkspaceFiles(projectDir);

  const dirtyFiles: string[] = [];
  for (const [relPath, local] of localFiles.entries()) {
    const rem = snap.blobs.get(relPath);
    if (!rem || rem.sha !== local.sha) {
      dirtyFiles.push(relPath);
    }
  }
  dirtyFiles.sort();

  const remotePendingFiles: string[] = [];
  const hasBaseline = Object.keys(ledger.lastSyncedTreeShas).length > 0;
  for (const [remPath, remBlob] of snap.blobs.entries()) {
    if (isForbiddenSyncPath(remPath)) continue;
    const remMaxBytes = isAllowedBinaryAssetPath(remPath) ? MAX_BINARY_ASSET_SYNC_BYTES : MAX_TEXT_SYNC_BYTES;
    if (remBlob.size > remMaxBytes) continue;
    const local = localFiles.get(remPath);
    const baseSha = ledger.lastSyncedTreeShas[remPath];
    if (!local) {
      // Plik istnieje na GitHubie, ale nie ma go lokalnie
      if (!hasBaseline || baseSha !== remBlob.sha) {
        remotePendingFiles.push(remPath);
      }
    } else if (hasBaseline && baseSha && remBlob.sha !== baseSha && local.sha === baseSha) {
      // Plik zmienił się na GitHubie od czasu ostatniej synchronizacji, a lokalnie pozostał bez zmian
      remotePendingFiles.push(remPath);
    }
  }
  remotePendingFiles.sort();

  const effectiveHeadFull = ledger.lastCommitSha || snap.headSha;
  return {
    ok: true,
    isRepo: true,
    syncEngine: 'github_rest_api',
    repository: GITHUB_REPOSITORY,
    branch,
    localBranch: branch,
    head: effectiveHeadFull.slice(0, 7),
    headFull: effectiveHeadFull,
    remoteHead: snap.headSha.slice(0, 7),
    remoteHeadFull: snap.headSha,
    ahead: dirtyFiles.length,
    behind: remotePendingFiles.length,
    dirtyFiles,
    dirtyFilesCount: dirtyFiles.length,
    remotePendingFiles,
    remotePendingCount: remotePendingFiles.length,
    lastPushedFiles: ledger.lastPushedFiles,
    lastPulledFiles: ledger.lastPulledFiles,
    lastCommitSha: effectiveHeadFull,
    lastSyncAt: ledger.lastSyncAt || null,
    syncHistory: ledger.history,
  };
}

export async function restGitSync(
  projectDir: string,
  action: GitSyncAction,
  message = 'SVL: synchronizacja obustronna z czatu i panelu',
  fetcher: typeof fetch = fetch,
): Promise<{
  ok: boolean;
  action: GitSyncAction;
  summary: string;
  status?: GitSyncStatus;
  pushedFiles?: string[];
  pulledFiles?: string[];
  commitSha?: string;
  previousHead?: string;
}> {
  const branch = syncBranch();
  if (!getGitHubToken()) {
    return { ok: false, action, summary: 'Brak GITHUB_TOKEN w pliku .env serwera.' };
  }

  const st = await restGitSyncStatus(projectDir, true, fetcher);
  if (!st.ok || ! cachedRemoteTree) {
    return { ok: false, action, summary: st.error || 'Błąd odczytu drzewa Git z GitHub API.', status: st };
  }

  if (action === 'status') {
    return { ok: true, action, summary: describeStatus(st), status: st };
  }

  const snap = cachedRemoteTree;
  const ledger = readRestSyncLedger(projectDir, branch);
  const previousHead = snap.headSha;

  if (action === 'init') {
    const treeMap: Record<string, string> = {};
    for (const [k, v] of snap.blobs.entries()) treeMap[k] = v.sha;
    ledger.branch = branch;
    ledger.lastSyncedHeadSha = snap.headSha;
    ledger.lastSyncedTreeShas = treeMap;
    if (!ledger.lastCommitSha) ledger.lastCommitSha = snap.headSha;
    ledger.lastSyncAt = new Date().toISOString();
    writeRestSyncLedger(projectDir, ledger);
    const updatedSt = await restGitSyncStatus(projectDir, false, fetcher);
    const msg = `Połączono katalog z ${GITHUB_REPOSITORY}@${branch} przez GitHub Git Data API (HEAD ${snap.headSha.slice(0, 7)}, lokalnych zmian: ${updatedSt.dirtyFiles?.length || 0}).`;
    logger('INFO', `GitHub init (REST): ${msg}`);
    return { ok: true, action, summary: msg, status: updatedSt, commitSha: snap.headSha, previousHead };
  }

  const pulledFiles: string[] = [];
  const pushedFiles: string[] = [];

  // Faza 1: Pobieranie zmian z GitHuba (dla 'pull' lub 'sync')
  if (action === 'pull' || action === 'sync') {
    const toPull = st.remotePendingFiles || [];
    for (const relPath of toPull) {
      if (isForbiddenSyncPath(relPath)) continue;
      const remBlob = snap.blobs.get(relPath);
      if (!remBlob) continue;
      const blobRes = await githubApi(
        'GET',
        `/repos/${GITHUB_REPOSITORY}/git/blobs/${remBlob.sha}`,
        undefined,
        fetcher,
      );
      if (!blobRes.ok || !blobRes.data || typeof (blobRes.data as any).content !== 'string') {
        continue;
      }
      const rawB64 = String((blobRes.data as any).content).replace(/\s+/g, '');
      const buf = Buffer.from(rawB64, 'base64');
      const isBinaryAsset = isAllowedBinaryAssetPath(relPath);
      if (buf.includes(0) && !isBinaryAsset) continue;
      const remoteText = isBinaryAsset ? '' : buf.toString('utf8');
      if (!isBinaryAsset && containsLikelySecret(remoteText)) continue;

      const absTarget = path.join(projectDir, relPath);
      fsSync.mkdirSync(path.dirname(absTarget), { recursive: true });
      if (relPath === 'data/svl_durable_backup.json' && fsSync.existsSync(absTarget)) {
        try {
          const localText = fsSync.readFileSync(absTarget, 'utf8');
          const merged = mergeDurableBackupJson(localText, remoteText);
          fsSync.writeFileSync(absTarget, merged || remoteText, 'utf8');
        } catch {
          fsSync.writeFileSync(absTarget, remoteText, 'utf8');
        }
      } else {
        fsSync.writeFileSync(absTarget, buf);
      }
      pulledFiles.push(relPath);
    }

    if (action === 'pull') {
      const treeMap: Record<string, string> = {};
      for (const [k, v] of snap.blobs.entries()) treeMap[k] = v.sha;
      ledger.lastSyncedHeadSha = snap.headSha;
      ledger.lastSyncedTreeShas = treeMap;
      ledger.lastPulledFiles = pulledFiles;
      ledger.lastCommitSha = snap.headSha;
      ledger.lastSyncAt = new Date().toISOString();
      if (pulledFiles.length > 0) {
        ledger.history.push({
          id: `sync-${Date.now().toString(36)}`,
          action: 'pull',
          commitSha: snap.headSha,
          shortSha: snap.headSha.slice(0, 7),
          previousHead: previousHead.slice(0, 7),
          pushedFiles: [],
          pulledFiles,
          message: `Pobrano z GitHuba (${pulledFiles.length} plików)`,
          timestamp: ledger.lastSyncAt,
        });
      }
      writeRestSyncLedger(projectDir, ledger);
      const afterPull = await restGitSyncStatus(projectDir, false, fetcher);
      const summary = pulledFiles.length > 0
        ? `Pobrano z GitHuba (${GITHUB_REPOSITORY}@${branch}): ${pulledFiles.length} plików (${pulledFiles.slice(0, 6).join(', ')}${pulledFiles.length > 6 ? '…' : ''}).`
        : `Brak nowych plików do pobrania z ${GITHUB_REPOSITORY}@${branch} (HEAD ${snap.headSha.slice(0, 7)}).`;
      logger('INFO', `GitHub pull (REST): ${summary}`);
      return { ok: true, action, summary, status: afterPull, pushedFiles: [], pulledFiles, commitSha: snap.headSha, previousHead };
    }
  }

  // Faza 2: Wysyłanie lokalnych zmian na GitHub (dla 'push' lub 'sync')
  const { files: localAfterPull, forbiddenSecretFiles } = collectTrackedWorkspaceFiles(projectDir);
  if (forbiddenSecretFiles.length > 0) {
    const errMsg = `Zatrzymano: wykryto potencjalny sekret w plikach: ${forbiddenSecretFiles.join(', ')}. Nic nie wysłano.`;
    logger('ERROR', errMsg);
    return { ok: false, action, summary: errMsg, status: st };
  }

  const changedLocal: LocalTrackedFile[] = [];
  for (const [relPath, local] of localAfterPull.entries()) {
    const rem = snap.blobs.get(relPath);
    if (!rem || rem.sha !== local.sha) {
      changedLocal.push(local);
    }
  }
  changedLocal.sort((a, b) => {
    // Priorytetyzuj artefakty SVL_CoreOS_2 (w tym Debian 13 + JEDI v12), backend, src i server.ts
    const score = (p: string) =>
      p.startsWith('SVL_CoreOS_2/') ? 0 : p.startsWith('backend/') ? 1 : p.startsWith('src/') ? 2 : p === 'server.ts' ? 3 : 4;
    return score(a.path) - score(b.path) || a.path.localeCompare(b.path);
  });

  let finalCommitSha = snap.headSha;
  if (changedLocal.length > 0) {
    // Utwórz bloby w partiach równoległych po 6 dla wszystkich zmienionych plików
    const treeEntries: Array<{ path: string; mode: '100644' | '100755'; type: 'blob'; sha?: string; content?: string }> = [];
    const batchSize = 6;
    for (let i = 0; i < changedLocal.length; i += batchSize) {
      const batch = changedLocal.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(async (item) => {
          // Dla małych plików tekstowych (< 12 KB) możemy przekazać content bezpośrednio; pliki binarne zawsze idą jako base64 blob
          if (!item.isBinary && item.size <= 12 * 1024 && changedLocal.length <= 15) {
            return {
              ok: true as const,
              entry: {
                path: item.path,
                mode: item.mode,
                type: 'blob' as const,
                content: item.buf.toString('utf8'),
              },
            };
          }
          const blobCreate = await githubApi(
            'POST',
            `/repos/${GITHUB_REPOSITORY}/git/blobs`,
            {
              content: item.buf.toString('base64'),
              encoding: 'base64',
            },
            fetcher,
          );
          if (!blobCreate.ok || !(blobCreate.data as any)?.sha) {
            return { ok: false as const, path: item.path, error: blobCreate.error || 'Błąd tworzenia bloba Git' };
          }
          return {
            ok: true as const,
            entry: {
              path: item.path,
              mode: item.mode,
              type: 'blob' as const,
              sha: String((blobCreate.data as any).sha),
            },
          };
        }),
      );
      for (const r of batchResults) {
        if (!r.ok) {
          return {
            ok: false,
            action,
            summary: `Błąd wysyłania bloba (${r.path}): ${r.error}`,
            status: st,
          };
        }
        treeEntries.push(r.entry);
        pushedFiles.push(r.entry.path);
      }
    }

    const newTreeRes = await githubApi(
      'POST',
      `/repos/${GITHUB_REPOSITORY}/git/trees`,
      {
        base_tree: snap.treeSha,
        tree: treeEntries,
      },
      fetcher,
    );
    if (!newTreeRes.ok || !(newTreeRes.data as any)?.sha) {
      return {
        ok: false,
        action,
        summary: `Nie udało się utworzyć drzewa Git na GitHubie: ${newTreeRes.error || 'brak sha'}`,
        status: st,
      };
    }
    const createdTreeSha = String((newTreeRes.data as any).sha);
    const cleanCommitMsg = String(message || 'SVL: synchronizacja obustronna z czatu i panelu').slice(0, 240);
    const newCommitRes = await githubApi(
      'POST',
      `/repos/${GITHUB_REPOSITORY}/git/commits`,
      {
        message: cleanCommitMsg,
        tree: createdTreeSha,
        parents: [snap.headSha],
      },
      fetcher,
    );
    if (!newCommitRes.ok || !(newCommitRes.data as any)?.sha) {
      return {
        ok: false,
        action,
        summary: `Nie udało się utworzyć commita na GitHubie: ${newCommitRes.error || 'brak sha'}`,
        status: st,
      };
    }
    finalCommitSha = String((newCommitRes.data as any).sha);

    const updateRefRes = await githubApi(
      'PATCH',
      `/repos/${GITHUB_REPOSITORY}/git/refs/heads/${encodeURIComponent(branch)}`,
      {
        sha: finalCommitSha,
        force: false,
      },
      fetcher,
    );
    if (!updateRefRes.ok) {
      return {
        ok: false,
        action,
        summary: `Nie udało się przesunąć gałęzi ${branch} do commita ${finalCommitSha.slice(0, 7)}: ${updateRefRes.error || 'błąd ref'}`,
        status: st,
      };
    }
  }

  // Odśwież drzewo po zapisie commita i zapisz stan w rejestrze synchronizacji
  const refreshedTree = await fetchRemoteGitTree(branch, true, fetcher);
  const newSnap = refreshedTree.snapshot || snap;
  const newTreeMap: Record<string, string> = {};
  for (const [k, v] of newSnap.blobs.entries()) newTreeMap[k] = v.sha;
  for (const item of changedLocal) newTreeMap[item.path] = item.sha;

  const syncTimestamp = new Date().toISOString();
  ledger.branch = branch;
  ledger.lastSyncedHeadSha = finalCommitSha;
  ledger.lastSyncedTreeShas = newTreeMap;
  ledger.lastPushedFiles = pushedFiles;
  ledger.lastPulledFiles = pulledFiles;
  ledger.lastCommitSha = finalCommitSha;
  ledger.lastSyncAt = syncTimestamp;
  ledger.history.push({
    id: `sync-${Date.now().toString(36)}`,
    action,
    commitSha: finalCommitSha,
    shortSha: finalCommitSha.slice(0, 7),
    previousHead: previousHead.slice(0, 7),
    pushedFiles,
    pulledFiles,
    message: String(message || 'SVL: synchronizacja obustronna').slice(0, 160),
    timestamp: syncTimestamp,
  });
  ledger.history = ledger.history.slice(-15);
  writeRestSyncLedger(projectDir, ledger);

  const finalStatus = await restGitSyncStatus(projectDir, false, fetcher);
  const summary =
    pushedFiles.length > 0 || pulledFiles.length > 0
      ? `Synchronizacja obustronna (${GITHUB_REPOSITORY}@${branch}) zakończona: wysłano ${pushedFiles.length} plików, pobrano ${pulledFiles.length} plików · commit ${previousHead.slice(0, 7)} → ${finalCommitSha.slice(0, 7)}.`
      : `Repozytorium ${GITHUB_REPOSITORY}@${branch} jest w 100% zgodne z lokalnym systemem (HEAD ${finalCommitSha.slice(0, 7)}, 0 różnic).`;

  logger('INFO', `GitHub ${action} (REST): ${summary}`);
  return {
    ok: true,
    action,
    summary,
    status: finalStatus,
    pushedFiles,
    pulledFiles,
    commitSha: finalCommitSha,
    previousHead,
  };
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
    if (canUseRestGitEngine(projectDir)) {
      return restGitSyncStatus(projectDir, doFetch);
    }
    return { ...base, error: 'Katalog projektu nie jest repozytorium git — użyj akcji „init”.' };
  }
  if (doFetch) {
    const f = await fetchRemote(projectDir, branch);
    if (!f.ok) return { ...base, isRepo: true, error: `Pobranie z GitHuba nie powiodło się: ${scrub(f.stderr)}` };
  }
  const localBranch = (await git(projectDir, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  const head = (await git(projectDir, ['rev-parse', '--short', 'HEAD'])).stdout.trim();
  const headFull = (await git(projectDir, ['rev-parse', 'HEAD'])).stdout.trim();
  const remote = await git(projectDir, ['rev-parse', '--short', TRACKING_REF(branch)]);
  const remoteFull = await git(projectDir, ['rev-parse', TRACKING_REF(branch)]);
  const counts = remote.ok
    ? (await git(projectDir, ['rev-list', '--left-right', '--count', `HEAD...${TRACKING_REF(branch)}`])).stdout.trim().split(/\s+/)
    : ['0', '0'];
  const dirty = (await git(projectDir, ['status', '--porcelain'])).stdout.split('\n').filter(Boolean).map((l) => l.slice(3));
  const ledger = readRestSyncLedger(projectDir, branch);
  return {
    ok: true,
    isRepo: true,
    syncEngine: 'local_git',
    repository: GITHUB_REPOSITORY,
    branch,
    localBranch,
    head,
    headFull,
    remoteHead: remote.ok ? remote.stdout.trim() : null,
    remoteHeadFull: remoteFull.ok ? remoteFull.stdout.trim() : null,
    ahead: Number(counts[0] || 0),
    behind: Number(counts[1] || 0),
    dirtyFiles: dirty.slice(0, 50),
    dirtyFilesCount: dirty.length,
    lastPushedFiles: ledger.lastPushedFiles,
    lastPulledFiles: ledger.lastPulledFiles,
    lastCommitSha: headFull || ledger.lastCommitSha || null,
    lastSyncAt: ledger.lastSyncAt || null,
    syncHistory: ledger.history,
  };
}

/** Commit lokalnych zmian (z blokadą sekretów). Zwraca listę zapisanych plików. */
async function commitLocalChanges(
  projectDir: string,
  message: string,
): Promise<{ ok: boolean; committed: boolean; stagedFiles: string[]; error?: string }> {
  const dirty = (await git(projectDir, ['status', '--porcelain'])).stdout.trim();
  if (!dirty) return { ok: true, committed: false, stagedFiles: [] };
  await git(projectDir, ['add', '-A']);
  const staged = (await git(projectDir, ['diff', '--cached', '--name-only'])).stdout.split('\n').filter(Boolean);
  const forbidden = staged.filter((f) => /(^|\/)\.env($|\.)|\.secret$|\.pem$|id_rsa|id_ed25519/i.test(f) && !/\.env\.example$/.test(f));
  const diff = (await git(projectDir, ['diff', '--cached'])).stdout;
  if (forbidden.length > 0 || containsLikelySecret(diff)) {
    await git(projectDir, ['reset', '-q']);
    const reason = forbidden.length > 0 ? `pliki z sekretami: ${forbidden.join(', ')}` : 'treść wygląda na sekret (token/klucz)';
    logger('ERROR', `Synchronizacja GitHub zablokowana — ${reason}`);
    return { ok: false, committed: false, stagedFiles: [], error: `Zatrzymano: zmiany zawierają ${reason}. Nic nie wysłano.` };
  }
  const c = await git(projectDir, ['commit', '-q', '-m', message.slice(0, 200)]);
  if (!c.ok) return { ok: false, committed: false, stagedFiles: [], error: `Commit nie powiódł się: ${scrub(c.stderr)}` };
  return { ok: true, committed: true, stagedFiles: staged };
}

function mergeDurableBackupJson(oursRaw: string, theirsRaw: string): string | null {
  try {
    const ours = JSON.parse(oursRaw);
    const theirs = JSON.parse(theirsRaw);
    if (!ours || typeof ours !== 'object' || !theirs || typeof theirs !== 'object') return null;
    const mergeById = (a: unknown, b: unknown, sortKey: string) => {
      const map = new Map<string, Record<string, unknown>>();
      for (const list of [Array.isArray(a) ? a : [], Array.isArray(b) ? b : []]) {
        for (const item of list) {
          if (item && typeof item === 'object' && typeof (item as any).id === 'string') {
            map.set((item as any).id, item as Record<string, unknown>);
          }
        }
      }
      return Array.from(map.values()).sort((x, y) =>
        String(x[sortKey] || '').localeCompare(String(y[sortKey] || '')),
      );
    };
    return JSON.stringify({
      version: 1,
      saved_at: new Date().toISOString(),
      explicitly_cleared: false,
      conversations: mergeById(theirs.conversations, ours.conversations, 'updated_at'),
      chat_messages: mergeById(theirs.chat_messages, ours.chat_messages, 'created_at'),
      agent_memory: mergeById(theirs.agent_memory, ours.agent_memory, 'created_at'),
    });
  } catch {
    return null;
  }
}

async function mergeRemote(
  projectDir: string,
  branch: string,
): Promise<{ ok: boolean; merged: boolean; pulledFiles: string[]; error?: string }> {
  const ref = TRACKING_REF(branch);
  const beforeHead = (await git(projectDir, ['rev-parse', 'HEAD'])).stdout.trim();
  const ff = await git(projectDir, ['merge', '--ff-only', ref]);
  if (ff.ok) {
    const merged = !/Already up to date/i.test(ff.stdout);
    const pulled = merged
      ? (await git(projectDir, ['diff', '--name-only', beforeHead, 'HEAD'])).stdout.split('\n').filter(Boolean)
      : [];
    return { ok: true, merged, pulledFiles: pulled };
  }
  const m = await git(projectDir, ['merge', '--no-edit', ref]);
  if (m.ok) {
    const pulled = (await git(projectDir, ['diff', '--name-only', beforeHead, 'HEAD'])).stdout.split('\n').filter(Boolean);
    return { ok: true, merged: true, pulledFiles: pulled };
  }
  const conflicts = (await git(projectDir, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
  if (conflicts.length === 1 && conflicts[0] === 'data/svl_durable_backup.json') {
    const ours = await git(projectDir, ['show', ':2:data/svl_durable_backup.json']);
    const theirs = await git(projectDir, ['show', ':3:data/svl_durable_backup.json']);
    const mergedJson = ours.ok && theirs.ok ? mergeDurableBackupJson(ours.stdout, theirs.stdout) : null;
    if (mergedJson) {
      fsSync.writeFileSync(path.join(projectDir, 'data', 'svl_durable_backup.json'), mergedJson, 'utf8');
      const addRes = await git(projectDir, ['add', 'data/svl_durable_backup.json']);
      const commitRes = addRes.ok ? await git(projectDir, ['commit', '-q', '--no-edit']) : addRes;
      if (commitRes.ok) return { ok: true, merged: true, pulledFiles: ['data/svl_durable_backup.json'] };
    }
  }
  await git(projectDir, ['merge', '--abort']);
  return {
    ok: false,
    merged: false,
    pulledFiles: [],
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
): Promise<{
  ok: boolean;
  action: GitSyncAction;
  summary: string;
  status?: GitSyncStatus;
  pushedFiles?: string[];
  pulledFiles?: string[];
  commitSha?: string;
  previousHead?: string;
}> {
  const branch = syncBranch();
  if (canUseRestGitEngine(projectDir)) {
    return restGitSync(projectDir, action, message);
  }
  const done = async (
    ok: boolean,
    summary: string,
    extra: { pushedFiles?: string[]; pulledFiles?: string[]; commitSha?: string; previousHead?: string } = {},
  ) => {
    logger(ok ? 'INFO' : 'WARN', `GitHub ${action}: ${summary}`);
    const currentStatus = await gitSyncStatus(projectDir, false);
    return {
      ok,
      action,
      summary,
      status: currentStatus,
      pushedFiles: extra.pushedFiles || [],
      pulledFiles: extra.pulledFiles || [],
      commitSha: extra.commitSha || currentStatus.headFull || currentStatus.head,
      previousHead: extra.previousHead,
    };
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
  const previousHead = fetched.remoteHeadFull || fetched.headFull || fetched.head;

  if (action === 'pull') {
    if ((fetched.dirtyFiles || []).length > 0) {
      return done(false, `Masz niezapisane zmiany (${fetched.dirtyFiles!.length} plików) — użyj „synchronizuj” (zapisze je i scali) albo „wyślij”.`);
    }
    const merged = await mergeRemote(projectDir, branch);
    return done(
      merged.ok,
      merged.ok ? (merged.merged ? `Pobrano zmiany z GitHuba (${fetched.behind} commitów).` : 'Brak nowych zmian na GitHubie.') : merged.error!,
      { pulledFiles: merged.pulledFiles, previousHead },
    );
  }

  const committed = await commitLocalChanges(projectDir, message);
  if (!committed.ok) return done(false, committed.error!);

  if (action === 'push') {
    const pushed = await pushBranch(projectDir, branch);
    if (!pushed.ok) {
      const rejected = /rejected|non-fast-forward|fetch first/i.test(pushed.stderr);
      return done(false, rejected ? 'GitHub ma nowsze zmiany — użyj „synchronizuj” (pobierze, scali i wyśle).' : `Wysłanie nie powiodło się: ${scrub(pushed.stderr)}`);
    }
    return done(
      true,
      `Wysłano na GitHub (${GITHUB_REPOSITORY}@${branch})${committed.committed ? ' razem z nowym commitem lokalnych zmian' : ''}.`,
      { pushedFiles: committed.stagedFiles, previousHead },
    );
  }

  // sync: lokalne → commit, zdalne → scal, potem wyślij
  const merged = await mergeRemote(projectDir, branch);
  if (!merged.ok) return done(false, merged.error!);
  const after = await gitSyncStatus(projectDir, false);
  if ((after.ahead || 0) > 0) {
    const pushed = await pushBranch(projectDir, branch);
    if (!pushed.ok) return done(false, `Wysłanie nie powiodło się: ${scrub(pushed.stderr)}`);
  }
  return done(
    true,
    `Synchronizacja obustronna zakończona: pobrano ${fetched.behind || 0}, wysłano ${after.ahead || 0} commitów${committed.committed ? ' (w tym zapis lokalnych zmian)' : ''}.`,
    { pushedFiles: committed.stagedFiles, pulledFiles: merged.pulledFiles, previousHead },
  );
}

export function describeStatus(s: GitSyncStatus): string {
  if (!s.isRepo) return s.error || 'Brak repozytorium git.';
  const dirty = (s.dirtyFiles || []).length;
  const engineLabel = s.syncEngine === 'github_rest_api' ? ' [Git Data API]' : '';
  return `${GITHUB_REPOSITORY}@${s.branch}${engineLabel}: lokalnie ${s.head} (${s.localBranch}), GitHub ${s.remoteHead || '—'} · do wysłania ${s.ahead ?? 0}, do pobrania ${s.behind ?? 0}, zmienionych plików ${dirty}`;
}

export async function gitFastForwardPull(projectDir: string): Promise<{
  ok: boolean;
  changed: boolean;
  changedFiles: string[];
  head?: string;
  skipped?: string;
  error?: string;
}> {
  const branch = syncBranch();
  const isGit = (await git(projectDir, ['rev-parse', '--is-inside-work-tree'])).ok;
  if (!isGit) {
    if (canUseRestGitEngine(projectDir)) {
      const res = await restGitSync(projectDir, 'pull', 'SVL: automatyczne pobranie z GitHuba');
      return {
        ok: res.ok,
        changed: (res.pulledFiles || []).length > 0,
        changedFiles: res.pulledFiles || [],
        head: res.status?.head,
        ...(res.ok ? {} : { error: res.summary }),
      };
    }
    return { ok: false, changed: false, changedFiles: [], skipped: 'brak repozytorium git' };
  }
  const f = await fetchRemote(projectDir, branch);
  if (!f.ok) return { ok: false, changed: false, changedFiles: [], error: scrub(f.stderr) };
  const ref = TRACKING_REF(branch);
  const counts = (await git(projectDir, ['rev-list', '--left-right', '--count', `HEAD...${ref}`])).stdout.trim().split(/\s+/);
  const ahead = Number(counts[0] || 0);
  const behind = Number(counts[1] || 0);
  if (behind === 0) return { ok: true, changed: false, changedFiles: [] };
  if (ahead > 0) {
    return { ok: true, changed: false, changedFiles: [], skipped: `masz ${ahead} własnych commitów do wysłania` };
  }
  const incoming = (await git(projectDir, ['diff', '--name-only', `HEAD..${ref}`])).stdout.split('\n').filter(Boolean);
  const dirtyLines = (await git(projectDir, ['status', '--porcelain'])).stdout.split('\n').filter(Boolean);
  const dirtySet = new Set(dirtyLines.map((l) => l.slice(3).trim()));
  const overlap = incoming.filter((file) => dirtySet.has(file));
  if (overlap.length > 0) {
    return {
      ok: true,
      changed: false,
      changedFiles: [],
      skipped: `niezapisane zmiany w plikach: ${overlap.join(', ')}`,
    };
  }
  const beforeHead = (await git(projectDir, ['rev-parse', 'HEAD'])).stdout.trim();
  const ff = await git(projectDir, ['merge', '--ff-only', ref]);
  if (!ff.ok) {
    return { ok: false, changed: false, changedFiles: [], error: scrub(ff.stderr) };
  }
  const changedFiles = (await git(projectDir, ['diff', '--name-only', beforeHead, 'HEAD'])).stdout.split('\n').filter(Boolean);
  const newHead = (await git(projectDir, ['rev-parse', '--short', 'HEAD'])).stdout.trim();
  return { ok: true, changed: changedFiles.length > 0, changedFiles, head: newHead };
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
