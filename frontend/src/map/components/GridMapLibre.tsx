/**
 * GridMapLibre — MapLibre GL JS electrical-grid map.
 *
 * Self-contained: loads and validates its own GeoJSON from /grid/,
 * then fires callbacks so DashboardPage.tsx needs minimal changes.
 *
 * Architecture notes
 * ------------------
 * • line-dasharray is NOT data-driven in MapLibre, so each
 *   (lineType-group × status) combination gets its own layer with a filter.
 * • Hover / selection uses MapLibre feature-state (setFeatureState) so
 *   zero React re-renders fire per pointer event.
 * • Sources carry stable 1-based numeric IDs so feature-state works;
 *   a uuid→numericId Map lets us resolve DashboardPage UUIDs.
 * • Array properties (voltageLevel, voltageBreakdown) stored on GeoJSON
 *   features are returned as JSON strings in mouse-event properties —
 *   parse them before use.
 */

import 'maplibre-gl/dist/maplibre-gl.css';
import './grid-map.css';
import React, {
  useEffect, useRef, useState, useCallback,
} from 'react';
import * as maplibregl from 'maplibre-gl';

import { useGridMapData }       from '../hooks/useGridMapData';
import { VOLTAGE_COLORS, SOURCE, LAYER, ZOOM, buildBaseStyle } from '../constants';
import type {
  GridTopologyV2, GridTopologyCompat,
  StationProperties, LineProperties,
  HoveredFeature, ValidationReport,
} from '../types';

import MapLegend         from './MapLegend';
import ValidationBanner  from './ValidationBanner';
import ValidationPanel   from './ValidationPanel';
import FeatureTooltip    from './FeatureTooltip';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type MapTheme = 'dark' | 'light' | 'satellite';

export interface GridMapLibreProps {
  /** Fired once the topology is loaded and the compat bridge is ready. */
  onTopologyReady?: (compat: GridTopologyCompat) => void;
  /** Fired when loading fails with a human-readable message. */
  onLoadError?: (message: string) => void;
  /** Fired when the user clicks a station marker. */
  onSelectStation?: (uuid: string) => void;
  /** UUID of the station to highlight (set by DashboardPage). */
  selectedStationUuid?: string | null;
  /** UUIDs of stations that matched a facility (show white match-ring). */
  matchedStationUuids?: Set<string>;
  /** Visual theme — dark (default) | light | satellite */
  theme?: MapTheme;
  /**
   * When true, the scroll wheel zooms the map.
   * When false (default), scroll wheel is disabled so the page can scroll.
   * Wired to DashboardPage's Scroll/Zoom toolbar buttons.
   */
  scrollWheelZoom?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

// -----------------------------------------------------------------------------
// MapLibre expression helpers
// -----------------------------------------------------------------------------

/** Build a match expression that maps a GeoJSON property to a voltage colour. */
function voltageMatch(field: string): maplibregl.ExpressionSpecification {
  return [
    'match', ['get', field],
    '380', VOLTAGE_COLORS['380'],
    '220', VOLTAGE_COLORS['220'],
    '110', VOLTAGE_COLORS['110'],
    '66',  VOLTAGE_COLORS['66'],
    '36',  VOLTAGE_COLORS['36'],
    '20',  VOLTAGE_COLORS['20'],
    '10',  VOLTAGE_COLORS['10'],
    '6',   VOLTAGE_COLORS['6'],
    '1',   VOLTAGE_COLORS['1'],
    '0.4', VOLTAGE_COLORS['0.4'],
    VOLTAGE_COLORS.unknown,
  ] as maplibregl.ExpressionSpecification;
}

/** Line width interpolated by zoom and voltage level. */
const LINE_WIDTH: maplibregl.ExpressionSpecification = [
  'interpolate', ['linear'], ['zoom'],
  5,  ['match', ['get', 'voltageLevel'], '380', 1.5, '220', 1.2, '110', 1.0, 0.8],
  10, ['match', ['get', 'voltageLevel'], '380', 3.0, '220', 2.5, '110', 2.0, '66', 1.5, 1.0],
  14, ['match', ['get', 'voltageLevel'], '380', 5.0, '220', 4.0, '110', 3.0, '66', 2.5, 1.5],
  18, ['match', ['get', 'voltageLevel'], '380', 7.0, '220', 6.0, '110', 5.0, '66', 4.0, 2.0],
] as maplibregl.ExpressionSpecification;

/** Station circle radius interpolated by zoom and highest voltage level. */
const STATION_R: maplibregl.ExpressionSpecification = [
  'interpolate', ['linear'], ['zoom'],
  5,  ['match', ['get', 'highestVoltageLevel'], '380', 5,  '220', 4,  '110', 3.5, 3],
  9,  ['match', ['get', 'highestVoltageLevel'], '380', 10, '220', 8,  '110', 6,   '66', 5, 5],
  17, ['match', ['get', 'highestVoltageLevel'], '380', 20, '220', 16, '110', 13,  '66', 11, 11],
] as maplibregl.ExpressionSpecification;

/** Station halo radius = station radius + ~5 px. */
const STATION_HALO_R: maplibregl.ExpressionSpecification = [
  'interpolate', ['linear'], ['zoom'],
  5,  ['match', ['get', 'highestVoltageLevel'], '380', 10, '220', 9,  '110', 8,  7],
  9,  ['match', ['get', 'highestVoltageLevel'], '380', 16, '220', 13, '110', 11, 10],
  17, ['match', ['get', 'highestVoltageLevel'], '380', 27, '220', 22, '110', 19, 16],
] as maplibregl.ExpressionSpecification;

// -----------------------------------------------------------------------------
// Utility: assign stable 1-based numeric IDs for feature-state
// -----------------------------------------------------------------------------

function withNumericIds(
  fc: GeoJSON.FeatureCollection,
  uuidField: string,
): [GeoJSON.FeatureCollection, Map<string, number>] {
  const idMap = new Map<string, number>();
  const features = fc.features.map((f, i) => {
    const id   = i + 1;                                           // 1-based avoids falsy 0
    const uuid = (f.properties as Record<string, unknown>)[uuidField] as string | undefined;
    if (uuid) idMap.set(uuid, id);
    return { ...f, id };
  });
  return [{ ...fc, features }, idMap];
}

// -----------------------------------------------------------------------------
// Layer definitions
// -----------------------------------------------------------------------------

/** Add all grid layers to the map (sources must already exist). */
function addGridLayers(map: maplibregl.Map) {
  const overheadOrMixed: maplibregl.ExpressionSpecification =
    ['in', ['get', 'lineType'], ['literal', ['overhead', 'mixed']]];
  const cable: maplibregl.ExpressionSpecification =
    ['==', ['get', 'lineType'], 'cable'];

  // -- Lines -----------------------------------------------------------------

  map.addLayer({
    id: LAYER.LINES_OVERHEAD_SOLID,
    type: 'line',
    source: SOURCE.LINES,
    minzoom: ZOOM.LINES_MIN,
    filter: ['all', overheadOrMixed, ['==', ['get', 'status'], 'in_operation']],
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color':   voltageMatch('voltageLevel'),
      'line-width':   LINE_WIDTH,
      'line-opacity': 0.9,
    },
  });

  map.addLayer({
    id: LAYER.LINES_OVERHEAD_PLANNED,
    type: 'line',
    source: SOURCE.LINES,
    minzoom: ZOOM.LINES_MIN,
    filter: ['all', overheadOrMixed, ['==', ['get', 'status'], 'planned']],
    layout: { 'line-join': 'round', 'line-cap': 'butt' },
    paint: {
      'line-color':      voltageMatch('voltageLevel'),
      'line-width':      LINE_WIDTH,
      'line-dasharray':  [6, 4],
      'line-opacity':    0.75,
    },
  });

  map.addLayer({
    id: LAYER.LINES_OVERHEAD_UNKNOWN,
    type: 'line',
    source: SOURCE.LINES,
    minzoom: ZOOM.LINES_MIN,
    filter: ['all', overheadOrMixed, ['==', ['get', 'status'], 'unknown']],
    layout: { 'line-join': 'round', 'line-cap': 'butt' },
    paint: {
      'line-color':     voltageMatch('voltageLevel'),
      'line-width':     LINE_WIDTH,
      'line-dasharray': [2, 4],
      'line-opacity':   0.6,
    },
  });

  map.addLayer({
    id: LAYER.LINES_CABLE_SOLID,
    type: 'line',
    source: SOURCE.LINES,
    minzoom: ZOOM.LINES_MIN,
    filter: ['all', cable, ['==', ['get', 'status'], 'in_operation']],
    layout: { 'line-join': 'round', 'line-cap': 'butt' },
    paint: {
      'line-color':     voltageMatch('voltageLevel'),
      'line-width':     LINE_WIDTH,
      'line-dasharray': [1, 3],
      'line-opacity':   0.85,
    },
  });

  map.addLayer({
    id: LAYER.LINES_CABLE_PLANNED,
    type: 'line',
    source: SOURCE.LINES,
    minzoom: ZOOM.LINES_MIN,
    filter: ['all', cable, ['in', ['get', 'status'], ['literal', ['planned', 'unknown']]]],
    layout: { 'line-join': 'round', 'line-cap': 'butt' },
    paint: {
      'line-color':     voltageMatch('voltageLevel'),
      'line-width':     LINE_WIDTH,
      'line-dasharray': [1, 3, 5, 3],
      'line-opacity':   0.65,
    },
  });

  // Hover glow — wide blurred halo behind the hovered line
  map.addLayer({
    id: LAYER.LINES_HIGHLIGHT,
    type: 'line',
    source: SOURCE.LINES,
    minzoom: ZOOM.LINES_MIN,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color':   '#ffffff',
      'line-width':   ['interpolate', ['linear'], ['zoom'], 5, 8, 14, 16] as maplibregl.ExpressionSpecification,
      'line-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.22, 0] as maplibregl.ExpressionSpecification,
      'line-blur':    6,
    },
  });

  // -- Masts -----------------------------------------------------------------

  map.addLayer({
    id: LAYER.MASTS_CIRCLE,
    type: 'circle',
    source: SOURCE.MASTS,
    minzoom: ZOOM.MASTS_MIN,
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'], 13, 1.6, 16, 2.6, 18, 3.4,
      ] as maplibregl.ExpressionSpecification,
      'circle-color':         voltageMatch('voltageLevel'),
      'circle-opacity':       0.82,
      'circle-stroke-width':  [
        'interpolate', ['linear'], ['zoom'], 13, 0.6, 17, 1.0,
      ] as maplibregl.ExpressionSpecification,
      'circle-stroke-color':  '#ffffff',
      'circle-stroke-opacity': 0.68,
    },
  });

  map.addLayer({
    id: LAYER.MASTS_HIGHLIGHT,
    type: 'circle',
    source: SOURCE.MASTS,
    minzoom: ZOOM.MASTS_MIN,
    paint: {
      'circle-radius':  [
        'interpolate', ['linear'], ['zoom'], 13, 5, 16, 8, 18, 10,
      ] as maplibregl.ExpressionSpecification,
      'circle-color':   '#ffffff',
      'circle-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.25, 0] as maplibregl.ExpressionSpecification,
      'circle-blur':    0.5,
    },
  });

  map.addLayer({
    id: LAYER.MASTS_CROSSBAR,
    type: 'symbol',
    source: SOURCE.MASTS,
    minzoom: ZOOM.MASTS_MIN,
    layout: {
      'text-field':          '━',
      'text-size':           [
        'interpolate', ['linear'], ['zoom'], 13, 8, 16, 12, 18, 15,
      ] as maplibregl.ExpressionSpecification,
      'text-font':           ['Open Sans Bold', 'Arial Unicode MS Bold'],
      'text-anchor':         'center',
      'text-allow-overlap':  false,
      'text-ignore-placement': false,
    },
    paint: {
      'text-color':      '#ffffff',
      'text-opacity':    [
        'interpolate', ['linear'], ['zoom'], 13, 0.62, 16, 0.86, 18, 0.95,
      ] as maplibregl.ExpressionSpecification,
      'text-halo-color': 'rgba(0,0,0,0.78)',
      'text-halo-width': 0.9,
    },
  });

  // -- Stations --------------------------------------------------------------

  // White ring for stations matched to a facility
  map.addLayer({
    id: LAYER.STATIONS_MATCH_RING,
    type: 'circle',
    source: SOURCE.STATIONS,
    minzoom: ZOOM.STATIONS_MIN,
    paint: {
      'circle-radius':         STATION_HALO_R,
      'circle-color':          'transparent',
      'circle-opacity':        0,
      'circle-stroke-width':   2,
      'circle-stroke-color':   '#ffffff',
      'circle-stroke-opacity': ['case', ['boolean', ['feature-state', 'matched'], false], 0.7, 0] as maplibregl.ExpressionSpecification,
    },
  });

  // Soft halo for hover / selected state
  map.addLayer({
    id: LAYER.STATIONS_SELECTED_HALO,
    type: 'circle',
    source: SOURCE.STATIONS,
    minzoom: ZOOM.STATIONS_MIN,
    paint: {
      'circle-radius':  STATION_HALO_R,
      'circle-color':   '#ffffff',
      'circle-opacity': [
        'case',
        ['boolean', ['feature-state', 'selected'], false], 0.28,
        ['boolean', ['feature-state', 'hover'],    false], 0.15,
        0,
      ] as maplibregl.ExpressionSpecification,
      'circle-blur': 0.8,
    },
  });

  // Main station circles — filled with voltage colour
  map.addLayer({
    id: LAYER.STATIONS_CIRCLE,
    type: 'circle',
    source: SOURCE.STATIONS,
    minzoom: ZOOM.STATIONS_MIN,
    paint: {
      'circle-radius':         STATION_R,
      'circle-color':          voltageMatch('highestVoltageLevel'),
      'circle-opacity':        1,
      // Crisp white ring that thickens on selection
      'circle-stroke-width':   [
        'interpolate', ['linear'], ['zoom'],
        5,  ['case', ['boolean', ['feature-state', 'selected'], false], 2.0, 1.0],
        12, ['case', ['boolean', ['feature-state', 'selected'], false], 3.0, 1.5],
      ] as maplibregl.ExpressionSpecification,
      'circle-stroke-color':   '#ffffff',
      'circle-stroke-opacity': [
        'case',
        ['boolean', ['feature-state', 'selected'], false], 1.0,
        ['boolean', ['feature-state', 'hover'],    false], 0.8,
        0.45,
      ] as maplibregl.ExpressionSpecification,
    },
  });

  // Inner dot — small bright centre for high-voltage stations at z≥10
  map.addLayer({
    id: LAYER.STATIONS_SELECTED,
    type: 'circle',
    source: SOURCE.STATIONS,
    minzoom: 10,
    filter: ['in', ['get', 'highestVoltageLevel'], ['literal', ['380', '220', '110']]],
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        10, 2,
        14, 3,
        17, 4,
      ] as maplibregl.ExpressionSpecification,
      'circle-color':   '#ffffff',
      'circle-opacity': 0.65,
      'circle-blur':    0,
    },
  });

  map.addLayer({
    id: LAYER.STATIONS_LOGO,
    type: 'symbol',
    source: SOURCE.STATIONS,
    minzoom: 6,
    layout: {
      'text-field': '+',
      'text-size': [
        'interpolate', ['linear'], ['zoom'],
        6, 9,
        10, 12,
        14, 15,
        17, 18,
      ] as maplibregl.ExpressionSpecification,
      'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
      'text-anchor': 'center',
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: {
      'text-color': '#ffffff',
      'text-opacity': [
        'case',
        ['boolean', ['feature-state', 'selected'], false], 0.98,
        ['boolean', ['feature-state', 'hover'], false], 0.92,
        0.72,
      ] as maplibregl.ExpressionSpecification,
      'text-halo-color': 'rgba(0,0,0,0.35)',
      'text-halo-width': 0.5,
    },
  });

  // -- Labels ----------------------------------------------------------------

  map.addLayer({
    id: LAYER.LABELS_LINES,
    type: 'symbol',
    source: SOURCE.LINES,
    minzoom: ZOOM.LINE_LABELS_MIN,
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': [
        'interpolate', ['linear'], ['zoom'], 10, 360, 14, 520, 17, 680,
      ] as maplibregl.ExpressionSpecification,
      'text-field': [
        'coalesce',
        ['get', 'lineName'],
        ['get', 'ref'],
        ['get', 'operatorRef'],
        ['get', 'shortName'],
      ] as maplibregl.ExpressionSpecification,
      'text-size': [
        'interpolate', ['linear'], ['zoom'], 10, 9.5, 14, 11.5, 17, 13,
      ] as maplibregl.ExpressionSpecification,
      'text-font': ['Open Sans SemiBold', 'Open Sans Regular'],
      'text-letter-spacing': 0.02,
      'text-rotation-alignment': 'map',
      'text-pitch-alignment': 'viewport',
      'text-max-angle': 25,
      'text-allow-overlap': false,
      'text-ignore-placement': false,
      'text-optional': true,
    },
    paint: {
      'text-color': voltageMatch('voltageLevel'),
      'text-halo-color': 'rgba(0,0,0,0.88)',
      'text-halo-width': 1.5,
      'text-halo-blur': 0.4,
      'text-opacity': [
        'interpolate', ['linear'], ['zoom'], 10, 0.58, 13, 0.82, 17, 0.95,
      ] as maplibregl.ExpressionSpecification,
    },
  });

  map.addLayer({
    id: LAYER.LABELS_STATIONS,
    type: 'symbol',
    source: SOURCE.STATIONS,
    minzoom: ZOOM.STATION_LABELS_MIN,
    layout: {
      'text-field':         ['get', 'shortName'] as maplibregl.ExpressionSpecification,
      'text-size':          [
        'interpolate', ['linear'], ['zoom'],
        8, 10, 12, 12, 16, 14,
      ] as maplibregl.ExpressionSpecification,
      'text-font':          ['Open Sans Bold', 'Open Sans Regular'],
      'text-anchor':        'top',
      'text-offset':        [0, 1.0],
      'text-allow-overlap': false,
      'text-optional':      true,
      'text-max-width':     8,
    },
    paint: {
      'text-color': [
        'case',
        ['boolean', ['feature-state', 'selected'], false], '#ffffff',
        voltageMatch('highestVoltageLevel'),
      ] as maplibregl.ExpressionSpecification,
      'text-halo-color': 'rgba(0,0,0,0.85)',
      'text-halo-width': 1.5,
      'text-halo-blur':  0.5,
    },
  });

  map.addLayer({
    id: LAYER.LABELS_MASTS,
    type: 'symbol',
    source: SOURCE.MASTS,
    minzoom: ZOOM.MAST_LABELS_MIN,
    layout: {
      'text-field':    ['coalesce', ['get', 'name'], ''] as maplibregl.ExpressionSpecification,
      'text-size':     9,
      'text-font':     ['Open Sans Regular', 'Arial Unicode MS Regular'],
      'text-anchor':   'top',
      'text-offset':   [0, 0.6],
      'text-optional': true,
    },
    paint: {
      'text-color':      '#cccccc',
      'text-halo-color': 'rgba(0,0,0,0.6)',
      'text-halo-width': 1,
      'text-opacity':    0.75,
    },
  });
}

// -----------------------------------------------------------------------------
// Property parsing helpers
// -----------------------------------------------------------------------------

/** Parse a GeoJSON property that may be a JSON-serialised array or real array. */
function parseArrayProp(raw: unknown, fallback: string[]): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as string[]; } catch { /* fall through */ }
  }
  return fallback;
}

function isSyntheticStationPairName(value: unknown): boolean {
  return typeof value === 'string' && /^Ltg\.\s+\d+(?:\.\d+)?\s+kV\s+.+[–-].+/.test(value);
}

function firstStringProp(props: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = props[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function lineDisplayName(props: Record<string, unknown>): string {
  const realName = firstStringProp(props, ['lineName', 'osmName', 'ref', 'operatorRef']);
  if (realName) return realName;

  const name = firstStringProp(props, ['name']);
  if (name && !isSyntheticStationPairName(name)) return name;

  return firstStringProp(props, ['shortName']) ?? String(props.uuid ?? 'Leitung');
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export default function GridMapLibre({
  onTopologyReady,
  onLoadError,
  onSelectStation,
  selectedStationUuid,
  matchedStationUuids,
  theme = 'dark',
  scrollWheelZoom = false,
  className = '',
  style: styleProp,
}: GridMapLibreProps) {

  // -- Refs ------------------------------------------------------------------
  const containerRef      = useRef<HTMLDivElement>(null);
  const mapRef            = useRef<maplibregl.Map | null>(null);
  const sourcesReadyRef   = useRef(false);
  const stationIdMapRef   = useRef(new Map<string, number>());
  const lineIdMapRef      = useRef(new Map<string, number>());
  const hoveredRef        = useRef<{ source: string; id: number } | null>(null);
  const prevSelectedRef   = useRef<number | null>(null);
  const prevMatchedIdsRef = useRef(new Set<number>());

  // Stable callbacks/values: refreshed after every render by the deps-less
  // effect below (mutating a ref mid-render is unsafe) so other effects can
  // read the latest value without re-firing just because the parent passed
  // a new inline-function identity, or (for theme/scrollWheelZoom) without
  // tying the one-time map-init effect to live prop changes.
  const onSelectRef        = useRef(onSelectStation);
  const onTopologyReadyRef = useRef(onTopologyReady);
  const onLoadErrorRef     = useRef(onLoadError);
  const initSnapshotRef    = useRef({ theme, scrollWheelZoom });
  useEffect(() => {
    onSelectRef.current = onSelectStation;
    onTopologyReadyRef.current = onTopologyReady;
    onLoadErrorRef.current = onLoadError;
    initSnapshotRef.current = { theme, scrollWheelZoom };
  });

  // -- State -----------------------------------------------------------------
  const [hoveredFeature,    setHoveredFeature]    = useState<HoveredFeature | null>(null);
  const [panelOpen,         setPanelOpen]         = useState(false);
  const [voltageLevels,     setVoltageLevels]     = useState<string[]>([]);
  const [validationReport,  setValidationReport]  = useState<ValidationReport | null>(null);

  // -- Data ------------------------------------------------------------------
  const { topology, compat, loading, error } = useGridMapData();

  // -- Parent callbacks ------------------------------------------------------
  useEffect(() => { if (compat) onTopologyReadyRef.current?.(compat); }, [compat]);
  useEffect(() => { if (error)  onLoadErrorRef.current?.(error); }, [error]);

  // -- Map initialisation ----------------------------------------------------
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const { theme: initTheme, scrollWheelZoom: initScrollWheelZoom } = initSnapshotRef.current;

    const map = new maplibregl.Map({
      container:   containerRef.current,
      style:       buildBaseStyle(initTheme === 'light', initTheme === 'satellite'),
      center:      [7.22, 51.25],   // NRW default
      zoom:        8,
      maxZoom:     18,
      minZoom:     4,
      // High-DPI rendering — cap at ×2 to avoid excessive VRAM use
      pixelRatio:  Math.min(window.devicePixelRatio || 1, 2),
      canvasContextAttributes: { antialias: true },
      // Disable scroll zoom by default; controlled via scrollWheelZoom prop
      scrollZoom:  initScrollWheelZoom,
      // Disable rotation & pitch — not needed for a flat grid map
      dragRotate:  false,
      pitchWithRotate: false,
      attributionControl: false,
    });

    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current       = null;
      sourcesReadyRef.current = false;
    };
  }, []);

  // -- Core: add sources, layers, and event handlers ------------------------
  const mountTopology = useCallback(
    (map: maplibregl.Map, topo: GridTopologyV2) => {
      if (sourcesReadyRef.current) return;

      // Assign numeric feature IDs
      const [stationsFC, stIdMap] = withNumericIds(topo.stations, 'uuid');
      const [linesFC,    lnIdMap] = withNumericIds(topo.lines,    'uuid');
      const [mastsFC]             = withNumericIds(topo.masts,    'uuid');

      stationIdMapRef.current = stIdMap;
      lineIdMapRef.current    = lnIdMap;

      // GeoJSON sources (generateId: false — we manage IDs ourselves)
      map.addSource(SOURCE.LINES,    { type: 'geojson', data: linesFC,    generateId: false });
      map.addSource(SOURCE.MASTS,    { type: 'geojson', data: mastsFC,    generateId: false });
      map.addSource(SOURCE.STATIONS, { type: 'geojson', data: stationsFC, generateId: false });

      addGridLayers(map);

      sourcesReadyRef.current = true;

      // Update React state for overlay components
      setVoltageLevels(topo.manifest.voltageLevels ?? extractVoltageLevels(topo));
      setValidationReport(topo.validationReport);

      // Fit to data bounds
      const b = topo.manifest.bounds;
      if (b) {
        map.fitBounds(
          [[b.minLon, b.minLat], [b.maxLon, b.maxLat]],
          { padding: 48, duration: 1000 },
        );
      }

      // Re-apply any pending feature-state (e.g. after theme reload)
      if (prevSelectedRef.current !== null) {
        map.setFeatureState(
          { source: SOURCE.STATIONS, id: prevSelectedRef.current },
          { selected: true },
        );
      }

      // -- Event handlers --------------------------------------------------

      // Helper: set hover on a feature and clear the previous one
      const applyHover = (source: string, id: number) => {
        if (hoveredRef.current) {
          map.setFeatureState(hoveredRef.current, { hover: false });
        }
        map.setFeatureState({ source, id }, { hover: true });
        hoveredRef.current = { source, id };
      };

      const clearHover = (source: string) => {
        if (hoveredRef.current?.source === source) {
          map.setFeatureState(hoveredRef.current, { hover: false });
          hoveredRef.current = null;
        }
        setHoveredFeature(null);
        map.getCanvas().style.cursor = '';
      };

      // Station hover
      map.on('mousemove', LAYER.STATIONS_CIRCLE, (e) => {
        if (!e.features?.length) return;
        const f  = e.features[0];
        const id = f.id as number;
        const p  = f.properties as Record<string, unknown>;

        applyHover(SOURCE.STATIONS, id);

        setHoveredFeature({
          type:           'station',
          uuid:           String(p.uuid ?? ''),
          name:           String(p.name ?? ''),
          voltageLevel:   String(p.highestVoltageLevel ?? ''),
          status:         (p.status as HoveredFeature['status']) ?? 'unknown',
          spannungsebenen: parseArrayProp(p.voltageLevel, [String(p.highestVoltageLevel ?? '')]),
          x: e.point.x,
          y: e.point.y,
        });
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', LAYER.STATIONS_CIRCLE, () => clearHover(SOURCE.STATIONS));

      // Station click
      map.on('click', LAYER.STATIONS_CIRCLE, (e) => {
        const uuid = (e.features?.[0]?.properties as { uuid?: string } | undefined)?.uuid;
        if (uuid) onSelectRef.current?.(uuid);
      });

      // Line hover (all line layers share hover logic)
      const lineLayers = [
        LAYER.LINES_OVERHEAD_SOLID,
        LAYER.LINES_OVERHEAD_PLANNED,
        LAYER.LINES_OVERHEAD_UNKNOWN,
        LAYER.LINES_CABLE_SOLID,
        LAYER.LINES_CABLE_PLANNED,
      ];
      lineLayers.forEach((layerId) => {
        map.on('mousemove', layerId, (e) => {
          if (!e.features?.length) return;
          const f  = e.features[0];
          const id = f.id as number;
          const p  = f.properties as Record<string, unknown>;

          applyHover(SOURCE.LINES, id);

          setHoveredFeature({
            type:         'line',
            uuid:         String(p.uuid ?? ''),
            name:         lineDisplayName(p),
            voltageLevel: String(p.voltageLevel ?? ''),
            status:       (p.status as HoveredFeature['status']) ?? 'unknown',
            lineType:     (p.lineType as HoveredFeature['lineType']) ?? 'overhead',
            x: e.point.x,
            y: e.point.y,
          });
          map.getCanvas().style.cursor = 'crosshair';
        });
        map.on('mouseleave', layerId, () => clearHover(SOURCE.LINES));
      });

      // Mast hover
      map.on('mousemove', LAYER.MASTS_CIRCLE, (e) => {
        if (!e.features?.length) return;
        const f  = e.features[0];
        const id = f.id as number;
        const p  = f.properties as Record<string, unknown>;

        applyHover(SOURCE.MASTS, id);

        setHoveredFeature({
          type:             'mast',
          uuid:             String(p.uuid ?? ''),
          name:             p.name ? String(p.name) : String(p.uuid ?? ''),
          voltageLevel:     String(p.voltageLevel ?? ''),
          status:           (p.status as HoveredFeature['status']) ?? 'unknown',
          voltageBreakdown: parseArrayProp(p.voltageBreakdown, [String(p.voltageLevel ?? '')]),
          x: e.point.x,
          y: e.point.y,
        });
        map.getCanvas().style.cursor = 'help';
      });
      map.on('mouseleave', LAYER.MASTS_CIRCLE, () => clearHover(SOURCE.MASTS));
    },
    [],
  );

  // -- Add sources + layers once both map and topology are ready -------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !topology || sourcesReadyRef.current) return;

    const doAdd = () => {
      if (sourcesReadyRef.current) return;
      mountTopology(map, topology);
    };

    if (map.isStyleLoaded()) doAdd();
    else map.once('load', doAdd);
  }, [topology, mountTopology]);

  // -- Theme changes ---------------------------------------------------------
  const prevThemeRef = useRef(theme);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || prevThemeRef.current === theme) return;
    prevThemeRef.current = theme;

    map.setStyle(buildBaseStyle(theme === 'light', theme === 'satellite'));
    sourcesReadyRef.current = false;

    map.once('styledata', () => {
      if (topology) mountTopology(map, topology);
    });
  }, [theme, topology, mountTopology]);

  // -- Selected station ------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !sourcesReadyRef.current) return;

    if (prevSelectedRef.current !== null) {
      map.setFeatureState(
        { source: SOURCE.STATIONS, id: prevSelectedRef.current },
        { selected: false },
      );
      prevSelectedRef.current = null;
    }
    if (selectedStationUuid) {
      const id = stationIdMapRef.current.get(selectedStationUuid);
      if (id !== undefined) {
        map.setFeatureState({ source: SOURCE.STATIONS, id }, { selected: true });
        prevSelectedRef.current = id;
      }
    }
  }, [selectedStationUuid]);

  // -- Matched stations ------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !sourcesReadyRef.current) return;

    prevMatchedIdsRef.current.forEach((id) =>
      map.setFeatureState({ source: SOURCE.STATIONS, id }, { matched: false }),
    );
    prevMatchedIdsRef.current.clear();

    matchedStationUuids?.forEach((uuid) => {
      const id = stationIdMapRef.current.get(uuid);
      if (id !== undefined) {
        map.setFeatureState({ source: SOURCE.STATIONS, id }, { matched: true });
        prevMatchedIdsRef.current.add(id);
      }
    });
  }, [matchedStationUuids]);

  // -- Scroll-wheel zoom toggle -----------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (scrollWheelZoom) {
      map.scrollZoom.enable();
    } else {
      map.scrollZoom.disable();
    }
  }, [scrollWheelZoom]);


  // -- CSS variables for overlays (shared via CSS custom properties) ---------
  const cssVars: Record<string, string> = theme === 'light'
    ? { '--grid-surface': '#ffffff', '--grid-border': 'rgba(0,0,0,0.12)',           '--grid-text': '#333333' }
    : { '--grid-surface': '#1a1a2e', '--grid-border': 'rgba(255,255,255,0.12)',     '--grid-text': '#e0e0e0' };

  // -- Render ----------------------------------------------------------------
  return (
    <div
      className={`grid-map-libre ${className}`}
      style={{ position: 'relative', width: '100%', height: '100%', ...cssVars as React.CSSProperties, ...styleProp }}
    >
      {/* MapLibre canvas host */}
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

      {/* -- Loading overlay ------------------------------------------------ */}
      {loading && (
        <div style={centreOverlay}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
            <div style={spinner} />
            <span style={{ fontSize: 13, color: 'var(--grid-text)', opacity: 0.7 }}>
              Netztopologie wird geladen…
            </span>
          </div>
        </div>
      )}

      {/* -- Error overlay -------------------------------------------------- */}
      {!loading && error && (
        <div style={{ ...centreOverlay, background: 'rgba(20,8,8,0.92)' }}>
          <div style={{ maxWidth: 360, textAlign: 'center', padding: '0 24px' }}>
            <div style={{ fontSize: 32, marginBottom: 14 }}>⚠</div>
            <div style={{ fontWeight: 700, fontSize: 15, color: '#ff9999', marginBottom: 10 }}>
              Kartendaten nicht verfügbar
            </div>
            <div style={{ fontSize: 12, color: '#cccccc', lineHeight: 1.6, opacity: 0.8 }}>
              {error}
            </div>
          </div>
        </div>
      )}

      {/* -- Validation banner (top, centred) ------------------------------- */}
      {validationReport && (
        <ValidationBanner
          report={validationReport}
          onShowDetails={() => setPanelOpen(true)}
        />
      )}

      {/* -- Validation panel (slide-in from right) ------------------------- */}
      {panelOpen && validationReport && (
        <ValidationPanel
          report={validationReport}
          onClose={() => setPanelOpen(false)}
        />
      )}

      {/* -- Legend (bottom-right) ------------------------------------------ */}
      {!loading && !error && (
        <MapLegend voltageLevels={voltageLevels} />
      )}

      {/* -- Feature tooltip (follows cursor, portal to body) --------------- */}
      <FeatureTooltip feature={hoveredFeature} />
    </div>
  );
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function extractVoltageLevels(topo: GridTopologyV2): string[] {
  const seen = new Set<string>();
  topo.lines.features.forEach((f) => {
    const v = (f.properties as LineProperties).voltageLevel;
    if (v) seen.add(v);
  });
  topo.stations.features.forEach((f) => {
    const vs = (f.properties as StationProperties).voltageLevel;
    if (Array.isArray(vs)) vs.forEach((v) => seen.add(v));
  });
  return [...seen];
}

// -----------------------------------------------------------------------------
// Shared inline styles
// -----------------------------------------------------------------------------

const centreOverlay: React.CSSProperties = {
  position:       'absolute',
  inset:          0,
  zIndex:         600,
  display:        'flex',
  alignItems:     'center',
  justifyContent: 'center',
  background:     'rgba(10,10,20,0.75)',
  backdropFilter: 'blur(3px)',
};

const spinner: React.CSSProperties = {
  width:       32,
  height:      32,
  borderRadius: '50%',
  border:       '3px solid rgba(255,255,255,0.15)',
  borderTop:    '3px solid rgba(255,255,255,0.75)',
  animation:    'grid-map-spin 0.8s linear infinite',
};
