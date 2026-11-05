import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('ttLive', {
  onEvent: (cb: (ev: unknown) => void) => ipcRenderer.on('tt-live-event', (_e, ev) => cb(ev)),
})

contextBridge.exposeInMainWorld('labelAPI', {
  getPrinters: () => ipcRenderer.invoke('get-printers'),
  savePrinter: (name: string) => ipcRenderer.invoke('save-printer', name),
  setRawZpl: (enabled: boolean) => ipcRenderer.invoke('set-raw-zpl', enabled),
  print: (labelData: unknown, printerName: string, template?: unknown) =>
    ipcRenderer.invoke('print-label', { labelData, printerName, template }),
})

contextBridge.exposeInMainWorld('updateAPI', {
  onReady: (cb: (info: { version: string }) => void) => ipcRenderer.on('tt-update-ready', (_e, info) => cb(info)),
})

contextBridge.exposeInMainWorld('recapAPI', {
  suggestRegex: (payload: unknown) => ipcRenderer.invoke('tt-suggest-regex', payload),
})

contextBridge.exposeInMainWorld('syncAPI', {
  connection: () => ipcRenderer.invoke('tt-connection'),
  openMonitor: () => ipcRenderer.invoke('tt-open-monitor'),
})

contextBridge.exposeInMainWorld('sfSyncAPI', {
  get: () => ipcRenderer.invoke('sf-sync:get'),
  connect: (token: string) => ipcRenderer.invoke('sf-connect:connect', token),
  disconnect: () => ipcRenderer.invoke('sf-connect:disconnect'),
  openFolder: () => ipcRenderer.invoke('sf-sync:open-folder'),
  openSettings: () => ipcRenderer.invoke('sf-connect:open-settings'),
  onState: (cb: (s: unknown) => void) => ipcRenderer.on('sf-sync-state', (_e, s) => cb(s)),
})

contextBridge.exposeInMainWorld('diagAPI', {
  open: () => ipcRenderer.invoke('tt-diag:open'),
})

contextBridge.exposeInMainWorld('chatAPI', {
  send: (text: string) => ipcRenderer.invoke('tt-chat-send', text),
  onSent: (cb: (r: unknown) => void) => ipcRenderer.on('tt-chat-sent', (_e, r) => cb(r)),
})

// ── live-ui lanes (docs/live-ui/LANES.md) — scaffold-owned; the handlers are in each lane's module.
// Lane A, electron/controlIpc.ts: Text size (window zoom, per computer) and hardware keys (F14).
contextBridge.exposeInMainWorld('controlAPI', {
  getZoom: () => ipcRenderer.invoke('ctl:zoom-get'),
  setZoom: (factor: number) => ipcRenderer.invoke('ctl:zoom-set', factor),
  onKey: (cb: (key: string) => void) => ipcRenderer.on('ctl:key', (_e, key) => cb(key)),
})

// Lane B, electron/storeIpc.ts → journal worker's core/storeIndex.ts.
contextBridge.exposeInMainWorld('storeAPI', {
  searchSales: (text: string, limit?: number) => ipcRenderer.invoke('store:search-sales', { text, limit }),
  searchChat: (text: string, limit?: number) => ipcRenderer.invoke('store:search-chat', { text, limit }),
  failedPayments: (limit?: number) => ipcRenderer.invoke('store:failed-payments', { limit }),
})

// Lane D, electron/buyerHistory.ts → hq POST /api/desktop/buyer-history.
contextBridge.exposeInMainWorld('buyerAPI', {
  lookup: (ids: string[]) => ipcRenderer.invoke('buyer:lookup', ids),
  onCounts: (cb: (p: unknown) => void) => ipcRenderer.on('buyer:counts', (_e, p) => cb(p)),
})

// ┌── lane G, electron/showStats.ts → hq GET /api/desktop/show-stats + /api/desktop/timeline.
contextBridge.exposeInMainWorld('showAPI', {
  get: () => ipcRenderer.invoke('show:get'),
  setTimelineOpen: (open: boolean) => ipcRenderer.invoke('show:timeline-open', open),
  onStats: (cb: (v: unknown) => void) => ipcRenderer.on('show:stats', (_e, v) => cb(v)),
  onTimeline: (cb: (v: unknown) => void) => ipcRenderer.on('show:timeline', (_e, v) => cb(v)),
})
// └── end lane G
