import { expect, test } from "bun:test";

import type { AuthStorage, StoredCredential } from "../../src/providers/auth-storage.ts";
import { OPENAI_CODEX_PROVIDER_ID } from "../../src/providers/openai-codex-oauth.ts";
import {
    ellipsizeHealthTail,
    expiredOAuthProvider,
    hasConfiguredProvider,
    healthRungsOf,
    idleProviderHealth,
    renderProviderHealth,
    runProviderHealthCheck,
    summarizeProviderHealth,
} from "../../clients/tui/provider-health.ts";

function memoryAuth(
    credentials: Readonly<Record<string, StoredCredential>> = {},
): AuthStorage {
    const store = { ...credentials };
    return {
        getCredential(provider) {
            return store[provider];
        },
        setCredential(provider, credential) {
            store[provider] = credential;
        },
        deleteCredential(provider) {
            delete store[provider];
        },
    };
}

test("idle health names the key and does not claim a tone", () => {
    const lines = renderProviderHealth(idleProviderHealth());
    expect(lines.join("\n")).toContain("not checked");
    expect(lines.join("\n")).toContain("press");
    expect(lines.join("\n")).not.toContain("green");
    expect(lines.join("\n")).not.toContain("yellow");
    expect(lines.join("\n")).not.toContain("red");
});

test("no provider configured is red and names the providers section", () => {
    const ready = summarizeProviderHealth({
        results: [],
        configured: false,
    });
    expect(ready.tone).toBe("red");
    expect(ready.summary).toBe("no provider configured");
    expect(ready.next).toContain("/models then Providers");
    const text = renderProviderHealth(ready).join("\n");
    expect(text).toContain("red");
    expect(text).toContain("/models then Providers");
});

test("a working ladder is green and names the rung that answered", () => {
    const ready = summarizeProviderHealth({
        results: [
            { rung: { provider: "openrouter", model: "glm-flash" }, answered: true },
            { rung: { provider: "ollama", model: "qwen" }, answered: true },
        ],
        configured: true,
    });
    expect(ready.tone).toBe("green");
    expect(ready.summary).toBe("openrouter/glm-flash answered");
    expect(ready.next).toBeUndefined();
    expect(ready.details).toBeUndefined();
    expect(renderProviderHealth(ready).join("\n")).toContain("green");
});

test("only the last rung answering is yellow and names Verify all", () => {
    const ready = summarizeProviderHealth({
        results: [
            { rung: { provider: "openrouter", model: "glm-flash" }, answered: false },
            { rung: { provider: "ollama", model: "qwen" }, answered: true },
        ],
        configured: true,
    });
    expect(ready.tone).toBe("yellow");
    expect(ready.summary).toContain("only the last favorite answered");
    expect(ready.summary).toContain("ollama/qwen");
    expect(ready.details).toEqual(["openrouter/glm-flash failed"]);
    expect(ready.next).toContain("/model");
    expect(ready.next).toContain("Verify all");
});

test("a failed favorite with an earlier answer stays green", () => {
    const ready = summarizeProviderHealth({
        results: [
            { rung: { provider: "openrouter", model: "glm-flash" }, answered: true },
            { rung: { provider: "ollama", model: "qwen" }, answered: false },
        ],
        configured: true,
    });
    expect(ready.tone).toBe("green");
    expect(ready.summary).toBe("openrouter/glm-flash answered");
    expect(ready.details).toEqual(["ollama/qwen failed"]);
    expect(ready.next).toBeUndefined();
    const text = renderProviderHealth(ready).join("\n");
    expect(text).toContain("green");
    expect(text).toContain("ollama/qwen failed");
});

test("an expired credential does not override remaining depth", () => {
    const ready = summarizeProviderHealth({
        results: [
            { rung: { provider: "openai-codex", model: "gpt-5.4" }, answered: true },
            { rung: { provider: "ollama", model: "qwen" }, answered: true },
        ],
        configured: true,
        expiredCredential: OPENAI_CODEX_PROVIDER_ID,
    });
    expect(ready.tone).toBe("green");
    expect(ready.summary).toBe("openai-codex/gpt-5.4 answered");
    expect(ready.details).toEqual(["openai-codex credential is expired"]);
    expect(ready.next).toBeUndefined();
});

test("nothing answering is red", () => {
    const ready = summarizeProviderHealth({
        results: [
            { rung: { provider: "openrouter", model: "glm-flash" }, answered: false },
        ],
        configured: true,
    });
    expect(ready.tone).toBe("red");
    expect(ready.summary).toBe("nothing answered");
    expect(ready.next).toContain("/models then Providers");
});

test("monochrome health lines keep the tone word", () => {
    for (const tone of ["green", "yellow", "red"] as const) {
        const text = renderProviderHealth({
            kind: "ready",
            tone,
            summary: "example",
            next: "/providers to connect one",
        }).join("\n");
        expect(text).toContain(tone);
        expect(text).toContain("next");
    }
});

test("health rungs follow favorites order and ignore a fake session model", () => {
    expect(healthRungsOf({
        model: "test",
        pooled: [
            {
                provider: "openrouter",
                model: "a",
                label: "a",
                available: true,
                verified: false,
                levels: [],
            },
            {
                provider: "ollama",
                model: "b",
                label: "b",
                available: true,
                verified: true,
                levels: [],
            },
        ],
    }).map((rung) => `${rung.provider}/${rung.model}`)).toEqual([
        "openrouter/a",
        "ollama/b",
    ]);
    expect(healthRungsOf({ model: "test" }, undefined)).toEqual([]);
});

test("a shipped local provider counts as configured without a credential", () => {
    expect(hasConfiguredProvider(memoryAuth(), undefined, {})).toBe(true);
    expect(hasConfiguredProvider(memoryAuth(), {
        providers: {
            local: {
                protocol: "openai-chat",
                base_url: "http://127.0.0.1:1234/v1",
                credential: "none",
            },
        },
    }, {})).toBe(true);
});

test("a local ollama default is a rung; a lone answer is yellow", () => {
    expect(healthRungsOf(
        { model: "qwen3:1.7b", provider: "ollama" },
        undefined,
    )).toEqual([{ provider: "ollama", model: "qwen3:1.7b" }]);
    const ready = summarizeProviderHealth({
        results: [
            { rung: { provider: "ollama", model: "qwen3:1.7b" }, answered: true },
        ],
        configured: true,
    });
    expect(ready.tone).toBe("yellow");
    expect(ready.summary).toContain("ollama/qwen3:1.7b");
    expect(ready.next).toContain("/model");
});

test("health ids keep the model tail when the line is too long", () => {
    const id = "openrouter/z-ai/glm-5.3-flash";
    const clipped = ellipsizeHealthTail(id, 16);
    expect(clipped.startsWith("…")).toBe(true);
    expect(clipped.endsWith("glm-5.3-flash")).toBe(true);
    expect(clipped).not.toBe("openrouter/z-ai");
    const line = renderProviderHealth({
        kind: "ready",
        tone: "green",
        summary: `${id} answered`,
        details: ["openai-codex/gpt-5.3-codex-spark failed"],
    }, 40);
    expect(line[0]!.length).toBeLessThanOrEqual(40);
    expect(line[0]).toContain("green");
    expect(line[0]).toMatch(/glm-5\.3-flash answered$/);
    expect(line[1]!.length).toBeLessThanOrEqual(40);
    expect(line[1]).toMatch(/codex-spark failed$/);
});

test("an already-expired Codex token is an expired credential", () => {
    const storage = memoryAuth({
        [OPENAI_CODEX_PROVIDER_ID]: {
            type: "oauth",
            token: JSON.stringify({
                schema_version: 1,
                access_token: "a",
                refresh_token: "r",
                expires_at: 1_000,
            }),
        },
    });
    expect(expiredOAuthProvider(storage, 2_000)).toBe(OPENAI_CODEX_PROVIDER_ID);
    expect(expiredOAuthProvider(storage, 500)).toBeUndefined();
});

test("a health run with no rungs never probes", async () => {
    let probed = 0;
    const ready = await runProviderHealthCheck({
        rungs: [],
        configured: false,
        probe: async () => {
            probed += 1;
            return true;
        },
        signal: new AbortController().signal,
        onProgress: () => {},
    });
    expect(probed).toBe(0);
    expect(ready.kind).toBe("ready");
    if (ready.kind === "ready") {
        expect(ready.tone).toBe("red");
    }
});

test("a health run probes each rung and can abort mid-flight", async () => {
    const abort = new AbortController();
    const seen: string[] = [];
    const done = runProviderHealthCheck({
        rungs: [
            { provider: "openrouter", model: "one" },
            { provider: "openrouter", model: "two" },
        ],
        configured: true,
        probe: async (rung, signal) => {
            seen.push(rung.model);
            if (rung.model === "one") abort.abort();
            await new Promise<void>((resolve, reject) => {
                if (signal.aborted) {
                    reject(new Error("aborted"));
                    return;
                }
                signal.addEventListener("abort", () => reject(new Error("aborted")));
            });
            return true;
        },
        signal: abort.signal,
        onProgress: () => {},
    });
    const status = await done;
    expect(seen).toEqual(["one"]);
    expect(status.kind).toBe("idle");
});
