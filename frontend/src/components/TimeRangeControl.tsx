import { useTimeRange, setTimeRange } from '../hooks/useTimeRange';
import { formatUtc, isWhole, parseUtc, WHOLE_PERIOD } from '../util/timeRange';

/** From/to (UTC) of every time course: the network-at-a-time course and the asset time series. */
export default function TimeRangeControl() {
  const range = useTimeRange();
  return (
    <div className="ab-chips" role="group" aria-label="Time range of the time courses (UTC)">
      <span className="ab-sub">Time range (UTC)</span>
      <input type="datetime-local" className="ab-control" aria-label="From (UTC)" value={formatUtc(range.from)}
        onChange={(e) => setTimeRange({ ...range, from: parseUtc(e.target.value) })} />
      <span className="ab-sub">–</span>
      <input type="datetime-local" className="ab-control" aria-label="To (UTC)" value={formatUtc(range.to)}
        onChange={(e) => setTimeRange({ ...range, to: parseUtc(e.target.value) })} />
      {!isWhole(range) && (
        <button type="button" className="ab-chip" onClick={() => setTimeRange(WHOLE_PERIOD)} title="Show the whole period again">Whole period</button>
      )}
    </div>
  );
}
