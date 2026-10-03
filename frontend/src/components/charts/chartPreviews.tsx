/**
 * Static SVG miniature previews for every ChartKind.
 *
 * Each preview is hand-drawn in a 180×64 coordinate space so it fits neatly
 * inside the ChartTemplatePicker gallery card. Colors use `var(--grid-*)` tokens
 * so they adapt to both dark and light themes automatically.
 *
 * No external dependencies, no runtime data — purely decorative shapes that
 * give the user an immediate visual impression of the chart type.
 */
import type { ReactNode } from 'react';
import type { ChartKind } from './chartTemplates';

/** Shared SVG canvas: 180 × 64 units, fills container width. */
function C({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 180 64" width="100%" height="100%" fill="none" aria-hidden="true">
      {children}
    </svg>
  );
}

// Palette constants — use CSS vars where possible so light/dark theme adapts.
const P  = 'var(--grid-primary)';       // primary blue
const PF = 0.18;                         // primary area-fill opacity
const TEAL   = '#38bdf8';
const AMBER  = '#fbbf24';
const RED    = '#f87171';
const MUTED  = 'currentColor';

// -- Helpers ------------------------------------------------------------------

/** Horizontal grid lines for context. */
function GridLines({ ys }: { ys: number[] }) {
  return (
    <>
      {ys.map((y) => (
        <line key={y} x1="5" y1={y} x2="175" y2={y}
          stroke={MUTED} strokeOpacity="0.08" strokeWidth="0.7" />
      ))}
    </>
  );
}

/** Axes (bottom + left). */
function Axes() {
  return (
    <>
      <line x1="14" y1="6" x2="14" y2="59" stroke={MUTED} strokeOpacity="0.15" strokeWidth="0.8" />
      <line x1="14" y1="59" x2="174" y2="59" stroke={MUTED} strokeOpacity="0.15" strokeWidth="0.8" />
    </>
  );
}

// -- Individual previews -------------------------------------------------------

function OverlayPreview() {
  return (
    <C>
      <GridLines ys={[18, 36, 54]} />
      {/* Line 3 — amber, lowest */}
      <polyline
        points="5,52 25,48 45,54 65,46 85,50 105,44 125,52 145,48 165,52"
        stroke={AMBER} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"
      />
      {/* Line 2 — teal, middle */}
      <polyline
        points="5,40 25,32 45,38 65,24 85,34 105,28 125,38 145,30 165,40"
        stroke={TEAL} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      />
      {/* Line 1 — primary, top */}
      <polyline
        points="5,30 25,16 45,24 65,10 85,20 105,14 125,26 145,18 165,26"
        stroke={P} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      />
    </C>
  );
}

function AggTrendPreview() {
  const pts = '5,52 30,40 55,28 80,20 105,32 130,24 155,18 175,30';
  return (
    <C>
      <GridLines ys={[20, 38, 56]} />
      {/* Min/max envelope */}
      <path
        d="M5,58 30,48 55,36 80,28 105,40 130,32 155,26 175,38
           L175,24 155,12 130,16 105,26 80,14 55,20 30,32 5,46 Z"
        fill={P} fillOpacity="0.10"
      />
      {/* Area fill */}
      <path d={`M ${pts} L175,62 L5,62 Z`} fill={P} fillOpacity={PF} />
      {/* Trend line */}
      <polyline points={pts} stroke={P} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </C>
  );
}

function HistogramPreview() {
  // Bell-curve distribution, 9 bars
  const bars: [number, number][] = [
    [10,8],[28,20],[46,34],[64,46],[82,54],[100,46],[118,32],[136,18],[154,8],
  ];
  const bot = 59;
  return (
    <C>
      <GridLines ys={[18, 38, 58]} />
      {bars.map(([x, h], i) => (
        <rect key={i} x={x} y={bot - h} width={14} height={h}
          fill={P} fillOpacity={0.28 + (h / 54) * 0.55} rx="1.5" />
      ))}
      {/* Bell curve outline */}
      <path d="M10,59 C40,59 54,8 90,7 C126,7 140,59 170,59"
        stroke={P} strokeWidth="1.5" strokeLinecap="round" fill="none" strokeOpacity="0.5" />
    </C>
  );
}

function HeatmapPreview() {
  // 7 cols (days) × 6 rows (time blocks)
  const cw = 22; const ch = 8; const gx = 2; const gy = 2;
  const ox = 7; const oy = 5;
  const heat = [
    [0.15,0.20,0.30,0.40,0.30,0.15,0.08],
    [0.40,0.55,0.65,0.75,0.65,0.40,0.20],
    [0.85,0.90,0.80,0.90,0.85,0.60,0.30],
    [0.70,0.80,0.95,1.00,0.90,0.70,0.40],
    [0.45,0.60,0.70,0.80,0.60,0.40,0.20],
    [0.15,0.20,0.30,0.45,0.25,0.15,0.08],
  ];
  return (
    <C>
      {heat.map((row, ri) =>
        row.map((v, ci) => (
          <rect key={`${ri}-${ci}`}
            x={ox + ci * (cw + gx)} y={oy + ri * (ch + gy)}
            width={cw} height={ch} rx="1.5"
            fill={P} fillOpacity={0.08 + v * 0.87}
          />
        ))
      )}
    </C>
  );
}

function DurationCurvePreview() {
  const pts = '5,10 18,14 30,18 45,24 60,31 75,38 90,44 108,50 125,54 145,57 162,60 175,61';
  return (
    <C>
      <GridLines ys={[20, 40, 60]} />
      <Axes />
      {/* Area */}
      <path d={`M ${pts} L175,62 L5,62 Z`} fill={P} fillOpacity={PF} />
      {/* Curve */}
      <polyline points={pts} stroke={P} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {/* Sample point marker */}
      <circle cx="75" cy="38" r="3" fill={P} />
      <line x1="75" y1="38" x2="75" y2="62" stroke={P} strokeWidth="0.8" strokeDasharray="2 2" strokeOpacity="0.5" />
    </C>
  );
}

function DailyProfilePreview() {
  // 24-hour profiles — Weekday peaks harder at midday; weekend peaks later + lower
  const weekday =
    '5,52 12,48 19,40 26,30 33,22 40,16 47,14 54,13 61,14 68,16 75,18 82,20 '+
    '89,18 96,16 103,18 110,22 117,28 124,34 131,40 138,44 145,47 152,50 159,51 175,52';
  const weekend =
    '5,56 12,54 19,52 26,50 33,46 40,42 47,38 54,34 61,31 68,30 75,30 82,32 '+
    '89,34 96,36 103,38 110,40 117,42 124,46 131,50 138,53 145,55 152,56 159,57 175,57';
  return (
    <C>
      <GridLines ys={[18, 38, 56]} />
      {/* Weekend (amber) */}
      <polyline points={weekend} stroke={AMBER} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      {/* Weekday (primary) */}
      <polyline points={weekday} stroke={P} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </C>
  );
}

function PeakDemandPreview() {
  // 8 periods; index 3 is the highlighted peak
  const heights = [38, 45, 52, 62, 56, 48, 42, 35];
  const bw = 15; const gap = 5; const ox = 10; const bot = 62;
  const peakIdx = 3;
  return (
    <C>
      <GridLines ys={[20, 40, 60]} />
      {heights.map((h, i) => {
        const isPeak = i === peakIdx;
        // Stacked sub-bar to show contribution breakdown
        const subH = Math.round(h * 0.4);
        return (
          <g key={i}>
            {/* Base portion */}
            <rect x={ox + i * (bw + gap)} y={bot - h} width={bw} height={h - subH}
              rx="1.5" fill={P} fillOpacity={isPeak ? 0.85 : 0.28}
            />
            {/* Sub-contribution */}
            <rect x={ox + i * (bw + gap)} y={bot - subH} width={bw} height={subH}
              rx="1.5" fill={TEAL} fillOpacity={isPeak ? 0.7 : 0.2}
            />
          </g>
        );
      })}
    </C>
  );
}

function CorrelationScatterPreview() {
  // Positive correlation — dots scattered around a rising trend
  const dots: [number, number][] = [
    [22,52],[32,48],[38,44],[46,40],[52,36],[60,32],
    [68,28],[74,26],[82,22],[90,20],[98,16],[106,13],
    [28,50],[56,34],[88,22],[44,42],[76,25],
  ];
  return (
    <C>
      <Axes />
      {/* Trend line */}
      <line x1="16" y1="56" x2="170" y2="10"
        stroke={P} strokeWidth="1.4" strokeDasharray="4 3" strokeOpacity="0.55" />
      {/* Dots */}
      {dots.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r="2.5" fill={P} fillOpacity="0.72" />
      ))}
    </C>
  );
}

function CorrelationScatter3DPreview() {
  const dots: [number, number, string][] = [
    [44,46, P],[58,38, TEAL],[72,33, P],[84,27, AMBER],
    [98,31, TEAL],[108,21, P],[124,24, AMBER],[138,16, TEAL],
  ];
  return (
    <C>
      <line x1="34" y1="52" x2="142" y2="52" stroke={MUTED} strokeOpacity="0.18" strokeWidth="0.9" />
      <line x1="34" y1="52" x2="34" y2="12" stroke={MUTED} strokeOpacity="0.18" strokeWidth="0.9" />
      <line x1="34" y1="52" x2="154" y2="18" stroke={MUTED} strokeOpacity="0.18" strokeWidth="0.9" />
      <path d="M58,44 L154,18 L154,48 L58,58 Z" fill={P} fillOpacity="0.06" stroke={MUTED} strokeOpacity="0.10" />
      {dots.map(([x, y, color], i) => (
        <circle key={i} cx={x} cy={y} r="2.8" fill={color} fillOpacity="0.78" />
      ))}
    </C>
  );
}

function CorrelationMatrixPreview() {
  // 4×4 symmetric matrix, diagonal = 1.0 (full primary), off-diagonal varies
  const vals: number[][] = [
    [1.00,  0.78,  0.42, -0.18],
    [0.78,  1.00,  0.61,  0.12],
    [0.42,  0.61,  1.00,  0.50],
    [-0.18, 0.12,  0.50,  1.00],
  ];
  const cw = 38; const ch = 13; const gx = 2; const gy = 2;
  const ox = 9; const oy = 4;
  return (
    <C>
      {vals.map((row, ri) =>
        row.map((v, ci) => {
          const isPos = v >= 0;
          return (
            <rect key={`${ri}-${ci}`}
              x={ox + ci * (cw + gx)} y={oy + ri * (ch + gy)}
              width={cw} height={ch} rx="2"
              fill={isPos ? P : RED} fillOpacity={0.08 + Math.abs(v) * 0.82}
            />
          );
        })
      )}
    </C>
  );
}

function BoxplotPreview() {
  // 3 horizontal box-and-whisker plots, different spreads
  const plots = [
    { y: 16, min: 25, q1: 55, med: 80,  q3: 110, max: 148 },
    { y: 32, min: 18, q1: 42, med: 90,  q3: 128, max: 158 },
    { y: 48, min: 32, q1: 62, med: 105, q3: 138, max: 162 },
  ];
  // Scale [0,180] → [16,166]
  const sc = (v: number) => 16 + (v / 180) * 150;
  return (
    <C>
      {plots.map((p, i) => (
        <g key={i}>
          {/* Left whisker */}
          <line x1={sc(p.min)} y1={p.y} x2={sc(p.q1)} y2={p.y}
            stroke={P} strokeWidth="1.5" strokeOpacity="0.55" />
          {/* Right whisker */}
          <line x1={sc(p.q3)} y1={p.y} x2={sc(p.max)} y2={p.y}
            stroke={P} strokeWidth="1.5" strokeOpacity="0.55" />
          {/* Whisker caps */}
          {[p.min, p.max].map((v) => (
            <line key={v} x1={sc(v)} y1={p.y - 4} x2={sc(v)} y2={p.y + 4}
              stroke={P} strokeWidth="1.5" strokeOpacity="0.55" />
          ))}
          {/* IQR box */}
          <rect
            x={sc(p.q1)} y={p.y - 7}
            width={sc(p.q3) - sc(p.q1)} height={14}
            rx="1.5" fill={P} fillOpacity="0.20" stroke={P} strokeWidth="1.2"
          />
          {/* Median */}
          <line x1={sc(p.med)} y1={p.y - 7} x2={sc(p.med)} y2={p.y + 7}
            stroke={P} strokeWidth="2.2" />
        </g>
      ))}
    </C>
  );
}

function PowerFactorPreview() {
  // cos φ oscillating just below a reference line (pf = 1)
  const line =
    '5,28 16,24 27,20 38,24 49,30 60,26 71,22 82,26 93,30 104,26 115,22 126,26 137,30 148,26 159,22 170,26';
  return (
    <C>
      <GridLines ys={[18, 36, 54]} />
      {/* Reference cos φ = 1 */}
      <line x1="5" y1="18" x2="175" y2="18"
        stroke={AMBER} strokeWidth="1.3" strokeDasharray="5 3" strokeOpacity="0.85" />
      {/* Reactive-loss band */}
      <path
        d={'M 5,28 16,24 27,20 38,24 49,30 60,26 71,22 82,26 93,30 104,26 115,22 126,26 137,30 148,26 159,22 170,26 L170,18 5,18 Z'}
        fill={AMBER} fillOpacity="0.10"
      />
      {/* cos φ line */}
      <polyline points={line} stroke={P} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {/* Area under pf line */}
      <path d={`M ${line} L170,62 L5,62 Z`} fill={P} fillOpacity={PF} />
    </C>
  );
}

function ExceedancePreview() {
  const pts = '5,57 25,52 45,42 65,32 85,20 105,26 125,36 145,46 165,54 175,57';
  const thresh = 33;
  return (
    <C>
      <GridLines ys={[20, 40, 60]} />
      {/* Base area fill */}
      <path d={`M ${pts} L175,62 L5,62 Z`} fill={P} fillOpacity={PF} />
      {/* Exceedance highlight (above threshold) */}
      <path
        d={`M65,${thresh} L85,20 L105,26 L125,${thresh} Z`}
        fill={RED} fillOpacity="0.32"
      />
      {/* Threshold line */}
      <line x1="5" y1={thresh} x2="175" y2={thresh}
        stroke={AMBER} strokeWidth="1.4" strokeDasharray="5 3" strokeOpacity="0.85" />
      {/* Value line */}
      <polyline points={pts} stroke={P} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </C>
  );
}

function QualityPreview() {
  // Day-hour heatmap with scattered grey "missing" cells
  const cw = 22; const ch = 8; const gx = 2; const gy = 2;
  const ox = 7; const oy = 5;
  // 1 = data present, 0 = missing
  const grid = [
    [1, 1, 0, 1, 1, 1, 1],
    [1, 1, 1, 0, 1, 1, 0],
    [0, 1, 1, 1, 1, 0, 1],
    [1, 1, 1, 0, 1, 1, 1],
    [1, 0, 1, 1, 0, 1, 1],
    [1, 1, 1, 1, 1, 1, 0],
  ];
  return (
    <C>
      {grid.map((row, ri) =>
        row.map((v, ci) => (
          <rect key={`${ri}-${ci}`}
            x={ox + ci * (cw + gx)} y={oy + ri * (ch + gy)}
            width={cw} height={ch} rx="1.5"
            fill={v ? P : MUTED} fillOpacity={v ? 0.65 : 0.10}
          />
        ))
      )}
    </C>
  );
}

function DstPreview() {
  // 24 hour bars; bar 2 is missing (spring gap), bar 3 is amber (flagged)
  const rawH = [
    12, 10, /* gap */ 0, 18, 24, 32, 40, 44, 46, 44, 42, 40,
    38, 36, 34, 32, 34, 38, 42, 40, 34, 26, 20, 14,
  ];
  const bw = 5; const gap = 1.5; const ox = 7; const bot = 60;
  return (
    <C>
      <GridLines ys={[20, 40, 58]} />
      {rawH.map((h, i) => {
        if (h === 0) return null;
        const isGap   = i === 3;  // hour that's flagged amber
        const isMiss  = i === 2;  // hour that's absent (spring forward)
        return (
          <rect key={i}
            x={ox + i * (bw + gap)} y={bot - h} width={bw} height={h}
            rx="0.8"
            fill={isGap || isMiss ? AMBER : P}
            fillOpacity={isGap || isMiss ? 0.85 : 0.70}
          />
        );
      })}
      {/* Gap annotation line */}
      <line
        x1={ox + 2 * (bw + gap) + bw / 2} y1="14"
        x2={ox + 2 * (bw + gap) + bw / 2} y2={bot}
        stroke={RED} strokeWidth="0.9" strokeDasharray="2 2" strokeOpacity="0.7"
      />
    </C>
  );
}

function SeasonRadarPreview() {
  const cx = 90; const cy = 32; const r = 26;
  const n = 12;
  // Monthly values — higher in summer, lower in winter
  const vals = [0.48, 0.42, 0.52, 0.66, 0.78, 0.90, 1.00, 0.94, 0.80, 0.64, 0.50, 0.44];
  const angles = Array.from({ length: n }, (_, i) => (i / n) * Math.PI * 2 - Math.PI / 2);

  const toXY = (i: number, scale = 1) => ({
    x: cx + Math.cos(angles[i]) * r * scale,
    y: cy + Math.sin(angles[i]) * r * scale,
  });

  const outerRing = angles.map((a) => `${cx + Math.cos(a) * r},${cy + Math.sin(a) * r}`).join(' ');
  const midRing   = angles.map((a) => `${cx + Math.cos(a) * r * 0.6},${cy + Math.sin(a) * r * 0.6}`).join(' ');
  const dataPath  = vals.map((v, i) => {
    const { x, y } = toXY(i, v);
    return `${x},${y}`;
  }).join(' ');

  return (
    <C>
      {/* Background rings */}
      <polygon points={outerRing} fill="none" stroke={MUTED} strokeOpacity="0.12" strokeWidth="0.8" />
      <polygon points={midRing}   fill="none" stroke={MUTED} strokeOpacity="0.10" strokeWidth="0.7" />
      {/* Spokes */}
      {angles.map((a, i) => (
        <line key={i}
          x1={cx} y1={cy}
          x2={cx + Math.cos(a) * r} y2={cy + Math.sin(a) * r}
          stroke={MUTED} strokeOpacity="0.10" strokeWidth="0.6"
        />
      ))}
      {/* Data polygon */}
      <polygon points={dataPath} fill={P} fillOpacity="0.22" stroke={P} strokeWidth="1.6" strokeLinejoin="round" />
      {/* Data point dots */}
      {vals.map((v, i) => {
        const { x, y } = toXY(i, v);
        return <circle key={i} cx={x} cy={y} r="1.8" fill={P} />;
      })}
    </C>
  );
}

function ComingSoonPreview() {
  return (
    <C>
      {/* Muted placeholder bars */}
      {([28, 42, 36, 52, 30, 44] as number[]).map((h, i) => (
        <rect key={i}
          x={12 + i * 28} y={62 - h} width={18} height={h}
          rx="2" fill={MUTED} fillOpacity="0.08"
        />
      ))}
      {/* Lock icon */}
      <rect x="74" y="20" width="32" height="24" rx="4"
        fill={MUTED} fillOpacity="0.10" stroke={MUTED} strokeOpacity="0.18" strokeWidth="1" />
      <path d="M80,20 C80,12 100,12 100,20"
        fill="none" stroke={MUTED} strokeOpacity="0.18" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="90" cy="32" r="3" fill={MUTED} fillOpacity="0.22" />
    </C>
  );
}

// -- Registry ------------------------------------------------------------------

type PreviewFn = () => React.JSX.Element;

const PREVIEW_MAP: Record<ChartKind, PreviewFn> = {
  overlay:            OverlayPreview,
  aggTrend:           AggTrendPreview,
  histogram:          HistogramPreview,
  heatmap:            HeatmapPreview,
  durationCurve:      DurationCurvePreview,
  dailyProfile:       DailyProfilePreview,
  peakDemand:         PeakDemandPreview,
  correlationScatter: CorrelationScatterPreview,
  correlationScatter3: CorrelationScatterPreview,
  correlationScatter3d: CorrelationScatter3DPreview,
  correlationMatrix:  CorrelationMatrixPreview,
  boxplot:            BoxplotPreview,
  powerFactor:        PowerFactorPreview,
  exceedance:         ExceedancePreview,
  quality:            QualityPreview,
  dst:                DstPreview,
  seasonRadar:        SeasonRadarPreview,
  // Client-side derived charts — reuse the visually-closest existing preview.
  pqQuadrant:         CorrelationScatterPreview,
  quScatter:          CorrelationScatterPreview,
  energyIntegral:     AggTrendPreview,
  lossesEfficiency:   OverlayPreview,
  assetLoading:       AggTrendPreview,
  overloadDuration:   DurationCurvePreview,
  rollingEnvelope:    AggTrendPreview,
  thresholdBands:     ExceedancePreview,
  anomalyScore:       ExceedancePreview,
  voltageCompliance:  ExceedancePreview,
  comingSoon:         ComingSoonPreview,
};

// -- Public component ----------------------------------------------------------

export function ChartPreview({ kind }: { kind: ChartKind }) {
  const Render = PREVIEW_MAP[kind] ?? ComingSoonPreview;
  return (
    <div
      className="mb-2.5 w-full overflow-hidden rounded-md"
      style={{ height: 68, background: 'var(--grid-subpanel, rgba(0,0,0,0.25))' }}
    >
      <Render />
    </div>
  );
}
