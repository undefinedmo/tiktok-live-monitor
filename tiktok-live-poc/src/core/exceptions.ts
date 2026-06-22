import type { OrderFlags, Sale } from './types'

export interface OrderException {
  reasons: string[]      // machine-readable reason codes, in a stable order
  needsAttention: boolean // reasons.length > 0
}

/**
 * Classify an order's exception signals for the pack/print queue. Pure.
 * Only signals a packer must ACT on become reasons. Informational/positive flags
 * (hasSellerNote — you wrote it; hasInsurance — protective) are intentionally NOT reasons.
 */
export function classifyException(flags: OrderFlags | undefined, paymentStatus?: Sale['paymentStatus']): OrderException {
  const reasons: string[] = []
  if (paymentStatus === 'failed') reasons.push('payment-failed')
  if (flags?.isRiskOrder) reasons.push('risk')
  if (flags?.isReplacement) reasons.push('replacement')
  if (flags?.hasBuyerNote) reasons.push('buyer-note')
  if (flags?.hasSellerFlag) reasons.push('seller-flag')
  return { reasons, needsAttention: reasons.length > 0 }
}
