import { useMemo, type ReactNode } from 'react';
import { ASSESSMENT } from '../../config/assessment';
import { LOADING_LIMITS } from '../../config/loadingBands';
import { DeltaChart, LoadingRangeChart, LodfChart, OverloadTimeChart } from './AcrossCharts';
import GroupedBars, { type GroupedMarkLine } from './GroupedBars';
import { useAcrossData } from '../../hooks/useAcrossData';
import { analyse, fmtPct, fmtPp, scenarioCode } from '../../util/acrossScenarios';
import { busValue, chosenLines, isSelecting, isVoltageKind, pickBuses, restrictScenarios } from '../../util/acrossSelection';
import { filterByEquipment } from '../../util/outageAssessment';
import { formatVoltage, isPerUnit, unitLabel } from '../../util/voltage';
import { readAcrossColors } from '../../util/acrossColors';
import { useChartTheme } from '../../hooks/useChartTheme';
import type { ChartKind } from '../charts/chartTemplates';
import type { DynamicChartConfig } from '../../util/dynamicCharts';

type Colors = ReturnType<typeof readAcrossColors>;
type Group = { id: string; code: string; name: string };
type Bus = ReturnType<typeof pickBuses>[number];
type Line = NonNullable<ReturnType<typeof chosenLines>>[number];

const bandLabel = (value: number) => value.toLocaleString('en-GB', { minimumFractionDigits: 2 });

/** Voltage charts: one group of bars per busbar, absolute (with the 0.9–1.1 p.u. band) or as ΔU. */
function VoltageBars({ buses, groups, delta, colors }: { buses: Bus[]; groups: Group[]; delta: boolean; colors: Colors }) {
  const unit = buses[0].unit;
  const absolutePu = !delta && isPerUnit(unit);
  const band = ASSESSMENT.voltageBandPu;
  const marks: GroupedMarkLine[] = absolutePu
    ? [band.lower, band.upper].map((value) => ({ value, label: bandLabel(value), color: colors.bands.severe }))
    : [];
  const byId = useMemo(() => new Map(buses.map((b) => [b.id, b])), [buses]);
  return (
    <GroupedBars
      rows={buses.map((b) => ({ id: b.id, name: b.name }))}
      scenarios={groups}
      valueOf={(rowId, scenarioId) => {
        const bus = byId.get(rowId);
        const value = bus ? busValue(bus, bus.cells[scenarioId]) : null;
        return value ? (delta ? value.delta : value.value) : null;
      }}
      format={(v) => `${formatVoltage(v, unit, { signed: delta })} ${unitLabel(unit)}`}
      unit={delta ? `ΔU in ${unitLabel(unit)}` : unitLabel(unit)}
      markLines={marks}
      min={absolutePu ? band.lower - 0.05 : undefined}
      max={absolutePu ? band.upper + 0.05 : undefined}
      diverging={delta}
      origin={absolutePu ? 1 : 0}
    />
  );
}

/** Branch charts for exactly the chosen equipment: one group of bars per branch, one bar per scenario. */
function ChosenBranchBars({ kind, chosen, groups, period, colors }: { kind: ChartKind; chosen: Line[]; groups: Group[]; period: number; colors: Colors }) {
  const rows = chosen.map((l) => ({ id: l.id, name: l.name }));
  const byId = useMemo(() => new Map(chosen.map((l) => [l.id, l])), [chosen]);
  const cell = (rowId: string, scenarioId: string) => byId.get(rowId)?.cells[scenarioId];
  const common = { rows, scenarios: groups };
  if (kind === 'acrossLoading') {
    return (
      <GroupedBars {...common} unit="Loading in %" format={fmtPct} min={0}
        valueOf={(r, s) => { const c = cell(r, s); return c && !c.outaged ? c.value : null; }}
        markLines={[{ value: LOADING_LIMITS.overload, label: '100 %', color: colors.bands.severe }, { value: LOADING_LIMITS.warning, label: '80 %', color: colors.bands.high }]} />
    );
  }
  if (kind === 'acrossTime') {
    return (
      <GroupedBars {...common} unit="Time above 100 % in % of the period" format={fmtPct} min={0}
        valueOf={(r, s) => { const c = cell(r, s); return c && !c.outaged && c.hours_over && period > 0 ? (c.hours_over[0] / period) * 100 : null; }} />
    );
  }
  return (
    <GroupedBars {...common} unit="Δ Loading in pp" format={fmtPp} diverging
      valueOf={(r, s) => { const c = cell(r, s); return c && !c.outaged ? c.delta : null; }} />
  );
}

const Empty = ({ children }: { children: ReactNode }) => <div className="ab-empty">{children}</div>;
const NEED_CHOICE = <Empty>Please choose at least one element under “Selection”.</Empty>;

/**
 * Body of the scenario evaluation charts added through "Add chart". It needs no selected
 * signals: it reads the saved scenario results itself, through the same lazy, shared loading as the
 * summary, and follows new scenarios automatically. With "Selected" it shows exactly the chosen
 * equipment (branches or busbars) as one group of bars per item and one bar per scenario; otherwise the
 * automatic top N. The scenarios can be narrowed down as well.
 */
export default function AcrossChartBody({ kind, config }: { kind: ChartKind; config: DynamicChartConfig }) {
  const { data, total, shown, loading, error } = useAcrossData(0);
  const theme = useChartTheme();
  const colors = useMemo(() => readAcrossColors(theme.isLight), [theme.isLight]);
  const top = config.topN && config.topN > 0 ? config.topN : 12;
  const equipment = config.equipment ?? 'all';
  const selecting = isSelecting(config);

  // Codes stay those of the full list (S03 stays S03), also when only some scenarios are shown.
  const codes = useMemo(() => new Map((data?.scenarios ?? []).map((s, i) => [s.id, scenarioCode(i)])), [data]);
  const restricted = useMemo(() => (data ? restrictScenarios(data, config.scenarioIds) : null), [data, config.scenarioIds]);
  const analysis = useMemo(() => {
    if (!restricted) return null;
    const result = analyse({ ...restricted, lines: filterByEquipment(restricted.lines, equipment) });
    for (const stats of result.scenarios) stats.code = codes.get(stats.scenario.id) ?? stats.code;
    return result;
  }, [restricted, equipment, codes]);
  const groups = useMemo(
    () => (restricted?.scenarios ?? []).map((s) => ({ id: s.id, code: codes.get(s.id) ?? '', name: s.name })),
    [restricted, codes],
  );
  const chosen = useMemo(
    () => (restricted ? chosenLines(filterByEquipment(restricted.lines, equipment), config) : null),
    [restricted, equipment, config],
  );
  const buses = useMemo(
    () => (restricted && isVoltageKind(kind) ? pickBuses(restricted.buses ?? [], restricted.scenarios, config) : []),
    [restricted, kind, config],
  );

  if (error && !data) return <div className="ab-empty" role="alert">{error}</div>;
  if (!analysis || !restricted || restricted.scenarios.length === 0) {
    return <div className="ab-empty" aria-busy={loading}>{loading || total > 0 ? 'Loading scenarios …' : 'No calculated scenarios yet.'}</div>;
  }
  const progress = loading && shown < total && <div className="ab-progress" role="status">Scenarios {shown} / {total}</div>;
  const noChoice = (config.elementIds?.length ?? 0) === 0;
  const period = data!.period_hours;

  let content: ReactNode;
  if (isVoltageKind(kind)) {
    if (selecting && noChoice) return NEED_CHOICE;
    if (buses.length === 0) return <Empty>No busbars with voltage values.</Empty>;
    content = <VoltageBars buses={buses} groups={groups} delta={kind === 'acrossVoltageDelta'} colors={colors} />;
  } else if (selecting && kind !== 'acrossLodf') {
    if (noChoice) return NEED_CHOICE;
    if (!chosen || chosen.length === 0) return <Empty>The chosen equipment does not match the type filter.</Empty>;
    content = <ChosenBranchBars kind={kind} chosen={chosen} groups={groups} period={period} colors={colors} />;
  } else {
    // Automatic top N (or the chosen branches in the LODF scatter).
    if (selecting && noChoice) return NEED_CHOICE;
    const lines = kind === 'acrossLodf' && chosen ? analysis.lines.filter((l) => chosen.some((c) => c.id === l.line.id)) : analysis.lines;
    content = (
      <>
        {kind === 'acrossLoading' && <LoadingRangeChart lines={lines} scenarios={analysis.scenarios} top={top} />}
        {kind === 'acrossTime' && <OverloadTimeChart lines={lines} scenarios={analysis.scenarios} periodHours={period} top={top} />}
        {kind === 'acrossDelta' && <DeltaChart lines={lines} scenarios={analysis.scenarios} top={top} />}
        {kind === 'acrossLodf' && <LodfChart lines={lines} scenarios={analysis.scenarios} hasLodf={data!.has_lodf} />}
      </>
    );
  }
  return (
    <div className="across-scope">
      {progress}
      {content}
    </div>
  );
}
