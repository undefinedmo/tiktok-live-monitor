// LANE D — renderer side of the past-order badge. Lane B calls requestCounts() with the ttuids it
// is about to paint and badgeFor() per sale row (feed, payment issues, top buyers — NEVER chat).
// Counts arrive through window.buyerAPI (lookup → cached now; onCounts → pushed later); a push
// calls the listeners so lane B can repaint. Nothing here is awaited by anyone: a slow, absent or
// failing hq just means no badge.

import { buyerTag, isBuyerId } from '../core/buyerTags'

/** Ask main again about an id still unknown after this long (main may have paused or dropped it). */
export const REASK_MS = 30_000

interface BuyerBridge {
  lookup: (ids: string[]) => Promise<{ counts: Record<string, number> }>
  onCounts: (cb: (p: { counts: Record<string, number> }) => void) => void
}

const known = new Map<string, number>()
const askedAt = new Map<string, number>()
const listeners: (() => void)[] = []
let queued: string[] = []
let flushQueued = false
let inited = false
/** The room the cache belongs to ('' until the top bar names one). Counts are per show. */
let room = ''
let notifyQueued = false

function bridge(): BuyerBridge | undefined {
  try { return (globalThis as { buyerAPI?: BuyerBridge }).buyerAPI } catch { return undefined }
}

function notify(): void {
  for (const cb of listeners) { try { cb() } catch { /* a listener's bug is not ours to surface */ } }
}

/**
 * Counts are "orders before THIS show started", so a new room makes every cached count stale. The
 * room is the one the top bar names (#room, set by renderer.ts on every 'room' event) — the same
 * signal chatDesk keys its show on. Main resets its own cache on the next lookup, which the
 * cleared ids now trigger.
 */
function syncRoom(): void {
  let r = ''
  try {
    const doc = (globalThis as { document?: { getElementById?: (id: string) => { textContent: string | null } | null } }).document
    r = String(doc?.getElementById?.('room')?.textContent ?? '').trim()
  } catch { return }
  if (!r || r === '—' || r === '-' || r === room) return
  room = r
  if (known.size === 0 && askedAt.size === 0) return
  const had = known.size > 0
  known.clear(); askedAt.clear()
  // Repaint later, not from inside the painter that called badgeFor().
  if (had && !notifyQueued) { notifyQueued = true; queueMicrotask(() => { notifyQueued = false; notify() }) }
}

/** Merge counts into the cache; true when anything changed. */
function merge(counts: unknown): boolean {
  if (!counts || typeof counts !== 'object') return false
  let changed = false
  for (const [id, v] of Object.entries(counts as Record<string, unknown>)) {
    if (!isBuyerId(id) || typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue
    if (known.get(id) !== v) { known.set(id, v); changed = true }
    askedAt.delete(id)
  }
  return changed
}

/** Called once by renderer.ts at startup (subscribe to window.buyerAPI.onCounts). */
export function initBuyerHistory(): void {
  if (inited) return
  const api = bridge()
  if (!api) return
  inited = true
  try {
    api.onCounts((p) => {
      try {
        const payload = p as { counts?: unknown; reset?: unknown }
        let changed = false
        if (payload?.reset === true) { changed = known.size > 0; known.clear(); askedAt.clear() }
        if (merge(payload?.counts)) changed = true
        if (changed) notify()
      } catch { /* never */ }
    })
  } catch { inited = false }
}

function flush(): void {
  flushQueued = false
  const ids = queued
  queued = []
  const api = bridge()
  if (!api || ids.length === 0) return
  try {
    void api.lookup(ids).then((r) => { if (merge(r?.counts)) notify() }, () => { /* no badge */ })
  } catch { /* no badge */ }
}

/** Ask for these buyers' counts (deduped, batched in main). Fire-and-forget; never throws. */
export function requestCounts(ttuids: readonly (string | undefined)[]): void {
  try {
    syncRoom()
    const now = Date.now()
    for (const id of ttuids) {
      if (!isBuyerId(id) || known.has(id)) continue
      const at = askedAt.get(id)
      if (at !== undefined && now - at < REASK_MS) continue
      askedAt.set(id, now)
      queued.push(id)
    }
    if (queued.length && !flushQueued) { flushQueued = true; queueMicrotask(flush) }
  } catch { /* never */ }
}

/** The past-order count for a buyer, if known. */
export function pastOrdersOf(ttuid: string | undefined): number | undefined {
  try { syncRoom() } catch { /* never */ }
  return ttuid ? known.get(ttuid) : undefined
}

/** `<span class="tag …">` for a sale row's buyer (core/buyerTags.buyerTag), or null for no badge. */
export function badgeFor(ttuid: string | undefined): HTMLElement | null {
  try {
    const tag = buyerTag(pastOrdersOf(ttuid))
    if (!tag) return null
    const e = document.createElement('span')
    e.className = `tag ${tag.kind === 'new' ? 'buyer-new' : 'buyer-ord'}`
    e.textContent = tag.text
    e.title = tag.title
    e.setAttribute('role', 'img')
    e.setAttribute('aria-label', tag.title)
    return e
  } catch {
    return null
  }
}

/** Called after new counts arrive, so the sales view can repaint its badges. */
export function onCountsChanged(cb: () => void): void {
  listeners.push(cb)
}

/** Tests only: forget everything. */
export function _resetForTests(): void {
  known.clear(); askedAt.clear(); listeners.length = 0; queued = []; flushQueued = false; inited = false; room = ''; notifyQueued = false
}
