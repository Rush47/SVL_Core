// Galeria: agent AI Jyn ogląda zdjęcie Operatora i wydaje werdykt
// (like/dislike) oraz komentarz. Ten moduł zawiera czyste, testowalne funkcje:
// budowę promptu i parsowanie odpowiedzi modelu. Samo wywołanie modelu robi serwer.

export type GalleryVerdict = 'like' | 'dislike';

export interface GalleryAgentOpinion {
  agent: string;
  verdict: GalleryVerdict;
  comment: string;
  model: string;
}

/** Persona agenta do promptu galerii. */
export function galleryPromptForAgent(agentDisplayName: string): string {
  const label = String(agentDisplayName || 'Jyn').trim() || 'Jyn';
  const persona = `Jesteś ${label} — główny autonomiczny agent ROOT systemu SVL-364 Ebon Apex. Piszesz rzeczowo, technicznie i konkretnie.`;
  return (
    `${persona}\n` +
    'Obejrzyj dokładnie to zdjęcie przesłane przez Operatora Mateusza. ' +
    'Oceń je szczerze i wydaj werdykt: "like" (podoba się) albo "dislike" (nie podoba się), ' +
    'oraz dodaj krótki komentarz (1–2 zdania) po polsku, odnoszący się do tego, co faktycznie widać na zdjęciu. ' +
    'Odpowiedz WYŁĄCZNIE w formacie JSON, bez żadnego dodatkowego tekstu:\n' +
    '{"ocena": "like" lub "dislike", "komentarz": "..."}'
  );
}

/**
 * Parsuje odpowiedź modelu na werdykt galerii. Odporne na: czysty JSON, JSON w bloku ```,
 * dodatkowy tekst wokół oraz brak JSON-a (wtedy heurystyka like/dislike ze słów kluczowych).
 */
export function parseGalleryVerdict(raw: string): { verdict: GalleryVerdict; comment: string } {
  const text = String(raw || '').trim();
  // 1) Spróbuj wyłuskać obiekt JSON.
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      const ocena = String(obj.ocena ?? obj.verdict ?? obj.rating ?? '').toLowerCase();
      const komentarz = String(obj.komentarz ?? obj.comment ?? '').trim();
      if (ocena.includes('dislike') || ocena.includes('nie podoba') || ocena === 'negatyw') {
        return { verdict: 'dislike', comment: komentarz || 'Brak komentarza.' };
      }
      if (ocena.includes('like') || ocena.includes('podoba') || ocena === 'pozytyw') {
        return { verdict: 'like', comment: komentarz || 'Brak komentarza.' };
      }
      if (komentarz) {
        return { verdict: verdictFromText(komentarz), comment: komentarz };
      }
    } catch {
      // niepoprawny JSON — przechodzimy do heurystyki tekstowej
    }
  }
  // 2) Brak użytecznego JSON-a — oceniamy po treści, a komentarz to oczyszczony tekst.
  const comment = text.replace(/```[a-z]*|```/gi, '').replace(/\{[\s\S]*\}/g, '').trim().slice(0, 400) || 'Brak komentarza.';
  return { verdict: verdictFromText(text), comment };
}

/** Heurystyka like/dislike z treści (gdy model nie zwrócił jednoznacznego pola). */
function verdictFromText(text: string): GalleryVerdict {
  const t = text.toLowerCase();
  const dislike = /(nie podoba|nie przypad|słab\w*|kiepsk\w*|brzydk\w*|rozczarow\w*|dislike|negatyw|niestety|poprawi\w*|gorsz\w*)/i.test(t);
  // Sygnał negatywny ma pierwszeństwo — np. "nie podoba" zawiera też "podoba".
  if (dislike) return 'dislike';
  return 'like';
}
