import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildProactiveStarterPrompt,
  formatMemoryPromptContext,
  selectNextFreeSpeaker,
} from './memoryPrompt.ts';

test('formatMemoryPromptContext prioritizes structured memories and filters errors/duplicates', () => {
  const ctx = formatMemoryPromptContext(
    [
      { kind: 'episode', content: 'Swobodna rozmowa: hej' },
      { kind: 'fact', content: 'Operator mieszka w Gdańsku' },
      { kind: 'fact', content: 'Operator mieszka w Gdańsku.' },
      { kind: 'fact', content: '⚠️ Błąd połączenia' },
      { kind: 'decision', content: 'Używamy SQLite WAL jako źródła prawdy' },
    ],
    'Jyn',
    10,
  );
  assert.match(ctx, /\[DECYZJA\] Używamy SQLite WAL/);
  assert.match(ctx, /\[FAKT\] Operator mieszka w Gdańsku/);
  assert.doesNotMatch(ctx, /⚠️ Błąd połączenia/);
  const decIdx = ctx.indexOf('[DECYZJA]');
  const factIdx = ctx.indexOf('[FAKT]');
  const epIdx = ctx.indexOf('[ROZMOWA]');
  assert.ok(decIdx >= 0 && factIdx > decIdx && epIdx > factIdx);
  // Deduplicated despite trailing dot
  assert.equal(ctx.match(/Operator mieszka w Gdańsku/g)?.length, 1);
});

test('selectNextFreeSpeaker initiates on empty channels and respects manual trigger', () => {
  // Empty channel -> AI initiates with explicit target or first participant
  assert.deepEqual(
    selectNextFreeSpeaker({
      predicted: null,
      participants: ['Jyn'],
      isAutonomous: true,
      consecutiveAi: 0,
      hasTurns: false,
      explicitTarget: 'Jyn',
    }),
    { speaker: 'Jyn' },
  );

  // Empty channel with Auto target picks first participant
  assert.deepEqual(
    selectNextFreeSpeaker({
      predicted: null,
      participants: ['Jyn'],
      isAutonomous: false,
      consecutiveAi: 0,
      hasTurns: false,
      explicitTarget: null,
    }),
    { speaker: 'Jyn' },
  );

  // Manual click never stalls with waiting_for_operator in single-agent chat
  assert.deepEqual(
    selectNextFreeSpeaker({
      predicted: 'operator',
      participants: ['Jyn'],
      lastTurnRole: 'assistant',
      lastAiSpeaker: 'Jyn',
      isAutonomous: false,
      consecutiveAi: 1,
      hasTurns: true,
      explicitTarget: 'Jyn',
    }),
    { speaker: 'Jyn' },
  );

  // Autonomous mode waits for operator after consecutive AI turns
  assert.deepEqual(
    selectNextFreeSpeaker({
      predicted: 'operator',
      participants: ['Jyn'],
      lastTurnRole: 'assistant',
      lastAiSpeaker: 'Jyn',
      isAutonomous: true,
      consecutiveAi: 2,
      hasTurns: true,
      explicitTarget: null,
    }),
    { speaker: null, skipReason: 'waiting_for_operator' },
  );
});

test('buildProactiveStarterPrompt generates Polish initiation prompt with optional memory hint', () => {
  const withoutMem = buildProactiveStarterPrompt('Jyn', 'Mateusz', '');
  assert.match(withoutMem, /Jyn/);
  assert.match(withoutMem, /Mateusz/);
  assert.doesNotMatch(withoutMem, /trwałej pamięci/);

  const withMem = buildProactiveStarterPrompt('Jyn', 'Mateusz', 'fakty');
  assert.match(withMem, /trwałej pamięci/);
});
