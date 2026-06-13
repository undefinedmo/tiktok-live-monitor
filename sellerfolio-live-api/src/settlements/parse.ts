// Pure parser for TikTok Shop settlement XLSX reports.
import * as XLSX from 'xlsx';

const SHEET_NAME = 'Unsettled order and adjustment';

export interface SettlementMeta {
  filename: string;
  downloadedAt: string | null;
  reportedCount: number | null;
  rangeStart: string | null; // YYYY-MM-DD
  rangeEnd: string | null;
}

export interface ParsedSettlementRow {
  type: string;
  externalOrderId: string;
  relatedOrderId: string | null;
  netSalesCents: number;
  grossSalesCents: number;
  feesCents: number;
  referralFeeCents: number;
  salesTaxOnReferralCents: number;
  tiktokShippingFeeCents: number;
  customerPaidShippingCents: number;
  customerPaymentCents: number;
  salesTaxPaymentCents: number;
  platformDiscountCents: number;
  estimatedSettlementCents: number;
  adjustmentCents: number; // used for reconciliation only; not stored as a column
  skuId: string | null;
  skuName: string | null;
  productName: string | null;
  quantity: number;
  estimatedSettleTime: string | null;
  unsettledReason: string | null;
  creationDate: string | null;
  raw: Record<string, unknown>;
}

export interface ParseError {
  row: number; // 1-based data row index
  reason: string;
}

export interface ParseResult {
  meta: SettlementMeta;
  rows: ParsedSettlementRow[];
  errors: ParseError[];
}

// header name -> typed field
const STRING_FIELDS: Record<string, keyof ParsedSettlementRow> = {
  'Type': 'type',
  'Order/adjustment ID': 'externalOrderId',
  'Related order ID': 'relatedOrderId',
  'Estimated Settle time': 'estimatedSettleTime',
  'unsettled reasons': 'unsettledReason',
  'SKU ID': 'skuId',
  'Product name': 'productName',
  'SKU name': 'skuName',
};
const MONEY_FIELDS: Record<string, keyof ParsedSettlementRow> = {
  'Net sales': 'netSalesCents',
  'Gross sales': 'grossSalesCents',
  'Fees': 'feesCents',
  'Referral fee': 'referralFeeCents',
  'Sales tax on referral fees': 'salesTaxOnReferralCents',
  'TikTok Shop shipping fee': 'tiktokShippingFeeCents',
  'Customer-paid shipping fee': 'customerPaidShippingCents',
  'Customer payment': 'customerPaymentCents',
  'Sales tax payment': 'salesTaxPaymentCents',
  'Platform discounts': 'platformDiscountCents',
  'Total estimated settlement amount': 'estimatedSettlementCents',
  'Adjustment amount': 'adjustmentCents',
};

// TikTok's exporter writes a corrupted <dimension> (e.g. A1:AO6) that understates the row
// count. Recompute the true used range from the actual cell addresses so every row is read.
export function fullRange(ws: XLSX.WorkSheet): string {
  const cellKeys = Object.keys(ws).filter((k) => !k.startsWith('!'));
  if (cellKeys.length === 0) return (ws['!ref'] as string) ?? 'A1:A1';
  const cells = cellKeys.map((k) => XLSX.utils.decode_cell(k));
  return XLSX.utils.encode_range({
    s: { r: Math.min(...cells.map((c) => c.r)), c: Math.min(...cells.map((c) => c.c)) },
    e: { r: Math.max(...cells.map((c) => c.r)), c: Math.max(...cells.map((c) => c.c)) },
  });
}

export function toCents(v: unknown): number {
  if (v == null) return 0;
  const s = String(v).trim();
  if (s === '' || s === '/') return 0;
  const n = Number(s.replace(/[$,]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function blankRow(): ParsedSettlementRow {
  return {
    type: '', externalOrderId: '', relatedOrderId: null,
    netSalesCents: 0, grossSalesCents: 0, feesCents: 0, referralFeeCents: 0,
    salesTaxOnReferralCents: 0, tiktokShippingFeeCents: 0, customerPaidShippingCents: 0,
    customerPaymentCents: 0, salesTaxPaymentCents: 0, platformDiscountCents: 0,
    estimatedSettlementCents: 0, adjustmentCents: 0,
    skuId: null, skuName: null, productName: null, quantity: 0,
    estimatedSettleTime: null, unsettledReason: null, creationDate: null, raw: {},
  };
}

export function parseSettlementXlsx(buffer: Buffer, filename: string): ParseResult {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[SHEET_NAME] ?? wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('settlement sheet not found');
  ws['!ref'] = fullRange(ws); // repair understated dimension before extracting the grid

  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, raw: false, blankrows: true });

  // meta cells
  let downloadedAt: string | null = null;
  let reportedCount: number | null = null;
  for (const r of grid) {
    const key = r?.[0] == null ? '' : String(r[0]).trim();
    if (key === 'Download time' && r[1] != null) downloadedAt = String(r[1]);
    if (key === 'Total Transactions' && r[1] != null) reportedCount = Number(r[1]);
  }

  // filename date range: ..._YYYY_MM_DD-YYYY_MM_DD...
  const m = filename.match(/(\d{4})_(\d{2})_(\d{2})-(\d{4})_(\d{2})_(\d{2})/);
  const rangeStart = m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  const rangeEnd = m ? `${m[4]}-${m[5]}-${m[6]}` : null;
  const meta: SettlementMeta = { filename, downloadedAt, reportedCount, rangeStart, rangeEnd };

  // header row = first row whose first cell is exactly "Type"
  const headerIdx = grid.findIndex((r) => r?.[0] != null && String(r[0]).trim() === 'Type');
  if (headerIdx === -1) throw new Error('settlement header row (starting with "Type") not found');
  const header = grid[headerIdx].map((c) => (c == null ? '' : String(c).trim()));

  const rows: ParsedSettlementRow[] = [];
  const errors: ParseError[] = [];

  for (let i = headerIdx + 1; i < grid.length; i++) {
    const cells = grid[i];
    if (!cells || cells.every((c) => c == null || String(c).trim() === '')) continue;

    const rec = blankRow();
    const raw: Record<string, unknown> = {};
    header.forEach((h, col) => {
      if (!h) return;
      const val = cells[col] ?? null;
      raw[h] = val;
      if (h in STRING_FIELDS) {
        const field = STRING_FIELDS[h];
        const s = val == null ? '' : String(val).trim();
        (rec as Record<string, unknown>)[field] =
          field === 'type' || field === 'externalOrderId' ? s : s === '' || s === '/' ? null : s;
      } else if (h in MONEY_FIELDS) {
        (rec as Record<string, unknown>)[MONEY_FIELDS[h]] = toCents(val);
      } else if (h === 'Quantity') {
        rec.quantity = val == null ? 0 : Math.round(Number(String(val).trim()) || 0);
      } else if (h === 'creation date') {
        rec.creationDate = val == null || String(val).trim() === '' ? null : String(val).trim();
      }
    });
    rec.raw = raw;

    const dataRow = rows.length + 1;
    if (!rec.externalOrderId) {
      errors.push({ row: dataRow, reason: 'missing Order/adjustment ID' });
      continue;
    }
    const expected =
      rec.netSalesCents + rec.feesCents +
      (rec.tiktokShippingFeeCents + rec.customerPaidShippingCents) + rec.adjustmentCents;
    if (Math.abs(expected - rec.estimatedSettlementCents) > 1) {
      errors.push({
        row: dataRow,
        reason: `reconciliation off: expected ${expected}¢ got ${rec.estimatedSettlementCents}¢`,
      });
    }
    rows.push(rec);
  }

  return { meta, rows, errors };
}
