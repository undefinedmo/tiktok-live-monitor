import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { parseSettlementXlsx, fullRange } from './parse';

// Columns the parser must understand (subset of the real 99 — order is intentionally
// shuffled to prove mapping is by header NAME, not position).
const HEADER = [
  'Type', 'Order/adjustment ID', 'Related order ID', 'creation date',
  'Total estimated settlement amount', 'Estimated Settle time', 'unsettled reasons',
  'SKU ID', 'Quantity', 'Product name', 'SKU name',
  'Net sales', 'Gross sales', 'Fees', 'Referral fee', 'Sales tax on referral fees',
  'TikTok Shop shipping fee', 'Customer-paid shipping fee', 'Customer payment',
  'Sales tax payment', 'Platform discounts', 'Adjustment amount',
];

// Build a row matching HEADER order. `over` overrides by column name.
function row(over: Record<string, unknown>): unknown[] {
  const base: Record<string, unknown> = {
    Type: 'Order', 'Order/adjustment ID': '577431091617435979',
    'Related order ID': '577431091617435979', 'creation date': '2026/06/12',
    'Total estimated settlement amount': '13.76', 'Estimated Settle time': 'Delivered + 1 days',
    'unsettled reasons': 'Waiting for package delivery', 'SKU ID': '1732440158393635811',
    Quantity: '1', 'Product name': '$15 STARTS WOMEN PREMIUM BRANDS', 'SKU name': '151',
    'Net sales': '15', 'Gross sales': '15', Fees: '-1.24', 'Referral fee': '-1.17',
    'Sales tax on referral fees': '-0.07', 'TikTok Shop shipping fee': '-4.58',
    'Customer-paid shipping fee': '4.58', 'Customer payment': '21.16',
    'Sales tax payment': '-1.58', 'Platform discounts': '0', 'Adjustment amount': '0',
  };
  return HEADER.map((h) => (h in over ? over[h] : base[h]));
}

function makeXlsx(rows: unknown[][]): Buffer {
  const aoa: unknown[][] = [
    ['Disclaimer: reference only.'],
    ['Download time', '2026-06-12 16:55:33'],
    ['Total Transactions', String(rows.length)],
    [],
    HEADER,
    ...rows,
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Unsettled order and adjustment');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

const FILENAME = 'Onhold-unsettled-orders-2026_06_01-2026_06_12(UTC-7).xlsx';

describe('parseSettlementXlsx', () => {
  it('detects the header below banner rows and maps columns by name', () => {
    const { rows } = parseSettlementXlsx(makeXlsx([row({})]), FILENAME);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.externalOrderId).toBe('577431091617435979');
    expect(r.type).toBe('Order');
    expect(r.productName).toBe('$15 STARTS WOMEN PREMIUM BRANDS');
    expect(r.quantity).toBe(1);
  });

  it('converts currency strings to signed integer cents', () => {
    const { rows } = parseSettlementXlsx(makeXlsx([row({})]), FILENAME);
    const r = rows[0];
    expect(r.netSalesCents).toBe(1500);
    expect(r.feesCents).toBe(-124);
    expect(r.referralFeeCents).toBe(-117);
    expect(r.salesTaxOnReferralCents).toBe(-7);
    expect(r.estimatedSettlementCents).toBe(1376);
    expect(r.customerPaymentCents).toBe(2116);
  });

  it("treats '/' and blank cells as 0", () => {
    const { rows } = parseSettlementXlsx(
      makeXlsx([row({ 'Platform discounts': '/', 'Adjustment amount': '' })]),
      FILENAME,
    );
    expect(rows[0].platformDiscountCents).toBe(0);
    expect(rows[0].adjustmentCents).toBe(0);
  });

  it('extracts meta and the date range from the filename', () => {
    const { meta } = parseSettlementXlsx(makeXlsx([row({})]), FILENAME);
    expect(meta.reportedCount).toBe(1);
    expect(meta.downloadedAt).toBe('2026-06-12 16:55:33');
    expect(meta.rangeStart).toBe('2026-06-01');
    expect(meta.rangeEnd).toBe('2026-06-12');
  });

  it('keeps the full row in raw', () => {
    const { rows } = parseSettlementXlsx(makeXlsx([row({})]), FILENAME);
    expect(rows[0].raw['Customer payment']).toBe('21.16');
    expect(rows[0].raw['SKU name']).toBe('151');
  });

  it('flags rows that fail the settlement reconciliation', () => {
    // estimatedSettlement should equal net + fees + shippingNet + adj = 13.76.
    // Force a mismatch by setting it to 99.99.
    const { errors } = parseSettlementXlsx(
      makeXlsx([row({ 'Total estimated settlement amount': '99.99' })]),
      FILENAME,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toMatch(/reconcil/i);
  });

  it('rejects a workbook without the expected header', () => {
    const ws = XLSX.utils.aoa_to_sheet([['nope']]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Unsettled order and adjustment');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    expect(() => parseSettlementXlsx(buf, FILENAME)).toThrow(/header/i);
  });

  it('recomputes the true range when the sheet !ref is understated (TikTok dimension quirk)', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ]); // 3 rows x 2 cols -> A1:B3
    ws['!ref'] = 'A1:A1'; // simulate TikTok's corrupted/understated dimension
    expect(fullRange(ws)).toBe('A1:B3');
  });

});
