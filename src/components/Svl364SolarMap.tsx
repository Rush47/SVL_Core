import React, { useMemo, useState } from 'react';
import { Compass, Navigation, Radio, ShieldCheck, ZoomIn, ZoomOut } from 'lucide-react';

export interface SolarBodyPoint {
  id: string;
  name: string;
  au: number;
  periodDays: number;
  angleDeg: number;
  xAu: number;
  yAu: number;
  kind: 'planet' | 'station' | 'belt';
  color: string;
  radius: number;
  hasRings?: boolean;
  parent?: string;
}

export interface FleetMarker {
  id: string;
  name: string;
  bodyId: string;
  xAu: number;
  yAu: number;
  au: number;
  angleDeg: number;
  status: string;
}

export interface ShipNavigationData {
  sector: string;
  currentBody: string;
  currentBodyName: string;
  targetBody: string;
  targetBodyName: string;
  missionStatus: string;
  au: number;
  angleDeg: number;
  xAu: number;
  yAu: number;
  velocityKms: number;
  altitudeKm: number;
  distanceFromEarthAu: number;
  lightDelayEarthSec: number;
  distanceToTargetAu: number;
  lightDelayTargetSec: number;
  transponder: string;
  note: string;
  solarDefenseReadActive: boolean;
  allianceDefenseActive: boolean;
  bodies: SolarBodyPoint[];
  fleetMarkers: FleetMarker[];
  epochUtc: string;
  updatedAt: string;
}

interface Svl364SolarMapProps {
  navigation: ShipNavigationData | null;
  savingCourse: boolean;
  onUpdateCourse: (payload: {
    currentBody?: string;
    targetBody?: string;
    missionStatus?: string;
    sector?: string;
  }) => Promise<void>;
}

const CENTER_X = 280;
const CENTER_Y = 230;
const MAX_R = 205;

function formatLightDelay(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const mins = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  return `${mins} min ${rem} s`;
}

function projectAuRadius(au: number, zoomMode: 'full' | 'inner'): number {
  if (au <= 0) return 0;
  if (zoomMode === 'inner') {
    const clamped = Math.min(au, 3.2);
    return 30 + (clamped / 3.2) * (MAX_R - 30);
  }
  const normalized = Math.min(au, 31.0) / 31.0;
  return 28 + Math.pow(normalized, 0.43) * (MAX_R - 28);
}

export const Svl364SolarMap: React.FC<Svl364SolarMapProps> = ({
  navigation,
  savingCourse,
  onUpdateCourse,
}) => {
  const [zoomMode, setZoomMode] = useState<'full' | 'inner'>('full');
  const [selectedBodyId, setSelectedBodyId] = useState<string>('earth-l2');

  const bodies = navigation?.bodies || [];
  const visibleBodies = useMemo(
    () =>
      zoomMode === 'inner'
        ? bodies.filter((b) => b.au <= 3.1)
        : bodies,
    [bodies, zoomMode],
  );

  const projected = useMemo(() => {
    const map = new Map<string, { x: number; y: number; r: number; body: SolarBodyPoint }>();
    for (const b of bodies) {
      const r = projectAuRadius(b.au, zoomMode);
      const rad = (b.angleDeg * Math.PI) / 180;
      // Punkt L2 delikatnie odsunięty radialnie od Ziemi, aby był wyraźnie widoczny
      const radialOffset = b.id === 'earth-l2' ? 14 : 0;
      const x = CENTER_X + Math.cos(rad) * (r + radialOffset);
      const y = CENTER_Y - Math.sin(rad) * (r + radialOffset);
      map.set(b.id, { x, y, r: r + radialOffset, body: b });
    }
    return map;
  }, [bodies, zoomMode]);

  const shipPos = navigation ? projected.get(navigation.currentBody) || projected.get('earth-l2') : undefined;
  const targetPos = navigation ? projected.get(navigation.targetBody) : undefined;
  const selectedBody = bodies.find((b) => b.id === selectedBodyId) || bodies.find((b) => b.id === navigation?.currentBody) || null;

  const selectedDistAu = useMemo(() => {
    if (!navigation || !selectedBody) return 0;
    return Math.hypot(navigation.xAu - selectedBody.xAu, navigation.yAu - selectedBody.yAu);
  }, [navigation, selectedBody]);

  const asteroidBeltR = projectAuRadius(2.77, zoomMode);

  return (
    <section
      aria-label="Mapa Układu Słonecznego i pozycja statku SVL-364"
      className="rounded-xl border border-slate-800/90 bg-[#0B111B] overflow-hidden"
    >
      {/* Header strip */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 bg-[#0E1623] px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-[0.18em] text-cyan-400">
            <Compass className="h-3.5 w-3.5 shrink-0" />
            Astrogacja Heliocentryczna · Epoka J2000 → UTC
          </div>
          <h2 className="text-sm sm:text-base font-semibold text-slate-100 mt-0.5 truncate">
            Układ Słoneczny — bieżąca pozycja: <span className="text-cyan-300">{navigation?.sector || 'Ładowanie efemeryd...'}</span>
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-slate-700/80 bg-[#070B12] p-0.5 text-xs font-mono">
            <button
              type="button"
              onClick={() => setZoomMode('full')}
              className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 transition-colors cursor-pointer ${
                zoomMode === 'full' ? 'bg-cyan-500/20 text-cyan-200' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <ZoomOut className="h-3.5 w-3.5" /> Pełny (30 AU)
            </button>
            <button
              type="button"
              onClick={() => setZoomMode('inner')}
              className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 transition-colors cursor-pointer ${
                zoomMode === 'inner' ? 'bg-cyan-500/20 text-cyan-200' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <ZoomIn className="h-3.5 w-3.5" /> Wewnętrzny (3 AU)
            </button>
          </div>
        </div>
      </div>

      {/* Map + Telemetry Side Panel */}
      <div className="grid grid-cols-1 lg:grid-cols-12">
        {/* Left: Interactive SVG Orbital Plot */}
        <div className="lg:col-span-8 relative bg-[#060A11] p-2 sm:p-3 flex items-center justify-center border-b lg:border-b-0 lg:border-r border-slate-800/80">
          <svg
            viewBox="0 0 560 460"
            className="w-full h-auto max-h-[430px] select-none"
            role="img"
            aria-label="Interaktywna mapa Układu Słonecznego z pozycją statku SVL-364"
          >
            <defs>
              <radialGradient id="svl-sun-glow" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#fef08a" stopOpacity="1" />
                <stop offset="45%" stopColor="#f59e0b" stopOpacity="0.85" />
                <stop offset="100%" stopColor="#f59e0b" stopOpacity="0" />
              </radialGradient>
              <radialGradient id="svl-bg-vignette" cx="50%" cy="50%" r="70%">
                <stop offset="0%" stopColor="#0c1524" />
                <stop offset="100%" stopColor="#05080f" />
              </radialGradient>
            </defs>

            <rect width="560" height="460" fill="url(#svl-bg-vignette)" rx="8" />

            {/* Subtelna siatka kątowa ekliptyki */}
            <line x1={CENTER_X} y1={14} x2={CENTER_X} y2={446} stroke="#1e293b" strokeWidth="0.7" strokeDasharray="3 5" />
            <line x1={24} y1={CENTER_Y} x2={536} y2={CENTER_Y} stroke="#1e293b" strokeWidth="0.7" strokeDasharray="3 5" />
            <text x={526} y={CENTER_Y - 6} textAnchor="end" fill="#475569" fontSize="9" fontFamily="monospace">0° ♈</text>
            <text x={CENTER_X + 6} y={24} fill="#475569" fontSize="9" fontFamily="monospace">90°</text>
            <text x={32} y={CENTER_Y - 6} fill="#475569" fontSize="9" fontFamily="monospace">180°</text>
            <text x={CENTER_X + 6} y={444} fill="#475569" fontSize="9" fontFamily="monospace">270°</text>

            {/* Pas planetoid */}
            {asteroidBeltR <= MAX_R + 4 && (
              <circle
                cx={CENTER_X}
                cy={CENTER_Y}
                r={asteroidBeltR}
                fill="none"
                stroke="#64748b"
                strokeOpacity="0.22"
                strokeWidth="7"
                strokeDasharray="2 7"
              />
            )}

            {/* Orbity planet */}
            {visibleBodies
              .filter((b) => b.kind === 'planet')
              .map((b) => {
                const r = projectAuRadius(b.au, zoomMode);
                const isSel = selectedBody?.id === b.id;
                return (
                  <circle
                    key={`orbit-${b.id}`}
                    cx={CENTER_X}
                    cy={CENTER_Y}
                    r={r}
                    fill="none"
                    stroke={isSel ? '#22d3ee' : '#334155'}
                    strokeOpacity={isSel ? 0.65 : 0.45}
                    strokeWidth={isSel ? 1.2 : 0.8}
                  />
                );
              })}

            {/* Słońce */}
            <circle cx={CENTER_X} cy={CENTER_Y} r={22} fill="url(#svl-sun-glow)" />
            <circle cx={CENTER_X} cy={CENTER_Y} r={8.5} fill="#fde047" />
            <text x={CENTER_X} y={CENTER_Y + 22} textAnchor="middle" fill="#fde68a" fontSize="9" fontFamily="monospace">
              SŁOŃCE
            </text>

            {/* Wektor kursu SVL-364 jeśli w locie */}
            {shipPos && targetPos && navigation && navigation.currentBody !== navigation.targetBody && (
              <g>
                <line
                  x1={shipPos.x}
                  y1={shipPos.y}
                  x2={targetPos.x}
                  y2={targetPos.y}
                  stroke="#f59e0b"
                  strokeWidth="1.6"
                  strokeDasharray="5 4"
                  strokeOpacity="0.9"
                />
                <circle cx={targetPos.x} cy={targetPos.y} r={11} fill="none" stroke="#f59e0b" strokeWidth="1.2" strokeDasharray="3 3" />
              </g>
            )}

            {/* Planety i punkty nawigacyjne */}
            {visibleBodies.map((b) => {
              const p = projected.get(b.id);
              if (!p) return null;
              const isSelected = selectedBody?.id === b.id;
              const isShipHere = navigation?.currentBody === b.id;
              return (
                <g
                  key={b.id}
                  className="cursor-pointer"
                  onClick={() => setSelectedBodyId(b.id)}
                >
                  {isSelected && (
                    <circle cx={p.x} cy={p.y} r={b.radius + 7} fill="none" stroke="#22d3ee" strokeWidth="1.3" strokeOpacity="0.85" />
                  )}
                  {b.hasRings && (
                    <ellipse
                      cx={p.x}
                      cy={p.y}
                      rx={b.radius + 6}
                      ry={b.radius * 0.45}
                      transform={`rotate(-18 ${p.x} ${p.y})`}
                      fill="none"
                      stroke="#fde047"
                      strokeOpacity="0.65"
                      strokeWidth="1.4"
                    />
                  )}
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={b.radius}
                    fill={b.color}
                    stroke="#060A11"
                    strokeWidth="1.5"
                  />
                  {!isShipHere && (
                    <text
                      x={p.x}
                      y={p.y - b.radius - 6}
                      textAnchor="middle"
                      fill={isSelected ? '#e0f2fe' : '#94a3b8'}
                      fontSize={b.id === 'earth-l2' ? '9' : '10'}
                      fontWeight={isSelected ? 'bold' : 'normal'}
                      fontFamily="monospace"
                    >
                      {b.id === 'earth-l2' ? 'L2' : b.name}
                    </text>
                  )}
                </g>
              );
            })}

            {/* Markery floty (SVL-465) */}
            {(navigation?.fleetMarkers || [])
              .filter((fm) => fm.id !== 'apex-citadel')
              .map((fm) => {
                const p = projected.get(fm.bodyId);
                if (!p || (zoomMode === 'inner' && fm.au > 3.1)) return null;
                return (
                  <g key={fm.id}>
                    <rect
                      x={p.x + 10}
                      y={p.y - 4}
                      width="7"
                      height="7"
                      transform={`rotate(45 ${p.x + 13.5} ${p.y - 0.5})`}
                      fill="#34d399"
                      stroke="#060A11"
                      strokeWidth="1"
                    />
                    <text x={p.x + 22} y={p.y + 3} fill="#6ee7b7" fontSize="9" fontFamily="monospace">
                      SVL-465
                    </text>
                  </g>
                );
              })}

            {/* Znacznik statku SVL-364 Ebon Apex */}
            {shipPos && (
              <g
                className="cursor-pointer"
                onClick={() => navigation && setSelectedBodyId(navigation.currentBody)}
              >
                <circle cx={shipPos.x} cy={shipPos.y} r={16} fill="none" stroke="#22d3ee" strokeOpacity="0.35" strokeWidth="1.2">
                  <animate attributeName="r" values="10;22;10" dur="3.2s" repeatCount="indefinite" />
                  <animate attributeName="stroke-opacity" values="0.7;0.05;0.7" dur="3.2s" repeatCount="indefinite" />
                </circle>
                <polygon
                  points={`${shipPos.x},${shipPos.y - 8} ${shipPos.x + 6.5},${shipPos.y + 6} ${shipPos.x},${shipPos.y + 3} ${shipPos.x - 6.5},${shipPos.y + 6}`}
                  fill="#22d3ee"
                  stroke="#050911"
                  strokeWidth="1.2"
                />
                <rect
                  x={shipPos.x + 10}
                  y={shipPos.y - 14}
                  width="64"
                  height="16"
                  rx="3"
                  fill="#0b1829"
                  stroke="#22d3ee"
                  strokeOpacity="0.7"
                  strokeWidth="0.9"
                />
                <text x={shipPos.x + 42} y={shipPos.y - 3} textAnchor="middle" fill="#cffafe" fontSize="9.5" fontWeight="bold" fontFamily="monospace">
                  SVL-364
                </text>
              </g>
            )}
          </svg>
        </div>

        {/* Right: Ship Position, Light Delay & Course Control */}
        <div className="lg:col-span-4 p-4 flex flex-col justify-between gap-4 bg-[#0B111B]">
          <div className="space-y-3">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2">
              <span className="text-[11px] font-mono uppercase tracking-wider text-slate-400">
                Pozycja SVL-364
              </span>
              <span className="rounded bg-cyan-500/15 px-2 py-0.5 font-mono text-[11px] font-semibold text-cyan-300">
                {navigation?.missionStatus || 'ORBIT_HOLD'}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs font-mono">
              <div className="rounded-lg bg-[#070B12] border border-slate-800/80 p-2.5">
                <div className="text-[10px] text-slate-500 uppercase">Odległość od Słońca</div>
                <div className="text-slate-100 font-semibold mt-0.5 tabular-nums">
                  {navigation ? `${navigation.au.toFixed(3)} AU` : '—'}
                </div>
              </div>
              <div className="rounded-lg bg-[#070B12] border border-slate-800/80 p-2.5">
                <div className="text-[10px] text-slate-500 uppercase">Długość eklipt.</div>
                <div className="text-slate-100 font-semibold mt-0.5 tabular-nums">
                  {navigation ? `${navigation.angleDeg.toFixed(1)}°` : '—'}
                </div>
              </div>
              <div className="rounded-lg bg-[#070B12] border border-slate-800/80 p-2.5">
                <div className="text-[10px] text-slate-500 uppercase">Opóźnienie → Ziemia</div>
                <div className="text-emerald-300 font-semibold mt-0.5 tabular-nums">
                  {navigation ? formatLightDelay(navigation.lightDelayEarthSec) : '—'}
                </div>
              </div>
              <div className="rounded-lg bg-[#070B12] border border-slate-800/80 p-2.5">
                <div className="text-[10px] text-slate-500 uppercase">Prędkość orbitalna</div>
                <div className="text-slate-100 font-semibold mt-0.5 tabular-nums">
                  {navigation ? `${navigation.velocityKms} km/s` : '—'}
                </div>
              </div>
            </div>

            <div className="rounded-lg bg-[#070B12] border border-slate-800/80 p-3 space-y-1.5 text-xs font-mono">
              <div className="flex items-center justify-between text-slate-400">
                <span className="flex items-center gap-1.5"><Radio className="h-3.5 w-3.5 text-cyan-400" /> Transponder</span>
                <span className="text-cyan-200 truncate max-w-[175px]" title={navigation?.transponder}>
                  {navigation?.transponder || 'SVL-364-EBON-APEX'}
                </span>
              </div>
              <div className="flex items-center justify-between text-slate-400">
                <span className="flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5 text-emerald-400" /> Most Obrony Układu</span>
                <span className={navigation?.solarDefenseReadActive ? 'text-emerald-300' : 'text-slate-400'}>
                  {navigation?.solarDefenseReadActive ? 'READ_ONLY ACTIVE' : 'STANDBY'}
                </span>
              </div>
            </div>

            {/* Selected Body Telemetry & Course Setter */}
            {selectedBody && (
              <div className="rounded-lg border border-slate-700/70 bg-[#0E1624] p-3 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-100 flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: selectedBody.color }} />
                    {selectedBody.name}
                  </span>
                  <span className="text-[11px] font-mono text-slate-400 tabular-nums">
                    {selectedBody.au.toFixed(3)} AU
                  </span>
                </div>
                <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
                  <span>Dystans od SVL-364: <strong className="text-slate-200">{selectedDistAu.toFixed(3)} AU</strong></span>
                  <span>Sygnał: <strong className="text-cyan-300">{formatLightDelay(selectedDistAu * 499.005)}</strong></span>
                </div>
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  <button
                    type="button"
                    disabled={savingCourse || navigation?.targetBody === selectedBody.id}
                    onClick={() =>
                      void onUpdateCourse({
                        targetBody: selectedBody.id,
                        missionStatus: navigation?.currentBody === selectedBody.id ? 'ORBIT_HOLD' : 'IN_TRANSIT',
                      })
                    }
                    className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md border border-amber-500/45 bg-amber-500/15 hover:bg-amber-500/25 disabled:opacity-40 px-2.5 py-1.5 text-[11px] font-mono font-semibold text-amber-200 transition-colors cursor-pointer"
                  >
                    <Navigation className="h-3 w-3" /> Wyznacz kurs
                  </button>
                  <button
                    type="button"
                    disabled={savingCourse || navigation?.currentBody === selectedBody.id}
                    onClick={() =>
                      void onUpdateCourse({
                        currentBody: selectedBody.id,
                        targetBody: selectedBody.id,
                        sector: selectedBody.name,
                        missionStatus: 'ORBIT_HOLD',
                      })
                    }
                    className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md border border-cyan-500/45 bg-cyan-500/15 hover:bg-cyan-500/25 disabled:opacity-40 px-2.5 py-1.5 text-[11px] font-mono font-semibold text-cyan-200 transition-colors cursor-pointer"
                  >
                    Ustaw pozycję
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-1 pt-2 border-t border-slate-800/70">
            {bodies.map((b) => (
              <button
                key={`pill-${b.id}`}
                type="button"
                onClick={() => setSelectedBodyId(b.id)}
                className={`rounded px-2 py-0.5 text-[10px] font-mono transition-colors cursor-pointer ${
                  selectedBody?.id === b.id
                    ? 'bg-cyan-500/25 text-cyan-200 border border-cyan-500/50'
                    : navigation?.currentBody === b.id
                      ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/35'
                      : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
                }`}
              >
                {b.id === 'earth-l2' ? 'L2' : b.name}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};
