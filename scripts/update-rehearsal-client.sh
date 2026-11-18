#!/bin/sh
set -eu

if [ "${VERA_REHEARSAL_CLEAN:-}" != 1 ]; then
    exec env -i HOME="${HOME:?}" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" TERM=xterm-256color VERA_REHEARSAL_CLEAN=1 VERA_REHEARSAL_LEG="${VERA_REHEARSAL_LEG:-}" sh "$0" "$@"
fi

fail() { echo "FAIL: $*"; exit 1; }
ok() { echo "ok: $*"; }
[ "$#" = 5 ] || fail "usage: update-rehearsal-client.sh FEED PREFIX HOME OLDER NEWER"
feed=${1%/}
prefix=$2
home=$3
older=${4#v}
newer=${5#v}
case "$prefix:$home" in /*:/*) ;; *) fail "prefix and home must be absolute paths" ;; esac
[ ! -e "$prefix" ] && [ ! -e "$home" ] || fail "prefix and home must not exist"
case "$prefix/" in "$HOME/.local/"*) fail "daily prefix refused" ;; esac
case "$home/" in "$HOME/.vera/"*) fail "daily home refused" ;; esac
mkdir -p "$prefix" "$home"
export VERA_HOME="$home" VERA_INSTALL_PREFIX="$prefix"
export VERA_RELEASES_API="$feed/releases" VERA_RELEASES_DOWNLOAD_BASE="$feed"
export VERA_DESKTOP=no
work=$(mktemp -d)
vera="$prefix/bin/vera"
share="$prefix/share/vera"
lock="$home/runtime/host.json"
stdio=
update=
tmux_name="vera-rehearsal-$$"
tui=0
cleanup() {
    curl -fsS --max-time 10 -X POST "$feed/control/complete-turn" >/dev/null 2>&1 || true
    tries=0
    while ! curl -fsS --max-time 10 "$feed/control/counts" 2>/dev/null | grep -q '"active":0'; do
        tries=$((tries + 1)); [ "$tries" -lt 10 ] || break
        sleep 1
    done
    if [ "$tui" = 1 ]; then tmux -L "$tmux_name" kill-server 2>/dev/null || true; fi
    if [ -n "$stdio" ]; then
        printf '%s\n' '{"type":"detach"}' >&3 2>/dev/null || true
        kill "$stdio" 2>/dev/null || true
        wait "$stdio" 2>/dev/null || true
    fi
    if [ -x "$vera" ] && [ -f "$lock" ]; then
        cleanup_pid=$(pid_of_host)
        "$vera" host stop --yes >"$work/cleanup.log" 2>&1 || cat "$work/cleanup.log"
        if kill -0 "$cleanup_pid" 2>/dev/null; then
            echo "FAIL: cleanup left private host PID $cleanup_pid in $home"
        fi
    fi
    if [ -n "$update" ]; then wait "$update" 2>/dev/null || true; fi
    rm -rf "$work"
}
trap cleanup EXIT
trap 'fail "interrupted"' INT TERM

field() { sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\{0,1\}\([^",}]*\).*/\1/p' "$1" | head -1; }
counts() { curl -fsS --max-time 10 "$feed/control/counts" >"$work/counts" || fail "read feed counts"; }
scenario() {
    curl -fsS --max-time 10 -X POST "$feed/control/scenario?mode=$1&version=$newer" >"$work/control" || fail "select $1 scenario"
}
until_file() {
    tries=0
    while ! grep -q "$2" "$1" 2>/dev/null; do
        tries=$((tries + 1)); [ "$tries" -lt 90 ] || fail "timed out waiting for $2 in $1"
        sleep 1
    done
}
pid_of_host() { field "$lock" pid; }
stop_host() {
    pid=$(pid_of_host)
    "$vera" host stop --yes >"$work/stop.log" 2>&1 || { cat "$work/stop.log"; fail "stop private host"; }
    tries=0
    while kill -0 "$pid" 2>/dev/null; do
        tries=$((tries + 1)); [ "$tries" -lt 30 ] || fail "host PID $pid did not exit"
        sleep 1
    done
}
install_old() {
    VERA_VERSION="$older" sh "$work/install.sh" >"$work/install.log" 2>&1 || { cat "$work/install.log"; fail "install older release"; }
    "$vera" --version >"$work/version" 2>&1 || fail "older version command"
    grep -q "vera $older" "$work/version" || { cat "$work/version"; fail "older version mismatch"; }
}
start_host() {
    rm -f "$work/input"
    mkfifo "$work/input"
    exec 3<>"$work/input"
    "$vera" stdio <"$work/input" >"$work/stdio.log" 2>"$work/stdio.err" &
    stdio=$!
    until_file "$work/stdio.log" stdio_attached
    [ -f "$lock" ] || fail "host lock missing"
}
detach_stdio() {
    printf '%s\n' '{"type":"detach"}' >&3
    wait "$stdio" || { cat "$work/stdio.err"; fail "detach stdio"; }
    stdio=
    exec 3>&-
}

plist_text() { plutil -extract "$2" raw -o - "$1" 2>/dev/null; }
write_faux_config() {
    printf '%s\n' '{"schema_version":1,"host":{"workers":0},"provider":"faux-local","model":"faux-model","approval_mode":"auto","providers":{"faux-local":{"protocol":"openai-chat","base_url":"'"$feed"'/v1","credential":"none"}}}' >"$home/config.json"
}
current_build() { basename "$(readlink "$share/current")"; }
# Vera.app in the temporary Applications folder: bundle id, shell marker, ad-hoc signature, no quarantine mark.
check_app() {
    [ -d "$app" ] || fail "Vera.app missing at $app"
    [ "$(plist_text "$app/Contents/Info.plist" CFBundleIdentifier)" = dev.vera.desktop ] || fail "Vera.app bundle id is not dev.vera.desktop"
    [ "$(plutil -type shell_api "$app/Contents/Resources/vera-shell.json" 2>/dev/null)" = integer ] || fail "Vera.app has no shell marker"
    codesign --verify --deep --strict "$app" >"$work/codesign.log" 2>&1 || { cat "$work/codesign.log"; fail "codesign --verify --deep --strict failed"; }
    if xattr -lr "$app" 2>/dev/null | grep -q com.apple.quarantine; then fail "Vera.app carries a quarantine mark"; fi
}
check_record() {
    [ -f "$record" ] || fail "installed.json missing"
    [ "$(plist_text "$record" layout_version)" = 1 ] && [ "$(plist_text "$record" app_path)" = "$app" ] || fail "installed.json does not record $app"
}
# The desktop package for a host build and version is whole, matches the build, and no install is left half done.
check_package() {
    dir="$share/desktop/$1/$2"
    manifest="$dir/desktop-package.json"
    [ -f "$manifest" ] || fail "no desktop package for $1 at $dir"
    [ "$(plist_text "$manifest" host_build_id)" = "$1" ] || fail "package at $dir targets another host build"
    [ "$(plist_text "$manifest" desktop_version)" = "$2" ] || fail "package at $dir is another desktop version"
    entry=$(plist_text "$manifest" entry)
    [ -n "$entry" ] && [ -f "$dir/$entry" ] || fail "package at $dir has no entry file"
    for partial in "$share/desktop/"*/.tmp-* "$share/releases/".staging-*; do [ ! -e "$partial" ] || fail "left $partial behind"; done
}
desktop_update_phase() {
    write_faux_config
    start_host
    old_pid=$(pid_of_host)
    "$vera" update >"$work/update.log" 2>&1 || { cat "$work/update.log"; fail "update failed"; }
    grep -q "Update rehearsal release $newer" "$work/update.log" || fail "release notes missing"
    grep -q "The next 'vera' starts it" "$work/update.log" || fail "cold update start notice missing"
    kill -0 "$old_pid" 2>/dev/null && fail "cold update left the old host running"
    new_build=$(current_build)
    [ "$new_build" != "$old_build" ] || fail "build did not change"
    [ "$(basename "$(readlink "$share/rollback")")" = "$old_build" ] || fail "rollback pin is not $old_build"
    check_package "$new_build" "$newer"
    check_package "$old_build" "$older"
    check_app
    check_record
    [ "$(cksum <"$record")" = "$record_sum" ] || fail "update rewrote installed.json"
    ok "update activated $new_build with its desktop package $newer; the $older package stays for rollback; app and record untouched"
    printf '%s\n' '{"type":"detach"}' >&3 || true
    wait "$stdio" 2>/dev/null || true
    stdio=
    exec 3>&-
    start_host
    until_file "$lock" "$new_build"
    [ "$(field "$lock" build_id)" = "$new_build" ] && [ "$(pid_of_host)" != "$old_pid" ] || fail "host did not start on $new_build"
    check_package "$(field "$lock" build_id)" "$newer"
    ok "host started on $new_build, the build whose desktop package is $newer"
    detach_stdio
    "$vera" rollback >"$work/rollback.log" 2>&1 || { cat "$work/rollback.log"; fail "rollback failed"; }
    until_file "$lock" "$old_build"
    [ "$(current_build)" = "$old_build" ] && [ "$(field "$lock" build_id)" = "$old_build" ] || fail "rollback did not move the host to $old_build"
    "$vera" --version >"$work/version"
    grep -q "vera $older" "$work/version" || fail "rollback version"
    check_package "$old_build" "$older"
    check_app
    [ "$(cksum <"$record")" = "$record_sum" ] || fail "rollback rewrote installed.json"
    ok "rollback moved host and desktop package back to $old_build and $older"
    stop_host
}
desktop_held_phase() {
    write_faux_config
    start_host
    old_pid=$(pid_of_host)
    scenario no-desktop
    "$vera" update >"$work/held.log" 2>&1 || { cat "$work/held.log"; fail "held update exited non-zero"; }
    cat "$work/held.log"
    grep -qF "Vera $newer is downloaded. It turns on once the desktop app for it is released; run 'vera update' again then." "$work/held.log" || fail "held line missing"
    [ "$(current_build)" = "$old_build" ] || fail "held update moved current"
    [ ! -e "$share/rollback" ] && [ ! -L "$share/rollback" ] || fail "held update created a rollback pin"
    [ "$(pid_of_host)" = "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null && [ "$(field "$lock" build_id)" = "$old_build" ] || fail "held update disturbed the host on $old_build"
    "$vera" --version >"$work/version"
    grep -q "vera $older" "$work/version" || fail "held update changed the version"
    [ "$(ls -d "$share/releases/"vera-* | wc -l | tr -d ' ')" = 2 ] || fail "held release was not unpacked beside $old_build"
    [ "$(find "$share/desktop" -mindepth 1 -maxdepth 1 -type d ! -name '.*' | wc -l | tr -d ' ')" = 1 ] || fail "held update installed a desktop package"
    check_package "$old_build" "$older"
    check_app
    [ "$(cksum <"$record")" = "$record_sum" ] || fail "held update rewrote installed.json"
    ok "held: approved line printed, current, rollback, host, packages, app and record unchanged"
    scenario normal
    detach_stdio
    "$vera" update >"$work/after-held.log" 2>&1 || { cat "$work/after-held.log"; fail "update after the desktop release appeared failed"; }
    new_build=$(current_build)
    [ "$new_build" != "$old_build" ] || fail "update after the desktop release appeared did not activate"
    kill -0 "$old_pid" 2>/dev/null && fail "cold update left the old host running"
    check_package "$new_build" "$newer"
    ok "once the desktop package existed, the next update activated $new_build with package $newer"
}
desktop_leg() {
    [ "$(uname -s)" = Darwin ] || fail "the $leg leg runs on macOS only"
    # HOME is a temporary folder only for sh and bun here, never for Electron.
    # Its .local is the daily prefix, so its .vera is the home that goes with it.
    export HOME="$prefix"
    prefix="$HOME/.local"
    home="$HOME/.vera"
    lock="$home/runtime/host.json"
    mkdir -p "$home"
    export VERA_HOME="$home"
    share="$prefix/share/vera"
    vera="$prefix/bin/vera"
    apps="$HOME/Applications"
    app="$apps/Vera.app"
    record="$share/desktop/installed.json"
    mkdir -p "$apps"
    export VERA_INSTALL_PREFIX="$prefix" VERA_DESKTOP=yes VERA_INSTALL_APPLICATIONS="$apps" VERA_INSTALL_NO_OPEN=1
    install_old
    old_build=$(current_build)
    grep -q "Installed the Vera desktop app $older" "$work/install.log" || { cat "$work/install.log"; fail "installer did not report the desktop app"; }
    check_app
    check_record
    check_package "$old_build" "$older"
    record_sum=$(cksum <"$record")
    ok "installed Vera $older ($old_build) with the desktop app: bundle id, shell marker, signature, package and record"
    case "$leg" in
        desktop-update) desktop_update_phase ;;
        desktop-held) desktop_held_phase ;;
    esac
    ok "$leg leg complete"
    exit 0
}

if [ -z "${VERA_REHEARSAL_LEG:-}" ]; then
    result=0
    legs="cold cold-palette hot wrong-checksum truncated-tarball"
    if [ "$(uname -s)" = Darwin ]; then legs="$legs desktop-install desktop-update desktop-held"; fi
    for leg in $legs; do
        echo "== leg: $leg =="
        VERA_REHEARSAL_LEG="$leg" sh "$0" "$feed" "$prefix/$leg" "$home/$leg" "$older" "$newer" || result=1
    done
    exit "$result"
fi
leg=$VERA_REHEARSAL_LEG
if [ "$leg" = hot ]; then export VERA_HOT_UPDATE=1; else unset VERA_HOT_UPDATE; fi
scenario normal
curl -fsS --max-time 30 "$feed/install.sh" >"$work/install.sh" || fail "download installer"
case "$leg" in desktop-install | desktop-update | desktop-held) desktop_leg ;; esac
install_old
old_build=$(basename "$(readlink "$share/current")")
ok "installed older Vera $older ($old_build)"
write_faux_config
start_host
old_pid=$(pid_of_host)
ok "private host started on $old_build (PID $old_pid), faux provider without credentials"
if [ "$leg" = wrong-checksum ] || [ "$leg" = truncated-tarball ]; then
    scenario "$leg"
    if "$vera" update >"$work/failure.log" 2>&1; then fail "$leg update unexpectedly succeeded"; fi
    cat "$work/failure.log"
    grep -qi 'checksum mismatch' "$work/failure.log" || fail "$leg checksum error missing"
    [ "$(basename "$(readlink "$share/current")")" = "$old_build" ] && [ "$(pid_of_host)" = "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null || fail "$leg changed current or host"
    for staging in "$share/releases/".staging-*; do [ ! -e "$staging" ] || fail "$leg left staging directory"; done
    ok "$leg refused with checksum mismatch, current and host untouched, no staging directory"
    detach_stdio
    stop_host
    ok "$leg host stopped and process exited"
    scenario normal
    exit 0
fi
counts
before=$(field "$work/counts" downloads)
status=0
"$vera" update --check >"$work/check.log" 2>&1 || status=$?
[ "$status" = 10 ] || { cat "$work/check.log"; fail "update --check exit $status, expected 10"; }
grep -q "Running Vera $older" "$work/check.log" && grep -q "Newest release is Vera $newer" "$work/check.log" || fail "check version output"
counts
[ "$(field "$work/counts" downloads)" = "$before" ] && [ "$(basename "$(readlink "$share/current")")" = "$old_build" ] || fail "check changed installation or downloaded assets"
ok "update --check reported older and newer, exit 10, no assets downloaded"

if command -v tmux >/dev/null 2>&1; then
    agent=$(sed -n 's/.*"agent_id":"\([^"]*\)".*/\1/p' "$work/stdio.log" | head -1)
    tmux -L "$tmux_name" -f /dev/null new-session -d -s crow -x 120 -y 40 "'$vera' attach '$agent'" || fail "attach TUI"
    tui=1
    tries=0
    while :; do
        tmux -L "$tmux_name" capture-pane -p -t crow >"$work/tui-start.log" || fail "capture attached TUI"
        grep -q 'Message Vera' "$work/tui-start.log" && break
        tries=$((tries + 1)); [ "$tries" -lt 30 ] || { cat "$work/tui-start.log"; fail "attached TUI did not start"; }
        sleep 1
    done
    ok "attached TUI in private tmux server"
else
    echo "skip: tmux absent, TUI reattachment not tested"
fi
printf '%s\n' '{"type":"prompt","content":"Reply with exactly: container faux passed"}' >&3
tries=0
while :; do
    counts
    [ "$(field "$work/counts" active)" -gt 0 ] && break
    tries=$((tries + 1)); [ "$tries" -lt 60 ] || fail "faux turn did not start"
    sleep 1
done
if [ "$tui" = 1 ] && [ "$leg" != hot ]; then
    tmux -L "$tmux_name" send-keys -t crow -l 'Reply with exactly: crow sails again'
fi
"$vera" update >"$work/update.log" 2>&1 &
update=$!
tries=0
while [ "$(ls -d "$share/releases/"vera-* | wc -l | tr -d ' ')" -lt 2 ]; do
    counts
    [ "$(field "$work/counts" active)" -gt 0 ] || { cat "$work/update.log"; fail "new release not unpacked beside old before faux turn ended"; }
    tries=$((tries + 1)); [ "$tries" -lt 60 ] || fail "new release not unpacked beside old"
    sleep 1
done
[ "$(basename "$(readlink "$share/current")")" = "$old_build" ] && kill -0 "$old_pid" 2>/dev/null || fail "host moved before running turn ended"
curl -fsS --max-time 10 -X POST "$feed/control/complete-turn" >"$work/control" || fail "complete faux turn"
wait "$update" || { cat "$work/update.log"; fail "update failed"; }
update=
grep -q "Update rehearsal release $newer" "$work/update.log" || fail "release notes missing"
until_file "$work/stdio.log" '"type":"turn_finished"'
grep -q '"type":"assistant_delta".*container faux passed' "$work/stdio.log" || fail "running turn did not finish with faux reply"
new_build=$(basename "$(readlink "$share/current")")
[ "$new_build" != "$old_build" ] || fail "build did not change"
if [ "$leg" = cold ] || [ "$leg" = cold-palette ]; then
    kill -0 "$old_pid" 2>/dev/null && fail "cold update left the old host running"
    grep -q "The next 'vera' starts it" "$work/update.log" || fail "cold update start notice missing"
    ok "default cold update drained the turn, stopped PID $old_pid and activated $new_build"
    if [ "$tui" = 1 ]; then
        tries=0
        while :; do
            tmux -L "$tmux_name" capture-pane -p -t crow >"$work/tui-stop.log" || fail "capture stopped TUI"
            grep -q 'The host stopped' "$work/tui-stop.log" && break
            tries=$((tries + 1)); [ "$tries" -lt 30 ] || { cat "$work/tui-stop.log"; fail "planned-stop screen missing"; }
            sleep 1
        done
        ok "$leg TUI displayed the planned stop"
        if [ "$leg" = cold ]; then
            tmux -L "$tmux_name" send-keys -t crow C-l
        else
            tmux -L "$tmux_name" send-keys -t crow C-p
            sleep 1
            tmux -L "$tmux_name" send-keys -t crow -l 'reconnect host'
            sleep 1
            tmux -L "$tmux_name" send-keys -t crow Enter
        fi
    else
        printf '%s\n' '{"type":"detach"}' >&3 || true
        wait "$stdio" 2>/dev/null || true
        stdio=
        exec 3>&-
        start_host
        ok "next vera stdio command invoked after cold activation"
    fi
fi
until_file "$lock" "$new_build"
[ "$(field "$lock" build_id)" = "$new_build" ] || fail "host build does not match $new_build"
new_pid=$(pid_of_host)
[ "$new_pid" != "$old_pid" ] || fail "host PID did not change"
[ "$(basename "$(readlink "$share/rollback")")" = "$old_build" ] && [ -d "$share/releases/$old_build" ] || fail "rollback not retained"
"$vera" --version >"$work/version"
grep -q "vera $newer" "$work/version" || fail "new version mismatch"
ok "$leg: notes printed, new release unpacked beside old, running turn finished, host on $new_build (PID $new_pid), rollback kept, version $newer"
if [ "$tui" = 1 ]; then
    sleep 4
    pane_tty=$(tmux -L "$tmux_name" display-message -p -t crow '#{pane_tty}')
    stty -a <"$pane_tty" >"$work/tty-mode" || fail "read TUI terminal mode"
    grep -Eq '(^|[ ;])-icanon([ ;]|$)' "$work/tty-mode" || { cat "$work/tty-mode"; fail "relaunched TUI terminal is not in raw mode"; }
    grep -Eq '(^|[ ;])-echo([ ;]|$)' "$work/tty-mode" || { cat "$work/tty-mode"; fail "relaunched TUI terminal has echo enabled"; }
    ok "relaunched TUI terminal has canonical mode and echo disabled"
    counts
    before=$(field "$work/counts" requests)
    before_completed=$(field "$work/counts" completed)
    if [ "$leg" = hot ]; then
        tmux -L "$tmux_name" send-keys -t crow -l 'Reply with exactly: container faux passed'
    else
        tmux -L "$tmux_name" capture-pane -p -t crow >"$work/tui-restored.log"
        grep -q 'Reply with exactly: crow sails again' "$work/tui-restored.log" || fail "unsent draft was not restored"
        grep -q 'container faux passed' "$work/tui-restored.log" || fail "session transcript was not restored"
        ok "$leg TUI restored the session and unsent draft"
    fi
    sleep 1
    tmux -L "$tmux_name" send-keys -t crow Enter
    tries=0
    while :; do
        counts
        [ "$(field "$work/counts" requests)" -gt "$before" ] && break
        tries=$((tries + 1)); [ "$tries" -lt 30 ] || { tmux -L "$tmux_name" capture-pane -p -t crow; fail "TUI did not reattach and send a turn on new build"; }
        sleep 1
    done
    curl -fsS --max-time 10 -X POST "$feed/control/complete-turn" >"$work/control" || fail "complete reattached TUI turn"
    tries=0
    while :; do
        counts
        [ "$(field "$work/counts" completed)" -gt "$before_completed" ] && [ "$(field "$work/counts" active)" = 0 ] && break
        tries=$((tries + 1)); [ "$tries" -lt 30 ] || fail "reattached TUI turn did not finish"
        sleep 1
    done
    sleep 2
    tmux -L "$tmux_name" capture-pane -p -t crow >"$work/tui.log"
    grep -q 'container faux passed' "$work/tui.log" || fail "reattached TUI did not show reply"
    ok "TUI reattached on new build and completed a second faux turn"
    tmux -L "$tmux_name" send-keys -t crow C-x d
    sleep 1
    tmux -L "$tmux_name" kill-server 2>/dev/null || true
    tui=0
fi
# The old stdio client can disconnect during a build handoff.
printf '%s\n' '{"type":"detach"}' >&3 || true
wait "$stdio" 2>/dev/null || true
stdio=
exec 3>&-
counts
before=$(field "$work/counts" downloads)
"$vera" update >"$work/again.log" 2>&1 || { cat "$work/again.log"; fail "second update"; }
grep -q 'is up to date' "$work/again.log" || fail "up-to-date message missing"
counts
[ "$(field "$work/counts" downloads)" = "$before" ] || fail "up-to-date update downloaded assets"
ok "second update reported up to date, no assets downloaded"
"$vera" rollback >"$work/rollback.log" 2>&1 || { cat "$work/rollback.log"; fail "rollback"; }
until_file "$lock" "$old_build"
[ "$(basename "$(readlink "$share/current")")" = "$old_build" ] || fail "rollback current"
"$vera" --version >"$work/version"
grep -q "vera $older" "$work/version" || fail "rollback version"
ok "rollback restored $older and host returned to $old_build"
stop_host
ok "$leg journey host stopped and process exited"
scenario normal
ok "$leg leg complete"
