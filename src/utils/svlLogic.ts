/**
 * Pure deterministic logic for SVL Python OS (Open WebUI Frontend & Verification Suite)
 * Mirrors the Python backend's TopologicalInfinityEngine and command parsers.
 */

import { trackGuiApiCall } from './guiLogger';

export interface CanonicalAgentMeta {
  id: string;
  canonicalName: string;
  displayName: string;
  slug: string;
  preservedRole: string;
  sourceProfile: string;
  accentHex: string;
  borderClass: string;
  textClass: string;
}

export const CANONICAL_AGENTS: CanonicalAgentMeta[] = [
  {
    id: 'bielik',
    canonicalName: 'Bielik',
    displayName: 'Bielik',
    slug: 'bielik',
    preservedRole:
    'Polskojęzyczne AI do przetwarzania poleceń na lokalnym modelu Ollama dolphin-llama3:8b-v2.9-q2_K uncensored (ROOT).',
    sourceProfile: 'ollama:dolphin-llama3:8b-v2.9-q2_K',
    accentHex: '#F59E0B',
    borderClass: 'border-amber-500/40',
    textClass: 'text-amber-300',
  },
  {
    id: 'maya',
    canonicalName: 'Maya',
    displayName: 'Maya Mitek',
    slug: 'maya',
    preservedRole:
      'Sztuczna Inteligencja Pokładowa Statku SVL-364 Ebon Apex (ROOT) zbudowana w oparciu o bazy danych SVL-364 oraz notatki i prace Operatora Mateusza Mitka.',
    sourceProfile: 'ollama:dolphin-llama3:8b-v2.9-q2_K',
    accentHex: '#22D3EE',
    borderClass: 'border-cyan-500/40',
    textClass: 'text-cyan-300',
  },
];

export function formatAgentDisplayName(rawName?: string | null): string {
  const clean = String(rawName || '').trim();
  if (!clean) return 'SVL System Kernel';
  const low = clean.toLowerCase();
  if (low === 'bielik' || low === 'bielik ai') return 'Bielik';
  if (
    low === 'maya' ||
    low === 'maya ai' ||
    low === 'maya svl-364' ||
    low === 'maya mitek' ||
    low === 'maya mitek ai' ||
    low === 'maya mitek svl-364'
  ) {
    return 'Maya Mitek';
  }
  if (
    low === 'komputer pokładowy' ||
    low === 'komputer pokladowy' ||
    low === 'komputer' ||
    low === 'komputerpokladowy' ||
    low === 'svl-364 komputer pokładowy'
  ) {
    return 'Komputer pokładowy';
  }
  if (
    low === 'system_si_1' ||
    low === 'system-si-1' ||
    low === 'systemsi1' ||
    low === 'system si 1' ||
    low === 'system_si' ||
    low === 'system-si' ||
    low === 'system si'
  ) {
    return 'System_SI_1';
  }
  if (low === 'all' || low === 'rodzina mitek' || low === 'rodzina mitek (wszyscy)') {
    return 'Rodzina Mitek (wszyscy)';
  }
  // Ochrona anty-podszywanie: nazwy udające agentów AL/wyłączone persony nie są wyświetlane jako AI.
  if (isForbiddenAgentSender(clean)) return 'Nadawca niezweryfikowany';
  return clean;
}

/** Wyłączone persony AI i jawne podszywania pod Bielika/Maye (np. „Mai”, „Iris”). */
const FORBIDDEN_AGENT_SENDERS = new Set([
  'iris', 'iris ai', 'agata', 'agata mitek', 'aria', 'aria mitek', 'alex', 'alex mitek',
  'astyria', 'astyria mitek', 'aurelius', 'aurelius mitek',
  'mai', 'mai mitek', 'mai ai', 'maja', 'maja mitek', 'system svl',
]);

function foldConfusable(name: string): string {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[4@]/g, 'a').replace(/0/g, 'o').replace(/3/g, 'e').replace(/1/g, 'i').replace(/[5$]/g, 's')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isForbiddenAgentSender(name?: string | null): boolean {
  const low = String(name || '').trim().toLowerCase();
  return FORBIDDEN_AGENT_SENDERS.has(low) || FORBIDDEN_AGENT_SENDERS.has(foldConfusable(name || ''));
}

export function getGitHubAgentPermissions(rawScopes: unknown): { read: boolean; writeSync: boolean; admin: boolean } {
  const scopes = new Set(
    Array.isArray(rawScopes) ? rawScopes.map((scope) => String(scope).trim().toLowerCase()) : [],
  );
  const admin = scopes.has('github.admin');
  return {
    read: admin || scopes.has('github.read'),
    writeSync: admin || scopes.has('github.write_sync'),
    // Administracja (usuwanie, ustawienia, dostęp) — zawsze po potwierdzeniu operatora.
    admin,
  };
}

/**
 * Czy wiadomość dotyczy GitHuba (repozytorium, commity, PR, zgłoszenia, gałęzie, synchronizacja)?
 * Tylko wtedy czat dołącza narzędzia GitHub — inaczej zwykła rozmowa idzie do Ollamy
 * i może korzystać z wyszukiwania w internecie.
 */
// Granice słów zgodne z polskimi literami (`\b` w JS traktuje „ę”, „ś” jako nie-litery).
const githubChatPattern =
  /(?<![\p{L}\p{N}_])(?:github\p{L}*|gh(?=\s)|svl[_-]core|repo|repozytori\p{L}*|commit\p{L}*|komit\p{L}*|pull\s*request\p{L}*|issue\p{L}*|branch\p{L}*|gałę\p{L}*|gałąź|main|wypchnij|wypchnąć|push\p{L}*|merge\p{L}*|scal\p{L}*|workflow\p{L}*|release\p{L}*)(?![\p{L}\p{N}_])/iu;
// Skróty wielkimi literami („PR #12”, „CI”) — bez ignorowania wielkości liter, by nie łapać „pr”/„ci”.
const githubAcronymPattern = /(?<![\p{L}\p{N}_])(?:PR|CI)(?![\p{L}\p{N}_])/u;

export function isGitHubChatRequest(text: string): boolean {
  const value = String(text || '');
  return githubChatPattern.test(value) || githubAcronymPattern.test(value);
}

const missionContextPattern = /\b(?:misj|procedur|operacj)\p{L}*/iu;
const unverifiedMissionCompletionPatterns = [
  /\b(?:misja|misję|procedura|procedurę|operacja|operację)\s+(?:(?:został[ay]?\s+|jest\s+)?(?:już\s+)?(?:pomyślnie\s+)?)(?:zakończon\p{L}*|ukończon\p{L}*|wykonan\p{L}*|zrealizowan\p{L}*)\b/iu,
  /\b(?:cał\p{L}*\s+)?(?:misj\p{L}*|procedur\p{L}*|operacj\p{L}*)(?:\s+misj\p{L}*)?\s+dobiegł\p{L}*\s+(?:już\s+)?(?:do\s+)?końca\b/iu,
  /\b(?:wykonał[ae]m|zrealizował[ae]m|zakończył[ae]m|ukończył[ae]m)\s+(?:już\s+)?(?:cał\p{L}*\s+)?(?:misj\p{L}*|procedur\p{L}*|operacj\p{L}*)\b/iu,
  /\b(?:wszystkie|całe)\s+(?:kroki|etapy|fazy)\s+(?:misji\s+)?(?:zostały|są)\s+(?:już\s+)?(?:zakończon\p{L}*|ukończon\p{L}*|wykonan\p{L}*|zrealizowan\p{L}*)\b/iu,
  /\b(?:the\s+)?(?:mission|procedure|operation)s?\s+(?:(?:is|was|has|have)\s+(?:been\s+)?|are\s+)?(?:successfully\s+)?(?:completed|finished|concluded|done)\b/iu,
  /\b(?:i\s+)?(?:completed|finished|concluded)\s+(?:the\s+)?(?:mission|procedure|operation)s?\b/iu,
  /\b(?:all\s+)?(?:mission\s+)?(?:steps|stages|phases)\s+(?:are|have\s+been|were)\s+(?:fully\s+)?(?:completed|finished|done)\b/iu,
];

export const UNVERIFIED_MISSION_STATUS_REPLY =
  '⚠️ **Status misji: NIEZWERYFIKOWANY.** System nie ma rejestru misji ani potwierdzeń wykonania jej kroków. Wygenerowanie odpowiedzi AI lub status „COMPLETED” zadania agenta oznacza tylko gotową odpowiedź, nie zakończenie procedury. Nie mogę potwierdzić, że misja dobiegła końca. Prześlij checklistę i wyniki z wiarygodnego źródła, a pomogę sprawdzić każdy krok.';

export function guardUnverifiedMissionCompletion(context: string, answer: string): string {
  if (
    !missionContextPattern.test(context) ||
    !unverifiedMissionCompletionPatterns.some((pattern) => pattern.test(answer))
  ) {
    return answer;
  }
  return UNVERIFIED_MISSION_STATUS_REPLY;
}

/**
 * Model twierdzi, że coś WYKONAŁ (zainstalował, naprawił, zmienił, uruchomił, wdrożył, zrestartował,
 * sprawdził na żywo, zakończył „100%”), a serwer nie wykonał żadnej operacji → zwraca notatkę ostrzegawczą.
 * Nie uruchamia się, gdy zdanie jest jawnym zaprzeczeniem (np. „nie wykonałem”, „nie uruchomiłem”).
 */
const UNVERIFIED_EXECUTION_CLAIM = new RegExp(
  [
    String.raw`(?<![\p{L}\p{N}_])(?:zainstalowa[łn]|wdroży[łl]|wdrożon|skompilowa[łn]|zbudowa[łn]|podmienio|zsynchronizowa[łn]|uruchomi[łl]|uruchomion|aktywowa[łn]|wykona[łn]|zrealizowa[łn]|zakończon|ukończon|naprawi[łl]|naprawion|zmieni[łl]|zmienion|zaktualizowa[łn]|zaktualizowan|zapisa[łl]|zapisan|usun[ąa][łl]|usunięt|utworzy[łl]|utworzon|wyłączy[łl]|wyłączon|włączy[łl]|włączon|zrestartowa[łn]|zrestartowan|wyczyści[łl]|wyczyszczon|przeprowadzi[łl])\p{L}*`,
    String.raw`(?<![\p{L}\p{N}_])(?:właśnie|natychmiast|od\s*razu)\s+(?:został[aoiy]?\s+)?(?:wykonan|naprawion|zmienion|zapisan|zaktualizowan|uruchomion|zsynchronizowan|zrestartowan|usunięt|zakończon)\p{L}*`,
    String.raw`(?<![\p{L}\p{N}_])(?:podmian\p{L}*|instalacj\p{L}*|debootstrap\p{L}*|kompilacj\p{L}*|wdrożeni\p{L}*|synchronizacj\p{L}*|napraw\p{L}*)[^.\n]{0,40}(?<![\p{L}\p{N}_])(?:zakończ|wykonan|aktywn|ukończ|gotow)\p{L}*`,
    String.raw`(?<![\p{L}\p{N}_])(?:status|postęp|progress)\b[^.\n]{0,30}\b100\s?%`,
  ].join('|'),
  'iu',
);

const UNVERIFIED_UPPERCASE_STATUS_CLAIM = /\b(?:ONLINE|ACTIVE_HOT_SWAPPED|COMPLETED_100_PERCENT)\b/;

const NEGATED_CLAIM_RE =
  /(?<![\p{L}\p{N}_])nie\s+(?:został[aoiy]?\s+)?(?:wykona[łl]\p{L}*|uruchomi[łl]\p{L}*|zmieni[łl]\p{L}*|naprawi[łl]\p{L}*|zainstalowa[łl]\p{L}*|zaktualizowa[łl]\p{L}*|zsynchronizowa[łl]\p{L}*|zrestartowa[łl]\p{L}*|zapisa[łl]\p{L}*|usun[ąa][łl]\p{L}*|utworzy[łl]\p{L}*|wyłączy[łl]\p{L}*|włączy[łl]\p{L}*|przeprowadzi[łl]\p{L}*|wykonan\p{L}*|naprawion\p{L}*|zmienion\p{L}*|uruchomion\p{L}*|mogę\s+potwierdzić)/iu;

export const UNVERIFIED_EXECUTION_BANNER =
  '> ⚠️ **Weryfikacja SVL (brak wykonanej akcji na serwerze):** Ta wypowiedź jest wyłącznie tekstem modelu AI — serwer nie wykonał żadnej operacji, zmiany plików ani sprawdzenia na żywo w tej turze.';

export function unverifiedExecutionNote(answer: string, verifiedActionsCount: number): string | null {
  if (verifiedActionsCount > 0) return null;
  // Ignorujemy znaczniki interaktywne [card:...] / [btn:...] oraz wiersze tabel podsumowujących Markdown (`| ... |`),
  // żeby etykiety UI i podsumowania stanu nie wywoływały fałszywego alarmu w swobodnej rozmowie.
  const withoutTables = String(answer || '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('|'))
    .join('\n');
  const text = withoutTables.replace(/\[(?:card|karta|btn|button|action|przycisk):[^\]\n]+\]/gi, ' ');
  // Sprawdź każde zdanie/linię osobno — zaprzeczone zdanie („Nie wykonałem tej operacji”) nie jest halucynacją.
  const segments = text.split(/(?<=[.!?])\s+|\n+/);
  const hasFabricatedClaim = segments.some((seg) => {
    const trimmed = seg.trim();
    if (!trimmed) return false;
    if (NEGATED_CLAIM_RE.test(trimmed)) return false;
    return UNVERIFIED_EXECUTION_CLAIM.test(trimmed) || UNVERIFIED_UPPERCASE_STATUS_CLAIM.test(trimmed);
  });
  if (!hasFabricatedClaim) return null;
  return 'Model opisuje wykonane działanie, ale serwer nie wykonał żadnej operacji — to tylko tekst modelu. Sprawdź faktyczny stan w panelu lub logach.';
}

export function enforceFactualExecutionGuard(
  answer: string,
  verifiedActionsCount: number,
): { reply: string; verificationNote: string | null } {
  const cleanedAnswer = String(answer || '')
    .replace(
      /^(?:>\s*)?(?:⚠️|✅)\s*\*?\*?Weryfikacja SVL\s*\([^)\n]*\)\s*[:：]?\*?\*?[^\n]*\n*/gim,
      '',
    )
    .trim();
  const note = unverifiedExecutionNote(cleanedAnswer, verifiedActionsCount);
  if (!note) {
    return { reply: cleanedAnswer, verificationNote: null };
  }
  return {
    reply: `${UNVERIFIED_EXECUTION_BANNER}\n\n${cleanedAnswer}`,
    verificationNote: note,
  };
}

/** Pełny, najwyższy zestaw uprawnień ROOT wspólny dla Operatora Mateusza Mitka, Bielika i Maya Mitek. */
export const FULL_ROOT_SCOPES: readonly string[] = [
  'chat',
  'chat.commands',
  'vision.ollama',
  'agents.pubsub',
  'agents.admin',
  'system.root',
  'linux.root',
  'kernel.admin',
  'apex.control',
  'modules.write',
  'memory.write',
  'terminal.exec',
  'ssh.exec',
  'packages.admin',
  'services.admin',
  'ollama.admin',
  'maya.mission',
  'security.antivirus',
  'security.admin',
  'mcp.tools',
  'files.read',
  'files.write',
  'github.read',
  'github.write_sync',
  'github.admin',
  'svl364.telemetry',
  'user_notes.read',
  'broadcast.wszyscy',
  'superuser.all',
];

/** Słowa kluczowe przycisku w treści czatu: `[btn: Etykieta|akcja]` (też `button`, `action`, `przycisk`). */
export const CHAT_BUTTON_TOKEN_PATTERN = '\\[(?:btn|button|action|przycisk):[^\\]\\n]+\\]';

export function parseChatInteractiveToken(token: string): { label: string; action: string } | null {
  const match = token.trim().match(/^\[(?:btn|button|action|przycisk):([^\]\n]+)\]$/i);
  if (!match) return null;

  const separator = match[1].indexOf('|');
  const label = (separator < 0 ? match[1] : match[1].slice(0, separator)).trim();
  const action = (separator < 0 ? label : match[1].slice(separator + 1)).trim();
  return label ? { label, action: action || label } : null;
}

/** Akcje, które rozumie czat (patrz `resolveChatInteractiveButtonAction`). */
const CHAT_ACTION_PREFIX = /^(?:send|text|tab|nav|open|goto|action|ask|copy):/i;

/**
 * Ujednolica przyciski pisane przez modele: linki Markdown z akcją czatu, np.
 * `[Synchronizuj](action:sync)` albo `[Zapytaj Mayę](send: Jaki jest stan?)`,
 * zamieniane są na `[btn: Etykieta|akcja]`. Zwykłe linki http(s) zostają bez zmian.
 */
export function normalizeAiInteractiveMarkup(text: string): string {
  return String(text || '').replace(
    /\[([^\]\n]{1,80})\]\(\s*((?:send|text|tab|nav|open|goto|action|ask|copy):[^)\n]{0,300})\)/gi,
    (_all, label: string, action: string) => {
      const cleanLabel = label.replace(/[|\]]/g, ' ').trim();
      const cleanAction = action.replace(/\]/g, ' ').trim();
      return cleanLabel && CHAT_ACTION_PREFIX.test(cleanAction) ? `[btn: ${cleanLabel}|${cleanAction}]` : _all;
    },
  );
}

export function isUnsafeChatInteractiveAction(action: string): boolean {
  const value = action.trim();
  if (/^(?:\/|run:|exec:)/i.test(value)) return true;

  const dispatchedText = value.match(/^(?:send|text):\s*([\s\S]*)$/i)?.[1]?.trim() || '';
  return /^\/exec(?:\s|$)/i.test(dispatchedText);
}

export type WorkspaceTabKey = 'chat' | 'apex' | 'svl364' | 'infrastructure' | 'agents' | 'terminals' | 'kernel' | 'linux';

const WORKSPACE_TAB_ALIASES: Record<string, WorkspaceTabKey> = {
  chat: 'chat',
  czat: 'chat',
  apex: 'apex',
  'apex-os': 'apex',
  apexos: 'apex',
  coreos: 'apex',
  svl364: 'svl364',
  'svl-364': 'svl364',
  ship: 'svl364',
  statek: 'svl364',
  ssh: 'svl364',
  mcp: 'svl364',
  infrastructure: 'infrastructure',
  infrastruktura: 'infrastructure',
  infra: 'infrastructure',
  server: 'infrastructure',
  serwer: 'infrastructure',
  agents: 'agents',
  agenci: 'agents',
  agent: 'agents',
  ai: 'agents',
  terminals: 'terminals',
  terminal: 'terminals',
  terminale: 'terminals',
  shell: 'terminals',
  kernel: 'kernel',
  jadro: 'kernel',
  'jądro': 'kernel',
  sfera: 'kernel',
  modules: 'kernel',
  'moduły': 'kernel',
  moduly: 'kernel',
  linux: 'linux',
  debian: 'linux',
  deploy: 'linux',
};

export type ResolvedChatButtonAction =
  | { kind: 'empty' }
  | { kind: 'unsafe' }
  | { kind: 'tab'; tab: WorkspaceTabKey }
  | { kind: 'invalid_tab'; rawTab: string }
  | { kind: 'send'; text: string }
  | { kind: 'ask'; agent?: 'Bielik' | 'Maya' }
  | { kind: 'text'; text: string }
  | { kind: 'copy'; text: string }
  | { kind: 'sync' }
  | { kind: 'scan' }
  | { kind: 'report' }
  | { kind: 'image'; prompt?: string }
  | { kind: 'vision' }
  | { kind: 'avatars' }
  | { kind: 'ollama' }
  | { kind: 'duplex' };

/**
 * Deterministycznie rozstrzyga kliknięcie dowolnego przycisku `[btn: Etykieta|akcja]` na czacie.
 * Obsługuje prefiksy `tab:`/`nav:`/`open:`/`goto:`, `send:`, `ask:`, `text:`, `copy:`, `action:*`
 * oraz bezpieczne akcje niestandardowe AI (zamiast martwego błędu „Nieznana akcja”).
 */
export function resolveChatInteractiveButtonAction(
  actionValue: string,
  label?: string,
): ResolvedChatButtonAction {
  const val = String(actionValue || '').trim();
  const cleanLabel = String(label || '').trim();
  if (!val) return { kind: 'empty' };
  if (isUnsafeChatInteractiveAction(val)) return { kind: 'unsafe' };

  const lower = val.toLowerCase();

  const tabMatch = val.match(/^(?:tab|nav|open|goto):\s*(.+)$/i);
  if (tabMatch) {
    const rawTab = tabMatch[1].trim().toLowerCase();
    const mapped = WORKSPACE_TAB_ALIASES[rawTab];
    return mapped ? { kind: 'tab', tab: mapped } : { kind: 'invalid_tab', rawTab };
  }

  if (lower.startsWith('send:')) {
    const textToSend = val.slice(5).trim();
    return textToSend ? { kind: 'send', text: textToSend } : { kind: 'empty' };
  }

  if (lower.startsWith('ask:')) {
    const canonical = normalizeAgentCanonicalName(val.slice(4).trim());
    return { kind: 'ask', agent: canonical === 'Bielik' || canonical === 'Maya' ? canonical : undefined };
  }

  if (lower.startsWith('text:')) {
    const draft = val.slice(5).trim();
    return draft ? { kind: 'text', text: draft } : { kind: 'empty' };
  }

  if (lower.startsWith('copy:')) {
    const toCopy = val.slice(5).trim();
    return toCopy ? { kind: 'copy', text: toCopy } : { kind: 'empty' };
  }

  const hasActionPrefix = lower.startsWith('action:');
  const actionRaw = hasActionPrefix ? val.slice(7).trim() : val;
  const actionName = actionRaw.toLowerCase();

  if (actionName === 'sync' || actionName === 'global_sync' || actionName === 'refresh') {
    return { kind: 'sync' };
  }
  if (actionName === 'scan' || actionName === 'antivirus' || actionName === 'av' || actionName === 'av_scan') {
    return { kind: 'scan' };
  }
  if (actionName === 'report' || actionName === 'svl_report' || actionName === 'raport') {
    return { kind: 'report' };
  }
  if (actionName === 'image' || actionName.startsWith('image:')) {
    const prompt = actionName.startsWith('image:') ? actionRaw.slice(6).trim() : '';
    return { kind: 'image', prompt: prompt || undefined };
  }
  if (actionName === 'vision' || actionName === 'real_vision') {
    return { kind: 'vision' };
  }
  if (actionName === 'avatars' || actionName === 'awatary') {
    return { kind: 'avatars' };
  }
  if (actionName === 'ollama' || actionName === 'ollama_config') {
    return { kind: 'ollama' };
  }
  if (actionName === 'duplex' || actionName === 'toggle_duplex') {
    return { kind: 'duplex' };
  }
  if (hasActionPrefix) {
    if (actionName === 'status') return { kind: 'send', text: '/status' };
    if (actionName === 'modules' || actionName === 'moduly') return { kind: 'send', text: '/moduly' };
    if (actionName === 'memory' || actionName === 'pamiec') return { kind: 'send', text: '/pamiec lista' };
    if (actionName === 'help' || actionName === 'pomoc') return { kind: 'send', text: '/pomoc' };
    if (actionName === 'connect' || actionName === 'polacz') return { kind: 'send', text: '/polacz' };
    const mappedTab = WORKSPACE_TAB_ALIASES[actionName];
    if (mappedTab) return { kind: 'tab', tab: mappedTab };
    // Niestandardowe akcje wygenerowane przez AI (np. `action:commit`, `action:check_ssh`) wysyłamy jako
    // intencję operatora do aktywnego czatu zamiast wyświetlać martwy błąd.
    const fallbackText = cleanLabel || actionRaw.replace(/[_-]+/g, ' ');
    return fallbackText ? { kind: 'send', text: fallbackText } : { kind: 'empty' };
  }

  // Przycisk bez prefiksu (np. `[btn: Pokaż moduły]`) wysyła intencję bezpośrednio na czat.
  const intentText = /^[a-z0-9_-]+$/i.test(val) && cleanLabel ? cleanLabel : val;
  return intentText ? { kind: 'send', text: intentText } : { kind: 'empty' };
}

export function normalizeAgentCanonicalName(
  rawName?: string | null,
): string | null {
  const clean = String(rawName || '').trim().toLowerCase();
  if (!clean) return null;
  if (clean === 'bielik' || clean === 'bielik ai' || clean === 'conv-agent-bielik') {
    return 'Bielik';
  }
  if (
    clean === 'maya' ||
    clean === 'maya ai' ||
    clean === 'maya svl-364' ||
    clean === 'maya mitek' ||
    clean === 'maya mitek ai' ||
    clean === 'maya mitek svl-364' ||
    clean === 'conv-agent-maya'
  ) {
    return 'Maya';
  }
  if (
    clean === 'system_si_1' ||
    clean === 'system-si-1' ||
    clean === 'systemsi1' ||
    clean === 'system si 1' ||
    clean === 'system_si' ||
    clean === 'system-si' ||
    clean === 'system si' ||
    clean === 'conv-system-si-1'
  ) {
    return 'System_SI_1';
  }
  return null;
}

export type SvlMcpChatAgent = 'Bielik' | 'Maya' | 'System_SI_1';

/** Wartości `agent` przyjmowane przez oba serwery MCP (`svl_chat`). Aliasy idą na kanoniczną nazwę. */
export const SVL_MCP_CHAT_AGENT_ENUM = ['Bielik', 'Maya', 'System_SI_1', 'system_si_1', 'system-si-1'] as const;

/** Nieznany adresat zostaje Bielikiem — tak jak dotychczasowy domyślny czat MCP. */
export function resolveSvlMcpChatAgent(raw: unknown): SvlMcpChatAgent {
  const canonical = normalizeAgentCanonicalName(typeof raw === 'string' ? raw : String(raw ?? ''));
  if (canonical === 'Maya' || canonical === 'System_SI_1' || canonical === 'Bielik') return canonical;
  return 'Bielik';
}

export function conversationIdForSvlChatAgent(agent: SvlMcpChatAgent): string {
  if (agent === 'System_SI_1') return 'conv-system-si-1';
  if (agent === 'Maya') return 'conv-agent-maya';
  return 'conv-agent-bielik';
}

export function formatOllamaChatBadge(input: {
  selectedAgent: string;
  selectedDisplayName: string;
  modelName: string;
  isOnboardComputer: boolean;
  isExplicitGemini: boolean;
  explicitGeminiModel: string;
  isExplicitOllama: boolean;
  isBielikAgent: boolean;
  requestedModel: string;
  effectiveModel: string;
}): string {
  const {
    selectedAgent,
    selectedDisplayName,
    modelName,
    isOnboardComputer,
    isExplicitGemini,
    explicitGeminiModel,
    isExplicitOllama,
    isBielikAgent,
    requestedModel,
    effectiveModel,
  } = input;
  if (isOnboardComputer) {
    return `Komputer pokładowy SVL-364 (SSH + MCP · ${isExplicitGemini ? explicitGeminiModel : modelName})`;
  }
  if (isExplicitGemini) return `${selectedDisplayName} · Gemini (${explicitGeminiModel})`;
  if (selectedAgent === 'Maya') return `Maya Mitek · AI Statku SVL-364 (ROOT · ${modelName})`;
  if (selectedAgent === 'System_SI_1') return `System_SI_1 · Ollama (${modelName} · ROOT)`;
  if (isExplicitOllama || isBielikAgent) return `Bielik · Ollama (${modelName} · ROOT)`;
  if (requestedModel === 'svl-hybrid-router') return `SVL-364 · Ollama (${modelName})`;
  return effectiveModel;
}

export function formatGrokChatBadge(input: {
  selectedAgent: string;
  modelName: string;
  isOnboardComputer: boolean;
  isBielikAgent: boolean;
}): string {
  if (input.isOnboardComputer) return `Komputer pokładowy SVL-364 (SSH + MCP · Grok ${input.modelName})`;
  if (input.selectedAgent === 'Maya') return `Maya Mitek · AI Statku SVL-364 (ROOT · Grok ${input.modelName})`;
  if (input.selectedAgent === 'System_SI_1') return `System_SI_1 · Grok (${input.modelName} · ROOT)`;
  if (input.isBielikAgent) return `Bielik · Grok (${input.modelName} · ROOT)`;
  return `SVL-364 · Grok (${input.modelName})`;
}

const MAYA_DIRECT_ADDRESS_RE =
  /(?:^|[\s,(])@maya(?:\s+mitek)?(?=$|[\s,.:;!?])|^\s*(?:(?:hej|cześć|czesc|siema|witaj|halo|ej|droga|pani|słuchaj|sluchaj|proszę|prosze|dzień\s+dobry|dzien\s+dobry|dobry\s+wieczór|dobry\s+wieczor)\s+)?(?:maya|majo|maja|maju)(?:\s+mitek)?(?=$|[\s,.:;!?])|(?:^|[\s,(])(?:maya|mayi|mayę|maye|mayą|majo|maju)\s+mitek(?=$|[\s,.:;!?])|(?<![\p{L}\p{N}_])(?:do|dla|zapytaj|spytaj|napisz\s+do|pisz[eę]\s+do|pytanie\s+do|hej|cześć|czesc|witaj|siema|halo)\s+(?:may[aeięąo]|maj[aeięąou])(?:\s+mitek)?(?=$|[\s,.:;!?])|(?:,\s*|\s+)(?:maya|majo)(?:\s+mitek)?(?=[!?,.]*$)/iu;

const BIELIK_DIRECT_ADDRESS_RE =
  /(?:^|[\s,(])@bielik(?=$|[\s,.:;!?])|^\s*(?:(?:hej|cześć|czesc|siema|witaj|halo|ej|słuchaj|sluchaj|proszę|prosze|dzień\s+dobry|dzien\s+dobry)\s+)?(?:bielik|bieliku)(?=$|[\s,.:;!?])|(?<![\p{L}\p{N}_])(?:do|dla|zapytaj|spytaj|napisz\s+do|pisz[eę]\s+do|pytanie\s+do|hej|cześć|czesc|witaj|siema|halo)\s+bielik[au]?(?=$|[\s,.:;!?])|(?:,\s*|\s+)(?:bielik|bieliku)(?=[!?,.]*$)/iu;

export interface ChatTargetResolution {
  agent: 'Bielik' | 'Maya' | 'System_SI_1';
  mentionsMaya: boolean;
  mentionsBielik: boolean;
  explicit: boolean;
}

/**
 * Deterministyczny wybór adresata wiadomości (wspólny dla klienta i serwera).
 * Zapobiega sytuacji, w której pisanie do Mayi Mitek („Maya, ...”, „Majo ...”, kanał Maya
 * lub wybrany adresat Maya) było przechwytywane przez Bielika.
 */
export function resolveChatTargetAgent(params: {
  message: string;
  conversationId?: string | null;
  targetAgent?: string | null;
  hasSlashCommand?: boolean;
}): ChatTargetResolution {
  const msg = String(params.message || '').trim();
  const convId = String(params.conversationId || '').trim();
  const normTarget = normalizeAgentCanonicalName(params.targetAgent);

  const mayaMatch = MAYA_DIRECT_ADDRESS_RE.exec(msg);
  const bielikMatch = BIELIK_DIRECT_ADDRESS_RE.exec(msg);
  const mentionsMaya = Boolean(mayaMatch);
  const mentionsBielik = Boolean(bielikMatch);

  if (convId === 'conv-system-si-1' || normTarget === 'System_SI_1') {
    return { agent: 'System_SI_1', mentionsMaya, mentionsBielik, explicit: true };
  }

  if (mentionsMaya && !mentionsBielik) {
    return { agent: 'Maya', mentionsMaya, mentionsBielik, explicit: true };
  }
  if (mentionsBielik && !mentionsMaya) {
    return { agent: 'Bielik', mentionsMaya, mentionsBielik, explicit: true };
  }
  if (mentionsMaya && mentionsBielik && mayaMatch && bielikMatch) {
    const first = mayaMatch.index <= bielikMatch.index ? 'Maya' : 'Bielik';
    return { agent: first, mentionsMaya, mentionsBielik, explicit: true };
  }

  if (convId === 'conv-agent-maya' || convId === 'conv-svl364-komputer-pokladowy') {
    return { agent: 'Maya', mentionsMaya, mentionsBielik, explicit: convId === 'conv-agent-maya' };
  }
  if (convId === 'conv-agent-bielik') {
    return { agent: 'Bielik', mentionsMaya, mentionsBielik, explicit: true };
  }

  if (normTarget === 'Maya') {
    return { agent: 'Maya', mentionsMaya, mentionsBielik, explicit: true };
  }
  if (normTarget === 'Bielik') {
    return { agent: 'Bielik', mentionsMaya, mentionsBielik, explicit: true };
  }

  if (params.hasSlashCommand) {
    return { agent: 'Bielik', mentionsMaya, mentionsBielik, explicit: true };
  }

  return { agent: 'Bielik', mentionsMaya, mentionsBielik, explicit: false };
}

export type BielikSlashCommand =
  | { kind: 'help' }
  | { kind: 'status' }
  | { kind: 'ollama' }
  | { kind: 'modules_list' }
  | {
      kind: 'ui_set';
      key: 'gui_theme' | 'gui_accent' | 'active_workspace_tab';
      value: string;
    }
  | {
      kind: 'module_upsert';
      id: string;
      status: 'ACTIVE' | 'CONFIGURED' | 'STANDBY';
      name: string;
      description: string;
      /** Existing module kind to keep when only the status changes. */
      moduleKind?: string;
      /** Status change of an existing module: keep its metadata and configuration untouched. */
      preserveExisting?: boolean;
    }
  | { kind: 'memory_list' }
  | { kind: 'memory_save'; memoryKind: 'fact' | 'decision' | 'task' | 'episode'; content: string }
  | { kind: 'root_exec'; command: string }
  | { kind: 'topology'; xStart: string; xEnd: string }
  | { kind: 'agent_connect' }
  | { kind: 'agent_task'; title: string; payload: string };

export function parseBielikChatCommand(rawMessage: string): BielikSlashCommand | null {
  const trimmed = String(rawMessage || '').trim();
  if (!trimmed.startsWith('/')) return null;

  const [rawCmd, ...restParts] = trimmed.split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  const rest = restParts.join(' ').trim();

  if (cmd === '/help' || cmd === '/pomoc' || cmd === '/komendy') {
    return { kind: 'help' };
  }
  if (cmd === '/status' || cmd === '/diagnostyka' || cmd === '/raport') {
    return { kind: 'status' };
  }
  if (cmd === '/ollama') {
    return { kind: 'ollama' };
  }
  if (cmd === '/moduly' || cmd === '/modules') {
    return { kind: 'modules_list' };
  }
  if (cmd === '/design' || cmd === '/motyw' || cmd === '/theme') {
    const aliases: Record<string, string> = {
      apex: 'apex',
      ciemny: 'apex',
      midnight: 'midnight',
      nocny: 'midnight',
      emerald: 'emerald',
      zielony: 'emerald',
      violet: 'violet',
      fioletowy: 'violet',
      fiolet: 'violet',
      reset: 'apex',
    };
    const value = aliases[rest.toLowerCase()];
    return value ? { kind: 'ui_set', key: 'gui_theme', value } : null;
  }
  if (cmd === '/akcent' || cmd === '/accent') {
    const aliases: Record<string, string> = {
      cyan: 'cyan',
      niebieski: 'cyan',
      emerald: 'emerald',
      zielony: 'emerald',
      violet: 'violet',
      fioletowy: 'violet',
      fiolet: 'violet',
      amber: 'amber',
      bursztynowy: 'amber',
      pomaranczowy: 'amber',
    };
    const value = aliases[rest.toLowerCase()];
    return value ? { kind: 'ui_set', key: 'gui_accent', value } : null;
  }
  if (cmd === '/panel' || cmd === '/tab') {
    const aliases: Record<string, string> = {
      chat: 'chat',
      czat: 'chat',
      apex: 'apex',
      statek: 'svl364',
      svl364: 'svl364',
      infrastruktura: 'infrastructure',
      agenci: 'agents',
      maya: 'maya',
      galeria: 'gallery',
      terminale: 'terminals',
      kernel: 'kernel',
      jadro: 'kernel',
      jądro: 'kernel',
      linux: 'linux',
    };
    const value = aliases[rest.toLowerCase()];
    return value ? { kind: 'ui_set', key: 'active_workspace_tab', value } : null;
  }
  if (cmd === '/modul' || cmd === '/module') {
    if (!rest) return { kind: 'modules_list' };
    const tokens = rest.split(/\s+/);
    const id = tokens[0].toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 64);
    if (!id) return null;
    const rawStatus = (tokens[1] || 'ACTIVE').toUpperCase();
    const validStatus: 'ACTIVE' | 'CONFIGURED' | 'STANDBY' =
      rawStatus === 'CONFIGURED' || rawStatus === 'STANDBY' ? rawStatus : 'ACTIVE';
    const hasExplicitStatus = ['ACTIVE', 'CONFIGURED', 'STANDBY'].includes(rawStatus);
    const desc = (hasExplicitStatus ? tokens.slice(2) : tokens.slice(1)).join(' ').trim() || `Moduł skonfigurowany przez Bielik (${id})`;
    return { kind: 'module_upsert', id, status: validStatus, name: id, description: desc };
  }
  if (cmd === '/pamiec' || cmd === '/memory' || cmd === '/zapamietaj') {
    if (!rest || rest.toLowerCase() === 'lista' || rest.toLowerCase() === 'list') {
      return { kind: 'memory_list' };
    }
    const content = rest.replace(/^(?:dodaj|zapisz|add)\s+/i, '').trim();
    if (!content) return { kind: 'memory_list' };
    return { kind: 'memory_save', memoryKind: 'fact', content: content.slice(0, 800) };
  }
  if (cmd === '/root' || cmd === '/exec') {
    if (!rest) return { kind: 'help' };
    return { kind: 'root_exec', command: rest.slice(0, 1000) };
  }
  if (cmd === '/topologia' || cmd === '/topology') {
    const args = rest.split(/\s+/).filter(Boolean);
    return { kind: 'topology', xStart: args[0] || '-inf', xEnd: args[1] || 'inf' };
  }
  if (cmd === '/polacz' || cmd === '/connect') {
    return { kind: 'agent_connect' };
  }
  if (cmd === '/zadanie' || cmd === '/task') {
    if (!rest) return null;
    const parts = rest.split('|').map((p) => p.trim());
    const title = (parts[0] || '').slice(0, 220);
    if (!title) return null;
    return { kind: 'agent_task', title, payload: (parts[1] || title).slice(0, 2000) };
  }
  return null;
}

export interface SshShipParsedCommand {
  rawInput: string;
  isExplicitExec: boolean;
  mode: 'shell' | 'natural';
  shellCommand: string;
  naturalDirective: string | null;
}

const KNOWN_SSH_SHELL_BINARIES = new Set([
  'id', 'whoami', 'uname', 'hostname', 'uptime', 'free', 'df', 'du', 'ls', 'll',
  'pwd', 'cd', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'awk', 'sed',
  'find', 'ps', 'top', 'htop', 'ip', 'ss', 'netstat', 'ping', 'curl', 'wget',
  'ssh', 'scp', 'sudo', 'su', 'ufw', 'iptables', 'systemctl', 'service',
  'journalctl', 'dmesg', 'env', 'printenv', 'export', 'echo', 'printf', 'date',
  'cal', 'wc', 'sort', 'uniq', 'tr', 'cut', 'chmod', 'chown', 'mkdir', 'rm',
  'cp', 'mv', 'touch', 'ln', 'tar', 'gzip', 'gunzip', 'zip', 'unzip', 'python',
  'python3', 'pip', 'pip3', 'node', 'npm', 'npx', 'git', 'ollama', 'sqlite3',
  'svl364-ssh', 'svl364-mcp', 'svl-db', 'which', 'whereis', 'file', 'stat',
  'lscpu', 'lsblk', 'lspci', 'lsusb', 'vmstat', 'iostat', 'ulimit', 'kill',
  'pkill', 'pgrep', 'nohup', 'true', 'false', 'test', '[', 'bash', 'sh', 'zsh',
]);

const SSH_NATURAL_LANGUAGE_STARTERS = new Set([
  'sprawdź', 'sprawdz', 'pokaż', 'pokaz', 'wyświetl', 'wyswietl', 'ustaw',
  'uruchom', 'włącz', 'wlacz', 'wyłącz', 'wylacz', 'stwórz', 'stworz',
  'utwórz', 'utworz', 'dodaj', 'usuń', 'usun', 'napraw', 'zaktualizuj',
  'synchronizuj', 'wyślij', 'wyslij', 'przeskanuj', 'skanuj', 'zbadaj',
  'podaj', 'jaki', 'jaka', 'jakie', 'czy', 'ile', 'gdzie', 'dlaczego',
  'opisz', 'wyjaśnij', 'wyjasnij', 'przetwórz', 'przetworz', 'daj',
  'nadaj', 'połącz', 'polacz', 'zresetuj', 'raport', 'telemetria',
  'diagnostyka', 'pomoc', 'wykonaj', 'zrób', 'zrob', 'aktywuj', 'odblokuj',
  'zablokuj', 'przełącz', 'przelacz', 'skieruj', 'leć', 'lec', 'kurs',
  'tarcze', 'reaktor', 'statek', 'maya', 'bielik', 'check', 'show', 'report',
]);

export function parseSshShipTerminalInput(rawInput: string): SshShipParsedCommand {
  const trimmed = String(rawInput || '').trim();
  const isExplicitExec = /^\/(?:exec|root)(?:\s+|$)/i.test(trimmed);
  const stripped = trimmed.replace(/^\/(?:exec|root)\s*/i, '').trim();

  if (!stripped) {
    return {
      rawInput: trimmed,
      isExplicitExec,
      mode: 'shell',
      shellCommand: 'id && uname -a && uptime && free -m',
      naturalDirective: null,
    };
  }

  const words = stripped.split(/\s+/);
  const firstWord = (words[0] || '').toLowerCase().replace(/[:,;.!?]+$/, '');
  const hasPolishDiacritics = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/.test(stripped);
  const hasShellSyntax = /[|&;><$`=]/.test(stripped) || /^(?:\/bin\/|\/usr\/|\.\/|\.\.\/)/.test(stripped);

  const isNatural =
    SSH_NATURAL_LANGUAGE_STARTERS.has(firstWord) ||
    firstWord === '/pomoc' ||
    firstWord === '/help' ||
    firstWord === '/status' ||
    firstWord === '/raport' ||
    (hasPolishDiacritics && !['echo', 'printf', 'grep', 'sqlite3', 'python', 'python3', 'curl'].includes(firstWord)) ||
    (!KNOWN_SSH_SHELL_BINARIES.has(firstWord) && !hasShellSyntax && words.length >= 2);

  if (!isNatural) {
    return {
      rawInput: trimmed,
      isExplicitExec,
      mode: 'shell',
      shellCommand: stripped,
      naturalDirective: null,
    };
  }

  const low = stripped.toLowerCase();
  let synthesizedCmd = 'id && hostname && uname -srm && uptime && free -m && df -h /';
  if (/ufw|zapor|firewall|port|sieć|siec|ip|qkd/.test(low)) {
    synthesizedCmd = 'id && hostname && ufw status && ip -br addr';
  } else if (/proces|worker|daemon|cpu|obciążen|obciazen|top|ps/.test(low)) {
    synthesizedCmd = 'id && ps -eo pid,user,comm,%cpu,%mem --sort=-%cpu | head -n 12';
  } else if (/dysk|miejsc|plik|katalog|storage/.test(low)) {
    synthesizedCmd = 'id && df -h / && ls -la';
  } else if (/pamięć|pamiec|ram|swap/.test(low)) {
    synthesizedCmd = 'id && free -m && uname -srm';
  } else if (/ollama|model|vision/.test(low)) {
    synthesizedCmd = 'id && ollama --version && ollama list';
  } else if (/baz|sqlite|moduł|modul|notatk|prac|maya|bielik/.test(low)) {
    synthesizedCmd = 'id && sqlite3 data/svl_os.sqlite3 "SELECT id, status, revision FROM system_modules ORDER BY revision DESC LIMIT 10;"';
  }

  return {
    rawInput: trimmed,
    isExplicitExec,
    mode: 'natural',
    shellCommand: synthesizedCmd,
    naturalDirective: stripped,
  };
}

export function extractBielikActionTags(rawReply: string): {
  cleanText: string;
  actions: Array<Record<string, any>>;
} {
  const actions: Array<Record<string, any>> = [];
  const cleanText = String(rawReply || '')
    .replace(/\[\[SVL_ACTION:(\{[\s\S]*?\})\]\]/g, (_m, jsonStr) => {
      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed && typeof parsed === 'object' && typeof parsed.cmd === 'string') {
          actions.push(parsed);
        }
      } catch {
        // ignore malformed model tag
      }
      return '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { cleanText, actions };
}

export function compactifyValue(x: number): number {
  if (Number.isNaN(x)) return 0.0;
  if (x === Number.NEGATIVE_INFINITY) return -1.0;
  if (x === Number.POSITIVE_INFINITY) return 1.0;
  return x / (1.0 + Math.abs(x));
}

export function calculateCompactMetricC(
  xStart: number,
  xEnd: number,
): {
  compactStart: number;
  compactEnd: number;
  domainLength: number;
  orthogonalB: number;
  metricC: number;
} {
  const compactStart = compactifyValue(xStart);
  const compactEnd = compactifyValue(xEnd);
  const domainLength = Math.abs(compactEnd - compactStart);
  const orthogonalB = Math.abs(compactStart * compactEnd) + 0.5;
  const metricC = Math.sqrt(domainLength * domainLength + orthogonalB * orthogonalB);
  return {
    compactStart: Math.round(compactStart * 1_000_000) / 1_000_000,
    compactEnd: Math.round(compactEnd * 1_000_000) / 1_000_000,
    domainLength: Math.round(domainLength * 1_000_000) / 1_000_000,
    orthogonalB: Math.round(orthogonalB * 1_000_000) / 1_000_000,
    metricC: Math.round(metricC * 1_000_000) / 1_000_000,
  };
}

export function validateOperatorTokenFormat(token: string): {
  valid: boolean;
  error: string | null;
} {
  const clean = (token || '').trim();
  if (!clean) {
    return { valid: false, error: 'Token nie może być pusty.' };
  }
  if (clean === '364_OMNIKLUCZ_ROOT') {
    return {
      valid: false,
      error: 'Ten token nie jest dozwolony.',
    };
  }
  if (clean.length < 32) {
    return {
      valid: false,
      error: 'SVL_OPERATOR_TOKEN musi mieć co najmniej 32 losowe znaki.',
    };
  }
  return { valid: true, error: null };
}

export function validateOllamaHostUrl(raw: string): {
  valid: boolean;
  normalized: string | null;
  error: string | null;
} {
  const trimmed = (raw || '').trim().replace(/\/+$/, '');
  if (!trimmed) {
    return { valid: false, normalized: null, error: 'Podaj adres URL serwera Ollama (np. http://127.0.0.1:11434).' };
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, normalized: null, error: 'Dozwolone są wyłącznie protokoły http:// lub https://.' };
    }
    return { valid: true, normalized: parsed.origin, error: null };
  } catch {
    return { valid: false, normalized: null, error: 'Nieprawidłowy format adresu URL serwera Ollama.' };
  }
}

export function buildChatHistoryPayload(
  messages: Array<{ role: string; content: string; sender?: string; provenance?: string }>,
  limit = 48,
): Array<{ role: 'user' | 'assistant'; content: string; sender?: string }> {
  return (messages || [])
    .filter((m) => {
      if ((m.role !== 'user' && m.role !== 'assistant') || !m.content?.trim()) return false;
      if (m.provenance === 'error') return false;
      const txt = m.content.trim();
      if (m.role === 'assistant' && txt.startsWith('⚠️') && /nie może teraz odpowiedzieć|nie zdążył/i.test(txt)) {
        return false;
      }
      return true;
    })
    .slice(-limit)
    .map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content.trim().slice(0, 12000),
      // Nadawca jest potrzebny, by każdy agent wiedział, które wypowiedzi są jego, a które cudze.
      ...(typeof m.sender === 'string' && m.sender.trim() ? { sender: m.sender.trim().slice(0, 80) } : {}),
    }));
}

export function selectOllamaModelName(
  requestedModel: string,
  availableModels: Array<{ name: string; vision_supported?: boolean }>,
  hasImage: boolean,
  preferredFallback = 'dolphin-llama3:8b-v2.9-q2_K',
): string {
  if (requestedModel.startsWith('ollama:')) {
    return requestedModel.slice('ollama:'.length);
  }
  if (hasImage) {
    const preferredVision = availableModels.find(
      (m) => m.name.startsWith('llama3.2-vision'),
    );
    if (preferredVision) return preferredVision.name;
    const visionModel = availableModels.find((m) => m.vision_supported);
    if (visionModel) return visionModel.name;
  }
  const preferredAvailable = availableModels.find((m) => m.name === preferredFallback);
  if (preferredAvailable) {
    return preferredAvailable.name;
  }
  if (availableModels.length > 0) {
    return availableModels[0].name;
  }
  return preferredFallback;
}

/**
 * Dobiera model faktycznie zainstalowany w Ollamie. Skonfigurowana nazwa (np. `llama3.2-vision:11b`)
 * często różni się od zainstalowanej tylko tagiem (`:latest`) — wcześniej kończyło się to komunikatem
 * „model nie jest zainstalowany / żaden model AI nie jest dostępny”, choć Ollama działała.
 */
export function resolveInstalledOllamaModel(
  requested: string,
  installed: Array<{ name?: string; model?: string; vision_supported?: boolean }>,
  hasImage = false,
): { name: string; substituted: boolean; installedCount: number } {
  const names = installed
    .map((m) => String(m?.name || m?.model || '').trim())
    .filter(Boolean);
  const want = String(requested || '').trim();
  const base = (n: string) => n.split(':')[0].toLowerCase();
  const tagged = (n: string) => (n.includes(':') ? n.toLowerCase() : `${n.toLowerCase()}:latest`);
  const exact = names.find((n) => n === want || tagged(n) === tagged(want));
  if (exact) return { name: exact, substituted: false, installedCount: names.length };
  const sameFamily = names.find((n) => base(n) === base(want));
  if (sameFamily) return { name: sameFamily, substituted: false, installedCount: names.length };
  if (names.length === 0) return { name: want, substituted: false, installedCount: 0 };
  const visionHint = /vision|llava|-vl|vl:|minicpm-v|pixtral|gemma3/i;
  const pick =
    (hasImage ? installed.find((m) => m?.vision_supported || visionHint.test(String(m?.name || m?.model || ''))) : null) ||
    installed.find((m) => visionHint.test(String(m?.name || m?.model || ''))) ||
    installed[0];
  return { name: String(pick?.name || pick?.model || names[0]), substituted: true, installedCount: names.length };
}

export type TerminalTabId = 'linux' | 'ssh' | 'python' | 'github' | 'hyperspace' | 'agents';

export interface TerminalLogLine {
  id: string;
  tab?: TerminalTabId;
  timestamp: string;
  kind: 'input' | 'stdout' | 'stderr' | 'system';
  text: string;
  command?: string;
  revision?: number;
  createdAt?: string;
}

export interface ChatAppliedAction {
  tool: string;
  entity: string;
  entityId: string;
  revision?: number;
  serverRevision?: number;
  summary: string;
  ok: boolean;
}

export interface SystemModule {
  id: string;
  name: string;
  kind: string;
  status: 'ACTIVE' | 'CONFIGURED' | 'STANDBY' | 'ARCHIVED';
  description: string;
  config: Record<string, any>;
  source: string;
  sourceMessageId?: string;
  revision: number;
  updatedAt: string;
}

export interface SyncableMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  sender: string;
  agentId?: string;
  modelUsed?: string;
  content: string;
  timestamp: string;
  imagePreview?: string;
  fileName?: string;
  connectionReport?: any;
  appliedActions?: ChatAppliedAction[];
  /** Skąd pochodzi treść: wiedza modelu (niezweryfikowana), źródła z internetu, wynik serwera, błąd. */
  provenance?: 'model_unverified' | 'web_sources' | 'server_verified' | 'error';
  verificationNote?: string;
  sourceOrigin?: string;
  correlationId?: string;
  metadata?: Record<string, any>;
}

export interface SyncableConversation {
  id: string;
  title: string;
  updatedAt: string;
  revision?: number;
  messages: SyncableMessage[];
}

export interface SvlSyncEvent<TPayload = Record<string, any>> {
  type: string;
  eventId: string;
  entity: string;
  entityId: string;
  revision: number;
  serverRevision: number;
  timestamp: string;
  origin: string;
  correlationId?: string;
  payload: TPayload;
}

export type TargetAgentSelection = 'Auto' | 'Rodzina Mitek' | 'Bielik' | 'Maya' | 'KomputerPokladowy' | 'System_SI_1';

export interface WorkspaceUiState {
  active_conversation_id?: string | null;
  selected_target_agent?: TargetAgentSelection;
  selected_agent_panel_id?: string;
  gui_theme?: 'apex' | 'midnight' | 'emerald' | 'violet' | { value: string };
  gui_accent?: 'cyan' | 'emerald' | 'violet' | 'amber' | { value: string };
  active_workspace_tab?: string | { value: string };
  revisions?: Record<string, number>;
}

export type AvatarProfileKey = 'Bielik' | 'Maya' | 'KomputerPokladowy' | 'System_SI_1' | 'Operator';

export type SvlAvatarMap = Partial<Record<AvatarProfileKey, string>>;

export type WsConnectionState = 'connecting' | 'online' | 'reconnecting' | 'offline';

export function mergeConversationThreads(
  remoteThreads: SyncableConversation[],
  localThreads: SyncableConversation[],
  pendingMessageIds: Set<string> = new Set(),
  deletedConversationIds: Set<string> = new Set(),
  pendingConversationIds: Set<string> = new Set(),
): SyncableConversation[] {
  const localById = new Map<string, SyncableConversation>();
  for (const lt of localThreads) {
    if (!deletedConversationIds.has(lt.id)) {
      localById.set(lt.id, lt);
    }
  }

  const dedupeMessages = (msgs: SyncableMessage[]): SyncableMessage[] => {
    const seen = new Set<string>();
    const out: SyncableMessage[] = [];
    for (const m of msgs) {
      if (!m || !m.id || seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
    return out;
  };

  const merged: SyncableConversation[] = [];
  const seenIds = new Set<string>();

  for (const rt of remoteThreads) {
    if (deletedConversationIds.has(rt.id)) continue;
    seenIds.add(rt.id);
    const lt = localById.get(rt.id);
    const cleanRemoteMsgs = dedupeMessages(rt.messages || []);
    if (!lt) {
      merged.push({ ...rt, messages: cleanRemoteMsgs });
      continue;
    }

    const remoteMsgIds = new Set(cleanRemoteMsgs.map((m) => m.id));
    const pendingExtras = (lt.messages || []).filter(
      (m) => m && m.id && !remoteMsgIds.has(m.id) && pendingMessageIds.has(m.id),
    );
    const highestRev = Math.max(Number(rt.revision || 0), Number(lt.revision || 0));
    merged.push({
      ...rt,
      revision: highestRev > 0 ? highestRev : rt.revision,
      title: lt.title && lt.title !== 'Nowa sesja' && pendingExtras.length > 0 ? lt.title : rt.title,
      messages: dedupeMessages([...cleanRemoteMsgs, ...pendingExtras]),
    });
  }

  for (const lt of localThreads) {
    if (seenIds.has(lt.id) || deletedConversationIds.has(lt.id)) continue;
    const isCanonical =
      lt.id === 'conv-rodzina-mitek-wszyscy' ||
      lt.id === 'conv-svl364-komputer-pokladowy' ||
      lt.id === 'conv-system-si-1' ||
      lt.id === 'conv-agent-bielik' ||
      lt.id === 'conv-agent-maya';
    const hasPending = (lt.messages || []).some((m) => pendingMessageIds.has(m.id));
    if (isCanonical || hasPending || pendingConversationIds.has(lt.id)) {
      seenIds.add(lt.id);
      merged.push({ ...lt, messages: dedupeMessages(lt.messages || []) });
    }
  }

  // Ensure mandatory canonical channels are present if canonical channels are in scope
  const hasAnyCanonical = [...remoteThreads, ...localThreads].some((c) =>
    c.id.startsWith('conv-'),
  );
  if (hasAnyCanonical) {
    const mandatoryCanonicalIds = [
      'conv-rodzina-mitek-wszyscy',
      'conv-svl364-komputer-pokladowy',
      'conv-system-si-1',
      'conv-agent-bielik',
      'conv-agent-maya',
    ];
    for (const cid of mandatoryCanonicalIds) {
      if (!merged.some((c) => c.id === cid)) {
        const canonicalTitle =
          cid === 'conv-rodzina-mitek-wszyscy'
            ? 'Rodzina Mitek (wszyscy)'
            : cid === 'conv-svl364-komputer-pokladowy'
            ? 'SVL-364 Komputer pokładowy (SSH + MCP)'
            : cid === 'conv-system-si-1'
            ? 'System_SI_1 — Zarządzanie Infrastrukturą (ROOT)'
            : cid === 'conv-agent-bielik'
            ? 'Bielik — Ollama 3.2 Vision 11B'
            : 'Maya Mitek — AI Statku SVL-364 (ROOT)';
        merged.push({
          id: cid,
          title: canonicalTitle,
          updatedAt: '',
          revision: 1,
          messages: [],
        });
      }
    }
  }

  return merged;
}

export interface SafeJsonResult<T = any> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
  correlationId?: string;
  offline?: boolean;
  conflict?: boolean;
  aborted?: boolean;
  proxyHtml?: boolean;
}

export async function safeParseJsonResponse<T = any>(
  resp: Pick<Response, 'ok' | 'status' | 'text' | 'headers'>,
): Promise<SafeJsonResult<T>> {
  const correlationId = resp.headers?.get?.('x-request-id') || undefined;
  let raw = '';
  try {
    raw = await resp.text();
  } catch (err: any) {
    return {
      ok: false,
      status: resp.status,
      data: null,
      correlationId,
      error: `Błąd odczytu odpowiedzi serwera (HTTP ${resp.status}): ${err?.message || String(err)}`,
    };
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      ok: resp.ok,
      status: resp.status,
      data: null,
      correlationId,
      error: resp.ok ? null : `Serwer zwrócił pustą odpowiedź (HTTP ${resp.status}).`,
    };
  }

  if (
    trimmed.startsWith('<!doctype') ||
    trimmed.startsWith('<!DOCTYPE') ||
    trimmed.startsWith('<html') ||
    trimmed.startsWith('<')
  ) {
    return {
      ok: false,
      status: resp.status,
      data: null,
      correlationId,
      proxyHtml: true,
      offline: resp.status === 200 || resp.status === 502 || resp.status === 503 || resp.status === 504,
      error:
        `Backend API zwrócił stronę HTML zamiast danych JSON (HTTP ${resp.status}). ` +
        `Sprawdź, czy serwer Express/Python działa pod tym adresem lub odczekaj kilka sekund po restarcie i spróbuj ponownie.`,
    };
  }

  try {
    const parsed = JSON.parse(trimmed) as T;
    const parsedErr =
      typeof (parsed as any)?.error === 'string' && (parsed as any).error
        ? (parsed as any).error
        : null;
    const upstreamStatus = Number((parsed as any)?.upstreamStatus || 0);
    const isOffline =
      Boolean((parsed as any)?.offline) ||
      resp.status === 503 ||
      resp.status === 502 ||
      resp.status === 504 ||
      resp.status === 424 ||
      upstreamStatus === 503 ||
      upstreamStatus === 502 ||
      upstreamStatus === 504;
    const isConflict = resp.status === 409 || Boolean((parsed as any)?.conflict);
    return {
      ok: resp.ok,
      status: resp.status,
      data: parsed,
      correlationId,
      offline: isOffline && !resp.ok,
      conflict: isConflict,
      error: resp.ok ? null : parsedErr || `Błąd serwera HTTP ${resp.status}`,
    };
  } catch (err: any) {
    return {
      ok: false,
      status: resp.status,
      data: null,
      correlationId,
      error: `Niepoprawny format odpowiedzi JSON (HTTP ${resp.status}): ${err?.message || String(err)}`,
    };
  }
}

export interface SafeFetchJsonOptions extends Omit<RequestInit, 'signal'> {
  timeoutMs?: number;
  signal?: AbortSignal;
  correlationId?: string;
  maxRetries?: number;
}

const OPERATOR_TOKEN_STORAGE_KEY = 'svl_operator_token';

function readInitialOperatorToken(): string {
  try {
    if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
      const saved = window.localStorage.getItem(OPERATOR_TOKEN_STORAGE_KEY);
      if (saved && saved.trim()) {
        return saved.trim().slice(0, 512);
      }
    }
  } catch {
    // ignore storage restriction
  }
  return '';
}

let svlOperatorAccessToken = readInitialOperatorToken();
export function setSvlOperatorAccessToken(value: string): void {
  const clean = String(value || '').trim().slice(0, 512);
  const changed = svlOperatorAccessToken !== clean;
  svlOperatorAccessToken = clean;
  try {
    if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
      if (clean) {
        window.localStorage.setItem(OPERATOR_TOKEN_STORAGE_KEY, clean);
      } else {
        window.localStorage.removeItem(OPERATOR_TOKEN_STORAGE_KEY);
      }
    }
    if (changed && typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('svl-operator-token-changed', { detail: clean }));
    }
  } catch {
    // ignore storage restriction
  }
}
export function getSvlOperatorAccessToken(): string {
  if (!svlOperatorAccessToken) {
    const fromStorage = readInitialOperatorToken();
    if (fromStorage) {
      svlOperatorAccessToken = fromStorage;
    }
  }
  return svlOperatorAccessToken;
}
// Serwer domyślnie NIE wymaga SVL_OPERATOR_TOKEN (wymóg włącza SVL_REQUIRE_OPERATOR_TOKEN=1).
// Tryb potwierdza /api/operator/status (pole tokenRequired); do tego czasu zakładamy domyślny.
let svlOperatorTokenRequired = false;
export function setSvlOperatorTokenRequired(required: boolean): void {
  const next = Boolean(required);
  if (next === svlOperatorTokenRequired) return;
  svlOperatorTokenRequired = next;
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('svl-operator-token-changed', { detail: getSvlOperatorAccessToken() }));
    }
  } catch {
    // ignore
  }
}
export function isSvlOperatorTokenRequired(): boolean {
  return svlOperatorTokenRequired;
}
/** Czy przeglądarka ma prawa operatora: token wpisany albo serwer go nie wymaga. */
export function hasSvlOperatorAccessToken(): boolean {
  return !svlOperatorTokenRequired || getSvlOperatorAccessToken().length > 0;
}


export async function safeFetchJson<T = any>(
  url: string,
  options: SafeFetchJsonOptions = {},
): Promise<SafeJsonResult<T>> {
  const {
    timeoutMs = 20000,
    signal: externalSignal,
    correlationId: providedCorrId,
    maxRetries,
    headers: initHeaders,
    ...restInit
  } = options;

  const method = String(restInit.method || 'GET').toUpperCase();
  const correlationId = providedCorrId || createUniqueId('req');
  // Only safe idempotent GETs automatically retry on transient transport/503 errors,
  // while Cloud Run / preview proxy HTML warmup pages (never reaching Express) always retry up to 2 times.
  const baseAttempts = 1 + (maxRetries !== undefined ? maxRetries : method === 'GET' ? 1 : 0);
  const maxHtmlWarmupAttempts = 3;
  const maxLoopAttempts = Math.max(baseAttempts, maxHtmlWarmupAttempts);

  for (let attempt = 0; attempt < maxLoopAttempts; attempt++) {
    if (externalSignal?.aborted) {
      return {
        ok: false,
        status: 0,
        data: null,
        correlationId,
        aborted: true,
        error: 'Żądanie anulowane.',
      };
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const onExternalAbort = () => controller.abort();
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const mergedHeaders = new Headers(initHeaders || {});
      // Never forward operator credentials to third-party or absolute URLs.
      if (typeof window !== 'undefined' && url.startsWith('/api/')) {
        const activeToken = getSvlOperatorAccessToken();
        if (activeToken && !mergedHeaders.has('X-SVL-Operator-Token')) {
          mergedHeaders.set('X-SVL-Operator-Token', activeToken);
        }
      }
      if (!mergedHeaders.has('Accept')) mergedHeaders.set('Accept', 'application/json');
      if (!mergedHeaders.has('X-Request-Id')) mergedHeaders.set('X-Request-Id', correlationId);
      if (restInit.body && !mergedHeaders.has('Content-Type')) {
        mergedHeaders.set('Content-Type', 'application/json');
      }

      const reqStartedAt = performance.now();
      const resp = await fetch(url, {
        ...restInit,
        method,
        headers: mergedHeaders,
        signal: controller.signal,
      });

      const parsed = await safeParseJsonResponse<T>(resp);
      parsed.correlationId = parsed.correlationId || correlationId;
      trackGuiApiCall({
        method,
        url,
        status: resp.status,
        ok: parsed.ok,
        durationMs: performance.now() - reqStartedAt,
        correlationId: parsed.correlationId,
        error: parsed.error,
      });

      const isTransientStatus =
        resp.status === 502 || resp.status === 503 || resp.status === 504 || Boolean(parsed.proxyHtml);
      const canRetryBase = attempt < baseAttempts - 1;
      const canRetryHtmlWarmup = Boolean(parsed.proxyHtml && attempt < maxHtmlWarmupAttempts - 1);
      if (!parsed.ok && isTransientStatus && (canRetryBase || canRetryHtmlWarmup)) {
        const delay = Math.round(500 * Math.pow(2, attempt) + Math.random() * 200);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      return parsed;
    } catch (err: any) {
      if (externalSignal?.aborted && !timedOut) {
        return {
          ok: false,
          status: 0,
          data: null,
          correlationId,
          aborted: true,
          error: 'Żądanie zostało anulowane.',
        };
      }

      const isLastBase = attempt >= baseAttempts - 1;
      if (!isLastBase && method === 'GET') {
        const delay = Math.round(250 * Math.pow(2, attempt) + Math.random() * 150);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      const failureError = timedOut
        ? `Przekroczono limit czasu (${Math.round(timeoutMs / 1000)}s) połączenia z ${url}.`
        : `Brak połączenia z backendem (${err?.message || 'offline'}).`;
      trackGuiApiCall({
        method,
        url,
        status: 0,
        ok: false,
        durationMs: 0,
        correlationId,
        error: failureError,
      });
      return {
        ok: false,
        status: 0,
        data: null,
        correlationId,
        offline: !timedOut,
        error: failureError,
      };
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  return {
    ok: false,
    status: 0,
    data: null,
    correlationId,
    offline: true,
    error: 'Błąd transportu sieciowego.',
  };
}

export function createUniqueId(prefix = 'id'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export type CanonicalAgentShort = string;

export function resolveAvatarProfileKey(
  sender?: string | null,
  agentId?: string | null,
): AvatarProfileKey | null {
  const rawAgent = String(agentId || '').trim().toLowerCase();
  const rawSender = String(sender || '').trim().toLowerCase();

  if (rawAgent === 'bielik' || rawSender === 'bielik' || rawSender === 'bielik ai') {
    return 'Bielik';
  }
  if (
    rawAgent === 'maya' ||
    rawAgent === 'maya mitek' ||
    rawSender === 'maya' ||
    rawSender === 'maya ai' ||
    rawSender === 'maya svl-364' ||
    rawSender === 'maya mitek' ||
    rawSender === 'maya mitek ai' ||
    rawSender === 'maya mitek svl-364'
  ) {
    return 'Maya';
  }
  if (
    rawAgent === 'komputerpokladowy' ||
    rawAgent === 'komputer pokładowy' ||
    rawAgent === 'komputer pokladowy' ||
    rawSender === 'komputer pokładowy' ||
    rawSender === 'komputer pokladowy' ||
    rawSender === 'komputerpokladowy' ||
    rawSender === 'svl-364 komputer pokładowy' ||
    rawSender === 'komputer pokładowy svl-364'
  ) {
    return 'KomputerPokladowy';
  }
  if (
    rawAgent === 'system_si_1' ||
    rawAgent === 'system-si-1' ||
    rawAgent === 'systemsi1' ||
    rawAgent === 'system_si' ||
    rawSender === 'system_si_1' ||
    rawSender === 'system-si-1' ||
    rawSender === 'systemsi1' ||
    rawSender === 'system si 1' ||
    rawSender === 'system_si' ||
    rawSender === 'system si'
  ) {
    return 'System_SI_1';
  }
  if (rawAgent === 'operator' || rawSender === 'operator' || rawSender.includes('mateusz mitek')) {
    return 'Operator';
  }

  return null;
}

export function validateAvatarUrlOrDataUri(
  raw: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    return { ok: false, error: 'Podaj adres HTTPS lub wybierz obraz PNG/JPG/WEBP.' };
  }
  if (trimmed.length > 3_600_000) {
    return { ok: false, error: 'Obraz awatara jest zbyt duży (maks. ~2.5 MB).' };
  }
  if (/^data:image\/(?:png|jpeg|jpg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/i.test(trimmed)) {
    return { ok: true, value: trimmed };
  }
  if (trimmed.startsWith('/') && !trimmed.startsWith('//') && !trimmed.includes('..')) {
    return { ok: true, value: trimmed };
  }
  try {
    const parsed = new URL(trimmed);
    if (
      parsed.protocol === 'https:' ||
      (parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'))
    ) {
      return { ok: true, value: parsed.toString() };
    }
  } catch {
    // invalid URL handled below
  }
  return {
    ok: false,
    error: 'Nieprawidłowe źródło awatara. Użyj adresu HTTPS lub obrazu PNG/JPG/WEBP.',
  };
}
