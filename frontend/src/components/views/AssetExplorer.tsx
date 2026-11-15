import { memo, useEffect, useMemo, useState } from 'react';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { DataZoomComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { getRawTimeseries, type TimeseriesData } from '../../api/client';
import { views, utc, type Asset } from '../../api/views';
import ReactECharts from '../charts/ReactECharts';
import { useTimeRange } from '../../hooks/useTimeRange';
import SearchableDropdown from '../SearchableDropdown';
import { useAnalysis } from '../../hooks/useAnalysis';
import { useChartTheme } from '../../hooks/useChartTheme';
import { readAcrossColors } from '../../util/acrossColors';
import { SUMMARY_IDS } from '../../util/acrossScenarios';
import { downloadText, fileSafe, toCsv } from '../../util/csv';
import { SectionCard } from '../across/shared';

echarts.use([LineChart, GridComponent, LegendComponent, TooltipComponent, DataZoomComponent, CanvasRenderer]);

export interface AssetItem { id: string; name: string; class_name: string | null; type: string; nominal_kv?: number | null }

const num = (v: unknown, digits = 1, unit = '') => (typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(digits)}${unit}` : '–');
const range = (v: unknown) => (Array.isArray(v) && v.length === 2 ? `${num(v[0], 3)} … ${num(v[1], 3)}` : '–');

/**
 * One element of the chosen analysis across every scenario: master data, its key figures per scenario (loading or
 * voltage against REF), its n-1 extremes per case and its time course in a chosen scenario against REF.
 */
export default memo(function AssetExplorer({ items, defaultId, codes, requested }: {
  items: AssetItem[];
  /** An element chosen elsewhere (network map); the later of it and the choice in this view wins. */
  requested?: { id: string; at: number } | null;
  /** The element shown first (the most critical branch). */
  defaultId: string | null;
  /** Scenario id -> code shown in the summary (S01, S02 …). */
  codes: Map<string, string>;
}) {
  const theme = useChartTheme();
  const colors = useMemo(() => readAcrossColors(theme.isLight), [theme.isLight]);
  const { analysis } = useAnalysis();
  const [own, setOwn] = useState<{ id: string; at: number } | null>(null);
  const picked = requested && (!own || requested.at > own.at) ? requested.id : own?.id ?? null;
  const setPicked = (id: string | null) => setOwn(id === null ? null : { id, at: Date.now() });
  const elementId = picked && items.some((i) => i.id === picked) ? picked : defaultId;
  const [asset, setAsset] = useState<{ key: string; data: Asset } | null>(null);
  const [error, setError] = useState('');
  const [scenario, setScenario] = useState<string | null>(null);
  const [series, setSeries] = useState<{ key: string; ref: TimeseriesData | null; out: TimeseriesData | null } | null>(null);
  const key = `${elementId}|${analysis}`;

  useEffect(() => {
    if (!elementId) return;
    const controller = new AbortController();
    views.asset(elementId, analysis, controller.signal)
      .then((data) => { setAsset({ key, data }); setError(''); })
      .catch(() => { if (!controller.signal.aborted) setError('This element could not be loaded.'); });
    return () => controller.abort();
  }, [key, elementId, analysis]);

  const shown = asset?.key === key ? asset.data : null;
  // The chosen scenario, else the one with the element's highest value (the one worth looking at first).
  const worst = useMemo(() => {
    const value = (cell: Record<string, unknown>) => (typeof cell.value === 'number' ? cell.value : -Infinity);
    return shown ? [...shown.scenarios].sort((a, b) => value(b.cell) - value(a.cell))[0] ?? null : null;
  }, [shown]);
  const current = shown?.scenarios.find((s) => s.scenario_id === scenario) ?? worst;
  const code = current?.kind === 'bus' ? 'U' : 'L';
  const span = useTimeRange();
  const seriesKey = `${key}|${current?.scenario_id}|${span.from}|${span.to}`;

  useEffect(() => {
    if (!current) return;
    let active = true;
    const iso = (t: number | null) => (t === null ? undefined : new Date(t * 1000).toISOString());
    const load = (component: string | undefined) =>
      component ? getRawTimeseries(component, code, iso(span.from), iso(span.to)).catch(() => null) : Promise.resolve(null);
    Promise.all([load(current.components.REF), load(current.components.OUTAGE)])
      .then(([ref, out]) => { if (active) setSeries({ key: seriesKey, ref, out }); });
    return () => { active = false; };
  }, [seriesKey, current, code, span]);

  const shownSeries = series?.key === seriesKey ? series : null;
  const option = useMemo(() => {
    if (!shownSeries || (!shownSeries.ref && !shownSeries.out)) return null;
    const line = (name: string, data: TimeseriesData | null, color: string, dashed: boolean) => ({
      type: 'line' as const, name, showSymbol: false, connectNulls: false, sampling: 'lttb' as const,
      lineStyle: { color, width: dashed ? 1 : 1.6, type: dashed ? 'dashed' as const : 'solid' as const }, itemStyle: { color },
      data: (data?.data ?? []).map((p) => [Date.parse(p.timestamp), p.value]),
    });
    return {
      backgroundColor: 'transparent', textStyle: { color: theme.mutedText, fontSize: 11 },
      legend: { top: 0, textStyle: { color: theme.text, fontSize: 11 } },
      tooltip: { trigger: 'axis', backgroundColor: theme.tooltipBg, borderColor: theme.tooltipBorder, textStyle: { color: theme.text, fontSize: 12 } },
      grid: { left: 8, right: 16, top: 30, bottom: 44, containLabel: true },
      dataZoom: [{ type: 'inside' }, { type: 'slider', height: 14, bottom: 6 }],
      xAxis: { type: 'time', axisLabel: { color: theme.mutedText, fontSize: 10 }, axisLine: { lineStyle: { color: theme.axis } } },
      yAxis: { type: 'value', scale: true, axisLabel: { color: theme.mutedText, fontSize: 10 }, splitLine: { lineStyle: { color: theme.grid } } },
      series: [line('Scenario', shownSeries.out, colors.bands.severe, false), line('REF', shownSeries.ref, theme.mutedText, true)],
    };
  }, [shownSeries, theme, colors]);

  const exportCsv = () => {
    if (!shown) return;
    downloadText(`asset-${fileSafe(shown.element.name)}.csv`, toCsv(
      ['Scenario', 'Name', 'Kind', 'REF max (whole period)', 'Scenario max in window', 'REF max in window', 'Delta pp',
       'Hours over limit', 'Voltage REF', 'Voltage scenario', 'Hours outside band', 'Switched off'],
      shown.scenarios.map((s) => {
        const c = s.cell as Record<string, unknown>;
        return [codes.get(s.scenario_id) ?? s.scenario_id, s.name, s.kind, s.ref_full, c.value as number ?? null,
          c.window_base as number ?? null, c.delta as number ?? null, c.hours_over as number ?? null,
          Array.isArray(c.ref) ? c.ref.join(' … ') : null, Array.isArray(c.out) ? c.out.join(' … ') : null,
          c.hours_outside as number ?? null, Boolean(c.outaged)];
      })));
  };

  const element = shown?.element;
  return (
    <SectionCard
      id={SUMMARY_IDS.asset}
      title={`Asset${element ? ` · ${element.name}` : ''}`}
      hint="One element across every scenario of the analysis: its key figures against REF, its extremes after a contingency per case (n-1), and its course in a chosen scenario against REF. Search by name, class or kV."
      actions={
        <div className="ab-chips">
          <SearchableDropdown
            label="Element"
            items={items}
            idOf={(i) => i.id}
            labelOf={(i) => `${i.name}${i.class_name ? ` (${i.class_name})` : ''}${i.nominal_kv ? ` · ${i.nominal_kv} kV` : ''}`}
            searchOf={(i) => [i.name, i.class_name ?? '', i.nominal_kv ? `${i.nominal_kv} kV` : ''].join(' ')}
            value={elementId}
            onChange={setPicked}
            placeholder="- Element -"
            emptyHint="No elements"
            className="min-w-[240px]"
          />
          {shown && <button type="button" className="ab-chip" onClick={exportCsv}>CSV</button>}
        </div>
      }
    >
      {error && <div className="ab-empty" role="alert">{error}</div>}
      {!elementId && <div className="ab-empty">Choose an element.</div>}
      {elementId && !shown && !error && <div className="ab-empty" aria-busy>Loading element …</div>}
      {element && (
        <p className="across-card__hint">
          {[element.class_name, element.grid ? `grid ${element.grid}` : null, element.nominal_kv ? `${element.nominal_kv} kV` : null,
            `key ${element.element_id.slice(0, 12)}…`, element.mrid ? `mRID ${element.mrid}` : 'no mRID recorded'].filter(Boolean).join(' · ')}
          {element.path && <><br /><span title={element.path}>{element.path}</span></>}
        </p>
      )}
      {shown && shown.scenarios.length > 0 && (
        <div className="ab-scroll">
          <table className="ab-table">
            <thead>
              {current?.kind === 'bus' ? (
                <tr><th>Scenario</th><th className="ab-num">REF voltage</th><th className="ab-num">Scenario voltage</th><th className="ab-num">Hours outside band</th><th /></tr>
              ) : (
                <tr><th>Scenario</th><th className="ab-num">REF max</th><th className="ab-num">Max in window</th><th className="ab-num">REF in window</th><th className="ab-num">Δ</th><th className="ab-num">Hours &gt; limit</th><th /></tr>
              )}
            </thead>
            <tbody>
              {shown.scenarios.map((s) => {
                const c = s.cell as Record<string, unknown>;
                const chosenRow = s.scenario_id === current?.scenario_id;
                return (
                  <tr key={s.scenario_id} aria-selected={chosenRow} onClick={() => setScenario(s.scenario_id)} style={{ cursor: 'pointer' }}>
                    <td><span className="ab-code">{codes.get(s.scenario_id) ?? '–'}</span> {s.name}</td>
                    {s.kind === 'bus' ? (
                      <><td className="ab-num">{range(c.ref)}</td><td className="ab-num">{range(c.out)}</td><td className="ab-num">{num(c.hours_outside, 1, ' h')}</td></>
                    ) : (
                      <><td className="ab-num">{num(s.ref_full, 1, ' %')}</td><td className="ab-num">{c.outaged ? 'switched off' : num(c.value, 1, ' %')}</td>
                        <td className="ab-num">{num(c.window_base, 1, ' %')}</td><td className="ab-num">{num(c.delta, 1, ' pp')}</td><td className="ab-num">{num(c.hours_over, 1, ' h')}</td></>
                    )}
                    <td>{chosenRow ? 'shown below' : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {option && <ReactECharts echarts={echarts} option={option} notMerge style={{ height: 240 }} exportName={`asset-${fileSafe(element?.name ?? 'element')}`} />}
      {shown && shown.n1.length > 0 && (
        <div className="ab-scroll mt-3">
          <table className="ab-table">
            <thead><tr><th>Case</th><th>n-1</th><th className="ab-num">Worst after contingency</th><th>At</th><th>Contingency</th><th className="ab-num">Limit</th><th className="ab-num">Times beyond</th></tr></thead>
            <tbody>
              {shown.n1.map((n) => (
                <tr key={`${n.case_id}|${n.kind}|${n.metric}`}>
                  <td>{n.case_id}</td><td>{n.kind}</td>
                  <td className="ab-num">{n.metric === 'loading' ? num(n.high, 1, ' %') : `${num(n.low, 3)} … ${num(n.high, 3)}`}</td>
                  <td>{n.high_t ? utc(n.high_t) : '–'}</td><td>{n.contingency_name ?? '–'}</td>
                  <td className="ab-num">{n.metric === 'loading' ? num(n.upper, 1, ' %') : `${num(n.lower, 3)} … ${num(n.upper, 3)}`}</td>
                  <td className="ab-num">{n.violation_times}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
});
