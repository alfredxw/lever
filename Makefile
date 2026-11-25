.PHONY: web hub-web hub hub-image hub-deploy mobile-ios mobile-ios-simulator mobile-android build desktop package dev privacy test generate
VERSION ?= 0.1.0
TARGETS ?= darwin/arm64
PACKAGE_FLAGS ?= -skip-dmg -skip-installer
MYGO_IOS_CLI := github.com/egoist/mygo/cmd/mygo@v0.10.1-0.20261118115623-e1e4364ce377
web:
	pnpm --dir web install --frozen-lockfile
	pnpm --dir web build
build: web
	go build -o bin/lever ./cmd/lever
desktop: web
	go build -o bin/desktop/Lever ./cmd/lever-desktop
package: web
	go run github.com/egoist/mygo/cmd/mygo@v0.10.0 build -platform $(TARGETS) $(PACKAGE_FLAGS) desktop
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
	go run github.com/egoist/mygo/cmd/mygo@v0.10.0 generate desktop


hub-web:
	pnpm --dir web install --frozen-lockfile
	pnpm --dir web exec tsc -b
	pnpm --dir web exec vite build --mode hub
hub: hub-web
	go build -trimpath -o bin/lever-hub ./cmd/lever-hub
hub-image: hub-web
	bash deploy/hub/build-image.sh $(VERSION)
hub-deploy:
	mkdir -p output/remote
	COPYFILE_DISABLE=1 tar -czf output/remote/lever-hub-deploy-$(VERSION).tar.gz -C deploy/hub compose.yaml .env.example README.md
mobile-ios: hub-web
	go run $(MYGO_IOS_CLI) build -platform ios mobile
	python3 mobile/sign_ios_keychain.py mobile/dist/ios-arm64/*.ipa
mobile-ios-simulator: hub-web
	go run $(MYGO_IOS_CLI) build -platform ios/simulator mobile
mobile-android: hub-web
	go run github.com/egoist/mygo/cmd/mygo@v0.10.0 build -platform android mobile
