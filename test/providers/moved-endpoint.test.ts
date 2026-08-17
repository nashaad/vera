import { expect, test } from "bun:test";

import { diagnoseProviders } from "../../clients/provider-doctor.ts";
import {
    discoveredCerebrasModels,
    discoveredOllamaModels,
    discoveredOpenRouterModels,
} from "../../src/host/runtime.ts";
import type { VeraConfig } from "../../src/config.ts";
import type { StoredCredential } from "../../src/providers/auth-storage.ts";
import { providerEndpointUrl } from "../../src/providers/endpoint-url.ts";

/**
 * A provider pointed somewhere else is pointed somewhere else everywhere.
 *
 * Each of these paths used to carry its own copy of the shipped host, so a
 * user who moved a provider got turns on the new host and a model list, a
 * probe, or a report from the old one. The probe is the one that mattered
 * most: it carries the credential.
 */
const KEY: StoredCredential = { type: "api_key", key: "secret-key" };

const AUTH = {
    getCredential(provider: string): StoredCredential | undefined {
        return provider === "openai-codex" ? undefined : KEY;
    },
};

/** Records every URL asked for, and answers with an empty model list. */
function recordingFetch(seen: string[]): typeof globalThis.fetch {
    return (async (input: string | URL | Request, _init?: RequestInit) => {
        seen.push(String(input));
        return new Response(JSON.stringify({ data: [] }), {
            headers: { "content-type": "application/json" },
        });
    }) as typeof globalThis.fetch;
}

test("the doctor probes the moved host, not the shipped one", async () => {
    const seen: string[] = [];
    const report = await diagnoseProviders(
        { provider_endpoints: { cerebras: "https://eu.cerebras.example/v1" } },
        {
            checkNetwork: true,
            env: {},
            authStorage: AUTH,
            fetch: recordingFetch(seen),
        },
    );

    expect(seen).toContain("https://eu.cerebras.example/v1/models");
    // The credential went to the host the user chose and nowhere else.
    expect(seen.some((url) => url.startsWith("https://api.cerebras.ai")))
        .toBe(false);
    const cerebras = report.providers.find(
        (provider) => provider.id === "cerebras",
    );
    expect(cerebras?.endpoint?.baseUrl).toBe("https://eu.cerebras.example/v1");
});

test("the doctor still probes Codex where Codex lives", async () => {
    const seen: string[] = [];
    await diagnoseProviders(
        // Nothing can put an entry here for a fixed provider, but the report
        // must not honour one if a file somehow carries it.
        { provider_endpoints: { "openai-codex": "https://elsewhere.example" } },
        {
            checkNetwork: true,
            env: {},
            authStorage: AUTH,
            fetch: recordingFetch(seen),
        },
    );

    expect(seen.some((url) => url.startsWith("https://elsewhere.example")))
        .toBe(false);
});

test("Ollama discovery asks the moved daemon", async () => {
    const seen: string[] = [];
    await discoveredOllamaModels({
        // The trailing path is what a user pastes after reading it off the
        // chat endpoint; the daemon is still the host underneath it.
        host: "http://127.0.0.1:11435/v1",
        fetch: recordingFetch(seen),
    });

    expect(seen[0]).toBe("http://127.0.0.1:11435/v1/models");
});

test("Cerebras discovery asks the moved host", async () => {
    const seen: string[] = [];
    await discoveredCerebrasModels(
        {
            provider: "cerebras",
            provider_endpoints: { cerebras: "https://eu.cerebras.example/v1" },
        } as unknown as VeraConfig,
        { authStorage: AUTH, fetch: recordingFetch(seen) },
    );

    expect(seen).toEqual(["https://eu.cerebras.example/v1/models"]);
});

test("the OpenRouter catalog refreshes from the moved host", async () => {
    const seen: string[] = [];
    await discoveredOpenRouterModels(
        {
            provider: "openrouter",
            provider_endpoints: { openrouter: "https://gateway.example/v1" },
        } as unknown as VeraConfig,
        { authStorage: AUTH, fetch: recordingFetch(seen) } as never,
    );

    expect(seen).toEqual(["https://gateway.example/v1/models"]);
});

test("a gateway's query survives the path join", () => {
    expect(
        providerEndpointUrl("https://gw.example/v1?api-version=2026-08-01", "/chat/completions"),
    ).toBe("https://gw.example/v1/chat/completions?api-version=2026-08-01");
    expect(providerEndpointUrl("https://api.deepseek.com/", "/chat/completions"))
        .toBe("https://api.deepseek.com/chat/completions");
});

test("a moved Ollama host is cut back to a host before it is used or logged", async () => {
    const seen: string[] = [];
    const entries: { host?: string }[] = [];
    await discoveredOllamaModels({
        host: "http://localhost:11435/v1?token=secret",
        fetch: recordingFetch(seen),
        log: (entry) => { entries.push(entry as { host?: string }); },
    });
    expect(seen[0]).toBe("http://localhost:11435/v1/models");
    const hosts = entries.map((entry) => entry.host).filter((host) => host !== undefined);
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) {
        expect(host).toBe("http://localhost:11435");
    }
});
