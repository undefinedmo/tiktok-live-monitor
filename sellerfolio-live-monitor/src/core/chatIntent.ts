// LANE C — chat intent: is a chat line a buyer question, a wish, or neither; and the local,
// rule-based suggested reply for a question. Pure (no DOM, no Electron): unit-test it in
// src/core/__tests__/chatIntent.test.ts.
//
// SCAFFOLD STUB: every export below is inert (detects nothing, suggests nothing). Lane C fills it.

/** TikTok's cap on a live comment. The reply box and suggestReply() never exceed it. */
export const REPLY_MAX = 100

export type ChatIntent =
  | { kind: 'question' }
  /** `item` is the wished-for thing: the rest of the line after the ISO / LF marker, trimmed. */
  | { kind: 'wish'; item: string }
  | { kind: 'none' }

/**
 * Classify one chat line (BUILD.md owner decisions 4 and 7).
 *
 * - **Wish**: the line starts with `ISO ` ("in search of") or `LF ` ("looking for"),
 *   case-insensitive, optionally after ONE leading `@mention`. The rest of the line is the item;
 *   an empty rest is not a wish. NOT "i wish" / "!wish".
 * - **Question**: heuristic, like the prototype — ends with `?` (trailing spaces allowed), or
 *   starts with a question word (is, are, do, does, did, can, could, will, what, which, how,
 *   when, where…). Wish wins over question when both match.
 * - otherwise `none`.
 */
export function chatIntent(text: string): ChatIntent {
  void text
  return { kind: 'none' }
}

/**
 * The suggested reply for a question, from simple LOCAL keyword rules (shipping, authentic,
 * sizes, still available, …) — no AI, no network. Returns '' when no rule matches (the card
 * then says "Needs your reply"). The result is at most REPLY_MAX characters.
 */
export function suggestReply(text: string): string {
  void text
  return ''
}
