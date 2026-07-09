/**
 * Central adapter registry.
 *
 * To register a new source:
 *   1. Create an adapter file under ./adapters/
 *   2. Import + add it to the ADAPTERS array below
 *   3. Make sure a `sources` row exists with matching slug
 *
 * The runner looks up adapters via getAdapter(source.slug). If no adapter is
 * registered, the runner refuses to start — a source with scrape_mode='crawler'
 * but no code adapter is a config bug we want to surface loudly.
 */

import type { Adapter } from './types';

import hms from './adapters/hms';
import hmsRbBlod from './adapters/hms-rb-blod';
import byggingarreglugerd from './adapters/byggingarreglugerd';
import taktak from './adapters/taktak';
import svanurinn from './adapters/svanurinn';
import byggjumGraenni from './adapters/byggjum-graenni';

const ADAPTERS: Adapter[] = [
  hms,
  hmsRbBlod,
  byggingarreglugerd,
  taktak,
  svanurinn,
  byggjumGraenni,
];

const bySlug = new Map<string, Adapter>(ADAPTERS.map((a) => [a.slug, a]));

export function getAdapter(slug: string): Adapter | undefined {
  return bySlug.get(slug);
}

export function listAdapters(): Adapter[] {
  return [...ADAPTERS];
}
