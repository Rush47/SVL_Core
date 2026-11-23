import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GITHUB_REPOSITORY,
  assessGhCommand,
  destructiveReason,
  gitSync,
  githubApi,
  isAllowedApiPath,
  splitArgs,
} from './githubAdmin.ts';

test('GitHub API is locked to Rush47/SVL_Core', () => {
  assert.equal(GITHUB_REPOSITORY, 'Rush47/SVL_Core');
  assert.equal(isAllowedApiPath('GET', '/repos/Rush47/SVL_Core/pulls'), true);
  assert.equal(isAllowedApiPath('POST', 'repos/rush47/svl_core/issues'), true);
  assert.equal(isAllowedApiPath('GET', '/repos/{owner}/{repo}/branches'), true);
  assert.equal(isAllowedApiPath('GET', '/repos/mmitek515-netizen/SVL_open'), false);
  assert.equal(isAllowedApiPath('GET', '/repos/Rush47/SVL_Core_evil/pulls'), false);
  assert.equal(isAllowedApiPath('GET', '/user'), true);
  assert.equal(isAllowedApiPath('POST', '/user/repos'), false);
  assert.equal(isAllowedApiPath('GET', '/repos/Rush47/SVL_Core/../other/x'), false);
});

test('irreversible operations are classified for operator confirmation', () => {
  assert.match(String(destructiveReason('DELETE', '/repos/Rush47/SVL_Core')), /CAŁEGO REPOZYTORIUM/);
  assert.ok(destructiveReason('DELETE', '/repos/Rush47/SVL_Core/git/refs/heads/x'));
  assert.ok(destructiveReason('PATCH', '/repos/Rush47/SVL_Core', { private: false }));
  assert.ok(destructiveReason('PUT', '/repos/Rush47/SVL_Core/collaborators/someone'));
  assert.ok(destructiveReason('PUT', '/repos/Rush47/SVL_Core/branches/main/protection'));
  assert.ok(destructiveReason('PUT', '/repos/Rush47/SVL_Core/pulls/12/merge'));
  assert.ok(destructiveReason('PATCH', '/repos/Rush47/SVL_Core/git/refs/heads/main', { sha: 'x', force: true }));
  assert.equal(destructiveReason('POST', '/repos/Rush47/SVL_Core/issues', { title: 'x' }), null);
  assert.equal(destructiveReason('GET', '/repos/Rush47/SVL_Core'), null);
});

test('gh commands: only this repository, destructive ones flagged', () => {
  assert.deepEqual(splitArgs('issue create --title "Nowy błąd" --body \'opis z spacjami\''), [
    'issue', 'create', '--title', 'Nowy błąd', '--body', 'opis z spacjami',
  ]);
  assert.deepEqual(assessGhCommand(['pr', 'list']), { allowed: true, destructive: null });
  assert.match(String(assessGhCommand(['repo', 'delete', '--yes']).destructive), /USUNIĘCIE/);
  assert.ok(assessGhCommand(['pr', 'merge', '5']).destructive);
  assert.equal(assessGhCommand(['repo', 'view', 'mmitek515-netizen/SVL_open']).allowed, false);
  assert.equal(assessGhCommand(['pr', 'list', '-R', 'someone/else']).allowed, false);
  assert.equal(assessGhCommand(['repo', 'create', 'nowe']).allowed, false);
  assert.equal(assessGhCommand(['search', 'repos', 'x']).allowed, false);
  assert.equal(assessGhCommand(['auth', 'login']).allowed, false);
  assert.equal(assessGhCommand(['api', '/repos/other/repo']).allowed, false);
  assert.ok(assessGhCommand(['api', '-X', 'DELETE', '/repos/Rush47/SVL_Core/releases/1']).destructive);
});

test('githubApi sends the token only to api.github.com and never for foreign repos', async () => {
  const prev = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'ghp_testtokentesttokentesttoken123456';
  const calls: Array<{ url: string; auth: string | null }> = [];
  const fakeFetch = (async (url: string, init: any) => {
    calls.push({ url, auth: init.headers.Authorization });
    return new Response(JSON.stringify({ number: 7 }), { status: 201, headers: { 'x-oauth-scopes': 'repo, workflow' } });
  }) as unknown as typeof fetch;
  try {
    const ok = await githubApi('POST', '/repos/Rush47/SVL_Core/issues', '{"title":"x"}', fakeFetch);
    assert.equal(ok.ok, true);
    assert.equal(ok.scopes, 'repo, workflow');
    const blocked = await githubApi('GET', '/repos/other/repo', undefined, fakeFetch);
    assert.equal(blocked.ok, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.github.com/repos/Rush47/SVL_Core/issues');
    assert.equal(calls[0].auth, 'Bearer ghp_testtokentesttokentesttoken123456');
  } finally {
    if (prev === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prev;
  }
});

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  }).trim();
}

test('bidirectional sync: local + remote changes merge, conflicts abort, secrets are blocked', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svl-gh-sync-'));
  const bare = path.join(root, 'remote.git');
  const project = path.join(root, 'project');
  const other = path.join(root, 'other');
  const prevRemote = process.env.SVL_GITHUB_REMOTE_URL;
  process.env.SVL_GITHUB_REMOTE_URL = `file://${bare}`;
  try {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    execFileSync('git', ['clone', '-q', bare, project]);
    fs.writeFileSync(path.join(project, 'a.txt'), 'start\n');
    sh(project, 'add', '-A');
    sh(project, 'commit', '-q', '-m', 'init');
    sh(project, 'push', '-q', 'origin', 'HEAD:main');
    execFileSync('git', ['clone', '-q', bare, other]);

    // Zmiana na „GitHubie” (inny klient) + lokalna zmiana w projekcie.
    fs.writeFileSync(path.join(other, 'remote.txt'), 'z GitHuba\n');
    sh(other, 'add', '-A');
    sh(other, 'commit', '-q', '-m', 'remote change');
    sh(other, 'push', '-q', 'origin', 'HEAD:main');
    fs.writeFileSync(path.join(project, 'local.txt'), 'lokalnie\n');

    const status = await gitSync(project, 'status');
    assert.equal(status.status?.behind, 1);
    assert.deepEqual(status.status?.dirtyFiles, ['local.txt']);

    const pullDirty = await gitSync(project, 'pull');
    assert.equal(pullDirty.ok, false);

    const synced = await gitSync(project, 'sync', 'test sync');
    assert.equal(synced.ok, true, synced.summary);
    assert.ok(fs.existsSync(path.join(project, 'remote.txt')));
    sh(other, 'pull', '-q', 'origin', 'main');
    assert.ok(fs.existsSync(path.join(other, 'local.txt')), 'lokalna zmiana dotarła na GitHub');

    // Konflikt: ta sama linia zmieniona po obu stronach → przerwanie bez nadpisania.
    fs.writeFileSync(path.join(other, 'a.txt'), 'wersja GitHub\n');
    sh(other, 'commit', '-q', '-am', 'remote edit');
    sh(other, 'push', '-q', 'origin', 'HEAD:main');
    fs.writeFileSync(path.join(project, 'a.txt'), 'wersja lokalna\n');
    const conflict = await gitSync(project, 'sync', 'conflict');
    assert.equal(conflict.ok, false);
    assert.match(conflict.summary, /Konflikt scalania w plikach: a\.txt/);
    assert.equal(fs.readFileSync(path.join(project, 'a.txt'), 'utf8'), 'wersja lokalna\n');
    sh(project, 'reset', '-q', '--hard', 'refs/remotes/svl-github/main');

    // Sekret w zmianach → nic nie zostaje wysłane.
    fs.writeFileSync(path.join(project, 'leak.ts'), 'const t = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\n');
    const leak = await gitSync(project, 'push');
    assert.equal(leak.ok, false);
    assert.match(leak.summary, /sekret/);
    assert.equal(sh(project, 'diff', '--cached', '--name-only'), '');
  } finally {
    if (prevRemote === undefined) delete process.env.SVL_GITHUB_REMOTE_URL;
    else process.env.SVL_GITHUB_REMOTE_URL = prevRemote;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('gitSync init recovers an unborn .git directory without overwriting workspace files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svl-gh-init-'));
  const bare = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const target = path.join(root, 'target');
  const prevRemote = process.env.SVL_GITHUB_REMOTE_URL;
  process.env.SVL_GITHUB_REMOTE_URL = `file://${bare}`;
  try {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    execFileSync('git', ['clone', '-q', bare, seed]);
    fs.writeFileSync(path.join(seed, 'README.md'), 'remote\n');
    sh(seed, 'add', '-A');
    sh(seed, 'commit', '-q', '-m', 'initial');
    sh(seed, 'push', '-q', 'origin', 'HEAD:main');

    fs.mkdirSync(target, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', target]);
    fs.writeFileSync(path.join(target, 'README.md'), 'local-edit\n');

    const res = await gitSync(target, 'init');
    assert.equal(res.ok, true, res.summary);
    assert.equal(fs.readFileSync(path.join(target, 'README.md'), 'utf8'), 'local-edit\n');
    assert.equal(res.status?.dirtyFiles?.includes('README.md'), true);
  } finally {
    if (prevRemote === undefined) delete process.env.SVL_GITHUB_REMOTE_URL;
    else process.env.SVL_GITHUB_REMOTE_URL = prevRemote;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('computeGitBlobSha matches canonical git hash-object output', async () => {
  const { computeGitBlobSha } = await import('./githubAdmin.ts');
  const buf = Buffer.from('SVL CoreOS 2 Debian 13 Trixie\n', 'utf8');
  const expected = execFileSync('git', ['hash-object', '--stdin'], { input: buf, encoding: 'utf8' }).trim();
  assert.equal(computeGitBlobSha(buf), expected);
});

test('REST sync tracks binary avatar assets under src/assets and public/assets via base64', async () => {
  const { isAllowedBinaryAssetPath, restGitSyncStatus } = await import('./githubAdmin.ts');
  assert.equal(isAllowedBinaryAssetPath('src/assets/images/avatar_jyn_core_1795287629705.jpg'), true);
  assert.equal(isAllowedBinaryAssetPath('public/assets/avatar_jyn_core.jpg'), true);
  assert.equal(isAllowedBinaryAssetPath('public/assets/aistudio/Screenshot_test.jpg'), false);
  assert.equal(isAllowedBinaryAssetPath('data/secret.jpg'), false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svl-gh-bin-'));
  const prevToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'ghp_testtokentesttokentesttoken123456';
  try {
    fs.mkdirSync(path.join(root, 'src', 'assets', 'images'), { recursive: true });
    // Fake JPEG bytes containing NUL bytes so binary handling is exercised
    const fakeJpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
    fs.writeFileSync(path.join(root, 'src', 'assets', 'images', 'avatar_jyn_core_test.jpg'), fakeJpg);

    const fakeFetch = (async (url: string) => {
      if (url.includes('/commits/')) {
        return new Response(JSON.stringify({ sha: 'a'.repeat(40), commit: { tree: { sha: 'b'.repeat(40) } } }), { status: 200 });
      }
      return new Response(JSON.stringify({ sha: 'b'.repeat(40), tree: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const status = await restGitSyncStatus(root, true, fakeFetch);
    assert.equal(status.ok, true);
    assert.equal(status.dirtyFiles?.includes('src/assets/images/avatar_jyn_core_test.jpg'), true);
  } finally {
    if (prevToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prevToken;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getGitHubToken czyta token z pliku GITHUB_TOKEN_FILE gdy brak zmiennych bezpośrednich', async () => {
  const { getGitHubToken } = await import('./githubAdmin.ts');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svl-gh-tok-'));
  const tokFile = path.join(tmpDir, 'gh.token');
  fs.writeFileSync(tokFile, 'ghp_filetoken1234567890abcdef123456\n', 'utf8');
  const prevGh = process.env.GITHUB_TOKEN;
  const prevCli = process.env.GH_TOKEN;
  const prevFile = process.env.GITHUB_TOKEN_FILE;
  try {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    process.env.GITHUB_TOKEN_FILE = tokFile;
    assert.equal(getGitHubToken(), 'ghp_filetoken1234567890abcdef123456');
  } finally {
    if (prevGh === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prevGh;
    if (prevCli === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = prevCli;
    if (prevFile === undefined) delete process.env.GITHUB_TOKEN_FILE;
    else process.env.GITHUB_TOKEN_FILE = prevFile;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
