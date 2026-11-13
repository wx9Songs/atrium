#!/usr/bin/env bash
# Builds everything a release carries, into dist/release/ (run on a Mac with Go, Node and Xcode):
#
#   atrium-VERSION-<os>-<arch>.tar.gz   for linux and macOS, amd64 and arm64: the hub, the runner,
#                                       the install scripts and the docs. Unpack it and run the
#                                       scripts from there; nothing needs to be compiled.
#   Atrium-VERSION.dmg                  the macOS app, for Apple silicon and Intel
#   SHA256SUMS
#
#   scripts/release.sh            build
#   scripts/release.sh publish    build, then create the GitHub release vVERSION with these files
#
# The app is signed ad hoc, not with a Developer ID, so macOS asks before opening it the
# first time. The release notes say how.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${VERSION:-$(sed -n 's/^var version = "\(.*\)"$/\1/p' cmd/atrium/main.go)}"
[ -n "$VERSION" ] || { echo "cannot read the version from cmd/atrium/main.go" >&2; exit 1; }
OUT="dist/release"
rm -rf "$OUT"; mkdir -p "$OUT"

echo "==> page"
(cd web && npm install --no-audit --no-fund >/dev/null && npx tsc --noEmit && npx vite build >/dev/null)
touch cmd/atrium/webdist/.keep

echo "==> hub and runner"
for t in linux/amd64 linux/arm64 darwin/arm64 darwin/amd64; do
  os=${t%/*}; arch=${t#*/}; name="atrium-$VERSION-$os-$arch"; dir="$OUT/$name"
  mkdir -p "$dir/bin" "$dir/scripts" "$dir/docs"
  GOOS=$os GOARCH=$arch CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "$dir/bin/atrium" ./cmd/atrium
  GOOS=$os GOARCH=$arch CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "$dir/bin/atrium-runner" ./cmd/atrium-runner
  cp scripts/local-install.sh scripts/machine-install.sh scripts/server-install.sh scripts/atrium-machine "$dir/scripts/"
  cp docs/install.md "$dir/docs/"
  cp README.md README.zh-CN.md LICENSE NOTICE "$dir/"
  # COPYFILE_DISABLE keeps macOS from adding ._ files that Linux tar complains about.
  COPYFILE_DISABLE=1 tar -czf "$OUT/$name.tar.gz" -C "$OUT" "$name"
  rm -rf "$dir"
  echo "    $name.tar.gz"
done

echo "==> macOS app"
VERSION="$VERSION" UNIVERSAL=1 ./app/build.sh | tail -1
STAGE="$(mktemp -d)"
ditto app/dist/Atrium.app "$STAGE/Atrium.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -quiet -volname "Atrium $VERSION" -srcfolder "$STAGE" -ov -format UDZO "$OUT/Atrium-$VERSION.dmg"
rm -rf "$STAGE"
echo "    Atrium-$VERSION.dmg ($(lipo -archs app/dist/Atrium.app/Contents/MacOS/Atrium))"

(cd "$OUT" && shasum -a 256 *.tar.gz *.dmg > SHA256SUMS)
echo "==> $OUT"; ls -lh "$OUT" | awk 'NR>1 {print "    " $5 "  " $9}'

if [ "${1:-}" = publish ]; then
  NOTES="${NOTES:-docs/release-notes/v$VERSION.md}"
  [ -f "$NOTES" ] || { echo "release notes not found: $NOTES" >&2; exit 1; }
  git diff --quiet && git diff --cached --quiet || { echo "commit your changes first" >&2; exit 1; }
  gh release create "v$VERSION" --title "Atrium $VERSION" --notes-file "$NOTES" "$OUT"/*.tar.gz "$OUT"/*.dmg "$OUT/SHA256SUMS"
fi
