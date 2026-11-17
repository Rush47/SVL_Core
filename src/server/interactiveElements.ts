// Przyciski w wiadomościach czatu, z których mogą korzystać Bielik i Maya.
//
// Modele nie dostają promptu z personą — tylko ten krótki opis możliwości interfejsu,
// bo bez niego nie mogą wiedzieć, że przyciski istnieją i jak je zapisać.
// Składnię i obsługę akcji implementują `parseChatInteractiveToken` / `normalizeAiInteractiveMarkup`
// (src/utils/svlLogic.ts) oraz `handleInteractiveAction` (ChatWorkspace.tsx).

export const CHAT_INTERACTIVE_GUIDE = [
  'Interfejs czatu SVL: w odpowiedzi możesz dodać klikalne przyciski w formacie [btn: Etykieta|akcja].',
  'Dostępne akcje:',
  '- send:<tekst> — po kliknięciu Operator wysyła ten tekst jako wiadomość (np. [btn: Pokaż moduły|send:/moduly]);',
  '- ask:Bielik albo ask:Maya — oddaje głos wskazanej AI;',
  '- text:<tekst> — wstawia tekst do pola wpisywania, żeby Operator mógł go poprawić;',
  '- tab:svl364, tab:infrastructure, tab:agents, tab:terminals, tab:kernel, tab:linux — otwiera zakładkę;',
  '- action:sync (synchronizacja), action:scan (skan antywirusowy — wynik ogłasza Maya), action:report (raport systemu — przygotowuje Maya).',
  'Dodawaj przyciski tylko wtedy, gdy ułatwiają następny krok. Przyciski nie uruchamiają poleceń powłoki.',
].join('\n');

/** Łączy opis przycisków z pamięcią agenta w jeden kontekst systemowy. */
export function buildAgentSystemContext(memoryContext: string): string {
  return [CHAT_INTERACTIVE_GUIDE, memoryContext].filter((part) => Boolean(part && part.trim())).join('\n\n');
}
