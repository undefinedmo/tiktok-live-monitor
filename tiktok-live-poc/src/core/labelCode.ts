// The code printed as a QR on every sale label, and read back by the pack station.
//
//   SF1:T:<sku_id>      e.g. SF1:T:1732451642461557731
//
//   SF1   format version — bump it if the payload shape ever changes, so old labels still
//         scan under the old rules.
//   T     platform (T = TikTok, W = Whatnot) so one pack station reads both apps' labels.
//   sku   the lot's TikTok sku_id. Each lot (variant "#35") is its own SKU, and sku ids are
//         globally unique — so it already encodes the product + lot + room, and it is the
//         SAME value on every source that can print the label: pin/get (current.sku_id),
//         the im Manager stream (variant f4) and auction_result/get (sku_id). A key hashed
//         from product NAME + lot + winner would not be: the roster name carries its own
//         "#79 " prefix, the im title and auction_result's product_name differ, and the
//         winner is a display name. The order rows (auction_result, Seller Center order
//         list, the official order API) carry sku_id too, so the pack station can match a
//         scan to an order with no key table in between.
//
// The winner is deliberately NOT in the code. A lot re-auctioned after a failed payment
// keeps its sku, so both labels share a code — harmless: the scan resolves to the sku's
// orders and only the paid one is in a shipment.
//
// Every character is in QR's alphanumeric set (0-9 A-Z and ":"), which packs 25 chars
// into a version-2 symbol (25×25 modules) at ECC level M — small enough to scan on 1" stock.

import qrcode from 'qrcode-generator'

export const LABEL_CODE_VERSION = 'SF1'

/** ECC level for every label QR — M survives a scuffed or partly-torn thermal label. The
 *  ZPL path's ^FD prefix ("MA,") must agree, or the two print paths draw different symbols. */
export const QR_ECC = 'M' as const

/** Quiet zone in modules on each side. The QR spec asks for 4; 2 is what 1" stock can
 *  afford, and every phone and 2D scanner we target reads a 2-module zone reliably. */
export const QR_QUIET = 2

export type LabelPlatform = 'T' | 'W'

export interface ParsedLabelCode {
  version: string
  platform: LabelPlatform
  id: string
}

const SKU_RE = /^\d{6,24}$/

/** The QR payload for a TikTok lot, or '' when the sku is unknown (manual prints). */
export function labelCode(skuId: string | undefined | null): string {
  const sku = (skuId ?? '').trim()
  return SKU_RE.test(sku) ? `${LABEL_CODE_VERSION}:T:${sku}` : ''
}

/** The QR module grid for a code (true = dark), without the quiet zone. The HTML path
 *  draws it; the ZPL path only needs its size, to pick a magnification that fits. */
export function qrModules(code: string): boolean[][] {
  const qr = qrcode(0, QR_ECC) // 0 = smallest version that fits
  qr.addData(code, /^[0-9A-Z $%*+\-./:]*$/.test(code) ? 'Alphanumeric' : 'Byte')
  qr.make()
  const n = qr.getModuleCount()
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)))
}

/** Decode a scanned label code; null if it is not an SF code this version understands.
 *  Scanners in keyboard-wedge mode can shift case or add a trailing CR/LF — tolerate both. */
export function parseLabelCode(raw: string): ParsedLabelCode | null {
  const m = /^(SF1):([TW]):([A-Z0-9-]{1,64})$/.exec(raw.trim().toUpperCase())
  if (!m) return null
  return { version: m[1]!, platform: m[2] as LabelPlatform, id: m[3]! }
}
