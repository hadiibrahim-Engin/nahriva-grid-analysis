import test from 'node:test';
import assert from 'node:assert/strict';
import { centredView, fittedBox, viewedBox, MapSpatialIndex, intersects } from '../mapViewport.ts';

test('native SVG viewport preserves aspect, pointer zoom and exact centred equipment coordinates',()=>{
  const extent={x:-40,y:-20,width:1200,height:800};
  const fit=fittedBox(extent,1500,500);
  assert.equal(fit.width/fit.height,3);
  assert.equal(fit.x+fit.width/2,extent.x+extent.width/2);
  const view=centredView(extent,1500,500,725,310,20);
  const box=viewedBox(extent,1500,500,view);
  assert.equal(box.x+box.width/2,725);
  assert.equal(box.y+box.height/2,310);
  const px=700,py=200,k=25;
  const next={k,x:px-(px-view.x)*k/view.k,y:py-(py-view.y)*k/view.k};
  const zoomed=viewedBox(extent,1500,500,next);
  assert.ok(Math.abs((box.x+px/1500*box.width)-(zoomed.x+px/1500*zoomed.width))<1e-9);
  assert.ok(Math.abs((box.y+py/500*box.height)-(zoomed.y+py/500*zoomed.height))<1e-9);
});

test('viewport index finds crossing long lines and boundary equipment without scanning 30,000 small items',()=>{
  const boxes=Array.from({length:30000},(_,i)=>({x:i%300*20,y:Math.floor(i/300)*20,width:8,height:4}));
  boxes.push({x:0,y:0,width:6000,height:2000});
  const index=new MapSpatialIndex(boxes,{x:0,y:0,width:6000,height:2000});
  for(const area of [{x:100,y:50,width:70,height:65},{x:0,y:0,width:0,height:0},{x:-300,y:-100,width:250,height:75},{x:-1000,y:-1000,width:12000,height:6000}]){
    const expected=boxes.flatMap((box,i)=>intersects(box,area)?[i]:[]).sort((a,b)=>a-b);
    assert.deepEqual([...index.query(area)].sort((a,b)=>a-b),expected);
  }
  assert.ok(index.query({x:100,y:50,width:70,height:65}).size<30);
});
