'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface AdminTabsProps {
  tabs: Array<{ href: string; label: string; count: number }>;
}

export function AdminTabs({ tabs }: AdminTabsProps) {
  const pathname = usePathname();

  // overflow-x-auto alone isn't enough: per the CSS spec, when one axis is
  // set to anything but 'visible', the browser computes the OTHER (unset)
  // axis as 'auto' too — 'visible' can't be mixed with a non-visible value
  // on the perpendicular axis. Left unset, that silently made this
  // horizontal tab strip vertically scrollable too; overflow-y-hidden pins
  // it to horizontal-only.
  return (
    <nav className="border-b border-paper-border dark:border-ink-border flex gap-1 mb-8 overflow-x-auto overflow-y-hidden">
      {tabs.map((tab) => {
        const active = pathname === tab.href || pathname?.startsWith(tab.href + '/');
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`group relative px-3 py-2.5 text-[13px] flex items-center gap-2 -mb-px border-b-2 transition whitespace-nowrap ${
              active
                ? 'border-brick-500 text-brick-500 font-medium'
                : 'border-transparent text-paper-soft dark:text-ink-soft hover:text-brick-500 hover:border-brick-500/40'
            }`}
          >
            <span>{tab.label}</span>
            <span
              className={`text-[10px] font-mono tabular-nums px-1.5 py-0.5 rounded transition ${
                active
                  ? 'bg-brick-500/15 text-brick-700 dark:bg-brick-500/20 dark:text-brick-200'
                  : 'bg-paper-muted dark:bg-ink-muted text-paper-faint dark:text-ink-faint group-hover:bg-brick-500/10 group-hover:text-brick-500'
              }`}
            >
              {tab.count}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
