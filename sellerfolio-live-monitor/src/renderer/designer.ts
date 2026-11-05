// LANE F — Settings: two tabs (Label designer / Printer & app), the free-layout label designer
// (core/labelLayout: canvas, layers, properties, QR modes, 4×6, logo), and the "Text from the
// title" drawer that hosts the existing regex tools (presets, sample title + buyer, AI Suggest
// pattern, pattern + flags, save/delete preset — unchanged, moved here from renderer.ts).
//
// Printing first: nothing here is on the print path. printLabel (renderer.ts) reads the live
// `labelTemplate` binding exported below and hands it to main, which prints the template's
// `layout` when there is one (electron/label.ts / zplLabel.ts) and the fixed label otherwise.
//
// A saved layout only exists once the operator edits something. Until then the designer shows
// the current fixed label converted (migrateFromTemplate) and the print path is untouched.

import { labelCode } from '../core/labelCode'
import {
  LAYOUT_SIZES, FONTS, DPI, SNAP_IN, PT_MIN, PT_MAX, ELEMENT_CSS, FIT_MIN_PT, FIT_STEP_PT, snapIn, elementText, normalizeLayout,
  migrateFromTemplate, layoutBody, layoutNeedsHtml, zplCanDraw, qrAdvice, hasNonZplText, monoFromRgba, logoDots, newText, newQr,
  newLogo, lineHeightIn, parseItemNumber, extractCustom, isLayoutSize, monoIsCurrent, boxDots, fitImageBytes, MAX_LOGO_DATAURL_BYTES,
  type LabelLayout, type LayoutElement, type TextElement, type QrElement, type LogoElement, type LayoutSize, type TextSource, type QrMode, type TextAlign,
} from '../core/labelLayout'
import { DEFAULT_TEMPLATE, type LabelTemplate, type LabelData } from '../electron/label'

// ── the saved template (printLabel reads this live binding) ──────────────────────

const TEMPLATE_KEY = 'tt-label-template'

function loadTemplate(): LabelTemplate {
  try {
    const t: LabelTemplate = { ...DEFAULT_TEMPLATE, ...JSON.parse(localStorage.getItem(TEMPLATE_KEY) || '{}') }
    if (t.layout) {
      const l = normalizeLayout(t.layout)
      if (l) { t.layout = l; t.labelSize = l.size } else delete t.layout
    }
    return t
  } catch {
    return { ...DEFAULT_TEMPLATE }
  }
}

/** The label template this computer prints with. Reassigned (never mutated) on every change. */
export let labelTemplate: LabelTemplate = loadTemplate()

let saveError = ''
function saveTemplate(): void {
  try {
    localStorage.setItem(TEMPLATE_KEY, JSON.stringify(labelTemplate))
    saveError = ''
  } catch {
    // Quota: almost always a large logo. The template in memory still prints this session.
    saveError = 'Could not save the label on this computer. Try a smaller logo image.'
  }
}

// ── wiring from renderer.ts ───────────────────────────────────────────────────────

interface Deps {
  /** renderer.ts printLabel (manual: never registers the lot in the print guard). */
  print: (data: LabelData) => Promise<void> | void
  /** The selected printer's name ('' = none). */
  printer: () => string
  /** Open the Settings screen. */
  openSettings: () => void
}
let deps: Deps = { print: () => undefined, printer: () => '', openSettings: () => undefined }

/** Called from renderer.ts setupSettings() (before initDesigner) with what only it can reach. */
export function setupDesigner(d: Deps): void {
  deps = d
  document.getElementById('labelSettings')?.addEventListener('click', () => deps.openSettings())
  document.getElementById('labelSettingsFooter')?.addEventListener('click', () => deps.openSettings())
  document.getElementById('printTest')?.addEventListener('click', () => void deps.print(sampleLabelData()))
}

/** The printer changed (or loaded): enable the test-print buttons and repaint the designer, whose
 *  ZPL banner reads the raw-ZPL switch setupPrinting sets in the same tick. */
export function refreshPrinterButtons(): void {
  const p = deps.printer()
  for (const b of document.querySelectorAll<HTMLButtonElement>('#printTest, .lf-testbtn')) {
    b.disabled = !p
    b.title = p ? `Print a test tag to ${p}` : 'Select a printer first'
  }
  if (built) setTimeout(renderDesigner, 0)
}

// ── sample sale (the canvas, the regex preview and the test tag all use it) ─────

const DEFAULT_SAMPLE_TITLE = '#141 Bin A - Alo Yoga and More, No Cancels'
const DEFAULT_SAMPLE_BUYER = 'Sarah D.'
let sampleTitle = localStorage.getItem('tt-sample-title') ?? DEFAULT_SAMPLE_TITLE
let sampleBuyer = localStorage.getItem('tt-sample-buyer') ?? DEFAULT_SAMPLE_BUYER

/** Built the way a real sale is: the lot number parsed from the title, the product name what
 *  remains once the "#NN " prefix is gone. */
export function sampleLabelData(): LabelData {
  const title = sampleTitle.trim()
  return {
    itemNumber: parseItemNumber(title),
    buyer: sampleBuyer.trim(),
    // '#' optional so this strips exactly what parseItemNumber consumed
    productName: title.replace(/^\s*#?\s*\d+\s*[-–—]?\s*/, '').trim() || title,
    price: '$82.00',
    title,
    code: labelCode('1732451642461557731'), // a real sku_id shape, so the QR is full size
  }
}

// ── designer state ──────────────────────────────────────────────────────────────

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
let draft: LabelLayout = labelTemplate.layout ? clone(labelTemplate.layout) : migrateFromTemplate(labelTemplate)
let selId: string | null = draft.elements[0]?.id ?? null
let built = false
let testSent = ''

const regexOf = () => ({ regex: labelTemplate.custom.regex, flags: labelTemplate.custom.flags ?? '' })
const zplOn = (): boolean => (document.getElementById('rawZpl') as HTMLInputElement | null)?.checked ?? false
const selected = (): LayoutElement | undefined => draft.elements.find((e) => e.id === selId)

/** Persist the draft as THE label (from now on prints go through the layout). */
function commit(): void {
  const l = normalizeLayout(draft)
  if (l) draft = l
  labelTemplate = { ...labelTemplate, labelSize: draft.size, layout: clone(draft) }
  saveTemplate()
  renderDesigner()
  // A size change clamps logo boxes and a resize changes them: the printer bitmaps must follow.
  syncMonos()
}

// ── tiny DOM helpers ─────────────────────────────────────────────────────────────

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}
function panel(title: string): { root: HTMLElement; head: HTMLElement } {
  const root = h('div', 'panel'), head = h('div', 'panel-head')
  head.appendChild(h('span', 'eyebrow', title))
  root.appendChild(head)
  return { root, head }
}
function field(label: string, control: HTMLElement): HTMLLabelElement {
  const f = h('label', 'lf-f', label)
  f.appendChild(control)
  return f
}
function toggle(label: string, on: boolean, disabled: boolean, why: string, onClick: () => void): HTMLButtonElement {
  const b = h('button', 'lf-toggle' + (on ? ' on' : ''), label)
  b.type = 'button'
  b.setAttribute('aria-pressed', String(on))
  b.disabled = disabled
  if (disabled && why) b.title = why
  b.addEventListener('click', onClick)
  return b
}
const warn = (text: string) => h('div', 'lf-warn', text)
const sub = (text: string) => h('div', 'lf-sub', text)
function btn(label: string, cls = 'lf-btn'): HTMLButtonElement {
  const b = h('button', cls, label)
  b.type = 'button'
  return b
}
/** A number input in inches, snapped to the 0.05 grid on change. */
function inchInput(key: string, value: number, min: number, max: number, onSet: (v: number) => void): HTMLInputElement {
  const n = h('input', 'lf-in')
  n.type = 'number'; n.step = String(SNAP_IN); n.min = String(min); n.max = String(max); n.value = String(value)
  n.dataset.k = key
  n.addEventListener('change', () => {
    const v = Number(n.value)
    if (Number.isFinite(v)) onSet(Math.min(max, Math.max(min, snapIn(v))))
    commit()
  })
  return n
}

// ── rendering ───────────────────────────────────────────────────────────────────

const SIZE_LABEL = (s: LayoutSize) => `${LAYOUT_SIZES[s].widthIn} × ${LAYOUT_SIZES[s].heightIn} in`
const SOURCE_LABELS: [TextSource, string][] = [['regex', 'Regex on title'], ['lot', 'Lot number'], ['item', 'Item name'], ['buyer', 'Buyer'], ['price', 'Price'], ['fixed', 'Fixed text']]
const KIND = (e: LayoutElement) => (e.type === 'qr' ? 'QR' : e.type === 'logo' ? 'Image' : e.src === 'regex' ? 'Regex' : e.src === 'fixed' ? 'Fixed' : 'Field')

let canvasCol: HTMLElement, propsCol: HTMLElement

/** Pixels per inch on screen for this stock (fits the canvas column, like the prototype). */
const screenScale = (s: LayoutSize) => Math.min(250, 460 / LAYOUT_SIZES[s].heightIn, 600 / LAYOUT_SIZES[s].widthIn)

/** The height of an element's hit box, in inches. */
function boxHeightIn(e: LayoutElement): number {
  if (e.type !== 'text') return e.h
  return lineHeightIn(e.pt) * (e.inverse ? 1.16 : 1)
}

/** Shrink each driver-path line to its box with the real font (FIT_SCRIPT's loop, on the canvas). */
function fitLines(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('.t > span').forEach((s) => {
    let p = parseFloat(s.style.fontSize)
    while (s.scrollWidth > s.clientWidth + 0.5 && p > FIT_MIN_PT) { p -= FIT_STEP_PT; s.style.fontSize = p + 'pt' }
  })
}

function renderDesigner(): void {
  if (!built) return
  const active = document.activeElement as HTMLElement | null
  const focusKey = active?.dataset?.k
  const zpl = zplOn()
  const size = LAYOUT_SIZES[draft.size]
  const scale = screenScale(draft.size)
  const sel = selected()
  const data = sampleLabelData()
  const rx = regexOf()
  canvasCol.replaceChildren()
  propsCol.replaceChildren()

  // ZPL banner — drives the existing raw-ZPL switch (#rawZpl → labelAPI.setRawZpl), the source of truth.
  const mode = h('div', 'lf-mode' + (zpl ? '' : ' std')), modeText = h('div')
  modeText.appendChild(h('b', '', zpl ? 'Fast printing (raw ZPL) is on. ' : 'Standard printing is on. '))
  modeText.appendChild(document.createTextNode(zpl ? 'The printer draws its own font, so fonts, italic and underline are off. The preview uses a close match.' : 'Any font and style works, but tags print about 5× slower.'))
  const modeBtn = btn(zpl ? 'Use any font' : 'Use fast printing')
  modeBtn.dataset.k = 'mode'
  modeBtn.addEventListener('click', () => {
    const raw = document.getElementById('rawZpl') as HTMLInputElement | null
    if (!raw) return
    raw.checked = !raw.checked
    raw.dispatchEvent(new Event('change', { bubbles: true }))
  })
  mode.appendChild(modeText); mode.appendChild(modeBtn)

  // Canvas panel: size, add buttons, the to-scale label.
  const cp = panel('Canvas'), tools = h('div', 'lf-tools')
  const sizeSel = h('select', 'lf-in')
  sizeSel.setAttribute('aria-label', 'Label size'); sizeSel.dataset.k = 'size'
  for (const s of Object.keys(LAYOUT_SIZES) as LayoutSize[]) { const o = h('option', '', SIZE_LABEL(s)); o.value = s; sizeSel.appendChild(o) }
  sizeSel.value = draft.size
  sizeSel.addEventListener('change', () => { if (isLayoutSize(sizeSel.value)) { draft.size = sizeSel.value; commit() } })
  tools.appendChild(sizeSel)
  const add = (label: string, make: () => LayoutElement, after?: (e: LayoutElement) => void) => {
    const b = btn(label); b.dataset.k = 'add-' + label
    b.addEventListener('click', () => { const e = make(); draft.elements.push(e); selId = e.id; commit(); after?.(e) })
    tools.appendChild(b)
  }
  const wMax = Math.max(0.2, size.widthIn - 0.2)
  add('Add text', () => newText({ w: Math.min(1.5, wMax) }))
  add('Add QR', () => newQr({ w: Math.min(0.46, size.widthIn, size.heightIn), h: Math.min(0.46, size.widthIn, size.heightIn) }))
  add('Add logo', () => newLogo(), (e) => chooseLogo(e.id))
  cp.head.appendChild(tools)

  const canvas = h('div', 'lf-canvas')
  const stage = h('div', 'lf-stage')
  stage.style.width = Math.round(size.widthIn * scale) + 'px'
  stage.style.height = Math.round(size.heightIn * scale) + 'px'
  const paper = h('div', 'lf-paper')
  paper.style.width = size.widthIn + 'in'; paper.style.height = size.heightIn + 'in'
  paper.style.transform = `scale(${scale / 96})`
  const body = layoutBody(draft, data, rx, { printerFont: zpl })
  paper.innerHTML = body.html // the print markup itself, escaped by layoutBody
  const hits = h('div', 'lf-hits')
  for (const e of draft.elements) hits.appendChild(hitBox(e, scale, size, paper))
  stage.appendChild(paper); stage.appendChild(hits)
  canvas.appendChild(stage)
  cp.root.appendChild(canvas)

  const foot = h('div', 'lf-sub lf-canvasfoot')
  foot.appendChild(h('span', '', labelTemplate.layout ? 'Drag anything. Positions snap to 0.05 in.' : 'Your current label, ready to edit. Nothing changes until you edit it.'))
  const right = h('span', 'lf-footright')
  const test = btn('Print test tag', 'lf-btn lf-testbtn'); test.dataset.k = 'test-foot'
  test.addEventListener('click', () => printTest())
  right.appendChild(test)
  const slowImg = zpl && draft.elements.some((e) => e.type === 'logo' && e.mono)
  right.appendChild(h('span', 'lf-tag', zpl ? (slowImg ? 'Prints as fast ZPL, with an image' : 'Prints as fast ZPL') : 'Prints through the driver'))
  foot.appendChild(right)
  cp.root.appendChild(foot)
  if (saveError) cp.root.appendChild(h('div', 'lf-pad', '')).appendChild(warn(saveError))
  canvasCol.appendChild(mode); canvasCol.appendChild(cp.root)
  if (body.fit) fitLines(paper)

  // Layers.
  const lp = panel('Layers'), lbox = h('div', 'lf-pad')
  for (const e of draft.elements) {
    const b = h('button', 'lf-layer' + (e.id === selId ? ' on' : ''))
    b.type = 'button'; b.dataset.k = 'layer-' + e.id
    b.setAttribute('aria-pressed', String(e.id === selId))
    b.appendChild(h('span', '', e.name)); b.appendChild(h('small', '', KIND(e)))
    b.addEventListener('click', () => { selId = e.id; renderDesigner() })
    lbox.appendChild(b)
  }
  if (!draft.elements.length) lbox.appendChild(sub('Nothing on this label yet.'))
  lp.root.appendChild(lbox)
  propsCol.appendChild(lp.root)

  // Properties.
  const pp = panel(sel ? sel.name : 'Nothing selected'), pb = h('div', 'lf-pad')
  if (sel) {
    const del = btn('Delete', 'lf-link'); del.dataset.k = 'delete'
    del.addEventListener('click', () => {
      draft.elements = draft.elements.filter((e) => e !== sel)
      selId = draft.elements[0]?.id ?? null
      commit()
    })
    pp.head.appendChild(del)
  }
  if (sel?.type === 'text') textProps(sel, pb, zpl)
  else if (sel?.type === 'qr') qrProps(sel, pb, size)
  else if (sel?.type === 'logo') logoProps(sel, pb, zpl, size)
  else pb.appendChild(sub('Add text, a QR code or a logo.'))
  pp.root.appendChild(pb)
  propsCol.appendChild(pp.root)

  refreshTestButtons()
  pathHint()
  if (focusKey) (document.querySelector(`#designerTab [data-k="${CSS.escape(focusKey)}"]`) as HTMLElement | null)?.focus()
}

function refreshTestButtons(): void {
  const p = deps.printer()
  for (const b of document.querySelectorAll<HTMLButtonElement>('.lf-testbtn')) {
    b.disabled = !p
    b.title = p ? `Print a test tag to ${p}` : 'Select a printer first'
  }
}

function printTest(): void {
  if (!deps.printer()) return
  testSent = 'Test tag sent. Scan it to check.'
  void deps.print(sampleLabelData())
  renderDesigner()
  setTimeout(() => { testSent = ''; }, 8000)
}

/** One draggable, keyboard-movable hit box over the canvas, for element `e`. */
function hitBox(e: LayoutElement, scale: number, size: { widthIn: number; heightIn: number }, paper: HTMLElement): HTMLButtonElement {
  const b = h('button', 'lf-hit' + (e.id === selId ? ' sel' : '') + (e.type === 'logo' && !e.dataUrl ? ' empty' : ''))
  b.type = 'button'; b.dataset.k = 'hit-' + e.id
  b.setAttribute('aria-label', `${e.name}. Arrow keys move it.`)
  if (e.type === 'logo' && !e.dataUrl) b.textContent = 'LOGO'
  const place = () => {
    b.style.left = e.x * scale + 'px'; b.style.top = e.y * scale + 'px'
    b.style.width = Math.max(10, e.w * scale) + 'px'; b.style.height = Math.max(10, boxHeightIn(e) * scale) + 'px'
    const p = paper.querySelector<HTMLElement>(`[data-id="${CSS.escape(e.id)}"]`)
    if (p) { p.style.left = (Math.round(e.x * DPI) / DPI).toFixed(3) + 'in'; p.style.top = (Math.round(e.y * DPI) / DPI).toFixed(3) + 'in' }
  }
  place()
  const maxX = () => Math.max(0, size.widthIn - Math.min(e.w, 0.2))
  const maxY = () => Math.max(0, size.heightIn - Math.min(boxHeightIn(e), 0.15))
  b.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return
    ev.preventDefault()
    const sx = ev.clientX, sy = ev.clientY, ox = e.x, oy = e.y
    let moved = false
    b.setPointerCapture(ev.pointerId)
    b.classList.add('sel')
    const move = (m: PointerEvent) => {
      const nx = Math.min(Math.max(0, snapIn(ox + (m.clientX - sx) / scale)), maxX())
      const ny = Math.min(Math.max(0, snapIn(oy + (m.clientY - sy) / scale)), maxY())
      if (nx !== e.x || ny !== e.y) { e.x = nx; e.y = ny; moved = true; place() }
    }
    const up = () => {
      b.removeEventListener('pointermove', move); b.removeEventListener('pointerup', up); b.removeEventListener('pointercancel', up)
      selId = e.id
      if (moved) commit(); else renderDesigner()
    }
    b.addEventListener('pointermove', move); b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up)
  })
  b.addEventListener('keydown', (ev) => {
    const step = ev.shiftKey ? 0.25 : SNAP_IN
    const d = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, [number, number]>)[ev.key]
    if (!d) return
    ev.preventDefault()
    e.x = Math.min(Math.max(0, snapIn(e.x + d[0])), maxX())
    e.y = Math.min(Math.max(0, snapIn(e.y + d[1])), maxY())
    selId = e.id
    commit()
  })
  return b
}

function textProps(sel: TextElement, pb: HTMLElement, zpl: boolean): void {
  const s = h('select', 'lf-in'); s.dataset.k = 'src'
  for (const [v, t] of SOURCE_LABELS) { const o = h('option', '', t); o.value = v; s.appendChild(o) }
  s.value = sel.src
  s.addEventListener('change', () => {
    sel.src = s.value as TextSource
    if (sel.src === 'fixed' && sel.text == null) sel.text = 'Text'
    commit()
    if (sel.src === 'regex') openDrawer(s)
  })
  pb.appendChild(field('Text comes from', s))
  if (sel.src === 'fixed') {
    const t = h('input', 'lf-in'); t.value = sel.text ?? ''; t.dataset.k = 'text'; t.maxLength = 200
    t.addEventListener('change', () => { sel.text = t.value; commit() })
    pb.appendChild(field('Text', t))
    if (zpl && hasNonZplText(sel.text)) pb.appendChild(warn('Emoji and symbols won’t print in fast printing.'))
  }
  if (sel.src === 'regex') {
    const rx = h('div', 'lf-sub'), edit = btn('Edit pattern'); edit.dataset.k = 'edit-pattern'
    const prints = elementText(sel, sampleLabelData(), regexOf())
    rx.appendChild(h('span', '', 'Prints: ' + (prints || (labelTemplate.custom.regex ? 'no match' : 'no pattern yet'))))
    rx.appendChild(edit)
    edit.addEventListener('click', () => openDrawer(edit))
    pb.appendChild(rx)
  }
  const fs = h('select', 'lf-in'); fs.dataset.k = 'font'
  if (zpl) {
    const zo = h('option', '', 'Printer font (ZPL)'); zo.value = ''; fs.appendChild(zo)
    fs.disabled = true; fs.title = 'Turn off fast printing to choose a font'
  } else {
    for (const n of FONTS) { const o = h('option', '', n); o.value = n; fs.appendChild(o) }
    if (!(FONTS as readonly string[]).includes(sel.font)) { const o = h('option', '', sel.font); o.value = sel.font; fs.appendChild(o) }
    fs.value = sel.font
  }
  fs.addEventListener('change', () => { if (fs.value) { sel.font = fs.value; commit() } })
  pb.appendChild(field('Font', fs))
  const n = h('input', 'lf-in'); n.type = 'number'; n.min = String(PT_MIN); n.max = String(PT_MAX); n.step = '0.5'; n.value = String(sel.pt); n.dataset.k = 'pt'
  n.addEventListener('change', () => { const v = Number(n.value); if (Number.isFinite(v) && v > 0) sel.pt = Math.min(PT_MAX, Math.max(PT_MIN, v)); commit() })
  pb.appendChild(field('Text size, pt', n))
  pb.appendChild(field('Box width, in', inchInput('w', sel.w, 0.1, LAYOUT_SIZES[draft.size].widthIn, (v) => { sel.w = v })))
  const row = h('div', 'lf-toggles'), why = 'Not available in fast printing'
  row.appendChild(toggle('Bold', zpl || sel.bold, zpl, 'The printer font is always bold', () => { sel.bold = !sel.bold; commit() }))
  row.appendChild(toggle('Italic', !zpl && sel.italic, zpl, why, () => { sel.italic = !sel.italic; commit() }))
  row.appendChild(toggle('Underline', !zpl && sel.underline, zpl, why, () => { sel.underline = !sel.underline; commit() }))
  row.appendChild(toggle('White on black', sel.inverse, false, '', () => { sel.inverse = !sel.inverse; commit() }))
  row.querySelectorAll<HTMLElement>('button').forEach((b, i) => { b.dataset.k = 'style-' + i })
  pb.appendChild(row)
  const al = h('div', 'lf-toggles'); al.setAttribute('role', 'group'); al.setAttribute('aria-label', 'Align in the box')
  for (const [v, t] of [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']] as [TextAlign, string][]) {
    const b = toggle(t, sel.align === v, false, '', () => { sel.align = v; commit() }); b.dataset.k = 'align-' + v
    al.appendChild(b)
  }
  pb.appendChild(field('Align', al))
  if (zpl && sel.inverse) pb.appendChild(warn('Print a test tag first. Some ZPL printers ignore this.'))
}

function qrProps(sel: QrElement, pb: HTMLElement, size: { widthIn: number; heightIn: number }): void {
  const k = h('select', 'lf-in'); k.dataset.k = 'qrmode'
  for (const [v, t] of [['pack', 'Pack scan code'], ['link', 'Web link'], ['fixed', 'Fixed text']] as [QrMode, string][]) { const o = h('option', '', t); o.value = v; k.appendChild(o) }
  k.value = sel.mode
  k.addEventListener('change', () => { sel.mode = k.value as QrMode; if (sel.mode !== 'pack' && sel.value == null) sel.value = ''; commit() })
  pb.appendChild(field('QR contains', k))
  if (sel.mode === 'pack') {
    pb.appendChild(sub('Matches the tag to its order at the pack station. Manual tags have no order, so they print without this QR.'))
  } else {
    const value = sel.value ?? ''
    const v = h('input', 'lf-in'); v.value = value; v.dataset.k = 'qrvalue'; v.maxLength = 300
    v.placeholder = sel.mode === 'link' ? 'https://your-shop-link' : 'What the QR should hold'
    v.addEventListener('change', () => { sel.value = v.value.trim(); commit() })
    pb.appendChild(field(sel.mode === 'link' ? 'Link' : 'Text', v))
    pb.appendChild(sub(value.length + (value.length === 1 ? ' character' : ' characters')))
    const adv = qrAdvice(value, sel.w)
    if (adv.level === 'empty') pb.appendChild(warn(sel.mode === 'link' ? 'Add a link, or this tag prints without a QR.' : 'Add text, or this tag prints without a QR.'))
    else if (adv.level === 'too-long') pb.appendChild(warn('Too long to scan at this size. Use a shorter link or a larger QR.'))
    else if (adv.level === 'long') pb.appendChild(warn('Long for this size. Print a test tag and scan it.'))
    else if (sel.mode === 'link' && !/^https?:\/\/\S+\.\S+/i.test(value)) pb.appendChild(warn('This doesn’t look like a full link. Start it with https://'))
    pb.appendChild(warn('Tags with this QR can’t be scanned at the pack station.'))
  }
  pb.appendChild(field('Size, in', inchInput('qrsize', sel.w, 0.2, Math.min(size.widthIn, size.heightIn), (v) => { sel.w = v; sel.h = v })))
  const test = btn('Print test tag', 'lf-btn lf-testbtn'); test.dataset.k = 'test-qr'
  test.addEventListener('click', () => printTest())
  const sent = h('div', 'lf-sub', testSent); sent.setAttribute('role', 'status')
  pb.appendChild(test); pb.appendChild(sent)
}

function logoProps(sel: LogoElement, pb: HTMLElement, zpl: boolean, size: { widthIn: number; heightIn: number }): void {
  const choose = btn(sel.dataUrl ? 'Choose another image' : 'Choose image'); choose.dataset.k = 'logo-choose'
  choose.addEventListener('click', () => chooseLogo(sel.id))
  pb.appendChild(choose)
  if (logoError) pb.appendChild(warn(logoError))
  if (!sel.dataUrl) pb.appendChild(sub('PNG, JPG, GIF, WebP or SVG. A black logo on white prints best.'))
  if (logoNotice[sel.id]) pb.appendChild(warn(logoNotice[sel.id]!))
  // commit() rebuilds the printer bitmap for the new box (syncMonos).
  pb.appendChild(field('Width, in', inchInput('logow', sel.w, 0.1, size.widthIn, (v) => { sel.w = v })))
  pb.appendChild(field('Height, in', inchInput('logoh', sel.h, 0.1, size.heightIn, (v) => { sel.h = v })))
  if (zpl) for (const n of zplCanDraw(sel).notes) pb.appendChild(warn(n))
}

// ── logos ────────────────────────────────────────────────────────────────────────

let logoError = ''
/** Per logo: a note shown under it when its image had to be made smaller. */
const logoNotice: Record<string, string> = {}
const SHRUNK_NOTE = 'This image was large, so it was saved smaller. Big images can stop tags printing through the driver. Print a test tag to check it.'
const MAX_LOGO_BYTES = 5 * 1024 * 1024
const MAX_LOGO_PX = 600 // kept image's longest side: plenty for 203 dpi, small in localStorage

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('That file could not be read as an image.'))
    img.src = src
  })
}

/**
 * The image as a data: URL no heavier than MAX_LOGO_DATAURL_BYTES (the driver path prints from a
 * data: URL, which Chromium caps at 2 MB). PNG first — flat logos stay crisp and small — stepping
 * down in size; a noisy image that is still too heavy as a small PNG is tried as JPEG on white
 * (the tag is white anyway), again stepping down. `shrunk` = it is smaller or lossier than chosen.
 */
function encodeLogo(img: HTMLImageElement): { dataUrl: string; shrunk: boolean } {
  const iw = img.naturalWidth || 300, ih = img.naturalHeight || 300
  const k = Math.min(1, MAX_LOGO_PX / Math.max(iw, ih))
  const w = Math.max(1, Math.round(iw * k)), hh = Math.max(1, Math.round(ih * k))
  const draw = (cw: number, ch: number, white: boolean): HTMLCanvasElement => {
    const c = document.createElement('canvas'); c.width = cw; c.height = ch
    const ctx = c.getContext('2d')
    if (ctx) { if (white) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch) } ctx.drawImage(img, 0, 0, cw, ch) }
    return c
  }
  const png = fitImageBytes(w, hh, (cw, ch) => draw(cw, ch, false).toDataURL('image/png'))
  if (png.fits) return { dataUrl: png.dataUrl, shrunk: png.shrunk }
  const jpg = fitImageBytes(w, hh, (cw, ch) => draw(cw, ch, true).toDataURL('image/jpeg', 0.85), MAX_LOGO_DATAURL_BYTES, 60)
  if (jpg.fits) return { dataUrl: jpg.dataUrl, shrunk: true }
  throw new Error('That image is too detailed to print reliably. Choose a simpler logo.')
}

/** The 1-bit printer bitmap of a logo at its current box size (ZPL ^GF). */
async function monoFor(el: LogoElement): Promise<LogoElement['mono']> {
  if (!el.dataUrl) return undefined
  const img = await loadImage(el.dataUrl)
  const { w, h: hh } = logoDots(el, img.naturalWidth, img.naturalHeight)
  const c = document.createElement('canvas'); c.width = w; c.height = hh
  const ctx = c.getContext('2d')
  if (!ctx) return undefined
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, hh)
  ctx.drawImage(img, 0, 0, w, hh)
  return monoFromRgba(ctx.getImageData(0, 0, w, hh).data, w, hh, DPI)
}

/** What a logo's bitmap is being built for; each key is tried once (no rebuild loop). */
const monoKey = (el: LogoElement): string => { const b = boxDots(el); return `${el.id}|${b.w}x${b.h}|${el.dataUrl?.length ?? 0}` }
const monoTried = new Set<string>()

/** Rebuild the printer bitmap of every logo whose box it no longer matches (a label-size change
 *  clamped the box, or it was resized). Async, best-effort: a rebuild that lands after the box
 *  changed again is dropped and the next commit tries the new box. layoutZpl also scales a stale
 *  bitmap down to its box, so a missed rebuild can never print over the text. */
function syncMonos(): void {
  for (const el of draft.elements) {
    if (el.type !== 'logo' || !el.dataUrl || monoIsCurrent(el)) continue
    const key = monoKey(el)
    if (monoTried.has(key)) continue
    monoTried.add(key)
    void monoFor(el).then((mono) => {
      const now = draft.elements.find((e) => e.id === el.id)
      if (now?.type !== 'logo' || monoKey(now) !== key || !mono) return
      now.mono = mono
      commit()
    }).catch(() => { /* keep the old bitmap; layoutZpl fits it to the box */ })
  }
}

/** Layouts saved before the byte cap: re-encode any logo heavier than it, once, at startup. */
async function shrinkSavedLogos(): Promise<void> {
  let changed = false
  for (const el of draft.elements) {
    if (el.type !== 'logo' || !el.dataUrl || el.dataUrl.length <= MAX_LOGO_DATAURL_BYTES) continue
    try {
      const out = encodeLogo(await loadImage(el.dataUrl))
      el.dataUrl = out.dataUrl
      el.mono = await monoFor(el)
      logoNotice[el.id] = SHRUNK_NOTE
      changed = true
    } catch { /* leave it; the operator can choose the image again */ }
  }
  if (changed) commit()
}

function chooseLogo(id: string): void {
  const input = h('input')
  input.type = 'file'
  input.accept = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml'
  input.addEventListener('change', async () => {
    const file = input.files?.[0]
    const el = draft.elements.find((e) => e.id === id)
    if (!file || el?.type !== 'logo') return
    logoError = ''
    if (file.size > MAX_LOGO_BYTES) { logoError = 'That image is over 5 MB. Choose a smaller one.'; renderDesigner(); return }
    try {
      const raw = await new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result))
        r.onerror = () => reject(new Error('That file could not be read.'))
        r.readAsDataURL(file)
      })
      const img = await loadImage(raw)
      const iw = img.naturalWidth || 300, ih = img.naturalHeight || 300
      const out = encodeLogo(img)
      el.dataUrl = out.dataUrl
      if (out.shrunk) logoNotice[el.id] = SHRUNK_NOTE; else delete logoNotice[el.id]
      // Keep the image's shape: same width, height from its aspect.
      const L = LAYOUT_SIZES[draft.size]
      el.h = Math.min(L.heightIn - el.y, Math.max(0.1, snapIn((el.w * ih) / iw)))
      el.mono = await monoFor(el)
      commit()
    } catch (e) {
      logoError = (e as Error).message || 'That file could not be read as an image.'
      renderDesigner()
    }
  })
  input.click()
}

// ── tabs ─────────────────────────────────────────────────────────────────────────

function setTab(name: 'designer' | 'app'): void {
  const designer = document.getElementById('designerTab'), app = document.getElementById('appTab')
  if (designer) designer.hidden = name !== 'designer'
  if (app) app.hidden = name !== 'app'
  document.querySelectorAll<HTMLButtonElement>('#settingsTabs .lf-tab').forEach((b) => {
    const on = b.dataset.tab === name
    b.classList.toggle('on', on)
    b.setAttribute('aria-selected', String(on))
    b.tabIndex = on ? 0 : -1
  })
  if (name === 'designer') renderDesigner()
}

function buildTabs(): void {
  const tabs = document.getElementById('settingsTabs')
  if (!tabs) return
  tabs.replaceChildren()
  const defs: ['designer' | 'app', string][] = [['designer', 'Label designer'], ['app', 'Printer & app']]
  for (const [name, label] of defs) {
    const b = h('button', 'lf-tab', label)
    b.type = 'button'; b.dataset.tab = name
    b.setAttribute('role', 'tab'); b.id = 'tab-' + name
    b.setAttribute('aria-controls', name === 'designer' ? 'designerTab' : 'appTab')
    b.addEventListener('click', () => setTab(name))
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const other = name === 'designer' ? 'app' : 'designer'
      setTab(other)
      document.getElementById('tab-' + other)?.focus()
    })
    tabs.appendChild(b)
  }
  document.getElementById('designerTab')?.setAttribute('aria-labelledby', 'tab-designer')
  document.getElementById('appTab')?.setAttribute('aria-labelledby', 'tab-app')
  document.getElementById('openDesignerTab')?.addEventListener('click', () => setTab('designer'))
}

// ── the "Text from the title" drawer ────────────────────────────────────────────

let drawerOpener: HTMLElement | null = null

function openDrawer(opener?: HTMLElement): void {
  const drawer = document.getElementById('titleDrawer'), scrim = document.getElementById('titleDrawerScrim')
  if (!drawer || !scrim) return
  drawerOpener = opener ?? (document.activeElement as HTMLElement | null)
  drawer.classList.add('show'); scrim.classList.add('show')
  drawer.removeAttribute('aria-hidden')
  ;(document.getElementById('titleDrawerClose') as HTMLElement | null)?.focus()
}

function closeDrawer(): void {
  const drawer = document.getElementById('titleDrawer'), scrim = document.getElementById('titleDrawerScrim')
  if (!drawer?.classList.contains('show')) return
  drawer.classList.remove('show'); scrim?.classList.remove('show')
  drawer.setAttribute('aria-hidden', 'true')
  renderDesigner()
  // The opener was redrawn with the designer; find its successor by key.
  const key = drawerOpener?.dataset?.k
  const again = key ? (document.querySelector(`#designerTab [data-k="${CSS.escape(key)}"]`) as HTMLElement | null) : null
  ;(again ?? (drawerOpener?.isConnected ? drawerOpener : null) ?? (document.querySelector('#designerTab [data-k="edit-pattern"]') as HTMLElement | null))?.focus()
}

function wireDrawer(): void {
  const drawer = document.getElementById('titleDrawer'), scrim = document.getElementById('titleDrawerScrim')
  if (!drawer || !scrim) return
  drawer.hidden = false; scrim.hidden = false // CSS keeps them off-screen until .show
  drawer.setAttribute('aria-hidden', 'true')
  document.getElementById('titleDrawerClose')?.addEventListener('click', closeDrawer)
  scrim.addEventListener('click', closeDrawer)
  drawer.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeDrawer(); return }
    if (e.key !== 'Tab') return
    // Keep focus inside the dialog while it is open.
    const f = [...drawer.querySelectorAll<HTMLElement>('button,input,select,summary,[tabindex]:not([tabindex="-1"])')].filter((x) => !(x as HTMLButtonElement).disabled && x.offsetParent !== null)
    if (!f.length) return
    const first = f[0]!, last = f[f.length - 1]!
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  })
}

// ── the existing regex tools (moved from renderer.ts setupSettings, behaviour unchanged) ─

interface RegexPreset { name: string; regex: string; flags: string }
const PRESETS_KEY = 'tt-regex-presets'
const SEED_PRESETS: RegexPreset[] = [
  { name: 'NWT / RETURN', regex: '\\b(NWT|RETURN)S?\\b', flags: 'i' },
  { name: 'Bin A / Bin B', regex: '\\b(Bin\\s+[A-Z])\\b', flags: 'i' },
  { name: 'Lot number', regex: '(#\\d+)', flags: '' },
]
function loadPresets(): RegexPreset[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY)
    if (!raw) return [...SEED_PRESETS] // first run: start with the patterns we know work
    const list = JSON.parse(raw) as RegexPreset[]
    return Array.isArray(list) ? list.filter((p) => p && typeof p.name === 'string' && typeof p.regex === 'string') : [...SEED_PRESETS]
  } catch { return [...SEED_PRESETS] }
}
const savePresets = (list: RegexPreset[]) => { try { localStorage.setItem(PRESETS_KEY, JSON.stringify(list)) } catch { /* quota */ } }
let regexPresets: RegexPreset[] = loadPresets()

/** Which print path the sample would take under raw ZPL (an all-emoji value falls back). */
function pathHint(): void {
  const hint = document.getElementById('samplePathHint')
  if (!hint) return
  const slow = zplOn() && layoutNeedsHtml(draft, sampleLabelData(), regexOf())
  hint.textContent = slow ? '⚠ falls back to slow HTML path' : ''
  hint.title = slow ? 'This label has glyphs ZPL cannot draw, so it prints via the slower HTML path.' : ''
}

function wireRegexTools(): void {
  const inp = (id: string) => document.getElementById(id) as HTMLInputElement | null
  const setRegex = inp('setRegex'), setFlags = inp('setFlags')
  if (!setRegex || !setFlags) return
  setRegex.value = labelTemplate.custom.regex
  setFlags.value = labelTemplate.custom.flags ?? ''

  // Extraction preview runs the SAME extractCustom the printer path uses, against whatever title
  // is in the box — so "(no match)" here means "(no match)" on the label.
  const preview = () => {
    const out = document.getElementById('extractPreview')
    if (!out) return
    if (!labelTemplate.custom.regex) { out.textContent = '—'; return }
    try {
      new RegExp(labelTemplate.custom.regex, labelTemplate.custom.flags) // throws on a bad pattern
      out.textContent = extractCustom(sampleTitle, labelTemplate.custom.regex, labelTemplate.custom.flags) || '(no match)'
    } catch { out.textContent = '(invalid regex)' }
  }
  const sampleInputs = () => {
    const t = inp('sampleTitle'), b = inp('sampleBuyer')
    if (!t || !b) return
    t.value = sampleTitle; b.value = sampleBuyer
    const onEdit = () => {
      sampleTitle = t.value; sampleBuyer = b.value
      try { localStorage.setItem('tt-sample-title', sampleTitle); localStorage.setItem('tt-sample-buyer', sampleBuyer) } catch { /* quota */ }
      preview(); pathHint(); renderDesigner()
    }
    t.addEventListener('input', onEdit)
    b.addEventListener('input', onEdit)
  }
  sampleInputs()

  // A pattern edit is a label edit: from here on the layout is what prints.
  const apply = () => {
    labelTemplate = { ...labelTemplate, custom: { enabled: labelTemplate.custom.enabled, regex: setRegex.value, flags: setFlags.value } }
    preview(); pathHint()
    commit()
  }

  // ── AI help for the extraction pattern (shown, never applied, run against the sample title) ─
  const ask = document.getElementById('rxAsk') as HTMLButtonElement | null
  const want = inp('rxWant')
  const box = document.getElementById('rxResult')
  const state = document.getElementById('rxState')
  if (ask && want && box && state) {
    let proposed: { regex: string; flags: string } | null = null
    const say = (msg: string, bad = false) => { state.textContent = msg; state.className = 'state ' + (bad ? 'bad-text' : 'muted') }
    if (!window.recapAPI?.suggestRegex) {
      ask.disabled = true
      say('Connect this computer to SellerFolio to use suggestions.')
    }
    document.getElementById('rxDismiss')?.addEventListener('click', () => { box.hidden = true; proposed = null })
    document.getElementById('rxUse')?.addEventListener('click', () => {
      if (!proposed) return
      setRegex.value = proposed.regex
      setFlags.value = proposed.flags
      labelTemplate = { ...labelTemplate, custom: { ...labelTemplate.custom, enabled: true } } // a pattern nobody prints is not what they asked for
      box.hidden = true
      proposed = null
      apply(); syncPresetSel()
      say('Pattern applied.')
    })
    ask.addEventListener('click', async () => {
      const title = sampleTitle.trim()
      if (!title) return say('Paste a sample listing title above first.', true)
      if (!want.value.trim()) return say('Describe what should print.', true)
      ask.disabled = true
      say('Asking…')
      try {
        const r = await window.recapAPI!.suggestRegex!({ title, want: want.value.trim() })
        if (r.error || !r.regex) return say(r.error ?? 'No pattern came back.', true)
        // Compile it before it is ever shown as usable — a malformed pattern must not reach the field.
        try { new RegExp(r.regex, r.flags ?? '') } catch (e) {
          return say('The suggested pattern was not valid: ' + (e as Error).message, true)
        }
        const prints = extractCustom(title, r.regex, r.flags ?? '')
        proposed = { regex: r.regex, flags: r.flags ?? '' }
        document.getElementById('rxPattern')!.textContent = r.regex + (r.flags ? '  /' + r.flags : '')
        const printsEl = document.getElementById('rxPrints')!
        printsEl.textContent = prints || 'nothing'
        printsEl.style.color = prints ? 'var(--ink)' : 'var(--loss)'
        document.getElementById('rxExplain')!.textContent = r.explain ?? ''
        box.hidden = false
        say(prints ? '' : 'That pattern finds nothing in your sample title — try describing it differently.', !prints)
      } catch (e) {
        say((e as Error).message, true)
      } finally {
        ask.disabled = false
      }
    })
  }

  for (const el of [setRegex, setFlags]) { el.addEventListener('input', apply); el.addEventListener('change', apply) }

  // ── saved patterns ──────────────────────────────────────────────────────────
  const presetSel = document.getElementById('presetSel') as HTMLSelectElement | null
  const presetName = inp('presetName')
  const presetDelete = document.getElementById('presetDelete') as HTMLButtonElement | null
  const syncPresetSel = () => {
    if (!presetSel || !presetDelete) return
    const regex = setRegex.value
    const hit = regexPresets.find((p) => p.regex === regex && p.flags === setFlags.value)
    presetSel.value = hit ? hit.name : ''
    presetDelete.disabled = !hit
    const first = presetSel.options[0]
    const custom = !hit && regex.trim() !== ''
    if (first) first.textContent = custom ? 'A custom pattern (see Advanced)' : regexPresets.length ? 'Choose what to print…' : 'No saved patterns — add one under Advanced'
    const adv = document.getElementById('advPattern') as HTMLDetailsElement | null
    if (adv && custom) adv.open = true
  }
  const renderPresets = () => {
    if (!presetSel) return
    presetSel.replaceChildren()
    const none = h('option', '', 'Choose what to print…'); none.value = ''
    presetSel.appendChild(none)
    for (const p of regexPresets) {
      const o = h('option', '', p.name); o.value = p.name; o.title = `/${p.regex}/${p.flags}`
      presetSel.appendChild(o)
    }
    syncPresetSel()
  }
  if (presetSel && presetName && presetDelete) {
    presetSel.addEventListener('change', () => {
      const p = regexPresets.find((x) => x.name === presetSel.value)
      if (!p) { presetDelete.disabled = true; return }
      setRegex.value = p.regex
      setFlags.value = p.flags
      labelTemplate = { ...labelTemplate, custom: { ...labelTemplate.custom, enabled: true } } // picking a pattern implies you want it printed
      presetName.value = p.name
      apply()
      presetDelete.disabled = false
    })
    document.getElementById('presetSave')?.addEventListener('click', () => {
      const regex = setRegex.value.trim()
      if (!regex) return
      // Default the name to the pattern itself rather than refusing — Electron has no window.prompt.
      const name = (presetName.value.trim() || regex).slice(0, 40)
      const flags = setFlags.value.trim()
      const at = regexPresets.findIndex((p) => p.name.toLowerCase() === name.toLowerCase())
      if (at >= 0) regexPresets[at] = { name, regex, flags } // same name overwrites, no duplicates
      else regexPresets.push({ name, regex, flags })
      savePresets(regexPresets)
      renderPresets()
      presetSel.value = name
      presetDelete.disabled = false
    })
    presetDelete.addEventListener('click', () => {
      const name = presetSel.value
      if (!name) return
      regexPresets = regexPresets.filter((p) => p.name !== name)
      savePresets(regexPresets)
      presetName.value = ''
      renderPresets()
    })
    for (const el of [setRegex, setFlags]) el.addEventListener('input', syncPresetSel)
    renderPresets()
  }
  preview()
  pathHint()
}

// ── start ────────────────────────────────────────────────────────────────────────

/** The canvas draws the print markup; give it the print document's element rules, scoped. */
function injectCanvasCss(): void {
  if (document.getElementById('lfPaperCss')) return
  const st = document.createElement('style')
  st.id = 'lfPaperCss'
  st.textContent = ELEMENT_CSS.map(([s, d]) => `.lf-paper ${s} { ${d} }`).join('\n')
  document.head.appendChild(st)
}

/** Called once by renderer.ts at startup, after the existing setupSettings(). */
export function initDesigner(): void {
  const tab = document.getElementById('designerTab')
  if (!tab) return
  injectCanvasCss()
  tab.replaceChildren()
  canvasCol = h('div', 'lf-col'); propsCol = h('div', 'lf-col')
  tab.appendChild(canvasCol); tab.appendChild(propsCol)
  built = true
  buildTabs()
  wireDrawer()
  wireRegexTools()
  // The raw-ZPL switch is the source of truth; repaint whenever it changes (banner or elsewhere).
  document.getElementById('rawZpl')?.addEventListener('change', () => setTimeout(renderDesigner, 0))
  setTab('designer')
  // Saved layouts from before the logo fixes: shrink heavy images, rebuild stale bitmaps.
  if (labelTemplate.layout) { void shrinkSavedLogos(); syncMonos() }
}
