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
    unreadableAuthStoragePath,
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

test("forgetting a provider removes only that credential", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-auth-forget-"));
    temporaryDirectories.push(root);
    const path = join(root, "auth.json");
    const storage = createAuthStorage({ path });
    storage.setCredential("openrouter", { type: "api_key", key: "wrong-key" });
    storage.setCredential("cerebras", { type: "api_key", key: "kept-key" });

    storage.deleteCredential("openrouter");

    const reloaded = createAuthStorage({ path });
    expect(reloaded.getCredential("openrouter")).toBeUndefined();
    expect(reloaded.getCredential("cerebras")).toEqual({
        type: "api_key",
        key: "kept-key",
    });
    // Omitted rather than written as null or undefined: the read side asks
    // `Object.hasOwn`, which a present key answers yes to whatever its value.
    const written: unknown = JSON.parse(readFileSync(path, "utf8"));
    expect(
        Object.hasOwn(
            (written as { credentials: Record<string, unknown> }).credentials,
            "openrouter",
        ),
    ).toBe(false);
});

test("forgetting a provider that was never stored is a no-op", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-auth-forget-missing-"));
    temporaryDirectories.push(root);
    const path = join(root, "auth.json");
    const storage = createAuthStorage({ path });
    storage.setCredential("openrouter", { type: "api_key", key: "kept-key" });

    expect(() => storage.deleteCredential("cerebras")).not.toThrow();
    expect(createAuthStorage({ path }).getCredential("openrouter")).toEqual({
        type: "api_key",
        key: "kept-key",
    });
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

test.each([
    ["malformed JSON", "{ not json"],
    ["a shape nothing here writes", '{"schema_version":99,"credentials":[]}'],
])("a store holding %s is moved aside so a provider can be connected", (
    _name,
    contents,
) => {
    const root = mkdtempSync(join(tmpdir(), "vera-auth-"));
    temporaryDirectories.push(root);
    const path = join(root, "auth.json");
    writeFileSync(path, contents);
    const quarantined: string[] = [];

    createAuthStorage({
        path,
        onQuarantine: (quarantinePath) => quarantined.push(quarantinePath),
    }).setCredential("openrouter", { type: "api_key", key: "fresh" });

    expect(createAuthStorage({ path }).getCredential("openrouter")).toEqual({
        type: "api_key",
        key: "fresh",
    });
    // Renamed, never deleted: the old file may hold a credential the user can
    // still recover by hand.
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(quarantined[0]!, "utf8")).toBe(contents);
    expect(quarantined[0]!.startsWith(`${path}.corrupt-`)).toBe(true);
});

test("a store that was never written quarantines nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-auth-"));
    temporaryDirectories.push(root);
    const path = join(root, ".vera", "auth.json");
    const quarantined: string[] = [];

    createAuthStorage({
        path,
        onQuarantine: (quarantinePath) => quarantined.push(quarantinePath),
    }).setCredential("openrouter", { type: "api_key", key: "first" });

    expect(quarantined).toEqual([]);
    expect(readdirSync(join(root, ".vera"))).toEqual(["auth.json"]);
});

test("an unreadable store is reported by path, and a missing one is not", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-auth-"));
    temporaryDirectories.push(root);
    const path = join(root, "auth.json");

    expect(unreadableAuthStoragePath({ path })).toBeUndefined();
    writeFileSync(path, "{ not json");
    expect(unreadableAuthStoragePath({ path })).toBe(path);
});
