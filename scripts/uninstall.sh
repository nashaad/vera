#!/bin/sh
# Removes an installed Vera release, its desktop app, and its home.
#
#   curl -fsSL https://raw.githubusercontent.com/nashaad/vera/main/scripts/uninstall.sh | sh
#
# VERA_INSTALL_PREFIX overrides ~/.local; VERA_HOME overrides ~/.vera.
# VERA_UNINSTALL=yes runs without questions; VERA_UNINSTALL_BACKUP=no skips backup
# in that mode. VERA_UNINSTALL_BACKUP_DIR sets the backup directory in either mode.
# Test seams: VERA_UNINSTALL_TTY (default /dev/tty) and VERA_INSTALL_APPLICATIONS
# (default /Applications).
set -eu

umask 077

die() {
    printf 'vera uninstall: %s\n' "$*" >&2
    exit 1
}

exists() {
    [ -e "$1" ] || [ -L "$1" ]
}

show_path() {
    if exists "$2"; then
        size=$(du -sh "$2" 2>/dev/null | awk '{print $1}')
        [ -n "$size" ] || size=unknown
        printf '  %s: %s  %s\n' "$1" "$size" "$2"
    fi
}

ask_yes_no() {
    question=$1
    default=$2
    while :; do
        printf '%s ' "$question"
        if ! IFS= read -r reply <&3; then
            printf '\n' >&2
            die 'terminal input ended; nothing was removed'
        fi
        case "$reply" in
            [Yy] | [Yy][Ee][Ss]) answer=yes; return ;;
            [Nn] | [Nn][Oo]) answer=no; return ;;
            '')
                if [ -n "$default" ]; then
                    answer=$default
                    return
                fi
                ;;
        esac
        printf 'Please answer y or n.\n'
    done
}

is_vera_shell() {
    [ -d "$1" ] && [ ! -L "$1" ] || return 1
    [ "$(plutil -extract CFBundleIdentifier raw -o - "$1/Contents/Info.plist" 2>/dev/null)" = dev.vera.desktop ] || return 1
    [ "$(plutil -type shell_api "$1/Contents/Resources/vera-shell.json" 2>/dev/null)" = integer ]
}

consider_app() {
    candidate=$1
    exists "$candidate" || return 0
    if is_vera_shell "$candidate"; then
        if [ -z "$app1" ]; then
            app1=$candidate
        elif [ "$(cd "$candidate" && pwd -P)" != "$(cd "$app1" && pwd -P)" ]; then
            app2=$candidate
        fi
    else
        printf 'Left alone, not the Vera desktop app: %s\n' "$candidate"
    fi
}

inside_directory() {
    [ -d "$2" ] || return 1
    physical_root=$(cd "$2" && pwd -P) || return 1
    case "$1/" in
        "$physical_root/"*) return 0 ;;
        *) return 1 ;;
    esac
}

validate_backup_directory() {
    case "$backup_dir" in
        '~') backup_dir=$HOME ;;
        '~/'*) backup_dir="$HOME/${backup_dir#'~/'}" ;;
    esac
    requested_backup_dir=$backup_dir
    backup_dir=$(cd "$backup_dir" 2>/dev/null && pwd -P) ||
        die "backup directory does not exist or cannot be read: $requested_backup_dir; nothing was removed"
    if inside_directory "$backup_dir" "$vera_home" ||
        inside_directory "$backup_dir" "$share" ||
        { [ -n "$app1" ] && inside_directory "$backup_dir" "$app1"; } ||
        { [ -n "$app2" ] && inside_directory "$backup_dir" "$app2"; }; then
        die 'backup directory is inside a path to be removed; nothing was removed'
    fi
}

make_backup() {
    readme_name=README.md
    [ "$home_name" != "$readme_name" ] || readme_name=VERA-RESTORE-README.md
    work=$(mktemp -d "$backup_dir/.vera-backup.XXXXXX") ||
        die "could not prepare backup in $backup_dir; nothing was removed"
    backup_path="$backup_dir/vera-backup-$(date '+%Y-%m-%d-%H-%M-%S').tar.gz"
    if ! (set -C; : >"$backup_path") 2>/dev/null; then
        die "could not create $backup_path without overwriting another file; nothing was removed"
    fi
    backup_pending=$backup_path
    {
        printf '# Vera backup\n\n'
        printf 'Archive directory: %s/\n' "$home_name"
        printf 'Original home path: %s\n' "$vera_home"
        printf 'Sign-ins included: %s\n\n' "$include_signins"
        printf 'The archive contains the Vera home in %s/ and this %s.\n' "$home_name" "$readme_name"
        if [ "$include_signins" = yes ]; then
            printf 'The home includes machine/auth.json (provider sign-ins), if it existed.\n'
        else
            printf 'machine/auth.json (provider sign-ins) is excluded. Other home files can contain secrets.\n'
        fi
        printf '\nTo restore, extract this archive and copy the contents of %s/ back to %s, preserving file permissions.\n' "$home_name" "$vera_home"
        printf 'If the home was not the default ~/.vera, set VERA_HOME to that path when starting Vera.\n'
        printf 'Reinstall Vera with:\n\n'
        printf '    curl -fsSL https://raw.githubusercontent.com/nashaad/vera/main/scripts/install.sh | sh\n'
    } >"$work/$readme_name" || die 'could not write the backup README; nothing was removed'

    if [ "$include_signins" = yes ]; then
        TAR_OPTIONS= tar -czf "$backup_path" -C "$home_parent" "./$home_name" -C "$work" "$readme_name" ||
            die 'backup failed; nothing was removed'
    else
        escaped_name=$(printf '%s' "$home_name" | sed 's/[][?*\\]/\\&/g')
        TAR_OPTIONS= tar --exclude "./$escaped_name/machine/auth.json" -czf "$backup_path" -C "$home_parent" "./$home_name" -C "$work" "$readme_name" ||
            die 'backup failed; nothing was removed'
    fi
    chmod 600 "$backup_path" || die 'could not secure the backup; nothing was removed'
    backup_pending=''
    printf 'Backup saved to %s\n' "$backup_path"
}

quit_app() {
    is_vera_shell "$1" || die "$1 changed and is not the Vera desktop app; nothing was removed"
    osascript - "$1" <<'APPLESCRIPT' || die "could not quit $1; nothing was removed"
on run argv
    set targetApp to application (item 1 of argv)
    if targetApp is running then
        tell targetApp to quit
        repeat 50 times
            if targetApp is not running then return
            delay 0.1
        end repeat
        error "Vera is still running"
    end if
end run
APPLESCRIPT
}

: "${HOME:?HOME is not set}"
prefix=${VERA_INSTALL_PREFIX:-$HOME/.local}
share="$prefix/share/vera"
launcher="$prefix/bin/vera"
vera_home=$(printf '%s' "${VERA_HOME:-}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
[ -n "$vera_home" ] || vera_home="$HOME/.vera"
while [ "$vera_home" != / ] && [ "${vera_home%/}" != "$vera_home" ]; do
    vera_home=${vera_home%/}
done

if exists "$vera_home"; then
    [ ! -L "$vera_home" ] ||
        die "Vera home is a symlink: $vera_home. Set VERA_HOME to its actual directory and retry; nothing was removed"
    [ -d "$vera_home" ] || die "Vera home is not a directory: $vera_home; nothing was removed"
    vera_home=$(cd "$vera_home" && pwd -P) || die 'could not resolve the Vera home; nothing was removed'
    user_home=$(cd "$HOME" && pwd -P) || die 'could not resolve HOME; nothing was removed'
    [ "$vera_home" != / ] || die 'Vera home cannot be the filesystem root; nothing was removed'
    case "$user_home/" in
        "$vera_home/"*) die 'Vera home cannot be your home directory or one of its ancestors; nothing was removed' ;;
    esac
    home_name=$(basename "$vera_home")
    home_parent=$(dirname "$vera_home")
fi

app1=''
app2=''
if [ "$(uname -s)" = Darwin ]; then
    command -v plutil >/dev/null 2>&1 || die 'plutil is required to identify the desktop app; nothing was removed'
    record="$share/desktop/installed.json"
    recorded_app=''
    if [ -f "$record" ]; then
        recorded_app=$(plutil -extract app_path raw -o - "$record" 2>/dev/null) || recorded_app=''
    fi
    case "$recorded_app" in
        /*) ;;
        *) recorded_app='' ;;
    esac
    if [ -n "$recorded_app" ] && exists "$recorded_app"; then
        consider_app "$recorded_app"
    else
        consider_app "${VERA_INSTALL_APPLICATIONS:-/Applications}/Vera.app"
        consider_app "$HOME/Applications/Vera.app"
    fi
fi

printf 'Vera uninstall will remove these existing paths:\n'
show_path launcher "$launcher"
show_path releases "$share"
[ -z "$app1" ] || show_path app "$app1"
[ -z "$app2" ] || show_path app "$app2"
show_path home "$vera_home"

interactive=no
if [ "${VERA_UNINSTALL:-}" != yes ]; then
    case "${CI:-}" in
        '' | 0 | false)
            terminal=${VERA_UNINSTALL_TTY:-/dev/tty}
            if ( : <"$terminal" ) 2>/dev/null; then
                exec 3<"$terminal"
                interactive=yes
            fi
            ;;
    esac
fi

if [ "$interactive" = yes ]; then
    ask_yes_no 'Continue with uninstall? [y/N]' no
    if [ "$answer" != yes ]; then
        printf 'Uninstall cancelled. Nothing was removed.\n'
        exit 0
    fi
else
    [ "${VERA_UNINSTALL:-}" = yes ] ||
        die 'no terminal available; set VERA_UNINSTALL=yes to uninstall without questions'
fi

backup_path=''
backup_pending=''
backup_in_progress=no
work=''
cleanup() {
    if [ "$backup_in_progress" = yes ]; then
        printf 'The Vera host is stopped and will start again the next time you run vera. Nothing was removed.\n' >&2
    fi
    [ -z "$backup_pending" ] || rm -f "$backup_pending"
    [ -z "$work" ] || rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

backup=no
if [ -d "$vera_home" ]; then
    backup=yes
    include_signins=yes
    backup_dir=${VERA_UNINSTALL_BACKUP_DIR:-$HOME}
    if [ "$interactive" = yes ]; then
        ask_yes_no 'Make a backup of the Vera home? [Y/n]' yes
        backup=$answer
        if [ "$backup" = yes ]; then
            printf 'Sign-ins are provider credentials stored in %s/machine/auth.json.\n' "$vera_home"
            ask_yes_no 'Include sign-ins in the backup? [y/n]' ''
            include_signins=$answer
            printf 'Backup directory [%s]: ' "$backup_dir"
            if ! IFS= read -r reply <&3; then
                printf '\n' >&2
                die 'terminal input ended; nothing was removed'
            fi
            [ -z "$reply" ] || backup_dir=$reply
        fi
    elif [ "${VERA_UNINSTALL_BACKUP:-}" = no ]; then
        backup=no
    fi
fi

if [ "$backup" = yes ]; then
    validate_backup_directory
fi

if [ -n "$app1" ]; then quit_app "$app1"; fi
if [ -n "$app2" ]; then quit_app "$app2"; fi

if [ -x "$launcher" ]; then
    if host_output=$(VERA_HOME="$vera_home" "$launcher" host stop --yes 2>&1); then
        printf '%s\n' "$host_output"
    else
        printf '%s\n' "$host_output" >&2
        die 'the Vera host did not stop; nothing was removed'
    fi
    host_result=$(printf '%s\n' "$host_output" | tail -n 1)
    case "$host_result" in
        'Resident Vera host PID '*' will stop once its running turns end.')
            die 'the host is waiting for running turns; retry uninstall after it stops; nothing was removed'
            ;;
        'No resident Vera host is running.' | 'Stopped resident Vera host PID '* | 'Resident Vera host PID '*' had already exited;'* | 'PID '*' is no longer a Vera host;'*) ;;
        *) die 'could not confirm that the Vera host stopped; nothing was removed' ;;
    esac
elif exists "$vera_home" || exists "$share" || exists "$launcher" || [ -n "$app1" ] || [ -n "$app2" ]; then
    die "cannot stop the Vera host because $launcher is missing or not executable; nothing was removed"
fi

if [ "$backup" = yes ]; then
    backup_in_progress=yes
    make_backup
    backup_in_progress=no
fi

if exists "$launcher"; then rm -f "$launcher" || die "could not remove $launcher"; fi
if exists "$share"; then rm -rf "$share" || die "could not remove $share"; fi
if [ -n "$app1" ]; then
    is_vera_shell "$app1" || die "$app1 changed and was not removed"
    rm -rf "$app1" || die "could not remove $app1"
fi
if [ -n "$app2" ]; then
    is_vera_shell "$app2" || die "$app2 changed and was not removed"
    rm -rf "$app2" || die "could not remove $app2"
fi
if exists "$vera_home"; then rm -rf "$vera_home" || die "could not remove $vera_home"; fi

printf 'Vera was uninstalled.\n'
if [ "$(uname -s)" = Darwin ]; then
    for leftover in "$HOME/Library/Preferences/dev.vera.desktop.plist" "$HOME/Library/Saved Application State/dev.vera.desktop.savedState"; do
        if exists "$leftover"; then printf 'Left in place: %s\n' "$leftover"; fi
    done
fi
[ -z "$backup_path" ] || printf 'Backup: %s\n' "$backup_path"
