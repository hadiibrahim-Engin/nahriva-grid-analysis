import { useState } from "react";
import { Copy, Focus, X } from "lucide-react";
import type { ElementResult, Run } from "../api/types";
import { selectionPayload } from "../util/selection";

export default function ElementDetail({
  run,
  element,
  onClose,
  onFilter,
}: {
  run: Run;
  element: ElementResult;
  onClose: () => void;
  onFilter: (id: string) => void;
}) {
  const [message, setMessage] = useState("");
  const payload = selectionPayload(run, element);
  async function copy() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setMessage("Elementreferenz kopiert.");
    } catch {
      setMessage(
        "Kopieren nicht verfügbar. Elementreferenz unten markieren und kopieren.",
      );
    }
  }
  return (
    <section className="panel element-detail" aria-label="Ausgewähltes Element">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">AUSGEWÄHLTES ELEMENT</span>
          <h2>{element.name}</h2>
        </div>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Elementdetails schließen"
        >
          <X size={18} />
        </button>
      </div>
      <dl>
        <div>
          <dt>Stabile ID</dt>
          <dd>{element.id}</dd>
        </div>
        <div>
          <dt>Elementklasse</dt>
          <dd>{element.className || "Nicht zugeordnet"}</dd>
        </div>
        <div>
          <dt>Objektpfad</dt>
          <dd>{element.path || "Nicht zugeordnet"}</dd>
        </div>
        <div>
          <dt>Study Case</dt>
          <dd>{run.study_case}</dd>
        </div>
      </dl>
      <div className="detail-actions">
        <button onClick={() => onFilter(element.id)}>
          <Focus size={15} />
          Nur dieses Element analysieren
        </button>
        <button onClick={() => void copy()}>
          <Copy size={15} />
          Elementreferenz kopieren
        </button>
      </div>
      <p className="muted">
        PowerFactory-Markierung ist noch nicht verbunden. Die Elementreferenz
        ist für eine spätere Übergabe vorbereitet.
      </p>
      <p role="status">{message}</p>
      <details>
        <summary>Elementreferenz anzeigen</summary>
        <pre>{JSON.stringify(payload, null, 2)}</pre>
      </details>
    </section>
  );
}
