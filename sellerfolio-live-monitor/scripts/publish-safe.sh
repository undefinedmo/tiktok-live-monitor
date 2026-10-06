#!/usr/bin/env bash
# publish-safe.sh — build + publish a release with every guard this uplink needs.
#
# The dev machine's uplink corrupts large HTTPS uploads (TLS "bad record mac"),
# which kills electron-builder's own upload mid-publish and can leave a STALE
# latest.yml from the previous version in release/. This script wraps the whole
# ritual (run 6+ times by hand across v1.3.0–v1.3.5):
#   1. clean dist/ (stale bundles otherwise ship via files:["dist/**/*"])
#   2. npm run publish (electron-builder) — its upload failing is EXPECTED
#   3. ensure the GitHub release exists for the package.json version
#   4. installer asset: verify sha512 by re-download; delete+re-upload (rate-
#      limited HTTP/1.1 curl, retries) until it matches the local build
#   5. latest.yml: regenerate from the LOCAL installer if version/hash is stale,
#      then upload (replacing any bad copy)
#   6. un-draft: prerelease for X.Y.Z-rc.N, else full release + Latest
#
# Usage: bash scripts/publish-safe.sh            # full build + publish
#        bash scripts/publish-safe.sh --verify   # no build; verify/repair the
#                                                # existing release's assets only
set -u

cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
REPO=$(node -p "const b=require('./package.json').build.publish; b.owner+'/'+b.repo")
TAG="v$VERSION"
EXE="release/TikTok Live Monitor Setup $VERSION.exe"
ASSET_NAME="TikTok-Live-Monitor-Setup-$VERSION.exe"
export GH_TOKEN=${GH_TOKEN:-$(gh auth token)}
AUTH="Authorization: token $GH_TOKEN"

fail() { echo "✗ $1" >&2; exit 1; }
sha512() { openssl dgst -sha512 -binary "$1" | openssl base64 -A; }

# ── 0. quality gate — must run BEFORE anything is built or uploaded ──────────
# `npm run publish` carries the same gate, but step 2 below swallows its exit
# code with `|| echo` (electron-builder's upload is EXPECTED to fail here), so a
# typecheck/test failure would slip through and — if a stale installer for this
# version is still sitting in release/ — get published. Gate explicitly, and let
# it kill the script. v1.3.14 shipped a print-dedup regression that `tsc` would
# not have caught but the test suite now does; this is that lesson wired in.
if [ "${1:-}" != "--verify" ]; then
  echo "→ typecheck + tests"
  npm run verify || fail "typecheck/tests failed — refusing to build or publish"
fi

# ── 1+2. build + electron-builder publish (unless --verify) ──────────────────
if [ "${1:-}" != "--verify" ]; then
  rm -rf dist release/win-unpacked
  echo "→ building + publishing $TAG (electron-builder upload failure is expected)"
  npm run publish || echo "→ electron-builder failed (probably the TLS corruption) — repairing"
fi
[ -f "$EXE" ] || fail "no local installer at $EXE — build failed outright"
LOCAL_SHA=$(sha512 "$EXE")
LOCAL_SIZE=$(stat -c%s "$EXE")
echo "→ local installer: $LOCAL_SIZE bytes"

# ── 3. release must exist ────────────────────────────────────────────────────
REL=$(gh api "repos/$REPO/releases" --jq ".[] | select(.tag_name==\"$TAG\") | .id" | head -1)
if [ -z "$REL" ]; then
  echo "→ creating draft release $TAG"
  REL=$(gh api -X POST "repos/$REPO/releases" -f tag_name="$TAG" -f name="$VERSION" -F draft=true --jq .id) || fail "cannot create release"
fi
echo "→ release id $REL"

# ── 4. installer asset: verify-or-replace until sha512 matches ───────────────
verify_asset() { # $1=asset_id → 0 if remote sha matches local
  curl -sSL --retry 6 --retry-all-errors --retry-delay 4 -H "$AUTH" -H "Accept: application/octet-stream" \
    -o /tmp/psafe-verify.bin "https://api.github.com/repos/$REPO/releases/assets/$1" || return 1
  [ "$(sha512 /tmp/psafe-verify.bin)" = "$LOCAL_SHA" ]
}
for attempt in 1 2 3; do
  AID=$(gh api "repos/$REPO/releases/$REL" --jq ".assets[] | select(.name==\"$ASSET_NAME\") | .id" | head -1)
  if [ -n "$AID" ]; then
    echo "→ verifying uploaded installer (attempt $attempt)"
    if verify_asset "$AID"; then echo "✓ installer verified"; break; fi
    echo "→ uploaded installer corrupt/incomplete — deleting asset $AID"
    gh api -X DELETE "repos/$REPO/releases/assets/$AID" || true
    AID=""
  fi
  if [ -z "$AID" ]; then
    echo "→ uploading installer (rate-limited; mid-transfer TLS errors are retried)"
    curl --http1.1 --limit-rate 3M --retry 8 --retry-all-errors --retry-delay 5 -sS -o /tmp/psafe-up.json \
      -H "$AUTH" -H "Content-Type: application/octet-stream" --data-binary @"$EXE" \
      "https://uploads.github.com/repos/$REPO/releases/$REL/assets?name=$ASSET_NAME" || true
  fi
  [ "$attempt" = 3 ] && fail "installer still not verified after 3 attempts"
done
rm -f /tmp/psafe-verify.bin /tmp/psafe-up.json

# ── 5. latest.yml: regenerate if stale, then (re)upload ──────────────────────
YML=release/latest.yml
if [ ! -f "$YML" ] || [ "$(grep -m1 '^version:' "$YML" | awk '{print $2}')" != "$VERSION" ] \
   || [ "$(grep -m1 'sha512:' "$YML" | awk '{print $2}')" != "$LOCAL_SHA" ]; then
  echo "→ latest.yml stale/missing — regenerating from the verified local installer"
  printf "version: %s\nfiles:\n  - url: %s\n    sha512: %s\n    size: %s\npath: %s\nsha512: %s\nreleaseDate: '%s'\n" \
    "$VERSION" "$ASSET_NAME" "$LOCAL_SHA" "$LOCAL_SIZE" "$ASSET_NAME" "$LOCAL_SHA" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" > "$YML"
fi
YID=$(gh api "repos/$REPO/releases/$REL" --jq '.assets[] | select(.name=="latest.yml") | .id' | head -1)
[ -n "$YID" ] && gh api -X DELETE "repos/$REPO/releases/assets/$YID" >/dev/null 2>&1
curl --http1.1 --retry 8 --retry-all-errors --retry-delay 4 -sS -o /dev/null -w "→ latest.yml upload: HTTP %{http_code}\n" \
  -H "$AUTH" -H "Content-Type: application/octet-stream" --data-binary @"$YML" \
  "https://uploads.github.com/repos/$REPO/releases/$REL/assets?name=latest.yml" || fail "latest.yml upload failed"

# ── 6. go live ───────────────────────────────────────────────────────────────
case "$VERSION" in
  *-*) echo "→ publishing as PRE-release (version has a suffix)"
       gh api -X PATCH "repos/$REPO/releases/$REL" -F draft=false -F prerelease=true -f name="$VERSION" --jq '.html_url' ;;
  *)   echo "→ publishing as Latest"
       gh api -X PATCH "repos/$REPO/releases/$REL" -F draft=false -F prerelease=false -F make_latest=true -f name="$VERSION" --jq '.html_url' ;;
esac || fail "could not publish release"
echo "✓ $TAG published, installer + latest.yml verified"
