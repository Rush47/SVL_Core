import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANONICAL_AGENTS,
  buildChatHistoryPayload,
  calculateCompactMetricC,
  compactifyValue,
  formatAgentDisplayName,
  getGitHubAgentPermissions,
  getSvlCodexAccessToken,
  getSvlOperatorAccessToken,
  guardUnverifiedMissionCompletion,
  hasSvlCodexAccessToken,
  hasSvlOperatorAccessToken,
  isUnsafeChatInteractiveAction,
  mergeConversationThreads,
  normalizeAgentCanonicalName,
  parseBielikChatCommand,
  parseSshShipTerminalInput,
  extractBielikActionTags,
  parseChatInteractiveToken,
  resolveAvatarProfileKey,
  safeParseJsonResponse,
  selectNextDuplexSpeaker,
  selectOllamaModelName,
  setSvlCodexAccessToken,
  setSvlOperatorAccessToken,
  validateOllamaHostUrl,
  validateOperatorTokenFormat,
} from './svlLogic';

test('GitHub agent scopes distinguish read access from sync-branch writes', () => {
  assert.deepEqual(getGitHubAgentPermissions(['github.read']), {
    read: true,
    writeSync: false,
  });
  assert.deepEqual(getGitHubAgentPermissions(['github.read', 'github.write_sync']), {
    read: true,
    writeSync: true,
  });
  assert.deepEqual(getGitHubAgentPermissions(undefined), {
    read: false,
    writeSync: false,
  });
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

test('CANONICAL_AGENTS configures Bielik and Maya on llama3.2-vision:11b while keeping Agata Mitek removed', () => {
  assert.deepEqual(
    CANONICAL_AGENTS.map((a) => ({ name: a.canonicalName, profile: a.sourceProfile })),
    [
      { name: 'Bielik', profile: 'ollama:llama3.2-vision:11b' },
      { name: 'Maya', profile: 'ollama:llama3.2-vision:11b' },
    ],
  );
  assert.equal(normalizeAgentCanonicalName('Agata'), null);
  assert.equal(normalizeAgentCanonicalName('Agata Mitek'), null);
  assert.equal(normalizeAgentCanonicalName('bielik'), 'Bielik');
  assert.equal(normalizeAgentCanonicalName('conv-agent-bielik'), 'Bielik');
  assert.equal(normalizeAgentCanonicalName('maya'), 'Maya');
  assert.equal(normalizeAgentCanonicalName('conv-agent-maya'), 'Maya');
  assert.equal(formatAgentDisplayName('Agata Mitek'), 'Asystent SVL');
  assert.equal(formatAgentDisplayName('Iris AI'), 'Asystent SVL');
  assert.equal(formatAgentDisplayName('bielik ai'), 'Bielik');
  assert.equal(formatAgentDisplayName('maya ai'), 'Maya');
  assert.equal(selectNextDuplexSpeaker(['Mateusz Mitek']), 'Bielik');
  assert.equal(selectNextDuplexSpeaker(['Bielik']), 'Maya');
  assert.equal(selectNextDuplexSpeaker(['Maya']), 'Bielik');
  assert.equal(resolveAvatarProfileKey('Agata Mitek', 'Agata'), null);
  assert.equal(resolveAvatarProfileKey('Bielik', 'bielik'), 'Bielik');
  assert.equal(resolveAvatarProfileKey('Maya', 'maya'), 'Maya');
  assert.equal(resolveAvatarProfileKey('Iris AI', 'iris'), null);
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

test('selectOllamaModelName honors explicit selection and prefers llama3.2-vision:11b when available', () => {
  const models = [
    { name: 'dolphin-qwen2.5:32b', vision_supported: false },
    { name: 'llama3.2-vision:11b', vision_supported: true },
  ];
  assert.equal(selectOllamaModelName('ollama:dolphin-qwen2.5:32b', models, false), 'dolphin-qwen2.5:32b');
  assert.equal(selectOllamaModelName('svl-hybrid-router', models, true), 'llama3.2-vision:11b');
  assert.equal(selectOllamaModelName('svl-hybrid-router', models, false), 'llama3.2-vision:11b');
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

test('operator and codex access tokens stay strictly in memory', () => {
  const prevOp = getSvlOperatorAccessToken();
  const prevCodex = getSvlCodexAccessToken();
  try {
    setSvlOperatorAccessToken('');
    setSvlCodexAccessToken('');
    assert.equal(hasSvlOperatorAccessToken(), false);
    assert.equal(hasSvlCodexAccessToken(), false);

    setSvlOperatorAccessToken('op_secret_token_32_characters_minimum_xyz');
    setSvlCodexAccessToken('codex_scoped_token_12345');
    assert.equal(hasSvlOperatorAccessToken(), true);
    assert.equal(hasSvlCodexAccessToken(), true);
    assert.equal(getSvlCodexAccessToken(), 'codex_scoped_token_12345');
  } finally {
    setSvlOperatorAccessToken(prevOp);
    setSvlCodexAccessToken(prevCodex);
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

