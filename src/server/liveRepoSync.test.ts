import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LiveRepoSync, detectSupervisor, loadLiveRepoSyncConfig } from './liveRepoSync.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mk(over: Partial<Parameters<typeof loadLiveRepoSyncConfig>[0]> = {}, opts: { isProd?: boolean; devHmrActive?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svl-live-'));
  fs.mkdirSync(path.join(root, 'dist', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'index.html'), '<script src="/assets/index-A.js"></script>');
  const isProd = opts.isProd ?? true;
  const config = loadLiveRepoSyncConfig(
    { SVL_LIVE_WATCH_DEBOUNCE_MS: '50', SVL_LIVE_REBUILD_DEBOUNCE_MS: '0', SVL_LIVE_RESTART_DELAY_MS: '0', SVL_SUPERVISED: '0', ...over } as any,
    { isProd, aiStudio: false, hasGit: false },
  );
  const frames: any[] = [];
  const resyncs: string[] = [];
  const calls = { python: 0, restart: [] as string[], invalidated: 0, builds: 0 };
  const sync = new LiveRepoSync({
    root,
    config,
    isProd,
    startWatchers: false,
    devHmrActive: opts.devHmrActive,
    publish: (f) => frames.push(f),
    broadcastResync: (r) => resyncs.push(r),
    restartPython: () => { calls.python += 1; },
    restartServer: (r) => calls.restart.push(r),
    invalidateDevModules: () => { calls.invalidated += 1; },
    buildRunner: async (outDir) => {
      calls.builds += 1;
      fs.mkdirSync(path.join(outDir, 'assets'), { recursive: true });
      fs.writeFileSync(path.join(outDir, 'index.html'), `<script src="/assets/index-B${calls.builds}.js"></script>`);
      return { ok: true, output: '' };
    },
  });
  const cleanup = () => { sync.stop(); fs.rmSync(root, { recursive: true, force: true }); };
  return { root, sync, frames, resyncs, calls, cleanup, config };
}

test('loadLiveRepoSyncConfig: rozsądne domyślne wartości i wyłączniki z .env', () => {
  const prod = loadLiveRepoSyncConfig({} as any, { isProd: true, aiStudio: false, hasGit: true });
  assert.equal(prod.enabled, true);
  assert.equal(prod.frontendRebuild, true);
  assert.equal(prod.autoPullSec, 60);
  assert.equal(prod.clientReload, 'auto');
  assert.equal(prod.serverRestart, 'auto');
  const studio = loadLiveRepoSyncConfig({} as any, { isProd: false, aiStudio: true, hasGit: true });
  assert.equal(studio.autoPullSec, 0, 'AI Studio: bez auto-pull (checkpointy „Manual edit”)');
  assert.equal(studio.frontendRebuild, false);
  assert.equal(studio.clientReload, 'prompt');
  const off = loadLiveRepoSyncConfig({ SVL_LIVE_REPO_SYNC: '0', SVL_GITHUB_AUTOPULL_SEC: '0', SVL_LIVE_FRONTEND_REBUILD: 'false' } as any, { isProd: true, aiStudio: false, hasGit: true });
  assert.equal(off.enabled, false);
  assert.equal(off.autoPullSec, 0);
  assert.equal(off.frontendRebuild, false);
  assert.equal(loadLiveRepoSyncConfig({ SVL_GITHUB_AUTOPULL_SEC: '5' } as any, { isProd: true, aiStudio: false, hasGit: true }).autoPullSec, 15, 'minimum 15 s');
});

test('detectSupervisor: systemd / pm2 / jawne SVL_SUPERVISED', () => {
  assert.equal(detectSupervisor({} as any), null);
  assert.equal(detectSupervisor({ INVOCATION_ID: 'abc' } as any), 'systemd');
  assert.equal(detectSupervisor({ INVOCATION_ID: 'abc', TERM: 'xterm-256color' } as any), null, 'terminal pod systemd --user to nie nadzorca');
  assert.equal(detectSupervisor({ pm_id: '0' } as any), 'pm2');
  assert.equal(detectSupervisor({ SVL_SUPERVISED: '1' } as any), 'SVL_SUPERVISED');
  assert.equal(detectSupervisor({ SVL_SUPERVISED: '0', INVOCATION_ID: 'x' } as any), null);
});

test('zmiana plików repo → svl.repo_changed z listą ścieżek (bez przebudowy dla zwykłych plików)', async () => {
  const t = mk();
  try {
    t.sync.notify(['SVL_CoreOS_2/nowy.md', path.join(t.root, 'docs/a.md')], 'czat');
    await sleep(120);
    const f = t.frames.find((x) => x.type === 'svl.repo_changed');
    assert.ok(f);
    assert.deepEqual(f.paths, ['SVL_CoreOS_2/nowy.md', 'docs/a.md']);
    assert.deepEqual(f.sources, ['czat']);
    assert.equal(t.calls.builds, 0);
    assert.equal(t.calls.restart.length, 0);
  } finally {
    t.cleanup();
  }
});

test('ścieżki spoza repozytorium są odrzucane', async () => {
  const t = mk();
  try {
    t.sync.notify(['/etc/passwd', '../x'], 'mcp');
    await sleep(120);
    assert.equal(t.frames.length, 0);
  } finally {
    t.cleanup();
  }
});

test('produkcja: zmiana GUI → przebudowa dist → svl.app_updated z nowym buildId', async () => {
  const t = mk();
  try {
    const before = t.sync.appBuildId();
    t.sync.notify(['src/components/Nowy.tsx'], 'git:panel GitHub');
    await sleep(250);
    const types = t.frames.map((f) => f.type);
    assert.ok(types.includes('svl.app_building'));
    const upd = t.frames.find((f) => f.type === 'svl.app_updated');
    assert.ok(upd, types.join(','));
    assert.equal(upd.mode, 'prod');
    assert.equal(upd.reload, 'auto');
    assert.notEqual(upd.buildId, before);
    assert.equal(t.sync.appBuildId(), upd.buildId);
    assert.match(fs.readFileSync(path.join(t.root, 'dist', 'index.html'), 'utf8'), /index-B1/);
  } finally {
    t.cleanup();
  }
});

test('dev bez HMR: unieważnienie modułów Vite + svl.app_updated (mode=dev); dev z HMR: nic (Vite sam)', async () => {
  const a = mk({}, { isProd: false, devHmrActive: false });
  const b = mk({}, { isProd: false, devHmrActive: true });
  try {
    a.sync.notify(['src/App.tsx'], 'watcher');
    b.sync.notify(['src/App.tsx'], 'watcher');
    await sleep(120);
    assert.equal(a.calls.invalidated, 1);
    assert.equal(a.frames.find((f) => f.type === 'svl.app_updated')?.mode, 'dev');
    assert.equal(b.calls.invalidated, 0);
    assert.equal(b.frames.some((f) => f.type === 'svl.app_updated'), false);
    assert.equal(a.calls.builds + b.calls.builds, 0);
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test('backend/*.py → restart jądra Python i pełne odświeżenie danych', async () => {
  const t = mk();
  try {
    t.sync.notify(['backend/app.py'], 'mcp:edit_file');
    await sleep(500);
    assert.equal(t.calls.python, 1);
    assert.ok(t.frames.some((f) => f.type === 'svl.python_restarting'));
    assert.equal(t.calls.restart.length, 0, 'gateway działa dalej');
  } finally {
    t.cleanup();
  }
});

test('kod serwera bez nadzorcy → svl.restart_required (bez automatycznego restartu)', async () => {
  const t = mk();
  try {
    t.sync.notify(['server.ts'], 'git:auto-pull');
    await sleep(150);
    const rr = t.frames.find((f) => f.type === 'svl.restart_required');
    assert.ok(rr);
    assert.equal(rr.autoRestartInMs, null);
    assert.ok(rr.reasons.some((r: string) => r.includes('server.ts')));
    assert.equal(t.calls.restart.length, 0);
    assert.ok(t.sync.status().restartRequired);
  } finally {
    t.cleanup();
  }
});

test('kod serwera pod nadzorcą (systemd) → automatyczny restart', async () => {
  const t = mk({ SVL_SUPERVISED: '1' });
  try {
    t.sync.notify(['src/server/liveSyncBus.ts'], 'watcher');
    await sleep(200);
    assert.equal(t.frames.find((f) => f.type === 'svl.restart_required')?.autoRestartInMs, 0);
    assert.ok(t.frames.some((f) => f.type === 'svl.restarting'));
    assert.equal(t.calls.restart.length, 1);
  } finally {
    t.cleanup();
  }
});

test('package.json bez auto npm install → restart wymagany z flagą depsChanged; GUI nie jest budowane', async () => {
  const t = mk();
  try {
    t.sync.notify(['package.json', 'src/App.tsx'], 'git:auto-pull');
    await sleep(200);
    const rr = t.frames.find((f) => f.type === 'svl.restart_required');
    assert.equal(rr?.depsChanged, true);
    assert.equal(t.calls.builds, 0);
  } finally {
    t.cleanup();
  }
});

test('auto-pull: wynik zapisany w statusie; brak zmian nie wysyła ramek', async () => {
  const t = mk();
  try {
    (t.sync as any).deps.runAutoPull = async () => ({ ok: true, changed: false, skipped: 'lokalnie 1 własnych commitów' });
    const summary = await t.sync.autoPull();
    assert.match(summary, /własnych commitów/);
    assert.match(String(t.sync.status().autoPull.lastResult), /własnych/);
    assert.equal(t.frames.length, 0);
  } finally {
    t.cleanup();
  }
});

test('wyłączona synchronizacja (SVL_LIVE_REPO_SYNC=0) ignoruje zgłoszenia', async () => {
  const t = mk({ SVL_LIVE_REPO_SYNC: '0' });
  try {
    t.sync.notify(['src/App.tsx'], 'czat');
    await sleep(120);
    assert.equal(t.frames.length, 0);
  } finally {
    t.cleanup();
  }
});
