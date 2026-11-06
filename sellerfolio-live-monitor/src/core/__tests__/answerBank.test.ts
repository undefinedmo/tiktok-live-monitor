import { describe, it, expect } from 'vitest'
import { matchAnswer, parseBank, type BankAnswer } from '../answerBank'
import { suggestReply } from '../chatIntent'

const shop = (id: string, keywords: string[], answer: string, examples: string[] = []): BankAnswer => ({ id, topic: id, brand: null, keywords, answer, examples })
const SHIP = shop('ship', ['ship', 'shipping'], 'We ship within 2 business days.')
const SIZE = shop('size', ['size', 'small'], 'Sizing is on each listing.')
const ALO: BankAnswer = { id: 'alo', topic: 'alo sizing', brand: 'Alo', keywords: ['small', 'size'], answer: 'Alo runs true to size.', examples: [] }
const bank = [SHIP, SIZE, ALO]

describe('matchAnswer', () => {
  it('matches a shop answer on a whole-word keyword', () => {
    expect(matchAnswer('when do you ship?', null, bank)?.id).toBe('ship')
  })
  it('brand answer beats a shop answer when the lot is that brand', () => {
    expect(matchAnswer('does alo run small', 'Alo Yoga legging', bank)?.id).toBe('alo')
  })
  it('does not pick the brand answer for another brand lot', () => {
    expect(matchAnswer('does alo run small', 'UGG Tasman', bank)?.id).toBe('size')
  })
  it('returns null with no keyword hit', () => {
    expect(matchAnswer('hello there', 'Alo Yoga legging', bank)).toBeNull()
  })
  it('keywords are whole-word', () => {
    expect(matchAnswer('i love the shipment color', null, [SHIP])).toBeNull()
  })
  it('example overlap counts', () => {
    const a = shop('ret', [], 'Returns within 30 days.', ['can I send it back'])
    expect(matchAnswer('can i send this back', null, [a])?.id).toBe('ret')
  })
})

describe('suggestReply with a bank', () => {
  it('bank answer first', () => {
    expect(suggestReply('when do you ship?', { bank })).toBe('We ship within 2 business days.')
  })
  it('falls back to the rule without a bank', () => {
    expect(suggestReply('when do you ship?')).toMatch(/ships together/)
    expect(suggestReply('when do you ship?', { bank: [] })).toMatch(/ships together/)
  })
})

describe('parseBank', () => {
  it('drops malformed rows', () => {
    expect(parseBank({ answers: [{ id: 'a', topic: 't', brand: null, keywords: ['x'], answer: 'y', examples: [] }, { id: 1 }, null] })).toHaveLength(1)
    expect(parseBank(null)).toEqual([])
  })
})
