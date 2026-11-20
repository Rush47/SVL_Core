import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitFastForwardPull } from './githubAdmin.ts';

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'svl-autopull-'));
  const bare = path.join(base, 'remote.git');
  const app = path.join(base, 'app');
  const other = path.join(base, 'other');
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd }).toString().trim();
  fs.mkdirSync(bare);
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  git(base, 'clone', '-q', bare, 'app');
  fs.writeFileSync(path.join(app, 'a.txt'), '1');
  git(app, 'add', '.');
  git(app, 'commit', '-qm', 'init');
  git(app, 'push', '-q', 'origin', 'HEAD:main');
  git(base, 'clone', '-q', bare, 'other');
  const pushRemote = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(other, file)), { recursive: true });
    fs.writeFileSync(path.join(other, file), content);
    git(other, 'add', '.');
    git(other, 'commit', '-qm', `zmiana ${file}`);
    git(other, 'push', '-q', 'origin', 'HEAD:main');
  };
  return { base, bare, app, git, pushRemote };
}

test('gitFastForwardPull: pobiera nowe commity fast-forward i zwraca zmienione pliki', async (t) => {
  const s = setup();
  const prevUrl = process.env.SVL_GITHUB_REMOTE_URL;
  process.env.SVL_GITHUB_REMOTE_URL = s.bare;
  t.after(() => {
    if (prevUrl === undefined) delete process.env.SVL_GITHUB_REMOTE_URL;
    else process.env.SVL_GITHUB_REMOTE_URL = prevUrl;
    fs.rmSync(s.base, { recursive: true, force: true });
  });

  assert.equal((await gitFastForwardPull(s.app)).changed, false);

  s.pushRemote('src/components/Nowy.tsx', 'export const Nowy = 1;');
  const r = await gitFastForwardPull(s.app);
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.deepEqual(r.changedFiles, ['src/components/Nowy.tsx']);
  assert.ok(fs.existsSync(path.join(s.app, 'src/components/Nowy.tsx')));

  // Niezapisana zmiana w pliku, który przychodzi z GitHuba → pominięcie, nic nie nadpisane.
  s.pushRemote('a.txt', 'zdalnie');
  fs.writeFileSync(path.join(s.app, 'a.txt'), 'lokalnie');
  const skipped = await gitFastForwardPull(s.app);
  assert.equal(skipped.changed, false);
  assert.match(String(skipped.skipped), /niezapisane zmiany/);
  assert.equal(fs.readFileSync(path.join(s.app, 'a.txt'), 'utf8'), 'lokalnie');

  // Niezapisana zmiana w INNYM pliku nie blokuje pobrania.
  s.git(s.app, 'checkout', '-q', '--', 'a.txt');
  fs.writeFileSync(path.join(s.app, 'notatka.md'), 'lokalna');
  const ok2 = await gitFastForwardPull(s.app);
  assert.equal(ok2.changed, true);
  assert.equal(fs.readFileSync(path.join(s.app, 'a.txt'), 'utf8'), 'zdalnie');

  // Lokalny commit (rozjazd) → bez scalania, tylko informacja.
  fs.writeFileSync(path.join(s.app, 'lokalny.txt'), 'x');
  s.git(s.app, 'add', 'lokalny.txt');
  s.git(s.app, 'commit', '-qm', 'lokalny');
  s.pushRemote('b.txt', 'b');
  const diverged = await gitFastForwardPull(s.app);
  assert.equal(diverged.changed, false);
  assert.match(String(diverged.skipped), /własnych commitów/);
});
