#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-simulator}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IOS_DIR="$ROOT/mobile/ios"
PROJ="$IOS_DIR/Lever.xcodeproj"
BUILD_ROOT="$IOS_DIR/build"

bash "$IOS_DIR/build-core.sh"
python3 "$IOS_DIR/generate-xcodeproj.py"

case "$MODE" in
  simulator)
    DERIVED="$BUILD_ROOT/sim"
    xcodebuild \
      -project "$PROJ" \
      -scheme Lever \
      -configuration Debug \
      -sdk iphonesimulator \
      -destination 'generic/platform=iOS Simulator' \
      -derivedDataPath "$DERIVED" \
      ARCHS=arm64 \
      ENABLE_DEBUG_DYLIB=NO \
      CODE_SIGN_ENTITLEMENTS="" \
      CODE_SIGN_IDENTITY="-" \
      CODE_SIGN_STYLE=Manual \
      build

    OUT_DIR="$ROOT/mobile/dist/ios-simulator"
    mkdir -p "$OUT_DIR"
    rm -rf "$OUT_DIR/Lever.app"
    cp -R "$DERIVED/Build/Products/Debug-iphonesimulator/Lever.app" "$OUT_DIR/Lever.app"
    echo "Built $OUT_DIR/Lever.app"
    ;;

  device)
    TEAM="${IOS_TEAM:-}"
    if [[ -z "$TEAM" ]]; then
      TEAM="$(security find-certificate -c "Apple Development" -p 2>/dev/null | openssl x509 -noout -subject 2>/dev/null | sed -n 's/.*OU=\([A-Z0-9]\{10\}\).*/\1/p' | head -n 1 || true)"
    fi
    if [[ -z "$TEAM" ]]; then
      echo "error: no Apple Development team found; pass IOS_TEAM=<TEAM_ID>" >&2
      exit 1
    fi

    ARCHIVE="$BUILD_ROOT/Lever.xcarchive"
    EXPORT_DIR="$BUILD_ROOT/export"
    EXPORT_PLIST="$BUILD_ROOT/ExportOptions.plist"
    rm -rf "$ARCHIVE" "$EXPORT_DIR"
    mkdir -p "$BUILD_ROOT"

    cat > "$EXPORT_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>development</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>teamID</key>
	<string>${TEAM}</string>
</dict>
</plist>
EOF

    xcodebuild \
      -project "$PROJ" \
      -scheme Lever \
      -configuration Release \
      -sdk iphoneos \
      -destination 'generic/platform=iOS' \
      -archivePath "$ARCHIVE" \
      DEVELOPMENT_TEAM="$TEAM" \
      -allowProvisioningUpdates \
      archive

    xcodebuild \
      -exportArchive \
      -archivePath "$ARCHIVE" \
      -exportPath "$EXPORT_DIR" \
      -exportOptionsPlist "$EXPORT_PLIST" \
      -allowProvisioningUpdates

    OUT_DIR="$ROOT/mobile/dist/ios-arm64"
    mkdir -p "$OUT_DIR"
    cp "$EXPORT_DIR/Lever.ipa" "$OUT_DIR/Lever.ipa"
    echo "Built $OUT_DIR/Lever.ipa"
    ;;

  *)
    echo "usage: $0 [simulator|device]" >&2
    exit 1
    ;;
esac
