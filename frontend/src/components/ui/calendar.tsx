import {
  addDays,
  addMonths,
  endOfDay,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isToday,
  isValid,
  isWithinInterval,
  parse,
  startOfDay,
  startOfMonth,
  startOfWeek,
  sub,
  subDays,
  subHours,
  subMinutes,
  subMonths,
  subWeeks,
  subYears,
} from 'date-fns';
import { enUS } from 'date-fns/locale';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, X } from 'lucide-react';
import clsx from 'clsx';
import { twMerge } from 'tailwind-merge';
import { Button } from './button-1';
import { Input } from './input';
import { Material } from './material-1';
import { Select } from './select-1';
import { useClickOutside } from './use-click-outside';

export interface RangeValue {
  start: Date | null;
  end: Date | null;
}

interface PresetValue {
  text: string;
  start: Date;
  end: Date;
}

type Presets = Record<string, PresetValue>;

const ClockIcon = () => (
  <svg height="16" strokeLinejoin="round" viewBox="0 0 16 16" width="16" aria-hidden>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M14.5 8C14.5 11.5899 11.5899 14.5 8 14.5C4.41015 14.5 1.5 11.5899 1.5 8C1.5 4.41015 4.41015 1.5 8 1.5C11.5899 1.5 14.5 4.41015 14.5 8ZM16 8C16 12.4183 12.4183 16 8 16C3.58172 16 0 12.4183 0 8C0 3.58172 3.58172 0 8 0C12.4183 0 16 3.58172 16 8ZM8.75 4.75V4H7.25V4.75V7.875C7.25 8.18976 7.39819 8.48615 7.65 8.675L9.55 10.1L10.15 10.55L11.05 9.35L10.45 8.9L8.75 7.625V4.75Z"
    />
  </svg>
);

const ArrowBottomIcon = ({ className }: { className?: string }) => (
  <svg height="16" strokeLinejoin="round" viewBox="0 0 16 16" width="16" className={clsx('fill-gray-1000', className)} aria-hidden>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M14.0607 5.49999L13.5303 6.03032L8.7071 10.8535C8.31658 11.2441 7.68341 11.2441 7.29289 10.8535L2.46966 6.03032L1.93933 5.49999L2.99999 4.43933L3.53032 4.96966L7.99999 9.43933L12.4697 4.96966L13 4.43933L14.0607 5.49999Z"
    />
  </svg>
);

const parseExactDate = (input: string) => {
  const now = new Date();
  const currentYear = now.getFullYear();
  for (const fmt of ['d MMM yyyy', 'd MMM', 'yyyy-MM-dd']) {
    const date = parse(input.trim(), fmt, now, { locale: enUS });
    if (isValid(date)) {
      if (fmt === 'd MMM') date.setFullYear(currentYear);
      return { [input]: { text: input, start: startOfDay(date), end: endOfDay(date) } };
    }
  }
  return null;
};

const parseRelativeDate = (input: string) => {
  const match = input.match(/(\d+)\s*(day|week|month|year|hour)s?/i);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  const unit = `${match[2].toLowerCase()}s`;
  const now = new Date();
  return { [input]: { text: input, start: startOfDay(sub(now, { [unit]: value })), end: endOfDay(now) } };
};

const parseFixedRange = (input: string) => {
  const match = input.match(/(.+)\s*[-–]\s*(.+)/);
  if (!match) return parseExactDate(input);
  const [, startStr, endStr] = match;
  if (!startStr || !endStr) return null;
  const now = new Date();
  for (const fmt of ['d MMM yyyy', 'd MMM', 'yyyy-MM-dd']) {
    const start = parse(startStr, fmt, now, { locale: enUS });
    const end = parse(endStr, fmt, now, { locale: enUS });
    if (isValid(start) && isValid(end)) {
      if (fmt === 'd MMM') {
        start.setFullYear(now.getFullYear());
        end.setFullYear(now.getFullYear());
      }
      return { [input]: { text: input, start: startOfDay(start), end: endOfDay(end) } };
    }
  }
  return null;
};

const parseDateInput = (input: string) => parseRelativeDate(input) || parseFixedRange(input) || parseExactDate(input);

const filterPresets = (obj: Presets, search: string): Presets => {
  if (!search) return obj;
  const searchWords = search.toLowerCase().split('-').filter(Boolean);
  const filtered = Object.fromEntries(
    Object.entries(obj).filter(([, value]) => {
      const keyLower = value.text.toLowerCase();
      return searchWords.every((word) => keyLower.includes(word));
    }),
  ) as Presets;
  if (Object.keys(filtered).length > 0) return filtered;
  const parsed = parseDateInput(search);
  if (parsed) return parsed;
  const numberMatch = search.match(/\d+/);
  if (!numberMatch) return {};
  const n = Number.parseInt(numberMatch[0], 10);
  const now = new Date();
  return {
    [`last-${n}-days`]: { text: `Last ${n} Days`, start: startOfDay(subDays(now, n)), end: endOfDay(now) },
    [`last-${n}-weeks`]: { text: `Last ${n} Weeks`, start: startOfDay(subWeeks(now, n)), end: endOfDay(now) },
    [`last-${n}-months`]: { text: `Last ${n} Months`, start: startOfDay(subMonths(now, n)), end: endOfDay(now) },
    [`last-${n}-years`]: { text: `Last ${n} Years`, start: startOfDay(subYears(now, n)), end: endOfDay(now) },
  };
};

const formatCompactDate = (date: Date, timezone: string) => formatInTimeZone(date, timezone, 'dd.MM.yyyy');

const typeRelativeTimes = [
  { text: '45m', start: subMinutes(new Date(), 45), end: new Date() },
  { text: '12 hours', start: subHours(new Date(), 12), end: new Date() },
  { text: '10d', start: startOfDay(subDays(new Date(), 10)), end: endOfDay(new Date()) },
  { text: '2 weeks', start: startOfDay(subWeeks(new Date(), 2)), end: endOfDay(new Date()) },
  { text: 'last month', start: startOfDay(subMonths(new Date(), 1)), end: endOfDay(new Date()) },
  { text: 'yesterday', start: startOfDay(subDays(new Date(), 1)), end: endOfDay(subDays(new Date(), 1)) },
  { text: 'today', start: startOfDay(new Date()), end: endOfDay(new Date()) },
];

const typeFixedTimes = [
  { text: 'Jan 1', start: startOfDay(new Date(new Date().getFullYear(), 0, 1)), end: endOfDay(new Date(new Date().getFullYear(), 0, 1)) },
  { text: 'Jan 1 - Jan 2', start: startOfDay(new Date(new Date().getFullYear(), 0, 1)), end: endOfDay(new Date(new Date().getFullYear(), 0, 2)) },
  { text: '1/1', start: startOfDay(new Date(new Date().getFullYear(), 0, 1)), end: endOfDay(new Date(new Date().getFullYear(), 0, 1)) },
  { text: '1/1 - 1/2', start: startOfDay(new Date(new Date().getFullYear(), 0, 1)), end: endOfDay(new Date(new Date().getFullYear(), 0, 2)) },
];

interface CalendarComboboxProps {
  stacked: boolean;
  compact: boolean;
  value: RangeValue | null;
  onChange: (date: RangeValue | null) => void;
  presets: Presets;
  presetIndex?: number;
}

const CalendarCombobox = ({ stacked, compact, value, onChange, presets, presetIndex }: CalendarComboboxProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [currentPreset, setCurrentPreset] = useState<PresetValue | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const filteredPresets = filterPresets(presets, inputValue);
  const close = useCallback(() => setIsOpen(false), []);
  useClickOutside(ref, close);

  const choosePreset = useCallback((next: PresetValue) => {
    setInputValue(next.text);
    setCurrentPreset(next);
    onChange({ start: next.start, end: next.end });
    setIsOpen(false);
  }, [onChange]);

  useEffect(() => {
    const array = Object.entries(presets);
    if (presetIndex !== undefined && presetIndex >= 0 && presetIndex < array.length) {
      choosePreset(array[presetIndex][1]);
    }
  }, [choosePreset, presetIndex, presets]);

  useEffect(() => {
    if (currentPreset && (currentPreset.start !== value?.start || currentPreset.end !== value?.end)) {
      setCurrentPreset(null);
      setInputValue('');
    }
  }, [currentPreset, value]);

  return (
    <div
      ref={ref}
      className={twMerge(clsx('inline-block font-sans text-sm', compact ? 'relative w-[180px]' : 'relative w-[250px]'))}
    >
      <Input
        prefix={compact ? undefined : <ClockIcon />}
        prefixStyling="pl-2.5"
        suffix={<ArrowBottomIcon className={clsx('duration-200', isOpen && 'rotate-180')} />}
        placeholder="Select Period"
        onFocus={() => setIsOpen(true)}
        value={inputValue}
        onChange={setInputValue}
        wrapperClassName={clsx(stacked && !compact && 'rounded-b-none', !stacked && !compact && 'rounded-r-none')}
        className="pl-2 placeholder:!text-gray-1000 placeholder:!opacity-100"
      />
      <Material
        type="menu"
        className={clsx(
          'absolute left-0 top-12 z-[920]',
          compact ? 'w-full' : 'grid w-[200%] grid-cols-2',
          isOpen ? 'opacity-100' : 'pointer-events-none opacity-0 duration-200',
        )}
      >
        <ul className="border-r border-r-gray-200 p-2">
          {Object.entries(filteredPresets).length > 0 ? (
            Object.entries(filteredPresets).map(([key, next]) => (
              <li
                key={key}
                className="flex h-9 w-full cursor-pointer items-center rounded-md px-2 font-sans text-sm text-gray-1000 hover:bg-gray-alpha-300 active:bg-gray-alpha-300"
                onClick={() => choosePreset(next)}
              >
                {next.text}
              </li>
            ))
          ) : (
            <li className="flex h-9 w-full items-center rounded-md px-2 font-sans text-sm text-gray-1000">{inputValue}</li>
          )}
        </ul>
        {!compact && (
          <div className="p-4 pr-[30px]">
            <div className="font-sans text-sm text-gray-900">Type relative times</div>
            <div className="mt-2 flex flex-wrap gap-1">
              {typeRelativeTimes.map((next) => (
                <button key={next.text} className="inline-flex h-5 cursor-pointer items-center rounded border-none bg-accents-2 px-1.5 font-mono text-[13px] text-gray-1000" onClick={() => choosePreset(next)}>
                  {next.text}
                </button>
              ))}
            </div>
            <div className="mt-4 font-sans text-sm text-gray-900">Type fixed times</div>
            <div className="mt-2 flex flex-wrap gap-1">
              {typeFixedTimes.map((next) => (
                <button key={next.text} className="inline-flex h-5 cursor-pointer items-center rounded border-none bg-accents-2 px-1.5 font-mono text-[13px] text-gray-1000" onClick={() => choosePreset(next)}>
                  {next.text}
                </button>
              ))}
            </div>
          </div>
        )}
      </Material>
    </div>
  );
};

interface CalendarProps {
  allowClear?: boolean;
  compact?: boolean;
  isDocsPage?: boolean;
  stacked?: boolean;
  horizontalLayout?: boolean;
  showTimeInput?: boolean;
  popoverAlignment?: 'start' | 'center' | 'end';
  value: RangeValue | null;
  onChange: (date: RangeValue | null) => void;
  presets?: Presets;
  presetIndex?: number;
  minValue?: Date;
  maxValue?: Date;
}

export const Calendar = ({
  allowClear = false,
  compact = false,
  isDocsPage = false,
  stacked = false,
  horizontalLayout = false,
  showTimeInput = true,
  popoverAlignment = 'start',
  value,
  onChange,
  presets,
  presetIndex,
  minValue,
  maxValue,
}: CalendarProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [currentDate, setCurrentDate] = useState(new Date());
  const [hoverDate, setHoverDate] = useState<Date | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const timezones = useMemo(
    () => [
      { value: 'UTC', label: 'UTC' },
      {
        value: Intl.DateTimeFormat().resolvedOptions().timeZone,
        label: `Local (${Intl.DateTimeFormat().resolvedOptions().timeZone})`,
      },
    ],
    [],
  );
  const [selectedTimezone, setSelectedTimezone] = useState(timezones[1].value);
  const [startDate, setStartDate] = useState(formatInTimeZone(value?.start || new Date(), selectedTimezone, 'MMM dd, yyyy'));
  const [startTime, setStartTime] = useState(formatInTimeZone(value?.start || startOfDay(new Date()), selectedTimezone, 'HH:mm'));
  const [endDate, setEndDate] = useState(formatInTimeZone(value?.end || new Date(), selectedTimezone, 'MMM dd, yyyy'));
  const [endTime, setEndTime] = useState(formatInTimeZone(value?.end || endOfDay(new Date()), selectedTimezone, 'HH:mm'));
  const [startDateError, setStartDateError] = useState(false);
  const [startTimeError, setStartTimeError] = useState(false);
  const [endDateError, setEndDateError] = useState(false);
  const [endTimeError, setEndTimeError] = useState(false);
  const calendarRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setIsOpen(false), []);
  useClickOutside(calendarRef, close);

  useEffect(() => {
    const closeOnViewportChange = () => setIsOpen(false);
    window.addEventListener('resize', closeOnViewportChange);
    window.addEventListener('scroll', closeOnViewportChange, true);
    return () => {
      window.removeEventListener('resize', closeOnViewportChange);
      window.removeEventListener('scroll', closeOnViewportChange, true);
    };
  }, []);

  const daysArray = useMemo(() => {
    const days: Date[] = [];
    let day = startOfWeek(startOfMonth(currentDate), { weekStartsOn: 1 });
    const lastDay = endOfWeek(endOfMonth(currentDate), { weekStartsOn: 1 });
    while (day <= lastDay) {
      days.push(day);
      day = addDays(day, 1);
    }
    return days;
  }, [currentDate]);

  const handleDateClick = (day: Date) => {
    if (!value?.start || (value.start && value.end)) {
      onChange({ start: startOfDay(day), end: null });
      setHoverDate(day);
      setIsSelecting(true);
    } else if (isSelecting) {
      if (day > value.start) {
        onChange({ ...value, end: endOfDay(day) });
      } else {
        onChange({ start: startOfDay(day), end: endOfDay(value.start) });
      }
      setIsSelecting(false);
      setHoverDate(null);
      setIsOpen(false);
    }
  };

  const onApply = () => {
    const parsedStartDate = parse(startDate, 'MMM dd, yyyy', new Date());
    const parsedStartTime = parse(startTime || '', 'HH:mm', new Date());
    const parsedEndDate = parse(endDate, 'MMM dd, yyyy', new Date());
    const parsedEndTime = parse(endTime || '', 'HH:mm', new Date());
    const hasStartDateError = parsedStartDate.toString() === 'Invalid Date';
    const hasStartTimeError = parsedStartTime.toString() === 'Invalid Date';
    const hasEndDateError = parsedEndDate.toString() === 'Invalid Date';
    const hasEndTimeError = parsedEndTime.toString() === 'Invalid Date';
    setStartDateError(hasStartDateError);
    setStartTimeError(hasStartTimeError);
    setEndDateError(hasEndDateError);
    setEndTimeError(hasEndTimeError);
    if (hasStartDateError || hasStartTimeError || hasEndDateError || hasEndTimeError) return;
    const parsedStart = parse(`${startDate} ${startTime}`, 'MMM d, yyyy HH:mm', new Date());
    const parsedEnd = parse(`${endDate} ${endTime}`, 'MMM d, yyyy HH:mm', new Date());
    onChange({ start: fromZonedTime(parsedStart, selectedTimezone), end: fromZonedTime(parsedEnd, selectedTimezone) });
    setIsOpen(false);
  };

  useEffect(() => {
    setStartDate(formatInTimeZone(value?.start || new Date(), selectedTimezone, 'MMM dd, yyyy'));
    setStartTime(formatInTimeZone(value?.start || startOfDay(new Date()), selectedTimezone, 'HH:mm'));
    setEndDate(formatInTimeZone(value?.end || new Date(), selectedTimezone, 'MMM dd, yyyy'));
    setEndTime(formatInTimeZone(value?.end || endOfDay(new Date()), selectedTimezone, 'HH:mm'));
  }, [isOpen, selectedTimezone, value]);

  return (
    <div className="relative" data-docs-page={isDocsPage || undefined}>
      <div className={clsx(presets && 'flex', presets && stacked && 'flex-col', compact && 'w-[220px]')}>
        {presets && (
          <CalendarCombobox
            stacked={stacked}
            compact={compact}
            presets={presets}
            value={value}
            onChange={onChange}
            presetIndex={presetIndex}
          />
        )}
        <div className="flex items-center justify-between">
          <div className={clsx('relative', compact ? 'w-[220px]' : 'w-[250px]')}>
            <button
              type="button"
              onClick={() => setIsOpen((prevState) => !prevState)}
              className={clsx(
                'group flex h-10 w-full items-center gap-2 rounded-lg border border-gray-alpha-400 bg-background-100 px-2.5 text-left text-gray-1000 shadow-border-small transition',
                'hover:border-gray-alpha-500 hover:bg-gray-alpha-100 focus:outline-none focus:shadow-focus-input',
                isOpen && 'border-blue-900 shadow-focus-input',
                presets && !stacked && !compact && 'rounded-l-none -ml-px',
                presets && stacked && !compact && 'rounded-t-none -mt-px',
                presets && compact && 'rounded-r-none -mr-px',
              )}
              aria-expanded={isOpen}
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-blue-900/15 text-blue-900">
                <CalendarDays size={16} strokeWidth={2} />
              </span>
              {value?.start && value?.end ? (
                <span className="grid min-w-0 flex-1 grid-cols-[1fr_auto_1fr] items-center gap-1.5 text-xs">
                  <span className="truncate rounded-md bg-gray-alpha-100 px-2 py-1 font-medium text-gray-1000">
                    {formatCompactDate(value.start, selectedTimezone)}
                  </span>
                  <span className="text-gray-700">-</span>
                  <span className="truncate rounded-md bg-gray-alpha-100 px-2 py-1 font-medium text-gray-1000">
                    {formatCompactDate(value.end, selectedTimezone)}
                  </span>
                </span>
              ) : (
                <span className="min-w-0 flex-1 truncate text-sm text-gray-700">Zeitraum wählen</span>
              )}
              <ChevronDown
                size={16}
                className={clsx('shrink-0 text-gray-700 transition-transform duration-200', isOpen && 'rotate-180 text-gray-1000')}
              />
            </button>
            {allowClear && value?.start && value?.end && (
              <button
                type="button"
                aria-label="Clear input value"
                className="absolute right-8 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-gray-700 transition hover:bg-gray-alpha-200 hover:text-gray-1000"
                onClick={() => onChange(null)}
              >
                <X size={13} />
              </button>
            )}
          </div>
        </div>
      </div>
      {isOpen && (
        <Material
          ref={calendarRef}
          type="menu"
          className={twMerge(clsx(
            'absolute top-12 z-[920] border border-gray-alpha-400 !bg-background-100 p-4 font-sans shadow-2xl shadow-black/40',
            horizontalLayout ? 'w-[520px]' : 'w-[340px]',
            presets && !stacked && !compact && 'left-[250px]',
            presets && stacked && 'top-[88px]',
            popoverAlignment === 'center' && 'left-[125px] -translate-x-1/2',
            popoverAlignment === 'end' && 'left-[250px] -translate-x-full',
          ))}
        >
          <div className={clsx(horizontalLayout && 'flex gap-5')}>
            <div>
              <div className="mb-4 flex items-center justify-between rounded-lg border border-gray-alpha-200 bg-gray-alpha-100 px-2 py-1.5">
                <h2 className="px-1 text-sm font-semibold text-gray-1000">
                  {formatInTimeZone(currentDate, selectedTimezone, 'MMMM yyyy')}
                </h2>
                <div className="flex gap-1">
                  <button
                    type="button"
                    aria-label="Vorheriger Monat"
                    onClick={() => setCurrentDate(subMonths(currentDate, 1))}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-gray-700 transition hover:bg-gray-alpha-200 hover:text-gray-1000"
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <button
                    type="button"
                    aria-label="Nächster Monat"
                    onClick={() => setCurrentDate(addMonths(currentDate, 1))}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-gray-700 transition hover:bg-gray-alpha-200 hover:text-gray-1000"
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
              </div>
              <div className="mb-2 grid grid-cols-7 text-center text-[11px] font-semibold uppercase tracking-wide text-gray-700">
                <div>M</div><div>T</div><div>W</div><div>T</div><div>F</div><div>S</div><div>S</div>
              </div>
              <div className="grid grid-cols-7 items-center gap-y-1">
                {daysArray.map((day) => {
                  const isStart = value?.start && isSameDay(day, value.start);
                  const isEnd = value?.end && isSameDay(day, value.end);
                  const currentHover = hoverDate && isSelecting && isSameDay(day, hoverDate);
                  const rangeEnd = value?.end || hoverDate;
                  const isInRange = value?.start && rangeEnd && isWithinInterval(day, {
                    start: value.start <= rangeEnd ? value.start : rangeEnd,
                    end: value.start <= rangeEnd ? rangeEnd : value.start,
                  });
                  const isAllowedDate = (minValue ? day >= startOfDay(minValue) : true) && (maxValue ? day <= endOfDay(maxValue) : true);
                  return (
                    <div
                      key={day.toString()}
                      className={clsx(
                        'flex items-center justify-center rounded text-center text-sm transition',
                        isSameMonth(day, currentDate) && isAllowedDate ? 'text-gray-1000' : 'text-gray-700',
                        isInRange && !isStart && !isEnd && !currentHover && 'bg-blue-900/10',
                        isAllowedDate ? 'cursor-pointer' : 'cursor-not-allowed',
                      )}
                      onMouseEnter={() => isAllowedDate && value?.start && !value.end && setHoverDate(day)}
                      onClick={() => isAllowedDate && handleDateClick(day)}
                    >
                      <div
                        className={clsx(
                          'flex h-8 w-8 items-center justify-center rounded-md border border-transparent font-medium transition',
                          (isStart || isEnd || currentHover) && isAllowedDate && '!border-blue-900 !bg-blue-900 !text-background-100 shadow-border-small',
                          !isStart && !isEnd && !currentHover && !isToday(day) && isAllowedDate && 'hover:border-gray-alpha-500 hover:bg-gray-alpha-100 hover:text-gray-1000',
                          currentHover && isAllowedDate && '!shadow-focus-calendar-date',
                          isToday(day) && !isStart && !isEnd && '!border-blue-900/60 !text-blue-900',
                        )}
                      >
                        {format(day, 'd')}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className={clsx('flex flex-col gap-3', horizontalLayout ? 'justify-between' : '-mx-4 mt-4 border-t border-gray-alpha-200 px-4 pt-3')}>
              <div className="flex flex-col gap-2">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-700">Start</div>
                  <div className="mt-1 grid grid-cols-3 gap-2">
                    <div className={showTimeInput ? 'col-span-2' : 'col-span-3'}>
                      <Input size="small" value={startDate} onChange={setStartDate} error={startDateError} />
                    </div>
                    {showTimeInput && <Input size="small" value={startTime} onChange={setStartTime} error={startTimeError} />}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-700">Ende</div>
                  <div className="mt-1 grid grid-cols-3 gap-2">
                    <div className={showTimeInput ? 'col-span-2' : 'col-span-3'}>
                      <Input size="small" value={endDate} onChange={setEndDate} error={endDateError} />
                    </div>
                    {showTimeInput && <Input size="small" value={endTime} onChange={setEndTime} error={endTimeError} />}
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex flex-col font-medium">
                  <Button
                    type="primary"
                    size="small"
                    prefix={<Check size={14} />}
                    onClick={onApply}
                    className="!justify-center"
                  >
                    Anwenden
                  </Button>
                </div>
                <div className="w-fit self-center">
                  <Select
                    size="xsmall"
                    variant="ghost"
                    options={timezones}
                    value={selectedTimezone}
                    onChange={(event) => setSelectedTimezone(event.target.value)}
                  />
                </div>
              </div>
            </div>
          </div>
        </Material>
      )}
    </div>
  );
};
