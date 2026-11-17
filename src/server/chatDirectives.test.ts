import assert from 'node:assert/strict';
import test from 'node:test';
import { commandKey, isMutatingCommand, parseChatDirectives } from './chatDirectives.ts';

const knownModules = [
  { id: 'svl-364', name: 'SVL-364 — Centrum Dowodzenia', kind: 'Orchestration & Command Center', description: 'Statek' },
  { id: 'svl-radar', name: 'Radar dalekiego zasięgu', kind: 'Sensor', description: 'Radar' },
];

test('slash commands are parsed exactly as before', () => {
  assert.deepEqual(parseChatDirectives('/pamiec dodaj kawa bez cukru'), [
    { kind: 'memory_save', memoryKind: 'fact', content: 'kawa bez cukru' },
  ]);
  assert.deepEqual(parseChatDirectives('/nieznane polecenie'), []);
});

test('natural memory directives save the remaining content', () => {
  assert.deepEqual(parseChatDirectives('Zapisz w pamięci że reaktor ma pracować na 80%.'), [
    { kind: 'memory_save', memoryKind: 'fact', content: 'reaktor ma pracować na 80%' },
  ]);
  assert.deepEqual(parseChatDirectives('Bielik, zapamiętaj: Operator pije kawę o 7:00'), [
    { kind: 'memory_save', memoryKind: 'fact', content: 'Operator pije kawę o 7:00' },
  ]);
  assert.deepEqual(parseChatDirectives('Pamiętaj, że lubię czarną herbatę'), [
    { kind: 'memory_save', memoryKind: 'fact', content: 'lubię czarną herbatę' },
  ]);
  assert.deepEqual(parseChatDirectives('Pamiętaj sobie: kod alarmu to 364'), [
    { kind: 'memory_save', memoryKind: 'fact', content: 'kod alarmu to 364' },
  ]);
  assert.deepEqual(parseChatDirectives('Co pamiętasz?'), [{ kind: 'memory_list' }]);
});

test('module status change keeps existing metadata and requires a known module', () => {
  const [cmd] = parseChatDirectives('Ustaw moduł svl-radar na STANDBY', { knownModules });
  assert.deepEqual(cmd, {
    kind: 'module_upsert',
    id: 'svl-radar',
    status: 'STANDBY',
    name: 'Radar dalekiego zasięgu',
    description: 'Radar',
    moduleKind: 'Sensor',
    preserveExisting: true,
  });
  assert.equal(parseChatDirectives('Aktywuj moduł `svl-364`', { knownModules })[0]?.kind, 'module_upsert');
  assert.equal((parseChatDirectives('Wyłącz moduł svl-364', { knownModules })[0] as any)?.status, 'STANDBY');
  // Unknown module ids are never created by a status-change sentence.
  assert.deepEqual(parseChatDirectives('Ustaw moduł radaru na standby', { knownModules }), []);
});

test('explicit module creation registers a new active module', () => {
  assert.deepEqual(parseChatDirectives('Utwórz nowy moduł svl-sonar sonar dalekiego zasięgu', { knownModules }), [
    {
      kind: 'module_upsert',
      id: 'svl-sonar',
      status: 'ACTIVE',
      name: 'svl-sonar',
      description: 'sonar dalekiego zasięgu',
    },
  ]);
});

test('other natural directives map to existing command kinds', () => {
  assert.deepEqual(parseChatDirectives('Sprawdź status Ollama'), [{ kind: 'ollama' }]);
  assert.deepEqual(parseChatDirectives('pokaż status systemu'), [{ kind: 'status' }]);
  assert.deepEqual(parseChatDirectives('Pokaż wszystkie moduły'), [{ kind: 'modules_list' }]);
  assert.deepEqual(parseChatDirectives('Podłącz workera Bielik'), [{ kind: 'agent_connect' }]);
  assert.deepEqual(parseChatDirectives('Zleć zadanie: Kalibracja tarcz | sprawdź QKD'), [
    { kind: 'agent_task', title: 'Kalibracja tarcz', payload: 'sprawdź QKD' },
  ]);
  assert.deepEqual(parseChatDirectives('Wykonaj polecenie `uptime`'), [{ kind: 'root_exec', command: 'uptime' }]);
});

test('ordinary conversation produces no directives', () => {
  for (const msg of [
    'Jak się masz?',
    'Wyjaśnij mi jak działa pamięć długotrwała',
    'Skonfiguruj mi plan dnia',
    'Maya, ustaw kurs na Marsa',
    'Uruchom polecenie uptime',
  ]) {
    assert.deepEqual(parseChatDirectives(msg, { knownModules }), [], msg);
  }
});

test('memory content is not re-parsed as another directive', () => {
  assert.deepEqual(parseChatDirectives('Zapamiętaj że trzeba wyłączyć moduł svl-radar', { knownModules }), [
    { kind: 'memory_save', memoryKind: 'fact', content: 'trzeba wyłączyć moduł svl-radar' },
  ]);
});

test('mutation classification and dedup keys', () => {
  assert.equal(isMutatingCommand({ kind: 'status' }), false);
  assert.equal(isMutatingCommand({ kind: 'memory_save', memoryKind: 'fact', content: 'x' }), true);
  assert.equal(
    commandKey({ kind: 'agent_connect' }),
    commandKey({ kind: 'agent_connect' }),
  );
});
