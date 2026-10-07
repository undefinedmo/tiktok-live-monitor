// The two pure decisions behind journal.ts's record(): which FILE a record goes to and what its
// LINE looks like. They live here so they are tested; the electron side only supplies the clock,
// the sequence and the directory. Portable: no electron/DOM, no fs.

export interface LineParts {
  runId: string
  /** Used for the id only when no explicit id is given. */
  seq: number
  /** THIS machine's clock when the record is made. It becomes the envelope's `t`. */
  nowMs: number
  room?: string
  session?: string
  type: string
  data: object
  /** A stable, content-derived id (a chat line's). Without one the id is `<run>-<seq>`. */
  id?: string
}

/** One JSON line, no newline. The envelope always wins over any same-named key in `data`. */
export function buildJournalLine(p: LineParts): string {
  const envelope = { v: 1, id: p.id ?? `${p.runId}-${p.seq}`, t: p.nowMs, room: p.room, session: p.session, type: p.type }
  return JSON.stringify({ ...envelope, ...p.data, ...envelope })
}

/** The chat journal's own file suffix. journalWorker orders uploads by it (see journalSync). */
export const CHAT_SUFFIX = '.chat.jsonl'

/**
 * One file per live room. Records that arrive before the room is known go to a dated catch-all.
 * Chat has its own file beside it: a busy show's chat outnumbers everything else many times over,
 * and in one file it would queue ahead of the sales on upload and compete with them for the
 * writer's backlog.
 */
export function journalFileName(room: string | undefined, type: string, isoDate: string): string {
  const stem = room ? `show-${room}` : `unassigned-${isoDate}`
  return type === 'chat' ? `${stem}${CHAT_SUFFIX}` : `${stem}.jsonl`
}
