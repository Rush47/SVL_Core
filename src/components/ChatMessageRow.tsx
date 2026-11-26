import React, { useMemo, useState } from 'react';
import {
  BellRing,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  RefreshCw,
  ThumbsUp,
  ThumbsDown,
  Layers,
  Sparkles,
  ArrowRight,
  Code2
} from 'lucide-react';
import { CANONICAL_AGENTS, DYNAMIC_AGENT_TEMPLATES, SyncableMessage, formatAgentDisplayName } from '../utils/svlLogic';
import { SvlAvatar } from './AgentAvatar';
import { renderFormattedContent } from './OpenAIChatRenderer';
import { Button } from '@openai/apps-sdk-ui/components/Button';

export const PROVENANCE_STYLE: Record<
  NonNullable<SyncableMessage['provenance']>,
  { label: string; hint: string; icon: string; className: string }
> = {
  model_unverified: {
    label: 'Wiedza modelu — niezweryfikowana',
    hint: 'Treść wygenerował model językowy z własnej wiedzy; może zawierać błędy. Sprawdź ważne informacje.',
    icon: '⚠️',
    className: 'border-amber-500/30 bg-amber-950/20 text-amber-200',
  },
  web_sources: {
    label: 'Ze źródłami z internetu',
    hint: 'Model korzystał z wyszukiwarki; źródła są podane pod odpowiedzią. Zweryfikuj je przed użyciem.',
    icon: '🔗',
    className: 'border-cyan-500/30 bg-cyan-950/20 text-cyan-200',
  },
  server_verified: {
    label: 'Wynik serwera',
    hint: 'Treść pochodzi z danych systemu lub wykonanego polecenia, nie z modelu językowego.',
    icon: '✅',
    className: 'border-emerald-500/30 bg-emerald-950/20 text-emerald-200',
  },
  error: {
    label: 'Brak odpowiedzi modelu',
    hint: 'Żaden model nie odpowiedział — powód podano w treści.',
    icon: '❌',
    className: 'border-rose-500/30 bg-rose-950/20 text-rose-200',
  },
};

/** Usuwa z etykiety modelu powtórzoną na początku nazwę nadawcy (np. „Jyn · …”). */
function stripSenderPrefix(label: string, names: Array<string | undefined>): string {
  let out = label.trim();
  for (const name of names) {
    const n = String(name || '').trim();
    if (n && out.toLowerCase().startsWith(`${n.toLowerCase()} · `)) out = out.slice(n.length + 3).trim();
  }
  return out;
}

interface ChatMessageRowProps {
  msg: SyncableMessage;
  isFamilyChannel: boolean;
  onInteractiveAction: (actionValue: string, label?: string) => void | Promise<void>;
  onNavigateTab: (tab: 'agents' | 'kernel') => void;
  onOpenCanvas?: (code?: string) => void;
}

export const ChatMessageRow = React.memo<ChatMessageRowProps>(function ChatMessageRow({
  msg,
  isFamilyChannel,
  onInteractiveAction,
  onNavigateTab,
  onOpenCanvas,
}) {
  const [actionsExpanded, setActionsExpanded] = useState(true);
  const [copiedMsg, setCopiedMsg] = useState(false);
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null);
  const isUser = msg.role === 'user';
  const isNotification = msg.role === 'system';
  const formattedSender = isUser ? msg.sender : formatAgentDisplayName(msg.sender);
  const modelLabel = stripSenderPrefix(String(msg.modelUsed || ''), [formattedSender, msg.sender]);
  const agentMeta = useMemo(
    () =>
      [...CANONICAL_AGENTS, ...DYNAMIC_AGENT_TEMPLATES].find(
        (a) =>
          a.canonicalName === msg.sender ||
          a.displayName === formattedSender ||
          a.id === msg.agentId,
      ),
    [formattedSender, msg.agentId, msg.sender],
  );
  const formattedContentNode = useMemo(
    () => renderFormattedContent(msg.content, isUser ? undefined : onInteractiveAction),
    [msg.content, onInteractiveAction, isUser],
  );

  return (
    <div className={`svl-msg-row flex flex-col min-w-0 max-w-full ${isUser ? 'items-end' : 'items-start'}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400 mb-1.5 px-1 max-w-full">
        <SvlAvatar
          sender={formattedSender}
          agentId={isUser ? 'operator' : msg.agentId || agentMeta?.id}
          size={26}
        />
        <span
          className={`font-semibold truncate max-w-[200px] sm:max-w-none ${
            agentMeta
              ? agentMeta.textClass
              : formattedSender === 'JEDI Omni-OS v12' || formattedSender === 'JEDI Omni-OS v11.5' || msg.agentId === 'JEDI_Omni_OS'
                ? 'text-emerald-300'
                : formattedSender === 'SI_Sphere' || msg.agentId === 'SI_Sphere'
                  ? 'text-violet-300'
                  : formattedSender === 'Jyn' || msg.agentId === 'Jyn'
                    ? 'text-cyan-300'
                    : isUser
                      ? 'text-violet-300'
                      : 'text-slate-200'
          }`}
        >
          {formattedSender}
        </span>
        {modelLabel && (
          <>
            <span aria-hidden="true">·</span>
            <span
              className={`font-mono text-[10px] px-1.5 py-0.5 rounded border break-all ${
                /ollama\s*\[.*svl-364/i.test(modelLabel)
                  ? 'border-violet-500/40 bg-violet-950/35 text-violet-200'
                  : /ollama/i.test(modelLabel)
                    ? 'border-cyan-500/35 bg-cyan-950/30 text-cyan-200'
                    : /fallback/i.test(modelLabel)
                      ? 'border-orange-500/45 bg-orange-950/35 text-orange-200'
                      : /gemini/i.test(modelLabel)
                        ? 'border-amber-500/35 bg-amber-950/25 text-amber-200'
                        : 'border-slate-700/60 bg-slate-900/50 text-slate-400'
              }`}
            >
              {modelLabel}
            </span>
          </>
        )}
        <span aria-hidden="true">·</span>
        <span className="font-mono tabular-nums text-slate-500">
          {/^\d{4}-\d{2}-\d{2}T/.test(String(msg.timestamp || ''))
            ? new Date(msg.timestamp).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })
            : msg.timestamp}
        </span>
        {msg.sourceOrigin && (
          <span
            className="hidden sm:inline max-w-[120px] truncate font-mono text-slate-500/80"
            title="Źródło zgłoszone przez klienta aplikacji. Identyfikator nie potwierdza tożsamości autora."
          >
            sesja: {msg.sourceOrigin.slice(0, 16)}
          </span>
        )}
      </div>

      <div
        className={`w-full min-w-0 rounded-2xl p-2.5 sm:p-4 border shadow-md overflow-hidden transition-colors ${
          isUser
            ? 'bg-gradient-to-br from-violet-950/45 to-[#131026]/90 border-violet-500/40 text-slate-100 max-w-full sm:max-w-2xl shadow-violet-950/20'
            : isNotification
              ? isFamilyChannel
                ? 'max-w-full sm:max-w-4xl bg-gradient-to-br from-amber-950/45 via-[#171520]/95 to-[#111520]/95 border-amber-400/40 text-amber-50 shadow-lg shadow-amber-950/15'
                : 'max-w-full sm:max-w-4xl bg-amber-950/25 border-amber-500/40 text-amber-100'
              : 'max-w-full sm:max-w-4xl bg-gradient-to-br from-[#111829]/95 to-[#0B101D]/95 border-slate-700/75 text-slate-200 shadow-black/30'
        }`}
      >
        {isNotification && (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-amber-300/15 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-200/80">
            <span className="inline-flex items-center gap-1.5">
              <BellRing className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {msg.sender === 'JEDI Omni-OS v12' || msg.sender === 'JEDI Omni-OS v11.5' || msg.agentId === 'JEDI_Omni_OS'
                ? `Jądro ${msg.sender === 'JEDI Omni-OS v11.5' ? 'JEDI Omni-OS v11.5' : 'JEDI Omni-OS v12'} (ROOT · VM · AI)`
                : msg.sender === 'SI_Sphere' || msg.agentId === 'SI_Sphere'
                  ? 'Raport węzła SI_Sphere (Rdzeń Floty SVL-465 · ROOT)'
                  : msg.sender === 'Jyn' || msg.agentId === 'Jyn'
                    ? 'Raport węzła Jyn Mitek (Infrastruktura · ROOT)'
                    : isFamilyChannel
                      ? 'Powiadomienie · kanał grupowy'
                      : 'Wiadomość systemowa'}
            </span>
            {isFamilyChannel && (
              <span className="rounded-full border border-amber-200/20 bg-amber-200/5 px-2 py-0.5 text-[9px]">
                Wszyscy
              </span>
            )}
          </div>
        )}
        {msg.imagePreview && (
          <div className="mb-3">
            <img
              src={msg.imagePreview}
              alt={msg.fileName || 'Załączony obraz Vision'}
              referrerPolicy="no-referrer"
              loading="lazy"
              className="max-h-64 max-w-full rounded-lg border border-slate-700 object-contain"
            />
          </div>
        )}

        <div className="text-xs sm:text-sm break-words min-w-0 max-w-full space-y-1">
          {formattedContentNode}
        </div>

        {msg.connectionReport && (
          <div className="mt-4 pt-4 border-t border-slate-800 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-emerald-400 flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                Raport środowiska SVL_System
              </span>
              <button
                type="button"
                onClick={() => onNavigateTab('agents')}
                className="min-h-[34px] px-3 py-1 bg-violet-600 hover:bg-violet-500 text-white rounded text-xs font-medium transition-colors whitespace-nowrap"
              >
                Przejdź do Panelu Agentów
              </button>
            </div>
          </div>
        )}

        {msg.role === 'assistant' && msg.provenance && (
          <div
            className={`mt-3 flex items-start gap-1.5 rounded-md border px-2 py-1 text-[11px] ${
              PROVENANCE_STYLE[msg.provenance].className
            }`}
            title={PROVENANCE_STYLE[msg.provenance].hint}
          >
            <span aria-hidden="true">{PROVENANCE_STYLE[msg.provenance].icon}</span>
            <span className="min-w-0 break-words">
              <strong>{PROVENANCE_STYLE[msg.provenance].label}</strong>
              {msg.verificationNote ? ` — ${msg.verificationNote}` : ` — ${PROVENANCE_STYLE[msg.provenance].hint}`}
            </span>
          </div>
        )}

        {Array.isArray(msg.appliedActions) && msg.appliedActions.length > 0 && (
          <div className="mt-4 pt-3 border-t border-slate-800/80 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setActionsExpanded((v) => !v)}
                className="text-xs font-semibold text-emerald-400 hover:text-emerald-300 flex items-center gap-1.5 transition-colors"
              >
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                <span>Wykonane kroki i akcje ({msg.appliedActions.length})</span>
                <ChevronDown
                  className={`w-3.5 h-3.5 transition-transform ${actionsExpanded ? 'rotate-180' : ''}`}
                  aria-hidden="true"
                />
              </button>
              <button
                type="button"
                onClick={() => onNavigateTab('kernel')}
                className="min-h-[30px] px-2.5 py-1 rounded-md bg-slate-800/90 hover:bg-slate-700 text-violet-300 text-[11px] font-medium whitespace-nowrap transition-colors"
              >
                Otwórz Jądro SVL {'&'} Sfera
              </button>
            </div>
            {actionsExpanded && (
              <div className="space-y-1 font-mono text-[11px]">
                {msg.appliedActions.map((act, actIdx) => (
                  <div
                    key={`${act.entity}-${act.entityId}-${actIdx}`}
                    className={`flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg border ${
                      act.ok
                        ? 'bg-emerald-950/20 border-emerald-500/30 text-emerald-200'
                        : 'bg-rose-950/20 border-rose-500/30 text-rose-200'
                    }`}
                  >
                    <span className="font-semibold text-violet-300 break-all">
                      {act.entity}:{act.entityId}
                    </span>
                    <span className="flex-1 min-w-[120px] text-slate-300 truncate">{act.summary}</span>
                    <span className="tabular-nums text-slate-400 shrink-0">
                      {act.revision ? `rev ${act.revision} · ` : ''}
                      {act.ok ? 'OK' : 'ERR'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {msg.role === 'assistant' && !isNotification && (
          <div className="mt-3 pt-2 border-t border-slate-800/60 flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
              <button
                type="button"
                onClick={() => {
                  try {
                    void navigator.clipboard.writeText(msg.content || '');
                  } catch {
                    // ignore
                  }
                  setCopiedMsg(true);
                  setTimeout(() => setCopiedMsg(false), 1800);
                }}
                className="inline-flex items-center gap-1 rounded-md border border-slate-800 bg-[#0A0F1C] hover:border-slate-700 hover:text-slate-200 px-2 py-1 transition-colors"
                title="Kopiuj całą odpowiedź"
              >
                {copiedMsg ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                <span>{copiedMsg ? 'Skopiowano' : 'Kopiuj'}</span>
              </button>

              {onOpenCanvas && (
                <button
                  type="button"
                  onClick={() => {
                    const match = (msg.content || '').match(/```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)```/);
                    onOpenCanvas(match ? match[1].trim() : msg.content);
                  }}
                  className="inline-flex items-center gap-1 rounded-md border border-cyan-500/30 bg-cyan-950/20 hover:border-cyan-500/60 text-cyan-300 px-2 py-1 transition-colors shadow-xs"
                  title="Otwórz w bocznym panelu Canvas Workspace"
                >
                  <Layers className="w-3 h-3" />
                  <span>Canvas</span>
                </button>
              )}

              <div className="inline-flex items-center rounded-md border border-slate-800 bg-[#0A0F1C] p-0.5">
                <button
                  type="button"
                  onClick={() => setFeedback(feedback === 'up' ? null : 'up')}
                  className={`p-1 rounded transition-colors ${
                    feedback === 'up'
                      ? 'text-emerald-400 bg-emerald-950/40'
                      : 'hover:text-slate-200 hover:bg-slate-800'
                  }`}
                  title="Dobra odpowiedź"
                >
                  <ThumbsUp className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  onClick={() => setFeedback(feedback === 'down' ? null : 'down')}
                  className={`p-1 rounded transition-colors ${
                    feedback === 'down'
                      ? 'text-rose-400 bg-rose-950/40'
                      : 'hover:text-slate-200 hover:bg-slate-800'
                  }`}
                  title="Odpowiedź wymaga poprawy"
                >
                  <ThumbsDown className="w-3 h-3" />
                </button>
              </div>

              <button
                type="button"
                onClick={() => void onInteractiveAction('action:sync', 'Synchronizacja globalna')}
                className="inline-flex items-center gap-1 rounded-md border border-slate-800 bg-[#0A0F1C] hover:border-cyan-500/40 hover:text-cyan-200 px-2 py-1 transition-colors"
              >
                <RefreshCw className="w-3 h-3" aria-hidden="true" />
                <span>Synchronizuj</span>
              </button>

              <button
                type="button"
                onClick={() => void onInteractiveAction('send:/status', 'Status systemu')}
                className="inline-flex items-center gap-1 rounded-md border border-slate-800 bg-[#0A0F1C] hover:border-violet-500/40 hover:text-violet-200 px-2 py-1 transition-colors"
              >
                <span>Status</span>
              </button>
            </div>


          </div>
        )}
      </div>
    </div>
  );
});
