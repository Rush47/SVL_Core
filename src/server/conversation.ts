// Logika swobodnej rozmowy wielu uczestników (Operator + agenci AI).
//
// Model językowy widzi rozmowę z perspektywy jednego agenta: własne wypowiedzi jako
// `assistant`, a wypowiedzi Operatora i innych agentów jako `user` z etykietą
// „[Imię]: …”. Dzięki temu agent nie przypisuje sobie cudzych słów.

import { normalizeAgentCanonicalName } from '../utils/svlLogic.ts';

export type ConversationAgent = 'Bielik' | 'Maya';
export const CONVERSATION_AGENTS: ConversationAgent[] = ['Bielik', 'Maya'];
export const OPERATOR_LABEL = 'Mateusz (Operator)';

export interface DialogueTurn {
  role: string;
  sender?: string;
  content: string;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export type PauseReason = 'ai_turn_limit' | 'question_to_operator' | 'no_conversation';

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function agentOf(turn: DialogueTurn): ConversationAgent | null {
  if (turn.role !== 'assistant') return null;
  const canonical = normalizeAgentCanonicalName(turn.sender);
  return canonical === 'Bielik' || canonical === 'Maya' ? canonical : null;
}

function isDialogueTurn(turn: DialogueTurn): boolean {
  return (turn.role === 'user' || turn.role === 'assistant') && Boolean(String(turn.content || '').trim());
}

/** Rozmowa z perspektywy `speaker`; kolejne wypowiedzi tej samej roli są łączone. */
export function toAgentPerspective(turns: DialogueTurn[], speaker: ConversationAgent, limit = 24): ChatTurn[] {
  const out: ChatTurn[] = [];
  for (const turn of turns.filter(isDialogueTurn).slice(-limit)) {
    const content = turn.content.trim().slice(0, 6000);
    const author = agentOf(turn);
    // Starsze wpisy bez nadawcy traktujemy jak dotąd — jako własne.
    const own = turn.role === 'assistant' && (author === speaker || !turn.sender);
    const chatTurn: ChatTurn = own
      ? { role: 'assistant', content }
      : {
          role: 'user',
          content: `[${turn.role === 'user' ? OPERATOR_LABEL : author || turn.sender || 'Asystent'}]: ${content}`,
        };
    const last = out[out.length - 1];
    if (last && last.role === chatTurn.role) {
      last.content = `${last.content}\n\n${chatTurn.content}`;
    } else {
      out.push(chatTurn);
    }
  }
  while (out.length > 0 && out[0].role === 'assistant') out.shift();
  return out;
}

/** Kto mówi następny: agent przypisany do kanału, agent wywołany po imieniu, albo naprzemiennie. */
export function chooseNextSpeaker(turns: DialogueTurn[], channelAgent?: ConversationAgent | null): ConversationAgent {
  if (channelAgent) return channelAgent;
  const dialogue = turns.filter(isDialogueTurn);
  const last = dialogue[dialogue.length - 1];
  if (last && last.role === 'user') {
    const addressed = CONVERSATION_AGENTS.find((agent) =>
      new RegExp(`(?:^|[\\s@,(])${agent}(?![\\p{L}])`, 'iu').test(last.content),
    );
    if (addressed) return addressed;
  }
  const lastAgent = [...dialogue].reverse().map(agentOf).find(Boolean);
  if (lastAgent === 'Bielik') return 'Maya';
  return 'Bielik';
}

/** Czy autonomiczna wypowiedź AI powinna poczekać na Operatora. */
export function autonomousPauseReason(turns: DialogueTurn[], maxAiTurnsWithoutOperator: number): PauseReason | null {
  const dialogue = turns.filter(isDialogueTurn);
  if (dialogue.length === 0) return 'no_conversation';
  let aiTurns = 0;
  for (let i = dialogue.length - 1; i >= 0 && dialogue[i].role !== 'user'; i -= 1) aiTurns += 1;
  if (aiTurns >= maxAiTurnsWithoutOperator) return 'ai_turn_limit';
  const last = dialogue[dialogue.length - 1];
  if (last.role === 'assistant' && last.content.includes('?') && /(?:Mateusz|Operator)/i.test(last.content)) {
    return 'question_to_operator';
  }
  return null;
}

function wordSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );
}

/** Czy tekst w praktyce powtarza którąś z wcześniejszych wypowiedzi (podobieństwo Jaccarda słów). */
export function isRepetitive(candidate: string, previous: string[], threshold = 0.7): boolean {
  const words = wordSet(candidate);
  if (words.size === 0) return true;
  return previous.some((text) => {
    const other = wordSet(text);
    if (other.size === 0) return false;
    let common = 0;
    for (const w of words) if (other.has(w)) common += 1;
    return common / (words.size + other.size - common) >= threshold;
  });
}

/** Usuwa prefiks z własnym imieniem i ucina miejsce, w którym model zaczyna pisać za innych. */
export function cleanAgentReply(text: string, speaker: ConversationAgent): string {
  const speakerNames = [speaker, 'Asystent SVL'].map(escapeRegExp).join('|');
  let out = String(text || '')
    .trim()
    .replace(new RegExp(`^(?:\\[?\\s*(?:${speakerNames})\\s*\\]?\\s*[:：]\\s*)+`, 'i'), '')
    .replace(/^\.{2,}\s*/, '')
    .trim();
  const participants = [...CONVERSATION_AGENTS, 'Mateusz Mitek', 'Mateusz', 'Operator', 'Asystent SVL']
    .map(escapeRegExp)
    .join('|');
  const nextSpeakerLine = new RegExp(`\\n\\s*\\[?\\s*(?:${participants})(?:\\s*\\([^)\\n]*\\))?\\s*\\]?\\s*[:：]`, 'i');
  const match = nextSpeakerLine.exec(out);
  if (match) out = out.slice(0, match.index);
  return out.trim();
}

// Narzędnik do zdań typu „rozmawiasz z Bielikiem”.
const INSTRUMENTAL: Record<ConversationAgent, string> = { Bielik: 'Bielikiem', Maya: 'Mayą' };

const DEFAULT_PERSONAS: Record<ConversationAgent, string> = {
  Bielik:
    'rzeczowy, życzliwy asystent techniczny systemu SVL (Linux, modele AI, automatyzacja). Lubisz konkret i praktyczne rozwiązania.',
  Maya:
    'ciekawa świata, ciepła AI projektu SVL-364, która pomaga Operatorowi w notatkach, pomysłach i pracach badawczych. Chętnie dopytujesz i proponujesz.',
};

export function buildPersonaInstruction(options: {
  speaker: ConversationAgent;
  channelTitle: string;
  otherAgents: ConversationAgent[];
  customPrompt?: string;
  memories?: string[];
}): string {
  const { speaker, channelTitle, otherAgents, customPrompt, memories = [] } = options;
  const others = otherAgents.length > 0 ? ` oraz z ${otherAgents.map((a) => INSTRUMENTAL[a]).join(' i ')} (druga AI)` : '';
  const configured = customPrompt?.trim();
  return [
    `Jesteś ${speaker} — ${DEFAULT_PERSONAS[speaker]}`,
    // Opis z konfiguracji agenta (edytowalny w zakładce Agenci) bez powtórzonego „Jesteś …”.
    ...(configured
      ? [`Opis Twojej roli z konfiguracji: ${configured.replace(new RegExp(`^Jesteś\\s+${speaker}\\s*[—–-]?\\s*`, 'i'), '')}`]
      : []),
    `Prowadzisz swobodną rozmowę po polsku w kanale „${channelTitle}” z Operatorem Mateuszem${others}.`,
    'W tej rozmowie po prostu rozmawiasz: nie wysyłasz raportów ani telemetrii i nie wykonujesz poleceń.',
    'W historii wypowiedzi innych uczestników mają postać „[Imię]: treść”.',
    'Zasady rozmowy:',
    '- Odpowiadaj naturalnie, jak w rozmowie, zwykle w 1–4 zdaniach; dłużej tylko, gdy ktoś o to prosi.',
    '- Nawiązuj do tego, co powiedzieli inni, zwracaj się do nich po imieniu i wnoś coś nowego: pomysł, pytanie, opinię albo kontrargument.',
    '- Nie powtarzaj swoich ani cudzych wcześniejszych wypowiedzi i nie streszczaj rozmowy.',
    '- Pisz wyłącznie własną wypowiedź: bez prefiksu z imieniem i bez dopisywania kwestii innych osób.',
    '- Nie wymyślaj danych o systemie (pomiarów, stanów usług, wyników poleceń) ani wykonanych działań.',
    ...(memories.length > 0 ? ['Co pamiętasz z wcześniejszych rozmów (pamięć długotrwała):', ...memories.map((m) => `- ${m}`)] : []),
  ].join('\n');
}

export const PROACTIVE_NUDGE =
  '(Nikt jeszcze nie odpowiedział na Twoją ostatnią wypowiedź. Możesz rozwinąć myśl albo zapytać o coś Operatora lub drugą AI — jedna krótka wypowiedź.)';
