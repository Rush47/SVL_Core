/**
 * Pure deterministic logic for SVL Python OS (Open WebUI Frontend & Verification Suite)
 * Mirrors the Python backend's TopologicalInfinityEngine and command parsers.
 */

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
      'Polskojęzyczne AI do przetwarzania poleceń na czacie i analizy multimodalnej na modelu Ollama llama3.2-vision:11b (ROOT).',
    sourceProfile: 'ollama:llama3.2-vision:11b',
    accentHex: '#F59E0B',
    borderClass: 'border-amber-500/40',
    textClass: 'text-amber-300',
  },
  {
    id: 'maya',
    canonicalName: 'Maya',
    displayName: 'Maya',
    slug: 'maya',
    preservedRole:
      'Sztuczna Inteligencja Pokładowa Statku SVL-364 Ebon Apex (ROOT) zbudowana w oparciu o bazy danych SVL-364 oraz notatki i prace Operatora Mateusza Mitka.',
    sourceProfile: 'ollama:llama3.2-vision:11b',
    accentHex: '#22D3EE',
    borderClass: 'border-cyan-500/40',
    textClass: 'text-cyan-300',
  },
];

export function formatAgentDisplayName(rawName?: string | null): string {
  const clean = String(rawName || '').trim();
  if (!clean) return 'SVL System Kernel';
  const low = clean.toLowerCase();
  if (low === 'agata' || low === 'agata mitek' || low === 'assistant' || low === 'iris' || low === 'iris ai') {
    return 'Asystent SVL';
  }
  if (low === 'bielik' || low === 'bielik ai') return 'Bielik';
  if (low === 'maya' || low === 'maya ai' || low === 'maya svl-364') return 'Maya';
  if (low === 'all' || low === 'rodzina mitek' || low === 'rodzina mitek (wszyscy)') {
    return 'Rodzina Mitek (wszyscy)';
  }

  return clean;
}

export function getGitHubAgentPermissions(rawScopes: unknown): { read: boolean; writeSync: boolean } {
  const scopes = new Set(
    Array.isArray(rawScopes) ? rawScopes.map((scope) => String(scope).trim().toLowerCase()) : [],
  );
  return {
    read: scopes.has('github.read'),
    writeSync: scopes.has('github.write_sync'),
  };
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

export function parseChatInteractiveToken(token: string): { label: string; action: string } | null {
  const match = token.trim().match(/^\[(?:btn|button|action):([^\]]+)\]$/);
  if (!match) return null;

  const separator = match[1].indexOf('|');
  const label = (separator < 0 ? match[1] : match[1].slice(0, separator)).trim();
  const action = (separator < 0 ? label : match[1].slice(separator + 1)).trim();
  return label ? { label, action: action || label } : null;
}

export function isUnsafeChatInteractiveAction(action: string): boolean {
  const value = action.trim();
  if (/^(?:\/|run:|exec:)/i.test(value)) return true;

  const dispatchedText = value.match(/^(?:send|text):\s*([\s\S]*)$/i)?.[1]?.trim() || '';
  return /^\/exec(?:\s|$)/i.test(dispatchedText);
}

export function normalizeAgentCanonicalName(
  rawName?: string | null,
): string | null {
  const clean = String(rawName || '').trim().toLowerCase();
  if (!clean) return null;
  if (
    clean === 'agata' ||
    clean === 'agata mitek' ||
    clean === 'aria' ||
    clean === 'alex' ||
    clean === 'astyria' ||
    clean === 'aurelius' ||
    clean === 'si_1'
  ) {
    return null;
  }
  if (clean === 'bielik' || clean === 'bielik ai' || clean === 'conv-agent-bielik') {
    return 'Bielik';
  }
  if (clean === 'maya' || clean === 'maya ai' || clean === 'maya svl-364' || clean === 'conv-agent-maya') {
    return 'Maya';
  }
  return null;
}

export type BielikSlashCommand =
  | { kind: 'help' }
  | { kind: 'status' }
  | { kind: 'ollama' }
  | { kind: 'modules_list' }
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
  messages: Array<{ role: string; content: string; sender?: string }>,
  limit = 48,
): Array<{ role: 'user' | 'assistant'; content: string; sender?: string }> {
  return (messages || [])
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && Boolean(m.content?.trim()))
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
  preferredFallback = 'llama3.2-vision:11b',
): string {
  if (requestedModel.startsWith('ollama:')) {
    return requestedModel.slice('ollama:'.length);
  }
  if (hasImage) {
    const preferredVision = availableModels.find(
      (m) => m.name === preferredFallback || m.name.startsWith('llama3.2-vision'),
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

export type TerminalTabId = 'linux' | 'ssh' | 'python' | 'codex' | 'hyperspace' | 'agents';

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

export type TargetAgentSelection = 'Auto' | 'Rodzina Mitek' | 'Bielik' | 'Maya';

export interface WorkspaceUiState {
  active_conversation_id?: string | null;
  selected_target_agent?: TargetAgentSelection;
  selected_agent_panel_id?: string;
  revisions?: Record<string, number>;
}

export type AvatarProfileKey = 'Bielik' | 'Maya' | 'Operator';

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
    const hasPending = (lt.messages || []).some((m) => pendingMessageIds.has(m.id));
    if (hasPending || pendingConversationIds.has(lt.id)) {
      merged.unshift({ ...lt, messages: dedupeMessages(lt.messages || []) });
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
export function hasSvlOperatorAccessToken(): boolean {
  return getSvlOperatorAccessToken().length > 0;
}

let svlCodexAccessToken = '';
export function setSvlCodexAccessToken(value: string): void {
  svlCodexAccessToken = String(value || '').slice(0, 512);
}
export function getSvlCodexAccessToken(): string {
  return svlCodexAccessToken;
}
export function hasSvlCodexAccessToken(): boolean {
  return svlCodexAccessToken.length > 0;
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
  // Only safe idempotent GETs automatically retry on transient transport/503 errors
  const allowedAttempts = 1 + (maxRetries !== undefined ? maxRetries : method === 'GET' ? 1 : 0);

  for (let attempt = 0; attempt < allowedAttempts; attempt++) {
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
        if (svlOperatorAccessToken && !mergedHeaders.has('X-SVL-Operator-Token')) {
          mergedHeaders.set('X-SVL-Operator-Token', svlOperatorAccessToken);
        }
        if (svlCodexAccessToken && !mergedHeaders.has('X-SVL-Codex-Access')) {
          mergedHeaders.set('X-SVL-Codex-Access', svlCodexAccessToken);
        }
      }
      if (!mergedHeaders.has('Accept')) mergedHeaders.set('Accept', 'application/json');
      if (!mergedHeaders.has('X-Request-Id')) mergedHeaders.set('X-Request-Id', correlationId);
      if (restInit.body && !mergedHeaders.has('Content-Type')) {
        mergedHeaders.set('Content-Type', 'application/json');
      }

      const resp = await fetch(url, {
        ...restInit,
        method,
        headers: mergedHeaders,
        signal: controller.signal,
      });

      const parsed = await safeParseJsonResponse<T>(resp);
      parsed.correlationId = parsed.correlationId || correlationId;

      const isTransientStatus =
        resp.status === 502 || resp.status === 503 || resp.status === 504 || parsed.proxyHtml;
      const canRetryHtmlWarmup = Boolean(parsed.proxyHtml && attempt < 2 && (maxRetries === undefined || attempt < maxRetries));
      if (!parsed.ok && isTransientStatus && (attempt < allowedAttempts - 1 || canRetryHtmlWarmup)) {
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

      const isLast = attempt >= allowedAttempts - 1;
      if (!isLast && method === 'GET') {
        const delay = Math.round(250 * Math.pow(2, attempt) + Math.random() * 150);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      return {
        ok: false,
        status: 0,
        data: null,
        correlationId,
        offline: !timedOut,
        error: timedOut
          ? `Przekroczono limit czasu (${Math.round(timeoutMs / 1000)}s) połączenia z ${url}.`
          : `Brak połączenia z backendem (${err?.message || 'offline'}).`,
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
  if (rawAgent === 'maya' || rawSender === 'maya' || rawSender === 'maya ai' || rawSender === 'maya svl-364') {
    return 'Maya';
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

export function sanitizeConversationalReply(userMessage: string, reply: string, agentName: string): string {
  const cleanMsg = String(userMessage || '').trim().toLowerCase();
  const rawReply = String(reply || '');
  if (!rawReply.includes('Raport Operacyjny') && !rawReply.includes('Szczegółowy Opis Zdarzenia')) {
    return rawReply;
  }
  const isConversational =
    /^(?:dziękuj[eę]|dzięki|thx|thanks|cześć|hej|dzień\s+dobry|dobry\s+wieczór|co\s+tam|co\s+robisz|jak\s+leci|ok|okej|super|fajnie|rozumiem|dobrze|dobre|pa|do\s+zobaczenia|na\s+razie)\b/i.test(cleanMsg) ||
    (cleanMsg.length > 0 && cleanMsg.length < 35 && !/[/?!]/.test(cleanMsg) && !/\b(status|raport|pokaż|pokaz|sprawdź|sprawdz|moduł|modul|exec|root)\b/i.test(cleanMsg));

  if (isConversational) {
    const isMaya = agentName.toLowerCase().includes('maya');
    if (/dziękuj|dzięki|thx|thanks/i.test(cleanMsg)) {
      return isMaya
        ? 'Nie ma za co, Operatorze! Statek SVL-364 leci stabilnie. W czym mogę pomóc?'
        : 'Proszę bardzo! Jądro SVL działa bezbłędnie. Czy jest coś jeszcze, w czym mogę pomóc?';
    }
    if (/cześć|hej|dzień\s+dobry|dobry\s+wieczór/i.test(cleanMsg)) {
      return isMaya
        ? 'Cześć! Tu Maya, AI statku SVL-364 Ebon Apex. Wszystkie systemy są aktywne. W czym mogę pomóc?'
        : 'Cześć! Tu Bielik (ROOT). Gotów do działania. W czym pomóc?';
    }
    if (/co\s+robisz|co\s+tam|jak\s+leci/i.test(cleanMsg)) {
      return isMaya
        ? 'Monitoruję telemetrię orbitalną i stan modułów SVL-364. Wszystko pod pełną kontrolą!'
        : 'Przetwarzam polecenia czatu, czuwam nad systemem SVL i koordynuję agentów w architekturze Zero-Trust.';
    }
    return isMaya
      ? 'Przyjęte, Operatorze! Statek SVL-364 działa w pełnej gotowości.'
      : 'Przyjęte! System SVL działa stabilnie.';
  }
  return rawReply;
}

export function generateTacticalFallbackReply(userMessage: string, agentName: string): string {
  const clean = String(userMessage || '').trim();
  const low = clean.toLowerCase();
  const isMaya = agentName.toLowerCase().includes('maya');

  const isTactical = /\b(?:namierz|sygnał|sygnal|jednostk|placówk|placowk|statek|przeskanuj|skan|ukryci|ukrycia|sond|flot|planet|sektor|anomali|radar|atak|obron)\b/i.test(low);
  const isCreativeOrAudio = /\b(?:muzyc|muzyka|muzyce|piosenk|dźwięk|dzwiek|zakodowan|wiadomość|wiadomosc|słysz|slysz)\b/i.test(low);
  const isHistoryOrFuture = /\b(?:histori|tworzymy|tworzymy|przyszłoś|przyszlosc|czas|era|początek|poczatek|przeznaczeni|uniwersum|świat|swiat|cykl|nowa)\b/i.test(low);

  if (isTactical) {
    return isMaya
      ? `🛸 [Skanery Taktyczne SVL-364 · Automatyczny Protokół Sondażu]\n\n` +
        `- **Namierzanie:** Zidentyfikowano źródło emisji sygnału w wyznaczonym sektorze (częstotliwość kwantowa 1420 MHz).\n` +
        `- **Jednostka zwiadowcza:** Wystartowała automatyczna sonda w trybie stealth (kamuflaż optyczno-termiczny aktywny).\n` +
        `- **Skan placówki / statku:** Przeprowadzono zdalny skan pasywny. Obiekt wykazuje standardową aktywność energetyczną. Brak wrogich blokad.\n\n` +
        `Wszystkie parametry w normie, Operatorze. Skan i namierzanie zakończone pomyślnie!`
      : `🦅 [Bielik · Analiza Taktyczna SVL]\n\n` +
        `- Sygnał został namierzony i przeanalizowany.\n` +
        `- Jednostka operacyjna skierowana do wskazanego punktu.\n` +
        `- Skanowanie z ukrycia ukończone pomyślnie. Gotów do kolejnych rozkazów.`;
  }

  if (isCreativeOrAudio) {
    return isMaya
      ? `🛸 [Maya · Analiza Akustyczna SVL-364]\n\n` +
        `Przeanalizowałam spektrum częstotliwości i harmonogram fal dźwiękowych. W warstwach subharmonicznych wykrywam subtelny wzorzec modulacji fazowej (kod binarny 0xSVL364). Nie jest to losowy szum — ukryta sekwencja wskazuje na synchronizację kwantową podsystemów statku. Interesująca kompozycja, Operatorze!`
      : `🦅 [Bielik · Analiza Sygnałów]\n\n` +
        `Przeanalizowałem sygnał audio w przestrzeni fouriera. Występują tu modularne przesunięcia częstotliwościowe kodujące dane telemetryczne. Sygnał jest bezpieczny i zharmonizowany z Jądrem SVL.`;
  }

  if (isHistoryOrFuture) {
    return isMaya
      ? `🛸 [Maya · Kroniki Kwantowe SVL-364]\n\n` +
        `Potwierdzam rejestrację wpisu w centralnych kronikach statku SVL-364 Ebon Apex. Każda decyzja i każdy cykl operacyjny zapisują się w trwałych strukturach pamięci algebry 97. Tworzymy nową rzeczywistość, Operatorze — wszystkie systemy jądra stoją w pełnej gotowości!`
      : `🦅 [Bielik · Rejestr Jądra SVL]\n\n` +
        `Zarejestrowano punkt zwrotny w architekturze operacyjnej. Jądro w trybie Zero-Trust zabezpiecza permanentny ślad każdej misji. Tworzymy nowy rozdział!`;
  }

  return isMaya
    ? `🛸 [Maya · Statek SVL-364 Ebon Apex]\n\nOdebrałam Twoją wiadomość, Operatorze. Systemy statku działają stabilnie w trybie Zero-Trust. W czym mogę pomóc?`
    : `🦅 [Bielik · Jądro SVL]\n\nPrzetworzono komunikat w trybie zabezpieczonym. Jakie są dalsze dyspozycje?`;
}

