import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pathArgument, listFolder } from "../../clients/desktop/src/folder-listing.ts";
import { MAX_FOLDER_ENTRIES } from "../../clients/ui/src/protocol/bridge.ts";

const roots: string[] = [];

function scratch(): string {
    const root = mkdtempSync(join(tmpdir(), "vera-listing-"));
    roots.push(root);
    return root;
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("@core lists one level, folders first, by name with numbers in order", async () => {
    const root = scratch();
    mkdirSync(join(root, "plunder"));
    mkdirSync(join(root, "plunder", "deep"));
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "map10.txt"), "");
    writeFileSync(join(root, "map2.txt"), "");
    writeFileSync(join(root, "Crow.md"), "");
    writeFileSync(join(root, ".DS_Store"), "");
    symlinkSync(join(root, "plunder"), join(root, "hold"));

    const listing = await listFolder(root);
    expect(listing).toEqual({
        ok: true,
        cut: false,
        entries: [
            { name: "hold", folder: true },
            { name: "plunder", folder: true },
            { name: "Crow.md", folder: false },
            { name: "map2.txt", folder: false },
            { name: "map10.txt", folder: false },
        ],
    });
});

test("@core stops at the cap and says the list was cut", async () => {
    const root = scratch();
    for (let i = 0; i <= MAX_FOLDER_ENTRIES; i++) writeFileSync(join(root, `coin-${i}`), "");
    const listing = await listFolder(root);
    expect(listing.ok && listing.entries.length).toBe(MAX_FOLDER_ENTRIES);
    expect(listing.ok && listing.cut).toBe(true);
});

test("a missing folder or a relative path is refused", async () => {
    const root = scratch();
    expect((await listFolder(join(root, "gone"))).ok).toBe(false);
    expect(pathArgument("relative/path")).toBeUndefined();
    expect(pathArgument(42)).toBeUndefined();
    expect(pathArgument(`${root}/a/../b`)).toBe(join(root, "b"));
});
