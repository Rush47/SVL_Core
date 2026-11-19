import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMayaMissionPlan, summarizeIssues, type MissionInput } from './mayaMission.ts';

const base: MissionInput = {
  ollamaReachable: false,
  geminiConfigured: true,
  diskFreeGb: 30,
  ramAvailableMb: 15000,
  modules: [{ id: 'a', status: 'ACTIVE' }, { id: 'b', status: 'ACTIVE' }],
  agents: [
    { canonical_name: 'Bielik', status: 'ONLINE_LOCAL_WORKER' },
    { canonical_name: 'Maya', status: 'ONLINE_LOCAL_WORKER' },
  ],
  apex: { serviceStatus: 'AKTYWNA', sentinelAvStatus: 'OK', lastAvScanAt: '2026-11-19T10:00:00Z', distro: 'Debian 13' },
  recentIssues: [],
  github: { tokenPresent: false, lastSyncOk: null, lastSyncSummary: null },
};

test('system sprawny → OK, ale zawsze jest propozycja rozwoju (raport)', () => {
  const plan = buildMayaMissionPlan(base);
  assert.equal(plan.severity, 'OK');
  assert.ok(plan.proposals.some((p) => p.id === 'full_report'));
  assert.equal(plan.safeActions.length, 0);
});

test('agent offline → samonaprawa reconnect i WARN', () => {
  const plan = buildMayaMissionPlan({
    ...base,
    agents: [{ canonical_name: 'Bielik', status: 'DISCONNECTED' }, { canonical_name: 'Maya', status: 'ONLINE_LOCAL_WORKER' }],
  });
  assert.equal(plan.severity, 'WARN');
  assert.ok(plan.safeActions.some((a) => a.kind === 'reconnect_agents'));
});

test('brak Ollamy i Gemini → ALERT brak modelu AI', () => {
  const plan = buildMayaMissionPlan({ ...base, ollamaReachable: false, geminiConfigured: false });
  assert.equal(plan.severity, 'ALERT');
  assert.ok(plan.findings.some((f) => f.category === 'ai' && f.severity === 'ALERT'));
});

test('brak skanu AV → samonaprawa antivirus_scan', () => {
  const plan = buildMayaMissionPlan({ ...base, apex: { ...base.apex, lastAvScanAt: null, sentinelAvStatus: 'NIE SKANOWANO' } });
  assert.ok(plan.safeActions.some((a) => a.kind === 'antivirus_scan'));
});

test('błędy w logach podnoszą severity i trafiają do ustaleń', () => {
  const plan = buildMayaMissionPlan({
    ...base,
    recentIssues: [
      { level: 'ERROR', category: 'ai_chat', message: 'coś padło', at: null },
      { level: 'ERROR', category: 'ai_chat', message: 'znów', at: null },
      { level: 'WARN', category: 'github', message: 'uwaga', at: null },
    ],
  });
  assert.equal(plan.severity, 'WARN');
  assert.ok(plan.findings.some((f) => f.category === 'log:ai_chat'));
});

test('usługa niezainstalowana i token GitHub → propozycje (nie samonaprawy)', () => {
  const plan = buildMayaMissionPlan({
    ...base,
    apex: { ...base.apex, serviceStatus: 'NIEZAINSTALOWANA jako usługa' },
    github: { tokenPresent: true, lastSyncOk: true, lastSyncSummary: 'ok' },
  });
  assert.ok(plan.proposals.some((p) => p.id === 'install_coreos2'));
  assert.ok(plan.proposals.some((p) => p.id === 'github_sync'));
  // Instalacja i push nie mogą być samonaprawami.
  assert.ok(!plan.safeActions.some((a) => (a.kind as string) === 'install_coreos2'));
});

test('sygnatura zmienia się wraz ze stanem (do deduplikacji powiadomień)', () => {
  const a = buildMayaMissionPlan(base).signature;
  const b = buildMayaMissionPlan({ ...base, diskFreeGb: 1 }).signature;
  assert.notEqual(a, b);
});

test('summarizeIssues grupuje po kategorii i liczy błędy', () => {
  const g = summarizeIssues([
    { level: 'ERROR', category: 'x', message: 'm1', at: null },
    { level: 'WARN', category: 'x', message: 'm2', at: null },
    { level: 'ERROR', category: 'y', message: 'm3', at: null },
  ]);
  assert.equal(g[0].category, 'x');
  assert.equal(g.find((e) => e.category === 'x')?.count, 2);
  assert.equal(g.find((e) => e.category === 'x')?.errors, 1);
});
