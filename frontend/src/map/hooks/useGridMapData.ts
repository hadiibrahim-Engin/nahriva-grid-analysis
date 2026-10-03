/**
 * Hook: load and validate the v2 grid topology.
 *
 * Load sequence:
 *   1. Fetch /grid/manifest.json
 *   2. Check exportBlocked — hard-stop if true
 *   3. Fetch stations, lines, masts in parallel
 *   4. Post raw FeatureCollections to the Web Worker for validation
 *   5. Worker returns cleaned FeatureCollections + ValidationReport
 *   6. Build O(1) lookup indexes on the main thread
 *   7. Build a MockTopology-compatible compat object for DashboardPage
 *
 * Falls back gracefully:
 *   • If /grid/manifest.json 404s → tries /mock_grid/ with the v1 loader (NOT this hook)
 *   • If exportBlocked → returns error state, map shows error overlay
 *   • If worker validation fails → falls back to unfiltered data + inline report
 */

import { useEffect, useState } from 'react';
import type {
  GridTopologyV2,
  GridManifest,
  ValidationReport,
  StationProperties,
  LineProperties,
  MastProperties,
  GridTopologyIndexes,
  GridTopologyCompat,
  GridStationCompat,
  GridCircuitCompat,
  WorkerValidateRequest,
  WorkerValidateResponse,
  WorkerErrorResponse,
} from '../types';

// -- State shape -----------------------------------------------------------

export interface GridMapDataState {
  topology: GridTopologyV2 | null;
  /** MockTopology-compatible bridge for DashboardPage (matching, KPI pills). */
  compat: GridTopologyCompat | null;
  loading: boolean;
  /** Fatal error message — map cannot be shown. */
  error: string | null;
}

// -- Index builder ---------------------------------------------------------

function buildIndexes(
  stations: GeoJSON.FeatureCollection,
  lines: GeoJSON.FeatureCollection,
  masts: GeoJSON.FeatureCollection,
): GridTopologyIndexes {
  const stationByUuid = new Map<string, GeoJSON.Feature<GeoJSON.Point, StationProperties>>();
  const lineByUuid    = new Map<string, GeoJSON.Feature<GeoJSON.LineString, LineProperties>>();
  const mastByUuid    = new Map<string, GeoJSON.Feature<GeoJSON.Point, MastProperties>>();
  const lineToMasts   = new Map<string, string[]>();
  const mastToLines   = new Map<string, string[]>();

  stations.features.forEach((f) => {
    const p = f.properties as StationProperties;
    stationByUuid.set(p.uuid, f as GeoJSON.Feature<GeoJSON.Point, StationProperties>);
  });

  lines.features.forEach((f) => {
    const p = f.properties as LineProperties;
    lineByUuid.set(p.uuid, f as GeoJSON.Feature<GeoJSON.LineString, LineProperties>);
    lineToMasts.set(p.uuid, Array.isArray(p.mastSequence) ? [...p.mastSequence] : []);
  });

  masts.features.forEach((f) => {
    const p = f.properties as MastProperties;
    mastByUuid.set(p.uuid, f as GeoJSON.Feature<GeoJSON.Point, MastProperties>);
    mastToLines.set(p.uuid, Array.isArray(p.lineUuids) ? [...p.lineUuids] : []);
  });

  return { stationByUuid, lineByUuid, mastByUuid, lineToMasts, mastToLines };
}

// -- Compat adapter --------------------------------------------------------

function buildCompat(
  stations: GeoJSON.FeatureCollection,
  lines: GeoJSON.FeatureCollection,
  report: ValidationReport,
): GridTopologyCompat {
  const compatStations: GridStationCompat[] = stations.features.map((f) => {
    const p  = f.properties as StationProperties;
    const pt = f.geometry as GeoJSON.Point;
    return {
      uuid:            p.uuid,
      langname:        p.name,
      identifierKurz:  p.shortName,
      spannungsebenen: Array.isArray(p.voltageLevel) ? p.voltageLevel : [p.voltageLevel],
      status:          p.status,
      planung:         p.status === 'planned',
      lat:             pt.coordinates[1],
      lon:             pt.coordinates[0],
    };
  });

  const compatCircuits: GridCircuitCompat[] = lines.features.map((f) => {
    const p = f.properties as LineProperties;
    return {
      uuid:     p.uuid,
      stationen: [p.stationFromUuid, p.stationToUuid],
    };
  });

  const warnings = report.issues
    .filter((i) => i.severity === 'warning' || i.severity === 'asset-blocking')
    .map((i) => i.message);

  return {
    stations:     compatStations,
    circuits:     compatCircuits,
    transformers: [],
    warnings,
  };
}

// -- Fetch helpers ---------------------------------------------------------

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  const text = await res.text();
  if (text.trimStart().startsWith('<')) throw new Error(`404 Not Found — ${url}`);
  return JSON.parse(text) as T;
}

// -- Main hook -------------------------------------------------------------

export function useGridMapData(): GridMapDataState {
  const [state, setState] = useState<GridMapDataState>({
    topology: null,
    compat:   null,
    loading:  true,
    error:    null,
  });

  useEffect(() => {
    let cancelled = false;
    let worker: Worker | null = null;

    async function load() {
      // 1. Manifest
      let manifest: GridManifest;
      try {
        manifest = await fetchJson<GridManifest>('/grid/manifest.json');
      } catch {
        if (cancelled) return;
        setState({ topology: null, compat: null, loading: false,
          error: 'Kartendaten nicht verfügbar (/grid/manifest.json nicht gefunden)' });
        return;
      }

      if (cancelled) return;

      // 2. Export-blocked check
      if (manifest.validationReport?.exportBlocked) {
        setState({ topology: null, compat: null, loading: false,
          error: 'Datensatz durch Exportvalidierung gesperrt. Validierungsbericht prüfen.' });
        return;
      }

      // 3. Parallel fetch of GeoJSON layers
      let rawStations: GeoJSON.FeatureCollection;
      let rawLines:    GeoJSON.FeatureCollection;
      let rawMasts:    GeoJSON.FeatureCollection;
      let externalReport: ValidationReport | null = null;

      try {
        const base = '/grid';
        const sf = manifest.layers.stations?.file ?? 'stations.geojson';
        const lf = manifest.layers.lines?.file    ?? 'lines.geojson';
        const mf = manifest.layers.masts?.file    ?? 'masts.geojson';

        const [s, l, m] = await Promise.all([
          fetchJson<GeoJSON.FeatureCollection>(`${base}/${sf}`),
          fetchJson<GeoJSON.FeatureCollection>(`${base}/${lf}`),
          fetchJson<GeoJSON.FeatureCollection>(`${base}/${mf}`),
        ]);
        rawStations = s;
        rawLines    = l;
        rawMasts    = m;

        // Optional: load the pre-generated validation report from the exporter
        if (manifest.validationReport?.file) {
          externalReport = await fetchJson<ValidationReport>(
            `${base}/${manifest.validationReport.file}`,
          ).catch(() => null);
        }
      } catch (err) {
        if (cancelled) return;
        setState({ topology: null, compat: null, loading: false,
          error: `Kartenlayer konnten nicht geladen werden: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }

      if (cancelled) return;

      // 4. Web Worker validation (non-blocking — runs off main thread)
      try {
        worker = new Worker(
          new URL('../worker/gridValidator.worker.ts', import.meta.url),
          { type: 'module' },
        );

        const workerResult = await new Promise<WorkerValidateResponse>((resolve, reject) => {
          worker!.onmessage = (e: MessageEvent<WorkerValidateResponse | WorkerErrorResponse>) => {
            if (e.data.type === 'VALIDATE_RESULT') resolve(e.data);
            else reject(new Error((e.data as WorkerErrorResponse).message));
          };
          worker!.onerror = (e) => reject(new Error(e.message));
          worker!.postMessage({
            type: 'VALIDATE',
            stations: rawStations,
            lines: rawLines,
            masts: rawMasts,
          } satisfies WorkerValidateRequest);
        });

        if (cancelled) return;

        const { validStations, validLines, validMasts, report } = workerResult;

        if (report.exportBlocked) {
          setState({ topology: null, compat: null, loading: false,
            error: `Datensatz enthält schwerwiegende Fehler. Prüfe den Validierungsbericht.\n${
              report.issues.filter(i => i.severity === 'fatal').map(i => `• ${i.message}`).join('\n')
            }` });
          return;
        }

        // 5. Merge external exporter report with our runtime report
        const finalReport: ValidationReport = externalReport
          ? {
              ...report,
              issues: [...externalReport.issues, ...report.issues],
              summary: {
                fatal:         report.summary.fatal + externalReport.summary.fatal,
                layerBlocking: report.summary.layerBlocking + externalReport.summary.layerBlocking,
                assetBlocking: report.summary.assetBlocking + externalReport.summary.assetBlocking,
                warnings:      report.summary.warnings + externalReport.summary.warnings,
              },
            }
          : report;

        // 6. Build indexes
        const indexes = buildIndexes(validStations, validLines, validMasts);

        // 7. Build compat
        const compat = buildCompat(validStations, validLines, finalReport);

        const topology: GridTopologyV2 = {
          stations: validStations as GeoJSON.FeatureCollection<GeoJSON.Point, StationProperties>,
          lines:    validLines    as GeoJSON.FeatureCollection<GeoJSON.LineString, LineProperties>,
          masts:    validMasts    as GeoJSON.FeatureCollection<GeoJSON.Point, MastProperties>,
          manifest,
          validationReport: finalReport,
          indexes,
        };

        setState({ topology, compat, loading: false, error: null });

      } catch (workerErr) {
        if (cancelled) return;
        // Worker failed — fall back to unvalidated data with a minimal report
        console.warn('[GridMap] Worker validation failed, using raw data:', workerErr);

        const fallbackReport: ValidationReport = {
          generatedAt: new Date().toISOString(),
          exportBlocked: false,
          summary: { fatal: 0, layerBlocking: 0, assetBlocking: 0, warnings: 1 },
          issues: [{
            severity: 'warning', code: 'WORKER_FAILED', entityType: 'dataset',
            message: 'Client-side validation failed — data shown unfiltered. Some assets may be invalid.',
          }],
          skippedAssets: [],
        };

        const indexes  = buildIndexes(rawStations, rawLines, rawMasts);
        const compat   = buildCompat(rawStations, rawLines, fallbackReport);

        const topology: GridTopologyV2 = {
          stations: rawStations as GeoJSON.FeatureCollection<GeoJSON.Point, StationProperties>,
          lines:    rawLines    as GeoJSON.FeatureCollection<GeoJSON.LineString, LineProperties>,
          masts:    rawMasts    as GeoJSON.FeatureCollection<GeoJSON.Point, MastProperties>,
          manifest,
          validationReport: fallbackReport,
          indexes,
        };

        setState({ topology, compat, loading: false, error: null });
      }
    }

    load();

    return () => {
      cancelled = true;
      worker?.terminate();
    };
  }, []);

  return state;
}
