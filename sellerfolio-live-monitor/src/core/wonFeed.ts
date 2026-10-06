// Parses one on-screen "won" feed row into the fields our packing label needs.
// The dashboard paints "<name> won auction item <n> …" the instant an auction
// closes — sub-second, versus the ~4s floor on auction_result/get. name +
// auction number are the guaranteed fields (the whole point of the feed); price
// is best-effort. Pure: no DOM/electron, so it's unit-testable. Verify the exact
// feed wording live — TikTok can change it (see the Winner Capture README).

export interface WonFeedWin {
  name: string
  auctionNo: string
  price?: string
}

// "<name>" is non-greedy so it stops at the first " won auction item"; the number
// may be bare or prefixed with '#'.
const WON_RE = /^\s*(.+?)\s+won\s+auction\s+item\s+#?\s*(\d+)\b/i
const PRICE_RE = /\$\s?\d[\d,]*(?:\.\d+)?/

export function parseWonFeedRow(text: string): WonFeedWin | null {
  const m = (text ?? '').match(WON_RE)
  if (!m) return null
  const name = (m[1] ?? '').trim()
  if (!name) return null
  const price = text.match(PRICE_RE)?.[0]
  return { name, auctionNo: m[2]!, ...(price ? { price } : {}) }
}
