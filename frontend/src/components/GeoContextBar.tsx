/**
 * Sticky context strip shown between the map section and the timeseries
 * chart in the first tab.
 *
 * Three states:
 *
 *   idle        — no station selected. Shows an invitation to click a
 *                 marker on the map.
 *
 *   pending     — station selected, fuzzy match is high confidence (or
 *                 already confirmed by the user). Shows station + facility
 *                 info and the active time range.
 *
 *   confirm     — station selected, fuzzy match is medium confidence.
 *                 Shows a yellow confirmation prompt before selecting the
 *                 facility. User can confirm or switch to manual selection.
 *
 * The bar never disappears — it always occupies vertical space so the
 * layout doesn't shift when a station is selected/cleared.
 */
import type { MockStation } from './charts/gridMockData';
import type { MatchResult } from '../util/facilityMatcher';
import { formatScore } from '../util/facilityMatcher';
import type { Facility } from '../api/client';
import AnimatedButton from './ui/AnimatedButton';

interface Props {
  selectedStation: MockStation | null;
  matchResult: MatchResult | null;
  /** The facility currently active in the dashboard dropdowns. */
  selectedFacility: Facility | null;
  dateStart: string;
  dateEnd: string;
  onClearSelection: () => void;
  /** Called when the user confirms a medium-confidence match. */
  onConfirmMatch: (facility: Facility) => void;
  /** Called when the user wants to pick the facility manually. */
  onManualSelect: () => void;
  onExportPdf: () => void;
  exportDisabled: boolean;
  exportBusy: boolean;
  exportStatusMessage: string | null;
  exportErrorMessage: string | null;
}

export default function GeoContextBar({
  selectedStation,
  matchResult,
  selectedFacility,
  dateStart,
  dateEnd,
  onClearSelection,
  onConfirmMatch,
  onManualSelect,
  onExportPdf,
  exportDisabled,
  exportBusy,
  exportStatusMessage,
  exportErrorMessage,
}: Props) {
  const isMedium = matchResult?.confidence === 'medium';
  const isHigh   = matchResult?.confidence === 'high';

  // -- idle state --------------------------------------------------------
  if (!selectedStation) {
    return (
      <div
        className="flex items-center gap-2 px-4 py-2 text-xs rounded-md border"
        style={{
          background: 'var(--grid-surface)',
          borderColor: 'var(--grid-border)',
          color: 'var(--grid-muted)',
        }}
      >
        <span aria-hidden>🗺️</span>
        <span>
          Klicke einen Marker auf der Karte, um eine Station auszuwählen
          und die Zeitreihe automatisch zu laden.
        </span>
      </div>
    );
  }

  // -- station selected --------------------------------------------------
  return (
    <div
      className="rounded-md border text-xs"
      style={{
        background: 'var(--grid-surface)',
        borderColor: isMedium ? 'var(--grid-warning)' : 'var(--grid-border)',
        color: 'var(--grid-text)',
      }}
    >
      {/* -- Top row: station identity + controls -- */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2">
        {/* Station marker icon + name */}
        <div className="flex items-center gap-1.5 min-w-0">
          <span aria-hidden className="shrink-0">📍</span>
          <span className="font-semibold truncate">{selectedStation.langname}</span>
          <span
            className="shrink-0 px-1.5 py-0.5 rounded font-mono"
            style={{ background: 'var(--grid-surface-strong)', color: 'var(--grid-text-soft)' }}
          >
            {selectedStation.identifierKurz}
          </span>
        </div>

        {/* Station type + voltages */}
        <div className="flex items-center gap-1.5" style={{ color: 'var(--grid-muted)' }}>
          <span>{selectedStation.typ}</span>
          {selectedStation.spannungsebenen.length > 0 && (
            <>
              <span>·</span>
              <span>{selectedStation.spannungsebenen.join(' / ')} kV</span>
            </>
          )}
          {selectedStation.planung && (
            <span
              className="px-1.5 py-0.5 rounded italic"
              style={{ background: 'var(--grid-surface-strong)', color: 'var(--grid-warning)' }}
            >
              in Planung
            </span>
          )}
        </div>

        {/* Time range */}
        <div className="flex items-center gap-1" style={{ color: 'var(--grid-muted)' }}>
          <span>Von</span>
          <span className="font-mono" style={{ color: 'var(--grid-text)' }}>{dateStart}</span>
          <span>bis</span>
          <span className="font-mono" style={{ color: 'var(--grid-text)' }}>{dateEnd}</span>
        </div>

        {/* Spacer */}
        <div className="grow" />

        {/* Clear */}
        <AnimatedButton
          variant="ghost"
          size="xs"
          onClick={onClearSelection}
          title="Auswahl aufheben"
          icon={<span aria-hidden>×</span>}
        >
          Auswahl aufheben
        </AnimatedButton>

        <AnimatedButton
          variant="pdf"
          size="xs"
          onClick={onExportPdf}
          disabled={exportDisabled}
          loading={exportBusy}
          title={exportDisabled ? 'No charts available for export.' : 'Export PDF'}
          aria-busy={exportBusy}
          icon={<span aria-hidden>📄</span>}
        >
          PDF
        </AnimatedButton>
      </div>

      {(exportStatusMessage || exportErrorMessage) && (
        <div
          className="flex items-center gap-2 px-4 pb-2 text-xs"
          style={{ color: exportErrorMessage ? 'var(--grid-danger)' : 'var(--grid-muted)' }}
        >
          {exportBusy && !exportErrorMessage && <span className="h-2.5 w-2.5 rounded-full border border-current border-t-transparent animate-spin" aria-hidden />}
          <span>{exportErrorMessage ?? exportStatusMessage}</span>
        </div>
      )}

      {/* -- Facility match row -- */}
      {matchResult && (
        <div
          className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 border-t"
          style={{
            borderColor: isMedium ? 'var(--grid-warning)' : 'var(--grid-border)',
            background: isMedium ? 'var(--grid-warning-soft, rgba(245,158,11,0.08))' : undefined,
          }}
        >
          {/* Confidence badge */}
          <ConfidenceBadge result={matchResult} />

          {isHigh && selectedFacility && (
            <span style={{ color: 'var(--grid-muted)' }}>
              Anlage:{' '}
              <span className="font-semibold" style={{ color: 'var(--grid-text)' }}>
                {selectedFacility.name}
              </span>
              {selectedFacility.spannungsebene && (
                <span style={{ color: 'var(--grid-muted)' }}>
                  {' '}· {selectedFacility.spannungsebene}
                </span>
              )}
              <span className="ml-2 font-mono" style={{ color: 'var(--grid-muted-2)' }}>
                ({selectedFacility.id})
              </span>
            </span>
          )}

          {/* Medium-confidence confirmation UI */}
          {isMedium && (
            <>
              <span style={{ color: 'var(--grid-text-soft)' }}>
                Mögliche Anlage:{' '}
                <span className="font-semibold">{matchResult.facility.name}</span>
                {matchResult.facility.spannungsebene && (
                  <span style={{ color: 'var(--grid-muted)' }}>
                    {' '}· {matchResult.facility.spannungsebene}
                  </span>
                )}
              </span>
              <div className="flex items-center gap-2">
                <AnimatedButton
                  variant="success"
                  size="xs"
                  onClick={() => onConfirmMatch(matchResult.facility)}
                  icon={<span aria-hidden>✓</span>}
                >
                  Bestätigen
                </AnimatedButton>
                <AnimatedButton
                  variant="secondary"
                  size="xs"
                  onClick={onManualSelect}
                >
                  Manuell wählen
                </AnimatedButton>
              </div>
            </>
          )}

          {/* Low confidence — no facility to show */}
          {matchResult.confidence === 'low' && (
            <span style={{ color: 'var(--grid-muted)' }}>
              Kein passender FDWH-Eintrag gefunden. Bitte Anlage manuell wählen.
            </span>
          )}
        </div>
      )}

      {/* No match at all (matchStation returned null) */}
      {!matchResult && selectedStation && (
        <div
          className="px-4 py-2 border-t text-xs"
          style={{ borderColor: 'var(--grid-border)', color: 'var(--grid-muted)' }}
        >
          Kein FDWH-Eintrag gefunden (keine Anlagen geladen oder Namensabweichung zu groß).
          Bitte Anlage manuell wählen.
        </div>
      )}
    </div>
  );
}

// -- helper ----------------------------------------------------------------

function ConfidenceBadge({ result }: { result: MatchResult }) {
  const { confidence, score } = result;
  const label =
    confidence === 'high'   ? '✓ Hohe Konfidenz' :
    confidence === 'medium' ? '⚠ Mittlere Konfidenz' :
                              '✕ Niedrige Konfidenz';
  const color =
    confidence === 'high'   ? 'var(--grid-success, #16a34a)' :
    confidence === 'medium' ? 'var(--grid-warning)' :
                              'var(--grid-danger)';

  return (
    <span
      className="px-2 py-0.5 rounded font-semibold"
      style={{ background: `${color}22`, color }}
      title={`Gemeinsame Tokens: ${result.matchedTokens.join(', ')}`}
    >
      {label} {formatScore(score)}
    </span>
  );
}
