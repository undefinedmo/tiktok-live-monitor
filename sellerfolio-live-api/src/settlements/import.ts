// Settlement import orchestration + shared Order rollup.
import type { PrismaClient, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { parseSettlementXlsx, type ParsedSettlementRow, type ParseError } from './parse';

type Platform = 'TIKTOK' | 'WHATNOT';
// Accept the base client or an interactive-transaction client.
type Db = PrismaClient | Prisma.TransactionClient;

export interface ImportSummary {
  importId: string;
  parsed: number;
  upserted: number;
  matched: number;
  unmatched: number;
  totals: { settlementCents: number; feesCents: number };
  rowErrors: ParseError[];
}

// Link a pending settlement (if any) to its order and roll fees + net payout onto the order.
// Returns true when a settlement existed and was applied. Shared by import + sync/orders.
export async function applySettlementRollup(
  db: Db,
  organizationId: string,
  platform: Platform,
  externalOrderId: string,
  orderId: string,
): Promise<boolean> {
  const s = await db.orderSettlement.findUnique({
    where: { organizationId_platform_externalOrderId: { organizationId, platform, externalOrderId } },
    select: { id: true, orderId: true, estimatedSettlementCents: true, feesCents: true },
  });
  if (!s) return false;
  if (s.orderId !== orderId) {
    await db.orderSettlement.update({ where: { id: s.id }, data: { orderId } });
  }
  await db.order.update({
    where: { id: orderId },
    data: { netCents: s.estimatedSettlementCents, feesCents: -s.feesCents },
  });
  return true;
}

function rowData(r: ParsedSettlementRow) {
  return {
    type: r.type,
    relatedOrderId: r.relatedOrderId,
    netSalesCents: r.netSalesCents,
    grossSalesCents: r.grossSalesCents,
    feesCents: r.feesCents,
    referralFeeCents: r.referralFeeCents,
    salesTaxOnReferralCents: r.salesTaxOnReferralCents,
    tiktokShippingFeeCents: r.tiktokShippingFeeCents,
    customerPaidShippingCents: r.customerPaidShippingCents,
    customerPaymentCents: r.customerPaymentCents,
    salesTaxPaymentCents: r.salesTaxPaymentCents,
    platformDiscountCents: r.platformDiscountCents,
    estimatedSettlementCents: r.estimatedSettlementCents,
    skuId: r.skuId,
    skuName: r.skuName,
    productName: r.productName,
    quantity: r.quantity,
    estimatedSettleTime: r.estimatedSettleTime,
    unsettledReason: r.unsettledReason,
    creationDate: r.creationDate ? new Date(r.creationDate) : null,
    raw: r.raw as never,
  };
}

export async function importSettlement(opts: {
  organizationId: string;
  platform: Platform;
  filename: string;
  buffer: Buffer;
  uploadedById?: string | null;
}): Promise<ImportSummary> {
  const { organizationId, platform, filename, buffer, uploadedById } = opts;
  const { meta, rows, errors } = parseSettlementXlsx(buffer, filename);

  const totalSettlementCents = rows.reduce((s, r) => s + r.estimatedSettlementCents, 0);
  const totalFeesCents = rows.reduce((s, r) => s + r.feesCents, 0);

  return prisma.$transaction(async (tx) => {
    const imp = await tx.settlementImport.create({
      data: {
        organizationId, platform, filename,
        rangeStart: meta.rangeStart ? new Date(meta.rangeStart) : null,
        rangeEnd: meta.rangeEnd ? new Date(meta.rangeEnd) : null,
        downloadedAt: meta.downloadedAt ? new Date(meta.downloadedAt) : null,
        reportedCount: meta.reportedCount,
        rowCount: rows.length,
        totalSettlementCents,
        totalFeesCents,
        uploadedById: uploadedById ?? null,
      },
    });

    let matched = 0;
    let unmatched = 0;
    for (const r of rows) {
      const order = await tx.order.findUnique({
        where: { organizationId_platform_externalOrderId: { organizationId, platform, externalOrderId: r.externalOrderId } },
        select: { id: true },
      });
      const data = rowData(r);
      await tx.orderSettlement.upsert({
        where: { organizationId_platform_externalOrderId: { organizationId, platform, externalOrderId: r.externalOrderId } },
        update: { importId: imp.id, orderId: order?.id ?? null, ...data },
        create: { organizationId, platform, externalOrderId: r.externalOrderId, importId: imp.id, orderId: order?.id ?? null, ...data },
      });
      if (order) {
        await applySettlementRollup(tx, organizationId, platform, r.externalOrderId, order.id);
        matched++;
      } else {
        unmatched++;
      }
    }

    await tx.settlementImport.update({
      where: { id: imp.id },
      data: { matchedCount: matched, unmatchedCount: unmatched },
    });

    return {
      importId: imp.id,
      parsed: rows.length,
      upserted: rows.length,
      matched,
      unmatched,
      totals: { settlementCents: totalSettlementCents, feesCents: totalFeesCents },
      rowErrors: errors,
    };
  });
}
