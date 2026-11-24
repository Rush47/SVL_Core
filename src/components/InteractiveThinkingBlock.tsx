import React, { useState } from 'react';
import { Brain, ChevronDown, ChevronRight, Copy, Check, Sparkles } from 'lucide-react';
import { ParsedThinkingToken } from '../utils/chatInteractiveTokens';

interface InteractiveThinkingBlockProps {
  thinking: ParsedThinkingToken;
  className?: string;
  defaultExpanded?: boolean;
}

export const InteractiveThinkingBlock: React.FC<InteractiveThinkingBlockProps> = ({
  thinking,
  className = '',
  defaultExpanded = false
}) => {
  const [isOpen, setIsOpen] = useState(defaultExpanded);
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(thinking.thought);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const wordCount = thinking.thought.trim().split(/\s+/).filter(Boolean).length;

  return (
    <div
      className={`my-3 border border-indigo-500/30 bg-gradient-to-r from-indigo-950/20 via-purple-950/15 to-slate-900/40 rounded-xl overflow-hidden transition-all duration-200 shadow-sm hover:border-indigo-500/50 ${className}`}
    >
      {/* Header bar */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setIsOpen(!isOpen)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setIsOpen(!isOpen);
          }
        }}
        className="w-full flex items-center justify-between px-3.5 py-2.5 bg-indigo-950/40 hover:bg-indigo-900/30 transition-colors cursor-pointer select-none text-left"
        aria-expanded={isOpen}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex items-center justify-center w-6 h-6 rounded-lg bg-indigo-500/20 border border-indigo-400/30 text-indigo-300">
            <Brain className="w-3.5 h-3.5 animate-pulse" />
          </div>
          <div className="flex items-center gap-2 truncate">
            <span className="text-xs font-semibold text-indigo-200 tracking-wide">
              {thinking.title || 'Proces myślowy JYN_OS'}
            </span>
            <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
              <Sparkles className="w-2.5 h-2.5" />
              {thinking.duration ? `${thinking.duration}s` : `~${wordCount} słów`}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
          <button
            type="button"
            onClick={handleCopy}
            className="p-1 rounded hover:bg-indigo-500/20 text-indigo-300 hover:text-indigo-100 transition-colors"
            title="Kopiuj tok myślenia"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
          <div className="text-indigo-400">
            {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </div>
        </div>
      </div>

      {/* Collapsible Content */}
      {isOpen && (
        <div className="px-4 py-3 bg-slate-950/50 border-t border-indigo-500/20 text-xs text-slate-300 leading-relaxed font-mono whitespace-pre-wrap selection:bg-indigo-500/30">
          <div className="pl-2 border-l-2 border-indigo-500/40 space-y-1">
            {thinking.thought}
          </div>
        </div>
      )}
    </div>
  );
};
