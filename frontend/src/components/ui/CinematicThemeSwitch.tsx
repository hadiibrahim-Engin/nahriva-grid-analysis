import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Moon, Sun } from 'lucide-react';
import type { ThemeMode } from '../../util/theme';

interface CinematicThemeSwitchProps {
  value: ThemeMode;
  onChange: (value: ThemeMode) => void;
  className?: string;
  size?: 'compact' | 'default';
}

interface Particle {
  id: number;
  delay: number;
  duration: number;
}

function currentSystemIsDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export default function CinematicThemeSwitch({
  value,
  onChange,
  className = '',
  size = 'compact',
}: CinematicThemeSwitchProps) {
  const shouldReduceMotion = useReducedMotion();
  const timeoutRef = useRef<number | null>(null);
  const [mounted, setMounted] = useState(false);
  const [systemIsDark, setSystemIsDark] = useState(false);
  const [particles, setParticles] = useState<Particle[]>([]);
  const [isAnimating, setIsAnimating] = useState(false);

  useEffect(() => {
    setMounted(true);
    setSystemIsDark(currentSystemIsDark());
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChangeMedia = () => setSystemIsDark(media.matches);
    media.addEventListener('change', onChangeMedia);
    return () => {
      media.removeEventListener('change', onChangeMedia);
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    };
  }, []);

  const isDark = mounted && (value === 'dark' || (value === 'system' && systemIsDark));
  const dims = size === 'default'
    ? { track: 'h-11 w-[80px] p-1.5', thumb: 'h-8 w-8', travel: 34, icon: 'h-4 w-4', pad: 'px-3' }
    : { track: 'h-8 w-[58px] p-1', thumb: 'h-6 w-6', travel: 26, icon: 'h-3.5 w-3.5', pad: 'px-2' };

  const particleSet = useMemo<Particle[]>(
    () => [
      { id: 0, delay: 0, duration: 0.52 },
      { id: 1, delay: 0.08, duration: 0.62 },
      { id: 2, delay: 0.16, duration: 0.72 },
    ],
    [],
  );

  const triggerParticles = () => {
    if (shouldReduceMotion) return;
    setParticles(particleSet);
    setIsAnimating(true);
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => {
      setIsAnimating(false);
      setParticles([]);
    }, 950);
  };

  const handleToggle = () => {
    triggerParticles();
    onChange(isDark ? 'light' : 'dark');
  };

  if (!mounted) {
    return <div className={`inline-block ${className}`}><div className={`${dims.track} rounded-full bg-[var(--grid-control)]`} /></div>;
  }

  return (
    <div className={`inline-block ${className}`}>
      <motion.button
        type="button"
        onClick={handleToggle}
        className={`relative flex items-center overflow-hidden rounded-full transition-colors duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--grid-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--grid-bg)] ${dims.track}`}
        style={{
          background: 'linear-gradient(135deg, var(--grid-header) 0%, var(--grid-control) 100%)',
          boxShadow: isDark
            ? 'inset 0 1px 4px rgba(0,0,0,0.72), 0 4px 12px rgba(0,0,0,0.22)'
            : 'inset 0 1px 4px rgba(91,110,130,0.24), 0 4px 12px rgba(15,23,42,0.1)',
          border: '1px solid var(--grid-border)',
        }}
        aria-label={isDark ? 'Helles Design aktivieren' : 'Dunkles Design aktivieren'}
        aria-checked={isDark}
        role="switch"
        whileTap={shouldReduceMotion ? undefined : { scale: 0.98 }}
      >
        <div
          aria-hidden
          className={`absolute inset-0 flex items-center justify-between ${dims.pad}`}
          style={{
            color: 'var(--grid-muted)',
          }}
        >
          <Sun className={dims.icon} />
          <Moon className={dims.icon} />
        </div>

        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-full"
          style={{
            background: isDark
              ? 'radial-gradient(circle at 30% 20%, rgba(112,152,241,0.12), transparent 45%)'
              : 'radial-gradient(circle at 25% 15%, rgba(255,255,255,0.95), transparent 42%)',
          }}
        />

        <motion.div
          className={`relative z-10 flex items-center justify-center overflow-hidden rounded-full ${dims.thumb}`}
          style={{
            background: isDark
              ? 'linear-gradient(145deg, #4675bb 0%, #244c89 100%)'
              : 'linear-gradient(145deg, var(--grid-surface) 0%, var(--grid-control-hover) 100%)',
            boxShadow: isDark
              ? '0 0 14px rgba(112,152,241,0.18), 0 4px 10px rgba(0,0,0,0.36)'
              : '0 4px 10px rgba(15,23,42,0.18), inset 0 1px 2px rgba(255,255,255,1)',
            border: isDark ? '1px solid rgba(112,152,241,0.35)' : '1px solid rgba(255,255,255,0.95)',
          }}
          animate={{ x: isDark ? dims.travel : 0 }}
          transition={shouldReduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 310, damping: 21 }}
        >
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-full"
            style={{
              background: 'linear-gradient(to bottom, rgba(255,255,255,0.34) 0%, transparent 45%, rgba(0,0,0,0.10) 100%)',
              mixBlendMode: 'overlay',
            }}
          />

          {isAnimating && particles.map((particle) => (
            <motion.div key={particle.id} className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <motion.div
                className="absolute rounded-full"
                style={{
                  width: 10,
                  height: 10,
                  background: 'radial-gradient(circle, var(--grid-primary-soft) 0%, transparent 70%)',
                }}
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: isDark ? 5.5 : 7, opacity: [0, 1, 0] }}
                transition={{ duration: particle.duration, delay: particle.delay, ease: 'easeOut' }}
              />
            </motion.div>
          ))}

          {isDark ? (
            <Moon className={`${dims.icon} relative z-10 text-white`} />
          ) : (
            <Sun className={`${dims.icon} relative z-10 text-[var(--grid-warning-text)]`} />
          )}
        </motion.div>
      </motion.button>
    </div>
  );
}
