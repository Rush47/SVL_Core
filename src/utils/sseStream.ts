// Przyrostowy parser strumienia Server-Sent Events (fetch + ReadableStream).
// Używamy fetch zamiast EventSource, bo EventSource nie wysyła nagłówka
// X-SVL-Operator-Token (token nie może trafić do adresu URL).

export interface SseParser {
  /** Dodaje fragment strumienia; zwraca kompletne pola `data` z zakończonych zdarzeń. */
  push(chunk: string): string[];
}

export function createSseParser(): SseParser {
  let buffer = '';
  let dataLines: string[] = [];
  return {
    push(chunk: string): string[] {
      buffer += chunk;
      const out: string[] = [];
      let newline = buffer.search(/\r?\n/);
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(buffer[newline] === '\r' ? newline + 2 : newline + 1);
        if (line === '') {
          if (dataLines.length > 0) out.push(dataLines.join('\n'));
          dataLines = [];
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        // `id:`, `event:`, `retry:` i komentarze `:` są ignorowane.
        newline = buffer.search(/\r?\n/);
      }
      return out;
    },
  };
}
