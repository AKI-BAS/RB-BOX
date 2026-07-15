type Bucket = 'fresh' | 'current' | 'aging' | 'old' | 'unknown';

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

function bucketFor(years: number | null): Bucket {
  if (years === null) return 'unknown';
  if (years < 2) return 'fresh';
  if (years < 5) return 'current';
  if (years < 10) return 'aging';
  return 'old';
}

// Fresh reuses the same green as the "published" status badge elsewhere;
// aging reuses the same amber as "pending_review" — old uses the brick-red
// family (brick-50/brick-500 are the exact #FCEBEB / #A32D2D design tokens),
// not pure red, per spec.
const BUCKET_STYLES: Record<Bucket, string> = {
  fresh: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  current: 'bg-paper-muted dark:bg-ink-muted text-paper-soft dark:text-ink-soft',
  aging: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  old: 'bg-brick-50 dark:bg-brick-500/20 text-brick-700 dark:text-[#F09595]',
  unknown: 'border border-paper-border dark:border-ink-border text-paper-faint dark:text-ink-faint',
};

function labelFor(bucket: Bucket, year: number | null, age: number | null, locale: 'is' | 'en'): string {
  switch (bucket) {
    case 'unknown':
      return locale === 'is' ? 'Dagsetning óþekkt' : 'Date unknown';
    case 'fresh':
      return locale === 'is' ? `Nýtt (${year})` : `New (${year})`;
    case 'current':
      return `${year}`;
    case 'aging':
      return locale === 'is' ? `${year} · ${age} ára` : `${year} · ${age} yrs old`;
    case 'old':
      return locale === 'is' ? `${year} · yfir 10 ára` : `${year} · 10+ yrs old`;
  }
}

export function AgeBadge({ date, locale }: { date: Date | string | null; locale: 'is' | 'en' }) {
  let parsed: Date | null = null;
  if (date) {
    const d = typeof date === 'string' ? new Date(date) : date;
    if (!Number.isNaN(d.getTime())) parsed = d;
  }

  let year: number | null = null;
  let age: number | null = null;
  if (parsed) {
    year = parsed.getFullYear();
    age = Math.floor((Date.now() - parsed.getTime()) / MS_PER_YEAR);
  }

  const bucket = bucketFor(age);
  const text = labelFor(bucket, year, age, locale);

  return (
    <span
      className={`h-5 px-1.5 rounded text-[10px] font-medium tracking-wide inline-flex items-center whitespace-nowrap shrink-0 ${BUCKET_STYLES[bucket]}`}
    >
      {text}
    </span>
  );
}
