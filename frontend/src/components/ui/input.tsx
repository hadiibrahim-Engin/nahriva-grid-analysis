import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Error } from './error';

const sizes = {
  xSmall: 'h-6 text-xs rounded-md',
  small: 'h-8 text-sm rounded-md',
  mediumSmall: 'h-10 text-sm rounded-md',
  medium: 'h-10 text-sm rounded-md',
  large: 'h-12 text-base rounded-lg',
};

interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'prefix' | 'size'> {
  size?: keyof typeof sizes;
  prefix?: React.ReactNode | string;
  suffix?: React.ReactNode | string;
  prefixStyling?: boolean | string;
  suffixStyling?: boolean | string;
  error?: string | boolean;
  label?: string;
  value?: string;
  onChange?: (value: string) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  wrapperClassName?: string;
}

export const Input = ({
  placeholder,
  size = 'medium',
  prefix,
  suffix,
  prefixStyling = true,
  suffixStyling = true,
  disabled = false,
  error,
  label,
  value,
  onChange,
  onFocus,
  onBlur,
  inputRef,
  className,
  wrapperClassName,
  ...rest
}: InputProps) => {
  const [internalValue, setInternalValue] = useState(value || '');
  const fallbackRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? fallbackRef;

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setInternalValue(event.target.value);
    onChange?.(event.target.value);
  };

  useEffect(() => {
    if (value !== undefined) setInternalValue(value);
  }, [value]);

  return (
    <div className="flex flex-col gap-2" onClick={() => ref.current?.focus()}>
      {label && <div className="text-[13px] capitalize text-gray-900">{label}</div>}
      <div
        className={clsx(
          'flex items-center font-sans duration-150',
          error
            ? 'shadow-error-input hover:shadow-error-input-hover'
            : 'border border-gray-alpha-400 hover:border-gray-alpha-500 focus-within:border-transparent focus-within:shadow-focus-input',
          sizes[size],
          disabled ? 'cursor-not-allowed bg-gray-100' : 'bg-background-100',
          wrapperClassName,
        )}
      >
        {prefix && (
          <div
            className={clsx(
              'flex h-full items-center justify-center fill-gray-700 text-gray-700',
              prefixStyling === true
                ? 'border-r border-gray-alpha-400 bg-background-200 px-3'
                : `pl-3${!prefixStyling ? '' : ` ${prefixStyling}`}`,
              size === 'large' ? 'rounded-l-lg' : 'rounded-l-md',
            )}
          >
            {prefix}
          </div>
        )}
        <input
          className={clsx(
            'inline-flex w-full appearance-none bg-background-100 text-geist-foreground outline-none placeholder:text-gray-900 placeholder:opacity-70',
            size === 'xSmall' || size === 'mediumSmall' ? 'px-2' : 'px-3',
            disabled && 'cursor-not-allowed bg-gray-100 text-gray-700',
            className,
          )}
          placeholder={placeholder}
          disabled={disabled}
          value={internalValue}
          onChange={handleChange}
          onFocus={onFocus}
          onBlur={onBlur}
          ref={ref}
          {...rest}
        />
        {suffix && (
          <div
            className={clsx(
              'flex h-full items-center justify-center fill-gray-700 text-gray-700',
              suffixStyling === true
                ? 'border-l border-gray-alpha-400 bg-background-200 px-3'
                : `pr-3 ${!suffixStyling ? '' : ` ${suffixStyling}`}`,
              size === 'large' ? 'rounded-r-lg' : 'rounded-r-md',
            )}
          >
            {suffix}
          </div>
        )}
      </div>
      {typeof error === 'string' && <Error size={size === 'large' ? 'large' : 'small'}>{error}</Error>}
    </div>
  );
};
