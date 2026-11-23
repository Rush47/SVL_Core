import { isValidInlineDollarMath } from './chatMath';

export type HighlightTone = 'amber' | 'cyan' | 'emerald' | 'rose' | 'violet';

export type InlineMarkdownNode =
  | { type: 'text'; text: string }
  | { type: 'token'; raw: string }
  | { type: 'code'; code: string }
  | { type: 'math'; tex: string }
  | { type: 'bold'; children: InlineMarkdownNode[] }
  | { type: 'italic'; children: InlineMarkdownNode[] }
  | { type: 'strike'; children: InlineMarkdownNode[] }
  | { type: 'highlight'; text: string; tone: HighlightTone }
  | { type: 'kbd'; keys: string }
  | { type: 'sup'; text: string }
  | { type: 'sub'; text: string }
  | { type: 'link'; label: string; href: string };

const INLINE_TOKEN_PREFIX_RE =
  /^\[(?:btn|button|action|przycisk|card|metric|karta|progress|postep|postęp|badge|znacznik|kpi|metrics|metryka|hl|mark|highlight|podswietl|podświetl|kbd|key|klawisz|checkbox|check|pole):[^\]\n]+\]/i;

const MARKDOWN_LINK_RE = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/i;

const HTML_INLINE_TAG_RE = /^<(kbd|mark|sup|sub)>([^<\n]+)<\/\1>/i;

const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;

function isWordChar(ch: string | undefined): boolean {
  return Boolean(ch && WORD_CHAR_RE.test(ch));
}

function isDigitChar(ch: string | undefined): boolean {
  return Boolean(ch && ch >= '0' && ch <= '9');
}

function pushText(nodes: InlineMarkdownNode[], value: string) {
  if (!value) return;
  const last = nodes[nodes.length - 1];
  if (last && last.type === 'text') {
    last.text += value;
  } else {
    nodes.push({ type: 'text', text: value });
  }
}

/**
 * Szuka zamykającego dwuznakowego delimitera (np. `**`, `~~`, `==`, `__`)
 * z pominięciem sekwencji escapowanych (`\`) i opcjonalnym wymaganiem granic słów.
 */
function findClosingDouble(
  input: string,
  fromIdx: number,
  delim: string,
  requireWordBoundary: boolean,
): number {
  let idx = fromIdx;
  while (idx < input.length - 1) {
    if (input[idx] === '\\') {
      idx += 2;
      continue;
    }
    if (input[idx] === delim[0] && input[idx + 1] === delim[1]) {
      const before = input[idx - 1];
      const after = input[idx + 2];
      const validContent = idx > fromIdx && before !== undefined && !/\s/.test(before);
      const boundaryOk = !requireWordBoundary || !isWordChar(after);
      if (validContent && boundaryOk) {
        return idx;
      }
    }
    idx += 1;
  }
  return -1;
}

/**
 * Szuka zamykającego pojedynczego delimitera (`*` lub `_`) zgodnie z CommonMark:
 * - dla `_` wymaga granicy słowa po zamykającym znaku (chroni `Jyn`, `SVL_Core`, `SI_Sphere i SVL_Core`),
 * - nie dopuszcza spacji bezpośrednio przed zamykającym znakiem,
 * - omija backticki i sekwencje escapowane.
 */
function findClosingSingle(
  input: string,
  fromIdx: number,
  delim: '*' | '_',
  requireWordBoundary: boolean,
): number {
  let idx = fromIdx;
  while (idx < input.length) {
    if (input[idx] === '\\') {
      idx += 2;
      continue;
    }
    if (input[idx] === '`') {
      const endTick = input.indexOf('`', idx + 1);
      if (endTick !== -1) {
        idx = endTick + 1;
        continue;
      }
    }
    if (input[idx] === delim) {
      // Nie dopasowuj podwojonego znaku (np. `**` lub `__`) jako zamknięcia pojedynczego
      if (input[idx + 1] === delim) {
        idx += 2;
        continue;
      }
      const before = input[idx - 1];
      const after = input[idx + 1];
      const validContent = idx > fromIdx && before !== undefined && !/\s/.test(before) && before !== delim;
      const boundaryOk = !requireWordBoundary || !isWordChar(after);
      if (validContent && boundaryOk) {
        return idx;
      }
    }
    idx += 1;
  }
  return -1;
}

/**
 * Szuka zamykającego pojedynczego `$` dla inline LaTeX z ochroną zapisów walutowych (`$100 i $200`, `$100/$200`).
 */
function findClosingInlineDollar(input: string, fromIdx: number): number {
  let idx = fromIdx;
  while (idx < input.length) {
    if (input[idx] === '\\') {
      idx += 2;
      continue;
    }
    if (input[idx] === '\n') {
      return -1;
    }
    if (input[idx] === '$') {
      // Podwójny `$$` nie zamyka inline `$...$`
      if (input[idx + 1] === '$') return -1;
      const before = input[idx - 1];
      const after = input[idx + 1];
      if (
        idx > fromIdx &&
        before !== undefined &&
        !/\s/.test(before) &&
        !isDigitChar(after)
      ) {
        const inner = input.slice(fromIdx, idx);
        if (isValidInlineDollarMath(inner)) {
          return idx;
        }
      }
      return -1;
    }
    idx += 1;
  }
  return -1;
}

/**
 * Deterministyczny tokenizer inline Markdown + SVL interactive tokens + KaTeX inline math.
 * Gwarantuje zachowanie znaku `_` wewnątrz identyfikatorów (np. `Jyn`, `SVL_Core`, `jyn_mitek_root`).
 */
export function tokenizeInlineMarkdown(input: string, depth = 0): InlineMarkdownNode[] {
  const nodes: InlineMarkdownNode[] = [];
  const maxDepth = 4;
  let i = 0;

  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1];
    const prev = i > 0 ? input[i - 1] : undefined;

    // 1. Sekwencje z ukośnikiem: `\(...\)` (LaTeX inline) oraz escapowanie znaków Markdown (`\_`, `\*`, `\$`, `\=`, `\~`, `` \` ``)
    if (ch === '\\' && next !== undefined) {
      if (next === '(') {
        const closeIdx = input.indexOf('\\)', i + 2);
        if (closeIdx !== -1) {
          const tex = input.slice(i + 2, closeIdx).trim();
          if (tex && !tex.includes('\n')) {
            nodes.push({ type: 'math', tex });
            i = closeIdx + 2;
            continue;
          }
        }
      }
      if ('_*$~=`\\[]'.includes(next)) {
        pushText(nodes, next);
        i += 2;
        continue;
      }
    }

    // 2. Tokeny interaktywne SVL `[btn: ...]`, `[hl: ...]`, `[kbd: ...]`, `[badge: ...]`, itd.
    if (ch === '[') {
      const rest = input.slice(i);
      const tokenMatch = rest.match(INLINE_TOKEN_PREFIX_RE);
      if (tokenMatch) {
        nodes.push({ type: 'token', raw: tokenMatch[0] });
        i += tokenMatch[0].length;
        continue;
      }
      // Link Markdown `[label](https://...)`
      const linkMatch = rest.match(MARKDOWN_LINK_RE);
      if (linkMatch) {
        nodes.push({ type: 'link', label: linkMatch[1], href: linkMatch[2] });
        i += linkMatch[0].length;
        continue;
      }
    }

    // 3. Inline code `` `...` ``
    if (ch === '`') {
      const closeTick = input.indexOf('`', i + 1);
      if (closeTick !== -1 && closeTick > i + 1) {
        nodes.push({ type: 'code', code: input.slice(i + 1, closeTick) });
        i = closeTick + 1;
        continue;
      }
    }

    // 4. Inline LaTeX math `$...$` (z ochroną walut)
    if (
      ch === '$' &&
      next !== '$' &&
      next !== undefined &&
      !/\s/.test(next) &&
      !isDigitChar(prev) &&
      prev !== '$'
    ) {
      const closeDollar = findClosingInlineDollar(input, i + 1);
      if (closeDollar !== -1) {
        const tex = input.slice(i + 1, closeDollar);
        nodes.push({ type: 'math', tex });
        i = closeDollar + 1;
        continue;
      }
    }

    // 5. Podświetlenie tekstu `==podświetlony tekst==`
    if (ch === '=' && next === '=' && input[i + 2] !== undefined && !/\s/.test(input[i + 2])) {
      const closeEq = findClosingDouble(input, i + 2, '==', false);
      if (closeEq !== -1) {
        nodes.push({ type: 'highlight', text: input.slice(i + 2, closeEq), tone: 'amber' });
        i = closeEq + 2;
        continue;
      }
    }

    // 6. Bezpieczne inline tagi HTML: `<kbd>`, `<mark>`, `<sup>`, `<sub>`
    if (ch === '<') {
      const htmlMatch = input.slice(i).match(HTML_INLINE_TAG_RE);
      if (htmlMatch) {
        const tag = htmlMatch[1].toLowerCase();
        const inner = htmlMatch[2].trim();
        if (inner) {
          if (tag === 'kbd') nodes.push({ type: 'kbd', keys: inner });
          else if (tag === 'mark') nodes.push({ type: 'highlight', text: inner, tone: 'amber' });
          else if (tag === 'sup') nodes.push({ type: 'sup', text: inner });
          else if (tag === 'sub') nodes.push({ type: 'sub', text: inner });
          i += htmlMatch[0].length;
          continue;
        }
      }
    }

    // 7. Pogrubienie `**...**`
    if (ch === '*' && next === '*' && input[i + 2] !== undefined && !/\s/.test(input[i + 2])) {
      const closeBold = findClosingDouble(input, i + 2, '**', false);
      if (closeBold !== -1) {
        const inner = input.slice(i + 2, closeBold);
        nodes.push({
          type: 'bold',
          children: depth < maxDepth ? tokenizeInlineMarkdown(inner, depth + 1) : [{ type: 'text', text: inner }],
        });
        i = closeBold + 2;
        continue;
      }
    }

    // 8. Pogrubienie `__...__` WYŁĄCZNIE na granicach słów (nigdy w `foo__bar__baz`)
    if (
      ch === '_' &&
      next === '_' &&
      !isWordChar(prev) &&
      input[i + 2] !== undefined &&
      !/\s/.test(input[i + 2]) &&
      input[i + 2] !== '_'
    ) {
      const closeBoldUnder = findClosingDouble(input, i + 2, '__', true);
      if (closeBoldUnder !== -1) {
        const inner = input.slice(i + 2, closeBoldUnder);
        nodes.push({
          type: 'bold',
          children: depth < maxDepth ? tokenizeInlineMarkdown(inner, depth + 1) : [{ type: 'text', text: inner }],
        });
        i = closeBoldUnder + 2;
        continue;
      }
    }

    // 9. Przekreślenie `~~...~~`
    if (ch === '~' && next === '~' && input[i + 2] !== undefined && !/\s/.test(input[i + 2])) {
      const closeStrike = findClosingDouble(input, i + 2, '~~', false);
      if (closeStrike !== -1) {
        const inner = input.slice(i + 2, closeStrike);
        nodes.push({
          type: 'strike',
          children: depth < maxDepth ? tokenizeInlineMarkdown(inner, depth + 1) : [{ type: 'text', text: inner }],
        });
        i = closeStrike + 2;
        continue;
      }
    }

    // 10. Kursywa `*...*` (bez spacji zaraz po otwarciu)
    if (ch === '*' && next !== '*' && next !== undefined && !/\s/.test(next)) {
      const closeItalic = findClosingSingle(input, i + 1, '*', false);
      if (closeItalic !== -1) {
        const inner = input.slice(i + 1, closeItalic);
        nodes.push({
          type: 'italic',
          children: depth < maxDepth ? tokenizeInlineMarkdown(inner, depth + 1) : [{ type: 'text', text: inner }],
        });
        i = closeItalic + 1;
        continue;
      }
    }

    // 11. Kursywa `_..._` WYŁĄCZNIE na granicach słów (CommonMark) — chroni `Jyn`, `SVL_Core`, `jyn_mitek_root`
    if (
      ch === '_' &&
      next !== '_' &&
      !isWordChar(prev) &&
      next !== undefined &&
      !/\s/.test(next)
    ) {
      const closeUnder = findClosingSingle(input, i + 1, '_', true);
      if (closeUnder !== -1) {
        const inner = input.slice(i + 1, closeUnder);
        nodes.push({
          type: 'italic',
          children: depth < maxDepth ? tokenizeInlineMarkdown(inner, depth + 1) : [{ type: 'text', text: inner }],
        });
        i = closeUnder + 1;
        continue;
      }
    }

    pushText(nodes, ch);
    i += 1;
  }

  return nodes;
}
