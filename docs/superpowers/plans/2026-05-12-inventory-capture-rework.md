# Inventory Capture Rework — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unblock the desktop app's `/api/inventory/*` 404s by scaffolding the v2 web API + supporting Prisma schema, then rework the desktop Inventory screen around an inline capture queue with auto-voice extraction on unknown UPCs.

**Architecture:** Three new Prisma models (`Inventory`, `InventoryMovement`, `ReceivingSession`), 15 tenant-scoped API routes following the existing `getTenantContext` / `requirePermission` pattern, and a desktop UI rebuild where the receiving queue becomes the primary capture surface. Voice extraction streams audio to a new server route that pipes through OpenAI Whisper + GPT-4 with JSON-structured output, returning per-field confidence scores.

**Tech Stack:** Next.js 16 App Router, Prisma 7, PostgreSQL, OpenAI SDK (Whisper + GPT-4o-mini), React 19 + TypeScript (Electron), Vitest.

**Spec:** `docs/superpowers/specs/2026-05-12-inventory-capture-rework-design.md`

**Deviation from spec:** The spec lists Gemini as the default voice-extract provider. The v2 web package has `openai` installed but no Gemini SDK. To keep dependency surface small, this plan uses OpenAI Whisper (transcription) + GPT-4o-mini (structured extraction) as the default. Gemini can be swapped in later by replacing the provider wrapper. Credits accounting uses a new `openai/whisper-extract` cost entry.

---

## File Map

### New files

```
web/
├── prisma/
│   └── migrations/<timestamp>_add_inventory/migration.sql       # auto-generated + raw SQL appended
├── src/
│   ├── lib/
│   │   └── inventory/
│   │       ├── types.ts                                          # shared TS types
│   │       ├── voice-extract-prompt.ts                           # prompt constant
│   │       ├── voice-extract.ts                                  # OpenAI Whisper + GPT wrapper
│   │       └── voice-extract.test.ts                             # unit tests (prompt + parsing)
│   └── app/
│       └── api/
│           └── inventory/
│               ├── route.ts                                      # GET, POST
│               ├── brands/route.ts                               # GET
│               ├── bulk/route.ts                                 # POST
│               ├── scan/route.ts                                 # POST
│               ├── voice-extract/route.ts                        # POST (multipart)
│               ├── [id]/route.ts                                 # PATCH
│               ├── [id]/qty/route.ts                             # PATCH
│               ├── [id]/movements/route.ts                       # GET
│               └── receipts/
│                   ├── route.ts                                  # GET, POST
│                   └── [id]/route.ts                             # GET, PATCH
└── tests/api/inventory/
    ├── inventory.test.ts                                         # list, create, patch, qty, bulk
    ├── scan.test.ts                                              # scan upsert + movements
    ├── receipts.test.ts                                          # session lifecycle + 409
    └── voice-extract.test.ts                                     # mocked OpenAI path

desktop/
├── src/
│   ├── components/inventory/
│   │   ├── CaptureQueue.tsx                                      # queue container
│   │   ├── CaptureRow.tsx                                        # one row, inline-editable
│   │   ├── ConfidenceUnderline.tsx                               # tiny shared component
│   │   ├── KeyboardOverlay.tsx                                   # "?" help overlay
│   │   └── ReceivingLevelMeter.tsx                               # WebAudio analyser dot
│   ├── hooks/
│   │   ├── useCaptureQueue.ts                                    # queue state + hydration
│   │   ├── useCaptureQueue.test.ts                               # unit tests
│   │   ├── useVoiceQueue.ts                                      # FIFO mic queue
│   │   ├── useVoiceQueue.test.ts                                 # unit tests
│   │   ├── useKeyboardShortcuts.ts                               # global+scoped handlers
│   │   └── useBrandAutocomplete.ts                               # fuzzy brand matching
│   └── utils/
│       └── stringSimilarity.ts                                   # Jaro-Winkler for brand match
```

### Modified files

```
web/
├── prisma/schema.prisma                                          # + 3 models + 3 Tenant relations
├── src/lib/permissions.ts                                        # + inventory.view, inventory.write
└── src/lib/credits.ts                                            # + openai/whisper-extract cost entry

desktop/
├── src/pages/Inventory.tsx                                       # restructured around queue
└── src/hooks/useReceiving.ts                                     # add row-hydration support

(delete) web/src/app/api/inventory/receipts/[id                   # malformed stub
(delete) web/src/app/api/inventory/receipts/]                     # malformed stub
```

---

## Phase 1 — Schema + base API (unblocks desktop 404s)

### Task 1.1: Prisma schema additions

**Files:**
- Modify: `web/prisma/schema.prisma`

- [ ] **Step 1: Add three models to the schema (append before the final closing brace of the file)**

```prisma
model Inventory {
  id               Int       @id @default(autoincrement())
  tenantId         String    @map("tenant_id") @db.Uuid
  upc              String    @db.VarChar(64)
  brand            String?   @db.VarChar(120)
  title            String?
  styleCode        String?   @map("style_code") @db.VarChar(64)
  colorCode        String?   @map("color_code") @db.VarChar(32)
  colorName        String?   @map("color_name") @db.VarChar(64)
  size             String?   @db.VarChar(32)
  retailPrice      Decimal?  @map("retail_price") @db.Decimal(10, 2)
  salePrice        Decimal?  @map("sale_price")   @db.Decimal(10, 2)
  cost             Decimal?  @db.Decimal(10, 2)
  qty              Int       @default(0)
  notes            String?
  enrichmentStatus String    @default("basic") @map("enrichment_status") @db.VarChar(20)
  createdAt        DateTime  @default(now()) @map("created_at") @db.Timestamptz
  updatedAt        DateTime  @default(now()) @updatedAt @map("updated_at") @db.Timestamptz

  tenant     Tenant              @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  movements  InventoryMovement[]

  @@unique([tenantId, upc])
  @@index([tenantId, updatedAt(sort: Desc)])
  @@index([tenantId, brand])
  @@index([tenantId, styleCode])
  @@map("inventory")
}

model InventoryMovement {
  id          BigInt   @id @default(autoincrement())
  tenantId    String   @map("tenant_id") @db.Uuid
  inventoryId Int      @map("inventory_id")
  delta       Int
  qtyAfter    Int      @map("qty_after")
  sourceType  String   @map("source_type") @db.VarChar(20)
  sessionId   Int?     @map("session_id")
  note        String?
  createdBy   Int      @map("created_by")
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz

  tenant    Tenant            @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  inventory Inventory         @relation(fields: [inventoryId], references: [id], onDelete: Cascade)
  session   ReceivingSession? @relation(fields: [sessionId], references: [id], onDelete: SetNull)

  @@index([tenantId, inventoryId, createdAt(sort: Desc)])
  @@index([tenantId, sessionId])
  @@map("inventory_movements")
}

model ReceivingSession {
  id         Int       @id @default(autoincrement())
  tenantId   String    @map("tenant_id") @db.Uuid
  vendor     String?   @db.VarChar(120)
  receivedAt DateTime  @default(now()) @map("received_at") @db.Timestamptz
  notes      String?
  closedAt   DateTime? @map("closed_at") @db.Timestamptz
  createdAt  DateTime  @default(now()) @map("created_at") @db.Timestamptz
  createdBy  Int       @map("created_by")

  tenant    Tenant              @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  movements InventoryMovement[]

  @@index([tenantId, closedAt])
  @@map("receiving_sessions")
}
```

- [ ] **Step 2: Add three back-relations on the `Tenant` model**

Find the `Tenant` model in `web/prisma/schema.prisma` and add these three lines to its relations block (anywhere between the existing relations, e.g. right after `brands Brand[]`):

```prisma
  inventory          Inventory[]
  inventoryMovements InventoryMovement[]
  receivingSessions  ReceivingSession[]
```

- [ ] **Step 3: Create the migration**

Run:
```bash
cd web && npx prisma migrate dev --name add_inventory --create-only
```
Expected: `migrations/<timestamp>_add_inventory/migration.sql` is created. Do NOT apply yet.

- [ ] **Step 4: Append raw SQL to the migration file**

Open `web/prisma/migrations/<timestamp>_add_inventory/migration.sql` and append:

```sql
-- One open session per tenant (partial unique)
CREATE UNIQUE INDEX uniq_active_session_per_tenant
  ON receiving_sessions (tenant_id) WHERE closed_at IS NULL;

-- RLS policies
ALTER TABLE inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE receiving_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_inventory ON inventory
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));
CREATE POLICY tenant_isolation_inventory_movements ON inventory_movements
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));
CREATE POLICY tenant_isolation_receiving_sessions ON receiving_sessions
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));
```

- [ ] **Step 5: Apply the migration**

Run:
```bash
cd web && npx prisma migrate dev
```
Expected: migration applied; Prisma client regenerated.

- [ ] **Step 6: Commit**

```bash
git add web/prisma/schema.prisma web/prisma/migrations/
git commit -m "feat(inventory): add Inventory, InventoryMovement, ReceivingSession models"
```

---

### Task 1.2: Permission keys

**Files:**
- Modify: `web/src/lib/permissions.ts`

- [ ] **Step 1: Add the two new keys to `PERMISSION_KEYS`**

Insert in the `PERMISSION_KEYS` array (e.g. right after `'products.view', 'products.edit',`):

```ts
'inventory.view', 'inventory.write',
```

- [ ] **Step 2: Add to manager + viewer role defaults**

In `ROLE_DEFAULTS.manager`'s array, add: `'inventory.view', 'inventory.write',`
In `ROLE_DEFAULTS.viewer`'s array, add: `'inventory.view',`
(Owner and admin pick these up automatically because they use `PERMISSION_KEYS` directly.)

- [ ] **Step 3: Run typecheck**

```bash
cd web && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/permissions.ts
git commit -m "feat(inventory): add inventory.view + inventory.write permissions"
```

---

### Task 1.3: Shared types module

**Files:**
- Create: `web/src/lib/inventory/types.ts`

- [ ] **Step 1: Write the types file**

```ts
import type { Decimal } from '@prisma/client/runtime/library';

export type EnrichmentStatus = 'basic' | 'enriched' | 'failed';

export interface InventoryItemDTO {
  id: number;
  tenantId: string;
  upc: string;
  brand: string | null;
  title: string | null;
  styleCode: string | null;
  colorCode: string | null;
  colorName: string | null;
  size: string | null;
  retailPrice: string | null;
  salePrice: string | null;
  cost: string | null;
  qty: number;
  notes: string | null;
  enrichmentStatus: EnrichmentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface InventoryStats {
  totalProducts: number;
  totalUnits: number;
}

export interface ReceivingSessionDTO {
  id: number;
  tenantId: string;
  vendor: string | null;
  receivedAt: string;
  notes: string | null;
  closedAt: string | null;
  createdAt: string;
  createdBy: number;
}

export interface MovementDTO {
  id: string;            // BigInt serialized
  inventoryId: number;
  delta: number;
  qtyAfter: number;
  sourceType: string;
  sessionId: number | null;
  note: string | null;
  createdBy: number;
  createdAt: string;
}

export type SourceType = 'scan' | 'voice_create' | 'adjusted' | 'manual_count' | 'bulk';

export function decimalToString(d: Decimal | null): string | null {
  return d == null ? null : d.toString();
}

export function toItemDTO(row: {
  id: number; tenantId: string; upc: string;
  brand: string | null; title: string | null; styleCode: string | null;
  colorCode: string | null; colorName: string | null; size: string | null;
  retailPrice: Decimal | null; salePrice: Decimal | null; cost: Decimal | null;
  qty: number; notes: string | null; enrichmentStatus: string;
  createdAt: Date; updatedAt: Date;
}): InventoryItemDTO {
  return {
    id: row.id,
    tenantId: row.tenantId,
    upc: row.upc,
    brand: row.brand,
    title: row.title,
    styleCode: row.styleCode,
    colorCode: row.colorCode,
    colorName: row.colorName,
    size: row.size,
    retailPrice: decimalToString(row.retailPrice),
    salePrice:   decimalToString(row.salePrice),
    cost:        decimalToString(row.cost),
    qty: row.qty,
    notes: row.notes,
    enrichmentStatus: row.enrichmentStatus as EnrichmentStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/lib/inventory/types.ts
git commit -m "feat(inventory): add shared DTO types + decimal serializer"
```

---

### Task 1.4: GET/POST `/api/inventory` (list + create)

**Files:**
- Create: `web/src/app/api/inventory/route.ts`
- Create: `web/tests/api/inventory/inventory.test.ts`

- [ ] **Step 1: Write the failing test**

`web/tests/api/inventory/inventory.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GET, POST } from '@/app/api/inventory/route';
import { NextRequest } from 'next/server';
import { createTestTenant, authHeaders, cleanupTestData } from '../../helpers/test-tenant';

let ctx: Awaited<ReturnType<typeof createTestTenant>>;

beforeAll(async () => { ctx = await createTestTenant(); });
afterAll(async () => { await cleanupTestData(ctx); });

describe('GET /api/inventory', () => {
  it('lists inventory scoped to tenant with stats', async () => {
    const req = new NextRequest('http://localhost/api/inventory', { headers: authHeaders(ctx) });
    const res = await GET(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.items).toEqual([]);
    expect(body.data.stats).toEqual({ totalProducts: 0, totalUnits: 0 });
    expect(body.data.filters.brands).toEqual([]);
    expect(body.data.total).toBe(0);
  });
});

describe('POST /api/inventory', () => {
  it('creates an item with tenantId scoped from context', async () => {
    const req = new NextRequest('http://localhost/api/inventory', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ upc: '0123456789012', brand: 'Nike', title: 'Air Max', qty: 3 }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.item.upc).toBe('0123456789012');
    expect(body.data.item.qty).toBe(3);
    expect(body.data.item.tenantId).toBe(ctx.tenantId);
  });
});
```

(Test helper `web/tests/helpers/test-tenant.ts` must already exist per the v2 testing conventions; if not present, see Task 1.A in the appendix below.)

- [ ] **Step 2: Run test to verify failure**

```bash
cd web && npx vitest run tests/api/inventory/inventory.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write the route**

`web/src/app/api/inventory/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requirePermission, handleAuthError } from '@/lib/tenant';
import { prisma } from '@/lib/prisma';
import { toItemDTO } from '@/lib/inventory/types';
import type { Prisma } from '@prisma/client';

const VALID_SORT: Record<string, string> = {
  upc: 'upc', brand: 'brand', title: 'title', styleCode: 'styleCode',
  retailPrice: 'retailPrice', qty: 'qty', updatedAt: 'updatedAt', createdAt: 'createdAt',
};

export async function GET(req: NextRequest) {
  try {
    const ctx = await getTenantContext(req);
    requirePermission(ctx, 'inventory.view');

    const sp = req.nextUrl.searchParams;
    const search = sp.get('search')?.trim() || '';
    const brand  = sp.get('brand')?.trim() || '';
    const sortByRaw = sp.get('sortBy') || 'updatedAt';
    const sortBy = VALID_SORT[sortByRaw] || 'updatedAt';
    const sortDir = sp.get('sortDir') === 'asc' ? 'asc' : 'desc';
    const limit  = Math.min(parseInt(sp.get('limit')  || '500', 10) || 500, 1000);
    const offset = Math.max(parseInt(sp.get('offset') || '0', 10) || 0, 0);

    const where: Prisma.InventoryWhereInput = { tenantId: ctx.tenantId };
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { upc:   { contains: search, mode: 'insensitive' } },
        { styleCode: { contains: search, mode: 'insensitive' } },
        { brand: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (brand) where.brand = brand;

    const [items, total, agg, brands] = await Promise.all([
      prisma.inventory.findMany({ where, orderBy: { [sortBy]: sortDir }, take: limit, skip: offset }),
      prisma.inventory.count({ where }),
      prisma.inventory.aggregate({ where: { tenantId: ctx.tenantId }, _sum: { qty: true }, _count: { id: true } }),
      prisma.inventory.findMany({
        where: { tenantId: ctx.tenantId, brand: { not: null } },
        distinct: ['brand'], select: { brand: true }, orderBy: { brand: 'asc' },
      }),
    ]);

    return NextResponse.json({
      success: true,
      data: {
        items: items.map(toItemDTO),
        total,
        stats: { totalProducts: agg._count.id, totalUnits: agg._sum.qty ?? 0 },
        filters: { brands: brands.map(b => b.brand!).filter(Boolean) },
      },
    });
  } catch (e) { return handleAuthError(e); }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getTenantContext(req);
    requirePermission(ctx, 'inventory.write');

    const body = await req.json();
    if (!body.upc || typeof body.upc !== 'string') {
      return NextResponse.json({ success: false, error: 'upc is required' }, { status: 400 });
    }

    const item = await prisma.inventory.create({
      data: {
        tenantId: ctx.tenantId,
        upc: String(body.upc).trim(),
        brand: body.brand ?? null,
        title: body.title ?? null,
        styleCode: body.styleCode ?? null,
        colorCode: body.colorCode ?? null,
        colorName: body.colorName ?? null,
        size: body.size ?? null,
        retailPrice: body.retailPrice != null ? String(body.retailPrice) : null,
        salePrice:   body.salePrice   != null ? String(body.salePrice)   : null,
        cost:        body.cost        != null ? String(body.cost)        : null,
        qty: typeof body.qty === 'number' ? body.qty : 1,
        notes: body.notes ?? null,
        enrichmentStatus: body.enrichmentStatus ?? 'basic',
      },
    });

    return NextResponse.json({ success: true, data: { item: toItemDTO(item) } });
  } catch (e) { return handleAuthError(e); }
}
```

- [ ] **Step 4: Run test to verify pass**

```bash
cd web && npx vitest run tests/api/inventory/inventory.test.ts
```
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/api/inventory/route.ts web/tests/api/inventory/inventory.test.ts
git commit -m "feat(inventory): GET/POST /api/inventory"
```

---

### Task 1.5: PATCH `/api/inventory/:id`

**Files:**
- Create: `web/src/app/api/inventory/[id]/route.ts`
- Modify: `web/tests/api/inventory/inventory.test.ts` (append patch tests)

- [ ] **Step 1: Append failing test**

Append to `inventory.test.ts`:
```ts
import { PATCH } from '@/app/api/inventory/[id]/route';

describe('PATCH /api/inventory/:id', () => {
  it('updates editable fields and ignores tenantId/qty', async () => {
    const created = await prisma.inventory.create({
      data: { tenantId: ctx.tenantId, upc: '9999000000001', qty: 5, brand: 'X' },
    });
    const req = new NextRequest(`http://localhost/api/inventory/${created.id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ brand: 'Adidas', qty: 999, tenantId: 'evil' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: String(created.id) }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.item.brand).toBe('Adidas');
    expect(body.data.item.qty).toBe(5);          // qty is NOT updatable here
    expect(body.data.item.tenantId).toBe(ctx.tenantId);
  });
});
```

- [ ] **Step 2: Run to verify fail**

```bash
cd web && npx vitest run tests/api/inventory/inventory.test.ts -t "PATCH /api/inventory/:id"
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write the route**

`web/src/app/api/inventory/[id]/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requirePermission, handleAuthError } from '@/lib/tenant';
import { prisma } from '@/lib/prisma';
import { toItemDTO } from '@/lib/inventory/types';

const EDITABLE = [
  'brand', 'title', 'styleCode', 'colorCode', 'colorName', 'size',
  'retailPrice', 'salePrice', 'cost', 'notes', 'enrichmentStatus',
] as const;

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getTenantContext(req);
    requirePermission(ctx, 'inventory.write');
    const { id } = await params;
    const itemId = parseInt(id, 10);
    if (!Number.isFinite(itemId)) {
      return NextResponse.json({ success: false, error: 'invalid id' }, { status: 400 });
    }

    const body = await req.json();
    const data: Record<string, unknown> = {};
    for (const k of EDITABLE) {
      if (k in body) {
        if (k === 'retailPrice' || k === 'salePrice' || k === 'cost') {
          data[k] = body[k] == null ? null : String(body[k]);
        } else {
          data[k] = body[k];
        }
      }
    }

    const existing = await prisma.inventory.findFirst({ where: { id: itemId, tenantId: ctx.tenantId } });
    if (!existing) {
      return NextResponse.json({ success: false, error: 'not found' }, { status: 404 });
    }

    const item = await prisma.inventory.update({ where: { id: itemId }, data });
    return NextResponse.json({ success: true, data: { item: toItemDTO(item) } });
  } catch (e) { return handleAuthError(e); }
}
```

- [ ] **Step 4: Run to verify pass**

```bash
cd web && npx vitest run tests/api/inventory/inventory.test.ts
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/api/inventory/[id]/route.ts web/tests/api/inventory/inventory.test.ts
git commit -m "feat(inventory): PATCH /api/inventory/:id"
```

---

### Task 1.6: PATCH `/api/inventory/:id/qty` with movement log

**Files:**
- Create: `web/src/app/api/inventory/[id]/qty/route.ts`
- Modify: `web/tests/api/inventory/inventory.test.ts`

- [ ] **Step 1: Append failing test**

```ts
import { PATCH as PATCH_QTY } from '@/app/api/inventory/[id]/qty/route';

describe('PATCH /api/inventory/:id/qty', () => {
  it('sets qty and logs a movement', async () => {
    const created = await prisma.inventory.create({
      data: { tenantId: ctx.tenantId, upc: '9999000000010', qty: 2 },
    });
    const req = new NextRequest(`http://localhost/api/inventory/${created.id}/qty`, {
      method: 'PATCH',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ qty: 7, sourceType: 'manual_count' }),
    });
    const res = await PATCH_QTY(req, { params: Promise.resolve({ id: String(created.id) }) });
    expect(res.status).toBe(200);
    const updated = await prisma.inventory.findUnique({ where: { id: created.id } });
    expect(updated?.qty).toBe(7);
    const movements = await prisma.inventoryMovement.findMany({ where: { inventoryId: created.id } });
    expect(movements).toHaveLength(1);
    expect(movements[0].delta).toBe(5);
    expect(movements[0].qtyAfter).toBe(7);
    expect(movements[0].sourceType).toBe('manual_count');
  });
});
```

- [ ] **Step 2: Run to fail**

```bash
cd web && npx vitest run tests/api/inventory/inventory.test.ts -t "qty"
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write the route**

`web/src/app/api/inventory/[id]/qty/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requirePermission, handleAuthError } from '@/lib/tenant';
import { prisma } from '@/lib/prisma';

const ALLOWED_SOURCES = new Set(['adjusted', 'manual_count', 'scan', 'voice_create', 'bulk']);

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getTenantContext(req);
    requirePermission(ctx, 'inventory.write');
    const { id } = await params;
    const itemId = parseInt(id, 10);
    if (!Number.isFinite(itemId)) {
      return NextResponse.json({ success: false, error: 'invalid id' }, { status: 400 });
    }

    const { qty, sourceType, sessionId, note } = await req.json();
    if (typeof qty !== 'number' || qty < 0 || !Number.isInteger(qty)) {
      return NextResponse.json({ success: false, error: 'qty must be a non-negative integer' }, { status: 400 });
    }
    const src = ALLOWED_SOURCES.has(sourceType) ? sourceType : 'adjusted';

    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.inventory.findFirst({ where: { id: itemId, tenantId: ctx.tenantId } });
      if (!existing) return null;
      const delta = qty - existing.qty;
      const updated = await tx.inventory.update({ where: { id: itemId }, data: { qty } });
      await tx.inventoryMovement.create({
        data: {
          tenantId: ctx.tenantId,
          inventoryId: itemId,
          delta,
          qtyAfter: qty,
          sourceType: src,
          sessionId: typeof sessionId === 'number' ? sessionId : null,
          note: note ?? null,
          createdBy: ctx.userId,
        },
      });
      return updated;
    });

    if (!result) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (e) { return handleAuthError(e); }
}
```

- [ ] **Step 4: Run to pass**

```bash
cd web && npx vitest run tests/api/inventory/inventory.test.ts -t "qty"
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/api/inventory/[id]/qty/route.ts web/tests/api/inventory/inventory.test.ts
git commit -m "feat(inventory): PATCH /api/inventory/:id/qty + movement log"
```

---

### Task 1.7: POST `/api/inventory/scan` (upsert + bump + movement)

**Files:**
- Create: `web/src/app/api/inventory/scan/route.ts`
- Create: `web/tests/api/inventory/scan.test.ts`

- [ ] **Step 1: Write failing test**

`web/tests/api/inventory/scan.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST } from '@/app/api/inventory/scan/route';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { createTestTenant, authHeaders, cleanupTestData } from '../../helpers/test-tenant';

let ctx: Awaited<ReturnType<typeof createTestTenant>>;
beforeAll(async () => { ctx = await createTestTenant(); });
afterAll(async () => { await cleanupTestData(ctx); });

function scanReq(upc: string, sessionId?: number) {
  return new NextRequest('http://localhost/api/inventory/scan', {
    method: 'POST',
    headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
    body: JSON.stringify({ upc, sessionId }),
  });
}

describe('POST /api/inventory/scan', () => {
  it('creates a stub on first scan with qty=1, isNew=true, and writes a voice_create movement', async () => {
    const res = await POST(scanReq('887700001234'));
    const body = await res.json();
    expect(body.data.isNew).toBe(true);
    expect(body.data.item.qty).toBe(1);
    expect(body.data.item.enrichmentStatus).toBe('basic');
    const movs = await prisma.inventoryMovement.findMany({
      where: { inventoryId: body.data.item.id }, orderBy: { id: 'asc' },
    });
    expect(movs).toHaveLength(1);
    expect(movs[0].sourceType).toBe('voice_create');
    expect(movs[0].delta).toBe(1);
  });

  it('bumps qty on subsequent scans with isNew=false and writes a scan movement', async () => {
    await POST(scanReq('887700001235'));
    const res = await POST(scanReq('887700001235'));
    const body = await res.json();
    expect(body.data.isNew).toBe(false);
    expect(body.data.item.qty).toBe(2);
    const movs = await prisma.inventoryMovement.findMany({
      where: { inventoryId: body.data.item.id }, orderBy: { id: 'asc' },
    });
    expect(movs).toHaveLength(2);
    expect(movs[1].sourceType).toBe('scan');
  });
});
```

- [ ] **Step 2: Run to fail**

```bash
cd web && npx vitest run tests/api/inventory/scan.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write the route**

`web/src/app/api/inventory/scan/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requirePermission, handleAuthError } from '@/lib/tenant';
import { prisma } from '@/lib/prisma';
import { toItemDTO } from '@/lib/inventory/types';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getTenantContext(req);
    requirePermission(ctx, 'inventory.write');

    const { upc, sessionId } = await req.json();
    if (!upc || typeof upc !== 'string') {
      return NextResponse.json({ success: false, error: 'upc required' }, { status: 400 });
    }
    const sId = typeof sessionId === 'number' ? sessionId : null;

    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.inventory.findUnique({
        where: { tenantId_upc: { tenantId: ctx.tenantId, upc } },
      });

      if (!existing) {
        const created = await tx.inventory.create({
          data: { tenantId: ctx.tenantId, upc, qty: 1, enrichmentStatus: 'basic' },
        });
        await tx.inventoryMovement.create({
          data: {
            tenantId: ctx.tenantId, inventoryId: created.id,
            delta: 1, qtyAfter: 1, sourceType: 'voice_create',
            sessionId: sId, createdBy: ctx.userId,
          },
        });
        return { item: created, isNew: true };
      }

      const bumped = await tx.inventory.update({
        where: { id: existing.id }, data: { qty: { increment: 1 } },
      });
      await tx.inventoryMovement.create({
        data: {
          tenantId: ctx.tenantId, inventoryId: bumped.id,
          delta: 1, qtyAfter: bumped.qty, sourceType: 'scan',
          sessionId: sId, createdBy: ctx.userId,
        },
      });
      return { item: bumped, isNew: false };
    });

    return NextResponse.json({
      success: true,
      data: { item: toItemDTO(result.item), isNew: result.isNew },
    });
  } catch (e) { return handleAuthError(e); }
}
```

- [ ] **Step 4: Run to pass**

```bash
cd web && npx vitest run tests/api/inventory/scan.test.ts
```
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/api/inventory/scan/route.ts web/tests/api/inventory/scan.test.ts
git commit -m "feat(inventory): POST /api/inventory/scan with movement log"
```

---

### Task 1.8: GET `/api/inventory/brands`

**Files:**
- Create: `web/src/app/api/inventory/brands/route.ts`

- [ ] **Step 1: Write the route**

`web/src/app/api/inventory/brands/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requirePermission, handleAuthError } from '@/lib/tenant';
import { prisma } from '@/lib/prisma';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getTenantContext(req);
    requirePermission(ctx, 'inventory.view');

    const rows = await prisma.inventory.findMany({
      where: { tenantId: ctx.tenantId, brand: { not: null } },
      distinct: ['brand'], select: { brand: true }, orderBy: { brand: 'asc' },
    });
    return NextResponse.json({
      success: true,
      data: { brands: rows.map(r => r.brand!).filter(Boolean) },
    });
  } catch (e) { return handleAuthError(e); }
}
```

- [ ] **Step 2: Manual smoke (quick curl)**

```bash
cd web && npm run dev &
# in another shell:
curl -s -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Id: $TENANT" http://localhost:3000/api/inventory/brands | jq
```
Expected: `{ success: true, data: { brands: [] } }` (or your seeded brands).

- [ ] **Step 3: Commit**

```bash
git add web/src/app/api/inventory/brands/route.ts
git commit -m "feat(inventory): GET /api/inventory/brands"
```

---

### Task 1.9: POST `/api/inventory/bulk`

**Files:**
- Create: `web/src/app/api/inventory/bulk/route.ts`

- [ ] **Step 1: Write the route**

`web/src/app/api/inventory/bulk/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requirePermission, handleAuthError } from '@/lib/tenant';
import { prisma } from '@/lib/prisma';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getTenantContext(req);
    requirePermission(ctx, 'inventory.write');

    const { ids, action, value } = await req.json();
    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ success: false, error: 'ids required' }, { status: 400 });
    }
    const numericIds = ids.map(Number).filter(Number.isFinite);

    if (action === 'delete') {
      const r = await prisma.inventory.deleteMany({
        where: { id: { in: numericIds }, tenantId: ctx.tenantId },
      });
      return NextResponse.json({ success: true, data: { affected: r.count } });
    }

    if (action === 'set_brand') {
      if (typeof value !== 'string' || !value.trim()) {
        return NextResponse.json({ success: false, error: 'brand value required' }, { status: 400 });
      }
      const r = await prisma.inventory.updateMany({
        where: { id: { in: numericIds }, tenantId: ctx.tenantId },
        data: { brand: value.trim() },
      });
      return NextResponse.json({ success: true, data: { affected: r.count } });
    }

    if (action === 'set_qty') {
      const qty = Number(value);
      if (!Number.isInteger(qty) || qty < 0) {
        return NextResponse.json({ success: false, error: 'qty must be a non-negative integer' }, { status: 400 });
      }
      // Set qty for each row, logging a movement per row, in a single transaction
      const result = await prisma.$transaction(async (tx) => {
        const rows = await tx.inventory.findMany({
          where: { id: { in: numericIds }, tenantId: ctx.tenantId },
          select: { id: true, qty: true },
        });
        for (const r of rows) {
          await tx.inventory.update({ where: { id: r.id }, data: { qty } });
          await tx.inventoryMovement.create({
            data: {
              tenantId: ctx.tenantId, inventoryId: r.id,
              delta: qty - r.qty, qtyAfter: qty, sourceType: 'bulk',
              createdBy: ctx.userId,
            },
          });
        }
        return rows.length;
      });
      return NextResponse.json({ success: true, data: { affected: result } });
    }

    return NextResponse.json({ success: false, error: 'unknown action' }, { status: 400 });
  } catch (e) { return handleAuthError(e); }
}
```

- [ ] **Step 2: Append test cases** to `web/tests/api/inventory/inventory.test.ts` covering each of the three actions (delete / set_brand / set_qty), each with a fresh seed item.

```ts
import { POST as BULK } from '@/app/api/inventory/bulk/route';

describe('POST /api/inventory/bulk', () => {
  it('deletes by ids scoped to tenant', async () => {
    const a = await prisma.inventory.create({ data: { tenantId: ctx.tenantId, upc: 'BLK001', qty: 1 } });
    const req = new NextRequest('http://localhost/api/inventory/bulk', {
      method: 'POST', headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [a.id], action: 'delete' }),
    });
    const res = await BULK(req);
    expect((await res.json()).data.affected).toBe(1);
  });

  it('sets brand', async () => {
    const a = await prisma.inventory.create({ data: { tenantId: ctx.tenantId, upc: 'BLK002', qty: 1 } });
    const req = new NextRequest('http://localhost/api/inventory/bulk', {
      method: 'POST', headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [a.id], action: 'set_brand', value: 'Puma' }),
    });
    expect((await (await BULK(req)).json()).data.affected).toBe(1);
    expect((await prisma.inventory.findUnique({ where: { id: a.id } }))?.brand).toBe('Puma');
  });

  it('sets qty and writes bulk movements', async () => {
    const a = await prisma.inventory.create({ data: { tenantId: ctx.tenantId, upc: 'BLK003', qty: 2 } });
    const req = new NextRequest('http://localhost/api/inventory/bulk', {
      method: 'POST', headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [a.id], action: 'set_qty', value: 5 }),
    });
    expect((await (await BULK(req)).json()).data.affected).toBe(1);
    const movs = await prisma.inventoryMovement.findMany({ where: { inventoryId: a.id } });
    expect(movs.some(m => m.sourceType === 'bulk' && m.qtyAfter === 5)).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests**

```bash
cd web && npx vitest run tests/api/inventory/inventory.test.ts
```
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add web/src/app/api/inventory/bulk/route.ts web/tests/api/inventory/inventory.test.ts
git commit -m "feat(inventory): POST /api/inventory/bulk (delete/set_qty/set_brand)"
```

---

### Task 1.10: GET `/api/inventory/:id/movements`

**Files:**
- Create: `web/src/app/api/inventory/[id]/movements/route.ts`

- [ ] **Step 1: Write the route**

`web/src/app/api/inventory/[id]/movements/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requirePermission, handleAuthError } from '@/lib/tenant';
import { prisma } from '@/lib/prisma';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getTenantContext(req);
    requirePermission(ctx, 'inventory.view');
    const { id } = await params;
    const itemId = parseInt(id, 10);
    if (!Number.isFinite(itemId)) {
      return NextResponse.json({ success: false, error: 'invalid id' }, { status: 400 });
    }
    const sp = req.nextUrl.searchParams;
    const limit  = Math.min(parseInt(sp.get('limit')  || '50', 10) || 50, 200);
    const offset = Math.max(parseInt(sp.get('offset') || '0', 10) || 0, 0);

    const movs = await prisma.inventoryMovement.findMany({
      where: { inventoryId: itemId, tenantId: ctx.tenantId },
      orderBy: { id: 'desc' }, take: limit, skip: offset,
    });
    return NextResponse.json({
      success: true,
      data: {
        movements: movs.map(m => ({
          id: m.id.toString(),
          inventoryId: m.inventoryId,
          delta: m.delta,
          qtyAfter: m.qtyAfter,
          sourceType: m.sourceType,
          sessionId: m.sessionId,
          note: m.note,
          createdBy: m.createdBy,
          createdAt: m.createdAt.toISOString(),
        })),
      },
    });
  } catch (e) { return handleAuthError(e); }
}
```

- [ ] **Step 2: Smoke + commit**

```bash
git add web/src/app/api/inventory/[id]/movements/route.ts
git commit -m "feat(inventory): GET /api/inventory/:id/movements"
```

---

### Task 1.11: Receiving sessions — list + create with 409

**Files:**
- Create: `web/src/app/api/inventory/receipts/route.ts`
- Create: `web/tests/api/inventory/receipts.test.ts`
- Delete: `web/src/app/api/inventory/receipts/[id` and `web/src/app/api/inventory/receipts/]` (malformed stub dirs)

- [ ] **Step 1: Remove the malformed stub dirs**

```bash
cd web && rm -rf "src/app/api/inventory/receipts/[id" "src/app/api/inventory/receipts/]"
```
Expected: no error. (Note the quotes — those literal directory names exist on disk.)

- [ ] **Step 2: Write failing test**

`web/tests/api/inventory/receipts.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GET, POST } from '@/app/api/inventory/receipts/route';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { createTestTenant, authHeaders, cleanupTestData } from '../../helpers/test-tenant';

let ctx: Awaited<ReturnType<typeof createTestTenant>>;
beforeAll(async () => { ctx = await createTestTenant(); });
afterAll(async () => { await cleanupTestData(ctx); });

describe('receiving sessions list', () => {
  it('returns active=null when no open session', async () => {
    const req = new NextRequest('http://localhost/api/inventory/receipts?active=true', { headers: authHeaders(ctx) });
    const body = await (await GET(req)).json();
    expect(body.data.active).toBeNull();
  });
});

describe('receiving sessions create', () => {
  it('starts a session', async () => {
    const req = new NextRequest('http://localhost/api/inventory/receipts', {
      method: 'POST', headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ vendor: 'Acme', notes: 'spring box' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.receipt.vendor).toBe('Acme');
    expect(body.data.receipt.closedAt).toBeNull();
  });

  it('returns 409 with active session payload when one is already open', async () => {
    const req = new NextRequest('http://localhost/api/inventory/receipts', {
      method: 'POST', headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ vendor: 'Other' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.data.active.vendor).toBe('Acme');
  });
});
```

- [ ] **Step 3: Run to fail**

```bash
cd web && npx vitest run tests/api/inventory/receipts.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 4: Write the route**

`web/src/app/api/inventory/receipts/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requirePermission, handleAuthError } from '@/lib/tenant';
import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';

function dto(r: { id: number; tenantId: string; vendor: string | null; receivedAt: Date;
                  notes: string | null; closedAt: Date | null; createdAt: Date; createdBy: number; }) {
  return {
    id: r.id, tenantId: r.tenantId, vendor: r.vendor,
    receivedAt: r.receivedAt.toISOString(),
    notes: r.notes,
    closedAt: r.closedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    createdBy: r.createdBy,
  };
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getTenantContext(req);
    requirePermission(ctx, 'inventory.view');
    const onlyActive = req.nextUrl.searchParams.get('active') === 'true';

    const where: Prisma.ReceivingSessionWhereInput = { tenantId: ctx.tenantId };
    const [active, all] = await Promise.all([
      prisma.receivingSession.findFirst({ where: { ...where, closedAt: null } }),
      onlyActive ? Promise.resolve([]) :
        prisma.receivingSession.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50 }),
    ]);

    return NextResponse.json({
      success: true,
      data: { receipts: all.map(dto), active: active ? dto(active) : null },
    });
  } catch (e) { return handleAuthError(e); }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getTenantContext(req);
    requirePermission(ctx, 'inventory.write');
    const { vendor, receivedAt, notes } = await req.json();

    try {
      const receipt = await prisma.receivingSession.create({
        data: {
          tenantId: ctx.tenantId,
          vendor: vendor ?? null,
          receivedAt: receivedAt ? new Date(receivedAt) : new Date(),
          notes: notes ?? null,
          createdBy: ctx.userId,
        },
      });
      return NextResponse.json({ success: true, data: { receipt: dto(receipt) } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const active = await prisma.receivingSession.findFirst({
          where: { tenantId: ctx.tenantId, closedAt: null },
        });
        return NextResponse.json(
          { success: false, error: 'session already active', data: { active: active ? dto(active) : null } },
          { status: 409 },
        );
      }
      throw e;
    }
  } catch (e) { return handleAuthError(e); }
}
```

- [ ] **Step 5: Run to pass**

```bash
cd web && npx vitest run tests/api/inventory/receipts.test.ts
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add web/src/app/api/inventory/receipts/route.ts web/tests/api/inventory/receipts.test.ts
git rm -r --cached "web/src/app/api/inventory/receipts/[id" "web/src/app/api/inventory/receipts/]" 2>/dev/null || true
git commit -m "feat(inventory): GET/POST /api/inventory/receipts with 409 on conflict"
```

---

### Task 1.12: GET/PATCH `/api/inventory/receipts/:id` (with rows + close)

**Files:**
- Create: `web/src/app/api/inventory/receipts/[id]/route.ts`
- Modify: `web/tests/api/inventory/receipts.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
import { GET as GET_ONE, PATCH } from '@/app/api/inventory/receipts/[id]/route';

describe('receipt detail + close', () => {
  it('returns receipt with stats and queue rows', async () => {
    const r = await prisma.receivingSession.create({
      data: { tenantId: ctx.tenantId, createdBy: 0, vendor: 'V' },
    });
    const inv = await prisma.inventory.create({ data: { tenantId: ctx.tenantId, upc: 'R1', qty: 1 } });
    await prisma.inventoryMovement.create({
      data: { tenantId: ctx.tenantId, inventoryId: inv.id, sessionId: r.id, delta: 1, qtyAfter: 1, sourceType: 'scan', createdBy: 0 },
    });
    const req = new NextRequest(`http://localhost/api/inventory/receipts/${r.id}`, { headers: authHeaders(ctx) });
    const body = await (await GET_ONE(req, { params: Promise.resolve({ id: String(r.id) }) })).json();
    expect(body.data.stats.totalScans).toBe(1);
    expect(body.data.stats.distinctUpcs).toBe(1);
    expect(body.data.stats.rows[0].upc).toBe('R1');
    // close it
    const close = new NextRequest(`http://localhost/api/inventory/receipts/${r.id}`, {
      method: 'PATCH', headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ close: true }),
    });
    const closed = await (await PATCH(close, { params: Promise.resolve({ id: String(r.id) }) })).json();
    expect(closed.data.receipt.closedAt).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to fail**

```bash
cd web && npx vitest run tests/api/inventory/receipts.test.ts -t "detail"
```
Expected: FAIL.

- [ ] **Step 3: Write the route**

`web/src/app/api/inventory/receipts/[id]/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requirePermission, handleAuthError } from '@/lib/tenant';
import { prisma } from '@/lib/prisma';
import { toItemDTO } from '@/lib/inventory/types';

function dto(r: any) {
  return {
    id: r.id, tenantId: r.tenantId, vendor: r.vendor,
    receivedAt: r.receivedAt.toISOString(),
    notes: r.notes,
    closedAt: r.closedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    createdBy: r.createdBy,
  };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getTenantContext(req);
    requirePermission(ctx, 'inventory.view');
    const { id } = await params;
    const sessionId = parseInt(id, 10);

    const receipt = await prisma.receivingSession.findFirst({
      where: { id: sessionId, tenantId: ctx.tenantId },
    });
    if (!receipt) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 });

    // Aggregate per UPC for this session
    const movs = await prisma.inventoryMovement.findMany({
      where: { sessionId, tenantId: ctx.tenantId },
      orderBy: { id: 'asc' },
      include: { inventory: true },
    });

    const totalScans = movs.length;
    const distinctIds = new Set(movs.map(m => m.inventoryId));
    // Latest snapshot per UPC for the queue
    const byUpc = new Map<string, ReturnType<typeof toItemDTO> & { lastScanAt: string }>();
    for (const m of movs) {
      const dtoItem = toItemDTO(m.inventory);
      byUpc.set(dtoItem.upc, { ...dtoItem, lastScanAt: m.createdAt.toISOString() });
    }
    const rows = Array.from(byUpc.values()).sort((a, b) => b.lastScanAt.localeCompare(a.lastScanAt));

    return NextResponse.json({
      success: true,
      data: {
        receipt: dto(receipt),
        stats: { totalScans, distinctUpcs: distinctIds.size, rows },
      },
    });
  } catch (e) { return handleAuthError(e); }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getTenantContext(req);
    requirePermission(ctx, 'inventory.write');
    const { id } = await params;
    const sessionId = parseInt(id, 10);
    const body = await req.json();

    const data: Record<string, unknown> = {};
    if (body.close === true) data.closedAt = new Date();
    if (typeof body.vendor === 'string') data.vendor = body.vendor;
    if (typeof body.notes  === 'string') data.notes  = body.notes;

    const existing = await prisma.receivingSession.findFirst({
      where: { id: sessionId, tenantId: ctx.tenantId },
    });
    if (!existing) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 });

    const receipt = await prisma.receivingSession.update({ where: { id: sessionId }, data });
    return NextResponse.json({ success: true, data: { receipt: dto(receipt) } });
  } catch (e) { return handleAuthError(e); }
}
```

- [ ] **Step 4: Run to pass**

```bash
cd web && npx vitest run tests/api/inventory/receipts.test.ts
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/api/inventory/receipts/[id]/route.ts web/tests/api/inventory/receipts.test.ts
git commit -m "feat(inventory): GET/PATCH /api/inventory/receipts/:id with queue rows"
```

---

## Phase 2 — Voice extraction

### Task 2.1: Voice-extract prompt + lib (OpenAI provider)

**Files:**
- Create: `web/src/lib/inventory/voice-extract-prompt.ts`
- Create: `web/src/lib/inventory/voice-extract.ts`
- Create: `web/src/lib/inventory/voice-extract.test.ts`
- Modify: `web/src/lib/credits.ts`

- [ ] **Step 1: Add credit cost entry**

In `web/src/lib/credits.ts`, find the cost table (search for `gemini-pro`) and add to the `openai` service block:

```ts
'whisper-extract': 2,
```
(Matches Whisper + GPT-4o-mini round-trip cost; tune later.)

- [ ] **Step 2: Write the prompt constant**

`web/src/lib/inventory/voice-extract-prompt.ts`:
```ts
export const VOICE_EXTRACT_PROMPT = `You are reading a clothing/footwear hang tag from an audio transcription.
The transcription may be noisy or partial. Extract ONLY what is explicitly said.

Return JSON conforming to this schema:
{
  "fields": {
    "upc"?: string,
    "brand"?: string,
    "title"?: string,
    "styleCode"?: string,
    "colorCode"?: string,
    "colorName"?: string,
    "size"?: string,
    "retailPrice"?: number,
    "salePrice"?: number,
    "cost"?: number
  },
  "confidence": {
    "<fieldName>": number   // 0..1 for each field present in "fields"
  }
}

Rules:
- Do NOT invent values. If the transcription doesn't clearly mention a field, omit it.
- Style codes are alphanumeric (e.g. "DV3505-100"); preserve hyphens.
- Sizes: keep as spoken ("10", "10.5", "M", "L/XL").
- Prices: numeric only (no $ sign). If "retail" not specified, treat any single price as retail.
- Confidence reflects how clearly the field was stated, not how plausible it sounds.

Transcription:
"""
{TRANSCRIPTION}
"""

Return only valid JSON.`;
```

- [ ] **Step 3: Write the extractor lib**

`web/src/lib/inventory/voice-extract.ts`:
```ts
import OpenAI from 'openai';
import { VOICE_EXTRACT_PROMPT } from './voice-extract-prompt';

export interface ExtractedFields {
  upc?: string;
  brand?: string;
  title?: string;
  styleCode?: string;
  colorCode?: string;
  colorName?: string;
  size?: string;
  retailPrice?: number;
  salePrice?: number;
  cost?: number;
}

export interface ExtractResult {
  transcription: string;
  fields: ExtractedFields;
  confidence: Partial<Record<keyof ExtractedFields, number>>;
}

const TRANSCRIBE_MODEL = 'whisper-1';
const EXTRACT_MODEL = 'gpt-4o-mini';

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

export async function extractFromAudio(
  audio: Blob | File | Buffer,
  filename = 'tag.webm',
): Promise<ExtractResult> {
  // 1. Transcribe
  const file = audio instanceof Blob || audio instanceof File
    ? audio
    : new Blob([audio as Uint8Array], { type: 'audio/webm' });
  const audioFile = new File([file], filename, { type: (file as Blob).type || 'audio/webm' });

  const transcription = await client().audio.transcriptions.create({
    file: audioFile, model: TRANSCRIBE_MODEL,
  });
  const text = (transcription.text || '').trim();
  if (!text) {
    return { transcription: '', fields: {}, confidence: {} };
  }

  // 2. Structured extraction
  const prompt = VOICE_EXTRACT_PROMPT.replace('{TRANSCRIPTION}', text);
  const completion = await client().chat.completions.create({
    model: EXTRACT_MODEL,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
  });

  const raw = completion.choices[0]?.message?.content || '{}';
  let parsed: { fields?: Record<string, unknown>; confidence?: Record<string, number> };
  try { parsed = JSON.parse(raw); } catch { parsed = {}; }

  const fields = normalizeFields(parsed.fields || {});
  const confidence: Partial<Record<keyof ExtractedFields, number>> = {};
  if (parsed.confidence) {
    for (const [k, v] of Object.entries(parsed.confidence)) {
      if (typeof v === 'number' && v >= 0 && v <= 1) {
        confidence[k as keyof ExtractedFields] = v;
      }
    }
  }

  return { transcription: text, fields, confidence };
}

function normalizeFields(raw: Record<string, unknown>): ExtractedFields {
  const out: ExtractedFields = {};
  const strKeys: Array<keyof ExtractedFields> = ['upc', 'brand', 'title', 'styleCode', 'colorCode', 'colorName', 'size'];
  const numKeys: Array<keyof ExtractedFields> = ['retailPrice', 'salePrice', 'cost'];
  for (const k of strKeys) {
    const v = raw[k];
    if (typeof v === 'string' && v.trim()) (out as any)[k] = v.trim();
  }
  for (const k of numKeys) {
    const v = raw[k];
    const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
    if (Number.isFinite(n) && n >= 0) (out as any)[k] = n;
  }
  return out;
}
```

- [ ] **Step 4: Write unit test for `normalizeFields`**

`web/src/lib/inventory/voice-extract.test.ts`:
```ts
import { describe, it, expect } from 'vitest';

// Pull internal helper via a re-export for tests
// (Add `export { normalizeFields }` at the bottom of voice-extract.ts before running these tests.)
import { normalizeFields } from './voice-extract';

describe('normalizeFields', () => {
  it('keeps string fields, drops empties, coerces price strings', () => {
    const out = normalizeFields({
      brand: 'Nike ', title: '', size: 'M', retailPrice: '120.00', salePrice: -5, cost: 'x',
    });
    expect(out).toEqual({ brand: 'Nike', size: 'M', retailPrice: 120 });
  });

  it('ignores unknown keys', () => {
    const out = normalizeFields({ foo: 'bar', styleCode: 'DV3505' });
    expect(out).toEqual({ styleCode: 'DV3505' });
  });
});
```

Then add `export { normalizeFields };` to the bottom of `voice-extract.ts` so the test can import it.

- [ ] **Step 5: Run tests**

```bash
cd web && npx vitest run src/lib/inventory/voice-extract.test.ts
```
Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/inventory/ web/src/lib/credits.ts
git commit -m "feat(inventory): voice-extract lib (OpenAI Whisper + GPT-4o-mini)"
```

---

### Task 2.2: POST `/api/inventory/voice-extract` (multipart)

**Files:**
- Create: `web/src/app/api/inventory/voice-extract/route.ts`
- Create: `web/tests/api/inventory/voice-extract.test.ts`

- [ ] **Step 1: Write failing test (mocks OpenAI)**

`web/tests/api/inventory/voice-extract.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@/lib/inventory/voice-extract', () => ({
  extractFromAudio: vi.fn(async () => ({
    transcription: 'Nike Air Max size 10 retail 145',
    fields: { brand: 'Nike', title: 'Air Max', size: '10', retailPrice: 145 },
    confidence: { brand: 0.95, title: 0.9, size: 0.8, retailPrice: 0.85 },
  })),
}));

import { POST } from '@/app/api/inventory/voice-extract/route';
import { NextRequest } from 'next/server';
import { createTestTenant, authHeaders, cleanupTestData } from '../../helpers/test-tenant';

let ctx: Awaited<ReturnType<typeof createTestTenant>>;
beforeAll(async () => { ctx = await createTestTenant(); });
afterAll(async () => { await cleanupTestData(ctx); });

describe('POST /api/inventory/voice-extract', () => {
  it('returns fields + confidence and deducts a credit', async () => {
    const fd = new FormData();
    fd.append('audio', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }), 'tag.webm');
    const req = new NextRequest('http://localhost/api/inventory/voice-extract', {
      method: 'POST', headers: authHeaders(ctx), body: fd,
    });
    const res = await POST(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.fields.brand).toBe('Nike');
    expect(body.data.confidence.brand).toBeCloseTo(0.95);
  });
});
```

- [ ] **Step 2: Run to fail**

```bash
cd web && npx vitest run tests/api/inventory/voice-extract.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write the route**

`web/src/app/api/inventory/voice-extract/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requirePermission, handleAuthError } from '@/lib/tenant';
import { checkCredits, deductCredits } from '@/lib/credits';
import { extractFromAudio } from '@/lib/inventory/voice-extract';

const SERVICE = 'openai';
const ENDPOINT = 'whisper-extract';
const MAX_BYTES = 2 * 1024 * 1024; // 2MB ~ 12s of opus

export async function POST(req: NextRequest) {
  try {
    const ctx = await getTenantContext(req);
    requirePermission(ctx, 'inventory.write');

    const credits = await checkCredits(ctx.tenantId, SERVICE, ENDPOINT);
    if (!credits.allowed) {
      return NextResponse.json(
        { success: false, error: 'insufficient credits', data: { remaining: credits.remaining } },
        { status: 402 },
      );
    }

    const form = await req.formData();
    const audio = form.get('audio');
    if (!(audio instanceof File || audio instanceof Blob)) {
      return NextResponse.json({ success: false, error: 'audio file required' }, { status: 400 });
    }
    if ((audio as Blob).size > MAX_BYTES) {
      return NextResponse.json({ success: false, error: 'audio too large' }, { status: 413 });
    }
    const upc = form.get('upc');
    const upcStr = typeof upc === 'string' ? upc : undefined;

    const result = await extractFromAudio(audio as Blob);

    // Deduct only on a "real" extraction (had a transcription).
    if (result.transcription) {
      await deductCredits(ctx.tenantId, ctx.userId, SERVICE, ENDPOINT, { upc: upcStr });
    }

    return NextResponse.json({ success: true, data: result });
  } catch (e) { return handleAuthError(e); }
}
```

- [ ] **Step 4: Run to pass**

```bash
cd web && npx vitest run tests/api/inventory/voice-extract.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/api/inventory/voice-extract web/tests/api/inventory/voice-extract.test.ts
git commit -m "feat(inventory): POST /api/inventory/voice-extract (multipart, credit-deducting)"
```

---

## Phase 3 — Desktop capture queue UI

### Task 3.1: `useCaptureQueue` hook

**Files:**
- Create: `desktop/src/hooks/useCaptureQueue.ts`
- Create: `desktop/src/hooks/useCaptureQueue.test.ts`

- [ ] **Step 1: Write failing tests**

`desktop/src/hooks/useCaptureQueue.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { reduce, initialState, type QueueAction } from './useCaptureQueue';

describe('useCaptureQueue reducer', () => {
  it('adds a new row on scan', () => {
    const s = reduce(initialState, { type: 'scanned', upc: '111', item: null });
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].upc).toBe('111');
    expect(s.rows[0].status).toBe('new');
  });

  it('bumps qty when scanning an existing upc', () => {
    let s = reduce(initialState, { type: 'scanned', upc: '111', item: { id: 1, qty: 1 } as any });
    s = reduce(s, { type: 'scanned', upc: '111', item: { id: 1, qty: 2 } as any });
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].qty).toBe(2);
    expect(s.rows[0].status).toBe('known');
  });

  it('applies AI fields with confidence and sets unconfirmed cells', () => {
    let s = reduce(initialState, { type: 'scanned', upc: '222', item: null });
    s = reduce(s, {
      type: 'ai_filled',
      upc: '222',
      fields: { brand: 'Nike', title: 'Air' },
      confidence: { brand: 0.9, title: 0.5 },
    });
    const r = s.rows[0];
    expect(r.brand).toBe('Nike');
    expect(r.unconfirmed.has('brand')).toBe(true);
    expect(r.lowConfidence.has('title')).toBe(true);
  });

  it('removeFromQueue drops the row', () => {
    let s = reduce(initialState, { type: 'scanned', upc: '333', item: null });
    s = reduce(s, { type: 'remove', upc: '333' });
    expect(s.rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to fail**

```bash
cd desktop && npx vitest run src/hooks/useCaptureQueue.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write the hook + reducer**

`desktop/src/hooks/useCaptureQueue.ts`:
```ts
import { useCallback, useEffect, useReducer } from 'react';
import { apiClient } from '../lib/apiClient';
import type { InventoryItem } from './useInventory';

export type RowStatus = 'new' | 'enriching' | 'known' | 'failed';
export type Field = 'brand' | 'title' | 'styleCode' | 'colorCode' | 'colorName' | 'size' | 'retailPrice' | 'salePrice' | 'cost';

export interface QueueRow extends Partial<InventoryItem> {
  id?: number;
  upc: string;
  qty: number;
  status: RowStatus;
  unconfirmed: Set<Field>;
  lowConfidence: Set<Field>;
  lastScanAt: number;
}

interface State {
  rows: QueueRow[];
}

export const initialState: State = { rows: [] };

export type QueueAction =
  | { type: 'scanned'; upc: string; item: InventoryItem | null }
  | { type: 'recording'; upc: string }
  | { type: 'enriching'; upc: string }
  | { type: 'ai_filled'; upc: string; fields: Partial<Record<Field, string | number>>; confidence: Partial<Record<Field, number>> }
  | { type: 'ai_failed'; upc: string }
  | { type: 'edit'; upc: string; field: Field; value: string | number | null }
  | { type: 'confirm_cell'; upc: string; field: Field }
  | { type: 'accept_row'; upc: string }
  | { type: 'remove'; upc: string }
  | { type: 'hydrate'; rows: QueueRow[] }
  | { type: 'set_qty'; upc: string; qty: number }
  | { type: 'clear' };

const LOW_CONFIDENCE_THRESHOLD = 0.6;

export function reduce(state: State, a: QueueAction): State {
  switch (a.type) {
    case 'scanned': {
      const idx = state.rows.findIndex(r => r.upc === a.upc);
      if (idx >= 0) {
        const row = state.rows[idx];
        const next: QueueRow = {
          ...row,
          ...(a.item ?? {}),
          qty: a.item?.qty ?? row.qty + 1,
          status: a.item ? 'known' : row.status,
          lastScanAt: Date.now(),
        };
        const rows = [...state.rows]; rows[idx] = next;
        return { rows };
      }
      const fresh: QueueRow = {
        ...(a.item ?? {}),
        upc: a.upc,
        qty: a.item?.qty ?? 1,
        status: a.item ? 'known' : 'new',
        unconfirmed: new Set(),
        lowConfidence: new Set(),
        lastScanAt: Date.now(),
      };
      return { rows: [fresh, ...state.rows] };
    }
    case 'recording':
    case 'enriching': {
      return mapRow(state, a.upc, r => ({ ...r, status: a.type === 'recording' ? r.status : 'enriching' }));
    }
    case 'ai_filled': {
      return mapRow(state, a.upc, r => {
        const unconfirmed = new Set(r.unconfirmed);
        const lowConfidence = new Set(r.lowConfidence);
        const merged: Partial<QueueRow> = {};
        for (const [field, value] of Object.entries(a.fields)) {
          const f = field as Field;
          if (value == null || value === '') continue;
          merged[f] = value as never;
          unconfirmed.add(f);
          const c = a.confidence[f];
          if (typeof c === 'number' && c < LOW_CONFIDENCE_THRESHOLD) lowConfidence.add(f);
        }
        return { ...r, ...merged, status: 'known', unconfirmed, lowConfidence };
      });
    }
    case 'ai_failed': {
      return mapRow(state, a.upc, r => ({ ...r, status: 'failed' }));
    }
    case 'edit': {
      return mapRow(state, a.upc, r => {
        const unconfirmed = new Set(r.unconfirmed); unconfirmed.delete(a.field);
        const lowConfidence = new Set(r.lowConfidence); lowConfidence.delete(a.field);
        return { ...r, [a.field]: a.value as never, unconfirmed, lowConfidence };
      });
    }
    case 'confirm_cell': {
      return mapRow(state, a.upc, r => {
        const unconfirmed = new Set(r.unconfirmed); unconfirmed.delete(a.field);
        const lowConfidence = new Set(r.lowConfidence); lowConfidence.delete(a.field);
        return { ...r, unconfirmed, lowConfidence };
      });
    }
    case 'accept_row': {
      return mapRow(state, a.upc, r => ({ ...r, unconfirmed: new Set(), lowConfidence: new Set() }));
    }
    case 'set_qty': {
      return mapRow(state, a.upc, r => ({ ...r, qty: a.qty }));
    }
    case 'remove': {
      return { rows: state.rows.filter(r => r.upc !== a.upc) };
    }
    case 'hydrate': {
      return { rows: a.rows };
    }
    case 'clear': return initialState;
  }
}

function mapRow(state: State, upc: string, f: (r: QueueRow) => QueueRow): State {
  const idx = state.rows.findIndex(r => r.upc === upc);
  if (idx < 0) return state;
  const rows = [...state.rows]; rows[idx] = f(rows[idx]);
  return { rows };
}

export function useCaptureQueue(sessionId: number | null) {
  const [state, dispatch] = useReducer(reduce, initialState);

  // Hydrate from server when a session becomes active
  useEffect(() => {
    if (!sessionId) { dispatch({ type: 'clear' }); return; }
    let cancelled = false;
    (async () => {
      const r = await apiClient.get<{ success: boolean; data?: { stats: { rows: any[] } } }>(
        `/api/inventory/receipts/${sessionId}`,
      );
      if (cancelled || !r.success || !r.data) return;
      const rows: QueueRow[] = (r.data.stats.rows || []).map(row => ({
        ...row,
        status: row.enrichmentStatus === 'enriched' ? 'known' : row.enrichmentStatus === 'failed' ? 'failed' : 'known',
        unconfirmed: new Set(),
        lowConfidence: new Set(),
        lastScanAt: Date.parse(row.lastScanAt ?? row.updatedAt ?? Date.now()),
      }));
      dispatch({ type: 'hydrate', rows });
    })();
    return () => { cancelled = true; };
  }, [sessionId]);

  const scanned = useCallback((upc: string, item: InventoryItem | null) => {
    dispatch({ type: 'scanned', upc, item });
  }, []);

  return { rows: state.rows, dispatch, scanned };
}
```

- [ ] **Step 4: Run to pass**

```bash
cd desktop && npx vitest run src/hooks/useCaptureQueue.test.ts
```
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/hooks/useCaptureQueue.ts desktop/src/hooks/useCaptureQueue.test.ts
git commit -m "feat(inventory): useCaptureQueue reducer + hydration"
```

---

### Task 3.2: `useVoiceQueue` hook (FIFO mic, parallel extract)

**Files:**
- Create: `desktop/src/hooks/useVoiceQueue.ts`
- Create: `desktop/src/hooks/useVoiceQueue.test.ts`

- [ ] **Step 1: Write failing tests**

`desktop/src/hooks/useVoiceQueue.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { makeFifoQueue } from './useVoiceQueue';

describe('FIFO mic queue', () => {
  it('records one at a time and extracts in parallel up to cap', async () => {
    const events: string[] = [];
    const record = vi.fn(async (upc: string) => {
      events.push(`rec-start:${upc}`);
      await new Promise(r => setTimeout(r, 10));
      events.push(`rec-stop:${upc}`);
      return new Blob([upc]);
    });
    const extract = vi.fn(async (upc: string) => {
      events.push(`ext-start:${upc}`);
      await new Promise(r => setTimeout(r, 50));
      events.push(`ext-stop:${upc}`);
      return { fields: {}, confidence: {} };
    });
    const q = makeFifoQueue({ record, extract, extractConcurrency: 3 });

    q.enqueue('A'); q.enqueue('B'); q.enqueue('C');
    await q.idle();

    const recIdx = (s: string) => events.indexOf(s);
    // recording is serial: B can't start before A stops
    expect(recIdx('rec-start:B')).toBeGreaterThan(recIdx('rec-stop:A'));
    // extraction is parallel: B's extract can start before A's stops
    expect(recIdx('ext-start:B')).toBeLessThan(recIdx('ext-stop:A'));
  });
});
```

- [ ] **Step 2: Run to fail**

```bash
cd desktop && npx vitest run src/hooks/useVoiceQueue.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write the hook**

`desktop/src/hooks/useVoiceQueue.ts`:
```ts
import { useCallback, useEffect, useRef } from 'react';

interface ExtractResult {
  fields: Record<string, unknown>;
  confidence: Record<string, number>;
}

interface QueueDeps {
  record: (upc: string) => Promise<Blob | null>;
  extract: (upc: string, audio: Blob) => Promise<ExtractResult | null>;
  extractConcurrency?: number;
  onRecordingStart?: (upc: string) => void;
  onEnriching?: (upc: string) => void;
  onResult?: (upc: string, result: ExtractResult) => void;
  onFailed?: (upc: string) => void;
}

export function makeFifoQueue(deps: QueueDeps) {
  const cap = deps.extractConcurrency ?? 3;
  const recQueue: string[] = [];
  let recording = false;
  let inFlightExtractions = 0;
  const pendingExtractions: Array<() => Promise<void>> = [];
  let idleResolvers: Array<() => void> = [];

  function maybeIdle() {
    if (!recording && recQueue.length === 0 && inFlightExtractions === 0 && pendingExtractions.length === 0) {
      for (const r of idleResolvers) r();
      idleResolvers = [];
    }
  }

  async function pumpExtract() {
    while (inFlightExtractions < cap && pendingExtractions.length > 0) {
      const job = pendingExtractions.shift()!;
      inFlightExtractions++;
      job().finally(() => { inFlightExtractions--; pumpExtract(); maybeIdle(); });
    }
  }

  async function pumpRecord() {
    if (recording || recQueue.length === 0) return;
    recording = true;
    const upc = recQueue.shift()!;
    deps.onRecordingStart?.(upc);
    try {
      const audio = await deps.record(upc);
      if (audio) {
        deps.onEnriching?.(upc);
        pendingExtractions.push(async () => {
          const result = await deps.extract(upc, audio);
          if (result) deps.onResult?.(upc, result); else deps.onFailed?.(upc);
        });
        pumpExtract();
      } else {
        deps.onFailed?.(upc);
      }
    } finally {
      recording = false;
      // Allow re-entry
      setTimeout(() => { pumpRecord(); maybeIdle(); }, 0);
    }
  }

  return {
    enqueue(upc: string) { recQueue.push(upc); pumpRecord(); },
    cancelCurrent() { /* tied to MediaRecorder.stop() at the caller */ },
    idle(): Promise<void> {
      return new Promise(res => { idleResolvers.push(res); maybeIdle(); });
    },
  };
}

// React hook wrapper — wires the FIFO queue to dispatchers from useCaptureQueue.
export function useVoiceQueue(deps: QueueDeps) {
  const ref = useRef(makeFifoQueue(deps));
  useEffect(() => { /* deps are stable for life of session */ }, []);
  const enqueue = useCallback((upc: string) => ref.current.enqueue(upc), []);
  return { enqueue };
}
```

- [ ] **Step 4: Run to pass**

```bash
cd desktop && npx vitest run src/hooks/useVoiceQueue.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/hooks/useVoiceQueue.ts desktop/src/hooks/useVoiceQueue.test.ts
git commit -m "feat(inventory): useVoiceQueue FIFO mic + parallel extract"
```

---

### Task 3.3: `ConfidenceUnderline` shared component

**Files:**
- Create: `desktop/src/components/inventory/ConfidenceUnderline.tsx`

- [ ] **Step 1: Write the component**

```tsx
interface Props {
  unconfirmed?: boolean;
  lowConfidence?: boolean;
  children: React.ReactNode;
}

export function ConfidenceUnderline({ unconfirmed, lowConfidence, children }: Props) {
  const cls = lowConfidence
    ? 'border-b-2 border-amber-400/70'
    : unconfirmed
      ? 'border-b border-violet-400/70'
      : '';
  return <span className={cls}>{children}</span>;
}
```

- [ ] **Step 2: Commit**

```bash
git add desktop/src/components/inventory/ConfidenceUnderline.tsx
git commit -m "feat(inventory): ConfidenceUnderline shared component"
```

---

### Task 3.4: `CaptureRow` component (inline-editable, ⋯ menu)

**Files:**
- Create: `desktop/src/components/inventory/CaptureRow.tsx`

- [ ] **Step 1: Write the component**

```tsx
import { useState } from 'react';
import { Loader2, Mic, AlertTriangle, CheckCircle, MoreVertical, Trash2 } from 'lucide-react';
import { ConfidenceUnderline } from './ConfidenceUnderline';
import type { QueueRow, Field } from '../../hooks/useCaptureQueue';

interface Props {
  row: QueueRow;
  onEdit: (field: Field, value: string | number | null) => void;
  onConfirmCell: (field: Field) => void;
  onAcceptRow: () => void;
  onRemove: () => void;
  onRemic: () => void;
  onOpenDetails: () => void;
  onBumpQty: (delta: number) => void;
  onSetQty: (qty: number) => void;
}

type TextField = Extract<Field, 'brand' | 'title' | 'styleCode' | 'colorCode' | 'colorName' | 'size'>;
type NumField  = Extract<Field, 'retailPrice' | 'salePrice' | 'cost'>;

export function CaptureRow({ row, onEdit, onConfirmCell, onAcceptRow, onRemove, onRemic, onOpenDetails, onBumpQty, onSetQty }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);

  const statusDot = (() => {
    switch (row.status) {
      case 'new':       return <Mic className="w-3.5 h-3.5 text-amber-400 animate-pulse" />;
      case 'enriching': return <Loader2 className="w-3.5 h-3.5 text-violet-400 animate-spin" />;
      case 'failed':    return <AlertTriangle className="w-3.5 h-3.5 text-danger" />;
      case 'known':     return <CheckCircle className="w-3.5 h-3.5 text-success" />;
    }
  })();

  const leftBorder =
    row.status === 'new'       ? 'border-l-4 border-amber-400' :
    row.status === 'enriching' ? 'border-l-4 border-violet-400' :
    'border-l-4 border-transparent';

  return (
    <tr className={`${leftBorder} text-sm`}>
      <td className="px-2 py-1.5 w-6">{statusDot}</td>
      <td className="px-2 py-1.5 font-mono text-xs text-text-secondary w-[110px]">{row.upc}</td>
      <Cell value={row.brand     ?? ''} field="brand"     row={row} onEdit={onEdit} onConfirm={onConfirmCell} />
      <Cell value={row.title     ?? ''} field="title"     row={row} onEdit={onEdit} onConfirm={onConfirmCell} flex />
      <Cell value={row.styleCode ?? ''} field="styleCode" row={row} onEdit={onEdit} onConfirm={onConfirmCell} mono />
      <Cell value={row.colorName ?? ''} field="colorName" row={row} onEdit={onEdit} onConfirm={onConfirmCell} />
      <Cell value={row.size      ?? ''} field="size"      row={row} onEdit={onEdit} onConfirm={onConfirmCell} />
      <NumCell value={row.retailPrice as number | null} field="retailPrice" row={row} onEdit={onEdit} onConfirm={onConfirmCell} />
      <NumCell value={row.cost        as number | null} field="cost"        row={row} onEdit={onEdit} onConfirm={onConfirmCell} />
      <td className="px-2 py-1.5 text-center w-[60px]">
        <div className="flex items-center justify-center gap-1">
          <button onClick={() => onBumpQty(-1)} className="px-1.5 text-text-tertiary hover:text-text-primary">−</button>
          <input
            value={row.qty}
            onChange={e => onSetQty(parseInt(e.target.value, 10) || 0)}
            className="w-10 text-center bg-bg-tertiary rounded text-xs"
          />
          <button onClick={() => onBumpQty(+1)} className="px-1.5 text-text-tertiary hover:text-text-primary">+</button>
        </div>
      </td>
      <td className="px-2 py-1.5 w-8 relative">
        <button onClick={() => setMenuOpen(v => !v)} className="p-1 rounded hover:bg-bg-tertiary">
          <MoreVertical className="w-3.5 h-3.5 text-text-tertiary" />
        </button>
        {menuOpen && (
          <div className="absolute right-0 mt-1 bg-bg-secondary border border-border-subtle rounded-lg shadow-lg z-10 min-w-[160px]">
            <button onClick={() => { setMenuOpen(false); onRemic(); }} className="block w-full text-left px-3 py-1.5 text-xs hover:bg-bg-tertiary">Re-mic</button>
            <button onClick={() => { setMenuOpen(false); onAcceptRow(); }} className="block w-full text-left px-3 py-1.5 text-xs hover:bg-bg-tertiary">Accept all AI fields</button>
            <button onClick={() => { setMenuOpen(false); onOpenDetails(); }} className="block w-full text-left px-3 py-1.5 text-xs hover:bg-bg-tertiary">Open full details</button>
            <button onClick={() => { setMenuOpen(false); onRemove(); }} className="block w-full text-left px-3 py-1.5 text-xs text-danger hover:bg-bg-tertiary"><Trash2 className="inline w-3 h-3 mr-1" />Remove from queue</button>
          </div>
        )}
      </td>
    </tr>
  );
}

function Cell({ value, field, row, onEdit, onConfirm, flex, mono }: {
  value: string; field: TextField; row: QueueRow;
  onEdit: (f: Field, v: string | number | null) => void;
  onConfirm: (f: Field) => void;
  flex?: boolean; mono?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  if (!editing) {
    return (
      <td className={`px-2 py-1.5 ${flex ? '' : 'w-[120px]'}`} onClick={() => { setDraft(value); setEditing(true); }}>
        <ConfidenceUnderline unconfirmed={row.unconfirmed.has(field)} lowConfidence={row.lowConfidence.has(field)}>
          <span className={mono ? 'font-mono text-xs' : ''}>{value || <span className="text-text-tertiary">—</span>}</span>
        </ConfidenceUnderline>
      </td>
    );
  }
  return (
    <td className={`px-2 py-1.5 ${flex ? '' : 'w-[120px]'}`}>
      <input
        autoFocus value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => { setEditing(false); if (draft !== value) onEdit(field, draft || null); else onConfirm(field); }}
        onKeyDown={e => {
          if (e.key === 'Enter') { setEditing(false); onEdit(field, draft || null); }
          if (e.key === 'Escape') { setEditing(false); }
        }}
        className={`w-full bg-bg-tertiary border border-violet-500 rounded px-1.5 py-0.5 text-xs outline-none ${mono ? 'font-mono' : ''}`}
      />
    </td>
  );
}

function NumCell({ value, field, row, onEdit, onConfirm }: {
  value: number | null; field: NumField; row: QueueRow;
  onEdit: (f: Field, v: string | number | null) => void;
  onConfirm: (f: Field) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value != null ? String(value) : '');
  if (!editing) {
    return (
      <td className="px-2 py-1.5 text-right w-[80px]" onClick={() => { setDraft(value != null ? String(value) : ''); setEditing(true); }}>
        <ConfidenceUnderline unconfirmed={row.unconfirmed.has(field)} lowConfidence={row.lowConfidence.has(field)}>
          {value != null ? `$${value}` : <span className="text-text-tertiary">—</span>}
        </ConfidenceUnderline>
      </td>
    );
  }
  return (
    <td className="px-2 py-1.5 text-right w-[80px]">
      <input
        autoFocus type="number" step="0.01" value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          const n = parseFloat(draft);
          if (Number.isFinite(n)) onEdit(field, n);
          else if (draft === '') onEdit(field, null);
          else onConfirm(field);
        }}
        onKeyDown={e => {
          if (e.key === 'Enter') { setEditing(false); const n = parseFloat(draft); onEdit(field, Number.isFinite(n) ? n : null); }
          if (e.key === 'Escape') setEditing(false);
        }}
        className="w-full bg-bg-tertiary border border-violet-500 rounded px-1.5 py-0.5 text-xs text-right outline-none"
      />
    </td>
  );
}
```

- [ ] **Step 2: Manual smoke (typecheck only)**

```bash
cd desktop && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add desktop/src/components/inventory/CaptureRow.tsx
git commit -m "feat(inventory): CaptureRow component with inline cell editing"
```

---

### Task 3.5: `CaptureQueue` component (assembles rows) + wire into `Inventory.tsx`

**Files:**
- Create: `desktop/src/components/inventory/CaptureQueue.tsx`
- Modify: `desktop/src/pages/Inventory.tsx`

- [ ] **Step 1: Write `CaptureQueue.tsx`**

```tsx
import { CaptureRow } from './CaptureRow';
import type { QueueRow, Field } from '../../hooks/useCaptureQueue';

interface Props {
  rows: QueueRow[];
  onEdit: (upc: string, field: Field, value: string | number | null) => void;
  onConfirmCell: (upc: string, field: Field) => void;
  onAcceptRow: (upc: string) => void;
  onRemove: (upc: string) => void;
  onRemic: (upc: string) => void;
  onOpenDetails: (upc: string) => void;
  onBumpQty: (upc: string, delta: number) => void;
  onSetQty: (upc: string, qty: number) => void;
}

export function CaptureQueue(props: Props) {
  if (props.rows.length === 0) return null;
  return (
    <div className="bg-bg-secondary border border-border-subtle rounded-lg overflow-hidden">
      <div className="px-3 py-1.5 border-b border-border-subtle flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Capture Queue · {props.rows.length}</span>
      </div>
      <table className="w-full">
        <thead className="bg-bg-tertiary/30">
          <tr className="text-[10px] uppercase tracking-wide text-text-tertiary">
            <th></th><th className="text-left px-2 py-1">UPC</th><th className="text-left px-2">Brand</th>
            <th className="text-left px-2">Title</th><th className="text-left px-2">Style</th>
            <th className="text-left px-2">Color</th><th className="text-left px-2">Size</th>
            <th className="text-right px-2">Retail</th><th className="text-right px-2">Cost</th>
            <th className="text-center px-2">Qty</th><th></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {props.rows.map(row => (
            <CaptureRow
              key={row.upc} row={row}
              onEdit={(f, v) => props.onEdit(row.upc, f, v)}
              onConfirmCell={(f) => props.onConfirmCell(row.upc, f)}
              onAcceptRow={() => props.onAcceptRow(row.upc)}
              onRemove={() => props.onRemove(row.upc)}
              onRemic={() => props.onRemic(row.upc)}
              onOpenDetails={() => props.onOpenDetails(row.upc)}
              onBumpQty={(d) => props.onBumpQty(row.upc, d)}
              onSetQty={(q) => props.onSetQty(row.upc, q)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Modify `Inventory.tsx` to render the queue and wire dispatchers**

Insert near the top of `Inventory()` after the existing hooks (around line 35):

```tsx
import { CaptureQueue } from '../components/inventory/CaptureQueue';
import { useCaptureQueue, type Field } from '../hooks/useCaptureQueue';
import { useVoiceQueue } from '../hooks/useVoiceQueue';
// ... inside Inventory():
const sessionId = activeSession?.id ?? null;
const { rows: queueRows, dispatch } = useCaptureQueue(sessionId);

const recordOne = useCallback(async (_upc: string): Promise<Blob | null> => {
  // Reuses useVoiceExtract under the hood. For brevity here, this is the simplest possible recorder:
  return new Promise(async (resolve) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      let speechMs = 0, silenceMs = 0, started = Date.now();
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser(); analyser.fftSize = 512;
      src.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      const tick = setInterval(() => {
        analyser.getByteTimeDomainData(data);
        let sum = 0; for (const v of data) { const d = v - 128; sum += d * d; }
        const rms = Math.sqrt(sum / data.length);
        if (rms > 6) { speechMs += 50; silenceMs = 0; } else if (speechMs > 0) silenceMs += 50;
        const elapsed = Date.now() - started;
        if ((speechMs > 400 && silenceMs > 1200) || elapsed > 12000) {
          clearInterval(tick); recorder.stop();
        }
      }, 50);
      recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = () => {
        ctx.close(); stream.getTracks().forEach(t => t.stop());
        if (speechMs < 400) { resolve(null); return; }
        resolve(new Blob(chunks, { type: 'audio/webm' }));
      };
      recorder.start();
    } catch { resolve(null); }
  });
}, []);

const extractOne = useCallback(async (upc: string, audio: Blob) => {
  const fd = new FormData(); fd.append('audio', audio, 'tag.webm'); fd.append('upc', upc);
  const baseUrl = localStorage.getItem('webAppUrl') || 'http://localhost:3000';
  const token   = localStorage.getItem('authToken');
  const tenantId = localStorage.getItem('tenantId');
  const headers: Record<string, string> = {};
  if (token)    headers['Authorization'] = `Bearer ${token}`;
  if (tenantId) headers['X-Tenant-Id']   = tenantId;
  const res = await fetch(`${baseUrl}/api/inventory/voice-extract`, { method: 'POST', body: fd, headers });
  if (!res.ok) return null;
  const body = await res.json();
  return body.success ? { fields: body.data.fields, confidence: body.data.confidence } : null;
}, []);

const { enqueue: enqueueVoice } = useVoiceQueue({
  record: recordOne,
  extract: extractOne,
  extractConcurrency: 3,
  onRecordingStart: (upc) => dispatch({ type: 'recording', upc }),
  onEnriching: (upc) => dispatch({ type: 'enriching', upc }),
  onResult: (upc, r) => dispatch({ type: 'ai_filled', upc, fields: r.fields as any, confidence: r.confidence as any }),
  onFailed: (upc) => dispatch({ type: 'ai_failed', upc }),
});
```

Modify `handleScanModeKeyDown` (around line 120) so that after a successful scan:

```tsx
const scanResult = await scanBarcode(upc);
if (scanResult.success && scanResult.item) {
  dispatch({ type: 'scanned', upc, item: scanResult.item });
  if (scanResult.isNew) enqueueVoice(upc);
  // remove the now-obsolete notFoundUpc inline banner block
}
```

Render the queue just above the inventory table:

```tsx
<CaptureQueue
  rows={queueRows}
  onEdit={async (upc, field, value) => {
    const row = queueRows.find(r => r.upc === upc);
    if (!row?.id) return;
    dispatch({ type: 'edit', upc, field, value });
    await upsertItem({ id: row.id, [field]: value } as any);
  }}
  onConfirmCell={(upc, field) => dispatch({ type: 'confirm_cell', upc, field })}
  onAcceptRow={(upc) => dispatch({ type: 'accept_row', upc })}
  onRemove={(upc) => dispatch({ type: 'remove', upc })}
  onRemic={(upc) => enqueueVoice(upc)}
  onOpenDetails={(upc) => {
    const row = queueRows.find(r => r.upc === upc);
    if (row?.id) openDetailPanel({ ...row, id: row.id } as any);
  }}
  onBumpQty={async (upc, d) => {
    const row = queueRows.find(r => r.upc === upc); if (!row?.id) return;
    const q = Math.max(0, row.qty + d);
    dispatch({ type: 'set_qty', upc, qty: q });
    await setQty(row.id, q, 'adjusted');
  }}
  onSetQty={async (upc, q) => {
    const row = queueRows.find(r => r.upc === upc); if (!row?.id) return;
    dispatch({ type: 'set_qty', upc, qty: q });
    await setQty(row.id, q, 'manual_count');
  }}
/>
```

- [ ] **Step 3: Manual smoke**

```bash
cd desktop && npm run dev
```
Open the app, start a receiving session, scan a known UPC (qty bumps row), scan an unknown one (mic should auto-start; row appears with status dot). Verify no console errors.

- [ ] **Step 4: Commit**

```bash
git add desktop/src/components/inventory/CaptureQueue.tsx desktop/src/pages/Inventory.tsx
git commit -m "feat(inventory): wire CaptureQueue + voice queue into Inventory page"
```

---

## Phase 4 — Keyboard model + accept/undo

### Task 4.1: `useKeyboardShortcuts` hook

**Files:**
- Create: `desktop/src/hooks/useKeyboardShortcuts.ts`

- [ ] **Step 1: Write the hook**

```tsx
import { useEffect } from 'react';

interface Handlers {
  onSlash?: () => void;
  onS?: () => void;
  onN?: () => void;
  onR?: () => void;
  onQuestion?: () => void;
  onEsc?: () => void;
}

export function useKeyboardShortcuts(handlers: Handlers, options: { lettersAreInput?: boolean } = {}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // If focus is in a text input/textarea, only Esc reaches us
      const target = e.target as HTMLElement;
      const isInput = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
      if (e.key === 'Escape') { handlers.onEsc?.(); return; }
      if (isInput) return;
      if (options.lettersAreInput) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case '/': e.preventDefault(); handlers.onSlash?.(); break;
        case 's': handlers.onS?.(); break;
        case 'n': handlers.onN?.(); break;
        case 'r': handlers.onR?.(); break;
        case '?': handlers.onQuestion?.(); break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handlers, options.lettersAreInput]);
}
```

- [ ] **Step 2: Wire into `Inventory.tsx`**

Inside `Inventory()`:
```tsx
const lettersAreInput = useMemo(() => localStorage.getItem('inventory.lettersAreInput') === '1', []);
useKeyboardShortcuts({
  onSlash: () => searchInputRef.current?.focus(),
  onS: toggleScanMode,
  onN: () => {
    const blank: Partial<InventoryItem> = { upc: '', qty: 1 };
    setSelectedItem(blank as InventoryItem); setEditedItem(blank);
  },
  onR: () => setStartReceivingOpen(true),
  onQuestion: () => setKbOverlayOpen(true),
  onEsc: () => closeDetailPanel(),
}, { lettersAreInput });
```

Add a `useState` for `kbOverlayOpen` near the other state declarations.

- [ ] **Step 3: Commit**

```bash
git add desktop/src/hooks/useKeyboardShortcuts.ts desktop/src/pages/Inventory.tsx
git commit -m "feat(inventory): keyboard shortcuts (/, s, n, r, ?, Esc)"
```

---

### Task 4.2: Per-row undo stack (10-deep)

**Files:**
- Modify: `desktop/src/hooks/useCaptureQueue.ts`
- Modify: `desktop/src/hooks/useCaptureQueue.test.ts`

- [ ] **Step 1: Append failing test**

```ts
it('undoes the last edit, redoes it', () => {
  let s = reduce(initialState, { type: 'scanned', upc: 'U', item: { id: 1, qty: 1, upc: 'U' } as any });
  s = reduce(s, { type: 'edit', upc: 'U', field: 'brand', value: 'A' });
  s = reduce(s, { type: 'edit', upc: 'U', field: 'brand', value: 'B' });
  s = reduce(s, { type: 'undo', upc: 'U' });
  expect(s.rows[0].brand).toBe('A');
  s = reduce(s, { type: 'redo', upc: 'U' });
  expect(s.rows[0].brand).toBe('B');
});
```

- [ ] **Step 2: Extend the reducer**

Add to `QueueRow`:
```ts
undoStack: Array<{ field: Field; prev: unknown }>;
redoStack: Array<{ field: Field; next: unknown }>;
```

Add to `QueueAction`:
```ts
| { type: 'undo'; upc: string }
| { type: 'redo'; upc: string }
```

In `reduce`, on `edit`: push the previous value onto the row's `undoStack` (cap at 10), clear `redoStack`.
On `undo`: pop from `undoStack`, push onto `redoStack`, restore previous value.
On `redo`: reverse direction.
On `ai_filled`: push a single "snapshot" entry containing all previous values for the AI-touched fields (so one Cmd/Z reverts the AI fill as one operation).

- [ ] **Step 3: Run tests**

```bash
cd desktop && npx vitest run src/hooks/useCaptureQueue.test.ts
```
Expected: all pass.

- [ ] **Step 4: Wire Cmd/Ctrl+Z in `Inventory.tsx`**

Inside the row's keydown handler (or a new keydown on the queue container):
```tsx
if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
  const upc = focusedUpcRef.current;
  if (upc) dispatch({ type: 'undo', upc });
}
if ((e.metaKey || e.ctrlKey) && e.key === 'z' && e.shiftKey) {
  const upc = focusedUpcRef.current;
  if (upc) dispatch({ type: 'redo', upc });
}
```

- [ ] **Step 5: Commit**

```bash
git add desktop/src/hooks/useCaptureQueue.ts desktop/src/hooks/useCaptureQueue.test.ts desktop/src/pages/Inventory.tsx
git commit -m "feat(inventory): per-row undo/redo (10-deep)"
```

---

### Task 4.3: Cmd/Ctrl+Enter accept-row + row focus tracking

**Files:**
- Modify: `desktop/src/components/inventory/CaptureRow.tsx`
- Modify: `desktop/src/pages/Inventory.tsx`

- [ ] **Step 1: Track row focus**

Add a ref + handler so when a cell in row X is focused, `focusedUpcRef.current = X.upc`. On the queue's keydown:

```tsx
if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
  const upc = focusedUpcRef.current;
  if (upc) dispatch({ type: 'accept_row', upc });
}
```

- [ ] **Step 2: Commit**

```bash
git add desktop/src/components/inventory/CaptureRow.tsx desktop/src/pages/Inventory.tsx
git commit -m "feat(inventory): Cmd/Ctrl+Enter accepts all AI fields on the focused row"
```

---

### Task 4.4: Settings toggle for "treat letter keystrokes as input only"

**Files:**
- Modify: existing settings page (find `desktop/src/pages/Settings.tsx`)

- [ ] **Step 1: Locate Settings page**

```bash
ls desktop/src/pages/Settings.tsx 2>/dev/null || ls desktop/src/pages/ | grep -i settings
```

- [ ] **Step 2: Add a toggle**

In the Settings page, add a labeled checkbox bound to `localStorage.getItem('inventory.lettersAreInput')` writing `'1'` or `''`.

```tsx
const [lettersInput, setLettersInput] = useState(() => localStorage.getItem('inventory.lettersAreInput') === '1');
// ...
<label className="flex items-center gap-2">
  <input type="checkbox" checked={lettersInput} onChange={(e) => {
    setLettersInput(e.target.checked);
    localStorage.setItem('inventory.lettersAreInput', e.target.checked ? '1' : '');
  }} />
  Treat letter keystrokes as input only (disables inventory hotkeys)
</label>
```

- [ ] **Step 3: Commit**

```bash
git add desktop/src/pages/Settings.tsx
git commit -m "feat(inventory): settings toggle for letter-as-input hotkey escape hatch"
```

---

## Phase 5 — Polish + edge cases

### Task 5.1: String similarity util + brand autocomplete

**Files:**
- Create: `desktop/src/utils/stringSimilarity.ts`
- Create: `desktop/src/hooks/useBrandAutocomplete.ts`

- [ ] **Step 1: Write similarity util (Jaro-Winkler)**

```ts
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const A = a.toLowerCase(), B = b.toLowerCase();
  const matchWindow = Math.max(0, Math.floor(Math.max(A.length, B.length) / 2) - 1);
  const aMatch = new Array(A.length).fill(false);
  const bMatch = new Array(B.length).fill(false);
  let matches = 0;
  for (let i = 0; i < A.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end   = Math.min(i + matchWindow + 1, B.length);
    for (let j = start; j < end; j++) {
      if (bMatch[j] || A[i] !== B[j]) continue;
      aMatch[i] = true; bMatch[j] = true; matches++; break;
    }
  }
  if (!matches) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < A.length; i++) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k++;
    if (A[i] !== B[k]) t++;
    k++;
  }
  t /= 2;
  const m = matches;
  const jaro = (m / A.length + m / B.length + (m - t) / m) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, A.length, B.length); i++) {
    if (A[i] === B[i]) prefix++; else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}
```

- [ ] **Step 2: Write the hook**

`desktop/src/hooks/useBrandAutocomplete.ts`:
```ts
import { useMemo } from 'react';
import { jaroWinkler } from '../utils/stringSimilarity';

export function useBrandAutocomplete(brands: string[]) {
  return useMemo(() => ({
    canonicalize(input: string): string {
      if (!input) return input;
      let best = input, score = 0;
      for (const b of brands) {
        const s = jaroWinkler(input, b);
        if (s > score) { score = s; best = b; }
      }
      return score >= 0.85 ? best : input;
    },
    suggest(input: string): string[] {
      const lower = input.toLowerCase();
      return brands
        .filter(b => b.toLowerCase().includes(lower))
        .slice(0, 6);
    },
  }), [brands]);
}
```

- [ ] **Step 3: Wire into the Brand cell**

In `CaptureRow.tsx`'s text Cell, when `field === 'brand'`, snap to canonical brand on blur. Pass `brands` down from `Inventory.tsx`.

- [ ] **Step 4: Commit**

```bash
git add desktop/src/utils/stringSimilarity.ts desktop/src/hooks/useBrandAutocomplete.ts desktop/src/components/inventory/CaptureRow.tsx desktop/src/pages/Inventory.tsx
git commit -m "feat(inventory): brand fuzzy autocomplete (Jaro-Winkler)"
```

---

### Task 5.2: Re-mic confirm dialog ("Overwrite confirmed fields?")

**Files:**
- Modify: `desktop/src/pages/Inventory.tsx`

- [ ] **Step 1: Wrap the `onRemic` dispatcher**

```tsx
const onRemic = useCallback((upc: string) => {
  const row = queueRows.find(r => r.upc === upc);
  const hasConfirmed = row && (row.brand || row.title || row.styleCode);
  if (hasConfirmed && !confirm('Overwrite confirmed fields? Click Cancel to keep them.')) {
    // Soft re-mic: mark all current fields as confirmed so AI cannot overwrite them
    for (const f of ['brand','title','styleCode','colorCode','colorName','size'] as const) {
      dispatch({ type: 'confirm_cell', upc, field: f });
    }
  }
  enqueueVoice(upc);
}, [queueRows, enqueueVoice, dispatch]);
```

In the AI-filled reducer path, skip fields whose names are already in a (new) `confirmed: Set<Field>` collection if it exists. Add `confirmed: Set<Field>` to the row and update reducer accordingly: `confirm_cell` adds to it; `edit` adds to it; `ai_filled` skips fields in it.

- [ ] **Step 2: Commit**

```bash
git add desktop/src/hooks/useCaptureQueue.ts desktop/src/pages/Inventory.tsx
git commit -m "feat(inventory): re-mic confirm dialog respects confirmed fields"
```

---

### Task 5.3: Waveform level meter while recording

**Files:**
- Create: `desktop/src/components/inventory/ReceivingLevelMeter.tsx`

- [ ] **Step 1: Write a thin canvas-free meter**

```tsx
import { useEffect, useState } from 'react';

interface Props { active: boolean; getRms?: () => number; }

export function ReceivingLevelMeter({ active, getRms }: Props) {
  const [rms, setRms] = useState(0);
  useEffect(() => {
    if (!active || !getRms) { setRms(0); return; }
    const t = setInterval(() => setRms(getRms()), 60);
    return () => clearInterval(t);
  }, [active, getRms]);
  const pct = Math.min(100, Math.round(rms * 4));
  return (
    <div className="h-1 bg-bg-tertiary rounded overflow-hidden">
      <div className="h-full bg-success transition-all" style={{ width: `${pct}%` }} />
    </div>
  );
}
```

- [ ] **Step 2: Pass an `rms` getter from the recorder into the currently-recording row.**

(Implementation note: hoist the analyser created inside `recordOne` to a ref so the row's meter can read `Math.sqrt(...)` from it.)

- [ ] **Step 3: Commit**

```bash
git add desktop/src/components/inventory/ReceivingLevelMeter.tsx desktop/src/pages/Inventory.tsx
git commit -m "feat(inventory): recording level meter under the active row"
```

---

### Task 5.4: Soft chime on AI completion

**Files:**
- Modify: `desktop/src/pages/Inventory.tsx`

- [ ] **Step 1: Add a `playChime` helper**

Reuse the existing `playTone` infrastructure in `Inventory.tsx`. Add:
```tsx
const playChime = useCallback(() => {
  playTone(1320, 0.08);
  setTimeout(() => playTone(1760, 0.1), 80);
}, [playTone]);
```

Call `playChime()` inside the `onResult` voice-queue callback alongside `dispatch({ type: 'ai_filled', ... })`.

- [ ] **Step 2: Commit**

```bash
git add desktop/src/pages/Inventory.tsx
git commit -m "feat(inventory): soft chime when AI fills a row"
```

---

### Task 5.5: "?" keyboard overlay

**Files:**
- Create: `desktop/src/components/inventory/KeyboardOverlay.tsx`

- [ ] **Step 1: Write the overlay**

```tsx
interface Props { open: boolean; onClose: () => void; }

const ROWS: Array<[string, string]> = [
  ['/', 'Focus search'],
  ['s', 'Toggle Scan mode'],
  ['n', 'New queue row'],
  ['r', 'Start receiving session'],
  ['Tab / Shift+Tab', 'Next / previous cell'],
  ['Enter', 'Save cell and jump to next unconfirmed field'],
  ['Esc', 'Cancel recording / drop focus / revert cell'],
  ['Cmd/Ctrl+Enter', 'Accept all AI fields on the focused row'],
  ['Cmd/Ctrl+Z / Shift+Z', 'Undo / redo'],
  ['m', 'Re-mic focused row'],
  ['d', 'Open full details for focused row'],
  ['Delete / Backspace', 'Remove focused row from queue'],
];

export function KeyboardOverlay({ open, onClose }: Props) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-6 max-w-md w-full" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold mb-4">Keyboard shortcuts</h3>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-border-subtle">
            {ROWS.map(([k, v]) => (
              <tr key={k}>
                <td className="py-1.5 pr-3 font-mono text-xs text-violet-400 whitespace-nowrap">{k}</td>
                <td className="py-1.5 text-text-secondary">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <button onClick={onClose} className="mt-4 px-3 py-1.5 bg-bg-tertiary rounded-lg text-sm">Close</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Render in `Inventory.tsx`**

```tsx
<KeyboardOverlay open={kbOverlayOpen} onClose={() => setKbOverlayOpen(false)} />
```

- [ ] **Step 3: Add "Press ? for shortcuts" hint pill** in the queue header that opens the overlay; remember dismissal in `localStorage`.

- [ ] **Step 4: Commit**

```bash
git add desktop/src/components/inventory/KeyboardOverlay.tsx desktop/src/pages/Inventory.tsx
git commit -m "feat(inventory): keyboard shortcuts overlay + hint pill"
```

---

## Appendix — Test tenant helper (if missing)

If `web/tests/helpers/test-tenant.ts` does not exist (only `tenants/` and `lib/` dirs are present), create it before Phase 1:

```ts
// web/tests/helpers/test-tenant.ts
import { prisma } from '@/lib/prisma';
import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';

export interface TestTenantCtx { tenantId: string; userId: number; token: string; }

export async function createTestTenant(): Promise<TestTenantCtx> {
  const tenant = await prisma.tenant.create({
    data: { name: 'test-' + randomUUID(), slug: 'test-' + Date.now() },
  });
  const user = await prisma.user.create({
    data: { email: `t-${Date.now()}@test`, passwordHash: 'x' },
  });
  await prisma.tenantUser.create({
    data: { tenantId: tenant.id, userId: user.id, role: 'owner', isActive: true, acceptedAt: new Date() },
  });
  const secret = new TextEncoder().encode(process.env.NEXTAUTH_SECRET || 'test-secret');
  const token = await new SignJWT({ id: String(user.id) })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(secret);
  return { tenantId: tenant.id, userId: user.id, token };
}

export function authHeaders(ctx: TestTenantCtx): Record<string, string> {
  return { Authorization: `Bearer ${ctx.token}`, 'X-Tenant-Id': ctx.tenantId };
}

export async function cleanupTestData(ctx: TestTenantCtx): Promise<void> {
  await prisma.inventoryMovement.deleteMany({ where: { tenantId: ctx.tenantId } });
  await prisma.receivingSession.deleteMany({ where: { tenantId: ctx.tenantId } });
  await prisma.inventory.deleteMany({ where: { tenantId: ctx.tenantId } });
  await prisma.tenantUser.deleteMany({ where: { tenantId: ctx.tenantId } });
  await prisma.tenant.delete({ where: { id: ctx.tenantId } });
  await prisma.user.delete({ where: { id: ctx.userId } });
}
```

Note: `NEXTAUTH_SECRET` must be set in `.env.local` for the tests to verify the signed JWT.
