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
  productName: z.string().max(500).optional(),
  variant: z.string().max(255).optional(),
  sku: z.string().max(255).optional(),
  quantity: z.number().int().nonnegative().default(1),
  unitPriceCents: z.number().int().default(0),
  totalCents: z.number().int().default(0),
  raw: z.unknown().optional(),
});

const orderSchema = z.object({
  platform: PlatformEnum,
  externalOrderId: z.string().max(255),
  externalShowId: z.string().max(255).optional(),
  status: z.enum(['PENDING', 'PAID', 'SHIPPED', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED']).optional(),
  buyerHandle: z.string().max(255).optional(),
  currency: z.string().length(3).default('usd'),
  subtotalCents: z.number().int().default(0),
  shippingCents: z.number().int().default(0),
  taxCents: z.number().int().default(0),
  totalCents: z.number().int().default(0),
  placedAt: z.string().datetime().optional(),
  items: z.array(orderItemSchema).optional(),
  raw: z.unknown().optional(),
});

const showSchema = z.object({
  platform: PlatformEnum,
  externalShowId: z.string().max(255),
  title: z.string().max(500).optional(),
  status: z.enum(['SCHEDULED', 'LIVE', 'ENDED']).optional(),
  startedAt: z.string().datetime().optional(),
  endedAt: z.string().datetime().optional(),
  metrics: z.record(z.unknown()).optional(),
});

const receiptSchema = z.object({
  platform: PlatformEnum,
  externalOrderId: z.string().max(255),
  sourceUrl: z.string().url().optional(),
  capturedAt: z.string().datetime().optional(),
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
    const where = {
      organizationId_platform_externalAccountId: {
        organizationId: orgId,
        platform: body.platform,
        externalAccountId: body.externalAccountId ?? null,
      },
    };
    const data = {
      handle: body.handle ?? null,
      status: body.status,
      connectedById: req.ctx!.userId,
      lastConnectedAt: body.status === 'CONNECTED' ? new Date() : undefined,
      metadata: (body.metadata ?? {}) as never,
    };
    return prisma.platformConnection.upsert({
      where,
      update: data,
      create: { organizationId: orgId, platform: body.platform, externalAccountId: body.externalAccountId ?? null, ...data },
    });
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
