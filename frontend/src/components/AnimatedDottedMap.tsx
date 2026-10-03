import { useId, useMemo, useState, type CSSProperties } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';

interface MapRoute {
  start: { lat: number; lng: number; label?: string };
  end: { lat: number; lng: number; label?: string };
}

interface AnimatedDottedMapProps {
  routes?: MapRoute[];
  lineColor?: string;
  showLabels?: boolean;
  animationDuration?: number;
  loop?: boolean;
  className?: string;
  muted?: boolean;
}

interface ProjectedPoint {
  x: number;
  y: number;
}

const VIEWBOX_WIDTH = 800;
const VIEWBOX_HEIGHT = 400;

const DEFAULT_ROUTES: MapRoute[] = [
  {
    start: { lat: 50.1109, lng: 8.6821, label: 'Frankfurt' },
    end: { lat: 40.7128, lng: -74.006, label: 'New York' },
  },
  {
    start: { lat: 50.1109, lng: 8.6821, label: 'Frankfurt' },
    end: { lat: 1.3521, lng: 103.8198, label: 'Singapore' },
  },
  {
    start: { lat: 52.52, lng: 13.405, label: 'Berlin' },
    end: { lat: 35.6762, lng: 139.6503, label: 'Tokyo' },
  },
  {
    start: { lat: 48.1351, lng: 11.582, label: 'München' },
    end: { lat: -23.5505, lng: -46.6333, label: 'São Paulo' },
  },
  {
    start: { lat: 51.2277, lng: 6.7735, label: 'Düsseldorf' },
    end: { lat: 59.3293, lng: 18.0686, label: 'Stockholm' },
  },
];

function projectPoint(lat: number, lng: number): ProjectedPoint {
  return {
    x: (lng + 180) * (VIEWBOX_WIDTH / 360),
    y: (90 - lat) * (VIEWBOX_HEIGHT / 180),
  };
}

function createCurvedPath(start: ProjectedPoint, end: ProjectedPoint): string {
  const midX = (start.x + end.x) / 2;
  const midY = Math.min(start.y, end.y) - Math.max(26, Math.abs(start.x - end.x) * 0.13);
  return `M ${start.x} ${start.y} Q ${midX} ${midY} ${end.x} ${end.y}`;
}

function insideEllipse(lng: number, lat: number, cx: number, cy: number, rx: number, ry: number): boolean {
  const dx = (lng - cx) / rx;
  const dy = (lat - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

function looksLikeLand(lng: number, lat: number): boolean {
  return (
    insideEllipse(lng, lat, -105, 49, 54, 23) ||
    insideEllipse(lng, lat, -90, 26, 42, 19) ||
    insideEllipse(lng, lat, -61, -16, 24, 42) ||
    insideEllipse(lng, lat, 16, 49, 33, 15) ||
    insideEllipse(lng, lat, 24, 7, 31, 38) ||
    insideEllipse(lng, lat, 78, 42, 72, 27) ||
    insideEllipse(lng, lat, 104, 13, 38, 23) ||
    insideEllipse(lng, lat, 134, -25, 24, 17)
  );
}

function buildDots(): ProjectedPoint[] {
  const dots: ProjectedPoint[] = [];
  for (let lat = -58; lat <= 72; lat += 5) {
    const rowOffset = Math.abs(Math.round(lat / 5)) % 2 === 0 ? 0 : 3;
    for (let lng = -172 + rowOffset; lng <= 178; lng += 6) {
      if (looksLikeLand(lng, lat)) {
        dots.push(projectPoint(lat, lng));
      }
    }
  }
  return dots;
}

export default function AnimatedDottedMap({
  routes = DEFAULT_ROUTES,
  lineColor = 'var(--grid-info)',
  showLabels = true,
  animationDuration = 2.1,
  loop = true,
  className = '',
  muted = false,
}: AnimatedDottedMapProps) {
  const [hoveredLocation, setHoveredLocation] = useState<string | null>(null);
  const shouldReduceMotion = useReducedMotion();
  const dots = useMemo(() => buildDots(), []);
  const gradientId = useId().replace(/:/g, '');
  const staggerDelay = 0.35;
  const totalAnimationTime = routes.length * staggerDelay + animationDuration;
  const fullCycleDuration = totalAnimationTime + 2;
  const mapDotColor = muted ? 'var(--grid-muted-2)' : 'var(--grid-muted)';

  return (
    <div
      className={`relative w-full overflow-hidden rounded-lg bg-[var(--grid-surface)] ${className}`}
      style={{ color: lineColor }}
    >
      <svg
        viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
        className="h-full w-full select-none"
        preserveAspectRatio="xMidYMid meet"
        aria-hidden
      >
        <defs>
          <linearGradient id={`path-gradient-${gradientId}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0" />
            <stop offset="8%" stopColor="currentColor" stopOpacity="0.96" />
            <stop offset="92%" stopColor="currentColor" stopOpacity="0.96" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
          <filter id={`glow-${gradientId}`}>
            <feGaussianBlur stdDeviation="3.2" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <mask id={`edge-fade-${gradientId}`}>
            <linearGradient id={`edge-gradient-${gradientId}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="white" stopOpacity="0" />
              <stop offset="12%" stopColor="white" stopOpacity="1" />
              <stop offset="88%" stopColor="white" stopOpacity="1" />
              <stop offset="100%" stopColor="white" stopOpacity="0" />
            </linearGradient>
            <rect width={VIEWBOX_WIDTH} height={VIEWBOX_HEIGHT} fill={`url(#edge-gradient-${gradientId})`} />
          </mask>
        </defs>

        <g mask={`url(#edge-fade-${gradientId})`}>
          {dots.map((dot, index) => (
            <circle
              key={`${dot.x}-${dot.y}-${index}`}
              cx={dot.x}
              cy={dot.y}
              r={muted ? 1.35 : 1.75}
              fill={mapDotColor}
              opacity={muted ? 0.18 : 0.28}
            />
          ))}

          {routes.map((route, index) => {
            const start = projectPoint(route.start.lat, route.start.lng);
            const end = projectPoint(route.end.lat, route.end.lng);
            const path = createCurvedPath(start, end);
            const startDelay = index * staggerDelay;
            const startTime = startDelay / fullCycleDuration;
            const endTime = (startDelay + animationDuration) / fullCycleDuration;
            const resetTime = totalAnimationTime / fullCycleDuration;

            return (
              <g key={`${route.start.label}-${route.end.label}-${index}`}>
                <motion.path
                  d={path}
                  fill="none"
                  stroke={`url(#path-gradient-${gradientId})`}
                  strokeWidth={muted ? 1.8 : 3.1}
                  initial={{ pathLength: 0, opacity: 0.2 }}
                  animate={shouldReduceMotion || !loop
                    ? { pathLength: 1, opacity: muted ? 0.5 : 0.95 }
                    : { pathLength: [0, 1, 1, 0], opacity: [0.18, 1, 1, 0.18] }}
                  transition={shouldReduceMotion || !loop
                    ? { duration: animationDuration, delay: startDelay }
                    : {
                        duration: fullCycleDuration,
                        times: [0, 0.42, 0.74, 1],
                        delay: startDelay,
                        ease: 'easeInOut',
                        repeat: Infinity,
                      }}
                />
                {loop && !shouldReduceMotion && (
                  <motion.circle
                    r={muted ? 3.8 : 5}
                    fill="currentColor"
                    filter={`url(#glow-${gradientId})`}
                    initial={{ offsetDistance: '0%', opacity: 0 }}
                    animate={{
                      offsetDistance: ['0%', '0%', '100%', '100%', '100%'],
                      opacity: [0, 0, 1, 0, 0],
                    }}
                    transition={{
                      duration: fullCycleDuration,
                      times: [0, startTime, endTime, resetTime, 1],
                      ease: 'easeInOut',
                      repeat: Infinity,
                    }}
                    style={{ offsetPath: `path('${path}')` } as CSSProperties}
                  />
                )}

                {[route.start, route.end].map((point, pointIndex) => {
                  const projected = pointIndex === 0 ? start : end;
                  return (
                    <motion.g
                      key={`${point.label}-${pointIndex}`}
                      onHoverStart={() => setHoveredLocation(point.label ?? null)}
                      onHoverEnd={() => setHoveredLocation(null)}
                      whileHover={{ scale: 1.18 }}
                      transition={{ type: 'spring', stiffness: 400, damping: 16 }}
                      className="cursor-pointer"
                    >
                      <circle
                        cx={projected.x}
                        cy={projected.y}
                        r={muted ? 4 : 5.4}
                        fill="currentColor"
                        filter={`url(#glow-${gradientId})`}
                      />
                      {!shouldReduceMotion && (
                        <circle cx={projected.x} cy={projected.y} r={muted ? 4 : 5.4} fill="currentColor" opacity="0.45">
                          <animate attributeName="r" from={muted ? 4 : 5.4} to={muted ? 13 : 18} dur="2s" repeatCount="indefinite" />
                          <animate attributeName="opacity" from="0.5" to="0" dur="2s" repeatCount="indefinite" />
                        </circle>
                      )}
                    </motion.g>
                  );
                })}

                {showLabels && !muted && [route.start, route.end].map((point, pointIndex) => {
                  if (!point.label) return null;
                  const projected = pointIndex === 0 ? start : end;
                  return (
                    <g key={`${point.label}-label`}>
                      <foreignObject x={projected.x - 52} y={projected.y - 34} width="104" height="28">
                        <div className="flex h-full items-center justify-center">
                          <span className="rounded border border-[var(--grid-border)] bg-[var(--grid-surface-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--grid-text)] shadow-sm backdrop-blur">
                            {point.label}
                          </span>
                        </div>
                      </foreignObject>
                    </g>
                  );
                })}
              </g>
            );
          })}
        </g>
      </svg>

      <AnimatePresence>
        {hoveredLocation && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            className="absolute bottom-4 left-4 rounded-lg border border-[var(--grid-border)] bg-[var(--grid-surface-soft)] px-3 py-2 text-sm font-medium text-[var(--grid-text)] shadow-lg backdrop-blur sm:hidden"
          >
            {hoveredLocation}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
