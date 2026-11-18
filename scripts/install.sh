#!/bin/sh
# Installs a packed Vera release tarball into PREFIX/share/vera/releases/<build-id>,
# points current at it, keeps the previous release as rollback, and writes
# PREFIX/bin/vera. Same layout as src/release/activate.ts.
#
#   curl -fsSL https://raw.githubusercontent.com/nashaad/vera/main/scripts/install.sh | sh
#   sh install.sh ./vera-darwin-arm64.tar.gz
#
# VERA_VERSION=1.2.3 selects a release; VERA_INSTALL_PREFIX overrides ~/.local.
# VERA_DESKTOP=ask|yes|no (default ask) controls the macOS desktop app step.
# Test seams: VERA_INSTALL_TTY (default /dev/tty), VERA_INSTALL_APPLICATIONS
# (default /Applications) and VERA_INSTALL_NO_OPEN (skip opening the app).
set -eu

repo=${VERA_REPO:-nashaad/vera}

die() {
    echo "vera install: $*" >&2
    exit 1
}

need() {
    command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

desktop=${VERA_DESKTOP:-ask}
case "$desktop" in
    ask | yes | no) ;;
    *) die "VERA_DESKTOP must be ask, yes or no, not '$desktop'" ;;
esac

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

latest_version() {
    api=${VERA_RELEASES_API:-https://api.github.com/repos/$repo/releases?per_page=1}
    download "$api" "$work/release.json" 2>/dev/null ||
        die "could not resolve the latest release; set VERA_VERSION to install a specific version"
    tag=$(awk '
        {
            if (match($0, /"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"/)) {
                value = substr($0, RSTART, RLENGTH)
                sub(/^"tag_name"[[:space:]]*:[[:space:]]*"/, "", value)
                sub(/"$/, "", value)
                if (value ~ /^[A-Za-z0-9._+-]+$/) print value
                exit
            }
        }' "$work/release.json")
    version=${tag#v}
    [ -n "$version" ] ||
        die "could not resolve the latest release; set VERA_VERSION to install a specific version"
    echo "$version"
}

link_release() {
    temporary="$share/.$1.$$"
    rm -f "$temporary"
    ln -s "releases/$2" "$temporary"
    # Plain mv onto a link to a directory moves into it: -T is GNU, -h is BSD.
    mv -fT "$temporary" "$share/$1" 2>/dev/null || mv -fh "$temporary" "$share/$1"
}

# Desktop app (macOS). A failure here leaves the installed vera command as it is.

desktop_fail() {
    echo "vera install: $*" >&2
    echo "The vera command is installed. The desktop app was not changed." >&2
    exit 1
}

json_text() {
    plutil -extract "$2" raw -o - "$1" 2>/dev/null
}

json_type() {
    plutil -type "$2" "$1" 2>/dev/null
}

# A plain relative path: no empty, dot or dot-dot parts, no backslash, no trailing slash.
safe_relative_path() {
    case "$1" in
        "" | /* | *\\* | . | .. | ./* | */. | ../* | */.. | */./* | */../* | */ | *//*) return 1 ;;
    esac
}

# Sets package_version on success and package_problem on failure.
check_package() {
    package_version=""
    package_problem=""
    package_manifest="$1/desktop-package.json"
    if [ ! -f "$package_manifest" ] || [ -L "$package_manifest" ]; then
        package_problem="has no desktop-package.json"
        return 1
    fi
    if [ "$(wc -c <"$package_manifest" | tr -d ' ')" -gt 65536 ]; then
        package_problem="has a desktop-package.json larger than 65536 bytes"
        return 1
    fi
    if [ "$(json_type "$package_manifest" layout_version)" != integer ] ||
        [ "$(json_text "$package_manifest" layout_version)" != 1 ]; then
        package_problem="has an unsupported desktop-package.json layout_version"
        return 1
    fi
    candidate=$(json_text "$package_manifest" desktop_version) || candidate=""
    case "$candidate" in
        "" | *[!0-9A-Za-z.+-]*)
            package_problem="has an invalid desktop_version"
            return 1
            ;;
    esac
    if [ "$(json_type "$package_manifest" desktop_version)" != string ] ||
        ! printf '%s\n' "$candidate" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'; then
        package_problem="has an invalid desktop_version"
        return 1
    fi
    if [ "$(json_type "$package_manifest" host_build_id)" != string ] ||
        [ "$(json_text "$package_manifest" host_build_id)" != "$build_id" ]; then
        package_problem="is not built for the installed host build $build_id"
        return 1
    fi
    entry=$(json_text "$package_manifest" entry) || entry=""
    if [ "$(json_type "$package_manifest" entry)" != string ] || ! safe_relative_path "$entry"; then
        package_problem="has an unsafe entry path"
        return 1
    fi
    entry_path="$1/$entry"
    if [ ! -f "$entry_path" ] || [ -L "$entry_path" ]; then
        package_problem="has no entry file $entry"
        return 1
    fi
    physical_root=$(cd "$1" && pwd -P) || physical_root=""
    physical_entry=$(cd "$(dirname "$entry_path")" && pwd -P) || physical_entry=""
    case "$physical_entry/" in
        "$physical_root"/*) [ -n "$physical_root" ] || return 1 ;;
        *)
            package_problem="has an entry outside the package"
            return 1
            ;;
    esac
    package_version=$candidate
}

is_vera_shell() {
    [ -d "$1" ] && [ ! -L "$1" ] || return 1
    [ "$(json_text "$1/Contents/Info.plist" CFBundleIdentifier)" = dev.vera.desktop ] || return 1
    [ "$(json_type "$1/Contents/Resources/vera-shell.json" shell_api)" = integer ]
}

# 0 not running, 1 running, 2 could not tell.
shell_running() {
    running_physical=$(cd "$1" && pwd -P) || return 2
    process_executables >"$work/processes" || return 2
    if awk -v logical="$1" -v physical="$running_physical" '
        index($0, logical "/Contents/") == 1 || index($0, physical "/Contents/") == 1 { found = 1; exit }
        END { exit !found }
    ' "$work/processes"; then
        return 1
    fi
    return 0
}

refuse_if_running() {
    running_state=0
    shell_running "$1" || running_state=$?
    case "$running_state" in
        0) ;;
        1) desktop_fail "Vera is running. Quit Vera and run the installer again." ;;
        *) desktop_fail "could not tell whether Vera is running. Quit Vera and run the installer again." ;;
    esac
}

archive_is_plain() {
    tar -tzf "$1" 2>/dev/null | awk '
        /^\// || /(^|\/)\.\.(\/|$)/ { bad = 1 }
        END { exit bad }'
}

copy_tree() {
    if command -v ditto >/dev/null 2>&1; then
        ditto "$1" "$2"
    else
        cp -Rp "$1" "$2"
    fi
}

# Sets answer to yes, no or none (no usable terminal).
ask_desktop() {
    answer=none
    terminal=${VERA_INSTALL_TTY:-/dev/tty}
    if ! ( : <"$terminal" ) 2>/dev/null; then
        return 0
    fi
    exec 3<"$terminal"
    printf 'Also install the Vera desktop app? [Y/n] '
    while read -r reply <&3; do
        case "$reply" in
            "" | [Yy] | [Yy][Ee][Ss]) answer=yes; break ;;
            [Nn] | [Nn][Oo]) answer=no; break ;;
        esac
        printf 'Please answer y or n. Also install the Vera desktop app? [Y/n] '
    done
    exec 3<&-
    if [ "$answer" = none ]; then
        echo
    fi
}

install_desktop_package() {
    host_dir="$share/desktop/$build_id"
    mkdir -p "$host_dir"
    staged_package=$(mktemp -d "$host_dir/.tmp-$$-XXXXXX")
    chmod 755 "$staged_package"
    tar -xzf "$desk/$package_asset" -C "$staged_package" || desktop_fail "could not unpack $package_asset"
    check_package "$staged_package" || desktop_fail "$package_asset $package_problem"
    package_dir="$host_dir/$package_version"
    if [ -d "$package_dir" ] && check_package "$package_dir"; then
        echo "Desktop package $package_version is already installed"
        rm -rf "$staged_package"
        staged_package=""
        return 0
    fi
    check_package "$staged_package" || desktop_fail "$package_asset $package_problem"
    xattr -dr com.apple.quarantine "$staged_package" 2>/dev/null || true
    rm -rf "$package_dir"
    mv "$staged_package" "$package_dir" || desktop_fail "could not install the desktop package into $package_dir"
    staged_package=""
}

install_desktop_app() {
    mkdir -p "$apps" || desktop_fail "could not create $apps"
    staged_app="$apps/.Vera.app.new-$$"
    rm -rf "$staged_app"
    xattr -dr com.apple.quarantine "$desk/shell/Vera.app" 2>/dev/null || true
    copy_tree "$desk/shell/Vera.app" "$staged_app" || desktop_fail "could not write to $apps"
    if [ -e "$dest_app" ] || [ -L "$dest_app" ]; then
        refuse_if_running "$dest_app"
        aside_app="$apps/.Vera.app.old-$$"
        rm -rf "$aside_app"
        mv "$dest_app" "$aside_app" || {
            aside_app=""
            desktop_fail "could not move the existing $dest_app aside"
        }
    fi
    if ! mv "$staged_app" "$dest_app"; then
        if [ -n "$aside_app" ]; then
            mv "$aside_app" "$dest_app" && aside_app=""
        fi
        desktop_fail "could not place $dest_app"
    fi
    staged_app=""
    if [ -n "$aside_app" ]; then
        rm -rf "$aside_app" || echo "Could not remove the previous app at $aside_app" >&2
        aside_app=""
    fi
}

write_desktop_record() {
    record="$share/desktop/installed.json"
    escaped=$(printf '%s' "$dest_app" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
    printf '{"layout_version": 1, "app_path": "%s"}\n' "$escaped" >"$record.$$.tmp"
    mv -f "$record.$$.tmp" "$record"
}

install_desktop() {
    [ "$desktop" != no ] || return 0
    case "$(uname -s)" in
        Darwin) ;;
        Linux)
            if [ "$desktop" = yes ]; then
                echo "The Vera desktop app is not available on Linux yet." >&2
                exit 1
            fi
            echo "The Vera desktop app is not available on Linux yet."
            return 0
            ;;
        *) return 0 ;;
    esac
    if [ "${prefix%/}" != "${HOME:?HOME is not set}/.local" ]; then
        if [ "$desktop" = yes ]; then
            echo "The desktop app needs Vera in ~/.local; it was not installed." >&2
            exit 1
        fi
        echo "The desktop app needs Vera in ~/.local; it was not installed."
        return 0
    fi
    if [ -z "${base:-}" ]; then
        if [ "$desktop" = yes ]; then
            desktop_fail "the desktop app comes from a release download. Run the installer without a file to add it."
        fi
        echo "The desktop app comes from a release download. Run the installer without a file to add it."
        return 0
    fi
    target=${asset#vera-}
    target=${target%.tar.gz}
    package_asset="vera-desktop-$target.tar.gz"
    shell_asset="vera-desktop-shell-$target.tar.gz"
    desk="$work/desktop"
    mkdir -p "$desk"
    if ! download "$base/$package_asset.sha256" "$desk/$package_asset.sha256" 2>/dev/null; then
        if [ "$desktop" = yes ]; then
            echo "This release has no desktop app yet. The vera command is installed." >&2
            exit 1
        fi
        echo "This release has no desktop app yet. The vera command is installed."
        return 0
    fi
    if [ "$desktop" = ask ]; then
        ask_desktop
        case "$answer" in
            yes) ;;
            no) return 0 ;;
            *)
                echo "To add the desktop app later, run the installer again with VERA_DESKTOP=yes."
                return 0
                ;;
        esac
    fi
    command -v plutil >/dev/null 2>&1 || desktop_fail "required command not found: plutil"

    system_apps=${VERA_INSTALL_APPLICATIONS:-/Applications}
    if [ -d "$system_apps" ] && [ -w "$system_apps" ]; then
        apps=$system_apps
    else
        apps="${HOME:?HOME is not set}/Applications"
    fi
    case "$apps" in
        /*) ;;
        *) desktop_fail "the Applications directory must be an absolute path: $apps" ;;
    esac
    dest_app="$apps/Vera.app"
    if [ -e "$dest_app" ] || [ -L "$dest_app" ]; then
        is_vera_shell "$dest_app" ||
            desktop_fail "$dest_app is not the Vera desktop app, so it was left alone. Move it away and run the installer again."
        refuse_if_running "$dest_app"
    fi

    for part in "$package_asset" "$shell_asset"; do
        echo "Downloading $part"
        download "$base/$part" "$desk/$part" || desktop_fail "download failed: $base/$part"
        [ -f "$desk/$part.sha256" ] ||
            download "$base/$part.sha256" "$desk/$part.sha256" || desktop_fail "download failed: $base/$part.sha256"
    done
    for part in "$package_asset" "$shell_asset"; do
        expected=$(awk '{print $1}' "$desk/$part.sha256")
        [ "$(sha256_of "$desk/$part")" = "$expected" ] || desktop_fail "checksum mismatch for $part"
        archive_is_plain "$desk/$part" || desktop_fail "$part holds a path outside its directory"
    done

    mkdir "$desk/shell"
    tar -xzf "$desk/$shell_asset" -C "$desk/shell" || desktop_fail "could not unpack $shell_asset"
    [ "$(ls -A "$desk/shell")" = Vera.app ] || desktop_fail "$shell_asset does not hold only Vera.app"
    is_vera_shell "$desk/shell/Vera.app" || desktop_fail "$shell_asset does not hold the Vera desktop app"

    install_desktop_package
    install_desktop_app
    write_desktop_record || desktop_fail "could not write $share/desktop/installed.json"
    echo "Installed the Vera desktop app $package_version"
    echo "App: $dest_app"
    if [ -z "${VERA_INSTALL_NO_OPEN:-}" ]; then
        open "$dest_app" || echo "Could not open Vera. Open it from $dest_app." >&2
    fi
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
staged_package=""
staged_app=""
aside_app=""
dest_app=""
cleanup() {
    rm -rf "$work"
    [ -z "$staged_package" ] || rm -rf "$staged_package"
    [ -z "$staged_app" ] || rm -rf "$staged_app"
    if [ -n "$aside_app" ] && [ -e "$aside_app" ] && [ ! -e "$dest_app" ]; then
        mv "$aside_app" "$dest_app" || echo "Could not restore the previous Vera app. It is at $aside_app." >&2
    fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

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
    version=${VERA_VERSION:-}
    if [ -z "$version" ]; then
        version=$(latest_version)
    fi
    download_base=${VERA_RELEASES_DOWNLOAD_BASE:-https://github.com/$repo/releases/download}
    download_base=${download_base%/}
    base="$download_base/v$version"
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

process_executables() {
    case "$(uname -s)" in
        Linux)
            command -v readlink >/dev/null 2>&1 || return 1
            readlink /proc/self/exe >/dev/null 2>&1 || return 1
            for executable in /proc/[0-9]*/exe; do
                readlink "$executable" 2>/dev/null || true
            done
            ;;
        Darwin)
            command -v lsof >/dev/null 2>&1 || return 1
            lsof -nP -w -d txt -Fn >"$work/lsof" 2>/dev/null || return 1
            sed -n 's/^n//p' "$work/lsof"
            ;;
        *) return 1 ;;
    esac
}

release_in_use() {
    awk -v logical="$releases" -v physical="$physical_releases" -v name="$name" '
        function matches(root, path, relative) {
            if (index(path, root "/") != 1) return 0
            relative = substr(path, length(root) + 2)
            return index(relative, name "/") == 1 ||
                (index(relative, ".gc-" name "-") == 1 && index(relative, "/") > 0)
        }
        matches(logical, $0) || matches(physical, $0) { found = 1; exit }
        END { exit !found }
    ' "$work/processes"
}

removed=0
if physical_releases=$(cd "$releases" && pwd -P) && process_executables >"$work/processes"; then
    current=$(basename "$(readlink "$share/current")")
    rollback=""
    if [ -L "$share/rollback" ]; then
        rollback=$(basename "$(readlink "$share/rollback")")
    fi
    ls -td "$releases"/* >"$work/releases" 2>/dev/null || true
    newest=0
    while IFS= read -r release; do
        [ -d "$release" ] || continue
        newest=$((newest + 1))
        name=${release##*/}
        [ "$newest" -gt 3 ] || continue
        [ "$name" != "$current" ] && [ "$name" != "$rollback" ] || continue
        release_in_use && continue
        retired="$releases/.gc-$name-$$"
        [ ! -e "$retired" ] || continue
        if ! mv "$release" "$retired"; then
            echo "Could not remove $release" >&2
            continue
        fi
        if ! process_executables >"$work/processes"; then
            [ ! -e "$release" ] && mv "$retired" "$release" || echo "Could not restore $release" >&2
            break
        fi
        if release_in_use; then
            [ ! -e "$release" ] && mv "$retired" "$release" || echo "Could not restore $release" >&2
        elif rm -rf "$retired"; then
            removed=$((removed + 1))
        else
            echo "Could not remove $retired" >&2
        fi
    done <"$work/releases"
fi
echo "Removed $removed old releases"

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

install_desktop
