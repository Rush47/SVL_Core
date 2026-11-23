// Wspólna szyna synchronizacji na żywo dla wszystkich kanałów do przeglądarek.
//
// Każda ramka (zdarzenie z outboxa SQLite, `svl.resync_required`) trafia przez tę szynę
// zarówno do klientów WebSocket `/ws/svl`, jak i do strumienia SSE `/api/events`.
// SSE to zwykłe HTTP, więc działa też tam, gdzie proxy (np. podgląd AI Studio, tunel)
// zrywa WebSocket — wtedy zmiany z czatu i tak pojawiają się w GUI od razu.

export type LiveSyncListener = (frame: string) => void;

export class LiveSyncBus {
  private listeners = new Set<LiveSyncListener>();

  /** Rejestruje odbiorcę ramek; zwraca funkcję wyrejestrowania. */
  subscribe(listener: LiveSyncListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Liczba podłączonych odbiorców (np. klientów SSE). */
  get size(): number {
    return this.listeners.size;
  }

  /** Wysyła ramkę JSON do wszystkich odbiorców; błąd jednego nie blokuje pozostałych. */
  publish(frame: string): number {
    let delivered = 0;
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(frame);
        delivered += 1;
      } catch {
        this.listeners.delete(listener);
      }
    }
    return delivered;
  }
}

/** Koduje ramkę JSON jako zdarzenie Server-Sent Events (wiele linii `data:` dla bezpieczeństwa). */
export function formatSseFrame(json: string, id?: string | number): string {
  const lines = String(json).split(/\r?\n/).map((line) => `data: ${line}`);
  return `${id !== undefined && id !== '' ? `id: ${id}\n` : ''}${lines.join('\n')}\n\n`;
}

/** Komentarz SSE utrzymujący połączenie przez proxy (ignorowany przez klienta). */
export function sseKeepAlive(): string {
  return `: keepalive ${Date.now()}\n\n`;
}
