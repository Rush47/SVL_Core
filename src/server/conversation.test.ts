import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTranscript,
  cleanAgentReply,
  consecutiveAiTurns,
  isRepetitive,
  parsePredictedSpeaker,
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

test('transcript is only the conversation — no instructions', () => {
  const transcript = buildTranscript([
    op('Cześć'),
    { role: 'system', sender: 'SVL System', content: 'raport' },
    bielik('Hej'),
    maya('Dzień dobry\nco słychać?'),
  ]);
  assert.equal(transcript, '[Mateusz (Operator)]: Cześć\n[Bielik]: Hej\n[Maya]: Dzień dobry\nco słychać?');
});

test('predicted next speaker is read from the model continuation', () => {
  assert.equal(parsePredictedSpeaker('Maya'), 'Maya');
  assert.equal(parsePredictedSpeaker(' bielik]: hej'), 'Bielik');
  assert.equal(parsePredictedSpeaker('Mateusz (Operator)'), 'operator');
  assert.equal(parsePredictedSpeaker('Operator]'), 'operator');
  assert.equal(parsePredictedSpeaker('Ktoś inny'), null);
  assert.equal(parsePredictedSpeaker(''), null);
});

test('consecutive AI turns are counted since the last operator message', () => {
  assert.equal(consecutiveAiTurns([op('a'), bielik('b'), maya('c')]), 2);
  assert.equal(consecutiveAiTurns([bielik('b'), op('a')]), 0);
  assert.equal(consecutiveAiTurns([]), 0);
});

test('repetition detection ignores case, punctuation and small edits', () => {
  const previous = ['Świetny pomysł, zacznijmy od kopii zapasowej bazy danych.'];
  assert.equal(isRepetitive('świetny pomysł — zacznijmy od kopii zapasowej bazy danych!', previous), true);
  assert.equal(isRepetitive('Proponuję najpierw sprawdzić logi z ostatniej nocy.', previous), false);
  assert.equal(isRepetitive('', previous), true);
});

import { isWebSearchRequest } from './webSearch.ts';

test('reply cleanup strips own name, [System] prefixes and cuts lines written for other speakers', () => {
  assert.equal(cleanAgentReply('Bielik: Jasne, zróbmy to.', 'Bielik'), 'Jasne, zróbmy to.');
  assert.equal(cleanAgentReply('[Maya]: ... Dobrze.', 'Maya'), 'Dobrze.');
  assert.equal(cleanAgentReply('[Bielik]: Potwierdzam.', 'Maya'), 'Potwierdzam.');
  assert.equal(cleanAgentReply('[System]: Cześć, Mateuszu!', 'Maya'), 'Cześć, Mateuszu!');
  assert.equal(cleanAgentReply('[Mateusz (Operator)]: Cześć!', 'Maya'), 'Cześć!');
  assert.equal(cleanAgentReply('[Maya (AI Statku SVL-364)]: Systemy sprawne.', 'Maya'), 'Systemy sprawne.');
  assert.equal(cleanAgentReply('Myślę, że warto.\n[Maya]: Zgadzam się!\nMateusz: OK', 'Bielik'), 'Myślę, że warto.');
  assert.equal(cleanAgentReply('Pierwsze zdanie.\n\nMateusz Mitek (Operator): dopisek', 'Maya'), 'Pierwsze zdanie.');
  assert.equal(cleanAgentReply('Drugie zdanie.\n[System]: uwaga', 'Bielik'), 'Drugie zdanie.');
});

test('transcript skips stored outage error notices from assistant turns', () => {
  const transcript = buildTranscript([
    op('Hej'),
    { role: 'assistant', sender: 'Maya', content: '⚠️ Maya nie może teraz odpowiedzieć: żaden model AI nie odpowiedział.' },
    maya('Jestem gotowa!'),
  ]);
  assert.equal(transcript, '[Mateusz (Operator)]: Hej\n[Maya]: Jestem gotowa!');
});

test('web search trigger ignores casual Polish words teraz, dzisiaj, wiadomość', () => {
  assert.equal(isWebSearchRequest('Cześć wszystkim! O czym dzisiaj porozmawiamy?'), false);
  assert.equal(isWebSearchRequest('Już teraz tworzymy historie'), false);
  assert.equal(isWebSearchRequest('Wyślij krótką wiadomość do Maya'), false);
  assert.equal(isWebSearchRequest('Wyszukaj w internecie najnowsze wiadomości ze świata'), true);
});
