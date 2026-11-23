import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_WINDOW_STEP,
  DEFAULT_CHAT_WINDOW_SIZE,
  computeComposerTextareaHeight,
  computeMessageWindow,
  nextMessageWindowLimit,
  shouldSubmitChatShortcut,
} from './chatViewport';

test('computeMessageWindow returns all messages when below limit', () => {
  assert.deepEqual(computeMessageWindow(0, 60), { startIndex: 0, hiddenCount: 0, hasMore: false });
  assert.deepEqual(computeMessageWindow(45, 60), { startIndex: 0, hiddenCount: 0, hasMore: false });
  assert.deepEqual(computeMessageWindow(60, 60), { startIndex: 0, hiddenCount: 0, hasMore: false });
});

test('computeMessageWindow slices only tail for large threads (e.g. 583 messages)', () => {
  assert.deepEqual(computeMessageWindow(583, DEFAULT_CHAT_WINDOW_SIZE), {
    startIndex: 523,
    hiddenCount: 523,
    hasMore: true,
  });
});

test('nextMessageWindowLimit increments cleanly and caps at totalCount', () => {
  assert.equal(nextMessageWindowLimit(60, 583, CHAT_WINDOW_STEP), 140);
  assert.equal(nextMessageWindowLimit(520, 583, CHAT_WINDOW_STEP), 583);
});

test('computeComposerTextareaHeight clamps to min/max bounds and toggles scroll', () => {
  assert.deepEqual(computeComposerTextareaHeight(28, 44, 148), { heightPx: 44, overflowY: 'hidden' });
  assert.deepEqual(computeComposerTextareaHeight(88, 44, 148), { heightPx: 88, overflowY: 'hidden' });
  assert.deepEqual(computeComposerTextareaHeight(240, 44, 148), { heightPx: 148, overflowY: 'auto' });
});

test('shouldSubmitChatShortcut submits on plain Enter only', () => {
  assert.equal(shouldSubmitChatShortcut({ key: 'Enter' }), true);
  assert.equal(shouldSubmitChatShortcut({ key: 'Enter', shiftKey: true }), false);
  assert.equal(shouldSubmitChatShortcut({ key: 'Enter', isComposing: true }), false);
  assert.equal(shouldSubmitChatShortcut({ key: 'Enter', ctrlKey: true }), false);
  assert.equal(shouldSubmitChatShortcut({ key: 'a' }), false);
});
