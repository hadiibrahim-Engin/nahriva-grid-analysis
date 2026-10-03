import type { DSTData } from '../../api/client';

interface Props {
  data: DSTData;
}

export default function DSTChart({ data }: Props) {
  if (data.events.length === 0) {
    return (
      <div className="text-gray-500 text-sm py-4 text-center">
        Keine Zeitumstellungs-Ereignisse im Zeitraum erkannt
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {data.events.map((e, i) => (
          <div
            key={i}
            className={`rounded-lg p-3 border ${
              e.type === 'spring_forward'
                ? 'bg-yellow-900/20 border-yellow-700'
                : 'bg-blue-900/20 border-blue-700'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="text-lg">{e.type === 'spring_forward' ? '⏩' : '⏪'}</span>
              <div>
                <div className="text-sm font-medium text-gray-200">{e.date}</div>
                <div className="text-xs text-gray-400">
                  {e.type === 'spring_forward'
                    ? `Sommerzeit: Stunde ${e.affected_hour}:00 fehlt`
                    : `Winterzeit: Stunde ${e.affected_hour}:00 doppelt (${e.measurement_count} Messungen)`}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="text-xs text-gray-500 mt-2">
        {data.events.filter((e) => e.type === 'spring_forward').length} Sommerzeitumstellungen,{' '}
        {data.events.filter((e) => e.type === 'fall_back').length} Winterzeitumstellungen
      </div>
    </div>
  );
}
