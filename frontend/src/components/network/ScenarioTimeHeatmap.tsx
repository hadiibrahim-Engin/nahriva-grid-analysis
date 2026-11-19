import { useMemo, useState } from 'react';
import * as echarts from 'echarts/core';
import { HeatmapChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, VisualMapComponent, DataZoomComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import ReactECharts from '../charts/ReactECharts';
import { useChartTheme } from '../../hooks/useChartTheme';
import type { NetworkTimeline } from '../../api/network';
import { utc } from '../../api/views';

echarts.use([HeatmapChart, GridComponent, TooltipComponent, VisualMapComponent, DataZoomComponent, CanvasRenderer]);

export default function ScenarioTimeHeatmap({ data, scenario, t, onPick }: {
  data: NetworkTimeline; scenario: string | null; t: number | null; onPick: (scenario: string, t: number) => void;
}) {
  const theme = useChartTheme();
  const [chosenColumn,setChosenColumn]=useState<number|null>(null);
  const selectedColumn=data.columns.findIndex(c=>t!==null&&c.start<=t&&t<=c.end);
  const column=chosenColumn!==null&&chosenColumn<data.columns.length?chosenColumn:Math.max(0,selectedColumn);
  const option = useMemo(() => {
    const voltage = data.metric === 'voltage';
    const cost = data.metric === 'redispatch';
    const unit = cost ? '€' : voltage ? 'p.u.' : data.metric === 'active_power' ? 'MW' : '%';
    const cells = data.scenarios.flatMap((s, y) => s.cells.flatMap((cell, x) => cell ? [{
      value: [x, y, cell.value],
      itemStyle: s.id === scenario && t !== null && data.columns[x].start <= t && t <= data.columns[x].end
        ? { borderColor: theme.text, borderWidth: 2 } : undefined,
    }] : []));
    const numbers = cells.map(c => c.value[2]);
    const high = numbers.reduce((a,b)=>Math.max(a,b),cost || data.metric === 'active_power' ? 1 : voltage ? 1.1 : 120);
    const low = numbers.reduce((a,b)=>Math.min(a,b),cost || data.metric === 'active_power' ? 0 : voltage ? 0.9 : 0);
    return {
      backgroundColor: 'transparent', animation: false,
      grid: { left: 62, right: 18, top: 12, bottom: 62 },
      tooltip: { formatter: (p: { value: number[] }) => {
        const [x, y, v] = p.value;
        // Plain text in the native tooltip avoids interpolating equipment names as HTML.
        return `S${String(y + 1).padStart(2, '0')} · ${utc(data.columns[x].start)} – ${utc(data.columns[x].end)} UTC\n${v.toFixed(voltage ? 3 : 2)} ${unit}\nKlick: tatsächlichen Zeitpunkt öffnen`;
      }, renderMode: 'richText', backgroundColor: theme.tooltipBg, borderColor: theme.tooltipBorder,
      textStyle: { color: theme.text } },
      xAxis: { type: 'category', data: data.columns.map(c=>utc(c.start)), axisLabel: { color: theme.mutedText, fontSize: 10, hideOverlap: true }, axisLine: { show: false }, axisTick: { show: false }, splitArea: { show: false } },
      yAxis: { type: 'category', inverse: true, data: data.scenarios.map((_s,i)=>`S${String(i+1).padStart(2,'0')}`),
        axisLabel: { color: theme.text, fontSize: 11 }, axisLine: { show: false }, axisTick: { show: false } },
      visualMap: { min: low, max: high, orient: 'horizontal', left: 'center', bottom: 0, itemHeight: 140, itemWidth: 7,
        text: [unit, ''], textStyle: { color: theme.mutedText }, calculable: true,
        inRange: { color: cost ? ['#64b7c2', '#e7eef7', '#e99155', '#c94f55'] : voltage ? ['#c94f55','#e0aa54','#66bb94'] : ['#244658','#66bb94','#e0aa54','#e99155','#c94f55'] } },
      dataZoom: [{ type: 'inside', xAxisIndex: 0, filterMode: 'none' }],
      series: [{ type: 'heatmap', data: cells, progressive: 2000, emphasis: { itemStyle: { borderColor: theme.text, borderWidth: 1 } } }],
    };
  }, [data, scenario, t, theme]);
  return <><ReactECharts echarts={echarts} option={option} notMerge style={{ height: Math.min(420, Math.max(170, data.scenarios.length * 28 + 85)) }}
    exportName="scenario-time-heatmap" onEvents={{ click: (p: unknown) => {
      const value = (p as { value?: number[] }).value;
      if (!value) return;
      const [x,y] = value; const row = data.scenarios[y]; const cell = row?.cells[x];
      if (cell) onPick(row.id, cell.t);
    } }} />
    <details className="nw-heat-accessible"><summary>Zeitfenster als Tabelle öffnen</summary>
      <label>Zeitfenster <select aria-label="Heatmap-Zeitfenster" value={column} onChange={e=>setChosenColumn(Number(e.target.value))}>{data.columns.map((c,i)=><option value={i} key={c.start}>{utc(c.start)} – {utc(c.end)} UTC</option>)}</select></label>
      <div className="nw-heat-times">{data.scenarios.map((s,i)=>{
        const cell=s.cells[column];
        return <button type="button" className="nw-button" key={s.id} disabled={!cell} onClick={()=>{if(cell)onPick(s.id,cell.t);}}>
          S{String(i+1).padStart(2,'0')} · {cell?`${utc(cell.t)} UTC · ${cell.value.toFixed(data.metric==='voltage'?3:2)}`:'Keine Werte'}
        </button>;
      })}</div>
    </details></>;
}
