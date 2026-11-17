import React, { useEffect, useState } from 'react';
import { Check, Copy, Plug } from 'lucide-react';
import { safeFetchJson } from '../utils/svlLogic';

/** Adres serwera MCP SVL dla Claude: konektor w aplikacji Claude (klucz w adresie) i Claude Code (nagłówek). */
export const McpConnectorCard: React.FC = () => {
  const [urlKeyPath, setUrlKeyPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [reveal, setReveal] = useState(false);

  useEffect(() => {
    void safeFetchJson<{ ok: boolean; urlKeyPath: string | null; error?: string }>('/api/mcp/connector', { timeoutMs: 8000 }).then(
      (res) => {
        if (res.ok && res.data?.ok) setUrlKeyPath(res.data.urlKeyPath);
        else setError(res.data?.error || res.error || `HTTP ${res.status}`);
      },
    );
  }, []);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const connectorUrl = urlKeyPath ? `${origin}${urlKeyPath}` : '';
  const masked = connectorUrl ? connectorUrl.replace(/(\/mcp\/svl\/).+$/, '$1••••••••') : '';

  const copy = async () => {
    if (!connectorUrl) return;
    await navigator.clipboard.writeText(connectorUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="p-5 rounded-xl bg-[#111520] border border-slate-800 space-y-3">
      <h2 className="text-sm font-semibold text-slate-100 inline-flex items-center gap-2">
        <Plug className="w-4 h-4" aria-hidden="true" /> Claude MCP · SVL CoreOS 2
      </h2>
      {error && <p className="text-xs text-amber-300">{error}</p>}
      {connectorUrl && (
        <>
          <p className="text-xs text-slate-400">Adres konektora (aplikacja Claude → Ustawienia → Konektory → Dodaj własny):</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 truncate rounded bg-[#0B0D13] border border-slate-800 px-2 py-1.5 text-[11px] text-cyan-200">
              {reveal ? connectorUrl : masked}
            </code>
            <button
              type="button"
              onClick={() => setReveal((v) => !v)}
              className="text-[11px] text-slate-400 hover:text-slate-200"
            >
              {reveal ? 'Ukryj' : 'Pokaż'}
            </button>
            <button
              type="button"
              onClick={() => void copy()}
              aria-label="Kopiuj adres konektora MCP"
              className="px-2 py-1.5 rounded-md border border-slate-700 hover:bg-slate-800 text-slate-200 text-xs inline-flex items-center gap-1"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? 'Skopiowano' : 'Kopiuj'}
            </button>
          </div>
          <p className="text-[11px] text-slate-500">
            Adres zawiera tajny klucz — nie udostępniaj go. Claude musi mieć dostęp do tego adresu z internetu:
            podgląd w AI Studio jest za logowaniem Google, więc użyj wdrożenia (Cloud Run) albo serwera z SVL CoreOS 2.
            Claude Code: <code>{origin}/mcp/svl</code> z nagłówkiem <code>Authorization: Bearer SVL_OPERATOR_TOKEN</code>.
          </p>
        </>
      )}
    </div>
  );
};
