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

    return (
      <textarea
        ref={textareaRef}
        rows={1}
        value={value}
        onChange={(e) => apply(e.target.value)}
        onKeyDown={(e) => {
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
        className={`${className || ''} resize-none leading-snug`.trim()}
      />
    );
  }),
);
