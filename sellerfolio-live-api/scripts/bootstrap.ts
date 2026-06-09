// Bootstrap an organization for testing/first use:
//   creates (or reuses) a user + organization + OWNER membership + free-plan subscription,
//   then issues an API token and prints the plaintext ONCE.
//
// Usage: npm run bootstrap -- --email you@example.com --org "My Shop" --token "My Laptop"
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { generateToken, hashToken, lastFour } from '../src/tokens';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'org';
}

async function main() {
  const email = arg('--email', 'owner@example.com');
  const orgName = arg('--org', 'My Shop');
  const tokenName = arg('--token', 'Bootstrap token');

  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, name: email.split('@')[0] },
  });

  // unique slug
  let slug = slugify(orgName);
  for (let n = 1; await prisma.organization.findUnique({ where: { slug } }); n++) slug = `${slugify(orgName)}-${n}`;

  const org = await prisma.organization.create({
    data: { name: orgName, slug, createdById: user.id },
  });

  await prisma.membership.create({
    data: { organizationId: org.id, userId: user.id, role: 'OWNER', status: 'ACTIVE', joinedAt: new Date() },
  });

  const freePlan = await prisma.plan.findUnique({ where: { key: 'free' } });
  if (freePlan) {
    await prisma.subscription.create({
      data: { organizationId: org.id, planId: freePlan.id, status: 'ACTIVE' },
    });
  }

  const plain = generateToken();
  await prisma.apiToken.create({
    data: { organizationId: org.id, userId: user.id, name: tokenName, tokenHash: hashToken(plain), lastFour: lastFour(plain) },
  });

  console.log('\n✓ Bootstrapped:');
  console.log('  user:', user.email);
  console.log('  org: ', org.name, `(${org.slug})`);
  console.log('  plan: free');
  console.log('\n  API TOKEN (shown once — copy it now):');
  console.log('  ' + plain + '\n');
  console.log('  Test it:');
  console.log(`    curl -s http://127.0.0.1:8788/v1/me -H "Authorization: Bearer ${plain}"\n`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
