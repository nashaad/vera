#!/bin/sh

set -eu

if [ "$#" -ne 2 ]; then
    printf 'usage: %s <base> <head>\n' "$0" >&2
    exit 2
fi

base=$1
head=$2
refused=0

if ! engine_paths=$(git diff --name-only --no-renames "$base...$head" -- \
    'src/engine/**' 'test/engine/**'); then
    printf 'protected-paths: could not inspect engine changes; refusing pull request\n' >&2
    exit 1
fi

if ! locked_paths=$(git diff --name-only --no-renames --diff-filter=MDT "$base...$head" -- \
    'test/locked/**'); then
    printf 'protected-paths: could not inspect locked journey changes; refusing pull request\n' >&2
    exit 1
fi

if [ -n "$engine_paths" ]; then
    printf 'protected-paths: engine changes require maintainer approval of the exact diff\n\n' >&2
    printf '%s\n' "$engine_paths" | sed 's/^/  /' >&2
    refused=1
fi

if [ -n "$locked_paths" ]; then
    printf 'protected-paths: locked journey changes require maintainer approval of the exact diff\n\n' >&2
    printf '%s\n' "$locked_paths" | sed 's/^/  /' >&2
    refused=1
fi

exit "$refused"
