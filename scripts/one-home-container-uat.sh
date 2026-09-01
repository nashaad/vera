#!/bin/sh
# OVU-38 one-home UAT in a disposable Linux container.
# Chrome browsing-extension checks are out of scope.
set -eu

die() {
    echo "vera one-home container uat: $*" >&2
    exit 1
}

command -v docker >/dev/null 2>&1 || die "required command not found: docker"
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

docker info >/dev/null 2>&1 || die "docker daemon is not running"

image=oven/bun:1.3.6-slim
if [ "$(uname -m)" = "x86_64" ]; then
    image=oven/bun:1.3.6-slim@sha256:9d20d1b535596c4a021ba2087d2d303c4098e96be15f47775729cf7a259bb41e
fi

docker run --rm --init \
    -v "$root:/src:ro" \
    -v "$root/test/fixtures/faux-openai-server.ts:/faux-openai-server.ts:ro" \
    "$image" \
    sh -eu -c '
        export DEBIAN_FRONTEND=noninteractive
        apt-get update >/dev/null
        apt-get install -y --no-install-recommends ca-certificates curl git >/dev/null

        mkdir -p /tmp/vera
        tar -C /src --exclude node_modules --exclude .git --exclude dist \
            --exclude .vera-test-home -cf - . \
            | tar -C /tmp/vera -xf -
        cd /tmp/vera
        git init >/dev/null
        git config user.email uat@vera.local
        git config user.name uat
        git add -A
        git commit -m uat >/dev/null

        bun install

        export HOME=/tmp/vera-user
        export VERA_HOME=$HOME/.vera
        mkdir -p \
            "$VERA_HOME/machine" \
            "$VERA_HOME/profiles/default/memory" \
            "$VERA_HOME/profiles/other/memory"
        printf "%s\n" "{}" > "$VERA_HOME/machine/auth.json"
        printf "%s\n" "{\"schema_version\":1,\"provider\":\"faux-local\",\"model\":\"faux-model\",\"approval_mode\":\"auto\",\"providers\":{\"faux-local\":{\"protocol\":\"openai-chat\",\"base_url\":\"http://127.0.0.1:8790/v1\",\"credential\":\"none\"}}}" \
            > "$VERA_HOME/profiles/default/config.json"
        printf "%s\n" "from default" > "$VERA_HOME/profiles/default/memory/note.md"
        printf "%s\n" "other-config" > "$VERA_HOME/profiles/other/config.json"
        printf "%s\n" "must not lift" > "$VERA_HOME/profiles/other/memory/secret.md"

        echo "== refuse unmigrated home =="
        if bun clients/cli/main.ts ls > /tmp/ls.out 2>/tmp/ls.err; then
            echo "expected ls to refuse an unmigrated home" >&2
            cat /tmp/ls.err >&2
            exit 1
        fi
        grep -q "still uses the profiles/ layout" /tmp/ls.err
        grep -q "vera migrate-home" /tmp/ls.err

        echo "== migrate-home =="
        bun clients/cli/main.ts migrate-home > /tmp/migrate.out
        grep -q "Other profiles kept in backup: other" /tmp/migrate.out
        test -f "$VERA_HOME/config.json"
        test -f "$VERA_HOME/memory/note.md"
        test ! -e "$VERA_HOME/profiles"
        test ! -e "$VERA_HOME/memory/secret.md"
        test "$(cat "$VERA_HOME/memory/note.md")" = "from default"

        echo "== clean-machine install =="
        bun run install:local --prefix /tmp/vera-prefix --force
        export PATH=/tmp/vera-prefix/bin:$PATH
        vera --version
        vera --help >/tmp/vera-help.txt
        grep -q "Run one bounded turn" /tmp/vera-help.txt

        echo "== hostless bounded run =="
        bun /faux-openai-server.ts >/tmp/faux-openai-server.log 2>&1 &
        faux_pid=$!
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
        response=$(vera -p "Reply with exactly: container faux passed" --prompt-only)
        test "$response" = "container faux passed"

        echo "== daily multi-client =="
        release=$(readlink -f /tmp/vera-prefix/share/vera/current)
        test -x "$release/host"
        "$release/host" >/tmp/host.log 2>&1 &
        host_wrapper_pid=$!
        ready=0
        for attempt in $(seq 1 200); do
            if [ -S "$VERA_HOME/runtime/host.sock" ] && [ -f "$VERA_HOME/runtime/host.json" ]; then
                ready=1
                break
            fi
            sleep 0.1
        done
        if [ "$ready" != 1 ]; then
            echo "host did not publish $VERA_HOME/runtime/host.sock" >&2
            echo "release=$release" >&2
            ls -la "$release" >&2
            ls -la "$VERA_HOME" >&2 || true
            ls -la "$VERA_HOME/runtime" >&2 || true
            echo "--- host.log ---" >&2
            cat /tmp/host.log >&2 || true
            exit 1
        fi
        host_pid=$(bun -e "console.log(JSON.parse(await Bun.file(process.argv[1]).text()).pid)" "$VERA_HOME/runtime/host.json")
        test -n "$host_pid"
        if ! vera ls >/tmp/ls-a.txt 2>/tmp/ls-a.err; then
            echo "first vera ls failed" >&2
            cat /tmp/ls-a.err >&2
            cat /tmp/host.log >&2 || true
            exit 1
        fi
        if ! vera ls >/tmp/ls-b.txt 2>/tmp/ls-b.err; then
            echo "second vera ls failed" >&2
            cat /tmp/ls-b.err >&2
            exit 1
        fi
        host_pid_again=$(bun -e "console.log(JSON.parse(await Bun.file(process.argv[1]).text()).pid)" "$VERA_HOME/runtime/host.json")
        test "$host_pid" = "$host_pid_again"
        test -S "$VERA_HOME/runtime/host.sock"

        echo "== worktree isolation =="
        git worktree add /tmp/wt-a >/dev/null
        git worktree add /tmp/wt-b >/dev/null
        ln -s /tmp/vera/node_modules /tmp/wt-a/node_modules
        ln -s /tmp/vera/node_modules /tmp/wt-b/node_modules
        if ! (cd /tmp/wt-a && bun run scripts/dev-tui.ts --status > /tmp/status-a.txt); then
            echo "dev-tui --status failed in wt-a" >&2
            exit 1
        fi
        if ! (cd /tmp/wt-b && bun run scripts/dev-tui.ts --status > /tmp/status-b.txt); then
            echo "dev-tui --status failed in wt-b" >&2
            exit 1
        fi
        home_a=$(sed -n "s/^Home: //p" /tmp/status-a.txt)
        home_b=$(sed -n "s/^Home: //p" /tmp/status-b.txt)
        sock_a=$(sed -n "s/^Socket: //p" /tmp/status-a.txt)
        sock_b=$(sed -n "s/^Socket: //p" /tmp/status-b.txt)
        test -n "$home_a"
        test -n "$home_b"
        test "$home_a" != "$home_b"
        test "$sock_a" != "$sock_b"
        test "$home_a" != "$VERA_HOME"
        test "$home_b" != "$VERA_HOME"

        echo "== /usage =="
        "$release/vera-annex" --home "$VERA_HOME" --port 0 --assets "$release/annex" \
            >/tmp/annex.out 2>/tmp/annex.err &
        annex_pid=$!
        ready=0
        annex_url=
        for attempt in $(seq 1 50); do
            annex_url=$(sed -n "s|\\r||g; /^http:\\/\\/127.0.0.1:/p" /tmp/annex.out | head -n 1)
            if [ -n "$annex_url" ]; then
                ready=1
                break
            fi
            sleep 0.1
        done
        if [ "$ready" != 1 ]; then
            echo "annex did not print a loopback URL" >&2
            cat /tmp/annex.out >&2 || true
            cat /tmp/annex.err >&2 || true
            exit 1
        fi
        case "$annex_url" in
            */) ;;
            *) annex_url="${annex_url}/" ;;
        esac
        curl --fail --silent --show-error "${annex_url}usage" >/tmp/usage.html
        grep -qi "usage" /tmp/usage.html
        curl --fail --silent --show-error "${annex_url}api/usage?window=7d" >/tmp/usage.json
        test -s /tmp/usage.json

        echo "== leftover public selectors in this tree =="
        leftover=$(grep -RIn --include="*.ts" --include="*.py" \
            -e "VERA_PROFILE" -e "VERA_RUNTIME_DIR" -e "--profile" \
            src clients python/vera 2>/dev/null \
            | grep -v scripts/dev-tui.ts || true)
        leftover_count=$(printf "%s" "$leftover" | grep -c . || true)
        test "$leftover_count" = "0"

        kill "$annex_pid" 2>/dev/null || true
        kill "$host_wrapper_pid" 2>/dev/null || true
        kill "$faux_pid" 2>/dev/null || true
        vera host stop --yes --force >/dev/null 2>&1 || true

        printf "version=%s\n" "$(vera --version)"
        printf "response=%s\n" "$response"
        printf "host_pid=%s\n" "$host_pid"
        printf "home_a=%s\n" "$home_a"
        printf "home_b=%s\n" "$home_b"
        printf "annex=%s\n" "$annex_url"
        printf "leftover_product=%s\n" "$leftover_count"
        echo "one-home container uat passed"
    '
