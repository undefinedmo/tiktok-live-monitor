const DIGITS = /\D/g

export function normalizeDigits(s: string): string {
  return (s || '').replace(DIGITS, '')
}

/** restack §9: a CSV tracking number is a substring of the (longer) Impb barcode decode. */
export function matchTracking(decoded: string, trackingNos: string[]): string | null {
  const d = normalizeDigits(decoded)
  if (!d) return null
  for (const t of trackingNos) {
    const nt = normalizeDigits(t)
    if (nt && d.includes(nt)) return t
  }
  return null
}
