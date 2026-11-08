// Settings → Clicker & keys: bind a hardware button (Flic, Stream Deck, any key) to Run next lot
// or Print last.
//
// "Add a key" asks main to release the bound keys (ctl:hotkeys-learn), then listens for the next
// key press in this window: the clicker's key is learned from that press (core/hotkeys learnKey),
// so nobody has to know what their clicker sends. Esc, a click elsewhere or 20 seconds cancels.
// Main keeps the saved list and the global registration (electron/controlIpc.ts); this file only
// paints what main reports. Also keeps the key badge on the top-bar Print last button current.

import {
  keyLabel, learnError, learnKey, type HotkeyAction, type HotkeyStatus,
} from '../core/hotkeys'

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null
const ACTIONS: HotkeyAction[] = ['runNext', 'printLast']
const BADGE_OF: Record<HotkeyAction, string> = { runNext: 'runNextBtn', printLast: 'printLastBtn' }
const LISTEN_MS = 20_000

let current: HotkeyStatus = { keys: [] }
let listening: HotkeyAction | null = null
let listenTimer: ReturnType<typeof setTimeout> | null = null

function api() { return window.controlAPI }

function setState(msg: string, bad = false): void {
  const el = byId('hkState')
  if (!el) return
  el.textContent = msg
  el.classList.toggle('muted', !bad)
  el.style.color = bad ? 'var(--loss)' : ''
}

function paint(): void {
  for (const a of ACTIONS) {
    const box = byId(`hkKeys-${a}`)
    if (box) {
      box.textContent = ''
      const keys = current.keys.filter((k) => k.action === a)
      if (!keys.length) {
        const none = document.createElement('span')
        none.className = 'hk-none'
        none.textContent = 'No key yet'
        box.append(none)
      }
      for (const k of keys) {
        const chip = document.createElement('span')
        chip.className = `hk-key${k.global ? '' : ' local'}`
        chip.title = k.global
          ? 'Works while any window is in front'
          : 'Another app is using this key, so it only works while this window is in front'
        chip.append(document.createTextNode(keyLabel(k.accel) + (k.global ? '' : ' · this window only')))
        const x = document.createElement('button')
        x.type = 'button'
        x.textContent = '×'
        x.setAttribute('aria-label', `Remove ${keyLabel(k.accel)}`)
        x.addEventListener('click', () => void remove(a, k.accel))
        chip.append(x)
        box.append(chip)
      }
    }
    const add = byId<HTMLButtonElement>(`hkAdd-${a}`)
    if (add) {
      add.textContent = listening === a ? 'Press your clicker now… (Esc to cancel)' : 'Add a key'
      add.classList.toggle('hk-listening', listening === a)
    }
  }
  // Each top-bar button's badge shows its first bound key, or nothing.
  for (const a of ACTIONS) {
    const first = current.keys.find((k) => k.action === a)
    const badge = byId(BADGE_OF[a])?.querySelector<HTMLElement>('.sh-key')
    if (badge) { badge.textContent = first ? keyLabel(first.accel) : ''; badge.hidden = !first }
  }
}

function stopListening(): void {
  if (!listening) return
  listening = null
  if (listenTimer) { clearTimeout(listenTimer); listenTimer = null }
  window.removeEventListener('keydown', onKey, true)
  window.removeEventListener('mousedown', onClickAway, true)
  void api()?.learnHotkey(false).catch(() => {})
  paint()
}

function onClickAway(e: MouseEvent): void {
  const t = e.target as HTMLElement | null
  if (t && listening && t.id === `hkAdd-${listening}`) return // the button's own click toggles
  stopListening()
}

function onKey(e: KeyboardEvent): void {
  if (!listening) return
  e.preventDefault()
  e.stopPropagation()
  if (e.repeat) return
  if (e.key === 'Escape' && !e.ctrlKey && !e.altKey) { setState(''); stopListening(); return }
  const r = learnKey({ key: e.key, code: e.code, control: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey })
  if (!r.ok) {
    if (r.reason !== 'modifier-only') setState(learnError(r.reason), true) // keep listening
    return
  }
  const action = listening
  stopListening()
  void add(action, r.accel)
}

async function add(action: HotkeyAction, accel: string): Promise<void> {
  try {
    const res = await api()?.addHotkey(action, accel)
    if (!res) return
    current = { keys: res.keys }
    if (res.error) setState(res.error, true)
    else {
      const k = res.keys.find((x) => x.accel === accel)
      setState(k && !k.global
        ? `${keyLabel(accel)} added, but another app is using it, so it only works while this window is in front. Pick another key in your clicker's app to make it work everywhere.`
        : `${keyLabel(accel)} added. Try it with TikTok in front.`, !!k && !k.global)
    }
  } catch { setState('Could not save that key. Try again.', true) }
  paint()
}

async function remove(action: HotkeyAction, accel: string): Promise<void> {
  try {
    const res = await api()?.removeHotkey(action, accel)
    if (res) current = res
    setState(`${keyLabel(accel)} removed.`)
  } catch { setState('Could not remove that key. Try again.', true) }
  paint()
}

async function startListening(action: HotkeyAction): Promise<void> {
  if (listening === action) { stopListening(); return }
  stopListening()
  listening = action
  setState('')
  paint()
  try { await api()?.learnHotkey(true) } catch { /* the press may still arrive */ }
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('mousedown', onClickAway, true)
  listenTimer = setTimeout(() => { setState('No key came through. Check the clicker is paired and set to press a key.', true); stopListening() }, LISTEN_MS)
}

/** Called once by renderer.ts at startup. Without the bridge (the http demo) the card says so. */
export function initHotkeysCard(): void {
  for (const a of ACTIONS) byId(`hkAdd-${a}`)?.addEventListener('click', () => void startListening(a))
  const bridge = api()
  if (!bridge?.getHotkeys) {
    for (const a of ACTIONS) { const b = byId<HTMLButtonElement>(`hkAdd-${a}`); if (b) b.disabled = true }
    setState('Clicker keys work in the desktop app only.')
    return
  }
  bridge.getHotkeys().then((s) => { current = s; paint() }).catch(() => setState('Could not read the saved keys.', true))
  paint()
}
