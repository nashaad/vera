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
        version_without_v=${version#v}
        printf '%s\n' "$version_without_v" \
            | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' \
            || die "invalid stable release version: $version"
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
revision=$(git -C "$root" rev-parse HEAD)

output_dir=$(dirname -- "$output")
mkdir -p "$output_dir"
output_dir=$(CDPATH= cd -- "$output_dir" && pwd)
output="$output_dir/$(basename -- "$output")"
archive_name="vera-$platform-$arch.tar.gz"

stage=$(mktemp -d "${TMPDIR:-/tmp}/vera-release.XXXXXX")
bundle="$stage/bundle"
source_tree="$stage/source"
cleanup() {
    rm -rf "$stage"
}
trap cleanup EXIT HUP INT TERM
mkdir -p "$bundle/bin" "$bundle/runtime"
mkdir "$source_tree"

# Archive tracked source instead of copying the checkout. This excludes local
# ignored state. Keep the runtime input explicit so a new private/development
# tree cannot silently enter a public release.
git -C "$root" archive HEAD | tar -xf - -C "$source_tree"
for path in clients config extensions src bun.lock bunfig.toml package.json tsconfig.json index.ts; do
    [ -e "$source_tree/$path" ] || die "release keep-list entry is missing: $path"
    mv "$source_tree/$path" "$bundle/$path"
done

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

# Bun creates convenience links in node_modules/.bin. They are not needed by
# the runtime bundle. Any other link is a packaging error because the installer
# intentionally accepts only self-contained archives.
if [ -d "$bundle/node_modules/.bin" ]; then
    find "$bundle/node_modules/.bin" -type l -delete
fi
if find "$bundle" -type l -print -quit | grep . >/dev/null 2>&1; then
    die "release bundle contains a symlink outside node_modules/.bin"
fi

cp "$bun" "$bundle/runtime/bun"
chmod 755 "$bundle/runtime/bun"
cp "$root/scripts/portable-launcher.sh" "$bundle/bin/vera"
chmod 755 "$bundle/bin/vera"
printf '%s\n' "$version" > "$bundle/VERSION"
libc=none
[ "$platform" = "linux" ] && libc=glibc
bun_version=$("$bun" --version)
cat > "$bundle/manifest.json" <<EOF
{
  "version": "$version",
  "source_revision": "$revision",
  "bun_version": "$bun_version",
  "platform": "$platform",
  "architecture": "$arch",
  "libc": "$libc",
  "archive": "$archive_name",
  "entrypoint": "bin/vera",
  "runtime": "runtime/bun"
}
EOF

rm -f "$output" "$output.sha256"
tar -czf "$output" -C "$bundle" .
if command -v shasum >/dev/null 2>&1; then
    (
        cd "$output_dir"
        shasum -a 256 "$(basename "$output")" > "$(basename "$output").sha256"
    )
elif command -v sha256sum >/dev/null 2>&1; then
    (
        cd "$output_dir"
        sha256sum "$(basename "$output")" > "$(basename "$output").sha256"
    )
else
    die "required command not found: shasum or sha256sum"
fi

echo "Built $output"
echo "Checksum: $output.sha256"
