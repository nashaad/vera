#!/bin/sh
set -eu

if [ "${VERA_REHEARSAL_CLEAN:-}" != 1 ]; then
    exec env -i HOME="${HOME:?}" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" TERM=xterm-256color VERA_REHEARSAL_CLEAN=1 VERA_REHEARSAL_LEG="${VERA_REHEARSAL_LEG:-}" sh "$0" "$@"
fi

cleanup_installed=0
paths_created=0
fail() {
    echo "FAIL: $*"
    if [ "$cleanup_installed" = 0 ] && [ "$paths_created" = 1 ]; then
        echo "Rehearsal paths kept: $original_prefix $original_home" >&2
    fi
    exit 1
}
ok() { echo "ok: $*"; }
[ "$#" = 5 ] || fail "usage: update-rehearsal-client.sh FEED PREFIX HOME OLDER NEWER"
feed=${1%/}
original_prefix=$2
original_home=$3
daily_home=$HOME
prefix=$original_prefix
home=$original_home
older=${4#v}
newer=${5#v}
case "$prefix:$home" in /*:/*) ;; *) fail "prefix and home must be absolute paths" ;; esac
[ ! -e "$prefix" ] && [ ! -e "$home" ] || fail "prefix and home must not exist"
case "$prefix/" in "$HOME/.local/"*) fail "daily prefix refused" ;; esac
case "$home/" in "$HOME/.vera/"*) fail "daily home refused" ;; esac
mkdir -p "$prefix" "$home" || fail "create prefix and home"
paths_created=1
export VERA_HOME="$home" VERA_INSTALL_PREFIX="$prefix"
export VERA_RELEASES_API="$feed/releases" VERA_RELEASES_DOWNLOAD_BASE="$feed"
export VERA_DESKTOP=no
work=$(mktemp -d) || fail "create scratch folder"
vera="$prefix/bin/vera"
share="$prefix/share/vera"
lock="$home/runtime/host.json"
stdio=
update=
tmux_name="vera-rehearsal-$$"
tui=0
image_mounted=0
cleanup() {
    cleanup_status=$?
    # A failed complete-turn means there is no feed to wait on; its counts would fail the same way.
    if curl -fsS --max-time 10 -X POST "$feed/control/complete-turn" >/dev/null 2>&1; then
        tries=0
        while ! curl -fsS --max-time 10 "$feed/control/counts" 2>/dev/null | grep -q '"active":0'; do
            tries=$((tries + 1)); [ "$tries" -lt 10 ] || break
            sleep 1
        done
    fi
    if [ "$tui" = 1 ]; then tmux -L "$tmux_name" kill-server 2>/dev/null || true; fi
    if [ -n "$stdio" ]; then
        printf '%s\n' '{"type":"detach"}' >&3 2>/dev/null || true
        kill "$stdio" 2>/dev/null || true
        wait "$stdio" 2>/dev/null || true
    fi
    if [ -x "$vera" ] && [ -f "$lock" ]; then
        cleanup_pid=$(pid_of_host)
        "$vera" host stop --yes >"$work/cleanup.log" 2>&1 || { cat "$work/cleanup.log"; cleanup_status=1; }
        if kill -0 "$cleanup_pid" 2>/dev/null; then
            echo "FAIL: cleanup left private host PID $cleanup_pid in $home"
            cleanup_status=1
        fi
    fi
    if [ -n "$update" ]; then kill "$update" 2>/dev/null || true; wait "$update" 2>/dev/null || true; fi
    if [ "$image_mounted" = 1 ]; then
        if hdiutil detach "$prefix" -force >/dev/null 2>&1; then
            image_mounted=0
        else
            echo "FAIL: could not detach the disk image at $prefix; image kept in $work"
            cleanup_status=1
        fi
    fi
    if [ "$image_mounted" = 0 ]; then rm -rf "$work"; fi
    case "$original_prefix/" in "$daily_home/.local/"*) cleanup_status=1 ;; esac
    case "$original_home/" in "$daily_home/.vera/"*) cleanup_status=1 ;; esac
    if [ "$cleanup_status" = 0 ]; then
        rm -rf "$original_prefix" "$original_home" || cleanup_status=1
    fi
    if [ "$cleanup_status" != 0 ]; then
        echo "Rehearsal paths kept: $original_prefix $original_home" >&2
    fi
    exit "$cleanup_status"
}
trap cleanup EXIT
cleanup_installed=1
trap 'fail "interrupted"' INT TERM

field() { sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\{0,1\}\([^",}]*\).*/\1/p' "$1" | head -1; }
counts() { curl -fsS --max-time 10 "$feed/control/counts" >"$work/counts" || fail "read feed counts"; }
scenario() {
    curl -fsS --max-time 10 -X POST "$feed/control/scenario?mode=$1&version=$newer" >"$work/control" 2>"$work/control.err" || { cat "$work/control.err" 2>/dev/null; fail "select $1 scenario"; }
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
# After a stop the client may already be gone.
drop_stdio() {
    printf '%s\n' '{"type":"detach"}' >&3 2>/dev/null || true
    if [ -n "$stdio" ]; then kill "$stdio" 2>/dev/null || true; wait "$stdio" 2>/dev/null || true; fi
    stdio=
    exec 3>&- 2>/dev/null || true
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
# Last JSON line of a file, as a file that `field` can read.
last_json() { tail -1 "$1" >"$work/last"; echo "$work/last"; }
# The pair on disk is whole: current and rollback reach releases, no staging or lock is left, and `vera boot --json`
# starts a host on the build current names. Boot leaves that host running.
no_leftovers() {
    for partial in "$share/releases/".staging-* "$share/releases/".install-* "$share/".current.* "$share/".rollback.*; do
        [ ! -e "$partial" ] || fail "$1: left $partial behind"
    done
    # A killed run's lock stays until the next update takes it over; one held by a live process is a leftover.
    if [ -e "$share/.update.lock" ] && kill -0 "$(field "$share/.update.lock" pid)" 2>/dev/null; then
        fail "$1: $share/.update.lock is held by a live process"
    fi
}
whole_pair() {
    cur=$(current_build)
    [ -d "$share/releases/$cur/" ] && [ -d "$share/current/" ] || fail "$1: current does not reach a release"
    if [ -L "$share/rollback" ] && [ ! -d "$share/rollback/" ]; then fail "$1: the rollback pin dangles"; fi
    "$vera" boot --json </dev/null >"$work/boot.out" 2>"$work/boot.err" || { cat "$work/boot.out" "$work/boot.err"; fail "$1: vera boot --json failed"; }
    grep -q '"type":"ready"' "$work/boot.out" || { cat "$work/boot.out"; fail "$1: vera boot --json did not report ready"; }
    tail -1 "$work/boot.out" >"$work/boot.last"
    [ "$(field "$work/boot.last" build_id)" = "$cur" ] || { cat "$work/boot.out"; fail "$1: the host booted on another build than $cur"; }
}
# Runs `vera update --json`; leaves the final line in $work/last and its fields readable with `field`.
update_json() {
    update_status=0
    "$vera" update --json </dev/null >"$work/update.out" 2>"$work/update.err" || update_status=$?
    last_json "$work/update.out" >/dev/null
}
update_done() {
    update_json
    [ "$update_status" = 0 ] || { cat "$work/update.out" "$work/update.err"; fail "$1: update exit $update_status"; }
    case "$(field "$work/last" result)" in done | up_to_date) ;; *) cat "$work/update.out"; fail "$1: update ended $(field "$work/last" result)" ;; esac
}
back_to_old() {
    "$vera" rollback </dev/null >"$work/rollback.out" 2>&1 || { cat "$work/rollback.out"; fail "rollback to $old_build failed"; }
    [ "$(current_build)" = "$old_build" ] || fail "rollback left current on $(current_build)"
}
killed() {
    [ "$1" = 137 ] || { cat "$work/kill.out" "$work/kill.err"; fail "$2: exit $1, expected 137 (killed)"; }
}
begin_busy_turn() {
    printf '%s\n' '{"type":"prompt","content":"Reply with exactly: container faux passed"}' >&3
    tries=0
    while :; do
        counts
        [ "$(field "$work/counts" active)" -gt 0 ] && break
        tries=$((tries + 1)); [ "$tries" -lt 60 ] || fail "faux turn did not start"
        sleep 1
    done
}
finish_busy_turn() {
    curl -fsS --max-time 10 -X POST "$feed/control/complete-turn" >"$work/control" || fail "complete faux turn"
    until_file "$work/stdio.log" '"type":"turn_finished"'
}
# A busy turn is untouched by an update that held or cancelled.
still_busy() {
    counts
    [ "$(field "$work/counts" active)" = 1 ] && kill -0 "$old_pid" 2>/dev/null && [ "$(current_build)" = "$old_build" ] || fail "$1: the busy session, the host or current was disturbed"
}

network_drop_leg() {
    scenario drop-mid-download
    update_json
    [ "$update_status" = 1 ] || { cat "$work/update.out"; fail "dropped download: exit $update_status, expected 1"; }
    [ "$(field "$work/last" result)" = failed ] && [ "$(field "$work/last" changed)" = false ] || { cat "$work/update.out"; fail "dropped download did not end failed with changed false"; }
    cat "$work/last"
    grep -q '"message":"Not enough disk space to download Vera ' "$work/last" || fail "full disk did not say there is not enough disk space"
    [ "$(current_build)" = "$old_build" ] && [ "$(pid_of_host)" = "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null || fail "dropped download changed current or the host"
    [ "$(ls -d "$share/releases/"vera-* | wc -l | tr -d ' ')" = 1 ] || fail "dropped download left a release beside $old_build"
    no_leftovers "dropped download"
    detach_stdio
    whole_pair "after the dropped download"
    ok "network drop mid-download: failed with changed false, nothing staged, pair whole and boots"
    scenario normal
    update_done "retry after the dropped download"
    [ "$(current_build)" != "$old_build" ] && [ "$(field "$work/last" changed)" = true ] || fail "retry did not switch"
    whole_pair "after the retry"
    ok "retry after the dropped download completed on $(current_build)"
}
disk_full_leg() {
    [ "$(uname -s)" = Darwin ] || fail "the $leg leg needs hdiutil, which is macOS only"
    hdiutil create -size 700m -fs HFS+ -volname vera-full -type SPARSE "$work/full" >/dev/null 2>&1 || fail "hdiutil create"
    hdiutil attach -nobrowse -mountpoint "$prefix" "$work/full.sparseimage" >/dev/null 2>&1 || fail "hdiutil attach"
    image_mounted=1
    install_old
    old_build=$(current_build)
    write_faux_config
    start_host
    old_pid=$(pid_of_host)
    avail_kb=$(df -k "$prefix" | awk 'NR == 2 { print $4 }')
    dd if=/dev/zero of="$prefix/.filler" bs=1048576 count=$((avail_kb / 1024 - 8)) >/dev/null 2>&1 || fail "could not fill the disk image"
    free_kb=$(df -k "$prefix" | awk 'NR == 2 { print $4 }')
    ok "installed $older on a 700 MB HFS+ disk image at $prefix with $free_kb KB free"
    update_json
    [ "$update_status" = 1 ] || { cat "$work/update.out"; fail "full disk: exit $update_status, expected 1"; }
    [ "$(field "$work/last" result)" = failed ] && [ "$(field "$work/last" changed)" = false ] || { cat "$work/update.out"; fail "full disk did not end failed with changed false"; }
    cat "$work/last"
    [ "$(current_build)" = "$old_build" ] && [ "$(pid_of_host)" = "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null || fail "full disk changed current or the host"
    [ "$(ls -d "$share/releases/"vera-* | wc -l | tr -d ' ')" = 1 ] || fail "full disk left a release beside $old_build"
    no_leftovers "full disk"
    detach_stdio
    whole_pair "on the full disk"
    ok "disk full: failed with changed false, nothing left behind, pair whole and boots"
    rm -f "$prefix/.filler"
    update_done "retry with space"
    [ "$(current_build)" != "$old_build" ] && [ "$(field "$work/last" changed)" = true ] || fail "retry did not switch"
    whole_pair "after the retry"
    ok "retry with space completed on $(current_build)"
}
kill_update_leg() {
    detach_stdio
    steps="update:release-staged update:before-switch install:host-stopped activate:start activate:rollback-linked activate:current-linked activate:launcher-written install:activated"
    # A feed built without desktop assets has no package step to kill at.
    if [ -n "$(find "$share/desktop" -mindepth 1 -maxdepth 1 -type d ! -name '.*' 2>/dev/null)" ]; then
        steps="update:release-staged update:package-staged ${steps#update:release-staged }"
    fi
    for step in $steps; do
        whole_pair "before the kill at $step"
        [ "$(current_build)" = "$old_build" ] || fail "$step: not on $old_build"
        status=0
        VERA_UPDATE_EXIT_AT=$step "$vera" update --json </dev/null >"$work/kill.out" 2>"$work/kill.err" || status=$?
        killed "$status" "$step"
        whole_pair "after a kill at $step"
        update_done "the rerun after $step"
        [ "$(current_build)" != "$old_build" ] || fail "$step: the rerun did not switch"
        whole_pair "after the rerun of $step"
        no_leftovers "$step"
        ok "killed at $step: whole pair, boots, rerun completed on $(current_build)"
        back_to_old
    done
}
kill_rollback_leg() {
    detach_stdio
    for step in upgrade:journal-activating activate:start activate:rollback-linked activate:current-linked upgrade:activated upgrade:journal-starting; do
        update_done "before the rollback killed at $step"
        whole_pair "before the rollback killed at $step"
        # With a live host a rollback is carried out by the host, outside this process, so the kill steps need it stopped.
        "$vera" host stop --yes </dev/null >"$work/stop.log" 2>&1 || { cat "$work/stop.log"; fail "$step: could not stop the host"; }
        status=0
        VERA_UPDATE_EXIT_AT=$step "$vera" rollback </dev/null >"$work/kill.out" 2>"$work/kill.err" || status=$?
        killed "$status" "rollback at $step"
        whole_pair "after a rollback killed at $step"
        "$vera" rollback </dev/null >"$work/rollback.out" 2>&1 || { cat "$work/rollback.out"; fail "$step: the rollback rerun failed"; }
        whole_pair "after the rollback rerun of $step"
        [ ! -e "$share/upgrade.json" ] || fail "$step: the journal is still there"
        no_leftovers "rollback at $step"
        ok "rollback killed at $step: whole pair, boots, rerun finished on $(current_build)"
    done
}
busy_held_leg() {
    begin_busy_turn
    status=0
    VERA_UPDATE_BUSY_LIMIT_MS=7000 "$vera" update --json </dev/null >"$work/busy.out" 2>"$work/busy.err" || status=$?
    cat "$work/busy.out"
    [ "$status" = 0 ] || fail "busy limit: exit $status, expected 0"
    grep -q '"phase":"waiting","sessions":\[{"id":"[^"]*","title":"[^"]\{1,\}"}\],"waited_ms":[0-9]*,"limit_ms":7000' "$work/busy.out" || fail "the waiting line does not name the session"
    ! grep -q '"phase":"switching"' "$work/busy.out" || fail "busy limit reached the switch"
    last_json "$work/busy.out" >/dev/null
    [ "$(field "$work/last" result)" = held ] && [ "$(field "$work/last" changed)" = false ] || fail "busy limit did not end held with changed false"
    still_busy "busy limit"
    ok "busy at the limit: waiting line names the session, held with changed false, host, turn and current untouched"
    finish_busy_turn
    update_done "after the busy turn ended"
    [ "$(field "$work/last" changed)" = true ] && [ "$(current_build)" != "$old_build" ] || fail "the update after the turn did not switch"
    kill -0 "$old_pid" 2>/dev/null && fail "the cold update left the old host running"
    drop_stdio
    whole_pair "after the busy update"
    ok "the update completed on $(current_build) once the session finished"
}
busy_cancelled_leg() {
    begin_busy_turn
    for signal in INT TERM; do
        # The release wrapper keeps INT and TERM for itself, so the run is signalled as a group, as a terminal's Ctrl-C does.
        perl -e '$SIG{INT} = "DEFAULT"; setpgrp(0, 0); exec @ARGV' "$vera" update --json </dev/null >"$work/cancel.out" 2>"$work/cancel.err" &
        update=$!
        until_file "$work/cancel.out" '"phase":"waiting"'
        kill "-$signal" -- "-$update"
        status=0
        wait "$update" || status=$?
        update=
        cat "$work/cancel.out"
        [ "$status" = 1 ] || fail "SIG$signal during the wait: exit $status, expected 1"
        last_json "$work/cancel.out" >/dev/null
        [ "$(field "$work/last" result)" = cancelled ] && [ "$(field "$work/last" changed)" = false ] || fail "SIG$signal did not end cancelled with changed false"
        ! grep -q '"phase":"switching"' "$work/cancel.out" || fail "SIG$signal reached the switch"
        still_busy "SIG$signal"
        ok "SIG$signal while waiting: cancelled with changed false, host, turn and current untouched"
    done
    finish_busy_turn
    detach_stdio
    whole_pair "after the cancelled updates"
    update_done "after the cancelled updates"
    [ "$(current_build)" != "$old_build" ] || fail "the update after the cancels did not switch"
    ok "the update completed on $(current_build) after two cancels"
}
busy_host_killed_leg() {
    begin_busy_turn
    "$vera" update --json </dev/null >"$work/hostkill.out" 2>"$work/hostkill.err" &
    update=$!
    until_file "$work/hostkill.out" '"phase":"waiting"'
    kill -9 "$old_pid"
    status=0
    wait "$update" || status=$?
    update=
    cat "$work/hostkill.out" "$work/hostkill.err"
    last_json "$work/hostkill.out" >/dev/null
    drop_stdio
    case "$(field "$work/last" result)" in
        done) [ "$(field "$work/last" changed)" = true ] || fail "done without a switch" ;;
        failed) [ "$(field "$work/last" changed)" = false ] || fail "failed after a switch" ;;
        *) fail "the update ended $(field "$work/last" result) after its host was killed" ;;
    esac
    whole_pair "after the host was killed"
    update_done "after the host was killed"
    [ "$(current_build)" != "$old_build" ] || fail "the update did not complete after the host was killed"
    whole_pair "after the update completed"
    ok "host killed during the wait: update ended $(field "$work/last" result), pair whole, boots, update completed on $(current_build)"
}
client_quit_leg() {
    detach_stdio
    "$vera" update --json </dev/null 2>"$work/quit.err" | head -n 1 >"$work/quit.out" || true
    sleep 5
    cat "$work/quit.out"
    no_leftovers "client quit"
    whole_pair "after the client quit"
    ok "client quit after the first line: pair whole ($(current_build)) and boots"
    update_done "after the client quit"
    [ "$(current_build)" != "$old_build" ] || fail "the update after the client quit did not switch"
    whole_pair "after the update completed"
    ok "update completed on $(current_build)"
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
# These two legs need a feed built with --newer-shell and run on macOS only; the desktop legs are not part of the terminal proof.
shell_api_of() { plist_text "$app/Contents/Resources/vera-shell.json" shell_api; }
no_app_leftovers() {
    for partial in "$apps/".Vera.app.old-* "$apps/".Vera.app.new-* "$share/desktop/.shell-downloads"; do
        [ ! -e "$partial" ] || fail "$1: left $partial beside the app"
    done
}
desktop_shell_swap_phase() {
    write_faux_config
    start_host
    old_pid=$(pid_of_host)
    [ "$(shell_api_of)" = 1 ] || fail "the installed app is not shell API 1"
    detach_stdio
    update_done "the update that needs a newer shell"
    [ "$(field "$work/last" changed)" = true ] || fail "the update that needs a newer shell did not switch"
    grep -q '"phase":"switching"' "$work/update.out" || fail "no switching line before the app was replaced"
    new_build=$(current_build)
    [ "$new_build" != "$old_build" ] || fail "build did not change"
    [ "$(shell_api_of)" = 2 ] || fail "the app was not replaced by the newer shell"
    check_app
    check_package "$new_build" "$newer"
    check_package "$old_build" "$older"
    no_app_leftovers "after the swap"
    [ "$(cksum <"$record")" = "$record_sum" ] || fail "the update rewrote installed.json"
    whole_pair "after the shell swap"
    ok "update replaced Vera.app with shell API 2 and moved host and package to $new_build, $newer; the $older package stays"
    # The desktop starts a rollback with `vera rollback`; the shell is never rolled back.
    "$vera" rollback >"$work/rollback.log" 2>&1 || { cat "$work/rollback.log"; fail "rollback failed"; }
    [ "$(current_build)" = "$old_build" ] || fail "rollback did not return to $old_build"
    [ "$(shell_api_of)" = 2 ] || fail "rollback replaced the app"
    check_app
    check_package "$old_build" "$older"
    [ "$(cksum <"$record")" = "$record_sum" ] || fail "rollback rewrote installed.json"
    whole_pair "after the rollback"
    ok "rollback returned host and package to $old_build and $older; the newer shell stays and loads the older package"
    stop_host
}
desktop_shell_held_phase() {
    write_faux_config
    start_host
    old_pid=$(pid_of_host)
    detach_stdio
    cp -R "$app" "$work/Vera.app.saved" || fail "could not save the app"
    rm -rf "$app"
    update_json
    [ "$(field "$work/last" result)" = held ] && [ "$(field "$work/last" changed)" = false ] || { cat "$work/update.out"; fail "no app: the update was not held"; }
    grep -q "there is no app at $app" "$work/update.out" || { cat "$work/update.out"; fail "no app: the held message is missing"; }
    [ "$(current_build)" = "$old_build" ] || fail "no app: current moved"
    whole_pair "with no app"
    ok "no app at the recorded path: held, nothing changed, pair whole and boots"
    mv "$work/Vera.app.saved" "$app"
    chmod a-w "$apps"
    update_json
    chmod u+w "$apps"
    [ "$(field "$work/last" result)" = held ] && [ "$(field "$work/last" changed)" = false ] || { cat "$work/update.out"; fail "read-only folder: the update was not held"; }
    grep -q "is not writable" "$work/update.out" || { cat "$work/update.out"; fail "read-only folder: the held message is missing"; }
    [ "$(current_build)" = "$old_build" ] || fail "read-only folder: current moved"
    [ "$(shell_api_of)" = 1 ] || fail "read-only folder: the app changed"
    whole_pair "with a read-only Applications folder"
    ok "read-only Applications folder: held, nothing changed, app untouched"
    update_done "the update once the folder is writable"
    [ "$(shell_api_of)" = 2 ] && [ "$(current_build)" != "$old_build" ] || fail "the update did not complete once the folder was writable"
    check_app
    no_app_leftovers "after the held updates"
    whole_pair "after the update"
    ok "the update completed on $(current_build) once the folder was writable"
    stop_host
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
        desktop-shell-swap) desktop_shell_swap_phase ;;
        desktop-shell-held) desktop_shell_held_phase ;;
    esac
    ok "$leg leg complete"
    exit 0
}

if [ -z "${VERA_REHEARSAL_LEG:-}" ]; then
    result=0
    legs="cold cold-palette hot wrong-checksum truncated-tarball network-drop kill-update kill-rollback busy-held busy-cancelled busy-host-killed client-quit"
    if [ "$(uname -s)" = Darwin ]; then legs="$legs disk-full desktop-install desktop-update desktop-held desktop-shell-swap desktop-shell-held"; fi
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
case "$leg" in desktop-install | desktop-update | desktop-held | desktop-shell-swap | desktop-shell-held) desktop_leg ;; esac
if [ "$leg" = disk-full ]; then
    disk_full_leg
    stop_host
    scenario normal
    ok "$leg leg complete"
    exit 0
fi
install_old
old_build=$(basename "$(readlink "$share/current")")
ok "installed older Vera $older ($old_build)"
write_faux_config
start_host
old_pid=$(pid_of_host)
ok "private host started on $old_build (PID $old_pid), faux provider without credentials"
terminal_fn=
case "$leg" in
    network-drop) terminal_fn=network_drop_leg ;;
    kill-update) terminal_fn=kill_update_leg ;;
    kill-rollback) terminal_fn=kill_rollback_leg ;;
    busy-held) terminal_fn=busy_held_leg ;;
    busy-cancelled) terminal_fn=busy_cancelled_leg ;;
    busy-host-killed) terminal_fn=busy_host_killed_leg ;;
    client-quit) terminal_fn=client_quit_leg ;;
esac
if [ -n "$terminal_fn" ]; then
    "$terminal_fn"
    stop_host
    ok "$leg host stopped and process exited"
    # A turn that the feed still holds for a host that was killed blocks a scenario change.
    curl -fsS --max-time 10 -X POST "$feed/control/complete-turn" >/dev/null 2>&1 || true
    scenario normal
    ok "$leg leg complete"
    exit 0
fi
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
