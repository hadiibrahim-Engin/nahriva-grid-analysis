/**
 * Visual constants for the electrical grid map.
 *
 * Single source of truth for:
 * - Voltage-level colour palette
 * - Line widths per voltage
 * - Dash arrays per status × line type
 * - MapLibre layer IDs
 * - Zoom thresholds
 * - Station circle radii
 */

// -- Voltage colour palette -------------------------------------------------
// Colours are distinct, colourblind-friendly, and ordered
// from highest (most prominent) to lowest voltage.

export const VOLTAGE_COLORS: Readonly<Record<string, string>> = {
  '380':     '#E63946',   // 380 kV — bold red
  '220':     '#F4A261',   // 220 kV — amber/orange
  '110':     '#2A9D8F',   // 110 kV — teal
  '66':      '#457B9D',   // 66 kV  — steel blue
  '36':      '#8338EC',   // 36 kV  — violet
  '20':      '#3A86FF',   // 20 kV  — bright blue
  '10':      '#06D6A0',   // 10 kV  — mint
  '6':       '#FFB703',   // 6 kV   — yellow
  '1':       '#8D99AE',   // 1 kV   — medium grey
  '0.4':     '#B0BEC5',   // 0.4 kV — light grey
  unknown:   '#9E9E9E',   // Fallback — mid grey
};

/** Ordered list of standard voltage levels for legend rendering. */
export const VOLTAGE_LEVELS_ORDERED = [
  '380', '220', '110', '66', '36', '20', '10', '6', '1', '0.4',
] as const;

/** Returns the canonical colour for a voltage level string, or the unknown fallback. */
export function voltageColor(level: string | undefined | null): string {
  if (!level) return VOLTAGE_COLORS.unknown;
  return VOLTAGE_COLORS[level] ?? VOLTAGE_COLORS.unknown;
}

// -- Line widths ------------------------------------------------------------

export const VOLTAGE_LINE_WIDTH: Readonly<Record<string, number>> = {
  '380': 4,
  '220': 3,
  '110': 2.5,
  '66':  2,
};

export function voltageLineWidth(level: string | undefined | null): number {
  if (!level) return 1.5;
  return VOLTAGE_LINE_WIDTH[level] ?? 1.5;
}

// -- Dash arrays ------------------------------------------------------------
// MapLibre line-dasharray values (unitless segments).
// Cable uses a tight dot pattern; overhead uses long dashes for planned.

export const DASH = {
  solid:        [] as number[],        // in_operation overhead
  planned:      [6, 4] as number[],   // planned overhead
  unknown:      [2, 4] as number[],   // unknown status
  cableSolid:   [1, 3] as number[],   // in_operation cable
  cablePlanned: [1, 3, 5, 3] as number[], // planned cable (dots + dash)
} as const;

// -- MapLibre source IDs ----------------------------------------------------

export const SOURCE = {
  STATIONS: 'grid-stations',
  LINES:    'grid-lines',
  MASTS:    'grid-masts',
} as const;

// -- MapLibre layer IDs ----------------------------------------------------
// Ordered from bottom to top (render order).

export const LAYER = {
  // Lines
  LINES_OVERHEAD_SOLID:   'lines-overhead-solid',
  LINES_OVERHEAD_PLANNED: 'lines-overhead-planned',
  LINES_OVERHEAD_UNKNOWN: 'lines-overhead-unknown',
  LINES_CABLE_BASE:       'lines-cable-base',
  LINES_CABLE_SOLID:      'lines-cable-solid',
  LINES_CABLE_PLANNED:    'lines-cable-planned',
  LINES_HIGHLIGHT:        'lines-highlight',

  // Masts
  MASTS_CIRCLE:           'masts-circle',
  MASTS_CROSSBAR:         'masts-crossbar',
  MASTS_HIGHLIGHT:        'masts-highlight',

  // Stations
  STATIONS_MATCH_RING:    'stations-match-ring',
  STATIONS_CIRCLE:        'stations-circle',
  STATIONS_SELECTED_HALO: 'stations-selected-halo',
  STATIONS_SELECTED:      'stations-selected',
  STATIONS_LOGO:          'stations-logo',

  // Labels
  LABELS_LINES:           'labels-lines',
  LABELS_STATIONS:        'labels-stations',
  LABELS_MASTS:           'labels-masts',
} as const;

// -- Zoom thresholds --------------------------------------------------------

export const ZOOM = {
  LINES_MIN:          5,
  STATIONS_MIN:       5,
  STATION_LABELS_MIN: 8,
  LINE_LABELS_MIN:    10,
  MASTS_MIN:          13,
  MAST_LABELS_MIN:    15,
} as const;

// -- Station circle radii ---------------------------------------------------
// Interpolated by zoom level; inner value at z9, outer value at z17.

export const STATION_RADIUS: Record<string, [number, number]> = {
  '380': [10, 20],
  '220': [8,  16],
  '110': [6,  13],
  '66':  [5,  11],
  unknown: [5, 11],
};

export function stationRadius(level: string | undefined | null): [number, number] {
  if (!level) return STATION_RADIUS.unknown;
  return STATION_RADIUS[level] ?? STATION_RADIUS.unknown;
}

// -- Tile base map styles ---------------------------------------------------

/**
 * Return the base-map style for MapLibre.
 *
 * • dark / light  → CARTO GL vector styles (crisp text, proper glyph server,
 *                    smooth zoom at every fractional level)
 * • satellite     → Esri World Imagery raster + label overlay
 *
 * Returning a URL string for vector styles lets MapLibre fetch and merge
 * the full style spec (glyphs, sprites, sources) automatically, so our
 * own symbol layers can render labels with Open Sans.
 */
export function buildBaseStyle(
  isLight: boolean,
  isSatellite = false,
): string | maplibregl.StyleSpecification {
  if (isSatellite) {
    // Raster satellite — no glyph server needed (no text labels from base)
    return {
      version: 8,
      sources: {
        satellite: {
          type: 'raster',
          tiles: [
            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
          ],
          tileSize: 256,
          maxzoom: 19,
          attribution: 'Tiles © Esri',
        },
        'satellite-labels': {
          type: 'raster',
          tiles: [
            'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
          ],
          tileSize: 256,
          attribution: '© Esri',
        },
      },
      layers: [
        { id: 'satellite-bg',     type: 'raster', source: 'satellite' },
        { id: 'satellite-labels', type: 'raster', source: 'satellite-labels' },
      ],
      // Glyph server needed so our own symbol layers work even on satellite
      glyphs: 'https://tiles.basemaps.cartocdn.com/fonts/{fontstack}/{range}.pbf',
    } as maplibregl.StyleSpecification;
  }

  // CARTO GL vector styles — full vector rendering, glyph server included
  return isLight
    ? 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
    : 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
}

// Import type for the style spec reference above
import type * as maplibregl from 'maplibre-gl';
