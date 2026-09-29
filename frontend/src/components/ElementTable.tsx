import { useState } from "react";
import { ArrowDownUp, ChevronLeft, ChevronRight } from "lucide-react";
import type { ElementResult } from "../api/types";
import { formatChartNumber as fmt } from "./charts/format";

export default function ElementTable({
  elements,
  unit,
  onSelect,
  selectedId,
}: {
  elements: ElementResult[];
  unit: string;
  onSelect: (e: ElementResult) => void;
  selectedId?: string;
}) {
  const [sort, setSort] = useState<"max" | "violations" | "name">("max");
  const [page, setPage] = useState(0);
  const ordered = [...elements].sort((a, b) =>
    sort === "name"
      ? a.name.localeCompare(b.name, "de")
      : (b[sort] ?? -Infinity) - (a[sort] ?? -Infinity),
  );
  const pages = Math.max(1, Math.ceil(ordered.length / 8));
  const current = Math.min(page, pages - 1);
  function changeSort(value: typeof sort) {
    setSort(value);
    setPage(0);
  }
  return (
    <section className="panel element-table" id="elemente">
      <div className="panel-heading">
        <div>
          <h2>
            Elementanalyse <span className="count">{elements.length}</span>
          </h2>
          <p>Element auswählen, um Identität und Kennzahlen zu prüfen.</p>
        </div>
        <span className="badge">{unit}</span>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th aria-sort={sort === "name" ? "ascending" : "none"}>
                <button onClick={() => changeSort("name")}>
                  Element <ArrowDownUp size={12} />
                </button>
              </th>
              <th>Klasse</th>
              <th>Mittelwert</th>
              <th aria-sort={sort === "max" ? "descending" : "none"}>
                <button onClick={() => changeSort("max")}>
                  Maximum <ArrowDownUp size={12} />
                </button>
              </th>
              <th>P95</th>
              <th aria-sort={sort === "violations" ? "descending" : "none"}>
                <button onClick={() => changeSort("violations")}>
                  Verletzungen <ArrowDownUp size={12} />
                </button>
              </th>
              <th>Werte / fehlend</th>
            </tr>
          </thead>
          <tbody>
            {ordered.slice(current * 8, current * 8 + 8).map((e) => (
              <tr
                key={e.id}
                className={selectedId === e.id ? "selected-row" : ""}
              >
                <td>
                  <button
                    className="element-name"
                    onClick={() => onSelect(e)}
                    aria-pressed={selectedId === e.id}
                  >
                    {e.name}
                    <small>{e.id}</small>
                  </button>
                </td>
                <td>
                  <code>{e.className || e.type}</code>
                </td>
                <td>{fmt(e.mean)}</td>
                <td className={e.violations ? "warning-text" : ""}>
                  {fmt(e.max)}
                </td>
                <td>{fmt(e.p95)}</td>
                <td>
                  <span className={e.violations ? "status warning" : "status"}>
                    {e.violations.toLocaleString("de-DE")}
                  </span>
                </td>
                <td>
                  {e.count.toLocaleString("de-DE")}{" "}
                  <span className="muted">/ {e.missing}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!ordered.length && (
        <p className="empty-inline">Keine Elemente für diese Filter.</p>
      )}
      <div className="table-footer">
        <span>
          Seite {current + 1} von {pages} · Sortierung:{" "}
          {sort === "name"
            ? "Name"
            : sort === "max"
              ? "Maximum"
              : "Verletzungen"}
        </span>
        <div>
          <button
            aria-label="Vorherige Seite"
            disabled={!current}
            onClick={() => setPage(current - 1)}
          >
            <ChevronLeft size={16} />
          </button>
          <button
            aria-label="Nächste Seite"
            disabled={current >= pages - 1}
            onClick={() => setPage(current + 1)}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
    </section>
  );
}
