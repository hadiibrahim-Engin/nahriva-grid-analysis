const HEAT_EXTRA_WIDTH = 12;
type OutlineKind = 'hover' | 'selected';
const outlines = new WeakMap<SVGSVGElement, Partial<Record<OutlineKind, SVGGElement>>>();

export function clearMapBackground(svg:SVGSVGElement,paints:{heat:SVGGElement|null;hit:SVGGElement|null}[]):void {
  svg.querySelectorAll('[data-heat-background],[data-map-hit-targets],[data-equipment-outline],[data-cost-labels]').forEach(node=>node.remove());
  outlines.delete(svg);
  for(const paint of paints){paint.heat=null;paint.hit=null;}
}

/** A single result layer below all equipment, above the SVG's own background.
 * Geometry is copied once; native voltage colours, labels and hit targets stay untouched.
 */
export function prepareHeatBackground(svg: SVGSVGElement, paints: { all: SVGElement[]; heat: SVGGElement | null; hit:SVGGElement|null }[]): {ensure:(indices:Iterable<number>,interactive?:boolean)=>void} {
  const shapes = paints.flatMap(paint => paint.all);
  if (!shapes.length) return {ensure:()=>undefined};
  let parent: Element = shapes[0].parentElement ?? svg;
  while (!shapes.every(shape => parent.contains(shape)) && parent.parentElement) parent = parent.parentElement;
  const ns = 'http://www.w3.org/2000/svg';
  const background = document.createElementNS(ns, 'g');
  background.setAttribute('data-heat-background', 'true');
  background.setAttribute('aria-hidden', 'true');
  background.style.pointerEvents = 'none';
  // Insert before the equipment-containing child, after any preceding solid background.
  let before = parent.firstElementChild;
  if (before && !before.contains(shapes[0])) {
    const equipmentChildren = new Set<Element>();
    for (const shape of shapes) {
      let child: Element = shape;
      while (child.parentElement && child.parentElement !== parent) child = child.parentElement;
      equipmentChildren.add(child);
    }
    while (before && !equipmentChildren.has(before)) before = before.nextElementSibling;
  }
  parent.insertBefore(background, before);
  const hits=document.createElementNS(ns,'g');
  hits.setAttribute('data-map-hit-targets','true');
  hits.setAttribute('aria-hidden','true');
  parent.insertBefore(hits,background.nextSibling);
  // Create geometry on demand for the viewport, not two full copies of every equipment on initial load.
  const ensure=(indices:Iterable<number>,interactive=true)=>{
  const base=background.getCTM();if(!base)return;
  const inverse=base.inverse();
  const heatFragment=document.createDocumentFragment();
  const hitFragment=document.createDocumentFragment();
  for (const index of indices) {
    const paint=paints[index];if(!paint)continue;
    if(paint.heat&&(!interactive||paint.hit))continue;
    const group = document.createElementNS(ns, 'g');
    group.style.display = 'none';
    if(!paint.heat)for (const shape of paint.all) {
      if (!(shape instanceof SVGGraphicsElement)) continue;
      const matrix = shape.getCTM();
      if (!matrix) continue;
      const width = Number.parseFloat(getComputedStyle(shape).strokeWidth) || 2;
      const clone = shape.cloneNode(false) as SVGElement;
      for (const attribute of Array.from(clone.attributes)) {
        if (['id', 'class', 'style', 'transform', 'filter', 'mask', 'clip-path'].includes(attribute.name) || attribute.name.startsWith('data-')) clone.removeAttribute(attribute.name);
      }
      const m = inverse.multiply(matrix);
      clone.setAttribute('transform', `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`);
      clone.style.fill = 'none';
      clone.style.stroke = 'currentColor';
      clone.style.strokeWidth = String(width + HEAT_EXTRA_WIDTH);
      clone.style.strokeOpacity = '1';
      clone.style.strokeDasharray = 'none';
      clone.style.strokeLinecap = 'round';
      clone.style.strokeLinejoin = 'round';
      clone.style.opacity = '1';
      group.append(clone);
    }
    if(!paint.heat){
      group.style.opacity = '0.22';heatFragment.append(group);paint.heat=group;
    }
    if(interactive&&!paint.hit){
      const hitGroup=document.createElementNS(ns,'g');
      hitGroup.setAttribute('data-index',String(index));hitGroup.setAttribute('data-map-hit','true');
      for(const source of Array.from(paint.heat.children)){
        const hit=source.cloneNode(false) as SVGElement;
        hit.style.stroke='transparent';
        hit.style.strokeWidth=String(parseFloat((source as SVGElement).style.strokeWidth)-HEAT_EXTRA_WIDTH+10);
        hit.style.pointerEvents='stroke';hitGroup.append(hit);
      }
      hitFragment.append(hitGroup);paint.hit=hitGroup;
    }
  }
  background.append(heatFragment);
  hits.append(hitFragment);
  };
  return {ensure};
}

/** White separation plus a dark/blue contour makes hover/selection visible without recolouring the SVG. */
export function outlineEquipment(svg:SVGSVGElement, heat:SVGGElement|null, kind:OutlineKind):void {
  const current = outlines.get(svg) ?? {};
  current[kind]?.remove();
  delete current[kind];
  if(!heat)return;
  const outline=document.createElementNS('http://www.w3.org/2000/svg','g');
  outline.setAttribute('data-equipment-outline',kind);
  outline.setAttribute('aria-hidden','true');
  outline.style.pointerEvents='none';
  outline.style.opacity=kind==='hover'?'0.65':'0.85';
  for(const [colour,extra] of [['#ffffff',6],[kind==='hover'?'#172e43':'#2563eb',3]] as const){
    for(const source of Array.from(heat.children)){
      const clone=source.cloneNode(false) as SVGElement;
      clone.style.stroke=colour;
      clone.style.strokeWidth=String(Math.max(1,parseFloat((source as SVGElement).style.strokeWidth)-HEAT_EXTRA_WIDTH+extra));
      outline.append(clone);
    }
  }
  heat.parentNode?.appendChild(outline);
  current[kind] = outline;
  outlines.set(svg, current);
}
