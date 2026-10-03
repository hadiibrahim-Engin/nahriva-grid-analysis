import { useMemo } from 'react';
import { ASSESSMENT } from '../../config/assessment';
import { LOADING_LIMITS } from '../../config/loadingBands';
import { DeltaChart, LoadingRangeChart, LodfChart, OverloadTimeChart } from './AcrossCharts';
import GroupedBars, { type GroupedMarkLine } from './GroupedBars';
import { useAcrossData } from '../../hooks/useAcrossData';
import { analyse, fmtPct, fmtPp, scenarioCode } from '../../util/acrossScenarios';
import { busValue, chosenLines, isSelecting, isVoltageKind, pickBuses, restrictScenarios } from '../../util/acrossSelection';
import { filterByEquipment } from '../../util/freischaltung';
import { readAcrossColors } from '../../util/acrossColors';
import { useChartTheme } from '../../hooks/useChartTheme';
import type { ChartKind } from '../charts/chartTemplates';
import type { DynamicChartConfig } from '../../util/dynamicCharts';

const isPu = (unit: string | null | undefined) => /^p\.?u\.?$/i.test((unit ?? '').trim());
const volts = (value: number, unit: string | null | undefined, sign = false) =>
  `${sign && value > 0 ? '+' : ''}${value.toLocaleString('de-DE', isPu(unit) ? { minimumFractionDigits: 3, maximumFractionDigits: 3 } : { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;

/**
 * Body of the scenario evaluation charts added through "Diagramm hinzufügen". It needs no selected
 * signals: it reads the saved scenario results itself, through the same lazy, shared loading as the
 * summary, and follows new scenarios automatically. With "Ausgewählte" it shows exactly the chosen
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
    return <div className="ab-empty" aria-busy={loading}>{loading || total > 0 ? 'Szenarien werden geladen …' : 'Noch keine berechneten Szenarien.'}</div>;
  }
  const progress = loading && shown < total && <div className="ab-progress" role="status">Szenarien {shown} / {total}</div>;
  const needChoice = <div className="ab-empty">Bitte unter „Auswahl“ mindestens ein Element wählen.</div>;
  const period = data!.period_hours;

  // Voltage: always one group per busbar.
  if (isVoltageKind(kind)) {
    if (selecting && (config.elementIds?.length ?? 0) === 0) return needChoice;
    if (buses.length === 0) return <div className="ab-empty">Keine Sammelschienen mit Spannungswerten.</div>;
    const unit = buses[0].unit;
    const delta = kind === 'acrossVoltageDelta';
    const band = ASSESSMENT.voltageBandPu;
    const marks: GroupedMarkLine[] = !delta && isPu(unit)
      ? [{ value: band.lower, label: `${band.lower.toLocaleString('de-DE', { minimumFractionDigits: 2 })}`, color: colors.bands.severe }, { value: band.upper, label: `${band.upper.toLocaleString('de-DE', { minimumFractionDigits: 2 })}`, color: colors.bands.severe }]
      : [];
    return (
      <div className="across-scope">
        {progress}
        <GroupedBars
          rows={buses.map((b) => ({ id: b.id, name: b.name }))}
          scenarios={groups}
          valueOf={(rowId, scenarioId) => {
            const bus = buses.find((b) => b.id === rowId);
            const value = bus ? busValue(bus, bus.cells[scenarioId]) : null;
            return value ? (delta ? value.delta : value.value) : null;
          }}
          format={(v) => `${volts(v, unit, delta)} ${isPu(unit) ? 'p.u.' : unit ?? ''}`}
          unit={delta ? `ΔU in ${isPu(unit) ? 'p.u.' : unit ?? ''}` : (isPu(unit) ? 'p.u.' : unit ?? '')}
          markLines={marks}
          min={!delta && isPu(unit) ? band.lower - 0.05 : undefined}
          max={!delta && isPu(unit) ? band.upper + 0.05 : undefined}
          diverging={delta}
          origin={!delta && isPu(unit) ? 1 : 0}
        />
      </div>
    );
  }

  // Branches, exactly the chosen ones: grouped by scenario.
  if (selecting && kind !== 'acrossLodf') {
    if ((config.elementIds?.length ?? 0) === 0) return needChoice;
    const rows = (chosen ?? []).map((l) => ({ id: l.id, name: l.name }));
    if (rows.length === 0) return <div className="ab-empty">Die gewählten Betriebsmittel passen nicht zum Typfilter.</div>;
    const cell = (rowId: string, scenarioId: string) => chosen?.find((l) => l.id === rowId)?.cells[scenarioId];
    const common = { rows, scenarios: groups };
    return (
      <div className="across-scope">
        {progress}
        {kind === 'acrossLoading' && (
          <GroupedBars {...common} unit="Auslastung in %" format={fmtPct} min={0}
            valueOf={(r, s) => { const c = cell(r, s); return c && !c.outaged ? c.value : null; }}
            markLines={[{ value: LOADING_LIMITS.overload, label: '100 %', color: colors.bands.severe }, { value: LOADING_LIMITS.warning, label: '80 %', color: colors.bands.high }]} />
        )}
        {kind === 'acrossTime' && (
          <GroupedBars {...common} unit="Zeit über 100 % in % des Zeitraums" format={fmtPct} min={0}
            valueOf={(r, s) => { const c = cell(r, s); return c && !c.outaged && c.hours_over && period > 0 ? (c.hours_over[0] / period) * 100 : null; }} />
        )}
        {kind === 'acrossDelta' && (
          <GroupedBars {...common} unit="Δ Loading in pp" format={fmtPp} diverging
            valueOf={(r, s) => { const c = cell(r, s); return c && !c.outaged ? c.delta : null; }} />
        )}
      </div>
    );
  }

  // Branches, automatic top N (or the chosen ones in the LODF scatter).
  const lines = kind === 'acrossLodf' && chosen
    ? analysis.lines.filter((l) => chosen.some((c) => c.id === l.line.id))
    : analysis.lines;
  if (selecting && kind === 'acrossLodf' && (config.elementIds?.length ?? 0) === 0) return needChoice;
  return (
    <div className="across-scope">
      {progress}
      {kind === 'acrossLoading' && <LoadingRangeChart lines={lines} scenarios={analysis.scenarios} top={top} />}
      {kind === 'acrossTime' && <OverloadTimeChart lines={lines} scenarios={analysis.scenarios} periodHours={period} top={top} />}
      {kind === 'acrossDelta' && <DeltaChart lines={lines} scenarios={analysis.scenarios} top={top} />}
      {kind === 'acrossLodf' && <LodfChart lines={lines} scenarios={analysis.scenarios} hasLodf={data!.has_lodf} />}
    </div>
  );
}
