#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="$ROOT/mobile/ios/Frameworks"
BUILD_DIR="$ROOT/mobile/ios/build/core"
XCFRAMEWORK="$OUT_DIR/LeverCore.xcframework"
MIN_IOS="17.0"

mkdir -p "$BUILD_DIR/ios" "$BUILD_DIR/sim" "$OUT_DIR"

DEV_SDK="$(xcrun --sdk iphoneos --show-sdk-path)"
SIM_SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
DEV_CLANG="$(xcrun --sdk iphoneos --find clang)"
SIM_CLANG="$(xcrun --sdk iphonesimulator --find clang)"

echo "Building LeverCore (iphoneos arm64)..."
(
  cd "$ROOT"
  CGO_ENABLED=1 GOOS=ios GOARCH=arm64 \
    CC="$DEV_CLANG -isysroot $DEV_SDK -arch arm64 -target arm64-apple-ios${MIN_IOS}" \
    CGO_CFLAGS="-isysroot $DEV_SDK -arch arm64 -target arm64-apple-ios${MIN_IOS}" \
    CGO_LDFLAGS="-isysroot $DEV_SDK -arch arm64 -target arm64-apple-ios${MIN_IOS}" \
    go build -trimpath -buildmode=c-archive -o "$BUILD_DIR/ios/libLeverCore.a" ./mobile/core
)

echo "Building LeverCore (iphonesimulator arm64)..."
(
  cd "$ROOT"
  CGO_ENABLED=1 GOOS=ios GOARCH=arm64 \
    CC="$SIM_CLANG -isysroot $SIM_SDK -arch arm64 -target arm64-apple-ios${MIN_IOS}-simulator" \
    CGO_CFLAGS="-isysroot $SIM_SDK -arch arm64 -target arm64-apple-ios${MIN_IOS}-simulator" \
    CGO_LDFLAGS="-isysroot $SIM_SDK -arch arm64 -target arm64-apple-ios${MIN_IOS}-simulator" \
    go build -trimpath -buildmode=c-archive -o "$BUILD_DIR/sim/libLeverCore.a" ./mobile/core
)

for slice in ios sim; do
  mkdir -p "$BUILD_DIR/$slice/headers"
  cp "$BUILD_DIR/$slice/libLeverCore.h" "$BUILD_DIR/$slice/headers/LeverCore.h"
  cat > "$BUILD_DIR/$slice/headers/module.modulemap" <<'EOF'
module LeverCore {
    header "LeverCore.h"
    export *
}
EOF
done

rm -rf "$XCFRAMEWORK"
xcodebuild -create-xcframework \
  -library "$BUILD_DIR/ios/libLeverCore.a" -headers "$BUILD_DIR/ios/headers" \
  -library "$BUILD_DIR/sim/libLeverCore.a" -headers "$BUILD_DIR/sim/headers" \
  -output "$XCFRAMEWORK"

echo "Built $XCFRAMEWORK"
