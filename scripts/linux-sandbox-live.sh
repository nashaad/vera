#!/bin/sh
# Runs the Linux sandbox live cases in a Debian container with bubblewrap and
# socat. The tests start real sandboxed commands from a folder outside the
# workspace, the way a host does.
#
#   scripts/linux-sandbox-live.sh            # native arch of the Docker host
#   scripts/linux-sandbox-live.sh x64        # linux/amd64, emulated on Apple silicon
set -eu

die() {
    echo "linux sandbox live: $*" >&2
    exit 1
}

command -v docker >/dev/null 2>&1 || die "required command not found: docker"
docker info >/dev/null 2>&1 || die "Docker is not running"

case "${1:-native}" in
    native)
        case "$(docker info --format '{{.Architecture}}')" in
            aarch64 | arm64) arch=arm64 ;;
            x86_64 | amd64) arch=x64 ;;
            *) die "unsupported Docker architecture" ;;
        esac
        ;;
    arm64 | x64) arch=$1 ;;
    *) die "usage: $0 [arm64|x64]" ;;
esac
case "$arch" in
    arm64) docker_platform=linux/arm64 ;;
    x64) docker_platform=linux/amd64 ;;
esac

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/vera-linux-sandbox.XXXXXX")
if [ "${VERA_SMOKE_KEEP:-}" = 1 ]; then
    echo "keeping $work"
else
    trap 'rm -rf "$work"' EXIT INT TERM
fi
# The index holds the staged previous slice; untracked files hold this one.
git -C "$root" ls-files -z >"$work/files.list"
git -C "$root" ls-files -z --others --exclude-standard >>"$work/files.list"
(cd "$root" && COPYFILE_DISABLE=1 xargs -0 tar --no-xattrs -cf "$work/source.tar" -- <"$work/files.list") 2>/dev/null

echo "== run: debian with bubblewrap and socat ($docker_platform)"
docker run --rm --init --platform "$docker_platform" \
    --privileged \
    -v "$work:/smoke:ro" \
    oven/bun:1.4.4 \
    sh -eu -c '
        export DEBIAN_FRONTEND=noninteractive
        apt-get update >/dev/null
        apt-get install -y --no-install-recommends \
            bubblewrap socat ripgrep git ca-certificates procps >/dev/null
        useradd -m crow
        mkdir -p /work
        tar -xf /smoke/source.tar -C /work
        chown -R crow /work
        su crow -s /bin/sh -c "
            set -eu
            cd /work
            bun install --frozen-lockfile >/tmp/install.log 2>&1 || { tail -30 /tmp/install.log; exit 1; }
            echo bwrap: \$(bwrap --version)
            echo socat: \$(socat -V 2>&1 | head -1)
            bun test test/sandbox/live-linux.test.ts
        "
    '
echo "linux sandbox live passed ($docker_platform)"
