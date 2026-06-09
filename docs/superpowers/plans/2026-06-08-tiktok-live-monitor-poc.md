# TikTok Live Monitor PoC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Electron app that connects to a logged-in TikTok Shop streamer dashboard, decodes the live event stream + auction roster, and proves we can derive a Whatnot-equivalent live feed (auctions, bids, sales, counts) — validated against the dashboard's own numbers.

**Architecture:** Throwaway Electron harness (BrowserWindow + persisted session + XHR-hook preload) wraps a **portable, framework-free `core/`** module (protobuf decoder → event mapper, roster JSON → state/sales differ, merge+dedup normalizer). `core/` is pure functions, unit-tested with fixtures, and ports verbatim into the eventual desktop `TikTokLiveSource`.

**Tech Stack:** TypeScript, Electron, Vitest (tests), esbuild (bundling preload/renderer). No protobuf library — a schemaless wire-walker (pure TS). No UI framework — plain TS/HTML renderer (throwaway).

**Companion spec:** `docs/superpowers/specs/2026-06-08-tiktok-live-monitor-poc-design.md`
**Capture findings (data shapes/fixtures):** `docs/superpowers/specs/2026-06-08-tiktok-live-traffic-capture.md`

---

## File Structure

```
tiktok-live-poc/
  package.json                 deps + scripts (dev, test, build)
  tsconfig.json                strict TS, ESM
  vitest.config.ts             test config
  esbuild.mjs                  bundles preload + renderer to dist/
  src/
    core/                      PORTABLE — zero electron/DOM deps
      types.ts                 normalized event model (the LiveSource contract)
      money.ts                 "$31.00" -> {cents, formatted}
      decoder.ts               protobuf wire-walker + frame splitter
      mapper.ts                decoded stream message -> normalized events
      rosterDiffer.ts          roster JSON -> StateSnapshot + derived SaleEvents
      normalizer.ts            merge stream+roster events, dedup
      __tests__/
        decoder.test.ts
        mapper.test.ts
        rosterDiffer.test.ts
        normalizer.test.ts
        pbEncode.ts            test-only protobuf encoder (builds input bytes)
    electron/
      main.ts                  window, persist partition, login handling, IPC
      preload.ts               XHR hook -> raw bytes/JSON over IPC
    renderer/
      index.html               minimal live view + validation panel
      renderer.ts              consumes IPC, runs core, renders
  fixtures/
    roster-sample.json         captured added_auction_product/list snapshot
```

Each `core/` file has one responsibility and no imports from `electron/` or `renderer/`. The harness depends on `core/`, never the reverse.

---

## Task 0: Project scaffold

**Files:**
- Create: `tiktok-live-poc/package.json`
- Create: `tiktok-live-poc/tsconfig.json`
- Create: `tiktok-live-poc/vitest.config.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "tiktok-live-poc",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "dist/main.cjs",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "build": "node esbuild.mjs",
    "dev": "node esbuild.mjs && electron ."
  },
  "devDependencies": {
    "electron": "^33.0.0",
    "esbuild": "^0.24.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["vitest/globals"],
    "outDir": "dist"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { globals: true, environment: 'node', include: ['src/**/*.test.ts'] },
})
```

- [ ] **Step 4: Install and verify the test runner boots**

Run: `cd tiktok-live-poc && npm install && npx vitest run`
Expected: exits 0 with "No test files found" (no tests yet).

- [ ] **Step 5: Commit**

```bash
git add tiktok-live-poc/package.json tiktok-live-poc/tsconfig.json tiktok-live-poc/vitest.config.ts
git commit -m "chore: scaffold tiktok-live-poc project"
```

---

## Task 1: Normalized event model (`core/types.ts`)

**Files:**
- Create: `tiktok-live-poc/src/core/types.ts`

No test (type-only module). Defines the shared contract used by every later task.

- [ ] **Step 1: Write `types.ts`**

```ts
export interface Money { cents: number; formatted: string }

export interface Buyer { username: string; displayName?: string; avatarUrl?: string }

export interface ProductRef {
  auctionConfigId: string
  productId?: string
  skuId?: string
  name: string
  variantDesc?: string
  imageUrl?: string
}

export interface AuctionEvent {
  kind: 'auction_started' | 'auction_ended'
  product: ProductRef
  price?: Money
  ts: number
}

export interface BidEvent {
  kind: 'bid'
  auctionConfigId: string
  price: Money
  bidCount: number          // 0 when unknown from stream; roster is authoritative
  bidder?: Buyer
  ts: number
}

export interface SaleEvent {
  kind: 'sale'
  status: 'sold' | 'payment_failed'
  product: ProductRef
  price: Money
  buyer?: Buyer
  dedupeKey: string
  source: 'stream' | 'roster'
  ts: number
}

export interface AuctionState {
  auctionConfigId: string
  productName: string
  variantDesc?: string
  formattedStartingBid?: string
  numSold: number
  numFailed: number
  stockNum?: number
  winUsername?: string
  maxBidPrice?: string
  numBids?: number
}

export interface StateSnapshot {
  kind: 'state'
  pinnedAuction?: AuctionState
  products: AuctionState[]
  totals: { sold: number; failed: number; paymentFailed: number }
  ts: number
}

export interface StatusEvent {
  kind: 'status'
  status: 'connecting' | 'connected' | 'idle' | 'needs-login' | 'error'
  detail?: string
}

export type LiveEvent = AuctionEvent | BidEvent | SaleEvent | StateSnapshot | StatusEvent
```

- [ ] **Step 2: Type-check**

Run: `cd tiktok-live-poc && npx tsc --noEmit`
Expected: exits 0, no errors.

- [ ] **Step 3: Commit**

```bash
git add tiktok-live-poc/src/core/types.ts
git commit -m "feat(core): add normalized live event model"
```

---

## Task 2: Money parser (`core/money.ts`)

**Files:**
- Create: `tiktok-live-poc/src/core/money.ts`
- Test: `tiktok-live-poc/src/core/__tests__/money.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { parseMoney } from '../money'

describe('parseMoney', () => {
  it('parses a formatted dollar string to cents', () => {
    expect(parseMoney('$31.00')).toEqual({ cents: 3100, formatted: '$31.00' })
  })
  it('handles missing cents and thousands separators', () => {
    expect(parseMoney('$1,250')).toEqual({ cents: 125000, formatted: '$1,250' })
  })
  it('returns zero cents for empty/garbage', () => {
    expect(parseMoney('')).toEqual({ cents: 0, formatted: '' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tiktok-live-poc && npx vitest run src/core/__tests__/money.test.ts`
Expected: FAIL — "Cannot find module '../money'".

- [ ] **Step 3: Write `money.ts`**

```ts
import type { Money } from './types'

export function parseMoney(formatted: string | undefined | null): Money {
  const text = formatted ?? ''
  const numeric = Number(text.replace(/[^0-9.]/g, '')) || 0
  return { cents: Math.round(numeric * 100), formatted: text }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tiktok-live-poc && npx vitest run src/core/__tests__/money.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add tiktok-live-poc/src/core/money.ts tiktok-live-poc/src/core/__tests__/money.test.ts
git commit -m "feat(core): parse formatted money to cents"
```

---

## Task 3: Protobuf decoder (`core/decoder.ts`)

**Files:**
- Create: `tiktok-live-poc/src/core/decoder.ts`
- Create: `tiktok-live-poc/src/core/__tests__/pbEncode.ts` (test-only encoder)
- Test: `tiktok-live-poc/src/core/__tests__/decoder.test.ts`

Background: the live stream is a `WebcastResponse` — a sequence of messages, each `{ method: string (field 1), payload: bytes (field 2) }`. The real method-name string is always **immediately followed by tag `0x12`** (field 2, wire 2 = the payload), which distinguishes it from the same name echoed inside the payload header (followed by `0x10`). See capture doc §4.

- [ ] **Step 1: Write the test-only protobuf encoder helper**

Create `src/core/__tests__/pbEncode.ts`:

```ts
// Minimal protobuf encoder — TEST USE ONLY, to build decoder inputs.
function varint(n: number): number[] {
  const out: number[] = []
  let v = n >>> 0
  while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v >>>= 7 }
  out.push(v)
  return out
}
export function tag(field: number, wire: number): number[] {
  return varint((field << 3) | wire)
}
export function vField(field: number, value: number): number[] {
  return [...tag(field, 0), ...varint(value)]
}
export function sField(field: number, str: string): number[] {
  const bytes = [...str].map((c) => c.charCodeAt(0))
  return [...tag(field, 2), ...varint(bytes.length), ...bytes]
}
export function mField(field: number, inner: number[]): number[] {
  return [...tag(field, 2), ...varint(inner.length), ...inner]
}
export function bytes(...parts: number[][]): Uint8Array {
  return new Uint8Array(parts.flat())
}
```

- [ ] **Step 2: Write the failing test**

Create `src/core/__tests__/decoder.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { walk, decodeFrame } from '../decoder'
import { bytes, sField, vField, mField } from './pbEncode'

describe('walk', () => {
  it('decodes varint and string fields into a field tree', () => {
    const buf = bytes(vField(2, 7), sField(3, 'hello'))
    expect(walk(buf)).toEqual({ '2': '7', '3': 'hello' })
  })
  it('decodes nested messages and repeated fields', () => {
    const inner = sField(1, 'action_type').concat(sField(2, 'bid'))
    const buf = bytes(mField(5, inner), mField(5, sField(1, 'platform').concat(sField(2, 'app'))))
    const tree = walk(buf)
    expect(Array.isArray(tree['5'])).toBe(true)
    expect((tree['5'] as any)[0]).toEqual({ '1': 'action_type', '2': 'bid' })
  })
})

describe('decodeFrame', () => {
  it('extracts {method,payload} for an outer message (method followed by 0x12)', () => {
    // outer message: field1 = method string, field2 = payload bytes
    const payload = sField(3, 'auction.new_bid')           // payload.field3 = event name marker
    const msg = sField(1, 'WebcastOecLiveCreatorMessage').concat(mField(2, payload))
    const frame = bytes(mField(1, msg))                    // WebcastResponse.field1 = repeated message
    const out = decodeFrame(frame)
    expect(out).toHaveLength(1)
    expect(out[0]!.method).toBe('WebcastOecLiveCreatorMessage')
    expect(out[0]!.payload['3']).toBe('auction.new_bid')
  })
  it('ignores a method name not followed by a payload tag', () => {
    // method name followed by a varint tag (0x10) — the header echo, not an outer message
    const buf = bytes(sField(1, 'WebcastChatMessage'), vField(2, 1))
    expect(decodeFrame(buf)).toHaveLength(0)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd tiktok-live-poc && npx vitest run src/core/__tests__/decoder.test.ts`
Expected: FAIL — "Cannot find module '../decoder'".

- [ ] **Step 4: Write `decoder.ts`**

```ts
export type PbValue = string | PbNode | PbValue[]
export interface PbNode { [field: string]: PbValue }

function readVarint(b: Uint8Array, p: number): [bigint, number] {
  let result = 0n
  let shift = 0n
  let byte = 0
  do {
    byte = b[p++]!
    result |= BigInt(byte & 0x7f) << shift
    shift += 7n
  } while ((byte & 0x80) !== 0 && p < b.length)
  return [result, p]
}

function isPrintable(b: Uint8Array, s: number, e: number): boolean {
  if (e - s === 0) return false
  for (let i = s; i < e; i++) {
    const c = b[i]!
    if (c < 9 || (c > 13 && c < 32) || c > 126) return false
  }
  return true
}

export function walk(b: Uint8Array, start = 0, end = b.length, depth = 0): PbNode {
  const node: PbNode = {}
  let p = start
  const put = (k: string, v: PbValue) => {
    const existing = node[k]
    if (existing === undefined) node[k] = v
    else if (Array.isArray(existing)) existing.push(v)
    else node[k] = [existing, v]
  }
  while (p < end) {
    let tagVal: bigint
    ;[tagVal, p] = readVarint(b, p)
    const field = Number(tagVal >> 3n)
    const wire = Number(tagVal & 7n)
    if (field === 0 || p > end) break
    if (wire === 0) {
      let v: bigint
      ;[v, p] = readVarint(b, p)
      put(String(field), v.toString())
    } else if (wire === 1) {
      put(String(field), 'f64')
      p += 8
    } else if (wire === 5) {
      put(String(field), 'f32')
      p += 4
    } else if (wire === 2) {
      let len: bigint
      ;[len, p] = readVarint(b, p)
      const L = Number(len)
      const s = p
      const e = Math.min(p + L, end)
      p = e
      if (isPrintable(b, s, e) && L < 300) {
        let str = ''
        for (let i = s; i < e; i++) str += String.fromCharCode(b[i]!)
        put(String(field), str)
      } else if (L > 0 && depth < 7) {
        const sub = walk(b, s, e, depth + 1)
        put(String(field), Object.keys(sub).length ? sub : `bytes${L}`)
      } else {
        put(String(field), `bytes${L}`)
      }
    } else break
  }
  return node
}

export interface StreamMessage { method: string; payload: PbNode }

export function decodeFrame(b: Uint8Array): StreamMessage[] {
  const out: StreamMessage[] = []
  let cur = ''
  for (let i = 0; i < b.length; i++) {
    const c = b[i]!
    if (c >= 32 && c < 127) {
      cur += String.fromCharCode(c)
      continue
    }
    // c is the byte that terminated the ASCII run; outer message => c === 0x12 (field 2, wire 2)
    if (c === 0x12 && /^[A-Za-z]{3,40}Message$/.test(cur)) {
      let q = i + 1
      let len: bigint
      ;[len, q] = readVarint(b, q)
      const L = Number(len)
      const payload = walk(b, q, Math.min(q + L, b.length), 0)
      out.push({ method: cur, payload })
    }
    cur = ''
  }
  return out
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd tiktok-live-poc && npx vitest run src/core/__tests__/decoder.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add tiktok-live-poc/src/core/decoder.ts tiktok-live-poc/src/core/__tests__/decoder.test.ts tiktok-live-poc/src/core/__tests__/pbEncode.ts
git commit -m "feat(core): schemaless protobuf decoder + frame splitter"
```

---

## Task 4: Stream message mapper (`core/mapper.ts`)

**Files:**
- Create: `tiktok-live-poc/src/core/mapper.ts`
- Test: `tiktok-live-poc/src/core/__tests__/mapper.test.ts`

Maps a decoded `WebcastOecLiveCreatorMessage` payload to a normalized event. Field map (capture doc §4.1): event name at `payload.4.3`; kv list at `payload.4.4` (`[{1:key,2:val}]`); auction state at `payload.3.2.1` (`.5` productName, `.7` formatted price, `.1` auctionId). Manager messages (`§4.2`, buyer at `11.1`, product at `11.2`) are parsed by `parseManagerEnrichment` for buyer/product attribution.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { mapCreatorMessage, parseManagerEnrichment } from '../mapper'
import type { PbNode } from '../decoder'

const creator = (eventName: string, auctionState: PbNode): PbNode => ({
  '1': { '1': 'WebcastOecLiveCreatorMessage', '4': '1780000000000' },
  '3': { '2': { '1': auctionState } },
  '4': { '3': eventName, '4': [{ '1': 'action_type', '2': eventName.split('.')[1] ?? '' }] },
})

describe('mapCreatorMessage', () => {
  it('maps auction.new_bid to a BidEvent with price in cents', () => {
    const ev = mapCreatorMessage(creator('auction.new_bid', { '1': '8656', '5': 'Sugarholic Cookies', '7': '$15.00' }))
    expect(ev).toMatchObject({ kind: 'bid', auctionConfigId: '8656', price: { cents: 1500 } })
  })
  it('maps auction.end to an auction_ended AuctionEvent', () => {
    const ev = mapCreatorMessage(creator('auction.end', { '1': '8656', '5': 'Item', '7': '$31.00' }))
    expect(ev).toMatchObject({ kind: 'auction_ended', price: { cents: 3100 } })
  })
  it('maps auction.result_update to a sold SaleEvent with a dedupeKey', () => {
    const ev = mapCreatorMessage(creator('auction.result_update', { '1': '8656', '5': 'Item', '7': '$31.00' }))
    expect(ev).toMatchObject({ kind: 'sale', status: 'sold', source: 'stream', dedupeKey: '8656' })
  })
  it('maps auction.payment_failure to a payment_failed SaleEvent', () => {
    const ev = mapCreatorMessage(creator('auction.payment_failure', { '1': '8656', '5': 'Item', '7': '$31.00' }))
    expect(ev).toMatchObject({ kind: 'sale', status: 'payment_failed' })
  })
  it('returns null for an unknown event name', () => {
    expect(mapCreatorMessage(creator('auction.unknown', { '1': '8656' }))).toBeNull()
  })
})

describe('parseManagerEnrichment', () => {
  it('extracts buyer username and product from a manager payload', () => {
    const payload: PbNode = {
      '11': {
        '1': { '3': 'Brenda', '38': 'brendap2929' },
        '2': { '1': 'Women Contemporary Random Pull', '3': { '1': '$15.00' } },
      },
    }
    expect(parseManagerEnrichment(payload)).toEqual({
      buyer: { username: 'brendap2929', displayName: 'Brenda' },
      productName: 'Women Contemporary Random Pull',
      price: { cents: 1500, formatted: '$15.00' },
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tiktok-live-poc && npx vitest run src/core/__tests__/mapper.test.ts`
Expected: FAIL — "Cannot find module '../mapper'".

- [ ] **Step 3: Write `mapper.ts`**

```ts
import type { PbNode, PbValue } from './decoder'
import type { AuctionEvent, BidEvent, SaleEvent, Buyer, ProductRef, Money } from './types'
import { parseMoney } from './money'

function asNode(v: PbValue | undefined): PbNode | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as PbNode) : null
}
function asString(v: PbValue | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function eventNameOf(payload: PbNode): string | null {
  const f4 = asNode(payload['4'])
  return f4 ? asString(f4['3']) ?? null : null
}

function auctionStateOf(payload: PbNode): PbNode {
  return asNode(asNode(asNode(payload['3'])?.['2'])?.['1']) ?? {}
}

function tsOf(payload: PbNode): number {
  const header = asNode(payload['1'])
  return Number(asString(header?.['4']) ?? '0') || 0
}

function productOf(state: PbNode): ProductRef {
  return {
    auctionConfigId: asString(state['1']) ?? '',
    name: asString(state['5']) ?? '',
  }
}

function priceOf(state: PbNode): Money {
  return parseMoney(asString(state['7']) ?? '')
}

export function mapCreatorMessage(payload: PbNode): AuctionEvent | BidEvent | SaleEvent | null {
  const name = eventNameOf(payload)
  if (!name) return null
  const state = auctionStateOf(payload)
  const product = productOf(state)
  const price = priceOf(state)
  const ts = tsOf(payload)
  switch (name) {
    case 'auction.start':
      return { kind: 'auction_started', product, price, ts }
    case 'auction.end':
      return { kind: 'auction_ended', product, price, ts }
    case 'auction.new_bid':
      return { kind: 'bid', auctionConfigId: product.auctionConfigId, price, bidCount: 0, ts }
    case 'auction.result_update':
      return {
        kind: 'sale', status: 'sold', product, price,
        dedupeKey: product.auctionConfigId, source: 'stream', ts,
      }
    case 'auction.payment_failure':
      return {
        kind: 'sale', status: 'payment_failed', product, price,
        dedupeKey: product.auctionConfigId, source: 'stream', ts,
      }
    default:
      return null
  }
}

export interface ManagerEnrichment { buyer?: Buyer; productName?: string; price?: Money }

export function parseManagerEnrichment(payload: PbNode): ManagerEnrichment {
  const m = asNode(payload['11'])
  if (!m) return {}
  const user = asNode(m['1'])
  const prod = asNode(m['2'])
  const username = asString(user?.['38'])
  const result: ManagerEnrichment = {}
  if (username) result.buyer = { username, displayName: asString(user?.['3']) }
  if (prod) {
    result.productName = asString(prod['1'])
    const priceStr = asString(asNode(prod['3'])?.['1'])
    if (priceStr) result.price = parseMoney(priceStr)
  }
  return result
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tiktok-live-poc && npx vitest run src/core/__tests__/mapper.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add tiktok-live-poc/src/core/mapper.ts tiktok-live-poc/src/core/__tests__/mapper.test.ts
git commit -m "feat(core): map decoded stream messages to normalized events"
```

---

## Task 5: Roster differ (`core/rosterDiffer.ts`)

**Files:**
- Create: `tiktok-live-poc/src/core/rosterDiffer.ts`
- Create: `tiktok-live-poc/fixtures/roster-sample.json`
- Test: `tiktok-live-poc/src/core/__tests__/rosterDiffer.test.ts`

Converts an `added_auction_product/list` response (capture doc §5) to a `StateSnapshot`, and emits derived `SaleEvent`s when a product's `num_sold`/`num_failed` increases between snapshots. `RosterDiffer` is a stateful class (holds previous counts) — one instance per session.

- [ ] **Step 1: Create the fixture `fixtures/roster-sample.json`**

```json
{
  "code": 0,
  "msg": "success",
  "has_more": false,
  "auction_payment_failure_info": { "num_auction_payment_failed": 1 },
  "pinned_auction_config": {
    "auction_config_id": "10263952440",
    "product_id": "1732433029460300771",
    "sku_id": "1732433028727608291",
    "product_name": "#29 Women Contemporary Random Pull",
    "variant_desc": "#29",
    "starting_bid_price": 15,
    "formatted_starting_bid_price": "$15.00",
    "stock_num": 271,
    "num_sold": 1,
    "num_failed": 0,
    "latest_auction_item": {
      "status": 3,
      "win_username": "Sugarholic Cookies",
      "max_bidding_price": "$15.00",
      "num_of_bids": 1
    }
  },
  "auction_config_list": [
    {
      "auction_config_id": "10263952440",
      "product_id": "1732433029460300771",
      "sku_id": "1732433028727608291",
      "product_name": "#30 Women Contemporary Random Pull",
      "variant_desc": "#30",
      "formatted_starting_bid_price": "$15.00",
      "num_sold": 26,
      "num_failed": 3,
      "stock_num": 271
    }
  ]
}
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { RosterDiffer } from '../rosterDiffer'

const roster = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../fixtures/roster-sample.json', import.meta.url)), 'utf8'),
)

describe('RosterDiffer', () => {
  it('builds a StateSnapshot with totals and pinned auction', () => {
    const d = new RosterDiffer()
    const { snapshot } = d.ingest(roster, 1000)
    expect(snapshot.kind).toBe('state')
    expect(snapshot.totals).toEqual({ sold: 26, failed: 3, paymentFailed: 1 })
    expect(snapshot.pinnedAuction?.winUsername).toBe('Sugarholic Cookies')
    expect(snapshot.products[0]?.auctionConfigId).toBe('10263952440')
  })
  it('emits no sales on first ingest (baseline)', () => {
    const d = new RosterDiffer()
    expect(d.ingest(roster, 1000).sales).toEqual([])
  })
  it('emits a sold SaleEvent when num_sold increases', () => {
    const d = new RosterDiffer()
    d.ingest(roster, 1000)
    const bumped = structuredClone(roster)
    bumped.auction_config_list[0].num_sold = 28 // +2
    const { sales } = d.ingest(bumped, 2000)
    expect(sales.filter((s) => s.status === 'sold')).toHaveLength(2)
    expect(sales[0]).toMatchObject({ kind: 'sale', source: 'roster', status: 'sold' })
  })
  it('emits a payment_failed SaleEvent when num_failed increases', () => {
    const d = new RosterDiffer()
    d.ingest(roster, 1000)
    const bumped = structuredClone(roster)
    bumped.auction_config_list[0].num_failed = 4 // +1
    const { sales } = d.ingest(bumped, 2000)
    expect(sales.filter((s) => s.status === 'payment_failed')).toHaveLength(1)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd tiktok-live-poc && npx vitest run src/core/__tests__/rosterDiffer.test.ts`
Expected: FAIL — "Cannot find module '../rosterDiffer'".

- [ ] **Step 4: Write `rosterDiffer.ts`**

```ts
import type { AuctionState, SaleEvent, StateSnapshot } from './types'
import { parseMoney } from './money'

interface RawAuction {
  auction_config_id?: string
  product_id?: string
  sku_id?: string
  product_name?: string
  variant_desc?: string
  formatted_starting_bid_price?: string
  num_sold?: number
  num_failed?: number
  stock_num?: number
  latest_auction_item?: {
    win_username?: string
    max_bidding_price?: string
    num_of_bids?: number
  }
}
interface RawRoster {
  pinned_auction_config?: RawAuction
  auction_config_list?: RawAuction[]
  auction_payment_failure_info?: { num_auction_payment_failed?: number }
}

function toState(a: RawAuction): AuctionState {
  return {
    auctionConfigId: a.auction_config_id ?? '',
    productName: a.product_name ?? '',
    variantDesc: a.variant_desc,
    formattedStartingBid: a.formatted_starting_bid_price,
    numSold: a.num_sold ?? 0,
    numFailed: a.num_failed ?? 0,
    stockNum: a.stock_num,
    winUsername: a.latest_auction_item?.win_username,
    maxBidPrice: a.latest_auction_item?.max_bidding_price,
    numBids: a.latest_auction_item?.num_of_bids,
  }
}

export class RosterDiffer {
  private prevSold = new Map<string, number>()
  private prevFailed = new Map<string, number>()
  private seeded = false

  ingest(raw: RawRoster, ts: number): { snapshot: StateSnapshot; sales: SaleEvent[] } {
    const list = raw.auction_config_list ?? []
    const products = list.map(toState)
    const totals = {
      sold: products.reduce((n, p) => n + p.numSold, 0),
      failed: products.reduce((n, p) => n + p.numFailed, 0),
      paymentFailed: raw.auction_payment_failure_info?.num_auction_payment_failed ?? 0,
    }
    const snapshot: StateSnapshot = {
      kind: 'state',
      pinnedAuction: raw.pinned_auction_config ? toState(raw.pinned_auction_config) : undefined,
      products,
      totals,
      ts,
    }

    const sales: SaleEvent[] = []
    for (const a of list) {
      const id = a.auction_config_id ?? ''
      const sold = a.num_sold ?? 0
      const failed = a.num_failed ?? 0
      if (this.seeded) {
        const dSold = sold - (this.prevSold.get(id) ?? 0)
        const dFailed = failed - (this.prevFailed.get(id) ?? 0)
        for (let i = 0; i < dSold; i++) sales.push(this.makeSale(a, 'sold', `${id}:sold:${sold - i}`, ts))
        for (let i = 0; i < dFailed; i++)
          sales.push(this.makeSale(a, 'payment_failed', `${id}:failed:${failed - i}`, ts))
      }
      this.prevSold.set(id, sold)
      this.prevFailed.set(id, failed)
    }
    this.seeded = true
    return { snapshot, sales }
  }

  private makeSale(a: RawAuction, status: SaleEvent['status'], dedupeKey: string, ts: number): SaleEvent {
    return {
      kind: 'sale',
      status,
      product: {
        auctionConfigId: a.auction_config_id ?? '',
        productId: a.product_id,
        skuId: a.sku_id,
        name: a.product_name ?? '',
        variantDesc: a.variant_desc,
      },
      price: parseMoney(a.latest_auction_item?.max_bidding_price ?? a.formatted_starting_bid_price ?? ''),
      buyer: a.latest_auction_item?.win_username
        ? { username: a.latest_auction_item.win_username }
        : undefined,
      dedupeKey,
      source: 'roster',
      ts,
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd tiktok-live-poc && npx vitest run src/core/__tests__/rosterDiffer.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add tiktok-live-poc/src/core/rosterDiffer.ts tiktok-live-poc/src/core/__tests__/rosterDiffer.test.ts tiktok-live-poc/fixtures/roster-sample.json
git commit -m "feat(core): roster differ derives state + sales from snapshots"
```

---

## Task 6: Normalizer (`core/normalizer.ts`)

**Files:**
- Create: `tiktok-live-poc/src/core/normalizer.ts`
- Test: `tiktok-live-poc/src/core/__tests__/normalizer.test.ts`

Merges stream `SaleEvent`s (fast) and roster `SaleEvent`s (authoritative) into a deduplicated output. Stream and roster use different `dedupeKey` schemes, so dedup is by **`auctionConfigId + status`** within a short time window: the first sale for a given auction+status wins; later duplicates from the other source are dropped. Non-sale events pass through unchanged.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { SaleDeduper } from '../normalizer'
import type { SaleEvent } from '../types'

const sale = (over: Partial<SaleEvent>): SaleEvent => ({
  kind: 'sale', status: 'sold', source: 'stream',
  product: { auctionConfigId: '8656', name: 'Item' },
  price: { cents: 1500, formatted: '$15.00' }, dedupeKey: '8656', ts: 1000, ...over,
})

describe('SaleDeduper', () => {
  it('passes the first sale for an auction+status', () => {
    const d = new SaleDeduper()
    expect(d.accept(sale({ source: 'stream', ts: 1000 }))).toBe(true)
  })
  it('drops a duplicate sale from the other source within the window', () => {
    const d = new SaleDeduper()
    d.accept(sale({ source: 'stream', ts: 1000 }))
    expect(d.accept(sale({ source: 'roster', ts: 1500 }))).toBe(false)
  })
  it('accepts a second sale of the same auction after the window (re-auction)', () => {
    const d = new SaleDeduper(60_000)
    d.accept(sale({ source: 'stream', ts: 1000 }))
    expect(d.accept(sale({ source: 'roster', ts: 1000 + 60_001 }))).toBe(true)
  })
  it('treats sold and payment_failed independently', () => {
    const d = new SaleDeduper()
    d.accept(sale({ status: 'sold', ts: 1000 }))
    expect(d.accept(sale({ status: 'payment_failed', ts: 1000 }))).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tiktok-live-poc && npx vitest run src/core/__tests__/normalizer.test.ts`
Expected: FAIL — "Cannot find module '../normalizer'".

- [ ] **Step 3: Write `normalizer.ts`**

```ts
import type { SaleEvent } from './types'

export class SaleDeduper {
  private lastSeen = new Map<string, number>()
  constructor(private windowMs = 30_000) {}

  /** Returns true if this sale is new (should be emitted), false if it's a duplicate. */
  accept(sale: SaleEvent): boolean {
    const key = `${sale.product.auctionConfigId}:${sale.status}`
    const prev = this.lastSeen.get(key)
    if (prev !== undefined && sale.ts - prev < this.windowMs) {
      this.lastSeen.set(key, sale.ts)
      return false
    }
    this.lastSeen.set(key, sale.ts)
    return true
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tiktok-live-poc && npx vitest run src/core/__tests__/normalizer.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full core suite + type-check**

Run: `cd tiktok-live-poc && npx vitest run && npx tsc --noEmit`
Expected: all suites PASS, tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add tiktok-live-poc/src/core/normalizer.ts tiktok-live-poc/src/core/__tests__/normalizer.test.ts
git commit -m "feat(core): dedupe stream vs roster sales by auction+status window"
```

---

## Task 7: Preload XHR hook (`electron/preload.ts`)

**Files:**
- Create: `tiktok-live-poc/src/electron/preload.ts`

Runs in the dashboard page. Hooks `XMLHttpRequest` to forward (a) raw `im/fetch` arraybuffers and (b) raw `added_auction_product/list` JSON to the main process. No decoding here — keeps the page-context code tiny and the decode logic in testable `core/`.

- [ ] **Step 1: Write `preload.ts`**

```ts
import { ipcRenderer } from 'electron'

const OrigOpen = XMLHttpRequest.prototype.open
XMLHttpRequest.prototype.open = function (
  this: XMLHttpRequest,
  method: string,
  url: string | URL,
  ...rest: unknown[]
) {
  const u = String(url)
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
  // @ts-expect-error variadic passthrough to native open
  return OrigOpen.call(this, method, url, ...rest)
}

ipcRenderer.send('tt-status', { status: 'connecting' })

// Detect a room becoming active (first im/fetch carries room_id) → connected.
const seenRoom = { value: false }
const OrigOpen2 = XMLHttpRequest.prototype.open
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
  const u = String(url)
  const m = u.match(/[?&]room_id=(\d+)/)
  if (m && !seenRoom.value) {
    seenRoom.value = true
    ipcRenderer.send('tt-status', { status: 'connected', detail: `room ${m[1]}` })
  }
  // @ts-expect-error variadic passthrough
  return OrigOpen2.call(this, method, url, ...rest)
}
```

- [ ] **Step 2: Type-check**

Run: `cd tiktok-live-poc && npx tsc --noEmit`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add tiktok-live-poc/src/electron/preload.ts
git commit -m "feat(electron): preload XHR hook forwards stream/roster to main"
```

---

## Task 8: Electron main — window, session, login, IPC (`electron/main.ts`)

**Files:**
- Create: `tiktok-live-poc/src/electron/main.ts`
- Create: `tiktok-live-poc/esbuild.mjs`

Opens a persisted-session BrowserWindow on the dashboard (interactive login per spec "Authentication & session"), runs `core/` on the forwarded data, and relays normalized `LiveEvent`s to the renderer. Detects logout via navigation to a login URL.

- [ ] **Step 1: Write the esbuild bundler `esbuild.mjs`**

```js
import { build } from 'esbuild'

const common = { bundle: true, platform: 'node', target: 'node20', format: 'cjs', external: ['electron'] }

await build({ ...common, entryPoints: ['src/electron/main.ts'], outfile: 'dist/main.cjs' })
await build({ ...common, entryPoints: ['src/electron/preload.ts'], outfile: 'dist/preload.cjs' })
await build({
  entryPoints: ['src/renderer/renderer.ts'],
  bundle: true, platform: 'browser', target: 'chrome120', format: 'iife', outfile: 'dist/renderer.js',
})
console.log('build complete')
```

- [ ] **Step 2: Write `main.ts`**

```ts
import { app, BrowserWindow, ipcMain, session } from 'electron'
import { fileURLToPath } from 'node:url'
import { decodeFrame } from '../core/decoder'
import { mapCreatorMessage, parseManagerEnrichment } from '../core/mapper'
import { RosterDiffer } from '../core/rosterDiffer'
import { SaleDeduper } from '../core/normalizer'
import type { LiveEvent } from '../core/types'

const DASHBOARD = 'https://shop.tiktok.com/streamer/live/event/dashboard'
const LOGIN_RE = /\/(login|passport|account\/login)/

let viewer: BrowserWindow | null = null
let monitor: BrowserWindow | null = null
const differ = new RosterDiffer()
const deduper = new SaleDeduper()

function send(ev: LiveEvent) {
  viewer?.webContents.send('tt-live-event', ev)
}

function createViewer() {
  viewer = new BrowserWindow({
    width: 1100, height: 800,
    webPreferences: { preload: fileURLToPath(new URL('./preload-viewer.cjs', import.meta.url)) },
  })
  viewer.loadFile(fileURLToPath(new URL('../renderer/index.html', import.meta.url)))
}

function createMonitor() {
  const part = session.fromPartition('persist:tiktok')
  monitor = new BrowserWindow({
    width: 1280, height: 860,
    webPreferences: {
      session: part,
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
    },
  })
  monitor.loadURL(DASHBOARD)
  monitor.webContents.on('did-navigate', (_e, url) => {
    if (LOGIN_RE.test(url)) send({ kind: 'status', status: 'needs-login', detail: 'Log in to TikTok in the monitor window' })
  })
}

ipcMain.on('tt-status', (_e, s: { status: LiveEvent extends { kind: 'status' } ? string : string; detail?: string }) => {
  send({ kind: 'status', status: s.status as never, detail: s.detail })
})

ipcMain.on('tt-stream-frame', (_e, bytes: Uint8Array) => {
  for (const msg of decodeFrame(bytes)) {
    if (msg.method === 'WebcastOecLiveCreatorMessage') {
      const ev = mapCreatorMessage(msg.payload)
      if (ev) {
        if (ev.kind === 'sale' && !deduper.accept(ev)) continue
        send(ev)
      }
    } else if (msg.method === 'WebcastOecLiveManagerMessage') {
      const enrich = parseManagerEnrichment(msg.payload)
      if (enrich.buyer) send({ kind: 'status', status: 'connected', detail: `high bidder: @${enrich.buyer.username}` })
    }
  }
})

ipcMain.on('tt-roster', (_e, raw: unknown) => {
  const { snapshot, sales } = differ.ingest(raw as never, Date.now())
  send(snapshot)
  for (const s of sales) if (deduper.accept(s)) send(s)
})

app.whenReady().then(() => {
  createViewer()
  createMonitor()
})
app.on('window-all-closed', () => app.quit())
```

> Note: `Date.now()` is fine here (Electron runtime). The viewer needs its own minimal preload to receive events — create it in the next step.

- [ ] **Step 3: Add the viewer preload bundle to `esbuild.mjs`**

Append to `esbuild.mjs` before the final `console.log`:

```js
await build({ ...common, entryPoints: ['src/electron/preload-viewer.ts'], outfile: 'dist/preload-viewer.cjs' })
```

- [ ] **Step 4: Create `src/electron/preload-viewer.ts`**

```ts
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('ttLive', {
  onEvent: (cb: (ev: unknown) => void) => ipcRenderer.on('tt-live-event', (_e, ev) => cb(ev)),
})
```

- [ ] **Step 5: Type-check**

Run: `cd tiktok-live-poc && npx tsc --noEmit`
Expected: exits 0. (If TS flags the `status as never` cast, it is intentional — the preload sends a plain string the renderer treats loosely.)

- [ ] **Step 6: Commit**

```bash
git add tiktok-live-poc/src/electron/main.ts tiktok-live-poc/src/electron/preload-viewer.ts tiktok-live-poc/esbuild.mjs
git commit -m "feat(electron): main process runs core and relays live events"
```

---

## Task 9: Renderer — live view + validation panel (`renderer/`)

**Files:**
- Create: `tiktok-live-poc/src/renderer/index.html`
- Create: `tiktok-live-poc/src/renderer/renderer.ts`

Three panes (spec "Minimal UI"): **Now** (pinned auction), **Feed** (events), **Totals + Validation** (our derived sold count vs roster `num_sold`).

- [ ] **Step 1: Write `index.html`**

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>TikTok Live Monitor PoC</title>
    <style>
      body { font: 13px system-ui; margin: 0; display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: auto 1fr; height: 100vh; }
      header { grid-column: 1 / 3; padding: 8px 12px; background: #111; color: #eee; }
      #now { padding: 12px; border-right: 1px solid #ddd; }
      #feed { padding: 12px; overflow: auto; }
      #totals { grid-column: 1 / 3; padding: 8px 12px; background: #f5f5f5; display: flex; gap: 24px; }
      .row { padding: 4px 0; border-bottom: 1px solid #eee; }
      .ok { color: #137333; } .bad { color: #b00020; font-weight: 600; }
    </style>
  </head>
  <body>
    <header><span id="status">connecting…</span></header>
    <div id="now"><h3>Now</h3><div id="pinned">—</div></div>
    <div id="feed"><h3>Feed</h3><div id="events"></div></div>
    <div id="totals">
      <span>Derived sold: <b id="derivedSold">0</b></span>
      <span>Roster sold: <b id="rosterSold">0</b></span>
      <span id="match" class="ok">match</span>
      <span>Failed: <b id="failed">0</b></span>
    </div>
    <script src="../renderer.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Write `renderer.ts`**

```ts
import type { LiveEvent } from '../core/types'

declare global {
  interface Window { ttLive: { onEvent: (cb: (ev: LiveEvent) => void) => void } }
}

const $ = (id: string) => document.getElementById(id)!
let derivedSold = 0
let rosterSold = 0

function addFeed(text: string) {
  const div = document.createElement('div')
  div.className = 'row'
  div.textContent = text
  $('events').prepend(div)
}

function refreshTotals() {
  $('derivedSold').textContent = String(derivedSold)
  $('rosterSold').textContent = String(rosterSold)
  const m = $('match')
  const ok = derivedSold === rosterSold
  m.textContent = ok ? 'match' : `MISMATCH (Δ ${derivedSold - rosterSold})`
  m.className = ok ? 'ok' : 'bad'
}

window.ttLive.onEvent((ev: LiveEvent) => {
  switch (ev.kind) {
    case 'status':
      $('status').textContent = `${ev.status}${ev.detail ? ' — ' + ev.detail : ''}`
      break
    case 'auction_started':
      addFeed(`▶ started: ${ev.product.name} ${ev.price?.formatted ?? ''}`)
      break
    case 'auction_ended':
      addFeed(`⏹ ended: ${ev.product.name} ${ev.price?.formatted ?? ''}`)
      break
    case 'bid':
      addFeed(`· bid ${ev.price.formatted} on ${ev.auctionConfigId}`)
      break
    case 'sale':
      derivedSold += ev.status === 'sold' ? 1 : 0
      addFeed(`${ev.status === 'sold' ? '✓ SOLD' : '✗ FAILED'} ${ev.product.name} ${ev.price.formatted} ${ev.buyer ? '@' + ev.buyer.username : ''} [${ev.source}]`)
      refreshTotals()
      break
    case 'state':
      rosterSold = ev.totals.sold
      $('failed').textContent = String(ev.totals.failed)
      $('pinned').textContent = ev.pinnedAuction
        ? `${ev.pinnedAuction.productName} — ${ev.pinnedAuction.maxBidPrice ?? ev.pinnedAuction.formattedStartingBid ?? ''} · ${ev.pinnedAuction.numBids ?? 0} bids · win @${ev.pinnedAuction.winUsername ?? '—'}`
        : '—'
      refreshTotals()
      break
  }
})
```

> Validation note: `derivedSold` counts stream+roster `sale` events post-dedup; `rosterSold` is the roster's authoritative total. The PoC's success metric is these staying equal during a show (the "match" indicator).

- [ ] **Step 3: Build and launch**

Run: `cd tiktok-live-poc && npm run dev`
Expected: two windows open — the monitor (TikTok dashboard; log in if prompted) and the viewer (panes). With an active live, the Feed populates and "match" stays green.

- [ ] **Step 4: Commit**

```bash
git add tiktok-live-poc/src/renderer/index.html tiktok-live-poc/src/renderer/renderer.ts
git commit -m "feat(renderer): minimal live view + sold-count validation panel"
```

---

## Task 10: Validation run + README

**Files:**
- Create: `tiktok-live-poc/README.md`

- [ ] **Step 1: Write `README.md`**

```markdown
# TikTok Live Monitor PoC

Proves the TikTok Shop live data plane (see ../docs/superpowers/specs/2026-06-08-tiktok-live-monitor-poc-design.md).

## Run
1. `npm install`
2. `npm test`        # core unit tests
3. `npm run dev`     # opens monitor + viewer windows
4. In the **monitor** window, log into TikTok if prompted (you log in yourself — the app never enters credentials).
5. Start/observe a live auction. Watch the **viewer** window.

## Success criteria
- Capture stays connected across a full show without re-auth.
- Decoder logs no unhandled crashes (new event variants are captured, not fatal).
- The viewer's **Derived sold** equals **Roster sold** throughout ("match" stays green).

## What ports to the real app
Everything in `src/core/` becomes `desktop/src/lib/liveSource/TikTokLiveSource.ts` internals.
The Electron harness (`src/electron`, `src/renderer`) is throwaway.
```

- [ ] **Step 2: Manual validation checklist (record results in the commit message)**

Run: `cd tiktok-live-poc && npm run dev`, then during an active live confirm:
- `status` shows `connected — room <id>`.
- Bids/sales appear in the Feed.
- "match" indicator stays green (derived sold == roster sold).
- Reloading the monitor window recovers state from the next roster poll.

- [ ] **Step 3: Commit**

```bash
git add tiktok-live-poc/README.md
git commit -m "docs: PoC run + validation instructions"
```

---

## Self-Review

**Spec coverage:**
- Portable core (decoder/mapper/rosterDiffer/normalizer/types) → Tasks 1–6. ✓
- Throwaway Electron harness (XHR hook, persisted session, login) → Tasks 7–8. ✓
- Minimal 3-pane UI + validation panel → Task 9. ✓
- Auth & session (persisted partition, interactive login, needs-login detection, no credential automation) → Task 8 + spec section. ✓
- Sale detection & dedup (stream fast-path + roster authority, dedupe by auction+status window) → Tasks 5, 6, 8. ✓
- Fixtures from capture → `fixtures/roster-sample.json` (Task 5) + hand-encoded protobuf via `pbEncode.ts` (Task 3). ✓
- Validation criteria (derived vs roster `num_sold`) → Task 9 panel + Task 10 checklist. ✓

**Known limitations to validate during the PoC run (not plan gaps):**
- Stream `bidCount`/`bidder` are best-effort (`0`/undefined) — roster `num_of_bids` and Manager-message enrichment are authoritative. Tasks reflect this; confirm exact `bidCount` field during the run and tighten `mapper.ts` if a reliable path is found.
- `WebcastOECAuctionActionMessage` is currently treated as a redundant `auction.start` signal and not mapped (Creator message covers lifecycle). Add a mapping only if the run shows it carries unique data.
- Protobuf `bytes`/binary product names (occasionally seen for `3.2.1.5`) fall back to roster `product_name`.

**Placeholder scan:** none — every code/test step contains complete content.

**Type consistency:** `LiveEvent` union, `SaleEvent.dedupeKey`/`source`, `RosterDiffer.ingest` return shape, and `SaleDeduper.accept` signature are consistent across Tasks 1, 4, 5, 6, 8, 9.
