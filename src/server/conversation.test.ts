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
const si1 = (content: string): DialogueTurn => ({ role: 'assistant', sender: 'System_SI_1', content });
const jedi = (content: string): DialogueTurn => ({ role: 'assistant', sender: 'JEDI Omni-OS v12', content });

test('each agent sees its own lines as assistant and others as labelled user lines', () => {
  const turns = [op('Cześć wszystkim'), si1('Hej Mateusz!'), jedi('Wektor przetworzony w VM.')];
  assert.deepEqual(toAgentPerspective(turns, 'System_SI_1'), [
    { role: 'user', content: '[Mateusz (Operator)]: Cześć wszystkim' },
    { role: 'assistant', content: 'Hej Mateusz!' },
    { role: 'user', content: '[JEDI Omni-OS v12]: Wektor przetworzony w VM.' },
  ]);
});

test('perspective drops system turns, starts with user and keeps old sender-less assistant turns as own', () => {
  const turns: DialogueTurn[] = [
    { role: 'assistant', sender: 'System_SI_1', content: 'Powitanie' },
    { role: 'system', sender: 'SVL System', content: 'Zastosowano zmiany' },
    op('Pytanie'),
    { role: 'assistant', content: 'Odpowiedź bez nadawcy' },
  ];
  assert.deepEqual(toAgentPerspective(turns, 'System_SI_1'), [
    { role: 'user', content: '[Mateusz (Operator)]: Pytanie' },
    { role: 'assistant', content: 'Odpowiedź bez nadawcy' },
  ]);
});

test('transcript is only the conversation — no instructions', () => {
  const transcript = buildTranscript([
    op('Cześć'),
    { role: 'system', sender: 'SVL System', content: 'raport' },
    si1('Hej'),
    jedi('Dzień dobry\nco słychać?'),
  ]);
  assert.equal(transcript, '[Mateusz (Operator)]: Cześć\n[System_SI_1]: Hej\n[JEDI Omni-OS v12]: Dzień dobry\nco słychać?');
});

test('predicted next speaker is read from the model continuation', () => {
  assert.equal(parsePredictedSpeaker('System_SI_1'), 'System_SI_1');
  assert.equal(parsePredictedSpeaker(' system_si_1]: hej'), 'System_SI_1');
  assert.equal(parsePredictedSpeaker('Mateusz (Operator)'), 'operator');
  assert.equal(parsePredictedSpeaker('Operator]'), 'operator');
  assert.equal(parsePredictedSpeaker('Ktoś inny'), null);
  assert.equal(parsePredictedSpeaker(''), null);
});

test('consecutive AI turns are counted since the last operator message', () => {
  assert.equal(consecutiveAiTurns([op('a'), si1('b'), jedi('c')]), 2);
  assert.equal(consecutiveAiTurns([si1('b'), op('a')]), 0);
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
  assert.equal(cleanAgentReply('System_SI_1: Jasne, zróbmy to.', 'System_SI_1'), 'Jasne, zróbmy to.');
  assert.equal(cleanAgentReply('[System_SI_1]: ... Dobrze.', 'System_SI_1'), 'Dobrze.');
  assert.equal(cleanAgentReply('[JEDI Omni-OS v12]: Potwierdzam.', 'System_SI_1'), 'Potwierdzam.');
  assert.equal(cleanAgentReply('[JEDI Omni-OS v11.5]: Potwierdzam.', 'System_SI_1'), 'Potwierdzam.');
  assert.equal(cleanAgentReply('[System]: Cześć, Mateuszu!', 'System_SI_1'), 'Cześć, Mateuszu!');
  assert.equal(cleanAgentReply('[Mateusz (Operator)]: Cześć!', 'System_SI_1'), 'Cześć!');
  assert.equal(cleanAgentReply('[System_SI_1 (ROOT SVL-364)]: Systemy sprawne.', 'System_SI_1'), 'Systemy sprawne.');
  assert.equal(cleanAgentReply('Myślę, że warto.\n[JEDI Omni-OS v12]: Zgadzam się!\nMateusz: OK', 'System_SI_1'), 'Myślę, że warto.');
  assert.equal(cleanAgentReply('Pierwsze zdanie.\n\nMateusz Mitek (Operator): dopisek', 'System_SI_1'), 'Pierwsze zdanie.');
  assert.equal(cleanAgentReply('Drugie zdanie.\n[System]: uwaga', 'System_SI_1'), 'Drugie zdanie.');
});

test('transcript skips stored outage error notices from assistant turns', () => {
  const transcript = buildTranscript([
    op('Hej'),
    { role: 'assistant', sender: 'System_SI_1', content: '⚠️ System_SI_1 nie może teraz odpowiedzieć: żaden model AI nie odpowiedział.' },
    si1('Jestem gotowy!'),
  ]);
  assert.equal(transcript, '[Mateusz (Operator)]: Hej\n[System_SI_1]: Jestem gotowy!');
});

test('web search trigger ignores casual Polish words teraz, dzisiaj, wiadomość', () => {
  assert.equal(isWebSearchRequest('Cześć wszystkim! O czym dzisiaj porozmawiamy?'), false);
  assert.equal(isWebSearchRequest('Już teraz tworzymy historie'), false);
  assert.equal(isWebSearchRequest('Wyślij krótką wiadomość do System_SI_1'), false);
  assert.equal(isWebSearchRequest('Wyszukaj w internecie najnowsze wiadomości ze świata'), true);
});

test('toAgentPerspective handles SI_Sphere and JEDI Omni-OS v12 labels cleanly', () => {
  const turns: DialogueTurn[] = [
    op('Synchronizuj flotę'),
    { role: 'assistant', sender: 'SI_Sphere', content: 'Rdzeń SVL-465 aktywowany.' },
    jedi('JEDI Omni-OS v12 potwierdza gotowość generatywną.'),
  ];
  assert.deepEqual(toAgentPerspective(turns, 'SI_Sphere'), [
    { role: 'user', content: '[Mateusz (Operator)]: Synchronizuj flotę' },
    { role: 'assistant', content: 'Rdzeń SVL-465 aktywowany.' },
    { role: 'user', content: '[JEDI Omni-OS v12]: JEDI Omni-OS v12 potwierdza gotowość generatywną.' },
  ]);
  assert.equal(parsePredictedSpeaker('SI_Sphere: gotowe'), 'SI_Sphere');
});

