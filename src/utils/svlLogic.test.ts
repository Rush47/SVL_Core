import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANONICAL_AGENTS,
  FULL_ROOT_SCOPES,
  buildChatHistoryPayload,
  calculateCompactMetricC,
  compactifyValue,
  formatAgentDisplayName,
  getGitHubAgentPermissions,
  isGitHubChatRequest,
  isForbiddenAgentSender,
  getSvlOperatorAccessToken,
  guardUnverifiedMissionCompletion,
  hasSvlOperatorAccessToken,
  setSvlOperatorTokenRequired,
  isUnsafeChatInteractiveAction,
  mergeConversationThreads,
  normalizeAgentCanonicalName,
  parseBielikChatCommand,
  parseSshShipTerminalInput,
  extractBielikActionTags,
  normalizeAiInteractiveMarkup,
  parseChatInteractiveToken,
  unverifiedExecutionNote,
  resolveChatInteractiveButtonAction,
  resolveChatTargetAgent,
  resolveInstalledOllamaModel,
  resolveAvatarProfileKey,
  safeFetchJson,
  safeParseJsonResponse,
  selectOllamaModelName,
  setSvlOperatorAccessToken,
  validateOllamaHostUrl,
  validateOperatorTokenFormat,
} from './svlLogic';

test('GitHub agent scopes: read, sync-branch writes and admin', () => {
  assert.deepEqual(getGitHubAgentPermissions(['github.read']), { read: true, writeSync: false, admin: false });
  assert.deepEqual(getGitHubAgentPermissions(['github.read', 'github.write_sync']), {
    read: true,
    writeSync: true,
    admin: false,
  });
  assert.deepEqual(getGitHubAgentPermissions(['github.admin']), { read: true, writeSync: true, admin: true });
  assert.deepEqual(getGitHubAgentPermissions(undefined), { read: false, writeSync: false, admin: false });
});
test('mission completion claims are blocked when no mission status can be verified', () => {
  const context = 'Prowadzę misję, sprawdź czy cała procedura się zakończyła.';
  assert.match(
    guardUnverifiedMissionCompletion(context, 'Cała procedura misji dobiegła już końca.'),
    /Status misji: NIEZWERYFIKOWANY/,
  );
  assert.match(
    guardUnverifiedMissionCompletion(context, 'The mission has been completed.'),
    /Status misji: NIEZWERYFIKOWANY/,
  );
});

test('mission completion guard leaves plans and unrelated answers unchanged', () => {
  const context = 'Opisz procedurę misji.';
  const planned = 'Procedurę można uznać za zakończoną dopiero po weryfikacji każdego kroku.';
  assert.equal(guardUnverifiedMissionCompletion(context, planned), planned);
  assert.equal(
    guardUnverifiedMissionCompletion('Napisz zdanie gramatyczne.', 'Misja została zakończona.'),
    'Misja została zakończona.',
  );
});

test('chat interactive tokens preserve action text and tolerate aliases', () => {
  assert.deepEqual(parseChatInteractiveToken('[btn: Otwórz panel|tab:agents]'), {
    label: 'Otwórz panel',
    action: 'tab:agents',
  });
  assert.deepEqual(parseChatInteractiveToken('[button: Więcej|text:a|b]'), {
    label: 'Więcej',
    action: 'text:a|b',
  });
  assert.equal(parseChatInteractiveToken('[btn: |tab:chat]'), null);
});

test('chat interactive actions cannot execute shell commands', () => {
  assert.equal(isUnsafeChatInteractiveAction('/exec rm -rf /'), true);
  assert.equal(isUnsafeChatInteractiveAction('run:uname -a'), true);
  assert.equal(isUnsafeChatInteractiveAction('send:/exec id'), true);
  assert.equal(isUnsafeChatInteractiveAction('text:/exec id'), true);
  assert.equal(isUnsafeChatInteractiveAction('tab:agents'), false);
  assert.equal(isUnsafeChatInteractiveAction('action:sync'), false);
});

test('TopologicalInfinityEngine compactifies [-Infinity, +Infinity] to [-1, 1] with c = 2.5', () => {
  assert.equal(compactifyValue(Number.NEGATIVE_INFINITY), -1.0);
  assert.equal(compactifyValue(Number.POSITIVE_INFINITY), 1.0);
  assert.equal(compactifyValue(0), 0.0);

  const res = calculateCompactMetricC(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY);
  assert.equal(res.compactStart, -1.0);
  assert.equal(res.compactEnd, 1.0);
  assert.equal(res.domainLength, 2.0);
  assert.equal(res.orthogonalB, 1.5);
  assert.equal(res.metricC, 2.5);
});

test('validateOperatorTokenFormat rejects disallowed and short tokens', () => {
  const legacy = validateOperatorTokenFormat('364_OMNIKLUCZ_ROOT');
  assert.equal(legacy.valid, false);
  assert.equal(legacy.error, 'Ten token nie jest dozwolony.');

  const shortToken = validateOperatorTokenFormat('short_secret_123');
  assert.equal(shortToken.valid, false);

  const validToken = validateOperatorTokenFormat('svl_operator_production_secret_token_36_chars');
  assert.equal(validToken.valid, true);
  assert.equal(validToken.error, null);
});

test('CANONICAL_AGENTS contains only Bielik and Maya on dolphin-llama3:8b-v2.9-q2_K', () => {
  assert.deepEqual(
    CANONICAL_AGENTS.map((a) => ({ name: a.canonicalName, profile: a.sourceProfile })),
    [
      { name: 'Bielik', profile: 'ollama:dolphin-llama3:8b-v2.9-q2_K' },
      { name: 'Maya', profile: 'ollama:dolphin-llama3:8b-v2.9-q2_K' },
    ],
  );
  assert.equal(normalizeAgentCanonicalName('Agata'), null);
  assert.equal(normalizeAgentCanonicalName('Agata Mitek'), null);
  assert.equal(normalizeAgentCanonicalName('bielik'), 'Bielik');
  assert.equal(normalizeAgentCanonicalName('conv-agent-bielik'), 'Bielik');
  assert.equal(normalizeAgentCanonicalName('maya'), 'Maya');
  assert.equal(normalizeAgentCanonicalName('Maya Mitek'), 'Maya');
  assert.equal(normalizeAgentCanonicalName('conv-agent-maya'), 'Maya');
  assert.equal(normalizeAgentCanonicalName('Iris AI'), null);
  assert.equal(normalizeAgentCanonicalName('codex'), null);
  assert.equal(formatAgentDisplayName('bielik ai'), 'Bielik');
  assert.equal(formatAgentDisplayName('maya ai'), 'Maya Mitek');
  assert.equal(formatAgentDisplayName('Maya'), 'Maya Mitek');
  assert.equal(resolveAvatarProfileKey('Agata Mitek', 'Agata'), null);
  assert.equal(resolveAvatarProfileKey('Bielik', 'bielik'), 'Bielik');
  assert.equal(resolveAvatarProfileKey('Maya', 'maya'), 'Maya');
  assert.equal(resolveAvatarProfileKey('Maya Mitek', 'maya'), 'Maya');
  assert.equal(resolveAvatarProfileKey('Iris AI', 'iris'), null);
});

test('resolveChatTargetAgent routes direct Polish mentions and Maya channel/selection to Maya (never hijacked by Bielik)', () => {
  // Natural Polish addressing in Family channel without @
  assert.equal(
    resolveChatTargetAgent({
      message: 'Maya, sprawdź status systemu',
      conversationId: 'conv-rodzina-mitek-wszyscy',
      targetAgent: 'Rodzina Mitek',
    }).agent,
    'Maya',
  );
  assert.equal(
    resolveChatTargetAgent({
      message: 'Cześć Maya Mitek, co słychać?',
      conversationId: 'conv-rodzina-mitek-wszyscy',
      targetAgent: 'Rodzina Mitek',
    }).agent,
    'Maya',
  );
  assert.equal(
    resolveChatTargetAgent({
      message: 'Hej Majo, pokaż tabelę modułów',
      conversationId: 'conv-rodzina-mitek-wszyscy',
      targetAgent: 'Auto',
    }).agent,
    'Maya',
  );
  assert.equal(
    resolveChatTargetAgent({
      message: 'Piszę do Mayi z pytaniem o raport',
      conversationId: 'conv-rodzina-mitek-wszyscy',
      targetAgent: 'Rodzina Mitek',
    }).agent,
    'Maya',
  );
  // Explicit dropdown selection Maya + slash command MUST NOT be hijacked by Bielik
  assert.equal(
    resolveChatTargetAgent({
      message: '/status',
      conversationId: 'conv-rodzina-mitek-wszyscy',
      targetAgent: 'Maya',
      hasSlashCommand: true,
    }).agent,
    'Maya',
  );
  // Direct Maya channel
  assert.equal(
    resolveChatTargetAgent({
      message: 'Opisz architekturę w tabeli',
      conversationId: 'conv-agent-maya',
      targetAgent: 'Auto',
    }).agent,
    'Maya',
  );
  // Explicit Bielik mentions & channel still route to Bielik
  assert.equal(
    resolveChatTargetAgent({
      message: 'Bielik, sprawdź pamięć',
      conversationId: 'conv-rodzina-mitek-wszyscy',
      targetAgent: 'Rodzina Mitek',
    }).agent,
    'Bielik',
  );
  assert.equal(
    resolveChatTargetAgent({
      message: 'Hej',
      conversationId: 'conv-agent-bielik',
      targetAgent: 'Bielik',
    }).agent,
    'Bielik',
  );
});

test('parseBielikChatCommand parses explicit slash commands deterministically', () => {
  assert.deepEqual(parseBielikChatCommand('/status'), { kind: 'status' });
  assert.deepEqual(parseBielikChatCommand('/ollama'), { kind: 'ollama' });
  assert.deepEqual(parseBielikChatCommand('/pomoc'), { kind: 'help' });
  assert.deepEqual(parseBielikChatCommand('/pamiec dodaj Test fakt Bielika'), {
    kind: 'memory_save',
    memoryKind: 'fact',
    content: 'Test fakt Bielika',
  });
  assert.deepEqual(parseBielikChatCommand('/modul svl-guard ACTIVE Tarcza aktywna'), {
    kind: 'module_upsert',
    id: 'svl-guard',
    status: 'ACTIVE',
    name: 'svl-guard',
    description: 'Tarcza aktywna',
  });
  assert.deepEqual(parseBielikChatCommand('/topologia -inf inf'), {
    kind: 'topology',
    xStart: '-inf',
    xEnd: 'inf',
  });
  assert.deepEqual(parseBielikChatCommand('/zadanie Audyt | Sprawdz stan'), {
    kind: 'agent_task',
    title: 'Audyt',
    payload: 'Sprawdz stan',
  });
  assert.deepEqual(parseBielikChatCommand('/root id && uname -a'), {
    kind: 'root_exec',
    command: 'id && uname -a',
  });
  assert.equal(parseBielikChatCommand('/iris tyt | msg'), null);
  assert.equal(parseBielikChatCommand('/powiadom tyt | msg'), null);
  assert.equal(parseBielikChatCommand('Zwykła wiadomość bez ukośnika'), null);
});

test('extractBielikActionTags extracts valid action JSON tags and strips them from reply', () => {
  const res = extractBielikActionTags(
    'Zapisuję fakt w pamięci.\n[[SVL_ACTION:{"cmd":"memory_save","content":"Model gotowy"}]]\nGotowe.',
  );
  assert.equal(res.cleanText, 'Zapisuję fakt w pamięci.\n\nGotowe.');
  assert.deepEqual(res.actions, [{ cmd: 'memory_save', content: 'Model gotowy' }]);

  const invalid = extractBielikActionTags('Błąd tagu [[SVL_ACTION:{bad json}]] zostaje oczyszczony.');
  assert.equal(invalid.cleanText, 'Błąd tagu  zostaje oczyszczony.');
  assert.deepEqual(invalid.actions, []);
});

test('validateOllamaHostUrl validates http/https endpoints cleanly', () => {
  assert.equal(validateOllamaHostUrl('http://127.0.0.1:11434/').normalized, 'http://127.0.0.1:11434');
  assert.equal(validateOllamaHostUrl('https://ollama.example.com').valid, true);
  assert.equal(validateOllamaHostUrl('ftp://bad-host').valid, false);
  assert.equal(validateOllamaHostUrl('').valid, false);
});

test('buildChatHistoryPayload filters system errors and preserves multi-turn order', () => {
  const history = buildChatHistoryPayload([
    { role: 'system', content: 'Błąd' },
    { role: 'user', content: 'Cześć!' },
    { role: 'assistant', content: 'Hej, w czym pomóc?' },
  ]);
  assert.deepEqual(history, [
    { role: 'user', content: 'Cześć!' },
    { role: 'assistant', content: 'Hej, w czym pomóc?' },
  ]);
});

test('selectOllamaModelName honors explicit selection and prefers dolphin-llama3 8B Q2 for text', () => {
  const models = [
    { name: 'dolphin-llama3:8b-v2.9-q2_K', vision_supported: false },
    { name: 'llama3.2-vision:11b', vision_supported: true },
  ];
  assert.equal(selectOllamaModelName('ollama:dolphin-llama3:8b-v2.9-q2_K', models, false), 'dolphin-llama3:8b-v2.9-q2_K');
  assert.equal(selectOllamaModelName('svl-hybrid-router', models, true), 'llama3.2-vision:11b');
  assert.equal(selectOllamaModelName('svl-hybrid-router', models, false), 'dolphin-llama3:8b-v2.9-q2_K');
});

test('mergeConversationThreads preserves pending in-flight messages and respects deleted threads', () => {
  const remote = [
    {
      id: 'c1',
      title: 'Sesja 1',
      updatedAt: '12:00',
      messages: [
        { id: 'm1', role: 'user' as const, sender: 'Op', content: 'Cześć', timestamp: '12:00' },
      ],
    },
    {
      id: 'c-deleted',
      title: 'Stara',
      updatedAt: '11:00',
      messages: [
        { id: 'm0', role: 'user' as const, sender: 'Op', content: 'Usuń mnie', timestamp: '11:00' },
      ],
    },
  ];
  const local = [
    {
      id: 'c1',
      title: 'Sesja 1',
      updatedAt: '12:01',
      messages: [
        { id: 'm1', role: 'user' as const, sender: 'Op', content: 'Cześć', timestamp: '12:00' },
        { id: 'm2', role: 'assistant' as const, sender: 'Alex', content: 'Odpowiedź w locie', timestamp: '12:01' },
      ],
    },
    {
      id: 'c-new',
      title: 'Nowa sesja',
      updatedAt: '12:02',
      messages: [
        { id: 'm3', role: 'assistant' as const, sender: 'SVL System Kernel', content: 'Start', timestamp: '12:02' },
      ],
    },
  ];

  const merged = mergeConversationThreads(remote, local, new Set(['m2', 'm3']), new Set(['c-deleted']));
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, 'c-new');
  assert.deepEqual(merged[1].messages.map((m) => m.id), ['m1', 'm2']);
});

test('empty authoritative conversation responses do not restore stale local threads', () => {
  const staleLocal = [
    {
      id: 'stale-conversation',
      title: 'Stara sesja',
      updatedAt: '12:00',
      messages: [
        { id: 'stale-message', role: 'user' as const, sender: 'Op', content: 'Stara treść', timestamp: '12:00' },
      ],
    },
  ];

  assert.deepEqual(mergeConversationThreads([], staleLocal), []);
});

test('safeParseJsonResponse handles HTML <!doctype> and non-JSON payloads without SyntaxError', async () => {
  const htmlResp = new Response('<!doctype html><html><body>502 Bad Gateway</body></html>', {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });
  const htmlRes = await safeParseJsonResponse(htmlResp);
  assert.equal(htmlRes.ok, false);
  assert.equal(htmlRes.data, null);
  assert.equal(htmlRes.proxyHtml, true);
  assert.equal(htmlRes.offline, true);
  assert.ok(htmlRes.error?.includes('HTML'));

  const proxiedErrResp = new Response(
    JSON.stringify({ ok: false, upstreamStatus: 503, error: 'Chwilowe przeciążenie modelu AI.' }),
    { status: 424, headers: { 'Content-Type': 'application/json' } },
  );
  const proxiedErr = await safeParseJsonResponse(proxiedErrResp);
  assert.equal(proxiedErr.ok, false);
  assert.equal(proxiedErr.status, 424);
  assert.equal(proxiedErr.offline, true);
  assert.equal(proxiedErr.error, 'Chwilowe przeciążenie modelu AI.');

  const jsonResp = new Response(JSON.stringify({ ok: true, reply: 'Działa' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  const jsonRes = await safeParseJsonResponse<{ ok: boolean; reply: string }>(jsonResp);
  assert.equal(jsonRes.ok, true);
  assert.equal(jsonRes.data?.reply, 'Działa');
  assert.equal(jsonRes.error, null);
});

test('operator access token stays strictly in memory', () => {
  const prevOp = getSvlOperatorAccessToken();
  try {
    setSvlOperatorAccessToken('');
    // Domyślnie serwer nie wymaga tokenu — prawa operatora bez wpisywania.
    setSvlOperatorTokenRequired(false);
    assert.equal(hasSvlOperatorAccessToken(), true);
    // Przy SVL_REQUIRE_OPERATOR_TOKEN=1 bez tokenu nie ma praw.
    setSvlOperatorTokenRequired(true);
    assert.equal(hasSvlOperatorAccessToken(), false);
    setSvlOperatorAccessToken('op_secret_token_32_characters_minimum_xyz');
    assert.equal(hasSvlOperatorAccessToken(), true);
  } finally {
    setSvlOperatorTokenRequired(false);
    setSvlOperatorAccessToken(prevOp);
  }
});

test('mergeConversationThreads preserves newly created pending empty threads during refresh', () => {
  const remote = [
    {
      id: 'conv-rodzina-mitek-wszyscy',
      title: 'Rodzina Mitek (wszyscy)',
      updatedAt: '12:00',
      messages: [],
    },
  ];
  const local = [
    {
      id: 'conv-pending-empty',
      title: 'Nowa sesja (12:05)',
      updatedAt: '12:05',
      messages: [],
    },
    remote[0],
  ];
  const merged = mergeConversationThreads(
    remote,
    local,
    new Set(),
    new Set(),
    new Set(['conv-pending-empty']),
  );
  assert.deepEqual(
    merged.map((c) => c.id),
    ['conv-pending-empty', 'conv-rodzina-mitek-wszyscy'],
  );
});

test('parseSshShipTerminalInput handles /exec root commands, natural Polish directives, and standard shell commands', () => {
  const execShell = parseSshShipTerminalInput('/exec id && uname -a');
  assert.equal(execShell.isExplicitExec, true);
  assert.equal(execShell.mode, 'shell');
  assert.equal(execShell.shellCommand, 'id && uname -a');

  const execNatural = parseSshShipTerminalInput('/exec Sprawdź stan zapory ufw i portów');
  assert.equal(execNatural.isExplicitExec, true);
  assert.equal(execNatural.mode, 'natural');
  assert.equal(execNatural.naturalDirective, 'Sprawdź stan zapory ufw i portów');
  assert.match(execNatural.shellCommand, /ufw status/);

  const naturalCmd = parseSshShipTerminalInput('Pokaż użycie pamięci RAM na statku SVL-364');
  assert.equal(naturalCmd.isExplicitExec, false);
  assert.equal(naturalCmd.mode, 'natural');
  assert.match(naturalCmd.shellCommand, /free -m/);

  const directShell = parseSshShipTerminalInput('df -h / && free -h');
  assert.equal(directShell.isExplicitExec, false);
  assert.equal(directShell.mode, 'shell');
  assert.equal(directShell.shellCommand, 'df -h / && free -h');
});

test('space tactical prompts containing przeskanuj do not trigger antivirus scan', () => {
  const msg = "Namierz co wysyła ten sygnał i wyślij tam jednostkę i przeskanuj tą placówkę lub statek z ukrycia";
  const hasAntivirusKeyword = /\b(?:wirus\w*|antywirus\w*|malware|kwarantann\w*)\b/i.test(msg) || /^\/antivirus\b/i.test(msg);
  const hasExplicitFileScan = /\bprzeskanuj\b/i.test(msg) && /\b(?:plik|pliki|kod|system|baz[ęe]|baze|katalog|komputer)\b/i.test(msg);
  const hasSpaceTacticalContext = /\b(?:placówk|placowk|statek|sygnał|sygnal|jednostk|ukryci|ukrycia|sond|flot|planet|sektor|anomali|radar)\b/i.test(msg);
  const wantsAntivirusScan = (hasAntivirusKeyword || hasExplicitFileScan) && !hasSpaceTacticalContext;
  assert.equal(wantsAntivirusScan, false);
});

test('safeFetchJson retries transient proxy HTML HTTP 200 responses even when maxRetries is 0', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response('<!doctype html><html><body>Loading preview</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    }
    return new Response(JSON.stringify({ ok: true, saved: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const result = await safeFetchJson<{ ok: boolean; saved: boolean }>('/api/py/chat/conversations/message', {
      method: 'POST',
      maxRetries: 0,
      timeoutMs: 5000,
      body: JSON.stringify({ test: true }),
    });
    assert.equal(calls, 2);
    assert.equal(result.ok, true);
    assert.equal(result.data?.saved, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AI buttons: Polish keyword and Markdown links with chat actions become working buttons', () => {
  assert.deepEqual(parseChatInteractiveToken('[przycisk: Skanuj|action:scan]'), { label: 'Skanuj', action: 'action:scan' });
  assert.deepEqual(parseChatInteractiveToken('[BTN: Raport|action:report]'), { label: 'Raport', action: 'action:report' });
  assert.equal(
    normalizeAiInteractiveMarkup('Wybierz: [Zapytaj Mayę](ask:Maya) albo [Moduły](send:/moduly).'),
    'Wybierz: [btn: Zapytaj Mayę|ask:Maya] albo [btn: Moduły|send:/moduly].',
  );
  // zwykłe linki i nieznane schematy zostają bez zmian
  assert.equal(normalizeAiInteractiveMarkup('[Docs](https://example.com)'), '[Docs](https://example.com)');
  assert.equal(normalizeAiInteractiveMarkup('[X](javascript:alert(1))'), '[X](javascript:alert(1))');
  assert.equal(isUnsafeChatInteractiveAction('send:/exec rm -rf /'), true);
  assert.equal(isUnsafeChatInteractiveAction('ask:Bielik'), false);
});

test('resolveInstalledOllamaModel finds the installed model instead of reporting it missing', () => {
  const installed = [{ name: 'llama3.2-vision:latest' }, { name: 'qwen2.5:7b' }];
  assert.deepEqual(resolveInstalledOllamaModel('llama3.2-vision:11b', installed), {
    name: 'llama3.2-vision:latest', substituted: false, installedCount: 2,
  });
  assert.equal(resolveInstalledOllamaModel('qwen2.5', installed).name, 'qwen2.5:7b');
  const other = resolveInstalledOllamaModel('llama3.2-vision:11b', [{ name: 'gemma2:9b' }]);
  assert.equal(other.name, 'gemma2:9b');
  assert.equal(other.substituted, true);
  assert.equal(resolveInstalledOllamaModel('llama3.2-vision:11b', []).installedCount, 0);
});

test('unverifiedExecutionNote flags claims of finished operations that the server never ran', () => {
  const claims = [
    'Atomowa podmiana systemu zakończona. Status: ACTIVE_HOT_SWAPPED.',
    'Zainstalowałem SVL CoreOS 2 na Debianie 13.',
    'Debootstrap Debian 13 zakończony — postęp 100%.',
    'Uruchomiłam demona SVL-Sentinel, wszystko ONLINE.',
  ];
  for (const text of claims) assert.ok(unverifiedExecutionNote(text, 0), text);
  assert.equal(unverifiedExecutionNote('Zainstalowałem pakiet.', 1), null);
  assert.equal(unverifiedExecutionNote('Aby zainstalować system, uruchom instalator jako root.', 0), null);
  assert.equal(unverifiedExecutionNote('Tarcza to ustawienie scenariusza statku.', 0), null);
});

test('resolveChatInteractiveButtonAction resolves tabs, Polish aliases, system actions, custom fallback, and blocks shell exec', () => {
  assert.deepEqual(resolveChatInteractiveButtonAction('tab:agents'), { kind: 'tab', tab: 'agents' });
  assert.deepEqual(resolveChatInteractiveButtonAction('nav:jądro'), { kind: 'tab', tab: 'kernel' });
  assert.deepEqual(resolveChatInteractiveButtonAction('open:statek'), { kind: 'tab', tab: 'svl364' });
  assert.deepEqual(resolveChatInteractiveButtonAction('goto:ssh'), { kind: 'tab', tab: 'svl364' });
  assert.deepEqual(resolveChatInteractiveButtonAction('goto:infrastruktura'), { kind: 'tab', tab: 'infrastructure' });
  assert.deepEqual(resolveChatInteractiveButtonAction('tab:unknown_xyz'), { kind: 'invalid_tab', rawTab: 'unknown_xyz' });

  assert.deepEqual(resolveChatInteractiveButtonAction('send:/status'), { kind: 'send', text: '/status' });
  assert.deepEqual(resolveChatInteractiveButtonAction('ask:Maya Mitek'), { kind: 'ask', agent: 'Maya' });
  assert.deepEqual(resolveChatInteractiveButtonAction('text:Sprawdź logi'), { kind: 'text', text: 'Sprawdź logi' });
  assert.deepEqual(resolveChatInteractiveButtonAction('copy:uname -a'), { kind: 'copy', text: 'uname -a' });

  assert.deepEqual(resolveChatInteractiveButtonAction('action:sync'), { kind: 'sync' });
  assert.deepEqual(resolveChatInteractiveButtonAction('action:antivirus'), { kind: 'scan' });
  assert.deepEqual(resolveChatInteractiveButtonAction('action:raport'), { kind: 'report' });
  assert.deepEqual(resolveChatInteractiveButtonAction('action:image:Futurystyczny statek SVL-364'), {
    kind: 'image',
    prompt: 'Futurystyczny statek SVL-364',
  });
  assert.deepEqual(resolveChatInteractiveButtonAction('action:vision'), { kind: 'vision' });
  assert.deepEqual(resolveChatInteractiveButtonAction('action:avatars'), { kind: 'avatars' });
  assert.deepEqual(resolveChatInteractiveButtonAction('action:ollama'), { kind: 'ollama' });
  assert.deepEqual(resolveChatInteractiveButtonAction('action:duplex'), { kind: 'duplex' });

  // Custom AI-invented action:* or bare label falls back to sending clean text instead of failing with unknown action
  assert.deepEqual(resolveChatInteractiveButtonAction('action:check_ports', 'Sprawdź otwarte porty'), {
    kind: 'send',
    text: 'Sprawdź otwarte porty',
  });
  assert.deepEqual(resolveChatInteractiveButtonAction('Pokaż moduły', 'Pokaż moduły'), {
    kind: 'send',
    text: 'Pokaż moduły',
  });

  // Shell execution via inline AI button stays strictly blocked
  assert.deepEqual(resolveChatInteractiveButtonAction('send:/exec id'), { kind: 'unsafe' });
  assert.deepEqual(resolveChatInteractiveButtonAction('/exec rm -rf /'), { kind: 'unsafe' });
  assert.deepEqual(resolveChatInteractiveButtonAction('run:whoami'), { kind: 'unsafe' });
});

test('FULL_ROOT_SCOPES includes all 29 superuser system, Linux root, kernel, terminal, SSH, Ollama, mission, antivirus, memory, agents, and GitHub admin scopes', () => {
  assert.equal(FULL_ROOT_SCOPES.length, 29);
  for (const required of [
    'system.root',
    'linux.root',
    'kernel.admin',
    'apex.control',
    'terminal.exec',
    'ssh.exec',
    'packages.admin',
    'services.admin',
    'ollama.admin',
    'maya.mission',
    'security.antivirus',
    'security.admin',
    'modules.write',
    'memory.write',
    'github.admin',
    'agents.admin',
    'superuser.all',
  ]) {
    assert.ok((FULL_ROOT_SCOPES as readonly string[]).includes(required), `Missing scope: ${required}`);
  }
});


test('isGitHubChatRequest rozpoznaje tylko sprawy GitHuba', () => {
  for (const text of [
    'Pokaż otwarte pull requesty',
    'Jakie są ostatnie commity w repozytorium?',
    'Utwórz issue o błędzie czatu',
    'Wypchnij zmiany na main',
    'Sprawdź GitHub Actions',
    'zsynchronizuj z GitHub',
  ]) {
    assert.equal(isGitHubChatRequest(text), true, text);
  }
  for (const text of ['Cześć Maya, jak stan?', 'Jaka jest pogoda w Warszawie?', 'Zapisz w pamięci, że lubię kawę', 'Raport statku SVL-364']) {
    assert.equal(isGitHubChatRequest(text), false, text);
  }
});


test('isForbiddenAgentSender wykrywa podszywania i wyłączone persony', () => {
  for (const bad of ['Mai', 'mai', 'M4i', 'M@i', 'Maja', 'Iris', 'Iris AI', 'Agata', 'si_1', 'Aurelius']) {
    assert.equal(isForbiddenAgentSender(bad), true, bad);
  }
  for (const ok of ['Bielik', 'Maya Mitek', 'Maya', 'Claude (MCP)', 'Mateusz Mitek (Operator)']) {
    assert.equal(isForbiddenAgentSender(ok), false, ok);
  }
});

test('formatAgentDisplayName nie przepuszcza podszywania', () => {
  assert.equal(formatAgentDisplayName('Mai'), 'Nadawca niezweryfikowany');
  assert.equal(formatAgentDisplayName('Iris'), 'Nadawca niezweryfikowany');
  assert.equal(formatAgentDisplayName('Maya'), 'Maya Mitek');
  assert.equal(formatAgentDisplayName('Bielik'), 'Bielik');
  assert.equal(formatAgentDisplayName('KomputerPokladowy'), 'Komputer pokładowy');
  assert.equal(formatAgentDisplayName('komputer pokladowy'), 'Komputer pokładowy');
  assert.equal(resolveAvatarProfileKey('Komputer pokładowy', 'KomputerPokladowy'), 'KomputerPokladowy');
});
