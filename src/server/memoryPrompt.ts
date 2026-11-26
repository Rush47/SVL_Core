import type { ConversationAgent } from './conversation.ts';

export interface AgentMemoryRecord {
  id?: string;
  scope?: string;
  kind?: string;
  content: string;
  created_at?: string;
}

const KIND_LABELS: Record<string, string> = {
  decision: 'DECYZJA',
  preference: 'PREFERENCJA',
  fact: 'FAKT',
  task: 'ZADANIE',
  episode: 'ROZMOWA',
};

const KIND_ORDER: Record<string, number> = {
  decision: 0,
  preference: 1,
  fact: 2,
  task: 3,
  episode: 4,
};

export function formatMemoryPromptContext(
  memories: AgentMemoryRecord[],
  agentName: string,
  limit = 12,
): string {
  if (!Array.isArray(memories) || memories.length === 0) return '';
  const seen = new Set<string>();
  const cleaned = memories
    .filter((m) => m && typeof m.content === 'string' && !/SQLite\s+WAL\s+Fallback|bufor jądra SVL|Słyszę Cię doskonale,\s*Mateuszu\.\s*Jestem z Tobą przy konsoli/i.test(m.content))
    .map((m) => ({
      kind: String(m.kind || 'fact').toLowerCase(),
      content: m.content.trim().replace(/\s+/g, ' ').slice(0, 320),
    }))
    .filter((m) => {
      if (!m.content || m.content.startsWith('⚠️')) return false;
      const key = m.content.toLowerCase().replace(/[.!?]+$/g, '').trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (KIND_ORDER[a.kind] ?? 5) - (KIND_ORDER[b.kind] ?? 5))
    .slice(0, Math.max(1, limit));

  if (cleaned.length === 0) return '';
  const lines = cleaned.map((m) => `- [${KIND_LABELS[m.kind] || m.kind.toUpperCase()}] ${m.content}`);
  return (
    `Trwała pamięć agenta ${agentName} z bazy SQLite:\n` +
    lines.join('\n')
  );
}

export interface SelectSpeakerOptions {
  predicted: ConversationAgent | 'operator' | null;
  participants: ConversationAgent[];
  lastTurnRole?: string;
  lastAiSpeaker?: ConversationAgent | null;
  isAutonomous: boolean;
  consecutiveAi: number;
  hasTurns: boolean;
  explicitTarget?: ConversationAgent | null;
}

export function selectNextFreeSpeaker(opts: SelectSpeakerOptions): {
  speaker: ConversationAgent | null;
  skipReason?: 'waiting_for_operator' | 'no_decision';
} {
  const {
    predicted,
    participants,
    lastTurnRole,
    lastAiSpeaker,
    isAutonomous,
    consecutiveAi,
    hasTurns,
    explicitTarget,
  } = opts;
  if (participants.length === 0) return { speaker: null, skipReason: 'no_decision' };

  const alternating = participants.find((a) => a !== lastAiSpeaker) || participants[0];
  const preferred = explicitTarget && participants.includes(explicitTarget) ? explicitTarget : null;

  if (!hasTurns) {
    return { speaker: preferred || participants[0] };
  }
  if (!isAutonomous && preferred) {
    return { speaker: preferred };
  }
  if (predicted && predicted !== 'operator' && participants.includes(predicted)) {
    return { speaker: predicted };
  }
  if (lastTurnRole === 'user') {
    return { speaker: preferred || alternating };
  }
  if (!isAutonomous) {
    return { speaker: alternating };
  }
  if (participants.length > 1 && consecutiveAi < 2) {
    return { speaker: alternating };
  }
  if (participants.length === 1 && consecutiveAi === 0) {
    return { speaker: participants[0] };
  }
  return {
    speaker: null,
    skipReason: predicted === 'operator' ? 'waiting_for_operator' : 'no_decision',
  };
}

export function buildProactiveStarterPrompt(
  speaker: ConversationAgent,
  operatorName = 'Mateusz',
  memoryContext = '',
): string {
  // Same dane uczestników, bez instrukcji dotyczącej tonu lub treści wypowiedzi.
  return `[Rozmowa: ${speaker}, ${operatorName}]${memoryContext ? ' [Kontekst trwałej pamięci dostępny]' : ''}`;
}
