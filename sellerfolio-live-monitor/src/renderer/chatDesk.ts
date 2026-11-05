// LANE C — chat: the live chat column (rows, name colours, the host's own echo suppressed), its
// tools (Search chat + All chat / Questions N), question cards with a local-rule suggested reply
// + Approve (posts as Host through window.chatAPI.send, max 100 chars, never automatic) / Skip,
// the "Buyers are asking for" panel, and the Chat screen (Questions list + Wishlist with Mark
// fulfilled). The nav badge is fed through ./shell setChatBadge(open questions).
//
// The decisions live in core/chatIntent.ts (pure, tested); this file only paints them.
// renderer.ts calls initChatDesk() once, onChat(items) for every 'chat' event (its own
// appendChat is a no-op now — this draws the rows), and onChatScreenShown() when Chat opens.
//
// Chat volume: every line of the show is kept in memory (MEM_LINES), but only the newest DOM_ROWS
// are in the DOM — "Search chat" covers the rest, from memory and from the journal store
// (window.storeAPI.searchChat, lane B). Nothing here touches the print path or does disk I/O.

import type { ChatMessage } from '../core/types'
import type { StoreChat } from '../core/storeIndex'
import { ChatDeskModel, OwnEchoFilter, REPLY_MAX, lineId, isQuestion, wishOf, type ChatAuthor, type DeskQuestion, type DeskWish } from '../core/chatIntent'
import { setChatBadge } from './shell'

/** Rows kept in the All chat DOM. Older lines stay searchable. */
const DOM_ROWS = 200
/** Lines kept in memory for the local search (the store keeps the rest). */
const MEM_LINES = 5000
/** Rows a search shows. */
const SEARCH_LIMIT = 300
/** How long a reply we posted waits for its webcast echo (which we then hide: the card shows it). */
const ECHO_MS = 20_000
/** Open wishes listed in the right-column panel; the rest are on the Chat screen. */
const ASKING_ROWS = 8
const WISH_STORE_KEY = 'sf-chat-wishes-done'

interface Line {
  id: string
  nickname: string
  handle?: string
  text: string
  ts: number
  q?: DeskQuestion
  wish?: boolean
}

// Chat-name hues, picked to hold 4.5:1 on the white chat column. The first is the app accent.
const NAME_COLORS = ['#0a58f0', '#be185d', '#0a6b34', '#9a4708', '#6d28d9', '#0e7490']
function nameColor(n: string): string {
  let h = 0
  for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0
  return NAME_COLORS[h % NAME_COLORS.length]!
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

// ── state (one show) ─────────────────────────────────────────────────────────
let model = new ChatDeskModel()
let lines: Line[] = []
let seen = new Set<string>()
let show = ''
/** Replies we posted. The webcast echoes each back from the host account; that echo is hidden once. */
const echoes = new OwnEchoFilter(ECHO_MS)

let mode: 'all' | 'questions' = 'all'
let query = ''
let searchSeq = 0
let searchTimer: ReturnType<typeof setTimeout> | null = null
let deskDirty = false

// DOM (looked up in initChatDesk; every painter tolerates a missing node)
let list: HTMLElement | null = null
let searchIn: HTMLInputElement | null = null
let allBtn: HTMLButtonElement | null = null
let qBtn: HTMLButtonElement | null = null
let qCount: HTMLElement | null = null
let asking: HTMLElement | null = null
let screen: HTMLElement | null = null

/** Per question, the card elements currently painted (chat column + Chat screen). */
const rowCards = new Map<string, HTMLElement>()
const deskCards = new Map<string, HTMLElement>()

// ── lifecycle ────────────────────────────────────────────────────────────────
export function initChatDesk(): void {
  list = document.getElementById('chatList')
  asking = document.getElementById('askingPanel')
  screen = document.getElementById('chatScreen')
  const note = document.getElementById('chatNote')
  if (note) note.textContent = 'Replies post as Host after approval.'
  buildTools()
  screen?.addEventListener('focusout', () => setTimeout(() => { if (deskDirty && !focusIn(screen)) renderDesk() }, 0))
  adoptShow()
  syncCounts()
  paintAsking()
}

/** Called for every 'chat' event (renderer.ts no longer draws the rows itself). */
export function onChat(items: ChatMessage[]): void {
  adoptShow()
  const fresh: Line[] = []
  const now = Date.now()
  for (const m of items ?? []) {
    if (!m || typeof m.text !== 'string') continue
    const text = m.text.trim()
    // Our own approved reply coming back (same text AND from the host): the card already says
    // "Posted as Host". A viewer typing the same words is NOT hidden (core/chatIntent OwnEchoFilter).
    if (echoes.isEcho({ text, userId: m.userId, handle: m.handle, nickname: m.nickname }, now)) continue
    const id = lineId(m)
    if (seen.has(id)) continue
    seen.add(id)
    const line: Line = { id, nickname: String(m.nickname ?? '').trim() || 'Viewer', handle: m.handle, text, ts: m.ts }
    const r = model.ingest({ msgId: m.msgId, nickname: line.nickname, handle: m.handle, text, ts: m.ts })
    if (r?.kind === 'question') line.q = r.q
    else if (r?.kind === 'wish' || wishOf(text) !== null) line.wish = true
    lines.push(line)
    fresh.push(line)
  }
  if (!fresh.length) return
  if (lines.length > MEM_LINES) lines = lines.slice(-MEM_LINES)
  if (seen.size > MEM_LINES * 3) seen = new Set(lines.map((l) => l.id))
  appendLines(fresh)
  if (fresh.some((l) => l.q)) syncCounts()
  if (fresh.some((l) => l.wish)) paintAsking()
  if (fresh.some((l) => l.q || l.wish) && screenShown()) {
    if (focusIn(screen)) deskDirty = true
    else renderDesk()
  }
}

/**
 * The host account (the room owner), when the app knows it: its user id and/or @handle. Without it
 * the host is learned from the first echo of a reply we post (see OwnEchoFilter).
 */
export function setChatHost(host: ChatAuthor | null | undefined): void {
  echoes.setHost(host)
}

/** Called by renderer.ts showScreen() when the Chat screen becomes visible. */
export function onChatScreenShown(): void {
  renderDesk()
}

/**
 * The show is the room the top bar names (#room, set by renderer.ts on every 'room' event). A
 * different room starts a fresh desk: questions and wishes belong to one show.
 */
function adoptShow(): void {
  const r = (document.getElementById('room')?.textContent ?? '').trim()
  const known = r && r !== '—' && r !== '-' ? r : ''
  if (!known || known === show) return
  const first = !show
  show = known
  if (!first) {
    model = new ChatDeskModel()
    lines = []
    seen = new Set()
    rowCards.clear()
    deskCards.clear()
    renderList()
    syncCounts()
    paintAsking()
    if (screenShown()) renderDesk()
  }
  model.restoreFulfilled(loadDone())
  paintAsking()
}

function loadDone(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(WISH_STORE_KEY) ?? 'null') as { show?: string; ids?: unknown } | null
    return v && v.show === show && Array.isArray(v.ids) ? v.ids.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}
function saveDone(): void {
  if (!show) return
  try { localStorage.setItem(WISH_STORE_KEY, JSON.stringify({ show, ids: model.fulfilledIds().slice(-500) })) } catch { /* memory still has it */ }
}

// ── the chat column ──────────────────────────────────────────────────────────
function buildTools(): void {
  const tools = document.getElementById('chatTools')
  if (!tools) return
  tools.replaceChildren()
  searchIn = el('input', 'cd-in')
  searchIn.type = 'search'
  searchIn.placeholder = 'Search chat'
  searchIn.setAttribute('aria-label', 'Search chat')
  searchIn.addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => { query = searchIn!.value.trim(); renderList() }, 180)
  })
  searchIn.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && searchIn!.value) { searchIn!.value = ''; query = ''; renderList() }
  })
  const kinds = el('div', 'cd-kinds')
  kinds.setAttribute('role', 'group')
  kinds.setAttribute('aria-label', 'Show in chat')
  allBtn = el('button', 'cd-kind', 'All chat')
  allBtn.type = 'button'
  qBtn = el('button', 'cd-kind')
  qBtn.type = 'button'
  qCount = el('span', 'cd-kindn', '0')
  qBtn.append('Questions ', qCount)
  allBtn.addEventListener('click', () => { mode = 'all'; renderList() })
  qBtn.addEventListener('click', () => { mode = 'questions'; renderList() })
  kinds.append(allBtn, qBtn)
  tools.append(searchIn, kinds)
  paintKinds()
}

function paintKinds(): void {
  allBtn?.classList.toggle('on', mode === 'all')
  qBtn?.classList.toggle('on', mode === 'questions')
  allBtn?.setAttribute('aria-pressed', String(mode === 'all'))
  qBtn?.setAttribute('aria-pressed', String(mode === 'questions'))
}

function syncCounts(): void {
  const n = model.openCount()
  if (qCount) qCount.textContent = String(n)
  if (qBtn) qBtn.setAttribute('aria-label', `Questions, ${n} open`)
  try { setChatBadge(n) } catch (e) { console.error('[live-ui] chatDesk.setChatBadge', e) }
}

function matches(l: { nickname: string; handle?: string; text: string }, needle: string): boolean {
  return l.text.toLowerCase().includes(needle) || l.nickname.toLowerCase().includes(needle) || (l.handle ?? '').toLowerCase().includes(needle)
}

function plainRow(l: { nickname: string; handle?: string; text: string }, wish: boolean): HTMLElement {
  const row = el('div', 'chatrow')
  row.append(nameSpan(l.nickname, l.handle), el('span', 'chattext', ' ' + l.text))
  if (wish) row.appendChild(el('span', 'cd-wish', 'Wish'))
  return row
}

function nameSpan(nickname: string, handle?: string): HTMLElement {
  const nm = el('span', 'chatname', nickname)
  nm.style.color = nameColor(nickname)
  if (handle) nm.title = '@' + handle
  return nm
}

function rowFor(l: Line): HTMLElement {
  return l.q ? questionRow(l.q) : plainRow(l, !!l.wish)
}

function hint(text: string): HTMLElement {
  return el('div', 'cd-hint', text)
}

function placeholder(text: string): HTMLElement {
  return el('span', 'mono placeholder', text)
}

function nearBottom(e: HTMLElement): boolean {
  return e.scrollHeight - e.scrollTop - e.clientHeight < 60
}

function focusIn(e: HTMLElement | null): boolean {
  return !!e && !!document.activeElement && e.contains(document.activeElement)
}

function screenShown(): boolean {
  return !!screen && screen.style.display !== 'none' && screen.style.display !== ''
}

/** New lines while the column is showing live chat: append, never rebuild (keeps a reply box's focus). */
function appendLines(fresh: Line[]): void {
  if (!list) return
  if (query) {
    // A search shows a fixed result; say there is more instead of moving it under the host.
    const needle = query.toLowerCase()
    const n = fresh.filter((l) => matches(l, needle) && (mode === 'all' || l.q)).length
    if (n) setSearchNote(`${n} new matching line${n === 1 ? '' : 's'} since this search. Search again to see ${n === 1 ? 'it' : 'them'}.`)
    return
  }
  const add = mode === 'all' ? fresh : fresh.filter((l) => l.q)
  if (!add.length) return
  const stick = nearBottom(list) && !focusIn(list)
  list.querySelector(':scope > .placeholder')?.remove()
  for (const l of add) list.appendChild(rowFor(l))
  if (mode === 'all') trimDom()
  if (stick) list.scrollTop = list.scrollHeight
}

/** Keep at most DOM_ROWS chat rows; never pull out a card the host is typing in. */
function trimDom(): void {
  if (!list) return
  let rows = list.querySelectorAll(':scope > .chatrow').length
  if (rows <= DOM_ROWS) return
  while (rows > DOM_ROWS) {
    const first = list.querySelector(':scope > .chatrow')
    if (!first || focusIn(first as HTMLElement)) break
    first.remove()
    rows--
  }
  if (!list.querySelector(':scope > .cd-hint')) list.prepend(hint(`Showing the last ${DOM_ROWS} lines. Search finds the rest.`))
}

function setSearchNote(text: string): void {
  const n = list?.querySelector(':scope > .cd-hint.live')
  if (n) n.textContent = text
  else if (list) { const h = hint(text); h.classList.add('live'); list.appendChild(h) }
}

/** Rebuild the column for the current mode + search. */
function renderList(): void {
  paintKinds()
  if (!list) return
  if (query) { void runSearch(query); return }
  searchSeq++ // a search still in flight must not paint over this
  const shown = mode === 'all' ? lines.slice(-DOM_ROWS) : lines.filter((l) => l.q)
  const nodes: HTMLElement[] = []
  if (mode === 'all' && lines.length > DOM_ROWS) nodes.push(hint(`Showing the last ${DOM_ROWS} lines. Search finds the rest.`))
  for (const l of shown) nodes.push(rowFor(l))
  if (!shown.length) nodes.push(placeholder(mode === 'all' ? 'waiting for comments...' : 'no questions yet'))
  list.replaceChildren(...nodes)
  list.scrollTop = mode === 'all' ? list.scrollHeight : 0
}

/** Search: this show's lines in memory, plus the journal store for anything older. */
async function runSearch(text: string): Promise<void> {
  const seq = ++searchSeq
  const needle = text.toLowerCase()
  const local = lines.filter((l) => matches(l, needle) && (mode === 'all' || l.q)).slice(-SEARCH_LIMIT)
  paintSearch(text, local, [], true)
  let stored: StoreChat[] = []
  try {
    const r = await window.storeAPI?.searchChat(text, SEARCH_LIMIT)
    if (r && r.kind === 'chat') stored = r.rows
  } catch { /* the store is best-effort: the local result stands */ }
  if (seq !== searchSeq) return
  const have = new Set(local.map((l) => contentKey(l)))
  const known = new Set(lines.map((l) => contentKey(l)))
  const extra = stored.filter((s) => {
    const k = contentKey(s)
    if (have.has(k) || known.has(k)) return false // in memory: shown above if it matched
    return mode === 'all' || isQuestion(s.text)
  })
  paintSearch(text, local, extra, false)
}

function contentKey(l: { nickname: string; text: string; ts: number }): string {
  return `${l.ts}|${l.nickname}|${String(l.text).trim()}`
}

function paintSearch(text: string, local: Line[], stored: StoreChat[], pending: boolean): void {
  if (!list) return
  const rows: { ts: number; node: () => HTMLElement }[] = [
    ...stored.map((s) => ({ ts: s.ts, node: () => plainRow({ nickname: s.nickname, handle: s.handle, text: s.text }, wishOf(s.text) !== null) })),
    ...local.map((l) => ({ ts: l.ts, node: () => rowFor(l) })),
  ]
  rows.sort((a, b) => a.ts - b.ts)
  const kept = rows.slice(-SEARCH_LIMIT)
  const n = kept.length
  const what = mode === 'questions' ? 'question' : 'line'
  const head = n
    ? `${n}${rows.length > n ? '+' : ''} ${what}${n === 1 ? '' : 's'} matching “${text}”${pending ? ' (searching older chat…)' : ''}`
    : pending ? `Searching for “${text}”…` : `No ${what}s match “${text}”.`
  list.replaceChildren(hint(head), ...kept.map((r) => r.node()))
  list.scrollTop = list.scrollHeight
}

// ── question cards ───────────────────────────────────────────────────────────
function cardClass(q: DeskQuestion): string {
  if (q.state === 'posted') return 'done'
  if (q.state === 'skipped') return 'skip'
  return q.reply.trim() ? 'ready' : 'need'
}

function replyLabel(q: DeskQuestion): string {
  if (!q.reply.trim()) return 'Needs your reply'
  return `${q.suggested ? 'Suggested reply' : 'Your reply'}, ${q.reply.length} of ${REPLY_MAX}`
}

/** The card in the chat column (cached per question so a repaint keeps its place in the list). */
function questionRow(q: DeskQuestion): HTMLElement {
  let row = rowCards.get(q.id)
  if (!row) { row = el('div'); rowCards.set(q.id, row) }
  paintRow(q, row)
  return row
}

function paintRow(q: DeskQuestion, row: HTMLElement): void {
  row.className = `chatrow cd-q ${cardClass(q)}`
  const head = el('div')
  head.append(nameSpan(q.buyer, q.handle), el('span', 'chattext', ' ' + q.text))
  const kids: HTMLElement[] = [head]
  if (q.state === 'posted') {
    const host = el('div', 'cd-host')
    host.append(el('b', '', 'Posted as Host '), document.createTextNode(q.posted ?? q.reply))
    kids.push(host)
  } else if (q.state === 'skipped') {
    const sub = el('div', 'cd-sub')
    const undo = el('button', 'cd-link', 'Undo')
    undo.type = 'button'
    undo.addEventListener('click', () => { model.reopen(q); repaint(q) })
    sub.append(el('span', '', 'Skipped'), undo)
    kids.push(sub)
  } else {
    kids.push(...replyEditor(q, 'Approve', row))
  }
  row.replaceChildren(...kids)
}

/** Reply box + Approve + status line + Skip — shared by the column card and the Chat screen. */
function replyEditor(q: DeskQuestion, approveText: string, card: HTMLElement): HTMLElement[] {
  const sending = q.state === 'sending'
  const line = el('div', 'cd-reply')
  const input = el('input', 'cd-in')
  input.maxLength = REPLY_MAX
  input.value = q.reply
  input.placeholder = 'Write a reply'
  input.setAttribute('aria-label', `Reply to ${q.buyer}`)
  input.disabled = sending
  const ok = el('button', 'cd-btn primary', sending ? 'Posting…' : approveText)
  ok.type = 'button'
  ok.disabled = sending || !q.reply.trim()
  const sub = el('div', 'cd-sub')
  const label = el('span', q.error ? 'cd-err' : '', q.error ? `Not posted: ${q.error}. Try again.` : replyLabel(q))
  label.setAttribute('role', q.error ? 'alert' : 'status')
  const skip = el('button', 'cd-link', 'Skip')
  skip.type = 'button'
  skip.disabled = sending
  input.addEventListener('input', () => {
    model.setReply(q, input.value)
    ok.disabled = !q.reply.trim()
    if (!q.error) label.textContent = replyLabel(q)
    card.className = card.classList.contains('cd-q') ? `chatrow cd-q ${cardClass(q)}` : `cd-q2 ${cardClass(q)}`
    syncTwin(q, input)
  })
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void approve(q) } })
  ok.addEventListener('click', () => void approve(q))
  skip.addEventListener('click', () => { model.skip(q); repaint(q) })
  line.append(input, ok)
  sub.append(label, skip)
  return [line, sub]
}

/** The same question's box on the other view follows what the host types. */
function syncTwin(q: DeskQuestion, from: HTMLInputElement): void {
  for (const card of [rowCards.get(q.id), deskCards.get(q.id)]) {
    const i = card?.querySelector('input')
    if (i && i !== from) i.value = q.reply
  }
}

/** Approve: the ONLY place a reply is posted. Only from the host's click / Enter, never automatic. */
async function approve(q: DeskQuestion): Promise<void> {
  const text = model.beginSend(q)
  if (!text) return
  repaint(q)
  echoes.sent(text, Date.now()) // the echo can arrive before the post's answer
  let r: { ok: boolean; error?: string }
  if (!window.chatAPI) r = { ok: false, error: 'chat is not available in this window' }
  else {
    try { r = await window.chatAPI.send(text) }
    catch (e) { r = { ok: false, error: e instanceof Error ? e.message : String(e) } }
  }
  if (!r?.ok) echoes.failed(text)
  model.sendResult(q, text, r)
  repaint(q)
}

function repaint(q: DeskQuestion): void {
  const row = rowCards.get(q.id)
  if (row) paintRow(q, row)
  const card = deskCards.get(q.id)
  if (card) paintDeskQuestion(q, card)
  syncCounts()
  if (screenShown()) paintDeskHead()
}

// ── "Buyers are asking for" ──────────────────────────────────────────────────
function paintAsking(): void {
  if (!asking) return
  const open = model.openWishes()
  asking.hidden = open.length === 0
  if (!open.length) { asking.replaceChildren(); return }
  const head = el('div', 'panel-head')
  head.append(el('span', 'eyebrow', 'Buyers are asking for'), el('span', 'meta', String(open.length)))
  const rows = el('div', 'cd-rows')
  for (const w of open.slice(0, ASKING_ROWS)) {
    const r = el('div', 'cd-row')
    r.append(el('span', 'cd-item', w.item), el('span', 'cd-tag', w.buyer))
    rows.appendChild(r)
  }
  if (open.length > ASKING_ROWS) rows.appendChild(el('div', 'cd-more', `${open.length - ASKING_ROWS} more on the Chat screen`))
  asking.replaceChildren(head, rows)
}

// ── the Chat screen ──────────────────────────────────────────────────────────
let deskQHead: HTMLElement | null = null

function renderDesk(): void {
  if (!screen) return
  deskDirty = false
  deskCards.clear()
  const left = el('div', 'panel cd-panel cd-questions')
  const lh = el('div', 'panel-head')
  deskQHead = el('span', 'meta')
  lh.append(el('span', 'eyebrow', 'Questions'), deskQHead)
  left.appendChild(lh)
  const qs = [...model.questions].reverse() // newest first
  if (!qs.length) left.appendChild(el('div', 'cd-pad', 'No questions yet. Lines ending in “?” or starting with a question word land here.'))
  for (const q of qs) {
    const card = el('div', 'cd-q2')
    deskCards.set(q.id, card)
    paintDeskQuestion(q, card)
    left.appendChild(card)
  }

  const right = el('div', 'panel cd-panel cd-wishlist')
  const rh = el('div', 'panel-head')
  const openW = model.openWishes().length
  rh.append(el('span', 'eyebrow', 'Wishlist'), el('span', 'meta', model.wishes.length ? `${openW} open` : ''))
  right.appendChild(rh)
  const ws = [...model.wishes].reverse()
  if (!ws.length) right.appendChild(el('div', 'cd-pad', 'No wishes yet. A line starting with ISO or LF (“ISO black uggs 7”) lands here.'))
  for (const w of ws) right.appendChild(wishCard(w))

  screen.replaceChildren(left, right)
  paintDeskHead()
}

function paintDeskHead(): void {
  if (deskQHead) deskQHead.textContent = model.questions.length ? `${model.openCount()} open` : ''
}

function statusTag(q: DeskQuestion): HTMLElement {
  const [cls, text] =
    q.state === 'posted' ? ['done', 'Posted as Host']
      : q.state === 'skipped' ? ['skip', 'Skipped']
        : q.state === 'sending' ? ['ready', 'Posting…']
          : q.error ? ['need', 'Not posted']
            : q.reply.trim() ? ['ready', q.suggested ? 'Suggested' : 'Ready']
              : ['need', 'Needs you']
  return el('span', `cd-tag cd-st ${cls}`, text)
}

function paintDeskQuestion(q: DeskQuestion, card: HTMLElement): void {
  card.className = `cd-q2 ${cardClass(q)}`
  const top = el('div', 'cd-sub')
  const who = el('b', '', q.buyer)
  if (q.handle) who.title = '@' + q.handle
  top.append(who, statusTag(q))
  const kids: HTMLElement[] = [top, el('div', 'cd-qtext', q.text)]
  if (q.state === 'posted') {
    const host = el('div', 'cd-host')
    host.append(el('b', '', 'Posted as Host '), document.createTextNode(q.posted ?? q.reply))
    kids.push(host)
  } else if (q.state === 'skipped') {
    const sub = el('div', 'cd-sub')
    const undo = el('button', 'cd-link', 'Undo skip')
    undo.type = 'button'
    undo.addEventListener('click', () => { model.reopen(q); repaint(q) })
    sub.append(el('span', ''), undo)
    kids.push(sub)
  } else {
    kids.push(...replyEditor(q, 'Approve and post', card))
  }
  card.replaceChildren(...kids)
}

function wishCard(w: DeskWish): HTMLElement {
  const card = el('div', 'cd-q2' + (w.fulfilled ? ' fulfilled' : ''))
  const top = el('div', 'cd-sub')
  const who = el('div')
  who.append(el('div', 'cd-item', w.item), el('small', '', w.buyer))
  const b = el('button', 'cd-btn' + (w.fulfilled ? ' on' : ''), w.fulfilled ? 'Fulfilled' : 'Mark fulfilled')
  b.type = 'button'
  b.setAttribute('aria-pressed', String(w.fulfilled))
  if (w.fulfilled) b.title = 'Click to put it back on the list'
  b.addEventListener('click', () => {
    model.setFulfilled(w, !w.fulfilled)
    saveDone()
    paintAsking()
    renderDesk()
  })
  top.append(who, b)
  card.appendChild(top)
  return card
}
