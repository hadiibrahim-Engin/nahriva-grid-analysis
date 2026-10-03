/**
 * Web Worker: grid topology validation.
 *
 * Runs entirely off the main thread so the map stays responsive during
 * the initial load of potentially large GeoJSON datasets.
 *
 * Protocol:
 *   Main → Worker:  WorkerValidateRequest  (postMessage)
 *   Worker → Main:  WorkerValidateResponse | WorkerErrorResponse  (postMessage)
 *
 * Validation pipeline:
 *   1. Coordinate range + null-island checks  → asset-blocking
 *   2. UUID presence + format check           → fatal (aborts dataset)
 *   3. Duplicate UUID detection               → fatal
 *   4. Cross-reference checks (line↔station, line↔mast, mast↔line)  → warnings
 *   5. lineType/mastSequence consistency      → warnings
 *   6. Unknown voltageLevel / status          → warnings
 */

import type {
  WorkerValidateRequest,
  WorkerValidateResponse,
  WorkerErrorResponse,
  ValidationReport,
  ValidationIssue,
  StationProperties,
  LineProperties,
  MastProperties,
} from '../types';

// -- Constants -------------------------------------------------------------

const ALLOWED_STATUS = new Set(['in_operation', 'planned', 'unknown']);
const STANDARD_VOLTAGE = new Set(['380','220','110','66','36','20','10','6','1','0.4']);
// Accept UUID v1–v8 (any version digit) — OSM-derived data uses v5
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// -- Helpers ---------------------------------------------------------------

function isValidUuid(v: unknown): boolean {
  return typeof v === 'string' && UUID_PATTERN.test(v);
}

function isValidCoord(coord: unknown): boolean {
  if (!Array.isArray(coord) || coord.length < 2) return false;
  const [lon, lat] = coord as number[];
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return false;
  // Reject null island with 0.01° tolerance
  if (Math.abs(lon) < 0.01 && Math.abs(lat) < 0.01) return false;
  return true;
}

function isValidLineString(geometry: unknown): boolean {
  if (!geometry || typeof geometry !== 'object') return false;
  const g = geometry as GeoJSON.Geometry;
  if (g.type !== 'LineString') return false;
  const ls = g as GeoJSON.LineString;
  if (!Array.isArray(ls.coordinates) || ls.coordinates.length < 2) return false;
  return ls.coordinates.every(isValidCoord);
}

function props<T>(feature: GeoJSON.Feature): T {
  return feature.properties as T;
}

// -- Core validation -------------------------------------------------------

function validateStations(
  fc: GeoJSON.FeatureCollection,
  issues: ValidationIssue[],
  globalUuids: Set<string>,
): GeoJSON.FeatureCollection {
  const valid: GeoJSON.Feature[] = [];

  for (let i = 0; i < fc.features.length; i++) {
    const f = fc.features[i];
    const p = props<StationProperties>(f);
    const path = `stations[${i}]`;

    // UUID
    if (!isValidUuid(p?.uuid)) {
      issues.push({ severity: 'fatal', code: 'MISSING_UUID', entityType: 'station',
        field: 'uuid', message: `${path}: missing or invalid uuid — dataset aborted` });
      return { type: 'FeatureCollection', features: [] };
    }
    if (globalUuids.has(p.uuid)) {
      issues.push({ severity: 'fatal', code: 'DUPLICATE_UUID', entityType: 'station',
        uuid: p.uuid, message: `${path}: duplicate uuid ${p.uuid} — dataset aborted` });
      return { type: 'FeatureCollection', features: [] };
    }
    globalUuids.add(p.uuid);

    // Coordinate
    if (!isValidCoord(f.geometry && (f.geometry as GeoJSON.Point).coordinates)) {
      issues.push({ severity: 'asset-blocking', code: 'INVALID_COORDINATE',
        entityType: 'station', uuid: p.uuid, field: 'geometry.coordinates',
        message: `${path} "${p.name}": invalid coordinate — station hidden`,
        resolution: 'Provide valid WGS84 [lon, lat]' });
      continue;
    }

    // Voltage
    if (!p.highestVoltageLevel || !STANDARD_VOLTAGE.has(p.highestVoltageLevel)) {
      issues.push({ severity: 'warning', code: 'UNKNOWN_VOLTAGE_LEVEL',
        entityType: 'station', uuid: p.uuid, field: 'highestVoltageLevel',
        value: p.highestVoltageLevel,
        message: `${path}: voltage "${p.highestVoltageLevel}" uses fallback color` });
    }

    // Status
    if (!ALLOWED_STATUS.has(p.status)) {
      issues.push({ severity: 'warning', code: 'UNKNOWN_STATUS',
        entityType: 'station', uuid: p.uuid, field: 'status', value: p.status,
        message: `${path}: status "${p.status}" treated as unknown` });
    }

    valid.push(f);
  }

  return { type: 'FeatureCollection', features: valid };
}

function validateLines(
  fc: GeoJSON.FeatureCollection,
  issues: ValidationIssue[],
  globalUuids: Set<string>,
  stationUuids: Set<string>,
  missingMastSequenceCount: { value: number },
): GeoJSON.FeatureCollection {
  const valid: GeoJSON.Feature[] = [];

  for (let i = 0; i < fc.features.length; i++) {
    const f = fc.features[i];
    const p = props<LineProperties>(f);
    const path = `lines[${i}]`;

    // UUID
    if (!isValidUuid(p?.uuid)) {
      issues.push({ severity: 'fatal', code: 'MISSING_UUID', entityType: 'line',
        field: 'uuid', message: `${path}: missing or invalid uuid — dataset aborted` });
      return { type: 'FeatureCollection', features: [] };
    }
    if (globalUuids.has(p.uuid)) {
      issues.push({ severity: 'fatal', code: 'DUPLICATE_UUID', entityType: 'line',
        uuid: p.uuid, message: `${path}: duplicate uuid ${p.uuid} — dataset aborted` });
      return { type: 'FeatureCollection', features: [] };
    }
    globalUuids.add(p.uuid);

    // Geometry
    if (!isValidLineString(f.geometry)) {
      issues.push({ severity: 'asset-blocking', code: 'LINE_WITHOUT_GEOMETRY',
        entityType: 'line', uuid: p.uuid,
        message: `${path} "${p.name}": invalid LineString — line hidden` });
      continue;
    }

    // Station refs
    if (!stationUuids.has(p.stationFromUuid)) {
      issues.push({ severity: 'asset-blocking', code: 'LINE_REFERENCES_UNKNOWN_STATION',
        entityType: 'line', uuid: p.uuid, field: 'stationFromUuid',
        value: p.stationFromUuid,
        message: `${path}: stationFromUuid "${p.stationFromUuid}" not found — line hidden` });
      continue;
    }
    if (!stationUuids.has(p.stationToUuid)) {
      issues.push({ severity: 'asset-blocking', code: 'LINE_REFERENCES_UNKNOWN_STATION',
        entityType: 'line', uuid: p.uuid, field: 'stationToUuid',
        value: p.stationToUuid,
        message: `${path}: stationToUuid "${p.stationToUuid}" not found — line hidden` });
      continue;
    }

    // lineType
    const VALID_LINE_TYPES = new Set(['overhead', 'cable', 'mixed']);
    if (!p.lineType || !VALID_LINE_TYPES.has(p.lineType)) {
      issues.push({ severity: 'warning', code: 'MISSING_LINE_TYPE',
        entityType: 'line', uuid: p.uuid, field: 'lineType', value: p.lineType,
        message: `${path}: missing/invalid lineType "${p.lineType}" — treated as overhead` });
    }

    // mastSequence vs lineType consistency
    const isCable = p.lineType === 'cable';
    const hasMasts = Array.isArray(p.mastSequence) && p.mastSequence.length > 0;
    if (!isCable && !hasMasts) {
      missingMastSequenceCount.value += 1;
    }
    if (isCable && hasMasts) {
      issues.push({ severity: 'warning', code: 'CABLE_HAS_MASTS',
        entityType: 'line', uuid: p.uuid, field: 'mastSequence',
        message: `${path}: cable line has non-empty mastSequence` });
    }

    // Voltage
    if (!STANDARD_VOLTAGE.has(p.voltageLevel)) {
      issues.push({ severity: 'warning', code: 'UNKNOWN_VOLTAGE_LEVEL',
        entityType: 'line', uuid: p.uuid, field: 'voltageLevel',
        value: p.voltageLevel,
        message: `${path}: voltage "${p.voltageLevel}" uses fallback color` });
    }

    // Status
    if (!ALLOWED_STATUS.has(p.status)) {
      issues.push({ severity: 'warning', code: 'UNKNOWN_STATUS',
        entityType: 'line', uuid: p.uuid, field: 'status', value: p.status,
        message: `${path}: status "${p.status}" treated as unknown` });
    }

    valid.push(f);
  }

  return { type: 'FeatureCollection', features: valid };
}

function validateMasts(
  fc: GeoJSON.FeatureCollection,
  issues: ValidationIssue[],
  globalUuids: Set<string>,
  lineUuids: Set<string>,
): GeoJSON.FeatureCollection {
  const valid: GeoJSON.Feature[] = [];

  for (let i = 0; i < fc.features.length; i++) {
    const f = fc.features[i];
    const p = props<MastProperties>(f);
    const path = `masts[${i}]`;

    // UUID
    if (!isValidUuid(p?.uuid)) {
      issues.push({ severity: 'fatal', code: 'MISSING_UUID', entityType: 'mast',
        field: 'uuid', message: `${path}: missing or invalid uuid — dataset aborted` });
      return { type: 'FeatureCollection', features: [] };
    }
    if (globalUuids.has(p.uuid)) {
      issues.push({ severity: 'fatal', code: 'DUPLICATE_UUID', entityType: 'mast',
        uuid: p.uuid, message: `${path}: duplicate uuid ${p.uuid} — dataset aborted` });
      return { type: 'FeatureCollection', features: [] };
    }
    globalUuids.add(p.uuid);

    // Coordinate
    if (!isValidCoord(f.geometry && (f.geometry as GeoJSON.Point).coordinates)) {
      issues.push({ severity: 'asset-blocking', code: 'INVALID_COORDINATE',
        entityType: 'mast', uuid: p.uuid, field: 'geometry.coordinates',
        message: `${path} "${p.name ?? p.uuid}": invalid coordinate — mast hidden` });
      continue;
    }

    // Primary line ref
    if (!lineUuids.has(p.primaryLineUuid)) {
      issues.push({ severity: 'warning', code: 'MAST_REFERENCES_UNKNOWN_LINE',
        entityType: 'mast', uuid: p.uuid, field: 'primaryLineUuid',
        value: p.primaryLineUuid,
        message: `${path}: primaryLineUuid "${p.primaryLineUuid}" not found` });
    }

    // Voltage
    if (!STANDARD_VOLTAGE.has(p.voltageLevel)) {
      issues.push({ severity: 'warning', code: 'UNKNOWN_VOLTAGE_LEVEL',
        entityType: 'mast', uuid: p.uuid, field: 'voltageLevel',
        value: p.voltageLevel,
        message: `${path}: voltage "${p.voltageLevel}" uses fallback color` });
    }

    valid.push(f);
  }

  return { type: 'FeatureCollection', features: valid };
}

// -- Message handler -------------------------------------------------------

self.onmessage = (event: MessageEvent<WorkerValidateRequest>) => {
  const { type, stations, lines, masts } = event.data;
  if (type !== 'VALIDATE') return;

  try {
    const issues: ValidationIssue[] = [];
    const globalUuids = new Set<string>();

    const validStations = validateStations(stations, issues, globalUuids);

    // Check for fatal issues after stations — abort entire dataset
    const hasFatal = issues.some((i) => i.severity === 'fatal');
    if (hasFatal) {
      const report: ValidationReport = {
        exportBlocked: true,
        summary: { fatal: issues.filter(i => i.severity === 'fatal').length, layerBlocking: 0, assetBlocking: 0, warnings: 0 },
        issues,
        skippedAssets: [],
      };
      self.postMessage({ type: 'VALIDATE_RESULT',
        validStations: { type: 'FeatureCollection', features: [] },
        validLines:    { type: 'FeatureCollection', features: [] },
        validMasts:    { type: 'FeatureCollection', features: [] },
        report } satisfies WorkerValidateResponse);
      return;
    }

    const stationUuids = new Set(
      validStations.features.map((f) => (f.properties as StationProperties).uuid),
    );

    const missingMastSequenceCount = { value: 0 };
    const validLines = validateLines(
      lines,
      issues,
      globalUuids,
      stationUuids,
      missingMastSequenceCount,
    );

    const hasFatal2 = issues.some((i) => i.severity === 'fatal');
    if (hasFatal2) {
      const report: ValidationReport = {
        exportBlocked: true,
        summary: { fatal: issues.filter(i => i.severity === 'fatal').length, layerBlocking: 0, assetBlocking: 0, warnings: 0 },
        issues,
        skippedAssets: [],
      };
      self.postMessage({ type: 'VALIDATE_RESULT',
        validStations: { type: 'FeatureCollection', features: [] },
        validLines:    { type: 'FeatureCollection', features: [] },
        validMasts:    { type: 'FeatureCollection', features: [] },
        report } satisfies WorkerValidateResponse);
      return;
    }

    const lineUuids = new Set(
      validLines.features.map((f) => (f.properties as LineProperties).uuid),
    );

    const validMasts = validateMasts(masts, issues, globalUuids, lineUuids);

    if (missingMastSequenceCount.value > 0) {
      issues.push({
        severity: 'warning',
        code: 'OVERHEAD_WITHOUT_MASTS',
        entityType: 'dataset',
        field: 'mastSequence',
        message: `${missingMastSequenceCount.value} overhead/mixed lines do not provide mastSequence; those lines render without mast markers.`,
        resolution: 'Add ordered mast UUIDs to each overhead/mixed line when mast geometry is available.',
      });
    }

    // Build skippedAssets list
    const validStationUuids = new Set(validStations.features.map(f => (f.properties as StationProperties).uuid));
    const validLineUuids    = new Set(validLines.features.map(f => (f.properties as LineProperties).uuid));
    const validMastUuids    = new Set(validMasts.features.map(f => (f.properties as MastProperties).uuid));

    const skippedAssets: ValidationReport['skippedAssets'] = [];
    issues
      .filter((i) => i.severity === 'asset-blocking' && i.uuid)
      .forEach((i) => {
        if (i.uuid && !validStationUuids.has(i.uuid) && !validLineUuids.has(i.uuid) && !validMastUuids.has(i.uuid)) {
          skippedAssets.push({ entityType: i.entityType, uuid: i.uuid, reason: i.code });
        }
      });

    const summary = {
      fatal:         issues.filter(i => i.severity === 'fatal').length,
      layerBlocking: issues.filter(i => i.severity === 'layer-blocking').length,
      assetBlocking: issues.filter(i => i.severity === 'asset-blocking').length,
      warnings:      issues.filter(i => i.severity === 'warning').length,
    };

    const report: ValidationReport = {
      generatedAt: new Date().toISOString(),
      exportBlocked: false,
      summary,
      issues,
      skippedAssets,
    };

    self.postMessage({
      type: 'VALIDATE_RESULT',
      validStations,
      validLines,
      validMasts,
      report,
    } satisfies WorkerValidateResponse);

  } catch (err) {
    self.postMessage({
      type: 'ERROR',
      message: err instanceof Error ? err.message : String(err),
    } satisfies WorkerErrorResponse);
  }
};
