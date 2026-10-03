/**
 * AnimatedButton – a Framer Motion–powered button wrapper that adds:
 *  • spring-based press (scale-down on tap/click)
 *  • smooth hover glow / lift
 *  • ripple burst on pointer-down
 *  • disabled state handled gracefully (no motion when disabled)
 *
 * Usage:
 *   <AnimatedButton variant="primary" onClick={…}>Add</AnimatedButton>
 *   <AnimatedButton variant="ghost" size="sm" icon={<PdfIcon />}>PDF</AnimatedButton>
 */
import { useRef, useState } from 'react';
import { motion, useSpring, useTransform, type HTMLMotionProps } from 'framer-motion';

// -- types --------------------------------------------------------------------

export type ButtonVariant =
  | 'primary'   // blue filled
  | 'secondary' // ghost bordered
  | 'ghost'     // barely-there
  | 'danger'    // red
  | 'success'   // green
  | 'csv'       // teal/cyan accent
  | 'pdf';      // amber/warm accent

export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

interface AnimatedButtonProps extends Omit<HTMLMotionProps<'button'>, 'children'> {
  children: React.ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Icon shown to the LEFT of children */
  icon?: React.ReactNode;
  /** Icon shown to the RIGHT of children */
  iconRight?: React.ReactNode;
  /** Show a spinner instead of icon (keeps width stable) */
  loading?: boolean;
  /** Passed through to the native button */
  disabled?: boolean;
  className?: string;
}

// -- variant tokens ------------------------------------------------------------

const VARIANT_BASE: Record<ButtonVariant, string> = {
  primary:   'bg-[var(--grid-primary)] hover:bg-[var(--grid-primary-hover)] text-white border border-transparent',
  secondary: 'bg-transparent border border-[var(--grid-border)] text-[var(--grid-text)] hover:bg-[var(--grid-control-hover)]',
  ghost:     'bg-transparent border border-transparent text-[var(--grid-muted)] hover:text-[var(--grid-text)] hover:bg-[var(--grid-control-hover)]',
  danger:    'bg-[var(--grid-danger)] hover:opacity-90 text-white border border-transparent',
  success:   'bg-[var(--grid-success)] hover:opacity-90 text-white border border-transparent',
  csv:       'bg-blue-700 hover:bg-blue-600 text-white border border-transparent',
  pdf:       'bg-[var(--grid-surface-strong)] hover:bg-[var(--grid-control-hover)] text-[var(--grid-text)] border border-[var(--grid-border)]',
};

const VARIANT_GLOW: Record<ButtonVariant, string> = {
  primary:   '0 0 18px rgba(47,128,255,0.45)',
  secondary: '0 0 12px rgba(47,128,255,0.18)',
  ghost:     'none',
  danger:    '0 0 18px rgba(242,95,92,0.40)',
  success:   '0 0 18px rgba(34,197,94,0.38)',
  csv:       '0 0 16px rgba(29,78,216,0.42)',
  pdf:       '0 0 14px rgba(47,128,255,0.20)',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  xs: 'px-2 py-0.5 text-[11px] rounded gap-1',
  sm: 'px-2.5 py-1 text-xs rounded gap-1.5',
  md: 'px-3.5 py-1.5 text-sm rounded-md gap-2',
  lg: 'px-5 py-2.5 text-base rounded-lg gap-2.5',
};

// -- ripple --------------------------------------------------------------------

interface Ripple { id: number; x: number; y: number }

// -- component -----------------------------------------------------------------

export default function AnimatedButton({
  children,
  variant = 'primary',
  size = 'sm',
  icon,
  iconRight,
  loading = false,
  disabled = false,
  className = '',
  onClick,
  onPointerDown,
  ...rest
}: AnimatedButtonProps) {
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const rippleCounter = useRef(0);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // spring for subtle vertical lift on hover
  const y = useSpring(0, { stiffness: 380, damping: 28, mass: 0.6 });
  const boxShadow = useTransform(y, [-2, 0], [VARIANT_GLOW[variant], 'none']);

  function handlePointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    if (disabled || loading) return;
    onPointerDown?.(e as never);
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const id = ++rippleCounter.current;
    setRipples((prev) => [...prev, { id, x: e.clientX - rect.left, y: e.clientY - rect.top }]);
    setTimeout(() => setRipples((prev) => prev.filter((r) => r.id !== id)), 600);
  }

  const isInert = disabled || loading;

  return (
    <motion.button
      ref={buttonRef}
      type="button"
      disabled={isInert}
      onPointerDown={handlePointerDown}
      onClick={isInert ? undefined : onClick as never}
      // hover / press spring
      onHoverStart={() => !isInert && y.set(-2)}
      onHoverEnd={() => y.set(0)}
      // scale spring on press
      whileTap={isInert ? {} : { scale: 0.94 }}
      animate={isInert ? { scale: 1 } : undefined}
      transition={{ type: 'spring', stiffness: 420, damping: 22 }}
      style={{ y, boxShadow }}
      className={[
        'relative inline-flex items-center justify-center font-semibold',
        'overflow-hidden select-none cursor-pointer',
        'transition-colors duration-150',
        'disabled:cursor-not-allowed disabled:opacity-40',
        'dashboard-glass-button',
        `dashboard-glass-button--${variant}`,
        VARIANT_BASE[variant],
        SIZE_CLASS[size],
        className,
      ].join(' ')}
      {...(rest as object)}
    >
      {/* ripple layer */}
      {ripples.map((r) => (
        <span
          key={r.id}
          aria-hidden
          style={{
            position: 'absolute',
            left: r.x,
            top: r.y,
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.30)',
            transform: 'translate(-50%,-50%) scale(1)',
            animation: 'btn-ripple 0.55s ease-out forwards',
            pointerEvents: 'none',
          }}
        />
      ))}

      {/* spinner or icon left */}
      {loading ? (
        <span
          aria-hidden
          className="h-3.5 w-3.5 rounded-full border-2 border-current border-t-transparent animate-spin shrink-0"
        />
      ) : icon ? (
        <span aria-hidden className="shrink-0 leading-none">{icon}</span>
      ) : null}

      <span className="truncate">{children}</span>

      {iconRight && !loading && (
        <span aria-hidden className="shrink-0 leading-none">{iconRight}</span>
      )}
    </motion.button>
  );
}
