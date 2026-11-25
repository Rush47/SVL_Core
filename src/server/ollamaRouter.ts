// Multi-endpoint Ollama Router: obsługuje jednocześnie lokalną Ollamę (np. :11434)
// oraz drugą Ollamę ze statku SVL-364 przez tunel SSH / zdalny host (np. :11435 lub SVL_SHIP_OLLAMA_URL).
// Zapobiega cichemu podmianom jawnie wybranego modelu Ollama (np. svl364-apex-uncensored:latest) na Gemini.

import { resolveCachedOllamaModel, type ResolveCachedOllamaResult } from './ollamaOptimizer.ts';
import { tunnelOllamaUrl, type ShipOllamaTunnelConfig } from './shipOllamaTunnel.ts';

export type OllamaEndpointId = 'local' | 'ship' | 'secondary';

export interface OllamaEndpointConfig {
  id: OllamaEndpointId;
  label: string;
  host: string;
  source: 'local' | 'ship_ssh' | 'remote';
  enabled: boolean;
  explicit: boolean;
}

export interface ParsedModelSpec {
  raw: string;
  kind: 'ollama' | 'gemini' | 'router' | 'other';
  modelName: string;
  /** Preferowany węzeł Ollamy (np. 'ship' dla svl364-apex-uncensored albo prefiksu ollama:ship:). */
  preferredEndpoint: OllamaEndpointId | null;
  /** Czy użytkownik jawnie wymusił konkretny węzeł (ollama:ship:... / ollama:local:...). */
  strictEndpoint: boolean;
}

export interface EndpointProbeAttempt {
  endpoint: OllamaEndpointConfig;
  ok: boolean;
  model?: string;
  exactMatch?: boolean;
  substituted?: boolean;
  installedModels?: string[];
  version?: string;
  reason?: string;
}

export type MultiOllamaResolution =
  | {
      ok: true;
      endpoint: OllamaEndpointConfig;
      model: string;
      requestedModel: string;
      exactMatch: boolean;
      substituted: boolean;
      installedModels: string[];
      version: string;
      attempts: EndpointProbeAttempt[];
    }
  | {
      ok: false;
      requestedModel: string;
      reason: string;
      attempts: EndpointProbeAttempt[];
    };

export function normalizeOllamaBaseUrl(raw: string | undefined | null): string | null {
  const clean = String(raw || '').trim().replace(/\/+$/, '');
  if (!clean) return null;
  const withScheme = /^https?:\/\//i.test(clean) ? clean : `http://${clean}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!parsed.hostname) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Zwraca true dla modeli domyślnie hostowanych na jednostce SVL-364 (GPU / Ship Ollama).
 */
export function isShipPreferredModel(modelName: string): boolean {
  const low = String(modelName || '').trim().toLowerCase();
  if (!low) return false;
  return (
    low.startsWith('svl364-') ||
    low.includes('apex-uncensored') ||
    /(?:^|[:\-_])(?:8x22b|8x7b|70b|90b|30b|32b|34b)\b/.test(low)
  );
}

/**
 * Parsuje wybór modelu z czatu:
 * - `ollama:ship:svl364-apex-uncensored:latest` → węzeł `ship`, model `svl364-apex-uncensored:latest`
 * - `ollama:local:qwen2.5:7b` → węzeł `local`, model `qwen2.5:7b`
 * - `ollama:svl364-apex-uncensored:latest` → preferuje `ship`, potem `local`
 * - `gemini-*` → jawny Gemini
 * - `svl-hybrid-router` → router (Ollama → Gemini fallback)
 */
export function parseOllamaModelSpec(
  rawModel: string,
  defaultOllamaModel = 'svl364-apex-uncensored:latest',
): ParsedModelSpec {
  const raw = String(rawModel || '').trim();
  if (!raw || raw === 'svl-hybrid-router') {
    return {
      raw: raw || 'svl-hybrid-router',
      kind: 'router',
      modelName: defaultOllamaModel,
      preferredEndpoint: isShipPreferredModel(defaultOllamaModel) ? 'ship' : null,
      strictEndpoint: false,
    };
  }
  if (/^gemini-/i.test(raw)) {
    return {
      raw,
      kind: 'gemini',
      modelName: raw,
      preferredEndpoint: null,
      strictEndpoint: false,
    };
  }
  if (/^ollama:/i.test(raw)) {
    const rest = raw.slice('ollama:'.length).trim();
    const scopedMatch = /^(ship|local|secondary):(.+)$/i.exec(rest);
    if (scopedMatch) {
      const scope = scopedMatch[1].toLowerCase() as OllamaEndpointId;
      const modelName = scopedMatch[2].trim() || defaultOllamaModel;
      return {
        raw,
        kind: 'ollama',
        modelName,
        preferredEndpoint: scope,
        strictEndpoint: true,
      };
    }
    const modelName = rest || defaultOllamaModel;
    return {
      raw,
      kind: 'ollama',
      modelName,
      preferredEndpoint: isShipPreferredModel(modelName) ? 'ship' : null,
      strictEndpoint: false,
    };
  }
  return {
    raw,
    kind: 'other',
    modelName: raw,
    preferredEndpoint: null,
    strictEndpoint: false,
  };
}

/**
 * Domyślnie jawnie wybrany model `ollama:*` (np. `ollama:svl364-apex-uncensored:latest`)
 * NIE przełącza się po cichu na Gemini — zapobiega to błędnemu wrażeniu, że apex-uncensored to Gemini.
 * Dopiero SVL_ALLOW_EXPLICIT_OLLAMA_GEMINI_FALLBACK=1 (albo tryb `svl-hybrid-router`) zezwala na fallback.
 */
export function shouldAllowExplicitOllamaFallbackToGemini(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const flag = String(env.SVL_ALLOW_EXPLICIT_OLLAMA_GEMINI_FALLBACK || '').trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on';
}

/**
 * Buduje deduplikowaną listę wszystkich węzłów Ollamy:
 * 1) Lokalna / główna Ollama (`primaryHost` / `OLLAMA_HOST`, domyślnie http://127.0.0.1:11434)
 * 2) Druga Ollama ze statku SVL-364 przez tunel SSH (`shipTunnel`) lub jawny URL (`SVL_SHIP_OLLAMA_URL` / `OLLAMA_SHIP_HOST`)
 * 3) Opcjonalna zdalna/druga Ollama (`OLLAMA_SECONDARY_HOST` / `SVL_SECOND_OLLAMA_HOST`)
 * 4) Opcjonalna autodetekcja zewnętrznego tunelu SSH na porcie 11435 (np. usługa systemd `svl-ship-ollama-tunnel.service`),
 *    gdy główna Ollama zajmuje port 11434.
 */
export function buildOllamaEndpoints(opts: {
  primaryHost?: string | null;
  env?: Record<string, string | undefined>;
  shipTunnel?: { cfg: ShipOllamaTunnelConfig; status?: string };
  includeDefaultSecondaryPort?: boolean;
}): OllamaEndpointConfig[] {
  const env = opts.env ?? process.env;
  const primary =
    normalizeOllamaBaseUrl(opts.primaryHost) ||
    normalizeOllamaBaseUrl(env.OLLAMA_HOST) ||
    'http://127.0.0.1:11434';

  const shipDirectUrl =
    normalizeOllamaBaseUrl(env.SVL_SHIP_OLLAMA_URL) ||
    normalizeOllamaBaseUrl(env.OLLAMA_SHIP_HOST);
  const secondaryUrl =
    normalizeOllamaBaseUrl(env.OLLAMA_SECONDARY_HOST) ||
    normalizeOllamaBaseUrl(env.SVL_SECOND_OLLAMA_HOST);

  const shipTunnelUrl = opts.shipTunnel ? normalizeOllamaBaseUrl(tunnelOllamaUrl(opts.shipTunnel.cfg)) : null;
  const shipTunnelEnabled = Boolean(opts.shipTunnel?.cfg.enabled);

  const byUrl = new Map<string, OllamaEndpointConfig>();

  const register = (ep: OllamaEndpointConfig) => {
    const existing = byUrl.get(ep.host);
    if (!existing) {
      byUrl.set(ep.host, ep);
      return;
    }
    // Jeśli tunel statku współdzieli ten sam port co główny OLLAMA_HOST (np. SVL_SHIP_OLLAMA=1 na 11434),
    // zachowujemy dokładną etykietę źródła „Statek SVL-364 (SSH)”.
    if (ep.id === 'ship' && ep.enabled) {
      byUrl.set(ep.host, { ...existing, ...ep });
    }
  };

  register({
    id: 'local',
    label: 'Lokalna',
    host: primary,
    source: 'local',
    enabled: true,
    explicit: true,
  });

  if (shipDirectUrl) {
    register({
      id: 'ship',
      label: 'Statek SVL-364 (SSH/Zdalna)',
      host: shipDirectUrl,
      source: 'ship_ssh',
      enabled: true,
      explicit: true,
    });
  }

  if (shipTunnelUrl && shipTunnelEnabled) {
    register({
      id: 'ship',
      label: `Statek SVL-364 (SSH · ${opts.shipTunnel?.cfg.target || 'Ship'})`,
      host: shipTunnelUrl,
      source: 'ship_ssh',
      enabled: true,
      explicit: true,
    });
  }

  if (secondaryUrl) {
    register({
      id: byUrl.has(secondaryUrl) ? byUrl.get(secondaryUrl)!.id : 'secondary',
      label: 'Druga Ollama (Zdalna)',
      host: secondaryUrl,
      source: 'remote',
      enabled: true,
      explicit: true,
    });
  }

  // Jeśli nie ma jeszcze osobnego węzła `ship` na innym porcie, sprawdź czy operator uruchomił
  // zewnętrzny tunel SSH (np. systemd na 127.0.0.1:11435 albo skonfigurowany SVL_SHIP_OLLAMA_LOCAL_PORT != primary).
  const autoProbeSecondary = opts.includeDefaultSecondaryPort !== false &&
    !['0', 'false', 'off', 'no'].includes(String(env.SVL_SHIP_OLLAMA_AUTO_PROBE || '').trim().toLowerCase());
  const hasDistinctShip = [...byUrl.values()].some((e) => e.id === 'ship');
  if (autoProbeSecondary && !hasDistinctShip) {
    const candidatePort = Number(env.SVL_SHIP_OLLAMA_LOCAL_PORT || 0);
    const secondaryLocalUrl =
      candidatePort > 0 && candidatePort < 65536
        ? `http://127.0.0.1:${candidatePort}`
        : 'http://127.0.0.1:11435';
    if (secondaryLocalUrl !== primary) {
      register({
        id: 'ship',
        label: `Statek SVL-364 (SSH · :${new URL(secondaryLocalUrl).port})`,
        host: secondaryLocalUrl,
        source: 'ship_ssh',
        enabled: false, // pasywne wykrywanie działającego tunelu zewnętrznego
        explicit: false,
      });
    }
  }

  return [...byUrl.values()];
}

/**
 * Zwraca adres URL Ollamy statku (priorytet: SVL_SHIP_OLLAMA_URL → OLLAMA_SHIP_HOST → tunel SSH).
 */
export function resolveShipOllamaBaseUrl(opts: {
  env?: Record<string, string | undefined>;
  shipTunnelCfg: ShipOllamaTunnelConfig;
}): string {
  const env = opts.env ?? process.env;
  return (
    normalizeOllamaBaseUrl(env.SVL_SHIP_OLLAMA_URL) ||
    normalizeOllamaBaseUrl(env.OLLAMA_SHIP_HOST) ||
    tunnelOllamaUrl(opts.shipTunnelCfg)
  );
}

/**
 * Dobiera najlepszy działający węzeł Ollamy i model spośród wszystkich skonfigurowanych instancji
 * (lokalna + statek SVL-364 SSH + druga zdalna).
 *
 * Priorytet:
 * 1) Dokładne dopasowanie (lub ta sama rodzina) na preferowanym węźle (np. `ship` dla svl364-apex-uncensored).
 * 2) Dokładne dopasowanie (lub ta sama rodzina) na dowolnym innym osiągalnym węźle Ollamy.
 * 3) Jeśli `allowSubstitution` (domyślnie true): najlepszy zainstalowany model na preferowanym lub dowolnym
 *    osiągalnym węźle Ollamy — zawsze pozostając w ekosystemie Ollama zamiast skakać do Gemini.
 */
export async function resolveOllamaAcrossEndpoints(
  endpoints: OllamaEndpointConfig[],
  requestedModel: string,
  opts: {
    preferredEndpoint?: OllamaEndpointId | null;
    strictEndpoint?: boolean;
    requireVision?: boolean;
    allowSubstitution?: boolean;
    local14bForDefault?: boolean;
    forceRefresh?: boolean;
    probeTimeoutMs?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<MultiOllamaResolution> {
  const allowSubstitution = opts.allowSubstitution !== false;
  const preferred = opts.preferredEndpoint ?? (isShipPreferredModel(requestedModel) ? 'ship' : null);

  const isApex = /^svl364-apex-uncensored(?::latest)?$/i.test(requestedModel);
  const allowLocal14b = isApex && opts.local14bForDefault && !opts.strictEndpoint && !opts.requireVision;
  let candidates = [...endpoints];
  if (opts.strictEndpoint && preferred) {
    candidates = candidates.filter((ep) => ep.id === preferred);
  }

  // Sortujemy tak, żeby preferowany węzeł był pierwszy przy równych dopasowaniach.
  candidates.sort((a, b) => {
    const aPref = preferred && a.id === preferred ? 0 : 1;
    const bPref = preferred && b.id === preferred ? 0 : 1;
    if (aPref !== bPref) return aPref - bPref;
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return 0;
  });

  if (candidates.length === 0) {
    return {
      ok: false,
      requestedModel,
      reason: opts.strictEndpoint && preferred
        ? `Wybrany węzeł Ollamy (${preferred}) nie jest skonfigurowany.`
        : 'Brak skonfigurowanych węzłów Ollama.',
      attempts: [],
    };
  }

  const probeResults = await Promise.all(
    candidates.map(async (endpoint): Promise<EndpointProbeAttempt> => {
      const isLoopback = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(endpoint.host);
      const defaultProbeMs = endpoint.explicit ? (isLoopback ? 2000 : 3500) : 1500;
      const effectiveProbeTimeoutMs =
        opts.probeTimeoutMs !== undefined
          ? endpoint.explicit
            ? opts.probeTimeoutMs
            : Math.min(opts.probeTimeoutMs, 600)
          : defaultProbeMs;
      const res: ResolveCachedOllamaResult = await resolveCachedOllamaModel(
        endpoint.host,
        requestedModel,
        {
          requireVision: opts.requireVision,
          forceRefresh: opts.forceRefresh,
          probeTimeoutMs: effectiveProbeTimeoutMs,
          fetchImpl: opts.fetchImpl,
        },
      );
      if (res.ok) {
        const sizeMatches = (model: string, size: RegExp) => size.test(res.modelSizes[model] || '');
        if (isApex && res.exactMatch && sizeMatches(res.model, /^7[01](?:\.\d+)?\s*B$/i)) {
          return { endpoint, ...res };
        }
        if (allowLocal14b && endpoint.id === 'local') {
          const local14b = res.installedModels.find(model => /^qwen2\.5:14b(?:$|-instruct)/i.test(model) && sizeMatches(model, /^14(?:\.\d+)?\s*B$/i))
            ?? res.installedModels.find(model => sizeMatches(model, /^14(?:\.\d+)?\s*B$/i));
          if (local14b) return { endpoint, ...res, model: local14b, exactMatch: false, substituted: true };
        }
        if (isApex) return { endpoint, ok: false, reason: 'Brak zweryfikowanego Apex 70B.' };
        return {
          endpoint,
          ok: true,
          model: res.model,
          exactMatch: res.exactMatch,
          substituted: res.substituted,
          installedModels: res.installedModels,
          version: res.version,
        };
      }
      return {
        endpoint,
        ok: false,
        reason: res.reason,
      };
    }),
  );

  // 1) Najpierw dokładne dopasowanie: preferuj lokalną Ollamę dla bezpośredniej inferencji,
  // chyba że użytkownik zażądał ścisłego węzła (strictEndpoint).
  const localExact = !preferred && !opts.strictEndpoint ? probeResults.find((a) => a.ok && a.exactMatch && a.endpoint.id === 'local') : null;
  const exactWinner = localExact || probeResults.find((a) => a.ok && a.exactMatch && a.model);
  if (exactWinner && exactWinner.model) {
    return {
      ok: true,
      endpoint: exactWinner.endpoint,
      model: exactWinner.model,
      requestedModel,
      exactMatch: true,
      substituted: false,
      installedModels: exactWinner.installedModels || [],
      version: exactWinner.version || '',
      attempts: probeResults,
    };
  }

  // 2) Jeśli dokładnego modelu nie ma na żadnym węźle, a dozwolony jest zamiennik w ramach Ollamy:
  if ((allowSubstitution && !isApex) || allowLocal14b) {
    const fallbackOllama = probeResults.find((a) => a.ok && a.model);
    if (fallbackOllama && fallbackOllama.model) {
      return {
        ok: true,
        endpoint: fallbackOllama.endpoint,
        model: fallbackOllama.model,
        requestedModel,
        exactMatch: false,
        substituted: Boolean(fallbackOllama.substituted),
        installedModels: fallbackOllama.installedModels || [],
        version: fallbackOllama.version || '',
        attempts: probeResults,
      };
    }
  }

  // Zbuduj zwięzły, uczciwy raport błędów ze wszystkich jawnych węzłów.
  const relevantFailures = probeResults.filter((a) => !a.ok && (a.endpoint.explicit || probeResults.length === 1));
  const detailLines = (relevantFailures.length > 0 ? relevantFailures : probeResults).map(
    (a) => `${a.endpoint.label} (${a.endpoint.host}): ${a.reason || 'niedostępna'}`,
  );
  return {
    ok: false,
    requestedModel,
    reason: detailLines.join(' | '),
    attempts: probeResults,
  };
}

/**
 * Czytelna, w 100% prawdziwa etykieta silnika dla odpowiedzi Ollamy.
 */
export function formatOllamaBadge(opts: {
  speakerName: string;
  endpointLabel: string;
  actualModel: string;
  requestedModel?: string;
  substituted?: boolean;
  roleTag?: string;
  vision?: boolean;
}): string {
  const roleSuffix = opts.roleTag ? ` · ${opts.roleTag}` : '';
  const visionSuffix = opts.vision ? ' · Vision' : '';
  if (opts.substituted && opts.requestedModel && opts.requestedModel !== opts.actualModel) {
    return `${opts.speakerName} · Ollama [${opts.endpointLabel}] (${opts.actualModel} · zamiennik za ${opts.requestedModel}${roleSuffix})${visionSuffix}`;
  }
  return `${opts.speakerName} · Ollama [${opts.endpointLabel}] (${opts.actualModel}${roleSuffix})${visionSuffix}`;
}

/**
 * Czytelna etykieta silnika dla odpowiedzi Gemini — nigdy nie udaje modelu Ollamy.
 */
export function formatGeminiBadge(opts: {
  speakerName: string;
  geminiModel: string;
  isFallbackFromOllama?: boolean;
  vision?: boolean;
}): string {
  const visionSuffix = opts.vision ? ' · Vision' : '';
  if (opts.isFallbackFromOllama) {
    return `${opts.speakerName} · Gemini (${opts.geminiModel} · fallback, Ollama niedostępna)${visionSuffix}`;
  }
  return `${opts.speakerName} · Gemini (${opts.geminiModel})${visionSuffix}`;
}

export interface ApexCreatePayload {
  model: string;
  from: string;
  system: string;
  parameters: Record<string, number>;
  stream: false;
}

/**
 * Wybiera najlepszy dostępny model bazowy na danym węźle Ollamy do zbudowania `svl364-apex-uncensored:latest`.
 */
export function selectBaseModelForApex(installedModels: string[], preferredBase?: string): string | null {
  const clean = installedModels.map((m) => String(m || '').trim())
    .filter((m) => /^dolphin-llama3:70b(?:$|-)/i.test(m));
  return clean.find((m) => m.toLowerCase() === preferredBase?.toLowerCase())
    ?? clean.find((m) => m.toLowerCase() === 'dolphin-llama3:70b')
    ?? clean[0] ?? null;
}

/**
 * Parsuje plik Modelfile.apex-uncensored na nowoczesny payload `POST /api/create` Ollamy (>= 0.5).
 */
export function buildApexCreatePayload(modelfileContent: string, baseModel: string, targetName = 'svl364-apex-uncensored:latest'): ApexCreatePayload {
  const parameters: Record<string, number> = {};
  for (const line of modelfileContent.split(/\r?\n/)) {
    const m = /^\s*PARAMETER\s+([a-z0-9_]+)\s+([-+]?\d+(?:\.\d+)?)\s*$/i.exec(line);
    if (m) {
      parameters[m[1]] = Number(m[2]);
    }
  }
  const sysMatch = /SYSTEM\s+"""([\s\S]*?)"""/i.exec(modelfileContent) || /SYSTEM\s+"([^"]*)"/i.exec(modelfileContent);
  const system = sysMatch?.[1]?.trim() ?? '';
  return {
    model: targetName,
    from: baseModel,
    system,
    parameters: Object.keys(parameters).length > 0 ? parameters : { num_ctx: 16384, temperature: 0.75, top_p: 0.92, repeat_penalty: 1.08 },
    stream: false,
  };
}

/** Model rzeczywiście użyty przez API Ollama lub most (nie model wybrany w GUI). */
export function readOllamaActualModel(data: unknown, expected: string): string {
  if (!data || typeof data !== 'object') throw new Error('Niepoprawna odpowiedź Ollamy');
  const result = data as Record<string, unknown>;
  const actual = String(result.routed_model || result.model || '').trim();
  if (!actual) throw new Error('Ollama nie podała rzeczywistego modelu');
  const normalize = (name: string) => name.toLowerCase().includes(':') ? name.toLowerCase() : name.toLowerCase() + ':latest';
  if (normalize(actual) !== normalize(expected)) {
    throw new Error(`Ollama podmieniła wybrany model: ${actual} zamiast ${expected}`);
  }
  return actual;
}

export function useRawOllamaTextChat(opts: { hasImage: boolean; hasTools: boolean; systemCommand: boolean; enabled?: boolean }): boolean {
  return opts.enabled !== false && !opts.hasImage && !opts.hasTools && !opts.systemCommand;
}
