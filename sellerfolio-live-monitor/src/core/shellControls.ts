// LANE A — pure logic behind the shell: Text size steps and the hardware-key filter.
// No DOM, no Electron: shared by renderer/shell.ts and electron/controlIpc.ts, tested in vitest.

/** Text size steps, in percent. 100 is the default; Reset returns to it. */
export const TEXT_STEPS = [85, 90, 100, 110, 120, 130] as const
export const TEXT_DEFAULT = 100
/** At this size and above the top bar sheds the live pill and the Room meter (as the prototype does). */
export const TEXT_BIG = 120

/** The nearest step to any percent (ties go to the smaller step); garbage → 100. */
export function nearestStep(pct: number): number {
  if (!Number.isFinite(pct) || pct <= 0) return TEXT_DEFAULT
  let best: number = TEXT_STEPS[0]
  for (const s of TEXT_STEPS) if (Math.abs(s - pct) < Math.abs(best - pct)) best = s
  return best
}

/** A zoom factor (1 = 100%) → its step in percent. */
export function factorToPct(factor: number): number {
  return nearestStep(Math.round(Number(factor) * 100))
}

/** A percent → the zoom factor actually applied (always a step). */
export function pctToFactor(pct: number): number {
  return nearestStep(pct) / 100
}

/** One step smaller (dir −1) or larger (+1); stays put at either end. */
export function stepText(pct: number, dir: -1 | 1): number {
  const i = TEXT_STEPS.indexOf(nearestStep(pct) as (typeof TEXT_STEPS)[number])
  const j = Math.min(Math.max(i + dir, 0), TEXT_STEPS.length - 1)
  return TEXT_STEPS[j] ?? TEXT_DEFAULT
}

const TEXT_MIN = TEXT_STEPS[0]
const TEXT_MAX = TEXT_STEPS[TEXT_STEPS.length - 1] ?? TEXT_DEFAULT
export function canShrink(pct: number): boolean { return nearestStep(pct) > TEXT_MIN }
export function canGrow(pct: number): boolean { return nearestStep(pct) < TEXT_MAX }
export function isBigText(pct: number): boolean { return nearestStep(pct) >= TEXT_BIG }

/** The saved Text size file (`{ "factor": 1.1 }`) → a step factor; anything unreadable → 1. */
export function parseSavedZoom(raw: string | null | undefined): number {
  if (!raw) return 1
  try {
    const v = JSON.parse(raw) as { factor?: unknown }
    const f = Number(v?.factor)
    return Number.isFinite(f) && f > 0 ? pctToFactor(f * 100) : 1
  } catch {
    return 1
  }
}

/** The shape of Electron's `before-input-event` input this filter needs. */
export interface KeyInput { type: string; key: string; code?: string; isAutoRepeat?: boolean; control?: boolean; alt?: boolean; meta?: boolean }

/**
 * The hardware key to forward to the viewer, or null. Only a fresh key-down of F14 without
 * modifiers counts: a held key's auto-repeat must not print the same label five times.
 */
export function controlKeyOf(input: KeyInput): 'F14' | null {
  if (input.type !== 'keyDown' || input.isAutoRepeat) return null
  if (input.control || input.alt || input.meta) return null
  return input.key === 'F14' || input.code === 'F14' ? 'F14' : null
}

/** The Chat nav badge text: '' hides it; over 99 shows "99+". */
export function badgeText(n: number): string {
  const v = Math.floor(Number(n))
  if (!Number.isFinite(v) || v <= 0) return ''
  return v > 99 ? '99+' : String(v)
}
