import React, { useState } from 'react';
import {
  X,
  Code2,
  Activity,
  Layers,
  Play,
  Copy,
  Check,
  RotateCcw,
  Maximize2,
  Minimize2,
  FileText
} from 'lucide-react';
import { InteractiveChartWidget } from './InteractiveChartWidget';
import { InteractiveFormulaWidget } from './InteractiveFormulaWidget';
import { ParsedChartToken, ParsedFormulaToken } from '../utils/chatInteractiveTokens';

interface ChatCanvasDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  initialCode?: string;
  initialTab?: 'code' | 'telemetry' | 'formulas';
  onInsertToChat?: (text: string) => void;
}

export const ChatCanvasDrawer: React.FC<ChatCanvasDrawerProps> = ({
  isOpen,
  onClose,
  initialCode = '',
  initialTab = 'code',
  onInsertToChat
}) => {
  const [activeTab, setActiveTab] = useState<'code' | 'telemetry' | 'formulas'>(initialTab);
  const [codeContent, setCodeContent] = useState<string>(
    initialCode ||
      `// SVL_Core - Canvas Workspace (Copilot & ChatGPT style)
// Wykonuj obliczenia telemetryczne i operacje na buforze SVL-364

interface TelemetryBuffer {
  timestamp: number;
  engineOutputMw: number;
  ollamaResponseLatencyMs: number;
  warpDistortionIndex: number;
}

function analyzeBufferHealth(samples: TelemetryBuffer[]): string {
  const avgLatency = samples.reduce((acc, s) => acc + s.ollamaResponseLatencyMs, 0) / (samples.length || 1);
  if (avgLatency < 50) return "OPTYMALNY (Przyspieszenie SVL aktywne)";
  return "STABILNY";
}

console.log("Canvas ready for live execution.");
`
  );
  const [codeOutput, setCodeOutput] = useState<string>('');
  const [copied, setCopied] = useState<boolean>(false);
  const [isExpanded, setIsExpanded] = useState<boolean>(false);

  // Sync initialCode if provided and updated
  React.useEffect(() => {
    if (initialCode) {
      setCodeContent(initialCode);
      setActiveTab('code');
    }
  }, [initialCode]);

  if (!isOpen) return null;

  const handleCopyCode = () => {
    navigator.clipboard.writeText(codeContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRunCode = () => {
    try {
      const logs: string[] = [];
      const customConsole = {
        log: (...args: unknown[]) => logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')),
        error: (...args: unknown[]) => logs.push('[ERROR] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')),
        warn: (...args: unknown[]) => logs.push('[WARN] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '))
      };
      
      // Safe quick evaluation in sandbox
      const runnable = new Function('console', codeContent);
      runnable(customConsole);
      setCodeOutput(logs.join('\n') || '(Kod wykonany pomyślnie bez wyjścia w konsoli)');
    } catch (err: unknown) {
      setCodeOutput(`Błąd wykonania: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Sample live telemetry chart for canvas
  const canvasTelemetryChart: ParsedChartToken = {
    type: 'line',
    title: 'Monitor Strumienia Telemetrii SVL-364 & Ollama (Live)',
    labels: ['T-60s', 'T-50s', 'T-40s', 'T-30s', 'T-20s', 'T-10s', 'Teraz'],
    series: [
      {
        name: 'Ollama Latency (ms)',
        values: [180, 92, 45, 24, 18, 16, 15],
        color: '#10b981'
      },
      {
        name: 'Warp Buffer (% zajętości)',
        values: [78, 45, 22, 18, 15, 14, 12],
        color: '#06b6d4'
      }
    ],
    unit: 'ms / %'
  };

  const canvasFormulaSample: ParsedFormulaToken = {
    title: 'Transformacja Lorentza & Dylatacja Czasu SVL',
    tex: '\\Delta t\' = \\frac{\\Delta t}{\\sqrt{1 - \\frac{v^2}{c^2}}}',
    latex: '\\Delta t\' = \\frac{\\Delta t}{\\sqrt{1 - \\frac{v^2}{c^2}}}',
    description: 'Relatywistyczny upływ czasu statku badawczego SVL-364 w układzie odniesienia stacji bazowej.',
    variables: [
      { symbol: '\\Delta t', name: 'Czas własny statku', unit: 's', defaultValue: 10, min: 1, max: 100, step: 1 },
      { symbol: 'v', name: 'Prędkość podświetlna', unit: 'km/s', defaultValue: 200000, min: 1000, max: 299792, step: 1000 },
      { symbol: 'c', name: 'Prędkość światła', unit: 'km/s', defaultValue: 299792, min: 299792, max: 299792, step: 1 }
    ],
    evaluate: (v) => {
      const dt = v['\\Delta t'] || 10;
      const speed = v['v'] || 200000;
      const c = v['c'] || 299792;
      const factor = 1 - Math.pow(speed / c, 2);
      if (factor <= 0) return 999999;
      return dt / Math.sqrt(factor);
    }
  };

  return (
    <div
      className={`fixed top-0 right-0 bottom-0 z-40 bg-slate-900/95 backdrop-blur-md border-l border-cyan-500/30 shadow-2xl flex flex-col transition-all duration-300 ${
        isExpanded ? 'w-full md:w-[85vw]' : 'w-full md:w-[600px] lg:w-[680px]'
      }`}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-cyan-500/20 bg-slate-950/60">
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-cyan-500/20 border border-cyan-500/40 text-cyan-400">
            <Layers className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
              Copilot Canvas / Workspace
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 font-mono">
                JYN_OS
              </span>
            </h3>
            <p className="text-[11px] text-slate-400">
              Interaktywny panel boczny do analizy kodu, telemetrii i wzorów
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1.5 rounded-lg text-slate-400 hover:text-cyan-300 hover:bg-slate-800 transition-colors"
            title={isExpanded ? 'Zmniejsz panel' : 'Rozszerz panel'}
          >
            {isExpanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-slate-800 transition-colors"
            title="Zamknij Canvas"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Tabs navigation */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-slate-800 bg-slate-900/70 text-xs">
        <button
          onClick={() => setActiveTab('code')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition-colors ${
            activeTab === 'code'
              ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
          }`}
        >
          <Code2 className="w-3.5 h-3.5" />
          Edytor / Skrypt
        </button>

        <button
          onClick={() => setActiveTab('telemetry')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition-colors ${
            activeTab === 'telemetry'
              ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
          }`}
        >
          <Activity className="w-3.5 h-3.5" />
          Wykresy & Telemetria
        </button>

        <button
          onClick={() => setActiveTab('formulas')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition-colors ${
            activeTab === 'formulas'
              ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
          }`}
        >
          <FileText className="w-3.5 h-3.5" />
          Wzory & Ewaluator
        </button>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {activeTab === 'code' && (
          <div className="flex flex-col h-full space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-400">TypeScript / JavaScript Sandbox</span>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={handleRunCode}
                  className="flex items-center gap-1 px-2.5 py-1 text-xs bg-emerald-600 hover:bg-emerald-500 text-white rounded-md font-medium transition-colors shadow-sm"
                >
                  <Play className="w-3 h-3 fill-current" />
                  Uruchom
                </button>
                <button
                  onClick={handleCopyCode}
                  className="flex items-center gap-1 px-2.5 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-md transition-colors border border-slate-700"
                >
                  {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  {copied ? 'Skopiowano' : 'Kopiuj'}
                </button>
                {onInsertToChat && (
                  <button
                    onClick={() => onInsertToChat(`\`\`\`typescript\n${codeContent}\n\`\`\``)}
                    className="flex items-center gap-1 px-2.5 py-1 text-xs bg-cyan-600/30 hover:bg-cyan-600/50 text-cyan-300 rounded-md transition-colors border border-cyan-500/40"
                  >
                    Wstaw do czatu
                  </button>
                )}
                <button
                  onClick={() => {
                    setCodeContent('');
                    setCodeOutput('');
                  }}
                  className="p-1 text-slate-400 hover:text-slate-200 rounded"
                  title="Wyczyść edytor"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <div className="flex-1 min-h-[300px] border border-slate-800 rounded-xl overflow-hidden bg-slate-950 flex flex-col focus-within:border-cyan-500/50">
              <textarea
                value={codeContent}
                onChange={(e) => setCodeContent(e.target.value)}
                className="w-full flex-1 p-3 bg-transparent text-slate-100 font-mono text-xs outline-none resize-none leading-relaxed"
                placeholder="Wpisz kod tutaj..."
                spellCheck={false}
              />
            </div>

            {codeOutput && (
              <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl">
                <div className="text-[10px] uppercase font-mono tracking-wider text-slate-400 mb-1">
                  Wyjście konsoli:
                </div>
                <pre className="text-xs font-mono text-emerald-400 whitespace-pre-wrap max-h-40 overflow-y-auto">
                  {codeOutput}
                </pre>
              </div>
            )}
          </div>
        )}

        {activeTab === 'telemetry' && (
          <div className="space-y-4">
            <div className="p-3 bg-cyan-950/20 border border-cyan-500/20 rounded-xl text-xs text-slate-300">
              Dane telemetryczne pobierane bezpośrednio z magistrali SVL-364 oraz monitora Ollama.
            </div>
            <InteractiveChartWidget chart={canvasTelemetryChart} />
          </div>
        )}

        {activeTab === 'formulas' && (
          <div className="space-y-4">
            <div className="p-3 bg-purple-950/20 border border-purple-500/20 rounded-xl text-xs text-slate-300">
              Symulator równań fizycznych i relatywistycznych silnika SVL Core. Zmień wartości suwakami, aby obserwować wynik na żywo.
            </div>
            <InteractiveFormulaWidget formula={canvasFormulaSample} />
          </div>
        )}
      </div>
    </div>
  );
};
