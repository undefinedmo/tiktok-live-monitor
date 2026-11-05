// LANE C — chat intent: is a chat line a buyer question, a wish, or neither; the local,
// rule-based suggested reply for a question; and ChatDeskModel, the per-show state the chat desk
// paints (questions with their reply / approval state, wishes with their fulfilled flag).
// Pure (no DOM, no Electron, no network): unit-tested in src/core/__tests__/chatIntent.test.ts.

/** TikTok's cap on a live comment. The reply box and suggestReply() never exceed it. */
export const REPLY_MAX = 100

export type ChatIntent =
  | { kind: 'question' }
  /** `item` is the wished-for thing: the rest of the line after the ISO / LF marker, trimmed. */
  | { kind: 'wish'; item: string }
  | { kind: 'none' }

/** One leading @mention ("@cathy " / "@cathy, ") — buyers often address the host first. */
const LEADING_MENTION = /^\s*@[^\s,:]+[\s,:]*/

/** The line without one leading @mention, trimmed. */
function stripMention(text: string): string {
  return String(text ?? '').replace(LEADING_MENTION, '').trim()
}

/** Words that open a question when they lead the line (BUILD.md decision 7, as the prototype). */
const QUESTION_WORDS = ['is', 'are', 'do', 'does', 'did', 'can', 'could', 'will', 'would', 'what', 'which', 'who', 'why', 'how', 'when', 'where', 'any']
const LEADING_QUESTION_WORD = new RegExp(`^(?:${QUESTION_WORDS.join('|')})\\b`, 'i')

/**
 * Heuristic question test: the line ends with `?` (trailing spaces allowed), or starts with a
 * question word — either optionally after one leading @mention. A line with no letter or digit
 * ("?", "??", "😍?") is not a question.
 */
export function isQuestion(text: string): boolean {
  const t = stripMention(text)
  if (!/[\p{L}\p{N}]/u.test(t)) return false
  return /\?\s*$/.test(t) || LEADING_QUESTION_WORD.test(t)
}

/**
 * Owner decision 4: a line that starts with `ISO ` ("in search of") or `LF ` ("looking for"),
 * case-insensitive, after an optional leading @mention, is a wish; the rest of the line is the
 * item ("ISO: x" works too; a stray ":" / "-" right after the marker is dropped). Returns null
 * for anything else — including an empty item, "ISO" glued to a word ("isolate"), and
 * "i wish" / "!wish".
 */
export function wishOf(text: string): string | null {
  const m = /^(?:iso|lf)(?:\s+|\s*:)(.+)$/is.exec(stripMention(text))
  if (!m) return null
  const item = m[1]!.replace(/^[\s:–—-]+/, '').trim()
  return item ? item : null
}

/** Classify one chat line. A wish wins over a question ("ISO size 7 uggs?" is a wish). */
export function chatIntent(text: string): ChatIntent {
  const item = wishOf(text)
  if (item !== null) return { kind: 'wish', item }
  return isQuestion(text) ? { kind: 'question' } : { kind: 'none' }
}

/**
 * Local keyword rules for the suggested reply (owner decision 2: no AI, no hq call). First match
 * wins; order puts the specific asks before the generic ones. Every reply is ≤ REPLY_MAX — the
 * test pins that. The host always sees and approves the reply; nothing is sent from here.
 */
export const REPLY_RULES: ReadonlyArray<{ name: string; test: RegExp; reply: string }> = [
  { name: 'run it back', test: /\b(run (it|that|this) back|rerun|re-run|run (it|that) again|do (it|that) again)\b/i, reply: "We'll try to run it back! Stay close and watch for it." },
  { name: 'shipping', test: /\b(ship(s|ping|ped)?|combine[sd]?|combining|bundle[sd]?|postage|deliver(y|ed)?)\b/i, reply: 'Yes! Everything you win tonight combines and ships together.' },
  { name: 'authentic', test: /\b(authentic|real|legit|genuine|fake)\b/i, reply: 'Yes, every item is 100% authentic.' },
  { name: 'size', test: /\b(sizes?|sizing|fits?|tts|true to size|runs? (small|big|large))\b/i, reply: "The size is on each listing. Ask about a lot and we'll check it for you!" },
  { name: 'price', test: /\b(price[sd]?|how much|cost|start(ing)? (bid|price|at))\b|\$/i, reply: 'The current bid is on the auction card. Bids start low, so jump in!' },
  { name: 'available', test: /\b(available|in stock|still have|any (more|left)|more of)\b/i, reply: "Let me check! If we have it, we'll put it up." },
  { name: 'colour', test: /\b(colou?rs?)\b/i, reply: "Colors are on each listing. Ask about a lot and we'll show it up close!" },
  { name: 'condition', test: /\b(condition|nwt|new with tags|used|pre-?owned|flaws?|damaged?)\b/i, reply: "Condition is on each listing. Ask about a lot and we'll show it up close!" },
]

/**
 * The suggested reply for a question from REPLY_RULES, or null when no rule matches (the card
 * then says "Needs your reply"). The result is at most REPLY_MAX characters.
 */
export function suggestReply(text: string): string | null {
  const t = stripMention(text)
  if (!t) return null
  for (const r of REPLY_RULES) if (r.test.test(t)) return r.reply.slice(0, REPLY_MAX)
  return null
}

// ── the per-show desk state ──────────────────────────────────────────────────

export type QuestionState = 'open' | 'sending' | 'posted' | 'skipped'

export interface DeskQuestion {
  /** Stable per message (TikTok's msgId, else ts|nickname|text). */
  id: string
  buyer: string
  handle?: string
  text: string
  ts: number
  /** The reply in the box (suggested, then whatever the host types). ≤ REPLY_MAX. */
  reply: string
  /** True while `reply` is still the untouched local-rule suggestion. */
  suggested: boolean
  state: QuestionState
  /** The last failed post's reason; cleared on the next attempt. */
  error?: string
  /** The exact text that went out as Host. */
  posted?: string
}

export interface DeskWish {
  id: string
  buyer: string
  handle?: string
  item: string
  ts: number
  fulfilled: boolean
}

/** The minimum a chat line needs to be classified (types.ts ChatMessage fits). */
export interface DeskLine {
  msgId?: string
  nickname: string
  handle?: string
  text: string
  ts: number
}

/** A stable id for a chat line: TikTok's msgId when present, else its content. */
export function lineId(m: DeskLine): string {
  return m.msgId ? `m:${m.msgId}` : `k:${m.ts}|${m.nickname}|${m.text}`
}

/**
 * The questions and wishes of ONE show. The renderer keeps one per show and throws it away when
 * the room changes. Order is arrival order. Never sends anything: beginSend() hands back the text
 * the HOST approved, and the caller posts it and reports back with sendResult().
 */
export class ChatDeskModel {
  readonly questions: DeskQuestion[] = []
  readonly wishes: DeskWish[] = []
  private readonly seen = new Set<string>()
  /** Wish ids the host marked fulfilled before (restored from storage); applied as lines arrive. */
  private readonly doneIds = new Set<string>()

  /** `cap` bounds each list; past it the oldest settled entry goes first (open ones are kept). */
  constructor(private readonly cap = 2000) {}

  /** Classify a line and record it. Returns what it became, or null (not a question/wish, or seen). */
  ingest(m: DeskLine): { kind: 'question'; q: DeskQuestion } | { kind: 'wish'; w: DeskWish } | null {
    const id = lineId(m)
    if (this.seen.has(id)) return null
    const intent = chatIntent(m.text)
    if (intent.kind === 'none') return null
    this.seen.add(id)
    const buyer = String(m.nickname ?? '').trim() || 'Viewer'
    if (intent.kind === 'wish') {
      // The same buyer repeating the same wish is one wish.
      const dupe = this.wishes.find((w) => !w.fulfilled && w.buyer === buyer && w.item.toLowerCase() === intent.item.toLowerCase())
      if (dupe) return null
      const w: DeskWish = { id, buyer, handle: m.handle, item: intent.item, ts: m.ts, fulfilled: this.doneIds.has(id) }
      this.wishes.push(w)
      trim(this.wishes, this.cap, (x) => x.fulfilled)
      return { kind: 'wish', w }
    }
    const reply = suggestReply(m.text) ?? ''
    const q: DeskQuestion = { id, buyer, handle: m.handle, text: String(m.text).trim(), ts: m.ts, reply, suggested: !!reply, state: 'open' }
    this.questions.push(q)
    trim(this.questions, this.cap, (x) => x.state === 'posted' || x.state === 'skipped')
    return { kind: 'question', q }
  }

  /** Questions still waiting for the host (open or mid-send) — the nav badge. */
  openCount(): number {
    let n = 0
    for (const q of this.questions) if (q.state === 'open' || q.state === 'sending') n++
    return n
  }

  /** Wishes not yet fulfilled, newest first — the "Buyers are asking for" panel. */
  openWishes(): DeskWish[] {
    return this.wishes.filter((w) => !w.fulfilled).reverse()
  }

  /** The host edited the reply box. Clamped to REPLY_MAX. */
  setReply(q: DeskQuestion, text: string): void {
    q.reply = String(text ?? '').slice(0, REPLY_MAX)
    q.suggested = false
  }

  /**
   * The host pressed Approve. Returns the text to post (trimmed, ≤ REPLY_MAX) and marks the
   * question 'sending', or null when there is nothing to send (empty reply, not open).
   */
  beginSend(q: DeskQuestion): string | null {
    if (q.state !== 'open') return null
    const text = q.reply.trim().slice(0, REPLY_MAX)
    if (!text) return null
    q.state = 'sending'
    q.error = undefined
    return text
  }

  /** The post's outcome. Failure re-opens the card with the reason; success marks it posted. */
  sendResult(q: DeskQuestion, text: string, r: { ok: boolean; error?: string } | null | undefined): void {
    if (q.state !== 'sending') return
    if (r?.ok) { q.state = 'posted'; q.posted = text; q.error = undefined; return }
    q.state = 'open'
    q.error = (r?.error && String(r.error).trim()) || 'no answer from TikTok'
  }

  skip(q: DeskQuestion): void {
    if (q.state === 'open') q.state = 'skipped'
  }

  /** Put a skipped question back in the queue. */
  reopen(q: DeskQuestion): void {
    if (q.state === 'skipped') q.state = 'open'
  }

  setFulfilled(w: DeskWish, on: boolean): void {
    w.fulfilled = on
    if (on) this.doneIds.add(w.id)
    else this.doneIds.delete(w.id)
  }

  /** Ids of fulfilled wishes, to persist (a restart replays recent chat, so they come back). */
  fulfilledIds(): string[] {
    return [...this.doneIds]
  }
  /** Restore persisted fulfilled ids: applies to wishes already here and to ones that arrive later. */
  restoreFulfilled(ids: Iterable<string>): void {
    for (const id of ids) if (typeof id === 'string') this.doneIds.add(id)
    for (const w of this.wishes) if (this.doneIds.has(w.id)) w.fulfilled = true
  }
}

/** Drop entries past `cap`: the oldest one `settled()` says may go, else the oldest of all. */
function trim<T>(list: T[], cap: number, settled: (x: T) => boolean): void {
  while (list.length > cap) {
    const i = list.findIndex(settled)
    list.splice(i >= 0 ? i : 0, 1)
  }
}
