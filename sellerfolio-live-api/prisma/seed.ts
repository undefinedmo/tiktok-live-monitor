// Seeds the Plan catalog (tiers + limits + feature flags + placeholder prices).
// Idempotent: re-runnable, upserts by plan key. Stripe IDs are filled in later.
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

interface PlanSeed {
  key: string;
  name: string;
  description: string;
  tier: number;
  isPublic: boolean;
  limits: Record<string, number>;
  features: Record<string, boolean>;
  prices: { interval: 'MONTH' | 'YEAR'; amountCents: number }[];
}

// limits: -1 means unlimited
const PLANS: PlanSeed[] = [
  {
    key: 'free',
    name: 'Free',
    description: 'Try the live ledger with one platform connection.',
    tier: 0,
    isPublic: true,
    limits: { members: 1, platformConnections: 1, monthlyTranscriptions: 10, monthlyOrders: 200 },
    features: { liveMonitor: true, videoReceipts: true, aiTranscription: false, teamRoles: false },
    prices: [{ interval: 'MONTH', amountCents: 0 }],
  },
  {
    key: 'starter',
    name: 'Starter',
    description: 'For solo sellers running regular shows.',
    tier: 1,
    isPublic: true,
    limits: { members: 3, platformConnections: 2, monthlyTranscriptions: 200, monthlyOrders: 5000 },
    features: { liveMonitor: true, videoReceipts: true, aiTranscription: true, teamRoles: true },
    prices: [{ interval: 'MONTH', amountCents: 2900 }, { interval: 'YEAR', amountCents: 29000 }],
  },
  {
    key: 'pro',
    name: 'Pro',
    description: 'For growing shops with a team.',
    tier: 2,
    isPublic: true,
    limits: { members: 10, platformConnections: 5, monthlyTranscriptions: 2000, monthlyOrders: 50000 },
    features: { liveMonitor: true, videoReceipts: true, aiTranscription: true, teamRoles: true },
    prices: [{ interval: 'MONTH', amountCents: 7900 }, { interval: 'YEAR', amountCents: 79000 }],
  },
  {
    key: 'enterprise',
    name: 'Enterprise',
    description: 'Unlimited scale with priority support.',
    tier: 3,
    isPublic: false,
    limits: { members: -1, platformConnections: -1, monthlyTranscriptions: -1, monthlyOrders: -1 },
    features: { liveMonitor: true, videoReceipts: true, aiTranscription: true, teamRoles: true },
    prices: [{ interval: 'MONTH', amountCents: 0 }],
  },
];

async function main() {
  for (const p of PLANS) {
    const plan = await prisma.plan.upsert({
      where: { key: p.key },
      update: { name: p.name, description: p.description, tier: p.tier, isPublic: p.isPublic, limits: p.limits, features: p.features },
      create: { key: p.key, name: p.name, description: p.description, tier: p.tier, isPublic: p.isPublic, limits: p.limits, features: p.features },
    });
    for (const price of p.prices) {
      await prisma.planPrice.upsert({
        where: { planId_interval_currency: { planId: plan.id, interval: price.interval, currency: 'usd' } },
        update: { amountCents: price.amountCents },
        create: { planId: plan.id, interval: price.interval, currency: 'usd', amountCents: price.amountCents },
      });
    }
    console.log(`✓ plan ${p.key} (${p.prices.length} price${p.prices.length === 1 ? '' : 's'})`);
  }
  console.log('Seed complete.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
