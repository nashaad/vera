#!/bin/sh
# Packs this checkout (HEAD plus uncommitted and untracked files) into a Linux
# release tarball inside a Bun container, then installs it with scripts/install.sh
# in a clean Debian container that has no Bun and runs the CLI and one faux turn.
#
#   scripts/linux-release-smoke.sh            # native arch of the Docker host
#   scripts/linux-release-smoke.sh x64        # linux/amd64, emulated on Apple silicon
set -eu

die() {
    echo "linux release smoke: $*" >&2
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
work=$(mktemp -d "${TMPDIR:-/tmp}/vera-linux-smoke.XXXXXX")
if [ "${VERA_SMOKE_KEEP:-}" = 1 ]; then
    echo "keeping $work"
else
    trap 'rm -rf "$work"' EXIT INT TERM
fi
mkdir "$work/out"

git -C "$root" bundle create "$work/source.bundle" HEAD >/dev/null 2>&1
git -C "$root" ls-files -z --modified --others --exclude-standard >"$work/changes.list"
if [ -s "$work/changes.list" ]; then
    (cd "$root" && COPYFILE_DISABLE=1 xargs -0 tar --no-xattrs -cf "$work/changes.tar" -- <"$work/changes.list") 2>/dev/null
else
    tar -cf "$work/changes.tar" -T /dev/null
fi
deleted=$(git -C "$root" ls-files --deleted)
printf '%s\n' "$deleted" >"$work/deleted.txt"

echo "== build: linux/$arch tarball"
docker run --rm --init --platform "$docker_platform" \
    -v "$work:/smoke" \
    oven/bun:1.4.4 \
    sh -eu -c '
        export DEBIAN_FRONTEND=noninteractive
        apt-get update >/dev/null
        apt-get install -y --no-install-recommends git ca-certificates >/dev/null
        git -c advice.detachedHead=false clone -q /smoke/source.bundle /src
        cd /src
        tar --warning=no-unknown-keyword -xf /smoke/changes.tar
        while IFS= read -r path; do [ -n "$path" ] && rm -f -- "$path"; done </smoke/deleted.txt
        bun install --frozen-lockfile >/tmp/install.log 2>&1 || { tail -30 /tmp/install.log; exit 1; }
        bun run scripts/pack-web.ts dist/release/annex >/tmp/pack-web.log 2>&1 || { tail -30 /tmp/pack-web.log; exit 1; }
        # Packed on the container filesystem: a host bind mount can damage the compiled binary.
        bun run scripts/pack-release.ts --tarball "/tmp/out/vera-linux-'"$arch"'.tar.gz"
        cp /tmp/out/vera-linux-*.tar.gz /tmp/out/vera-linux-*.tar.gz.sha256 /smoke/out/
        cp scripts/install.sh test/fixtures/faux-openai-server.ts /smoke/out/
        cp "$(command -v bun)" /smoke/out/faux-bun
    '
ls -lh "$work/out/vera-linux-$arch.tar.gz" | awk '{print "tarball " $5}'

echo "== run: clean debian, no bun"
docker run --rm --init --platform "$docker_platform" \
    -v "$work/out:/dist:ro" \
    debian:bookworm-slim \
    sh -eu -c '
        export DEBIAN_FRONTEND=noninteractive
        apt-get update >/dev/null
        apt-get install -y --no-install-recommends procps >/dev/null
        useradd -m crow
        su crow -s /bin/sh -c "
            set -eu
            cd \$HOME
            if command -v bun >/dev/null 2>&1; then echo bun is on PATH >&2; exit 1; fi
            sh /dist/install.sh /dist/vera-linux-'"$arch"'.tar.gz
            sh /dist/install.sh /dist/vera-linux-'"$arch"'.tar.gz | grep -q \"already installed\"
            [ -L \$HOME/.local/share/vera/current ] && [ ! -e \$HOME/.local/share/vera/current/current ]
            export PATH=\$HOME/.local/bin:\$PATH
            export VERA_HOME=\$HOME/vera-home
            mkdir -p \$VERA_HOME
            vera --version
            vera --help | grep -q \"Run one bounded turn\"
            vera doctor >/tmp/doctor.txt 2>&1 || { cat /tmp/doctor.txt >&2; exit 1; }
            /dist/faux-bun /dist/faux-openai-server.ts >/tmp/faux.log 2>&1 &
            faux=\$!
            trap \"kill \$faux 2>/dev/null || true\" EXIT
            sleep 1
            printf \"%s\n\" \"{\\\"schema_version\\\":1,\\\"provider\\\":\\\"faux-local\\\",\\\"model\\\":\\\"faux-model\\\",\\\"approval_mode\\\":\\\"auto\\\",\\\"providers\\\":{\\\"faux-local\\\":{\\\"protocol\\\":\\\"openai-chat\\\",\\\"base_url\\\":\\\"http://127.0.0.1:8790/v1\\\",\\\"credential\\\":\\\"none\\\"}}}\" >\$VERA_HOME/config.json
            response=\$(vera -p \"Reply with exactly: container faux passed\" --prompt-only)
            [ \"\$response\" = \"container faux passed\" ] || { echo \"faux turn returned: \$response\" >&2; exit 1; }
            echo \"faux turn: \$response\"
            du -sh \$HOME/.local/share/vera/releases/* | awk \"{print \\\"installed \\\" \\\$1}\"
        "
    '
echo "linux release smoke passed (linux/$arch)"
