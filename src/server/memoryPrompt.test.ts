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
    'System_SI_1',
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
      participants: ['System_SI_1'],
      isAutonomous: true,
      consecutiveAi: 0,
      hasTurns: false,
      explicitTarget: 'System_SI_1',
    }),
    { speaker: 'System_SI_1' },
  );

  // Empty channel with Auto target picks first participant
  assert.deepEqual(
    selectNextFreeSpeaker({
      predicted: null,
      participants: ['System_SI_1'],
      isAutonomous: false,
      consecutiveAi: 0,
      hasTurns: false,
      explicitTarget: null,
    }),
    { speaker: 'System_SI_1' },
  );

  // Manual click never stalls with waiting_for_operator in single-agent chat
  assert.deepEqual(
    selectNextFreeSpeaker({
      predicted: 'operator',
      participants: ['System_SI_1'],
      lastTurnRole: 'assistant',
      lastAiSpeaker: 'System_SI_1',
      isAutonomous: false,
      consecutiveAi: 1,
      hasTurns: true,
      explicitTarget: 'System_SI_1',
    }),
    { speaker: 'System_SI_1' },
  );

  // Autonomous mode waits for operator after consecutive AI turns
  assert.deepEqual(
    selectNextFreeSpeaker({
      predicted: 'operator',
      participants: ['System_SI_1'],
      lastTurnRole: 'assistant',
      lastAiSpeaker: 'System_SI_1',
      isAutonomous: true,
      consecutiveAi: 2,
      hasTurns: true,
      explicitTarget: null,
    }),
    { speaker: null, skipReason: 'waiting_for_operator' },
  );
});

test('buildProactiveStarterPrompt generates Polish initiation prompt with optional memory hint', () => {
  const withoutMem = buildProactiveStarterPrompt('System_SI_1', 'Mateusz', '');
  assert.match(withoutMem, /System_SI_1/);
  assert.match(withoutMem, /Mateusz/);
  assert.doesNotMatch(withoutMem, /trwałej pamięci/);

  const withMem = buildProactiveStarterPrompt('System_SI_1', 'Mateusz', 'fakty');
  assert.match(withMem, /trwałej pamięci/);
});
