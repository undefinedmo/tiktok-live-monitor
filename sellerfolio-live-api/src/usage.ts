// Usage metering + plan-limit enforcement.
import { prisma } from './db';
import type { UsageMetric } from '@prisma/client';

/** Current monthly bucket, e.g. "2026-06" (UTC). */
export function currentPeriod(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Plan limits JSON for an org's active subscription (-1 = unlimited, missing = unlimited). */
export async function planLimits(organizationId: string): Promise<Record<string, number>> {
  const sub = await prisma.subscription.findUnique({
    where: { organizationId },
    include: { plan: true },
  });
  return (sub?.plan.limits as Record<string, number>) ?? {};
}

/** Record usage (counter + event). */
export async function recordUsage(organizationId: string, metric: UsageMetric, quantity = 1, metadata?: unknown) {
  const period = currentPeriod();
  await prisma.usageCounter.upsert({
    where: { organizationId_metric_period: { organizationId, metric, period } },
    update: { count: { increment: quantity } },
    create: { organizationId, metric, period, count: quantity },
  });
  await prisma.usageEvent.create({
    data: { organizationId, metric, quantity, metadata: (metadata ?? undefined) as never },
  });
}

/**
 * Enforce a monthly limit before accepting `quantity` more of `metric`.
 * Returns { ok } or { ok:false, limit, used } if it would exceed the plan limit.
 */
export async function checkLimit(
  organizationId: string,
  metric: UsageMetric,
  limitKey: string,
  quantity = 1,
): Promise<{ ok: true } | { ok: false; limit: number; used: number }> {
  const limits = await planLimits(organizationId);
  const limit = limits[limitKey];
  if (limit == null || limit < 0) return { ok: true }; // unlimited / unset
  const counter = await prisma.usageCounter.findUnique({
    where: { organizationId_metric_period: { organizationId, metric, period: currentPeriod() } },
  });
  const used = counter?.count ?? 0;
  if (used + quantity > limit) return { ok: false, limit, used };
  return { ok: true };
}
