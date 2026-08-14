#!/bin/sh
# Writes one line per interval so the sidecar log shows the process is alive.
# VERA_SOCKET carries the resident host's socket path for real clients.
while true; do
    echo "heartbeat $(date -u +%Y-%m-%dT%H:%M:%SZ) socket=$VERA_SOCKET"
    sleep "${INTERVAL_SECONDS:-60}"
done
