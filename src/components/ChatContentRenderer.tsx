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
  Send,
  ShieldAlert,
  Sigma,
  Sparkles,
  Square,
  Terminal,
  WrapText,
  XCircle,
} from 'lucide-react';
import { ChatInteractiveButton } from './ChatInteractiveButton';
import {
  isUnsafeChatInteractiveAction,
  normalizeAiInteractiveMarkup,
  parseChatInteractiveToken,
} from '../utils/svlLogic';
import {
  parseActionCardToken,
  parseAlertToken,
  parseBadgeToken,
  parseBarsToken,
  parseCheckboxToken,
  parseChecklistToken,
  parseChipsToken,
  parseConfirmToken,
  parseDiffToken,
  parseFormToken,
  parseGaugeToken,
  parseHighlightToken,
  parseJsonToken,
  parseKbdToken,
  parseKpiToken,
  parseStepToken,
  parseTabsToken,
  parseTerminalToken,
  parseTimelineToken,
  parseToggleToken,
  renderChecklistActionTemplate,
  renderFormTemplate,
  type InteractiveTone,
  type ParsedActionCardToken,
  type ParsedAlertToken,
  type ParsedBarsToken,
  type ParsedCheckboxToken,
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
import {
  tokenizeInlineMarkdown,
  type HighlightTone,
  type InlineMarkdownNode,
} from '../utils/chatMarkdownInline';
import { renderMathToHtml } from '../utils/chatMath';

const InteractiveCodeBlock: React.FC<{
  code: string;
  language: string;
  onAction?: (actionValue: string, label?: string) => void | Promise<void>;
}> = ({ code, language, onAction }) => {
  const [copied, setCopied] = useState(false);
  const [wrapLines, setWrapLines] = useState(false);
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
          <button
            type="button"
            onClick={() => setWrapLines((prev) => !prev)}
            aria-pressed={wrapLines}
            className={`min-h-[26px] flex items-center gap-1 px-2 py-0.5 rounded transition-colors ${
              wrapLines
                ? 'bg-cyan-500/20 border border-cyan-400/40 text-cyan-200'
                : 'bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-cyan-200'
            }`}
            title={wrapLines ? 'Wyłącz zawijanie długich linii' : 'Włącz zawijanie długich linii'}
          >
            <WrapText className="w-3 h-3" aria-hidden="true" />
            <span className="hidden sm:inline">Zawijaj</span>
          </button>
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
        <pre className={wrapLines ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'}>{cleanCode}</pre>
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

const HIGHLIGHT_TONE_CLASS: Record<HighlightTone, string> = {
  amber: 'bg-amber-400/20 text-amber-100 border-amber-400/45 shadow-[0_0_12px_-5px_rgba(251,191,36,0.55)]',
  cyan: 'bg-cyan-400/18 text-cyan-100 border-cyan-400/45 shadow-[0_0_12px_-5px_rgba(34,211,238,0.55)]',
  emerald: 'bg-emerald-400/18 text-emerald-100 border-emerald-400/45 shadow-[0_0_12px_-5px_rgba(52,211,153,0.55)]',
  rose: 'bg-rose-400/20 text-rose-100 border-rose-400/45 shadow-[0_0_12px_-5px_rgba(251,113,133,0.55)]',
  violet: 'bg-violet-400/20 text-violet-100 border-violet-400/45 shadow-[0_0_12px_-5px_rgba(167,139,250,0.55)]',
};

const InteractiveHighlightSpan: React.FC<{ text: string; tone?: HighlightTone }> = ({
  text,
  tone = 'amber',
}) => (
  <mark
    data-highlight-tone={tone}
    className={`inline rounded-md border px-1.5 py-[1px] font-medium not-italic ${HIGHLIGHT_TONE_CLASS[tone]}`}
  >
    {text}
  </mark>
);

const InteractiveKbdBadge: React.FC<{ keys: string }> = ({ keys }) => {
  const parts =
    keys.trim() === '+'
      ? ['+']
      : keys
          .split(/\s*\+\s*/)
          .map((p) => p.trim())
          .filter(Boolean);
  return (
    <span className="inline-flex items-center gap-0.5 align-middle mx-0.5" data-kbd-group="true">
      {parts.map((part, idx) => (
        <React.Fragment key={`${part}-${idx}`}>
          {idx > 0 && <span className="text-[10px] text-slate-500 font-mono">+</span>}
          <kbd className="inline-flex items-center justify-center min-w-[20px] rounded-md border border-slate-600/90 bg-gradient-to-b from-slate-800 to-slate-900 px-1.5 py-[1px] font-mono text-[11px] font-semibold text-slate-100 shadow-[inset_0_-1px_0_rgba(15,23,42,0.9),0_1px_2px_rgba(0,0,0,0.45)]">
            {part}
          </kbd>
        </React.Fragment>
      ))}
    </span>
  );
};

const InteractiveMathInline: React.FC<{ tex: string }> = ({ tex }) => {
  const rendered = useMemo(() => renderMathToHtml(tex, false), [tex]);
  if (!rendered.html) {
    return (
      <code className="px-1.5 py-0.5 rounded bg-[#070A10] border border-cyan-500/25 font-mono text-[12px] text-cyan-200">
        {tex}
      </code>
    );
  }
  return (
    <span
      className="svl-math-inline inline-block align-baseline px-0.5 text-slate-100"
      data-math-inline="true"
      title={tex}
      dangerouslySetInnerHTML={{ __html: rendered.html }}
    />
  );
};

const InteractiveMathBlock: React.FC<{
  tex: string;
  onAction?: (actionValue: string, label?: string) => void | Promise<void>;
}> = ({ tex, onAction }) => {
  const [copied, setCopied] = useState(false);
  const cleanTex = tex.trim();
  const rendered = useMemo(() => renderMathToHtml(cleanTex, true), [cleanTex]);

  const handleCopy = () => {
    try {
      void navigator.clipboard.writeText(cleanTex);
    } catch {
      // clipboard unavailable
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div
      className="my-2.5 w-full max-w-full rounded-xl border border-cyan-500/25 bg-gradient-to-b from-[#0A1324] to-[#060B16] overflow-hidden shadow-md"
      data-math-block="true"
    >
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-[#0D1628] border-b border-slate-800/80 text-[11px] text-slate-400">
        <span className="inline-flex items-center gap-1.5 font-mono font-semibold uppercase tracking-wider text-cyan-300">
          <Sigma className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" />
          <span>Wzór · LaTeX</span>
        </span>
        <div className="flex items-center gap-1.5">
          {onAction && (
            <button
              type="button"
              onClick={() => void onAction(`text:$$\n${cleanTex}\n$$`, 'Wstawiono wzór do czatu')}
              className="min-h-[24px] px-2 py-0.5 rounded bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-cyan-200 transition-colors font-mono text-[10px]"
              title="Wstaw wzór do pola czatu"
            >
              Wstaw
            </button>
          )}
          <button
            type="button"
            onClick={handleCopy}
            className="min-h-[24px] inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800/90 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors font-mono text-[10px]"
            title="Skopiuj kod LaTeX"
          >
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            <span>{copied ? 'Skopiowano!' : 'LaTeX'}</span>
          </button>
        </div>
      </div>
      <div className="svl-math-block px-4 py-3 overflow-x-auto text-center text-slate-100">
        {rendered.html ? (
          <div dangerouslySetInnerHTML={{ __html: rendered.html }} />
        ) : (
          <pre className="font-mono text-xs text-rose-300 whitespace-pre-wrap text-left">{cleanTex}</pre>
        )}
      </div>
    </div>
  );
};

const InteractiveActionCheckbox: React.FC<{
  checkbox: ParsedCheckboxToken;
  onAction?: (actionValue: string, label?: string) => void | Promise<void>;
  block?: boolean;
}> = ({ checkbox, onAction, block = false }) => {
  const [checked, setChecked] = useState(checkbox.checked);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const nextAction = checked ? checkbox.offAction : checkbox.onAction;
  const unsafe = Boolean(nextAction && isUnsafeChatInteractiveAction(nextAction));

  const handleToggle = () => {
    const nextState = !checked;
    setChecked(nextState);
    const act = nextState ? checkbox.onAction : checkbox.offAction;
    if (act && onAction && !isUnsafeChatInteractiveAction(act)) {
      void onAction(act, `${checkbox.label}: ${nextState ? 'zaznaczono' : 'odznaczono'}`);
      setStatusNote(nextState ? 'Akcja wysłana ✓' : 'Odznaczono ✓');
      setTimeout(() => setStatusNote(null), 1800);
    }
  };

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={unsafe}
      onClick={handleToggle}
      data-action-checkbox="true"
      className={`${
        block ? 'my-1.5 flex w-full justify-between' : 'my-0.5 mr-2 inline-flex align-middle'
      } items-center gap-2 rounded-xl border px-3 py-1.5 text-xs font-medium transition-all duration-150 ${
        unsafe
          ? 'border-rose-500/30 bg-rose-950/20 text-rose-300/70 cursor-not-allowed opacity-65'
          : checked
            ? 'border-emerald-400/45 bg-emerald-500/15 text-emerald-100 hover:bg-emerald-500/20 cursor-pointer'
            : 'border-slate-700/80 bg-[#0B1221] text-slate-200 hover:border-cyan-400/50 hover:bg-cyan-950/25 cursor-pointer'
      }`}
      title={unsafe ? 'Akcja zablokowana ze względów bezpieczeństwa' : `Kliknij, aby przełączyć i wywołać akcję`}
    >
      <span className="inline-flex items-center gap-2 min-w-0">
        {checked ? (
          <CheckSquare className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
        ) : (
          <Square className="w-4 h-4 text-cyan-400 shrink-0" aria-hidden="true" />
        )}
        <span className={checked ? 'text-emerald-100' : 'text-slate-100'}>{checkbox.label}</span>
      </span>
      {statusNote && (
        <span className="font-mono text-[10px] text-emerald-300 shrink-0">{statusNote}</span>
      )}
    </button>
  );
};

const InteractiveActionCard: React.FC<{
  card: ParsedActionCardToken;
  keyPrefix: string;
  onAction?: (actionValue: string, label?: string) => void | Promise<void>;
}> = ({ card, keyPrefix, onAction }) => {
  const accentBar =
    card.tone === 'ok'
      ? 'from-emerald-400/70 to-teal-400/30'
      : card.tone === 'warn'
        ? 'from-amber-400/70 to-orange-400/30'
        : card.tone === 'err'
          ? 'from-rose-400/70 to-red-400/30'
          : 'from-cyan-400/70 to-violet-400/30';

  return (
    <div
      className={`my-2 rounded-xl border overflow-hidden shadow-md transition-colors ${TONE_SURFACE[card.tone]}`}
      data-action-card="true"
    >
      <div className={`h-0.5 w-full bg-gradient-to-r ${accentBar}`} />
      <div className="p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="text-xs font-semibold text-white tracking-tight">{card.title}</div>
          {card.description && (
            <div className="text-xs text-slate-300/95 leading-relaxed">
              {renderFormattedLine(card.description, `${keyPrefix}-ac-desc`, onAction)}
            </div>
          )}
        </div>
        <div className="shrink-0">
          <ChatInteractiveButton
            label={card.ctaLabel}
            action={card.action}
            onAction={onAction}
            disabled={isUnsafeChatInteractiveAction(card.action)}
            inGroup
          />
        </div>
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
  const [submitted, setSubmitted] = useState(false);
  const doneCount = checkedMap.filter(Boolean).length;
  const totalCount = checklist.items.length;
  const percent = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  const checkedTexts = checklist.items.filter((_, idx) => checkedMap[idx]).map((i) => i.text);
  const uncheckedTexts = checklist.items.filter((_, idx) => !checkedMap[idx]).map((i) => i.text);

  const hasCustomSubmit = Boolean(checklist.submitLabel && checklist.submitAction);
  const effectiveSubmitLabel = checklist.submitLabel || `Wyślij zaznaczone (${doneCount})`;
  const effectiveSubmitAction = checklist.submitAction
    ? renderChecklistActionTemplate(checklist.submitAction, checkedTexts, uncheckedTexts)
    : `send:Wykonaj zaznaczone punkty z „${checklist.title}”: ${checkedTexts.join('; ')}`;
  const submitUnsafe = isUnsafeChatInteractiveAction(effectiveSubmitAction);
  const submitDisabled = submitUnsafe || (!hasCustomSubmit && doneCount === 0);

  const handleBulkSubmit = () => {
    if (!onAction || submitDisabled) return;
    setSubmitted(true);
    void onAction(effectiveSubmitAction, effectiveSubmitLabel);
    setTimeout(() => setSubmitted(false), 2000);
  };

  return (
    <div
      className="my-2 rounded-xl border border-cyan-500/30 bg-gradient-to-b from-[#0A1222] to-[#070D19] p-3 text-xs space-y-2.5 shadow-sm"
      data-interactive-checklist="true"
    >
      <div className="space-y-1.5 border-b border-slate-800/80 pb-2">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 font-semibold text-cyan-200">
            <ListChecks className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" />
            <span>{checklist.title}</span>
          </span>
          <span className="font-mono text-[10px] text-slate-400 tabular-nums">
            {doneCount}/{totalCount} ukończone ({percent}%)
          </span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-slate-800/90 overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-emerald-400 transition-all duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        {checklist.items.map((item, idx) => {
          const isDone = Boolean(checkedMap[idx]);
          return (
            <div
              key={`${keyPrefix}-cli-${idx}`}
              className={`flex items-start justify-between gap-2 rounded-lg px-2 py-1.5 transition-colors ${
                isDone ? 'bg-emerald-950/20' : 'hover:bg-slate-800/40'
              }`}
            >
              <div className="flex items-start gap-2 min-w-0 flex-1">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={isDone}
                  onClick={() =>
                    setCheckedMap((prev) => prev.map((v, i) => (i === idx ? !v : v)))
                  }
                  className="mt-0.5 text-cyan-400 hover:text-cyan-300 transition-colors shrink-0 cursor-pointer"
                >
                  {isDone ? <CheckSquare className="w-4 h-4 text-emerald-400" /> : <Square className="w-4 h-4" />}
                </button>
                <span className={`leading-relaxed break-words ${isDone ? 'line-through text-slate-400' : 'text-slate-100'}`}>
                  {renderFormattedLine(item.text, `${keyPrefix}-clt-${idx}`, onAction)}
                </span>
              </div>
              {item.action && onAction && (
                <div className="shrink-0">
                  <ChatInteractiveButton
                    label="Uruchom"
                    action={item.action}
                    onAction={onAction}
                    disabled={isUnsafeChatInteractiveAction(item.action)}
                    compact
                    inGroup
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {onAction && (
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1.5 border-t border-slate-800/70">
          <button
            type="button"
            onClick={() =>
              setCheckedMap((prev) => {
                const allDone = prev.every(Boolean);
                return prev.map(() => !allDone);
              })
            }
            className="text-[11px] font-mono text-slate-400 hover:text-cyan-300 transition-colors cursor-pointer"
          >
            {doneCount === totalCount ? 'Odznacz wszystko' : 'Zaznacz wszystko'}
          </button>
          <button
            type="button"
            disabled={submitDisabled}
            onClick={handleBulkSubmit}
            className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/40 bg-cyan-500/20 hover:bg-cyan-500/30 disabled:opacity-40 disabled:cursor-not-allowed px-3 py-1.5 text-[11px] font-semibold text-cyan-100 transition-all cursor-pointer"
          >
            {submitted ? (
              <Check className="w-3.5 h-3.5 text-emerald-300" aria-hidden="true" />
            ) : (
              <Send className="w-3 h-3 text-cyan-300" aria-hidden="true" />
            )}
            <span>{submitted ? 'Wysłano ✓' : effectiveSubmitLabel}</span>
          </button>
        </div>
      )}
    </div>
  );
};

const InteractiveMarkdownChecklistGroup: React.FC<{
  items: Array<{ initialChecked: boolean; text: string }>;
  keyPrefix: string;
  onAction?: (actionValue: string, label?: string) => void | Promise<void>;
}> = ({ items, keyPrefix, onAction }) => {
  const [checkedMap, setCheckedMap] = useState<boolean[]>(() => items.map((i) => i.initialChecked));
  const [sent, setSent] = useState(false);
  const doneCount = checkedMap.filter(Boolean).length;
  const totalCount = items.length;
  const percent = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  const handleSendChecked = () => {
    if (!onAction || doneCount === 0) return;
    const selected = items.filter((_, idx) => checkedMap[idx]).map((i) => i.text);
    setSent(true);
    void onAction(`send:Wykonaj zaznaczone punkty: ${selected.join('; ')}`, 'Wykonaj zaznaczone');
    setTimeout(() => setSent(false), 2000);
  };

  return (
    <div
      className="my-2 rounded-xl border border-slate-700/75 bg-[#080F1D]/90 p-2.5 text-xs space-y-2"
      data-markdown-checklist="true"
    >
      {totalCount > 1 && (
        <div className="space-y-1 pb-1.5 border-b border-slate-800/80">
          <div className="flex items-center justify-between gap-2 text-[10px] font-mono text-slate-400">
            <span className="inline-flex items-center gap-1 text-cyan-300 font-semibold uppercase tracking-wider">
              <ListChecks className="w-3 h-3" aria-hidden="true" />
              <span>Lista zadań</span>
            </span>
            <span className="tabular-nums">
              {doneCount}/{totalCount} ({percent}%)
            </span>
          </div>
          <div className="h-1 w-full rounded-full bg-slate-800 overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-emerald-400 transition-all duration-300"
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      )}

      <div className="space-y-1">
        {items.map((item, idx) => {
          const checked = Boolean(checkedMap[idx]);
          return (
            <div
              key={`${keyPrefix}-mdchk-${idx}`}
              className={`flex items-start gap-2 rounded-lg px-1.5 py-1 transition-colors ${
                checked ? 'bg-emerald-950/15' : 'hover:bg-slate-800/35'
              }`}
            >
              <button
                type="button"
                role="checkbox"
                aria-checked={checked}
                onClick={() => setCheckedMap((prev) => prev.map((v, i) => (i === idx ? !v : v)))}
                className="mt-0.5 text-cyan-400 hover:text-cyan-300 transition-colors shrink-0 cursor-pointer"
                title={checked ? 'Odznacz punkt' : 'Zaznacz jako wykonane'}
              >
                {checked ? <CheckSquare className="w-4 h-4 text-emerald-400" /> : <Square className="w-4 h-4" />}
              </button>
              <div className={`flex-1 min-w-0 leading-relaxed ${checked ? 'line-through text-slate-400' : 'text-slate-100'}`}>
                {renderFormattedLine(item.text, `${keyPrefix}-mdchkt-${idx}`, onAction)}
              </div>
            </div>
          );
        })}
      </div>

      {onAction && (
        <div className="flex items-center justify-end pt-1 border-t border-slate-800/70">
          <button
            type="button"
            disabled={doneCount === 0}
            onClick={handleSendChecked}
            className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/35 bg-cyan-500/15 hover:bg-cyan-500/25 disabled:opacity-40 disabled:cursor-not-allowed px-2.5 py-1 text-[11px] font-medium text-cyan-100 transition-all cursor-pointer"
          >
            {sent ? <Check className="w-3 h-3 text-emerald-300" /> : <Send className="w-3 h-3 text-cyan-300" />}
            <span>{sent ? 'Wysłano do AI ✓' : `Wyślij zaznaczone (${doneCount})`}</span>
          </button>
        </div>
      )}
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
              className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
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
            className="rounded-lg bg-amber-500/90 hover:bg-amber-400 disabled:opacity-40 px-3 py-1.5 text-[11px] font-semibold text-slate-950 transition-colors cursor-pointer"
          >
            {confirm.confirmLabel}
          </button>
          <button
            type="button"
            onClick={() => setState('cancelled')}
            className="rounded-lg border border-slate-700 bg-slate-800/80 hover:bg-slate-700 px-3 py-1.5 text-[11px] font-medium text-slate-300 transition-colors cursor-pointer"
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
}> = ({ chips, onAction }) => {
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  return (
    <div className="my-2 flex flex-wrap items-center gap-1.5 text-xs">
      <span className="inline-flex items-center gap-1 text-[11px] font-mono text-slate-400 mr-1">
        <Sparkles className="w-3 h-3 text-cyan-400" aria-hidden="true" />
        <span>{chips.label}:</span>
      </span>
      {chips.options.map((opt, idx) => {
        const unsafe = isUnsafeChatInteractiveAction(opt.action);
        const picked = activeIdx === idx;
        return (
          <button
            key={`${opt.label}-${idx}`}
            type="button"
            disabled={unsafe}
            onClick={() => {
              if (!unsafe && onAction) {
                setActiveIdx(idx);
                void onAction(opt.action, opt.label);
                setTimeout(() => setActiveIdx((cur) => (cur === idx ? null : cur)), 1600);
              }
            }}
            className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-all duration-150 disabled:opacity-40 cursor-pointer ${
              picked
                ? 'border-emerald-400/60 bg-emerald-500/20 text-emerald-100'
                : 'border-cyan-500/35 bg-cyan-950/35 hover:bg-cyan-500/20 hover:border-cyan-300/60 text-cyan-100'
            }`}
          >
            {picked && <Check className="w-3 h-3 text-emerald-300" aria-hidden="true" />}
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
};

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

const BUTTON_ONLY_LINE_RE =
  /^(?:\[(?:btn|button|action|przycisk):[^\]\n]+\]\s*)+$/i;

function extractButtonsFromLine(
  line: string,
): Array<{ label: string; action: string }> | null {
  const trimmed = line.trim();
  if (!trimmed || !BUTTON_ONLY_LINE_RE.test(trimmed)) return null;
  const rawTokens = trimmed.match(/\[(?:btn|button|action|przycisk):[^\]\n]+\]/gi);
  if (!rawTokens || rawTokens.length === 0) return null;
  const parsed = rawTokens
    .map((raw) => parseChatInteractiveToken(raw))
    .filter((b): b is { label: string; action: string } => b !== null);
  return parsed.length === rawTokens.length ? parsed : null;
}

function renderInlineToken(
  raw: string,
  key: string,
  onAction?: (actionValue: string, label?: string) => void | Promise<void>,
): React.ReactNode {
  const button = parseChatInteractiveToken(raw);
  if (button) {
    return (
      <ChatInteractiveButton
        key={key}
        label={button.label}
        action={button.action}
        onAction={onAction}
        disabled={isUnsafeChatInteractiveAction(button.action)}
      />
    );
  }
  const highlight = parseHighlightToken(raw);
  if (highlight) {
    return <InteractiveHighlightSpan key={key} text={highlight.text} tone={highlight.tone} />;
  }
  const kbd = parseKbdToken(raw);
  if (kbd) {
    return <InteractiveKbdBadge key={key} keys={kbd.keys} />;
  }
  const checkbox = parseCheckboxToken(raw);
  if (checkbox) {
    return <InteractiveActionCheckbox key={key} checkbox={checkbox} onAction={onAction} />;
  }
  const badge = parseBadgeToken(raw);
  if (badge) {
    return (
      <span
        key={key}
        className={`inline-flex items-center rounded-full border px-2 py-0.5 mr-1 text-[10px] font-mono font-semibold uppercase tracking-wider align-middle ${TONE_BADGE[badge.tone]}`}
      >
        {badge.text}
      </span>
    );
  }
  const inlineKpi = parseKpiToken(raw);
  if (inlineKpi) {
    return <InteractiveKpiTile key={key} kpi={inlineKpi} />;
  }
  const card = parseCardToken(raw);
  if (card) {
    return (
      <span
        key={key}
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
  const progress = parseProgressToken(raw);
  if (progress) {
    return (
      <div
        key={key}
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
  return <React.Fragment key={key}>{raw}</React.Fragment>;
}

function renderInlineNodes(
  nodes: InlineMarkdownNode[],
  keyPrefix: string,
  onAction?: (actionValue: string, label?: string) => void | Promise<void>,
): React.ReactNode {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (node.type) {
      case 'text':
        return <React.Fragment key={key}>{node.text}</React.Fragment>;
      case 'token':
        return renderInlineToken(node.raw, key, onAction);
      case 'code':
        return (
          <code
            key={key}
            className="px-1.5 py-0.5 rounded bg-[#070A10] border border-cyan-500/25 font-mono text-[12px] text-cyan-200 break-words"
          >
            {node.code}
          </code>
        );
      case 'math':
        return <InteractiveMathInline key={key} tex={node.tex} />;
      case 'bold':
        return (
          <strong key={key} className="font-semibold text-white">
            {renderInlineNodes(node.children, `${key}-b`, onAction)}
          </strong>
        );
      case 'italic':
        return (
          <em key={key} className="italic text-slate-300">
            {renderInlineNodes(node.children, `${key}-i`, onAction)}
          </em>
        );
      case 'strike':
        return (
          <del key={key} className="text-slate-400">
            {renderInlineNodes(node.children, `${key}-s`, onAction)}
          </del>
        );
      case 'highlight':
        return <InteractiveHighlightSpan key={key} text={node.text} tone={node.tone} />;
      case 'kbd':
        return <InteractiveKbdBadge key={key} keys={node.keys} />;
      case 'sup':
        return (
          <sup key={key} className="text-[0.72em] leading-none text-cyan-200/90 align-super">
            {node.text}
          </sup>
        );
      case 'sub':
        return (
          <sub key={key} className="text-[0.72em] leading-none text-cyan-200/90 align-sub">
            {node.text}
          </sub>
        );
      case 'link':
        return (
          <a
            key={key}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-cyan-300 underline underline-offset-2 hover:text-cyan-200 break-all"
          >
            {node.label}
          </a>
        );
      default:
        return null;
    }
  });
}

export function renderFormattedLine(
  line: string,
  keyPrefix: string,
  onAction?: (actionValue: string, label?: string) => void | Promise<void>,
): React.ReactNode {
  const nodes = tokenizeInlineMarkdown(line);
  return renderInlineNodes(nodes, keyPrefix, onAction);
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

      // 1. Blok matematyczny LaTeX `$$...$$` (jednoliniowy lub wieloliniowy)
      if (trimmed.startsWith('$$')) {
        const blockStartIdx = idx;
        const singleLineMatch = trimmed.match(/^\$\$(.+?)\$\$$/);
        if (singleLineMatch && singleLineMatch[1].trim()) {
          renderedElements.push(
            <InteractiveMathBlock
              key={`math-blk-${segIdx}-${blockStartIdx}`}
              tex={singleLineMatch[1].trim()}
              onAction={onAction}
            />,
          );
          idx += 1;
          continue;
        }
        const mathLines: string[] = [];
        const afterOpen = trimmed.slice(2).trim();
        if (afterOpen) mathLines.push(afterOpen);
        idx += 1;
        while (idx < lines.length) {
          const curTrimmed = lines[idx].trim();
          if (curTrimmed.endsWith('$$')) {
            const beforeClose = curTrimmed.slice(0, -2).trim();
            if (beforeClose) mathLines.push(beforeClose);
            idx += 1;
            break;
          }
          mathLines.push(lines[idx]);
          idx += 1;
        }
        const texBody = mathLines.join('\n').trim();
        if (texBody) {
          renderedElements.push(
            <InteractiveMathBlock
              key={`math-blk-${segIdx}-${blockStartIdx}`}
              tex={texBody}
              onAction={onAction}
            />,
          );
        }
        continue;
      }

      // 2. Blok matematyczny LaTeX `\[...\]` (jednoliniowy lub wieloliniowy)
      if (trimmed.startsWith('\\[')) {
        const blockStartIdx = idx;
        const singleBracketMatch = trimmed.match(/^\\\[(.+?)\\\]$/);
        if (singleBracketMatch && singleBracketMatch[1].trim()) {
          renderedElements.push(
            <InteractiveMathBlock
              key={`math-brk-${segIdx}-${blockStartIdx}`}
              tex={singleBracketMatch[1].trim()}
              onAction={onAction}
            />,
          );
          idx += 1;
          continue;
        }
        const mathLines: string[] = [];
        const afterOpen = trimmed.slice(2).trim();
        if (afterOpen) mathLines.push(afterOpen);
        idx += 1;
        while (idx < lines.length) {
          const curTrimmed = lines[idx].trim();
          if (curTrimmed.endsWith('\\]')) {
            const beforeClose = curTrimmed.slice(0, -2).trim();
            if (beforeClose) mathLines.push(beforeClose);
            idx += 1;
            break;
          }
          mathLines.push(lines[idx]);
          idx += 1;
        }
        const texBody = mathLines.join('\n').trim();
        if (texBody) {
          renderedElements.push(
            <InteractiveMathBlock
              key={`math-brk-${segIdx}-${blockStartIdx}`}
              tex={texBody}
              onAction={onAction}
            />,
          );
        }
        continue;
      }

      // 3. Detect collapsible details block: `[details: Title] ... [/details]`
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

      // 4. Detect Markdown Table block (both outer-piped `| A | B |` and standard `A | B`)
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

      // 5. Interactive Copilot/Work blocks
      const actionCardToken = parseActionCardToken(trimmed);
      if (actionCardToken) {
        renderedElements.push(
          <InteractiveActionCard
            key={`acard-${segIdx}-${idx}`}
            card={actionCardToken}
            keyPrefix={`acard-${segIdx}-${idx}`}
            onAction={onAction}
          />,
        );
        idx += 1;
        continue;
      }

      const checkboxBlockToken = parseCheckboxToken(trimmed);
      if (checkboxBlockToken) {
        renderedElements.push(
          <InteractiveActionCheckbox
            key={`chkbox-${segIdx}-${idx}`}
            checkbox={checkboxBlockToken}
            onAction={onAction}
            block
          />,
        );
        idx += 1;
        continue;
      }

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

      // 6. Grupowany pasek przycisków akcji (Copilot / ChatGPT Work action bar)
      const lineButtons = extractButtonsFromLine(trimmed);
      if (lineButtons) {
        const barStartIdx = idx;
        const groupedButtons = [...lineButtons];
        idx += 1;
        while (idx < lines.length) {
          const nextBtns = extractButtonsFromLine(lines[idx]);
          if (!nextBtns) break;
          groupedButtons.push(...nextBtns);
          idx += 1;
        }
        renderedElements.push(
          <div
            key={`btn-bar-${segIdx}-${barStartIdx}`}
            data-chat-action-bar="true"
            className="my-2 flex flex-wrap items-center gap-2"
          >
            {groupedButtons.map((btn, bIdx) => (
              <ChatInteractiveButton
                key={`btn-bar-${segIdx}-${barStartIdx}-${bIdx}`}
                label={btn.label}
                action={btn.action}
                onAction={onAction}
                disabled={isUnsafeChatInteractiveAction(btn.action)}
                inGroup
              />
            ))}
          </div>,
        );
        continue;
      }

      // 7. Interactive Markdown Checklist (`- [ ] ...` / `- [x] ...`) — grupowane z paskiem postępu i akcją wysyłki
      const checklistMatch = trimmed.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/);
      if (checklistMatch) {
        const groupStartIdx = idx;
        const mdItems: Array<{ initialChecked: boolean; text: string }> = [
          {
            initialChecked: checklistMatch[1].toLowerCase() === 'x',
            text: checklistMatch[2],
          },
        ];
        idx += 1;
        while (idx < lines.length) {
          const nextMatch = lines[idx].trim().match(/^[-*]\s+\[([ xX])\]\s+(.*)$/);
          if (!nextMatch) break;
          mdItems.push({
            initialChecked: nextMatch[1].toLowerCase() === 'x',
            text: nextMatch[2],
          });
          idx += 1;
        }
        renderedElements.push(
          <InteractiveMarkdownChecklistGroup
            key={`chk-grp-${segIdx}-${groupStartIdx}`}
            items={mdItems}
            keyPrefix={`chk-${segIdx}-${groupStartIdx}`}
            onAction={onAction}
          />,
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
        <div key={`p-${idx}`} className="svl-chat-prose leading-relaxed">
          {renderFormattedLine(line, `l-${idx}`, onAction)}
        </div>,
      );
      idx += 1;
    }

    return <React.Fragment key={`text-seg-${segIdx}`}>{renderedElements}</React.Fragment>;
  });
}
