// Warstwa akcji czatu dla modeli BEZ natywnego wywoływania narzędzi.
//
// Lokalne modele Ollamy (np. dolphin-llama3) odrzucają parametr `tools` (HTTP 400
// „does not support tools”). Wcześniej brama wtedy po cichu usuwała narzędzia, a model
// odpowiadał samym tekstem w stylu „Zrobione!”, choć w systemie nic się nie zmieniło.
// Tutaj model dostaje prosty protokół tekstowy: blok <svl_action>{…}</svl_action>,
// który serwer wycina z odpowiedzi, wykonuje tym samym kodem co natywne narzędzia
// i rozgłasza zmiany do wszystkich klientów.

export interface TextToolSpec {
  name: string;
  description?: string;
  parameters?: {
    properties?: Record<string, { type?: unknown; description?: string; enum?: unknown[] }>;
    required?: string[];
  };
}

export interface ParsedTextAction {
  tool: string;
  args: Record<string, unknown>;
}

export interface ExtractedTextActions {
  actions: ParsedTextAction[];
  /** Odpowiedź bez bloków akcji (bloki zastąpione znacznikiem `{{svl_action:N}}`). */
  text: string;
}

export const MAX_TEXT_ACTIONS = 8;

// JavaScript's \b nie rozumie polskich liter („zmień\b” nigdy nie pasuje), więc granice są jawne.
const B = '(?<![\\p{L}\\p{N}_])';
const E = '(?![\\p{L}\\p{N}_])';

const SYSTEM_COMMAND_WORDS = [
  'root', 'sudo', 'shell', 'bash', 'linux', 'ssh', 'sshd', 'demon\\p{L}*', 'usług\\p{L}*', 'uslug\\p{L}*',
  'serwis\\p{L}*', 'moduł\\p{L}*', 'modul\\p{L}*', 'kana[łl]\\p{L}*', 'komputer\\p{L}*', 'pokładow\\p{L}*',
  'pokladow\\p{L}*', 'pamię[ćc]\\p{L}*', 'pamiec\\p{L}*', 'zapamięt\\p{L}*', 'zapamiet\\p{L}*', 'wirus\\p{L}*',
  'antywirus\\p{L}*', 'skan\\p{L}*', 'raport\\p{L}*', 'synchroniz\\p{L}*', 'diagnost\\p{L}*', 'status\\p{L}*',
  'proces\\p{L}*', 'dysk\\p{L}*', 'ram', 'cpu', 'port\\p{L}*', 'jądr\\p{L}*', 'jadr\\p{L}*', 'apex', 'svl-?364',
  'zadani\\p{L}*', 'sprawdź', 'sprawdz', 'uruchom\\p{L}*', 'napraw\\p{L}*', 'popraw\\p{L}*', 'ulepsz\\p{L}*',
  'rozwi[ńn]\\p{L}*', 'rozwij\\p{L}*', 'wykonaj', 'zainstaluj', 'skonfiguruj', 'ustaw\\p{L}*', 'nadaj',
  'przyznaj', 'zaktualizuj', 'pobierz', 'usuń', 'usun\\p{L}*', 'dodaj', 'zmień', 'zmien\\p{L}*', 'stwórz',
  'stworz\\p{L}*', 'utwórz', 'utworz\\p{L}*', 'otwórz', 'otworz\\p{L}*', 'uprawnie\\p{L}*', 'wszystk\\p{L}*',
  'ollam\\p{L}*', 'model\\p{L}*', 'vision', 'plik\\p{L}*', 'katalog\\p{L}*', 'bielik\\p{L}*', 'may\\p{L}*',
  'agent\\p{L}*', 'misj\\p{L}*', 'pakiet\\p{L}*', 'komend\\p{L}*', 'polece[ńn]\\p{L}*', 'log\\p{L}*', 'mcp',
  'api',
  // Interfejs (GUI): wcześniej brakowało tych słów, więc model nie dostawał narzędzi do zmiany wyglądu.
  'motyw\\p{L}*', 'kolor\\p{L}*', 'akcent\\p{L}*', 'wygl[ąa]d\\p{L}*', 'design\\p{L}*', 'gui', 'ui',
  'interfejs\\p{L}*', 'panel\\p{L}*', 'zak[łl]adk\\p{L}*', 'ekran\\p{L}*', 'tryb\\p{L}*', 'w[łl][ąa]cz\\p{L}*',
  'wy[łl][ąa]cz\\p{L}*', 'prze[łl][ąa]cz\\p{L}*', 'aktywuj', 'dezaktywuj', 'poka[żz]\\p{L}*', 'zapisz',
  'wyślij', 'wyslij', 'zleć', 'zlec',
];
const SYSTEM_COMMAND_RE = new RegExp(`${B}(?:${SYSTEM_COMMAND_WORDS.join('|')})${E}`, 'iu');

/** Czy wiadomość Operatora wygląda na polecenie dla systemu (wtedy model dostaje narzędzia). */
export function isSystemCommandRequest(message: string): boolean {
  return SYSTEM_COMMAND_RE.test(String(message || ''));
}

function typeLabel(type: unknown): string {
  const t = String(type || '').toLowerCase();
  if (t.includes('number') || t.includes('integer')) return 'liczba';
  if (t.includes('bool')) return 'true/false';
  if (t.includes('array')) return 'lista';
  if (t.includes('object')) return 'obiekt';
  return 'tekst';
}

/** Instrukcja systemowa z protokołem <svl_action> i listą dostępnych akcji. */
export function buildTextActionProtocol(tools: TextToolSpec[]): string {
  const lines = tools.slice(0, 40).map((tool) => {
    const props = tool.parameters?.properties || {};
    const required = new Set(tool.parameters?.required || []);
    const params = Object.entries(props)
      .map(([name, spec]) => {
        const enumPart = Array.isArray(spec?.enum) && spec.enum.length > 0 ? ` = ${spec.enum.join('|')}` : '';
        return `${name}${required.has(name) ? '' : '?'}: ${typeLabel(spec?.type)}${enumPart}`;
      })
      .join(', ');
    const desc = String(tool.description || '').replace(/\s+/g, ' ').slice(0, 160);
    return `- ${tool.name}(${params}) — ${desc}`;
  });
  return [
    'WYKONYWANIE AKCJI W SYSTEMIE SVL (obowiązkowe):',
    'Ten model nie ma natywnych narzędzi. Gdy Operator każe coś zmienić, uruchomić, zapisać lub sprawdzić,',
    'wstaw w odpowiedzi blok (jeden na akcję, poprawny JSON w jednej linii):',
    '<svl_action>{"tool":"nazwa_narzędzia","args":{"parametr":"wartość"}}</svl_action>',
    'Serwer wykona każdy blok od razu, zapisze zmianę i natychmiast pokaże ją we wszystkich oknach aplikacji,',
    'a wynik dopisze w miejscu bloku. Nigdy nie pisz, że coś zrobiłeś, jeśli nie wstawiłeś bloku <svl_action>.',
    'Przykład: Operator: „zmień motyw na zielony” → <svl_action>{"tool":"svl_workspace_ui","args":{"setting":"gui_theme","value":"emerald"}}</svl_action>',
    'Dostępne akcje:',
    ...lines,
  ].join('\n');
}

const TAGGED_RE = /<svl_action>\s*([\s\S]*?)\s*<\/svl_action>/giu;
const FENCED_RE = /```(?:svl_action|svl-action|json)?\s*\n?(\{[\s\S]*?\})\s*```/giu;

function parseActionJson(raw: string, allowed: Set<string>): ParsedTextAction | null {
  let data: any;
  try {
    data = JSON.parse(raw.trim());
  } catch {
    // Modele często używają pojedynczych cudzysłowów lub przecinka na końcu.
    try {
      data = JSON.parse(raw.trim().replace(/,\s*([}\]])/g, '$1').replace(/'/g, '"'));
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const tool = String(data.tool ?? data.name ?? data.action ?? data.function ?? '').trim();
  if (!tool || !allowed.has(tool)) return null;
  let args = data.args ?? data.arguments ?? data.parameters ?? data.params ?? {};
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      args = {};
    }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
  return { tool, args: args as Record<string, unknown> };
}

/**
 * Wycina z odpowiedzi modelu bloki <svl_action> (oraz bloki ```json z polem „tool”
 * wskazującym dozwolone narzędzie). Nieznane narzędzia zostają w tekście bez zmian.
 */
export function extractTextActions(
  reply: string,
  allowedTools: Iterable<string>,
  max = MAX_TEXT_ACTIONS,
): ExtractedTextActions {
  const allowed = new Set(allowedTools);
  const actions: ParsedTextAction[] = [];
  const replaceWith = (match: string, body: string) => {
    if (actions.length >= max) return '';
    const parsed = parseActionJson(body, allowed);
    if (!parsed) return match;
    actions.push(parsed);
    return `{{svl_action:${actions.length - 1}}}`;
  };
  let text = String(reply || '').replace(TAGGED_RE, (m, body) => {
    const res = replaceWith(m, body);
    // Nieczytelny blok <svl_action> nie trafia do Operatora jako surowy JSON.
    return res === m ? '' : res;
  });
  text = text.replace(FENCED_RE, (m, body) => replaceWith(m, body));
  return { actions, text };
}

/** Wstawia wyniki akcji w miejsce znaczników; brakujące wyniki są usuwane. */
export function renderActionReceipts(text: string, receipts: string[]): string {
  return text
    .replace(/\{\{svl_action:(\d+)\}\}/g, (_m, idx) => {
      const receipt = receipts[Number(idx)];
      return receipt ? `\n${receipt}\n` : '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Krótki wynik akcji dla Operatora. */
export function formatActionReceipt(tool: string, result: Record<string, any> | null | undefined): string {
  const ok = Boolean(result && result.ok !== false && !result.error);
  const detail = String(
    (result && (result.summary || result.message || result.error)) || (ok ? 'wykonano' : 'błąd'),
  ).replace(/\s+/g, ' ').slice(0, 300);
  return `${ok ? '✅' : '❌'} \`${tool}\`: ${detail}`;
}

/**
 * Deklaracje narzędzi Gemini używają typów `Type.OBJECT` = "OBJECT". API zgodne z OpenAI
 * (xAI Grok) i Ollama oczekują JSON Schema z małymi literami ("object"), inaczej
 * mogą odrzucić całe żądanie. Konwersja jest rekurencyjna i nie zmienia oryginału.
 */
export function toJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map((item) => toJsonSchema(item));
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === 'type' && typeof value === 'string') {
      out[key] = value.toLowerCase();
    } else if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([name, prop]) => [name, toJsonSchema(prop)]),
      );
    } else if (key === 'items' || key === 'anyOf' || key === 'oneOf' || key === 'allOf') {
      out[key] = toJsonSchema(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}
