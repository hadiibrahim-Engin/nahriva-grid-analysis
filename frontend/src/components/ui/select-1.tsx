import clsx from 'clsx';
import { Error } from './error';

const sizes = [
  {
    xsmall: 'h-6 text-xs pl-1.5 pr-[22px]',
    small: 'h-8 text-sm pl-3 pr-9',
    medium: 'h-10 text-sm pl-3 pr-9',
    large: 'h-12 text-base pl-3 pr-9 rounded-lg',
  },
  {
    xsmall: 'h-6 text-xs px-[22px]',
    small: 'h-8 text-sm px-9',
    medium: 'h-10 text-sm px-9',
    large: 'h-12 text-base px-9 rounded-lg',
  },
];

export interface Option {
  value: string;
  label: string;
}

interface SelectProps {
  variant?: 'default' | 'ghost';
  options?: Option[];
  label?: string;
  value?: string;
  placeholder?: string;
  size?: keyof typeof sizes[0];
  prefix?: React.ReactNode;
  suffix?: React.ReactNode;
  disabled?: boolean;
  error?: string;
  onChange?: React.ChangeEventHandler<HTMLSelectElement>;
}

const ArrowBottom = () => (
  <svg height="16" strokeLinejoin="round" viewBox="0 0 16 16" width="16" aria-hidden>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M14.0607 5.49999L13.5303 6.03032L8.7071 10.8535C8.31658 11.2441 7.68341 11.2441 7.29289 10.8535L2.46966 6.03032L1.93933 5.49999L2.99999 4.43933L3.53032 4.96966L7.99999 9.43933L12.4697 4.96966L13 4.43933L14.0607 5.49999Z"
    />
  </svg>
);

export const Select = ({
  variant = 'default',
  options,
  label,
  value,
  placeholder,
  size = 'medium',
  suffix,
  prefix,
  disabled = false,
  error,
  onChange,
}: SelectProps) => (
  <div>
    {label && (
      <label htmlFor="select" className="mb-2 block cursor-text font-sans text-[13px] capitalize text-gray-900">
        {label}
      </label>
    )}
    <div
      className={clsx(
        'relative flex items-center',
        disabled
          ? 'fill-[#8f8f8f]'
          : 'fill-[#666666] hover:fill-[#171717] dark:fill-[#a1a1a1] hover:dark:fill-[#ededed]',
      )}
    >
      <select
        id="select"
        disabled={disabled}
        value={value}
        onChange={onChange}
        className={clsx(
          'w-full appearance-none rounded-[5px] border font-sans outline-none duration-200',
          sizes[prefix ? 1 : 0][size],
          disabled
            ? 'cursor-not-allowed bg-gray-100 text-gray-700'
            : variant === 'default'
              ? 'cursor-pointer bg-background-100 text-gray-1000'
              : 'bg-transparent text-accents-5',
          error
            ? 'border-error ring-[3px] ring-red-900-alpha-160 ring-opacity-100'
            : `ring-gray-alpha-500 ring-opacity-100 focus:ring-[3px] ${
                variant === 'default' ? 'border-gray-alpha-400' : 'border-transparent ring-0'
              }`,
        )}
      >
        {placeholder && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options?.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {prefix && (
        <span className={clsx('pointer-events-none absolute inline-flex duration-150', size === 'xsmall' ? 'left-[5px]' : 'left-3')}>
          {prefix}
        </span>
      )}
      <span className={clsx('pointer-events-none absolute inline-flex duration-150', size === 'xsmall' ? 'right-[5px]' : 'right-3')}>
        {suffix || <ArrowBottom />}
      </span>
    </div>
    {error && (
      <div className="mt-2">
        <Error size={size === 'large' ? 'large' : 'small'}>{error}</Error>
      </div>
    )}
  </div>
);
