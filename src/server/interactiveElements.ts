// Kontekst danych dla modelu: bez narzuconej osobowości, stylu i formatu wypowiedzi.
// Autoryzacja narzędzi i walidacja wyników pozostają po stronie serwera.
export const FACTUAL_GROUNDING_RULES = '';
export const CHAT_INTERACTIVE_GUIDE = '';

export function buildAgentSystemContext(memoryContext: string, _speakerDisplayName?: string): string {
  return String(memoryContext || '').trim();
}
