/**
 * Domain types for the v2 electrical grid map (MapLibre-based).
 *
 * These types align precisely with the data contract defined in the
 * technical specification. All coordinates are [longitude, latitude]
 * in WGS84 / EPSG:4326.
 */

// -- Status ----------------------------------------------------------------

export type GridStatus = 'in_operation' | 'planned' | 'unknown';

export type LineType = 'overhead' | 'cable' | 'mixed';

// -- GeoJSON feature property shapes ---------------------------------------

export interface StationProperties {
  uuid: string;
  name: string;
  shortName: string;
  /** All voltage levels present at this station, e.g. ["380","110"]. */
  voltageLevel: string[];
  /** Highest voltage level — drives coloring and marker size. */
  highestVoltageLevel: string;
  status: GridStatus;
  metadata?: Record<string, unknown>;
}

export interface LineProperties {
  uuid: string;
  name: string;
  shortName: string;
  lineName?: string | null;
  ref?: string | null;
  operatorRef?: string | null;
  operator?: string | null;
  osm_way_ids?: number[];
  voltageLevel: string;
  lineType: LineType;
  stationFromUuid: string;
  stationToUuid: string;
  /** Ordered mast UUIDs from stationFrom to stationTo. Empty for cables. */
  mastSequence: string[];
  status: GridStatus;
  circuits?: number;
  length_m?: number;
  metadata?: Record<string, unknown>;
}

export interface MastProperties {
  uuid: string;
  name?: string;
  primaryLineUuid: string;
  /** All lines passing through this mast (shared-corridor support). */
  lineUuids: string[];
  /** Highest voltage level of all lines on this mast. */
  voltageLevel: string;
  /** All distinct voltage levels on this mast, ordered highest first. */
  voltageBreakdown: string[];
  status: GridStatus;
  mastType?: string;
  sequenceIndex?: number;
  metadata?: Record<string, unknown>;
}

// -- Manifest --------------------------------------------------------------

export interface GridManifest {
  version: string;
  exportedAt: string;
  exportedBy?: string;
  coordinateSystem: string;
  coordinateOrder: 'lon_lat';
  layers: {
    stations?: { file: string; count: number; format: string };
    lines?: { file: string; count: number; format: string };
    masts?: { file: string; count: number; format: string };
  };
  validationReport?: {
    file: string;
    exportBlocked: boolean;
    fatalCount: number;
    warningCount: number;
  };
  bounds?: {
    minLon: number;
    minLat: number;
    maxLon: number;
    maxLat: number;
  };
  voltageLevels?: string[];
}

// -- Validation ------------------------------------------------------------

export type ValidationSeverity = 'fatal' | 'layer-blocking' | 'asset-blocking' | 'warning';

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  entityType: 'station' | 'line' | 'mast' | 'dataset';
  uuid?: string;
  field?: string;
  value?: unknown;
  message: string;
  resolution?: string;
}

export interface ValidationReport {
  generatedAt?: string;
  exportBlocked: boolean;
  summary: {
    fatal: number;
    layerBlocking: number;
    assetBlocking: number;
    warnings: number;
  };
  issues: ValidationIssue[];
  skippedAssets: Array<{ entityType: string; uuid: string; reason: string }>;
}

// -- Runtime topology (loaded + validated + indexed) -----------------------

/** O(1) lookup indexes built in the Web Worker at load time. */
export interface GridTopologyIndexes {
  /** lineUuid → ordered mastUuid[] */
  lineToMasts: Map<string, string[]>;
  /** mastUuid → lineUuid[] */
  mastToLines: Map<string, string[]>;
  /** uuid → station Feature */
  stationByUuid: Map<string, GeoJSON.Feature<GeoJSON.Point, StationProperties>>;
  /** uuid → line Feature */
  lineByUuid: Map<string, GeoJSON.Feature<GeoJSON.LineString, LineProperties>>;
  /** uuid → mast Feature */
  mastByUuid: Map<string, GeoJSON.Feature<GeoJSON.Point, MastProperties>>;
}

export interface GridTopologyV2 {
  stations: GeoJSON.FeatureCollection<GeoJSON.Point, StationProperties>;
  lines: GeoJSON.FeatureCollection<GeoJSON.LineString, LineProperties>;
  masts: GeoJSON.FeatureCollection<GeoJSON.Point, MastProperties>;
  manifest: GridManifest;
  validationReport: ValidationReport;
  indexes: GridTopologyIndexes;
}

// -- Compat adapter (bridges new format → old MockTopology shape) ----------
// Used by DashboardPage for facility matching and KPI pills without
// requiring a full DashboardPage rewrite.

export interface GridStationCompat {
  uuid: string;
  langname: string;
  identifierKurz: string;
  spannungsebenen: string[];
  status: string;
  planung: boolean;
  lat: number;
  lon: number;
}

export interface GridCircuitCompat {
  uuid: string;
  stationen: [string, string];
}

export interface GridTopologyCompat {
  stations: GridStationCompat[];
  circuits: GridCircuitCompat[];
  transformers: never[];
  warnings: string[];
}

// -- Hover / selection state -----------------------------------------------

export type HoveredEntityType = 'station' | 'line' | 'mast';

export interface HoveredFeature {
  type: HoveredEntityType;
  uuid: string;
  name: string;
  voltageLevel: string;
  status: GridStatus;
  /** Only for masts */
  voltageBreakdown?: string[];
  /** Only for lines */
  lineType?: LineType;
  /** Only for stations */
  spannungsebenen?: string[];
  /** Screen pixel position for tooltip placement */
  x: number;
  y: number;
}

// -- Web Worker message protocol -------------------------------------------

export interface WorkerValidateRequest {
  type: 'VALIDATE';
  stations: GeoJSON.FeatureCollection;
  lines: GeoJSON.FeatureCollection;
  masts: GeoJSON.FeatureCollection;
}

export interface WorkerValidateResponse {
  type: 'VALIDATE_RESULT';
  validStations: GeoJSON.FeatureCollection;
  validLines: GeoJSON.FeatureCollection;
  validMasts: GeoJSON.FeatureCollection;
  report: ValidationReport;
}

export interface WorkerErrorResponse {
  type: 'ERROR';
  message: string;
}

export type WorkerResponse = WorkerValidateResponse | WorkerErrorResponse;
