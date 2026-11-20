import { centredView, MapSpatialIndex, viewedBox, type MapBox, type MapView } from './mapViewport';

export interface ViewportPaint {
  nodes:SVGGraphicsElement[]; all:SVGElement[]; heat:SVGGElement|null; hit:SVGGElement|null;
  visible:boolean;
}

function bounds(node:SVGGraphicsElement,inverse:DOMMatrix):MapBox {
  const box=node.getBBox(),matrix=node.getCTM();
  if(!matrix)return {x:box.x,y:box.y,width:box.width,height:box.height};
  const transform=inverse.multiply(matrix);
  // Transform the two edge vectors once. Their signed extents include all four corners,
  // including rotated, sheared and mirrored equipment.
  const {a, b, c, d, e, f} = transform;
  const dx = a * box.width, dy = b * box.width;
  const ex = c * box.height, ey = d * box.height;
  return {
    x: a * box.x + c * box.y + e + Math.min(0, dx) + Math.min(0, ex),
    y: b * box.x + d * box.y + f + Math.min(0, dy) + Math.min(0, ey),
    width: Math.abs(dx) + Math.abs(ex), height: Math.abs(dy) + Math.abs(ey),
  };
}

/** Keep the complete imported drawing, but paint/hit-test only equipment intersecting the viewBox. */
export class SvgMapViewport<P extends ViewportPaint = ViewportPaint> {
  readonly extent:MapBox;
  readonly boxes:MapBox[];
  visible=new Set<number>();
  overview=false;
  private index:MapSpatialIndex;
  private labels:{node:SVGGraphicsElement;box:MapBox;font:number;display:string}[];
  private labelIndex:MapSpatialIndex;
  private visibleLabels=new Set<number>();
  private displays:string[][];
  private aspect:string|null;
  readonly svg:SVGSVGElement;
  readonly paints:P[];
  constructor(svg:SVGSVGElement,paints:P[]) {
    this.svg=svg;this.paints=paints;
    this.aspect=svg.getAttribute('preserveAspectRatio');
    const base=svg.viewBox.baseVal;
    this.extent={x:base.x,y:base.y,width:base.width||100,height:base.height||100};
    const root=svg.getCTM()?.inverse()??new DOMMatrix();
    this.boxes=paints.map(paint=>{
      if (paint.nodes.length === 1) return bounds(paint.nodes[0], root);
      const boxes=paint.nodes.map(node=>bounds(node,root));
      if(!boxes.length)return {x:0,y:0,width:0,height:0};
      const x=Math.min(...boxes.map(b=>b.x)),y=Math.min(...boxes.map(b=>b.y));
      return {x,y,width:Math.max(...boxes.map(b=>b.x+b.width))-x,height:Math.max(...boxes.map(b=>b.y+b.height))-y};
    });
    this.index=new MapSpatialIndex(this.boxes,this.extent);
    this.displays=paints.map(p=>p.nodes.map(node=>node.style.display));
    // Measure before any visibility writes; otherwise getBBox/getCTM would repeatedly force layout.
    this.labels=Array.from(svg.querySelectorAll<SVGGraphicsElement>('text')).filter(node=>!node.closest('[data-index]'))
      .map(node=>({node,box:bounds(node,root),font:parseFloat(getComputedStyle(node).fontSize)||12,display:node.style.display}));
    this.labelIndex=new MapSpatialIndex(this.labels.map(l=>l.box),this.extent);
    for(const paint of paints){paint.visible=false;for(const node of paint.nodes)node.style.display='none';if(paint.hit)paint.hit.style.display='none';}
    for(const label of this.labels)label.node.style.display='none';
    svg.setAttribute('preserveAspectRatio','none');
  }
  detail(width:number,height:number,index?:number):MapView {
    if(index==null&&this.paints.length>2000){
      index=Math.floor(this.boxes.length/2);
    }
    const box=index==null?this.extent:this.boxes[index]??this.extent;
    const k=this.paints.length>2000?Math.min(40,Math.sqrt(this.paints.length/70)):1;
    return centredView(this.extent,width,height,box.x+box.width/2,box.y+box.height/2,k);
  }
  reframe(width:number,height:number,k:number):MapView {
    const box=this.svg.viewBox.baseVal;
    return centredView(this.extent,width,height,box.x+box.width/2,box.y+box.height/2,k);
  }
  update(view:MapView,width:number,height:number):boolean {
    if(width<=0||height<=0)return false;
    const box=viewedBox(this.extent,width,height,view);
    this.svg.setAttribute('viewBox',`${box.x} ${box.y} ${box.width} ${box.height}`);
    const padded={x:box.x-box.width*.03,y:box.y-box.height*.03,width:box.width*1.06,height:box.height*1.06};
    const next=this.index.query(padded);
    const overview=next.size>2000;
    let changed=this.overview!==overview||next.size!==this.visible.size;
    for(const i of this.visible)if(!next.has(i)){
      const paint=this.paints[i];paint.visible=false;
      for(const node of paint.nodes)node.style.display='none';
      if(paint.heat)paint.heat.style.display='none';
      if(paint.hit)paint.hit.style.display='none';
      changed=true;
    }
    for(const i of next){
      const paint=this.paints[i];
      if(!this.visible.has(i)){
        paint.visible=true;paint.nodes.forEach((node,j)=>{node.style.display=this.displays[i][j];});changed=true;
      }
      if(paint.hit&&(this.overview!==overview||!this.visible.has(i)))paint.hit.style.display=overview?'none':'';
    }
    const labels=this.labelIndex.query(padded),scale=width/box.width;
    for(const i of labels)if(this.labels[i].font*scale<7)labels.delete(i);
    for(const i of this.visibleLabels)if(!labels.has(i))this.labels[i].node.style.display='none';
    for(const i of labels)if(!this.visibleLabels.has(i))this.labels[i].node.style.display=this.labels[i].display;
    this.visibleLabels=labels;this.visible=next;this.overview=overview;
    return changed;
  }
  dispose():void {
    this.svg.setAttribute('viewBox',`${this.extent.x} ${this.extent.y} ${this.extent.width} ${this.extent.height}`);
    if(this.aspect==null)this.svg.removeAttribute('preserveAspectRatio');else this.svg.setAttribute('preserveAspectRatio',this.aspect);
    this.paints.forEach((paint,i)=>paint.nodes.forEach((node,j)=>{node.style.display=this.displays[i][j];}));
    for(const label of this.labels)label.node.style.display=label.display;
  }
}
