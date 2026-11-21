.PHONY: web build desktop package dev privacy test generate
TARGETS ?= darwin/arm64
web:
	pnpm --dir web install --frozen-lockfile
	pnpm --dir web build
build: web
	go build -o bin/lever ./cmd/lever
desktop: web
	go build -o bin/desktop/Lever ./cmd/lever-desktop
package: web
	go run github.com/egoist/mygo/cmd/mygo@v0.7.4 build -platform $(TARGETS) -skip-dmg -skip-installer desktop
dev:
	go run -tags dev ./cmd/lever --dev-origin http://127.0.0.1:5179
privacy:
	python3 scripts/privacy_check.py
test: privacy
	go test -race ./internal/...
	pnpm --dir web build
	pnpm --dir web test:e2e
generate:
	go run github.com/gzuidhof/tygo@v0.2.21 generate --config internal/model/tygo.yaml
	go run github.com/egoist/mygo/cmd/mygo@v0.7.4 generate desktop
