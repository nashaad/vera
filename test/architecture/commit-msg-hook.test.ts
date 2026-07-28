import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(process.cwd(), "dev/hooks/commit-msg");

/** Whether the hook would let this message through, and what it said if not. */
function check(message: string): { readonly accepted: boolean; readonly said: string } {
    const directory = mkdtempSync(join(tmpdir(), "vera-commit-msg-"));
    const file = join(directory, "COMMIT_EDITMSG");
    try {
        writeFileSync(file, message);
        const result = Bun.spawnSync(["sh", HOOK, file]);
        return {
            accepted: result.exitCode === 0,
            said: new TextDecoder().decode(result.stderr),
        };
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

test("a single-line Conventional Commit is what the hook is for", () => {
    expect(check("fix: keep the picker on screen").accepted).toBe(true);
    expect(check("fix(tui): keep the picker on screen").accepted).toBe(true);
    expect(check("feat(host)!: change the attach handshake").accepted).toBe(true);
    // --cleanup=verbatim leaves comment lines in the file.
    expect(check("fix: keep the picker on screen\n# not a body").accepted)
        .toBe(true);
});

test("a body is refused, however well written", () => {
    const result = check(
        "fix: keep the picker on screen\n\nThe picker was rebuilt on every "
            + "keystroke, so the selection moved under the cursor.",
    );
    expect(result.accepted).toBe(false);
    expect(result.said).toContain("more than one line");
});

test("a tracker reference belongs in the tracker", () => {
    expect(check("fix: refs nash-73 keep the picker on screen").accepted)
        .toBe(false);
    expect(check("fix: closes nash-73").accepted).toBe(false);
    expect(check("fix: keep utf-8 titles readable").accepted).toBe(true);
});

test("a subject that is not a Conventional Commit is refused", () => {
    expect(check("keep the picker on screen").accepted).toBe(false);
    expect(check("Fix: keep the picker on screen").accepted).toBe(false);
    expect(check("").accepted).toBe(false);
    expect(check(`fix: ${"x".repeat(80)}`).accepted).toBe(false);
});

test("git's own generated subjects are left alone", () => {
    expect(check("Merge branch 'main' into feature").accepted).toBe(true);
    expect(check("Revert \"fix: keep the picker on screen\"").accepted).toBe(true);
    expect(check("fixup! fix: keep the picker on screen").accepted).toBe(true);
});
