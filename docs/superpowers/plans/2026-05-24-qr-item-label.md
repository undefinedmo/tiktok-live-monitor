# QR Item Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dense Code128 + CRC32 item-label barcode with a QR code encoding `showToken|title`, so labels scan reliably on the C750 and stay unique across shows.

**Architecture:** The QR payload is `<8-hex show token>|<listing title>`. The title is the natural key (it already contains `#N`); the show token disambiguates titles reused across shows. The QR SVG is generated in the Electron **main process** (offline, no CDN). The pack-station web API decodes by parsing the scan and matching the normalized title against `ShipmentItem.listingTitle`, scoped by the parent `shipments.show_id`. Clean break — old labels won't scan; `barcode-codec.ts` is deleted from both repos.

**Tech Stack:** Next.js 16 / Prisma 7 / Vitest (web); Electron 33 / React / Vitest / `qrcode-generator` (desktop).

**Spec:** `docs/superpowers/specs/2026-05-24-qr-item-label-design.md`

---

## File Structure

**Web (`web/`) — decode:**
- Create `src/lib/title-match.ts` — pure helpers: `showTokenFromId`, `normalizeTitle`, `parseScan`.
- Create `src/lib/__tests__/title-match.test.ts` — unit tests.
- Modify `src/app/api/pack-station/verify/route.ts` — match by title within shipment + show-token check.
- Modify `src/app/api/pack-station/find-item/route.ts` — match by show token + title.
- Create `src/app/api/pack-station/verify/__tests__/verify.test.ts` — route test.
- Delete `src/lib/barcode-codec.ts`.

**Desktop (`desktop/`) — encode:**
- Create `electron/lib/label-codec.ts` — `showTokenFromId`, `buildLabelPayload`, `qrSvg`.
- Create `electron/lib/label-codec.test.ts` — unit tests.
- Modify `vitest.config.ts` — add `electron/**/*.test.ts` to `include`.
- Modify `electron/lib/label-html.ts` — render QR SVG; drop bars/username; add `showId`.
- Modify `electron/ipc/label-generator.ts` — thread `showId`; update diagnostic log.
- Modify `src/pages/LiveMonitor.tsx` — pass `showId: liveId` when printing.
- Modify `src/pages/PackStation.tsx` — scan routing detects `|` (drop legacy 10-digit).
- Delete `electron/lib/barcode-codec.ts`.

---

## Task 1: Web — title-match pure helpers

**Files:**
- Create: `web/src/lib/title-match.ts`
- Test: `web/src/lib/__tests__/title-match.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/__tests__/title-match.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { showTokenFromId, normalizeTitle, parseScan } from '@/lib/title-match';

describe('showTokenFromId', () => {
  it('returns the first 8 hex chars of a UUID, lowercased', () => {
    expect(showTokenFromId('9F03C1C6-7647-4150-a2f9-7eed935a8827')).toBe('9f03c1c6');
  });
  it('returns empty string for null/undefined', () => {
    expect(showTokenFromId(null)).toBe('');
    expect(showTokenFromId(undefined)).toBe('');
  });
});

describe('normalizeTitle', () => {
  it('trims, collapses whitespace, lowercases', () => {
    expect(normalizeTitle('  Cool   Item  #4 ')).toBe('cool item #4');
  });
  it('NFC-normalizes unicode so composed and decomposed forms match', () => {
    expect(normalizeTitle('café')).toBe(normalizeTitle('café'));
  });
  it('returns empty string for null', () => {
    expect(normalizeTitle(null)).toBe('');
  });
});

describe('parseScan', () => {
  it('splits the 8-hex token and title at the delimiter', () => {
    expect(parseScan('9f03c1c6|Vintage Tee #4')).toEqual({ showToken: '9f03c1c6', title: 'Vintage Tee #4' });
  });
  it('keeps pipes that appear inside the title', () => {
    expect(parseScan('9f03c1c6|A|B|C')).toEqual({ showToken: '9f03c1c6', title: 'A|B|C' });
  });
  it('returns null when the delimiter is misplaced', () => {
    expect(parseScan('9f03|Tee')).toBeNull();
  });
  it('returns null when the token is not hex', () => {
    expect(parseScan('zzzzzzzz|Tee')).toBeNull();
  });
  it('returns null when the title is empty', () => {
    expect(parseScan('9f03c1c6|')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/__tests__/title-match.test.ts`
Expected: FAIL — cannot find module `@/lib/title-match`.

- [ ] **Step 3: Write the implementation**

Create `web/src/lib/title-match.ts`:

```ts
// Pure helpers for QR item-label matching at the pack station.
// QR payload format: `<showToken>|<title>` where showToken is the first 8 hex
// chars of the show UUID (dashes stripped, lowercased) and `|` is the delimiter.
// Title is parsed by FIXED OFFSET (not split) so titles may contain `|`.

const DELIM = '|';
const SHOW_TOKEN_LEN = 8;

export function showTokenFromId(showId: string | null | undefined): string {
  if (!showId) return '';
  return showId.replace(/-/g, '').slice(0, SHOW_TOKEN_LEN).toLowerCase();
}

export function normalizeTitle(title: string | null | undefined): string {
  if (!title) return '';
  return title.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

export interface ParsedScan {
  showToken: string;
  title: string;
}

export function parseScan(raw: string): ParsedScan | null {
  const s = raw.trim();
  if (s.length < SHOW_TOKEN_LEN + 1) return null;
  if (s[SHOW_TOKEN_LEN] !== DELIM) return null;
  const showToken = s.slice(0, SHOW_TOKEN_LEN).toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(showToken)) return null;
  const title = s.slice(SHOW_TOKEN_LEN + 1);
  if (!title) return null;
  return { showToken, title };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/__tests__/title-match.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
cd web && git add src/lib/title-match.ts src/lib/__tests__/title-match.test.ts
git commit -m "feat(pack-station): add title-match QR decode helpers"
```

---

## Task 2: Web — rewrite verify route

**Files:**
- Modify: `web/src/app/api/pack-station/verify/route.ts`
- Test: `web/src/app/api/pack-station/verify/__tests__/verify.test.ts`

- [ ] **Step 1: Write the failing route test**

Create `web/src/app/api/pack-station/verify/__tests__/verify.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/prisma', () => ({
  prisma: {
    shipment: { findFirst: vi.fn() },
    shipmentItem: { findMany: vi.fn() },
    packScan: { create: vi.fn() },
  },
}));

vi.mock('@/lib/tenant', () => ({
  getTenantContext: vi.fn(),
  requirePermission: vi.fn(),
  handleAuthError: vi.fn((e: unknown) => {
    const err = e as Error & { status?: number };
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: err.status ?? 500, headers: { 'Content-Type': 'application/json' },
    });
  }),
}));

import { getTenantContext } from '@/lib/tenant';
import { prisma } from '@/lib/prisma';
import { POST } from '../route';

type Req = import('next/server').NextRequest;
function req(body: unknown) {
  return new Request('http://localhost/api/pack-station/verify', {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
  }) as unknown as Req;
}

const ITEM = { id: 10, listingTitle: 'Vintage Tee #4', buyerUsername: 'alice', quantity: 1, orderId: 'o1', orderItemId: 'oi1' };

describe('POST /api/pack-station/verify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getTenantContext as ReturnType<typeof vi.fn>).mockResolvedValue({ tenantId: 't-1', userId: 1, role: 'owner', overrides: [] });
    (prisma.packScan.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.shipmentItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([ITEM]);
  });

  it('matches an item by normalized title within the shipment', async () => {
    (prisma.shipment.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 's1', showId: '9f03c1c6-7647-4150-a2f9-7eed935a8827' });
    const res = await POST(req({ shipmentId: 's1', barcode: '9f03c1c6|vintage   tee #4' }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.matched).toBe(true);
    expect(body.item.id).toBe(10);
  });

  it('does not match when the scanned show token differs from the shipment show', async () => {
    (prisma.shipment.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 's1', showId: 'aaaaaaaa-7647-4150-a2f9-7eed935a8827' });
    const res = await POST(req({ shipmentId: 's1', barcode: '9f03c1c6|Vintage Tee #4' }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.matched).toBe(false);
  });

  it('returns 400 for an unrecognized label', async () => {
    (prisma.shipment.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 's1', showId: null });
    const res = await POST(req({ shipmentId: 's1', barcode: 'not-a-label' }));
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/app/api/pack-station/verify/__tests__/verify.test.ts`
Expected: FAIL — current route imports `barcode-codec` and matches on `userHash`, so the title-based assertions fail.

- [ ] **Step 3: Rewrite the route**

Replace the entire contents of `web/src/app/api/pack-station/verify/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { getTenantContext, requirePermission, handleAuthError } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { parseScan, normalizeTitle, showTokenFromId } from "@/lib/title-match";

function parseItemNumber(title: string): string {
  const m = title.match(/#(\d+)/);
  return m ? m[1] : "";
}

// POST /api/pack-station/verify — verify a scanned QR (`showToken|title`)
// against a shipment. Body: { shipmentId: string, barcode: string }
export async function POST(req: NextRequest) {
  try {
    const ctx = await getTenantContext(req);
    requirePermission(ctx, 'pack_station.use');

    const body = await req.json();
    const { shipmentId, barcode } = body as { shipmentId?: string; barcode?: string };
    if (!shipmentId || !barcode) {
      return NextResponse.json({ success: false, error: "shipmentId and barcode are required" }, { status: 400 });
    }

    const parsed = parseScan(barcode);
    if (!parsed) {
      return NextResponse.json({ success: false, error: "Unrecognized label" }, { status: 400 });
    }

    const shipment = await prisma.shipment.findFirst({
      where: { id: shipmentId, tenantId: ctx.tenantId },
      select: { id: true, showId: true },
    });
    if (!shipment) {
      return NextResponse.json({ success: false, error: "Shipment not found" }, { status: 404 });
    }

    // If the shipment's show is known, the scanned show token must match it.
    const shipmentToken = showTokenFromId(shipment.showId);
    const showMatches = !shipmentToken || shipmentToken === parsed.showToken;

    const wantTitle = normalizeTitle(parsed.title);
    const itemNumber = parseItemNumber(parsed.title);

    const items = await prisma.shipmentItem.findMany({
      where: { shipmentId, tenantId: ctx.tenantId },
      select: { id: true, listingTitle: true, buyerUsername: true, quantity: true, orderId: true, orderItemId: true },
    });

    const matched = showMatches && wantTitle
      ? items.find((it) => normalizeTitle(it.listingTitle) === wantTitle)
      : undefined;

    if (matched) {
      await prisma.packScan
        .create({
          data: {
            tenantId: ctx.tenantId, userId: ctx.userId ?? null, shipmentId,
            itemNumber: itemNumber || null, username: matched.buyerUsername ?? null,
            scanBarcode: barcode, matched: true,
          },
        })
        .catch((e) => console.error('[pack-station/verify] PackScan log failed:', e));

      return NextResponse.json({
        success: true, matched: true,
        item: {
          id: matched.id, listingTitle: matched.listingTitle, buyerUsername: matched.buyerUsername,
          quantity: matched.quantity, orderId: matched.orderId, orderItemId: matched.orderItemId,
        },
        decodedItemNumber: itemNumber ? parseInt(itemNumber, 10) : null,
      });
    }

    // Mismatch — find which buyer the scanned title belongs to (same show), for the UI.
    let decodedUsername: string | undefined;
    if (wantTitle) {
      const candidates = await prisma.shipmentItem.findMany({
        where: { tenantId: ctx.tenantId, shipment: { showId: { startsWith: parsed.showToken } } },
        select: { listingTitle: true, buyerUsername: true },
        take: 500,
      });
      const owner = candidates.find((c) => normalizeTitle(c.listingTitle) === wantTitle);
      if (owner?.buyerUsername) decodedUsername = owner.buyerUsername;
    }

    await prisma.packScan
      .create({
        data: {
          tenantId: ctx.tenantId, userId: ctx.userId ?? null, shipmentId,
          itemNumber: itemNumber || null, username: decodedUsername ?? null,
          scanBarcode: barcode, matched: false,
        },
      })
      .catch((e) => console.error('[pack-station/verify] PackScan log failed:', e));

    return NextResponse.json({
      success: true, matched: false,
      decodedItemNumber: itemNumber ? parseInt(itemNumber, 10) : null,
      decodedUsername,
    });
  } catch (error) {
    return handleAuthError(error);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/app/api/pack-station/verify/__tests__/verify.test.ts`
Expected: PASS (3 cases).

- [ ] **Step 5: Commit**

```bash
cd web && git add src/app/api/pack-station/verify/route.ts src/app/api/pack-station/verify/__tests__/verify.test.ts
git commit -m "feat(pack-station): verify scans by title + show token"
```

---

## Task 3: Web — rewrite find-item route

**Files:**
- Modify: `web/src/app/api/pack-station/find-item/route.ts`
- Test: `web/src/app/api/pack-station/find-item/__tests__/find-item.test.ts`

- [ ] **Step 1: Write the failing route test**

Create `web/src/app/api/pack-station/find-item/__tests__/find-item.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/prisma', () => ({
  prisma: { shipmentItem: { findMany: vi.fn() } },
}));

vi.mock('@/lib/tenant', () => ({
  getTenantContext: vi.fn(),
  requirePermission: vi.fn(),
  handleAuthError: vi.fn((e: unknown) => {
    const err = e as Error & { status?: number };
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: err.status ?? 500, headers: { 'Content-Type': 'application/json' },
    });
  }),
}));

import { getTenantContext } from '@/lib/tenant';
import { prisma } from '@/lib/prisma';
import { GET } from '../route';

type Req = import('next/server').NextRequest;
function req(barcode: string) {
  return new Request(`http://localhost/api/pack-station/find-item?barcode=${encodeURIComponent(barcode)}`) as unknown as Req;
}

describe('GET /api/pack-station/find-item', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getTenantContext as ReturnType<typeof vi.fn>).mockResolvedValue({ tenantId: 't-1', userId: 1, role: 'owner', overrides: [] });
  });

  it('locates the shipment by show token + normalized title', async () => {
    (prisma.shipmentItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { listingTitle: 'Vintage Tee #4', shipment: { id: 's9', status: 'pending', trackingCode: 'TC', trackingNumber: 'TN', buyerUsername: 'alice', addressFullName: 'Alice A', totalItems: 3, createdAt: new Date('2026-05-20') } },
    ]);
    const res = await GET(req('9f03c1c6|vintage tee #4'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.found).toBe(true);
    expect(body.shipment.id).toBe('s9');
  });

  it('returns found:false when no item matches', async () => {
    (prisma.shipmentItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const res = await GET(req('9f03c1c6|Nothing Here #1'));
    const body = await res.json();
    expect(body.found).toBe(false);
  });

  it('returns 400 for an unrecognized label', async () => {
    const res = await GET(req('garbage'));
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/app/api/pack-station/find-item/__tests__/find-item.test.ts`
Expected: FAIL — current route imports `barcode-codec`.

- [ ] **Step 3: Rewrite the route**

Replace the entire contents of `web/src/app/api/pack-station/find-item/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { getTenantContext, requirePermission, handleAuthError } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { parseScan, normalizeTitle } from "@/lib/title-match";

// GET /api/pack-station/find-item?barcode=<raw QR>
// Locates which shipment a scanned item belongs to (the "wrong shipment" UI).
export async function GET(req: NextRequest) {
  try {
    const ctx = await getTenantContext(req);
    requirePermission(ctx, 'pack_station.use');

    const { searchParams } = new URL(req.url);
    const barcode = searchParams.get("barcode") || searchParams.get("itemId"); // back-compat param name
    if (!barcode) {
      return NextResponse.json({ success: false, error: "barcode parameter is required" }, { status: 400 });
    }

    const parsed = parseScan(barcode);
    if (!parsed) {
      return NextResponse.json({ success: false, error: "Unrecognized label" }, { status: 400 });
    }

    const candidates = await prisma.shipmentItem.findMany({
      where: {
        tenantId: ctx.tenantId,
        shipment: { showId: { startsWith: parsed.showToken } },
      },
      select: {
        listingTitle: true,
        shipment: {
          select: {
            id: true, status: true, trackingCode: true, trackingNumber: true,
            buyerUsername: true, addressFullName: true, totalItems: true, createdAt: true,
          },
        },
      },
      take: 500,
    });

    const wantTitle = normalizeTitle(parsed.title);
    const matched = wantTitle
      ? candidates
          .filter((c) => c.shipment && normalizeTitle(c.listingTitle) === wantTitle)
          .sort((a, b) => (b.shipment!.createdAt?.getTime() ?? 0) - (a.shipment!.createdAt?.getTime() ?? 0))[0]
      : undefined;

    if (!matched || !matched.shipment) {
      return NextResponse.json({ success: true, found: false });
    }

    return NextResponse.json({
      success: true, found: true,
      shipment: {
        id: matched.shipment.id, status: matched.shipment.status,
        trackingCode: matched.shipment.trackingCode, trackingNumber: matched.shipment.trackingNumber,
        buyerUsername: matched.shipment.buyerUsername, addressFullName: matched.shipment.addressFullName,
        totalItems: matched.shipment.totalItems, packedStatus: 'PENDING',
      },
    });
  } catch (error) {
    return handleAuthError(error);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/app/api/pack-station/find-item/__tests__/find-item.test.ts`
Expected: PASS (3 cases).

- [ ] **Step 5: Commit**

```bash
cd web && git add src/app/api/pack-station/find-item/route.ts src/app/api/pack-station/find-item/__tests__/find-item.test.ts
git commit -m "feat(pack-station): find-item by show token + title"
```

---

## Task 4: Web — delete barcode-codec & audit consumers

**Files:**
- Delete: `web/src/lib/barcode-codec.ts`
- Audit: `web/src/app/api/pack-station/{stats,mark-packed,recent-packed,shipment}/route.ts`, `web/src/app/(dashboard)/shipping/pack-station/page.tsx`

- [ ] **Step 1: Confirm no remaining importers**

Run: `cd web && grep -rn "barcode-codec" src/`
Expected: no matches (verify + find-item no longer import it after Tasks 2–3).
If any other file matches, open it and replace its usage with `title-match` helpers before deleting.

- [ ] **Step 2: Delete the file**

```bash
cd web && git rm src/lib/barcode-codec.ts
```

- [ ] **Step 3: Confirm the web pack-station page needs no scan change**

Run: `cd web && grep -n "verifyItem\|loadShipment\|\\\\d{10}\|includes" "src/app/(dashboard)/shipping/pack-station/page.tsx"`
Expected: the page routes by a `mode` toggle (`scan-shipment` / `scan-items`) and passes the raw `trimmed` string straight to `verifyItem` / `loadShipment`. There is **no** numeric/10-digit assumption, so no change is required. (If a `\d{10}` check is found, remove it.)

- [ ] **Step 4: Confirm sibling routes don't decode barcodes**

Run: `cd web && grep -rn "decodeBarcode\|hashUsername\|isEncodedBarcode\|verifyUsername" src/app/api/pack-station/`
Expected: no matches. These routes (`stats`, `mark-packed`, `recent-packed`, `shipment`) only matched earlier greps on the path string `pack-station`, not on codec usage.

- [ ] **Step 5: Run the full web test suite + typecheck**

Run: `cd web && npx vitest run && npx tsc --noEmit`
Expected: tests PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
cd web && git add -A
git commit -m "chore(pack-station): remove legacy barcode-codec"
```

---

## Task 5: Desktop — QR codec helpers

**Files:**
- Modify: `desktop/package.json` (deps)
- Modify: `desktop/vitest.config.ts`
- Create: `desktop/electron/lib/label-codec.ts`
- Test: `desktop/electron/lib/label-codec.test.ts`

- [ ] **Step 1: Install the QR generator**

```bash
cd desktop && npm install qrcode-generator && npm install -D @types/qrcode-generator
```

- [ ] **Step 2: Let vitest discover electron tests**

In `desktop/vitest.config.ts`, change the `include` line:

```ts
    include: ['src/**/*.test.ts', 'electron/**/*.test.ts'],
```

- [ ] **Step 3: Write the failing test**

Create `desktop/electron/lib/label-codec.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { showTokenFromId, buildLabelPayload, qrSvg } from './label-codec';

describe('showTokenFromId', () => {
  it('returns the first 8 hex chars of a UUID, lowercased', () => {
    expect(showTokenFromId('9F03C1C6-7647-4150-a2f9-7eed935a8827')).toBe('9f03c1c6');
  });
  it('returns empty string when id is missing', () => {
    expect(showTokenFromId(null)).toBe('');
  });
});

describe('buildLabelPayload', () => {
  it('joins the token and the trimmed title with a pipe', () => {
    expect(buildLabelPayload('9f03c1c6-7647-4150-a2f9-7eed935a8827', '  Vintage Tee #4 '))
      .toBe('9f03c1c6|Vintage Tee #4');
  });
  it('returns empty string when the title is missing', () => {
    expect(buildLabelPayload('9f03c1c6-7647-4150-a2f9-7eed935a8827', '')).toBe('');
  });
  it('returns empty string when the showId is missing', () => {
    expect(buildLabelPayload(null, 'Vintage Tee #4')).toBe('');
  });
});

describe('qrSvg', () => {
  it('produces a scalable svg tag for a payload', () => {
    const svg = qrSvg('9f03c1c6|Vintage Tee #4');
    expect(svg).toContain('<svg');
    expect(svg).toContain('viewBox');
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd desktop && npx vitest run electron/lib/label-codec.test.ts`
Expected: FAIL — cannot find module `./label-codec`.

- [ ] **Step 5: Write the implementation**

Create `desktop/electron/lib/label-codec.ts`:

```ts
// QR item-label codec. Payload format: `<showToken>|<title>` where showToken is
// the first 8 hex chars of the show UUID (dashes stripped, lowercased).
// The title is the unique key; the show token disambiguates titles reused
// across shows. QR rendered as an SVG string in the Electron main process
// (offline — no CDN dependency at print time).
import qrcode from 'qrcode-generator';

const DELIM = '|';

export function showTokenFromId(showId: string | null | undefined): string {
  if (!showId) return '';
  return showId.replace(/-/g, '').slice(0, 8).toLowerCase();
}

export function buildLabelPayload(showId: string | null | undefined, title: string | null | undefined): string {
  const token = showTokenFromId(showId);
  const t = (title ?? '').trim();
  if (!token || !t) return '';
  return `${token}${DELIM}${t}`;
}

export function qrSvg(payload: string): string {
  const qr = qrcode(0, 'L'); // type 0 = auto-fit smallest version; ECC level L
  qr.addData(payload);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}
```

> If TypeScript flags the default import, the package is CommonJS — use
> `import * as qrcode from 'qrcode-generator';` (esModuleInterop off). If
> `createSvgTag`'s options object is not in the installed `@types`, fall back to
> `qr.createSvgTag(4, 2)` and add `viewBox`-based scaling is unnecessary because
> the container sizes it (Task 6 sets the wrapper width/height).

- [ ] **Step 6: Run test to verify it passes**

Run: `cd desktop && npx vitest run electron/lib/label-codec.test.ts`
Expected: PASS (all cases).

- [ ] **Step 7: Commit**

```bash
cd desktop && git add package.json package-lock.json vitest.config.ts electron/lib/label-codec.ts electron/lib/label-codec.test.ts
git commit -m "feat(labels): add QR label codec (showToken|title)"
```

---

## Task 6: Desktop — render QR in label HTML

**Files:**
- Modify: `desktop/electron/lib/label-html.ts`

- [ ] **Step 1: Replace the codec import**

In `desktop/electron/lib/label-html.ts`, change line 3:

```ts
import { buildLabelPayload, qrSvg } from './label-codec';
```

- [ ] **Step 2: Add `showId` to the LabelData interface**

In the `LabelData` interface, add the field:

```ts
export interface LabelData {
  itemNumber?: string;
  buyerUsername?: string;
  price?: string;
  itemTitle?: string;
  showId?: string;
}
```

- [ ] **Step 3: Replace `generateLabelHTML` with the QR version**

Replace the entire `generateLabelHTML` function (and remove the now-unused `wrapText` helper) with:

```ts
export function generateLabelHTML(data: LabelData, template: LabelTemplate): string {
  const size = LABEL_SIZES[template.labelSize];
  const widthPt = size.widthIn * 72;
  const heightPt = size.heightIn * 72;
  const padding = 3; // pt
  const gap = 2; // pt

  const itemNumber = data.itemNumber || parseItemNumber(data.itemTitle || '');
  const price = data.price || '';

  // QR payload: `<showToken>|<title>`. Empty if showId or title is missing,
  // in which case the QR simply isn't rendered.
  const qrPayload = buildLabelPayload(data.showId, data.itemTitle);

  // Vertical budget: text rows take fixed height; the QR fills the remainder
  // as a square so it stays as large as possible on a 1" label.
  let usedHeight = padding * 2;
  let enabledSections = 0;
  if (template.itemNumber.enabled && itemNumber) enabledSections++;
  if (template.barcode.enabled && qrPayload) enabledSections++;
  if (template.price.enabled && price) enabledSections++;
  usedHeight += Math.max(0, enabledSections - 1) * gap;
  if (template.itemNumber.enabled && itemNumber) usedHeight += template.itemNumber.fontSize * 1.1;
  if (template.price.enabled && price) usedHeight += template.price.fontSize * 1.1;

  const usableWidth = widthPt - padding * 2;
  const qrSizePt = template.barcode.enabled && qrPayload
    ? Math.max(0, Math.min(usableWidth, heightPt - usedHeight))
    : 0;

  const sections: string[] = [];

  if (template.itemNumber.enabled && itemNumber) {
    sections.push(`<div style="font-size:${template.itemNumber.fontSize}pt;font-weight:bold;line-height:1.1;text-align:center;flex-shrink:0;">#${escapeHTML(itemNumber)}</div>`);
  }

  if (qrSizePt > 0) {
    sections.push(`<div class="qr" style="width:${qrSizePt}pt;height:${qrSizePt}pt;flex-shrink:0;">${qrSvg(qrPayload)}</div>`);
  }

  if (template.price.enabled && price) {
    sections.push(`<div style="font-size:${template.price.fontSize}pt;font-weight:bold;line-height:1.1;text-align:center;flex-shrink:0;">$${escapeHTML(price)}</div>`);
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page {
    size: ${widthPt}pt ${heightPt}pt;
    margin: 0;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: ${widthPt}pt;
    height: ${heightPt}pt;
  }
  body {
    font-family: '${template.fontFamily}', sans-serif;
    color: #000000;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: ${gap}pt;
    padding: ${padding}pt;
    overflow: visible;
  }
  .qr { display: flex; align-items: center; justify-content: center; }
  .qr svg { display: block; width: 100%; height: 100%; }
</style>
</head>
<body>
${sections.join('\n')}
</body>
</html>`;
}
```

> Note: this removes the `buyerUsername` row entirely (per the design — no room
> for it alongside a robust QR on a 1" label) and removes all the JsBarcode
> bar-width math and the CDN `<script>` tag. `parseItemNumber` and `escapeHTML`
> stay; `wrapText` and `charsPerLine` are deleted.

- [ ] **Step 4: Verify no JsBarcode / encodeBarcode references remain**

Run: `cd desktop && grep -n "JsBarcode\|encodeBarcode\|wrapText\|cdn.jsdelivr" electron/lib/label-html.ts`
Expected: no matches.

- [ ] **Step 5: Typecheck**

Run: `cd desktop && npx tsc --noEmit`
Expected: no type errors. (If `qrcode-generator` import errors, apply the fallback note from Task 5 Step 5.)

- [ ] **Step 6: Commit**

```bash
cd desktop && git add electron/lib/label-html.ts
git commit -m "feat(labels): render QR (showToken|title) instead of Code128"
```

---

## Task 7: Desktop — plumb showId from the live monitor

**Files:**
- Modify: `desktop/electron/ipc/label-generator.ts`
- Modify: `desktop/src/pages/LiveMonitor.tsx`

- [ ] **Step 1: Add `showId` to the IPC handler's LabelData**

In `desktop/electron/ipc/label-generator.ts`, add `showId?: string;` to the `LabelData` interface (near line 12):

```ts
interface LabelData {
  buyerUsername: string;
  buyerName?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  country?: string;
  items?: Array<{ title: string; quantity: number }>;
  itemNumber?: string;
  itemTitle?: string;
  price?: string;
  showId?: string;
}
```

- [ ] **Step 2: Pass `showId` into generateLabelHTML**

In the `print-label` handler, update the `generateLabelHTML(...)` call (near line 731) to include `showId`:

```ts
      const html = generateLabelHTML({
        itemNumber,
        buyerUsername: labelData.buyerUsername,
        price: labelData.price || '',
        itemTitle: labelData.itemTitle || labelData.items?.[0]?.title || '',
        showId: labelData.showId,
      }, template);
```

- [ ] **Step 3: Replace the JsBarcode diagnostic log**

Replace the diagnostic block (the `const barcodeMatch = html.match(...)` through the `console.log('[Label] Encoding barcode:', ...)` call, ~lines 740–748) with:

```ts
      // Diagnostic: surface what got encoded into the QR.
      const hasQr = /<svg[^>]*viewBox/.test(html);
      console.log('[Label] QR payload:', JSON.stringify({
        itemNumber,
        title: labelData.itemTitle || labelData.items?.[0]?.title || '',
        showId: labelData.showId ?? '(none)',
        rendered: hasQr ? 'qr-svg' : '(no qr)',
      }));
```

- [ ] **Step 4: Pass `showId: liveId` from LiveMonitor when printing**

In `desktop/src/pages/LiveMonitor.tsx`, in `handlePrintLabel` (near line 269), add `showId: liveId` to the print payload and add `liveId` to the `useCallback` deps:

```ts
        await window.labelAPI.print(
          {
            itemNumber,
            buyerUsername: sale.buyer.username,
            itemTitle: sale.listing.title,
            price: String(sale.price.amount / 100),
            showId: liveId,
          },
          selectedPrinter
        );
```

Update the dependency array at the end of the `useCallback` to:

```ts
    [selectedPrinter, addToPrintQueue, updateQueueStatus, liveId]
```

- [ ] **Step 5: Typecheck**

Run: `cd desktop && npx tsc --noEmit`
Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
cd desktop && git add electron/ipc/label-generator.ts src/pages/LiveMonitor.tsx
git commit -m "feat(labels): thread live showId into item-label QR"
```

---

## Task 8: Desktop — scan routing & remove legacy codec

**Files:**
- Modify: `desktop/src/pages/PackStation.tsx`
- Delete: `desktop/electron/lib/barcode-codec.ts`

- [ ] **Step 1: Detect item scans by the delimiter only**

In `desktop/src/pages/PackStation.tsx` (line 133), change:

```ts
    const isItemBarcode = /^\d{10}$/.test(trimmed) || trimmed.includes('|');
```

to:

```ts
    const isItemBarcode = trimmed.includes('|');
```

- [ ] **Step 2: Confirm nothing imports the desktop codec**

Run: `cd desktop && grep -rn "barcode-codec" electron/ src/`
Expected: no matches (Task 6 removed the only importer).

- [ ] **Step 3: Delete the file**

```bash
cd desktop && git rm electron/lib/barcode-codec.ts
```

- [ ] **Step 4: Run the full desktop test suite + typecheck + lint**

Run: `cd desktop && npx vitest run && npx tsc --noEmit && npm run lint`
Expected: tests PASS; no type errors; lint clean.

- [ ] **Step 5: Commit**

```bash
cd desktop && git add -A
git commit -m "chore(pack-station): scan routing for QR, drop legacy codec"
```

---

## Task 9: Full verification & manual scan test

**Files:** none (verification only)

- [ ] **Step 1: Run both automated suites**

Run: `cd web && npx vitest run && npx tsc --noEmit`
Then: `cd desktop && npx vitest run && npx tsc --noEmit`
Expected: all PASS, no type errors.

- [ ] **Step 2: Build the desktop app**

Run: `cd desktop && npm run build`
Expected: build succeeds (confirms the inlined QR generator bundles into the Electron main process with no CDN dependency).

- [ ] **Step 3: Manual print + scan (golden path)**

  1. Start the desktop app, open Live Monitor, connect to a show (so `liveId` is set).
  2. Trigger/print one item label (or use a known sale row).
  3. Confirm the printed 1" label shows a centered QR with a small `#N` beneath it (no username line).
  4. Scan the printed QR with the **C750**. Confirm it beeps/decodes to `<8hex>|<title>`.
  5. In Pack Station, load the matching shipment, scan the item — confirm it verifies (green/match).

- [ ] **Step 4: Manual "wrong shipment" path**

  1. With a *different* shipment open, scan the same item.
  2. Confirm the mismatch UI reports the correct owning buyer (find-item resolved via show token + title).

- [ ] **Step 5: Confirm the C750 is a 2D imager (if any scan fails to decode)**

If the C750 does not decode the QR at all, verify it reads a QR on a phone screen. A 1D-only unit cannot read QR regardless of payload — escalate to the user before further debugging.

- [ ] **Step 6: Final commit (if any verification fixups were needed)**

```bash
git -C web add -A && git -C web commit -m "test(pack-station): verification fixups" || true
git -C desktop add -A && git -C desktop commit -m "test(labels): verification fixups" || true
```

---

## Self-Review Notes

- **Spec coverage:** payload format (T1/T5), clean break + delete codec (T4/T8), offline inline QR (T5/T6), no schema change / match via `shipments.show_id` (T2/T3), layout QR+#N drop username (T6), showId plumbing (T7), scanner free-text (T4 web / T8 desktop), audit sibling routes (T4), manual C750 test (T9). All covered.
- **Type consistency:** `parseScan` → `{ showToken, title }` used identically in verify (T2) and find-item (T3); `showTokenFromId`/`buildLabelPayload`/`qrSvg` signatures match between definition (T5) and use (T6); `LabelData.showId` added in both `label-html.ts` (T6) and `label-generator.ts` (T7).
- **Cross-repo note:** `title-match.ts` (web) and `label-codec.ts` (desktop) intentionally duplicate `showTokenFromId`/normalization because the two repos don't share a module. The token derivation (strip dashes, first 8, lowercase) and the payload format must stay byte-identical across both.
