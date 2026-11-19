/** A shared signed cost scale keeps colours comparable when switching scenarios at the same hour. */
export function costMagnitude(values: readonly (number | null | undefined)[]): number {
  return values.reduce<number>((max,value)=>typeof value==='number'&&Number.isFinite(value)?Math.max(max,Math.abs(value)):max,0);
}

export function costHeatColour(value: number | null | undefined, scale: number, positive: string, negative: string, missing: string): string {
  if(value==null||!Number.isFinite(value))return missing;
  const zero=[232,238,242];
  const end=value<0?negative:positive;
  const hex=/^#([a-f\d]{6})$/i.exec(end);
  if(!hex)return end;
  const target=[0,2,4].map(i=>parseInt(hex[1].slice(i,i+2),16));
  const fraction=scale>0?Math.min(1,Math.abs(value)/scale):0;
  return '#'+zero.map((start,i)=>Math.round(start+(target[i]-start)*fraction).toString(16).padStart(2,'0')).join('');
}
