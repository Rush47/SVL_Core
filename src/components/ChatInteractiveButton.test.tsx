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
  assert.match(html, />Otwórz panel agentów<\/button>/);
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
  assert.match(html, /Przyciski czatu nie mogą uruchamiać poleceń powłoki/);
});

test('formatted chat content renders safe interactive actions and blocks unsafe ones', () => {
  const content = renderFormattedContent(
    '**Aktualizacja**\n[btn: Otwórz panel agentów|tab:agents]\n[btn: Nie uruchamiaj powłoki|send:/exec id]',
    () => {},
  );
  const html = renderToStaticMarkup(React.createElement(React.Fragment, null, content));

  assert.match(html, /<strong[^>]*>Aktualizacja<\/strong>/);
  assert.match(html, /Otwórz panel agentów/);
  assert.match(html, /aria-disabled="false"/);
  assert.match(html, /aria-disabled="true"/);
});

test('markdown table parser handles tables without outer pipes and preserves [btn:] inside cells', () => {
  assert.equal(isMarkdownTableSeparator('--- | --- | ---'), true);
  assert.deepEqual(
    parseMarkdownTableRow('Moduł | Status | [btn: Otwórz Apex|tab:apex]'),
    ['Moduł', 'Status', '[btn: Otwórz Apex|tab:apex]'],
  );

  const md = [
    'Moduł | Status | Akcja',
    '--- | --- | ---',
    'Apex OS | AKTYWNY | [btn: Otwórz Apex|tab:apex]',
    'Ollama | GOTOWA | [btn: Synchronizuj|action:sync]',
  ].join('\n');
  const html = renderToStaticMarkup(React.createElement(React.Fragment, null, renderFormattedContent(md, () => {})));
  assert.match(html, /<table/);
  assert.match(html, /Otwórz Apex/);
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
  assert.match(html, /role="checkbox"/);
  assert.match(html, /<details/);
  assert.match(html, /Szczegóły techniczne/);
});

test('buildAgentSystemContext includes factual grounding and table/interactive element instructions', () => {
  const ctx = buildAgentSystemContext('');
  assert.match(ctx, /ZASADY PRAWDOMÓWNOŚCI/);
  assert.match(ctx, /Tabele Markdown/);
  assert.match(ctx, /\[card:/);
  assert.match(ctx, /\[details:/);
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
