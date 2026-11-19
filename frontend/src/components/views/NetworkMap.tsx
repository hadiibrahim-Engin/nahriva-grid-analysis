import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import api from '../../api/client';
import { ASSESSMENT } from '../../config/assessment';
import { LOADING_LIMITS } from '../../config/loadingBands';
import { useAnalysis } from '../../hooks/useAnalysis';
import { useChartTheme } from '../../hooks/useChartTheme';
import { useGridFilter } from '../../hooks/useGridFilter';
import { readAcrossColors, type AcrossColors } from '../../util/acrossColors';
import { readParam, writeParam } from '../../util/shareLink';
import { costHeatColour, costMagnitude } from '../../util/mapHeat';
import { outlineEquipment, prepareHeatBackground } from '../../util/mapBackground';
import MapEquipmentHover from '../network/MapEquipmentHover';

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
  m: (0 | 1 | 2 | null)[];
  v: (number | null)[];
  r: (number | null)[];
  lo: (number | null)[];
  up: (number | null)[];
  off: number[];
}
/** Keep the original drawing separate from the result background. */
interface Paint { strokes: SVGElement[]; dashes: string[]; all: SVGElement[]; opacity: string[]; heat: SVGGElement | null }

const SHAPES = 'path,line,polyline,polygon,rect,circle,ellipse';
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
  const paints: Paint[] = Array.from({ length: count }, () => ({ strokes: [], dashes: [], all: [], opacity: [], heat: null }));
  for (const node of Array.from(svg.querySelectorAll<SVGElement>('[id]'))) {
    const index = layers[node.id];
    if (index === undefined) continue;
    node.setAttribute('data-index', String(index));
    const paint = paints[index];
    for (const shape of node.matches(SHAPES) ? [node] : Array.from(node.querySelectorAll<SVGElement>(SHAPES))) {
      const stroke = shape.getAttribute('stroke');
      paint.all.push(shape);
      paint.opacity.push(shape.style.opacity);
      if (stroke && stroke !== 'none') { paint.strokes.push(shape); paint.dashes.push(shape.style.strokeDasharray); }
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
  if (values.m[i] === 2) return colors.lodf;
  const lower = values.lo[i] ?? ASSESSMENT.voltageBandPu.lower;
  const upper = values.up[i] ?? ASSESSMENT.voltageBandPu.upper;
  if (v < lower || v > upper) return colors.bands.severe;
  return v < lower + ASSESSMENT.voltageMarginPu || v > upper - ASSESSMENT.voltageMarginPu ? colors.bands.high : colors.bands.ok;
}

/**
 * The network map at one time: original SVG colours preserve voltage levels; a separate background shows
 * results (branches by loading, busbars by voltage). Hover shows the value, click opens the element in the
 * asset view. Built for large maps: the drawing is inserted once, a new time only changes colours, and zooming and
 * panning move one GPU layer without rendering React.
 */
export default function NetworkMap({ scenarioId, t, onPickAsset, selectedElementId, onElementsLoaded, mode='results', costs, costScale, dataRevision='' }: {
  scenarioId: string;
  t: number;
  onPickAsset?: (elementId: string) => void;
  selectedElementId?: string | null;
  onElementsLoaded?: (elements: MapMatch['elements']) => void;
  mode?: 'results' | 'redispatch';
  costs?: { element_id: string; cost_eur: number | null }[];
  costScale?: number;
  dataRevision?: string;
}) {
  const { analysis } = useAnalysis();
  const { grid, kv } = useGridFilter();
  const theme = useChartTheme();
  const colors = useMemo(() => readAcrossColors(theme.isLight), [theme.isLight]);
  const [list, setList] = useState<{ folder: string; maps: MapInfo[] } | null>(null);
  const [chosen, setChosen] = useState<string | null>(()=>readParam('map'));
  const [mapRevision,setMapRevision]=useState(0);
  const [listError,setListError]=useState('');
  const [map, setMap] = useState<{ key: string; svg: string; match: MapMatch } | null>(null);
  const [loaded, setValues] = useState<{ map: string; data: MapValues } | null>(null);
  const [error, setError] = useState('');
  const [contrast,setContrast]=useState(()=>readParam('contrast')==='strong'?'strong':'normal');
  const [hovered,setHovered]=useState<{mapKey:string;index:number}|null>(null);
  const host = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const lastPointer=useRef({x:0,y:0});
  const hideTimer=useRef(0);
  const hoverKey=useRef('');
  const view = useRef({ x: 0, y: 0, k: 1 });
  const pending = useRef(0);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ moved: boolean; distance: number } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api.get<{ folder: string; maps: MapInfo[] }>('/maps', { signal: controller.signal })
      .then((response) => {setList(response.data);setListError('');})
      .catch(() => { if (!controller.signal.aborted) setListError('Der Kartenordner konnte nicht gelesen werden. Bitte erneut laden.'); });
    return () => controller.abort();
  }, [mapRevision]);
  const name = list?.maps.some(m=>m.name===chosen)?chosen:list?.maps[0]?.name ?? null;
  const mapKey = `${name}|${analysis}|${mapRevision}`;
  const hoveredIndex=hovered?.mapKey===mapKey?hovered.index:null;
  const costsById=useMemo(()=>new Map(costs?.map(c=>[c.element_id,c.cost_eur])??[]),[costs]);
  const maxCost=costScale??costMagnitude(costs?.map(c=>c.cost_eur)??[]);

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
      .then((response) => setValues({ map: mapKey, data: response.data }))
      .catch(() => { if (!controller.signal.aborted) setError('The values of this time could not be loaded.'); });
    return () => controller.abort();
  }, [name, scenarioId, t, mapKey]);

  const shownMap = map?.key === mapKey ? map : null;
  // Values of another map have another order; the previous time of the same map is kept while the next loads.
  const values = loaded?.map === mapKey ? loaded.data : null;
  const drawing = useMemo(() => {
    if (!shownMap) return null;
    const svg = sanitize(shownMap.svg);
    return svg ? { svg, paints: prepare(svg, shownMap.match.layers, shownMap.match.elements.length) } : 'invalid' as const;
  }, [shownMap]);
  useEffect(()=>{ if(shownMap) onElementsLoaded?.(shownMap.match.elements); },[shownMap,onElementsLoaded]);

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
    if (drawing && drawing !== 'invalid') {
      target.appendChild(drawing.svg);
      prepareHeatBackground(drawing.svg, drawing.paints);
    }
    view.current = { x: 0, y: 0, k: 1 };
    apply();
  }, [drawing]);

  // Only the background changes colour. The SVG's line/fill colours retain their original meaning.
  useEffect(() => {
    if (!drawing || drawing === 'invalid' || !values) return;
    const off = new Set(values.off);
    const elements = shownMap?.match.elements ?? [];
    drawing.paints.forEach((paint, i) => {
      // Filters dim the original drawing without replacing its voltage-level colours.
      const [, , elementGrid, elementKv] = elements[i] ?? [];
      const outside = (grid !== null && elementGrid !== grid) || (kv !== null && elementKv !== kv);
      const cost = costsById.get(elements[i]?.[0]);
      const isPlant=['ElmSym','ElmGenstat','ElmPvsys'].includes(elements[i]?.[4]??'');
      const colour = mode==='redispatch'
        ? costHeatColour(cost,maxCost,colors.bands.severe,colors.neg,theme.mutedText)
        : colourOf(values, i, colors, theme.mutedText);
      const hasHeat = !outside && !off.has(i) && (mode==='redispatch'
        ? isPlant && cost != null : values.v[i] != null && (values.m[i]===0 || values.m[i]===1));
      if (paint.heat) {
        paint.heat.style.color = colour;
        paint.heat.style.display = hasHeat ? '' : 'none';
        const value=values.v[i];
        const critical=value!=null&&(values.m[i]===0 ? value>=LOADING_LIMITS.warning
          : values.m[i]===1 && (value<(values.lo[i]??ASSESSMENT.voltageBandPu.lower)+ASSESSMENT.voltageMarginPu || value>(values.up[i]??ASSESSMENT.voltageBandPu.upper)-ASSESSMENT.voltageMarginPu));
        paint.heat.style.opacity=mode==='redispatch'
          ? contrast==='normal'?'0.35':'0.52'
          : critical ? contrast==='normal'?'0.32':'0.50' : contrast==='normal'?'0.16':'0.26';
      }
      paint.strokes.forEach((shape,j) => { shape.style.strokeDasharray = off.has(i) ? '6 5' : paint.dashes[j]; });
      paint.all.forEach((shape,j) => { shape.style.opacity = outside ? '0.18' : paint.opacity[j]; });
    });
  }, [drawing, values, colors, theme.mutedText, grid, kv, shownMap,mode,costsById,maxCost,contrast]);

  useEffect(()=>{
    if(!drawing||drawing==='invalid'||!shownMap)return;
    const i=shownMap.match.elements.findIndex(e=>e[0]===selectedElementId);
    outlineEquipment(drawing.svg,i>=0?drawing.paints[i]?.heat:null,'selected');
  },[drawing,shownMap,selectedElementId]);

  useEffect(()=>{
    if(drawing&&drawing!=='invalid')outlineEquipment(drawing.svg,hoveredIndex==null?null:drawing.paints[hoveredIndex]?.heat,'hover');
  },[drawing,hoveredIndex]);

  useEffect(()=>{
    if(!drawing||drawing==='invalid'||!shownMap)return;
    drawing.svg.querySelector('[data-cost-labels]')?.remove();
    if(!costs||mode!=='redispatch')return;
    const group=document.createElementNS('http://www.w3.org/2000/svg','g');group.setAttribute('data-cost-labels','true');
    for(const item of costs){
      const i=shownMap.match.elements.findIndex(e=>e[0]===item.element_id);
      const node=drawing.svg.querySelector<SVGGraphicsElement>(`[data-index="${i}"]:not([data-map-hit])`);
      if(!node)continue;
      const box=node.getBBox();const label=document.createElementNS('http://www.w3.org/2000/svg','text');
      const rootMatrix=drawing.svg.getCTM();const matrix=node.getCTM();
      const point=new DOMPoint(box.x+box.width/2,box.y+box.height);
      const position=rootMatrix&&matrix?point.matrixTransform(rootMatrix.inverse().multiply(matrix)):point;
      label.setAttribute('x',String(position.x));label.setAttribute('y',String(position.y+15));
      label.setAttribute('text-anchor','middle');label.setAttribute('class','ab-map__cost-label');label.setAttribute('data-index',String(i));
      label.textContent=item.cost_eur===null?'RD —':`${item.cost_eur.toLocaleString('de-DE',{maximumFractionDigits:2})} €`;
      group.append(label);
    }
    drawing.svg.append(group);
    return ()=>group.remove();
  },[drawing,shownMap,costs,mode]);

  // Wheel and trackpad: smooth zoom around the pointer (a pinch arrives as wheel with ctrlKey, in small steps).
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if(event.target instanceof Element&&event.target.closest('.ab-map__hover'))return;
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
  const positionTip=()=>{
    const box=tip.current; const area=frame.current?.getBoundingClientRect();
    if(!box||!area||box.hidden)return;
    box.style.maxWidth=`${Math.max(0,area.width-24)}px`;
    box.style.maxHeight=`${Math.max(0,Math.min(520,area.height-24))}px`;
    const {x,y}=lastPointer.current;
    const px=x-area.left,py=y-area.top;
    const left=px+18+box.offsetWidth<area.width?px+18:px-box.offsetWidth-18;
    const top=py+18+box.offsetHeight<area.height?py+18:py-box.offsetHeight-18;
    box.style.transform=`translate(${Math.max(12,Math.min(area.width-box.offsetWidth-12,left))}px,${Math.max(12,Math.min(area.height-box.offsetHeight-12,top))}px)`;
  };
  useLayoutEffect(()=>{
    positionTip();
    const observer=new ResizeObserver(positionTip);
    if(tip.current)observer.observe(tip.current);
    if(frame.current)observer.observe(frame.current);
    return ()=>observer.disconnect();
  },[hoveredIndex,drawing]);
  useEffect(()=>()=>window.clearTimeout(hideTimer.current),[]);
  const keepTip=()=>{window.clearTimeout(hideTimer.current);hideTimer.current=0;};
  const hideTip=()=>{
    if(hideTimer.current)return;
    hideTimer.current=window.setTimeout(()=>{
      hideTimer.current=0;
      if(tip.current?.contains(document.activeElement))return;
      hoverKey.current='';setHovered(null);
    },250);
  };
  const closeTip=()=>{keepTip();hoverKey.current='';setHovered(null);};
  const openTip=(i:number,x:number,y:number)=>{
    keepTip();
    lastPointer.current={x,y};
    const key=`${mapKey}|${i}`;
    if(hoverKey.current!==key){hoverKey.current=key;setHovered({mapKey,index:i});}
    positionTip();
  };
  const showTip = (event: ReactPointerEvent | null) => {
    if(event?.target instanceof Element&&event.target.closest('.ab-map__hover'))return;
    const i = event ? indexAt(event.target) : null;
    if(i===null||!shownMap||!event){hideTip();return;}
    openTip(i,event.clientX,event.clientY);
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
    closeTip();
    move({ ...view.current, x: view.current.x + dx, y: view.current.y + dy });
  };
  const onUp = (event: ReactPointerEvent) => {
    pointers.current.delete(event.pointerId);
    const moved = gesture.current?.moved;
    if (pointers.current.size === 0) gesture.current = null;
    if (event.type === 'pointercancel' || moved || !shownMap) return;
    // Pointer capture sends pointerup to the frame; hit-test the SVG underneath the release position.
    const i = indexAt(document.elementFromPoint(event.clientX, event.clientY));
    if (i !== null) { onPickAsset?.(shownMap.match.elements[i][0]);openTip(i,event.clientX,event.clientY); }
  };
  const onDoubleClick = (event: ReactMouseEvent) => {
    const area = frame.current?.getBoundingClientRect();
    if (area) zoomAt(event.clientX - area.left, event.clientY - area.top, event.shiftKey ? 1 / 2 : 2);
  };

  const mapFiles=<details className="ab-map__files">
    <summary>Karten hinzufügen / Speicherort</summary>
    <p>Aktiver Kartenordner: <code>{list?.folder??'wird geladen …'}</code></p>
    <ol><li>Netzplan in Figma als SVG mit „Include id attribute“ exportieren.</li>
      <li>Die SVG-Datei in diesen Ordner kopieren, zum Beispiel <code>nord.svg</code>. Mehrere Karten können nebeneinander liegen.</li>
      <li>„Karten neu laden“ klicken und oben die Karte auswählen. Der Server muss nicht neu gestartet werden.</li></ol>
    <p>Eine Ebene pro Betriebsmittel in der Gruppe „Elements“, benannt wie in PowerFactory. Kraftwerke können in einer Gruppe „Generators“ liegen. Ein neues SVG liefert die Zeichnung; Ergebniswerte kommen aus der gewählten Analyse.</p>
    <p>Zusätzlich zur SVG: Ergebnisdatenbank mit Stammdaten, Szenarien und Zeitreihen (bei Parquet-Speicherung auch der zugehörige <code>.values</code>-Ordner). Für Redispatch: Stunden-CSV mit Szenario-ID, Kraftwerk-ID, UTC-Intervall, MWh und €/MWh. Eine separate Zuordnungsdatei ist bei passenden SVG-Ebenennamen nicht nötig.</p>
    <button type="button" className="ab-chip" onClick={()=>setMapRevision(n=>n+1)}>Karten neu laden</button>
    {listError&&<p role="alert">{listError}</p>}
  </details>;

  if (list && list.maps.length === 0) {
    return (
      <div className="ab-map"><p className="across-card__hint">Noch keine SVG-Karte im Kartenordner.</p>{mapFiles}</div>
    );
  }
  const m = shownMap?.match;
  const l = LOADING_LIMITS;
  return (
    <div className="ab-map" aria-label="Network map">
      <div className="ab-chips">
        {list && list.maps.length > 0 && (
          <label className="ab-map__select">Karte <select className="ab-control" aria-label="Netzkarte auswählen" value={name ?? ''} onChange={(e) => {setChosen(e.target.value);writeParam('map',e.target.value);}}>
            {list.maps.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
          </select></label>
        )}
        <span className="ab-sub">Linienfarben = Spannungsebene · Heatmap im Hintergrund</span>
        <label className="ab-map__contrast">Heatmap-Kontrast <select className="ab-control" aria-label="Heatmap-Kontrast" value={contrast} onChange={e=>{setContrast(e.target.value);writeParam('contrast',e.target.value);}}><option value="strong">Stark</option><option value="normal">Dezent</option></select></label>
        {mode==='results'?<><span className="ab-sub">Hintergrund Auslastung:</span>
        {[[colors.bands.ok, `< ${l.warning} %`], [colors.bands.high, `${l.warning}–${l.overload} %`], [colors.bands.light, `${l.overload}–${l.clear} %`],
          [colors.bands.clear, `${l.clear}–${l.severe} %`], [colors.bands.severe, `≥ ${l.severe} %`]].map(([color, text]) => (
          <span key={text} className="ab-map__key"><i style={{ background: color }} />{text}</span>
        ))}
        <span className="ab-sub">Sammelschienen: Spannungsband · gestrichelt = abgeschaltet</span></>:<>
          <span className="ab-map__cost-scale" aria-label={`Kostenskala von minus bis plus ${maxCost.toLocaleString('de-DE')} Euro je Stunde`}>
            <span>−{maxCost.toLocaleString('de-DE',{maximumFractionDigits:2})} €</span>
            <i style={{background:`linear-gradient(to right, ${colors.neg}, #e8eef2, ${colors.bands.severe})`}}/>
            <span>+{maxCost.toLocaleString('de-DE',{maximumFractionDigits:2})} € / h</span>
          </span>
          <span className="ab-sub">Kraftwerk-Hintergrund nach Kostenbetrag · gleiche Skala für alle Szenarien dieser Stunde · ohne Hintergrund = keine Kostendaten</span>
        </>}
        <button type="button" className="ab-chip" onClick={() => zoomCentre(1.5)} aria-label="Zoom in">+</button>
        <button type="button" className="ab-chip" onClick={() => zoomCentre(1 / 1.5)} aria-label="Zoom out">−</button>
        <button type="button" className="ab-chip" onClick={fit}>Fit</button>
      </div>
      {mapFiles}
      {(error || drawing === 'invalid') && <div className="ab-empty" role="alert">{error || 'The map is not valid SVG.'}</div>}
      {!shownMap && !error && <div className="ab-empty" aria-busy>Loading network map …</div>}
      <div ref={frame} className="ab-map__frame" title="Wheel or pinch: zoom · drag: move · double-click: zoom in (Shift: out)"
        onPointerDown={onDown} onPointerMove={onMove} onPointerOver={event=>{if(!pointers.current.size)showTip(event);}} onPointerUp={onUp} onPointerCancel={onUp}
        onPointerLeave={() => showTip(null)} onDoubleClick={onDoubleClick}>
        <div ref={host} className="ab-map__canvas" />
        <div ref={tip} className="ab-map__hover" hidden={hoveredIndex===null} role="region" aria-label="Stundenvergleich beim Hover" tabIndex={0}
          onPointerEnter={keepTip} onPointerLeave={hideTip} onFocus={keepTip} onBlur={hideTip}
          onPointerDown={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()}
          onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();closeTip();}}}>
          {hoveredIndex!==null&&shownMap&&<MapEquipmentHover analysis={analysis} t={t} elementId={shownMap.match.elements[hoveredIndex][0]}
            name={shownMap.match.elements[hoveredIndex][1]} scenarioId={scenarioId} revision={`${mapRevision}|${dataRevision}`}/>}
        </div>
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
