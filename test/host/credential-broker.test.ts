import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { createCredentialBroker } from "../../src/host/master/credentials.ts";
import { fetchCodexCatalog } from "../../src/model/codex-catalog.ts";
import type { StoredCredential } from "../../src/providers/auth-storage.ts";

test("forget waits for a pending refresh and later leases see the deletion", async () => {
    let stored: StoredCredential | undefined = { type: "oauth", token: JSON.stringify({
        schema_version: 1, access_token: randomUUID(), refresh_token: randomUUID(), expires_at: 1,
    }) };
    const writes: string[] = [];
    const storage = {
        getCredential: () => stored,
        setCredential(_provider: string, value: StoredCredential) { writes.push("refresh"); stored = value; },
        deleteCredential() { writes.push("forget"); stored = undefined; },
    };
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const localFetch = (async () => {
        started.resolve();
        await release.promise;
        return Response.json({ access_token: randomUUID(), refresh_token: randomUUID(), expires_in: 60 });
    }) as unknown as typeof globalThis.fetch;
    const broker = createCredentialBroker({
        authStorage: storage, fetch: localFetch,
        config: () => ({ schema_version: 1, provider: "openai-codex", model: "fixture", approval_mode: "auto" }),
    });
    try {
        const first = broker.lease("openai-codex");
        await started.promise;
        const forgotten = broker.withProviderMutation("openai-codex", () => storage.deleteCredential());
        const after = broker.lease("openai-codex").then(() => false, () => true);
        expect(writes).toEqual([]);
        release.resolve();
        expect((await first).kind).toBe("oauth");
        await forgotten;
        expect(await after).toBe(true);
        expect(writes).toEqual(["refresh", "forget"]);
        expect(stored).toBeUndefined();
    } finally {
        release.resolve();
    }
});

test("a catalog transport error cannot expose a leased credential", async () => {
    const token = randomUUID();
    const stored: StoredCredential = { type: "oauth", token: JSON.stringify({
        schema_version: 1, access_token: token, refresh_token: randomUUID(), expires_at: Date.now() + 60_000,
    }) };
    const authorization = { accessToken: token };
    try {
        await fetchCodexCatalog({
            authStorage: { getCredential: () => stored, setCredential: () => {}, deleteCredential: () => {} },
            authorization: { resolve: async () => authorization, refreshRejected: async () => authorization },
            fetch: (async () => { throw new Error(`transport rejected ${token}`); }) as unknown as typeof globalThis.fetch,
        });
        throw new Error("Catalog request unexpectedly succeeded");
    } catch (error) {
        expect(error instanceof Error && error.message.includes(token)).toBe(false);
        expect(error instanceof Error && error.message.includes("[redacted]")).toBe(true);
    }
});

test("a rejected token refreshes when an ordinary cached lease is concurrent", async () => {
    const initial = randomUUID();
    const renewed = randomUUID();
    let stored: StoredCredential | undefined = { type: "oauth", token: JSON.stringify({
        schema_version: 1, access_token: initial, refresh_token: randomUUID(), expires_at: Date.now() + 60_000,
    }) };
    const storage = {
        getCredential: () => stored,
        setCredential(_provider: string, value: StoredCredential) { stored = value; },
        deleteCredential() { stored = undefined; },
    };
    let refreshes = 0;
    const localFetch = (async () => {
        refreshes += 1;
        return Response.json({ access_token: renewed, refresh_token: randomUUID(), expires_in: 60 });
    }) as unknown as typeof globalThis.fetch;
    const broker = createCredentialBroker({
        authStorage: storage, fetch: localFetch,
        config: () => ({ schema_version: 1, provider: "openai-codex", model: "fixture", approval_mode: "auto" }),
    });
    const [ordinary, retry] = await Promise.all([
        broker.lease("openai-codex"), broker.lease("openai-codex", initial),
    ]);
    expect(ordinary.kind).toBe("oauth");
    expect(refreshes).toBe(1);
    expect(retry.kind === "oauth" && retry.authorization.accessToken === renewed).toBe(true);
});

test("a rejected token shares an active refresh even when the access value is unchanged", async () => {
    const access = randomUUID();
    let stored: StoredCredential | undefined = { type: "oauth", token: JSON.stringify({
        schema_version: 1, access_token: access, refresh_token: randomUUID(), expires_at: 1,
    }) };
    const storage = {
        getCredential: () => stored,
        setCredential(_provider: string, value: StoredCredential) { stored = value; },
        deleteCredential() { stored = undefined; },
    };
    let refreshes = 0;
    const localFetch = (async () => {
        refreshes += 1;
        return Response.json({ access_token: access, refresh_token: randomUUID(), expires_in: 10 });
    }) as unknown as typeof globalThis.fetch;
    const broker = createCredentialBroker({
        authStorage: storage, fetch: localFetch,
        config: () => ({ schema_version: 1, provider: "openai-codex", model: "fixture", approval_mode: "auto" }),
    });
    const [ordinary, retry] = await Promise.all([
        broker.lease("openai-codex"), broker.lease("openai-codex", access),
    ]);
    expect(ordinary.kind).toBe("oauth");
    expect(retry.kind).toBe("oauth");
    expect(refreshes).toBe(1);
});
