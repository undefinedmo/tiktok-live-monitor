// The shop's approved chat answers from SellerFolio hq, polled in main.
//
//   GET {base}/api/desktop/answers   (If-None-Match) → { answers, updatedAt }   every 10 min
//
// Auth like show-stats: Bearer sfm_… + X-SF-Device (main's sfHeaders), only while this computer
// holds a computer token. Never on the print path: async, timed out, every failure swallowed, and
// the last good list is kept in memory so a flaky hq never empties the suggestions.
//   304 → unchanged · 404/405/501 (older hq) → ask again in 10 min · 401/403 → paused 5 min
//   network / 5xx → back off 30 s → 5 min
//
// Channels:  invoke 'answers:get' → BankAnswer[]    event 'answers:change' BankAnswer[]  (main → viewer)

import { ipcMain } from 'electron'
import { backoffMs, classifyStatus } from '../core/buyerTags'
import { parseBank, type BankAnswer } from '../core/answerBank'

export const ANSWERS_PATH = '/api/desktop/answers'
export const ANSWERS_EVERY_MS = 10 * 60_000
export const AUTH_PAUSE_MS = 5 * 60_000
export const RETRY_BASE_MS = 30_000
export const MAX_BACKOFF_MS = 5 * 60_000
export const REQUEST_TIMEOUT_MS = 10_000

export interface AnswerBankDeps {
  url: (path: string) => string | null
  headers: () => Record<string, string> | null
  send: (channel: string, ...args: unknown[]) => void
  log: (line: string) => void
}

export interface AnswerBankEnv {
  fetch: (url: string, init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal; redirect: 'error' }) => Promise<{ status: number; headers: { get: (k: string) => string | null }; json: () => Promise<unknown> }>
  now: () => number
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (h: unknown) => void
}

export interface AnswerBankPoller {
  snapshot: () => BankAnswer[]
  tick: () => Promise<void>
  stop: () => void
}

export function createAnswerBank(d: AnswerBankDeps, env: AnswerBankEnv): AnswerBankPoller {
  let bank: BankAnswer[] = []
  let etag: string | null = null
  let failures = 0
  let timer: unknown = null
  let stopped = false
  let busy = false
  let lastKey = ''

  const log = (line: string): void => { try { d.log(`[answers] ${line}`) } catch { /* never */ } }
  const push = (): void => { try { d.send('answers:change', bank) } catch { /* never */ } }

  function schedule(ms: number): void {
    if (stopped) return
    if (timer !== null) { try { env.clearTimeout(timer) } catch { /* ignore */ } }
    timer = env.setTimeout(() => { timer = null; void tick() }, ms)
  }

  async function tick(): Promise<void> {
    if (busy || stopped) return
    busy = true
    let next = ANSWERS_EVERY_MS
    try {
      const headers = d.headers()
      const url = d.url(ANSWERS_PATH)
      if (!headers || !url) {
        next = 5_000 //  no computer token yet: cheap re-check, no network
        if (bank.length) { bank = []; etag = null; lastKey = ''; push() }
      } else {
        const key = `${url}\n${headers['authorization'] ?? headers['Authorization'] ?? ''}`
        if (key !== lastKey) { lastKey = key; etag = null } // new token / base URL: ask fresh
        const h: Record<string, string> = { ...headers, accept: 'application/json' }
        if (etag) h['if-none-match'] = etag
        let status: number | 'network' = 'network'
        let body: unknown = null
        let newTag: string | null = null
        const ctl = new AbortController()
        const to = env.setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS)
        try {
          const res = await env.fetch(url, { method: 'GET', headers: h, signal: ctl.signal, redirect: 'error' })
          status = res.status
          newTag = res.headers.get('etag')
          if (status >= 200 && status < 300) { try { body = await res.json() } catch { status = 'network' } }
        } catch {
          status = 'network'
        } finally {
          try { env.clearTimeout(to) } catch { /* ignore */ }
        }
        if (status === 304) {
          failures = 0
        } else {
          const outcome = classifyStatus(status)
          if (outcome === 'ok') {
            failures = 0
            etag = newTag
            const fresh = parseBank(body)
            if (JSON.stringify(fresh) !== JSON.stringify(bank)) { bank = fresh; push() }
          } else if (outcome === 'unavailable' || outcome === 'bad') {
            log(`hq has no ${ANSWERS_PATH} (HTTP ${status}); asking again in 10 min`)
          } else if (outcome === 'auth') {
            next = AUTH_PAUSE_MS
            log(`hq refused the computer token (HTTP ${status}); paused 5 min`)
          } else {
            failures++
            next = backoffMs(failures, RETRY_BASE_MS, MAX_BACKOFF_MS)
            if (failures === 1 || failures % 10 === 0) log(`failed (${status === 'network' ? 'network / bad body' : `HTTP ${status}`}), try ${failures}; keeping ${bank.length} cached`)
          }
        }
      }
    } catch (e) {
      log(`tick failed: ${String(e)}`)
    } finally {
      busy = false
      schedule(next)
    }
  }

  schedule(0)
  return {
    snapshot: () => bank,
    tick,
    stop: () => { stopped = true; if (timer !== null) { try { env.clearTimeout(timer) } catch { /* ignore */ } timer = null } },
  }
}

let instance: AnswerBankPoller | null = null

/** Called once from main.ts, beside registerShowStatsIpc. */
export function registerAnswerBankIpc(d: AnswerBankDeps): void {
  instance = createAnswerBank(d, {
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  })
  ipcMain.handle('answers:get', () => {
    try { return instance?.snapshot() ?? [] } catch { return [] }
  })
}
