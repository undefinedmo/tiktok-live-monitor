import type { Money } from './types'

export function parseMoney(formatted: string | undefined | null): Money {
  const text = formatted ?? ''
  const numeric = Number(text.replace(/[^0-9.]/g, '')) || 0
  return { cents: Math.round(numeric * 100), formatted: text }
}
