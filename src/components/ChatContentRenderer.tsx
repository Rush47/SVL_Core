import React, { useState } from 'react';
import {
  Check,
  Copy,
} from 'lucide-react';
import { ChatInteractiveButton } from './ChatInteractiveButton';
import {
  isUnsafeChatInteractiveAction,
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
    void navigator.clipboard.writeText(cleanCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="my-2.5 rounded-lg border border-slate-800 bg-[#070A10] overflow-hidden text-xs font-mono shadow-sm">
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#101624] border-b border-slate-800 text-[11px] text-slate-400">
        <span className="font-semibold uppercase tracking-wider text-cyan-400">
          {cleanLang || 'TERMINAL / KOD'}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800/90 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
          >
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            <span>{copied ? 'Skopiowano!' : 'Kopiuj'}</span>
          </button>
        </div>
      </div>
      <div className="p-3 overflow-auto text-slate-200 leading-relaxed max-h-96">
        <pre>{cleanCode}</pre>
      </div>
    </div>
  );
};

export function renderFormattedLine(
  line: string,
  keyPrefix: string,
  onAction?: (actionValue: string, label?: string) => void,
): React.ReactNode {
  const tokens = line.split(/(\*\*[^*]+\*\*|~~[^~]+~~|`[^`]+`|\*[^*\n]+\*|_[^_\n]+_|\[(?:btn|button|action):[^\]]+\]|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g);
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
          className="text-cyan-300 underline underline-offset-2 hover:text-cyan-200"
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
          className="px-1.5 py-0.5 rounded bg-[#070A10] border border-cyan-500/25 font-mono text-[12px] text-cyan-200"
        >
          {codeContent}
        </code>
      );
    }
    return <React.Fragment key={`${keyPrefix}-${i}`}>{tok}</React.Fragment>;
  });
}

function parseMarkdownTableRow(rowLine: string): string[] {
  const trimmed = rowLine.trim();
  const stripped = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return stripped.split('|').map((cell) => cell.trim());
}

function isMarkdownTableSeparator(rowLine: string): boolean {
  const cells = parseMarkdownTableRow(rowLine);
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

export function renderFormattedContent(
  content: string,
  onAction?: (actionValue: string, label?: string) => void,
): React.ReactNode {
  const normalized = (content || '').trim();
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

      // Detect Markdown Table block
      if (
        trimmed.startsWith('|') &&
        trimmed.endsWith('|') &&
        idx + 1 < lines.length &&
        lines[idx + 1].trim().startsWith('|') &&
        isMarkdownTableSeparator(lines[idx + 1])
      ) {
        const headerCells = parseMarkdownTableRow(trimmed);
        idx += 2;
        const bodyRows: string[][] = [];
        while (
          idx < lines.length &&
          lines[idx].trim().startsWith('|') &&
          lines[idx].trim().endsWith('|')
        ) {
          if (!isMarkdownTableSeparator(lines[idx])) {
            bodyRows.push(parseMarkdownTableRow(lines[idx]));
          }
          idx += 1;
        }
        renderedElements.push(
          <div
            key={`table-${segIdx}-${idx}`}
            className="my-2.5 overflow-x-auto rounded-lg border border-cyan-500/25 bg-[#070B12] shadow-sm"
          >
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-cyan-500/25 bg-[#0C1422] text-cyan-300 font-mono text-[11px] uppercase tracking-wider">
                  {headerCells.map((hCell, hIdx) => (
                    <th key={`th-${hIdx}`} className="py-2 px-3 font-semibold">
                      {renderFormattedLine(hCell, `th-${segIdx}-${idx}-${hIdx}`, onAction)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80 text-slate-200">
                {bodyRows.map((rCells, rIdx) => (
                  <tr
                    key={`tr-${rIdx}`}
                    className="hover:bg-cyan-500/5 transition-colors"
                  >
                    {rCells.map((cText, cIdx) => (
                      <td key={`td-${rIdx}-${cIdx}`} className="py-1.5 px-3 align-top leading-relaxed">
                        {renderFormattedLine(cText, `td-${segIdx}-${idx}-${rIdx}-${cIdx}`, onAction)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        );
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
