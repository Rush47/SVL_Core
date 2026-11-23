import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  Bot,
  Check,
  ChevronRight,
  Copy,
  Cpu,
  FileText,
  Image as ImageIcon,
  Loader2,
  PenLine,
  Radio,
  RefreshCw,
  Rocket,
  Send,
  Server,
  ShieldCheck,
  Sparkles,
  Terminal,
  Users,
  Zap,
} from 'lucide-react';

export type ChatButtonActionKind = 'send' | 'action' | 'tab' | 'ask' | 'copy' | 'text' | 'unsafe';

export interface ChatInteractiveButtonProps {
  label: string;
  action: string;
  onAction?: (actionValue: string, label?: string) => void | Promise<void>;
  disabled?: boolean;
  compact?: boolean;
  inGroup?: boolean;
}

export function resolveChatButtonKind(action: string, disabled = false): ChatButtonActionKind {
  if (disabled) return 'unsafe';
  const norm = action.trim().toLowerCase();
  if (/^(?:tab|nav|open|goto):/.test(norm)) return 'tab';
  if (norm.startsWith('copy:')) return 'copy';
  if (norm.startsWith('text:')) return 'text';
  if (norm.startsWith('ask:')) return 'ask';
  if (norm.startsWith('action:') || norm === 'sync') return 'action';
  return 'send';
}

const KIND_STYLES: Record<
  ChatButtonActionKind,
  {
    surface: string;
    iconWrap: string;
    doneLabel: string;
    trailing?: 'external' | 'chevron';
  }
> = {
  send: {
    surface:
      'border-cyan-400/35 bg-gradient-to-b from-cyan-500/18 via-sky-500/10 to-cyan-950/35 text-cyan-50 shadow-[0_1px_12px_-4px_rgba(34,211,238,0.45)] hover:border-cyan-300/70 hover:from-cyan-400/28 hover:to-sky-500/20 hover:text-white',
    iconWrap: 'text-cyan-300 group-hover:text-cyan-200',
    doneLabel: 'Wysłano',
    trailing: 'chevron',
  },
  action: {
    surface:
      'border-emerald-400/35 bg-gradient-to-b from-emerald-500/16 via-teal-500/10 to-emerald-950/35 text-emerald-50 shadow-[0_1px_12px_-4px_rgba(16,185,129,0.4)] hover:border-emerald-300/70 hover:from-emerald-400/26 hover:to-teal-500/20 hover:text-white',
    iconWrap: 'text-emerald-300 group-hover:text-emerald-200',
    doneLabel: 'Wykonano',
  },
  tab: {
    surface:
      'border-violet-400/35 bg-gradient-to-b from-violet-500/16 via-purple-500/10 to-violet-950/35 text-violet-100 shadow-[0_1px_12px_-4px_rgba(167,139,250,0.38)] hover:border-violet-300/70 hover:from-violet-400/26 hover:to-purple-500/20 hover:text-white',
    iconWrap: 'text-violet-300 group-hover:text-violet-200',
    doneLabel: 'Otwarto',
    trailing: 'external',
  },
  ask: {
    surface:
      'border-sky-400/35 bg-gradient-to-b from-sky-500/16 via-indigo-500/10 to-slate-900/50 text-sky-100 shadow-[0_1px_12px_-4px_rgba(56,189,248,0.38)] hover:border-sky-300/70 hover:from-sky-400/26 hover:to-indigo-500/20 hover:text-white',
    iconWrap: 'text-sky-300 group-hover:text-sky-200',
    doneLabel: 'Zapytano',
    trailing: 'chevron',
  },
  copy: {
    surface:
      'border-slate-600/75 bg-gradient-to-b from-slate-800/85 to-slate-900/90 text-slate-100 hover:border-slate-400/70 hover:from-slate-700/85 hover:to-slate-800/95 hover:text-white',
    iconWrap: 'text-slate-300 group-hover:text-white',
    doneLabel: 'Skopiowano',
  },
  text: {
    surface:
      'border-amber-400/35 bg-gradient-to-b from-amber-500/16 via-amber-500/8 to-amber-950/30 text-amber-100 shadow-[0_1px_12px_-4px_rgba(251,191,36,0.3)] hover:border-amber-300/70 hover:from-amber-400/25 hover:to-amber-500/18 hover:text-white',
    iconWrap: 'text-amber-300 group-hover:text-amber-200',
    doneLabel: 'Wstawiono',
  },
  unsafe: {
    surface:
      'border-rose-500/30 bg-rose-950/20 text-rose-300/70 cursor-not-allowed opacity-65',
    iconWrap: 'text-rose-400/80',
    doneLabel: 'Zablokowano',
  },
};

export const ChatInteractiveButton: React.FC<ChatInteractiveButtonProps> = ({
  label,
  action,
  onAction,
  disabled = false,
  compact = false,
  inGroup = false,
}) => {
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const resetTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (resetTimerRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  const kind = resolveChatButtonKind(action, disabled);
  const styleCfg = KIND_STYLES[kind];
  const normalizedAction = action.trim().toLowerCase();
  const iconCls = compact ? 'w-3 h-3 shrink-0' : 'w-3.5 h-3.5 shrink-0';

  const baseIcon = disabled
    ? <AlertTriangle className={iconCls} aria-hidden="true" />
    : normalizedAction.startsWith('tab:apex') || normalizedAction.startsWith('nav:apex')
      ? <Zap className={iconCls} aria-hidden="true" />
      : normalizedAction.startsWith('tab:svl364') || normalizedAction.startsWith('nav:svl364')
        ? <Rocket className={iconCls} aria-hidden="true" />
        : normalizedAction.startsWith('tab:infrastructure') || normalizedAction.startsWith('nav:infrastructure')
          ? <Server className={iconCls} aria-hidden="true" />
          : normalizedAction.startsWith('tab:terminals') || normalizedAction.startsWith('nav:terminals')
            ? <Terminal className={iconCls} aria-hidden="true" />
            : normalizedAction.startsWith('tab:agents') || normalizedAction.startsWith('nav:agents')
              ? <Users className={iconCls} aria-hidden="true" />
              : normalizedAction.startsWith('tab:kernel') || normalizedAction.startsWith('nav:kernel')
                ? <Cpu className={iconCls} aria-hidden="true" />
                : normalizedAction.startsWith('tab:linux') || normalizedAction.startsWith('nav:linux')
                  ? <Terminal className={iconCls} aria-hidden="true" />
                  : normalizedAction.startsWith('copy:')
                    ? <Copy className={iconCls} aria-hidden="true" />
                    : normalizedAction.startsWith('text:')
                      ? <PenLine className={iconCls} aria-hidden="true" />
                      : normalizedAction === 'action:sync' || normalizedAction === 'sync'
                        ? <RefreshCw className={iconCls} aria-hidden="true" />
                        : normalizedAction === 'action:scan' || normalizedAction === 'action:antivirus'
                          ? <ShieldCheck className={iconCls} aria-hidden="true" />
                          : normalizedAction === 'action:report'
                            ? <FileText className={iconCls} aria-hidden="true" />
                            : normalizedAction.startsWith('action:image') || normalizedAction === 'action:vision'
                              ? <ImageIcon className={iconCls} aria-hidden="true" />
                              : normalizedAction === 'action:duplex'
                                ? <Radio className={iconCls} aria-hidden="true" />
                                : normalizedAction.startsWith('action:')
                                  ? <Sparkles className={iconCls} aria-hidden="true" />
                                  : normalizedAction.startsWith('ask:')
                                    ? <Bot className={iconCls} aria-hidden="true" />
                                    : <Send className={iconCls} aria-hidden="true" />;

  const icon = phase === 'running'
    ? <Loader2 className={`${iconCls} animate-spin`} aria-hidden="true" />
    : phase === 'done'
      ? <Check className={`${iconCls} text-emerald-300`} aria-hidden="true" />
      : baseIcon;

  const handleClick = async () => {
    if (disabled || phase === 'running' || !onAction) return;
    setPhase('running');
    try {
      await onAction(action, label);
      if (!mountedRef.current) return;
      setPhase('done');
      if (typeof window !== 'undefined') {
        if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
        resetTimerRef.current = window.setTimeout(() => {
          if (mountedRef.current) setPhase('idle');
        }, 1800);
      }
    } catch {
      if (mountedRef.current) setPhase('idle');
    }
  };

  const isDisabled = disabled || phase === 'running';
  const surfaceClass =
    phase === 'done'
      ? 'border-emerald-400/65 bg-emerald-500/20 text-emerald-100 shadow-[0_0_16px_-4px_rgba(16,185,129,0.55)]'
      : styleCfg.surface;

  const sizeClass = compact
    ? 'min-h-[26px] px-2.5 py-1 text-[11px] rounded-lg gap-1.5'
    : 'min-h-[32px] px-3 py-1.5 text-xs rounded-xl gap-2';

  const spacingClass = inGroup ? '' : 'my-1 mr-2 align-middle';

  return (
    <button
      type="button"
      role="button"
      data-action-kind={kind}
      data-state={phase}
      aria-disabled={isDisabled ? 'true' : 'false'}
      disabled={isDisabled}
      onClick={() => void handleClick()}
      title={disabled ? 'Przyciski czatu nie mogą uruchamiać poleceń powłoki.' : `Akcja: ${action}`}
      className={`group inline-flex items-center font-medium tracking-[0.01em] border backdrop-blur-sm transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 ${
        isDisabled ? '' : 'cursor-pointer hover:-translate-y-[0.5px] active:translate-y-0 active:scale-[0.97]'
      } ${sizeClass} ${surfaceClass} ${spacingClass}`.trim()}
    >
      <span className={`inline-flex items-center justify-center ${phase === 'done' ? 'text-emerald-300' : styleCfg.iconWrap}`}>
        {icon}
      </span>
      <span className="truncate max-w-[280px] sm:max-w-[340px]">
        {phase === 'done' ? `${label} · ${styleCfg.doneLabel}` : label}
      </span>
      {!compact && phase === 'idle' && styleCfg.trailing === 'external' && (
        <ArrowUpRight className="w-3 h-3 opacity-60 group-hover:opacity-100 group-hover:translate-x-[1px] group-hover:-translate-y-[1px] transition-transform shrink-0" aria-hidden="true" />
      )}
      {!compact && phase === 'idle' && styleCfg.trailing === 'chevron' && (
        <ChevronRight className="w-3 h-3 opacity-55 group-hover:opacity-100 group-hover:translate-x-0.5 transition-transform shrink-0" aria-hidden="true" />
      )}
    </button>
  );
};
