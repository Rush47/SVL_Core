import katex from 'katex';

export interface RenderedMathResult {
  html: string;
  ok: boolean;
  error?: string;
}

/**
 * Bezpiecznie renderuje wyrażenie LaTeX przy pomocy KaTeX do HTML + MathML.
 * Nie rzuca wyjątków przy błędach składni — zamiast tego zwraca czytelny wynik z flagą `ok`.
 */
export function renderMathToHtml(rawTex: string, displayMode = false): RenderedMathResult {
  const tex = String(rawTex || '').trim();
  if (!tex) {
    return { html: '', ok: false, error: 'Puste wyrażenie matematyczne' };
  }

  try {
    const html = katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      strict: 'ignore',
      trust: false,
      output: 'htmlAndMathml',
      errorColor: '#fb7185',
    });
    const hasErrorNode = html.includes('katex-error');
    return { html, ok: !hasErrorNode };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { html: '', ok: false, error: message };
  }
}

/**
 * Rozpoznaje, czy podany łańcuch wewnątrz `$...$` wygląda na poprawne wyrażenie matematyczne,
 * chroniąc zwykłe zapisy walutowe (np. `$100`, `$100 i $200`, `$50/$100`).
 */
export function isValidInlineDollarMath(content: string): boolean {
  if (!content || content.includes('\n')) return false;
  if (/^\s/.test(content) || /\s$/.test(content)) return false;
  // Same znaki interpunkcyjne / spacje bez symboli matematycznych nie tworzą wzoru
  if (/^[\s.,;:!?]+$/.test(content)) return false;

  const hasLatexOrMathOp = /[\\^_=+\-*/<>|∑∫√∞±≤≥≠≈×÷{}[\]()]/.test(content);
  // Chroń zapisy walutowe z prozą (np. `$100 USD$`, `$50 zł$`, `$100 i więcej$`) gdy brak operatorów/komend LaTeX
  if (!hasLatexOrMathOp && /^\d[\d.,]*\s+[\p{L}%]/u.test(content)) {
    return false;
  }
  return true;
}
