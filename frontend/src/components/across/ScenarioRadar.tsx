import { useMemo, useState } from 'react';
import * as echarts from 'echarts/core';
import { RadarChart } from 'echarts/charts';
import { AriaComponent, LegendComponent, RadarComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import ReactECharts from '../charts/ReactECharts';
import { useChartTheme } from '../../hooks/useChartTheme';
import { escapeHtml, withAlpha } from '../../util/acrossColors';
import { SUMMARY_IDS, fmtHours, fmtLodf, fmtPct, fmtPp, type ScenarioStats } from '../../util/acrossScenarios';
import { SectionCard } from './shared';

echarts.use([RadarChart, RadarComponent, AriaComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

interface Props {
  scenarios: ScenarioStats[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const metrics = [
  { name: 'Max Loading (%)', label: 'Max Loading\n(%)', read: (s: ScenarioStats) => s.maxValue, format: fmtPct, minimum: 120 },
  { name: 'Leitungen > 100 %', label: 'Leitungen\n> 100 %', read: (s: ScenarioStats) => s.n100, format: (v: number | null) => v === null ? '–' : String(v), minimum: 1 },
  { name: 'Überlastdauer (h)', label: 'Überlastdauer\n(h)', read: (s: ScenarioStats) => s.longestOverloadHours, format: fmtHours, minimum: 1 },
  { name: 'Max |Δ Loading| (pp)', label: 'Max |Δ Loading|\n(pp)', read: (s: ScenarioStats) => s.maxDelta === null ? null : Math.abs(s.maxDelta), format: fmtPp, minimum: 10 },
  { name: 'Max |LODF|', label: 'Max |LODF|', read: (s: ScenarioStats) => s.maxAbsLodf, format: fmtLodf, minimum: 0.3 },
  { name: 'Beeinflusste Leitungen', label: 'Beeinflusste\nLeitungen', read: (s: ScenarioStats) => s.affected, format: (v: number | null) => v === null ? '–' : String(v), minimum: 1 },
] as const;

export default function ScenarioRadar({ scenarios, selectedId, onSelect }: Props) {
  const theme = useChartTheme();
  const [compare, setCompare] = useState(true);
  const option = useMemo(() => {
    // Shared scales across every scenario, even in the single-scenario view.
    const maxima = metrics.map((metric) => Math.max(metric.minimum, ...scenarios.map((s) => metric.read(s) ?? 0)) * 1.1);
    const rows = compare ? scenarios : scenarios.filter((s) => s.scenario.id === selectedId);
    return {
      backgroundColor: 'transparent',
      animation: false,
      aria: { enabled: true, description: 'Szenariovergleich auf sechs Achsen mit unterschiedlichen Einheiten. Die exakten Kennzahlen stehen in der Szenariotabelle.' },
      legend: { type: 'scroll', bottom: 2, data: rows.map((s) => s.code), textStyle: { color: theme.text, fontSize: 12 }, pageTextStyle: { color: theme.mutedText }, pageIconColor: theme.primary },
      tooltip: {
        backgroundColor: theme.tooltipBg, borderColor: theme.tooltipBorder, textStyle: { color: theme.text },
        formatter: (params: { name: string }) => {
          const s = scenarios.find((row) => row.code === params.name);
          if (!s) return '';
          return [`<strong>${escapeHtml(s.code)} · ${escapeHtml(s.scenario.name)}</strong>`, ...metrics.map((metric) => `${escapeHtml(metric.name)}: <strong>${metric.format(metric.read(s))}</strong>`)].join('<br/>');
        },
      },
      radar: {
        center: ['50%', '46%'], radius: '62%', shape: 'polygon', splitNumber: 4,
        indicator: metrics.map((metric, i) => ({ name: `${metric.label}\n0–${maxima[i].toLocaleString('de-DE', { maximumFractionDigits: 1 })}`, min: 0, max: maxima[i] })),
        axisName: { color: theme.text, fontSize: 11, lineHeight: 16 },
        axisLine: { lineStyle: { color: theme.axis } }, splitLine: { lineStyle: { color: theme.grid } },
        splitArea: { show: false },
      },
      media: [{ query: { maxWidth: 480 }, option: { radar: { radius: '40%', axisName: { fontSize: 10, lineHeight: 14 } }, legend: { itemWidth: 12, itemHeight: 8, textStyle: { fontSize: 10 } } } }],
      series: [{
        type: 'radar', symbol: 'circle', symbolSize: 5,
        data: rows.map((s) => {
          const selected = s.scenario.id === selectedId;
          const color = theme.palette[scenarios.indexOf(s) % theme.palette.length];
          return {
            name: s.code, value: metrics.map((metric) => metric.read(s) ?? 0),
            itemStyle: { color }, lineStyle: { color, width: selected ? 3 : 1.5, opacity: selected ? 1 : 0.55 },
            areaStyle: { color: withAlpha(color, selected ? 0.12 : 0.025) },
            emphasis: { lineStyle: { width: 3, opacity: 1 }, areaStyle: { opacity: 0.15 } },
          };
        }),
      }],
    };
  }, [scenarios, selectedId, compare, theme]);
  return (
    <SectionCard id={SUMMARY_IDS.radar} title="Szenariovergleich · Radarplot"
      hint="Jede Achse hat eine eigene Skala und Einheit; größer bedeutet stärkere Belastung bzw. stärkeren Einfluss. Überlastdauer = längste Überschreitung einer Leitung."
      actions={<label className="ab-toggle"><input type="checkbox" checked={compare} onChange={(event) => setCompare(event.target.checked)} />Alle Szenarien vergleichen</label>}
    >
      <div className="ab-radar" role="img" aria-label="Radarplot der Szenariokennzahlen">
        <ReactECharts echarts={echarts} option={option} notMerge style={{ height: 400 }} onEvents={{ click: (event) => {
          const name = (event as { name?: string }).name;
          const current = scenarios.find((s) => s.code === name);
          if (current) onSelect(current.scenario.id);
        } }} />
      </div>
      <div className="ab-chips" role="group" aria-label="Szenario für den Radarplot wählen">
        {scenarios.map((s) => <button key={s.scenario.id} className="ab-chip" type="button" aria-pressed={s.scenario.id === selectedId} title={s.scenario.name} onClick={() => onSelect(s.scenario.id)}>{s.code}</button>)}
      </div>
      <p className="across-card__hint mt-2">Fehlende Kennzahlen werden am Ursprung dargestellt und im Tooltip als „–“ ausgewiesen. Exakte Werte und Ausfallfenster stehen in der Tabelle darunter.</p>
    </SectionCard>
  );
}
