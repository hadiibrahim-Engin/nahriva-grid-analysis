import { MOCK_GRID, type MockCircuit, type MockStation, type MockTopology, type MockTransformer } from '../components/charts/gridMockData';

const REAL_GRID_BASE = '/grid';
const MOCK_GRID_BASE = '/mock_grid';
const MAX_REPORTED_ISSUES = 12;
const MAX_REPORTED_WARNINGS = 16;

type JsonRecord = Record<string, unknown>;

class GridJsonHttpError extends Error {
  readonly path: string;
  readonly status: number;

  constructor(
    path: string,
    status: number,
    statusText: string,
  ) {
    super(`${status} ${statusText} while loading ${path}`);
    this.name = 'GridJsonHttpError';
    this.path = path;
    this.status = status;
  }
}

class GridTopologyUnavailableError extends Error {
  readonly basePath: string;

  constructor(basePath: string) {
    super(`No grid topology JSON found under ${basePath}. Expected topology.json or stationen.json, trafos.json, stromkreise.json.`);
    this.name = 'GridTopologyUnavailableError';
    this.basePath = basePath;
  }
}

class GridTopologyValidationError extends Error {
  readonly source: string;
  readonly issues: string[];

  constructor(
    source: string,
    issues: string[],
  ) {
    const shown = issues.slice(0, MAX_REPORTED_ISSUES);
    const remaining = issues.length - shown.length;
    super(
      [
        `Invalid grid topology in ${source}.`,
        ...shown.map((issue) => `- ${issue}`),
        ...(remaining > 0 ? [`- ... ${remaining} more issue(s)`] : []),
      ].join('\n'),
    );
    this.name = 'GridTopologyValidationError';
    this.source = source;
    this.issues = issues;
  }
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new GridJsonHttpError(path, res.status, res.statusText);
  }

  const contentType = res.headers.get('content-type') ?? '';
  const text = await res.text();
  if (contentType.includes('text/html') && text.trimStart().startsWith('<')) {
    throw new GridJsonHttpError(path, 404, 'Not Found');
  }

  try {
    return JSON.parse(text) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in ${path}: ${message}`);
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getField(record: JsonRecord, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  }
  return undefined;
}

function fieldLabel(keys: readonly string[]): string {
  return keys.length === 1 ? keys[0] : `${keys[0]} (aliases: ${keys.slice(1).join(', ')})`;
}

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const decimalNormalized = trimmed.includes(',') && !trimmed.includes('.')
    ? trimmed.replace(',', '.')
    : trimmed;
  const numberValue = Number(decimalNormalized);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function warningList(warnings: string[]): string[] {
  const shown = warnings.slice(0, MAX_REPORTED_WARNINGS);
  const remaining = warnings.length - shown.length;
  return remaining > 0 ? [...shown, `... ${remaining} more warning(s)`] : shown;
}

function readRequiredString(record: JsonRecord, keys: readonly string[], path: string, issues: string[]): string | null {
  const value = getField(record, keys);
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  issues.push(`${path}.${keys[0]}: expected non-empty string field ${fieldLabel(keys)}`);
  return null;
}

function readString(record: JsonRecord, keys: readonly string[], fallback: string): string {
  const value = getField(record, keys);
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

function readBoolean(record: JsonRecord, keys: readonly string[], fallback: boolean, path: string, issues: string[]): boolean {
  const value = getField(record, keys);
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'ja' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'nein' || normalized === 'no') return false;
  }
  issues.push(`${path}.${keys[0]}: expected boolean field ${fieldLabel(keys)}`);
  return fallback;
}

function readNumber(
  record: JsonRecord,
  keys: readonly string[],
  path: string,
  issues: string[],
  options: { required?: boolean; min?: number; max?: number } = {},
): number | null {
  const value = getField(record, keys);
  if (value === undefined || value === null || value === '') {
    if (options.required) issues.push(`${path}.${keys[0]}: expected finite number field ${fieldLabel(keys)}`);
    return null;
  }

  const numberValue = parseFiniteNumber(value);

  if (numberValue === null) {
    issues.push(`${path}.${keys[0]}: expected finite number field ${fieldLabel(keys)}`);
    return null;
  }
  if (options.min !== undefined && numberValue < options.min) {
    issues.push(`${path}.${keys[0]}: expected value >= ${options.min}, got ${numberValue}`);
  }
  if (options.max !== undefined && numberValue > options.max) {
    issues.push(`${path}.${keys[0]}: expected value <= ${options.max}, got ${numberValue}`);
  }
  return numberValue;
}

function coordinateRangeIssues(lat: number, lon: number): string[] {
  const issues: string[] = [];
  if (lat < -90 || lat > 90) issues.push(`lat must be between -90 and 90, got ${lat}`);
  if (lon < -180 || lon > 180) issues.push(`lon must be between -180 and 180, got ${lon}`);
  return issues;
}

function coordinateFromFields(record: JsonRecord): { lat: number; lon: number } | null {
  const lat = parseFiniteNumber(getField(record, ['lat', 'latitude', 'breitengrad']));
  const lon = parseFiniteNumber(getField(record, ['lon', 'lng', 'longitude', 'laengengrad', 'längengrad']));
  if (lat === null || lon === null) return null;
  return { lat, lon };
}

function coordinateFromObject(value: unknown): { lat: number; lon: number } | null {
  if (!isRecord(value)) return null;
  return coordinateFromFields(value);
}

function coordinateFromGeoJson(value: unknown): { lat: number; lon: number } | null {
  if (!isRecord(value)) return null;
  const coordinates = getField(value, ['coordinates']);
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const lon = parseFiniteNumber(coordinates[0]);
  const lat = parseFiniteNumber(coordinates[1]);
  if (lat === null || lon === null) return null;
  return { lat, lon };
}

function readStationCoordinates(record: JsonRecord, path: string): { coords: { lat: number; lon: number } | null; reason: string } {
  const candidates = [
    coordinateFromFields(record),
    coordinateFromObject(getField(record, ['position', 'coords', 'coordinate', 'koordinaten'])),
    coordinateFromGeoJson(getField(record, ['geometry', 'geojson'])),
  ].filter((coords): coords is { lat: number; lon: number } => coords !== null);

  if (candidates.length === 0) {
    return {
      coords: null,
      reason: `${path}.lat/lon: expected finite coordinate fields lat/lon, latitude/longitude, position.{lat,lon}, or GeoJSON geometry.coordinates`,
    };
  }

  const coords = candidates[0];
  const rangeIssues = coordinateRangeIssues(coords.lat, coords.lon);
  if (rangeIssues.length > 0) {
    return { coords: null, reason: `${path}: ${rangeIssues.join('; ')}` };
  }

  return { coords, reason: '' };
}

function readVoltageLevels(record: JsonRecord, path: string, issues: string[]): string[] {
  const value = getField(record, ['spannungsebenen', 'voltageLevels']);
  const singleValue = getField(record, ['spannungsebene', 'voltageLevel']);
  const rawValues = Array.isArray(value)
    ? value
    : singleValue === undefined || singleValue === null || singleValue === ''
      ? null
      : [singleValue];

  if (!rawValues) {
    issues.push(`${path}.spannungsebenen: expected array field spannungsebenen or single spannungsebene`);
    return [];
  }

  const levels = rawValues
    .map((item) => (typeof item === 'string' || typeof item === 'number' ? String(item).trim() : ''))
    .filter(Boolean);

  if (levels.length === 0) {
    issues.push(`${path}.spannungsebenen: expected at least one voltage level`);
  }
  return levels;
}

function readStationPair(record: JsonRecord, path: string, issues: string[]): [string, string] | null {
  const value = getField(record, ['stationen', 'stations']);
  if (Array.isArray(value) && value.length >= 2) {
    const a = typeof value[0] === 'string' || typeof value[0] === 'number' ? String(value[0]).trim() : '';
    const b = typeof value[1] === 'string' || typeof value[1] === 'number' ? String(value[1]).trim() : '';
    if (a && b) return [a, b];
  }

  const from = getField(record, ['fromStation', 'fromUuid', 'sourceStation']);
  const to = getField(record, ['toStation', 'toUuid', 'targetStation']);
  const fromString = typeof from === 'string' || typeof from === 'number' ? String(from).trim() : '';
  const toString = typeof to === 'string' || typeof to === 'number' ? String(to).trim() : '';
  if (fromString && toString) return [fromString, toString];

  issues.push(`${path}.stationen: expected two station UUIDs in stationen, stations, or from/to fields`);
  return null;
}

function normalizeStations(
  raw: unknown,
  source: string,
  issues: string[],
  warnings: string[],
  droppedStationIds: Set<string>,
): MockStation[] {
  if (!Array.isArray(raw)) {
    issues.push(`${source}.stations: expected array field stations (or stationen)`);
    return [];
  }

  return raw.flatMap((item, index) => {
    const path = `stations[${index}]`;
    if (!isRecord(item)) {
      issues.push(`${path}: expected object`);
      return [];
    }

    const uuid = readRequiredString(item, ['uuid', 'id'], path, issues);
    if (!uuid) return [];

    const langname = readString(item, ['langname', 'name', 'label'], uuid);
    const { coords, reason } = readStationCoordinates(item, path);
    if (!coords) {
      droppedStationIds.add(uuid);
      warnings.push(`${path} "${langname}" (${uuid}) was not shown: invalid coordinates. ${reason}`);
      return [];
    }

    const spannungsebenen = readVoltageLevels(item, path, issues);
    return [{
      uuid,
      langname,
      identifierKurz: readString(item, ['identifierKurz', 'identifier_kurz', 'kurzname', 'shortName'], uuid),
      typ: readString(item, ['typ', 'type'], 'Station'),
      spannungsebenen,
      status: readString(item, ['status'], 'unbekannt'),
      planung: readBoolean(item, ['planung', 'planned'], false, path, issues),
      lat: coords.lat,
      lon: coords.lon,
    }];
  });
}

function normalizeTransformers(
  raw: unknown,
  source: string,
  stationIds: Set<string>,
  droppedStationIds: Set<string>,
  warnings: string[],
): MockTransformer[] {
  if (!Array.isArray(raw)) {
    warnings.push(`${source}.transformers was ignored: expected array field transformers (or trafos).`);
    return [];
  }

  return raw.flatMap((item, index) => {
    const path = `transformers[${index}]`;
    if (!isRecord(item)) {
      warnings.push(`${path} was not shown: expected object.`);
      return [];
    }

    const transformerIssues: string[] = [];
    const uuid = readRequiredString(item, ['uuid', 'id', 'component_id'], path, transformerIssues);
    const uuidStation = readRequiredString(item, ['uuidStation', 'stationUuid', 'station_uuid', 'anr'], path, transformerIssues);
    if (!uuid || !uuidStation) {
      warnings.push(`${path} was not shown: ${transformerIssues.join('; ')}`);
      return [];
    }

    if (!stationIds.has(uuidStation)) {
      const reason = droppedStationIds.has(uuidStation)
        ? `station "${uuidStation}" has invalid coordinates`
        : `station "${uuidStation}" is not defined`;
      warnings.push(`${path} "${uuid}" was not shown: ${reason}.`);
      return [];
    }

    const transformerFieldWarnings: string[] = [];
    const nennleistung = readNumber(item, ['nennleistung', 'ratedPowerMva'], path, transformerFieldWarnings) ?? 0;
    const planung = readBoolean(item, ['planung', 'planned'], false, path, transformerFieldWarnings);
    if (transformerFieldWarnings.length > 0) {
      warnings.push(`${path} "${uuid}" was shown with defaults: ${transformerFieldWarnings.join('; ')}`);
    }

    return [{
      uuid,
      uuidStation,
      bezeichnung: readString(item, ['bezeichnung', 'feldname_kurz', 'name'], uuid),
      umspannebenen: readString(item, ['umspannebenen', 'spannungsebene', 'voltageLevel'], ''),
      nennleistung,
      status: readString(item, ['status'], 'unbekannt'),
      planung,
    }];
  });
}

function normalizeCircuits(
  raw: unknown,
  source: string,
  stationIds: Set<string>,
  droppedStationIds: Set<string>,
  issues: string[],
  warnings: string[],
): MockCircuit[] {
  if (!Array.isArray(raw)) {
    issues.push(`${source}.circuits: expected array field circuits (or stromkreise)`);
    return [];
  }

  return raw.flatMap((item, index) => {
    const path = `circuits[${index}]`;
    if (!isRecord(item)) {
      warnings.push(`${path} was not shown: expected object.`);
      return [];
    }

    const circuitIssues: string[] = [];
    const uuid = readRequiredString(item, ['uuid', 'id'], path, circuitIssues);
    const stationen = readStationPair(item, path, circuitIssues);
    if (!uuid || !stationen) {
      warnings.push(`${path} was not shown: ${circuitIssues.join('; ')}`);
      return [];
    }

    const missingStations = stationen.filter((stationUuid) => !stationIds.has(stationUuid));
    if (missingStations.length > 0) {
      const reason = missingStations
        .map((stationUuid) => droppedStationIds.has(stationUuid)
          ? `"${stationUuid}" has invalid coordinates`
          : `"${stationUuid}" is not defined`)
        .join('; ');
      warnings.push(`${path} "${uuid}" was not shown: ${reason}.`);
      return [];
    }

    const typ = readString(item, ['typ', 'type'], 'Freileitung');
    const spannungsebene = readString(item, ['spannungsebene', 'voltageLevel'], '0');
    const circuitFieldWarnings: string[] = [];
    const laenge = readNumber(item, ['laenge', 'lengthKm'], path, circuitFieldWarnings) ?? undefined;
    const planung = readBoolean(item, ['planung', 'planned'], false, path, circuitFieldWarnings);
    if (circuitFieldWarnings.length > 0) {
      warnings.push(`${path} "${uuid}" was shown with defaults: ${circuitFieldWarnings.join('; ')}`);
    }

    return [{
      uuid,
      langname: readString(item, ['langname', 'name', 'label'], uuid),
      identifierKurz: readString(item, ['identifierKurz', 'identifier_kurz', 'kurzname', 'shortName'], uuid),
      typ,
      spannungsebene,
      stationen,
      laenge,
      planung,
    }];
  });
}

function validateGridTopology(value: unknown, source: string): MockTopology {
  const issues: string[] = [];
  const warnings: string[] = [];
  const droppedStationIds = new Set<string>();
  if (!isRecord(value)) {
    throw new GridTopologyValidationError(source, [`${source}: expected topology object`]);
  }

  const stations = normalizeStations(getField(value, ['stations', 'stationen']), source, issues, warnings, droppedStationIds);
  const stationIds = new Set<string>();
  stations.forEach((station) => {
    if (stationIds.has(station.uuid)) {
      issues.push(`stations: duplicate uuid "${station.uuid}"`);
    }
    stationIds.add(station.uuid);
  });

  if (stations.length === 0 && issues.length === 0) {
    issues.push(`${source}.stations: no station has valid coordinates, so the map cannot be shown`);
  }

  const transformers = normalizeTransformers(getField(value, ['transformers', 'trafos']), source, stationIds, droppedStationIds, warnings);
  const circuits = normalizeCircuits(getField(value, ['circuits', 'stromkreise']), source, stationIds, droppedStationIds, issues, warnings);

  if (issues.length > 0) {
    throw new GridTopologyValidationError(source, issues);
  }
  return { stations, transformers, circuits, warnings: warningList(warnings) };
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof GridJsonHttpError && error.status === 404;
}

function isUnavailableError(error: unknown): boolean {
  return error instanceof GridTopologyUnavailableError;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadGridTopologyFrom(basePath: string): Promise<MockTopology> {
  let topologyError: unknown = null;
  try {
    const topology = await fetchJson<unknown>(`${basePath}/topology.json`);
    return validateGridTopology(topology, `${basePath}/topology.json`);
  } catch (err) {
    if (!isNotFoundError(err)) topologyError = err;
  }

  const results = await Promise.allSettled([
    fetchJson<unknown>(`${basePath}/stationen.json`),
    fetchJson<unknown>(`${basePath}/trafos.json`),
    fetchJson<unknown>(`${basePath}/stromkreise.json`),
  ]);

  if (results.every((result) => result.status === 'fulfilled')) {
    const [stations, transformers, circuits] = results.map((result) => (
      result.status === 'fulfilled' ? result.value : null
    ));
    return validateGridTopology(
      { stations, transformers, circuits },
      `${basePath}/{stationen,trafos,stromkreise}.json`,
    );
  }

  if (topologyError) throw topologyError;

  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length === 3 && failures.every(isNotFoundError)) {
    throw new GridTopologyUnavailableError(basePath);
  }

  throw new Error(
    `Grid topology files under ${basePath} are incomplete: ${failures.map(describeError).join(' | ')}`,
  );
}

export async function loadGridTopology(): Promise<MockTopology> {
  try {
    return await loadGridTopologyFrom(REAL_GRID_BASE);
  } catch (err) {
    if (!isUnavailableError(err)) throw err;
  }

  try {
    return await loadGridTopologyFrom(MOCK_GRID_BASE);
  } catch (err) {
    if (isUnavailableError(err)) return MOCK_GRID;
    throw err;
  }
}

export function fallbackGridTopology(): MockTopology {
  return MOCK_GRID;
}
