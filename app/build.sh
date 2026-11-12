#!/bin/sh
# Builds app/dist/Atrium.app. Needs the Xcode command line tools (swift, iconutil, codesign).
set -e
cd "$(dirname "$0")"
VERSION="${VERSION:-0.1.0}"
swift build -c release 2>&1 | tail -3
BIN="$(swift build -c release --show-bin-path)/Atrium"
APP="dist/Atrium.app"
mkdir -p dist
[ -d "$APP" ] && mv "$APP" "dist/.old-$$.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Atrium"

ICONSET="dist/AppIcon.iconset"; mkdir -p "$ICONSET"
swift make-icon.swift dist/icon-1024.png
for s in 16 32 128 256 512; do
  sips -z $s $s dist/icon-1024.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2)); sips -z $d $d dist/icon-1024.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Atrium</string>
  <key>CFBundleDisplayName</key><string>Atrium</string>
  <key>CFBundleIdentifier</key><string>dev.atrium.app</string>
  <key>CFBundleExecutable</key><string>Atrium</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHumanReadableCopyright</key><string>MIT License</string>
  <!-- The page is usually served over plain http on loopback (through an SSH tunnel). -->
  <key>NSAppTransportSecurity</key><dict>
    <key>NSAllowsLocalNetworking</key><true/>
    <key>NSAllowsArbitraryLoadsInWebContent</key><true/>
  </dict>
</dict></plist>
PLIST
codesign --force --sign - "$APP" 2>/dev/null
echo "built $(pwd)/$APP"
