import type { Statistics } from '../api/client';
import { formatChartNumber } from './charts/format';
import { useAnimatedNumber } from '../util/animateNumber';

const MTYPE_LABELS: Record<string, string> = {
  P: 'Wirkleistung',
  Q: 'Blindleistung',
  U: 'Spannung',
  I: 'Strom',
};

/** Inline animated number, formatted with the chart number style. */
function AnimatedValue({ value }: { value: number | null | undefined }) {
  const text = useAnimatedNumber(value ?? null, formatChartNumber);
  return <span className="font-mono tabular-nums">{text}</span>;
}

export default function StatsCard({ stats }: { stats: Statistics }) {
  const label = MTYPE_LABELS[stats.measurement_type] || stats.measurement_type;

  // "Active" = the mean value is meaningfully non-zero. When the asset
  // is powered down everything reads 0 and we keep the tile quiet.
  // The 1e-6 cutoff swallows floating-point noise without missing
  // real low-load signals.
  const isActive = Number.isFinite(stats.mean) && Math.abs(stats.mean) > 1e-6;

  return (
    <div
      className={`
        relative bg-gray-800 rounded-lg p-4 border border-gray-700
        ${isActive ? 'animate-grid-pulse' : ''}
      `}
    >
      {/* Lightning glyph — only when the tile is showing an active value */}
      {isActive && (
        <span
          aria-hidden
          title="Aktive Messgröße"
          className="
            absolute top-2 right-2 text-base leading-none
            animate-lightning
          "
          style={{ color: 'var(--grid-primary)' }}
        >
          ⚡
        </span>
      )}

      <h3 className="text-sm text-gray-400 mb-2">
        {label} ({stats.unit})
      </h3>
      <div className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <span className="text-gray-500">Mittelwert:</span>{' '}
          <span className="text-white ml-1"><AnimatedValue value={stats.mean} /></span>
        </div>
        <div>
          <span className="text-gray-500">Std.Abw.:</span>{' '}
          <span className="text-white ml-1"><AnimatedValue value={stats.std_dev} /></span>
        </div>
        <div>
          <span className="text-gray-500">Min:</span>{' '}
          <span className="text-green-400 ml-1"><AnimatedValue value={stats.min} /></span>
        </div>
        <div>
          <span className="text-gray-500">Max:</span>{' '}
          <span className="text-red-400 ml-1"><AnimatedValue value={stats.max} /></span>
        </div>
        <div className="col-span-2">
          <span className="text-gray-500">Messpunkte:</span>{' '}
          <span className="text-white ml-1 font-mono tabular-nums">
            {stats.count.toLocaleString()}
          </span>
        </div>
      </div>
    </div>
  );
}
