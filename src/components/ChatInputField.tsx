import React, { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react';

/**
 * Pole wpisywania wiadomości z własnym stanem.
 *
 * Tekst żyje tylko tutaj, więc pisanie nie przerysowuje całego czatu (listy wiadomości z Markdownem).
 * Rodzic dostaje informację wyłącznie o zmianie „puste ↔ niepuste” i czyta tekst przez uchwyt
 * (`getValue`) dopiero przy wysyłaniu.
 */
export interface ChatInputHandle {
  getValue: () => string;
  setValue: (value: string) => void;
  focus: () => void;
}

interface ChatInputFieldProps {
  placeholder: string;
  ariaLabel: string;
  className?: string;
  onEmptyChange: (isEmpty: boolean) => void;
}

export const ChatInputField = React.memo(
  forwardRef<ChatInputHandle, ChatInputFieldProps>(function ChatInputField(
    { placeholder, ariaLabel, className, onEmptyChange },
    ref,
  ) {
    const [value, setValueState] = useState('');
    const valueRef = useRef('');
    const inputRef = useRef<HTMLInputElement | null>(null);
    const wasEmptyRef = useRef(true);

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
        focus: () => inputRef.current?.focus(),
      }),
      [apply],
    );

    return (
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => apply(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoComplete="off"
        className={className}
      />
    );
  }),
);
