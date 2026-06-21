// Pure show-persistence model for the renderer. Each poll delivers a full
// snapshot of the current show's sales, so an upsert REPLACES that show's
// sales array (it never appends). Zero electron/DOM deps so it stays testable.

import type { Sale } from './types'

export interface ShowMeta {
  id: string
  name: string
  startTime?: number // unix SECONDS
}

export interface ShowRecord extends ShowMeta {
  sales: Sale[]
  updatedAt: number // unix ms
}

export type ShowStore = Record<string, ShowRecord> // keyed by show id

/** Parse the persisted JSON safely; return {} on null/invalid. */
export function loadShows(raw: string | null): ShowStore {
  if (raw == null) return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    return parsed as ShowStore
  } catch {
    return {}
  }
}

/**
 * Replace `meta.id`'s sales snapshot with `sales`; keep/update name+startTime;
 * set updatedAt=now. Returns a NEW store object (does not mutate the input).
 * No-op if meta.id is empty.
 */
export function upsertShow(
  store: ShowStore,
  meta: ShowMeta,
  sales: Sale[],
  now: number
): ShowStore {
  if (!meta.id) return { ...store }
  const record: ShowRecord = {
    id: meta.id,
    name: meta.name,
    startTime: meta.startTime,
    sales,
    updatedAt: now,
  }
  return { ...store, [meta.id]: record }
}

/**
 * All shows sorted by startTime DESC (most recent first); shows without
 * startTime sort last; tie-break by name asc. Returns ShowMeta[].
 */
export function listShows(store: ShowStore): ShowMeta[] {
  return Object.values(store)
    .slice()
    .sort(byStartTimeDescThenName)
    .map(({ id, name, startTime }) => ({ id, name, startTime }))
}

/**
 * Sales for one show id, or ALL shows concatenated when showId === 'all'
 * (ordered by show startTime desc, then sales as stored). Unknown id → [].
 */
export function salesForShow(store: ShowStore, showId: string): Sale[] {
  if (showId === 'all') {
    return Object.values(store)
      .slice()
      .sort(byStartTimeDescThenName)
      .flatMap((record) => record.sales)
  }
  return store[showId]?.sales ?? []
}

function byStartTimeDescThenName(a: ShowRecord, b: ShowRecord): number {
  const aTime = a.startTime
  const bTime = b.startTime
  if (aTime !== bTime) {
    if (aTime === undefined) return 1 // a (no startTime) sorts last
    if (bTime === undefined) return -1 // b (no startTime) sorts last
    return bTime - aTime // desc
  }
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0 // tie-break name asc
}
