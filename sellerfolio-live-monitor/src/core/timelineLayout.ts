// LANE G — the show timeline: hq's wire types, a defensive parser, and the pure layout.
//
// The layout is a port of SellerFolio's web/src/chat-insights/timeline-layout.ts (the show page's
// timeline) so the desktop draws the same picture from the same payload: one time axis, then a
// track each for auction runs, viewer chat per minute, questions, problem flags and "Said" (what
// the host said about a sold item). Source: hq GET /api/desktop/timeline?roomId= → { timeline }.
// Types mirror hq src/live-chat/types.ts (ShowTimeline and friends) — keep them in step.
//
// Portable: no electron/DOM. Clock labels use this computer's zone.

import { fmtCents } from './showStats'

export interface TimelineItem {
  brand: string | null
  item: string | null
  size: string | null
  color: string | null
  summary: string | null
}

export type RunOutcome = 'sold' | 'unsold' | 'unknown'

export interface TimelineAuction {
  lot: string
  startMs: number | null
  endMs: number
  outcome: RunOutcome
  priceCents: number | null
  productName: string | null
  bids: number | null
  orderId: string | null
  buyerUserId: string | null
  buyerName: string | null
  item: TimelineItem | null
}

export interface TimelineChatBucket {
  atMs: number
  viewerLines: number
  questions: number
}

export interface TimelineMarker {
  eventId: string
  atMs: number
  lot: string | null
  text: string
  /** QuestionTopic for questions, FlagKind for flags. */
  kind: string
}

export interface ShowTimeline {
  hasJournal: boolean
  startMs: number | null
  endMs: number | null
  auctions: TimelineAuction[]
  chatBuckets: TimelineChatBucket[]
  questions: TimelineMarker[]
  flags: TimelineMarker[]
}

// ── parsing (never trust the wire: drop what does not fit instead of throwing) ─────────────────

const MAX_RUNS = 5_000
const MAX_BUCKETS = 24 * 60
const MAX_MARKERS = 4_000

type J = Record<string, unknown>
const objOf = (v: unknown): J | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : null)
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const nonNeg = (v: unknown): number => { const n = finite(v); return n !== null && n >= 0 ? n : 0 }

function parseItem(v: unknown): TimelineItem | null {
  const o = objOf(v)
  if (!o) return null
  return { brand: str(o['brand']), item: str(o['item']), size: str(o['size']), color: str(o['color']), summary: str(o['summary']) }
}

function parseRun(v: unknown): TimelineAuction | null {
  const o = objOf(v)
  if (!o) return null
  const lot = str(o['lot'])
  const endMs = finite(o['endMs'])
  if (!lot || endMs === null) return null
  const oc = o['outcome']
  return {
    lot,
    startMs: finite(o['startMs']),
    endMs,
    outcome: oc === 'sold' || oc === 'unsold' ? oc : 'unknown',
    priceCents: finite(o['priceCents']),
    productName: str(o['productName']),
    bids: finite(o['bids']),
    orderId: str(o['orderId']),
    buyerUserId: str(o['buyerUserId']),
    buyerName: str(o['buyerName']),
    item: parseItem(o['item']),
  }
}

function parseMarker(v: unknown, i: number): TimelineMarker | null {
  const o = objOf(v)
  if (!o) return null
  const atMs = finite(o['atMs'])
  if (atMs === null) return null
  return { eventId: str(o['eventId']) ?? `m${i}`, atMs, lot: str(o['lot']), text: str(o['text']) ?? '', kind: str(o['kind']) ?? 'other' }
}

function list<T>(v: unknown, f: (x: unknown, i: number) => T | null, cap: number): T[] {
  if (!Array.isArray(v)) return []
  const out: T[] = []
  for (let i = 0; i < v.length && out.length < cap; i++) { const p = f(v[i], i); if (p) out.push(p) }
  return out
}

/** `{ timeline: ShowTimeline }` (or a bare ShowTimeline) → ShowTimeline, or null when it is neither. */
export function parseTimeline(raw: unknown): ShowTimeline | null {
  const outer = objOf(raw)
  const t = objOf(outer?.['timeline']) ?? (outer && 'auctions' in outer ? outer : null)
  if (!t) return null
  return {
    hasJournal: t['hasJournal'] === true,
    startMs: finite(t['startMs']),
    endMs: finite(t['endMs']),
    auctions: list(t['auctions'], (x) => parseRun(x), MAX_RUNS),
    chatBuckets: list(t['chatBuckets'], (x) => {
      const o = objOf(x)
      const atMs = finite(o?.['atMs'])
      return o && atMs !== null ? { atMs, viewerLines: nonNeg(o['viewerLines']), questions: nonNeg(o['questions']) } : null
    }, MAX_BUCKETS),
    questions: list(t['questions'], parseMarker, MAX_MARKERS),
    flags: list(t['flags'], parseMarker, MAX_MARKERS),
  }
}

// ── layout (ported from web timeline-layout.ts) ────────────────────────────────────────────────

export const MIN_MS = 60_000
/** A run with no journaled start and nothing before it: draw it this long, ending at its end. */
export const DEFAULT_RUN_MS = 30_000
/** Zoom factors over "fit the panel". 1 = the whole show in the visible width. */
export const ZOOMS = [1, 2, 4, 8, 16, 32] as const
/** The narrowest a bar's click target may be, px. */
export const MIN_HIT_PX = 6
/** Roughly how wide one 10px mono label character is, px. */
export const CH_PX = 6.1
/** Side padding inside the plot so an edge bar or tick label is never cut off. */
export const PAD_X = 12

/** The drawn span: the payload's own start/end widened to everything in it. Null when empty. */
export function timeDomain(d: Pick<ShowTimeline, 'startMs' | 'endMs' | 'auctions' | 'chatBuckets' | 'questions' | 'flags'>): { t0: number; t1: number } | null {
  let lo = Infinity
  let hi = -Infinity
  const see = (n: number) => { if (n < lo) lo = n; if (n > hi) hi = n }
  for (const a of d.auctions) { see(a.endMs); if (a.startMs != null) see(a.startMs) }
  for (const b of d.chatBuckets) { see(b.atMs); see(b.atMs + MIN_MS) }
  for (const m of d.questions) see(m.atMs)
  for (const m of d.flags) see(m.atMs)
  const any = lo !== Infinity
  let t0 = d.startMs ?? (any ? lo : null)
  let t1 = d.endMs ?? (any ? hi : null)
  if (t0 == null || t1 == null) return null
  if (any) { t0 = Math.min(t0, lo); t1 = Math.max(t1, hi) }
  if (t1 - t0 < MIN_MS) t1 = t0 + MIN_MS
  return { t0, t1 }
}

export interface Scale {
  t0: number
  t1: number
  width: number
  x: (ms: number) => number
  ms: (x: number) => number
}

export function makeScale(t0: number, t1: number, width: number, pad = PAD_X): Scale {
  const inner = Math.max(1, width - pad * 2)
  const span = Math.max(1, t1 - t0)
  return { t0, t1, width, x: (ms) => pad + ((ms - t0) / span) * inner, ms: (x) => t0 + ((x - pad) / inner) * span }
}

/** A stable identity for a run: a lot can run twice, but not end twice at the same instant. */
export const runKey = (a: Pick<TimelineAuction, 'lot' | 'endMs'>): string => `${a.lot}@${a.endMs}`

export interface BarLayout {
  run: TimelineAuction
  key: string
  startMs: number
  endMs: number
  x: number
  w: number
  /** Hit rect — at least MIN_HIT_PX wide, centred on the drawn bar. */
  hx: number
  hw: number
}

/** One bar per run, oldest first. A run with no journaled start begins where the previous one ended;
 *  the very first such run gets DEFAULT_RUN_MS. A start after the end (clock skew) collapses to the end. */
export function layoutBars(auctions: TimelineAuction[], s: Scale): BarLayout[] {
  const runs = [...auctions].sort((a, b) => a.endMs - b.endMs)
  let prevEnd: number | null = null
  return runs.map((run) => {
    let start = run.startMs ?? prevEnd ?? Math.max(s.t0, run.endMs - DEFAULT_RUN_MS)
    if (start > run.endMs) start = run.endMs
    prevEnd = run.endMs
    const x = s.x(start)
    const w = Math.max(1, s.x(run.endMs) - x)
    const hw = Math.max(MIN_HIT_PX, w)
    return { run, key: runKey(run), startMs: start, endMs: run.endMs, x, w, hx: x + w / 2 - hw / 2, hw }
  })
}

/** What the transcription identified, else the console's product name. */
export function productOf(a: TimelineAuction): string | null {
  const id = [a.item?.brand, a.item?.item].filter((v): v is string => !!v && v.trim() !== '').join(' ')
  return id || a.productName || null
}

/** Price text, or null when unknown — never a fabricated zero. */
export const priceOf = (a: Pick<TimelineAuction, 'priceCents'>): string | null => (a.priceCents == null ? null : fmtCents(a.priceCents))

/** The label inside a bar: "#42 · $35.00" if it fits, else "#42", else nothing. */
export function fitLabel(a: TimelineAuction, widthPx: number, ch = CH_PX): string | null {
  const room = widthPx - 6
  const price = priceOf(a)
  const full = price ? `${a.lot} · ${price}` : a.lot
  if (full.length * ch <= room) return full
  if (a.lot.length * ch <= room) return a.lot
  return null
}

export const OUTCOME_LABEL: Record<RunOutcome, string> = { sold: 'Sold', unsold: 'Unsold', unknown: 'Outcome unknown' }

/** Accessible name for a bar. */
export function barAria(a: TimelineAuction): string {
  return [`Lot ${a.lot.replace(/^#/, '')}`, OUTCOME_LABEL[a.outcome], productOf(a), priceOf(a)].filter(Boolean).join(', ')
}

export interface ChatColumn { atMs: number; x: number; w: number; hLines: number; hQuestions: number; b: TimelineChatBucket }

/** Viewer lines per minute as columns `height` tall at the busiest minute; questions on the same scale. */
export function layoutChat(buckets: TimelineChatBucket[], s: Scale, height: number): { cols: ChatColumn[]; max: number } {
  let max = 0
  for (const b of buckets) if (b.viewerLines > max) max = b.viewerLines
  const k = max > 0 ? height / max : 0
  const cols = buckets.map((b) => {
    const x = s.x(b.atMs)
    const full = s.x(b.atMs + MIN_MS) - x
    const w = Math.max(1, full - (full > 3 ? 1 : 0))
    return { atMs: b.atMs, x, w, hLines: b.viewerLines * k, hQuestions: Math.min(b.questions, b.viewerLines || b.questions) * k, b }
  })
  return { cols, max }
}

const TICK_STEPS_MIN = [1, 2, 5, 10, 15, 30, 60, 120, 240]

/** Axis ticks at a round minute step that leaves at least `minGapPx` between labels. */
export function axisTicks(s: Scale, minGapPx = 72): { ms: number; x: number }[] {
  const pxPerMin = s.x(s.t0 + MIN_MS) - s.x(s.t0)
  const step = (TICK_STEPS_MIN.find((m) => m * pxPerMin >= minGapPx) ?? TICK_STEPS_MIN[TICK_STEPS_MIN.length - 1]!) * MIN_MS
  const out: { ms: number; x: number }[] = []
  for (let t = Math.ceil(s.t0 / step) * step; t <= s.t1; t += step) out.push({ ms: t, x: s.x(t) })
  return out
}

/** "2:05 PM" (or "2:05:09 PM") in this computer's zone. */
export const clockLabel = (ms: number, seconds = false): string =>
  new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) })

/** The plot width for a zoom factor over a visible width. */
export const plotWidth = (viewW: number, zoom: number): number => Math.max(320, Math.round(viewW * zoom))

/** Keep the centre of the view where it was when the zoom changes. */
export function scrollForZoom(scrollLeft: number, viewW: number, fromW: number, toW: number): number {
  const centre = (scrollLeft + viewW / 2) / Math.max(1, fromW)
  return Math.max(0, Math.min(toW - viewW, centre * toW - viewW / 2))
}

/** Sold runs whose transcription carried a summary of what the host said. */
export const saidRuns = (bars: BarLayout[]): BarLayout[] => bars.filter((b) => b.run.outcome === 'sold' && !!b.run.item?.summary?.trim())

export const TOPIC_LABEL: Record<string, string> = {
  size: 'Size', authenticity: 'Authenticity', condition: 'Condition', price: 'Price', shipping: 'Shipping',
  fit_fabric: 'Fit / fabric', color: 'Color', rerun: 'Re-run', other: 'Other',
}
export const topicLabel = (k: string): string => TOPIC_LABEL[k] ?? k

/** hq's FLAG_KINDS labels (web/src/chat-insights/flags-view.ts). */
export const FLAG_LABEL: Record<string, string> = {
  not_received: 'Not received', wrong_item: 'Wrong item', damaged: 'Damaged', refund_return: 'Refund / return',
  payment: 'Payment', combine_shipping: 'Combine shipping', other_complaint: 'Other complaint',
}
export const flagLabel = (k: string): string => FLAG_LABEL[k] ?? k

/** CSS-safe kind suffix (never trust a wire string into a class). */
export const kindClass = (k: string): string => k.replace(/[^a-z_]/gi, '').toLowerCase() || 'other'

/** Markers sorted by time, each with its x. */
export const placeMarkers = (ms: TimelineMarker[], s: Scale): { m: TimelineMarker; x: number }[] =>
  [...ms].sort((a, b) => a.atMs - b.atMs).map((m) => ({ m, x: s.x(m.atMs) }))

/** The panel head's summary: "42 runs · 30 sold". */
export function timelineSummary(t: Pick<ShowTimeline, 'auctions'>): string {
  const n = t.auctions.length
  const sold = t.auctions.filter((a) => a.outcome === 'sold').length
  return `${n} run${n === 1 ? '' : 's'} · ${sold} sold`
}

/** After a refresh, keep a view that was following the live edge on the live edge. */
export function followScroll(prev: { scrollLeft: number; viewW: number; plotW: number }, nextPlotW: number): number {
  const atEnd = prev.scrollLeft + prev.viewW >= prev.plotW - 4
  if (atEnd) return Math.max(0, nextPlotW - prev.viewW)
  return Math.min(prev.scrollLeft, Math.max(0, nextPlotW - prev.viewW))
}
