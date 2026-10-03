import clsx from 'clsx';
import { Spinner } from './spinner-1';

const sizes = [
  {
    tiny: 'px-1.5 h-6 text-sm',
    small: 'px-1.5 h-8 text-sm',
    medium: 'px-2.5 h-10 text-sm',
    large: 'px-3.5 h-12 text-base',
  },
  {
    tiny: 'w-6 h-6 text-sm',
    small: 'w-8 h-8 text-sm',
    medium: 'w-10 h-10 text-sm',
    large: 'w-12 h-12 text-base',
  },
];

const types = {
  primary: 'bg-gray-1000 fill-background-100 text-background-100 hover:bg-gray-1000-h',
  secondary: 'border border-gray-alpha-400 bg-background-100 fill-gray-1000 text-gray-1000 hover:bg-gray-alpha-200',
  tertiary: 'bg-transparent fill-gray-1000 text-gray-1000 hover:bg-gray-alpha-200',
  error: 'bg-red-800 fill-white text-white hover:bg-red-900',
  warning: 'bg-amber-800 fill-black text-black hover:bg-amber-850',
};

const shapes = {
  square: {
    tiny: 'rounded',
    small: 'rounded-md',
    medium: 'rounded-md',
    large: 'rounded-lg',
  },
  circle: {
    tiny: 'rounded-full',
    small: 'rounded-full',
    medium: 'rounded-full',
    large: 'rounded-full',
  },
  rounded: {
    tiny: 'rounded-full',
    small: 'rounded-full',
    medium: 'rounded-full',
    large: 'rounded-full',
  },
};

export interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'prefix'> {
  size?: keyof typeof sizes[0];
  type?: keyof typeof types;
  variant?: 'styled' | 'unstyled';
  shape?: keyof typeof shapes;
  svgOnly?: boolean;
  children?: React.ReactNode;
  prefix?: React.ReactNode;
  suffix?: React.ReactNode;
  shadow?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
  buttonType?: React.ButtonHTMLAttributes<HTMLButtonElement>['type'];
}

export const Button = ({
  size = 'medium',
  type = 'primary',
  variant = 'styled',
  shape = 'square',
  svgOnly = false,
  children,
  prefix,
  suffix,
  shadow = false,
  loading = false,
  disabled = false,
  fullWidth = false,
  buttonType = 'button',
  className,
  ...rest
}: ButtonProps) => (
  <button
    type={buttonType}
    disabled={disabled}
    tabIndex={0}
    className={clsx(
      'flex items-center justify-center gap-0.5 duration-150',
      sizes[+svgOnly][size],
      disabled || loading
        ? 'cursor-not-allowed border border-gray-400 bg-gray-100 text-gray-700'
        : types[type],
      shapes[shape][size],
      shadow && 'border-none shadow-border-small',
      fullWidth && 'w-full',
      variant === 'unstyled'
        ? 'h-fit bg-transparent px-0 text-gray-1000 outline-none hover:bg-transparent'
        : 'focus:outline-0 focus:shadow-focus-ring',
      className,
    )}
    {...rest}
  >
    {loading ? <Spinner size={size === 'large' ? 24 : 16} /> : prefix}
    <span
      className={clsx(
        'relative overflow-hidden overflow-ellipsis whitespace-nowrap font-sans',
        size !== 'tiny' && variant !== 'unstyled' && 'px-1.5',
      )}
    >
      {children}
    </span>
    {!loading && suffix}
  </button>
);
