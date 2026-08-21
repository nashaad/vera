#!/bin/sh
# Install the exact npm tarball through ./install, then run the real CLI and
# faux model in a disposable Debian container.
set -eu

die() {
    echo "vera npm container smoke: $*" >&2
    exit 1
}

[ "$#" -eq 2 ] || die "usage: $0 <npm-package.tgz> <version>"
package=$1
version=$2
[ -f "$package" ] || die "package not found: $package"
printf '%s\n' "$version" \
    | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' \
    || die "version must be stable semver: $version"
command -v docker >/dev/null 2>&1 || die "required command not found: docker"

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
package=$(CDPATH= cd -- "$(dirname -- "$package")" && pwd)/$(basename -- "$package")

docker run --platform linux/amd64 --rm --init \
    -e VERA_TEST_VERSION="$version" \
    -v "$package:/vera-package.tgz:ro" \
    -v "$root/install:/install:ro" \
    -v "$root/test/fixtures/faux-openai-server.ts:/faux-openai-server.ts:ro" \
    oven/bun:1.3.6-slim@sha256:9d20d1b535596c4a021ba2087d2d303c4098e96be15f47775729cf7a259bb41e \
    sh -eu -c '
        export DEBIAN_FRONTEND=noninteractive
        apt-get update >/dev/null
        apt-get install -y --no-install-recommends ca-certificates curl nodejs npm >/dev/null
        export HOME=/tmp/vera-home
        mkdir -p "$HOME"
        test "$(bun --version)" = "1.3.6"
        export PATH=/tmp/vera-prefix/bin:$PATH
        export VERA_HOME=$HOME/.vera
        export VERA_INSTALL_PREFIX=/tmp/vera-prefix
        export VERA_NPM_PACKAGE=/vera-package.tgz
        if ! sh /install >/tmp/vera-install.log 2>&1; then
            cat /tmp/vera-install.log >&2
            exit 1
        fi

        test "$(vera --version)" = "vera $VERA_TEST_VERSION"
        vera --help >/tmp/vera-help.txt
        grep -q "Run one bounded turn" /tmp/vera-help.txt

        bun /faux-openai-server.ts >/tmp/faux-openai-server.log 2>&1 &
        server_pid=$!
        trap "kill $server_pid 2>/dev/null || true" EXIT
        ready=0
        for attempt in $(seq 1 50); do
            if curl --fail --silent --show-error \
                -X POST \
                -H "content-type: application/json" \
                --data "{}" \
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
        printf "version=%s\n" "$(vera --version)"
        printf "response=%s\n" "$response"
    '
