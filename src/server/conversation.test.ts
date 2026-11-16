import assert from 'node:assert/strict';
import test from 'node:test';
import {
  autonomousPauseReason,
  buildPersonaInstruction,
  chooseNextSpeaker,
  cleanAgentReply,
  isRepetitive,
  toAgentPerspective,
  type DialogueTurn,
} from './conversation.ts';

const op = (content: string): DialogueTurn => ({ role: 'user', sender: 'Mateusz Mitek (Operator)', content });
const bielik = (content: string): DialogueTurn => ({ role: 'assistant', sender: 'Bielik', content });
const maya = (content: string): DialogueTurn => ({ role: 'assistant', sender: 'Maya', content });

test('each agent sees its own lines as assistant and others as labelled user lines', () => {
  const turns = [op('Cześć wszystkim'), bielik('Hej Mateusz!'), maya('Witaj, co dziś robimy?')];
  assert.deepEqual(toAgentPerspective(turns, 'Bielik'), [
    { role: 'user', content: '[Mateusz (Operator)]: Cześć wszystkim' },
    { role: 'assistant', content: 'Hej Mateusz!' },
    { role: 'user', content: '[Maya]: Witaj, co dziś robimy?' },
  ]);
  assert.deepEqual(toAgentPerspective(turns, 'Maya'), [
    { role: 'user', content: '[Mateusz (Operator)]: Cześć wszystkim\n\n[Bielik]: Hej Mateusz!' },
    { role: 'assistant', content: 'Witaj, co dziś robimy?' },
  ]);
});

test('perspective drops system turns, starts with user and keeps old sender-less assistant turns as own', () => {
  const turns: DialogueTurn[] = [
    { role: 'assistant', sender: 'Bielik', content: 'Powitanie' },
    { role: 'system', sender: 'SVL System', content: 'Zastosowano zmiany' },
    op('Pytanie'),
    { role: 'assistant', content: 'Odpowiedź bez nadawcy' },
  ];
  assert.deepEqual(toAgentPerspective(turns, 'Bielik'), [
    { role: 'user', content: '[Mateusz (Operator)]: Pytanie' },
    { role: 'assistant', content: 'Odpowiedź bez nadawcy' },
  ]);
});

test('next speaker: bound channel, alternation, operator addressing', () => {
  assert.equal(chooseNextSpeaker([op('hej'), maya('cześć')], 'Bielik'), 'Bielik');
  assert.equal(chooseNextSpeaker([op('hej'), bielik('cześć')]), 'Maya');
  assert.equal(chooseNextSpeaker([op('hej'), maya('cześć')]), 'Bielik');
  assert.equal(chooseNextSpeaker([op('Maya, co o tym sądzisz?')]), 'Maya');
  assert.equal(chooseNextSpeaker([bielik('a'), maya('b'), op('i co dalej?')]), 'Bielik');
  assert.equal(chooseNextSpeaker([]), 'Bielik');
});

test('autonomous turns pause after the AI limit or when the operator was asked a question', () => {
  assert.equal(autonomousPauseReason([op('hej'), bielik('a'), maya('b')], 4), null);
  assert.equal(
    autonomousPauseReason([op('hej'), bielik('a'), maya('b'), bielik('c'), maya('d')], 4),
    'ai_turn_limit',
  );
  assert.equal(autonomousPauseReason([op('hej'), bielik('Mateusz, który wariant wybierasz?')], 4), 'question_to_operator');
  assert.equal(autonomousPauseReason([op('hej'), bielik('Maya, a Ty jak uważasz?')], 4), null);
  assert.equal(autonomousPauseReason([], 4), 'no_conversation');
});

test('repetition detection ignores case, punctuation and small edits', () => {
  const previous = ['Świetny pomysł, zacznijmy od kopii zapasowej bazy danych.'];
  assert.equal(isRepetitive('świetny pomysł — zacznijmy od kopii zapasowej bazy danych!', previous), true);
  assert.equal(isRepetitive('Proponuję najpierw sprawdzić logi z ostatniej nocy.', previous), false);
  assert.equal(isRepetitive('', previous), true);
});

test('reply cleanup strips own name prefix and cuts lines written for other speakers', () => {
  assert.equal(cleanAgentReply('Bielik: Jasne, zróbmy to.', 'Bielik'), 'Jasne, zróbmy to.');
  assert.equal(cleanAgentReply('[Maya]: ... Dobrze.', 'Maya'), 'Dobrze.');
  assert.equal(
    cleanAgentReply('Myślę, że warto.\n[Maya]: Zgadzam się!\nMateusz: OK', 'Bielik'),
    'Myślę, że warto.',
  );
  assert.equal(cleanAgentReply('Pierwsze zdanie.\n\nMateusz Mitek (Operator): dopisek', 'Maya'), 'Pierwsze zdanie.');
});

test('persona instruction names the other participants and includes memories', () => {
  const text = buildPersonaInstruction({
    speaker: 'Maya',
    channelTitle: 'Rodzina Mitek (wszyscy)',
    otherAgents: ['Bielik'],
    memories: ['[FACT] Operator lubi kawę'],
  });
  assert.match(text, /Jesteś Maya/);
  assert.match(text, /z Bielikiem \(druga AI\)/);
  assert.match(text, /Operator lubi kawę/);
  assert.match(text, /\[Imię\]:/);
  assert.doesNotMatch(text, /ROOT|LOCK-REAL-ONLY/);
});

test('configured persona is used once, as role description, below the conversation rules', () => {
  const text = buildPersonaInstruction({
    speaker: 'Maya',
    channelTitle: 'Kanał',
    otherAgents: [],
    customPrompt: 'Jesteś Maya — AI statku. Wysyłasz powiadomienia telemetryczne i wykonujesz polecenia ROOT.',
  });
  assert.equal(text.match(/Jesteś Maya/g)?.length, 1);
  assert.match(text, /Opis Twojej roli/);
  assert.match(text, /nie wysyłasz raportów ani telemetrii/);
});
