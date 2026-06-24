import { orderedOrders, type RestackOrder } from '../core/restack/sortlogic'
import { binOf } from '../core/restack/bins'

const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]!))

interface PageRow { pageIndex: number; fulfillUnitId: string; orderId: string | null; matchMethod: string }
interface OrderRow { orderId: string; buyer: string; placedAt: number | null; fulfillUnitId: string | null; trackingNo: string | null; packed: boolean; items: { sku: string | null; productName: string | null; quantity: number | null }[] }
interface BatchData { batch: { id: string; status: string; pageCount: number; unitCount: number }; pages: PageRow[]; orders: OrderRow[] }

declare global {
  interface Window {
    picklistAPI: {
      list(): Promise<{ id: string; capturedAt: number; pageCount: number; unitCount: number; status: string }[]>
      get(id: string): Promise<BatchData | null>
      pagePdf(id: string, pageIndex: number): Promise<Uint8Array | null>
      exportDoc(id: string, kind: 'labels' | 'sheet'): Promise<{ ok: boolean; path?: string; error?: string }>
      clear(): Promise<{ ok: boolean }>
      setPacked(orderId: string, packed: boolean): Promise<boolean>
      onBatchReady(cb: (p: unknown) => void): void
    }
  }
}

let host: HTMLElement
let currentBatch: string | null = null

export function initPicklist(container: HTMLElement): void {
  host = container
  window.picklistAPI.onBatchReady(() => void refresh())
  void refresh()
}

async function refresh(): Promise<void> {
  const batches = await window.picklistAPI.list()
  if (!batches.length) { host.innerHTML = '<p class="empty">No label batches captured yet. Print shipping labels in the TikTok Seller window to capture a batch.</p>'; return }
  if (!currentBatch || !batches.some((b) => b.id === currentBatch)) currentBatch = batches[0]!.id
  const data = await window.picklistAPI.get(currentBatch)
  if (!data) return
  render(batches, data)
}

function render(batches: { id: string; pageCount: number; unitCount: number; status: string }[], data: BatchData): void {
  // Restack order from order data we hold; group rendering by buyer block.
  const ro: RestackOrder[] = data.orders.map((o) => ({ orderId: o.orderId, buyer: o.buyer, createdMs: o.placedAt }))
  const seq = orderedOrders(ro)
  const byId = new Map(data.orders.map((o) => [o.orderId, o]))
  const pageOfUnit = new Map(data.pages.map((p) => [p.fulfillUnitId, p.pageIndex]))

  const warnings: string[] = []
  if (data.batch.pageCount !== data.batch.unitCount) warnings.push(`Page count (${data.batch.pageCount}) != unit count (${data.batch.unitCount}) — barcode tie required.`)
  const unmatched = data.pages.filter((p) => p.matchMethod === 'unmatched').length
  if (unmatched) warnings.push(`${unmatched} label page(s) not tied to a synced order.`)

  const sel = batches.map((b) => `<option value="${esc(b.id)}"${b.id === currentBatch ? ' selected' : ''}>${esc(b.id)} — ${b.pageCount}p (${esc(b.status)})</option>`).join('')
  const rows = seq.map((o) => {
    const ord = byId.get(o.orderId)!
    const items = ord.items.map((it) => `${esc(it.sku ?? '?')} (Bin ${binOf(it.productName)})`).join(', ')
    const pageIdx = ord.fulfillUnitId != null ? pageOfUnit.get(ord.fulfillUnitId) : undefined
    const multi = ord.items.length > 1 ? ' class="multi"' : ''
    const view = pageIdx != null ? `<button data-page="${pageIdx}">View label</button>` : '—'
    return `<tr${multi}><td>${esc(ord.buyer)}</td><td>${ord.placedAt ? new Date(ord.placedAt).toLocaleTimeString() : ''}</td><td>${items}</td>
      <td><input type="checkbox" class="pack" data-order="${esc(ord.orderId)}"${ord.packed ? ' checked' : ''}></td><td>${view}</td></tr>`
  }).join('')

  host.innerHTML = `
    <div class="picklist-toolbar">
      <select id="batch-sel">${sel}</select>
      <button id="export-labels">Export reordered labels</button>
      <button id="export-sheet">Export packing sheet</button>
      <button id="clear-labels">Clear labels</button>
    </div>
    ${warnings.length ? `<div class="warnings">${warnings.map((w) => `<div>&#9888; ${w}</div>`).join('')}</div>` : ''}
    <table class="picklist"><thead><tr><th>Buyer</th><th>Purchased</th><th>Items (SKU / Bin)</th><th>Pack</th><th>Label</th></tr></thead><tbody>${rows}</tbody></table>`

  host.querySelector<HTMLSelectElement>('#batch-sel')!.onchange = (e) => { currentBatch = (e.target as HTMLSelectElement).value; void refresh() }
  host.querySelector('#export-labels')!.addEventListener('click', () => void window.picklistAPI.exportDoc(currentBatch!, 'labels'))
  host.querySelector('#export-sheet')!.addEventListener('click', () => void window.picklistAPI.exportDoc(currentBatch!, 'sheet'))
  host.querySelector('#clear-labels')!.addEventListener('click', async () => { if (confirm('Delete all captured label PDFs and tie data?')) { await window.picklistAPI.clear(); currentBatch = null; void refresh() } })
  host.querySelectorAll<HTMLInputElement>('.pack').forEach((cb) => { cb.onchange = () => void window.picklistAPI.setPacked(cb.dataset.order!, cb.checked) })
  host.querySelectorAll<HTMLButtonElement>('button[data-page]').forEach((b) => {
    b.onclick = async () => {
      const bytes = await window.picklistAPI.pagePdf(currentBatch!, Number(b.dataset.page))
      if (bytes) { const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })); window.open(url, '_blank'); setTimeout(() => URL.revokeObjectURL(url), 60000) }
    }
  })
}
