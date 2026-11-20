import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countTotalConversationMessages,
  evaluateChatSnapshotAcceptance,
  shouldPreserveLocalConversationsOnEmptyServer,
  shouldSkipResyncEcho,
} from './syncGuards';

test('evaluateChatSnapshotAcceptance force-applies on global sync and resets stale revision', () => {
  const res = evaluateChatSnapshotAcceptance({
    responseServerRevision: 12,
    appliedChatServerRevision: 95,
    requestEpoch: 1,
    currentEpoch: 2,
    forceApply: true,
  });
  assert.equal(res.accept, true);
  assert.equal(res.resetAppliedRevision, true);
});

test('evaluateChatSnapshotAcceptance realigns after backend revision drop instead of dropping forever', () => {
  const largeDrop = evaluateChatSnapshotAcceptance({
    responseServerRevision: 3,
    appliedChatServerRevision: 77,
    requestEpoch: 5,
    currentEpoch: 5,
    forceApply: false,
  });
  assert.equal(largeDrop.accept, true);
  assert.equal(largeDrop.resetAppliedRevision, true);

  const singleLag = evaluateChatSnapshotAcceptance({
    responseServerRevision: 76,
    appliedChatServerRevision: 77,
    requestEpoch: 5,
    currentEpoch: 5,
    forceApply: false,
  });
  assert.equal(singleLag.accept, false);
});

test('shouldSkipResyncEcho ignores echoes from the same tab origin', () => {
  assert.equal(shouldSkipResyncEcho('tab-abc123', 'tab-abc123'), true);
  assert.equal(shouldSkipResyncEcho('tab-other', 'tab-abc123'), false);
  assert.equal(shouldSkipResyncEcho(undefined, 'tab-abc123'), false);
});

test('shouldPreserveLocalConversationsOnEmptyServer protects non-empty UI unless explicitly cleared', () => {
  const emptyServer = [{ messages: [] }];
  const populatedLocal = [{ messages: [{ id: 'm1' }, { id: 'm2' }] }];
  assert.equal(countTotalConversationMessages(populatedLocal), 2);
  assert.equal(shouldPreserveLocalConversationsOnEmptyServer(emptyServer, populatedLocal, false), true);
  assert.equal(shouldPreserveLocalConversationsOnEmptyServer(emptyServer, populatedLocal, true), false);
  assert.equal(shouldPreserveLocalConversationsOnEmptyServer(populatedLocal, populatedLocal, false), false);
});
