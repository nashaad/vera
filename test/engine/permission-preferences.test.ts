import { beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    addPermissionPreference,
    listPermissionPreferences,
    loadPermissionPreferences,
    PermissionPreferenceStore,
    removePermissionPreference,
} from "../../src/engine/permission-preferences.ts";
import {
    decideToolPermission,
    isPermissionPredicate,
} from "../../src/engine/permissions.ts";
import type { HookToolCall } from "../../src/sdk/hooks.ts";
import { initBashParser } from "../../src/tools/bash-parser.ts";

const workspace = "/Users/nash/Projects/vera";
const homeDirectory = "/Users/nash";

// `runTurn` awaits this in production. The classifier stays synchronous, so
// without the parser ready every bash command classifies as unknown.
beforeAll(async () => {
    await initBashParser();
});

async function withPreferencesFile(
    run: (path: string) => Promise<void>,
): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "vera-preferences-"));
    const path = join(dir, "preferences.json");
    try {
        await run(path);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

function bash(command: string): HookToolCall {
    return { id: "call_1", name: "bash", input: { command } };
}

test("a missing preferences file reads as no preferences", async () => {
    await withPreferencesFile(async (path) => {
        expect(await loadPermissionPreferences(path)).toEqual([]);
    });
});

test("add/list/remove round-trip through disk", async () => {
    await withPreferencesFile(async (path) => {
        const added = await addPermissionPreference(
            { operation: "git.push" },
            path,
        );
        expect(added.when).toEqual({ operation: "git.push" });

        const listed = await listPermissionPreferences(path);
        expect(listed).toEqual([added]);

        const removed = await removePermissionPreference(added.id, path);
        expect(removed).toBe(true);
        expect(await listPermissionPreferences(path)).toEqual([]);

        expect(await removePermissionPreference(added.id, path)).toBe(false);
    });
});

test("a preference lowers a matching ask to allow across a simulated reload", async () => {
    await withPreferencesFile(async (path) => {
        expect(decideToolPermission(
            "ask",
            bash("git push origin main"),
            workspace,
            [],
            { homeDirectory },
        ).behavior).toBe("ask");

        await addPermissionPreference({ operation: "git.push" }, path);
        // Simulate a process restart: preferences are only ever loaded from
        // disk, never carried over in memory.
        const reloaded = await loadPermissionPreferences(path);

        const decision = decideToolPermission(
            "ask",
            bash("git push origin main"),
            workspace,
            [],
            { homeDirectory, permissionPreferences: reloaded },
        );
        expect(decision).toMatchObject({
            behavior: "allow",
            actions: [{ outcome: "allow", preference: reloaded[0]?.id }],
        });
    });
});

test("a preference cannot override a profile denial", async () => {
    await withPreferencesFile(async (path) => {
        await addPermissionPreference({ verb: "delete" }, path);
        const reloaded = await loadPermissionPreferences(path);
        const permissionModes = {
            locked: {
                name: "locked",
                defaultOutcome: "deny" as const,
                rules: [],
            },
        };
        const decision = decideToolPermission(
            "locked",
            bash("rm -rf dist"),
            workspace,
            [],
            { homeDirectory, permissionModes, permissionPreferences: reloaded },
        );
        expect(decision.behavior).toBe("deny");
    });
});

test("a preference cannot override the accident guard", async () => {
    await withPreferencesFile(async (path) => {
        await addPermissionPreference({ verb: "delete" }, path);
        const reloaded = await loadPermissionPreferences(path);
        const decision = decideToolPermission(
            "full_access",
            bash("rm -rf /Users/nash/Projects/vera"),
            workspace,
            [],
            { homeDirectory, permissionPreferences: reloaded },
        );
        expect(decision).toMatchObject({
            behavior: "deny",
            source: "accident_guard",
        });
    });
});

test("removing a preference restores the original prompt", async () => {
    await withPreferencesFile(async (path) => {
        const added = await addPermissionPreference(
            { operation: "git.push" },
            path,
        );
        const beforeRemoval = await loadPermissionPreferences(path);
        expect(decideToolPermission(
            "ask",
            bash("git push origin main"),
            workspace,
            [],
            { homeDirectory, permissionPreferences: beforeRemoval },
        ).behavior).toBe("allow");

        await removePermissionPreference(added.id, path);
        const afterRemoval = await loadPermissionPreferences(path);
        expect(decideToolPermission(
            "ask",
            bash("git push origin main"),
            workspace,
            [],
            { homeDirectory, permissionPreferences: afterRemoval },
        ).behavior).toBe("ask");
    });
});

test("the store serves the classifier synchronously from its cache", async () => {
    await withPreferencesFile(async (path) => {
        const store = await PermissionPreferenceStore.open(path);
        expect(store.list()).toEqual([]);

        await store.add({ operation: "git.push" });
        // The point of the store: no await between the add and the decision,
        // because `decideToolPermission` cannot await a file read per call.
        expect(decideToolPermission(
            "ask",
            bash("git push origin main"),
            workspace,
            [],
            { homeDirectory, permissionPreferences: store.list() },
        ).behavior).toBe("allow");

        // The cache is not the only copy: a second store over the same file
        // sees the write.
        const reopened = await PermissionPreferenceStore.open(path);
        expect(reopened.list()).toEqual(store.list());
    });
});

test("store removal reports whether anything matched", async () => {
    await withPreferencesFile(async (path) => {
        const store = await PermissionPreferenceStore.open(path);
        const added = await store.add({ operation: "git.push" });

        expect(await store.remove("no-such-id")).toBe(false);
        expect(store.list()).toHaveLength(1);

        expect(await store.remove(added.id)).toBe(true);
        expect(store.list()).toEqual([]);
        expect(await loadPermissionPreferences(path)).toEqual([]);
    });
});

test("concurrent adds all survive instead of clobbering each other", async () => {
    await withPreferencesFile(async (path) => {
        const store = await PermissionPreferenceStore.open(path);
        // Without serialization each add reads the pre-write file and the last
        // write wins, leaving one preference on disk instead of three.
        await Promise.all([
            store.add({ operation: "git.push" }),
            store.add({ operation: "git.commit" }),
            store.add({ executable: "curl" }),
        ]);

        expect(store.list()).toHaveLength(3);
        expect(await loadPermissionPreferences(path)).toHaveLength(3);
    });
});

// Adversarial boundary checks: preferences arrive from a client over RPC, so
// the engine must not trust the predicate it is handed.

test("a match-everything preference cannot enter over the wire", () => {
    // `isPermissionPredicate` requires at least one field, which is what stops
    // `{}` (a predicate matching every action) from decoding. Without this the
    // add RPC would be a one-command route to full_access.
    expect(isPermissionPredicate({})).toBe(false);
});

test("no preference can lower a deny, whatever it matches", async () => {
    await withPreferencesFile(async (path) => {
        const store = await PermissionPreferenceStore.open(path);
        await store.add({ pathGlob: ".env" });
        const decision = decideToolPermission(
            "ask",
            { id: "call_1", name: "read", input: { path: ".env" } },
            workspace,
            [],
            { homeDirectory, permissionPreferences: store.list() },
        );
        expect(decision.behavior).toBe("deny");
        if (decision.behavior === "deny") {
            expect(decision.source).toBe("mode");
        }
    });
});

test("the accident guard runs ahead of preferences", () => {
    // Constructed in-process rather than through the store, because the point
    // is that even a preference the wire would reject cannot reach the guard.
    const decision = decideToolPermission(
        "ask",
        bash("rm -rf ~"),
        workspace,
        [],
        {
            homeDirectory,
            permissionPreferences: [
                { id: "x", when: { executable: "rm" }, createdAt: "now" },
            ],
        },
    );
    expect(decision.behavior).toBe("deny");
    if (decision.behavior === "deny") {
        expect(decision.source).toBe("accident_guard");
    }
});
