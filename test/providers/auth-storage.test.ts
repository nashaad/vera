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

import {
    apiKey,
    createAuthStorage,
    oauthToken,
} from "../../src/providers/auth-storage.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("auth storage atomically persists and reloads a provider credential", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-auth-"));
    temporaryDirectories.push(root);
    const path = join(root, ".vera", "auth.json");

    createAuthStorage({ path }).setCredential("openrouter", {
        type: "api_key",
        key: "test-key",
    });

    expect(readdirSync(join(root, ".vera"))).toEqual(["auth.json"]);
    const reloaded = createAuthStorage({ path });
    expect(reloaded.getCredential("openrouter")).toEqual({
        type: "api_key",
        key: "test-key",
    });
    expect(reloaded.getCredential("constructor")).toBeUndefined();
});

test("how a provider is connected survives the round trip", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-auth-kinds-"));
    temporaryDirectories.push(root);
    const path = join(root, "auth.json");
    const storage = createAuthStorage({ path });

    storage.setCredential("openai-codex", { type: "oauth", token: "{}" });
    storage.setCredential("openrouter", { type: "api_key", key: "sk-1" });

    // The same provider can often be reached by a subscription or by a key
    // billed per token, and the two cost differently. A store that only knew
    // "connected" could not tell the user which one is about to be spent.
    const reloaded = createAuthStorage({ path });
    expect(apiKey(reloaded, "openai-codex")).toBeUndefined();
    expect(oauthToken(reloaded, "openai-codex")).toBe("{}");
    expect(oauthToken(reloaded, "openrouter")).toBeUndefined();
    expect(apiKey(reloaded, "openrouter")).toBe("sk-1");
});

test("the untagged Vera 1 map recovers the kind it threw away", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-auth-untagged-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "auth.json");
    // Version 1 stored every credential as an opaque string. Only OAuth records
    // were ever written through it, and they are the ones that parse as JSON,
    // so the kind is recoverable rather than lost.
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        tokens: {
            "openai-codex": JSON.stringify({ access_token: "a" }),
            openrouter: "sk-opaque",
        },
    }));

    const storage = createAuthStorage({ path });
    expect(storage.getCredential("openai-codex")?.type).toBe("oauth");
    expect(apiKey(storage, "openrouter")).toBe("sk-opaque");
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

    // The oldest shape was already tagged, so the upgrade keeps the tag rather
    // than flattening it the way version 1 did.
    expect(apiKey(storage, "openai")).toBe("legacy-key");
    expect(JSON.parse(oauthToken(storage, "openai-codex") ?? "null"))
        .toMatchObject({ type: "oauth", access: "legacy-access" });

    storage.setCredential("next", { type: "api_key", key: "next-key" });

    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written).toEqual({
        schema_version: 2,
        credentials: {
            openai: { type: "api_key", key: "legacy-key" },
            "openai-codex": {
                type: "oauth",
                token: JSON.stringify({
                    type: "oauth",
                    access: "legacy-access",
                    refresh: "legacy-refresh",
                    expires: 123,
                }),
            },
            next: { type: "api_key", key: "next-key" },
        },
    });
});
