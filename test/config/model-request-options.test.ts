import { afterEach, expect, test } from "bun:test";
import {
    chmodSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    loadVeraConfig,
    updateVeraConfigDefaults,
    VeraConfigError,
} from "../../src/config.ts";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a hand-written exact-model request option parses", () => {
    const path = configPath({
        "openrouter/z-ai/glm-5.3-flash": {
            body: {
                provider: {
                    only: ["z-ai"],
                    allow_fallbacks: false,
                },
            },
        },
    });

    expect(loadVeraConfig({ path }).model_request_options).toEqual({
        "openrouter/z-ai/glm-5.3-flash": {
            body: {
                provider: {
                    only: ["z-ai"],
                    allow_fallbacks: false,
                },
            },
        },
    });
});

test("the atomic writer replaces and clears one model without disturbing config", () => {
    const path = configPath({
        "openrouter/first/model": { body: { provider: { only: ["first"] } } },
        "openrouter/second/model": { body: { provider: { only: ["second"] } } },
    }, { context_limit: 131_072 });
    chmodSync(path, 0o644);

    updateVeraConfigDefaults({
        model_request_options: {
            model: "openrouter/first/model",
            body: { provider: { only: ["replacement"] } },
        },
    }, { path });

    let loaded = loadVeraConfig({ path });
    expect(loaded.context_limit).toBe(131_072);
    expect(loaded.model_request_options).toEqual({
        "openrouter/first/model": {
            body: { provider: { only: ["replacement"] } },
        },
        "openrouter/second/model": {
            body: { provider: { only: ["second"] } },
        },
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);

    updateVeraConfigDefaults({
        model_request_options: {
            model: "openrouter/first/model",
            body: {},
        },
    }, { path });
    loaded = loadVeraConfig({ path });
    expect(loaded.model_request_options).toEqual({
        "openrouter/second/model": {
            body: { provider: { only: ["second"] } },
        },
    });

    updateVeraConfigDefaults({
        model_request_options: {
            model: "openrouter/second/model",
            body: null,
        },
    }, { path });
    expect(loadVeraConfig({ path }).model_request_options).toBeUndefined();
    expect(JSON.parse(readFileSync(path, "utf8")).model_request_options)
        .toBeUndefined();
});

test.each([
    ["options array", []],
    ["options scalar", 1],
    ["bad reference", { bad: { body: {} } }],
    ["unsupported provider", { "ollama/model": { body: {} } }],
    ["entry scalar", { "openrouter/model": 1 }],
    ["body array", { "openrouter/model": { body: [] } }],
    ["body null", { "openrouter/model": { body: null } }],
    ["protected field", { "openrouter/model": { body: { messages: [] } } }],
    ["header override", { "openrouter/model": { body: { headers: {} } } }],
    ["credential override", { "openrouter/model": { body: { api_key: "secret" } } }],
    ["unknown OpenRouter field", {
        "openrouter/model": { body: { provider: { future_field: true } } },
    }],
    ["malformed OpenRouter field", {
        "openrouter/model": { body: { provider: { only: [""] } } },
    }],
    ["nested unknown OpenRouter field", {
        "openrouter/model": {
            body: { provider: { max_price: { prompt: "1", future: "2" } } },
        },
    }],
    ["nested credential field", {
        "openrouter/model": {
            body: {
                provider: {
                    max_price: { prompt: "1", api_key: "never-store-this" },
                },
            },
        },
    }],
])("invalid %s config is refused through VeraConfigError", (_label, options) => {
    const path = configPath(options);
    expect(() => loadVeraConfig({ path })).toThrow(VeraConfigError);
});

test("an oversized body is refused", () => {
    const path = configPath({
        "openrouter/model": {
            body: { provider: { only: ["x".repeat(70_000)] } },
        },
    });
    expect(() => loadVeraConfig({ path })).toThrow(VeraConfigError);
});

test("a rejected programmatic write leaves the file byte-for-byte intact", () => {
    const path = configPath({
        "openrouter/model": { body: { provider: { only: ["safe"] } } },
    });
    const before = readFileSync(path);

    expect(() => updateVeraConfigDefaults({
        model_request_options: {
            model: "openrouter/model",
            body: { provider: { only: [Number.NaN] } } as never,
        },
    }, { path })).toThrow("non-finite");

    expect(readFileSync(path)).toEqual(before);
});

test.each([
    ["array root", []],
    ["undefined", { provider: { only: [undefined] } }],
    ["function", { provider: { only: [() => "no"] } }],
    ["binary value", { provider: { only: [new Uint8Array([1])] } }],
])("a rejected programmatic %s leaves the file intact", (_label, body) => {
    const path = configPath({
        "openrouter/model": { body: { provider: { only: ["safe"] } } },
    });
    const before = readFileSync(path);

    expect(() => updateVeraConfigDefaults({
        model_request_options: {
            model: "openrouter/model",
            body: body as never,
        },
    }, { path })).toThrow(VeraConfigError);

    expect(readFileSync(path)).toEqual(before);
});

test("a cyclic programmatic body leaves the file intact", () => {
    const path = configPath({
        "openrouter/model": { body: { provider: { only: ["safe"] } } },
    });
    const before = readFileSync(path);
    const body: Record<string, unknown> = {};
    body.provider = body;

    expect(() => updateVeraConfigDefaults({
        model_request_options: {
            model: "openrouter/model",
            body: body as never,
        },
    }, { path })).toThrow(VeraConfigError);

    expect(readFileSync(path)).toEqual(before);
});

function configPath(
    modelRequestOptions: unknown,
    extra: Record<string, unknown> = {},
): string {
    const root = mkdtempSync(join(tmpdir(), "vera-model-request-options-"));
    roots.push(root);
    const path = join(root, "config.json");
    writeFileSync(path, `${JSON.stringify({
        schema_version: 1,
        provider: "openrouter",
        model: "test/model",
        approval_mode: "ask",
        model_request_options: modelRequestOptions,
        ...extra,
    }, null, 2)}\n`, { mode: 0o600 });
    return path;
}
