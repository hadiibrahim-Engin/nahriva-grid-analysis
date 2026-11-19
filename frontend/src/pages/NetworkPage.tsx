import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, Map as MapIcon, Maximize2, Minimize2, RefreshCw, X } from 'lucide-react';
import AnalysisPicker from '../components/AnalysisPicker';
import GridPicker from '../components/GridPicker';
import VoltageLevelPicker from '../components/VoltageLevelPicker';
import LimitsDialog from '../components/LimitsDialog';
import { useAnalysis } from '../hooks/useAnalysis';
import { useGridFilter } from '../hooks/useGridFilter';
import { networkApi, type NetworkHour, type NetworkTimeline, type NetworkMetric } from '../api/network';
import api from '../api/client';
import { readParam, writeParam } from '../util/shareLink';
import { applyGridThemeMode, storedThemeMode } from '../util/theme';
import { downloadText, toCsv } from '../util/csv';
import { costMagnitude } from '../util/mapHeat';
import ScenarioTimeHeatmap from '../components/network/ScenarioTimeHeatmap';
import RedispatchImportDialog from '../components/network/RedispatchImportDialog';
import '../network.css';

const NetworkMap = lazy(()=>import('../components/views/NetworkMap'));
type MapElement = [string, string, string | null, number | null, string | null];
const date = (t: number) => new Date(t*1000).toLocaleString('de-DE', { timeZone: 'UTC', dateStyle: 'short', timeStyle: 'short' });
const money = (n: number | null | undefined) => n == null ? '—' : n.toLocaleString('de-DE', { style:'currency', currency:'EUR' });
const number = (n: number | null | undefined, digits=1) => n == null ? '—' : n.toLocaleString('de-DE', { maximumFractionDigits: digits });
const code = (i: number) => `S${String(i+1).padStart(2,'0')}`;
const NO_TIMES: number[] = [];
const empty = <div className="nw-empty" role="status">Ergebnisse werden geladen …</div>;

export default function NetworkPage() {
  const { analysis } = useAnalysis();
  const { grid, kv } = useGridFilter();
  const [revision, setRevision] = useState(0);
  const [base, setBase] = useState<{ key: string | null; data: NetworkTimeline } | null>(null);
  const [error, setError] = useState('');
  const [scenarioId, setScenarioId] = useState<string | null>(()=>readParam('scenario'));
  const [chosenTime, setChosenTime] = useState<number | null>(()=>{
    const raw = readParam('t'); return raw !== null && Number.isFinite(Number(raw)) ? Number(raw) : null;
  });
  const [element, setElement] = useState<string | null>(()=>readParam('element'));
  const [mapElements, setMapElements] = useState<MapElement[]>([]);
  const [heatMetric, setHeatMetric] = useState<NetworkMetric>('loading');
  const [elementHeat, setElementHeat] = useState(false);
  const [mapMode, setMapMode] = useState<'results' | 'redispatch'>(()=>readParam('layer')==='cost'?'redispatch':'results');
  const [mapFocus, setMapFocus] = useState(()=>readParam('focus')==='map');
  const [inspectorVisible,setInspectorVisible]=useState(true);
  const [heat, setHeat] = useState<{ key: string; data: NetworkTimeline } | null>(null);
  const [hour, setHour] = useState<{ key: string; data: NetworkHour } | null>(null);
  const [hourError, setHourError] = useState('');
  const [heatError, setHeatError] = useState('');
  const [allowed, setAllowed] = useState(false);
  const [plantScope, setPlantScope] = useState<'scenario'|'all'>('scenario');
  const [plantQuery, setPlantQuery] = useState('');
  const [plantLimit, setPlantLimit] = useState(50);
  const [theme, setTheme] = useState(storedThemeMode);
  useEffect(()=>applyGridThemeMode(theme),[theme]);
  useEffect(()=>{
    const leave=()=>{setMapFocus(false);writeParam('focus',null);};
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape')leave();};
    const fullscreen=()=>{if(!document.fullscreenElement)leave();};
    document.addEventListener('keydown',key);
    document.addEventListener('fullscreenchange',fullscreen);
    return ()=>{document.removeEventListener('keydown',key);document.removeEventListener('fullscreenchange',fullscreen);};
  },[]);
  useEffect(()=>{
    const controller = new AbortController();
    api.get<{database_switch:boolean}>('/capabilities',{signal:controller.signal}).then(r=>setAllowed(r.data.database_switch)).catch(()=>undefined);
    return ()=>controller.abort();
  },[]);
  useEffect(()=>{
    const controller = new AbortController(); setError('');
    networkApi.timeline({analysis,metric:'loading'},controller.signal).then(data=>setBase({key:analysis,data}))
      .catch(()=>{if(!controller.signal.aborted)setError('Die Analyse konnte nicht geladen werden. Bitte erneut laden.');});
    return ()=>controller.abort();
  },[analysis,revision]);
  const data = base?.key === analysis ? base.data : null;
  const scenarios = data?.scenarios ?? [];
  const scenario = scenarios.find(s=>s.id===scenarioId) ?? scenarios[0];
  const times = data?.times ?? NO_TIMES;
  const timeIndex = useMemo(()=>{
    if (!times.length) return -1;
    if (chosenTime === null) {
      const cells = scenario?.cells.filter(c=>c!==null) ?? [];
      const worst = cells.reduce<(typeof cells)[number] | null>((best,c)=>!best || c.value>best.value ? c : best,null);
      return Math.max(0,times.indexOf(worst?.t ?? times[0]));
    }
    let lo=0,hi=times.length-1;
    while(lo<hi) { const mid=Math.floor((lo+hi)/2); if(times[mid]<chosenTime)lo=mid+1;else hi=mid; }
    return lo>0 && Math.abs(times[lo-1]-chosenTime)<Math.abs(times[lo]-chosenTime) ? lo-1 : lo;
  },[times,chosenTime,scenario]);
  const t = timeIndex>=0 ? times[timeIndex] : null;
  const pickTime = (value: number) => {setChosenTime(value);writeParam('t',value);};
  const pickScenario = (id: string) => {setScenarioId(id);writeParam('scenario',id);};
  const pickElement = (id: string | null) => {setElement(id);writeParam('element',id);};
  const hourKey = `${analysis}|${t}|${element}|${grid}|${kv}|${revision}`;
  useEffect(()=>{
    if(t===null) return;
    const controller = new AbortController(); setHourError('');
    networkApi.hour({analysis,t,element:element??undefined,grid,kv},controller.signal).then(result=>setHour({key:hourKey,data:result}))
      .catch(()=>{if(!controller.signal.aborted)setHourError('Die Stundenwerte konnten nicht geladen werden.');});
    return ()=>controller.abort();
  },[analysis,t,element,grid,kv,hourKey]);
  const current = hour?.key===hourKey ? hour.data : null;
  const heatElement = elementHeat && element ? element : undefined;
  const effectiveMetric = heatMetric==='active_power' && !heatElement ? 'loading' : heatMetric;
  const heatKey = `${analysis}|${effectiveMetric}|${heatElement}|${revision}`;
  useEffect(()=>{
    if(effectiveMetric==='loading' && !heatElement) return;
    const controller = new AbortController();setHeatError('');
    networkApi.timeline({analysis,element:heatElement,metric:effectiveMetric},controller.signal).then(result=>setHeat({key:heatKey,data:result}))
      .catch(()=>{if(!controller.signal.aborted)setHeatError('Die Heatmap konnte nicht geladen werden.');});
    return ()=>controller.abort();
  },[analysis,effectiveMetric,heatElement,heatKey]);
  const heatData = effectiveMetric==='loading'&&!heatElement ? data : heat?.key===heatKey ? heat.data : null;
  const selectedHour = current?.scenarios.find(s=>s.id===scenario?.id);
  const selectedName = current?.element?.name ?? mapElements.find(e=>e[0]===element)?.[1];
  const plants = useMemo(()=>{
    const q=plantQuery.trim().toLowerCase();
    return (current?.plants ?? []).filter(p=>(plantScope==='all'||p.scenario_id===scenario?.id)&&(!q||`${p.name} ${p.scenario_name}`.toLowerCase().includes(q)));
  },[current,plantScope,scenario?.id,plantQuery]);
  const costLabels = useMemo(()=>(current?.plants ?? []).filter(p=>p.scenario_id===scenario?.id).map(p=>({element_id:p.element_id,cost_eur:p.cost_eur})),[current,scenario?.id]);
  const costScale=useMemo(()=>costMagnitude((current?.plants??[]).map(p=>p.cost_eur)),[current]);
  const elementChoices = useMemo(()=>{
    const items=new Map(mapElements.map(e=>[e[0],{id:e[0],name:e[1]}]));
    for(const p of current?.plants ?? [])items.set(p.element_id,{id:p.element_id,name:p.name});
    return [...items.values()].sort((a,b)=>a.name.localeCompare(b.name));
  },[mapElements,current]);
  const backQuery = new URLSearchParams(window.location.search); backQuery.set('view','network'); backQuery.delete('t'); backQuery.delete('element');
  const currentUnit = current?.scenarios.find(s=>s.metric)?.metric==='voltage' ? 'p.u.' : current?.scenarios.find(s=>s.metric)?.metric==='active_power' ? 'MW' : '%';
  const generatorSelected = ['ElmSym','ElmGenstat','ElmPvsys'].includes(current?.element?.class_name ?? '');
  const moveHour = (direction:number)=>{
    if(t===null)return;
    const target=t+direction*3600;
    const next=direction>0 ? times.find(x=>x>=target) : [...times].reverse().find(x=>x<=target);
    if(next!==undefined)pickTime(next);
  };
  return <div className={`grid-theme-scope across-scope nw-page${mapFocus?' nw-page--map-only':''}`}>
    <header className="nw-header">
      <div className="nw-brand"><a href={`/?${backQuery}`} className="nw-back" aria-label="Zurück zum Dashboard"><ArrowLeft size={18}/></a><MapIcon size={23}/><div><h1>Netzkarte</h1><p>Szenarien, Netzbelastung und Redispatch</p></div></div>
      <div className="nw-actions">{!mapFocus&&<a href="#network-heatmap" className="nw-button">Zeitvergleich</a>}
        {!mapFocus&&<button className="nw-button" aria-pressed={inspectorVisible} onClick={()=>setInspectorVisible(v=>!v)}>{inspectorVisible?'Details ausblenden':'Details anzeigen'}</button>}<LimitsDialog/>
        <button className="nw-button" onClick={()=>setTheme(v=>v==='dark'?'light':'dark')}>{theme==='dark'?'Hell':'Dunkel'}</button>
        <button className="nw-icon" aria-label="Ergebnisse neu laden" onClick={()=>setRevision(n=>n+1)}><RefreshCw size={16}/></button>
        <button className="nw-icon" aria-label={mapFocus?'Vollmodus verlassen':'Karten-Vollmodus'} aria-pressed={mapFocus} onClick={()=>{
          const next=!mapFocus;setMapFocus(next);writeParam('focus',next?'map':null);
          if(!next&&document.fullscreenElement)void document.exitFullscreen?.().catch(()=>undefined);
          else if(next)void document.documentElement.requestFullscreen?.().catch(()=>undefined);
        }}>{mapFocus?<Minimize2 size={16}/>:<Maximize2 size={16}/>}</button>
      </div>
    </header>
    <div className="nw-context"><AnalysisPicker refreshKey={revision}/><GridPicker refreshKey={revision}/><VoltageLevelPicker refreshKey={revision}/>
      <label className="nw-select">Szenario<select value={scenario?.id??''} onChange={e=>pickScenario(e.target.value)} disabled={!scenarios.length}>{scenarios.map((s,i)=><option key={s.id} value={s.id}>{code(i)} · {s.name}</option>)}</select></label>
      <div className="nw-segment" role="group" aria-label="Kartenfärbung"><button aria-pressed={mapMode==='results'} onClick={()=>{setMapMode('results');writeParam('layer','loading');}}>Auslastung</button><button aria-pressed={mapMode==='redispatch'} onClick={()=>{setMapMode('redispatch');writeParam('layer','cost');}}>Kosten</button></div>
    </div>
    <main className="nw-main">
      {current?.delivery?.source.startsWith('DEMO_')&&<p className="nw-demo-notice">Synthetische Demo: stündliche Redispatch-Planung mit ausgeglichener Hoch- und Abregelung. Der Lastfluss zeigt den Zustand vor Redispatch; keine realen Betriebs- oder Abrechnungsdaten.</p>}
      {error && <p className="nw-error" role="alert">{error}</p>}
      {!data&&!error&&empty}
      {data&&scenarios.length===0&&<div className="nw-empty">Keine Szenarien in dieser Analyse. Bitte eine andere Analyse auswählen.</div>}
      {data&&scenarios.length>0&&<>
        <div className={`nw-stage${mapFocus||!inspectorVisible?' nw-stage--no-inspector':''}`}>
          <section className="nw-map-panel" aria-label="Große interaktive Netzkarte">
            <div className="nw-panel-heading"><div><span className="nw-eyebrow">{code(Math.max(0,scenarios.indexOf(scenario!)))} · {scenario?.name}</span><h2>{t===null?'Keine QDS-Zeitpunkte':`${date(t)} UTC`}</h2></div>
              <span className="nw-state">{mapMode==='redispatch'?'Kosten je Kraftwerk und Stunde':'Leitungen: Auslastung · Sammelschienen: Spannung'}</span></div>
            {t!==null&&scenario?.has_qds ? <Suspense fallback={empty}><NetworkMap scenarioId={scenario.id} t={t} onPickAsset={pickElement}
              selectedElementId={element} onElementsLoaded={setMapElements} mode={mapMode} costs={costLabels} costScale={costScale} dataRevision={`${revision}|${current?.delivery?.id??''}`}/></Suspense>
              : <div className="nw-empty">Dieser Fall enthält keine QDS-Zeitreihe für die Karte. n-1-Ergebnisse bleiben im Dashboard verfügbar.</div>}
          </section>
          {!mapFocus&&inspectorVisible&&<aside className="nw-inspector" aria-label="Betriebsmittel über alle Szenarien">
            <div className="nw-inspector-title"><span className="nw-eyebrow">Betriebsmittel</span>{element&&<button className="nw-icon" aria-label="Auswahl aufheben" onClick={()=>pickElement(null)}><X size={14}/></button>}</div>
            <select className="nw-asset-select" aria-label="Betriebsmittel auswählen" value={element??''} onChange={e=>pickElement(e.target.value||null)}><option value="">Auf der Karte auswählen</option>{elementChoices.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select>
            <h2>{selectedName??'Netzüberblick'}</h2>
            <p className="nw-muted">{current?.element ? `${current.element.grid} · ${number(current.element.nominal_kv)} kV` : 'Ein Klick zeigt die zeitgleichen Werte in allen Szenarien.'}</p>
            <div className="nw-inspector-stats"><div><span>{selectedName?'Szenariowert':'Max. Auslastung · Gesamtnetz'}</span><strong>{number(selectedName?selectedHour?.value:selectedHour?.loading_max,3)} <small>{selectedName?currentUnit:'%'}</small></strong></div><div><span>{selectedName?'Referenz REF':'Grenzverletzungen · Gesamtnetz'}</span><strong>{number(selectedName?selectedHour?.ref:selectedHour?.loading_over,3)} <small>{selectedName?currentUnit:''}</small></strong></div></div>
            <div className="nw-table-title"><h3>Alle Szenarien</h3><span>{t===null?'':`${date(t)} UTC`}</span></div>
            {hourError?<p className="nw-error" role="alert">{hourError}</p>:!current?empty:<div className="nw-scenario-list">{current.scenarios.map((s,i)=>{
              const cost = generatorSelected ? current.plants.find(p=>p.scenario_id===s.id&&p.element_id===element)?.cost_eur : s.redispatch?.cost_eur;
              const value = selectedName?s.value:s.loading_max;
              return <button className="nw-scenario-row" key={s.id} aria-pressed={s.id===scenario?.id} onClick={()=>pickScenario(s.id)} title={s.name}>
                <span className="nw-scenario-code">{code(i)}</span><span className="nw-scenario-name">{s.name}<small>{s.outaged?'Abgeschaltet':!s.has_time?'Kein QDS-Wert zu diesem Zeitpunkt':`${number(value,selectedName?3:1)} ${selectedName?currentUnit:'%'}${!selectedName?' max.':''}`}</small></span>
                <span className="nw-scenario-cost">{money(cost)}<small>{generatorSelected?'Kraftwerk':'bekannte Kosten'}</small></span>
              </button>;
            })}</div>}
            <p className="nw-muted">— bedeutet nicht verfügbar. Bekannte Kosten sind Teilsummen; fehlende Kraftwerke werden nicht als 0 € gezählt.</p>
          </aside>}
        </div>
        {!mapFocus&&<><section id="network-heatmap" className="nw-section" aria-label="Szenarien-Zeit-Heatmap">
          <div className="nw-section-heading"><div><span className="nw-eyebrow">Szenario × Zeit</span><h2>Wo wird es kritisch?</h2><p>{elementHeat&&selectedName?selectedName:'Gesamtnetz, unabhängig von Netz- und Spannungsfilter'} · {effectiveMetric==='voltage'?'Minimum':effectiveMetric==='redispatch'?'Betragsgrößte bekannte Stundenkosten':'Maximum'} je Zeitfenster. Klick öffnet Szenario und tatsächlichen Zeitpunkt.</p></div>
            <div className="nw-actions"><label className="nw-checkbox"><input type="checkbox" checked={elementHeat} disabled={!element} onChange={e=>{
              setElementHeat(e.target.checked);
              if(heatMetric!=='redispatch')setHeatMetric(e.target.checked&&generatorSelected?'active_power':e.target.checked&&current?.element?.class_name==='ElmTerm'?'voltage':'loading');
            }}/>Gewähltes Element</label>
              <select aria-label="Heatmap-Messgröße" value={effectiveMetric} onChange={e=>setHeatMetric(e.target.value as NetworkMetric)}><option value="loading">Auslastung %</option><option value="voltage">Spannung p.u.</option>{generatorSelected&&elementHeat&&<option value="active_power">Erzeugung MW</option>}<option value="redispatch">Redispatch € / Stunde</option></select></div></div>
          {heatError&&<p role="alert" className="nw-error">{heatError}</p>}
          {heatData ? heatData.scenarios.some(s=>s.cells.some(c=>c!==null)) ? <ScenarioTimeHeatmap data={heatData} scenario={scenario?.id??null} t={t} onPick={(id,time)=>{pickScenario(id);pickTime(time);}}/>
            : <div className="nw-empty">{effectiveMetric==='redispatch'?'Noch keine Redispatch-Kosten für diese Auswahl importiert.':'Für diese Messgröße liegen keine Werte vor.'}</div>:!heatError&&empty}
          <div className="nw-scenario-key">{scenarios.map((s,i)=><button key={s.id} aria-pressed={s.id===scenario?.id} onClick={()=>pickScenario(s.id)}><b>{code(i)}</b>{s.name}</button>)}</div>
        </section>
        <section className="nw-section" aria-label="Redispatch-Kosten je Kraftwerk">
          <div className="nw-section-heading"><div><span className="nw-eyebrow">Kraftwerke · {current?`${date(current.hour_start)}–${date(current.hour_start+3600)} UTC`:'Stundenwerte'}</span><h2>Redispatch-Mengen und Kosten</h2><p>{current?.delivery?`${current.delivery.source} · ${current.delivery.quantity_kind==='delivered'?'gelieferte':current.delivery.quantity_kind==='planned'?'geplante':'angeforderte'} Mengen · ${current.delivery.rows.toLocaleString('de-DE')} Datensätze`:'Keine Redispatch-Lieferung angebunden. Netzberechnungswerte sind bereits verfügbar.'}</p></div>
            <div className="nw-actions">{allowed&&<RedispatchImportDialog data={current} onImported={()=>setRevision(n=>n+1)}/>}<button className="nw-button" disabled={!plants.length} onClick={()=>downloadText('kraftwerke-stunde.csv',toCsv(['scenario_id','Szenario','element_id','Kraftwerk','UTC Stunde','P MW','Redispatch MWh','Preis EUR/MWh','Kosten EUR'],plants.map(p=>[p.scenario_id,p.scenario_name,p.element_id,p.name,current?date(current.hour_start):'',p.active_power_mw,p.energy_mwh,p.price_eur_per_mwh,p.cost_eur])))}>CSV exportieren</button></div></div>
          <div className="nw-table-controls"><div className="nw-segment" role="group" aria-label="Kraftwerk-Szenariofilter"><button aria-pressed={plantScope==='scenario'} onClick={()=>{setPlantScope('scenario');setPlantLimit(50);}}>Aktuelles Szenario</button><button aria-pressed={plantScope==='all'} onClick={()=>{setPlantScope('all');setPlantLimit(50);}}>Alle Szenarien</button></div><input type="search" aria-label="Kraftwerke durchsuchen" placeholder="Kraftwerk oder Szenario suchen …" value={plantQuery} onChange={e=>{setPlantQuery(e.target.value);setPlantLimit(50);}}/></div>
          <div className="nw-table-scroll"><table className="nw-table"><thead><tr><th>Szenario</th><th>Kraftwerk</th><th>Netz</th><th>Erzeugung MW</th><th>Redispatch MWh</th><th>€/MWh</th><th>Kosten / Stunde</th></tr></thead><tbody>{plants.slice(0,plantLimit).map(p=><tr key={`${p.scenario_id}|${p.element_id}`} className={element===p.element_id?'is-selected':undefined}><td>{code(Math.max(0,scenarios.findIndex(s=>s.id===p.scenario_id)))}</td><td><button onClick={()=>pickElement(p.element_id)}>{p.name}<ArrowRight size={12}/></button></td><td>{p.grid}</td><td>{number(p.active_power_mw,2)}</td><td>{number(p.energy_mwh,3)}</td><td>{number(p.price_eur_per_mwh,2)}</td><td>{money(p.cost_eur)}</td></tr>)}</tbody></table>{!plants.length&&<p className="nw-empty">Keine Kraftwerke für diese Auswahl aufgezeichnet.</p>}</div>
          {plants.length>plantLimit&&<button className="nw-button" onClick={()=>setPlantLimit(n=>n+100)}>Weitere Kraftwerke ({plantLimit} / {plants.length})</button>}
          <p className="nw-muted">Kosten = gelieferte MWh × gelieferter €/MWh-Preis, vorzeichengetreu. Die Mengenart steht an der Lieferung. Keine Ableitung aus REF-/Szenario-Leistungsdifferenzen.</p>
        </section></>}
      </>}
    </main>
    <footer className="nw-clock" aria-label="Zeitnavigation">
      <div className="nw-clock-buttons"><button className="nw-icon" disabled={timeIndex<=0} aria-label="Eine Stunde zurück" onClick={()=>moveHour(-1)}><ChevronLeft size={20}/></button><div><span className="nw-eyebrow">Simulationszeit · UTC</span><strong>{t===null?'Keine Zeitpunkte':date(t)}</strong></div><button className="nw-icon" disabled={timeIndex<0||timeIndex>=times.length-1} aria-label="Eine Stunde weiter" onClick={()=>moveHour(1)}><ChevronRight size={20}/></button></div>
      <div className="nw-clock-slider"><input aria-label="Simulationszeitpunkt" type="range" min={0} max={Math.max(0,times.length-1)} step={1} value={Math.max(0,timeIndex)} disabled={!times.length} onChange={e=>pickTime(times[Number(e.target.value)])}/><div><span>{times.length?date(times[0]):'—'}</span><span>{timeIndex>=0?`${timeIndex+1} / ${times.length} verfügbare Zeitpunkte`:''}</span><span>{times.length?date(times[times.length-1]):'—'}</span></div></div>
      <label className="nw-time-input">Zu Datum / Uhrzeit<input type="datetime-local" aria-label="Zu UTC-Zeitpunkt springen" value={t===null?'':new Date(t*1000).toISOString().slice(0,16)} onChange={e=>{const target=Date.parse(e.target.value+'Z');if(Number.isFinite(target))pickTime(target/1000);}}/></label>
    </footer>
  </div>;
}
