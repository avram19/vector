#!/usr/bin/env bash
# Release helper: builds Vector, signs the updater bundle, uploads the DMG +
# .app.tar.gz + .sig + latest.json to a GitHub release.
#
# Requirements:
#   - gh CLI authenticated
#   - ~/.config/vector-updater/private.key exists (Tauri updater private key)
#   - Run from the repo root
#
# Usage: scripts/release.sh
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"
KEY_PATH="${HOME}/.config/vector-updater/private.key"
if [ ! -f "$KEY_PATH" ]; then
  echo "Missing ${KEY_PATH} — generate one with: npx tauri signer generate -w ${KEY_PATH}"
  exit 1
fi

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

# Rename tarball to versioned asset for a stable URL.
V_TARBALL="src-tauri/target/release/bundle/macos/Vector_${VERSION}_aarch64.app.tar.gz"
V_SIG="${V_TARBALL}.sig"
cp "$TARBALL" "$V_TARBALL"
cp "$SIG" "$V_SIG"

MANIFEST="src-tauri/target/release/bundle/macos/latest.json"
SIG_CONTENT=$(cat "$V_SIG")
PUB_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

cat > "$MANIFEST" <<EOF
{
  "version": "${VERSION}",
  "notes": "See https://github.com/avram19/vector/releases/tag/${TAG}",
  "pub_date": "${PUB_DATE}",
  "platforms": {
    "darwin-aarch64": {
      "signature": "${SIG_CONTENT}",
      "url": "https://github.com/avram19/vector/releases/download/${TAG}/Vector_${VERSION}_aarch64.app.tar.gz"
    }
  }
}
EOF

echo "==> Manifest:"; cat "$MANIFEST"

if gh release view "$TAG" >/dev/null 2>&1; then
  echo "==> Uploading assets to existing release ${TAG}"
  gh release upload "$TAG" "$DMG" "$V_TARBALL" "$V_SIG" "$MANIFEST" --clobber
else
  echo "==> Creating release ${TAG}"
  gh release create "$TAG" "$DMG" "$V_TARBALL" "$V_SIG" "$MANIFEST" \
    --title "Vector ${VERSION} (Apple Silicon)" \
    --notes "Auto-generated release for ${TAG}. Update via the in-app banner or download the DMG."
fi

echo "==> Done. https://github.com/avram19/vector/releases/tag/${TAG}"
