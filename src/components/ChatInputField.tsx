import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { computeComposerTextareaHeight, shouldSubmitChatShortcut } from '../utils/chatViewport';

/**
 * Wielowierszowe, automatycznie skalowane pole wpisywania wiadomości z własnym stanem.
 *
 * Tekst żyje tylko tutaj, więc pisanie nie przerysowuje całego czatu (listy wiadomości z Markdownem).
 * Rodzic dostaje informację wyłącznie o zmianie „puste ↔ niepuste” i czyta tekst przez uchwyt
 * (`getValue`) dopiero przy wysyłaniu. Enter wysyła wiadomość, a Shift+Enter dodaje nową linię.
 */
export interface ChatInputHandle {
  getValue: () => string;
  setValue: (value: string) => void;
  focus: () => void;
}

interface ChatInputFieldProps {
  placeholder: string;
  compactPlaceholder?: string;
  ariaLabel: string;
  className?: string;
  onEmptyChange: (isEmpty: boolean) => void;
}

export const ChatInputField = React.memo(
  forwardRef<ChatInputHandle, ChatInputFieldProps>(function ChatInputField(
    { placeholder, compactPlaceholder, ariaLabel, className, onEmptyChange },
    ref,
  ) {
    const [value, setValueState] = useState('');
    const [isCompactViewport, setIsCompactViewport] = useState(() =>
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(max-width: 639px)').matches
        : false,
    );
    const valueRef = useRef('');
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const wasEmptyRef = useRef(true);

    useEffect(() => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
      const mq = window.matchMedia('(max-width: 639px)');
      const update = () => setIsCompactViewport(mq.matches);
      update();
      mq.addEventListener('change', update);
      return () => mq.removeEventListener('change', update);
    }, []);

    const resizeTextarea = useCallback(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.style.height = 'auto';
      const { heightPx, overflowY } = computeComposerTextareaHeight(el.scrollHeight, 44, 148);
      el.style.height = `${heightPx}px`;
      el.style.overflowY = overflowY;
    }, []);

    useLayoutEffect(() => {
      resizeTextarea();
    }, [value, resizeTextarea]);

    const apply = useCallback(
      (next: string) => {
        valueRef.current = next;
        setValueState(next);
        const isEmpty = next.trim().length === 0;
        if (isEmpty !== wasEmptyRef.current) {
          wasEmptyRef.current = isEmpty;
          onEmptyChange(isEmpty);
        }
      },
      [onEmptyChange],
    );

    useImperativeHandle(
      ref,
      () => ({
        getValue: () => valueRef.current,
        setValue: (next: string) => apply(next),
        focus: () => textareaRef.current?.focus(),
      }),
      [apply],
    );

    const effectivePlaceholder = isCompactViewport && compactPlaceholder ? compactPlaceholder : placeholder;

    const SLASH_COMMANDS = [
      { cmd: '/status', desc: 'Pełny status systemu i telemetrii' },
      { cmd: '/synchronizuj', desc: 'Synchronizacja globalna OS + GitHub' },
      { cmd: '/moduly', desc: 'Lista aktywnych modułów SQLite' },
      { cmd: '/pamiec', desc: 'Odczytaj pamięć długotrwałą 128D' },
      { cmd: '/zadanie ', desc: 'Zleć zadanie workerowi AI (tytuł | opis)' },
      { cmd: '/jedi status', desc: 'Status maszyny JEDI Omni-OS v12' },
      { cmd: '/ollama', desc: 'Status modeli i demona Ollama' },
      { cmd: '/github sync', desc: 'Obustronna synchronizacja z GitHub' },
      { cmd: '/exec ', desc: 'Wykonaj polecenie w powłoce ROOT' },
    ];

    const trimmed = value.trimStart();
    const showPalette = trimmed.startsWith('/') && !trimmed.includes('\n') && !trimmed.includes(' ');
    const filteredCommands = showPalette
      ? SLASH_COMMANDS.filter((item) => item.cmd.toLowerCase().startsWith(trimmed.toLowerCase()))
      : [];

    const [selectedIdx, setSelectedIdx] = useState(0);

    return (
      <div className="relative flex-1 min-w-0 flex">
        {filteredCommands.length > 0 && (
          <div
            role="listbox"
            aria-label="Paleta poleceń czatu"
            className="absolute bottom-full left-0 right-0 mb-2 z-30 rounded-xl border border-cyan-500/35 bg-[#091021]/95 backdrop-blur-md shadow-2xl overflow-hidden max-h-60 overflow-y-auto"
          >
            <div className="px-3 py-1.5 border-b border-slate-800 text-[10px] font-mono uppercase tracking-wider text-cyan-300 flex justify-between">
              <span>Polecenia SVL · Copilot Palette</span>
              <span className="text-slate-500">Tab / Kliknij</span>
            </div>
            {filteredCommands.map((item, idx) => (
              <button
                key={item.cmd}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  apply(item.cmd);
                  textareaRef.current?.focus();
                }}
                className={`w-full text-left px-3 py-2 flex items-center justify-between gap-2 text-xs transition-colors ${
                  idx === selectedIdx
                    ? 'bg-cyan-500/15 text-cyan-200'
                    : 'text-slate-300 hover:bg-white/[0.04]'
                }`}
              >
                <span className="font-mono font-semibold text-cyan-300">{item.cmd.trim()}</span>
                <span className="text-[11px] text-slate-400 truncate">{item.desc}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(e) => {
            setSelectedIdx(0);
            apply(e.target.value);
          }}
          onKeyDown={(e) => {
            if (filteredCommands.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelectedIdx((prev) => (prev + 1) % filteredCommands.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelectedIdx((prev) => (prev - 1 + filteredCommands.length) % filteredCommands.length);
                return;
              }
              if (e.key === 'Tab') {
                e.preventDefault();
                const chosen = filteredCommands[selectedIdx] || filteredCommands[0];
                if (chosen) apply(chosen.cmd);
                return;
              }
            }
            if (
              shouldSubmitChatShortcut({
                key: e.key,
                shiftKey: e.shiftKey,
                isComposing: e.nativeEvent.isComposing,
                altKey: e.altKey,
                ctrlKey: e.ctrlKey,
                metaKey: e.metaKey,
              })
            ) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={effectivePlaceholder}
          aria-label={ariaLabel}
          enterKeyHint="send"
          autoComplete="off"
          className={`${className || ''} w-full resize-none leading-snug`.trim()}
        />
      </div>
    );
  }),
);
