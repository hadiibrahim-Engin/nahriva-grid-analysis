const HEAT_EXTRA_WIDTH = 12;

/** A single result layer below all equipment, above the SVG's own background.
 * Geometry is copied once; native voltage colours, labels and hit targets stay untouched.
 */
export function prepareHeatBackground(svg: SVGSVGElement, paints: { all: SVGElement[]; heat: SVGGElement | null }[]): void {
  const shapes = paints.flatMap(paint => paint.all);
  if (!shapes.length) return;
  let parent: Element = shapes[0].parentElement ?? svg;
  while (!shapes.every(shape => parent.contains(shape)) && parent.parentElement) parent = parent.parentElement;
  const ns = 'http://www.w3.org/2000/svg';
  const background = document.createElementNS(ns, 'g');
  background.setAttribute('data-heat-background', 'true');
  background.setAttribute('aria-hidden', 'true');
  background.style.pointerEvents = 'none';
  // Insert before the equipment-containing child, after any preceding solid background.
  const before = Array.from(parent.children).find(child => shapes.some(shape => child === shape || child.contains(shape)));
  parent.insertBefore(background, before ?? null);
  const base = background.getCTM();
  if (!base) { background.remove(); return; }
  const inverse = base.inverse();
  const hits=document.createElementNS(ns,'g');
  hits.setAttribute('data-map-hit-targets','true');
  hits.setAttribute('aria-hidden','true');
  parent.insertBefore(hits,background.nextSibling);
  for (const [index,paint] of paints.entries()) {
    const group = document.createElementNS(ns, 'g');
    const hitGroup=document.createElementNS(ns,'g');
    hitGroup.setAttribute('data-index',String(index));
    hitGroup.setAttribute('data-map-hit','true');
    group.style.display = 'none';
    for (const shape of paint.all) {
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
      const hit=clone.cloneNode(false) as SVGElement;
      hit.style.stroke='transparent';
      hit.style.strokeWidth=String(width+10);
      hit.style.pointerEvents='stroke';
      hitGroup.append(hit);
    }
    // Group opacity prevents intersections within an equipment symbol from getting darker.
    group.style.opacity = '0.22';
    background.append(group);
    hits.append(hitGroup);
    paint.heat = group;
  }
}

/** White separation plus a dark/blue contour makes hover/selection visible without recolouring the SVG. */
export function outlineEquipment(svg:SVGSVGElement, heat:SVGGElement|null, kind:'hover'|'selected'):void {
  svg.querySelector(`[data-equipment-outline="${kind}"]`)?.remove();
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
}
