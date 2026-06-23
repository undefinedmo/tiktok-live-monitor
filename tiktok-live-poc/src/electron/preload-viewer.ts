import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('ttLive', {
  onEvent: (cb: (ev: unknown) => void) => ipcRenderer.on('tt-live-event', (_e, ev) => cb(ev)),
})

contextBridge.exposeInMainWorld('labelAPI', {
  getPrinters: () => ipcRenderer.invoke('get-printers'),
  savePrinter: (name: string) => ipcRenderer.invoke('save-printer', name),
  print: (labelData: unknown, printerName: string, template?: unknown) =>
    ipcRenderer.invoke('print-label', { labelData, printerName, template }),
})

contextBridge.exposeInMainWorld('recapAPI', {
  enabled: () => ipcRenderer.invoke('recap-enabled'),
  transcribe: (payload: unknown) => ipcRenderer.invoke('tt-transcribe', payload),
  transcribeOrders: (items: unknown) => ipcRenderer.invoke('tt-transcribe-orders', items),
  onTranscribeProgress: (cb: (p: unknown) => void) => ipcRenderer.on('tt-transcribe-progress', (_e, p) => cb(p)),
})

contextBridge.exposeInMainWorld('syncAPI', {
  now: () => ipcRenderer.invoke('tt-sync'),
  connection: () => ipcRenderer.invoke('tt-connection'),
  openMonitor: () => ipcRenderer.invoke('tt-open-monitor'),
})

contextBridge.exposeInMainWorld('chatAPI', {
  send: (text: string) => ipcRenderer.invoke('tt-chat-send', text),
  onSent: (cb: (r: unknown) => void) => ipcRenderer.on('tt-chat-sent', (_e, r) => cb(r)),
})

contextBridge.exposeInMainWorld('dbAPI', {
  getSnapshot: () => ipcRenderer.invoke('tt-db:getSnapshot'),
  setCost: (orderId: string, cents: number | null) => ipcRenderer.invoke('tt-db:setCost', { orderId, cents }),
  setProductCost: (productId: string, cents: number | null) => ipcRenderer.invoke('tt-db:setProductCost', { productId, cents }),
  setTranscript: (scope: 'order' | 'product', key: string, transcript: unknown | null) => ipcRenderer.invoke('tt-db:setTranscript', { scope, key, transcript }),
  setPicked: (orderId: string, picked: boolean) => ipcRenderer.invoke('tt-db:setPicked', { orderId, picked }),
  getShows: () => ipcRenderer.invoke('tt-db:getShows'),
  setShows: (store: unknown) => ipcRenderer.invoke('tt-db:setShows', store),
  importLegacy: (blob: unknown) => ipcRenderer.invoke('tt-db:importLegacy', blob),
})
