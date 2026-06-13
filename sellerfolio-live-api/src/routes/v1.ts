// v1 API routes. All routes here run behind the auth hook (see server.ts) — req.ctx is set.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db';
import { requirePermission } from '../auth';
import { recordUsage, checkLimit } from '../usage';
import { PERMISSIONS } from '../permissions';

const PlatformEnum = z.enum(['TIKTOK', 'WHATNOT']);

const connectionSchema = z.object({
  platform: PlatformEnum,
  externalAccountId: z.string().max(255).optional(),
  handle: z.string().max(255).optional(),
  status: z.enum(['CONNECTED', 'EXPIRED', 'DISCONNECTED']).default('CONNECTED'),
  metadata: z.record(z.unknown()).optional(),
});

const orderItemSchema = z.object({
  productName: z.string().max(500).nullish(),
  variant: z.string().max(255).nullish(),
  sku: z.string().max(255).nullish(),
  quantity: z.number().int().nonnegative().default(1),
  unitPriceCents: z.number().int().default(0),
  totalCents: z.number().int().default(0),
  raw: z.unknown().optional(),
});

const orderSchema = z.object({
  platform: PlatformEnum,
  externalOrderId: z.string().max(255),
  externalShowId: z.string().max(255).nullish(),
  status: z.enum(['PENDING', 'PAID', 'SHIPPED', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED']).optional(),
  buyerHandle: z.string().max(255).nullish(),
  currency: z.string().length(3).default('usd'),
  subtotalCents: z.number().int().default(0),
  shippingCents: z.number().int().default(0),
  taxCents: z.number().int().default(0),
  totalCents: z.number().int().default(0),
  placedAt: z.string().optional(),
  items: z.array(orderItemSchema).optional(),
  raw: z.unknown().optional(),
});

const showSchema = z.object({
  platform: PlatformEnum,
  externalShowId: z.string().max(255),
  title: z.string().max(500).nullish(),
  status: z.enum(['SCHEDULED', 'LIVE', 'ENDED']).optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  metrics: z.record(z.unknown()).optional(),
});

const receiptSchema = z.object({
  platform: PlatformEnum,
  externalOrderId: z.string().max(255),
  sourceUrl: z.string().url().optional(),
  capturedAt: z.string().optional(),
  transcriptStatus: z.enum(['NONE', 'PENDING', 'COMPLETED', 'FAILED', 'SKIPPED']).optional(),
  transcript: z.string().optional(),
  productInfo: z.record(z.unknown()).optional(),
});

export async function registerRoutes(api: FastifyInstance) {
  // ── identity check ──
  api.get('/me', async (req) => {
    const ctx = req.ctx!;
    const [user, org] = await Promise.all([
      prisma.user.findUnique({ where: { id: ctx.userId }, select: { id: true, email: true, name: true } }),
      prisma.organization.findUnique({ where: { id: ctx.organizationId }, select: { id: true, name: true, slug: true } }),
    ]);
    return { user, organization: org, role: ctx.role, permissions: [...ctx.permissions] };
  });

  // ── orders (read) ──
  api.get('/orders', async (req, reply) => {
    if (!requirePermission(req, reply, 'orders.view')) return;
    const orders = await prisma.order.findMany({
      where: { organizationId: req.ctx!.organizationId, deletedAt: null },
      include: {
        items: true,
        show: { select: { title: true, externalShowId: true } },
        receipts: { select: { transcript: true, productInfo: true, transcriptStatus: true, sourceUrl: true } },
      },
      orderBy: [{ placedAt: 'desc' }],
      take: 2000,
    });
    return { orders: orders.map((o) => ({ ...o, profitCents: o.costCents != null ? (o.netCents ?? o.totalCents) - o.costCents : null })) };
  });

  // ── order edit (single) ──
  const editSchema = z.object({
    costCents: z.number().int().nonnegative().nullable().optional(),
    flag: z.string().max(20).nullable().optional(),
    classification: z.string().max(20).nullable().optional(),
    isGiveaway: z.boolean().optional(),
    status: z.enum(['PENDING', 'PAID', 'SHIPPED', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED']).optional(),
    tags: z.array(z.string().max(40)).optional(),
  });
  api.patch('/orders/:id', async (req, reply) => {
    if (!requirePermission(req, reply, 'orders.manage')) return;
    const { id } = req.params as { id: string };
    const body = editSchema.parse(req.body);
    const existing = await prisma.order.findFirst({ where: { id, organizationId: req.ctx!.organizationId } });
    if (!existing) return reply.code(404).send({ error: 'order_not_found' });
    const order = await prisma.order.update({ where: { id }, data: body });
    return { ...order, profitCents: order.costCents != null ? (order.netCents ?? order.totalCents) - order.costCents : null };
  });

  // ── bulk update (mass edit) ──
  const bulkSchema = z.object({
    ids: z.array(z.string().uuid()).min(1).max(2000),
    set: z.object({
      cost: z.object({ mode: z.enum(['fixed', 'percent']), value: z.number().nonnegative() }).optional(),
      flag: z.string().max(20).nullable().optional(),
      classification: z.string().max(20).nullable().optional(),
      isGiveaway: z.boolean().optional(),
      status: z.enum(['PENDING', 'PAID', 'SHIPPED', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED']).optional(),
      tags: z.object({ add: z.array(z.string().max(40)).optional(), remove: z.array(z.string().max(40)).optional(), set: z.array(z.string().max(40)).optional() }).optional(),
    }),
  });
  api.post('/orders/bulk-update', async (req, reply) => {
    if (!requirePermission(req, reply, 'orders.manage')) return;
    const orgId = req.ctx!.organizationId;
    const { ids, set } = bulkSchema.parse(req.body);
    const rows = await prisma.order.findMany({ where: { id: { in: ids }, organizationId: orgId }, select: { id: true, totalCents: true, tags: true } });
    let updated = 0;
    for (const r of rows) {
      const data: Record<string, unknown> = {};
      if (set.cost) data.costCents = set.cost.mode === 'percent' ? Math.round((r.totalCents * set.cost.value) / 100) : Math.round(set.cost.value * 100);
      if (set.flag !== undefined) data.flag = set.flag;
      if (set.classification !== undefined) data.classification = set.classification;
      if (set.isGiveaway !== undefined) data.isGiveaway = set.isGiveaway;
      if (set.status) data.status = set.status;
      if (set.tags) {
        let t = set.tags.set ? [...set.tags.set] : [...r.tags];
        if (set.tags.add) for (const x of set.tags.add) if (!t.includes(x)) t.push(x);
        if (set.tags.remove) t = t.filter((x) => !set.tags!.remove!.includes(x));
        data.tags = t;
      }
      if (Object.keys(data).length) { await prisma.order.update({ where: { id: r.id }, data }); updated++; }
    }
    return { matched: rows.length, updated };
  });

  // ── cost suggestions (last-used costs, grouped by AI brand) ──
  api.get('/orders/cost-suggestions', async (req, reply) => {
    if (!requirePermission(req, reply, 'orders.view')) return;
    const brand = ((req.query as { brand?: string }).brand || '').toLowerCase();
    const orders = await prisma.order.findMany({
      where: { organizationId: req.ctx!.organizationId, costCents: { not: null } },
      include: { receipts: { select: { productInfo: true } } },
      take: 2000,
    });
    const counts = new Map<number, number>();
    for (const o of orders) {
      const b = String((o.receipts[0]?.productInfo as { brand?: string } | undefined)?.brand || '').toLowerCase();
      if (brand && b !== brand) continue;
      counts.set(o.costCents!, (counts.get(o.costCents!) || 0) + 1);
    }
    const suggestions = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([cents, count]) => ({ costCents: cents, count }));
    return { suggestions };
  });

  // ── distinct tags ──
  api.get('/tags', async (req, reply) => {
    if (!requirePermission(req, reply, 'orders.view')) return;
    const rows = await prisma.order.findMany({ where: { organizationId: req.ctx!.organizationId }, select: { tags: true }, take: 5000 });
    const set = new Set<string>();
    rows.forEach((r) => r.tags.forEach((t) => set.add(t)));
    return { tags: [...set].sort() };
  });

  // ── connections ──
  api.get('/connections', async (req, reply) => {
    if (!requirePermission(req, reply, 'connections.view')) return;
    return prisma.platformConnection.findMany({
      where: { organizationId: req.ctx!.organizationId, deletedAt: null },
      orderBy: { platform: 'asc' },
    });
  });

  api.put('/connections', async (req, reply) => {
    if (!requirePermission(req, reply, 'connections.manage')) return;
    const body = connectionSchema.parse(req.body);
    const orgId = req.ctx!.organizationId;
    const extId = body.externalAccountId ?? null;
    const data = {
      handle: body.handle ?? null,
      status: body.status,
      connectedById: req.ctx!.userId,
      lastConnectedAt: body.status === 'CONNECTED' ? new Date() : undefined,
      metadata: (body.metadata ?? {}) as never,
    };
    // Prisma upsert can't key on a compound-unique with a null component, so do it manually.
    const existing = await prisma.platformConnection.findFirst({
      where: { organizationId: orgId, platform: body.platform, externalAccountId: extId },
    });
    if (existing) return prisma.platformConnection.update({ where: { id: existing.id }, data });
    return prisma.platformConnection.create({ data: { organizationId: orgId, platform: body.platform, externalAccountId: extId, ...data } });
  });

  // ── sync: orders (bulk, idempotent) ──
  api.post('/sync/orders', async (req, reply) => {
    if (!requirePermission(req, reply, 'orders.manage')) return;
    const orgId = req.ctx!.organizationId;
    const orders = z.array(orderSchema).max(1000).parse(req.body);
    if (orders.length === 0) return { received: 0, upserted: 0 };

    const limit = await checkLimit(orgId, 'ORDER_SYNC', 'monthlyOrders', orders.length);
    if (!limit.ok) {
      return reply.code(402).send({ error: 'plan_limit_exceeded', metric: 'monthlyOrders', limit: limit.limit, used: limit.used });
    }

    let upserted = 0;
    for (const o of orders) {
      let showId: string | undefined;
      if (o.externalShowId) {
        const show = await prisma.show.findUnique({
          where: { organizationId_platform_externalShowId: { organizationId: orgId, platform: o.platform, externalShowId: o.externalShowId } },
          select: { id: true },
        });
        showId = show?.id;
      }
      const base = {
        showId,
        status: o.status ?? 'PENDING',
        buyerHandle: o.buyerHandle ?? null,
        currency: o.currency,
        subtotalCents: o.subtotalCents,
        shippingCents: o.shippingCents,
        taxCents: o.taxCents,
        totalCents: o.totalCents,
        placedAt: o.placedAt ? new Date(o.placedAt) : null,
        raw: (o.raw ?? undefined) as never,
      };
      const order = await prisma.order.upsert({
        where: { organizationId_platform_externalOrderId: { organizationId: orgId, platform: o.platform, externalOrderId: o.externalOrderId } },
        update: base,
        create: { organizationId: orgId, platform: o.platform, externalOrderId: o.externalOrderId, ...base },
      });
      if (o.items) {
        await prisma.orderItem.deleteMany({ where: { orderId: order.id } });
        if (o.items.length) {
          await prisma.orderItem.createMany({
            data: o.items.map((it) => ({
              organizationId: orgId,
              orderId: order.id,
              productName: it.productName ?? null,
              variant: it.variant ?? null,
              sku: it.sku ?? null,
              quantity: it.quantity,
              unitPriceCents: it.unitPriceCents,
              totalCents: it.totalCents,
              raw: (it.raw ?? undefined) as never,
            })),
          });
        }
      }
      upserted++;
    }
    await recordUsage(orgId, 'ORDER_SYNC', upserted);
    return { received: orders.length, upserted };
  });

  // ── sync: shows (bulk, idempotent) ──
  api.post('/sync/shows', async (req, reply) => {
    if (!requirePermission(req, reply, 'orders.manage')) return;
    const orgId = req.ctx!.organizationId;
    const shows = z.array(showSchema).max(1000).parse(req.body);
    let upserted = 0;
    for (const s of shows) {
      const base = {
        title: s.title ?? null,
        status: s.status ?? 'ENDED',
        startedAt: s.startedAt ? new Date(s.startedAt) : null,
        endedAt: s.endedAt ? new Date(s.endedAt) : null,
        metrics: (s.metrics ?? {}) as never,
      };
      await prisma.show.upsert({
        where: { organizationId_platform_externalShowId: { organizationId: orgId, platform: s.platform, externalShowId: s.externalShowId } },
        update: base,
        create: { organizationId: orgId, platform: s.platform, externalShowId: s.externalShowId, ...base },
      });
      upserted++;
    }
    await recordUsage(orgId, 'SHOW_SYNC', upserted);
    return { received: shows.length, upserted };
  });

  // ── receipts (attach video receipt + transcript to an order) ──
  api.post('/receipts', async (req, reply) => {
    if (!requirePermission(req, reply, 'receipts.view')) return;
    const orgId = req.ctx!.organizationId;
    const body = receiptSchema.parse(req.body);
    const order = await prisma.order.findUnique({
      where: { organizationId_platform_externalOrderId: { organizationId: orgId, platform: body.platform, externalOrderId: body.externalOrderId } },
      select: { id: true },
    });
    if (!order) return reply.code(404).send({ error: 'order_not_found' });

    const existing = await prisma.receipt.findFirst({ where: { orderId: order.id }, select: { id: true } });
    const data = {
      sourceUrl: body.sourceUrl ?? null,
      capturedAt: body.capturedAt ? new Date(body.capturedAt) : null,
      transcriptStatus: body.transcriptStatus ?? 'NONE',
      transcript: body.transcript ?? null,
      productInfo: (body.productInfo ?? undefined) as never,
      transcribedAt: body.transcript ? new Date() : null,
    };
    const receipt = existing
      ? await prisma.receipt.update({ where: { id: existing.id }, data })
      : await prisma.receipt.create({ data: { organizationId: orgId, orderId: order.id, platform: body.platform, ...data } });
    await recordUsage(orgId, 'RECEIPT_CAPTURE', 1);
    return receipt;
  });

  // ── permissions catalog (handy for building UIs) ──
  api.get('/permissions', async () => PERMISSIONS);
}
