import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthStorage } from "../../src/providers/auth-storage.ts";
import { createProviderSignInService } from "../../src/providers/provider-sign-in.ts";
import { connectHost } from "../../src/host/connection.ts";
import { parseHostRequest } from "../../src/host/protocol.ts";
import { startHostServer } from "../../src/host/server.ts";

test("provider requests validate their wire shape", () => {
    expect(parseHostRequest(JSON.stringify({ type: "provider_save", request_id: "1", provider: "../bad", key: "fake", credential: "api_key", endpoint: "https://example.invalid", protocol: "openai-chat", custom: true }))).toBeUndefined();
    expect(parseHostRequest(JSON.stringify({ type: "provider_list", request_id: "1" }))).toEqual({ type: "provider_list", request_id: "1" });
});

test("host lists provider status and refuses invalid saves without echoing secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-provider-rpc-"));
    const socketPath = join(root, "host.sock");
    const service = createProviderSignInService({ env: {}, configPath: join(root, "config.json"), cacheDir: join(root, "cache"), authStorage: createAuthStorage({ path: join(root, "auth.json") }) });
    const server = await startHostServer({ socketPath, lockPath: join(root, "host.json"), providerSignIn: service });
    async function request(value: object): Promise<Record<string, unknown>> {
        const connection = await connectHost({ socketPath });
        try { await connection.send(value); return await connection.receive() as Record<string, unknown>; }
        finally { connection.close(); }
    }
    try {
        const listed = await request({ type: "provider_list", request_id: "1" });
        expect(listed.type).toBe("provider_list_result");
        expect(listed.needs_setup).toBe(true);
        for (const [provider, key, endpoint, custom] of [
            ["unknown", "fake-secret", "https://example.invalid", false],
            ["gateway", "", "https://example.invalid", true],
            ["gateway", "fake-secret", "file:///tmp", true],
        ] as const) {
            const response = await request({ type: "provider_save", request_id: "2", provider, key, credential: "api_key", endpoint, protocol: "openai-chat", custom });
            expect(response.type).toBe("provider_request_failed");
            expect(JSON.stringify(response)).not.toContain("fake-secret");
        }
    } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("disconnect and a newer sign-in cancel the previous attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-provider-login-"));
    const socketPath = join(root, "host.sock");
    let stopped = 0;
    let stoppedThird!: () => void;
    const thirdStopped = new Promise<void>((resolve) => { stoppedThird = resolve; });
    const service = createProviderSignInService({ env: {}, configPath: join(root, "config.json"), authStorage: createAuthStorage({ path: join(root, "auth.json") }),
        login: async ({ signal, onAuthorizationUrl } = {}) => {
            onAuthorizationUrl?.("https://example.invalid/authorize");
            await new Promise<void>((resolve) => {
                if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true });
            });
            stopped += 1;
            if (stopped === 3) stoppedThird();
            throw new Error("Canceled");
        } });
    const server = await startHostServer({ socketPath, lockPath: join(root, "host.json"), providerSignIn: service });
    let first: Awaited<ReturnType<typeof connectHost>> | undefined;
    let second: Awaited<ReturnType<typeof connectHost>> | undefined;
    try {
        first = await connectHost({ socketPath });
        await first.send({ type: "provider_sign_in", request_id: "first", provider: "openai-codex" });
        expect((await first.receive() as { type: string }).type).toBe("provider_sign_in_url");
        second = await connectHost({ socketPath });
        await second.send({ type: "provider_sign_in", request_id: "second", provider: "openai-codex" });
        expect((await first.receive() as { type: string }).type).toBe("provider_request_failed");
        expect((await second.receive() as { type: string }).type).toBe("provider_sign_in_url");
        const cancel = await connectHost({ socketPath });
        try {
            await cancel.send({ type: "provider_sign_in_cancel", request_id: "second", provider: "openai-codex" });
            expect((await cancel.receive() as { type: string }).type).toBe("provider_sign_in_cancelled");
            expect((await second.receive() as { type: string }).type).toBe("provider_request_failed");
        } finally { cancel.close(); }
        expect(stopped).toBe(2);
        const third = await connectHost({ socketPath });
        await third.send({ type: "provider_sign_in", request_id: "third", provider: "openai-codex" });
        expect((await third.receive() as { type: string }).type).toBe("provider_sign_in_url");
        third.close();
        await thirdStopped;
        expect(stopped).toBe(3);
    } finally { first?.close(); second?.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("browser sign-in exchanges a code through a local fake authorization service", async () => {
    const { loginOpenAICodex } = await import("../../src/providers/openai-codex-oauth.ts");
    const root = await mkdtemp(join(tmpdir(), "vera-provider-oauth-"));
    const socketPath = join(root, "host.sock");
    let callbackClosed = false;
    const issuer = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/authorize") {
            const callback = new URL(url.searchParams.get("redirect_uri")!);
            callback.searchParams.set("state", url.searchParams.get("state")!);
            callback.searchParams.set("code", "fake-code");
            return fetch(callback);
        }
        return Response.json({ access_token: "fake-access", refresh_token: "fake-refresh", expires_in: 3600 });
    } });
    const auth = createAuthStorage({ path: join(root, "auth.json") });
    const service = createProviderSignInService({ env: {}, configPath: join(root, "config.json"), authStorage: auth,
        login: (options = {}) => loginOpenAICodex({ ...options,
            fetch: (async () => fetch(`http://127.0.0.1:${issuer.port}/token`, { method: "POST" })) as unknown as typeof fetch,
            startCallback: (state, signal) => {
                let resolve!: (code: string) => void;
                let reject!: (error: Error) => void;
                const code = new Promise<string>((accept, fail) => { resolve = accept; reject = fail; });
                const callback = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
                    const url = new URL(request.url);
                    if (url.searchParams.get("state") === state) resolve(url.searchParams.get("code") ?? "");
                    return new Response("ok");
                } });
                const abort = () => reject(new Error("Canceled"));
                signal?.addEventListener("abort", abort, { once: true });
                return { redirectUri: `http://127.0.0.1:${callback.port}/callback`, code,
                    close: () => { signal?.removeEventListener("abort", abort); callback.stop(true); callbackClosed = true; } };
            },
        }) });
    const host = await startHostServer({ socketPath, lockPath: join(root, "host.json"), providerSignIn: service });
    const connection = await connectHost({ socketPath });
    try {
        await connection.send({ type: "provider_sign_in", request_id: "oauth", provider: "openai-codex" });
        const frame = await connection.receive() as { type: string; url: string };
        expect(frame.type).toBe("provider_sign_in_url");
        const original = new URL(frame.url);
        const local = new URL(`http://127.0.0.1:${issuer.port}/authorize`);
        local.searchParams.set("state", original.searchParams.get("state")!);
        local.searchParams.set("redirect_uri", original.searchParams.get("redirect_uri")!);
        await fetch(local);
        const result = await connection.receive() as { type: string; provider: { connected: boolean } };
        expect(result.type).toBe("provider_sign_in_result");
        expect(result.provider.connected).toBe(true);
        expect(auth.getCredential("openai-codex")?.type).toBe("oauth");
        expect(callbackClosed).toBe(true);
        expect(JSON.stringify(result)).not.toContain("fake-access");
    } finally { connection.close(); await host.close(); issuer.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("model selection reports verification failure and accepts a verified choice", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-provider-model-"));
    const socketPath = join(root, "host.sock");
    const selected: string[] = [];
    const server = await startHostServer({ socketPath, lockPath: join(root, "host.json"),
        selectProviderModel: async (provider, model) => {
            if (model === "bad") throw new Error("The model did not answer");
            selected.push(`${provider}/${model}`);
        } });
    async function select(model: string): Promise<Record<string, unknown>> {
        const connection = await connectHost({ socketPath });
        try {
            await connection.send({ type: "provider_select_model", request_id: "model", provider: "faux-0", model });
            return await connection.receive() as Record<string, unknown>;
        } finally { connection.close(); }
    }
    try {
        expect((await select("bad")).type).toBe("provider_request_failed");
        expect((await select("crow-0")).type).toBe("provider_select_model_result");
        expect(selected).toEqual(["faux-0/crow-0"]);
    } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("host saves a custom provider into the real stores without returning its key", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-provider-save-rpc-"));
    const socketPath = join(root, "host.sock");
    const authPath = join(root, "auth.json");
    const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
        return request.headers.get("authorization") === "Bearer fake-key" ? Response.json({ data: [{ id: "crow-0" }] }) : new Response(null, { status: 401 });
    } });
    const service = createProviderSignInService({ env: {}, configPath: join(root, "config.json"), cacheDir: join(root, "cache"), authStorage: createAuthStorage({ path: authPath }) });
    const host = await startHostServer({ socketPath, lockPath: join(root, "host.json"), providerSignIn: service });
    const connection = await connectHost({ socketPath });
    try {
        await connection.send({ type: "provider_save", request_id: "save", provider: "faux-0", key: "fake-key", credential: "api_key",
            endpoint: `http://127.0.0.1:${provider.port}/v1`, protocol: "openai-chat", custom: true });
        const result = await connection.receive() as { type: string; provider: { id: string; connected: boolean } };
        expect(result.type).toBe("provider_save_result");
        expect(result.provider).toMatchObject({ id: "faux-0", connected: true });
        expect(JSON.stringify(result)).not.toContain("fake-key");
        expect(createAuthStorage({ path: authPath }).getCredential("faux-0")).toEqual({ type: "api_key", key: "fake-key" });
        const edit = await connectHost({ socketPath });
        try {
            await edit.send({ type: "provider_save", request_id: "edit", provider: "faux-0", key: "", credential: "api_key",
                reuse_existing: true, editing: "faux-0", endpoint: `http://127.0.0.1:${provider.port}/v1`, protocol: "openai-chat", custom: true });
            const edited = await edit.receive() as { type: string };
            expect(edited.type).toBe("provider_save_result");
            expect(JSON.stringify(edited)).not.toContain("fake-key");
        } finally { edit.close(); }
    } finally { connection.close(); await host.close(); provider.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("provider status decoder refuses malformed rows and drops extra fields", async () => {
    const { parseProviderSignInStatus } = await import("../../src/host/provider-sign-in-client.ts");
    const status = { id: "faux-0", name: "Faux", methods: ["key"] as const, connected: true, catalog_connected: true, enabled: true, custom: true };
    expect(parseProviderSignInStatus({ ...status, token: "fake-token" })).toEqual(status);
    expect(parseProviderSignInStatus({ ...status, methods: ["other"] })).toBeUndefined();
    expect(parseProviderSignInStatus({ ...status, connected: "yes" })).toBeUndefined();
});

test("canceling during token exchange closes the callback and never stores credentials", async () => {
    const { loginOpenAICodex } = await import("../../src/providers/openai-codex-oauth.ts");
    const root = await mkdtemp(join(tmpdir(), "vera-oauth-cancel-"));
    const auth = createAuthStorage({ path: join(root, "auth.json") });
    const controller = new AbortController();
    let callbackClosed = false;
    let exchangeStarted!: () => void;
    const started = new Promise<void>((resolve) => { exchangeStarted = resolve; });
    try {
        const login = loginOpenAICodex({ authStorage: auth, signal: controller.signal,
            startCallback: () => ({ redirectUri: "http://127.0.0.1/callback", code: Promise.resolve("fake-code"), close: () => { callbackClosed = true; } }),
            openAuthorizationUrl: async () => true,
            fetch: ((_: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
                exchangeStarted();
                init?.signal?.addEventListener("abort", () => reject(new Error("Canceled")), { once: true });
            })) as unknown as typeof fetch });
        await started;
        controller.abort();
        expect(callbackClosed).toBe(true);
        await expect(login).rejects.toThrow();
        expect(auth.getCredential("openai-codex")).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
});
