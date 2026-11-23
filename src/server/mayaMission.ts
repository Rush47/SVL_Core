// Misja ciągła Maya Mitek: analiza stanu systemu z PRAWDZIWYCH pomiarów (health, apex, agenci,
// logi WARN/ERROR), bezpieczne samonaprawy oraz propozycje zmian wymagających potwierdzenia
// Operatora. Planer jest czystą funkcją (testowalny) — wykonanie akcji i powiadomienia robi serwer.
//
// Zasady systemu SVL:
// - Bez zmyślonych danych: wszystkie wnioski wynikają z przekazanych pomiarów.
// - Operacje nieodwracalne (push GitHub, instalacja usługi, root-exec) NIE są wykonywane
//   automatycznie — trafiają do `proposals` z przyciskiem potwierdzenia.
// - Samonaprawy (`safeActions`) są odwracalne i bezpieczne (np. podłączenie workera, skan AV).

export type MissionSeverity = 'OK' | 'INFO' | 'WARN' | 'ALERT';

export interface MissionFinding {
  severity: MissionSeverity;
  category: string;
  title: string;
  detail: string;
}

/** Akcja naprawcza/rozwojowa, którą misja może wykonać sama (odwracalna, bezpieczna). */
export interface MissionSafeAction {
  id: string;
  title: string;
  /** Wewnętrzny rodzaj akcji wykonywanej przez serwer. */
  kind: 'reconnect_agents' | 'antivirus_scan' | 'warm_ollama' | 'generate_report';
  reason: string;
}

/** Propozycja wymagająca potwierdzenia Operatora (nieodwracalna/rozwojowa). */
export interface MissionProposal {
  id: string;
  title: string;
  detail: string;
  /** Akcja przycisku w czacie, np. `action:sync`, `tab:linux`, `send:...`. */
  action: string;
  actionLabel: string;
}

export interface MissionInput {
  ollamaReachable: boolean;
  geminiConfigured: boolean;
  diskFreeGb: number | null;
  ramAvailableMb: number | null;
  modules: Array<{ id?: string; status?: string }>;
  agents: Array<{ canonical_name?: string; status?: string }>;
  apex: {
    serviceStatus?: string;
    sentinelAvStatus?: string;
    lastAvScanAt?: string | null;
    distro?: string;
  };
  recentIssues: Array<{ level: string; category: string; message: string; at: string | null }>;
  github: { tokenPresent: boolean; lastSyncOk: boolean | null; lastSyncSummary: string | null };
  /** Tunel SSH do Ollamy statku SVL-364 (gdy włączony standardowy silnik ze statku). */
  shipOllama?: { enabled: boolean; status: string; description: string };
}

export interface MissionPlan {
  severity: MissionSeverity;
  headline: string;
  findings: MissionFinding[];
  safeActions: MissionSafeAction[];
  proposals: MissionProposal[];
  /** Skrót stanu — gdy się nie zmienia, nie wysyłamy nowego powiadomienia (brak spamu). */
  signature: string;
  reportMarkdown: string;
}

const SEVERITY_RANK: Record<MissionSeverity, number> = { OK: 0, INFO: 1, WARN: 2, ALERT: 3 };
const SEVERITY_ICON: Record<MissionSeverity, string> = { OK: '✅', INFO: 'ℹ️', WARN: '⚠️', ALERT: '🚨' };

function worst(a: MissionSeverity, b: MissionSeverity): MissionSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/** Grupuje wpisy WARN/ERROR z logów po kategorii, z liczbą wystąpień i przykładem. */
export function summarizeIssues(
  issues: MissionInput['recentIssues'],
): Array<{ category: string; count: number; errors: number; sample: string }> {
  const map = new Map<string, { count: number; errors: number; sample: string }>();
  for (const issue of issues) {
    const key = String(issue.category || 'system');
    const entry = map.get(key) || { count: 0, errors: 0, sample: String(issue.message || '').slice(0, 160) };
    entry.count += 1;
    if (String(issue.level).toUpperCase() === 'ERROR') entry.errors += 1;
    map.set(key, entry);
  }
  return [...map.entries()]
    .map(([category, v]) => ({ category, ...v }))
    .sort((a, b) => b.errors - a.errors || b.count - a.count);
}

export function buildMayaMissionPlan(input: MissionInput): MissionPlan {
  const findings: MissionFinding[] = [];
  const safeActions: MissionSafeAction[] = [];
  const proposals: MissionProposal[] = [];
  let severity: MissionSeverity = 'OK';
  const sigParts: string[] = [];

  // 1) Agenci ROOT — muszą być podłączeni, inaczej polecenia nie są przetwarzane.
  const offlineAgents = input.agents.filter(
    (a) => !String(a.status || '').toUpperCase().includes('ONLINE'),
  );
  if (input.agents.length > 0 && offlineAgents.length > 0) {
    severity = worst(severity, 'WARN');
    const names = offlineAgents.map((a) => a.canonical_name || '?').join(', ');
    findings.push({
      severity: 'WARN',
      category: 'agenci',
      title: `Agent poza trybem online: ${names}`,
      detail: 'Niepodłączony worker nie przetwarza poleceń — misja podłącza go ponownie.',
    });
    safeActions.push({
      id: 'reconnect_agents',
      title: 'Podłącz ponownie workery Bielik i Maya Mitek',
      kind: 'reconnect_agents',
      reason: `Agenci offline: ${names}`,
    });
    sigParts.push(`agents_offline:${names}`);
  }

  // 2) Dostępność modeli AI.
  if (!input.ollamaReachable && !input.geminiConfigured) {
    severity = worst(severity, 'ALERT');
    findings.push({
      severity: 'ALERT',
      category: 'ai',
      title: 'Brak dostępnego modelu AI',
      detail:
        'Ollama nie odpowiada, a klucz GEMINI_API_KEY nie jest ustawiony. Rozmowa z AI nie zadziała — ' +
        'ustaw OLLAMA_HOST na komputer z Ollamą albo GEMINI_API_KEY.',
    });
    sigParts.push('ai_none');
  } else if (!input.ollamaReachable) {
    findings.push({
      severity: 'INFO',
      category: 'ai',
      title: 'Ollama niedostępna — działa tylko Gemini',
      detail: 'Lokalny model Ollama nie odpowiada; odpowiedzi pochodzą z Gemini (limit klucza API).',
    });
    sigParts.push('ai_gemini_only');
  }

  // 2b) Ollama ze statku SVL-364 przez SSH (gdy ustawiona jako standardowy silnik).
  if (input.shipOllama?.enabled) {
    if (input.shipOllama.status === 'up') {
      findings.push({
        severity: 'OK',
        category: 'ollama-statek',
        title: 'Ollama ze statku SVL-364 aktywna (SSH)',
        detail: input.shipOllama.description,
      });
    } else {
      severity = worst(severity, 'WARN');
      findings.push({
        severity: 'WARN',
        category: 'ollama-statek',
        title: 'Tunel SSH do Ollamy statku nie działa',
        detail: input.shipOllama.description,
      });
      sigParts.push(`ship_ollama:${input.shipOllama.status}`);
    }
  }

  // 3) Zasoby hosta.
  if (typeof input.diskFreeGb === 'number' && input.diskFreeGb < 2) {
    severity = worst(severity, 'ALERT');
    findings.push({
      severity: 'ALERT',
      category: 'zasoby',
      title: `Mało miejsca na dysku: ${input.diskFreeGb.toFixed(1)} GB`,
      detail: 'Poniżej 2 GB — zapisy (SQLite WAL, logi, build) mogą się nie udać.',
    });
    sigParts.push('disk_low');
  }
  if (typeof input.ramAvailableMb === 'number' && input.ramAvailableMb < 512) {
    severity = worst(severity, 'WARN');
    findings.push({
      severity: 'WARN',
      category: 'zasoby',
      title: `Mało wolnej pamięci: ${Math.round(input.ramAvailableMb)} MB`,
      detail: 'Poniżej 512 MB — model Ollama lub build mogą zostać przerwane.',
    });
    sigParts.push('ram_low');
  }

  // 4) Antywirus — jeśli nigdy nie skanowano, misja uruchamia skan (bezpieczne, odwracalne).
  const avStatus = String(input.apex.sentinelAvStatus || '').toUpperCase();
  if (!input.apex.lastAvScanAt || avStatus.includes('NIE SKANOWANO')) {
    findings.push({
      severity: 'INFO',
      category: 'bezpieczeństwo',
      title: 'System nie był jeszcze skanowany antywirusowo',
      detail: 'Misja uruchamia pierwszy skan sygnatur, aby mieć realny punkt odniesienia.',
    });
    safeActions.push({
      id: 'antivirus_scan',
      title: 'Uruchom skan antywirusowy',
      kind: 'antivirus_scan',
      reason: 'Brak wcześniejszego skanu',
    });
    sigParts.push('av_never');
  }

  // 5) Błędy z logów (prawdziwe zdarzenia) → najwyższy priorytet dla naprawy.
  const grouped = summarizeIssues(input.recentIssues);
  const withErrors = grouped.filter((g) => g.errors > 0);
  if (withErrors.length > 0) {
    severity = worst(severity, 'WARN');
    for (const g of withErrors.slice(0, 4)) {
      findings.push({
        severity: 'WARN',
        category: `log:${g.category}`,
        title: `Błędy w logach (${g.category}): ${g.errors}×`,
        detail: g.sample,
      });
    }
    sigParts.push('log_errors:' + withErrors.map((g) => `${g.category}=${g.errors}`).join(','));
  }

  // 6) SVL CoreOS 2 jako usługa systemd — propozycja (instalacja jest nieodwracalna → potwierdzenie).
  const svc = String(input.apex.serviceStatus || '');
  if (/NIEZAINSTALOWANA|not installed|brak/i.test(svc)) {
    proposals.push({
      id: 'install_coreos2',
      title: 'Zainstaluj SVL CoreOS 2 jako usługę systemd',
      detail:
        'System działa, ale nie jako trwała usługa. Instalacja (install_coreos2_svl364.sh) wymaga roota ' +
        'i jest nieodwracalna — do decyzji Operatora.',
      action: 'tab:linux',
      actionLabel: '🐧 Wdrożenie Linux',
    });
    sigParts.push('svc_missing');
  }

  // 7) Synchronizacja z GitHubem — propozycja (push jest nieodwracalny → potwierdzenie).
  if (input.github.tokenPresent) {
    if (input.github.lastSyncOk === false) {
      severity = worst(severity, 'WARN');
      findings.push({
        severity: 'WARN',
        category: 'github',
        title: 'Ostatnia synchronizacja z GitHubem nie powiodła się',
        detail: String(input.github.lastSyncSummary || '').slice(0, 200) || 'Sprawdź token i połączenie.',
      });
      sigParts.push('gh_sync_fail');
    }
    proposals.push({
      id: 'github_sync',
      title: 'Synchronizuj repozytorium z GitHubem',
      detail: 'Pobranie i wysłanie zmian (push jest nieodwracalny) — na żądanie Operatora.',
      action: 'action:sync',
      actionLabel: '🔄 Synchronizuj',
    });
  }

  // 8) Rozwój systemu — zawsze jedna propozycja ulepszenia (pełny raport SVL_System do przeglądu).
  proposals.push({
    id: 'full_report',
    title: 'Przygotuj pełny raport SVL_System do przeglądu',
    detail: 'Szczegółowy przegląd jądra, modułów i telemetrii jako podstawa kolejnych usprawnień.',
    action: 'action:report',
    actionLabel: '📋 Raport SVL_System',
  });

  const activeModules = input.modules.filter((m) => String(m.status).toUpperCase() === 'ACTIVE').length;
  if (findings.length === 0) {
    findings.push({
      severity: 'OK',
      category: 'system',
      title: 'System sprawny — brak błędów w logach i zasobach',
      detail: `Aktywne moduły: ${activeModules}/${input.modules.length}. Misja kontynuuje nadzór.`,
    });
  }

  const headline =
    severity === 'OK'
      ? 'System sprawny — misja kontynuuje nadzór i rozwój'
      : severity === 'ALERT'
        ? 'Wykryto krytyczny problem — wymaga uwagi'
        : severity === 'WARN'
          ? 'Wykryto problemy do naprawy'
          : 'Drobne uwagi i propozycje usprawnień';

  const signature = `${severity}|${sigParts.sort().join('|')}`;
  const reportMarkdown = buildReportMarkdown(severity, headline, findings, safeActions, proposals, {
    activeModules,
    totalModules: input.modules.length,
  });

  return { severity, headline, findings, safeActions, proposals, signature, reportMarkdown };
}

function buildReportMarkdown(
  severity: MissionSeverity,
  headline: string,
  findings: MissionFinding[],
  safeActions: MissionSafeAction[],
  proposals: MissionProposal[],
  meta: { activeModules: number; totalModules: number },
): string {
  const lines: string[] = [];
  lines.push(`${SEVERITY_ICON[severity]} **Misja Maya Mitek — ${headline}**`);
  lines.push(
    `> Nadzór i rozwój systemu · moduły aktywne: ${meta.activeModules}/${meta.totalModules} · ` +
      `${new Date().toLocaleString('pl-PL')}`,
  );
  lines.push('');
  lines.push('**Ustalenia (z pomiarów i logów):**');
  for (const f of findings) {
    lines.push(`- ${SEVERITY_ICON[f.severity]} **${f.title}** — ${f.detail}`);
  }
  if (safeActions.length > 0) {
    lines.push('');
    lines.push('**Samonaprawy wykonywane automatycznie (odwracalne):**');
    for (const a of safeActions) lines.push(`- 🔧 ${a.title} — ${a.reason}`);
  }
  if (proposals.length > 0) {
    lines.push('');
    lines.push('**Propozycje do decyzji Operatora (nieodwracalne — czekają na potwierdzenie):**');
    for (const p of proposals) lines.push(`- 🧩 ${p.title} — ${p.detail}`);
    lines.push('');
    lines.push(proposals.map((p) => `[btn: ${p.actionLabel}|${p.action}]`).join(' '));
  }
  return lines.join('\n');
}
