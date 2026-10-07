import { describe, it, expect } from 'vitest'
import type { ChatMessage } from '../types'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { decodeChat } from '../chat'
import { ChatJournal, journalChat, MAX_NAME_CHARS, MAX_TEXT_CHARS, MIN_PLAUSIBLE_TS_MS, SEEN_CAP } from '../chatJournal'

const T0 = 1781991025523 // a real chat timestamp, TikTok's clock, ms
const NOW = 1781991026000 // this machine's clock when the frame arrived; deliberately NOT equal to T0
const msg = (o: Partial<ChatMessage> = {}): ChatMessage => ({ msgId: '7653593120676039438', userId: '6841363407170978822', nickname: 'Latrice Colburn', handle: 'latricecolburn', text: 'Cute', ts: T0, ...o })
const one = (m: ChatMessage, now = NOW) => new ChatJournal().ingest([m], now)

describe('ChatJournal: what a chat line becomes', () => {
  it('carries the time (seconds and ms, TikTok clock), author, id, handle and text and nothing else', () => {
    const [r] = one(msg({ avatarUrl: 'https://p19-common-sign.tiktokcdn-us.com/avatar.jpeg?x-expires=1' }))
    expect(r).toEqual({
      id: 'chat.7653593120676039438',
      data: {
        atEpochSec: 1781991025,
        atMs: 1781991025523,
        author: 'Latrice Colburn',
        authorId: '6841363407170978822',
        handle: 'latricecolburn',
        text: 'Cute',
      },
    })
  })

  it('never carries the avatar url (a signed, expiring ~1 KB link on every line, and no use to anyone)', () => {
    const [r] = one(msg({ avatarUrl: 'https://example.invalid/a.jpeg' }))
    expect(JSON.stringify(r)).not.toContain('example.invalid')
    expect(Object.keys(r!.data)).not.toContain('avatarUrl')
  })

  it('omits author fields the frame did not carry rather than writing empty strings', () => {
    const [r] = one(msg({ userId: undefined, handle: undefined }))
    expect(Object.keys(r!.data).sort()).toEqual(['atEpochSec', 'atMs', 'author', 'text'])
  })

  it('keeps every line, in order: questions, statements, emoji, links and blanks alike (no detector here)', () => {
    const texts = ['how much is shipping?', 'lol', '🔥🔥🔥', 'https://example.com', '   ', 'is it real??', '.']
    const out = new ChatJournal().ingest(texts.map((text, i) => msg({ msgId: String(100 + i), text, ts: T0 + i })), NOW)
    expect(out.map((r) => r.data['text'])).toEqual(texts)
  })

  it('returns nothing for no messages', () => {
    expect(new ChatJournal().ingest([], NOW)).toEqual([])
  })
})

describe('ChatJournal: the stable id', () => {
  it("is TikTok's own message id, so two viewers posting identical text in the same millisecond stay two records", () => {
    const a = msg({ msgId: '111', userId: '1', nickname: 'Ann', text: 'size?' })
    const b = msg({ msgId: '222', userId: '2', nickname: 'Bob', text: 'size?' })
    const out = new ChatJournal().ingest([a, b], NOW)
    expect(out.map((r) => r.id)).toEqual(['chat.111', 'chat.222'])
  })

  it('does not change when the same message is seen again, even by a fresh journal after a restart', () => {
    const first = new ChatJournal().ingest([msg()], NOW)
    const again = new ChatJournal().ingest([msg()], NOW + 600_000)
    expect(again).toEqual(first)
  })

  it('drops a message already journaled, whether re-delivered in a later frame or repeated in one', () => {
    const j = new ChatJournal()
    expect(j.ingest([msg()], NOW)).toHaveLength(1)
    expect(j.ingest([msg()], NOW + 1000)).toEqual([])
    const k = new ChatJournal()
    expect(k.ingest([msg(), msg()], NOW)).toHaveLength(1)
  })

  it('a re-delivered frame with one new message journals only the new one', () => {
    const j = new ChatJournal()
    j.ingest([msg({ msgId: '1' }), msg({ msgId: '2' })], NOW)
    expect(j.ingest([msg({ msgId: '2' }), msg({ msgId: '3' })], NOW).map((r) => r.id)).toEqual(['chat.3'])
  })

  it("fits the server's id rules: [A-Za-z0-9._:-], at most 120 characters", () => {
    const wild = msg({ msgId: undefined, userId: undefined, handle: undefined, nickname: '名前 🍒 / ;;\n"quote"'.repeat(20), text: 'x '.repeat(400) })
    for (const m of [msg(), wild, msg({ msgId: undefined, ts: 0 })]) {
      const [r] = one(m)
      expect(r!.id).toMatch(/^[A-Za-z0-9._:-]+$/)
      expect(r!.id.length).toBeLessThanOrEqual(120)
    }
  })
})

describe('ChatJournal: the stable id when TikTok sent no message id', () => {
  const bare = (o: Partial<ChatMessage> = {}) => msg({ msgId: undefined, ...o })

  it('is a fixed function of when, who and what, pinned, because changing it would double-count every old line', () => {
    expect(one(bare())[0]!.id).toBe('chatx.1781991025523.ukvxdpmf73h.tco3ck4jbo7')
    expect(one(bare({ userId: undefined, handle: 'latricecolburn' }))[0]!.id).toBe('chatx.1781991025523.u1kf7nepvxpm.tco3ck4jbo7')
    expect(one(bare({ userId: undefined, handle: undefined }))[0]!.id).toBe('chatx.1781991025523.u16pchg17usg.tco3ck4jbo7')
  })

  it("is the same on every ingest of the same line (nothing from this machine's clock enters it)", () => {
    expect(one(bare(), 5)[0]!.id).toBe(one(bare(), 5_000_000_000_000)[0]!.id)
  })

  it('separates two viewers who type the same text in the same millisecond', () => {
    const out = new ChatJournal().ingest([bare({ userId: '1' }), bare({ userId: '2' })], NOW)
    expect(new Set(out.map((r) => r.id)).size).toBe(2)
  })

  it('separates the same viewer typing the same text at different milliseconds', () => {
    const out = new ChatJournal().ingest([bare({ ts: T0 }), bare({ ts: T0 + 1 })], NOW)
    expect(new Set(out.map((r) => r.id)).size).toBe(2)
  })

  it('separates the same viewer, same millisecond, different text', () => {
    const out = new ChatJournal().ingest([bare({ text: 'a' }), bare({ text: 'b' })], NOW)
    expect(new Set(out.map((r) => r.id)).size).toBe(2)
  })

  it("keeps BOTH of a viewer's identical lines in one frame, numbering the second", () => {
    const out = new ChatJournal().ingest([bare(), bare()], NOW)
    const base = one(bare())[0]!.id
    expect(out.map((r) => r.id)).toEqual([base, `${base}.2`])
  })

  it('numbers a third identical line .3, and a re-delivery of all three adds nothing', () => {
    const j = new ChatJournal()
    const base = one(bare())[0]!.id
    expect(j.ingest([bare(), bare(), bare()], NOW).map((r) => r.id)).toEqual([base, `${base}.2`, `${base}.3`])
    expect(j.ingest([bare(), bare(), bare()], NOW)).toEqual([])
  })

  it('does not let a user id "5" and a nickname "5" share an id', () => {
    const a = one(bare({ userId: '5', handle: undefined, nickname: 'x' }))[0]!.id
    const b = one(bare({ userId: undefined, handle: undefined, nickname: '5' }))[0]!.id
    expect(a).not.toBe(b)
  })

  it('is decided by the whole text, not just the part that is kept', () => {
    const prefix = 'a'.repeat(MAX_TEXT_CHARS)
    const out = new ChatJournal().ingest([bare({ text: `${prefix}1` }), bare({ text: `${prefix}2` })], NOW)
    expect(new Set(out.map((r) => r.id)).size).toBe(2)
  })

  it("falls back to this machine's arrival time only when there is no timestamp at all, and says so in the id", () => {
    const [r] = one(bare({ ts: 0 }), 1781991026000)
    expect(r!.id).toBe('chatx.L1781991026000.ukvxdpmf73h.tco3ck4jbo7')
  })
})

describe('ChatJournal: which clock each time is on', () => {
  it("atMs and atEpochSec are TikTok's timestamp, floored to the second, and never touched by this machine's clock", () => {
    const a = one(msg({ ts: 1781991025999 }), 1)[0]!.data
    const b = one(msg({ ts: 1781991025999 }), 9_999_999_999_999)[0]!.data
    expect(a).toEqual(b)
    expect(a['atMs']).toBe(1781991025999)
    expect(a['atEpochSec']).toBe(1781991025) // floor, not round
  })

  it("writes no time at all when TikTok sent none, rather than stamping this machine's clock into a server-clock field", () => {
    const d = one(msg({ ts: 0 }), NOW)[0]!.data
    expect('atMs' in d).toBe(false)
    expect('atEpochSec' in d).toBe(false)
    expect(JSON.stringify(d)).not.toContain(String(NOW))
  })

  it('treats a timestamp before 2024-01-01 UTC as missing, and one exactly at it as real', () => {
    expect(MIN_PLAUSIBLE_TS_MS).toBe(Date.UTC(2024, 0, 1))
    expect('atMs' in one(msg({ ts: MIN_PLAUSIBLE_TS_MS - 1 }))[0]!.data).toBe(false)
    expect(one(msg({ ts: MIN_PLAUSIBLE_TS_MS }))[0]!.data['atMs']).toBe(MIN_PLAUSIBLE_TS_MS)
    // the common failure: a timestamp in SECONDS read as milliseconds
    expect('atMs' in one(msg({ ts: 1781991025 }))[0]!.data).toBe(false)
  })
})

describe('ChatJournal: volume bounds', () => {
  it('keeps a text of exactly the cap whole and flags nothing', () => {
    const text = 'x'.repeat(MAX_TEXT_CHARS)
    const d = one(msg({ text }))[0]!.data
    expect(MAX_TEXT_CHARS).toBe(500)
    expect(d['text']).toBe(text)
    expect('truncated' in d).toBe(false)
  })

  it('cuts one character over the cap to exactly the cap and says it did', () => {
    const d = one(msg({ text: 'x'.repeat(MAX_TEXT_CHARS + 1) }))[0]!.data
    expect(d['text']).toBe('x'.repeat(MAX_TEXT_CHARS))
    expect(d['truncated']).toBe(true)
  })

  it('counts and cuts by character, never splitting an emoji', () => {
    const d = one(msg({ text: '🍒'.repeat(MAX_TEXT_CHARS + 5) }))[0]!.data
    expect(d['text']).toBe('🍒'.repeat(MAX_TEXT_CHARS))
    expect(d['truncated']).toBe(true)
    const fits = one(msg({ text: '🍒'.repeat(MAX_TEXT_CHARS) }))[0]!.data // 1000 UTF-16 units, 500 characters
    expect(fits['text']).toBe('🍒'.repeat(MAX_TEXT_CHARS))
    expect('truncated' in fits).toBe(false)
  })

  it('flags truncation for the text alone, the author alone, and the handle alone', () => {
    const long = (c: string) => c.repeat(MAX_NAME_CHARS + 1)
    expect(one(msg({ text: 'x'.repeat(MAX_TEXT_CHARS + 1) }))[0]!.data['truncated']).toBe(true)
    expect(one(msg({ nickname: long('n') }))[0]!.data['truncated']).toBe(true)
    expect(one(msg({ handle: long('h') }))[0]!.data['truncated']).toBe(true)
    expect('truncated' in one(msg())[0]!.data).toBe(false)
  })

  it('caps the author name and handle too, and flags that as well', () => {
    expect(MAX_NAME_CHARS).toBe(100)
    const d = one(msg({ nickname: 'n'.repeat(MAX_NAME_CHARS + 1), handle: 'h'.repeat(MAX_NAME_CHARS + 1) }))[0]!.data
    expect(d['author']).toBe('n'.repeat(MAX_NAME_CHARS))
    expect(d['handle']).toBe('h'.repeat(MAX_NAME_CHARS))
    expect(d['truncated']).toBe(true)
    const exact = one(msg({ nickname: 'n'.repeat(MAX_NAME_CHARS) }))[0]!.data
    expect(exact['author']).toBe('n'.repeat(MAX_NAME_CHARS))
    expect('truncated' in exact).toBe(false)
  })

  it("the worst line still fits the server's 8 KB payload limit", () => {
    const worst = msg({ nickname: '🍒'.repeat(MAX_NAME_CHARS * 2), handle: '🍒'.repeat(MAX_NAME_CHARS * 2), text: '🍒'.repeat(MAX_TEXT_CHARS * 2) })
    const r = one(worst)[0]!
    expect(Buffer.byteLength(JSON.stringify(r.data), 'utf8')).toBeLessThan(8 * 1024)
  })

  it('remembers exactly SEEN_CAP ids for the dedupe: the oldest is forgotten one past it, not before', () => {
    expect(SEEN_CAP).toBe(10_000)
    const j = new ChatJournal()
    const batch = Array.from({ length: SEEN_CAP }, (_, i) => msg({ msgId: String(i + 1) }))
    expect(j.ingest(batch, NOW)).toHaveLength(SEEN_CAP)
    expect(j.ingest([msg({ msgId: '1' })], NOW)).toEqual([]) // still remembered: exactly SEEN_CAP are held
    j.ingest([msg({ msgId: String(SEEN_CAP + 1) })], NOW) // one more pushes the oldest (1) out; 2..10001 remain
    expect(j.ingest([msg({ msgId: '2' })], NOW)).toEqual([]) // 2 is the oldest kept, and is still remembered
    expect(j.ingest([msg({ msgId: '1' })], NOW)).toHaveLength(1) // 1 was forgotten, so it is journaled again
  })
})

// The hand-off main.ts makes for every im frame. Fed a REAL captured frame, so a field the decoder
// stopped reading, or one the journal stopped carrying, shows up here and not in a show.
describe('journalChat: a real frame to journal records', () => {
  const { b64 } = JSON.parse(readFileSync(fileURLToPath(new URL('../../../fixtures/im-fetch-sample.json', import.meta.url)), 'utf8'))
  const items = decodeChat(Uint8Array.from(Buffer.from(b64, 'base64')))

  it('records each chat line once, as type "chat", with its stable id', () => {
    const calls: [string, object, string][] = []
    const n = journalChat(new ChatJournal(), items, NOW, (type, data, id) => calls.push([type, data, id]))
    expect(n).toBe(1)
    expect(calls).toEqual([[
      'chat',
      { atEpochSec: 1781991025, atMs: 1781991025523, author: 'Latrice Colburn', authorId: '6841363407170978822', handle: 'latricecolburn', text: 'Cute' },
      'chat.7653593120676039438',
    ]])
  })

  it('records nothing the second time the same frame arrives', () => {
    const j = new ChatJournal()
    const calls: string[] = []
    journalChat(j, items, NOW, (_t, _d, id) => calls.push(id))
    expect(journalChat(j, items, NOW + 1000, (_t, _d, id) => calls.push(id))).toBe(0)
    expect(calls).toHaveLength(1)
  })

  it('records nothing for a frame with no chat', () => {
    expect(journalChat(new ChatJournal(), decodeChat(new Uint8Array([1, 2, 3])), NOW, () => { throw new Error('should not record') })).toBe(0)
  })
})
