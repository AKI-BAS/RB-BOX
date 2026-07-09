'use client';

import { t, type Lang } from '@/lib/i18n';
import type { Source, Category, Database } from '@/types/database';

type AccessLevel = Database['public']['Tables']['documents']['Row']['access_level'];

export interface Filters {
  access: Set<AccessLevel>;
  sources: Set<string>;
  category: string | null;
}

interface BrowsePanelProps {
  lang: Lang;
  sources: Source[];
  sourceCounts: Record<string, number>;
  categories: Category[];
  filters: Filters;
  onChange: (f: Filters) => void;
  onClose: () => void;
}

const ACCESS_LEVELS: Array<{
  key: 'open' | 'internal' | 'restricted' | 'paid';
}> = [
  { key: 'open' },
  { key: 'internal' },
  { key: 'restricted' },
  { key: 'paid' },
];

function toggle<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function CheckSquare({ checked }: { checked: boolean }) {
  return (
    <span
      className={`w-3.5 h-3.5 rounded-[3px] border flex items-center justify-center transition shrink-0 ${
        checked
          ? 'bg-brick-500 border-brick-500'
          : 'border-paper-border dark:border-ink-border group-hover:border-brick-500/50'
      }`}
    >
      {checked && (
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
    </span>
  );
}

export function BrowsePanel({
  lang,
  sources,
  sourceCounts,
  categories,
  filters,
  onChange,
  onClose,
}: BrowsePanelProps) {

  const activeCount =
    filters.access.size +
    filters.sources.size +
    (filters.category ? 1 : 0);

  const roots = categories.filter((c) => !c.parent_id);
  const childrenOf = (id: string) =>
    categories.filter((c) => c.parent_id === id);

  return (
    <aside className="w-full sm:w-[248px] shrink-0 rounded-xl border border-paper-border dark:border-ink-border bg-paper-surface dark:bg-ink-surface flex flex-col overflow-hidden">
      {/* Panel header */}
      <div className="px-4 h-[42px] flex items-center justify-between border-b border-paper-border dark:border-ink-border">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-medium">
            {t(lang, 'browse')}
          </span>
          <kbd>[</kbd>
        </div>
        <button
          onClick={onClose}
          className="text-paper-faint dark:text-ink-faint hover:text-brick-500 transition p-2 -m-2"
          title={t(lang, 'browse')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
        {/* Access */}
        <section>
          <h3 className="section-label mb-2.5">{t(lang, 'access')}</h3>
          <ul className="space-y-1.5">
            {ACCESS_LEVELS.map(({ key }) => {
              const checked = filters.access.has(key);
              return (
                <li key={key}>
                  <label className="flex items-center gap-2.5 text-[13px] cursor-pointer group">
                    <CheckSquare checked={checked} />
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        onChange({
                          ...filters,
                          access: toggle(filters.access, key),
                        })
                      }
                      className="sr-only"
                    />
                    <span className={`transition ${checked ? '' : 'text-paper-soft dark:text-ink-soft'} group-hover:text-brick-500`}>
                      {t(lang, key)}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </section>

        {/* Source */}
        <section>
          <h3 className="section-label mb-2.5">{t(lang, 'source')}</h3>
          <ul className="space-y-1.5">
            {sources.length === 0 && (
              <li className="text-[11px] text-paper-faint dark:text-ink-faint italic">
                {lang === 'is' ? 'Engar heimildir enn' : 'No sources yet'}
              </li>
            )}
            {sources.map((s) => {
              const checked = filters.sources.has(s.id);
              const count = sourceCounts[s.id] ?? 0;
              return (
                <li key={s.id}>
                  <label className="flex items-center gap-2.5 text-[13px] cursor-pointer group">
                    <CheckSquare checked={checked} />
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        onChange({
                          ...filters,
                          sources: toggle(filters.sources, s.id),
                        })
                      }
                      className="sr-only"
                    />
                    <span className={`flex-1 truncate transition ${checked ? '' : 'text-paper-soft dark:text-ink-soft'} group-hover:text-brick-500`}>
                      {lang === 'en' && s.name_en ? s.name_en : s.name}
                    </span>
                    <span className="text-[10.5px] font-mono text-paper-faint dark:text-ink-faint tabular-nums shrink-0">
                      {count}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </section>

        {/* Categories — muted by default, accent only on the active one */}
        <section>
          <h3 className="section-label mb-2.5">{t(lang, 'category')}</h3>
          <ul className="space-y-0.5">
            {categories.length === 0 && (
              <li className="text-[11px] text-paper-faint dark:text-ink-faint italic">
                {lang === 'is' ? 'Engir flokkar enn' : 'No categories yet'}
              </li>
            )}
            {roots.map((c) => {
              const kids = childrenOf(c.id);
              const isSelfActive = filters.category === c.id;
              const childActive = kids.some((k) => k.id === filters.category);
              const expanded = isSelfActive || childActive;

              return (
                <li key={c.id}>
                  <button
                    onClick={() =>
                      onChange({
                        ...filters,
                        category: filters.category === c.id ? null : c.id,
                      })
                    }
                    className={`text-[13px] w-full text-left py-1 transition ${
                      isSelfActive
                        ? 'text-brick-500 font-semibold'
                        : 'text-paper-soft dark:text-ink-soft hover:text-brick-500'
                    }`}
                  >
                    {lang === 'en' && c.name_en ? c.name_en : c.name}
                  </button>

                  {expanded && kids.length > 0 && (
                    <ul className="mt-0.5 mb-1.5 space-y-0.5">
                      {kids.map((k) => {
                        const kActive = filters.category === k.id;
                        return (
                          <li key={k.id}>
                            <button
                              onClick={() =>
                                onChange({ ...filters, category: k.id })
                              }
                              className={`text-[12.5px] py-0.5 pl-3 w-full text-left flex items-center gap-1.5 transition ${
                                kActive
                                  ? 'text-brick-500 font-medium'
                                  : 'text-paper-soft dark:text-ink-soft hover:text-brick-500'
                              }`}
                            >
                              <span
                                aria-hidden
                                className="text-paper-faint dark:text-ink-faint font-mono text-[11px] leading-none select-none"
                              >
                                └
                              </span>
                              <span>
                                {lang === 'en' && k.name_en ? k.name_en : k.name}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      {/* Footer — always visible; explicit "3 filters active · Clear" */}
      <div className="px-4 py-2.5 border-t border-paper-border dark:border-ink-border flex items-center justify-between text-[11.5px]">
        <span className="text-paper-faint dark:text-ink-faint">
          {activeCount > 0
            ? `${activeCount} ${t(lang, 'filtersActive')}`
            : lang === 'is'
              ? 'Engar síur virkar'
              : 'No filters active'}
        </span>
        {activeCount > 0 && (
          <button
            onClick={() =>
              onChange({
                access: new Set(),
                sources: new Set(),
                category: null,
              })
            }
            className="text-brick-500 font-medium hover:underline"
          >
            {t(lang, 'clearAll')}
          </button>
        )}
      </div>
    </aside>
  );
}
