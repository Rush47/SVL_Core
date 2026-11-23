import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  RepoChangeAggregator,
  classifyRepoPath,
  isIgnoredRepoPath,
  readGitHead,
  startGitHeadWatcher,
  startRepoWatcher,
  gitChangedFiles,
} from './repoWatcher.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('isIgnoredRepoPath: szum (node_modules, .git, dist, data, logi, sqlite, tmp) jest pomijany', () => {
  for (const p of [
    'node_modules/react/index.js',
    '.git/HEAD',
    '.git/refs/heads/main',
    'dist/index.html',
    'dist.__next/assets/a.js',
    'dist.__prev/index.html',
    'data/svl_durable_backup.json',
    'data/svl.sqlite3-wal',
    'logi/svl_2026.txt',
    'backend/__pycache__/app.cpython-312.pyc',
    'src/components/.Foo.tsx.swp',
    'src/x.ts.tmp-1234',
    'src/components/sedmne3XE',
    'server.log',
    '.env',
    '.env.local',
    '',
    '../outside.ts',
  ]) {
    assert.equal(isIgnoredRepoPath(p), true, p);
  }
  for (const p of ['src/App.tsx', 'server.ts', 'SVL_CoreOS_2/kernel/x.py', 'backend/app.py', 'index.html', 'package.json', 'README.md', '.env.example']) {
    assert.equal(isIgnoredRepoPath(p), false, p);
  }
});

test('isIgnoredRepoPath: dodatkowe wykluczenia z SVL_LIVE_WATCH_IGNORE (nazwa lub ścieżka)', () => {
  assert.equal(isIgnoredRepoPath('tmpfiles/a.txt', ['tmpfiles']), true);
  assert.equal(isIgnoredRepoPath('SVL_CoreOS_2/cache/a.bin', ['SVL_CoreOS_2/cache']), true);
  assert.equal(isIgnoredRepoPath('SVL_CoreOS_2/kernel/a.py', ['SVL_CoreOS_2/cache']), false);
});

test('classifyRepoPath: frontend / serwer / Python / zależności', () => {
  assert.deepEqual(classifyRepoPath('src/components/GitHubPanel.tsx').sort(), ['content', 'frontend']);
  assert.deepEqual(classifyRepoPath('index.html').sort(), ['content', 'frontend']);
  assert.deepEqual(classifyRepoPath('server.ts').sort(), ['content', 'server']);
  assert.deepEqual(classifyRepoPath('src/server/liveSyncBus.ts').sort(), ['content', 'server']);
  assert.deepEqual(classifyRepoPath('src/utils/svlLogic.ts').sort(), ['content', 'frontend', 'server']);
  assert.deepEqual(classifyRepoPath('backend/app.py').sort(), ['content', 'python']);
  assert.deepEqual(classifyRepoPath('package-lock.json').sort(), ['content', 'deps']);
  assert.deepEqual(classifyRepoPath('SVL_CoreOS_2/kernel/x.py'), ['content']);
  // testy nie wymagają przebudowy ani restartu
  assert.deepEqual(classifyRepoPath('src/server/repoWatcher.test.ts'), ['content']);
  assert.deepEqual(classifyRepoPath('backend/tests/test_x.py'), ['content']);
});

test('RepoChangeAggregator: seria zdarzeń = jedna paczka po ciszy (debounce), duplikaty scalone', async () => {
  const batches: any[] = [];
  const agg = new RepoChangeAggregator((b) => batches.push(b), 40, 1000);
  agg.add('src/App.tsx', 'watcher');
  await sleep(10);
  agg.add(['src/App.tsx', 'server.ts'], 'czat');
  await sleep(10);
  agg.add('SVL_CoreOS_2/a.md', 'watcher');
  assert.equal(batches.length, 0);
  await sleep(80);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].paths, ['SVL_CoreOS_2/a.md', 'server.ts', 'src/App.tsx']);
  assert.deepEqual(batches[0].sources, ['czat', 'watcher']);
  assert.ok(batches[0].kinds.includes('frontend'));
  assert.ok(batches[0].kinds.includes('server'));
  agg.dispose();
});

test('RepoChangeAggregator: maxWait wymusza wysłanie przy ciągłych zmianach (git pull setek plików)', async () => {
  const batches: any[] = [];
  const agg = new RepoChangeAggregator((b) => batches.push(b), 50, 120);
  const started = Date.now();
  while (Date.now() - started < 200) {
    agg.add(`SVL_CoreOS_2/f${Date.now()}.txt`);
    await sleep(15);
  }
  assert.ok(batches.length >= 1, 'co najmniej jedna paczka w trakcie ciągłych zmian');
  agg.dispose();
});

test('RepoChangeAggregator: limit liczby ścieżek w paczce', async () => {
  const batches: any[] = [];
  const agg = new RepoChangeAggregator((b) => batches.push(b), 10, 100, 5);
  agg.add(Array.from({ length: 20 }, (_, i) => `a/${i}.txt`));
  agg.flush();
  assert.equal(batches[0].paths.length, 5);
});

test('startRepoWatcher: wykrywa zapis w podkatalogu i nowy katalog, ignoruje node_modules/dist', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svl-watch-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.mkdirSync(path.join(root, 'dist'));
  const seen: string[] = [];
  const w = startRepoWatcher({ root, onPath: (p) => seen.push(p) });
  try {
    assert.equal(w.mode, 'fs.watch');
    assert.deepEqual(w.watchedDirs(), ['src']);
    await sleep(50);
    fs.writeFileSync(path.join(root, 'node_modules', 'x.js'), '1');
    fs.writeFileSync(path.join(root, 'dist', 'index.html'), '1');
    fs.writeFileSync(path.join(root, 'src', 'App.tsx'), 'export {}');
    fs.writeFileSync(path.join(root, 'server.ts'), '//');
    fs.mkdirSync(path.join(root, 'SVL_CoreOS_2'));
    await sleep(150);
    fs.writeFileSync(path.join(root, 'SVL_CoreOS_2', 'nowy.md'), '# x');
    await sleep(300);
    assert.ok(seen.includes('src/App.tsx'), `src/App.tsx w ${seen.join(',')}`);
    assert.ok(seen.includes('server.ts'));
    assert.ok(seen.some((p) => p.startsWith('SVL_CoreOS_2')), 'nowy katalog najwyższego poziomu');
    assert.ok(!seen.some((p) => p.startsWith('node_modules') || p.startsWith('dist')));
  } finally {
    w.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readGitHead + startGitHeadWatcher + gitChangedFiles: wykrywa nowy commit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svl-head-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root }).toString().trim();
  try {
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(root, 'a.txt'), '1');
    git('add', '.');
    git('commit', '-qm', 'one');
    const first = readGitHead(root);
    assert.ok(first && /^[0-9a-f]{40}$/.test(first.sha));
    assert.equal(first!.ref, 'refs/heads/main');
    const changes: Array<[string, string]> = [];
    const hw = startGitHeadWatcher({ root, intervalMs: 250, onChange: (a, b) => changes.push([a, b]) });
    fs.writeFileSync(path.join(root, 'b.txt'), '2');
    git('add', '.');
    git('commit', '-qm', 'two');
    await sleep(600);
    hw.close();
    assert.equal(changes.length, 1);
    assert.equal(changes[0][0], first!.sha);
    assert.deepEqual(await gitChangedFiles(root, changes[0][0], changes[0][1]), ['b.txt']);
    // packed-refs
    git('pack-refs', '--all');
    assert.equal(readGitHead(root)?.sha, changes[0][1]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('gitChangedFiles odrzuca nieprawidłowe SHA (bez wstrzyknięcia argumentów)', async () => {
  assert.deepEqual(await gitChangedFiles(os.tmpdir(), '--output=/tmp/x', 'abc1234'), []);
});
