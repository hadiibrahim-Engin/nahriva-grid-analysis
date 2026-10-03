import { useMemo } from 'react';
import { DeltaChart, LoadingRangeChart, LodfChart, OverloadTimeChart } from './AcrossCharts';
import { useAcrossData } from '../../hooks/useAcrossData';
import { analyse } from '../../util/acrossScenarios';
import { filterByEquipment } from '../../util/freischaltung';
import type { ChartKind } from '../charts/chartTemplates';
import type { DynamicChartConfig } from '../../util/dynamicCharts';

/**
 * Body of the scenario evaluation charts added through "Diagramm hinzufügen". It needs no selected
 * signals: it reads the saved scenario results itself, through the same lazy, shared loading as the
 * summary, and follows new scenarios automatically.
 */
export default function AcrossChartBody({ kind, config }: { kind: ChartKind; config: DynamicChartConfig }) {
  const { data, total, shown, loading, error } = useAcrossData(0);
  const top = config.topN && config.topN > 0 ? config.topN : 12;
  const analysis = useMemo(() => {
    if (!data) return null;
    return analyse({ ...data, lines: filterByEquipment(data.lines, config.equipment ?? 'all') });
  }, [data, config.equipment]);

  if (error && !data) return <div className="ab-empty" role="alert">{error}</div>;
  if (!analysis || analysis.scenarios.length === 0) {
    return <div className="ab-empty" aria-busy={loading}>{loading || total > 0 ? 'Szenarien werden geladen …' : 'Noch keine berechneten Szenarien.'}</div>;
  }
  return (
    <div className="across-scope">
      {loading && shown < total && <div className="ab-progress" role="status">Szenarien {shown} / {total}</div>}
      {kind === 'acrossLoading' && <LoadingRangeChart lines={analysis.lines} scenarios={analysis.scenarios} top={top} />}
      {kind === 'acrossTime' && <OverloadTimeChart lines={analysis.lines} scenarios={analysis.scenarios} periodHours={data!.period_hours} top={top} />}
      {kind === 'acrossDelta' && <DeltaChart lines={analysis.lines} scenarios={analysis.scenarios} top={top} />}
      {kind === 'acrossLodf' && <LodfChart lines={analysis.lines} scenarios={analysis.scenarios} hasLodf={data!.has_lodf} />}
    </div>
  );
}
