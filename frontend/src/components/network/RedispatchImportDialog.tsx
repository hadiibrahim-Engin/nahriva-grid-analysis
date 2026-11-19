import { useRef, useState } from 'react';
import api from '../../api/client';
import { useAnalysis } from '../../hooks/useAnalysis';
import { downloadText, toCsv } from '../../util/csv';
import type { NetworkHour } from '../../api/network';

export default function RedispatchImportDialog({ data, onImported }: { data: NetworkHour | null; onImported: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { analysis } = useAnalysis();
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const header = ['scenario_id','element_id','start_utc','end_utc','energy_mwh','price_eur_per_mwh'];
  const mappings = () => {
    if (!data) return;
    downloadText('redispatch-mapping.csv', toCsv(['scenario_id','scenario','element_id','generator'], data.plants.map(p=>[p.scenario_id,p.scenario_name,p.element_id,p.name])));
  };
  return <>
    <button className="nw-button" type="button" onClick={()=>dialog.current?.showModal()}>Redispatch importieren</button>
    <dialog ref={dialog} className="ab-dialog nw-import" aria-label="Redispatch importieren">
      <form onSubmit={async e => {
        e.preventDefault(); if (!file || !kind) return;
        if (file.size > 10_000_000) { setError('Die CSV darf höchstens 10 MB groß sein.'); return; }
        setBusy(true); setError('');
        try {
          await api.post('/redispatch/import', { analysis: data?.analysis ?? analysis, source: file.name, quantity_kind: kind, csv: await file.text() });
          onImported(); dialog.current?.close(); setFile(null);
        } catch (err) { setError((err as { response?: { data?: { detail?: string } } }).response?.data?.detail ?? 'Import fehlgeschlagen. Bitte CSV und Serververbindung prüfen.'); }
        finally { setBusy(false); }
      }}>
        <div className="ab-dialog__head"><h2>Redispatch-Kosten anbinden</h2><button type="button" className="ab-chip" disabled={busy} onClick={()=>dialog.current?.close()}>Schließen</button></div>
        <p>Gelieferte Stundenenergie × Preis. Vorzeichen werden übernommen. Jede Zeile beschreibt ein Kraftwerk in einem Szenario für eine volle UTC-Stunde [Beginn, Ende).</p>
        <p>Eine Datei ist eine vollständige Lieferung für diese Analyse. Ein neuer Import wird als neue Revision angezeigt; frühere Lieferungen bleiben gespeichert. Fehlende Zeilen bleiben unbekannt.</p>
        <div className="nw-actions"><button type="button" className="nw-button" onClick={()=>downloadText('redispatch-template.csv', header.join(',')+'\n')}>CSV-Vorlage</button>
          <button type="button" className="nw-button" disabled={!data} onClick={mappings}>Szenario- und Kraftwerk-IDs</button></div>
        <code className="nw-csv-columns">{header.join(',')}</code>
        <label>Mengenart<select required value={kind} onChange={e=>setKind(e.target.value)} disabled={busy}><option value="">Bitte wählen</option><option value="requested">Angefordert</option><option value="planned">Geplant</option><option value="delivered">Geliefert</option></select></label>
        <label>CSV-Datei<input type="file" accept=".csv,text/csv" required disabled={busy} onChange={e=>setFile(e.target.files?.[0] ?? null)} /></label>
        <p>Kommagetrennt, Dezimalpunkt, Zeitangaben mit Z oder +00:00. Maximal 50.000 Zeilen. Je Kraftwerk, Szenario und Stunde genau eine aggregierte Zeile. Beispiel: 2.5 MWh × 80 €/MWh = 200 €.</p>
        {error && <p role="alert" className="nw-error">{error}</p>}
        <button className="nw-button nw-button--primary" disabled={busy || !file || !kind}>{busy ? 'Prüfen und importieren …' : 'Lieferung prüfen und speichern'}</button>
      </form>
    </dialog>
  </>;
}
