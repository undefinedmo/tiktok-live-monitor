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
