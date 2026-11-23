import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FrontendRebuilder, currentBuildId, type BuildRunner } from './frontendRebuilder.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mkRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svl-rebuild-'));
  const dist = path.join(root, 'dist');
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<script src="/assets/index-OLD.js"></script>');
  fs.writeFileSync(path.join(dist, 'assets', 'index-OLD.js'), 'old');
  return { root, dist };
}

function fakeRunner(opts: { fail?: boolean; delayMs?: number; tag?: string } = {}): BuildRunner & { calls: number; maxConcurrent: number } {
  let active = 0;
  const fn: any = async (outDir: string) => {
    fn.calls += 1;
    active += 1;
    fn.maxConcurrent = Math.max(fn.maxConcurrent, active);
    await sleep(opts.delayMs ?? 20);
    active -= 1;
    if (opts.fail) return { ok: false, output: 'error TS1234: zepsuty komponent' };
    const tag = `${opts.tag || 'NEW'}${fn.calls}`;
    fs.mkdirSync(path.join(outDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'index.html'), `<script src="/assets/index-${tag}.js"></script>`);
    fs.writeFileSync(path.join(outDir, 'assets', `index-${tag}.js`), tag);
    return { ok: true, output: 'built' };
  };
  fn.calls = 0;
  fn.maxConcurrent = 0;
  return fn;
}

test('currentBuildId czyta hash głównej paczki z index.html', () => {
  const { root, dist } = mkRoot();
  assert.equal(currentBuildId(dist), 'index-OLD');
  assert.equal(currentBuildId(path.join(root, 'brak')), 'none');
  fs.rmSync(root, { recursive: true, force: true });
});

test('udany build podmienia dist, zachowuje zasoby poprzedniej wersji i zgłasza nowy buildId', async () => {
  const { root, dist } = mkRoot();
  const runner = fakeRunner();
  const built: string[] = [];
  const rb = new FrontendRebuilder({ distDir: dist, runner, debounceMs: 0, onBuilt: (id) => built.push(id) });
  assert.equal(await rb.runNow(), true);
  assert.match(fs.readFileSync(path.join(dist, 'index.html'), 'utf8'), /index-NEW1/);
  assert.ok(fs.existsSync(path.join(dist, 'assets', 'index-NEW1.js')));
  assert.ok(fs.existsSync(path.join(dist, 'assets', 'index-OLD.js')), 'stara paczka dostępna dla otwartych kart');
  assert.ok(!fs.existsSync(`${dist}.__next`) && !fs.existsSync(`${dist}.__prev`));
  assert.equal(built.length, 1);
  assert.equal(rb.status().buildId, built[0]);
  // Drugi build: przenosi tylko jedno pokolenie wstecz (OLD znika, NEW1 zostaje).
  assert.equal(await rb.runNow(), true);
  assert.ok(fs.existsSync(path.join(dist, 'assets', 'index-NEW2.js')));
  assert.ok(fs.existsSync(path.join(dist, 'assets', 'index-NEW1.js')));
  assert.ok(!fs.existsSync(path.join(dist, 'assets', 'index-OLD.js')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('nieudany build zostawia poprzedni dist bez zmian (guard)', async () => {
  const { root, dist } = mkRoot();
  const errors: string[] = [];
  const rb = new FrontendRebuilder({ distDir: dist, runner: fakeRunner({ fail: true }), debounceMs: 0, onFailed: (e) => errors.push(e) });
  assert.equal(await rb.runNow(), false);
  assert.match(fs.readFileSync(path.join(dist, 'index.html'), 'utf8'), /index-OLD/);
  assert.ok(!fs.existsSync(`${dist}.__next`));
  assert.equal(rb.status().state, 'failed');
  assert.match(errors[0], /zepsuty komponent/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('nigdy dwa buildy naraz; zgłoszenia w trakcie budowania = jeden dodatkowy build', async () => {
  const { root, dist } = mkRoot();
  const runner = fakeRunner({ delayMs: 60 });
  const rb = new FrontendRebuilder({ distDir: dist, runner, debounceMs: 10 });
  rb.request('a');
  rb.request('b');
  await sleep(30); // build trwa
  assert.equal(rb.isBuilding, true);
  rb.request('c');
  rb.request('d');
  await sleep(300);
  assert.equal(runner.maxConcurrent, 1);
  assert.equal(runner.calls, 2, 'debounce scala a+b, a c+d dają jeden kolejny build');
  assert.equal(rb.status().state, 'idle');
  fs.rmSync(root, { recursive: true, force: true });
});
