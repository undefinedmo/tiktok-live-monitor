import type { Money } from './types'

export function parseMoney(formatted: string | undefined | null): Money {
  const text = formatted ?? ''
  // Keep a LEADING minus. Stripping every non-digit turned "-$5.00" into +500 cents, so a
  // refund or adjustment row would ADD to the show's total instead of subtracting. Only a
  // sign at the very start counts — the '-' in a range or an id is not a negation.
  const negative = /^\s*-/.test(text)
  const numeric = Number(text.replace(/[^0-9.]/g, '')) || 0
  return { cents: Math.round(numeric * 100) * (negative ? -1 : 1), formatted: text }
}
