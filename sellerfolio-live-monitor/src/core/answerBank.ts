// The shop's approved answers (from SellerFolio hq, GET /api/desktop/answers) and the matcher the
// chat desk uses to suggest one. Pure: no network, no DOM. The host still sees and approves every
// reply; a match only fills the editable reply box.

export interface BankAnswer {
  id: string
  topic: string
  brand: string | null
  keywords: string[]
  answer: string
  examples: string[]
}

const STOP = new Set(['the', 'and', 'for', 'are', 'you', 'your', 'this', 'that', 'with', 'what', 'have', 'does', 'can', 'how', 'will', 'its', 'there', 'they', 'from', 'about', 'please'])

function tokens(s: string): string[] {
  return (String(s ?? '').toLowerCase().match(/[a-z0-9']+/g) ?? []).filter((t) => t.length > 2 && !STOP.has(t))
}

function hasWord(haystack: string, needle: string): boolean {
  const n = String(needle ?? '').trim().toLowerCase()
  if (!n) return false
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  return new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`, 'i').test(haystack)
}

/** Validate an hq payload into a clean list; malformed rows are dropped, never thrown on. */
export function parseBank(body: unknown): BankAnswer[] {
  const rows = (body as { answers?: unknown } | null)?.answers
  if (!Array.isArray(rows)) return []
  const out: BankAnswer[] = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    if (typeof o.id !== 'string' || typeof o.answer !== 'string' || !o.answer.trim()) continue
    const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    out.push({
      id: o.id,
      topic: typeof o.topic === 'string' ? o.topic : '',
      brand: typeof o.brand === 'string' && o.brand.trim() ? o.brand : null,
      keywords: strs(o.keywords),
      answer: o.answer,
      examples: strs(o.examples),
    })
  }
  return out
}

/**
 * The best approved answer for a question, or null. Score = whole-word keyword hits + the best
 * example's token overlap. A brand answer only competes when the current lot names that brand,
 * and wins a tie against a shop-wide answer. Needs a score of at least 1.
 */
export function matchAnswer(question: string, lotTitle: string | null, bank: BankAnswer[]): BankAnswer | null {
  const q = String(question ?? '').toLowerCase()
  if (!q.trim() || !Array.isArray(bank)) return null
  const qTokens = new Set(tokens(q))
  let best: BankAnswer | null = null
  let bestScore = 0
  for (const a of bank) {
    if (a.brand && !(lotTitle && hasWord(lotTitle.toLowerCase(), a.brand))) continue
    let score = 0
    for (const k of a.keywords) if (hasWord(q, k)) score++
    let overlap = 0
    for (const ex of a.examples) {
      let n = 0
      for (const t of new Set(tokens(ex))) if (qTokens.has(t)) n++
      if (n > overlap) overlap = n
    }
    score += overlap
    if (score < 1) continue
    if (score > bestScore || (score === bestScore && a.brand && best && !best.brand)) { best = a; bestScore = score }
  }
  return best
}
