import React, { useMemo, useState } from 'react';
import {
  Calculator,
  Check,
  Copy,
  Info,
  Sigma,
  Sparkles,
  Sliders,
} from 'lucide-react';
import { ParsedFormulaToken } from '../utils/chatInteractiveTokens';
import { renderMathToHtml } from '../utils/chatMath';

interface InteractiveFormulaWidgetProps {
  formula: ParsedFormulaToken;
  onAction?: (actionValue: string, label?: string) => void | Promise<void>;
}

export const InteractiveFormulaWidget: React.FC<InteractiveFormulaWidgetProps> = ({
  formula,
  onAction,
}) => {
  const [copied, setCopied] = useState(false);
  const [calculatorOpen, setCalculatorOpen] = useState(false);
  const [symbolsOpen, setSymbolsOpen] = useState(false);

  // Variable values state for the live evaluator
  const [variableValues, setVariableValues] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    for (const v of formula.variables) {
      init[v.symbol] = v.value ?? 1;
    }
    return init;
  });

  const { title = 'Formuła Naukowa & Wzór', tex, description, variables } = formula;

  const rendered = useMemo(() => renderMathToHtml(tex, true), [tex]);

  const handleCopyLatex = () => {
    try {
      void navigator.clipboard.writeText(tex);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  // Live calculation of known canonical formulas
  const evaluatedResult = useMemo(() => {
    const cleanTex = tex.replace(/\s+/g, '');

    // E = mc^2 or E=mc^2
    if (/E\s*=\s*m\s*c(?:\^2|²)/i.test(cleanTex)) {
      const m = variableValues['m'] ?? 1;
      const c = variableValues['c'] ?? 299792458; // m/s
      const e = m * c * c;
      return { label: 'Energia relatywistyczna (E)', val: e.toExponential(4), unit: 'Jouli (J)' };
    }

    // F = ma
    if (/F\s*=\s*m\s*a/i.test(cleanTex)) {
      const m = variableValues['m'] ?? 10;
      const a = variableValues['a'] ?? 9.81;
      const f = m * a;
      return { label: 'Siła (F)', val: f.toFixed(2), unit: 'Newtonów (N)' };
    }

    // v = s / t
    if (/v\s*=\s*s\s*\/\s*t/i.test(cleanTex) || /v\s*=\s*\\frac\{s\}\{t\}/i.test(cleanTex)) {
      const s = variableValues['s'] ?? 100;
      const t = variableValues['t'] ?? 10;
      const v = t !== 0 ? s / t : 0;
      return { label: 'Prędkość (v)', val: v.toFixed(2), unit: 'm/s' };
    }

    // Generic evaluator: product of non-zero variables if unknown
    const entries = Object.entries(variableValues);
    if (entries.length > 0) {
      const prod = entries.reduce((acc, [, val]) => acc * val, 1);
      return { label: 'Wartość relacyjna wzoru', val: prod.toFixed(3), unit: 'jednostek' };
    }

    return null;
  }, [tex, variableValues]);

  return (
    <div className="my-2.5 w-full max-w-full rounded-2xl border border-violet-500/35 bg-gradient-to-br from-[#0F0D1E] via-[#0B0917] to-[#06050C] p-3.5 shadow-lg shadow-black/40 overflow-hidden">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-violet-900/40 pb-2 mb-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <div className="p-1 rounded-md bg-violet-500/15 border border-violet-500/30 text-violet-300">
            <Sigma className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h4 className="text-xs sm:text-sm font-bold text-violet-200 truncate">{title}</h4>
            {description && <p className="text-[10px] text-slate-400 truncate">{description}</p>}
          </div>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-1.5 shrink-0">
          {variables.length > 0 && (
            <button
              type="button"
              onClick={() => setSymbolsOpen((prev) => !prev)}
              className={`flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] transition-colors ${
                symbolsOpen
                  ? 'border-violet-500 bg-violet-600/30 text-violet-200'
                  : 'border-slate-800 bg-slate-900/60 hover:bg-slate-800 text-slate-300'
              }`}
              title="Pokaż znaczenie symboli"
            >
              <Info className="w-3 h-3 text-violet-400" />
              <span className="hidden sm:inline">Symbole</span>
            </button>
          )}

          {variables.length > 0 && (
            <button
              type="button"
              onClick={() => setCalculatorOpen((prev) => !prev)}
              className={`flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] transition-colors ${
                calculatorOpen
                  ? 'border-cyan-500 bg-cyan-600/30 text-cyan-200'
                  : 'border-slate-800 bg-slate-900/60 hover:bg-slate-800 text-slate-300'
              }`}
              title="Otwórz interaktywny przelicznik wartości"
            >
              <Calculator className="w-3 h-3 text-cyan-400" />
              <span>Przelicznik</span>
            </button>
          )}

          <button
            type="button"
            onClick={handleCopyLatex}
            className="flex items-center gap-1 px-2.5 py-0.5 rounded-md border border-slate-800 bg-slate-900/60 hover:bg-slate-800 text-[11px] text-slate-300 hover:text-white transition-colors"
            title="Kopiuj kod LaTeX"
          >
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            <span>{copied ? 'Skopiowano!' : 'LaTeX'}</span>
          </button>
        </div>
      </div>

      {/* KaTeX Equation Display Box */}
      <div className="my-2 p-3 sm:p-4 rounded-xl border border-violet-500/25 bg-[#06040A] overflow-x-auto text-center flex items-center justify-center min-h-[58px]">
        {rendered.ok ? (
          <div
            className="text-sm sm:text-base md:text-lg text-slate-100 font-serif leading-relaxed select-text"
            dangerouslySetInnerHTML={{ __html: rendered.html }}
          />
        ) : (
          <div className="text-xs text-rose-400 font-mono">
            Błąd składni LaTeX: {rendered.error || tex}
          </div>
        )}
      </div>

      {/* Collapsible Symbols Inspector */}
      {symbolsOpen && variables.length > 0 && (
        <div className="my-2 p-2.5 rounded-xl border border-violet-900/40 bg-[#0B0918] space-y-1.5 text-xs">
          <span className="font-semibold text-violet-300 uppercase tracking-wider text-[10px] block">
            Inspektor Symboli i Parametrów
          </span>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {variables.map((v, idx) => (
              <div
                key={`sym-${idx}`}
                className="flex items-center justify-between gap-2 p-1.5 rounded-lg bg-slate-900/60 border border-slate-800 font-mono text-[11px]"
              >
                <span className="font-bold text-cyan-300">${v.symbol}$</span>
                <span className="text-slate-400 truncate">
                  {v.label || (v.value !== undefined ? `${v.value} ${v.unit || ''}` : 'Zmienna dynamiczna')}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Live Interactive Evaluator & Slider Deck */}
      {calculatorOpen && variables.length > 0 && (
        <div className="my-2 p-3 rounded-xl border border-cyan-500/30 bg-[#090D18] space-y-3 text-xs">
          <div className="flex items-center justify-between border-b border-slate-800 pb-1.5">
            <span className="font-semibold text-cyan-300 flex items-center gap-1.5">
              <Sliders className="w-3.5 h-3.5" />
              Interaktywny Przelicznik Wartości
            </span>
            <span className="font-mono text-[10px] text-slate-500">CZAS RZECZYWISTY</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {variables.map((v) => {
              const currentVal = variableValues[v.symbol] ?? v.value ?? 1;
              return (
                <div key={`calc-${v.symbol}`} className="space-y-1 p-2 rounded-lg bg-slate-900/70 border border-slate-800">
                  <div className="flex items-center justify-between font-mono text-[11px]">
                    <span className="text-slate-300 font-bold">Symbol: {v.symbol}</span>
                    <span className="text-cyan-300 font-semibold">{currentVal} {v.unit || ''}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(100, currentVal * 2.5)}
                    step={1}
                    value={currentVal}
                    onChange={(e) => {
                      const num = Number(e.target.value);
                      setVariableValues((prev) => ({ ...prev, [v.symbol]: num }));
                    }}
                    className="w-full accent-cyan-400 cursor-pointer h-1 bg-slate-700 rounded-lg"
                  />
                </div>
              );
            })}
          </div>

          {/* Evaluated Live Output */}
          {evaluatedResult && (
            <div className="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-lg border border-cyan-500/40 bg-cyan-950/20 font-mono text-xs">
              <div>
                <span className="text-slate-400 block text-[10px]">{evaluatedResult.label}</span>
                <span className="text-base font-bold text-cyan-200">
                  {evaluatedResult.val} {evaluatedResult.unit}
                </span>
              </div>
              {onAction && (
                <button
                  type="button"
                  onClick={() =>
                    void onAction(
                      `send:Wartość obliczona dla wzoru ${title}: ${evaluatedResult.val} ${evaluatedResult.unit}`,
                      'Wstawiono wynik do czatu',
                    )
                  }
                  className="px-2.5 py-1 rounded bg-cyan-600 hover:bg-cyan-500 text-white font-medium text-[11px] transition-colors"
                >
                  Wstaw do czatu
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
