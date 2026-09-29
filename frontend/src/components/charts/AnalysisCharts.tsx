import * as echarts from "echarts/core";
import { LineChart, BarChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkLineComponent,
  AriaComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsCoreOption } from "echarts/core";
import type { Analysis, Point } from "../../api/types";
import ReactECharts from "./ReactECharts";
import { formatChartNumber as fmt } from "./format";

echarts.use([
  LineChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkLineComponent,
  AriaComponent,
  CanvasRenderer,
]);
const colors = ["#60a5fa", "#a78bfa", "#2dd4bf"];
const axis = {
  axisLine: { lineStyle: { color: "#354155" } },
  axisLabel: { color: "#9aa7b8", fontSize: 10 },
  splitLine: { lineStyle: { color: "#263244" } },
};
const base: EChartsCoreOption = {
  animation: false,
  aria: { enabled: true },
  color: colors,
  backgroundColor: "transparent",
  textStyle: { fontFamily: "system-ui" },
  tooltip: { trigger: "axis", renderMode: "richText" },
  grid: { left: 57, right: 22, top: 25, bottom: 48 },
};

function Chart({
  option,
  height = 275,
}: {
  option: EChartsCoreOption;
  height?: number;
}) {
  return (
    <ReactECharts
      echarts={echarts}
      option={option}
      notMerge
      style={{ height, width: "100%" }}
    />
  );
}
export function SeriesChart({
  points,
  comparison,
  unit,
  lower,
  upper,
}: {
  points: Point[];
  comparison?: Point[];
  unit: string;
  lower?: number | null;
  upper?: number | null;
}) {
  const line = (name: string, data: Point[], dashed = false) => ({
    name,
    type: "line",
    showSymbol: false,
    connectNulls: false,
    lineStyle: { width: 2, type: dashed ? "dashed" : "solid" },
    data: data.map((p) => [p.timestamp, p.mean]),
  });
  const thresholds = [lower, upper]
    .filter((v): v is number => v != null)
    .map((v) => ({
      yAxis: v,
      label: { formatter: `${fmt(v)} ${unit}`, color: "#fbbf24" },
    }));
  const series = [
    {
      ...line("Auswahl · Mittelwert", points),
      markLine: {
        silent: true,
        symbol: "none",
        lineStyle: { color: "#d7a546", type: "dashed" },
        data: thresholds,
      },
    },
    ...(comparison
      ? [line("Vergleich · gepaarte Werte", comparison, true)]
      : []),
  ];
  return (
    <Chart
      height={310}
      option={{
        ...base,
        useUTC: true,
        grid: { left: 60, right: 24, top: 35, bottom: 65 },
        legend: {
          top: 0,
          right: 12,
          textStyle: { color: "#bac5d4", fontSize: 11 },
        },
        xAxis: { type: "time", ...axis },
        yAxis: {
          type: "value",
          name: unit,
          min:
            lower != null
              ? (range: { min: number }) => Math.min(range.min, lower)
              : undefined,
          max:
            upper != null
              ? (range: { max: number }) => Math.max(range.max, upper)
              : undefined,
          scale: true,
          ...axis,
          nameTextStyle: { color: "#9aa7b8" },
        },
        dataZoom: [
          { type: "inside" },
          {
            type: "slider",
            bottom: 10,
            height: 18,
            borderColor: "#354155",
            textStyle: { color: "#9aa7b8" },
          },
        ],
        series,
      }}
    />
  );
}
export default function AnalysisCharts({ data }: { data: Analysis }) {
  const [lo, hi] = [data.metric.lower, data.metric.upper];
  return (
    <div className="charts-grid">
      <section className="panel series-panel">
        <div className="panel-heading">
          <div>
            <h2>Zeitlicher Verlauf</h2>
            <p>
              {data.metric.name} · Mittelwert über ausgewählte Elemente je
              Zeitpunkt
            </p>
          </div>
          <span className="badge">UTC</span>
        </div>
        <SeriesChart
          points={data.points}
          comparison={data.comparison?.points}
          unit={data.metric.unit}
          lower={lo}
          upper={hi}
        />
        <div className="chart-note">
          Zoom verändert nur die Diagrammansicht. Kennzahlen gelten für den
          eingestellten Zeitraum.
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Werteverteilung</h2>
            <p>Häufigkeit der gültigen Einzelmesswerte</p>
          </div>
        </div>
        <Chart
          option={{
            ...base,
            xAxis: {
              type: "category",
              data: data.histogram.map((b) => fmt((b.lower + b.upper) / 2)),
              name: data.metric.unit,
              ...axis,
            },
            yAxis: { type: "value", minInterval: 1, ...axis },
            series: [
              {
                type: "bar",
                barMaxWidth: 36,
                data: data.histogram.map((b) => b.count),
                itemStyle: { color: "#60a5fa", borderRadius: [3, 3, 0, 0] },
              },
            ],
          }}
        />
        <div className="chart-note">
          12 gleich breite Klassen · Achsenbeschriftung zeigt Klassenmitten.
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Dauerlinie</h2>
            <p>{data.metric.name} · absteigend nach Messwert</p>
          </div>
        </div>
        <Chart
          option={{
            ...base,
            xAxis: { type: "value", min: 0, max: 100, name: "%", ...axis },
            yAxis: {
              type: "value",
              name: data.metric.unit,
              scale: true,
              ...axis,
            },
            series: [
              {
                type: "line",
                showSymbol: false,
                data: data.duration.map((p) => [p.percent, p.value]),
                lineStyle: { width: 2, color: "#2dd4bf" },
                areaStyle: { color: "rgba(45,212,191,.07)" },
              },
            ],
          }}
        />
        <div className="chart-note">
          101 empirische Quantile · Anteil der Messwerte, keine Zeitgewichtung
          bei Lücken.
        </div>
      </section>
    </div>
  );
}
