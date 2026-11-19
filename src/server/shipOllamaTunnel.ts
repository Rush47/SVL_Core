// Ollama ze statku SVL-364 jako standardowy silnik — przez tunel SSH (local port-forward).
// Ten moduł zawiera czyste, testowalne funkcje; samo uruchomienie procesu `ssh` robi serwer.
//
// Idea: `ssh -N -L <localHost>:<localPort>:127.0.0.1:<shipPort> <target>` tuneluje port Ollamy
// ze statku na localhost gatewaya. Potem OLLAMA_HOST wskazuje na ten tunel, więc czat, rozgrzewanie
// modeli i misja Mayi używają Ollamy ze statku tak samo jak lokalnej.

export interface ShipOllamaTunnelConfig {
  enabled: boolean;
  /** Alias OpenSSH z ~/.ssh/config albo user@host (SVL_SSH_TARGET). */
  target: string;
  /** Port Ollamy na statku (zdalny). */
  shipPort: number;
  /** Port lokalny, na który tunelujemy (OLLAMA_HOST będzie go używać). */
  localPort: number;
  localHost: string;
}

function toPort(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

/** Odczytuje konfigurację tunelu ze zmiennych środowiskowych. */
export function parseShipOllamaTunnelEnv(env: Record<string, string | undefined>): ShipOllamaTunnelConfig {
  const enabled = ['1', 'true', 'yes', 'on'].includes(String(env.SVL_SHIP_OLLAMA ?? '').trim().toLowerCase());
  return {
    enabled,
    target: String(env.SVL_SSH_TARGET || 'Ship').trim() || 'Ship',
    shipPort: toPort(env.SVL_SHIP_OLLAMA_PORT, 11434),
    localPort: toPort(env.SVL_SHIP_OLLAMA_LOCAL_PORT, 11434),
    localHost: String(env.SVL_SHIP_OLLAMA_LOCAL_HOST || '127.0.0.1').trim() || '127.0.0.1',
  };
}

/** Pełny adres HTTP lokalnego końca tunelu — wartość dla OLLAMA_HOST. */
export function tunnelOllamaUrl(cfg: ShipOllamaTunnelConfig): string {
  return `http://${cfg.localHost}:${cfg.localPort}`;
}

/**
 * Argumenty `ssh` dla trwałego tunelu portu (bez powłoki zdalnej):
 * - BatchMode: bez pytań o hasło (tylko klucze z konfiguracji OpenSSH),
 * - ExitOnForwardFailure: jeśli port jest zajęty/niedostępny, ssh kończy się (wykryjemy błąd),
 * - ServerAliveInterval/CountMax: szybkie wykrycie zerwanego łącza,
 * - StrictHostKeyChecking=accept-new: pierwsze połączenie nie wisi na pytaniu o odcisk klucza.
 */
export function buildSshTunnelArgs(cfg: ShipOllamaTunnelConfig): string[] {
  return [
    '-N',
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
    '-L', `${cfg.localHost}:${cfg.localPort}:127.0.0.1:${cfg.shipPort}`,
    cfg.target,
  ];
}

/** Opóźnienie ponownej próby z narastaniem (maks. 60 s). */
export function tunnelRestartDelayMs(attempt: number): number {
  return Math.min(60_000, 2000 * Math.max(1, attempt));
}

export type TunnelStatus = 'off' | 'starting' | 'up' | 'down';

/** Czytelny opis stanu tunelu dla operatora. */
export function describeTunnelStatus(status: TunnelStatus, cfg: ShipOllamaTunnelConfig, error?: string | null): string {
  if (!cfg.enabled) return 'Tunel Ollamy ze statku wyłączony (ustaw SVL_SHIP_OLLAMA=1).';
  const route = `${cfg.target} → ${tunnelOllamaUrl(cfg)} (zdalny port ${cfg.shipPort})`;
  switch (status) {
    case 'up':
      return `Ollama ze statku SVL-364 aktywna przez SSH: ${route}.`;
    case 'starting':
      return `Zestawianie tunelu SSH do Ollamy statku: ${route}…`;
    case 'down':
      return `Tunel SSH do Ollamy statku nie działa: ${error || 'brak połączenia'} (${route}).`;
    default:
      return 'Tunel Ollamy ze statku wyłączony.';
  }
}

/**
 * Domyślne, mocne modele UNCENSORED pod GPU (statek SVL-364 ma dużo RAM i GPU).
 * Realne tagi z rejestru Ollamy (ollama.com/library), od największego do najszybszego.
 * Linie Dolphin i Wizard-Vicuna-Uncensored to sprawdzone modele bez cenzury treści.
 */
export const SHIP_UNCENSORED_GPU_MODELS: readonly string[] = [
  'dolphin-mixtral:8x22b',          // ~141B MoE — flagowy, maksymalna jakość (duże VRAM/RAM)
  'dolphin-llama3:70b',             // 70B, uncensored, bardzo mocny
  'wizard-vicuna-uncensored:30b',   // 30B, uncensored
  'dolphin-mixtral:8x7b',           // 8x7B MoE, szybszy, uncensored
];

/**
 * Lista modeli do pobrania na statku ("podłącz wszystkie, tylko uncensored pod GPU").
 * Domyślnie zestaw SHIP_UNCENSORED_GPU_MODELS; SVL_SHIP_OLLAMA_MODELS (po przecinku) nadpisuje.
 * Celowo NIE dokłada modeli wizyjnych/ocenzurowanych — operator chce wyłącznie uncensored.
 * Odfiltrowuje duplikaty i profile budowane lokalnie (apex-uncensored powstaje z Modelfile).
 */
export function resolveShipPullModels(
  env: Record<string, string | undefined>,
  extra: string[] = [],
): string[] {
  const override = String(env.SVL_SHIP_OLLAMA_MODELS || '').split(',').map((m) => m.trim()).filter(Boolean);
  const raw = [...(override.length > 0 ? override : SHIP_UNCENSORED_GPU_MODELS), ...extra]
    .map((m) => String(m || '').trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of raw) {
    // Profil apex-uncensored nie jest w rejestrze Ollamy — buduje się go z Modelfile (ollama create).
    if (/apex-uncensored/i.test(m)) continue;
    const key = m.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(m); }
  }
  return out;
}
