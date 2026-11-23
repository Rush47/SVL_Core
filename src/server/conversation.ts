// Swobodna rozmowa wielu uczestników (Operator + agenci AI) — bez żadnych instrukcji.
//
// Modele nie dostają promptów: widzą wyłącznie zapis rozmowy. Z perspektywy agenta własne
// wypowiedzi są `assistant`, a cudze `user` z etykietą „[Imię]: …”. W trybie obustronnym
// to model, dopisując kolejną linię zapisu „[…”, sam wskazuje, kto mówi następny.

import { normalizeAgentCanonicalName } from '../utils/svlLogic.ts';

export type ConversationAgent = 'Jyn' | 'SI_Sphere' | 'JEDI_Omni_OS';
export const CONVERSATION_AGENTS: ConversationAgent[] = ['Jyn', 'SI_Sphere'];
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

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function agentOf(turn: DialogueTurn): ConversationAgent | null {
  if (turn.role !== 'assistant') return null;
  const canonical = normalizeAgentCanonicalName(turn.sender);
  return canonical === 'Jyn' || canonical === 'SI_Sphere' || canonical === 'JEDI_Omni_OS'
    ? canonical
    : null;
}

function speakerDisplayLabel(agent: ConversationAgent): string {
  return agent === 'JEDI_Omni_OS' ? 'JEDI Omni-OS v12' : agent;
}

/** Usuwa wklejone lub powtórzone przez model nagłówki „Weryfikacja SVL (...)” na początku wypowiedzi. */
export function stripServerVerificationBanners(rawText: string): string {
  return String(rawText || '')
    .replace(
      /^(?:>\s*)?(?:⚠️|✅)\s*\*?\*?Weryfikacja SVL\s*\([^)\n]*\)\s*[:：]?\*?\*?[^\n]*\n*/gim,
      '',
    )
    .trim();
}

function isDialogueTurn(turn: DialogueTurn): boolean {
  const txt = String(turn.content || '').trim();
  if (!txt) return false;
  if (turn.role !== 'user' && turn.role !== 'assistant') return false;
  if (turn.role === 'assistant' && txt.startsWith('⚠️') && /nie może teraz odpowiedzieć|nie zdążył/i.test(txt)) {
    return false;
  }
  return true;
}

/** Rozmowa z perspektywy `speaker`; kolejne wypowiedzi tej samej roli są łączone. */
export function toAgentPerspective(turns: DialogueTurn[], speaker: ConversationAgent, limit = 24): ChatTurn[] {
  const out: ChatTurn[] = [];
  for (const turn of turns.filter(isDialogueTurn).slice(-limit)) {
    const content = stripServerVerificationBanners(turn.content).slice(0, 6000);
    if (!content) continue;
    const author = agentOf(turn);
    // Starsze wpisy bez nadawcy traktujemy jak dotąd — jako własne.
    const own = turn.role === 'assistant' && (author === speaker || !turn.sender);
    const otherLabel =
      turn.role === 'user'
        ? OPERATOR_LABEL
        : author
          ? speakerDisplayLabel(author)
          : turn.sender || 'AI';
    const chatTurn: ChatTurn = own
      ? { role: 'assistant', content }
      : {
          role: 'user',
          content: `[${otherLabel}]: ${content}`,
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

/** Zapis rozmowy w postaci „[Imię]: treść” — jedyne wejście modelu w trybie obustronnym. */
export function buildTranscript(turns: DialogueTurn[], limit = 30): string {
  return turns
    .filter(isDialogueTurn)
    .slice(-limit)
    .map((turn) => {
      const cleaned = stripServerVerificationBanners(turn.content).slice(0, 4000);
      return cleaned ? `[${labelOf(turn)}]: ${cleaned}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

function labelOf(turn: DialogueTurn): string {
  if (turn.role === 'user') return OPERATOR_LABEL;
  const author = agentOf(turn);
  if (author) return speakerDisplayLabel(author);
  return turn.sender || 'AI';
}

/** Kogo model wskazał jako następnego mówcę (dopisanie po „[”). */
export function parsePredictedSpeaker(continuation: string): ConversationAgent | 'operator' | null {
  const name = String(continuation || '').trim().split(/[\]:\n]/)[0].trim().toLowerCase();
  if (!name) return null;
  if (/^(?:mateusz|operator)/.test(name)) return 'operator';
  const normalized = normalizeAgentCanonicalName(name);
  if (normalized === 'Jyn' || normalized === 'SI_Sphere' || normalized === 'JEDI_Omni_OS') {
    return normalized;
  }
  const agent = CONVERSATION_AGENTS.find((a) => name === a.toLowerCase() || name.startsWith(`${a.toLowerCase()} `));
  if (agent) return agent;
  if (name.startsWith('jedi')) return 'JEDI_Omni_OS';
  if (name.startsWith('si_sphere') || name.startsWith('si-sphere') || name === 'si2') return 'SI_Sphere';
  return null;
}

/** Ile wypowiedzi AI padło od ostatniej wiadomości Operatora. */
export function consecutiveAiTurns(turns: DialogueTurn[]): number {
  const dialogue = turns.filter(isDialogueTurn);
  let count = 0;
  for (let i = dialogue.length - 1; i >= 0 && dialogue[i].role !== 'user'; i -= 1) count += 1;
  return count;
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

/** Usuwa prefiks z imieniem mówcy (lub [System]: / [Mateusz (Operator)]:) i ucina miejsce, w którym model zaczyna pisać za innych. */
export function cleanAgentReply(text: string, speaker: ConversationAgent): string {
  const speakerNames = [
    ...CONVERSATION_AGENTS,
    'Jyn Mitek',
    'Jyn Mitek',
    'SI_Sphere (SVL-465 · ROOT)',
    'SI_Sphere',
    'JEDI Omni-OS v12',
    'JEDI Omni-OS v11.5',
    'JEDI_Omni_OS',
    speaker,
    'Asystent',
    'System',
    'AI',
    'Model',
    'Mateusz Mitek',
    'Mateusz',
    'Operator',
  ]
    .map(escapeRegExp)
    .join('|');
  let out = stripServerVerificationBanners(String(text || ''))
    .replace(new RegExp(`^(?:\\[?\\s*(?:${speakerNames})(?:\\s*\\([^)\\n]*\\))?\\s*\\]?\\s*[:：]\\s*)+`, 'i'), '')
    .replace(/^\.{2,}\s*/, '')
    .trim();
  out = stripServerVerificationBanners(out);
  const participants = [
    ...CONVERSATION_AGENTS,
    'Jyn Mitek',
    'Jyn Mitek',
    'SI_Sphere (SVL-465 · ROOT)',
    'SI_Sphere',
    'JEDI Omni-OS v12',
    'JEDI Omni-OS v11.5',
    'JEDI_Omni_OS',
    'Mateusz Mitek',
    'Mateusz',
    'Operator',
    'Asystent',
    'System',
  ]
    .map(escapeRegExp)
    .join('|');
  const nextSpeakerLine = new RegExp(`\\n\\s*\\[?\\s*(?:${participants})(?:\\s*\\([^)\\n]*\\))?\\s*\\]?\\s*[:：]`, 'i');
  const match = nextSpeakerLine.exec(out);
  if (match) out = out.slice(0, match.index);
  return out.trim();
}
