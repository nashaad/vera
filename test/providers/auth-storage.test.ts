import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAuthStorage } from "../../src/providers/auth-storage.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("auth storage atomically persists and reloads a provider token", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-auth-"));
    temporaryDirectories.push(root);
    const path = join(root, ".vera", "auth.json");

    createAuthStorage({ path }).setToken("openai-codex", "test-token");

    expect(readdirSync(join(root, ".vera"))).toEqual(["auth.json"]);
    const reloaded = createAuthStorage({ path });
    expect(reloaded.getToken("openai-codex")).toBe("test-token");
    expect(reloaded.getToken("constructor")).toBeUndefined();
});
