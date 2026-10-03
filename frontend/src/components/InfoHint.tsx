interface Props {
  text: string;
}

export default function InfoHint({ text }: Props) {
  return (
    <span
      aria-label={text}
      className="inline-flex h-3 w-3 shrink-0 items-center justify-center rounded-full border border-gray-500/70 text-[8px] font-semibold leading-none text-gray-400"
    >
      i
    </span>
  );
}
