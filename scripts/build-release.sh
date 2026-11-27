#!/usr/bin/env bash
set -euo pipefail

package_dir=output/release
mkdir -p "$package_dir"

collect_desktop_updates() {
  local dist_dir="$1"
  local target="$2"
  local manifest="$dist_dir/update-$target.json"
  local archive="$dist_dir/lever-$VERSION-$target.tar.gz"
  if [[ "$SIGN_RELEASE" != true ]]; then
    return 0
  fi
  test -s "$manifest"
  test -s "$archive"
  cp "$manifest" "$package_dir/"
  cp "$archive" "$package_dir/"
  shopt -s nullglob
  local delta
  for delta in "$dist_dir"/lever-*-to-"$VERSION"-"$target".delta; do
    test -s "$delta"
    cp "$delta" "$package_dir/"
  done
  shopt -u nullglob
}

case "$1" in
  macos)
    identity=-
    package_flags="-sign - -skip-notarize"
    if [[ "$SIGN_RELEASE" == true ]]; then
      : "${MACOS_SIGNING_P12_BASE64:?Set the MACOS_SIGNING_P12_BASE64 secret}"
      : "${MACOS_SIGNING_P12_PASSWORD:?Set the MACOS_SIGNING_P12_PASSWORD secret}"
      : "${APPLE_NOTARY_KEY_P8:?Set the APPLE_NOTARY_KEY_P8 secret}"
      : "${APPLE_NOTARY_KEY_ID:?Set the APPLE_NOTARY_KEY_ID secret}"
      : "${APPLE_NOTARY_ISSUER_ID:?Set the APPLE_NOTARY_ISSUER_ID secret}"
      : "${MYGO_UPDATER_PRIVATE_KEY:?Set the MYGO_UPDATER_PRIVATE_KEY secret}"
      umask 077
      signing_dir=$(mktemp -d)
      keychain="$signing_dir/lever.keychain-db"
      trap 'security delete-keychain "$keychain" || true; rm -rf "$signing_dir"' EXIT
      keychain_password=$(openssl rand -hex 32)
      echo "::add-mask::$keychain_password"
      printf '%s' "$MACOS_SIGNING_P12_BASE64" | base64 -D > "$signing_dir/cert.p12"
      printf '%s\n' "$APPLE_NOTARY_KEY_P8" > "$signing_dir/AuthKey.p8"
      security create-keychain -p "$keychain_password" "$keychain"
      security set-keychain-settings -lut 21600 "$keychain"
      security unlock-keychain -p "$keychain_password" "$keychain"
      security import "$signing_dir/cert.p12" -k "$keychain" -P "$MACOS_SIGNING_P12_PASSWORD" -T /usr/bin/codesign
      security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain" >/dev/null
      security list-keychains -d user -s "$keychain"
      security default-keychain -d user -s "$keychain"
      identity=$(security find-identity -v -p codesigning "$keychain" | awk '/Developer ID Application:/ { print $2 }')
      if ! [[ "$identity" =~ ^[A-Fa-f0-9]{40}$ ]]; then
        echo 'The imported keychain must contain one Developer ID Application identity.' >&2
        exit 1
      fi
      xcrun notarytool store-credentials lever-notary --keychain "$keychain" \
        --key "$signing_dir/AuthKey.p8" --key-id "$APPLE_NOTARY_KEY_ID" --issuer "$APPLE_NOTARY_ISSUER_ID"
      package_flags="-sign $identity"
      unset MACOS_SIGNING_P12_BASE64 MACOS_SIGNING_P12_PASSWORD APPLE_NOTARY_KEY_P8
      umask 022
    else
      unset MYGO_UPDATER_PRIVATE_KEY
    fi

    make package TARGETS=darwin/arm64 PACKAGE_FLAGS="$package_flags"
    app=desktop/dist/darwin-arm64/Lever.app
    codesign --verify --deep --strict "$app"
    if [[ "$(lipo -archs "$app/Contents/MacOS/Lever")" != arm64 ]]; then
      echo 'Expected an Apple Silicon executable.' >&2
      exit 1
    fi
    dmg="$package_dir/lever-$VERSION-macos-arm64.dmg"
    mv "desktop/dist/darwin-arm64/lever-$VERSION-arm64.dmg" "$dmg"
    if [[ "$SIGN_RELEASE" == true ]]; then
      xcrun stapler validate "$app"
      xcrun stapler validate "$dmg"
    fi
    hdiutil verify "$dmg"
    collect_desktop_updates "desktop/dist/darwin-arm64" "darwin-arm64"
    ;;
  windows)
    if [[ "$SIGN_RELEASE" == true ]]; then
      : "${MYGO_UPDATER_PRIVATE_KEY:?Set the MYGO_UPDATER_PRIVATE_KEY secret}"
    else
      unset MYGO_UPDATER_PRIVATE_KEY
    fi
    pnpm --dir web install --frozen-lockfile
    pnpm --dir web build
    mygo_version=$(go list -m -f '{{.Version}}' github.com/egoist/mygo)
    go run "github.com/egoist/mygo/cmd/mygo@$mygo_version" build -platform windows/amd64 desktop
    mv "desktop/dist/windows-amd64/lever-setup-$VERSION-amd64.exe" \
      "$package_dir/lever-$VERSION-windows-amd64-setup.exe"
    collect_desktop_updates "desktop/dist/windows-amd64" "windows-amd64"
    ;;
  android)
    apk="$package_dir/lever-mobile-$VERSION-android.apk"
    build_tools="$ANDROID_HOME/build-tools/36.0.0"
    source_apk="mobile/dist/android/lever-mobile-$VERSION.apk"
    if [[ "$SIGN_RELEASE" == true ]]; then
      : "${ANDROID_KEYSTORE_BASE64:?Set the ANDROID_KEYSTORE_BASE64 secret}"
      : "${ANDROID_KEYSTORE_PASSWORD:?Set the ANDROID_KEYSTORE_PASSWORD secret}"
      : "${ANDROID_KEY_ALIAS:?Set the ANDROID_KEY_ALIAS secret}"
      umask 077
      signing_dir=$(mktemp -d)
      trap 'rm -rf "$signing_dir"' EXIT
      printf '%s' "$ANDROID_KEYSTORE_BASE64" | base64 -d > "$signing_dir/lever.keystore"
      export ANDROID_KEY_PASSWORD="${ANDROID_KEY_PASSWORD:-$ANDROID_KEYSTORE_PASSWORD}"
      "$build_tools/apksigner" sign --ks "$signing_dir/lever.keystore" \
        --ks-key-alias "$ANDROID_KEY_ALIAS" --ks-pass env:ANDROID_KEYSTORE_PASSWORD \
        --key-pass env:ANDROID_KEY_PASSWORD --out "$apk" "$source_apk"
    else
      cp "$source_apk" "$apk"
    fi
    signer=$("$build_tools/apksigner" verify --print-certs "$apk")
    printf '%s\n' "$signer"
    if [[ "$SIGN_RELEASE" == true && "$signer" == *'CN=Android Debug'* ]]; then
      echo 'The release APK requires a distribution key.' >&2
      exit 1
    fi
    package=$("$build_tools/aapt" dump badging "$apk")
    [[ "$package" == *"package: name='app.lever.mobile'"*"versionName='$VERSION'"* ]]
    [[ "$package" == *"'arm64-v8a'"* ]]
    ;;
  hub)
    grep -Fxq "LEVER_HUB_IMAGE=lever-hub:$VERSION" deploy/hub/.env.example
    grep -Fq "\${LEVER_HUB_IMAGE:-lever-hub:$VERSION}" deploy/hub/compose.yaml
    docker compose --env-file deploy/hub/.env.example -f deploy/hub/compose.yaml config --quiet
    for arch in arm64 amd64; do
      image="lever-hub:$VERSION"
      HUB_ARCH="$arch" bash deploy/hub/build-image.sh "$VERSION"
      [[ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")" == "linux/$arch" ]]
      docker save "$image" | gzip -n > "$package_dir/lever-hub-$VERSION-linux-$arch.tar.gz"
    done
    container=$(docker run --rm -d -p 127.0.0.1::8090 "$image" --listen :8090)
    trap 'docker stop "$container" >/dev/null' EXIT
    endpoint=$(docker port "$container" 8090/tcp)
    curl --fail --silent --show-error --retry 5 --retry-connrefused "http://$endpoint/healthz"
    make hub-deploy VERSION="$VERSION"
    mv "output/remote/lever-hub-deploy-$VERSION.tar.gz" "$package_dir/"
    ;;
  *)
    echo "Unknown release target: $1" >&2
    exit 1
    ;;
esac
