import { useId } from 'react';

interface BrandLogoProps {
  size?: number;
  className?: string;
}

export default function BrandLogo({ size = 32, className = '' }: BrandLogoProps) {
  const id = useId().replace(/:/g, '');
  const bgId = `brand-bg-${id}`;
  const lineId = `brand-line-${id}`;

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center ${className}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <svg viewBox="0 0 48 48" role="img" className="h-full w-full">
        <defs>
          <linearGradient id={bgId} x1="8" y1="6" x2="42" y2="44" gradientUnits="userSpaceOnUse">
            <stop stopColor="var(--grid-primary)" />
            <stop offset="0.58" stopColor="var(--grid-info)" />
            <stop offset="1" stopColor="var(--grid-success)" />
          </linearGradient>
          <linearGradient id={lineId} x1="10" y1="30" x2="38" y2="16" gradientUnits="userSpaceOnUse">
            <stop stopColor="#ffffff" stopOpacity="0.95" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0.62" />
          </linearGradient>
        </defs>
        <rect x="3.5" y="3.5" width="41" height="41" rx="12" fill={`url(#${bgId})`} />
        <rect x="3.5" y="3.5" width="41" height="41" rx="12" fill="#020617" opacity="0.1" />
        <path
          d="M13 31.5h5.5l4-13 5.2 19 3.6-11H36"
          fill="none"
          stroke={`url(#${lineId})`}
          strokeWidth="3.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="13" cy="31.5" r="2.4" fill="#fff" fillOpacity="0.9" />
        <circle cx="36" cy="26.5" r="2.4" fill="#fff" fillOpacity="0.9" />
        <path d="M13 13h22M13 18h12" stroke="#fff" strokeOpacity="0.3" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </span>
  );
}
