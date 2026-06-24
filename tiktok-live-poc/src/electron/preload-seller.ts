import { ipcRenderer } from 'electron'

// Runs in the Seller-Center window (contextIsolation:false) so it can wrap the
// page's own fetch + XHR. We only care about shipping_doc/generate: forward its
// request body (ordered fulfill_unit_id_list) + response (doc_url, stats).
const GEN_RE = /\/fulfillment\/na\/shipping_doc\/generate/

const OrigFetch = window.fetch
window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
  let url = ''
  try { url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url } catch { /* ignore */ }
  const p = OrigFetch.apply(this as never, arguments as never) as Promise<Response>
  if (GEN_RE.test(url)) {
    const reqBody = typeof init?.body === 'string' ? init.body : ''
    p.then((res) => res.clone().text().then((respBody) => {
      ipcRenderer.send('tt-label-batch', { url, reqBody, respBody })
    }).catch(() => {})).catch(() => {})
  }
  return p
} as typeof window.fetch

// axios/older code paths use XHR; capture the request body in send() and the response on load.
const OrigOpen = XMLHttpRequest.prototype.open
const OrigSend = XMLHttpRequest.prototype.send
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest & { __genUrl?: string }, method: string, url: string | URL, ...rest: unknown[]) {
  this.__genUrl = GEN_RE.test(String(url)) ? String(url) : undefined
  return (OrigOpen as (...a: unknown[]) => void).call(this, method, url, ...rest)
}
XMLHttpRequest.prototype.send = function (this: XMLHttpRequest & { __genUrl?: string }, body?: Document | XMLHttpRequestBodyInit | null) {
  if (this.__genUrl) {
    const reqBody = typeof body === 'string' ? body : ''
    const url = this.__genUrl
    this.addEventListener('load', () => {
      try {
        if (this.responseType === '' || this.responseType === 'text') {
          ipcRenderer.send('tt-label-batch', { url, reqBody, respBody: this.responseText })
        }
      } catch { /* ignore */ }
    })
  }
  return (OrigSend as (b?: unknown) => void).call(this, body as never)
}
