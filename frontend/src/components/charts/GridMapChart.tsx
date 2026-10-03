/**
 * Geographic view of the grid topology.
 *
 * Renders stations as circle markers and Stromkreise as polylines on
 * top of an OpenStreetMap tile layer (CartoDB light / dark).
 *
 * Visual language:
 *   • Marker fill    — highest voltage level at the station
 *   • Marker radius  — degree centrality (number of circuits attached)
 *   • Selected       — larger radius, white stroke, halo ring
 *   • Match ring     — outer ring colour indicates pre-computed fuzzy-match
 *                       confidence: green = high, amber = medium, muted = none
 *   • Polyline colour— voltage band (380 / 220 / 110 / MS)
 *   • Polyline weight— voltage level (thicker = higher voltage)
 *   • Dashed         — `planung = true`  (planned, not yet built)
 *   • Dotted         — typ contains "Kabel" (underground cable)
 *
 * scrollWheelZoom is enabled (default): scrolling the wheel over the map
 * zooms it. To scroll the page, the user scrolls in the area BELOW the
 * map (the charts-overlay section).
 */
import React, { useEffect, useMemo } from 'react';
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Polyline,
  Tooltip,
  Popup,
  useMap,
} from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { canvas as createCanvasRenderer } from 'leaflet';
import type { LatLngExpression, LatLngBoundsExpression } from 'leaflet';
import { useChartTheme } from '../../hooks/useChartTheme';
import AnimatedDottedMap from '../AnimatedDottedMap';
import type {
  MockTopology,
  MockStation,
  MockTransformer,
} from './gridMockData';
import type { MatchResult } from '../../util/facilityMatcher';

export type MapLayerMode = 'grid' | 'satellite';

interface Props {
  topology: MockTopology;
  /** UUID of the currently selected station — shown with highlight ring. */
  selectedStationUuid?: string | null;
  /** Callback when the user picks a station from the popup. */
  onSelectStation?: (stationUuid: string) => void;
  /** Callback when the selected station popup/summary should be cleared. */
  onClearStation?: () => void;
  /**
   * Pre-computed fuzzy-match results for every station, keyed by UUID.
   * Used to colour match-quality rings on the markers before the user clicks.
   */
  stationMatchMap?: Map<string, MatchResult | null>;
  /** Whether wheel input over the map zooms the map or scrolls the page. */
  scrollWheelZoom?: boolean;
  /** Visual tile/background style. */
  layerMode?: MapLayerMode;
}

// -- helpers ---------------------------------------------------------------

/** Highest voltage level (kV) the station operates at — used for colour/size. */
function highestVoltage(station: MockStation): number {
  const nums = station.spannungsebenen
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
  return nums.length ? Math.max(...nums) : 0;
}

function hasValidStationCoordinate(station: MockStation): boolean {
  return (
    Number.isFinite(station.lat) &&
    Number.isFinite(station.lon) &&
    station.lat >= -90 &&
    station.lat <= 90 &&
    station.lon >= -180 &&
    station.lon <= 180
  );
}

/** Mean centre of all stations — used as the map's initial view. */
function meanCenter(stations: MockStation[]): LatLngExpression {
  if (stations.length === 0) return [51.4, 7.1];
  const lat = stations.reduce((s, st) => s + st.lat, 0) / stations.length;
  const lon = stations.reduce((s, st) => s + st.lon, 0) / stations.length;
  return [lat, lon];
}

/** Bounding box of all stations with a little padding. */
function stationBounds(stations: MockStation[]): LatLngBoundsExpression | undefined {
  if (stations.length < 2) return undefined;
  const lats = stations.map((s) => s.lat);
  const lons = stations.map((s) => s.lon);
  const pad = 0.1;
  return [
    [Math.min(...lats) - pad, Math.min(...lons) - pad],
    [Math.max(...lats) + pad, Math.max(...lons) + pad],
  ];
}

interface TileConfig {
  url: string;
  attribution: string;
  subdomains?: string[];
  className?: string;
  labelOverlay?: {
    url: string;
    attribution: string;
    className?: string;
  };
}

function tileConfig(layerMode: MapLayerMode, isLight: boolean): TileConfig {
  if (layerMode === 'satellite') {
    return {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attribution: 'Tiles &copy; Esri',
      className: 'grid-map-satellite-tiles',
      labelOverlay: {
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
        attribution: 'Labels &copy; Esri',
        className: 'grid-map-label-tiles',
      },
    };
  }

  return {
    url: isLight
      ? 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
      : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: ['a', 'b', 'c', 'd'],
  };
}

// -- Inner component: fly to selected station ------------------------------

/**
 * Mounts inside MapContainer so it has access to the Leaflet map instance.
 * Flies to the selected station whenever `uuid` changes.
 */
function FlyToStation({
  uuid,
  stations,
}: {
  uuid: string | null | undefined;
  stations: MockStation[];
}) {
  const map = useMap();
  useEffect(() => {
    if (!uuid) return;
    const station = stations.find((s) => s.uuid === uuid);
    if (station) {
      map.flyTo([station.lat, station.lon], Math.max(map.getZoom(), 11), {
        duration: 1.0,
        easeLinearity: 0.35,
      });
    }
  }, [uuid, stations, map]);
  return null;
}

function MapRuntimeOptions({
  scrollWheelZoom,
  layerMode,
}: {
  scrollWheelZoom: boolean;
  layerMode: MapLayerMode;
}) {
  const map = useMap();

  useEffect(() => {
    if (scrollWheelZoom) {
      map.scrollWheelZoom.enable();
    } else {
      map.scrollWheelZoom.disable();
    }
  }, [map, scrollWheelZoom]);

  useEffect(() => {
    const container = map.getContainer();
    container.classList.remove('grid-map-layer--grid', 'grid-map-layer--satellite');
    container.classList.add(`grid-map-layer--${layerMode}`);
  }, [map, layerMode]);

  return null;
}

// -- Main component --------------------------------------------------------

function GridMapChart({
  topology,
  selectedStationUuid,
  onSelectStation,
  onClearStation,
  stationMatchMap,
  scrollWheelZoom = true,
  layerMode = 'grid',
}: Props) {
  const theme = useChartTheme();
  const { stations: rawStations, circuits, transformers } = topology;
  const stations = useMemo(
    () => rawStations.filter(hasValidStationCoordinate),
    [rawStations],
  );
  const pathRenderer = useMemo(() => createCanvasRenderer({ padding: 0.4, tolerance: 8 }), []);
  const initialCenter = useMemo(() => meanCenter(stations), [stations]);
  const initialBounds = useMemo(() => stationBounds(stations), [stations]);
  const networkRoutes = useMemo(() => circuits.slice(0, 7).flatMap((circuit) => {
    const [aUuid, bUuid] = circuit.stationen;
    const a = stations.find((station) => station.uuid === aUuid);
    const b = stations.find((station) => station.uuid === bUuid);
    if (!a || !b) return [];
    return [{
      start: { lat: a.lat, lng: a.lon, label: a.identifierKurz },
      end: { lat: b.lat, lng: b.lon, label: b.identifierKurz },
    }];
  }), [circuits, stations]);

  // Lookups keyed by UUID — built once per topology.
  const stationByUuid = useMemo(() => {
    const m = new Map<string, MockStation>();
    stations.forEach((s) => m.set(s.uuid, s));
    return m;
  }, [stations]);

  const transformersByStation = useMemo(() => {
    const m = new Map<string, MockTransformer[]>();
    transformers.forEach((t) => {
      const arr = m.get(t.uuidStation) ?? [];
      arr.push(t);
      m.set(t.uuidStation, arr);
    });
    return m;
  }, [transformers]);

  // Degree centrality — number of circuits each station participates in.
  const degree = useMemo(() => {
    const d = new Map<string, number>();
    circuits.forEach((c) => {
      c.stationen.forEach((uuid) => d.set(uuid, (d.get(uuid) ?? 0) + 1));
    });
    return d;
  }, [circuits]);

  const voltageColour = (kv: number): string => {
    if (kv >= 380) return theme.danger;
    if (kv >= 220) return theme.warning;
    if (kv >= 110) return theme.primary;
    return theme.mutedText;
  };

  const voltageWeight = (kv: number): number => {
    if (kv >= 380) return 4;
    if (kv >= 220) return 3;
    if (kv >= 110) return 2;
    return 1.5;
  };

  const tiles = tileConfig(layerMode, theme.isLight);

  /** Colour of the pre-computed match-quality ring for a given station. */
  const matchRingColour = (uuid: string): string | null => {
    if (!stationMatchMap) return null;
    const m = stationMatchMap.get(uuid);
    if (!m) return null;
    if (m.confidence === 'high')   return theme.success;
    if (m.confidence === 'medium') return theme.warning;
    return null; // low confidence — no ring
  };

  return (
    <div className="relative h-full w-full overflow-hidden">
      <MapContainer
        center={initialCenter}
        zoom={9}
        bounds={initialBounds}
        scrollWheelZoom={scrollWheelZoom}
        preferCanvas
        wheelDebounceTime={55}
        wheelPxPerZoomLevel={90}
        zoomSnap={0.5}
        zoomDelta={0.5}
        style={{ height: '100%', width: '100%' }}
        className={`grid-map-view grid-map-layer--${layerMode}`}
      >
      <MapRuntimeOptions
        scrollWheelZoom={scrollWheelZoom}
        layerMode={layerMode}
      />
      <TileLayer
        key={`${theme.isLight ? 'light' : 'dark'}-${layerMode}`}
        url={tiles.url}
        attribution={tiles.attribution}
        {...(tiles.subdomains ? { subdomains: tiles.subdomains } : {})}
        className={tiles.className}
        // Defer tile work while interacting; a smaller buffer keeps pan/zoom responsive.
        updateWhenIdle
        updateWhenZooming={false}
        updateInterval={160}
        keepBuffer={2}
        detectRetina={false}
      />
      {tiles.labelOverlay && (
        <TileLayer
          key={`labels-${layerMode}`}
          url={tiles.labelOverlay.url}
          attribution={tiles.labelOverlay.attribution}
          className={tiles.labelOverlay.className}
          updateWhenIdle
          updateWhenZooming={false}
          updateInterval={160}
          keepBuffer={2}
          detectRetina={false}
          pane="tilePane"
          zIndex={240}
        />
      )}

      {/* Fly to selected station when it changes */}
      <FlyToStation uuid={selectedStationUuid} stations={stations} />

      {/* -- Stromkreise ----------------------------------------------- */}
      {circuits.map((circuit) => {
        const [aUuid, bUuid] = circuit.stationen;
        const a = stationByUuid.get(aUuid);
        const b = stationByUuid.get(bUuid);
        if (!a || !b) return null;

        const kv = Number(circuit.spannungsebene) || 0;
        const isCable = circuit.typ.includes('Kabel');
        const isMixed = circuit.typ === 'Kabel+Freileitung';

        const dashArray = circuit.planung
          ? '6 6'
          : isMixed
            ? '10 4'
            : isCable
              ? '2 4'
              : undefined;

        return (
          <Polyline
            key={circuit.uuid}
            positions={[
              [a.lat, a.lon],
              [b.lat, b.lon],
            ]}
            renderer={pathRenderer}
            pathOptions={{
              color: voltageColour(kv),
              weight: voltageWeight(kv),
              opacity: circuit.planung ? 0.55 : 0.9,
              dashArray,
            }}
          >
            <Tooltip sticky>
              <div className="text-xs">
                <div className="font-semibold">{circuit.langname}</div>
                <div className="opacity-80">
                  {circuit.spannungsebene} kV · {circuit.typ}
                  {typeof circuit.laenge === 'number' ? ` · ${circuit.laenge} km` : ''}
                </div>
                {circuit.planung && <div className="opacity-80 italic">in Planung</div>}
              </div>
            </Tooltip>
          </Polyline>
        );
      })}

      {/* -- Stations -------------------------------------------------- */}
      {stations.map((station) => {
        const kv = highestVoltage(station);
        const deg = degree.get(station.uuid) ?? 0;
        const baseRadius = 6 + Math.min(deg, 6) * 1.4;
        const fill = voltageColour(kv);
        const stationTrafos = transformersByStation.get(station.uuid) ?? [];
        const isSelected = station.uuid === selectedStationUuid;
        const ringColour = matchRingColour(station.uuid);
        const preMatch = stationMatchMap?.get(station.uuid) ?? null;

        return (
          <React.Fragment key={station.uuid}>
            {/* Match-quality ring — shown behind the station marker */}
            {ringColour && !isSelected && (
              <CircleMarker
                key={`${station.uuid}-mring`}
                center={[station.lat, station.lon]}
                radius={baseRadius + 8}
                interactive={false}
                renderer={pathRenderer}
                pathOptions={{
                  color: ringColour,
                  fillOpacity: 0,
                  weight: 2,
                  opacity: 0.65,
                }}
              />
            )}

            <CircleMarker
              center={[station.lat, station.lon]}
              radius={isSelected ? baseRadius + 5 : baseRadius}
              renderer={pathRenderer}
              pathOptions={{
                color: isSelected ? '#ffffff' : fill,
                fillColor: fill,
                fillOpacity: isSelected ? 1.0 : station.planung ? 0.35 : 0.85,
                weight: isSelected ? 3 : 2,
                dashArray: !isSelected && station.planung ? '4 3' : undefined,
              }}
              eventHandlers={{
                click: () => onSelectStation?.(station.uuid),
                popupclose: () => {
                  if (station.uuid === selectedStationUuid) onClearStation?.();
                },
              }}
            >
              <Tooltip direction="top" offset={[0, -(baseRadius + 5)]}>
                <div className="text-xs">
                  <div className="font-semibold">{station.langname}</div>
                  <div className="opacity-80">
                    {station.spannungsebenen.join(' / ')} kV
                  </div>
                  {preMatch && preMatch.confidence !== 'low' && (
                    <div
                      className="mt-0.5"
                      style={{
                        color: preMatch.confidence === 'high'
                          ? theme.success
                          : theme.warning,
                      }}
                    >
                      {preMatch.confidence === 'high' ? '✓' : '~'}{' '}
                      {preMatch.facility.name}
                    </div>
                  )}
                  {isSelected && (
                    <div className="opacity-70 italic mt-0.5">ausgewählt</div>
                  )}
                </div>
              </Tooltip>
              <Popup>
                <div
                  className="text-xs"
                  style={{ minWidth: 210, color: 'var(--grid-text)' }}
                >
                  <div className="font-semibold text-sm mb-1">
                    {station.langname}
                    {isSelected && (
                      <span
                        className="ml-1 text-xs font-normal"
                        style={{ color: 'var(--grid-primary)' }}
                      >
                        ✓ aktiv
                      </span>
                    )}
                  </div>
                  <div className="opacity-80 mb-2">
                    {station.identifierKurz} · {station.typ}
                  </div>
                  <div className="mb-2">
                    <span className="opacity-60">Spannung: </span>
                    {station.spannungsebenen.join(' / ')} kV
                  </div>
                  <div className="mb-2">
                    <span className="opacity-60">Status: </span>
                    {station.status}
                  </div>

                  {/* Pre-computed match info */}
                  {preMatch && (
                    <div
                      className="mb-2 px-2 py-1 rounded text-xs"
                      style={{
                        background: preMatch.confidence === 'high'
                          ? `${theme.success}20`
                          : preMatch.confidence === 'medium'
                            ? `${theme.warning}20`
                            : 'var(--grid-surface-strong)',
                        color: preMatch.confidence === 'high'
                          ? theme.success
                          : preMatch.confidence === 'medium'
                            ? theme.warning
                            : 'var(--grid-muted)',
                      }}
                    >
                      <span className="font-semibold">
                        {preMatch.confidence === 'high' ? '✓ ' :
                         preMatch.confidence === 'medium' ? '~ ' : '? '}
                        {preMatch.facility.name}
                      </span>
                      <span className="ml-1 opacity-70">
                        ({Math.round(preMatch.score * 100)} %)
                      </span>
                    </div>
                  )}

                  {stationTrafos.length > 0 && (
                    <div className="mb-2">
                      <div className="opacity-60 mb-1">Transformatoren:</div>
                      <ul className="pl-3 list-disc space-y-0.5">
                        {stationTrafos.map((t) => (
                          <li key={t.uuid}>
                            <span className="font-semibold">{t.bezeichnung}</span>{' '}
                            — {t.umspannebenen} kV · {t.nennleistung} MVA
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => onSelectStation?.(station.uuid)}
                    className="mt-2 w-full text-xs px-3 py-1.5 rounded transition-colors"
                    style={{
                      background: isSelected
                        ? 'var(--grid-surface-strong)'
                        : 'var(--grid-primary)',
                      color: isSelected ? 'var(--grid-text)' : '#fff',
                    }}
                  >
                    {isSelected ? '✓ Ausgewählt' : 'Diese Station auswählen'}
                  </button>
                </div>
              </Popup>
            </CircleMarker>
          </React.Fragment>
        );
      })}

      {/* Selected station halo ring — canvas-rendered, slightly larger
          radius with no fill to create a visible selection indicator. */}
      {selectedStationUuid && (() => {
        const sel = stationByUuid.get(selectedStationUuid);
        if (!sel) return null;
        const kv = highestVoltage(sel);
        const deg = degree.get(sel.uuid) ?? 0;
        const baseRadius = 6 + Math.min(deg, 6) * 1.4;
        return (
          <CircleMarker
            key={`${selectedStationUuid}-halo`}
            center={[sel.lat, sel.lon]}
            radius={baseRadius + 14}
            interactive={false}
            renderer={pathRenderer}
            pathOptions={{
              color: voltageColour(kv),
              fillOpacity: 0,
              weight: 1.5,
              opacity: 0.55,
            }}
          />
        );
      })()}

        <Legend theme={theme} />
      </MapContainer>
      <AnimatedDottedMap
        routes={networkRoutes}
        lineColor={theme.primary}
        showLabels={false}
        muted
        className="pointer-events-none absolute inset-0 z-[360] border-0 bg-transparent opacity-45 mix-blend-screen"
        animationDuration={2.2}
      />
    </div>
  );
}

export default React.memo(GridMapChart);

// -- Legend overlay --------------------------------------------------------

function Legend({ theme }: { theme: ReturnType<typeof useChartTheme> }) {
  const items: { color: string; label: string }[] = [
    { color: theme.danger,  label: '380 kV' },
    { color: theme.warning, label: '220 kV' },
    { color: theme.primary, label: '110 kV' },
  ];
  return (
    <div
      className="absolute bottom-3 right-3 z-[400] rounded-md border px-3 py-2 text-xs shadow-lg"
      style={{
        background: 'var(--grid-surface)',
        borderColor: 'var(--grid-border)',
        color: 'var(--grid-text)',
      }}
    >
      <div className="font-semibold mb-1 opacity-80">Spannung</div>
      {items.map((it) => (
        <div key={it.label} className="flex items-center gap-2 mb-0.5">
          <span
            className="inline-block h-2 w-6 rounded-sm"
            style={{ background: it.color }}
          />
          <span>{it.label}</span>
        </div>
      ))}
      <div
        className="mt-1 pt-1 border-t"
        style={{ borderColor: 'var(--grid-border)' }}
      >
        <div className="opacity-70">- - in Planung</div>
        <div className="opacity-70">· · · Kabel</div>
      </div>
    </div>
  );
}
