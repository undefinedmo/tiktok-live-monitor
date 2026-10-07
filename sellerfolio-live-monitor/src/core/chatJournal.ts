// Turns decoded chat messages into journal records, so the questions viewers ask can be found
// later. The goal here is the CORPUS: every line, faithfully, with a time and an author. It does
// not decide what is a question; that is a later initiative, and it can only be measured against
// a record that did not pre-filter.
//
// Each record carries a stable id the server upserts on, so a line journaled twice (a restart
// replays recent history; a frame arrives again) is one row, not two.
//
// CLOCKS. There are two, and they are never mixed:
//   - atMs / atEpochSec are TIKTOK'S clock: the message's own timestamp (common.timestamp).
//     This is the clock the order `createdAt`, the clip windows and the auction times are on, so
//     a chat line can be joined to a sale or a lot without a conversion.
//   - the journal envelope's `t` is THIS machine's clock at the moment of journaling (journal.ts).
//     The gap between t and atMs is the station's skew, which stays recoverable from the data.
//   When TikTok sent no usable timestamp, no time is written at all. This machine's clock is
//   never put into a TikTok-clock field. (The one place it appears is the fallback id, marked `L`.)
//
// THE LOT. Every line carries the lot that was in progress when it was said (`lot`, as the auction
// journal names it, e.g. "#42"; null when none is known). That is what makes the corpus worth keeping:
// "is it real?" means something only for the lot it was asked about. Without it a line can be joined to a
// lot only through `auction_start`, which is captured for about 29% of lots. The lot is whatever the app
// knows at the moment the frame is journaled (`lotInProgress`); a frame replayed after a restart is
// stamped with the lot then in progress, which is a limit of the source, not something this can know.
//
// Portable: no electron/DOM.

import { STATUS_BIDDING, STATUS_ENDED } from './auctionJournal'
import type { ChatMessage } from './types'

/** Longest chat text kept, in characters. TikTok's own limit is far below this (~150); the cap
 *  exists so a hostile or malformed frame cannot make one line enormous. Over it, the text is cut
 *  and `truncated` is set. */
export const MAX_TEXT_CHARS = 500
/** Longest nickname or @handle kept, in characters. */
export const MAX_NAME_CHARS = 100
/** How many recent ids are remembered to drop a re-delivered message locally. */
export const SEEN_CAP = 10_000
/** A timestamp before this is not a real chat time (0, or seconds read as ms). The server applies
 *  the same floor to the journal's own `t`. */
export const MIN_PLAUSIBLE_TS_MS = Date.UTC(2024, 0, 1)

export interface ChatJournalRecord {
  /** The stable id the uploader upserts on. */
  id: string
  /** The journal fields, written under type `chat`. `lot` is a string, or null when no lot is known. */
  data: Record<string, string | number | boolean | null>
}

/** A pin/get sample is trusted as "the pinned card right now" this long (the poll runs about once a second). */
export const PIN_LOT_FRESH_MS = 15_000
/** A bid on a lot names the lot in progress for this long; the bid feed has no "closed" signal of its own. */
export const IM_LOT_FRESH_MS = 60_000

/**
 * The lot in progress, from what the app hears, or null.
 *  1. the pinned card, while it is taking bids (a fresh pin sample, status bidding, with a lot number);
 *  2. else the lot of the latest bid, if it is recent -- unless the pinned card says that very lot has
 *     ENDED (the bid feed never says "closed", so it would otherwise name a finished lot for a minute);
 *  3. else null.
 */
export function lotInProgress(
  im: { lotNumber?: string; ts: number } | null,
  pin: { ts: number; current?: { status?: number; variantDesc?: string } } | null,
  nowMs: number,
): string | null {
  const named = (v: string | undefined): string | null => (v && v.trim() ? v.trim() : null)
  const c = pin && nowMs - pin.ts < PIN_LOT_FRESH_MS ? pin.current : undefined
  if (c?.status === STATUS_BIDDING) {
    const lot = named(c.variantDesc)
    if (lot) return lot
  }
  const bid = im && nowMs - im.ts < IM_LOT_FRESH_MS ? named(im.lotNumber) : null
  if (!bid) return null
  if (c?.status === STATUS_ENDED && named(c.variantDesc) === bid) return null
  return bid
}

/** cyrb53, base 36: a fast deterministic 53-bit string hash. Not cryptographic; it only has to
 *  keep two different texts or viewers from sharing an id part. It must NEVER change, or every
 *  journaled fallback id changes with it. */
function hash53(s: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/** Cut to `max` characters (code points, so an emoji is never split). */
function cap(s: string, max: number): { value: string; cut: boolean } {
  if (s.length <= max) return { value: s, cut: false } // UTF-16 length is an upper bound on characters
  const chars = Array.from(s)
  if (chars.length <= max) return { value: s, cut: false }
  return { value: chars.slice(0, max).join(''), cut: true }
}

export class ChatJournal {
  // Insertion-ordered, so the first key is always the oldest.
  private readonly seen = new Set<string>()

  /**
   * The records to journal for one decoded frame, in order. Messages already journaled are
   * dropped. `nowMs` is THIS machine's clock and is used for nothing but the id of a message
   * that carries no timestamp at all. `lot` is the lot in progress (see `lotInProgress`), stamped on
   * every line of the frame; it is never part of a line's id.
   */
  ingest(messages: ChatMessage[], nowMs: number, lot: string | null = null): ChatJournalRecord[] {
    const out: ChatJournalRecord[] = []
    const lotName = lot && lot.trim() ? lot.trim() : null
    const inFrame = new Map<string, number>()
    for (const m of messages) {
      const hasTime = m.ts >= MIN_PLAUSIBLE_TS_MS
      const id = this.idOf(m, hasTime, nowMs, inFrame)
      if (this.seen.has(id)) continue
      this.remember(id)

      const text = cap(m.text, MAX_TEXT_CHARS)
      const author = cap(m.nickname, MAX_NAME_CHARS)
      const handle = m.handle ? cap(m.handle, MAX_NAME_CHARS) : undefined
      const data: ChatJournalRecord['data'] = {}
      if (hasTime) {
        data['atEpochSec'] = Math.floor(m.ts / 1000)
        data['atMs'] = m.ts
      }
      data['author'] = author.value
      if (m.userId) data['authorId'] = m.userId
      if (handle) data['handle'] = handle.value
      data['text'] = text.value
      data['lot'] = lotName
      if (text.cut || author.cut || handle?.cut) data['truncated'] = true
      out.push({ id, data })
    }
    return out
  }

  private idOf(m: ChatMessage, hasTime: boolean, nowMs: number, inFrame: Map<string, number>): string {
    // TikTok's message id is unique per message: two viewers typing the same words in the same
    // millisecond have different ones, and a replay of history carries the same one.
    if (m.msgId) return `chat.${m.msgId}`
    // No message id: identify by when, who and what. The same viewer sending the same text in
    // the same millisecond is indistinguishable from a replay, so within ONE frame a repeat is a
    // real second line (numbered), and across frames it is the same line again (dropped).
    const who = m.userId ? `id:${m.userId}` : m.handle ? `h:${m.handle}` : `n:${m.nickname}`
    const base = `chatx.${hasTime ? m.ts : `L${nowMs}`}.u${hash53(who)}.t${hash53(m.text)}`
    const n = (inFrame.get(base) ?? 0) + 1
    inFrame.set(base, n)
    return n === 1 ? base : `${base}.${n}`
  }

  private remember(id: string): void {
    this.seen.add(id)
    if (this.seen.size > SEEN_CAP) this.seen.delete(this.seen.values().next().value!)
  }
}

/** What main.ts does with every decoded im frame: journal each new chat line. Returns how many
 *  were recorded. `record` is journal.ts's record(), injected so this stays portable and tested. */
export function journalChat(
  journal: ChatJournal,
  items: ChatMessage[],
  nowMs: number,
  record: (type: 'chat', data: ChatJournalRecord['data'], id: string) => void,
  lot: string | null = null,
): number {
  const recs = journal.ingest(items, nowMs, lot)
  for (const r of recs) record('chat', r.data, r.id)
  return recs.length
}
