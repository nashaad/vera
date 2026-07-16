import { afterEach, expect, test } from "bun:test";
import {
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
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

test("auth storage upgrades the Vera 1 credential map on its next write", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-auth-legacy-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "auth.json");
    writeFileSync(path, JSON.stringify({
        openai: { type: "api_key", key: "legacy-key" },
        "openai-codex": {
            type: "oauth",
            access: "legacy-access",
            refresh: "legacy-refresh",
            expires: 123,
        },
    }));
    const storage = createAuthStorage({ path });

    expect(JSON.parse(storage.getToken("openai-codex") ?? "null")).toMatchObject({
        type: "oauth",
        access: "legacy-access",
    });
    storage.setToken("next", "next-token");

    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written).toEqual({
        schema_version: 1,
        tokens: {
            openai: JSON.stringify({ type: "api_key", key: "legacy-key" }),
            "openai-codex": JSON.stringify({
                type: "oauth",
                access: "legacy-access",
                refresh: "legacy-refresh",
                expires: 123,
            }),
            next: "next-token",
        },
    });
});
