import { describe, expect, it } from 'vitest'
import type { IdentificationRow } from '../identifyStore'
import {
  CORRECTION_FIELDS, CORRECTION_BACKOFF_MS, buildCorrectionRequest, correctionPatch, pendingCorrections,
  readCorrectionOutcome,
} from '../correctionSync'

const row = (over: Partial<IdentificationRow> = {}): IdentificationRow => ({
  orderId: 'o1', roomId: 'r1', atEpochSec: 1_760_000_000, head: 'h', lot: '#1', price: '$20',
  status: 'done', text: 'Identified', live: true, ...over,
})

describe('pendingCorrections', () => {
  it('is empty when nobody has corrected anything', () => {
    expect(pendingCorrections([row(), row({ orderId: 'o2' })])).toEqual([])
  })

  it('takes a corrected row that has not been sent', () => {
    const r = row({ edited: true, fields: { brand: 'Alo Yoga' } })
    expect(pendingCorrections([r])).toEqual([r])
  })

  it('leaves one that SellerFolio already accepted', () => {
    expect(pendingCorrections([row({ edited: true, fields: { brand: 'Alo' }, syncedAt: 1_760_000_100 })])).toEqual([])
  })

  // A row SellerFolio has no record of must not be retried every launch forever.
  it('leaves one that was refused for a reason retrying will not change', () => {
    expect(pendingCorrections([row({ edited: true, fields: { brand: 'Alo' }, syncNote: 'no record of this lot' })])).toEqual([])
  })

  it('leaves a corrected row with nothing to send', () => {
    expect(pendingCorrections([row({ edited: true })])).toEqual([])
    expect(pendingCorrections([row({ edited: true, fields: {} })])).toEqual([])
    // `summary` is not an identity field the server takes, so a row holding only one owes nothing.
    expect(pendingCorrections([row({ edited: true, fields: { summary: 'she said it was soft' } })])).toEqual([])
  })

  it('leaves a row with no orderId, which is not addressable', () => {
    expect(pendingCorrections([row({ edited: true, fields: { brand: 'Alo' }, orderId: '' })])).toEqual([])
  })

  // Oldest first, so a backlog from a past show drains in the order the lots sold rather than
  // newest-first, which would interleave two shows on screen.
  it('sends the oldest sale first', () => {
    const a = row({ orderId: 'a', atEpochSec: 300, edited: true, fields: { brand: 'A' } })
    const b = row({ orderId: 'b', atEpochSec: 100, edited: true, fields: { brand: 'B' } })
    const c = row({ orderId: 'c', atEpochSec: 200, edited: true, fields: { brand: 'C' } })
    expect(pendingCorrections([a, b, c]).map((r) => r.orderId)).toEqual(['b', 'c', 'a'])
  })
})

describe('correctionPatch', () => {
  it('sends the five identity fields', () => {
    expect([...CORRECTION_FIELDS]).toEqual(['brand', 'item', 'color', 'size', 'retailPrice'])
  })

  it('carries every identity field the row holds, including the blanked ones', () => {
    // A blanked colour IS the correction: the model said Phoenix and it was never said.
    expect(correctionPatch(row({ fields: { brand: 'Alo Yoga', color: '', size: '3X' } })))
      .toEqual({ brand: 'Alo Yoga', color: '', size: '3X' })
  })

  it('never sends a field the server does not accept', () => {
    expect(correctionPatch(row({ fields: { brand: 'Alo', summary: 'a long note' } }))).toEqual({ brand: 'Alo' })
  })

  it('is null when there is nothing the server would take', () => {
    expect(correctionPatch(row())).toBeNull()
    expect(correctionPatch(row({ fields: { summary: 'x' } }))).toBeNull()
  })
})

describe('buildCorrectionRequest', () => {
  const cfg = { baseUrl: 'http://100.68.11.76:8099', token: 'tok' }

  it('posts the lot and its fields to the correction endpoint', () => {
    const r = buildCorrectionRequest(cfg, 'o1', { brand: 'Alo Yoga' })
    expect(r.url).toBe('http://100.68.11.76:8099/api/capture/live-correct')
    expect(r.headers.Authorization).toBe('Bearer tok')
    expect(r.headers['content-type']).toBe('application/json')
    expect(JSON.parse(r.body)).toEqual({ orderId: 'o1', fields: { brand: 'Alo Yoga' } })
  })

  // A base URL saved with a trailing slash would otherwise ask for //api/capture/live-correct.
  it('does not double the slash on an address that ends in one', () => {
    expect(buildCorrectionRequest({ ...cfg, baseUrl: 'http://host:8099/' }, 'o1', { brand: 'A' }).url)
      .toBe('http://host:8099/api/capture/live-correct')
  })

  // The server takes the workspace from the token. A body that named one would be ignored there,
  // but sending one at all invites someone later to trust it.
  it('never names a workspace', () => {
    expect(buildCorrectionRequest(cfg, 'o1', { brand: 'A' }).body).not.toContain('workspace')
  })
})

describe('readCorrectionOutcome', () => {
  it('counts any 2xx as accepted', () => {
    for (const status of [200, 201, 204]) expect(readCorrectionOutcome(status).kind).toBe('sent')
  })

  // The two answers that are facts about the row rather than about the network. Retrying a 404
  // every launch would spin forever on a lot the server has no transcript for.
  it('stops retrying a refusal', () => {
    expect(readCorrectionOutcome(404)).toEqual({ kind: 'refused', note: 'SellerFolio has no record of this lot' })
    expect(readCorrectionOutcome(400)).toEqual({ kind: 'refused', note: 'SellerFolio would not accept this correction' })
  })

  // A wrong token is a settings change, not something a retry fixes — the same reading
  // identifyClient already takes on a 401.
  it('stops the whole queue on a token the server will not take', () => {
    expect(readCorrectionOutcome(401).kind).toBe('stop')
    expect(readCorrectionOutcome(403).kind).toBe('stop')
  })

  it('retries anything that could succeed later', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) expect(readCorrectionOutcome(status).kind).toBe('retry')
  })

  // The station's uplink drops mid-show; that is the ordinary case, not a refusal.
  it('retries when the request never got an answer at all', () => {
    expect(readCorrectionOutcome(null).kind).toBe('retry')
  })

  // A status nobody planned for must not be read as success — a correction would be marked sent
  // when nothing was written.
  it('retries a status it does not recognise rather than calling it sent', () => {
    for (const status of [0, 199, 302, 418]) expect(readCorrectionOutcome(status).kind).toBe('retry')
  })

  it('backs off, and never hammers a server that is down', () => {
    expect(CORRECTION_BACKOFF_MS.length).toBeGreaterThan(2)
    expect(CORRECTION_BACKOFF_MS[0]).toBeGreaterThanOrEqual(1000)
    for (let i = 1; i < CORRECTION_BACKOFF_MS.length; i++) {
      expect(CORRECTION_BACKOFF_MS[i]!).toBeGreaterThan(CORRECTION_BACKOFF_MS[i - 1]!)
    }
  })
})
