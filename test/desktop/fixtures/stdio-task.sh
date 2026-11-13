#!/bin/sh
# A task in plain POSIX sh. Usage: stdio-task.sh <mode> <record-file>
# Reads the run line, then behaves as <mode>. Records what it saw in <record-file>.
mode=$1
record=$2

IFS= read -r line || exit 1
printf '%s\n' "$line" > "$record"
printf '{"type":"log","level":"info","text":"pid %s"}\n' "$$"

# Blocks until stdin reaches end-of-file, then leaves a marker.
wait_for_eof() {
    while IFS= read -r _; do :; done
    : > "$record.eof"
}

case "$mode" in
answer)
    printf '{"type":"progress","message":"halfway","increment":50}\n'
    printf '{"type":"log","level":"warn","text":"careful"}\n'
    printf '{"type":"result","reply":{"pong":1}}\n'
    printf '{"type":"log","level":"info","text":"after the result"}\n'
    wait_for_eof
    ;;
answer-ignoring-term)
    trap '' TERM
    printf '{"type":"result","reply":{"pong":1}}\n'
    wait_for_eof
    ;;
silent)
    trap '' TERM
    wait_for_eof
    ;;
stubborn)
    trap '' TERM
    while :; do :; done
    ;;
exit)
    exit 3
    ;;
garbage)
    printf 'this is not json\n'
    wait_for_eof
    ;;
oversized)
    printf '{"type":"log","level":"info","text":"'
    head -c 1100000 /dev/zero | tr '\0' a
    printf '"}\n'
    wait_for_eof
    ;;
unterminated-flood)
    # Never sends a newline; the desktop must stop reading instead of buffering it.
    while :; do head -c 65536 /dev/zero | tr '\0' a; done
    ;;
stderr)
    printf 'first complaint\r\nsecond complaint\n\n' >&2
    printf 'no newline at the end' >&2
    exit 1
    ;;
stderr-flood)
    # More than a pipe holds; the child blocks unless the desktop drains stderr.
    head -c 4000000 /dev/zero | tr '\0' x >&2
    printf '{"type":"result","reply":{"pong":1}}\n'
    wait_for_eof
    ;;
multibyte)
    printf '{"type":"log","level":"info","text":"h\303\251llo \342\202\254 \360\237\231\202"}\n'
    printf '{"type":"result","reply":{"pong":1}}\n'
    wait_for_eof
    ;;
esac
