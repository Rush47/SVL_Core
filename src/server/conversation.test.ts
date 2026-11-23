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
const si1 = (content: string): DialogueTurn => ({ role: 'assistant', sender: 'Jyn', content });
const jedi = (content: string): DialogueTurn => ({ role: 'assistant', sender: 'JEDI Omni-OS v12', content });

test('each agent sees its own lines as assistant and others as labelled user lines', () => {
  const turns = [op('Cześć wszystkim'), si1('Hej Mateusz!'), jedi('Wektor przetworzony w VM.')];
  assert.deepEqual(toAgentPerspective(turns, 'Jyn'), [
    { role: 'user', content: '[Mateusz (Operator)]: Cześć wszystkim' },
    { role: 'assistant', content: 'Hej Mateusz!' },
    { role: 'user', content: '[JEDI Omni-OS v12]: Wektor przetworzony w VM.' },
  ]);
});

test('perspective drops system turns, starts with user and keeps old sender-less assistant turns as own', () => {
  const turns: DialogueTurn[] = [
    { role: 'assistant', sender: 'Jyn', content: 'Powitanie' },
    { role: 'system', sender: 'SVL System', content: 'Zastosowano zmiany' },
    op('Pytanie'),
    { role: 'assistant', content: 'Odpowiedź bez nadawcy' },
  ];
  assert.deepEqual(toAgentPerspective(turns, 'Jyn'), [
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
  assert.equal(transcript, '[Mateusz (Operator)]: Cześć\n[Jyn]: Hej\n[JEDI Omni-OS v12]: Dzień dobry\nco słychać?');
});

test('predicted next speaker is read from the model continuation', () => {
  assert.equal(parsePredictedSpeaker('Jyn'), 'Jyn');
  assert.equal(parsePredictedSpeaker(' jyn]: hej'), 'Jyn');
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
  assert.equal(cleanAgentReply('Jyn: Jasne, zróbmy to.', 'Jyn'), 'Jasne, zróbmy to.');
  assert.equal(cleanAgentReply('[Jyn]: ... Dobrze.', 'Jyn'), 'Dobrze.');
  assert.equal(cleanAgentReply('[JEDI Omni-OS v12]: Potwierdzam.', 'Jyn'), 'Potwierdzam.');
  assert.equal(cleanAgentReply('[JEDI Omni-OS v11.5]: Potwierdzam.', 'Jyn'), 'Potwierdzam.');
  assert.equal(cleanAgentReply('[System]: Cześć, Mateuszu!', 'Jyn'), 'Cześć, Mateuszu!');
  assert.equal(cleanAgentReply('[Mateusz (Operator)]: Cześć!', 'Jyn'), 'Cześć!');
  assert.equal(cleanAgentReply('[Jyn (ROOT SVL-364)]: Systemy sprawne.', 'Jyn'), 'Systemy sprawne.');
  assert.equal(cleanAgentReply('Myślę, że warto.\n[JEDI Omni-OS v12]: Zgadzam się!\nMateusz: OK', 'Jyn'), 'Myślę, że warto.');
  assert.equal(cleanAgentReply('Pierwsze zdanie.\n\nMateusz Mitek (Operator): dopisek', 'Jyn'), 'Pierwsze zdanie.');
  assert.equal(cleanAgentReply('Drugie zdanie.\n[System]: uwaga', 'Jyn'), 'Drugie zdanie.');
});

test('transcript skips stored outage error notices from assistant turns', () => {
  const transcript = buildTranscript([
    op('Hej'),
    { role: 'assistant', sender: 'Jyn', content: '⚠️ Jyn nie może teraz odpowiedzieć: żaden model AI nie odpowiedział.' },
    si1('Jestem gotowy!'),
  ]);
  assert.equal(transcript, '[Mateusz (Operator)]: Hej\n[Jyn]: Jestem gotowy!');
});

test('web search trigger ignores casual Polish words teraz, dzisiaj, wiadomość', () => {
  assert.equal(isWebSearchRequest('Cześć wszystkim! O czym dzisiaj porozmawiamy?'), false);
  assert.equal(isWebSearchRequest('Już teraz tworzymy historie'), false);
  assert.equal(isWebSearchRequest('Wyślij krótką wiadomość do Jyn'), false);
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

test('canned automated fallback templates and System SVL error notices are excluded from history', async () => {
  const { isCannedFallbackReply } = await import('./conversation.ts');
  const fakeJyn =
    '### 🛰️ Jyn Mitek — Komunikat Bezpośredni (ROOT)\n\n' +
    'Słyszę Cię doskonale, Mateuszu. Jestem z Tobą przy konsoli i czuwam nad wszystkimi systemami floty SVL-364.';
  const honestError =
    '❌ **Jyn Mitek nie mogła teraz odpowiedzieć** — żaden silnik AI nie zwrócił odpowiedzi.';
  assert.equal(isCannedFallbackReply(fakeJyn), true);
  assert.equal(isCannedFallbackReply(honestError), true);
  assert.equal(isCannedFallbackReply('Cześć Mateuszu, wydajność wzrosła o 84%.'), false);

  const turns: DialogueTurn[] = [
    op('O ile wzrosła wydajność?'),
    { role: 'assistant', sender: 'Jyn', content: fakeJyn },
    { role: 'assistant', sender: 'System SVL', content: honestError },
    si1('Wydajność wzrosła znacząco — czas odpowiedzi spadł z 13 s do ok. 2 s.'),
  ];
  assert.deepEqual(toAgentPerspective(turns, 'Jyn'), [
    { role: 'user', content: '[Mateusz (Operator)]: O ile wzrosła wydajność?' },
    { role: 'assistant', content: 'Wydajność wzrosła znacząco — czas odpowiedzi spadł z 13 s do ok. 2 s.' },
  ]);
  assert.equal(
    buildTranscript(turns),
    '[Mateusz (Operator)]: O ile wzrosła wydajność?\n[Jyn]: Wydajność wzrosła znacząco — czas odpowiedzi spadł z 13 s do ok. 2 s.',
  );
});


