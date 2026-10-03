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

function BarsPreview() {
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

// -- Registry ------------------------------------------------------------------

type PreviewFn = () => React.JSX.Element;

const PREVIEW_MAP: Record<ChartKind, PreviewFn> = {
  acrossLoading:      BarsPreview,
  acrossTime:         ExceedancePreview,
  acrossDelta:        BarsPreview,
  acrossLodf:         CorrelationScatterPreview,
  acrossVoltage:      BarsPreview,
  acrossVoltageDelta: BarsPreview,
  overlay:            OverlayPreview,
  aggTrend:           AggTrendPreview,
  histogram:          HistogramPreview,
  durationCurve:      DurationCurvePreview,
  correlationScatter: CorrelationScatterPreview,
  correlationScatter3: CorrelationScatterPreview,
  correlationScatter3d: CorrelationScatter3DPreview,
  correlationMatrix:  CorrelationMatrixPreview,
  boxplot:            BoxplotPreview,
  exceedance:         ExceedancePreview,
  // Client-side derived charts reuse the visually closest preview.
  rollingEnvelope:    AggTrendPreview,
  thresholdBands:     ExceedancePreview,
  anomalyScore:       ExceedancePreview,
  voltageCompliance:  ExceedancePreview,
};

// -- Public component ----------------------------------------------------------

export function ChartPreview({ kind }: { kind: ChartKind }) {
  const Render = PREVIEW_MAP[kind];
  return (
    <div
      className="mb-2.5 w-full overflow-hidden rounded-md"
      style={{ height: 68, background: 'var(--grid-subpanel, rgba(0,0,0,0.25))' }}
    >
      <Render />
    </div>
  );
}
