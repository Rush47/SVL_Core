import assert from 'node:assert/strict';
import test from 'node:test';
import { LiveSyncBus, formatSseFrame, sseKeepAlive } from './liveSyncBus.ts';
import { createSseParser } from '../utils/sseStream.ts';

test('LiveSyncBus dostarcza ramkę wszystkim odbiorcom i pozwala się wypisać', () => {
  const bus = new LiveSyncBus();
  const a: string[] = [];
  const b: string[] = [];
  const offA = bus.subscribe((f) => a.push(f));
  bus.subscribe((f) => b.push(f));
  assert.equal(bus.size, 2);
  assert.equal(bus.publish('{"x":1}'), 2);
  offA();
  assert.equal(bus.size, 1);
  assert.equal(bus.publish('{"x":2}'), 1);
  assert.deepEqual(a, ['{"x":1}']);
  assert.deepEqual(b, ['{"x":1}', '{"x":2}']);
});

test('LiveSyncBus usuwa odbiorcę, który rzuca wyjątek, i nie blokuje pozostałych', () => {
  const bus = new LiveSyncBus();
  const got: string[] = [];
  bus.subscribe(() => {
    throw new Error('zamknięte połączenie');
  });
  bus.subscribe((f) => got.push(f));
  assert.equal(bus.publish('f1'), 1);
  assert.equal(bus.size, 1);
  assert.deepEqual(got, ['f1']);
});

test('formatSseFrame + createSseParser: ramki przechodzą w kawałkach i z wieloma liniami', () => {
  const frames = [
    JSON.stringify({ type: 'svl.resync_required', reason: 'chat_directive_applied', serverRevision: 9 }),
    '{"a":1,\n"b":"ąę"}',
  ];
  const wire = 'retry: 3000\n\n' + sseKeepAlive() + formatSseFrame(frames[0], 7) + formatSseFrame(frames[1]);
  const parser = createSseParser();
  const out: string[] = [];
  for (let i = 0; i < wire.length; i += 5) out.push(...parser.push(wire.slice(i, i + 5)));
  assert.deepEqual(out, frames);
  assert.deepEqual(JSON.parse(out[1]), { a: 1, b: 'ąę' });
});

test('createSseParser obsługuje końce linii CRLF', () => {
  const parser = createSseParser();
  assert.deepEqual(parser.push('data: {"ok":true}\r\n\r\n'), ['{"ok":true}']);
});
