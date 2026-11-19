import test from 'node:test';
import assert from 'node:assert/strict';
import {costMagnitude,costHeatColour} from '../mapHeat.ts';

const colour=(v:number|null,scale=100)=>costHeatColour(v,scale,'#c94f55','#287f8d','#888888');
test('cost maps distinguish explicit zero from unavailable costs',()=>{
  assert.equal(colour(null),'#888888');
  assert.equal(colour(0),'#e8eef2');
  assert.equal(costMagnitude([null,undefined,NaN]),0);
});
test('cost maps use one signed magnitude across all scenarios, with saturation at its ends',()=>{
  const scale=costMagnitude([10,70,-100,null]);
  assert.equal(scale,100);
  assert.equal(colour(100,scale),'#c94f55');
  assert.equal(colour(-100,scale),'#287f8d');
  assert.equal(colour(1000,scale),'#c94f55');
  assert.notEqual(colour(10,scale),colour(70,scale));
});
