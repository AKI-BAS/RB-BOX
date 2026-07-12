import { buildTermRegex } from '@/lib/search/highlight';

/**
 * Renders `text` with `terms` highlighted via <mark> — no
 * dangerouslySetInnerHTML. Splitting on a regex with a single capturing
 * group makes String.split() alternate [unmatched, matched, unmatched, ...],
 * so odd indices are always the matched substrings.
 */
export function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  if (!text) return null;
  const regex = buildTermRegex(terms);
  if (!regex) return <>{text}</>;

  const parts = text.split(regex);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="bg-[#A32D2D]/20 dark:bg-[#A32D2D]/40 text-inherit rounded-sm px-0.5">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}
