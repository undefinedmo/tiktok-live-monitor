// LANE A — the shell: nav rail (Show / Chat / Settings, with the Chat badge), the top-bar controls
// (Arm switch, disabled "Run next" with a "Coming soon" tooltip, Print last [F14]), the F14 key
// (window.controlAPI.onKey), and Text size (A−/A+, per computer, window.controlAPI zoom).
//
// Fills: index.html #navRail, #topControls, #textSizeSlot; CSS block "lane A".
// SCAFFOLD STUB: every export is a no-op. renderer.ts calls initShell() once and onScreen() from
// showScreen(); lane C calls setChatBadge().

import type { LabelData } from '../electron/label'

export type Screen = 'monitor' | 'chat' | 'settings'

export interface ShellDeps {
  /** renderer.ts showScreen — honours the Connect gate (a gated call shows Connect instead). */
  showScreen: (s: Screen) => void
  /** renderer.ts printLabel, for Print last. Never registers the lot in the print guard. */
  print: (data: LabelData) => void
}

let deps: ShellDeps | null = null

/** Called once by renderer.ts at startup, before the first showScreen(). */
export function initShell(d: ShellDeps): void {
  deps = d
}

/**
 * Called at the END of every renderer.ts showScreen(): `screen` is what is actually shown
 * ('connect' while gated), `gated` is the Connect gate. Paint the rail's active / disabled state.
 */
export function onScreen(screen: Screen | 'connect', gated: boolean): void {
  void screen; void gated; void deps
}

/** Lane C → the Chat nav badge: open question count (0 hides it). */
export function setChatBadge(n: number): void {
  void n
}
