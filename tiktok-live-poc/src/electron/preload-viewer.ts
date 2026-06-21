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
})
