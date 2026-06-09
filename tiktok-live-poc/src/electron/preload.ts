import { ipcRenderer } from 'electron'

// Runs in the monitor window (contextIsolation:false, so this shares the page's
// main world and can observe the page's own XMLHttpRequest). No decoding here —
// raw bytes/JSON are forwarded to main, where the testable core/ runs.
const OrigOpen = XMLHttpRequest.prototype.open
let seenRoom = false

XMLHttpRequest.prototype.open = function (
  this: XMLHttpRequest,
  method: string,
  url: string | URL,
  ...rest: unknown[]
) {
  const u = String(url)

  const room = u.match(/[?&]room_id=(\d+)/)
  if (room && !seenRoom) {
    seenRoom = true
    ipcRenderer.send('tt-status', { status: 'connected', detail: `room ${room[1]}` })
  }

  if (/webcast\/im\/fetch/.test(u)) {
    this.addEventListener('load', () => {
      try {
        const buf = this.response as ArrayBuffer
        if (buf && buf.byteLength) ipcRenderer.send('tt-stream-frame', new Uint8Array(buf))
      } catch {
        /* ignore */
      }
    })
  } else if (/added_auction_product\/list/.test(u)) {
    this.addEventListener('load', () => {
      try {
        ipcRenderer.send('tt-roster', JSON.parse(this.responseText))
      } catch {
        /* ignore */
      }
    })
  }

  return (OrigOpen as (...a: unknown[]) => void).call(this, method, url, ...rest)
}

ipcRenderer.send('tt-status', { status: 'connecting' })
