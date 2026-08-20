#!/bin/sh
# Build the directory-shaped archive consumed by the root ./install script.
#
# Usage:
#   scripts/build-release.sh <version> <output-archive>
#
# The default path installs production dependencies into the bundle. For a
# local, offline proof, VERA_RELEASE_NODE_MODULES may point at an already
# installed node_modules directory for the target platform.
set -eu

die() {
    echo "vera release: $*" >&2
    exit 1
}

[ "$#" -eq 2 ] || die "usage: $0 <version> <output-archive>"
version=$1
output=$2

case "$version" in
    v[0-9]*|[0-9]*)
        case "$version" in
            *[!A-Za-z0-9._+-]*) die "invalid release version: $version" ;;
        esac
        ;;
    *) die "invalid release version: $version" ;;
esac

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
command -v git >/dev/null 2>&1 || die "required command not found: git"
command -v tar >/dev/null 2>&1 || die "required command not found: tar"
command -v mktemp >/dev/null 2>&1 || die "required command not found: mktemp"

bun=${BUN_RUNTIME:-}
if [ -z "$bun" ]; then
    bun=$(command -v bun || true)
fi
[ -n "$bun" ] || die "required command not found: bun"
[ -x "$bun" ] || die "BUN_RUNTIME is not executable: $bun"

platform=${VERA_RELEASE_PLATFORM:-}
if [ -z "$platform" ]; then
    case "$(uname -s)" in
        Darwin) platform=darwin ;;
        Linux) platform=linux ;;
        *) die "unsupported operating system: $(uname -s)" ;;
    esac
fi

arch=${VERA_RELEASE_ARCH:-}
if [ -z "$arch" ]; then
    case "$(uname -m)" in
        arm64|aarch64) arch=arm64 ;;
        x86_64|amd64) arch=x64 ;;
        *) die "unsupported architecture: $(uname -m)" ;;
    esac
fi

case "$platform/$arch" in
    darwin/arm64|darwin/x64|linux/arm64|linux/x64) ;;
    *) die "unsupported Vera release target: $platform/$arch" ;;
esac

if [ -n "$(git -C "$root" status --porcelain --untracked-files=all)" ]; then
    die "working tree must be clean before building a release"
fi

output_dir=$(dirname -- "$output")
mkdir -p "$output_dir"
output_dir=$(CDPATH= cd -- "$output_dir" && pwd)
output="$output_dir/$(basename -- "$output")"
archive_name="vera-$platform-$arch.tar.gz"

stage=$(mktemp -d "${TMPDIR:-/tmp}/vera-release.XXXXXX")
bundle="$stage/bundle"
cleanup() {
    rm -rf "$stage"
}
trap cleanup EXIT HUP INT TERM
mkdir -p "$bundle/bin" "$bundle/runtime"

# Archive tracked source instead of copying the checkout. This excludes local
# ignored state and makes the release input explicit: the clean commit above.
git -C "$root" archive HEAD | tar -xf - -C "$bundle"
rm -rf "$bundle/.git" "$bundle/test" "$bundle/.worktrees" "$bundle/install"

if [ -n "${VERA_RELEASE_NODE_MODULES:-}" ]; then
    [ -d "$VERA_RELEASE_NODE_MODULES" ] \
        || die "VERA_RELEASE_NODE_MODULES is not a directory"
    mkdir "$bundle/node_modules"
    cp -R "$VERA_RELEASE_NODE_MODULES/." "$bundle/node_modules/"
else
    (
        cd "$bundle"
        "$bun" install --production --frozen-lockfile
    )
fi

cp "$bun" "$bundle/runtime/bun"
chmod 755 "$bundle/runtime/bun"
cp "$root/scripts/portable-launcher.sh" "$bundle/bin/vera"
chmod 755 "$bundle/bin/vera"
printf '%s\n' "$version" > "$bundle/VERSION"
cat > "$bundle/manifest.json" <<EOF
{
  "version": "$version",
  "platform": "$platform",
  "architecture": "$arch",
  "archive": "$archive_name",
  "entrypoint": "bin/vera",
  "runtime": "runtime/bun"
}
EOF

rm -f "$output" "$output.sha256"
tar -czf "$output" -C "$bundle" .
if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$output" > "$output.sha256"
elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$output" > "$output.sha256"
else
    die "required command not found: shasum or sha256sum"
fi

echo "Built $output"
echo "Checksum: $output.sha256"
