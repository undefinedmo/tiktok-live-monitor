// LANE B — main-process side of the show store. The store itself lives in the journal worker
// (core/storeIndex.ts, fed in journalWorker.ts); main only forwards queries with journal.ts
// queryStore(), which never blocks and resolves empty on timeout. Bridge: preload `storeAPI`.
//
// Channels (fixed by the scaffold — keep the names):
//   invoke 'store:search-sales'    ({ text, limit? }) → StoreResult (kind 'sales')
//   invoke 'store:search-chat'     ({ text, limit? }) → StoreResult (kind 'chat')
//   invoke 'store:failed-payments' ({ limit? })       → StoreResult (kind 'failed')
//
// The text is capped here (a search box, not a document) before it crosses to the worker.

import { ipcMain } from 'electron'
import { queryStore } from './journal'

const text = (a: unknown): string => (a && typeof (a as { text?: unknown }).text === 'string' ? (a as { text: string }).text.slice(0, 200) : '')
const limit = (a: unknown): number | undefined => {
  const n = (a as { limit?: unknown } | undefined)?.limit
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

/** Called once from main.ts (the "live-ui lanes" block). */
export function registerStoreIpc(): void {
  ipcMain.handle('store:search-sales', (_e, a: unknown) => queryStore({ kind: 'sales', text: text(a), limit: limit(a) }))
  ipcMain.handle('store:search-chat', (_e, a: unknown) => queryStore({ kind: 'chat', text: text(a), limit: limit(a) }))
  ipcMain.handle('store:failed-payments', (_e, a: unknown) => queryStore({ kind: 'failed', limit: limit(a) }))
}
