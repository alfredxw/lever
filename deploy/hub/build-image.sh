#!/usr/bin/env bash
set -euo pipefail
version=${1:-0.1.0}
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
arch=${HUB_ARCH:-$(go env GOARCH)}
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/data" "$stage/tmp"
chmod 700 "$stage/data" "$stage/tmp"
CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -trimpath -ldflags='-s -w' -o "$stage/lever-hub" ./cmd/lever-hub
for bundle in /etc/ssl/certs/ca-certificates.crt /etc/ssl/cert.pem; do
  if test -f "$bundle"; then cp -L "$bundle" "$stage/ca-certificates.crt"; break; fi
done
test -s "$stage/ca-certificates.crt"
cp deploy/hub/Dockerfile "$stage/"
docker build --platform "linux/$arch" -t "lever-hub:$version" "$stage"
