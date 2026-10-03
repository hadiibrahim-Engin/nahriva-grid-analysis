/**
 * ChartTemplatePicker — the "Add chart" window.
 *
 * Step 1 (gallery): a searchable, category-grouped catalogue of every chart
 * template from the registry. Live templates are selectable; "coming soon"
 * templates render greyed-out for discoverability.
 *
 * Step 2 (config): once a template is chosen, the user wires up the source
 * signal(s) and any template-specific parameters (threshold, aggregation,
 * resolution). The global dashboard date range is inherited and shown read-only.
 * "Generate" hands a DashboardChartConfig back to the dashboard, which mounts a
 * DynamicChartCard — that card shows the circular "Generating" loader while its
 * data resolves.
 *
 * The window is styled with the dashboard's `--grid-*` theme tokens (scoped via
 * `grid-theme-scope`) so it matches the SCADA theme and follows light/dark.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AggregationFn, ResolutionInfo } from '../api/client';
import SearchableDropdown from './SearchableDropdown';
import {
  CHART_TEMPLATES,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  ARITY_LABELS,
  type ChartTemplate,
} from './charts/chartTemplates';
import { ChartPreview } from './charts/chartPreviews';
import ScenarioOptions from './across/ScenarioOptions';
import {
  seriesLabel,
  missingRequiredMeasurements,
  defaultThresholdLevelName,
  defaultThresholdLevelColor,
  normalizeThresholdLevelColor,
  normalizeThresholdLevelEntries,
  MTYPE_LABELS,
  type DashboardSeries,
  type DynamicChartConfig,
} from '../util/dynamicCharts';

const AGG_LABELS: Record<AggregationFn, string> = {
  AVG: 'Mittelwert',
  MIN: 'Minimum',
  MAX: 'Maximum',
  SUM: 'Summe',
};

// Shared token-based class fragments so the controls match the dashboard.
const PANEL_BG = 'bg-[var(--grid-surface)]';
const CONTROL_CLASS = 'grid-form-input';
const DEFAULT_THRESHOLD_LEVELS = [80, 100];

function normalizeThresholdLevels(levels: number[]): number[] {
  return [...new Set(levels.filter((level) => Number.isFinite(level)))]
    .sort((a, b) => a - b);
}

interface Props {
  open: boolean;
  onClose: () => void;
  availableSeries: DashboardSeries[];
  resolutions: ResolutionInfo[];
  startIso?: string;
  endIso?: string;
  onGenerate: (templateId: string, config: DynamicChartConfig) => void;
}

export default function ChartTemplatePicker({
  open,
  onClose,
  availableSeries,
  resolutions,
  startIso,
  endIso,
  onGenerate,
}: Props) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ChartTemplate | null>(null);

  // Config state
  const [primaryKey, setPrimaryKey] = useState<string | null>(null);
  const [secondaryKey, setSecondaryKey] = useState<string | null>(null);
  const [tertiaryKey, setTertiaryKey] = useState<string | null>(null);
  const [multiKeys, setMultiKeys] = useState<string[]>([]);
  const [threshold, setThreshold] = useState(80);
  const [thresholdLevels, setThresholdLevels] = useState<number[]>(DEFAULT_THRESHOLD_LEVELS);
  const [thresholdLevelNames, setThresholdLevelNames] = useState<string[]>([]);
  const [thresholdLevelColors, setThresholdLevelColors] = useState<string[]>([]);
  const [voltageMinPct, setVoltageMinPct] = useState(90);
  const [voltageMaxPct, setVoltageMaxPct] = useState(110);
  const [aggregation, setAggregation] = useState<AggregationFn>('AVG');
  const [resolutionMinutes, setResolutionMinutes] = useState(60);
  const [topN, setTopN] = useState(12);
  const [equipment, setEquipment] = useState<NonNullable<DynamicChartConfig['equipment']>>('all');

  const defaultResolution = useMemo(
    () => resolutions.find((r) => r.minutes === 60)?.minutes ?? resolutions.find((r) => r.minutes > 0)?.minutes ?? 60,
    [resolutions],
  );

  // Reset everything when the window is (re)opened.
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelected(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (selected) setSelected(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, selected, onClose]);

  // Source options narrow to the measurements a template requires.
  const sourceOptions = useMemo(() => {
    if (!selected || selected.measurements.length === 0) return availableSeries;
    return availableSeries.filter((s) => selected.measurements.includes(s.measurementType));
  }, [selected, availableSeries]);

  // Component-level templates pick a Betriebsmittel, not a single measurement.
  // One representative signal per distinct component identifies it.
  const componentOptions = useMemo(() => {
    const seen = new Map<string, DashboardSeries>();
    for (const s of availableSeries) if (!seen.has(s.componentId)) seen.set(s.componentId, s);
    return [...seen.values()];
  }, [availableSeries]);

  // Read via refs below: sourceOptions/componentOptions recompute whenever
  // availableSeries changes identity (e.g. live data polling), and listing
  // them as effect deps would reset the picker's selection on every such
  // change instead of only when the user picks a new template. Refreshed
  // after every render (not during render, which is unsafe for refs).
  const sourceOptionsRef = useRef(sourceOptions);
  const componentOptionsRef = useRef(componentOptions);
  useEffect(() => {
    sourceOptionsRef.current = sourceOptions;
    componentOptionsRef.current = componentOptions;
  });

  // Initialise config defaults whenever a template is picked.
  useEffect(() => {
    if (!selected) return;
    setThreshold(selected.thresholdDefault ?? 80);
    setThresholdLevels(selected.thresholdLevelsDefault ?? DEFAULT_THRESHOLD_LEVELS);
    setThresholdLevelNames([]);
    setThresholdLevelColors([]);
    setVoltageMinPct(selected.voltageMinPercentDefault ?? 90);
    setVoltageMaxPct(selected.voltageMaxPercentDefault ?? 110);
    setAggregation('AVG');
    setResolutionMinutes(defaultResolution);
    setTopN(12);
    setEquipment('all');
    setPrimaryKey(sourceOptionsRef.current[0]?.key ?? null);
    setSecondaryKey(sourceOptionsRef.current[1]?.key ?? null);
    setTertiaryKey(sourceOptionsRef.current[2]?.key ?? null);
    setMultiKeys(
      selected.componentLevel
        ? componentOptionsRef.current.map((c) => c.key)
        : sourceOptionsRef.current.map((s) => s.key),
    );
  }, [selected, defaultResolution]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return CHART_TEMPLATES;
    return CHART_TEMPLATES.filter((t) =>
      [t.name, t.question, t.measurements.join(' '), CATEGORY_LABELS[t.category]]
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [query]);

  if (!open) return null;

  const buildConfig = (): { ok: boolean; config: DynamicChartConfig; missingMeasurements: string[] } => {
    if (!selected) return { ok: false, config: { sourceKeys: [] }, missingMeasurements: [] };
    let sourceKeys: string[] = [];
    let ok = false;
    if (selected.scenarioLevel) {
      // Scenario evaluation needs no signals: it reads the saved scenario results itself.
      sourceKeys = [];
      ok = true;
    } else if (selected.componentLevel) {
      // One representative signal key per chosen Betriebsmittel; the card derives
      // the actually-needed measurements from the component automatically.
      sourceKeys = multiKeys;
      ok = multiKeys.length > 0;
    } else if (selected.arity === 'one') {
      sourceKeys = primaryKey ? [primaryKey] : [];
      ok = sourceKeys.length === 1;
    } else if (selected.arity === 'two') {
      sourceKeys = [primaryKey, secondaryKey].filter((k): k is string => !!k);
      ok = sourceKeys.length === 2 && primaryKey !== secondaryKey;
    } else if (selected.arity === 'three') {
      sourceKeys = [primaryKey, secondaryKey, tertiaryKey].filter((k): k is string => !!k);
      ok = sourceKeys.length === 3 && new Set(sourceKeys).size === 3;
    } else {
      sourceKeys = multiKeys;
      ok = multiKeys.length > 0;
    }
    // Required measurements only gate signal-level charts; component-level
    // charts auto-pull what they need (the backend rejects truly missing data).
    const missingMeasurements = ok && !selected.componentLevel
      ? missingRequiredMeasurements(selected.requiredComponentMeasurements, sourceKeys, availableSeries)
      : [];
    const normalizedThresholdEntries = normalizeThresholdLevelEntries(
      thresholdLevels,
      thresholdLevelNames,
      thresholdLevelColors,
    );
    const thresholdLevelsOk = !selected.needsThresholdLevels || normalizedThresholdEntries.length >= 2;
    return {
      ok: ok && missingMeasurements.length === 0 && thresholdLevelsOk,
      missingMeasurements,
      config: {
        sourceKeys,
        ...(selected.needsThreshold ? { threshold } : {}),
        ...(selected.needsThresholdLevels ? {
          thresholdLevels: normalizedThresholdEntries.map((entry) => entry.value),
          thresholdLevelNames: normalizedThresholdEntries.map((entry) => entry.name),
          thresholdLevelColors: normalizedThresholdEntries.map((entry) => entry.color),
        } : {}),
        ...(selected.needsVoltageBand ? { voltageMinPct, voltageMaxPct } : {}),
        ...(selected.needsAggregation ? { aggregation } : {}),
        ...(selected.needsResolution ? { resolutionMinutes } : {}),
        ...(selected.needsScenarioOptions ? { topN, equipment } : {}),
      },
    };
  };

  const { ok: canGenerate, config, missingMeasurements } = buildConfig();

  const handleGenerate = () => {
    if (!selected || !canGenerate) return;
    onGenerate(selected.id, config);
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="chart-picker-title"
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm animate-panel-enter"
      onClick={onClose}
    >
      <div
        className={`grid-theme-scope flex h-[min(94vh,860px)] w-[min(98vw,1480px)] flex-col overflow-hidden rounded-xl border border-[var(--grid-border)] ${PANEL_BG} text-[var(--grid-text)] shadow-2xl shadow-black/50`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-[var(--grid-border)] bg-[var(--grid-header)] px-5 py-4">
          <div className="flex items-center gap-3">
            {selected && (
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="rounded border border-[var(--grid-border)] bg-[var(--grid-control)] px-2 py-1 text-xs text-[var(--grid-text-soft)] transition-colors hover:bg-[var(--grid-control-hover)]"
              >
                ← Zurück
              </button>
            )}
            <h2 id="chart-picker-title" className="text-sm font-semibold tracking-wide text-[var(--grid-text)]">
              {selected ? selected.name : 'Diagramm hinzufügen'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Schließen"
            className="text-[var(--grid-muted)] transition-colors hover:text-[var(--grid-text)]"
          >
            ✕
          </button>
        </div>

        {!selected ? (
          <Gallery
            query={query}
            setQuery={setQuery}
            templates={filtered}
            onSelect={setSelected}
          />
        ) : (
          <ConfigPanel
            template={selected}
            sourceOptions={sourceOptions}
            componentOptions={componentOptions}
            availableSeriesCount={availableSeries.length}
            startIso={startIso}
            endIso={endIso}
            resolutions={resolutions}
            primaryKey={primaryKey}
            setPrimaryKey={setPrimaryKey}
            secondaryKey={secondaryKey}
            setSecondaryKey={setSecondaryKey}
            tertiaryKey={tertiaryKey}
            setTertiaryKey={setTertiaryKey}
            multiKeys={multiKeys}
            setMultiKeys={setMultiKeys}
            threshold={threshold}
            setThreshold={setThreshold}
            thresholdLevels={thresholdLevels}
            setThresholdLevels={setThresholdLevels}
            thresholdLevelNames={thresholdLevelNames}
            setThresholdLevelNames={setThresholdLevelNames}
            thresholdLevelColors={thresholdLevelColors}
            setThresholdLevelColors={setThresholdLevelColors}
            voltageMinPct={voltageMinPct}
            setVoltageMinPct={setVoltageMinPct}
            voltageMaxPct={voltageMaxPct}
            setVoltageMaxPct={setVoltageMaxPct}
            aggregation={aggregation}
            setAggregation={setAggregation}
            resolutionMinutes={resolutionMinutes}
            setResolutionMinutes={setResolutionMinutes}
            topN={topN}
            equipment={equipment}
            setScenarioOptions={(next) => { setTopN(next.topN); setEquipment(next.equipment); }}
            canGenerate={canGenerate}
            missingMeasurements={missingMeasurements}
            onGenerate={handleGenerate}
          />
        )}
      </div>
    </div>
  );
}

// -- Gallery ----------------------------------------------------------------

interface GalleryProps {
  query: string;
  setQuery: (q: string) => void;
  templates: ChartTemplate[];
  onSelect: (t: ChartTemplate) => void;
}

function Gallery({ query, setQuery, templates, onSelect }: GalleryProps) {
  return (
    <>
      <div className="border-b border-[var(--grid-border)] px-5 py-3">
        <input
          type="search"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Diagramme durchsuchen (Name, Frage, Messgröße)…"
          className="grid-form-input w-full"
        />
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {CATEGORY_ORDER.map((category) => {
          const items = templates.filter((t) => t.category === category);
          if (items.length === 0) return null;
          return (
            <div key={category} className="mb-6 last:mb-0">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--grid-muted)]">
                {CATEGORY_LABELS[category]}
              </h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {items.map((t) => (
                  <TemplateCard key={t.id} template={t} onSelect={onSelect} />
                ))}
              </div>
            </div>
          );
        })}
        {templates.length === 0 && (
          <div className="py-12 text-center text-sm text-[var(--grid-muted)]">Keine passenden Diagramme gefunden.</div>
        )}
      </div>
    </>
  );
}

function TemplateCard({ template, onSelect }: { template: ChartTemplate; onSelect: (t: ChartTemplate) => void }) {
  const disabled = !!template.comingSoon;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onSelect(template)}
      className={`flex flex-col rounded-lg border p-3 text-left transition-colors ${
        disabled
          ? 'cursor-not-allowed border-[var(--grid-border-soft)] bg-[var(--grid-subpanel)] opacity-55'
          : 'border-[var(--grid-border)] bg-[var(--grid-surface-strong)] hover:border-[var(--grid-primary)] hover:shadow-[0_0_0_1px_var(--grid-primary)]'
      }`}
    >
      {/* Visual preview */}
      <ChartPreview kind={template.kind} />

      {/* Name + coming-soon badge */}
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium text-[var(--grid-text)]">{template.name}</span>
        {template.comingSoon && (
          <span className="shrink-0 rounded-full bg-[var(--grid-control)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--grid-muted)]">
            Bald
          </span>
        )}
      </div>

      {/* Engineering question */}
      <p className="mt-1 flex-1 text-xs leading-relaxed text-[var(--grid-muted)]">{template.question}</p>

      {/* Measurement tags + arity */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {template.measurements.map((m) => (
          <span
            key={m}
            className="rounded bg-[var(--grid-info-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--grid-info)]"
          >
            {m}
          </span>
        ))}
        <span className="ml-auto text-[10px] uppercase tracking-wide text-[var(--grid-muted-2)]">
          {ARITY_LABELS[template.arity]}
        </span>
      </div>
    </button>
  );
}

// -- Config panel -------------------------------------------------------------

interface ConfigPanelProps {
  template: ChartTemplate;
  sourceOptions: DashboardSeries[];
  componentOptions: DashboardSeries[];
  availableSeriesCount: number;
  startIso?: string;
  endIso?: string;
  resolutions: ResolutionInfo[];
  primaryKey: string | null;
  setPrimaryKey: (k: string | null) => void;
  secondaryKey: string | null;
  setSecondaryKey: (k: string | null) => void;
  tertiaryKey: string | null;
  setTertiaryKey: (k: string | null) => void;
  multiKeys: string[];
  setMultiKeys: (k: string[]) => void;
  threshold: number;
  setThreshold: (n: number) => void;
  thresholdLevels: number[];
  setThresholdLevels: (levels: number[]) => void;
  thresholdLevelNames: string[];
  setThresholdLevelNames: (names: string[]) => void;
  thresholdLevelColors: string[];
  setThresholdLevelColors: (colors: string[]) => void;
  voltageMinPct: number;
  setVoltageMinPct: (n: number) => void;
  voltageMaxPct: number;
  setVoltageMaxPct: (n: number) => void;
  aggregation: AggregationFn;
  setAggregation: (a: AggregationFn) => void;
  resolutionMinutes: number;
  setResolutionMinutes: (n: number) => void;
  topN: number;
  equipment: NonNullable<DynamicChartConfig['equipment']>;
  setScenarioOptions: (next: { topN: number; equipment: NonNullable<DynamicChartConfig['equipment']> }) => void;
  canGenerate: boolean;
  missingMeasurements: string[];
  onGenerate: () => void;
}

function ThresholdLevelsEditor({
  levels,
  names,
  colors,
  onChange,
  onNamesChange,
  onColorsChange,
}: {
  levels: number[];
  names: string[];
  colors: string[];
  onChange: (levels: number[]) => void;
  onNamesChange: (names: string[]) => void;
  onColorsChange: (colors: string[]) => void;
}) {
  const updateLevel = (index: number, value: number) => {
    onChange(levels.map((level, i) => (i === index ? value : level)));
  };
  const updateName = (index: number, name: string) => {
    const nextNames = levels.map((_, i) => names[i] ?? defaultThresholdLevelName(i, levels.length));
    nextNames[index] = name;
    onNamesChange(nextNames);
  };
  const updateColor = (index: number, color: string) => {
    const nextColors = levels.map((_, i) => normalizeThresholdLevelColor(colors[i], i, levels.length));
    nextColors[index] = normalizeThresholdLevelColor(color, index, levels.length);
    onColorsChange(nextColors);
  };
  const addLevel = () => {
    const normalized = normalizeThresholdLevels(levels);
    const last = normalized[normalized.length - 1] ?? 100;
    onChange([...levels, last + 10]);
    onColorsChange([
      ...levels.map((_, i) => normalizeThresholdLevelColor(colors[i], i, levels.length)),
      defaultThresholdLevelColor(levels.length, levels.length + 1),
    ]);
  };
  const removeLevel = (index: number) => {
    onChange(levels.filter((_, i) => i !== index));
    onNamesChange(names.filter((_, i) => i !== index));
    onColorsChange(colors.filter((_, i) => i !== index));
  };

  return (
    <div className="w-full max-w-[520px]">
      <div className="mb-1 flex items-center justify-between gap-3">
        <label className="text-xs text-[var(--grid-muted)]">Schwellenstufen</label>
        <button
          type="button"
          onClick={addLevel}
          className="rounded border border-[var(--grid-border)] bg-[var(--grid-control)] px-2 py-1 text-xs text-[var(--grid-text-soft)] transition-colors hover:bg-[var(--grid-control-hover)]"
        >
          + Stufe
        </button>
      </div>
      <div className="space-y-2 rounded border border-[var(--grid-border)] bg-[var(--grid-subpanel)] p-2">
        {levels.map((level, index) => {
          const fallbackLabel = defaultThresholdLevelName(index, levels.length);
          const label = names[index] ?? fallbackLabel;
          const tone = normalizeThresholdLevelColor(colors[index], index, levels.length);
          return (
            <div key={index} className="flex items-center gap-2">
              <label className="relative h-7 w-7 shrink-0 overflow-hidden rounded-full border border-[var(--grid-border)]" title={`${label} Farbe`}>
                <span
                  aria-hidden
                  className="absolute inset-0"
                  style={{ background: tone, boxShadow: `0 0 8px ${tone}` }}
                />
                <input
                  type="color"
                  value={tone}
                  onChange={(e) => updateColor(index, e.target.value)}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  aria-label={`${label} Farbe`}
                />
              </label>
              <input
                type="text"
                value={label}
                onChange={(e) => updateName(index, e.target.value)}
                className={`${CONTROL_CLASS} w-36`}
                aria-label={`${fallbackLabel} Name`}
              />
              <input
                type="number"
                title={label}
                value={Number.isFinite(level) ? level : ''}
                onChange={(e) => updateLevel(index, Number(e.target.value))}
                className={`${CONTROL_CLASS} w-32`}
              />
              <button
                type="button"
                onClick={() => removeLevel(index)}
                className="rounded border border-[var(--grid-border)] px-2 py-1 text-xs text-[var(--grid-muted)] transition-colors hover:bg-[var(--grid-control-hover)] hover:text-[var(--grid-text)]"
                aria-label={`${label} entfernen`}
              >
                Entfernen
              </button>
            </div>
          );
        })}
      </div>
      <p className="mt-1 text-xs text-[var(--grid-muted-2)]">
        Die Kurve bleibt bis zur ersten Schwelle normal, wird danach orange und ab der letzten Schwelle rot.
      </p>
    </div>
  );
}

function ConfigPanel(props: ConfigPanelProps) {
  const {
    template, sourceOptions, componentOptions, availableSeriesCount, resolutions,
    primaryKey, setPrimaryKey, secondaryKey, setSecondaryKey, tertiaryKey, setTertiaryKey, multiKeys, setMultiKeys,
    threshold, setThreshold, thresholdLevels, setThresholdLevels, voltageMinPct, setVoltageMinPct, voltageMaxPct, setVoltageMaxPct,
    thresholdLevelNames, setThresholdLevelNames,
    thresholdLevelColors, setThresholdLevelColors,
    aggregation, setAggregation, resolutionMinutes, setResolutionMinutes,
    topN, equipment, setScenarioOptions,
    canGenerate, missingMeasurements, onGenerate,
  } = props;

  // Component-level templates choose Betriebsmittel; everything else chooses signals.
  const pickList = template.componentLevel ? componentOptions : sourceOptions;
  const noSources = availableSeriesCount === 0;
  const noMatchingSources = pickList.length === 0;
  const allSelected = multiKeys.length === pickList.length && pickList.length > 0;

  const toggleMulti = (key: string) => {
    setMultiKeys(multiKeys.includes(key) ? multiKeys.filter((k) => k !== key) : [...multiKeys, key]);
  };
  const toggleAll = () => {
    setMultiKeys(allSelected ? [] : pickList.map((s) => s.key));
  };

  return (
    <>
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <p className="mb-4 text-xs leading-relaxed text-[var(--grid-muted)]">{template.question}</p>

        {template.scenarioLevel ? (
          <div className="flex flex-wrap items-end gap-4">
            <ScenarioOptions topN={topN} equipment={equipment} onChange={setScenarioOptions} />
          </div>
        ) : noSources ? (
          <div className="rounded border border-[var(--grid-warning)]/40 bg-[var(--grid-danger-soft)] px-4 py-3 text-sm text-[var(--grid-warning)]">
            Zuerst Zeitreihen über die Dropdowns oben hinzufügen, dann steht dieses Diagramm als Quelle zur Verfügung.
          </div>
        ) : noMatchingSources ? (
          <div className="rounded border border-[var(--grid-warning)]/40 bg-[var(--grid-danger-soft)] px-4 py-3 text-sm text-[var(--grid-warning)]">
            Keine passende Messgröße in der Auswahl. Dieses Diagramm benötigt: {template.measurements.join(', ')}.
          </div>
        ) : (
          <div className="space-y-4">
            {/* Component-level: pick Betriebsmittel; needed measurements auto-pulled. */}
            {template.componentLevel && (
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-xs text-[var(--grid-muted)]">Betriebsmittel ({multiKeys.length} gewählt)</label>
                  <button
                    type="button"
                    onClick={toggleAll}
                    className="text-xs text-[var(--grid-info)] transition-colors hover:text-[var(--grid-primary)]"
                  >
                    {allSelected ? 'Keine' : 'Alle'}
                  </button>
                </div>
                <div className="max-h-44 space-y-1 overflow-y-auto rounded border border-[var(--grid-border)] bg-[var(--grid-subpanel)] p-2">
                  {componentOptions.map((c) => (
                    <label
                      key={c.key}
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm text-[var(--grid-text-soft)] hover:bg-[var(--grid-control-hover)]"
                    >
                      <input
                        type="checkbox"
                        checked={multiKeys.includes(c.key)}
                        onChange={() => toggleMulti(c.key)}
                        className="accent-[var(--grid-primary)]"
                      />
                      <span className="truncate">{c.facilityName} / {c.componentName}</span>
                    </label>
                  ))}
                </div>
                <p className="mt-1 text-xs text-[var(--grid-muted-2)]">
                  Die benötigten Messgrößen werden automatisch herangezogen. Mehrere Betriebsmittel ergeben je ein Diagramm.
                </p>
              </div>
            )}
            {/* Source selectors */}
            {!template.componentLevel && template.arity === 'one' && (
              <SearchableDropdown
                label="Quelle"
                items={sourceOptions}
                idOf={(s) => s.key}
                labelOf={(s) => seriesLabel(s)}
                value={primaryKey}
                onChange={setPrimaryKey}
                placeholder="Zeitreihe wählen"
                emptyHint="Keine Zeitreihen"
                className="min-w-[280px] max-w-[460px]"
              />
            )}
            {template.arity === 'two' && (
              <div className="flex flex-wrap gap-3">
                <SearchableDropdown
                  label="X-Zeitreihe"
                  items={sourceOptions}
                  idOf={(s) => s.key}
                  labelOf={(s) => seriesLabel(s)}
                  value={primaryKey}
                  onChange={setPrimaryKey}
                  placeholder="X wählen"
                  className="min-w-[260px]"
                />
                <SearchableDropdown
                  label="Y-Zeitreihe"
                  items={sourceOptions}
                  idOf={(s) => s.key}
                  labelOf={(s) => seriesLabel(s)}
                  value={secondaryKey}
                  onChange={setSecondaryKey}
                  placeholder="Y wählen"
                  className="min-w-[260px]"
                />
              </div>
            )}
            {template.arity === 'three' && (
              <div className="flex flex-wrap gap-3">
                <SearchableDropdown
                  label="X-Zeitreihe"
                  items={sourceOptions}
                  idOf={(s) => s.key}
                  labelOf={(s) => seriesLabel(s)}
                  value={primaryKey}
                  onChange={setPrimaryKey}
                  placeholder="X wählen"
                  className="min-w-[260px]"
                />
                <SearchableDropdown
                  label="Y-Zeitreihe"
                  items={sourceOptions}
                  idOf={(s) => s.key}
                  labelOf={(s) => seriesLabel(s)}
                  value={secondaryKey}
                  onChange={setSecondaryKey}
                  placeholder="Y wählen"
                  className="min-w-[260px]"
                />
                <SearchableDropdown
                  label={template.kind === 'correlationScatter3d' ? 'Z-Zeitreihe' : 'Farbe (Z-Zeitreihe)'}
                  items={sourceOptions}
                  idOf={(s) => s.key}
                  labelOf={(s) => seriesLabel(s)}
                  value={tertiaryKey}
                  onChange={setTertiaryKey}
                  placeholder="Z wählen"
                  className="min-w-[260px]"
                />
              </div>
            )}
            {template.arity === 'multi' && (
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-xs text-[var(--grid-muted)]">Quellen ({multiKeys.length} gewählt)</label>
                  <button
                    type="button"
                    onClick={toggleAll}
                    className="text-xs text-[var(--grid-info)] transition-colors hover:text-[var(--grid-primary)]"
                  >
                    {allSelected ? 'Keine' : 'Alle'}
                  </button>
                </div>
                <div className="max-h-44 space-y-1 overflow-y-auto rounded border border-[var(--grid-border)] bg-[var(--grid-subpanel)] p-2">
                  {sourceOptions.map((s) => (
                    <label
                      key={s.key}
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm text-[var(--grid-text-soft)] hover:bg-[var(--grid-control-hover)]"
                    >
                      <input
                        type="checkbox"
                        checked={multiKeys.includes(s.key)}
                        onChange={() => toggleMulti(s.key)}
                        className="accent-[var(--grid-primary)]"
                      />
                      <span className="truncate">{seriesLabel(s)}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* Parameter controls */}
            <div className="flex flex-wrap gap-4">
              {template.needsAggregation && (
                <div>
                  <label className="mb-1 block text-xs text-[var(--grid-muted)]">Aggregation</label>
                  <select value={aggregation} onChange={(e) => setAggregation(e.target.value as AggregationFn)} className={CONTROL_CLASS}>
                    {(Object.keys(AGG_LABELS) as AggregationFn[]).map((fn) => (
                      <option key={fn} value={fn}>{AGG_LABELS[fn]}</option>
                    ))}
                  </select>
                </div>
              )}
              {template.needsResolution && (
                <div>
                  <label className="mb-1 block text-xs text-[var(--grid-muted)]">Auflösung</label>
                  <select value={resolutionMinutes} onChange={(e) => setResolutionMinutes(Number(e.target.value))} className={CONTROL_CLASS}>
                    {resolutions.filter((r) => r.minutes > 0).map((r) => (
                      <option key={r.minutes} value={r.minutes}>{r.label}</option>
                    ))}
                  </select>
                </div>
              )}
              {template.needsThreshold && (
                <div>
                  <label className="mb-1 block text-xs text-[var(--grid-muted)]">{template.thresholdLabel ?? 'Schwellwert'}</label>
                  <input
                    type="number"
                    value={threshold}
                    onChange={(e) => setThreshold(Number(e.target.value))}
                    className={`${CONTROL_CLASS} w-40`}
                  />
                </div>
              )}
              {template.needsThresholdLevels && (
                <ThresholdLevelsEditor
                  levels={thresholdLevels}
                  names={thresholdLevelNames}
                  colors={thresholdLevelColors}
                  onChange={setThresholdLevels}
                  onNamesChange={setThresholdLevelNames}
                  onColorsChange={setThresholdLevelColors}
                />
              )}
              {template.needsVoltageBand && (
                <>
                  <div>
                    <label className="mb-1 block text-xs text-[var(--grid-muted)]">Min. Spannung (%)</label>
                    <input
                      type="number"
                      min={0}
                      step={0.1}
                      value={voltageMinPct}
                      onChange={(e) => setVoltageMinPct(Number(e.target.value))}
                      className={`${CONTROL_CLASS} w-40`}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-[var(--grid-muted)]">Max. Spannung (%)</label>
                    <input
                      type="number"
                      min={0}
                      step={0.1}
                      value={voltageMaxPct}
                      onChange={(e) => setVoltageMaxPct(Number(e.target.value))}
                      className={`${CONTROL_CLASS} w-40`}
                    />
                  </div>
                </>
              )}
            </div>

            {/* Required-measurement gate: name exactly which physical inputs
                are missing so the user knows what to load. */}
            {missingMeasurements.length > 0 && (
              <div
                role="alert"
                className="rounded border border-[var(--grid-warning)]/40 bg-[var(--grid-danger-soft)] px-4 py-3 text-sm text-[var(--grid-warning)]"
              >
                Für diese Auswertung fehlen Messgrößen am Betriebsmittel:{' '}
                <strong>{missingMeasurements.map((m) => MTYPE_LABELS[m] ?? m).join(', ')}</strong>.
                Bitte zuerst diese Zeitreihe(n) über die Dropdowns oben hinzufügen.
              </div>
            )}
            {template.needsThresholdLevels && normalizeThresholdLevels(thresholdLevels).length < 2 && (
              <div
                role="alert"
                className="rounded border border-[var(--grid-warning)]/40 bg-[var(--grid-danger-soft)] px-4 py-3 text-sm text-[var(--grid-warning)]"
              >
                Bitte mindestens zwei Schwellen eintragen: eine Warnstufe und eine Überschreitungsstufe.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between gap-3 border-t border-[var(--grid-border)] bg-[var(--grid-header)] px-5 py-3">
        <span className="text-xs text-[var(--grid-muted)]">
          {missingMeasurements.length > 0
            ? `Fehlende Größe(n): ${missingMeasurements.map((m) => MTYPE_LABELS[m] ?? m).join(', ')}`
            : ''}
        </span>
        <button
          type="button"
          onClick={onGenerate}
          disabled={!canGenerate}
          className="rounded bg-[var(--grid-primary)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--grid-primary-hover)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Generieren
        </button>
      </div>
    </>
  );
}
