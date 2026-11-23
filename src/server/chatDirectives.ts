// Deterministic recognition of operator commands written in chat.
//
// Commands are recognised here, before any language model is called, so the
// gateway can execute them immediately and broadcast the resulting state
// changes. Slash commands keep their exact syntax; natural Polish sentences
// are matched by narrow patterns so that ordinary conversation never mutates
// state.

import { parseBielikChatCommand, type BielikSlashCommand } from '../utils/svlLogic.ts';

export interface KnownModule {
  id: string;
  name?: string;
  kind?: string;
  description?: string;
}

export interface ParseChatDirectivesOptions {
  knownModules?: KnownModule[];
}

type ModuleStatus = 'ACTIVE' | 'CONFIGURED' | 'STANDBY';

// Ile poleceń serwerowych wykona jedna wiadomość. Operator ROOT bywa wydaje kilka naraz.
const MAX_DIRECTIVES = 12;
// JavaScript's \b does not understand Polish letters, so boundaries are explicit.
const B = '(?<![\\p{L}\\p{N}_])';
const E = '(?![\\p{L}\\p{N}_])';
const MODULE_WORD = `modu(?:ł|l)(?:u|y)?${E}`;
const MODULE_ID = '[`"\'„]?([a-z0-9][a-z0-9._-]{1,63})[`"\'”]?';

const re = (source: string) => new RegExp(source, 'iu');

const MEMORY_SAVE_PATTERNS = [
  re(`${B}(?:zapisz|dodaj|wpisz)\\s+(?:to\\s+)?(?:w|do)\\s+pami(?:ę|e)ci(?:\\s+d(?:ł|l)ugotrwa(?:ł|l)ej)?${E}\\s*[,:]?\\s*(?:(?:że|ze)${E}\\s*)?(.+)$`),
  re(`${B}(?:zapami(?:ę|e)taj|pami(?:ę|e)taj)(?:\\s+sobie)?${E}\\s*[,:]?\\s*(?:(?:że|ze)${E}\\s*)?(.+)$`),
];

const STATUS_WORDS: Array<[RegExp, ModuleStatus]> = [
  [re(`^(?:active|aktywn\\p{L}*|w(?:ł|l)(?:ą|a)czon\\p{L}*)$`), 'ACTIVE'],
  [re(`^(?:standby|czuwani\\p{L}*|u(?:ś|s)pion\\p{L}*|wstrzyman\\p{L}*|wy(?:ł|l)(?:ą|a)czon\\p{L}*|nieaktywn\\p{L}*)$`), 'STANDBY'],
  [re(`^(?:configured|skonfigurowan\\p{L}*)$`), 'CONFIGURED'],
];

const MODULE_SET_STATUS = re(
  `${B}(?:ustaw|zmie(?:ń|n)|prze(?:ł|l)(?:ą|a)cz)\\s+${MODULE_WORD}\\s+${MODULE_ID}\\s+(?:(?:na|w|jako)\\s+)?(?:(?:tryb|stan|status)\\s+)?([\\p{L}]+)`,
);
const MODULE_ACTIVATE = re(`${B}(?:aktywuj|w(?:ł|l)(?:ą|a)cz|uruchom)\\s+${MODULE_WORD}\\s+${MODULE_ID}(?![a-z0-9._-])`);
const MODULE_DEACTIVATE = re(
  `${B}(?:dezaktywuj|wy(?:ł|l)(?:ą|a)cz|wstrzymaj|u(?:ś|s)pij)\\s+${MODULE_WORD}\\s+${MODULE_ID}(?![a-z0-9._-])`,
);
const MODULE_CREATE = re(
  `${B}(?:dodaj|utw(?:ó|o)rz|stw(?:ó|o)rz|zarejestruj)\\s+(?:nowy\\s+)?${MODULE_WORD}\\s+${MODULE_ID}(?![a-z0-9._-])\\s*[,:\\-–—]?\\s*(.*)$`,
);

const SIMPLE_RULES: Array<[RegExp, () => BielikSlashCommand]> = [
  [re(`${B}(?:poka(?:ż|z)|wy(?:ś|s)wietl|wypisz)\\s+(?:swoj(?:ą|a)\\s+)?pami(?:ę|e)(?:ć|c)${E}|${B}co\\s+pami(?:ę|e)tasz${E}`), () => ({ kind: 'memory_list' })],
  [re(`${B}(?:sprawd(?:ź|z)|poka(?:ż|z))\\s+(?:status|stan)\\s+ollam\\p{L}*`), () => ({ kind: 'ollama' })],
  [re(`${B}(?:sprawd(?:ź|z)|poka(?:ż|z))\\s+(?:status|stan|telemetri\\p{L}*)\\s+(?:systemu|j(?:ą|a)dra|svl)${E}`), () => ({ kind: 'status' })],
  [re(`${B}(?:(?:poka(?:ż|z)|wy(?:ś|s)wietl|wypisz)\\s+(?:wszystkie\\s+)?|lista\\s+)modu(?:ł|l)(?:y|(?:ó|o)w)${E}`), () => ({ kind: 'modules_list' })],
  [re(`${B}(?:pod(?:ł|l)(?:ą|a)cz|po(?:ł|l)(?:ą|a)cz|uruchom|zsynchronizuj|synchronizuj)\\s+(?:lokaln\\p{L}+\\s+)?(?:worker\\p{L}*|agent(?:a|ów|ow|y)?|jyn)${E}`), () => ({ kind: 'agent_connect' })],
  [re(`${B}(?:oblicz|policz|wyznacz)\\s+topologi\\p{L}*`), () => ({ kind: 'topology', xStart: '-inf', xEnd: 'inf' })],
];

const AGENT_TASK = re(`${B}(?:zle(?:ć|c)|dodaj)\\s+zadanie${E}\\s*[:\\-–—]?\\s*(.+)$`);
const ROOT_EXEC = re(`${B}(?:wykonaj|uruchom)\\s+(?:polecenie|komend(?:ę|e))\\s+\`([^\`]{1,1000})\``);
const UI_THEME = re(
  `${B}(?:zmie(?:ń|n)|ustaw|prze(?:ł|l)(?:ą|a)cz|w(?:ł|l)(?:ą|a)cz)\\s+(?:design|motyw|wygl(?:ą|a)d)${E}\\s*(?:na\\s+)?(apex|ciemny|midnight|nocny|emerald|zielony|violet|fioletowy|fiolet)${E}`,
);
const UI_ACCENT = re(
  `${B}(?:zmie(?:ń|n)|ustaw)\\s+(?:kolor\\s+)?akcent(?:u|em|owy)?${E}\\s*(?:na\\s+)?(cyan|niebieski|emerald|zielony|violet|fioletowy|fiolet|amber|bursztynowy|pomara(?:ń|n)czowy)${E}`,
);
const UI_TAB = re(
  `${B}(?:otw(?:ó|o)rz|poka(?:ż|z)|prze(?:ł|l)(?:ą|a)cz|wy(?:ś|s)wietl)\\s+(?:panel|zak(?:ł|l)adk(?:ę|e))\\s+(?:na\\s+)?(czat|chat|apex|statek|svl[ -]?364|infrastruktura|agenci|galeria|terminale|j(?:ą|a)dro|kernel|linux)${E}`,
);

function mapStatusWord(word: string): ModuleStatus | null {
  for (const [pattern, status] of STATUS_WORDS) {
    if (pattern.test(word)) return status;
  }
  return null;
}

function cleanTail(value: string): string {
  return value.trim().replace(/[\s.!]+$/u, '').trim();
}

function statusChange(id: string, status: ModuleStatus, known: Map<string, KnownModule>): BielikSlashCommand | null {
  const existing = known.get(id.toLowerCase());
  if (!existing) return null;
  return {
    kind: 'module_upsert',
    id: existing.id,
    status,
    name: existing.name || existing.id,
    description: existing.description || '',
    moduleKind: existing.kind,
    preserveExisting: true,
  };
}

const OS_SYNC_RE = re(
  `${B}(?:z?synchronizuj|od(?:ś|s)wie(?:ż|z)|pobierz\\s+zmiany|wy(?:ś|s)lij\\s+zmiany|zr(?:ó|o)b\\s+(?:pe(?:ł|l)n[ąa]\\s+)?synchronizacj\\p{L}*)${E}.*?(?:system|github|repozytori|kod|globaln|zmiany|$)|${B}synchronizuj${E}`,
);
const AUTONOMY_ON_RE = re(
  `${B}(?:w(?:ł|l)(?:ą|a)cz|uruchom|aktywuj)\\s+(?:sobie\\s+)?(?:automatyczn\\p{L}*\\s+)?(?:dzia(?:ł|l)anie\\s+w\\s+tle|autonomi\\p{L}*|tryb\\s+autonomiczn\\p{L}*|prac(?:ę|e)\\s+w\\s+tle)(?:${E}|$)`,
);
const AUTONOMY_OFF_RE = re(
  `${B}(?:wy(?:ł|l)(?:ą|a)cz|zatrzymaj|dezaktywuj)\\s+(?:automatyczn\\p{L}*\\s+)?(?:dzia(?:ł|l)anie\\s+w\\s+tle|autonomi\\p{L}*|tryb\\s+autonomiczn\\p{L}*|prac(?:ę|e)\\s+w\\s+tle)(?:${E}|$)`,
);

/** Stable identity of a command, used to avoid executing the same command twice in one chat turn. */
export function commandKey(cmd: BielikSlashCommand): string {
  return JSON.stringify(cmd, Object.keys(cmd).sort());
}

/** Commands that change persisted state and therefore must be broadcast to every client. */
export function isMutatingCommand(cmd: BielikSlashCommand): boolean {
  return (
    cmd.kind === 'os_sync' ||
    cmd.kind === 'module_upsert' ||
    cmd.kind === 'memory_save' ||
    cmd.kind === 'root_exec' ||
    cmd.kind === 'agent_connect' ||
    cmd.kind === 'agent_task' ||
    cmd.kind === 'ui_set' ||
    cmd.kind === 'autonomy_set'
  );
}

export function parseChatDirectives(
  rawMessage: string,
  options: ParseChatDirectivesOptions = {},
): BielikSlashCommand[] {
  const message = String(rawMessage || '').trim();
  if (!message) return [];

  if (message.startsWith('/')) {
    const slash = parseBielikChatCommand(message);
    return slash ? [slash] : [];
  }

  const known = new Map(
    (options.knownModules || [])
      .filter((mod) => mod && typeof mod.id === 'string' && mod.id)
      .map((mod) => [mod.id.toLowerCase(), mod] as const),
  );
  const commands: BielikSlashCommand[] = [];
  const push = (cmd: BielikSlashCommand | null) => {
    if (!cmd || commands.length >= MAX_DIRECTIVES) return;
    const key = commandKey(cmd);
    if (!commands.some((existing) => commandKey(existing) === key)) commands.push(cmd);
  };

  // Free-text memory content runs to the end of the message; only the text
  // before it is searched for further directives.
  let text = message;
  for (const pattern of MEMORY_SAVE_PATTERNS) {
    const match = pattern.exec(text);
    const content = match ? cleanTail(match[1]) : '';
    if (match && content.length >= 3) {
      push({ kind: 'memory_save', memoryKind: 'fact', content: content.slice(0, 800) });
      text = text.slice(0, match.index);
      break;
    }
  }

  if (OS_SYNC_RE.test(text)) {
    push({ kind: 'os_sync' });
  }
  if (AUTONOMY_ON_RE.test(text)) {
    push({ kind: 'autonomy_set', enabled: true });
  } else if (AUTONOMY_OFF_RE.test(text)) {
    push({ kind: 'autonomy_set', enabled: false });
  }

  const create = MODULE_CREATE.exec(text);
  if (create) {
    const id = create[1].toLowerCase();
    push({
      kind: 'module_upsert',
      id,
      status: 'ACTIVE',
      name: id,
      description: cleanTail(create[2] || '').slice(0, 500) || `Moduł ${id} utworzony z czatu`,
    });
  }

  const setStatus = MODULE_SET_STATUS.exec(text);
  if (setStatus) {
    const status = mapStatusWord(setStatus[2]);
    if (status) push(statusChange(setStatus[1], status, known));
  }
  const activate = MODULE_ACTIVATE.exec(text);
  if (activate) push(statusChange(activate[1], 'ACTIVE', known));
  const deactivate = MODULE_DEACTIVATE.exec(text);
  if (deactivate) push(statusChange(deactivate[1], 'STANDBY', known));

  for (const [pattern, build] of SIMPLE_RULES) {
    if (pattern.test(text)) push(build());
  }

  const task = AGENT_TASK.exec(text);
  if (task) {
    const [title, payload] = task[1].split('|').map((part) => cleanTail(part));
    if (title) push({ kind: 'agent_task', title: title.slice(0, 220), payload: (payload || title).slice(0, 2000) });
  }

  const exec = ROOT_EXEC.exec(text);
  if (exec && exec[1].trim()) push({ kind: 'root_exec', command: exec[1].trim() });

  const theme = UI_THEME.exec(text);
  if (theme) {
    const themeAliases: Record<string, string> = {
      apex: 'apex',
      ciemny: 'apex',
      midnight: 'midnight',
      nocny: 'midnight',
      emerald: 'emerald',
      zielony: 'emerald',
      violet: 'violet',
      fioletowy: 'violet',
      fiolet: 'violet',
    };
    push({ kind: 'ui_set', key: 'gui_theme', value: themeAliases[theme[1].toLowerCase()] });
  }

  const accent = UI_ACCENT.exec(text);
  if (accent) {
    const accentAliases: Record<string, string> = {
      cyan: 'cyan',
      niebieski: 'cyan',
      emerald: 'emerald',
      zielony: 'emerald',
      violet: 'violet',
      fioletowy: 'violet',
      fiolet: 'violet',
      amber: 'amber',
      bursztynowy: 'amber',
      pomarańczowy: 'amber',
      pomaranczowy: 'amber',
    };
    push({ kind: 'ui_set', key: 'gui_accent', value: accentAliases[accent[1].toLowerCase()] });
  }

  const tab = UI_TAB.exec(text);
  if (tab) {
    const normalized = tab[1].toLowerCase().replace(/[\s_-]/g, '');
    const tabAliases: Record<string, string> = {
      czat: 'chat',
      chat: 'chat',
      apex: 'apex',
      statek: 'svl364',
      svl364: 'svl364',
      infrastruktura: 'infrastructure',
      agenci: 'agents',
      galeria: 'gallery',
      terminale: 'terminals',
      jądro: 'kernel',
      jadro: 'kernel',
      kernel: 'kernel',
      linux: 'linux',
    };
    push({ kind: 'ui_set', key: 'active_workspace_tab', value: tabAliases[normalized] });
  }

  return commands;
}

export function workspaceUiCommand(settingRaw: string, valueRaw: string): BielikSlashCommand | null {
  const s = String(settingRaw || '').trim().toLowerCase();
  const v = String(valueRaw || '').trim().toLowerCase().replace(/[\s_-]/g, '');
  if (s === 'gui_theme' || s === 'theme' || s === 'motyw' || s === 'design' || s === 'wygląd' || s === 'wyglad') {
    const themeAliases: Record<string, string> = {
      apex: 'apex',
      ciemny: 'apex',
      midnight: 'midnight',
      nocny: 'midnight',
      emerald: 'emerald',
      zielony: 'emerald',
      violet: 'violet',
      fioletowy: 'violet',
      fiolet: 'violet',
    };
    const mapped = themeAliases[v];
    return mapped ? { kind: 'ui_set', key: 'gui_theme', value: mapped } : null;
  }
  if (s === 'gui_accent' || s === 'accent' || s === 'akcent' || s === 'kolor') {
    const accentAliases: Record<string, string> = {
      cyan: 'cyan',
      niebieski: 'cyan',
      emerald: 'emerald',
      zielony: 'emerald',
      violet: 'violet',
      fioletowy: 'violet',
      fiolet: 'violet',
      amber: 'amber',
      bursztynowy: 'amber',
      pomarańczowy: 'amber',
      pomaranczowy: 'amber',
    };
    const mapped = accentAliases[v];
    return mapped ? { kind: 'ui_set', key: 'gui_accent', value: mapped } : null;
  }
  if (s === 'active_workspace_tab' || s === 'tab' || s === 'panel' || s === 'zakładka' || s === 'zakladka') {
    const tabAliases: Record<string, string> = {
      czat: 'chat',
      chat: 'chat',
      apex: 'apex',
      statek: 'svl364',
      svl364: 'svl364',
      infrastruktura: 'infrastructure',
      infrastructure: 'infrastructure',
      agenci: 'agents',
      agents: 'agents',
      galeria: 'gallery',
      gallery: 'gallery',
      terminale: 'terminals',
      terminals: 'terminals',
      jądro: 'kernel',
      jadro: 'kernel',
      kernel: 'kernel',
      linux: 'linux',
    };
    const mapped = tabAliases[v];
    return mapped ? { kind: 'ui_set', key: 'active_workspace_tab', value: mapped } : null;
  }
  return null;
}

