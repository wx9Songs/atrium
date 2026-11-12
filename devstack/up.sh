#!/bin/sh
# Local development stack: mock archive (8792) + hub (8791) + a runner that
# drives the fake agents in devstack/bin. Nothing here touches a real install.
#   devstack/up.sh          build and start everything (Ctrl-C stops it)
#   devstack/up.sh seed     also reset devstack/data to the made-up sessions first
# The page: `cd web && npx vite` (http://127.0.0.1:5199, proxies /api to the hub),
# or http://127.0.0.1:8791 for the page built into the hub.
set -e
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:$PATH"
if [ "$1" = seed ] || [ ! -d devstack/data/sessions ]; then node devstack/seed.mjs; fi
mkdir -p devstack/out cmd/atrium/webdist && touch cmd/atrium/webdist/.keep
go build -o devstack/out/atrium ./cmd/atrium
go build -o devstack/out/atrium-runner ./cmd/atrium-runner
trap 'kill 0' INT TERM EXIT
node devstack/mock-archive.mjs &
devstack/out/atrium serve --config devstack/hub.json &
sleep 0.5
PATH="$(pwd)/devstack/bin:$PATH" CLAUDE_CONFIG_DIR="$(pwd)/devstack/data/claude-home" CODEX_HOME="$(pwd)/devstack/data/codex-home" \
  devstack/out/atrium-runner --config devstack/runner.json &
wait
