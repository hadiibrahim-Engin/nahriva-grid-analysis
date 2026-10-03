/**
 * Chart template registry.
 *
 * Every dynamically addable chart on the dashboard is described here as data,
 * decoupled from rendering. `ChartTemplatePicker` reads this registry to build
 * the searchable, category-grouped gallery, and `DynamicChartCard` switches on
 * `kind` to fetch the right data source and render the matching ECharts
 * component.
 *
 * The PowerFactory export delivers loading (L) and voltage (U) of a short scenario simulation, so
 * only charts that make sense for these two signals are registered.
 */

export type ChartCategory = 'scenarioEvaluation' | 'timeseries' | 'distribution' | 'limits' | 'correlation';

export const CATEGORY_LABELS: Record<ChartCategory, string> = {
  scenarioEvaluation: 'Scenario evaluation',
  timeseries: 'Time series',
  distribution: 'Distribution',
  limits: 'Limits',
  correlation: 'Correlation',
};

/** Fixed display order of categories in the picker. */
export const CATEGORY_ORDER: ChartCategory[] = ['scenarioEvaluation', 'timeseries', 'distribution', 'limits', 'correlation'];

/** How many source signals the template consumes. */
export type SignalArity = 'none' | 'one' | 'two' | 'three' | 'multi';

export const ARITY_LABELS: Record<SignalArity, string> = {
  none: 'All scenarios',
  one: 'One signal',
  two: 'Two signals',
  three: 'Three signals',
  multi: 'Several signals',
};

/** Discriminator consumed by DynamicChartCard to pick the fetch + render path. */
export type ChartKind =
  // Across-scenarios evaluation (no signals needed; reads the saved scenario results):
  | 'acrossLoading'
  | 'acrossTime'
  | 'acrossDelta'
  | 'acrossLodf'
  | 'acrossVoltage'
  | 'acrossVoltageDelta'
  // Charts of saved signals:
  | 'overlay'
  | 'aggTrend'
  | 'histogram'
  | 'durationCurve'
  | 'correlationScatter'
  | 'correlationScatter3'
  | 'correlationScatter3d'
  | 'correlationMatrix'
  | 'boxplot'
  | 'exceedance'
  // Client-side derived (computed from already-loaded raw timeseries):
  | 'rollingEnvelope'
  | 'thresholdBands'
  | 'anomalyScore'
  | 'voltageCompliance';

export interface ChartTemplate {
  id: string;
  kind: ChartKind;
  /** Short chart name shown on the card. */
  name: string;
  /** The engineering question this chart answers. */
  question: string;
  category: ChartCategory;
  /** Measurement types the user selects the source FROM, e.g. ['P','Q']. Empty = any. */
  measurements: string[];
  /**
   * Component-level charts derive their result from several measurements of ONE
   * equipment (e.g. the correlation matrix uses all measurements). The picker then
   * selects a COMPONENT, not a single measurement signal.
   */
  componentLevel?: boolean;
  arity: SignalArity;
  /**
   * Evaluates the saved scenarios as a whole instead of selected signals: no source selection,
   * the chart reads the scenario results itself (see components/across/AcrossChartBody).
   */
  scenarioLevel?: boolean;
  /** Show the equipment-count and equipment-type options of the scenario evaluation charts. */
  needsScenarioOptions?: boolean;
  /** Show a numeric threshold input in the config panel. */
  needsThreshold?: boolean;
  /** Show a configurable list of threshold levels. */
  needsThresholdLevels?: boolean;
  /** Override the generic "Threshold" label (e.g. "Nominal voltage"). */
  thresholdLabel?: string;
  /** Default value for the threshold input. */
  thresholdDefault?: number;
  /** Default values for multi-threshold charts. */
  thresholdLevelsDefault?: number[];
  /** Show min/max voltage compliance percentage inputs. */
  needsVoltageBand?: boolean;
  /** Default lower voltage limit, expressed as percent of nominal voltage. */
  voltageMinPercentDefault?: number;
  /** Default upper voltage limit, expressed as percent of nominal voltage. */
  voltageMaxPercentDefault?: number;
  /** Show an AVG/MIN/MAX/SUM selector. */
  needsAggregation?: boolean;
  /** Show a resolution / bucket selector. */
  needsResolution?: boolean;
  /** Show Y-axis scaling controls (auto/manual min-max, linear/log).
   * Meaningful for templates rendered with a numeric y-axis. */
  needsYAxisControl?: boolean;
  /** Show a single-vs-combined layout toggle (histogram with 2+ signals). */
  needsHistogramMode?: boolean;
  /** Show the boxplot bucketing selector (hour/weekday/month/weekday-weekend). */
  needsBoxplotGroupBy?: boolean;
  /** Show a single-vs-combined layout toggle (boxplot with 2+ signals). */
  needsBoxplotMode?: boolean;
  /** Show the correlation-statistic selector (Pearson/Spearman/Kendall). */
  needsCorrelationMethod?: boolean;
}

export const CHART_TEMPLATES: ChartTemplate[] = [
  // -- Scenario evaluation: the saved outage scenarios compared as a whole ------
  {
    id: 'across-loading-range',
    kind: 'acrossLoading',
    name: 'Highest loading per equipment',
    question: 'Which equipment reaches the highest loading across all scenarios (base to maximum)?',
    category: 'scenarioEvaluation',
    measurements: [],
    arity: 'none',
    scenarioLevel: true,
    needsScenarioOptions: true,
  },
  {
    id: 'across-overload-time',
    kind: 'acrossTime',
    name: 'Overload duration (overload rate)',
    question: 'How long and how strongly is equipment overloaded during the simulation period?',
    category: 'scenarioEvaluation',
    measurements: [],
    arity: 'none',
    scenarioLevel: true,
    needsScenarioOptions: true,
  },
  {
    id: 'across-delta',
    kind: 'acrossDelta',
    name: 'Change of loading',
    question: 'Which equipment changes its loading most because of an outage (pp compared with REF)?',
    category: 'scenarioEvaluation',
    measurements: [],
    arity: 'none',
    scenarioLevel: true,
    needsScenarioOptions: true,
  },
  {
    id: 'across-voltage',
    kind: 'acrossVoltage',
    name: 'Voltage per busbar',
    question: 'How does the voltage of the chosen busbars behave in the scenarios compared with the voltage band?',
    category: 'scenarioEvaluation',
    measurements: [],
    arity: 'none',
    scenarioLevel: true,
    needsScenarioOptions: true,
  },
  {
    id: 'across-voltage-delta',
    kind: 'acrossVoltageDelta',
    name: 'Voltage change (ΔU)',
    question: 'How much does an outage change the voltage of the chosen busbars compared with REF?',
    category: 'scenarioEvaluation',
    measurements: [],
    arity: 'none',
    scenarioLevel: true,
    needsScenarioOptions: true,
  },
  {
    id: 'across-lodf',
    kind: 'acrossLodf',
    name: 'LODF and change of loading',
    question: 'Where do a high LODF and a large additional load coincide?',
    category: 'scenarioEvaluation',
    measurements: [],
    arity: 'none',
    scenarioLevel: true,
    needsScenarioOptions: true,
  },
  // -- Signal charts: one or more saved signals --------------------------------
  {
    id: 'timeseries-overlay',
    kind: 'overlay',
    name: 'Time series overlay',
    question: 'How do several signals compare directly?',
    category: 'timeseries',
    measurements: [],
    arity: 'multi',
    needsYAxisControl: true,
  },
  {
    id: 'aggregated-trend',
    kind: 'aggTrend',
    name: 'Aggregated trend',
    question: 'What does the mean / min / max / sum trend look like at the chosen resolution?',
    category: 'timeseries',
    measurements: [],
    arity: 'multi',
    needsAggregation: true,
    needsResolution: true,
    needsYAxisControl: true,
  },
  {
    id: 'rolling-envelope',
    kind: 'rollingEnvelope',
    name: 'Rolling mean',
    question: 'How does the smoothed profile develop over time?',
    category: 'timeseries',
    measurements: [],
    arity: 'multi',
    needsResolution: true,
    needsYAxisControl: true,
  },
  {
    id: 'anomaly-score',
    kind: 'anomalyScore',
    name: 'Anomaly score (z-value)',
    question: 'When does the signal deviate statistically from its normal behaviour?',
    category: 'timeseries',
    measurements: [],
    arity: 'one',
    needsResolution: true,
    needsYAxisControl: true,
  },
  {
    id: 'histogram',
    kind: 'histogram',
    name: 'Histogram',
    question: 'How are the values of one or more time series distributed?',
    category: 'distribution',
    measurements: [],
    arity: 'multi',
    needsHistogramMode: true,
    needsYAxisControl: true,
  },
  {
    id: 'boxplot-distribution',
    kind: 'boxplot',
    name: 'Boxplot distribution',
    question: 'How do the values spread (median, quartiles, outliers), grouped by hour, weekday, month or weekday/weekend?',
    category: 'distribution',
    measurements: [],
    arity: 'multi',
    needsYAxisControl: true,
    needsBoxplotGroupBy: true,
    needsBoxplotMode: true,
  },
  {
    id: 'duration-curve',
    kind: 'durationCurve',
    name: 'Duration curve',
    question: 'For how long is a value exceeded over the period?',
    category: 'distribution',
    measurements: [],
    arity: 'multi',
    needsYAxisControl: true,
  },
  {
    id: 'exceedance-threshold',
    kind: 'exceedance',
    name: 'Threshold exceedance',
    question: 'How often and how strongly is a threshold exceeded?',
    category: 'limits',
    measurements: [],
    arity: 'one',
    needsThreshold: true,
    needsYAxisControl: true,
  },
  {
    id: 'multi-threshold-lines',
    kind: 'thresholdBands',
    name: 'Multi-level threshold lines',
    question: 'When does the signal reach warning and exceedance levels?',
    category: 'limits',
    measurements: [],
    arity: 'one',
    needsThresholdLevels: true,
    thresholdLevelsDefault: [80, 100],
    needsYAxisControl: true,
  },
  {
    id: 'voltage-compliance',
    kind: 'voltageCompliance',
    name: 'Voltage compliance',
    question: 'Does U leave the chosen band around the nominal voltage?',
    category: 'limits',
    measurements: ['U'],
    arity: 'one',
    needsThreshold: true,
    thresholdLabel: 'Nominal voltage (0 = automatic from data)',
    thresholdDefault: 0,
    needsVoltageBand: true,
    voltageMinPercentDefault: 90,
    voltageMaxPercentDefault: 110,
    needsYAxisControl: true,
  },
  {
    id: 'correlation-scatter',
    kind: 'correlationScatter',
    name: 'Correlation scatter',
    question: 'How are two measurements related (Pearson, Spearman or Kendall)?',
    category: 'correlation',
    measurements: [],
    arity: 'two',
    needsYAxisControl: true,
    needsCorrelationMethod: true,
  },
  {
    id: 'correlation-scatter-3d',
    kind: 'correlationScatter3',
    name: 'Colour-coded correlation scatter',
    question: 'How are two measurements related when a third one controls the point colour?',
    category: 'correlation',
    measurements: [],
    arity: 'three',
    needsYAxisControl: true,
    needsCorrelationMethod: true,
  },
  {
    id: 'correlation-scatter-3d-view',
    kind: 'correlationScatter3d',
    name: '3D correlation scatter',
    question: 'How do three measurements distribute together in X/Y/Z space?',
    category: 'correlation',
    measurements: [],
    arity: 'three',
    needsYAxisControl: true,
    needsCorrelationMethod: true,
  },
  {
    id: 'correlation-matrix',
    kind: 'correlationMatrix',
    name: 'Correlation matrix',
    question: 'How do all measurements of one equipment correlate with each other?',
    category: 'correlation',
    measurements: [],
    componentLevel: true,
    arity: 'one',
  },
];

export function getTemplate(id: string): ChartTemplate | undefined {
  return CHART_TEMPLATES.find((t) => t.id === id);
}
