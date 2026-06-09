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
