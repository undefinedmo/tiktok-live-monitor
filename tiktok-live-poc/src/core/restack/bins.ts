export type Bin = 'A' | 'B' | '?'

/** Bin label derived from the product name (mirrors tiktok-label-restack §5.1). */
export function binOf(productName: string | null | undefined): Bin {
  const s = productName ?? ''
  if (/bin\s*a/i.test(s)) return 'A'
  if (/bin\s*b/i.test(s)) return 'B'
  return '?'
}
