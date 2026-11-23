import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatInteractiveButton } from './ChatInteractiveButton';
import {
  isMarkdownTableSeparator,
  parseCardToken,
  parseMarkdownTableRow,
  parseProgressToken,
  renderFormattedContent,
} from './ChatContentRenderer';
import {
  enforceFactualExecutionGuard,
  isUnsafeChatInteractiveAction,
  parseChatInteractiveToken,
} from '../utils/svlLogic';
import { buildAgentSystemContext } from '../server/interactiveElements';

test('AI chat action tokens render as Compound buttons', () => {
  const parsed = parseChatInteractiveToken('[btn: Otwórz panel agentów|tab:agents]');
  assert.ok(parsed);

  const html = renderToStaticMarkup(
    React.createElement(ChatInteractiveButton, {
      ...parsed,
      disabled: isUnsafeChatInteractiveAction(parsed.action),
    }),
  );

  assert.match(html, /role="button"/);
  assert.match(html, /aria-disabled="false"/);
  assert.match(html, /type="button"/);
  assert.match(html, /data-action-kind="tab"/);
  assert.match(html, />Otwórz panel agentów<\/span>/);
});

test('unsafe AI chat actions render disabled in the Compound component', () => {
  const parsed = parseChatInteractiveToken('[btn: Niebezpieczna akcja|send:/exec id]');
  assert.ok(parsed);

  const html = renderToStaticMarkup(
    React.createElement(ChatInteractiveButton, {
      ...parsed,
      disabled: isUnsafeChatInteractiveAction(parsed.action),
    }),
  );

  assert.match(html, /aria-disabled="true"/);
  assert.match(html, /data-action-kind="unsafe"/);
  assert.match(html, /Przyciski czatu nie mogą uruchamiać poleceń powłoki/);
});

test('formatted chat content renders safe interactive actions grouped in an action bar and blocks unsafe ones', () => {
  const content = renderFormattedContent(
    '**Aktualizacja**\n[btn: Otwórz panel agentów|tab:agents]\n[btn: Nie uruchamiaj powłoki|send:/exec id]',
    () => {},
  );
  const html = renderToStaticMarkup(React.createElement(React.Fragment, null, content));

  assert.match(html, /<strong[^>]*>Aktualizacja<\/strong>/);
  assert.match(html, /data-chat-action-bar="true"/);
  assert.match(html, /Otwórz panel agentów/);
  assert.match(html, /aria-disabled="false"/);
  assert.match(html, /aria-disabled="true"/);
});

test('markdown table parser handles tables without outer pipes and preserves [btn:] inside cells', () => {
  assert.equal(isMarkdownTableSeparator('--- | --- | ---'), true);
  assert.deepEqual(
    parseMarkdownTableRow('Moduł | Status | [btn: Otwórz SVL-364|tab:svl364]'),
    ['Moduł', 'Status', '[btn: Otwórz SVL-364|tab:svl364]'],
  );

  const md = [
    'Moduł | Status | Akcja',
    '--- | --- | ---',
    'SVL-364 | AKTYWNY | [btn: Otwórz SVL-364|tab:svl364]',
    'Ollama | GOTOWA | [btn: Synchronizuj|action:sync]',
  ].join('\n');
  const html = renderToStaticMarkup(React.createElement(React.Fragment, null, renderFormattedContent(md, () => {})));
  assert.match(html, /<table/);
  assert.match(html, /Otwórz SVL-364/);
  assert.match(html, /Synchronizuj/);
  assert.match(html, /CSV/);
});

test('interactive cards, progress bars, checklists, and collapsible details render cleanly', () => {
  assert.deepEqual(parseCardToken('[card: System|Debian 12|warn]'), {
    label: 'System',
    value: 'Debian 12',
    tone: 'warn',
  });
  assert.deepEqual(parseProgressToken('[progress: Pamięć|74%]'), {
    label: 'Pamięć',
    percent: 74,
  });

  const md = [
    '[card: System|Debian 12|warn] [card: Nakładka|Apex OS|ok]',
    '[progress: Synchronizacja|100%]',
    '- [ ] Sprawdzić logi',
    '- [x] Zapisano kopię',
    '[details: Szczegóły techniczne]',
    'Wersja jądra: `4.19.0-gvisor`',
    '[/details]',
  ].join('\n');
  const html = renderToStaticMarkup(React.createElement(React.Fragment, null, renderFormattedContent(md, () => {})));
  assert.match(html, /Debian 12/);
  assert.match(html, /Apex OS/);
  assert.match(html, /100%/);
  assert.match(html, /data-markdown-checklist="true"/);
  assert.match(html, /role="checkbox"/);
  assert.match(html, /Wyślij zaznaczone/);
  assert.match(html, /<details/);
  assert.match(html, /Szczegóły techniczne/);
});

test('underscore identifiers are preserved intact without broken italics while boundary _italic_ works', () => {
  const md = 'Agenci Jyn, SVL_Core i jyn_mitek_root oraz \\_literalny\\_ znak, a obok _prawdziwa kursywa_.';
  const html = renderToStaticMarkup(React.createElement(React.Fragment, null, renderFormattedContent(md, () => {})));

  assert.match(html, /Jyn/);
  assert.match(html, /SVL_Core/);
  assert.match(html, /jyn_mitek_root/);
  assert.match(html, /_literalny_/);
  assert.match(html, /<em[^>]*>prawdziwa kursywa<\/em>/);
  assert.doesNotMatch(html, /<em[^>]*>SI<\/em>/);
});

test('KaTeX inline and display math render properly while currency amounts stay plain text', () => {
  const md = [
    'Wzór Einsteina: $E = mc^2$ oraz \\(\\alpha + \\beta = \\gamma\\). Koszt to $100 i $200.',
    '$$',
    '\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}',
    '$$',
    '\\[ \\int_0^1 x^2\\,dx = \\frac{1}{3} \\]',
  ].join('\n');
  const html = renderToStaticMarkup(React.createElement(React.Fragment, null, renderFormattedContent(md, () => {})));

  assert.match(html, /data-math-inline="true"/);
  assert.match(html, /data-math-block="true"/);
  assert.match(html, /class="katex"/);
  assert.match(html, /Koszt to \$100 i \$200\./);
});

test('highlights, kbd shortcuts, sup/sub, action checkboxes, action checklists, and action cards render dynamically', () => {
  const md = [
    'Uwaga: ==kluczowy komunikat==, <mark>alert</mark>, [hl: krytyczny|rose], skrót [kbd: Ctrl+Shift+P] oraz H<sub>2</sub>O i 2<sup>10</sup>.',
    '[checkbox: Włącz diagnostykę|off|send:/diag on|send:/diag off]',
    '[checklist: Plan operacji|x:Sprawdź węzeł=>send:/status; :Otwórz jądro=>tab:kernel|Wykonaj zaznaczone=>send:Uruchom: {checked}]',
    '[action-card: Aktualizacja rdzenia|Wykryto nową konfigurację `SVL_Core`.|Synchronizuj teraz|action:sync|ok]',
  ].join('\n');
  const html = renderToStaticMarkup(React.createElement(React.Fragment, null, renderFormattedContent(md, () => {})));

  assert.match(html, /data-highlight-tone="amber"[^>]*>kluczowy komunikat<\/mark>/);
  assert.match(html, /data-highlight-tone="rose"[^>]*>krytyczny<\/mark>/);
  assert.match(html, /<kbd[^>]*>Ctrl<\/kbd>/);
  assert.match(html, /<kbd[^>]*>Shift<\/kbd>/);
  assert.match(html, /<kbd[^>]*>P<\/kbd>/);
  assert.match(html, /<sub[^>]*>2<\/sub>/);
  assert.match(html, /<sup[^>]*>10<\/sup>/);
  assert.match(html, /data-action-checkbox="true"/);
  assert.match(html, /Włącz diagnostykę/);
  assert.match(html, /data-interactive-checklist="true"/);
  assert.match(html, /Wykonaj zaznaczone/);
  assert.match(html, /Uruchom/);
  assert.match(html, /data-action-card="true"/);
  assert.match(html, /Synchronizuj teraz/);
});

test('buildAgentSystemContext includes factual grounding and table/interactive element instructions', () => {
  const ctx = buildAgentSystemContext('');
  assert.match(ctx, /ZASADY PRAWDOMÓWNOŚCI/);
  assert.match(ctx, /Tabele Markdown/);
  assert.match(ctx, /\[card:/);
  assert.match(ctx, /\[details:/);
  assert.match(ctx, /\[checkbox:/);
  assert.match(ctx, /\[action-card:/);
  assert.match(ctx, /KaTeX/);
});

test('enforceFactualExecutionGuard flags fabricated instant actions and allows honest negations', () => {
  const fabricated = enforceFactualExecutionGuard('Właśnie naprawiłem plik i zrestartowałem serwer!', 0);
  assert.ok(fabricated.verificationNote);
  assert.match(fabricated.reply, /Weryfikacja SVL \(brak wykonanej akcji na serwerze\)/);

  const honestNegation = enforceFactualExecutionGuard(
    'Nie wykonałem tej operacji automatycznie. Kliknij [btn: Synchronizuj|action:sync].',
    0,
  );
  assert.equal(honestNegation.verificationNote, null);
  assert.doesNotMatch(honestNegation.reply, /Weryfikacja SVL/);

  const verified = enforceFactualExecutionGuard('Zsynchronizowałem moduły.', 1);
  assert.equal(verified.verificationNote, null);
});
