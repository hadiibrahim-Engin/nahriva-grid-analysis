import { useEffect, useMemo, useState } from 'react';
import { networkApi, type EquipmentHour, type EquipmentMetric } from '../../api/network';
import './mapEquipmentHover.css';

const format = (value: number | null | undefined, digits=2) => value == null ? '—' : (Number(value.toFixed(digits))||0).toLocaleString('de-DE',{maximumFractionDigits:digits});
const time = (t:number) => new Date(t*1000).toLocaleString('de-DE',{timeZone:'UTC',dateStyle:'short',timeStyle:'short'});
const label = (metric:EquipmentMetric) => ({loading:'Auslastung',voltage:'Spannung',active_power:'Wirkleistung'}[metric.id]??metric.name);

/** One debounced request per equipment/time; pointer motion never refetches the table. */
export default function MapEquipmentHover({analysis,t,elementId,name,scenarioId,revision}: {
  analysis:string|null; t:number; elementId:string; name:string; scenarioId:string; revision:string;
}) {
  const [result,setResult]=useState<{key:string;data:EquipmentHour}|null>(null);
  const [error,setError]=useState('');
  const [retry,setRetry]=useState(0);
  const cache=useMemo(()=>new Map<string,{data:EquipmentHour;at:number}>(),[]);
  const key=`${analysis}|${t}|${elementId}|${revision}|${retry}`;
  useEffect(()=>{
    const controller=new AbortController(); setError('');
    const timer=window.setTimeout(()=>{
      const cached=cache.get(key);
      const request=cached&&Date.now()-cached.at<15_000 ? Promise.resolve(cached.data)
        : networkApi.equipmentHour({analysis,t,element:elementId},controller.signal);
      request.then(data=>{
        if(controller.signal.aborted)return;
        cache.set(key,{data,at:Date.now()});
        if(cache.size>32)cache.delete(cache.keys().next().value!);
        setResult({key,data});
      }).catch(()=>{if(!controller.signal.aborted)setError('Stundenvergleich konnte nicht geladen werden.');});
    },120);
    return ()=>{window.clearTimeout(timer);controller.abort();};
  },[analysis,t,elementId,revision,retry,key,cache]);
  const data=result?.key===key?result.data:null;
  const metrics=useMemo(()=>{
    const found=new Map<string,EquipmentMetric>();
    for(const scenario of data?.scenarios??[])for(const metric of scenario.metrics)found.set(metric.id,metric);
    const order=['loading','voltage','active_power'];
    return [...found.values()].sort((a,b)=>(order.includes(a.id)?order.indexOf(a.id):99)-(order.includes(b.id)?order.indexOf(b.id):99)||a.name.localeCompare(b.name));
  },[data]);
  const plant=['ElmSym','ElmGenstat','ElmPvsys'].includes(data?.element.class_name??'');
  return <>
    <header className="ab-map-hover__header"><div><strong>{data?.element.name??name}</strong>
      <span>{data?.element.grid}{data?.element.nominal_kv!=null?` · ${format(data.element.nominal_kv)} kV`:''}</span></div>
      <div><b>{time(t)} UTC</b><span>Vergleich über alle Szenarien</span></div></header>
    {!data&&!error&&<p role="status" className="ab-map-hover__notice">Stundenwerte aller Szenarien werden geladen …</p>}
    {error&&<p role="alert" className="ab-map-hover__notice">{error} <button type="button" onClick={()=>setRetry(n=>n+1)}>Erneut laden</button></p>}
    {data&&<><div className="ab-map-hover__scroll"><table aria-label={`Stundenvergleich ${data.element.name}`}>
      <thead><tr><th>Szenario / Zustand</th>{metrics.map(metric=><th key={metric.id}>{label(metric)}<small>{metric.unit}</small></th>)}
        {plant&&<><th>RD-Energie<small>MWh</small></th><th>RD-Preis<small>€/MWh</small></th><th>RD-Kosten<small>€ / Stunde</small></th></>}</tr></thead>
      <tbody>{data.scenarios.map((scenario,index)=><tr key={scenario.id} data-current={scenario.id===scenarioId}>
        <th scope="row"><span className="ab-map-hover__scenario"><b>S{String(index+1).padStart(2,'0')}</b>{scenario.name}</span>
          <small>{scenario.outaged?'Abgeschaltet':!scenario.has_time?'Kein QDS-Wert zu dieser Zeit':'In Betrieb'}{scenario.id===scenarioId?' · angezeigt':''}</small></th>
        {metrics.map(metric=>{
          const m=scenario.metrics.find(value=>value.id===metric.id);
          const digits=metric.unit==='p.u.'?3:2;
          const alert=!scenario.outaged&&m?.value!=null&&((m.lower!=null&&m.value<m.lower)||(m.upper!=null&&m.value>m.upper));
          return <td key={metric.id} data-alert={alert||undefined} title={m?`Grenzen: ${format(m.lower,digits)} … ${format(m.upper,digits)} ${m.unit}`:undefined}>
            <strong>{format(m?.value,digits)}</strong><small>REF {format(m?.ref,digits)} · Δ {m?.delta!=null&&m.delta>=0.5*10**-digits?'+':''}{format(m?.delta,digits)}{m?.delta!=null&&metric.unit==='%'?' pp':''}</small></td>;
        })}
        {plant&&<><td>{format(scenario.redispatch?.energy_mwh)}</td><td>{format(scenario.redispatch?.price_eur_per_mwh)}</td><td><strong>{format(scenario.redispatch?.cost_eur)}</strong></td></>}
      </tr>)}</tbody>
    </table></div>
      <footer>REF = Referenz · Δ = Szenario − REF · — = kein gespeicherter Wert.
        {plant&&<> Redispatch: {time(data.hour_start)}–{new Date((data.hour_start+3600)*1000).toLocaleTimeString('de-DE',{timeZone:'UTC',hour:'2-digit',minute:'2-digit'})} UTC.</>}
        <span>Maus hierher bewegen zum Lesen und Scrollen · Klick auf das Betriebsmittel wählt es aus.</span></footer>
    </>}
  </>;
}
