#!/bin/sh
# Served by the stand-in curl. Places an outrider on PATH the way a real installer would, and reports itself on stderr in the same shape the runtime downloads use.
set -e
bin="${OUTRIDER_FAKE_BIN:-${TMPDIR:-/tmp}/vera-dev/outrider-fake/bin}"
mkdir -p "$bin"
total=9400000
step=0
while [ "$step" -lt 4 ]; do
    step=$((step + 1))
    downloaded=$((total * step / 4))
    done_flag=false
    [ "$step" -eq 4 ] && done_flag=true
    printf '{"name":"outrider 0.4.1","downloaded":%s,"total":%s,"bytes_per_second":9400000,"eta_seconds":%s,"done":%s}\n' \
        "$downloaded" "$total" "$((4 - step))" "$done_flag" >&2
    sleep 0.4
done
cat > "$bin/outrider" <<'RUNNER'
#!/bin/sh
exec bun "@REPO@/dev/outrider-cli.ts" "$@"
RUNNER
chmod +x "$bin/outrider"
printf '{"name":"installed to %s","done":true}\n' "$bin/outrider" >&2
echo "outrider 0.4.1 installed to $bin/outrider"
