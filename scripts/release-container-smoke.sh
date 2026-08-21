#!/bin/sh
# Run the installed release bundle through the real CLI in a disposable
# glibc container. The local fake provider keeps this deterministic and free.
set -eu

die() {
    echo "vera container smoke: $*" >&2
    exit 1
}

[ "$#" -eq 2 ] || die "usage: $0 <linux-x64-archive> <version>"
archive=$1
version=$2
[ -f "$archive" ] || die "archive not found: $archive"
[ -f "$archive.sha256" ] || die "checksum sidecar not found: $archive.sha256"
if ! printf '%s\n' "$version" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
    die "version must be a stable semver: $version"
fi
command -v docker >/dev/null 2>&1 || die "required command not found: docker"

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
archive_name=$(basename -- "$archive")
release_root=$(mktemp -d "${TMPDIR:-/tmp}/vera-container-release.XXXXXX")
cleanup() {
    rm -rf "$release_root"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$release_root/latest/download"
cp "$archive" "$release_root/latest/download/$archive_name"
cp "$archive.sha256" "$release_root/latest/download/$archive_name.sha256"

docker run --platform linux/amd64 --rm --init \
    -e VERA_TEST_VERSION="$version" \
    -v "$release_root:/releases:ro" \
    -v "$root/install:/install:ro" \
    -v "$root/test/fixtures/faux-openai-server.ts:/faux-openai-server.ts:ro" \
    debian:bookworm-slim \
    sh -eu -c '
        export DEBIAN_FRONTEND=noninteractive
        apt-get update >/dev/null
        apt-get install -y --no-install-recommends \
            ca-certificates curl tar coreutils libc-bin >/dev/null
        export HOME=/tmp/vera-home
        export VERA_HOME=/tmp/vera-home/.vera
        export VERA_INSTALL_BASE_URL=file:///releases
        export VERA_INSTALL_ALLOW_FILE=1
        export VERA_INSTALL_VERSION=latest
        export VERA_INSTALL_ROOT=/tmp/vera-install
        export VERA_INSTALL_BIN_DIR=/tmp/vera-bin
        sh /install >/tmp/vera-install.log
        export PATH=/tmp/vera-bin:$PATH
        test "$(vera --version)" = "vera $VERA_TEST_VERSION"
        vera --help >/tmp/vera-help.txt
        grep -q "Run one bounded turn" /tmp/vera-help.txt

        runtime_bun="/tmp/vera-install/versions/$VERA_TEST_VERSION/runtime/bun"
        "$runtime_bun" /faux-openai-server.ts >/tmp/faux-openai-server.log 2>&1 &
        server_pid=$!
        trap "kill $server_pid 2>/dev/null || true" EXIT
        ready=0
        for attempt in $(seq 1 50); do
            if curl --fail --silent --show-error \
                -X POST \
                -H "content-type: application/json" \
                --data '{}' \
                http://127.0.0.1:8790/v1/chat/completions >/dev/null 2>&1; then
                ready=1
                break
            fi
            sleep 0.1
        done
        test "$ready" = 1

        mkdir -p "$VERA_HOME/profiles/default"
        printf "%s\n" "{\"schema_version\":1,\"provider\":\"faux-local\",\"model\":\"faux-model\",\"approval_mode\":\"auto\",\"providers\":{\"faux-local\":{\"protocol\":\"openai-chat\",\"base_url\":\"http://127.0.0.1:8790/v1\",\"credential\":\"none\"}}}" \
            > "$VERA_HOME/profiles/default/config.json"
        response=$(vera -p "Reply with exactly: container faux passed" --prompt-only)
        test "$response" = "container faux passed"
        test "$(readlink /tmp/vera-install/current)" = "versions/$VERA_TEST_VERSION"
        printf "version=%s\n" "$(vera --version)"
        printf "response=%s\n" "$response"
    '
