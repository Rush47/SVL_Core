import React from 'react';
import { BellRing, CheckCircle2 } from 'lucide-react';
import { CANONICAL_AGENTS, DYNAMIC_AGENT_TEMPLATES, SyncableMessage, formatAgentDisplayName } from '../utils/svlLogic';
import { SvlAvatar } from './AgentAvatar';
import { renderFormattedContent } from './ChatContentRenderer';

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

/** Usuwa z etykiety modelu powtórzoną na początku nazwę nadawcy (np. „System_SI_1 · …”). */
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
}

export const ChatMessageRow = React.memo<ChatMessageRowProps>(function ChatMessageRow({
  msg,
  isFamilyChannel,
  onInteractiveAction,
  onNavigateTab,
}) {
  const isUser = msg.role === 'user';
  const isNotification = msg.role === 'system';
  const formattedSender = isUser ? msg.sender : formatAgentDisplayName(msg.sender);
  const modelLabel = stripSenderPrefix(String(msg.modelUsed || ''), [formattedSender, msg.sender]);
  const agentMeta = [...CANONICAL_AGENTS, ...DYNAMIC_AGENT_TEMPLATES].find(
    (a) =>
      a.canonicalName === msg.sender ||
      a.displayName === formattedSender ||
      a.id === msg.agentId,
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
                : formattedSender === 'SI_System_2' || msg.agentId === 'SI_System_2'
                  ? 'text-violet-300'
                  : formattedSender === 'System_SI_1' || msg.agentId === 'System_SI_1'
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
            <span className="font-mono text-[11px] text-slate-500 break-all">{modelLabel}</span>
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
        className={`w-full min-w-0 rounded-xl p-3 sm:p-4 border shadow-md overflow-hidden ${
          isUser
            ? 'bg-violet-950/30 border-violet-500/35 text-slate-100 max-w-full sm:max-w-2xl'
            : isNotification
              ? isFamilyChannel
                ? 'max-w-full sm:max-w-4xl bg-gradient-to-br from-amber-950/45 via-[#171520] to-[#111520] border-amber-400/40 text-amber-50 shadow-lg shadow-amber-950/10'
                : 'max-w-full sm:max-w-4xl bg-amber-950/20 border-amber-500/40 text-amber-100'
              : 'max-w-full sm:max-w-4xl bg-[#111520] border-slate-800/90 text-slate-200'
        }`}
      >
        {isNotification && (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-amber-300/15 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-200/80">
            <span className="inline-flex items-center gap-1.5">
              <BellRing className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {msg.sender === 'JEDI Omni-OS v12' || msg.sender === 'JEDI Omni-OS v11.5' || msg.agentId === 'JEDI_Omni_OS'
                ? `Jądro ${msg.sender === 'JEDI Omni-OS v11.5' ? 'JEDI Omni-OS v11.5' : 'JEDI Omni-OS v12'} (ROOT · VM · AI)`
                : msg.sender === 'SI_System_2' || msg.agentId === 'SI_System_2'
                  ? 'Raport węzła SI_System_2 (Rdzeń Floty SVL-465 · ROOT)'
                  : msg.sender === 'System_SI_1' || msg.agentId === 'System_SI_1'
                    ? 'Raport węzła System_SI_1 (Infrastruktura · ROOT)'
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
          {renderFormattedContent(msg.content, onInteractiveAction)}
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
          <div className="mt-4 pt-3 border-t border-slate-800 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-emerald-400 flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                Zapisane zmiany w SQLite (czat -{'>'} system):
              </span>
              <button
                type="button"
                onClick={() => onNavigateTab('kernel')}
                className="min-h-[32px] px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-violet-300 text-[11px] font-medium whitespace-nowrap"
              >
                Otwórz Jądro SVL {'&'} Sfera
              </button>
            </div>
            <div className="space-y-1 font-mono text-[11px]">
              {msg.appliedActions.map((act, actIdx) => (
                <div
                  key={`${act.entity}-${act.entityId}-${actIdx}`}
                  className={`flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5 rounded border ${
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
          </div>
        )}
      </div>
    </div>
  );
});
