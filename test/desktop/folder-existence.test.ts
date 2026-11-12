import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { existingFolders, folderListArgument } from "../../clients/desktop/src/folder-existence.ts";
import { MAX_FOLDER_CHECKS } from "../../clients/ui/src/protocol/bridge.ts";

const roots: string[] = [];

function scratch(): string {
    const root = mkdtempSync(join(tmpdir(), "vera-folders-"));
    roots.push(root);
    return root;
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("@core only paths that are directories are reported, in the order given", async () => {
    const root = scratch();
    const kept = join(root, "kept");
    const other = join(root, "other");
    mkdirSync(kept);
    mkdirSync(other);
    writeFileSync(join(root, "file.txt"), "x");
    const asked = [other, join(root, "gone"), join(root, "file.txt"), kept];
    expect(await existingFolders(asked)).toEqual([other, kept]);
});

test("a list that is not an array or is over the cap is refused, and bad entries are dropped", () => {
    expect(folderListArgument("/a")).toEqual([]);
    expect(folderListArgument(undefined)).toEqual([]);
    expect(folderListArgument(Array.from({ length: MAX_FOLDER_CHECKS + 1 }, (_, index) => `/w/${index}`))).toEqual([]);
    expect(folderListArgument(Array.from({ length: MAX_FOLDER_CHECKS }, (_, index) => `/w/${index}`))).toHaveLength(MAX_FOLDER_CHECKS);
    expect(folderListArgument(["/ok", "relative/path", 3, null, "/x".repeat(3000)])).toEqual(["/ok"]);
});
