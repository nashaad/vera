#!/bin/sh

newline='
'
roots=
prefixes=
for root do
    [ -d "$root" ] || continue
    case $root in
        *"$newline"*) continue ;;
        -*) root=./$root ;;
    esac
    root=$(cd -P "$root" 2>/dev/null && pwd -P) || continue
    case $root in *"$newline"*) continue ;; esac
    case "$newline$roots$newline" in
        *"$newline$root$newline"*) continue ;;
    esac
    roots=${roots:+"$roots$newline"}$root
    found=$(find "$root" -maxdepth 7 \
        \( -type d \( -name .git -o -name node_modules \) -prune \) -o \
        \( -type d -path '*/share/vera/releases' \
            \( -mtime +0 -exec sh -c '
                newline="
"
                for path do
                    case $path in
                        *"$newline"*) continue ;;
                    esac
                    printf "%s\n" "${path%/share/vera/releases}"
                done
            ' sh {} + -o -true \) -prune \) 2>/dev/null)
    [ -n "$found" ] && prefixes=${prefixes:+"$prefixes$newline"}$found
done

[ -n "$prefixes" ] || exit 0
set -f
IFS=$newline
set -- $prefixes
unset IFS
sizes=$(du -sk "$@" 2>/dev/null) || sizes=
{
    printf '%s\n' "$#"
    printf '%s\n' "$@"
    [ -z "$sizes" ] || printf '%s\n' "$sizes"
} | awk '
    function human(kb) {
        if (kb >= 1048576) return sprintf("%.1f GiB", kb / 1048576)
        if (kb >= 1024) return sprintf("%.1f MiB", kb / 1024)
        return sprintf("%d KiB", kb)
    }
    function quote(path,    i, c, result) {
        result = q
        for (i = 1; i <= length(path); i++) {
            c = substr(path, i, 1)
            result = result (c == q ? q "\\" q q : c)
        }
        return result q
    }
    NR == 1 { count = $0 + 0; q = sprintf("%c", 39); next }
    NR <= count + 1 { paths[NR - 1] = $0; next }
    {
        tab = index($0, "\t")
        if (tab && substr($0, 1, tab - 1) ~ /^[0-9]+$/) {
            path = substr($0, tab + 1)
            sizes[path] = substr($0, 1, tab - 1) + 0
        }
    }
    END {
        total = 0
        known = 1
        for (i = 1; i <= count; i++) {
            if (paths[i] in sizes) total += sizes[paths[i]]
            else known = 0
        }
        printf "Stale Vera release installs: %d %s\n", count, (count == 1 ? "install" : "installs")
        printf "  Total: %s\n", (known ? human(total) : "unknown")
        for (i = 1; i <= count && i <= 10; i++) {
            size = (paths[i] in sizes) ? human(sizes[paths[i]]) : "unknown"
            printf "  %s (%s)\n", paths[i], size
        }
        if (count > 10) printf "  and %d more\n", count - 10
        printf "  Remove with: rm -rf"
        for (i = 1; i <= count; i++) printf " %s", quote(paths[i])
        printf "\n"
    }
' >&2
exit 0
