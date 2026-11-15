import { memo, useEffect, useMemo, useState } from 'react';
import * as echarts from 'echarts/core';
import { CustomChart } from 'echarts/charts';
import { DataZoomComponent, GridComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import api from '../../api/client';
import { gridlens, type N1Gantt as Gantt, type NativeResult } from '../../api/gridlens';
import { UNASSIGNED, useAnalysis } from '../../hooks/useAnalysis';
import ReactECharts from '../charts/ReactECharts';
import { useChartTheme } from '../../hooks/useChartTheme';
import { escapeHtml, readAcrossColors } from '../../util/acrossColors';
import { LOADING_BANDS, bandOf } from '../../config/loadingBands';
import { SectionCard } from './shared';
import { SUMMARY_IDS } from '../../util/acrossScenarios';

echarts.use([CustomChart, GridComponent, TooltipComponent, DataZoomComponent, CanvasRenderer]);

const PRIME = "(n-1)'";
const FETCH_LINES = 40;
const DEFAULT_VISIBLE_LINES = 15;
const LINE_OPTIONS = [10, 15, 25, 40] as const;

interface Case { id: string; name: string; results: NativeResult[] }

const when = (t: number) => new Date(t * 1000).toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'short', timeStyle: 'short' });
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '–' : `${v.toFixed(1)} %`);

/** The planning cases of one analysis (default: the newest) with their n-1 and (n-1)' results. */
async function loadCases(analysis: string | null, signal: AbortSignal): Promise<Case[]> {
  const target = analysis ?? (await api.get<{ default: string | null }>('/analyses', { signal })).data.default;
  if (!target || target === UNASSIGNED) return []; // results saved without an analysis carry no n-1 sweeps
  const assessment = await gridlens.assessment(target, signal);
  const sweeps = assessment.results.filter((r) => r.kind !== 'QDS' && r.status !== 'not_calculated');
  const names = new Map(assessment.cases.map((c) => [c.case_id, c.name]));
  const cases = new Map<string, Case>();
  for (const result of sweeps) {
    const entry = cases.get(result.case_id) ?? { id: result.case_id, name: names.get(result.case_id) ?? result.case_id, results: [] };
    entry.results.push(result);
    cases.set(result.case_id, entry);
  }
  return [...cases.values()];
}

/**
 * n-1 overloads as a Gantt chart: one row per branch, one bar per episode in which the loading after a
 * contingency exceeds the limit. Each bar says which contingency triggers it and the loading before the
 * contingency (the case's QDS at that time) and after it. Built from the summaries written at import, so a
 * sweep of millions of cells is drawn at once.
 */
export default memo(function N1Gantt({ refreshKey, onAvailable }: {
  refreshKey: number;
  /** Reports whether the section is shown (the database has n-1 sweeps), for the navigation bar. */
  onAvailable?: (shown: boolean) => void;
}) {
  const theme = useChartTheme();
  const { analysis } = useAnalysis();
  const colors = useMemo(() => readAcrossColors(theme.isLight), [theme.isLight]);
  const [cases, setCases] = useState<Case[] | null>(null);
  const [caseId, setCaseId] = useState<string | null>(null);
  const [kind, setKind] = useState<string>(PRIME);
  const [visibleLineCount, setVisibleLineCount] = useState(DEFAULT_VISIBLE_LINES);
  const [loaded, setLoaded] = useState<{ id: string; gantt: Gantt } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    loadCases(analysis, controller.signal).then((found) => { setCases(found); onAvailable?.(found.length > 0); }).catch(() => { if (!controller.signal.aborted) setError('The n-1 results could not be loaded.'); });
    return () => controller.abort();
  }, [refreshKey, onAvailable, analysis]);

  const current = cases?.find((c) => c.id === caseId) ?? cases?.[0] ?? null;
  const result = current?.results.find((r) => r.kind === kind) ?? current?.results[0] ?? null;

  useEffect(() => {
    if (!result) return;
    const controller = new AbortController();
    gridlens.n1Gantt(result.id, FETCH_LINES, controller.signal)
      .then((gantt) => { setLoaded({ id: result.id, gantt }); setError(''); })
      .catch(() => { if (!controller.signal.aborted) setError('The n-1 results could not be loaded.'); });
    return () => controller.abort();
  }, [result]);

  const gantt = loaded && loaded.id === result?.id ? loaded.gantt : null;

  const option = useMemo(() => {
    if (!gantt || gantt.lines.length === 0 || gantt.start === null || gantt.end === null) return null;
    // The API ranks by severity. ECharts places the first category at the bottom,
    // hence the reverse after taking the requested number of rows.
    const lines = gantt.lines.slice(0, visibleLineCount).reverse();
    const names = (id: string | null) => (id ? gantt.contingencies[id] ?? id : 'unknown contingency');
    const before = gantt.pre_source ? `QDS ${gantt.pre_source}` : 'not imported';
    const data = lines.flatMap((line, y) => line.segments.map((s, k) => {
      const already = s.pre_max !== null && line.limit !== null && s.pre_max > line.limit;
      return {
        value: [y, s.start * 1000, s.end * 1000, s.post, k],
        itemStyle: { color: colors.bands[bandOf(s.post).id], borderColor: already ? theme.text : 'transparent' },
        already,
      };
    }));
    return {
      backgroundColor: 'transparent',
      textStyle: { color: theme.mutedText, fontSize: 11 },
      tooltip: {
        backgroundColor: theme.tooltipBg, borderColor: theme.tooltipBorder, textStyle: { color: theme.text, fontSize: 12 },
        extraCssText: 'max-width: 420px;',
        formatter: (p: { dataIndex: number }) => {
          const item = data[p.dataIndex];
          const [y, , , , k] = item.value;
          const line = lines[y];
          const s = line.segments[k];
          const hours = (s.end - s.start) / 3600;
          return `<strong>${escapeHtml(line.name)}</strong> · limit ${pct(line.limit)}<br/>`
            + `${when(s.start)} – ${when(s.end)} UTC (${hours.toFixed(hours < 10 ? 2 : 0).replace(/\.?0+$/, '')} h)<br/>`
            + `Triggered by: <strong>${escapeHtml(names(s.contingency))}</strong><br/>`
            + `Loading before n-1: <strong>${pct(s.pre)}</strong> <span style="opacity:.7">(${escapeHtml(before)}, at the peak)</span><br/>`
            + `Loading after n-1: <strong>${pct(s.post)}</strong> <span style="opacity:.7">(peak ${when(s.peak_t)})</span><br/>`
            + (gantt.has_reference ? `n-1 without the planned outages: ${pct(s.reference)}<br/>` : '')
            + `Contingencies beyond the limit: up to ${s.violations}`
            + (item.already ? '<br/><em>Already above the limit before the contingency.</em>' : '');
        },
      },
      animationDuration: 240,
      grid: { left: 10, right: 18, top: 12, bottom: 46, containLabel: true },
      dataZoom: [
        { type: 'inside', xAxisIndex: 0, filterMode: 'weakFilter' },
        {
          type: 'slider', xAxisIndex: 0, height: 14, bottom: 8, filterMode: 'weakFilter',
          borderColor: theme.axis, backgroundColor: 'transparent', fillerColor: `${theme.axis}33`,
          handleStyle: { color: theme.mutedText, borderColor: theme.axis },
          textStyle: { color: theme.mutedText, fontSize: 9 },
        },
      ],
      xAxis: {
        type: 'time', min: gantt.start * 1000, max: gantt.end * 1000,
        axisLabel: { color: theme.mutedText, fontSize: 10 }, axisLine: { lineStyle: { color: theme.axis } },
        splitLine: { show: true, lineStyle: { color: theme.grid } },
      },
      yAxis: {
        type: 'category', data: lines.map((l) => l.name),
        axisLabel: {
          color: theme.text, fontSize: 11, width: 160, overflow: 'truncate', margin: 12,
          formatter: (name: string, index: number) => {
            const line = lines[index];
            return `{name|${name}}\n{meta|${pct(line.peak)} peak · ${line.hours} h}`;
          },
          rich: {
            name: { color: theme.text, fontSize: 11, fontWeight: 600, lineHeight: 15 },
            meta: { color: theme.mutedText, fontSize: 9, lineHeight: 13 },
          },
        },
        axisTick: { show: false },
        axisLine: { show: false },
        splitArea: {
          show: true,
          areaStyle: { color: ['transparent', `${theme.grid}20`] },
        },
      },
      series: [{
        type: 'custom',
        encode: { x: [1, 2], y: 0 },
        data,
        renderItem: (params: { coordSys: { x: number; y: number; width: number; height: number }; dataIndex: number },
          api: { value: (i: number) => number; coord: (v: number[]) => number[]; size: (v: number[]) => number[]; visual: (k: string) => string }) => {
          const y = api.value(0);
          const from = api.coord([api.value(1), y]);
          const to = api.coord([api.value(2), y]);
          const height = Math.min(13, api.size([0, 1])[1] * 0.46);
          const rect = echarts.graphic.clipRectByRect(
            { x: from[0], y: from[1] - height / 2, width: Math.max(2, to[0] - from[0]), height },
            { x: params.coordSys.x, y: params.coordSys.y, width: params.coordSys.width, height: params.coordSys.height },
          );
          if (!rect) return null;
          const item = data[params.dataIndex];
          return {
            type: 'rect', shape: { ...rect, r: 2 },
            style: {
              fill: api.visual('color'), opacity: 0.86,
              stroke: item.already ? theme.text : undefined,
              lineWidth: item.already ? 1 : 0,
              lineDash: item.already ? [3, 2] : undefined,
            },
          };
        },
      }],
    };
  }, [gantt, colors, theme, visibleLineCount]);

  if (!cases || cases.length === 0) return error ? <p role="alert" className="mt-3 text-sm text-[var(--grid-danger)]">{error}</p> : null;
  const kinds = current?.results.map((r) => r.kind) ?? [];
  const shownLines = gantt?.lines.slice(0, visibleLineCount) ?? [];
  const episodeCount = shownLines.reduce((sum, line) => sum + line.segments.length, 0);
  const worstPeak = shownLines.reduce((peak, line) => Math.max(peak, line.peak), 0);
  const longest = shownLines.reduce((hours, line) => Math.max(hours, line.hours), 0);
  return (
    <SectionCard
      id={SUMMARY_IDS.n1}
      title={`n-1 overload timeline${current ? ` · ${current.id} ${current.name}` : ''}`}
      hint="Each row is an affected branch; each bar is an overload episode. Colour shows the peak loading band. Hover for contingency and loading details, or zoom the time axis."
      actions={
        <div className="ab-chips">
          {cases.length > 1 && (
            <select className="ab-control" aria-label="Planning case" value={current?.id ?? ''} onChange={(e) => setCaseId(e.target.value)}>
              {cases.map((c) => <option key={c.id} value={c.id}>{c.id} · {c.name}</option>)}
            </select>
          )}
          {kinds.length > 1 && kinds.map((k) => (
            <button key={k} type="button" className="ab-chip" aria-pressed={result?.kind === k} onClick={() => setKind(k)}
              title={k === PRIME ? 'n-1 with the planned outages of the case' : 'n-1 without the planned outages (reference)'}>{k}</button>
          ))}
          <label className="n1-gantt__limit">
            <span>Rows</span>
            <select className="ab-control" aria-label="Number of branches shown" value={visibleLineCount}
              onChange={(event) => setVisibleLineCount(Number(event.target.value))}>
              {LINE_OPTIONS.map((count) => <option key={count} value={count}>Top {count}</option>)}
            </select>
          </label>
        </div>
      }
    >
      {error && <div className="ab-empty">{error}</div>}
      {!gantt && !error && <div className="ab-empty" aria-busy>Loading n-1 results …</div>}
      {gantt && gantt.lines.length === 0 && <div className="ab-empty">No branch exceeds its loading limit after any contingency ({gantt.kind}).</div>}
      {option && gantt && (
        <>
          <div className="n1-gantt__summary" aria-label="Summary of displayed overloads">
            <div><span>Branches shown</span><strong>{shownLines.length}{shownLines.length < gantt.lines.length || gantt.lines.length >= FETCH_LINES ? '+' : ''}</strong></div>
            <div><span>Overload episodes</span><strong>{episodeCount}</strong></div>
            <div><span>Worst peak</span><strong>{pct(worstPeak)}</strong></div>
            <div><span>Longest violation</span><strong>{longest} h</strong></div>
          </div>
          <div className="n1-gantt__plot">
            <div className="n1-gantt__scroll">
              <ReactECharts echarts={echarts} option={option} notMerge
                style={{ height: Math.max(330, shownLines.length * 38 + 72) }} />
            </div>
          </div>
          <ul className="ab-legend n1-gantt__legend" aria-label="Loading after the contingency">
            {LOADING_BANDS.filter((b) => b.id !== 'ok' && b.id !== 'high').map((b) => (
              <li key={b.id}><span className="ab-swatch" style={{ background: colors.bands[b.id] }} /><span className="ab-legend__label">{b.label}</span> {b.range}</li>
            ))}
            <li><span className="ab-swatch" style={{ border: `1px dashed ${theme.text}` }} /><span className="ab-legend__label">Already above the limit before n-1</span></li>
            <li>Ranked by severity</li>
            {gantt.lines.length >= FETCH_LINES && <li>Up to the {FETCH_LINES} most affected branches available.</li>}
          </ul>
        </>
      )}
    </SectionCard>
  );
});
