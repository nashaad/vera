import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    PreimageStash,
    sessionChangedFiles,
} from "../../src/store/preimage-stash.ts";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

function root(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-changed-"));
    roots.push(directory);
    return directory;
}

test("the files a session changed come back in the order it touched them", async () => {
    const stash = root();
    const session = new PreimageStash("agent-1", stash);
    await stash1(session, "src/one.ts");
    await stash1(session, "src/two.ts");
    await stash1(session, "src/three.ts");

    expect(sessionChangedFiles("agent-1", stash))
        .toEqual(["src/one.ts", "src/two.ts", "src/three.ts"]);
});

test("a file changed twice is counted once", async () => {
    const stash = root();
    const session = new PreimageStash("agent-1", stash);
    await stash1(session, "src/one.ts");
    await stash1(session, "src/one.ts");

    // The stash keeps the first capture per path, which is what makes this a
    // count of files rather than a count of edits.
    expect(sessionChangedFiles("agent-1", stash)).toEqual(["src/one.ts"]);
});

test("one session's changes are not another's", async () => {
    const stash = root();
    await stash1(new PreimageStash("agent-1", stash), "src/one.ts");
    await stash1(new PreimageStash("agent-2", stash), "src/two.ts");

    expect(sessionChangedFiles("agent-1", stash)).toEqual(["src/one.ts"]);
    expect(sessionChangedFiles("agent-2", stash)).toEqual(["src/two.ts"]);
});

test("a session that changed nothing reads as nothing, not as an error", () => {
    expect(sessionChangedFiles("never-ran", root())).toEqual([]);
    expect(sessionChangedFiles("agent-1", join(root(), "absent"))).toEqual([]);
});

test("a corrupt sidecar is skipped without losing the rest", async () => {
    const stash = root();
    const session = new PreimageStash("agent-1", stash);
    await stash1(session, "src/one.ts");
    writeFileSync(join(stash, "agent-1", "broken.json"), "{ not json", "utf8");

    expect(sessionChangedFiles("agent-1", stash)).toEqual(["src/one.ts"]);
});

async function stash1(stash: PreimageStash, path: string): Promise<void> {
    await stash.capture(path, `contents of ${path}`);
    // The stash stamps captures from the wall clock, and the order this
    // asserts is the order they were taken.
    await Bun.sleep(2);
}
