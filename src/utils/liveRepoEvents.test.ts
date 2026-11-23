import test from 'node:test';
import assert from 'node:assert/strict';
import { decideReload, dispatchLiveRepoFrame, isUserTyping, repoChangeTouches, saveReloadState, takeReloadState } from './liveRepoEvents.ts';

class FakeTarget {
  events: Array<{ type: string; detail: any }> = [];
  dispatchEvent(e: Event) {
    this.events.push({ type: e.type, detail: (e as CustomEvent).detail });
    return true;
  }
}

test('dispatchLiveRepoFrame: ramki repo → zdarzenia okna; hello przekazuje buildId, ale nie jest konsumowane', () => {
  const t = new FakeTarget();
  assert.equal(dispatchLiveRepoFrame({ type: 'svl.repo_changed', paths: ['a'] }, t as any), true);
  assert.equal(dispatchLiveRepoFrame({ type: 'svl.app_updated', buildId: 'b1' }, t as any), true);
  assert.equal(dispatchLiveRepoFrame({ type: 'svl.hello', appBuildId: 'b1' }, t as any), false);
  assert.equal(dispatchLiveRepoFrame({ type: 'svl.event', eventId: 'x' }, t as any), false);
  assert.equal(dispatchLiveRepoFrame(null, t as any), false);
  assert.deepEqual(t.events.map((e) => e.type), ['svl:repo-changed', 'svl:app-updated', 'svl:app-build-id']);
});

test('decideReload: auto przeładowuje, ale czeka gdy użytkownik pisze; prompt/off; ten sam build ignorowany', () => {
  assert.equal(decideReload({ policy: 'auto', newBuildId: 'b2', knownBuildId: 'b1', typing: false }), 'reload');
  assert.equal(decideReload({ policy: 'auto', newBuildId: 'b2', knownBuildId: 'b1', typing: true }), 'wait');
  assert.equal(decideReload({ policy: 'prompt', newBuildId: 'b2', knownBuildId: 'b1', typing: false }), 'prompt');
  assert.equal(decideReload({ policy: 'off', newBuildId: 'b2', knownBuildId: 'b1', typing: false }), 'ignore');
  assert.equal(decideReload({ policy: 'auto', newBuildId: 'b1', knownBuildId: 'b1', typing: false }), 'ignore');
  assert.equal(decideReload({ policy: 'auto', newBuildId: '', knownBuildId: 'b1', typing: false }), 'ignore');
});

test('isUserTyping: niepuste pole tekstowe = pisze', () => {
  const doc = (el: any) => ({ activeElement: el }) as any;
  assert.equal(isUserTyping(doc({ tagName: 'TEXTAREA', value: 'cześć' })), true);
  assert.equal(isUserTyping(doc({ tagName: 'TEXTAREA', value: '  ' })), false);
  assert.equal(isUserTyping(doc({ tagName: 'INPUT', type: 'text', value: 'x' })), true);
  assert.equal(isUserTyping(doc({ tagName: 'INPUT', type: 'checkbox', value: 'on' })), false);
  assert.equal(isUserTyping(doc({ tagName: 'DIV', isContentEditable: true })), true);
  assert.equal(isUserTyping(doc(null)), false);
});

test('repoChangeTouches: filtr prefiksów, ucięta lista = odśwież', () => {
  assert.equal(repoChangeTouches({ paths: ['SVL_CoreOS_2/a.md'] }, ['SVL_CoreOS_2']), true);
  assert.equal(repoChangeTouches({ paths: ['src/App.tsx'] }, ['SVL_CoreOS_2']), false);
  assert.equal(repoChangeTouches({ changedPaths: ['SVL_CoreOS_2/x'] }, ['SVL_CoreOS_2/x']), true);
  assert.equal(repoChangeTouches({ paths: ['src/App.tsx'], totalPaths: 500 }, ['SVL_CoreOS_2']), true);
  assert.equal(repoChangeTouches({ paths: [] }, []), true);
});

test('saveReloadState/takeReloadState: jednorazowy odczyt, przeterminowany stan pomijany', () => {
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) } as any;
  saveReloadState({ activeTab: 'linux', scrollY: 120 }, storage);
  const st = takeReloadState(storage);
  assert.equal(st?.activeTab, 'linux');
  assert.equal(takeReloadState(storage), null);
  storage.setItem('svl:live-reload-state', JSON.stringify({ activeTab: 'x', savedAt: Date.now() - 10 * 60_000 }));
  assert.equal(takeReloadState(storage), null);
});
