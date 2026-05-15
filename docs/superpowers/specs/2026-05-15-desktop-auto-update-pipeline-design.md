# Desktop Auto-Update Pipeline

**Date:** 2026-05-15
**Status:** Approved, ready for implementation plan
**Owner:** Mo Raad

## Problem

The SellerFolio desktop app has `electron-updater` wired correctly in code, but the release pipeline is broken in ways that prevent any update from reaching a user:

1. **v1.0.1 release on `greenerytx/LuxeSense` is a draft** and missing the 97 MB `.exe` installer (only `latest.yml` + `.blockmap` were uploaded). electron-updater ignores draft releases.
2. **productName changed from `LuxeSense` to `SellerFolio`** between 1.0.0 and 1.0.1. NSIS uses productName as the install directory and uninstall key — existing 1.0.0 installs would not be upgraded; users would end up with two apps side-by-side.
3. **No CI workflow.** Releases depend on someone running `npm run publish` locally with `GH_TOKEN` set, which is fragile (the missing 1.0.1 .exe was likely a partial publish).
4. **Source repo (`sellerfolio-platform`) has no GitHub remote.** Cannot trigger workflows from tag pushes.
5. **Workspace dependency** `@sellerfolio/shared` lives at `LuxeSense/packages/shared` — outside `sellerfolio-platform/`. Pushing only the platform directory leaves CI unable to resolve the dep.

There are no production users of v1.0.0 (sole user is the developer), so no migration logic is needed.

## Goals

- A `git tag desktop-v1.0.2 && git push --tags` triggers an automated build that publishes a working installer.
- Installed clients can detect, download, and install updates without manual intervention.
- The release pipeline is fully reproducible from a clean checkout — no local environment dependencies beyond a GitHub PAT.
- Source code stays in a private repo; installer assets are publicly downloadable so electron-updater works without baking tokens into the app.

## Non-Goals

- **Code signing.** Windows SmartScreen warnings will persist. Acceptable for current usage; revisit before any external user.
- **Mac/Linux builds.** Windows-only.
- **Update channels** (beta/stable). Single channel.
- **Migrating any existing 1.0.0 install.** No users to migrate.
- **Splitting `@sellerfolio/shared` into a published package.** Vendored for now; revisit if drift becomes painful.

## Architecture

Two new GitHub repositories owned by `greenerytx`:

| Repo | Visibility | Purpose |
|---|---|---|
| `sellerfolio-platform` | private | Source code + GitHub Actions release workflow |
| `sellerfolio-releases` | public | Hosts installer assets only — target of electron-updater |

The existing `greenerytx/LuxeSense` repo is archived (not deleted; preserved for reference).

```
git tag desktop-v1.0.2
        │
        ▼
push to greenerytx/sellerfolio-platform
        │
        ▼
.github/workflows/desktop-release.yml on windows-latest
   pnpm install --frozen-lockfile
   cd desktop && pnpm run publish
        │
        ▼
electron-builder publishes installer + latest.yml + .blockmap
   target: greenerytx/sellerfolio-releases (public)
   auth:   RELEASES_REPO_TOKEN (fine-grained PAT)
        │
        ▼
Installed client checks https://github.com/greenerytx/sellerfolio-releases/releases/latest
   downloads SellerFolio-Setup-1.0.2.exe (no auth required, public repo)
   verifies SHA-512 against latest.yml
   prompts user to install
```

## Repository Layout (sellerfolio-platform after changes)

```
sellerfolio-platform/
├── .github/
│   └── workflows/
│       └── desktop-release.yml      [NEW]
├── packages/
│   └── shared/                      [NEW — vendored from LuxeSense/packages/shared]
├── desktop/
│   ├── package.json                  [MODIFIED — publish.repo, version]
│   └── ... (unchanged)
├── web/
├── middleware/
├── docs/
├── pnpm-workspace.yaml              [NEW — workspace root]
├── package.json                     [NEW — root workspace package]
└── .gitignore                        [MODIFIED — ensure desktop/release/ excluded]
```

## Components

### 1. Vendored shared package

Copy `LuxeSense/packages/shared/` → `sellerfolio-platform/packages/shared/` byte-for-byte (including `dist/`, `src/`, `package.json`, `tsconfig.json`, `tsup.config.ts`).

Add `sellerfolio-platform/pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
  - "desktop"
```

Add `sellerfolio-platform/package.json` (workspace root):

```json
{
  "name": "sellerfolio-platform",
  "private": true,
  "scripts": {
    "build:shared": "pnpm --filter @sellerfolio/shared build",
    "build:desktop": "pnpm --filter sellerfolio-desktop build",
    "publish:desktop": "pnpm --filter sellerfolio-desktop publish"
  },
  "engines": {
    "node": ">=20.0.0",
    "pnpm": ">=8.0.0"
  }
}
```

`desktop/package.json` already declares `"@sellerfolio/shared": "workspace:*"` — no change needed there.

**Sync policy:** vendored copy is the source of truth for `sellerfolio-platform`. If `LuxeSense/packages/shared` evolves and the platform needs the change, copy it in manually and commit. No automated sync.

### 2. Updated desktop publish config

`desktop/package.json`:

```diff
   "version": "1.0.1",
+  "version": "1.0.2",
...
   "publish": {
     "provider": "github",
     "owner": "greenerytx",
-    "repo": "LuxeSense"
+    "repo": "sellerfolio-releases"
   }
```

Version bump to 1.0.2 skips the botched 1.0.1 draft. The new releases repo starts clean.

### 3. GitHub Actions workflow

`.github/workflows/desktop-release.yml`:

```yaml
name: Desktop Release

on:
  push:
    tags:
      - 'desktop-v*'

jobs:
  release:
    runs-on: windows-latest
    permissions:
      contents: read
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v3
        with:
          version: 9

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build shared package
        run: pnpm --filter @sellerfolio/shared build

      - name: Publish desktop release
        working-directory: desktop
        env:
          GH_TOKEN: ${{ secrets.RELEASES_REPO_TOKEN }}
        run: pnpm run publish
```

`pnpm run publish` in desktop already runs `tsc && vite build && electron-builder --publish always`. electron-builder reads `publish.repo` from `package.json` and uses `GH_TOKEN` to authenticate against `greenerytx/sellerfolio-releases`.

### 4. RELEASES_REPO_TOKEN secret

Fine-grained personal access token:

- **Repository access:** only `greenerytx/sellerfolio-releases`
- **Permissions:** Contents → Read and write
- **Expiration:** 1 year (calendar reminder to rotate)

Stored as `RELEASES_REPO_TOKEN` in `sellerfolio-platform` repo secrets. Exposed to the workflow step as `GH_TOKEN` (the env var name electron-builder expects).

The default `GITHUB_TOKEN` cannot be used because it is scoped to the workflow's own repo, and we publish to a different repo.

### 5. .gitignore additions

Ensure `desktop/release/` is gitignored (it currently contains build artifacts that shouldn't be committed). Add if missing.

## Release Process (after implementation)

```
# 1. Bump version in desktop/package.json
# 2. Commit + push
git add desktop/package.json
git commit -m "chore: bump desktop to 1.0.2"
git push

# 3. Tag and push the tag
git tag desktop-v1.0.2
git push origin desktop-v1.0.2

# 4. Watch the workflow at github.com/greenerytx/sellerfolio-platform/actions
# 5. Verify release at github.com/greenerytx/sellerfolio-releases/releases
# 6. Installed clients pick up the update on next launch (3s after start)
```

## Failure Modes & Handling

| Failure | Detection | Recovery |
|---|---|---|
| Workflow fails during build (tsc/vite error) | GitHub Actions UI shows red X | Fix code, re-tag with same version (delete old tag first), re-push |
| `electron-builder --publish always` fails after partial upload | Workflow log shows error; release on releases repo is partial/missing assets | Manually delete the GitHub release, re-tag, re-push |
| `RELEASES_REPO_TOKEN` expired | Workflow fails with 401 from GitHub API | Generate new fine-grained PAT, update secret in `sellerfolio-platform` settings |
| Client cannot reach github.com | electron-updater logs error event; `update-status` IPC sends `{status: 'error'}` | App continues to work normally; user can retry from Settings |
| `latest.yml` references file that doesn't exist | Client logs 404 on download | Re-publish the release (delete + re-tag) |

## Testing

- **Pre-release smoke test:** before tagging the first 1.0.2 release, run `pnpm install` in a fresh clone of `sellerfolio-platform` and verify `cd desktop && pnpm run build` succeeds locally.
- **Update flow validation:** after 1.0.2 ships, install it, then bump to 1.0.3 and tag. Confirm the running 1.0.2 client detects, downloads, and installs the update.

## Migration Steps (one-time)

These execute the design and replace the current broken state:

1. Create private repo `greenerytx/sellerfolio-platform`
2. Create public repo `greenerytx/sellerfolio-releases`
3. Generate `RELEASES_REPO_TOKEN` PAT, store as secret on `sellerfolio-platform`
4. Vendor `packages/shared/` into `sellerfolio-platform/packages/shared/`
5. Add root `package.json` and `pnpm-workspace.yaml`
6. Update `desktop/package.json` (version 1.0.2, repo `sellerfolio-releases`)
7. Add `.github/workflows/desktop-release.yml`
8. Local verification: `pnpm install && pnpm --filter @sellerfolio/shared build && pnpm --filter sellerfolio-desktop build` from platform root
9. Initial commit + push to GitHub
10. Tag `desktop-v1.0.2` and push tag → first automated release
11. Verify installer on `sellerfolio-releases`, install it, manually trigger `updater:check` from Settings to confirm "no update available"
12. Bump to 1.0.3, repeat to confirm full upgrade flow
13. Archive `greenerytx/LuxeSense`

## Open Questions

None remaining at design time.
