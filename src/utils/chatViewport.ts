export const DEFAULT_CHAT_WINDOW_SIZE = 60;
export const CHAT_WINDOW_STEP = 80;

export interface MessageWindowSlice {
  startIndex: number;
  hiddenCount: number;
  hasMore: boolean;
}

/**
 * Wyznacza zakres renderowanych wiadomości z końca historii,
 * aby długie wątki (500+ wiadomości) nie blokowały pierwszego renderowania i przewijania.
 */
export function computeMessageWindow(
  totalCount: number,
  windowLimit: number = DEFAULT_CHAT_WINDOW_SIZE,
): MessageWindowSlice {
  const safeTotal = Math.max(0, Math.floor(Number.isFinite(totalCount) ? totalCount : 0));
  const safeLimit = Math.max(1, Math.floor(Number.isFinite(windowLimit) ? windowLimit : DEFAULT_CHAT_WINDOW_SIZE));
  const startIndex = Math.max(0, safeTotal - safeLimit);
  return {
    startIndex,
    hiddenCount: startIndex,
    hasMore: startIndex > 0,
  };
}

export function nextMessageWindowLimit(
  currentLimit: number,
  totalCount: number,
  step: number = CHAT_WINDOW_STEP,
): number {
  const safeTotal = Math.max(0, Math.floor(Number.isFinite(totalCount) ? totalCount : 0));
  const safeCurrent = Math.max(1, Math.floor(Number.isFinite(currentLimit) ? currentLimit : DEFAULT_CHAT_WINDOW_SIZE));
  const safeStep = Math.max(1, Math.floor(Number.isFinite(step) ? step : CHAT_WINDOW_STEP));
  return Math.min(safeTotal, safeCurrent + safeStep);
}

/**
 * Oblicza wysokość pola wielowierszowego w px z bezpiecznym zakresem [minHeight, maxHeight].
 */
export function computeComposerTextareaHeight(
  scrollHeight: number,
  minHeight = 44,
  maxHeight = 148,
): { heightPx: number; overflowY: 'hidden' | 'auto' } {
  const safeScroll = Number.isFinite(scrollHeight) ? scrollHeight : minHeight;
  const clamped = Math.max(minHeight, Math.min(maxHeight, Math.ceil(safeScroll)));
  return {
    heightPx: clamped,
    overflowY: safeScroll > maxHeight ? 'auto' : 'hidden',
  };
}

/**
 * Rozstrzyga, czy naciśnięcie klawisza powinno wysłać wiadomość (Enter bez Shift i bez kompozycji IME).
 */
export function shouldSubmitChatShortcut(evt: {
  key: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}): boolean {
  if (evt.key !== 'Enter') return false;
  if (evt.shiftKey || evt.isComposing || evt.altKey || evt.ctrlKey || evt.metaKey) return false;
  return true;
}
