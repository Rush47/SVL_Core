import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpDown,
  Check,
  CheckCircle2,
  CheckSquare,
  ChevronDown,
  Clock,
  Copy,
  Info,
  ListChecks,
  Loader2,
  Play,
  ShieldAlert,
  Sparkles,
  Square,
  Terminal,
  XCircle,
} from 'lucide-react';
import { ChatInteractiveButton } from './ChatInteractiveButton';
import {
  isUnsafeChatInteractiveAction,
  normalizeAiInteractiveMarkup,
  parseChatInteractiveToken,
} from '../utils/svlLogic';
import {
  parseAlertToken,
  parseBadgeToken,
  parseBarsToken,
  parseChecklistToken,
  parseChipsToken,
  parseConfirmToken,
  parseDiffToken,
  parseFormToken,
  parseGaugeToken,
  parseJsonToken,
  parseKpiToken,
  parseStepToken,
  parseTabsToken,
  parseTerminalToken,
  parseTimelineToken,
  parseToggleToken,
  renderFormTemplate,
  type InteractiveTone,
  type ParsedAlertToken,
  type ParsedBarsToken,
  type ParsedChecklistToken,
  type ParsedChipsToken,
  type ParsedConfirmToken,
  type ParsedDiffToken,
  type ParsedFormToken,
  type ParsedGaugeToken,
  type ParsedJsonToken,
  type ParsedKpiToken,
  type ParsedStepToken,
  type ParsedTabsToken,
  type ParsedTerminalToken,
  type ParsedTimelineToken,
  type ParsedToggleToken,
} from '../utils/chatInteractiveTokens';

const InteractiveCodeBlock: React.FC<{
  code: string;
  language: string;
  onAction?: (actionValue: string, label?: string) => void | Promise<void>;
}> = ({ code, language, onAction }) => {
  const [copied, setCopied] = useState(false);
  const cleanCode = code.replace(/^\n+|\n+$/g, '');
  const cleanLang = (language || '').toLowerCase().trim();
  const lineCount = cleanCode ? cleanCode.split('\n').length : 0;
  const isShell = /^(bash|sh|zsh|shell|console|terminal)$/.test(cleanLang);

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
    <div className="my-2.5 w-full max-w-full min-w-0 rounded-xl border border-slate-700/80 bg-[#060911] overflow-hidden text-xs font-mono shadow-md">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 bg-[#0E1525] border-b border-slate-800 text-[11px] text-slate-400">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold uppercase tracking-wider text-cyan-300 truncate">
            {cleanLang || 'TERMINAL / KOD'}
          </span>
          <span className="text-[10px] text-slate-500 tabular-nums">{lineCount} l.</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {onAction && (
            <button
              type="button"
              onClick={() => void onAction(`text:${cleanCode}`, 'Wstawiono kod do czatu')}
              className="min-h-[26px] flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-cyan-200 transition-colors"
              title="Wstaw treść do pola wpisywania czatu"
            >
              <span>Wstaw</span>
            </button>
          )}
          {onAction && isShell && (
            <button
              type="button"
              onClick={() => void onAction('tab:terminals', 'Otwarto terminale')}
              className="min-h-[26px] flex items-center gap-1 px-2 py-0.5 rounded bg-cyan-950/60 border border-cyan-500/30 hover:bg-cyan-900/60 text-cyan-200 transition-colors"
              title="Otwórz zakładkę Terminale"
            >
              <Terminal className="w-3 h-3" aria-hidden="true" />
              <span>Terminale</span>
            </button>
          )}
          <button
            type="button"
            onClick={handleCopy}
            className="min-h-[26px] flex items-center gap-1 px-2.5 py-0.5 rounded bg-slate-800/90 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
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

const InteractiveStepCard: React.FC<{ step: ParsedStepToken }> = ({ step }) => {
  const cfg =
    step.status === 'running'
      ? { icon: <Loader2 className="w-3.5 h-3.5 text-cyan-300 animate-spin shrink-0" />, cls: 'border-cyan-500/35 bg-cyan-950/20 text-cyan-100' }
      : step.status === 'error'
        ? { icon: <XCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />, cls: 'border-rose-500/35 bg-rose-950/20 text-rose-100' }
        : step.status === 'pending'
          ? { icon: <Clock className="w-3.5 h-3.5 text-slate-400 shrink-0" />, cls: 'border-slate-700/80 bg-[#0B101C] text-slate-300' }
          : { icon: <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />, cls: 'border-emerald-500/35 bg-emerald-950/20 text-emerald-100' };
  return (
    <div className={`my-1.5 flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs ${cfg.cls}`}>
      <span className="inline-flex items-center gap-2 font-medium min-w-0">
        {cfg.icon}
        <span className="truncate">{step.label}</span>
      </span>
      {step.detail && <span className="font-mono text-[11px] opacity-80 shrink-0">{step.detail}</span>}
    </div>
  );
};

const InteractiveToggleCard: React.FC<{
  toggle: ParsedToggleToken;
  onAction?: (actionValue: string, label?: string) => void | Promise<void>;
}> = ({ toggle, onAction }) => {
  const [enabled, setEnabled] = useState(toggle.enabled);
  const handleToggle = () => {
    const next = !enabled;
    setEnabled(next);
    const act = next ? toggle.onAction : toggle.offAction;
    if (onAction && !isUnsafeChatInteractiveAction(act)) {
      void onAction(act, `${toggle.label}: ${next ? 'ON' : 'OFF'}`);
    }
  };
  return (
    <div className="my-1.5 flex items-center justify-between gap-3 rounded-xl border border-slate-700/80 bg-[#0B111F] px-3 py-2 text-xs">
      <span className="font-medium text-slate-200">{toggle.label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={handleToggle}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${
          enabled
            ? 'border-emerald-400/60 bg-emerald-500/30'
            : 'border-slate-600 bg-slate-800'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full transition-transform ${
            enabled ? 'translate-x-5 bg-emerald-300' : 'translate-x-1 bg-slate-400'
          }`}
        />
      </button>
    </div>
  );
};

const InteractiveFormCard: React.FC<{
  form: ParsedFormToken;
  onAction?: (actionValue: string, label?: string) => void | Promise<void>;
}> = ({ form, onAction }) => {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(form.fields.map((f) => [f.name, f.defaultValue])),
  );
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cmd = renderFormTemplate(form.commandTemplate, values).trim();
    if (!cmd || !onAction) return;
    const actionStr = /^(send|ask|text|copy|tab|action):/i.test(cmd) ? cmd : `send:${cmd}`;
    if (!isUnsafeChatInteractiveAction(actionStr)) {
      setSubmitted(true);
      void onAction(actionStr, form.title);
      setTimeout(() => setSubmitted(false), 2000);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="my-2 rounded-xl border border-cyan-500/30 bg-[#0A1120] p-3 space-y-2.5 text-xs"
    >
      <div className="flex items-center justify-between gap-2 border-b border-slate-800 pb-1.5">
        <span className="font-semibold text-cyan-300">{form.title}</span>
        <span className="font-mono text-[10px] text-slate-500">INTERAKTYWNY FORMULARZ</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {form.fields.map((field) => (
          <label key={field.name} className="flex flex-col gap-1">
            <span className="text-[11px] text-slate-400">{field.label}</span>
            <input
              type="text"
              value={values[field.name] ?? ''}
              onChange={(e) => setValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
              className="rounded-md border border-slate-700 bg-[#060911] px-2.5 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-cyan-400"
            />
          </label>
        ))}
      </div>
      <div className="flex justify-end">
        <button
          type="submit"
          className="inline-flex items-center gap-1.5 rounded-md bg-cyan-600 hover:bg-cyan-500 px-3 py-1.5 text-[11px] font-semibold text-white transition-colors"
        >
          <Play className="w-3 h-3" aria-hidden="true" />
          <span>{submitted ? 'Wysłano ✓' : 'Wykonaj'}</span>
        </button>
      </div>
    </form>
  );
};

const TONE_SURFACE: Record<InteractiveTone, string> = {
  ok: 'border-emerald-500/35 bg-emerald-950/20 text-emerald-200',
  warn: 'border-amber-500/35 bg-amber-950/20 text-amber-200',
  err: 'border-rose-500/35 bg-rose-950/20 text-rose-200',
  info: 'border-cyan-500/30 bg-cyan-950/20 text-cyan-200',
};

const TONE_BADGE: Record<InteractiveTone, string> = {
  ok: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300',
  warn: 'border-amber-500/40 bg-amber-500/15 text-amber-300',
  err: 'border-rose-500/40 bg-rose-500/15 text-rose-300',
  info: 'border-cyan-500/40 bg-cyan-500/15 text-cyan-300',
};

const InteractiveKpiTile: React.FC<{ kpi: ParsedKpiToken }> = ({ kpi }) => (
  <div className={`my-1.5 inline-flex flex-col min-w-[150px] max-w-full mr-2 rounded-xl border px-3 py-2 align-middle ${TONE_SURFACE[kpi.tone]}`}>
    <span className="text-[10px] font-mono uppercase tracking-wider text-slate-400">{kpi.label}</span>
    <div className="mt-0.5 flex items-baseline gap-2">
      <span className="text-base font-bold font-mono tabular-nums text-white">{kpi.value}</span>
      {kpi.delta && (
        <span className={`rounded-full border px-1.5 py-0.5 text-[10px] font-mono ${TONE_BADGE[kpi.tone]}`}>
          {kpi.delta}
        </span>
      )}
    </div>
  </div>
);

const InteractiveAlertBanner: React.FC<{
  alert: ParsedAlertToken;
  keyPrefix: string;
  onAction?: (actionValue: string, label?: string) => void | Promise<void>;
}> = ({ alert, keyPrefix, onAction }) => {
  const Icon =
    alert.tone === 'ok'
      ? CheckCircle2
      : alert.tone === 'warn'
        ? AlertTriangle
        : alert.tone === 'err'
          ? ShieldAlert
          : Info;
  return (
    <div className={`my-2 flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-xs ${TONE_SURFACE[alert.tone]}`}>
      <Icon className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="font-semibold text-white">{alert.title}</div>
        <div className="text-slate-200/90 leading-relaxed">{renderFormattedLine(alert.body, keyPrefix, onAction)}</div>
      </div>
    </div>
  );
};

const InteractiveChecklistCard: React.FC<{
  checklist: ParsedChecklistToken;
  keyPrefix: string;
  onAction?: (actionValue: string, label?: string) => void | Promise<void>;
}> = ({ checklist, keyPrefix, onAction }) => {
  const [checkedMap, setCheckedMap] = useState<boolean[]>(() => checklist.items.map((i) => i.checked));
  const doneCount = checkedMap.filter(Boolean).length;
  return (
    <div className="my-2 rounded-xl border border-cyan-500/25 bg-[#09101D] p-3 text-xs space-y-2">
      <div className="flex items-center justify-between gap-2 border-b border-slate-800/80 pb-1.5">
        <span className="inline-flex items-center gap-1.5 font-semibold text-cyan-200">
          <ListChecks className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" />
          <span>{checklist.title}</span>
        </span>
        <span className="font-mono text-[10px] text-slate-400 tabular-nums">
          {doneCount}/{checklist.items.length} ukończone
        </span>
      </div>
      <div className="space-y-1">
        {checklist.items.map((item, idx) => {
          const isDone = Boolean(checkedMap[idx]);
          return (
            <div key={`${keyPrefix}-cli-${idx}`} className="flex items-start gap-2">
              <button
                type="button"
                role="checkbox"
                aria-checked={isDone}
                onClick={() =>
                  setCheckedMap((prev) => prev.map((v, i) => (i === idx ? !v : v)))
                }
                className="mt-0.5 text-cyan-400 hover:text-cyan-300 transition-colors shrink-0"
              >
                {isDone ? <CheckSquare className="w-4 h-4 text-emerald-400" /> : <Square className="w-4 h-4" />}
              </button>
              <span className={`leading-relaxed ${isDone ? 'line-through text-slate-500' : 'text-slate-200'}`}>
                {renderFormattedLine(item.text, `${keyPrefix}-clt-${idx}`, onAction)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const InteractiveTabsBlock: React.FC<{
  tabs: ParsedTabsToken;
  keyPrefix: string;
  onAction?: (actionValue: string, label?: string) => void | Promise<void>;
}> = ({ tabs, keyPrefix, onAction }) => {
  const [activeIdx, setActiveIdx] = useState(0);
  const current = tabs.tabs[activeIdx] ?? tabs.tabs[0];
  return (
    <div className="my-2 rounded-xl border border-slate-700/80 bg-[#080E1A] overflow-hidden text-xs">
      <div className="flex flex-wrap items-center gap-1 border-b border-slate-800 bg-[#0D1526] px-2 py-1.5" role="tablist">
        {tabs.tabs.map((tab, idx) => {
          const active = idx === activeIdx;
          return (
            <button
              key={`${keyPrefix}-tab-${idx}`}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveIdx(idx)}
              className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                active
                  ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-400/40'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div className="p-3 text-slate-200 leading-relaxed" role="tabpanel">
        {renderFormattedLine(current.content, `${keyPrefix}-tabpanel-${activeIdx}`, onAction)}
      </div>
    </div>
  );
};

const InteractiveConfirmCard: React.FC<{
  confirm: ParsedConfirmToken;
  onAction?: (actionValue: string, label?: string) => void | Promise<void>;
}> = ({ confirm, onAction }) => {
  const [state, setState] = useState<'idle' | 'confirmed' | 'cancelled'>('idle');
  const unsafe = isUnsafeChatInteractiveAction(confirm.confirmAction);
  return (
    <div className="my-2 rounded-xl border border-amber-500/35 bg-[#12101A] p-3 text-xs space-y-2.5">
      <div>
        <div className="font-semibold text-amber-200">{confirm.title}</div>
        <div className="mt-0.5 text-slate-300 leading-relaxed">{confirm.description}</div>
      </div>
      {state === 'idle' ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={unsafe}
            onClick={() => {
              if (!unsafe && onAction) {
                setState('confirmed');
                void onAction(confirm.confirmAction, confirm.confirmLabel);
              }
            }}
            className="rounded-md bg-amber-500/90 hover:bg-amber-400 disabled:opacity-40 px-3 py-1.5 text-[11px] font-semibold text-slate-950 transition-colors"
          >
            {confirm.confirmLabel}
          </button>
          <button
            type="button"
            onClick={() => setState('cancelled')}
            className="rounded-md border border-slate-700 bg-slate-800/80 hover:bg-slate-700 px-3 py-1.5 text-[11px] font-medium text-slate-300 transition-colors"
          >
            {confirm.cancelLabel}
          </button>
        </div>
      ) : (
        <div className={`text-[11px] font-mono ${state === 'confirmed' ? 'text-emerald-300' : 'text-slate-400'}`}>
          {state === 'confirmed' ? `Potwierdzono: ${confirm.confirmLabel} ✓` : 'Anulowano przez Operatora'}
        </div>
      )}
    </div>
  );
};

const InteractiveChipsBar: React.FC<{
  chips: ParsedChipsToken;
  onAction?: (actionValue: string, label?: string) => void | Promise<void>;
}> = ({ chips, onAction }) => (
  <div className="my-2 flex flex-wrap items-center gap-1.5 text-xs">
    <span className="inline-flex items-center gap-1 text-[11px] font-mono text-slate-400 mr-1">
      <Sparkles className="w-3 h-3 text-cyan-400" aria-hidden="true" />
      <span>{chips.label}:</span>
    </span>
    {chips.options.map((opt, idx) => {
      const unsafe = isUnsafeChatInteractiveAction(opt.action);
      return (
        <button
          key={`${opt.label}-${idx}`}
          type="button"
          disabled={unsafe}
          onClick={() => {
            if (!unsafe && onAction) void onAction(opt.action, opt.label);
          }}
          className="rounded-full border border-cyan-500/30 bg-cyan-950/30 hover:bg-cyan-500/20 disabled:opacity-40 px-2.5 py-1 text-[11px] font-medium text-cyan-200 transition-colors"
        >
          {opt.label}
        </button>
      );
    })}
  </div>
);

const InteractiveTimelineCard: React.FC<{ timeline: ParsedTimelineToken }> = ({ timeline }) => (
  <div className="my-2 rounded-xl border border-slate-700/80 bg-[#080E1A] p-3 text-xs">
    <div className="space-y-2 border-l border-cyan-500/35 pl-3 ml-1.5">
      {timeline.entries.map((entry, idx) => (
        <div key={`${entry.title}-${idx}`} className="relative">
          <span className="absolute -left-[17px] top-1.5 h-2 w-2 rounded-full bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.7)]" />
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-medium text-slate-100">{entry.title}</span>
            {entry.meta && <span className="font-mono text-[10px] text-cyan-300/90">{entry.meta}</span>}
          </div>
        </div>
      ))}
    </div>
  </div>
);

const InteractiveTerminalPreview: React.FC<{
  term: ParsedTerminalToken;
  onAction?: (actionValue: string, label?: string) => void | Promise<void>;
}> = ({ term, onAction }) => {
  const [copied, setCopied] = useState(false);
  const copyCmd = () => {
    try {
      void navigator.clipboard.writeText(term.command);
    } catch {
      // clipboard unavailable
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <div className="my-2 rounded-xl border border-slate-700/80 bg-[#050810] overflow-hidden text-xs font-mono">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-[#0D1422] border-b border-slate-800 px-3 py-1.5">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-cyan-300">
          <Terminal className="w-3.5 h-3.5" aria-hidden="true" />
          <span>{term.title}</span>
        </span>
        <div className="flex items-center gap-1.5">
          {onAction && (
            <button
              type="button"
              onClick={() => void onAction(`text:${term.command}`, 'Wstawiono komendę')}
              className="rounded bg-slate-800 hover:bg-slate-700 px-2 py-0.5 text-[10px] text-slate-200 transition-colors"
            >
              Wstaw
            </button>
          )}
          <button
            type="button"
            onClick={copyCmd}
            className="inline-flex items-center gap-1 rounded bg-slate-800 hover:bg-slate-700 px-2 py-0.5 text-[10px] text-slate-200 transition-colors"
          >
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            <span>{copied ? 'OK' : 'Kopiuj'}</span>
          </button>
        </div>
      </div>
      <div className="p-2.5 space-y-1.5">
        <div className="text-emerald-300 break-all">$ {term.command}</div>
        {term.output && <div className="text-slate-300/90 whitespace-pre-wrap break-words border-t border-slate-800/70 pt-1.5">{term.output}</div>}
      </div>
    </div>
  );
};

const InteractiveDiffCard: React.FC<{ diff: ParsedDiffToken }> = ({ diff }) => {
  const [copied, setCopied] = useState(false);
  const copyAfter = () => {
    try {
      void navigator.clipboard.writeText(diff.after);
    } catch {
      // clipboard unavailable
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <div className="my-2 rounded-xl border border-slate-700/80 bg-[#060911] overflow-hidden text-xs font-mono">
      <div className="flex items-center justify-between gap-2 bg-[#0D1525] border-b border-slate-800 px-3 py-1.5">
        <span className="text-[11px] font-semibold text-cyan-300 truncate">{diff.file}</span>
        <button
          type="button"
          onClick={copyAfter}
          className="inline-flex items-center gap-1 rounded bg-slate-800 hover:bg-slate-700 px-2 py-0.5 text-[10px] text-slate-200 transition-colors"
        >
          {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
          <span>{copied ? 'Skopiowano' : 'Kopiuj nowy'}</span>
        </button>
      </div>
      <div className="divide-y divide-slate-800/60">
        <div className="bg-rose-950/30 text-rose-300 px-3 py-1.5 whitespace-pre-wrap break-all">- {diff.before}</div>
        <div className="bg-emerald-950/30 text-emerald-300 px-3 py-1.5 whitespace-pre-wrap break-all">+ {diff.after}</div>
      </div>
    </div>
  );
};

const InteractiveBarsChart: React.FC<{ bars: ParsedBarsToken }> = ({ bars }) => {
  const maxVal = Math.max(1, ...bars.items.map((i) => i.value));
  return (
    <div className="my-2 rounded-xl border border-cyan-500/25 bg-[#080E1A] p-3 text-xs space-y-2">
      <div className="font-semibold text-cyan-200 border-b border-slate-800/80 pb-1">{bars.title}</div>
      <div className="space-y-1.5">
        {bars.items.map((item, idx) => {
          const pct = Math.min(100, Math.round((item.value / maxVal) * 100));
          return (
            <div key={`${item.label}-${idx}`} className="space-y-0.5">
              <div className="flex items-center justify-between gap-2 text-[11px] font-mono">
                <span className="text-slate-300 truncate">{item.label}</span>
                <span className="text-cyan-300 tabular-nums shrink-0">{item.value}</span>
              </div>
              <div className="h-2 w-full rounded-full bg-slate-800 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-sky-400 transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const InteractiveGaugeCard: React.FC<{ gauge: ParsedGaugeToken }> = ({ gauge }) => {
  const barCls =
    gauge.tone === 'ok'
      ? 'from-emerald-500 to-teal-400'
      : gauge.tone === 'warn'
        ? 'from-amber-500 to-yellow-400'
        : gauge.tone === 'err'
          ? 'from-rose-500 to-red-400'
          : 'from-cyan-500 to-sky-400';
  return (
    <div className={`my-1.5 inline-flex flex-col min-w-[170px] max-w-full mr-2 rounded-xl border px-3 py-2 align-middle ${TONE_SURFACE[gauge.tone]}`}>
      <div className="flex items-center justify-between gap-2 text-[11px] font-mono">
        <span className="text-slate-300 truncate">{gauge.label}</span>
        <span className="font-bold text-white tabular-nums">{gauge.percent}{gauge.unit}</span>
      </div>
      <div className="mt-1.5 h-2 w-full rounded-full bg-slate-900/90 overflow-hidden">
        <div className={`h-full rounded-full bg-gradient-to-r ${barCls}`} style={{ width: `${gauge.percent}%` }} />
      </div>
    </div>
  );
};

const InteractiveJsonCard: React.FC<{ jsonItem: ParsedJsonToken }> = ({ jsonItem }) => {
  const [copied, setCopied] = useState(false);
  const formatted = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(jsonItem.rawJson), null, 2);
    } catch {
      return jsonItem.rawJson;
    }
  }, [jsonItem.rawJson]);
  const copyJson = () => {
    try {
      void navigator.clipboard.writeText(formatted);
    } catch {
      // clipboard unavailable
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <details className="my-2 rounded-xl border border-slate-700/80 bg-[#060911] overflow-hidden text-xs font-mono">
      <summary className="cursor-pointer list-none flex items-center justify-between gap-2 bg-[#0D1525] px-3 py-1.5 text-cyan-300 hover:bg-[#131E33]">
        <span className="font-semibold truncate">{jsonItem.title}</span>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            copyJson();
          }}
          className="inline-flex items-center gap-1 rounded bg-slate-800 hover:bg-slate-700 px-2 py-0.5 text-[10px] text-slate-200"
        >
          {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
          <span>{copied ? 'OK' : 'JSON'}</span>
        </button>
      </summary>
      <pre className="p-2.5 text-[11px] text-slate-200 overflow-x-auto max-h-72">{formatted}</pre>
    </details>
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
    .split(/(\[(?:btn|button|action|przycisk|card|metric|karta|progress|postep|postęp|badge|znacznik|kpi|metrics|metryka):[^\]\n]+\])/gi)
    .flatMap((part) =>
      parseChatInteractiveToken(part) || parseCardToken(part) || parseProgressToken(part) || parseBadgeToken(part) || parseKpiToken(part)
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
    const badge = parseBadgeToken(tok);
    if (badge) {
      return (
        <span
          key={`${keyPrefix}-${i}`}
          className={`inline-flex items-center rounded-full border px-2 py-0.5 mr-1 text-[10px] font-mono font-semibold uppercase tracking-wider align-middle ${TONE_BADGE[badge.tone]}`}
        >
          {badge.text}
        </span>
      );
    }
    const inlineKpi = parseKpiToken(tok);
    if (inlineKpi) {
      return <InteractiveKpiTile key={`${keyPrefix}-${i}`} kpi={inlineKpi} />;
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
          onAction={onAction}
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

      // Interactive Copilot/Work blocks: [step:...], [toggle:...], [form:...]
      const stepToken = parseStepToken(trimmed);
      if (stepToken) {
        renderedElements.push(<InteractiveStepCard key={`step-${segIdx}-${idx}`} step={stepToken} />);
        idx += 1;
        continue;
      }

      const toggleToken = parseToggleToken(trimmed);
      if (toggleToken) {
        renderedElements.push(
          <InteractiveToggleCard key={`toggle-${segIdx}-${idx}`} toggle={toggleToken} onAction={onAction} />,
        );
        idx += 1;
        continue;
      }

      const formToken = parseFormToken(trimmed);
      if (formToken) {
        renderedElements.push(
          <InteractiveFormCard key={`form-${segIdx}-${idx}`} form={formToken} onAction={onAction} />,
        );
        idx += 1;
        continue;
      }

      const alertToken = parseAlertToken(trimmed);
      if (alertToken) {
        renderedElements.push(
          <InteractiveAlertBanner
            key={`alert-${segIdx}-${idx}`}
            alert={alertToken}
            keyPrefix={`alert-${segIdx}-${idx}`}
            onAction={onAction}
          />,
        );
        idx += 1;
        continue;
      }

      const checklistToken = parseChecklistToken(trimmed);
      if (checklistToken) {
        renderedElements.push(
          <InteractiveChecklistCard
            key={`checklist-${segIdx}-${idx}`}
            checklist={checklistToken}
            keyPrefix={`checklist-${segIdx}-${idx}`}
            onAction={onAction}
          />,
        );
        idx += 1;
        continue;
      }

      const tabsToken = parseTabsToken(trimmed);
      if (tabsToken) {
        renderedElements.push(
          <InteractiveTabsBlock
            key={`tabs-${segIdx}-${idx}`}
            tabs={tabsToken}
            keyPrefix={`tabs-${segIdx}-${idx}`}
            onAction={onAction}
          />,
        );
        idx += 1;
        continue;
      }

      const confirmToken = parseConfirmToken(trimmed);
      if (confirmToken) {
        renderedElements.push(
          <InteractiveConfirmCard key={`confirm-${segIdx}-${idx}`} confirm={confirmToken} onAction={onAction} />,
        );
        idx += 1;
        continue;
      }

      const chipsToken = parseChipsToken(trimmed);
      if (chipsToken) {
        renderedElements.push(
          <InteractiveChipsBar key={`chips-${segIdx}-${idx}`} chips={chipsToken} onAction={onAction} />,
        );
        idx += 1;
        continue;
      }

      const timelineToken = parseTimelineToken(trimmed);
      if (timelineToken) {
        renderedElements.push(<InteractiveTimelineCard key={`timeline-${segIdx}-${idx}`} timeline={timelineToken} />);
        idx += 1;
        continue;
      }

      const terminalToken = parseTerminalToken(trimmed);
      if (terminalToken) {
        renderedElements.push(
          <InteractiveTerminalPreview key={`term-${segIdx}-${idx}`} term={terminalToken} onAction={onAction} />,
        );
        idx += 1;
        continue;
      }

      const diffToken = parseDiffToken(trimmed);
      if (diffToken) {
        renderedElements.push(<InteractiveDiffCard key={`diff-${segIdx}-${idx}`} diff={diffToken} />);
        idx += 1;
        continue;
      }

      const barsToken = parseBarsToken(trimmed);
      if (barsToken) {
        renderedElements.push(<InteractiveBarsChart key={`bars-${segIdx}-${idx}`} bars={barsToken} />);
        idx += 1;
        continue;
      }

      const gaugeToken = parseGaugeToken(trimmed);
      if (gaugeToken) {
        renderedElements.push(<InteractiveGaugeCard key={`gauge-${segIdx}-${idx}`} gauge={gaugeToken} />);
        idx += 1;
        continue;
      }

      const jsonToken = parseJsonToken(trimmed);
      if (jsonToken) {
        renderedElements.push(<InteractiveJsonCard key={`json-${segIdx}-${idx}`} jsonItem={jsonToken} />);
        idx += 1;
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
