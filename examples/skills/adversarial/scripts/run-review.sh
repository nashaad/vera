#!/bin/sh
set -eu

usage() {
    printf '%s\n' "usage: run-review.sh --runner vera [--model <provider/model>] --uncommitted | --commit <sha> | --base <ref>" >&2
    exit 2
}

fail() {
    printf 'adversarial review failed: %s\n' "$1" >&2
    exit 2
}

if [ "${VERA_ADVERSARIAL_REVIEW_CHILD:-}" = "1" ]; then
    fail "child reviewers cannot recurse"
fi

[ "$#" -ge 2 ] || usage
[ "$1" = "--runner" ] || usage
runner=$2
shift 2

case "$runner" in
    vera|codex)
        ;;
    *)
        fail "runner must be vera or codex"
        ;;
esac

vera_model="openrouter/openai/gpt-5.6-luna"
if [ "$runner" = "vera" ] && [ "${1:-}" = "--model" ]; then
    [ "$#" -ge 2 ] || usage
    vera_model=$2
    shift 2
fi

[ "$#" -ge 1 ] || usage
target=$1
case "$target" in
    --uncommitted)
        [ "$#" -eq 1 ] || usage
        ;;
    --commit|--base)
        [ "$#" -eq 2 ] || usage
        target_value=$2
        [ -n "$target_value" ] || usage
        ;;
    *)
        fail "unknown review target: $target"
        ;;
esac

review_prompt='You are the leaf adversarial reviewer. Review only the selected git target. Do not edit files, run tests or builds, commit, push, merge, reset, stash, invoke codex exec, invoke any other agent, or request another review. Return actionable findings first, ordered P0 through P3, with precise file/line or commit references, concrete failure mechanisms, and smallest useful corrections. Separate confirmed defects from questions and suggestions. End with coverage and unverified areas.'

if [ "$runner" = "codex" ]; then
    case "$target" in
        --uncommitted)
            exec env VERA_ADVERSARIAL_REVIEW_CHILD=1 codex exec -s read-only review --ephemeral --uncommitted "$review_prompt"
            ;;
        --commit)
            exec env VERA_ADVERSARIAL_REVIEW_CHILD=1 codex exec -s read-only review --ephemeral --commit "$target_value" "$review_prompt"
            ;;
        --base)
            exec env VERA_ADVERSARIAL_REVIEW_CHILD=1 codex exec -s read-only review --ephemeral --base "$target_value" "$review_prompt"
            ;;
    esac
fi

temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/adversarial-review.XXXXXX")
trap 'rm -rf "$temp_dir"' EXIT HUP INT TERM
patch_file="$temp_dir/change.patch"
prompt_file="$temp_dir/prompt.md"

case "$target" in
    --uncommitted)
        git diff --no-ext-diff --binary HEAD > "$patch_file"
        untracked=$(git ls-files --others --exclude-standard)
        if [ -n "$untracked" ]; then
            while IFS= read -r path; do
                [ -n "$path" ] || continue
                if git diff --no-index --binary -- /dev/null "$path" >> "$patch_file"; then
                    :
                else
                    status=$?
                    [ "$status" -eq 1 ] || fail "could not read untracked file: $path"
                fi
            done <<EOF
$untracked
EOF
        fi
        ;;
    --commit)
        git show --format=fuller --binary "$target_value" > "$patch_file"
        ;;
    --base)
        git diff --no-ext-diff --binary "$target_value...HEAD" > "$patch_file"
        ;;
esac

[ -s "$patch_file" ] || fail "selected target has no diff"
patch_bytes=$(wc -c < "$patch_file" | tr -d '[:space:]')
[ "$patch_bytes" -le 1000000 ] || fail "selected diff is larger than 1,000,000 bytes"

{
    printf '%s\n\nSelected target: %s\n\nPatch:\n' "$review_prompt" "$target"
    cat "$patch_file"
} > "$prompt_file"

prompt=$(cat "$prompt_file")
exec env VERA_ADVERSARIAL_REVIEW_CHILD=1 vera -p "$prompt" --prompt-only --model "$vera_model" --effort xhigh

