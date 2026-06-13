import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import * as XLSX from 'xlsx';
import { prisma } from '../db';
import { importSettlement } from './import';

// Minimal app exposing just the import logic over multipart, to prove file plumbing works.
function buildApp(orgId: string): FastifyInstance {
  const app = Fastify();
  app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
  app.post('/settlements/import', async (req, reply) => {
    const file = await (req as unknown as { file: () => Promise<{ filename: string; toBuffer: () => Promise<Buffer> } | undefined> }).file();
    if (!file) return reply.code(400).send({ error: 'no_file' });
    const buffer = await file.toBuffer();
    return importSettlement({ organizationId: orgId, platform: 'TIKTOK', filename: file.filename, buffer });
  });
  return app;
}

const HEADER = [
  'Type', 'Order/adjustment ID', 'Related order ID', 'creation date',
  'Total estimated settlement amount', 'Estimated Settle time', 'unsettled reasons',
  'SKU ID', 'Quantity', 'Product name', 'SKU name',
  'Net sales', 'Gross sales', 'Fees', 'Referral fee', 'Sales tax on referral fees',
  'TikTok Shop shipping fee', 'Customer-paid shipping fee', 'Customer payment',
  'Sales tax payment', 'Platform discounts', 'Adjustment amount',
];
function xlsxBuf(orderId: string): Buffer {
  const data = HEADER.map((h) => ({
    Type: 'Order', 'Order/adjustment ID': orderId, 'Related order ID': orderId, 'creation date': '2026/06/12',
    'Total estimated settlement amount': '13.76', 'Estimated Settle time': 'Delivered + 1 days',
    'unsettled reasons': 'x', 'SKU ID': '1', Quantity: '1', 'Product name': 'p', 'SKU name': '151',
    'Net sales': '15', 'Gross sales': '15', Fees: '-1.24', 'Referral fee': '-1.17',
    'Sales tax on referral fees': '-0.07', 'TikTok Shop shipping fee': '-4.58',
    'Customer-paid shipping fee': '4.58', 'Customer payment': '21.16', 'Sales tax payment': '-1.58',
    'Platform discounts': '0', 'Adjustment amount': '0',
  } as Record<string, string>)[h]);
  const aoa = [['Disclaimer'], ['Download time', '2026-06-12 16:55:33'], ['Total Transactions', '1'], [], HEADER, data];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Unsettled order and adjustment');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

let orgId: string;
let app: FastifyInstance;
beforeEach(async () => {
  const org = await prisma.organization.create({ data: { name: 'Route Org', slug: `route-${Date.now()}-${Math.round(Math.random() * 1e6)}` } });
  orgId = org.id;
  app = buildApp(orgId);
  await app.ready();
});
afterEach(async () => {
  await app.close();
  await prisma.organization.delete({ where: { id: orgId } });
});

describe('POST /settlements/import', () => {
  it('accepts a multipart XLSX upload and returns a summary', async () => {
    const boundary = '----testboundary';
    const buf = xlsxBuf('ROUTE-1');
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="Onhold-unsettled-orders-2026_06_01-2026_06_12.xlsx"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      buf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: 'POST', url: '/settlements/import',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.parsed).toBe(1);
    expect(json.totals.settlementCents).toBe(1376);
  });
});
