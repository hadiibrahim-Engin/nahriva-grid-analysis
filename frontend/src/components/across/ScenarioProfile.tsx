import { useEffect, useMemo, useState } from 'react';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import api from '../../api/client';
import ReactECharts from '../charts/ReactECharts';
import { useChartTheme } from '../../hooks/useChartTheme';
import { LOADING_LIMITS } from '../../config/loadingBands';
import { escapeHtml, readAcrossColors, withAlpha } from '../../util/acrossColors';
import { SUMMARY_IDS, fmtPct } from '../../util/acrossScenarios';
import { SectionCard } from './shared';

echarts.use([LineChart, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, TooltipComponent, CanvasRenderer]);

interface Profile {
  scenario_id: string;
  times: string[];
  windows: [number, number][];
  series: { id: string; name: string; type: string; max: number; out: (number | null)[]; ref: (number | null)[] }[];
}

/**
 * Loading over the simulation period of the most critical in-service equipment of one
 * scenario: when is it critical, for how long, and how does it differ from the reference run.
 */
export default function ScenarioProfile({ scenarioId, label, refreshKey }: { scenarioId: string; label: string; refreshKey: number }) {
  const theme = useChartTheme();
  const colors = useMemo(() => readAcrossColors(theme.isLight), [theme.isLight]);
  const [loaded, setLoaded] = useState<{ id: string; profile: Profile } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.get<Profile>(`/across-scenarios/${encodeURIComponent(scenarioId)}/profile`, { params: { top: 5, points: 300 } })
      .then((response) => { if (active) { setLoaded({ id: scenarioId, profile: response.data }); setFailed(null); } })
      .catch(() => { if (active) setFailed(scenarioId); });
    return () => { active = false; };
  }, [scenarioId, refreshKey]);

  const profile = loaded?.id === scenarioId ? loaded.profile : null;
  const option = useMemo(() => {
    if (!profile || profile.series.length === 0) return null;
    const stamps = profile.times.map((t) => Date.parse(t));
    const palette = theme.palette;
    return {
      backgroundColor: 'transparent',
      textStyle: { color: theme.mutedText, fontSize: 11 },
      legend: { top: 0, type: 'scroll', itemWidth: 16, itemHeight: 8, textStyle: { color: theme.text, fontSize: 11 } },
      tooltip: {
        trigger: 'axis',
        backgroundColor: theme.tooltipBg,
        borderColor: theme.tooltipBorder,
        textStyle: { color: theme.text, fontSize: 12 },
        extraCssText: 'max-width: 360px;',
        formatter: (params: { dataIndex: number; seriesName: string; seriesIndex: number; color: string }[]) => {
          const index = params[0]?.dataIndex ?? 0;
          const when = new Date(stamps[index]).toLocaleString('de-DE', { timeZone: 'UTC', dateStyle: 'short', timeStyle: 'short' });
          const rows = profile.series.map((s, i) => {
            const out = s.out[index];
            const ref = s.ref[index];
            return `<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${palette[i % palette.length]}"></span> ${escapeHtml(s.name)}: <strong>${fmtPct(out)}</strong> <span style="opacity:.7">(REF ${fmtPct(ref)})</span>`;
          });
          return `<strong>${when} UTC</strong><br/>${rows.join('<br/>')}`;
        },
      },
      grid: { left: 8, right: 16, top: 36, bottom: 28, containLabel: true },
      xAxis: { type: 'time', axisLabel: { color: theme.mutedText, fontSize: 10 }, axisLine: { lineStyle: { color: theme.axis } }, splitLine: { show: false } },
      yAxis: {
        type: 'value', min: 0,
        max: (v: { max: number }) => Math.max(110, Math.ceil(v.max / 10) * 10),
        axisLabel: { color: theme.mutedText, fontSize: 10, formatter: '{value} %' },
        splitLine: { lineStyle: { color: theme.grid } },
      },
      series: profile.series.flatMap((s, i) => {
        const color = palette[i % palette.length];
        const base = {
          type: 'line' as const, showSymbol: false, smooth: false, connectNulls: false,
        };
        const out = {
          ...base, name: s.name, z: 3, lineStyle: { color, width: 2 }, itemStyle: { color },
          data: s.out.map((v, k) => [stamps[k], v]),
          ...(i === 0 ? {
            markArea: {
              silent: true,
              itemStyle: { color: withAlpha(colors.lodf, theme.isLight ? 0.08 : 0.14) },
              label: { show: true, position: 'insideTopLeft', color: theme.mutedText, fontSize: 10, formatter: 'Freischaltung' },
              data: profile.windows.map(([a, b]) => [{ xAxis: a * 1000 }, { xAxis: b * 1000 }]),
            },
            markLine: {
              silent: true, symbol: 'none', label: { position: 'insideEndTop', color: theme.mutedText, fontSize: 10 },
              data: [
                { yAxis: LOADING_LIMITS.overload, label: { formatter: '100 %' }, lineStyle: { color: colors.bands.severe, type: 'dashed', width: 1.2 } },
                { yAxis: LOADING_LIMITS.warning, label: { formatter: '80 %' }, lineStyle: { color: colors.bands.high, type: 'dotted', width: 1 } },
              ],
            },
          } : {}),
        };
        const ref = {
          ...base, name: `${s.name} (REF)`, z: 2, silent: true, lineStyle: { color, width: 1, type: 'dashed', opacity: 0.55 }, itemStyle: { color },
          data: s.ref.map((v, k) => [stamps[k], v]),
        };
        return [out, ref];
      }),
    };
  }, [profile, theme, colors]);

  // The legend lists each equipment once; the dashed REF series follow their equipment.
  const legendOption = useMemo(() => {
    if (!option || !profile) return option;
    return { ...option, legend: { ...option.legend, data: profile.series.map((s) => s.name) } };
  }, [option, profile]);

  return (
    <SectionCard
      id={SUMMARY_IDS.profile}
      title={`Belastungsverlauf · ${label}`}
      hint="Die fünf am höchsten belasteten Betriebsmittel in Betrieb über den Simulationszeitraum. Durchgezogen: mit Freischaltung, gestrichelt: Referenz (REF). Die Fläche markiert das Ausfallfenster; freigeschaltete Betriebsmittel fehlen."
    >
      {failed === scenarioId && !profile && <div className="ab-empty">Der Verlauf konnte nicht geladen werden.</div>}
      {!profile && failed !== scenarioId && <div className="ab-empty" aria-busy>Verlauf wird geladen …</div>}
      {profile && profile.series.length === 0 && <div className="ab-empty">Für dieses Szenario liegen keine Betriebsmittelverläufe vor.</div>}
      {legendOption && <ReactECharts echarts={echarts} option={legendOption} notMerge style={{ height: 330 }} />}
    </SectionCard>
  );
}
