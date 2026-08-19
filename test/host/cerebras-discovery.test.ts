import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { VeraConfig } from "../../src/config.ts";

import {
    cerebrasModels,
    discoveredCerebrasModels,
} from "../../src/host/runtime.ts";

test("Cerebras discovery maps public capability metadata", () => {
    expect(cerebrasModels({
        data: [{
            id: "gpt-oss-120b",
            name: "OpenAI GPT OSS",
            description: "Fast reasoning model",
            capabilities: { tools: true, reasoning: true },
            limits: { max_context_length: 131_072 },
        }],
    })).toEqual([{
        provider: "cerebras",
        model: "gpt-oss-120b",
        label: "OpenAI GPT OSS",
        description: "Fast reasoning model",
        contextWindow: 131_072,
    }]);
});

test("Cerebras discovery is gated on a usable connection", async () => {
    let fetched = false;
    const models = await discoveredCerebrasModels({
        schema_version: 1,
        provider: "openrouter",
        model: "any/model",
        approval_mode: "ask",
    }, {
        authStorage: { getCredential: () => undefined },
        fetch: async () => {
            fetched = true;
            return new Response('{"data":[]}');
        },
    });

    expect(models).toEqual([]);
    expect(fetched).toBe(false);
});

const config: VeraConfig = {
    schema_version: 1,
    provider: "cerebras",
    model: "gpt-oss-120b",
    approval_mode: "ask",
};

function listing(): Response {
    return new Response(JSON.stringify({
        data: [{
            id: "gpt-oss-120b",
            name: "OpenAI GPT OSS",
            limits: { max_context_length: 131_072 },
        }],
    }));
}

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function cacheDir(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-cerebras-"));
    directories.push(directory);
    return directory;
}

test("a remembered Cerebras listing answers without a request", async () => {
    const directory = cacheDir();
    let requests = 0;
    const fetch = async () => {
        requests += 1;
        return listing();
    };

    const first = await discoveredCerebrasModels(config, {
        cacheDir: directory,
        maxAgeMs: 3_600_000,
        fetch,
    });
    const second = await discoveredCerebrasModels(config, {
        cacheDir: directory,
        maxAgeMs: 3_600_000,
        fetch,
    });

    expect(requests).toBe(1);
    expect(second).toEqual(first);
    expect(second.map((model) => model.model)).toEqual(["gpt-oss-120b"]);
});

test("a manual refresh asks even with a snapshot in hand", async () => {
    const directory = cacheDir();
    let requests = 0;
    const fetch = async () => {
        requests += 1;
        return listing();
    };

    await discoveredCerebrasModels(config, {
        cacheDir: directory,
        maxAgeMs: 3_600_000,
        fetch,
    });
    await discoveredCerebrasModels(config, {
        cacheDir: directory,
        maxAgeMs: 0,
        fetch,
    });

    expect(requests).toBe(2);
});

test("a failed Cerebras fetch falls back to the last listing", async () => {
    const directory = cacheDir();
    await discoveredCerebrasModels(config, {
        cacheDir: directory,
        maxAgeMs: 3_600_000,
        fetch: async () => listing(),
    });

    const offline = await discoveredCerebrasModels(config, {
        cacheDir: directory,
        maxAgeMs: 0,
        fetch: async () => {
            throw new Error("offline");
        },
    });

    expect(offline.map((model) => model.model)).toEqual(["gpt-oss-120b"]);
});
