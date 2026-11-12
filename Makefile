# Atrium build. Needs Go 1.22+ and Node 18+.
GOFLAGS := -trimpath -ldflags "-s -w"
ARCH ?= amd64

.PHONY: all web server server-linux runner runners app

all: server runner

web:
	cd web && npm install --no-audit --no-fund && npx tsc --noEmit && npx vite build
	@touch cmd/atrium/webdist/.keep   # the build empties the folder; the placeholder keeps a fresh clone compiling

# The hub embeds the built web page, so it depends on `web`.
server: web
	CGO_ENABLED=0 go build $(GOFLAGS) -o bin/atrium ./cmd/atrium

# Server binary for a Linux host, built from any OS:  make server-linux ARCH=amd64
server-linux: web
	GOOS=linux GOARCH=$(ARCH) CGO_ENABLED=0 go build $(GOFLAGS) -o bin/linux-$(ARCH)/atrium ./cmd/atrium

runner:
	CGO_ENABLED=0 go build $(GOFLAGS) -o bin/atrium-runner ./cmd/atrium-runner

# Runner for every supported platform.
runners:
	for t in linux/amd64 linux/arm64 darwin/arm64 darwin/amd64; do \
	  GOOS=$${t%/*} GOARCH=$${t#*/} CGO_ENABLED=0 go build $(GOFLAGS) -o bin/$${t%/*}-$${t#*/}/atrium-runner ./cmd/atrium-runner; \
	done

# macOS desktop app (needs Xcode command line tools).
app:
	./app/build.sh
