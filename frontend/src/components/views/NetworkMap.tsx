import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import api from '../../api/client';
import { ASSESSMENT } from '../../config/assessment';
import { LOADING_LIMITS } from '../../config/loadingBands';
import { useAnalysis } from '../../hooks/useAnalysis';
import { useChartTheme } from '../../hooks/useChartTheme';
import { readAcrossColors, type AcrossColors } from '../../util/acrossColors';

interface MapInfo { name: string; bytes: number }
interface MapMatch {
  /** Matched elements once: [id, name, grid, nominal kV, class]; the values come in this order. */
  elements: [string, string, string | null, number | null, string | null][];
  /** Layer id -> index in `elements`. */
  layers: Record<string, number>;
  counts: { layers: number; matched: number; elements: number; elements_without_layer: number };
  unmatched_layers: string[];
  ambiguous_layers: string[];
  repeated_layers: string[];
  elements_without_layer: { element_id: string; name: string; grid: string }[];
}
/** GET /maps/{name}/values: columns in the order of `elements` (m: 0 loading, 1 voltage, null not in the run). */
interface MapValues {
  t: number;
  in_window: boolean;
  m: (0 | 1 | null)[];
  v: (number | null)[];
  r: (number | null)[];
  lo: (number | null)[];
  up: (number | null)[];
  off: number[];
}
/** The shapes of one element that take its colour, found once per map. */
interface Paint { strokes: SVGElement[]; fills: SVGElement[]; all: SVGElement[] }

const SHAPES = 'path,line,polyline,polygon,rect,circle,ellipse';
const WHITE = new Set(['#fff', '#ffffff', 'white']);
const DROP = 'script,foreignObject,iframe,object,embed,audio,video';
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 40;

/** The SVG of a map as DOM, without anything that could run: scripts, embedded documents, handlers, links out. */
function sanitize(text: string): SVGSVGElement | null {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = doc.documentElement;
  if (doc.querySelector('parsererror') || svg.nodeName.toLowerCase() !== 'svg') return null;
  svg.querySelectorAll(DROP).forEach((node) => node.remove());
  for (const node of [svg, ...Array.from(svg.querySelectorAll('*'))]) {
    for (const attribute of Array.from(node.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (name.startsWith('on') || ((name === 'href' || name === 'xlink:href') && !value.startsWith('#') && !value.startsWith('data:image/'))) {
        node.removeAttribute(attribute.name);
      }
    }
  }
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.setAttribute('class', 'ab-map__svg');
  return document.importNode(svg, true) as unknown as SVGSVGElement;
}

/** Marks every matched layer (one pass over all ids, not one search per layer) and collects its colour shapes. */
function prepare(svg: SVGSVGElement, layers: Record<string, number>, count: number): Paint[] {
  const paints: Paint[] = Array.from({ length: count }, () => ({ strokes: [], fills: [], all: [] }));
  for (const node of Array.from(svg.querySelectorAll<SVGElement>('[id]'))) {
    const index = layers[node.id];
    if (index === undefined) continue;
    node.setAttribute('data-index', String(index));
    const paint = paints[index];
    for (const shape of node.matches(SHAPES) ? [node] : Array.from(node.querySelectorAll<SVGElement>(SHAPES))) {
      const stroke = shape.getAttribute('stroke');
      const fill = shape.getAttribute('fill');
      paint.all.push(shape);
      if (stroke && stroke !== 'none') paint.strokes.push(shape);
      if (fill && fill !== 'none' && !WHITE.has(fill.toLowerCase()) && shape.getAttribute('fill-opacity') !== '0') paint.fills.push(shape);
    }
  }
  return paints;
}

function colourOf(values: MapValues, i: number, colors: AcrossColors, muted: string): string {
  const v = values.v[i];
  if (v === null || values.off.includes(i)) return muted;
  if (values.m[i] === 0) {
    const l = LOADING_LIMITS;
    return v >= l.severe ? colors.bands.severe : v > l.clear ? colors.bands.clear : v > l.overload
      ? colors.bands.light : v >= l.warning ? colors.bands.high : colors.bands.ok;
  }
  const lower = values.lo[i] ?? ASSESSMENT.voltageBandPu.lower;
  const upper = values.up[i] ?? ASSESSMENT.voltageBandPu.upper;
  if (v < lower || v > upper) return colors.bands.severe;
  return v < lower + ASSESSMENT.voltageMarginPu || v > upper - ASSESSMENT.voltageMarginPu ? colors.bands.high : colors.bands.ok;
}

function tooltip(match: MapMatch, values: MapValues | null, i: number): string {
  const [, name, grid, kv] = match.elements[i];
  const head = `${name}${grid ? ` · ${grid}` : ''}${kv ? ` · ${kv} kV` : ''}`;
  if (!values || values.m[i] === null) return `${head}\nno value at this time`;
  if (values.off.includes(i)) return `${head}\nswitched off`;
  const v = values.v[i];
  const r = values.r[i];
  if (v === null) return `${head}\nno valid value`;
  const loading = values.m[i] === 0;
  const f = (x: number) => (loading ? `${x.toFixed(1)} %` : `${x.toFixed(3)} p.u.`);
  const d = r === null ? '' : ` (${v - r >= 0 ? '+' : ''}${loading ? `${(v - r).toFixed(1)} pp` : (v - r).toFixed(3)} against REF ${f(r)})`;
  return `${head}\n${f(v)}${d}`;
}

/**
 * The network map at one time: an SVG exported from the operator's Figma map, every equipment layer coloured by
 * its value (branches by loading, busbars by voltage). Hover shows the value, click opens the element in the
 * asset view. Built for large maps: the drawing is inserted once, a new time only changes colours, and zooming and
 * panning move one GPU layer without rendering React.
 */
export default function NetworkMap({ scenarioId, t, onPickAsset }: {
  scenarioId: string;
  t: number;
  onPickAsset?: (elementId: string) => void;
}) {
  const { analysis } = useAnalysis();
  const theme = useChartTheme();
  const colors = useMemo(() => readAcrossColors(theme.isLight), [theme.isLight]);
  const [list, setList] = useState<{ folder: string; maps: MapInfo[] } | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [map, setMap] = useState<{ key: string; svg: string; match: MapMatch } | null>(null);
  const [loaded, setValues] = useState<{ map: string; data: MapValues } | null>(null);
  const [error, setError] = useState('');
  const host = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const view = useRef({ x: 0, y: 0, k: 1 });
  const pending = useRef(0);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ moved: boolean; distance: number } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api.get<{ folder: string; maps: MapInfo[] }>('/maps', { signal: controller.signal })
      .then((response) => setList(response.data))
      .catch(() => { if (!controller.signal.aborted) setList({ folder: '', maps: [] }); });
    return () => controller.abort();
  }, []);
  const name = chosen ?? list?.maps[0]?.name ?? null;
  const mapKey = `${name}|${analysis}`;

  useEffect(() => {
    if (!name) return;
    const controller = new AbortController();
    const params = analysis === null ? {} : { analysis };
    Promise.all([
      api.get<string>(`/maps/${encodeURIComponent(name)}.svg`, { signal: controller.signal, responseType: 'text' }),
      api.get<MapMatch>(`/maps/${encodeURIComponent(name)}/match`, { signal: controller.signal, params }),
    ])
      .then(([svg, match]) => { setMap({ key: mapKey, svg: svg.data, match: match.data }); setError(''); })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        const detail = (e as { response?: { data?: { detail?: string } } }).response?.data?.detail;
        setError(detail ?? 'The network map could not be loaded.');
      });
    return () => controller.abort();
  }, [name, analysis, mapKey]);

  // The previous time's colours stay until the next time has arrived.
  useEffect(() => {
    if (!name) return;
    const controller = new AbortController();
    api.get<MapValues>(`/maps/${encodeURIComponent(name)}/values`, { signal: controller.signal, params: { scenario: scenarioId, t } })
      .then((response) => setValues({ map: name, data: response.data }))
      .catch(() => { if (!controller.signal.aborted) setError('The values of this time could not be loaded.'); });
    return () => controller.abort();
  }, [name, scenarioId, t]);

  const shownMap = map?.key === mapKey ? map : null;
  // Values of another map have another order; the previous time of the same map is kept while the next loads.
  const values = loaded?.map === name ? loaded.data : null;
  const drawing = useMemo(() => {
    if (!shownMap) return null;
    const svg = sanitize(shownMap.svg);
    return svg ? { svg, paints: prepare(svg, shownMap.match.layers, shownMap.match.elements.length) } : 'invalid' as const;
  }, [shownMap]);

  // Moves the drawing: one transform on one element, at most once per frame. translate3d keeps the drawing on its
  // own compositor layer, so moving costs no repaint and the browser redraws it sharp off the main thread after a
  // zoom. (Measured with 20,000 layers: switching will-change, a pointer-events rule or a :active cursor on the way
  // made the browser restyle every node, 50–120 ms per gesture.)
  const apply = () => {
    pending.current = 0;
    const canvas = host.current;
    if (!canvas) return;
    const { x, y, k } = view.current;
    canvas.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${k})`;
  };
  const move = (next: { x: number; y: number; k: number }) => {
    view.current = next;
    if (!pending.current) pending.current = requestAnimationFrame(apply);
  };
  const zoomAt = (px: number, py: number, factor: number) => {
    const v = view.current;
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * factor));
    move({ k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k });
  };
  const zoomCentre = (factor: number) => {
    const box = frame.current?.getBoundingClientRect();
    if (box) zoomAt(box.width / 2, box.height / 2, factor);
  };
  const fit = () => move({ x: 0, y: 0, k: 1 });

  useLayoutEffect(() => {
    const target = host.current;
    if (!target) return;
    target.replaceChildren();
    if (drawing && drawing !== 'invalid') target.appendChild(drawing.svg);
    view.current = { x: 0, y: 0, k: 1 };
    apply();
  }, [drawing]);

  // Colours of the current time: only the style of the collected shapes changes, the drawing stays.
  useEffect(() => {
    if (!drawing || drawing === 'invalid' || !values) return;
    const off = new Set(values.off);
    drawing.paints.forEach((paint, i) => {
      const colour = colourOf(values, i, colors, theme.mutedText);
      const dashed = off.has(i) ? '6 5' : '';
      const faint = values.m[i] === null || (values.v[i] === null && !off.has(i)) ? '0.45' : '';
      for (const shape of paint.strokes) { shape.style.stroke = colour; shape.style.strokeDasharray = dashed; }
      for (const shape of paint.fills) shape.style.fill = colour;
      for (const shape of paint.all) shape.style.opacity = faint;
    });
  }, [drawing, values, colors, theme.mutedText]);

  // Wheel and trackpad: smooth zoom around the pointer (a pinch arrives as wheel with ctrlKey, in small steps).
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = element.getBoundingClientRect();
      const step = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      zoomAt(event.clientX - box.left, event.clientY - box.top, Math.exp(-step * (event.ctrlKey ? 0.01 : 0.0015)));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
    // zoomAt only reads refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawing]);

  const indexAt = (target: EventTarget | null) => {
    const node = target instanceof Element ? target.closest('[data-index]') : null;
    return node ? Number(node.getAttribute('data-index')) : null;
  };
  const showTip = (event: ReactPointerEvent | null) => {
    const box = tip.current;
    if (!box) return;
    const i = event ? indexAt(event.target) : null;
    const area = frame.current?.getBoundingClientRect();
    if (i === null || !shownMap || !area || !event) { box.hidden = true; return; }
    const text = tooltip(shownMap.match, values, i);
    if (box.textContent !== text) box.textContent = text;
    box.style.transform = `translate(${event.clientX - area.left + 14}px, ${event.clientY - area.top + 14}px)`;
    box.hidden = false;
  };
  const onDown = (event: ReactPointerEvent) => {
    frame.current?.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const [a, b] = [...pointers.current.values()];
    gesture.current = { moved: false, distance: b ? Math.hypot(a.x - b.x, a.y - b.y) : 0 };
  };
  const onMove = (event: ReactPointerEvent) => {
    const last = pointers.current.get(event.pointerId);
    if (!last || !gesture.current) { showTip(event); return; }
    const now = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, now);
    if (pointers.current.size === 2) {  // two fingers: pinch around their middle
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const area = frame.current!.getBoundingClientRect();
      if (gesture.current.distance > 0) zoomAt((a.x + b.x) / 2 - area.left, (a.y + b.y) / 2 - area.top, distance / gesture.current.distance);
      gesture.current = { moved: true, distance };
      return;
    }
    const dx = now.x - last.x;
    const dy = now.y - last.y;
    if (!gesture.current.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    gesture.current.moved = true;
    showTip(null);
    move({ ...view.current, x: view.current.x + dx, y: view.current.y + dy });
  };
  const onUp = (event: ReactPointerEvent) => {
    pointers.current.delete(event.pointerId);
    const moved = gesture.current?.moved;
    if (pointers.current.size === 0) gesture.current = null;
    if (moved || !shownMap) return;
    const i = indexAt(event.target);
    if (i !== null && onPickAsset) onPickAsset(shownMap.match.elements[i][0]);
  };
  const onDoubleClick = (event: ReactMouseEvent) => {
    const area = frame.current?.getBoundingClientRect();
    if (area) zoomAt(event.clientX - area.left, event.clientY - area.top, event.shiftKey ? 1 / 2 : 2);
  };

  if (list && list.maps.length === 0) {
    return (
      <p className="across-card__hint">
        No network map. Export your Figma map as SVG (with “Include id attribute”) into {list.folder || 'the folder “maps” next to the database'}; the equipment layers go into a group named “Elements”.
      </p>
    );
  }
  const m = shownMap?.match;
  const l = LOADING_LIMITS;
  return (
    <div className="ab-map" aria-label="Network map">
      <div className="ab-chips">
        {list && list.maps.length > 1 && (
          <select className="ab-control" aria-label="Network map" value={name ?? ''} onChange={(e) => setChosen(e.target.value)}>
            {list.maps.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
          </select>
        )}
        <span className="ab-sub">Branches by loading:</span>
        {[[colors.bands.ok, `< ${l.warning} %`], [colors.bands.high, `${l.warning}–${l.overload} %`], [colors.bands.light, `${l.overload}–${l.clear} %`],
          [colors.bands.clear, `${l.clear}–${l.severe} %`], [colors.bands.severe, `≥ ${l.severe} %`]].map(([color, text]) => (
          <span key={text} className="ab-map__key"><i style={{ background: color }} />{text}</span>
        ))}
        <span className="ab-sub">Busbars: in band · close · outside; dashed = switched off</span>
        <button type="button" className="ab-chip" onClick={() => zoomCentre(1.5)} aria-label="Zoom in">+</button>
        <button type="button" className="ab-chip" onClick={() => zoomCentre(1 / 1.5)} aria-label="Zoom out">−</button>
        <button type="button" className="ab-chip" onClick={fit}>Fit</button>
      </div>
      {(error || drawing === 'invalid') && <div className="ab-empty" role="alert">{error || 'The map is not valid SVG.'}</div>}
      {!shownMap && !error && <div className="ab-empty" aria-busy>Loading network map …</div>}
      <div ref={frame} className="ab-map__frame" title="Wheel or pinch: zoom · drag: move · double-click: zoom in (Shift: out)"
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        onPointerLeave={() => showTip(null)} onDoubleClick={onDoubleClick}>
        <div ref={host} className="ab-map__canvas" />
        <div ref={tip} className="ab-map__tip" hidden />
      </div>
      {m && (m.unmatched_layers.length > 0 || m.ambiguous_layers.length > 0 || m.counts.elements_without_layer > 0 || m.repeated_layers.length > 0) && (
        <details className="ab-map__report">
          <summary className="ab-sub">
            {m.counts.matched} of {m.counts.layers} layers matched · {m.counts.elements_without_layer} elements of the analysis without a layer
          </summary>
          {m.unmatched_layers.length > 0 && <p className="ab-sub">Layers without element: {m.unmatched_layers.join(', ')}</p>}
          {m.ambiguous_layers.length > 0 && <p className="ab-sub">Names in several grids (name the layer “grid name”): {m.ambiguous_layers.join(', ')}</p>}
          {m.repeated_layers.length > 0 && <p className="ab-sub">Repeated layer names: {m.repeated_layers.join(', ')}</p>}
          {m.elements_without_layer.length > 0 && (
            <p className="ab-sub">Elements without layer: {m.elements_without_layer.map((e) => `${e.name} (${e.grid})`).join(', ')}
              {m.counts.elements_without_layer > m.elements_without_layer.length ? ' …' : ''}</p>
          )}
        </details>
      )}
    </div>
  );
}
