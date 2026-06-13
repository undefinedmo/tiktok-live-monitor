import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as XLSX from 'xlsx';
import { prisma } from '../db';
import { importSettlement, applySettlementRollup } from './import';

const HEADER = [
  'Type', 'Order/adjustment ID', 'Related order ID', 'creation date',
  'Total estimated settlement amount', 'Estimated Settle time', 'unsettled reasons',
  'SKU ID', 'Quantity', 'Product name', 'SKU name',
  'Net sales', 'Gross sales', 'Fees', 'Referral fee', 'Sales tax on referral fees',
  'TikTok Shop shipping fee', 'Customer-paid shipping fee', 'Customer payment',
  'Sales tax payment', 'Platform discounts', 'Adjustment amount',
];

function row(orderId: string, over: Record<string, unknown> = {}): unknown[] {
  const base: Record<string, unknown> = {
    Type: 'Order', 'Order/adjustment ID': orderId, 'Related order ID': orderId,
    'creation date': '2026/06/12', 'Total estimated settlement amount': '13.76',
    'Estimated Settle time': 'Delivered + 1 days', 'unsettled reasons': 'Waiting for package delivery',
    'SKU ID': '1732440158393635811', Quantity: '1',
    'Product name': '$15 STARTS WOMEN PREMIUM BRANDS', 'SKU name': '151',
    'Net sales': '15', 'Gross sales': '15', Fees: '-1.24', 'Referral fee': '-1.17',
    'Sales tax on referral fees': '-0.07', 'TikTok Shop shipping fee': '-4.58',
    'Customer-paid shipping fee': '4.58', 'Customer payment': '21.16',
    'Sales tax payment': '-1.58', 'Platform discounts': '0', 'Adjustment amount': '0',
  };
  return HEADER.map((h) => (h in over ? over[h] : base[h]));
}

function makeXlsx(rows: unknown[][]): Buffer {
  const aoa = [['Disclaimer'], ['Download time', '2026-06-12 16:55:33'],
    ['Total Transactions', String(rows.length)], [], HEADER, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Unsettled order and adjustment');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

const FILENAME = 'Onhold-unsettled-orders-2026_06_01-2026_06_12(UTC-7).xlsx';
let orgId: string;

beforeEach(async () => {
  const org = await prisma.organization.create({
    data: { name: 'Test Settlement Org', slug: `test-settle-${Date.now()}-${Math.round(Math.random() * 1e6)}` },
  });
  orgId = org.id;
});

afterEach(async () => {
  await prisma.organization.delete({ where: { id: orgId } }); // cascades to orders + settlements + imports
});

async function makeOrder(externalOrderId: string) {
  return prisma.order.create({
    data: { organizationId: orgId, platform: 'TIKTOK', externalOrderId, totalCents: 2100 },
  });
}

describe('importSettlement', () => {
  it('imports rows, links existing orders, and rolls up fees + net payout', async () => {
    await makeOrder('AAA-1');
    const summary = await importSettlement({
      organizationId: orgId, platform: 'TIKTOK', filename: FILENAME, buffer: makeXlsx([row('AAA-1')]),
    });
    expect(summary.parsed).toBe(1);
    expect(summary.matched).toBe(1);
    expect(summary.unmatched).toBe(0);

    const order = await prisma.order.findFirstOrThrow({ where: { organizationId: orgId, externalOrderId: 'AAA-1' } });
    expect(order.netCents).toBe(1376);  // estimated settlement
    expect(order.feesCents).toBe(124);  // positive magnitude of -1.24

    const s = await prisma.orderSettlement.findFirstOrThrow({ where: { organizationId: orgId, externalOrderId: 'AAA-1' } });
    expect(s.orderId).toBe(order.id);
    expect(s.referralFeeCents).toBe(-117);
  });

  it('stores unmatched rows with orderId null', async () => {
    const summary = await importSettlement({
      organizationId: orgId, platform: 'TIKTOK', filename: FILENAME, buffer: makeXlsx([row('GHOST-1')]),
    });
    expect(summary.matched).toBe(0);
    expect(summary.unmatched).toBe(1);
    const s = await prisma.orderSettlement.findFirstOrThrow({ where: { organizationId: orgId, externalOrderId: 'GHOST-1' } });
    expect(s.orderId).toBeNull();
  });

  it('is idempotent — re-import updates in place, no duplicates', async () => {
    await makeOrder('AAA-1');
    await importSettlement({ organizationId: orgId, platform: 'TIKTOK', filename: FILENAME, buffer: makeXlsx([row('AAA-1')]) });
    await importSettlement({
      organizationId: orgId, platform: 'TIKTOK', filename: FILENAME,
      buffer: makeXlsx([row('AAA-1', { 'Referral fee': '-2.00', Fees: '-2.07', 'Sales tax on referral fees': '-0.07', 'Total estimated settlement amount': '12.93' })]),
    });
    const all = await prisma.orderSettlement.findMany({ where: { organizationId: orgId, externalOrderId: 'AAA-1' } });
    expect(all).toHaveLength(1);
    expect(all[0].referralFeeCents).toBe(-200);
    const order = await prisma.order.findFirstOrThrow({ where: { organizationId: orgId, externalOrderId: 'AAA-1' } });
    expect(order.netCents).toBe(1293);
  });
});

describe('applySettlementRollup (re-link path)', () => {
  it('links a pending settlement when its order appears later', async () => {
    // settlement imported first — order not captured yet
    await importSettlement({ organizationId: orgId, platform: 'TIKTOK', filename: FILENAME, buffer: makeXlsx([row('LATE-1')]) });
    let s = await prisma.orderSettlement.findFirstOrThrow({ where: { organizationId: orgId, externalOrderId: 'LATE-1' } });
    expect(s.orderId).toBeNull();

    // order syncs in later → caller runs the rollup
    const order = await makeOrder('LATE-1');
    const linked = await applySettlementRollup(prisma, orgId, 'TIKTOK', 'LATE-1', order.id);
    expect(linked).toBe(true);

    s = await prisma.orderSettlement.findFirstOrThrow({ where: { organizationId: orgId, externalOrderId: 'LATE-1' } });
    expect(s.orderId).toBe(order.id);
    const refreshed = await prisma.order.findFirstOrThrow({ where: { id: order.id } });
    expect(refreshed.netCents).toBe(1376);
    expect(refreshed.feesCents).toBe(124);
  });

  it('no-ops when there is no settlement for the order', async () => {
    const order = await makeOrder('NONE-1');
    const linked = await applySettlementRollup(prisma, orgId, 'TIKTOK', 'NONE-1', order.id);
    expect(linked).toBe(false);
  });
});
