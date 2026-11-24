import React, { useMemo, useState } from 'react';
import {
  BarChart3,
  Check,
  Copy,
  Gauge,
  LineChart,
  PieChart,
  Radar as RadarIcon,
  Table,
} from 'lucide-react';
import { ParsedChartToken } from '../utils/chatInteractiveTokens';

interface InteractiveChartWidgetProps {
  chart: ParsedChartToken;
  onAction?: (actionValue: string, label?: string) => void | Promise<void>;
}

const PALETTE = [
  '#06b6d4', // cyan-500
  '#8b5cf6', // violet-500
  '#10b981', // emerald-500
  '#f59e0b', // amber-500
  '#ec4899', // pink-500
  '#3b82f6', // blue-500
  '#14b8a6', // teal-500
];

export const InteractiveChartWidget: React.FC<InteractiveChartWidgetProps> = ({ chart }) => {
  const [viewMode, setViewMode] = useState<'chart' | 'table'>('chart');
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [hoveredSeries, setHoveredSeries] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  const { labels, series, unit = '', title, type, subtitle } = chart;

  const stats = useMemo(() => {
    const allVals = series.flatMap((s) => s.values);
    if (allVals.length === 0) return { min: 0, max: 0, avg: 0, sum: 0 };
    const sum = allVals.reduce((acc, v) => acc + v, 0);
    const min = Math.min(...allVals);
    const max = Math.max(...allVals);
    const avg = sum / allVals.length;
    return { min, max, avg, sum };
  }, [series]);

  const handleCopyJson = () => {
    try {
      const payload = {
        title,
        type,
        labels,
        series,
        unit,
        stats,
      };
      void navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  const getIcon = () => {
    switch (type) {
      case 'line':
        return <LineChart className="w-4 h-4 text-cyan-400" />;
      case 'donut':
        return <PieChart className="w-4 h-4 text-violet-400" />;
      case 'radar':
        return <RadarIcon className="w-4 h-4 text-emerald-400" />;
      case 'gauge':
        return <Gauge className="w-4 h-4 text-amber-400" />;
      default:
        return <BarChart3 className="w-4 h-4 text-cyan-400" />;
    }
  };

  // SVG Chart Dimensions
  const width = 540;
  const height = type === 'radar' ? 260 : type === 'gauge' ? 220 : 230;
  const padding = { top: 25, right: 30, bottom: 35, left: 45 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  // Max value with padding for axis
  const maxVal = Math.max(stats.max * 1.15, 1);
  const minVal = Math.min(stats.min < 0 ? stats.min * 1.15 : 0, 0);
  const valRange = maxVal - minVal || 1;

  const renderLineChart = () => {
    const ptCount = labels.length;
    const xStep = ptCount > 1 ? chartW / (ptCount - 1) : chartW / 2;

    return (
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto overflow-visible select-none">
        <defs>
          {series.map((s, idx) => {
            const col = s.color || PALETTE[idx % PALETTE.length];
            return (
              <linearGradient key={`grad-${idx}`} id={`line-grad-${idx}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={col} stopOpacity="0.35" />
                <stop offset="100%" stopColor={col} stopOpacity="0.0" />
              </linearGradient>
            );
          })}
        </defs>

        {/* Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = padding.top + chartH * (1 - ratio);
          const v = minVal + valRange * ratio;
          return (
            <g key={`grid-${ratio}`}>
              <line
                x1={padding.left}
                y1={y}
                x2={padding.left + chartW}
                y2={y}
                stroke="#334155"
                strokeDasharray="3 3"
                strokeOpacity="0.4"
              />
              <text x={padding.left - 6} y={y + 3} textAnchor="end" className="text-[9px] fill-slate-500 font-mono">
                {v.toFixed(v >= 100 ? 0 : 1)}
              </text>
            </g>
          );
        })}

        {/* X Axis Labels */}
        {labels.map((lbl, idx) => {
          const x = padding.left + idx * xStep;
          return (
            <text
              key={`x-lbl-${idx}`}
              x={x}
              y={height - 10}
              textAnchor="middle"
              className={`text-[9px] font-mono transition-colors ${
                hoveredIndex === idx ? 'fill-cyan-300 font-bold' : 'fill-slate-400'
              }`}
            >
              {lbl}
            </text>
          );
        })}

        {/* Series Paths & Areas */}
        {series.map((s, sIdx) => {
          const col = s.color || PALETTE[sIdx % PALETTE.length];
          const pts = s.values.map((v, idx) => {
            const x = padding.left + idx * xStep;
            const y = padding.top + chartH * (1 - (v - minVal) / valRange);
            return { x, y, v };
          });

          if (pts.length === 0) return null;

          let pathD = `M ${pts[0].x} ${pts[0].y}`;
          for (let i = 1; i < pts.length; i++) {
            const prev = pts[i - 1];
            const curr = pts[i];
            const cpX = (prev.x + curr.x) / 2;
            pathD += ` C ${cpX} ${prev.y}, ${cpX} ${curr.y}, ${curr.x} ${curr.y}`;
          }

          const areaD = `${pathD} L ${pts[pts.length - 1].x} ${padding.top + chartH} L ${pts[0].x} ${padding.top + chartH} Z`;

          return (
            <g key={`series-${sIdx}`}>
              <path d={areaD} fill={`url(#line-grad-${sIdx})`} />
              <path
                d={pathD}
                fill="none"
                stroke={col}
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="transition-all duration-300"
              />
              {pts.map((pt, pIdx) => {
                const isHovered = hoveredIndex === pIdx && (hoveredSeries === null || hoveredSeries === sIdx);
                return (
                  <g key={`pt-${sIdx}-${pIdx}`}>
                    <circle
                      cx={pt.x}
                      cy={pt.y}
                      r={isHovered ? 6 : 3.5}
                      fill={col}
                      stroke="#0B101D"
                      strokeWidth="2"
                      className="cursor-pointer transition-all duration-200"
                      onMouseEnter={() => {
                        setHoveredIndex(pIdx);
                        setHoveredSeries(sIdx);
                      }}
                      onMouseLeave={() => {
                        setHoveredIndex(null);
                        setHoveredSeries(null);
                      }}
                    />
                    {isHovered && (
                      <g>
                        <rect
                          x={pt.x - 35}
                          y={pt.y - 32}
                          width="70"
                          height="22"
                          rx="4"
                          fill="#0F172A"
                          stroke={col}
                          strokeWidth="1"
                        />
                        <text
                          x={pt.x}
                          y={pt.y - 18}
                          textAnchor="middle"
                          fill="#F8FAFC"
                          className="text-[10px] font-mono font-bold"
                        >
                          {pt.v} {unit}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
    );
  };

  const renderBarChart = () => {
    const count = labels.length;
    const barGroupW = chartW / (count || 1);
    const subBarCount = series.length;
    const barSpacing = 4;
    const barW = Math.max(6, Math.min(32, (barGroupW - 16) / subBarCount - barSpacing));

    return (
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto overflow-visible select-none">
        {/* Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = padding.top + chartH * (1 - ratio);
          const v = minVal + valRange * ratio;
          return (
            <g key={`bar-grid-${ratio}`}>
              <line
                x1={padding.left}
                y1={y}
                x2={padding.left + chartW}
                y2={y}
                stroke="#334155"
                strokeDasharray="3 3"
                strokeOpacity="0.4"
              />
              <text x={padding.left - 6} y={y + 3} textAnchor="end" className="text-[9px] fill-slate-500 font-mono">
                {v.toFixed(v >= 100 ? 0 : 1)}
              </text>
            </g>
          );
        })}

        {/* Bars */}
        {labels.map((lbl, idx) => {
          const groupCenterX = padding.left + idx * barGroupW + barGroupW / 2;
          const totalGroupWidth = subBarCount * (barW + barSpacing) - barSpacing;
          const groupStartX = groupCenterX - totalGroupWidth / 2;

          return (
            <g key={`bar-group-${idx}`}>
              {series.map((s, sIdx) => {
                const val = s.values[idx] ?? 0;
                const col = s.color || PALETTE[sIdx % PALETTE.length];
                const barH = Math.max(2, chartH * ((val - minVal) / valRange));
                const barX = groupStartX + sIdx * (barW + barSpacing);
                const barY = padding.top + chartH - barH;
                const isHovered = hoveredIndex === idx && (hoveredSeries === null || hoveredSeries === sIdx);

                return (
                  <g key={`bar-${idx}-${sIdx}`}>
                    <rect
                      x={barX}
                      y={barY}
                      width={barW}
                      height={barH}
                      rx="3"
                      fill={col}
                      opacity={isHovered ? 1 : 0.85}
                      className="cursor-pointer transition-all duration-200"
                      onMouseEnter={() => {
                        setHoveredIndex(idx);
                        setHoveredSeries(sIdx);
                      }}
                      onMouseLeave={() => {
                        setHoveredIndex(null);
                        setHoveredSeries(null);
                      }}
                    />
                    {isHovered && (
                      <text
                        x={barX + barW / 2}
                        y={barY - 6}
                        textAnchor="middle"
                        fill="#F8FAFC"
                        className="text-[10px] font-mono font-bold"
                      >
                        {val} {unit}
                      </text>
                    )}
                  </g>
                );
              })}
              <text
                x={groupCenterX}
                y={height - 10}
                textAnchor="middle"
                className={`text-[9px] font-mono transition-colors truncate ${
                  hoveredIndex === idx ? 'fill-cyan-300 font-bold' : 'fill-slate-400'
                }`}
              >
                {lbl.length > 10 ? `${lbl.slice(0, 8)}…` : lbl}
              </text>
            </g>
          );
        })}
      </svg>
    );
  };

  const renderDonutChart = () => {
    const dataItems = series.map((s, idx) => ({
      name: s.name,
      value: s.values[0] ?? 0,
      color: s.color || PALETTE[idx % PALETTE.length],
    }));
    const total = dataItems.reduce((acc, d) => acc + d.value, 0) || 1;
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(chartW, chartH) / 2 - 10;
    const innerRadius = radius * 0.62;

    let cumulativeAngle = -Math.PI / 2;

    return (
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto overflow-visible select-none">
        {dataItems.map((item, idx) => {
          const sliceAngle = (item.value / total) * (Math.PI * 2);
          const startAngle = cumulativeAngle;
          const endAngle = cumulativeAngle + sliceAngle;
          cumulativeAngle = endAngle;

          const isHovered = hoveredIndex === idx;
          const r = isHovered ? radius + 5 : radius;

          const x1 = cx + r * Math.cos(startAngle);
          const y1 = cy + r * Math.sin(startAngle);
          const x2 = cx + r * Math.cos(endAngle);
          const y2 = cy + r * Math.sin(endAngle);

          const ix1 = cx + innerRadius * Math.cos(endAngle);
          const iy1 = cy + innerRadius * Math.sin(endAngle);
          const ix2 = cx + innerRadius * Math.cos(startAngle);
          const iy2 = cy + innerRadius * Math.sin(startAngle);

          const largeArc = sliceAngle > Math.PI ? 1 : 0;
          const pathD = `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} L ${ix1} ${iy1} A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${ix2} ${iy2} Z`;

          const percent = ((item.value / total) * 100).toFixed(1);

          return (
            <g key={`donut-slice-${idx}`}>
              <path
                d={pathD}
                fill={item.color}
                opacity={isHovered ? 1 : 0.88}
                stroke="#090D1A"
                strokeWidth="2"
                className="cursor-pointer transition-all duration-200"
                onMouseEnter={() => setHoveredIndex(idx)}
                onMouseLeave={() => setHoveredIndex(null)}
              />
            </g>
          );
        })}

        {/* Center Readout */}
        <text x={cx} y={cy - 6} textAnchor="middle" fill="#94A3B8" className="text-[10px] font-mono">
          {hoveredIndex !== null ? dataItems[hoveredIndex]?.name : 'SUMA'}
        </text>
        <text x={cx} y={cy + 14} textAnchor="middle" fill="#F8FAFC" className="text-sm font-bold font-mono">
          {hoveredIndex !== null
            ? `${dataItems[hoveredIndex]?.value} ${unit} (${(((dataItems[hoveredIndex]?.value ?? 0) / total) * 100).toFixed(0)}%)`
            : `${total.toFixed(0)} ${unit}`}
        </text>
      </svg>
    );
  };

  const renderRadarChart = () => {
    const count = labels.length;
    if (count < 3) return renderBarChart();

    const cx = width / 2;
    const cy = height / 2;
    const radius = 80;
    const angleStep = (Math.PI * 2) / count;

    const levels = [0.25, 0.5, 0.75, 1];

    return (
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto overflow-visible select-none">
        {/* Background concentric webs */}
        {levels.map((lvl, lIdx) => {
          const webPts = labels.map((_, i) => {
            const angle = i * angleStep - Math.PI / 2;
            const r = radius * lvl;
            return `${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`;
          });
          return (
            <polygon
              key={`web-${lIdx}`}
              points={webPts.join(' ')}
              fill="none"
              stroke="#334155"
              strokeDasharray="2 2"
              strokeOpacity="0.4"
            />
          );
        })}

        {/* Axis lines & Labels */}
        {labels.map((lbl, idx) => {
          const angle = idx * angleStep - Math.PI / 2;
          const x = cx + radius * Math.cos(angle);
          const y = cy + radius * Math.sin(angle);
          const lblX = cx + (radius + 20) * Math.cos(angle);
          const lblY = cy + (radius + 15) * Math.sin(angle);

          return (
            <g key={`axis-${idx}`}>
              <line x1={cx} y1={cy} x2={x} y2={y} stroke="#334155" strokeOpacity="0.5" />
              <text
                x={lblX}
                y={lblY}
                textAnchor="middle"
                dominantBaseline="central"
                className="text-[9px] fill-slate-400 font-mono"
              >
                {lbl}
              </text>
            </g>
          );
        })}

        {/* Series polygons */}
        {series.map((s, sIdx) => {
          const col = s.color || PALETTE[sIdx % PALETTE.length];
          const pts = labels.map((_, idx) => {
            const val = s.values[idx] ?? 0;
            const norm = Math.max(0, Math.min(1, val / maxVal));
            const r = radius * norm;
            const angle = idx * angleStep - Math.PI / 2;
            return {
              x: cx + r * Math.cos(angle),
              y: cy + r * Math.sin(angle),
              val,
            };
          });

          const polyStr = pts.map((p) => `${p.x},${p.y}`).join(' ');

          return (
            <g key={`radar-s-${sIdx}`}>
              <polygon
                points={polyStr}
                fill={col}
                fillOpacity="0.3"
                stroke={col}
                strokeWidth="2"
                className="transition-all duration-300"
              />
              {pts.map((pt, pIdx) => (
                <circle
                  key={`radar-pt-${sIdx}-${pIdx}`}
                  cx={pt.x}
                  cy={pt.y}
                  r="3.5"
                  fill={col}
                  stroke="#0B101D"
                  strokeWidth="1.5"
                />
              ))}
            </g>
          );
        })}
      </svg>
    );
  };

  const renderGaugeChart = () => {
    const val = series[0]?.values[0] ?? 0;
    const minG = 0;
    const maxG = 100;
    const norm = Math.max(0, Math.min(1, (val - minG) / (maxG - minG)));

    const cx = width / 2;
    const cy = height - 40;
    const r = 90;

    const startAngle = Math.PI;
    const endAngle = Math.PI * 2;
    const currentAngle = startAngle + norm * (endAngle - startAngle);

    const x1 = cx - r;
    const y1 = cy;
    const x2 = cx + r;
    const y2 = cy;

    const arcBgD = `M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`;

    const curX = cx + r * Math.cos(currentAngle);
    const curY = cy + r * Math.sin(currentAngle);
    const largeArc = norm > 0.5 ? 1 : 0;
    const arcFillD = `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${curX} ${curY}`;

    const col = norm > 0.85 ? '#ef4444' : norm > 0.65 ? '#f59e0b' : '#06b6d4';

    return (
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto overflow-visible select-none">
        <path d={arcBgD} fill="none" stroke="#334155" strokeWidth="12" strokeLinecap="round" />
        <path d={arcFillD} fill="none" stroke={col} strokeWidth="12" strokeLinecap="round" />

        {/* Center Needle & Text */}
        <circle cx={cx} cy={cy} r="6" fill={col} />
        <line
          x1={cx}
          y1={cy}
          x2={cx + (r - 18) * Math.cos(currentAngle)}
          y2={cy + (r - 18) * Math.sin(currentAngle)}
          stroke={col}
          strokeWidth="3"
          strokeLinecap="round"
        />

        <text x={cx} y={cy - 25} textAnchor="middle" fill="#F8FAFC" className="text-xl font-bold font-mono">
          {val} {unit}
        </text>
        <text x={cx} y={cy - 10} textAnchor="middle" fill="#94A3B8" className="text-[10px] font-mono">
          Wskaźnik telemetryczny ({norm > 0.85 ? 'KRYTYCZNY' : norm > 0.65 ? 'UWAGA' : 'NOMINALNY'})
        </text>
      </svg>
    );
  };

  const renderDataTable = () => {
    return (
      <div className="overflow-x-auto max-h-56 no-scrollbar rounded-lg border border-slate-800 bg-[#060911]">
        <table className="w-full text-[11px] font-mono text-left">
          <thead className="bg-[#0D1525] text-slate-400 border-b border-slate-800 sticky top-0">
            <tr>
              <th className="px-3 py-1.5 font-semibold">Etykieta</th>
              {series.map((s, idx) => (
                <th key={`th-${idx}`} className="px-3 py-1.5 font-semibold text-cyan-300">
                  {s.name} {unit && `(${unit})`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60 text-slate-300">
            {labels.map((lbl, idx) => (
              <tr key={`tr-${idx}`} className="hover:bg-slate-800/30 transition-colors">
                <td className="px-3 py-1.5 font-medium text-slate-200">{lbl}</td>
                {series.map((s, sIdx) => (
                  <td key={`td-${idx}-${sIdx}`} className="px-3 py-1.5 tabular-nums">
                    {s.values[idx] ?? '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div className="my-2.5 w-full max-w-full rounded-2xl border border-cyan-500/30 bg-gradient-to-br from-[#0B111F] via-[#080D1A] to-[#050811] p-3 shadow-lg shadow-black/40 overflow-hidden">
      {/* Chart Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 pb-2 mb-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <div className="p-1 rounded-md bg-cyan-500/10 border border-cyan-500/20">{getIcon()}</div>
          <div className="min-w-0">
            <h4 className="text-xs sm:text-sm font-bold text-cyan-200 truncate">{title}</h4>
            {subtitle && <p className="text-[10px] text-slate-400 truncate">{subtitle}</p>}
          </div>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => setViewMode((m) => (m === 'chart' ? 'table' : 'chart'))}
            className="flex items-center gap-1 px-2 py-0.5 rounded-md border border-slate-700 bg-slate-800/60 hover:bg-slate-700 text-[11px] text-slate-300 transition-colors"
            title={viewMode === 'chart' ? 'Przełącz na widok tabeli danych' : 'Przełącz na widok wykresu'}
          >
            {viewMode === 'chart' ? <Table className="w-3 h-3 text-cyan-400" /> : <BarChart3 className="w-3 h-3 text-cyan-400" />}
            <span>{viewMode === 'chart' ? 'Tabela' : 'Wykres'}</span>
          </button>
          <button
            type="button"
            onClick={handleCopyJson}
            className="flex items-center gap-1 px-2 py-0.5 rounded-md border border-slate-700 bg-slate-800/60 hover:bg-slate-700 text-[11px] text-slate-300 transition-colors"
            title="Kopiuj surowe dane JSON wykresu"
          >
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            <span className="hidden sm:inline">{copied ? 'Skopiowano' : 'Dane'}</span>
          </button>
        </div>
      </div>

      {/* Main View Body */}
      {viewMode === 'chart' ? (
        <div className="w-full">
          {type === 'line' && renderLineChart()}
          {type === 'bar' && renderBarChart()}
          {type === 'donut' && renderDonutChart()}
          {type === 'radar' && renderRadarChart()}
          {type === 'gauge' && renderGaugeChart()}

          {/* Series Legend */}
          {series.length > 1 && (
            <div className="mt-2 pt-2 border-t border-slate-800/60 flex flex-wrap items-center justify-center gap-3 text-[10px] font-mono">
              {series.map((s, idx) => {
                const col = s.color || PALETTE[idx % PALETTE.length];
                return (
                  <div key={`legend-${idx}`} className="flex items-center gap-1.5 text-slate-300">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: col }} />
                    <span>{s.name}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        renderDataTable()
      )}

      {/* KPI Footer Summary */}
      <div className="mt-2.5 pt-2 border-t border-slate-800/60 grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-[10px] font-mono">
        <div className="rounded-lg bg-slate-900/60 p-1 border border-slate-800/60">
          <span className="text-slate-500 block">ŚREDNIA</span>
          <span className="text-slate-200 font-bold">{stats.avg.toFixed(1)} {unit}</span>
        </div>
        <div className="rounded-lg bg-slate-900/60 p-1 border border-slate-800/60">
          <span className="text-slate-500 block">MAKSIMUM</span>
          <span className="text-emerald-300 font-bold">{stats.max.toFixed(1)} {unit}</span>
        </div>
        <div className="rounded-lg bg-slate-900/60 p-1 border border-slate-800/60">
          <span className="text-slate-500 block">MINIMUM</span>
          <span className="text-cyan-300 font-bold">{stats.min.toFixed(1)} {unit}</span>
        </div>
        <div className="rounded-lg bg-slate-900/60 p-1 border border-slate-800/60">
          <span className="text-slate-500 block">SUMA</span>
          <span className="text-violet-300 font-bold">{stats.sum.toFixed(0)} {unit}</span>
        </div>
      </div>
    </div>
  );
};
