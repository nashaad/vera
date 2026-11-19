import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthStorage } from "../../src/providers/auth-storage.ts";
import { createProviderSignInService } from "../../src/providers/provider-sign-in.ts";

const declaration = { protocol: "openai-chat" as const, credential: "api_key" as const, base_url: "https://example.invalid/v1" };

test("sign-in refuses empty keys, bad endpoints and unknown providers", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-provider-service-"));
    const service = createProviderSignInService({ env: {}, configPath: join(root, "config.json"), cacheDir: join(root, "cache"), authStorage: createAuthStorage({ path: join(root, "auth.json") }) });
    try {
        expect(service.list().find((provider) => provider.id === "openrouter")).toMatchObject({ protocol: "openai-chat", methods: ["key"] });
        await expect(service.save({ id: "unknown", declaration, apiKey: "fake", custom: false })).rejects.toThrow("Unknown provider");
        await expect(service.save({ id: "unknown", declaration, apiKey: " ", custom: true })).rejects.toThrow("Missing API key");
        await expect(service.save({ id: "unknown", declaration: { ...declaration, base_url: "file:///tmp" }, apiKey: "fake", custom: true })).rejects.toThrow("HTTP or HTTPS");
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("provider refusal never returns the submitted key", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-provider-secret-"));
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ message: "rejected fake-secret-value" }, { status: 401 }) });
    const service = createProviderSignInService({ env: {}, configPath: join(root, "config.json"), cacheDir: join(root, "cache"), authStorage: createAuthStorage({ path: join(root, "auth.json") }) });
    try {
        const reason = await service.save({ id: "gateway", custom: true, apiKey: "fake-secret-value", declaration: { ...declaration, base_url: `http://127.0.0.1:${server.port}/v1` } }).then(() => "", (error: Error) => error.message);
        expect(reason).toContain("[redacted]");
        expect(reason).not.toContain("fake-secret-value");
        expect(JSON.stringify(service.list())).not.toContain("fake-secret-value");
    } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
});
