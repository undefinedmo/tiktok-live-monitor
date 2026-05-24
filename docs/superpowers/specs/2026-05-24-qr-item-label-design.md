# QR Item Labels — Design

**Date:** 2026-05-24
**Status:** Approved (pending spec review)

## Problem

The new C750 scanner cannot reliably read the dense Code128 barcode on our 1" item
labels (it projects its aim line but never decodes — no beep). The cheaper Netum
scanner read them, but we want a format that scans dependably on any 2D imager.

The current label encodes a 10-digit numeric string (`barcode-codec.ts`):
`CRC32(username) % 1e6` (6 digits) + zero-padded item number (4 digits). That hash
trick exists **only** to keep a 1D Code128 short enough to print at a scannable bar
width on a 1" label. It also forces the pack-station decode to re-hash every buyer
in a shipment to find a match, and it can collide (`% 1_000_000`).

Switching to a **QR code** removes the bar-width constraint entirely, which means we
can drop the hashing scheme and encode human-meaningful data directly.

## Key identifier decision

The natural key for an item is its **listing title** — it already contains the
item number (`#N`, parsed via `/#(\d+)/`) and distinguishes separate listings run in
the same show.

Title alone is **not globally unique**, confirmed against the v2 DB: e.g.
`"GIVEAWAY - BEAUTY PRODUCT #1"` appears across 36 different shows. (Giveaways don't
go through pack-station scanning, but other recurring product titles can repeat
across shows too.) `(show_id + title)` is effectively unique — of 4356 such groups
only 35 repeat, and those are same-buyer multi-quantity that existing per-row logic
already handles.

**Therefore the QR payload is `showToken|title`**, where `showToken` is the first 8
hex characters of the Whatnot show UUID.

### Why an 8-hex show token (not the full UUID)

A full 36-char UUID plus a worst-case ~100-char title pushes the QR to ~version 7,
which on a 1" round forces ~10-mil modules — marginal for a budget scanner. The first
8 hex chars (32 bits) keep collisions astronomically unlikely across our lifetime show
volume, and a collision would *also* require an identical title to matter. This keeps
the QR ~one version smaller so even long titles stay comfortably scannable.

## Payload format

```
<showToken><DELIM><title>
```

- `showToken` — first 8 lowercase hex chars of the show UUID (fixed length).
- `DELIM` — a single `|`.
- `title` — the listing title, encoded verbatim (raw, not normalized; normalization
  happens at match time on both sides).

**Parsing is by fixed offset, not split:** `showToken = scan.slice(0, 8)`,
`title = scan.slice(9)` (char 8 must be `|`). This is robust to titles that
themselves contain `|`.

## Scope decisions (confirmed with user)

- **Clean break — no legacy support.** Already-printed Code128 labels will stop
  scanning and must be reprinted. We do not keep the old 10-digit / pipe decode
  paths. `barcode-codec.ts` is deleted from both repos.
- **Offline-safe rendering.** The QR generator is **inlined** into the label HTML
  (vendored compact pure-JS encoder, e.g. `qrcode-generator`). The label must print
  during a live show even if the network blips — today's CDN-loaded JsBarcode is a
  latent failure point we remove.
- **No schema change.** `shipment_items.show_id` is 100% NULL, but the parent
  `shipments.show_id` is populated for current shows. We match the show token against
  `shipments.show_id` through the existing item→shipment relation.

## Architecture & data flow

### Encode (label print) — `desktop/`

1. **Live monitor already holds the show UUID** (`LIVESTREAM_ID` in
   `electron/ipc/label-generator.ts`). Thread it into the sale event so it reaches the
   label printer.
2. `LabelData` (in the `print-label` IPC handler) gains a `showId` field.
3. `electron/lib/label-html.ts`:
   - Remove `import { encodeBarcode }` and the 10-digit `barcodeValue` logic.
   - Build payload `showToken|title` where `showToken = showId.replace(/-/g,'').slice(0,8).toLowerCase()`.
   - Replace the JsBarcode CDN `<script>` with the inlined QR encoder, rendering an
     **SVG QR at ECC level L**, sized to fill the available square with a quiet-zone
     margin so it sits inside the 1" circle.
   - If `showId` or `title` is missing, render nothing (existing fall-through behavior).
4. Remove the JsBarcode diagnostic logging in `label-generator.ts` (~lines 738–748);
   replace with equivalent QR-payload logging.

### Label layout (1" round)

QR centered, with a small human-readable `#N` beneath it for eyeball sorting. **Drop
the username text** — there isn't room for a big number, a username line, and a robust
QR. This gives the QR ~0.6–0.65".

### Decode (pack station) — `web/`

`web/src/lib/barcode-codec.ts` is deleted. Add a small `web/src/lib/title-match.ts`
with:
- `parseScan(raw)` → `{ showToken, title }` via fixed-offset parsing.
- `normalizeTitle(s)` → trim, collapse internal whitespace, lowercase, Unicode NFC.

**`POST /api/pack-station/verify`** (operator has a shipment open):
- Parse the scan. Match within the shipment's items by `normalizeTitle(title) ===
  normalizeTitle(item.listingTitle)`.
- If the shipment's `show_id` is present, also assert its 8-hex token equals
  `showToken`; mismatch → treat as not-matched (wrong item/show).
- On miss, look up the title tenant-wide to report which buyer/shipment it belongs to
  (existing "wrong shipment" UX).
- `PackScan` audit log: derive `itemNumber` by parsing `#N` from the title;
  `username` from the matched row; `scanBarcode` = raw scan.

**`GET /api/pack-station/find-item`** (unknown shipment):
- Parse the scan. Match items where the parent `shipments.show_id` 8-hex token ==
  `showToken` **AND** `normalizeTitle(listing_title) == normalizeTitle(title)`,
  scoped to unpacked/recent shipments. Deterministic — no recency guessing required.

### Audit / consumers to verify (no assumed changes)

- `web/src/app/(dashboard)/shipping/pack-station/page.tsx` — scanner input must accept
  free-text (spaces, symbols, `|`); the scanned value is no longer numeric.
- `web/src/app/api/pack-station/{stats,mark-packed,recent-packed,shipment}/route.ts` —
  confirm none assume the numeric/10-digit barcode.

## Error handling

- Scan with no `|` at offset 8, or empty title → `400 "Unrecognized label"`.
- QR generation failure at print time → existing fallback (small "barcode error" text).
- Title present in QR but not found in shipment → existing mismatch UX.

## Testing

- **Unit:** `normalizeTitle` (whitespace, case, Unicode NFC, emoji-in-title);
  `parseScan` (fixed-offset, title containing `|`); `showToken` derivation from a UUID.
- **Round-trip:** title + showId → payload → QR → scan string → parse → normalized
  match against stored `listing_title` + `shipments.show_id` token.
- **Manual:** print on the thermal printer, scan with the C750, confirm verify matches,
  the show-token cross-check rejects a wrong-show item, and find-item locates the
  correct shipment.

## Risks & mitigations

- **Title string drift** between the live-captured `listing.title` (encode) and the
  synced `shipment_items.listing_title` (decode). Mitigated by `normalizeTitle` on both
  sides. Residual risk accepted: title is the chosen key. The show-token gate scopes
  matches so a normalized-title hit is checked against the right show.
- **`shipments.show_id` must be populated going forward.** Confirmed current shows
  carry it (legacy NULLs are out of scope). If a new shipment lacks `show_id`,
  find-item falls back to title-within-unpacked matching for that item.
- **C750 must be a 2D imager.** Verify with a phone-QR test before rollout; a 1D-only
  unit cannot read QR regardless of payload.

## Out of scope

- Backfilling legacy `show_id` or reprinting already-shipped labels.
- Giveaway items (not scanned at pack station).
- Any change to the 4×6 shipping-label flow (`LabelGenerator.tsx` / `print-labels`).
