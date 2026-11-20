/** World-coordinate viewport math and a bounded grid index. No CSS scaling of a rasterised SVG layer. */
export interface MapBox { x:number; y:number; width:number; height:number }
export interface MapView { x:number; y:number; k:number }
export const intersects=(a:MapBox,b:MapBox)=>a.x<=b.x+b.width&&a.x+a.width>=b.x&&a.y<=b.y+b.height&&a.y+a.height>=b.y;

export function fittedBox(box:MapBox,width:number,height:number):MapBox {
  const scale=Math.min(width/box.width,height/box.height)||1;
  return {x:box.x-(width/scale-box.width)/2,y:box.y-(height/scale-box.height)/2,width:width/scale,height:height/scale};
}
export function viewedBox(box:MapBox,width:number,height:number,view:MapView):MapBox {
  const fit=fittedBox(box,width,height),scale=width/fit.width;
  return {x:fit.x-view.x/(scale*view.k),y:fit.y-view.y/(scale*view.k),width:fit.width/view.k,height:fit.height/view.k};
}
export function centredView(box:MapBox,width:number,height:number,x:number,y:number,k:number):MapView {
  const fit=fittedBox(box,width,height),scale=width/fit.width;
  return {k,x:width/2-(x-fit.x)*scale*k,y:height/2-(y-fit.y)*scale*k};
}

/** Very long edges are kept separately, rather than expanding into thousands of grid cells. */
export class MapSpatialIndex {
  private cells=new Map<string,number[]>();
  private large:number[]=[];
  private size:number;
  private boxes:readonly MapBox[];
  constructor(boxes:readonly MapBox[],extent:MapBox) {
    this.boxes=boxes;
    this.size=Math.max(extent.width,extent.height)/64||1;
    boxes.forEach((box,i)=>{
      const [x0,y0,x1,y1]=this.range(box);
      if((x1-x0+1)*(y1-y0+1)>64){this.large.push(i);return;}
      for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++){
        const key=`${x},${y}`,items=this.cells.get(key);
        if(items)items.push(i);else this.cells.set(key,[i]);
      }
    });
  }
  private range(box:MapBox){return [Math.floor(box.x/this.size),Math.floor(box.y/this.size),Math.floor((box.x+box.width)/this.size),Math.floor((box.y+box.height)/this.size)];}
  query(box:MapBox):Set<number> {
    const result=new Set<number>(),[x0,y0,x1,y1]=this.range(box);
    if((x1-x0+1)*(y1-y0+1)>16_384){this.boxes.forEach((item,i)=>{if(intersects(item,box))result.add(i);});return result;}
    for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++)for(const i of this.cells.get(`${x},${y}`)??[])if(intersects(this.boxes[i],box))result.add(i);
    for(const i of this.large)if(intersects(this.boxes[i],box))result.add(i);
    return result;
  }
}
