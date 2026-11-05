// LANE A — the shell: nav rail (Show / Chat / Settings, with the Chat badge), the top-bar controls
// (Arm switch, disabled "Run next" with a "Coming soon" tooltip, Print last [F14]), the F14 key
// (window.controlAPI.onKey), and Text size (A−/A+, per computer, window.controlAPI zoom).
//
// Fills: index.html #navRail, #topControls, #textSizeSlot (markup there); CSS block "lane A".
// renderer.ts calls initShell() once and onScreen() from showScreen(); lane C calls setChatBadge().
//
// Nothing here is on the print path. Print last calls renderer.ts printLabel (via deps.print) with
// the last SALE label lane E saw an attempt for — ok OR failed, so a failed #81 is what F14
// recovers; sample/test tags never count (core/printLogFormat nextPrintLast). The button shows
// the lot ("Print last #81"). It never registers in the print guard and needs no arming:
// reprinting a tag cannot start anything on TikTok.

import type { LabelData } from '../electron/label'
import { onPrintLastChange, printLastLabel } from './printLog'
import { printLastText } from '../core/printLogFormat'
import { TEXT_DEFAULT, badgeText, canGrow, canShrink, factorToPct, isBigText, pctToFactor, stepText } from '../core/shellControls'

export type Screen = 'monitor' | 'chat' | 'settings'

export interface ShellDeps {
  /** renderer.ts showScreen — honours the Connect gate (a gated call shows Connect instead). */
  showScreen: (s: Screen) => void
  /** renderer.ts printLabel, for Print last. Never registers the lot in the print guard. */
  print: (data: LabelData) => void
}

let deps: ShellDeps | null = null
let armed = false
let textPct = TEXT_DEFAULT
let lastPrintAt = 0
let flashTimer: ReturnType<typeof setTimeout> | null = null

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null
const NAV: Record<Screen, string> = { monitor: 'navShow', chat: 'navChat', settings: 'navSettings' }
/** One press = one label: F14 bounce or a double-click inside this window does not print twice. */
const PRINT_LAST_GAP_MS = 700
const TEXT_KEY = 'sf-text-size' // browser fallback only (no controlAPI, e.g. the http demo)

/** Called once by renderer.ts at startup, before the first showScreen(). */
export function initShell(d: ShellDeps): void {
  deps = d

  for (const s of Object.keys(NAV) as Screen[]) {
    byId(NAV[s])?.addEventListener('click', () => deps?.showScreen(s))
  }

  const arm = byId<HTMLButtonElement>('armBtn')
  arm?.addEventListener('click', () => setArmed(!armed))

  byId<HTMLButtonElement>('printLastBtn')?.addEventListener('click', () => printLast())
  try { window.controlAPI?.onKey((key) => { if (key === 'F14') printLast() }) } catch { /* no bridge: the button still works */ }
  onPrintLastChange(() => paintPrintLast())
  paintPrintLast()

  byId('textSmaller')?.addEventListener('click', () => void setText(stepText(textPct, -1)))
  byId('textBigger')?.addEventListener('click', () => void setText(stepText(textPct, 1)))
  byId('textReset')?.addEventListener('click', () => void setText(TEXT_DEFAULT))
  paintText()
  void loadText()
}

/**
 * Called at the END of every renderer.ts showScreen(): `screen` is what is actually shown
 * ('connect' while gated), `gated` is the Connect gate. Paint the rail's active / disabled state.
 */
export function onScreen(screen: Screen | 'connect', gated: boolean): void {
  for (const s of Object.keys(NAV) as Screen[]) {
    const b = byId<HTMLButtonElement>(NAV[s])
    if (!b) continue
    const on = s === screen
    b.classList.toggle('on', on)
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current')
    b.disabled = gated
  }
  // The top-bar controls belong to a connected app; the Connect screen shows none of them.
  const ctl = byId('topControls')
  if (ctl) ctl.hidden = screen === 'connect'
}

/** Lane C → the Chat nav badge: open question count (0 hides it). */
export function setChatBadge(n: number): void {
  const badge = byId('navChatBadge')
  const t = badgeText(n)
  if (badge) { badge.textContent = t; badge.hidden = !t }
  const chat = byId(NAV.chat)
  if (chat) {
    if (t) chat.setAttribute('aria-label', `Chat, ${Math.floor(n)} open ${Math.floor(n) === 1 ? 'question' : 'questions'}`)
    else chat.removeAttribute('aria-label')
  }
}

/** The Arm switch. Run next is out of this build, so nothing reads it yet besides the switch itself. */
export function isArmed(): boolean { return armed }

function setArmed(on: boolean): void {
  armed = on
  const arm = byId('armBtn')
  if (arm) { arm.classList.toggle('on', on); arm.setAttribute('aria-pressed', String(on)) }
  const text = byId('armText')
  if (text) text.textContent = on ? 'Armed' : 'Arm buttons'
}

// ── Print last [F14] ─────────────────────────────────────────────────────────
function printLast(): void {
  const now = Date.now()
  if (now - lastPrintAt < PRINT_LAST_GAP_MS) return
  lastPrintAt = now
  let data: LabelData | undefined
  try { data = printLastLabel() } catch { data = undefined }
  if (!data || !deps) { flashPrintLast('Nothing printed yet'); return }
  deps.print({ ...data })
}

/** "Print last #81" on the button (left alone while a flash message is showing). */
function paintPrintLast(): void {
  const btn = byId('printLastBtn'), text = byId('printLastText')
  let data: ReturnType<typeof printLastLabel>
  try { data = printLastLabel() } catch { data = undefined }
  const label = printLastText(data)
  if (text && !flashTimer) text.textContent = label
  if (btn) btn.title = data ? `Reprint ${label.slice('Print last '.length) || 'the last label'} (F14)` : 'Reprint the last label (F14)'
}

function flashPrintLast(msg: string): void {
  const btn = byId('printLastBtn'), text = byId('printLastText')
  if (!btn || !text) return
  text.textContent = msg
  btn.classList.add('sh-flash')
  if (flashTimer) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => { flashTimer = null; btn.classList.remove('sh-flash'); paintPrintLast() }, 1600)
}

// ── Text size ────────────────────────────────────────────────────────────────
async function loadText(): Promise<void> {
  try {
    if (window.controlAPI) textPct = factorToPct(await window.controlAPI.getZoom())
    else textPct = factorToPct(Number(localStorage.getItem(TEXT_KEY) ?? 100) / 100)
  } catch { textPct = TEXT_DEFAULT }
  if (!window.controlAPI) applyBrowserZoom()
  paintText()
}

async function setText(pct: number): Promise<void> {
  textPct = factorToPct(pctToFactor(pct))
  paintText()
  try {
    if (window.controlAPI) textPct = factorToPct(await window.controlAPI.setZoom(pctToFactor(textPct)))
    else { try { localStorage.setItem(TEXT_KEY, String(textPct)) } catch { /* this session only */ } applyBrowserZoom() }
  } catch { /* the size still shows; main could not apply it */ }
  paintText()
}

/** Demo / no-preload fallback: CSS zoom stands in for webContents.setZoomFactor. */
function applyBrowserZoom(): void {
  const f = textPct / 100
  document.body.style.setProperty('zoom', String(f))
  document.body.style.height = `${100 / f}vh`
}

function paintText(): void {
  document.body.classList.toggle('sh-big', isBigText(textPct))
  const pct = byId('textPct')
  if (pct) pct.textContent = `${textPct}%`
  const smaller = byId<HTMLButtonElement>('textSmaller'), bigger = byId<HTMLButtonElement>('textBigger')
  if (smaller) smaller.disabled = !canShrink(textPct)
  if (bigger) bigger.disabled = !canGrow(textPct)
}
