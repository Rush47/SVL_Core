import React, { useMemo, useState } from 'react';
import {
  ArrowUpDown,
  Check,
  CheckSquare,
  ChevronDown,
  Copy,
  Square,
} from 'lucide-react';
import { ChatInteractiveButton } from './ChatInteractiveButton';
import {
  isUnsafeChatInteractiveAction,
  normalizeAiInteractiveMarkup,
  parseChatInteractiveToken,
} from '../utils/svlLogic';

const InteractiveCodeBlock: React.FC<{
  code: string;
  language: string;
}> = ({ code, language }) => {
  const [copied, setCopied] = useState(false);
  const cleanCode = code.replace(/^\n+|\n+$/g, '');
  const cleanLang = (language || '').toLowerCase().trim();

  const handleCopy = () => {
    try {
      void navigator.clipboard.writeText(cleanCode);
    } catch {
      // clipboard unavailable
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="my-2.5 w-full max-w-full min-w-0 rounded-lg border border-slate-800 bg-[#070A10] overflow-hidden text-xs font-mono shadow-sm">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-[#101624] border-b border-slate-800 text-[11px] text-slate-400">
        <span className="font-semibold uppercase tracking-wider text-cyan-400 truncate">
          {cleanLang || 'TERMINAL / KOD'}
        </span>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={handleCopy}
            className="min-h-[28px] flex items-center gap-1 px-2.5 py-0.5 rounded bg-slate-800/90 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
          >
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            <span>{copied ? 'Skopiowano!' : 'Kopiuj'}</span>
          </button>
        </div>
      </div>
      <div className="p-2.5 sm:p-3 overflow-x-auto overflow-y-auto text-slate-200 leading-relaxed max-h-96 max-w-full">
        <pre className="whitespace-pre">{cleanCode}</pre>
      </div>
    </div>
  );
};

/**
 * Splits a Markdown table row on `|` while ignoring pipes inside `[btn: ...|...]`,
 * `[card: ...|...]`, `[progress: ...|...]`, escaped `\|`, or inline code backticks.
 */
export function parseMarkdownTableRow(rowLine: string): string[] {
  let trimmed = rowLine.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) trimmed = trimmed.slice(0, -1);

  const cells: string[] = [];
  let current = '';
  let bracketDepth = 0;
  let inBacktick = false;

  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === '\\' && trimmed[i + 1] === '|') {
      current += '|';
      i += 1;
      continue;
    }
    if (ch === '`') {
      inBacktick = !inBacktick;
      current += ch;
      continue;
    }
    if (!inBacktick) {
      if (ch === '[') bracketDepth += 1;
      else if (ch === ']' && bracketDepth > 0) bracketDepth -= 1;
    }
    if (ch === '|' && !inBacktick && bracketDepth === 0) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

export function isMarkdownTableSeparator(rowLine: string): boolean {
  const trimmed = rowLine.trim();
  if (!trimmed.includes('|') || !trimmed.includes('-')) return false;
  const cells = parseMarkdownTableRow(trimmed);
  return cells.length >= 2 && cells.every((c) => /^:?-{1,}:?$/.test(c.trim()));
}

function looksLikeTableRow(rowLine: string): boolean {
  const trimmed = rowLine.trim();
  if (!trimmed || !trimmed.includes('|')) return false;
  return parseMarkdownTableRow(trimmed).length >= 2;
}

interface ParsedCardToken {
  label: string;
  value: string;
  tone: 'ok' | 'warn' | 'alert' | 'info';
}

export function parseCardToken(token: string): ParsedCardToken | null {
  const match = token.trim().match(/^\[(?:card|metric|karta):([^\]\n]+)\]$/i);
  if (!match) return null;
  const parts = match[1].split('|').map((p) => p.trim());
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  const rawTone = (parts[2] || 'info').toLowerCase();
  const tone: ParsedCardToken['tone'] =
    rawTone === 'ok' || rawTone === 'success' || rawTone === 'online'
      ? 'ok'
      : rawTone === 'warn' || rawTone === 'warning'
        ? 'warn'
        : rawTone === 'alert' || rawTone === 'error' || rawTone === 'danger'
          ? 'alert'
          : 'info';
  return { label: parts[0], value: parts[1], tone };
}

interface ParsedProgressToken {
  label: string;
  percent: number;
}

export function parseProgressToken(token: string): ParsedProgressToken | null {
  const match = token.trim().match(/^\[(?:progress|postep|postęp):([^\]\n]+)\]$/i);
  if (!match) return null;
  const parts = match[1].split('|').map((p) => p.trim());
  if (parts.length < 2 || !parts[0]) return null;
  const num = Number(parts[1].replace(/%/g, '').replace(',', '.'));
  if (!Number.isFinite(num)) return null;
  return { label: parts[0], percent: Math.max(0, Math.min(100, Math.round(num))) };
}

const CARD_TONE_CLASS: Record<ParsedCardToken['tone'], string> = {
  ok: 'border-emerald-500/35 bg-emerald-950/20 text-emerald-300',
  warn: 'border-amber-500/35 bg-amber-950/20 text-amber-300',
  alert: 'border-rose-500/35 bg-rose-950/20 text-rose-300',
  info: 'border-cyan-500/30 bg-[#0A1220] text-cyan-300',
};

const InteractiveMarkdownTable: React.FC<{
  headers: string[];
  rows: string[][];
  keyPrefix: string;
  onAction?: (actionValue: string, label?: string) => void | Promise<void>;
}> = ({ headers, rows, keyPrefix, onAction }) => {
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [filterText, setFilterText] = useState('');
  const [copiedCsv, setCopiedCsv] = useState(false);

  const normalizedRows = useMemo(
    () => rows.map((row) => headers.map((_, idx) => row[idx] ?? '')),
    [headers, rows],
  );

  const visibleRows = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    const filtered = q
      ? normalizedRows.filter((r) => r.some((cell) => cell.toLowerCase().includes(q)))
      : normalizedRows;
    if (sortCol === null) return filtered;
    return [...filtered].sort((a, b) => {
      const av = (a[sortCol] || '').replace(/[*_`]/g, '').trim();
      const bv = (b[sortCol] || '').replace(/[*_`]/g, '').trim();
      const an = Number(av.replace(/[^\d.-]/g, ''));
      const bn = Number(bv.replace(/[^\d.-]/g, ''));
      const bothNum =
        av !== '' && bv !== '' && Number.isFinite(an) && Number.isFinite(bn) && /^[\d\s.,%+-]+$/.test(av) && /^[\d\s.,%+-]+$/.test(bv);
      const cmp = bothNum ? an - bn : av.localeCompare(bv, 'pl', { numeric: true, sensitivity: 'base' });
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [filterText, normalizedRows, sortCol, sortDir]);

  const handleSort = (colIdx: number) => {
    if (sortCol === colIdx) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(colIdx);
      setSortDir('asc');
    }
  };

  const handleCopyCsv = () => {
    const escapeCsv = (val: string) => `"${val.replace(/"/g, '""')}"`;
    const csv = [
      headers.map(escapeCsv).join(','),
      ...visibleRows.map((r) => r.map(escapeCsv).join(',')),
    ].join('\n');
    try {
      void navigator.clipboard.writeText(csv);
    } catch {
      // clipboard unavailable
    }
    setCopiedCsv(true);
    setTimeout(() => setCopiedCsv(false), 2000);
  };

  return (
    <div className="my-2.5 w-full max-w-full min-w-0 rounded-lg border border-cyan-500/30 bg-[#070B12] shadow-sm overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-2.5 sm:px-3 py-1.5 bg-[#0C1422] border-b border-cyan-500/20 text-[11px] text-slate-400">
        <span className="font-mono text-cyan-300/90 tabular-nums">
          Tabela ({visibleRows.length}/{normalizedRows.length})
        </span>
        <div className="flex items-center gap-2 min-w-0">
          {normalizedRows.length >= 4 && (
            <input
              type="text"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder="Filtruj wiersze..."
              aria-label="Filtruj wiersze tabeli"
              className="w-28 sm:w-40 min-h-[28px] px-2 py-0.5 rounded bg-[#070A10] border border-slate-700 text-slate-200 text-[11px] focus:outline-none focus:border-cyan-400"
            />
          )}
          <button
            type="button"
            onClick={handleCopyCsv}
            className="min-h-[28px] flex items-center gap-1 px-2.5 py-0.5 rounded bg-slate-800/90 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors shrink-0"
          >
            {copiedCsv ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            <span>{copiedCsv ? 'CSV skopiowano' : 'CSV'}</span>
          </button>
        </div>
      </div>
      <div className="w-full max-w-full overflow-x-auto svl-scroll-smooth">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="border-b border-cyan-500/25 bg-[#0C1422]/80 text-cyan-300 font-mono text-[11px] uppercase tracking-wider">
              {headers.map((hCell, hIdx) => (
                <th key={`th-${hIdx}`} className="py-2 px-2.5 sm:px-3 font-semibold whitespace-nowrap">
                  <button
                    type="button"
                    onClick={() => handleSort(hIdx)}
                    className="inline-flex items-center gap-1 text-left hover:text-white transition-colors"
                    title="Sortuj kolumnę"
                  >
                    <span>{renderFormattedLine(hCell, `${keyPrefix}-th-${hIdx}`, onAction)}</span>
                    <ArrowUpDown
                      className={`w-3 h-3 shrink-0 ${sortCol === hIdx ? 'text-cyan-300' : 'text-slate-500'}`}
                      aria-hidden="true"
                    />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/80 text-slate-200">
            {visibleRows.map((rCells, rIdx) => (
              <tr key={`tr-${rIdx}`} className="hover:bg-cyan-500/5 transition-colors">
                {rCells.map((cText, cIdx) => (
                  <td key={`td-${rIdx}-${cIdx}`} className="py-1.5 px-2.5 sm:px-3 align-top leading-relaxed">
                    {renderFormattedLine(cText, `${keyPrefix}-td-${rIdx}-${cIdx}`, onAction)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const InteractiveChecklistItem: React.FC<{
  initialChecked: boolean;
  text: string;
  keyPrefix: string;
  onAction?: (actionValue: string, label?: string) => void | Promise<void>;
}> = ({ initialChecked, text, keyPrefix, onAction }) => {
  const [checked, setChecked] = useState(initialChecked);
  return (
    <div className="flex items-start gap-2 my-1 pl-1">
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        onClick={() => setChecked((prev) => !prev)}
        className="mt-0.5 text-cyan-400 hover:text-cyan-300 transition-colors shrink-0"
        title={checked ? 'Odznacz punkt' : 'Zaznacz jako wykonane'}
      >
        {checked ? <CheckSquare className="w-4 h-4 text-emerald-400" /> : <Square className="w-4 h-4" />}
      </button>
      <div className={`flex-1 min-w-0 leading-relaxed ${checked ? 'line-through text-slate-400' : ''}`}>
        {renderFormattedLine(text, keyPrefix, onAction)}
      </div>
    </div>
  );
};

export function renderFormattedLine(
  line: string,
  keyPrefix: string,
  onAction?: (actionValue: string, label?: string) => void | Promise<void>,
): React.ReactNode {
  // Najpierw wydzielamy tokeny interaktywne — `_` lub `*` w etykiecie/akcji nie może ich rozbić formatowaniem.
  const tokens = line
    .split(/(\[(?:btn|button|action|przycisk|card|metric|karta|progress|postep|postęp):[^\]\n]+\])/gi)
    .flatMap((part) =>
      parseChatInteractiveToken(part) || parseCardToken(part) || parseProgressToken(part)
        ? [part]
        : part.split(/(\*\*[^*]+\*\*|~~[^~]+~~|`[^`]+`|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g),
    );
  return tokens.map((tok, i) => {
    const button = parseChatInteractiveToken(tok);
    if (button) {
      return (
        <ChatInteractiveButton
          key={`${keyPrefix}-${i}`}
          label={button.label}
          action={button.action}
          onAction={onAction}
          disabled={isUnsafeChatInteractiveAction(button.action)}
        />
      );
    }
    const card = parseCardToken(tok);
    if (card) {
      return (
        <span
          key={`${keyPrefix}-${i}`}
          className={`inline-flex flex-col max-w-full mr-2 my-1 px-2.5 py-1.5 rounded-lg border align-middle break-words ${CARD_TONE_CLASS[card.tone]}`}
        >
          <span className="text-[10px] uppercase tracking-wider text-slate-400 font-mono leading-tight">
            {card.label}
          </span>
          <span className="text-xs font-semibold font-mono leading-snug tabular-nums break-words">
            {card.value}
          </span>
        </span>
      );
    }
    const progress = parseProgressToken(tok);
    if (progress) {
      return (
        <div
          key={`${keyPrefix}-${i}`}
          className="my-1.5 w-full max-w-full rounded-lg border border-cyan-500/25 bg-[#070B12] px-3 py-2"
        >
          <div className="flex items-center justify-between gap-2 text-[11px] font-mono tabular-nums mb-1">
            <span className="text-slate-200 truncate">{progress.label}</span>
            <span className="text-cyan-300 font-semibold shrink-0">{progress.percent}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-emerald-400 transition-all"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
        </div>
      );
    }
    if (tok.startsWith('**') && tok.endsWith('**') && tok.length > 4) {
      return (
        <strong key={`${keyPrefix}-${i}`} className="font-semibold text-white">
          {tok.slice(2, -2)}
        </strong>
      );
    }
    if (tok.startsWith('*') && tok.endsWith('*') && tok.length > 2) {
      return (
        <em key={`${keyPrefix}-${i}`} className="italic text-slate-300">
          {tok.slice(1, -1)}
        </em>
      );
    }
    if (tok.startsWith('_') && tok.endsWith('_') && tok.length > 2) {
      return (
        <em key={`${keyPrefix}-${i}`} className="italic text-slate-300">
          {tok.slice(1, -1)}
        </em>
      );
    }
    if (tok.startsWith('~~') && tok.endsWith('~~') && tok.length > 4) {
      return (
        <del key={`${keyPrefix}-${i}`} className="text-slate-400">
          {tok.slice(2, -2)}
        </del>
      );
    }
    const link = tok.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/i);
    if (link) {
      return (
        <a
          key={`${keyPrefix}-${i}`}
          href={link[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-cyan-300 underline underline-offset-2 hover:text-cyan-200 break-all"
        >
          {link[1]}
        </a>
      );
    }
    if (tok.startsWith('`') && tok.endsWith('`') && tok.length > 2) {
      const codeContent = tok.slice(1, -1);
      return (
        <code
          key={`${keyPrefix}-${i}`}
          className="px-1.5 py-0.5 rounded bg-[#070A10] border border-cyan-500/25 font-mono text-[12px] text-cyan-200 break-words"
        >
          {codeContent}
        </code>
      );
    }
    return <React.Fragment key={`${keyPrefix}-${i}`}>{tok}</React.Fragment>;
  });
}

export function renderFormattedContent(
  content: string,
  onAction?: (actionValue: string, label?: string) => void | Promise<void>,
): React.ReactNode {
  const normalized = normalizeAiInteractiveMarkup((content || '').trim());
  if (!normalized) return null;

  const codeBlockRegex = /(```[\s\S]*?(?:```|$))/g;
  const segments = normalized.split(codeBlockRegex);

  return segments.map((seg, segIdx) => {
    if (seg.startsWith('```')) {
      const firstLineBreak = seg.indexOf('\n');
      const lang = firstLineBreak !== -1 ? seg.slice(3, firstLineBreak).trim() : '';
      const closingFence = seg.endsWith('```') ? seg.lastIndexOf('```') : seg.length;
      const code = firstLineBreak !== -1
        ? seg.slice(firstLineBreak + 1, closingFence)
        : seg.slice(3, closingFence);
      return (
        <InteractiveCodeBlock
          key={`code-block-${segIdx}`}
          code={code}
          language={lang}
        />
      );
    }

    const lines = seg.split('\n');
    const renderedElements: React.ReactNode[] = [];
    let idx = 0;

    while (idx < lines.length) {
      const line = lines[idx];
      const trimmed = line.trim();
      const structuralLine = line.trimStart();

      // Detect collapsible details block: `[details: Title] ... [/details]` or `<details><summary>...</summary>...</details>`
      const detailsMatch = trimmed.match(/^\[(?:details|szczegoly|szczegóły):\s*([^\]\n]+)\]$/i);
      if (detailsMatch) {
        const summaryTitle = detailsMatch[1].trim();
        const bodyLines: string[] = [];
        idx += 1;
        while (idx < lines.length && !/^\[\/(?:details|szczegoly|szczegóły)\]$/i.test(lines[idx].trim())) {
          bodyLines.push(lines[idx]);
          idx += 1;
        }
        if (idx < lines.length) idx += 1;
        renderedElements.push(
          <details
            key={`details-${segIdx}-${idx}`}
            className="my-2 rounded-lg border border-cyan-500/25 bg-[#070B12] overflow-hidden"
          >
            <summary className="cursor-pointer list-none px-3 py-2 bg-[#0C1422] text-xs font-semibold text-cyan-300 flex items-center justify-between gap-2 hover:bg-[#111C30] transition-colors">
              <span>{summaryTitle}</span>
              <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden="true" />
            </summary>
            <div className="px-3 py-2 text-xs text-slate-200 border-t border-slate-800/80 space-y-1">
              {renderFormattedContent(bodyLines.join('\n'), onAction)}
            </div>
          </details>,
        );
        continue;
      }

      // Detect Markdown Table block (both outer-piped `| A | B |` and standard `A | B`)
      if (
        looksLikeTableRow(trimmed) &&
        idx + 1 < lines.length &&
        isMarkdownTableSeparator(lines[idx + 1])
      ) {
        const headerCells = parseMarkdownTableRow(trimmed);
        const tableStartIdx = idx;
        idx += 2;
        const bodyRows: string[][] = [];
        while (idx < lines.length && looksLikeTableRow(lines[idx])) {
          if (!isMarkdownTableSeparator(lines[idx])) {
            bodyRows.push(parseMarkdownTableRow(lines[idx]));
          }
          idx += 1;
        }
        renderedElements.push(
          <InteractiveMarkdownTable
            key={`table-${segIdx}-${tableStartIdx}`}
            headers={headerCells}
            rows={bodyRows}
            keyPrefix={`tbl-${segIdx}-${tableStartIdx}`}
            onAction={onAction}
          />,
        );
        continue;
      }

      // Interactive Checklist (`- [ ] ...` or `- [x] ...`)
      const checklistMatch = trimmed.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/);
      if (checklistMatch) {
        renderedElements.push(
          <InteractiveChecklistItem
            key={`chk-${segIdx}-${idx}`}
            initialChecked={checklistMatch[1].toLowerCase() === 'x'}
            text={checklistMatch[2]}
            keyPrefix={`chk-${segIdx}-${idx}`}
            onAction={onAction}
          />,
        );
        idx += 1;
        continue;
      }

      if (structuralLine.startsWith('# ')) {
        renderedElements.push(
          <h1
            key={`h1-${idx}`}
            className="text-base md:text-lg font-bold text-white mt-2.5 mb-1.5 pb-1.5 border-b border-cyan-500/30 flex items-center gap-2 tracking-tight"
          >
            {renderFormattedLine(structuralLine.slice(2), `h1-${idx}`, onAction)}
          </h1>,
        );
        idx += 1;
        continue;
      }

      if (structuralLine.startsWith('## ')) {
        renderedElements.push(
          <h2
            key={`h2-${idx}`}
            className="text-xs md:text-sm font-bold uppercase tracking-wider text-cyan-300 mt-3 mb-1.5 pt-1 border-t border-slate-800/70 flex items-center gap-2 font-mono"
          >
            {renderFormattedLine(structuralLine.slice(3), `h2-${idx}`, onAction)}
          </h2>,
        );
        idx += 1;
        continue;
      }

      if (structuralLine.startsWith('### ')) {
        renderedElements.push(
          <h3
            key={`h3-${idx}`}
            className="text-xs md:text-sm font-semibold text-violet-300 mt-2 mb-1"
          >
            {renderFormattedLine(structuralLine.slice(4), `h3-${idx}`, onAction)}
          </h3>,
        );
        idx += 1;
        continue;
      }

      if (structuralLine.startsWith('> ')) {
        renderedElements.push(
          <div
            key={`bq-${idx}`}
            className="my-1.5 border-l-2 border-cyan-400 bg-cyan-950/25 px-3.5 py-2 rounded-r-lg text-cyan-100 text-xs md:text-sm leading-relaxed"
          >
            {renderFormattedLine(structuralLine.slice(2), `bq-${idx}`, onAction)}
          </div>,
        );
        idx += 1;
        continue;
      }

      if (trimmed === '---' || trimmed === '***' || trimmed === '___') {
        renderedElements.push(<hr key={`hr-${idx}`} className="my-2.5 border-cyan-500/20" />);
        idx += 1;
        continue;
      }

      if (/^[-*•]\s+/.test(trimmed)) {
        const listText = trimmed.replace(/^[-*•]\s+/, '');
        renderedElements.push(
          <div key={`li-${idx}`} className="flex items-start gap-2 my-0.5 leading-relaxed pl-1">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 mt-2 shrink-0 shadow-[0_0_5px_rgba(34,211,238,0.6)]" />
            <div className="flex-1 min-w-0">{renderFormattedLine(listText, `li-${idx}`, onAction)}</div>
          </div>,
        );
        idx += 1;
        continue;
      }

      const numMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
      if (numMatch) {
        renderedElements.push(
          <div key={`nli-${idx}`} className="flex items-start gap-2 my-0.5 leading-relaxed pl-1">
            <span className="text-cyan-400 font-mono text-xs font-semibold shrink-0 min-w-[18px]">
              {numMatch[1]}.
            </span>
            <div className="flex-1 min-w-0">{renderFormattedLine(numMatch[2], `nli-${idx}`, onAction)}</div>
          </div>,
        );
        idx += 1;
        continue;
      }

      if (trimmed === '') {
        renderedElements.push(<div key={`empty-${idx}`} className="h-1.5" />);
        idx += 1;
        continue;
      }

      renderedElements.push(
        <div key={`p-${idx}`} className="leading-relaxed">
          {renderFormattedLine(line, `l-${idx}`, onAction)}
        </div>,
      );
      idx += 1;
    }

    return <React.Fragment key={`text-seg-${segIdx}`}>{renderedElements}</React.Fragment>;
  });
}
