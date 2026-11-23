import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTextActionProtocol,
  extractTextActions,
  formatActionReceipt,
  isSystemCommandRequest,
  renderActionReceipts,
  toJsonSchema,
} from './chatActions.ts';
import { workspaceUiCommand } from './chatDirectives.ts';

const TOOLS = ['svl_workspace_ui', 'svl_module_upsert', 'svl_system_status'];

test('isSystemCommandRequest rozumie polskie litery na końcu słów', () => {
  // Stary regex z \b nie pasował do „zmień”, „usuń”, „moduł”, „sprawdź”.
  assert.equal(isSystemCommandRequest('zmień kolor na amber'), true);
  assert.equal(isSystemCommandRequest('usuń moduł radar'), true);
  assert.equal(isSystemCommandRequest('sprawdź'), true);
  assert.equal(isSystemCommandRequest('przełącz motyw na ciemny'), true);
  assert.equal(isSystemCommandRequest('otwórz zakładkę terminale'), true);
  assert.equal(isSystemCommandRequest('Pokaż rejestr floty Jyn'), true);
  assert.equal(isSystemCommandRequest('uruchom diagnostykę infrastruktury'), true);
  assert.equal(isSystemCommandRequest('odblokuj kernel Debiana i zrestartuj usługę'), true);
  assert.equal(isSystemCommandRequest('przeanalizuj kod i uruchom testy'), true);
  assert.equal(isSystemCommandRequest('zbuduj nowy plik w repozytorium git'), true);
  assert.equal(isSystemCommandRequest('Cześć, jak się masz'), false);
  assert.equal(isSystemCommandRequest('dobranoc'), false);
});

test('extractTextActions wycina bloki <svl_action> i zostawia znaczniki', () => {
  const reply =
    'Już zmieniam.\n<svl_action>{"tool":"svl_workspace_ui","args":{"setting":"gui_theme","value":"emerald"}}</svl_action>\nGotowe.';
  const out = extractTextActions(reply, TOOLS);
  assert.deepEqual(out.actions, [{ tool: 'svl_workspace_ui', args: { setting: 'gui_theme', value: 'emerald' } }]);
  assert.match(out.text, /\{\{svl_action:0\}\}/);
  assert.doesNotMatch(out.text, /svl_action>/);
});

test('extractTextActions akceptuje warianty pól i bloki ```json', () => {
  const reply = [
    '```json',
    '{"name": "svl_module_upsert", "arguments": "{\\"id\\":\\"radar\\",\\"status\\":\\"ACTIVE\\"}"}',
    '```',
    "<svl_action>{'tool':'svl_system_status','args':{},}</svl_action>",
  ].join('\n');
  const out = extractTextActions(reply, TOOLS);
  assert.deepEqual(out.actions.map((a) => a.tool).sort(), ['svl_module_upsert', 'svl_system_status']);
  const mod = out.actions.find((a) => a.tool === 'svl_module_upsert');
  assert.deepEqual(mod?.args, { id: 'radar', status: 'ACTIVE' });
});

test('extractTextActions ignoruje nieznane narzędzia i zwykły JSON', () => {
  const plain = 'Przykład: ```json\n{"a": 1}\n```';
  assert.equal(extractTextActions(plain, TOOLS).actions.length, 0);
  assert.equal(extractTextActions(plain, TOOLS).text, plain);
  const unknown = '<svl_action>{"tool":"rm_rf","args":{}}</svl_action>';
  const out = extractTextActions(unknown, TOOLS);
  assert.equal(out.actions.length, 0);
  assert.equal(out.text, '');
});

test('extractTextActions respektuje limit akcji', () => {
  const block = '<svl_action>{"tool":"svl_system_status","args":{}}</svl_action>';
  const out = extractTextActions(block.repeat(20), TOOLS, 3);
  assert.equal(out.actions.length, 3);
});

test('renderActionReceipts wstawia wyniki w miejsce bloków', () => {
  const out = extractTextActions(
    'A <svl_action>{"tool":"svl_system_status","args":{}}</svl_action> B',
    TOOLS,
  );
  const text = renderActionReceipts(out.text, [formatActionReceipt('svl_system_status', { ok: true, summary: 'Stan OK' })]);
  assert.match(text, /^A\s+✅ `svl_system_status`: Stan OK\s+B$/u);
  assert.match(formatActionReceipt('x', { ok: false, error: 'brak' }), /^❌ `x`: brak$/u);
});

test('buildTextActionProtocol opisuje protokół i parametry narzędzi', () => {
  const prompt = buildTextActionProtocol([
    {
      name: 'svl_workspace_ui',
      description: 'Zmienia interfejs',
      parameters: {
        properties: { setting: { type: 'STRING', enum: ['gui_theme', 'gui_accent'] }, value: { type: 'STRING' } },
        required: ['setting', 'value'],
      },
    },
  ]);
  assert.match(prompt, /<svl_action>/);
  assert.match(prompt, /svl_workspace_ui\(setting: tekst = gui_theme\|gui_accent, value: tekst\)/);
});

test('toJsonSchema zamienia typy Gemini na JSON Schema', () => {
  const schema = {
    type: 'OBJECT',
    properties: { tags: { type: 'ARRAY', items: { type: 'STRING' } }, n: { type: 'NUMBER' } },
    required: ['n'],
  };
  assert.deepEqual(toJsonSchema(schema), {
    type: 'object',
    properties: { tags: { type: 'array', items: { type: 'string' } }, n: { type: 'number' } },
    required: ['n'],
  });
  assert.equal(schema.type, 'OBJECT');
});

test('workspaceUiCommand normalizuje ustawienia interfejsu z narzędzia', () => {
  assert.deepEqual(workspaceUiCommand('gui_theme', 'zielony'), { kind: 'ui_set', key: 'gui_theme', value: 'emerald' });
  assert.deepEqual(workspaceUiCommand('motyw', 'Violet'), { kind: 'ui_set', key: 'gui_theme', value: 'violet' });
  assert.deepEqual(workspaceUiCommand('akcent', 'amber'), { kind: 'ui_set', key: 'gui_accent', value: 'amber' });
  assert.deepEqual(workspaceUiCommand('panel', 'terminals'), {
    kind: 'ui_set',
    key: 'active_workspace_tab',
    value: 'terminals',
  });
  assert.deepEqual(workspaceUiCommand('zakładka', 'SVL-364'), {
    kind: 'ui_set',
    key: 'active_workspace_tab',
    value: 'svl364',
  });
  assert.equal(workspaceUiCommand('gui_theme', 'różowy'), null);
  assert.equal(workspaceUiCommand('font', 'arial'), null);
});
