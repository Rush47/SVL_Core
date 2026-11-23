import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseActionCardToken,
  parseAlertToken,
  parseBadgeToken,
  parseBarsToken,
  parseCheckboxToken,
  parseChecklistToken,
  parseChipsToken,
  parseConfirmToken,
  parseDiffToken,
  parseFormToken,
  parseGaugeToken,
  parseHighlightToken,
  parseJsonToken,
  parseKbdToken,
  parseKpiToken,
  parseStepToken,
  parseTabsToken,
  parseTerminalToken,
  parseTimelineToken,
  parseToggleToken,
  renderChecklistActionTemplate,
  renderFormTemplate,
} from './chatInteractiveTokens.ts';

test('parseStepToken parses Copilot-style workflow steps', () => {
  assert.deepEqual(parseStepToken('[step: Analiza repozytorium|done|24 pliki]'), {
    label: 'Analiza repozytorium',
    status: 'done',
    detail: '24 pliki',
  });
  assert.deepEqual(parseStepToken('[krok: Budowanie dist|running]'), {
    label: 'Budowanie dist',
    status: 'running',
  });
  assert.deepEqual(parseStepToken('[step: Testy|error|timeout]'), {
    label: 'Testy',
    status: 'error',
    detail: 'timeout',
  });
  assert.equal(parseStepToken('[step: ]'), null);
});

test('parseToggleToken parses interactive toggle switches', () => {
  assert.deepEqual(
    parseToggleToken('[toggle: Autonomia w tle|on|send:włącz działanie w tle|send:wyłącz działanie w tle]'),
    {
      label: 'Autonomia w tle',
      enabled: true,
      onAction: 'send:włącz działanie w tle',
      offAction: 'send:wyłącz działanie w tle',
    },
  );
  assert.equal(parseToggleToken('[toggle: Brak akcji|on]'), null);
});

test('parseFormToken and renderFormTemplate build parameterized actions', () => {
  const form = parseFormToken(
    '[form: Nowe zadanie|title=Tytuł zadania:Audyt;desc=Opis|/zadanie {title} | {desc}]',
  );
  assert.ok(form);
  assert.equal(form.title, 'Nowe zadanie');
  assert.deepEqual(form.fields, [
    { name: 'title', label: 'Tytuł zadania', defaultValue: 'Audyt' },
    { name: 'desc', label: 'Opis', defaultValue: '' },
  ]);
  assert.equal(
    renderFormTemplate(form.commandTemplate, { title: 'Skan', desc: 'Pełny' }),
    '/zadanie Skan | Pełny',
  );
});

test('parseKpiToken, parseBadgeToken and parseAlertToken parse metric and status tokens', () => {
  assert.deepEqual(parseKpiToken('[kpi: Usługi ACTIVE|6/6|+100%|ok]'), {
    label: 'Usługi ACTIVE',
    value: '6/6',
    delta: '+100%',
    tone: 'ok',
  });
  assert.deepEqual(parseBadgeToken('[badge: ONLINE|ok]'), {
    text: 'ONLINE',
    tone: 'ok',
  });
  assert.deepEqual(parseAlertToken('[alert: warn|Uwaga|Wykryto wysoki load CPU]'), {
    tone: 'warn',
    title: 'Uwaga',
    body: 'Wykryto wysoki load CPU',
  });
});

test('parseChecklistToken, parseTabsToken, parseConfirmToken, parseChipsToken, parseTimelineToken and parseTerminalToken', () => {
  assert.deepEqual(parseChecklistToken('[checklist: Plan wdrożenia|x:Build TS; :Testy Python]'), {
    title: 'Plan wdrożenia',
    items: [
      { checked: true, text: 'Build TS' },
      { checked: false, text: 'Testy Python' },
    ],
  });
  assert.deepEqual(parseTabsToken('[tabs: Status=Wszystko OK|Logi=Brak błędów]'), {
    tabs: [
      { label: 'Status', content: 'Wszystko OK' },
      { label: 'Logi', content: 'Brak błędów' },
    ],
  });
  assert.deepEqual(
    parseConfirmToken('[confirm: Restart usługi|Czy zrestartować backend?|Tak|send:/restart|Nie]'),
    {
      title: 'Restart usługi',
      description: 'Czy zrestartować backend?',
      confirmLabel: 'Tak',
      confirmAction: 'send:/restart',
      cancelLabel: 'Nie',
    },
  );
  assert.deepEqual(parseChipsToken('[chips: Następne kroki|Status=send:/status;Jądro=tab:kernel]'), {
    label: 'Następne kroki',
    options: [
      { label: 'Status', action: 'send:/status' },
      { label: 'Jądro', action: 'tab:kernel' },
    ],
  });
  assert.deepEqual(parseTimelineToken('[timeline: Start=08:00;Gotowe=08:02]'), {
    entries: [
      { title: 'Start', meta: '08:00' },
      { title: 'Gotowe', meta: '08:02' },
    ],
  });
  assert.deepEqual(parseTerminalToken('[terminal: Szybki test|npm run test:unit|157 passed]'), {
    title: 'Szybki test',
    command: 'npm run test:unit',
    output: '157 passed',
  });
  assert.deepEqual(parseDiffToken('[diff: server.ts|old()|new()]'), {
    file: 'server.ts',
    before: 'old()',
    after: 'new()',
  });
  assert.deepEqual(parseBarsToken('[bars: Zużycie|CPU=42;RAM=68]'), {
    title: 'Zużycie',
    items: [
      { label: 'CPU', value: 42 },
      { label: 'RAM', value: 68 },
    ],
  });
  assert.deepEqual(parseGaugeToken('[gauge: CPU|72|%|warn]'), {
    label: 'CPU',
    percent: 72,
    unit: '%',
    tone: 'warn',
  });
  assert.deepEqual(parseJsonToken('[json: Config|{"ok":true}]'), {
    title: 'Config',
    rawJson: '{"ok":true}',
  });
});

test('parseHighlightToken, parseKbdToken, parseCheckboxToken, parseActionCardToken and checklist actions', () => {
  assert.deepEqual(parseHighlightToken('[hl: Kluczowy alert|rose]'), {
    text: 'Kluczowy alert',
    tone: 'rose',
  });
  assert.deepEqual(parseHighlightToken('[podświetl: Info|cyan]'), {
    text: 'Info',
    tone: 'cyan',
  });
  assert.deepEqual(parseKbdToken('[kbd: Ctrl+Shift+P]'), {
    keys: 'Ctrl+Shift+P',
  });
  assert.deepEqual(
    parseCheckboxToken('[checkbox: Tryb diagnostyczny|on|send:/diag on|send:/diag off]'),
    {
      label: 'Tryb diagnostyczny',
      checked: true,
      onAction: 'send:/diag on',
      offAction: 'send:/diag off',
    },
  );
  assert.deepEqual(
    parseActionCardToken('[action-card: Skan systemu|Sprawdź integralność węzłów|Uruchom skan|action:scan|ok]'),
    {
      title: 'Skan systemu',
      description: 'Sprawdź integralność węzłów',
      ctaLabel: 'Uruchom skan',
      action: 'action:scan',
      tone: 'ok',
    },
  );

  const cl = parseChecklistToken(
    '[checklist: Wdrożenie|x:Sprawdź logi=>send:/status; :Otwórz jądro=>tab:kernel|Wykonaj zaznaczone=>send:Wykonaj: {checked} ({count})]',
  );
  assert.deepEqual(cl, {
    title: 'Wdrożenie',
    items: [
      { checked: true, text: 'Sprawdź logi', action: 'send:/status' },
      { checked: false, text: 'Otwórz jądro', action: 'tab:kernel' },
    ],
    submitLabel: 'Wykonaj zaznaczone',
    submitAction: 'send:Wykonaj: {checked} ({count})',
  });
  assert.equal(
    renderChecklistActionTemplate(cl!.submitAction!, ['Sprawdź logi'], ['Otwórz jądro']),
    'send:Wykonaj: Sprawdź logi (1)',
  );
});

