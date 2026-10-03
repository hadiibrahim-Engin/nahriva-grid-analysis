import { motion } from 'framer-motion';
import { useId, useState } from 'react';

type LiquidState = 'sleep' | 'personal';

const spring = {
  type: 'spring' as const,
  stiffness: 500,
  damping: 27,
  mass: 0.78,
};

const capsuleBase =
  'absolute flex h-[72px] w-[238px] items-center justify-between overflow-hidden rounded-full px-7 text-white outline-none';

function SleepIcon() {
  return (
    <span className="relative block h-8 w-8 rounded-full bg-white/90 shadow-[inset_-9px_1px_0_rgba(8,13,11,0.92),0_0_18px_rgba(255,255,255,0.2)]" />
  );
}

function PersonalIcon() {
  return (
    <span className="relative block h-9 w-9 rounded-full border border-white/35 bg-white/10 shadow-[inset_0_1px_6px_rgba(255,255,255,0.2)]">
      <span className="absolute left-1/2 top-2 h-2.5 w-2.5 -translate-x-1/2 rounded-full bg-white/85" />
      <span className="absolute bottom-2 left-1/2 h-3.5 w-5 -translate-x-1/2 rounded-t-full bg-white/85" />
    </span>
  );
}

function MenuDots() {
  return (
    <span className="flex items-center gap-1.5">
      {[0, 1, 2].map((dot) => (
        <span
          key={dot}
          className="h-1.5 w-1.5 rounded-full bg-white/80 shadow-[0_0_7px_rgba(255,255,255,0.45)]"
        />
      ))}
    </span>
  );
}

interface GlassCapsuleProps {
  active: boolean;
  label: string;
  onClick: () => void;
  position: 'sleep' | 'personal';
}

export function GlassCapsule({ active, label, onClick, position }: GlassCapsuleProps) {
  const isSleep = position === 'sleep';

  return (
    <motion.button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`${capsuleBase} ${isSleep ? 'left-0 top-0' : 'bottom-0 right-0'}`}
      animate={{
        y: active ? -10 : 0,
        scale: active ? 1.04 : 1,
      }}
      whileHover={{ scale: active ? 1.048 : 1.018, y: active ? -11 : -3 }}
      whileTap={{ scale: 0.982, y: active ? -6 : 1 }}
      transition={spring}
      style={{
        background:
          'linear-gradient(145deg, rgba(53,61,56,0.58), rgba(13,18,15,0.92) 38%, rgba(2,3,3,0.98) 100%)',
        boxShadow:
          active
            ? '0 34px 54px rgba(0,0,0,0.68), 0 16px 24px rgba(0,0,0,0.48), inset 0 1px 1px rgba(255,255,255,0.42), inset 0 -22px 30px rgba(0,0,0,0.74), inset 0 0 0 1px rgba(255,255,255,0.16)'
            : '0 29px 46px rgba(0,0,0,0.62), 0 11px 18px rgba(0,0,0,0.42), inset 0 1px 1px rgba(255,255,255,0.32), inset 0 -19px 28px rgba(0,0,0,0.72), inset 0 0 0 1px rgba(255,255,255,0.1)',
        backdropFilter: 'blur(18px) saturate(1.08)',
      }}
    >
      <span className="pointer-events-none absolute inset-0 rounded-full bg-[linear-gradient(115deg,rgba(255,255,255,0.14),transparent_28%,transparent_62%,rgba(255,255,255,0.05))]" />
      <span className="pointer-events-none absolute left-8 right-12 top-2 h-px rounded-full bg-white/90 shadow-[0_0_16px_rgba(255,255,255,0.82)]" />
      <span className="pointer-events-none absolute left-7 top-4 h-2.5 w-32 rounded-full bg-white/30 blur-md" />
      <span className="pointer-events-none absolute bottom-2 left-11 h-5 w-40 rounded-full bg-white/12 blur-lg" />
      <span className="pointer-events-none absolute inset-[1px] rounded-full ring-1 ring-inset ring-white/13" />
      <span className="pointer-events-none absolute inset-x-5 bottom-0 h-1/2 rounded-b-full bg-[radial-gradient(ellipse_at_center,rgba(255,255,255,0.1),transparent_62%)]" />
      <span className="pointer-events-none absolute -right-10 top-0 h-24 w-28 rotate-12 bg-white/10 blur-2xl" />
      <span className="pointer-events-none absolute -left-8 bottom-1 h-16 w-24 -rotate-12 bg-black/45 blur-2xl" />

      <span className="relative z-10 flex min-w-0 items-center gap-4">
        {isSleep ? <SleepIcon /> : <PersonalIcon />}
        <span className="text-[15px] font-semibold tracking-[0.16em] text-white/90">
          {label}
        </span>
      </span>
      <span className="relative z-10">
        <MenuDots />
      </span>
    </motion.button>
  );
}

function LiquidBlob({
  active,
  className,
  sleep,
  personal,
  delay = 0,
}: {
  active: LiquidState;
  className: string;
  sleep: { x: number; y: number; scaleX?: number; scaleY?: number; rotate?: number };
  personal: { x: number; y: number; scaleX?: number; scaleY?: number; rotate?: number };
  delay?: number;
}) {
  const target = active === 'sleep' ? sleep : personal;

  return (
    <motion.div
      className={`absolute rounded-full bg-white/88 will-change-transform ${className}`}
      animate={{
        x: target.x,
        y: target.y,
        scaleX: target.scaleX ?? 1,
        scaleY: target.scaleY ?? 1,
        rotate: target.rotate ?? 0,
      }}
      transition={{ ...spring, delay }}
    >
      <motion.span
        className="absolute inset-[10%] rounded-full bg-white/34 blur-md"
        animate={{ scale: [1, 1.08, 0.98, 1], opacity: [0.45, 0.65, 0.5, 0.45] }}
        transition={{ duration: 3.7, repeat: Infinity, ease: 'easeInOut', delay }}
      />
      <motion.span
        className="absolute left-[17%] top-[13%] h-[18%] w-[46%] rounded-full bg-white/85 blur-sm"
        animate={{ x: [0, 4, -2, 0], opacity: [0.72, 0.95, 0.82, 0.72] }}
        transition={{ duration: 4.4, repeat: Infinity, ease: 'easeInOut', delay: delay + 0.1 }}
      />
      <span className="absolute bottom-[12%] right-[13%] h-[24%] w-[36%] rounded-full bg-[#dfe3d9]/22 blur-md" />
    </motion.div>
  );
}

export function LiquidBridge({ active }: { active: LiquidState }) {
  const rawId = useId();
  const filterId = `liquid-goo-${rawId.replace(/:/g, '')}`;

  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      <svg aria-hidden="true" className="absolute h-0 w-0">
        <filter id={filterId}>
          <feGaussianBlur in="SourceGraphic" stdDeviation="12.5" result="blur" />
          <feColorMatrix
            in="blur"
            mode="matrix"
            values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 25 -10"
            result="goo"
          />
          <feBlend in="SourceGraphic" in2="goo" />
        </filter>
      </svg>

      <motion.div
        className="absolute inset-0"
        style={{ filter: `url(#${filterId})` }}
        animate={{ y: [0, -2, 1, 0], scale: [1, 1.012, 0.995, 1] }}
        transition={{ duration: 4.8, repeat: Infinity, ease: 'easeInOut' }}
      >
        <LiquidBlob
          active={active}
          className="h-24 w-36 shadow-[inset_0_11px_18px_rgba(255,255,255,0.52),inset_0_-15px_22px_rgba(105,114,104,0.2),0_8px_18px_rgba(0,0,0,0.18)]"
          sleep={{ x: 99, y: 83, scaleX: 1.62, scaleY: 0.6, rotate: -21 }}
          personal={{ x: 150, y: 112, scaleX: 1.82, scaleY: 0.56, rotate: -21 }}
        />
        <LiquidBlob
          active={active}
          className="h-20 w-28 shadow-[inset_0_8px_18px_rgba(255,255,255,0.48)]"
          sleep={{ x: 122, y: 51, scaleX: 1.18, scaleY: 0.72, rotate: -34 }}
          personal={{ x: 189, y: 139, scaleX: 1.28, scaleY: 0.68, rotate: -34 }}
          delay={0.025}
        />
        <LiquidBlob
          active={active}
          className="h-16 w-24 opacity-95 shadow-[inset_0_-10px_16px_rgba(82,94,84,0.2)]"
          sleep={{ x: 176, y: 96, scaleX: 1.1, scaleY: 0.68, rotate: 12 }}
          personal={{ x: 108, y: 104, scaleX: 1.18, scaleY: 0.64, rotate: 12 }}
          delay={0.045}
        />
        <LiquidBlob
          active={active}
          className="h-12 w-20 bg-white/80 opacity-90"
          sleep={{ x: 211, y: 124, scaleX: 0.86, scaleY: 0.72, rotate: 23 }}
          personal={{ x: 76, y: 76, scaleX: 0.94, scaleY: 0.72, rotate: 23 }}
          delay={0.06}
        />
        <LiquidBlob
          active={active}
          className="h-10 w-16 bg-white/75 opacity-80"
          sleep={{ x: 82, y: 103, scaleX: 0.78, scaleY: 0.68, rotate: -8 }}
          personal={{ x: 236, y: 111, scaleX: 0.86, scaleY: 0.66, rotate: -8 }}
          delay={0.08}
        />
      </motion.div>

      <motion.div
        className="absolute left-[120px] top-[105px] h-5 w-48 -rotate-[28deg] rounded-full bg-white/48 blur-[3px]"
        animate={{
          scaleX: active === 'sleep' ? [1.1, 1.58, 1.18] : [1.18, 1.66, 1.22],
          x: active === 'sleep' ? -18 : 24,
          opacity: [0.36, 0.7, 0.48],
        }}
        transition={{ ...spring, duration: undefined }}
      />
      <motion.div
        className="absolute left-[151px] top-[98px] h-3 w-32 -rotate-[28deg] rounded-full bg-white/72 blur-sm"
        animate={{ x: active === 'sleep' ? -9 : 10, scaleX: active === 'sleep' ? 0.92 : 1.08 }}
        transition={spring}
      />
      <div className="absolute left-[142px] top-[90px] h-1.5 w-24 -rotate-[28deg] rounded-full bg-white/85 blur-[1px]" />
    </div>
  );
}

export default function LiquidButtonScene() {
  const [active, setActive] = useState<LiquidState>('sleep');

  return (
    <section className="min-h-screen bg-[#e8e2d4] px-6 py-10 text-[#141411]">
      <div className="mx-auto flex min-h-[780px] max-w-5xl flex-col items-center justify-center gap-8">
        <h1 className="font-serif text-[clamp(2.5rem,7vw,5.9rem)] font-semibold tracking-[0.075em] text-[#161611]">
          LIQUID BUTTON
        </h1>

        <div className="relative h-[540px] w-full max-w-[790px] overflow-hidden rounded-[34px] bg-[radial-gradient(circle_at_44%_34%,rgba(94,118,96,0.35),transparent_33%),radial-gradient(circle_at_61%_68%,rgba(231,232,214,0.11),transparent_28%),linear-gradient(150deg,#1a231c_0%,#0c120f_48%,#040504_100%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.12),inset_0_-70px_100px_rgba(0,0,0,0.45),0_38px_82px_rgba(26,28,21,0.38)]">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_24%,rgba(0,0,0,0.46)_78%)]" />
          <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,0.025)_1px,transparent_1px),linear-gradient(0deg,rgba(255,255,255,0.018)_1px,transparent_1px)] bg-[length:54px_54px] opacity-20" />
          <div className="absolute left-1/2 top-[61%] h-32 w-[470px] -translate-x-1/2 rotate-[-30deg] rounded-full bg-black/72 blur-2xl" />
          <div className="absolute left-1/2 top-[58%] h-12 w-[390px] -translate-x-1/2 rotate-[-30deg] rounded-full bg-white/8 blur-2xl" />

          <motion.div
            className="absolute left-1/2 top-1/2 h-[292px] w-[430px] -translate-x-1/2 -translate-y-1/2"
            style={{ rotate: -30 }}
          >
            <LiquidBridge active={active} />
            <GlassCapsule
              active={active === 'sleep'}
              label="Sleep"
              position="sleep"
              onClick={() => setActive('sleep')}
            />
            <GlassCapsule
              active={active === 'personal'}
              label="Personal"
              position="personal"
              onClick={() => setActive('personal')}
            />
          </motion.div>

          <motion.div
            aria-hidden="true"
            className="pointer-events-none absolute left-[52%] top-[61%] h-0 w-0"
            animate={{
              x: active === 'sleep' ? [-5, -18, -10] : [18, 32, 24],
              y: active === 'sleep' ? [-12, -22, -14] : [6, 16, 10],
            }}
            transition={{ duration: 2.8, repeat: Infinity, ease: 'easeInOut' }}
          >
            <div className="h-0 w-0 border-b-[17px] border-l-[9px] border-r-[9px] border-b-white border-l-transparent border-r-transparent drop-shadow-[0_5px_10px_rgba(0,0,0,0.45)]" />
            <div className="ml-[7px] h-8 w-1.5 -rotate-12 rounded-full bg-white shadow-[0_0_10px_rgba(255,255,255,0.25)]" />
          </motion.div>
        </div>
      </div>
    </section>
  );
}
