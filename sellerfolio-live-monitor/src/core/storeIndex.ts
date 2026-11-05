// LANE B — the show store: an in-memory index rebuilt from the JSONL journal, living in the
// journal WORKER thread (BUILD.md decision 1 — no SQLite, no sql.js, no native module). The
// worker feeds it every journal line it writes (and, when a room's first record arrives, the
// lines already on disk for that room), and answers queries posted from main (journal.ts
// queryStore → worker 'store-query' → 'store-result'). Pure: no fs, no electron, no DOM — the
// renderer imports the matcher from here too, so a live row and a stored row match the same way.
//
// Memory is bounded by document caps (oldest evicted first): a long, busy show keeps its newest
// MAX_SALES sales, MAX_CHAT chat lines and MAX_PRINTS print marks, and nothing older.

import type { Sale } from './types'

/** A sale as the journal records it (main.ts `record('sale', …)` + `payment_failed`). */
export interface StoreSale {
  orderId: string
  lot?: string // "#42"
  skuId?: string
  productId?: string
  productName?: string
  buyer?: string // display name
  handle?: string
  buyerId?: string // ttuid — the key for the past-order badge
  price?: string // formatted
  cents?: number
  payment?: 'paid' | 'failed' | 'pending'
  createdAt?: number
  /** When a label for this lot + buyer was last sent to the printer (journal `print`, ok). */
  printedAt?: number
}

/** A chat line as the journal records it (core/chatJournal.ts). */
export interface StoreChat {
  id: string
  nickname: string
  handle?: string
  userId?: string
  text: string
  ts: number
  lot?: string | null
}

export type StoreQuery =
  /** Full-text over lot, buyer, handle, product name, price. Empty text → the newest `limit`. */
  | { kind: 'sales'; text: string; limit?: number }
  /** Full-text over nickname, handle and text. */
  | { kind: 'chat'; text: string; limit?: number }
  /** Sales whose payment failed this show (newest first). */
  | { kind: 'failed'; limit?: number }

export type StoreResult =
  | { kind: 'sales'; rows: StoreSale[]; total: number }
  | { kind: 'chat'; rows: StoreChat[]; total: number }
  | { kind: 'failed'; rows: StoreSale[]; total: number }

/** The result kind a query gets back. */
export type ResultOf<Q extends StoreQuery> = Extract<StoreResult, { kind: Q['kind'] }>

/** The answer when there is no store (no worker, timeout, stub): the right kind, no rows. */
export function emptyStoreResult(q: StoreQuery): StoreResult {
  return { kind: q.kind, rows: [], total: 0 } as StoreResult
}

// ── caps ─────────────────────────────────────────────────────────────────────
/** Sales kept (a big show is ~1–2k). ~0.5 KB each → ≤ ~10 MB. */
export const MAX_SALES = 20_000
/** Chat lines kept (a busy 6 h show is ~20–40k). Text ≤ 500 chars → ≤ ~40 MB worst case, ~15 MB typical. */
export const MAX_CHAT = 40_000
/** lot+buyer print marks kept (they only decorate sales). */
export const MAX_PRINTS = 20_000
/** Rows one query returns at most, whatever `limit` asks. */
export const MAX_ROWS = 500
/** Rows when `limit` is missing. */
export const DEFAULT_ROWS = 100
/** A journal line longer than this is not indexed (the chat cap is 500 chars; a sale is ~400 B). */
export const MAX_LINE_CHARS = 16_384

// ── matching (shared with the renderer) ─────────────────────────────────────
/** A query split into lower-case words. A leading `@` is dropped (handles are stored bare). */
export function searchTokens(q: string): string[] {
  return String(q ?? '')
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/^@+/, ''))
    .filter(Boolean)
}

/** Every word must appear somewhere in the haystack (AND, substring). No words → everything matches. */
export function matchesAll(hay: string, tokens: readonly string[]): boolean {
  for (const t of tokens) if (!hay.includes(t)) return false
  return true
}

/** The searchable text of a sale: lot, buyer, @handle, product, price. Lower-case. */
export function saleHaystack(s: { lot?: string; buyer?: string; handle?: string; productName?: string; price?: string }): string {
  return [s.lot, s.buyer, s.handle, s.productName, s.price].filter((x): x is string => typeof x === 'string' && !!x).join('\u0001').toLowerCase()
}

function chatHaystack(c: StoreChat): string {
  return [c.nickname, c.handle, c.text].filter((x): x is string => typeof x === 'string' && !!x).join('\u0001').toLowerCase()
}

/** The room a journal file belongs to, from its name (`show-<room>.jsonl` / `.chat.jsonl`); '' for a catch-all. */
export function roomOfJournalFile(name: string): string {
  const base = String(name).split(/[\\/]/).pop() ?? ''
  const m = /^show-(.+?)(?:\.chat)?\.jsonl$/.exec(base)
  return m ? m[1]! : ''
}

// ── stored rows in the renderer's shape ─────────────────────────────────────
/** A stored sale in the shape the rows (and printSale) take. */
export function saleFromStore(r: StoreSale): Sale {
  const buyer: Sale['buyer'] = { username: r.buyer ?? '' }
  if (r.buyerId) buyer.ttuid = r.buyerId
  if (r.handle) buyer.handle = r.handle
  const s: Sale = {
    orderId: r.orderId,
    buyer,
    productId: r.productId ?? '',
    productName: r.productName ?? '',
    price: { cents: r.cents ?? 0, formatted: r.price ?? '' },
    paymentStatus: r.payment ?? 'pending',
    createdAt: r.createdAt ?? 0,
  }
  if (r.skuId) s.skuId = r.skuId
  if (r.lot) s.skuDesc = r.lot
  return s
}

const liveHay = (s: Sale) => saleHaystack({ lot: s.skuDesc, buyer: s.buyer.username, handle: s.buyer.handle, productName: s.productName, price: s.price.formatted })

/**
 * Live matches merged with the store's, by order id (the live row wins), newest first. `found`
 * counts the store's matches beyond the rows it returned, so the number is the whole show's.
 */
export function mergeSearch(live: readonly Sale[], stored: readonly Sale[], storedTotal: number, q: string): { rows: Sale[]; found: number; fromStore: Set<string> } {
  const tokens = searchTokens(q)
  const byId = new Map<string, Sale>()
  const fromStore = new Set<string>()
  for (const s of live) if (matchesAll(liveHay(s), tokens) && !byId.has(s.orderId)) byId.set(s.orderId, s)
  for (const s of stored) {
    if (byId.has(s.orderId)) continue
    byId.set(s.orderId, s)
    fromStore.add(s.orderId)
  }
  const rows = [...byId.values()].sort((a, b) => b.createdAt - a.createdAt)
  const found = rows.length + Math.max(0, storedTotal - stored.length)
  return { rows, found, fromStore }
}

// ── the index ────────────────────────────────────────────────────────────────
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const printMark = (lot: string | undefined, buyer: string | undefined): string =>
  `${(lot ?? '').replace(/^#/, '').trim().toLowerCase()}|${(buyer ?? '').trim().toLowerCase().replace(/\s+/g, ' ')}`

interface SaleEntry { row: StoreSale; hay: string; order: number }
interface ChatEntry { row: StoreChat; hay: string }

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_ROWS
  return Math.max(0, Math.min(MAX_ROWS, Math.floor(limit)))
}

export class StoreIndex {
  private room = ''
  private readonly sales = new Map<string, SaleEntry>() // insertion-ordered: first = oldest
  private readonly failed = new Set<string>()
  private readonly chat = new Map<string, ChatEntry>()
  private readonly prints = new Map<string, number>()
  private seq = 0

  /** The room the index holds ('' until a line names one). */
  get currentRoom(): string { return this.room }
  get saleCount(): number { return this.sales.size }
  get chatCount(): number { return this.chat.size }

  /** Forget everything and hold `room` from now on. */
  reset(room = ''): void {
    this.room = room
    this.sales.clear()
    this.failed.clear()
    this.chat.clear()
    this.prints.clear()
    this.seq = 0
  }

  /**
   * Take one journal line (the exact JSONL string the worker writes). Cheap, and never throws: a
   * bad line is skipped. Idempotent per record (sales upsert on orderId, chat on its id), so a
   * line read back from disk and seen live again is harmless. A line for a different room than
   * the current one starts a fresh index; a line with no room joins the current one.
   */
  ingest(line: string): void {
    try {
      if (typeof line !== 'string' || !line || line.length > MAX_LINE_CHARS) return
      const r = JSON.parse(line) as Record<string, unknown>
      if (!r || typeof r !== 'object') return
      const room = str(r['room'])
      if (room && room !== this.room) this.reset(room)
      switch (r['type']) {
        case 'sale': return this.addSale(r, false)
        case 'payment_failed': return this.addSale(r, true)
        case 'print': return this.addPrint(r)
        case 'chat': return this.addChat(r)
        default: return
      }
    } catch { /* not a line we can read */ }
  }

  /** Ingest a whole file's text (one record per line). A trailing partial line is skipped by JSON.parse. */
  ingestText(text: string): void {
    let start = 0
    while (start < text.length) {
      let end = text.indexOf('\n', start)
      if (end < 0) end = text.length
      const line = text.slice(start, end).trim()
      if (line) this.ingest(line)
      start = end + 1
    }
  }

  private addSale(r: Record<string, unknown>, failed: boolean): void {
    const orderId = str(r['orderId'])
    if (!orderId) return
    const prev = this.sales.get(orderId)
    const pay = str(r['payment'])
    const next: StoreSale = { ...(prev?.row ?? { orderId }) }
    const set = <K extends keyof StoreSale>(k: K, v: StoreSale[K] | undefined) => { if (v !== undefined) next[k] = v }
    set('lot', str(r['lot']))
    set('skuId', str(r['skuId']))
    set('productId', str(r['productId']))
    set('productName', str(r['productName']))
    set('buyer', str(r['buyer']))
    set('handle', str(r['handle']))
    set('buyerId', str(r['buyerId']))
    set('price', str(r['price']))
    set('cents', num(r['cents']))
    // A sale record's createdAt is TikTok's order time; a payment_failed record has none, so the
    // envelope time only stands in when nothing better is known.
    if (num(r['createdAt'])) next.createdAt = num(r['createdAt'])
    else if (next.createdAt === undefined) set('createdAt', num(r['t']))
    if (failed || this.failed.has(orderId)) {
      next.payment = 'failed'
      this.failed.add(orderId)
    } else if (pay === 'paid' || pay === 'failed' || pay === 'pending') {
      next.payment = pay
      if (pay === 'failed') this.failed.add(orderId)
    }
    const mark = this.prints.get(printMark(next.lot, next.buyer))
    if (mark !== undefined) next.printedAt = mark
    if (prev) { prev.row = next; prev.hay = saleHaystack(next); return }
    this.sales.set(orderId, { row: next, hay: saleHaystack(next), order: ++this.seq })
    while (this.sales.size > MAX_SALES) {
      const oldest = this.sales.keys().next().value!
      this.sales.delete(oldest)
      this.failed.delete(oldest)
    }
  }

  private addPrint(r: Record<string, unknown>): void {
    if (r['ok'] !== true || r['dry'] === true) return
    const lot = str(r['lot'])
    const buyer = str(r['buyer'])
    if (!lot || !buyer) return
    const at = num(r['t']) ?? 0
    const key = printMark(lot, buyer)
    this.prints.delete(key) // re-insert: newest last, so eviction drops the oldest mark
    this.prints.set(key, at)
    while (this.prints.size > MAX_PRINTS) this.prints.delete(this.prints.keys().next().value!)
    // The label usually prints BEFORE the order row exists; when the row is already here, mark it.
    for (const e of this.sales.values()) if (printMark(e.row.lot, e.row.buyer) === key) e.row.printedAt = at
  }

  private addChat(r: Record<string, unknown>): void {
    const id = str(r['id'])
    const text = typeof r['text'] === 'string' ? r['text'] : undefined
    if (!id || text === undefined || this.chat.has(id)) return
    const row: StoreChat = { id, nickname: str(r['author']) ?? '', text, ts: num(r['atMs']) ?? num(r['t']) ?? 0 }
    const handle = str(r['handle'])
    const userId = str(r['authorId'])
    if (handle) row.handle = handle
    if (userId) row.userId = userId
    if (typeof r['lot'] === 'string' || r['lot'] === null) row.lot = r['lot'] as string | null
    this.chat.set(id, { row, hay: chatHaystack(row) })
    while (this.chat.size > MAX_CHAT) this.chat.delete(this.chat.keys().next().value!)
  }

  /** Answer one query from memory. Never throws. Rows are newest first. */
  query<Q extends StoreQuery>(q: Q): ResultOf<Q> {
    return this.answer(q) as ResultOf<Q>
  }

  private answer(q: StoreQuery): StoreResult {
    try {
      const limit = clampLimit(q.limit)
      if (q.kind === 'chat') {
        const tokens = searchTokens(q.text)
        const hits: StoreChat[] = []
        for (const e of this.chat.values()) if (matchesAll(e.hay, tokens)) hits.push(e.row)
        hits.sort((a, b) => b.ts - a.ts)
        return { kind: 'chat', rows: hits.slice(0, limit), total: hits.length }
      }
      const tokens = q.kind === 'sales' ? searchTokens(q.text) : []
      const hits: SaleEntry[] = []
      for (const e of this.sales.values()) {
        if (q.kind === 'failed' ? e.row.payment !== 'failed' : !matchesAll(e.hay, tokens)) continue
        hits.push(e)
      }
      hits.sort((a, b) => (b.row.createdAt ?? 0) - (a.row.createdAt ?? 0) || b.order - a.order)
      return { kind: q.kind, rows: hits.slice(0, limit).map((e) => e.row), total: hits.length }
    } catch {
      return emptyStoreResult(q)
    }
  }
}
