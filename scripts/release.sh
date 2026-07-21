#!/usr/bin/env bash
# Release helper: builds Vector, signs the updater bundle, uploads the DMG +
# .app.tar.gz + .sig + latest.json to a GitHub release.
#
# Release notes come from the GitHub release body. If the release does not
# exist yet, one is created with notes auto-generated from commits since the
# previous tag. The latest.json manifest embeds those notes so the in-app
# updater can show "What's new".
#
# Requirements:
#   - gh CLI authenticated
#   - jq installed
#   - ~/.config/vector-updater/private.ke exists (Tauri updater private key)
#   - Run from the repo root
#
# Usage: scripts/release.sh
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"
KEY_PATH="${HOME}/.config/vector-updater/private.ke"
if [ ! -f "$KEY_PATH" ]; then
  echo "Missing ${KEY_PATH} — generate one with: npx tauri signer generate -w ${KEY_PATH}"
  exit 1
fi
command -v jq >/dev/null || { echo "jq is required (brew install jq)"; exit 1; }

echo "==> Building Vector ${VERSION}"
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_PATH")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
npm run tauri build

DMG="src-tauri/target/release/bundle/dmg/Vector_${VERSION}_aarch64.dmg"
TARBALL="src-tauri/target/release/bundle/macos/Vector.app.tar.gz"
SIG="src-tauri/target/release/bundle/macos/Vector.app.tar.gz.sig"
for f in "$DMG" "$TARBALL" "$SIG"; do
  [ -f "$f" ] || { echo "missing artifact: $f"; exit 1; }
done

V_TARBALL="src-tauri/target/release/bundle/macos/Vector_${VERSION}_aarch64.app.tar.gz"
V_SIG="${V_TARBALL}.sig"
cp "$TARBALL" "$V_TARBALL"
cp "$SIG" "$V_SIG"

# Create the release first (without assets) if it doesn't exist, so we have a
# body we can read back for the manifest.
if ! gh release view "$TAG" >/dev/null 2>&1; then
  PREV_TAG=$(git tag --sort=-v:refname | grep -v "^${TAG}\$" | head -1 || true)
  if [ -n "${PREV_TAG:-}" ]; then
    CHANGES=$(git log --pretty=format:'- %s' "${PREV_TAG}..HEAD" | grep -v -E '^- (chore|release):' || true)
    [ -n "$CHANGES" ] || CHANGES="Maintenance release."
  else
    CHANGES="Initial release."
  fi
  echo "==> Creating release ${TAG}"
  gh release create "$TAG" \
    --title "Vector ${VERSION} (Apple Silicon)" \
    --notes "$CHANGES"
fi

RELEASE_NOTES=$(gh release view "$TAG" --json body -q .body)
SIG_CONTENT=$(cat "$V_SIG")
PUB_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
MANIFEST="src-tauri/target/release/bundle/macos/latest.json"
URL="https://github.com/avram19/vector/releases/download/${TAG}/Vector_${VERSION}_aarch64.app.tar.gz"

jq -n \
  --arg version "$VERSION" \
  --arg notes "$RELEASE_NOTES" \
  --arg pub_date "$PUB_DATE" \
  --arg sig "$SIG_CONTENT" \
  --arg url "$URL" \
  '{version:$version, notes:$notes, pub_date:$pub_date, platforms:{"darwin-aarch64":{signature:$sig, url:$url}}}' \
  > "$MANIFEST"

# --- Linux updater entries ---------------------------------------------------
# The Linux AppImage bundles come from the CI build matrix
# (.github/workflows/build.yml, ubuntu-22.04 + ubuntu-22.04-arm legs), not from
# this (macOS-only) build. If those artifacts have been downloaded locally
# (e.g. via `gh run download <run-id> -D dist/linux`) before running this
# script, fold their signatures into the manifest and upload them alongside
# the macOS assets. Otherwise, skip them — this script still works standalone
# for a macOS-only release.
LINUX_DIR="dist/linux"
LINUX_UPLOAD_ASSETS=()

X86_TARBALL=$(find "$LINUX_DIR" -name "*_amd64.AppImage.tar.gz" 2>/dev/null | head -1 || true)
if [ -n "$X86_TARBALL" ] && [ -f "${X86_TARBALL}.sig" ]; then
  X86_SIG="${X86_TARBALL}.sig"
  X86_URL="https://github.com/avram19/vector/releases/download/${TAG}/$(basename "$X86_TARBALL")"
  jq --arg sig "$(cat "$X86_SIG")" --arg url "$X86_URL" \
    '.platforms["linux-x86_64"] = {signature:$sig, url:$url}' \
    "$MANIFEST" > "${MANIFEST}.tmp" && mv "${MANIFEST}.tmp" "$MANIFEST"
  LINUX_UPLOAD_ASSETS+=("$X86_TARBALL" "$X86_SIG")
else
  echo "==> No linux-x86_64 AppImage found under ${LINUX_DIR}; skipping linux-x86_64 manifest entry"
fi

ARM_TARBALL=$(find "$LINUX_DIR" -name "*_aarch64.AppImage.tar.gz" 2>/dev/null | head -1 || true)
if [ -n "$ARM_TARBALL" ] && [ -f "${ARM_TARBALL}.sig" ]; then
  ARM_SIG="${ARM_TARBALL}.sig"
  ARM_URL="https://github.com/avram19/vector/releases/download/${TAG}/$(basename "$ARM_TARBALL")"
  jq --arg sig "$(cat "$ARM_SIG")" --arg url "$ARM_URL" \
    '.platforms["linux-aarch64"] = {signature:$sig, url:$url}' \
    "$MANIFEST" > "${MANIFEST}.tmp" && mv "${MANIFEST}.tmp" "$MANIFEST"
  LINUX_UPLOAD_ASSETS+=("$ARM_TARBALL" "$ARM_SIG")
else
  echo "==> No linux-aarch64 AppImage found under ${LINUX_DIR}; skipping linux-aarch64 manifest entry"
fi

echo "==> Manifest:"; cat "$MANIFEST"

echo "==> Uploading assets to ${TAG}"
gh release upload "$TAG" "$DMG" "$V_TARBALL" "$V_SIG" "$MANIFEST" \
  "${LINUX_UPLOAD_ASSETS[@]+"${LINUX_UPLOAD_ASSETS[@]}"}" --clobber

echo "==> Done. https://github.com/avram19/vector/releases/tag/${TAG}"
