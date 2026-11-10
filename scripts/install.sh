#!/bin/sh
# Installs a packed Vera release tarball into PREFIX/share/vera/releases/<build-id>,
# points current at it, keeps the previous release as rollback, and writes
# PREFIX/bin/vera. Same layout as src/release/activate.ts.
#
#   curl -fsSL https://github.com/nashaad/vera/releases/latest/download/install.sh | sh
#   sh install.sh ./vera-darwin-arm64.tar.gz
#
# VERA_VERSION=1.2.3 selects a release; VERA_INSTALL_PREFIX overrides ~/.local.
set -eu

repo=${VERA_REPO:-nashaad/vera}

die() {
    echo "vera install: $*" >&2
    exit 1
}

need() {
    command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

platform() {
    case "$(uname -s)" in
        Darwin) os=darwin ;;
        Linux) os=linux ;;
        *) die "unsupported OS: $(uname -s)" ;;
    esac
    case "$(uname -m)" in
        arm64 | aarch64) arch=arm64 ;;
        x86_64 | amd64) arch=x64 ;;
        *) die "unsupported architecture: $(uname -m)" ;;
    esac
    if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then
        die "musl Linux is not supported; Vera needs glibc"
    fi
    echo "vera-$os-$arch"
}

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        die "required command not found: sha256sum or shasum"
    fi
}

download() {
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL --retry 3 -o "$2" "$1"
    elif command -v wget >/dev/null 2>&1; then
        wget -q -O "$2" "$1"
    else
        die "required command not found: curl or wget"
    fi
}

link_release() {
    temporary="$share/.$1.$$"
    rm -f "$temporary"
    ln -s "releases/$2" "$temporary"
    # Plain mv onto a link to a directory moves into it: -T is GNU, -h is BSD.
    mv -fT "$temporary" "$share/$1" 2>/dev/null || mv -fh "$temporary" "$share/$1"
}

need tar
need uname
need awk

prefix=${VERA_INSTALL_PREFIX:-${HOME:?HOME is not set}/.local}
share="$prefix/share/vera"
releases="$share/releases"
launcher="$prefix/bin/vera"
mkdir -p "$releases" "$prefix/bin"
work=$(mktemp -d "$releases/.install-XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM

if [ "$#" -gt 1 ]; then
    die "usage: install.sh [vera-<os>-<arch>.tar.gz]"
elif [ "$#" -eq 1 ]; then
    [ -f "$1" ] || die "tarball not found: $1"
    tarball=$1
    if [ -f "$1.sha256" ]; then
        expected=$(awk '{print $1}' "$1.sha256")
        [ "$(sha256_of "$tarball")" = "$expected" ] || die "checksum mismatch for $1"
    fi
else
    asset=$(platform).tar.gz
    if [ -n "${VERA_VERSION:-}" ]; then
        base="https://github.com/$repo/releases/download/v$VERA_VERSION"
    else
        base="https://github.com/$repo/releases/latest/download"
    fi
    echo "Downloading $asset"
    tarball="$work/$asset"
    download "$base/$asset" "$tarball" || die "download failed: $base/$asset"
    download "$base/$asset.sha256" "$tarball.sha256" || die "download failed: $base/$asset.sha256"
    expected=$(awk '{print $1}' "$tarball.sha256")
    [ "$(sha256_of "$tarball")" = "$expected" ] || die "checksum mismatch for $asset"
fi

mkdir "$work/x"
tar -xzf "$tarball" -C "$work/x"
build_id=$(ls "$work/x")
case "$build_id" in
    vera-*) ;;
    *) die "tarball does not hold one vera-<build> directory" ;;
esac
[ "$(ls "$work/x" | wc -l | tr -d ' ')" = 1 ] || die "tarball holds more than one directory"
[ -f "$work/x/$build_id/manifest.json" ] || die "tarball has no release manifest"
[ -x "$work/x/$build_id/vera" ] || die "tarball has no vera launcher"
if [ "$(uname -s)" = Darwin ]; then
    xattr -dr com.apple.quarantine "$work/x/$build_id" 2>/dev/null || true
fi

if [ -d "$releases/$build_id" ]; then
    echo "Release $build_id is already installed"
else
    mv "$work/x/$build_id" "$releases/$build_id"
fi

previous=""
if [ -L "$share/current" ]; then
    previous=$(basename "$(readlink "$share/current")")
fi
if [ -n "$previous" ] && [ "$previous" != "$build_id" ]; then
    link_release rollback "$previous"
fi
link_release current "$build_id"

target="$share/current/vera"
cat >"$launcher.$$.tmp" <<EOF
#!/bin/sh
set -eu
target='$target'
if [ ! -x "\$target" ]; then
  echo "vera: no activated release at \$target. Run the Vera installer again." >&2
  exit 1
fi
exec "\$target" "\$@"
EOF
chmod 755 "$launcher.$$.tmp"
mv -f "$launcher.$$.tmp" "$launcher"

echo "Installed $build_id"
echo "Launcher: $launcher"
case ":$PATH:" in
    *":$prefix/bin:"*) ;;
    *)
        echo
        echo "$prefix/bin is not on PATH. Add this to your shell startup file:"
        echo "  export PATH=\"$prefix/bin:\$PATH\""
        ;;
esac
