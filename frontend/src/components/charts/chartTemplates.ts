/**
 * Chart template registry.
 *
 * Every dynamically addable chart on the dashboard is described here as data,
 * decoupled from rendering. `ChartTemplatePicker` reads this registry to build
 * the searchable, category-grouped gallery, and `DynamicChartCard` switches on
 * `kind` to fetch the right data source and render the matching ECharts
 * component.
 *
 * Templates whose backend data does not exist yet are flagged `comingSoon` —
 * they still appear in the gallery (greyed out, non-selectable) so the product
 * surface is discoverable, but they cannot be generated.
 */

export type ChartCategory =
  | 'scenarioEvaluation'
  | 'timeseries'
  | 'distribution'
  | 'powerQuality'
  | 'gridOperation'
  | 'correlation'
  | 'forecastEvents'
  | 'dataQuality';

export const CATEGORY_LABELS: Record<ChartCategory, string> = {
  scenarioEvaluation: 'Szenarioauswertung',
  timeseries: 'Zeitreihen',
  distribution: 'Verteilung',
  powerQuality: 'Netzqualität',
  gridOperation: 'Netzbetrieb',
  correlation: 'Korrelation',
  forecastEvents: 'Prognose / Ereignisse',
  dataQuality: 'Datenqualität',
};

/** Fixed display order of categories in the picker. */
export const CATEGORY_ORDER: ChartCategory[] = [
  'scenarioEvaluation',
  'timeseries',
  'distribution',
  'powerQuality',
  'gridOperation',
  'correlation',
  'forecastEvents',
  'dataQuality',
];

/** How many source signals the template consumes. */
export type SignalArity = 'none' | 'one' | 'two' | 'three' | 'multi';

export const ARITY_LABELS: Record<SignalArity, string> = {
  none: 'Alle Szenarien',
  one: 'Ein Signal',
  two: 'Zwei Signale',
  three: 'Drei Signale',
  multi: 'Mehrere Signale',
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
  | 'overlay'
  | 'aggTrend'
  | 'histogram'
  | 'heatmap'
  | 'durationCurve'
  | 'dailyProfile'
  | 'peakDemand'
  | 'correlationScatter'
  | 'correlationScatter3'
  | 'correlationScatter3d'
  | 'correlationMatrix'
  | 'boxplot'
  | 'powerFactor'
  | 'exceedance'
  | 'quality'
  | 'dst'
  | 'seasonRadar'
  // Client-side derived (computed from already-loaded raw timeseries):
  | 'pqQuadrant'
  | 'quScatter'
  | 'energyIntegral'
  | 'lossesEfficiency'
  | 'assetLoading'
  | 'overloadDuration'
  | 'rollingEnvelope'
  | 'thresholdBands'
  | 'anomalyScore'
  | 'voltageCompliance'
  | 'comingSoon';

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
   * Measurement types the selected COMPONENT must provide for the calculation
   * to be physically correct, e.g. power factor needs P, Q AND S of the same
   * component. Checked against the loaded signals; the Add-chart action is
   * blocked (with a clear hint) until all are present. Empty/undefined = none.
   */
  requiredComponentMeasurements?: string[];
  /**
   * Component-level charts derive their result from several measurements of ONE
   * Betriebsmittel (e.g. power factor uses P, Q, S; the correlation matrix uses
   * all measurements). The picker then selects a COMPONENT, not a single
   * measurement signal — picking "P" alone would be misleading.
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
  /** Override the generic "Schwellwert" label (e.g. "Bemessungsleistung (MVA)"). */
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
  /** Still registered for discoverability but not yet renderable (no data source). */
  comingSoon?: boolean;
}

export const CHART_TEMPLATES: ChartTemplate[] = [
  // -- Scenario evaluation: the saved outage scenarios compared as a whole ------
  {
    id: 'across-loading-range',
    kind: 'acrossLoading',
    name: 'Höchste Auslastung je Betriebsmittel',
    question: 'Welche Betriebsmittel erreichen über alle Szenarien die höchste Auslastung (Base bis Maximum)?',
    category: 'scenarioEvaluation',
    measurements: [],
    arity: 'none',
    scenarioLevel: true,
    needsScenarioOptions: true,
  },
  {
    id: 'across-overload-time',
    kind: 'acrossTime',
    name: 'Überlastdauer (Overload Rate)',
    question: 'Wie lange und wie stark sind Betriebsmittel im Simulationszeitraum überlastet?',
    category: 'scenarioEvaluation',
    measurements: [],
    arity: 'none',
    scenarioLevel: true,
    needsScenarioOptions: true,
  },
  {
    id: 'across-delta',
    kind: 'acrossDelta',
    name: 'Änderung der Auslastung',
    question: 'Welche Betriebsmittel ändern ihre Auslastung durch eine Freischaltung am stärksten (pp gegenüber REF)?',
    category: 'scenarioEvaluation',
    measurements: [],
    arity: 'none',
    scenarioLevel: true,
    needsScenarioOptions: true,
  },
  {
    id: 'across-voltage',
    kind: 'acrossVoltage',
    name: 'Spannung je Sammelschiene',
    question: 'Wie verhält sich die Spannung der gewählten Sammelschienen in den Szenarien gegenüber dem Spannungsband?',
    category: 'scenarioEvaluation',
    measurements: [],
    arity: 'none',
    scenarioLevel: true,
    needsScenarioOptions: true,
  },
  {
    id: 'across-voltage-delta',
    kind: 'acrossVoltageDelta',
    name: 'Spannungsänderung (ΔU)',
    question: 'Wie stark ändert eine Freischaltung die Spannung der gewählten Sammelschienen gegenüber REF?',
    category: 'scenarioEvaluation',
    measurements: [],
    arity: 'none',
    scenarioLevel: true,
    needsScenarioOptions: true,
  },
  {
    id: 'across-lodf',
    kind: 'acrossLodf',
    name: 'LODF und Änderung der Auslastung',
    question: 'Wo treffen ein hoher LODF und eine große Mehrbelastung zusammen?',
    category: 'scenarioEvaluation',
    measurements: [],
    arity: 'none',
    scenarioLevel: true,
    needsScenarioOptions: true,
  },
  // -- Live templates (backed by existing API + chart components) ----------
  {
    id: 'timeseries-overlay',
    kind: 'overlay',
    name: 'Zeitreihen-Overlay',
    question: 'Wie verlaufen mehrere Signale im direkten Vergleich?',
    category: 'timeseries',
    measurements: [],
    arity: 'multi',
    needsYAxisControl: true,
  },
  {
    id: 'aggregated-trend',
    kind: 'aggTrend',
    name: 'Aggregierter Trend',
    question: 'Wie sieht der Mittel-/Min-/Max-/Summen-Trend bei gewählter Auflösung aus?',
    category: 'timeseries',
    measurements: [],
    arity: 'multi',
    needsAggregation: true,
    needsResolution: true,
    needsYAxisControl: true,
  },
  {
    id: 'daily-profile',
    kind: 'dailyProfile',
    name: 'Tagesprofil',
    question: 'Wie unterscheidet sich der mittlere Tagesverlauf an Werktagen und Wochenenden?',
    category: 'timeseries',
    measurements: [],
    arity: 'multi',
    needsYAxisControl: true,
  },
  {
    id: 'season-radar',
    kind: 'seasonRadar',
    name: 'Saison-Radar',
    question: 'Wie sieht der saisonale Fingerabdruck über die Monate aus?',
    category: 'timeseries',
    // Season radar is backed by P/Q/S monthly medians; only the picked ones
    // are computed and drawn (one radar per Betriebsmittel, polygons combined).
    measurements: ['P', 'Q', 'S'],
    arity: 'multi',
  },
  {
    id: 'histogram',
    kind: 'histogram',
    name: 'Histogramm',
    question: 'Wie sind die Messwerte einer oder mehrerer Zeitreihen verteilt?',
    category: 'distribution',
    measurements: [],
    arity: 'multi',
    needsHistogramMode: true,
    needsYAxisControl: true,
  },
  {
    id: 'boxplot-distribution',
    kind: 'boxplot',
    name: 'Boxplot-Verteilung',
    question: 'Wie streuen die Werte (Median, Quartile, Ausreißer) — gruppiert nach Stunde, Wochentag, Monat oder Werktag/Wochenende?',
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
    name: 'Dauerlinie',
    question: 'Wie lange wird ein Wert über den Zeitraum überschritten?',
    category: 'distribution',
    measurements: [],
    arity: 'multi',
    needsYAxisControl: true,
  },
  {
    id: 'power-factor',
    kind: 'powerFactor',
    name: 'Leistungsfaktor',
    question: 'Wie verhält sich cos φ / tan φ aus P, Q und S?',
    category: 'powerQuality',
    measurements: [],
    // Component-level: the backend derives cos φ / tan φ from the
    // Betriebsmittel's P, Q, S — the user picks the component, not a single
    // measurement, and the needed inputs are pulled automatically.
    componentLevel: true,
    arity: 'one',
    needsYAxisControl: true,
  },
  {
    id: 'day-hour-heatmap',
    kind: 'heatmap',
    name: 'Tag/Stunde-Heatmap',
    question: 'Welche Last- bzw. Spannungsmuster zeigen sich nach Wochentag und Stunde?',
    category: 'gridOperation',
    // Two heatmaps cannot share axes, so multiple signals are switched via a
    // dropdown on the card instead of being combined.
    measurements: [],
    arity: 'multi',
  },
  {
    id: 'peak-demand',
    kind: 'peakDemand',
    name: 'Spitzenlast',
    question: 'Wann treten Tages-, Wochen- oder Monatsspitzen auf und wer trägt dazu bei?',
    category: 'gridOperation',
    measurements: ['P'],
    arity: 'multi',
    needsYAxisControl: true,
  },
  {
    id: 'exceedance-threshold',
    kind: 'exceedance',
    name: 'Schwellwertüberschreitung',
    question: 'Wie oft und wie stark wird ein Schwellwert überschritten?',
    category: 'gridOperation',
    measurements: [],
    arity: 'one',
    needsThreshold: true,
    needsYAxisControl: true,
  },
  {
    id: 'multi-threshold-lines',
    kind: 'thresholdBands',
    name: 'Mehrstufige Schwellwertlinien',
    question: 'Wann erreicht das Signal Warn- und Überschreitungsstufen?',
    category: 'gridOperation',
    measurements: [],
    arity: 'one',
    needsThresholdLevels: true,
    thresholdLevelsDefault: [80, 100],
    needsYAxisControl: true,
  },
  {
    id: 'correlation-scatter',
    kind: 'correlationScatter',
    name: 'Korrelations-Scatter',
    question: 'Wie hängen zwei Messgrößen zusammen (Pearson, Spearman oder Kendall)?',
    category: 'correlation',
    measurements: [],
    arity: 'two',
    needsYAxisControl: true,
    needsCorrelationMethod: true,
  },
  {
    id: 'correlation-scatter-3d',
    kind: 'correlationScatter3',
    name: 'Farbkodierter Korrelations-Scatter',
    question: 'Wie hängen zwei Messgrößen zusammen, wenn eine dritte die Punktfarbe steuert?',
    category: 'correlation',
    measurements: [],
    arity: 'three',
    needsYAxisControl: true,
    needsCorrelationMethod: true,
  },
  {
    id: 'correlation-scatter-3d-view',
    kind: 'correlationScatter3d',
    name: '3D-Korrelations-Scatter',
    question: 'Wie verteilen sich drei Messgrößen gemeinsam im X/Y/Z-Raum?',
    category: 'correlation',
    measurements: [],
    arity: 'three',
    needsYAxisControl: true,
    needsCorrelationMethod: true,
  },
  {
    id: 'correlation-matrix',
    kind: 'correlationMatrix',
    name: 'Korrelationsmatrix',
    question: 'Wie korrelieren alle Messgrößen eines Betriebsmittels untereinander?',
    category: 'correlation',
    measurements: [],
    componentLevel: true,
    arity: 'one',
  },
  {
    id: 'dst-anomaly',
    kind: 'dst',
    name: 'Zeitumstellung / Zeit-Anomalie',
    question: 'Treten an Zeitumstellungstagen fehlende oder doppelte Stunden auf?',
    category: 'forecastEvents',
    measurements: [],
    componentLevel: true,
    arity: 'one',
  },
  {
    id: 'quality-gap-heatmap',
    kind: 'quality',
    name: 'Qualitäts-Lücken-Heatmap',
    question: 'Wo fehlen Messwerte nach Tag und Stunde?',
    category: 'dataQuality',
    measurements: [],
    componentLevel: true,
    arity: 'one',
  },

  // -- Client-side derived (computed from the loaded raw timeseries) -------
  {
    id: 'pq-quadrant',
    kind: 'pqQuadrant',
    name: 'P-Q-Quadrant',
    question: 'In welchem Lastquadranten (P/Q) arbeitet das Betriebsmittel?',
    category: 'powerQuality',
    measurements: ['P', 'Q'],
    arity: 'two',
    needsYAxisControl: true,
  },
  {
    id: 'qu-scatter',
    kind: 'quScatter',
    name: 'Q-U-Scatter',
    question: 'Wie hängt die Blindleistung von der Spannung ab?',
    category: 'correlation',
    measurements: ['Q', 'U'],
    arity: 'two',
    needsYAxisControl: true,
  },
  {
    id: 'energy-integral',
    kind: 'energyIntegral',
    name: 'Energie-Integral',
    question: 'Wie viel Energie (∫P dt) wurde im Zeitraum umgesetzt?',
    category: 'gridOperation',
    measurements: ['P'],
    arity: 'one',
    needsYAxisControl: true,
  },
  {
    id: 'losses-efficiency',
    kind: 'lossesEfficiency',
    name: 'Verluste (Ein- minus Ausspeisung)',
    question: 'Wie hoch sind die Wirkleistungsverluste zwischen zwei Messpunkten?',
    category: 'gridOperation',
    measurements: ['P'],
    arity: 'two',
    needsYAxisControl: true,
  },
  {
    id: 'asset-loading',
    kind: 'assetLoading',
    name: 'Betriebsmittel-Auslastung',
    question: 'Wie hoch ist die Auslastung in % der Bemessungsleistung?',
    category: 'gridOperation',
    measurements: ['S'],
    arity: 'one',
    needsThreshold: true,
    thresholdLabel: 'Bemessungsleistung (MVA)',
    thresholdDefault: 100,
    needsYAxisControl: true,
  },
  {
    id: 'overload-duration',
    kind: 'overloadDuration',
    name: 'Überlast-Dauerlinie',
    question: 'Wie lange liegt die Auslastung über 100 %?',
    category: 'gridOperation',
    measurements: ['S'],
    arity: 'one',
    needsThreshold: true,
    thresholdLabel: 'Bemessungsleistung (MVA)',
    thresholdDefault: 100,
    needsYAxisControl: true,
  },
  {
    id: 'rolling-envelope',
    kind: 'rollingEnvelope',
    name: 'Rollender Mittelwert',
    question: 'Wie entwickelt sich der geglättete Verlauf über die Zeit?',
    category: 'timeseries',
    measurements: [],
    arity: 'multi',
    needsResolution: true,
    needsYAxisControl: true,
  },
  {
    id: 'anomaly-score',
    kind: 'anomalyScore',
    name: 'Anomalie-Score (z-Wert)',
    question: 'Wann weicht das Signal statistisch auffällig vom Normalverhalten ab?',
    category: 'forecastEvents',
    measurements: [],
    arity: 'one',
    needsResolution: true,
    needsYAxisControl: true,
  },
  {
    id: 'voltage-compliance',
    kind: 'voltageCompliance',
    name: 'Spannungskonformität',
    question: 'Verlässt U das gewählte Band um die Nennspannung?',
    category: 'powerQuality',
    measurements: ['U'],
    arity: 'one',
    needsThreshold: true,
    thresholdLabel: 'Nennspannung (0 = automatisch aus Daten)',
    thresholdDefault: 0,
    needsVoltageBand: true,
    voltageMinPercentDefault: 90,
    voltageMaxPercentDefault: 110,
    needsYAxisControl: true,
  },

  // -- Coming soon (no data source exists in the FDWH yet) -----------------
  {
    id: 'phase-imbalance',
    kind: 'comingSoon',
    name: 'Phasenunsymmetrie',
    question: 'Wie groß ist die Unsymmetrie zwischen L1/L2/L3?',
    category: 'powerQuality',
    measurements: ['U', 'I'],
    arity: 'multi',
    comingSoon: true,
  },
  {
    id: 'thd-harmonics',
    kind: 'comingSoon',
    name: 'THD / Oberschwingungen',
    question: 'Wie hoch ist der Klirrfaktor und welche Harmonischen dominieren?',
    category: 'powerQuality',
    measurements: [],
    arity: 'one',
    comingSoon: true,
  },
  {
    id: 'sag-swell-timeline',
    kind: 'comingSoon',
    name: 'Sag/Swell/Unterbrechung',
    question: 'Wann traten Spannungseinbrüche, -spitzen oder Unterbrechungen auf?',
    category: 'powerQuality',
    measurements: ['U'],
    arity: 'one',
    comingSoon: true,
  },
  {
    id: 'alarm-timeline',
    kind: 'comingSoon',
    name: 'Alarm-/Ereignis-Timeline',
    question: 'Wann traten Alarme und Ereignisse auf?',
    category: 'forecastEvents',
    measurements: [],
    arity: 'one',
    comingSoon: true,
  },
  {
    id: 'alarm-pareto',
    kind: 'comingSoon',
    name: 'Alarm-Pareto / Ranking',
    question: 'Welche Alarmtypen treten am häufigsten auf?',
    category: 'forecastEvents',
    measurements: [],
    arity: 'one',
    comingSoon: true,
  },
  {
    id: 'forecast-vs-actual',
    kind: 'comingSoon',
    name: 'Prognose vs. Ist',
    question: 'Wie genau trifft die Prognose den tatsächlichen Verlauf?',
    category: 'forecastEvents',
    measurements: [],
    arity: 'two',
    comingSoon: true,
  },
  {
    id: 'data-completeness',
    kind: 'comingSoon',
    name: 'Vollständigkeit / Flatline',
    question: 'Wo gibt es Datenlücken oder eingefrorene (flatline) Werte?',
    category: 'dataQuality',
    measurements: [],
    arity: 'one',
    comingSoon: true,
  },
];

/**
 * Templates that stay registered (saved charts keep working) but are not offered in "Diagramm
 * hinzufügen". Reasons, all verified against the PowerFactory export, which delivers only loading (L)
 * and voltage (U) of a short scenario simulation:
 */
export const HIDDEN_TEMPLATE_REASONS: Record<string, string> = {
  // Need P, Q, S or I, which the export does not contain.
  'season-radar': 'braucht P/Q/S und ein Jahresprofil über zwölf Monate',
  'power-factor': 'braucht P, Q und S',
  'pq-quadrant': 'braucht P und Q',
  'qu-scatter': 'braucht Q',
  'peak-demand': 'braucht P',
  'energy-integral': 'braucht P',
  'losses-efficiency': 'braucht P',
  'asset-loading': 'braucht S; die Auslastung liegt schon in Prozent vor',
  'overload-duration': 'braucht S; die Dauerlinie auf der Auslastung leistet dasselbe',
  // Meaningless for a short simulation.
  'dst-anomaly': 'Simulationszeiten kennen keine Zeitumstellung',
  'quality-gap-heatmap': 'Simulationsdaten haben keine Messlücken',
  'daily-profile': 'ein typischer Tag aus sieben Simulationstagen ist nicht aussagekräftig',
  'day-hour-heatmap': 'Tag-Stunde-Muster brauchen lange Zeiträume',
};

/** What the picker offers: no hidden and no not-yet-built templates. */
export const PICKER_TEMPLATES: ChartTemplate[] = CHART_TEMPLATES.filter(
  (t) => !t.comingSoon && !(t.id in HIDDEN_TEMPLATE_REASONS),
);

export function getTemplate(id: string): ChartTemplate | undefined {
  return CHART_TEMPLATES.find((t) => t.id === id);
}
