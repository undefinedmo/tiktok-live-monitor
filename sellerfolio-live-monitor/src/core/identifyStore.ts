// Identifications that survive a restart. One append-only JSON-lines file under userData, the same
// convention as the show journal: a line is one row, a torn last line costs only itself, and nothing
// here can throw. The file is a LOG of state changes -- a lot is written when its sale is queued and
// again when it settles (and again when an operator corrects it) -- and the LAST line for an order
// wins when the file is read. Disk and clock are injected, so every failure below is tested rather
// than hoped for. Portable: no electron, no fs.
//
// WHY THESE RULES (the app's real job is printing labels; identification must never be able to
// stop it starting, so nothing in here is allowed to throw and nothing in here trusts the file):
//
// - THE CAP IS BY COUNT, WITH AN AGE BACKSTOP, NEVER BY SHOW. A show runs hundreds of lots (919 sales
//   in the biggest journal measured), the operator reviews them for hours and sometimes the next
//   morning, and "which show" is not something this file can know reliably (a restart mid-show, two
//   shows in a day). 2000 rows hold more than two of the biggest shows measured and cost ~1 MB.
//   Rows older than 30 days go regardless: the server holds the truth, and a row that old is only
//   noise on the screen. Eviction is by SALE time, so a Retry settling an old lot last cannot push a
//   newer sale out. (The in-memory array this replaces held 30 and silently popped the oldest.)
// - A BAD LINE IS SKIPPED, NEVER FATAL. Truncated by a power cut, binary noise, wrong types: the line
//   is dropped and every other row loads. An unreadable FILE yields no rows and is left alone (a
//   transient lock must not be answered by rewriting it).
// - THE FILE REPAIRS ITSELF, ATOMICALLY. When a load finds damage or redundancy it rewrites the file
//   (the disk layer replaces it via temp-file + rename, so a crash mid-repair leaves the old file).
//   If the repair fails the rows still load, and the next append starts on a fresh line so it can
//   never be glued to a torn fragment.
// - EVERY LINE CARRIES A VERSION. A line from a NEWER version is not shown (this version cannot read
//   it) but is kept byte for byte through a rewrite, so running an older build does not destroy it.
// - NOTHING SECRET IS WRITTEN. A row is rebuilt from a whitelist of fields; a token or a whole Sale
//   object handed in by mistake does not reach the file. Strings are length-bounded.

export const STORE_VERSION = 1
/** Rows kept. Not 30: a whole show (up to ~900 lots) and the next one, ~1 MB on disk. */
export const MAX_IDENTIFICATIONS = 2000
/** Rows whose sale is older than this are dropped. Rows dated in the future (a wrong clock) are kept. */
export const MAX_AGE_SEC = 30 * 24 * 60 * 60
/** The file is rewritten when it holds this many times the cap in lines, so it is bounded mid-session. */
const COMPACT_FACTOR = 3

export type RowStatus = 'transcribing' | 'done' | 'error' | 'skipped' | 'abandoned'
const STATUSES: readonly string[] = ['transcribing', 'done', 'error', 'skipped', 'abandoned']
const FIELD_KEYS = ['brand', 'item', 'color', 'size', 'retailPrice', 'summary'] as const
export type RowFields = Partial<Record<(typeof FIELD_KEYS)[number], string>>

export type IdentificationRow = {
  orderId: string
  roomId: string | null
  /** The sale's time, epoch seconds on this machine's clock. What the cap and the ordering use. */
  atEpochSec: number
  head: string
  lot: string
  price: string
  status: RowStatus
  text: string
  live?: boolean
  edited?: boolean
  fields?: RowFields
}

export type StoreIO = {
  /** The whole file, or null when there is none. May throw (locked, unreadable). */
  read(): string | null
  /** Append to the end of the file. May throw. */
  append(text: string): void
  /** Replace the whole file atomically. May throw. */
  replace(text: string): void
}

const LIMITS = { id: 120, head: 240, lot: 80, price: 40, text: 600, field: 240 }
const clip = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
const CLOSED_TEXT = 'Not identified: the app was closed before this lot was reached'

/** A row from untrusted input (a line of the file, or a caller), or null when it is not one. */
function normalize(raw: unknown, fromDisk: boolean): IdentificationRow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (typeof o.orderId !== 'string' || !o.orderId || o.orderId.length > LIMITS.id) return null
  if (typeof o.atEpochSec !== 'number' || !Number.isFinite(o.atEpochSec)) return null
  if (typeof o.status !== 'string' || !STATUSES.includes(o.status)) return null
  let status = o.status as RowStatus
  let text = clip(o.text, LIMITS.text)
  // A row that was still waiting when the app closed will never settle: say so rather than show
  // "Identifying…" forever.
  if (fromDisk && status === 'transcribing') {
    status = 'abandoned'
    text = CLOSED_TEXT
  }
  const out: IdentificationRow = {
    orderId: o.orderId,
    roomId: typeof o.roomId === 'string' && o.roomId.length <= LIMITS.id ? o.roomId : null,
    atEpochSec: o.atEpochSec,
    head: clip(o.head, LIMITS.head),
    lot: clip(o.lot, LIMITS.lot),
    price: clip(o.price, LIMITS.price),
    status,
    text,
  }
  if (o.live === true) out.live = true
  if (o.edited === true) out.edited = true
  if (o.fields && typeof o.fields === 'object' && !Array.isArray(o.fields)) {
    const f: RowFields = {}
    for (const k of FIELD_KEYS) {
      const v = (o.fields as Record<string, unknown>)[k]
      if (typeof v === 'string') f[k] = v.slice(0, LIMITS.field)
    }
    if (Object.keys(f).length) out.fields = f
  }
  return out
}

type Parsed = { kind: 'row'; row: IdentificationRow } | { kind: 'foreign' } | { kind: 'bad' }
function parseLine(line: string): Parsed {
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    return { kind: 'bad' }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { kind: 'bad' }
  const ver = (v as { v?: unknown }).v
  if (typeof ver !== 'number' || !Number.isInteger(ver) || ver < 1) return { kind: 'bad' }
  if (ver > STORE_VERSION) return { kind: 'foreign' }
  const row = normalize(v, true)
  return row ? { kind: 'row', row } : { kind: 'bad' }
}

const encode = (row: IdentificationRow): string => JSON.stringify({ v: STORE_VERSION, ...row })

export type IdentifyStore = {
  /** Read the file. Never throws. Newest sale first. */
  load(): IdentificationRow[]
  /** Persist a row (or its new state). Never throws; false when it was not written yet. */
  save(row: IdentificationRow): boolean
}

export function createIdentifyStore(
  io: StoreIO,
  opts: { now: () => number; maxCount?: number; maxAgeSec?: number },
): IdentifyStore {
  const maxCount = opts.maxCount ?? MAX_IDENTIFICATIONS
  const maxAgeSec = opts.maxAgeSec ?? MAX_AGE_SEC
  /** orderId -> row and the order it was last touched in (file order, which breaks ties). */
  let rows = new Map<string, { row: IdentificationRow; seq: number }>()
  let foreign: string[] = []
  let seq = 0
  let loaded = false
  let linesOnDisk = 0
  /** The file may not end in a newline (a torn write, or it could not be read): start the next append on a fresh line. */
  let needsNewline = false
  let pending: string[] = []

  /** Entries to keep: within the age cap, then the newest `maxCount` by sale time (later-written wins a tie). */
  function retained(): Array<{ row: IdentificationRow; seq: number }> {
    const oldest = opts.now() / 1000 - maxAgeSec
    return [...rows.values()]
      .filter((e) => e.row.atEpochSec >= oldest)
      .sort((a, b) => b.row.atEpochSec - a.row.atEpochSec || b.seq - a.seq)
      .slice(0, maxCount)
  }
  function prune(): void {
    if (rows.size === 0) return
    const keep = retained()
    if (keep.length !== rows.size) rows = new Map(keep.map((e) => [e.row.orderId, e]))
  }
  /** Rewrite the file from memory. True when it was written. Never throws. */
  function compact(): boolean {
    prune()
    if (foreign.length > maxCount) foreign = foreign.slice(foreign.length - maxCount)
    const own = [...rows.values()].sort((a, b) => a.seq - b.seq).map((e) => encode(e.row))
    const all = [...foreign, ...own]
    try {
      io.replace(all.length ? all.join('\n') + '\n' : '')
    } catch {
      return false
    }
    linesOnDisk = all.length
    needsNewline = false
    pending = []
    return true
  }
  const ordered = (): IdentificationRow[] =>
    retained().map((e) => e.row)

  function load(): IdentificationRow[] {
    loaded = true
    rows = new Map()
    foreign = []
    seq = 0
    pending = []
    let text: string | null
    try {
      text = io.read()
    } catch {
      // Unreadable (locked, permissions): no rows, and the file is NOT rewritten -- that would answer a
      // transient lock by destroying what is in it. Appends still go, on a fresh line.
      needsNewline = true
      return []
    }
    if (text === null || text === '') {
      linesOnDisk = 0
      needsNewline = false
      return []
    }
    const endsClean = text.endsWith('\n')
    let nonBlank = 0
    let bad = 0
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      nonBlank++
      const p = parseLine(line)
      if (p.kind === 'bad') bad++
      else if (p.kind === 'foreign') foreign.push(line.trim())
      else {
        rows.delete(p.row.orderId) // re-inserting moves it to the end: the last line wins
        rows.set(p.row.orderId, { row: p.row, seq: seq++ })
      }
    }
    prune()
    linesOnDisk = nonBlank
    needsNewline = !endsClean
    // Damage, redundancy (superseded or evicted lines) or a torn tail: write it back clean.
    if (!endsClean || bad > 0 || nonBlank !== rows.size + foreign.length) compact()
    return ordered()
  }

  function save(input: IdentificationRow): boolean {
    try {
      if (!loaded) load()
      const row = normalize(input, false)
      if (!row) return false
      rows.delete(row.orderId)
      rows.set(row.orderId, { row, seq: seq++ })
      pending.push(encode(row))
      if (pending.length > maxCount) pending.shift() // a disk that stays unwritable must not grow memory without bound
      prune()
      try {
        io.append((needsNewline ? '\n' : '') + pending.join('\n') + '\n')
      } catch {
        return false
      }
      linesOnDisk += pending.length
      pending = []
      needsNewline = false
      if (linesOnDisk > maxCount * COMPACT_FACTOR) compact()
      return true
    } catch {
      return false
    }
  }

  return { load, save }
}

/** What the renderer keeps per lot. Only the persisted part is named here; the rest (`sale`) never leaves memory. */
export type EntryLike = {
  head: string
  lot: string
  price: string
  status: RowStatus
  text: string
  live?: boolean
  edited?: boolean
  fields?: RowFields
  orderId?: string
  roomId?: string | null
  atEpochSec?: number
}

/** The row to persist for an entry, or null when it has no order or no sale time (a demo row). */
export function rowFromEntry(e: EntryLike): IdentificationRow | null {
  if (typeof e.orderId !== 'string' || typeof e.atEpochSec !== 'number') return null
  return normalize(
    {
      orderId: e.orderId,
      roomId: e.roomId ?? null,
      atEpochSec: e.atEpochSec,
      head: e.head,
      lot: e.lot,
      price: e.price,
      status: e.status,
      text: e.text,
      live: e.live,
      edited: e.edited,
      fields: e.fields,
    },
    false,
  )
}

/** The entry a persisted row restores. It has no `sale`: the audio is gone, so there is nothing to Retry. */
export function entryFromRow(r: IdentificationRow): Required<Pick<EntryLike, 'orderId' | 'roomId' | 'atEpochSec'>> & EntryLike {
  const e: Required<Pick<EntryLike, 'orderId' | 'roomId' | 'atEpochSec'>> & EntryLike = {
    head: r.head,
    lot: r.lot,
    price: r.price,
    status: r.status,
    text: r.text,
    orderId: r.orderId,
    roomId: r.roomId,
    atEpochSec: r.atEpochSec,
  }
  if (r.live) e.live = true
  if (r.edited) e.edited = true
  if (r.fields) e.fields = { ...r.fields }
  return e
}

/**
 * The entries to add to the screen from the rows the store loaded. Skips an order the screen already
 * has (a sale that arrived before the file was read) and never takes the list past `max`, counting
 * what is there. The result is in the order the rows came in (newest first), ready to append.
 */
export function restoreEntries(
  existing: ReadonlyArray<{ orderId?: string }>,
  rows: readonly IdentificationRow[],
  max: number,
): ReturnType<typeof entryFromRow>[] {
  const have = new Set(existing.map((e) => e.orderId))
  const out: ReturnType<typeof entryFromRow>[] = []
  for (const r of rows) {
    if (existing.length + out.length >= max) break
    if (have.has(r.orderId)) continue
    have.add(r.orderId)
    out.push(entryFromRow(r))
  }
  return out
}
