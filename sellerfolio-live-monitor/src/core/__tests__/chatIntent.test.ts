import { describe, it, expect } from 'vitest'
import { isQuestion, wishOf, chatIntent, suggestReply, REPLY_MAX, REPLY_RULES, ChatDeskModel, lineId } from '../chatIntent'

describe('isQuestion', () => {
  it('a trailing ? (spaces allowed)', () => {
    expect(isQuestion('size 7?')).toBe(true)
    expect(isQuestion('size 7?   ')).toBe(true)
    expect(isQuestion('love it!!')).toBe(false)
  })
  it('a leading question word, any case', () => {
    for (const w of ['is', 'are', 'do', 'does', 'did', 'can', 'could', 'will', 'what', 'which', 'how', 'when', 'where', 'any']) {
      expect(isQuestion(`${w} this one available`)).toBe(true)
      expect(isQuestion(`${w.toUpperCase()} this one available`)).toBe(true)
    }
  })
  it('the word must stand alone (no prefixes of longer words)', () => {
    expect(isQuestion('island vibes')).toBe(false)
    expect(isQuestion('anyway love this')).toBe(false)
    expect(isQuestion('canada here')).toBe(false)
    expect(isQuestion('howdy')).toBe(false)
  })
  it('tolerates one leading @mention', () => {
    expect(isQuestion('@cathy is it real')).toBe(true)
    expect(isQuestion('@cathy, what size')).toBe(true)
    expect(isQuestion('@cathy love it')).toBe(false)
    expect(isQuestion('@cathy size 6?')).toBe(true)
  })
  it('a line with no word is not a question', () => {
    expect(isQuestion('?')).toBe(false)
    expect(isQuestion('??')).toBe(false)
    expect(isQuestion('@cathy ?')).toBe(false)
    expect(isQuestion('')).toBe(false)
  })
  it('a question word in the middle does not count', () => {
    expect(isQuestion('wow is that gorgeous')).toBe(false)
  })
})

describe('wishOf (owner decision 4)', () => {
  it('ISO / LF prefix, case-insensitive, rest is the item', () => {
    expect(wishOf('ISO black uggs size 7')).toBe('black uggs size 7')
    expect(wishOf('iso black uggs')).toBe('black uggs')
    expect(wishOf('LF alo leggings M')).toBe('alo leggings M')
    expect(wishOf('lf   coach bag  ')).toBe('coach bag')
  })
  it('after an optional leading @mention', () => {
    expect(wishOf('@cathy ISO tasman slippers')).toBe('tasman slippers')
    expect(wishOf('@cathy, lf lulu belt bag')).toBe('lulu belt bag')
  })
  it('drops a stray separator after the marker', () => {
    expect(wishOf('ISO: tazz 8')).toBe('tazz 8')
    expect(wishOf('LF - mini bag')).toBe('mini bag')
    expect(wishOf('iso:uggs')).toBe('uggs')
  })
  it('NOT i wish / !wish, not glued words, not empty, not mid-line', () => {
    expect(wishOf('i wish black uggs')).toBeNull()
    expect(wishOf('!wish black uggs')).toBeNull()
    expect(wishOf('isolate this')).toBeNull()
    expect(wishOf('lfg!!')).toBeNull()
    expect(wishOf('ISO')).toBeNull()
    expect(wishOf('ISO   ')).toBeNull()
    expect(wishOf('ISO :')).toBeNull()
    expect(wishOf('I am ISO uggs')).toBeNull()
    expect(wishOf('ISO\tuggs')).toBe('uggs')
  })
})

describe('chatIntent', () => {
  it('wish wins over question', () => {
    expect(chatIntent('ISO size 7 uggs?')).toEqual({ kind: 'wish', item: 'size 7 uggs?' })
  })
  it('question / none', () => {
    expect(chatIntent('is it real?')).toEqual({ kind: 'question' })
    expect(chatIntent('gorgeous')).toEqual({ kind: 'none' })
  })
})

describe('suggestReply', () => {
  it('matches the keyword rules', () => {
    expect(suggestReply('do you combine shipping?')).toMatch(/ships together/)
    expect(suggestReply('is this authentic?')).toMatch(/authentic/)
    expect(suggestReply('is it real')).toMatch(/authentic/)
    expect(suggestReply('what size is this?')).toMatch(/size/)
    expect(suggestReply('do they run small?')).toMatch(/size/)
    expect(suggestReply('how much is it?')).toMatch(/bid/)
    expect(suggestReply('can you run it back?')).toMatch(/run it back/)
    expect(suggestReply('any more left?')).toMatch(/check/)
    expect(suggestReply('what colors?')).toMatch(/Colors/)
    expect(suggestReply('is it NWT?')).toMatch(/Condition/)
  })
  it('null when nothing matches (the card says Needs your reply)', () => {
    expect(suggestReply('where are you located?')).toBeNull()
    expect(suggestReply('')).toBeNull()
    expect(suggestReply('really cute?')).toBeNull() // "real" is a whole word only
  })
  it('run it back beats the generic rules', () => {
    expect(suggestReply('run it back, how much?')).toMatch(/run it back/)
  })
  it('every rule reply fits TikTok\'s cap', () => {
    for (const r of REPLY_RULES) expect(r.reply.length).toBeLessThanOrEqual(REPLY_MAX)
    expect(REPLY_MAX).toBe(100)
  })
})

const line = (text: string, n = 1, nickname = 'Ann') => ({ msgId: String(n), nickname, text, ts: 1_700_000_000_000 + n })

describe('ChatDeskModel', () => {
  it('records questions and wishes, ignores the rest and repeats', () => {
    const m = new ChatDeskModel()
    expect(m.ingest(line('is it real?', 1))?.kind).toBe('question')
    expect(m.ingest(line('is it real?', 1))).toBeNull() // same msgId
    expect(m.ingest(line('ISO uggs 7', 2))?.kind).toBe('wish')
    expect(m.ingest(line('love it', 3))).toBeNull()
    expect(m.questions).toHaveLength(1)
    expect(m.wishes).toHaveLength(1)
    expect(m.openCount()).toBe(1)
  })
  it('a question carries its suggestion (or none)', () => {
    const m = new ChatDeskModel()
    const a = m.ingest(line('is it authentic?', 1))
    const b = m.ingest(line('where are you?', 2))
    expect(a?.kind === 'question' && a.q.suggested && a.q.reply).toMatch(/authentic/)
    expect(b?.kind === 'question' && b.q.reply).toBe('')
    expect(b?.kind === 'question' && b.q.suggested).toBe(false)
  })
  it('the same buyer repeating the same wish is one wish', () => {
    const m = new ChatDeskModel()
    m.ingest(line('ISO uggs 7', 1))
    expect(m.ingest(line('iso UGGS 7', 2))).toBeNull()
    expect(m.ingest(line('ISO uggs 7', 3, 'Bea'))?.kind).toBe('wish')
    expect(m.wishes).toHaveLength(2)
  })
  it('without a msgId the id is the content', () => {
    expect(lineId({ nickname: 'A', text: 'x', ts: 5 })).toBe('k:5|A|x')
    expect(lineId({ msgId: '9', nickname: 'A', text: 'x', ts: 5 })).toBe('m:9')
  })

  it('approve: posts only the approved text, ≤100, and only once', () => {
    const m = new ChatDeskModel()
    const r = m.ingest(line('is it real?', 1))
    if (r?.kind !== 'question') throw new Error('no question')
    const q = r.q
    m.setReply(q, '  ' + 'x'.repeat(150))
    expect(q.reply.length).toBe(REPLY_MAX)
    const text = m.beginSend(q)
    expect(text).toBe('x'.repeat(98)) // the leading spaces counted against the 100, then trimmed
    expect(q.state).toBe('sending')
    expect(m.beginSend(q)).toBeNull() // a double click does not post twice
    expect(m.openCount()).toBe(1) // still waiting while it sends
    m.sendResult(q, text!, { ok: true })
    expect(q.state).toBe('posted')
    expect(q.posted).toBe(text)
    expect(m.openCount()).toBe(0)
  })
  it('a failed post keeps the card open and says why', () => {
    const m = new ChatDeskModel()
    const r = m.ingest(line('is it real?', 1))
    if (r?.kind !== 'question') throw new Error('no question')
    const t = m.beginSend(r.q)!
    m.sendResult(r.q, t, { ok: false, error: 'streamer key not ready' })
    expect(r.q.state).toBe('open')
    expect(r.q.error).toBe('streamer key not ready')
    m.beginSend(r.q)
    expect(r.q.error).toBeUndefined()
    m.sendResult(r.q, t, undefined)
    expect(r.q.error).toBe('no answer from TikTok')
  })
  it('an empty reply cannot be approved', () => {
    const m = new ChatDeskModel()
    const r = m.ingest(line('where are you?', 1))
    if (r?.kind !== 'question') throw new Error('no question')
    expect(m.beginSend(r.q)).toBeNull()
    m.setReply(r.q, '   ')
    expect(m.beginSend(r.q)).toBeNull()
    expect(r.q.state).toBe('open')
  })
  it('skip / reopen', () => {
    const m = new ChatDeskModel()
    const r = m.ingest(line('is it real?', 1))
    if (r?.kind !== 'question') throw new Error('no question')
    m.skip(r.q)
    expect(r.q.state).toBe('skipped')
    expect(m.openCount()).toBe(0)
    m.reopen(r.q)
    expect(m.openCount()).toBe(1)
  })

  it('fulfilled wishes drop out of the open list (newest first) and persist by id', () => {
    const m = new ChatDeskModel()
    m.ingest(line('ISO a', 1)); m.ingest(line('ISO b', 2)); m.ingest(line('ISO c', 3))
    expect(m.openWishes().map((w) => w.item)).toEqual(['c', 'b', 'a'])
    m.setFulfilled(m.wishes[1]!, true)
    expect(m.openWishes().map((w) => w.item)).toEqual(['c', 'a'])
    expect(m.fulfilledIds()).toEqual(['m:2'])

    // A restart replays the chat: restored ids apply to wishes that arrive afterwards.
    const again = new ChatDeskModel()
    again.restoreFulfilled(m.fulfilledIds())
    again.ingest(line('ISO a', 1)); again.ingest(line('ISO b', 2))
    expect(again.openWishes().map((w) => w.item)).toEqual(['a'])
    again.setFulfilled(again.wishes[1]!, false)
    expect(again.fulfilledIds()).toEqual([])
  })

  it('caps each list, dropping settled entries before open ones', () => {
    const m = new ChatDeskModel(3)
    const qs = [1, 2, 3].map((n) => m.ingest(line(`is it ${n}?`, n)))
    if (qs[1]?.kind === 'question') m.skip(qs[1].q)
    m.ingest(line('is it 4?', 4))
    expect(m.questions.map((q) => q.text)).toEqual(['is it 1?', 'is it 3?', 'is it 4?'])
  })
})
