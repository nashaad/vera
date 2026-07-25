import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    addPermissionPreference,
    listPermissionPreferences,
    loadPermissionPreferences,
    removePermissionPreference,
} from "../../src/engine/permission-preferences.ts";
import { decideToolPermission } from "../../src/engine/permissions.ts";
import type { HookToolCall } from "../../src/sdk/hooks.ts";

const workspace = "/Users/nash/Projects/vera";
const homeDirectory = "/Users/nash";

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
