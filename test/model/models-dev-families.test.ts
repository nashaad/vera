import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    FAMILY_CACHE_MAX_AGE_MS,
    modelFamilies,
    openRouterFamilies,
} from "../../src/model/models-dev-families.ts";

const NOW = 1_760_000_000_000;

function cacheDir(): string {
    return mkdtempSync(join(tmpdir(), "vera-families-"));
}

function answering(body: unknown, calls: { count: number }): typeof fetch {
    return (async () => {
        calls.count += 1;
        return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
}

const DOCUMENT = {
    anthropic: { models: { "claude-opus-5": { family: "claude-opus" } } },
    openrouter: {
        models: {
            "anthropic/claude-opus-5": { family: "claude-opus" },
            "z-ai/glm-5.2": { family: "glm" },
            "vendor/unlabelled": {},
        },
    },
};

test("only the OpenRouter section is kept, and only labelled models", () => {
    const families = openRouterFamilies(DOCUMENT);
    expect(families).toEqual({
        "anthropic/claude-opus-5": "claude-opus",
        "z-ai/glm-5.2": "glm",
    });
});

test("a document with no OpenRouter section reads as no families", () => {
    expect(openRouterFamilies({ anthropic: { models: {} } })).toEqual({});
    expect(openRouterFamilies("not a document")).toEqual({});
});

test("a fetched map is cached and the week after is not refetched", async () => {
    const directory = cacheDir();
    const calls = { count: 0 };
    const options = {
        cacheDir: directory,
        fetch: answering(DOCUMENT, calls),
        now: NOW,
    };

    const first = await modelFamilies(options);
    expect(first.get("z-ai/glm-5.2")).toBe("glm");
    expect(calls.count).toBe(1);

    await modelFamilies({ ...options, now: NOW + FAMILY_CACHE_MAX_AGE_MS - 1 });
    expect(calls.count).toBe(1);

    await modelFamilies({ ...options, now: NOW + FAMILY_CACHE_MAX_AGE_MS });
    expect(calls.count).toBe(2);
});

test("an unreachable models.dev answers with what Vera already holds", async () => {
    const directory = cacheDir();
    const calls = { count: 0 };
    await modelFamilies({
        cacheDir: directory,
        fetch: answering(DOCUMENT, calls),
        now: NOW,
    });

    const stale = await modelFamilies({
        cacheDir: directory,
        now: NOW + 10 * FAMILY_CACHE_MAX_AGE_MS,
        fetch: (() => {
            throw new Error("offline");
        }) as unknown as typeof fetch,
    });
    expect(stale.get("z-ai/glm-5.2")).toBe("glm");
});

test("with nothing held and nothing reachable, the map is empty", async () => {
    const families = await modelFamilies({
        cacheDir: cacheDir(),
        now: NOW,
        fetch: (() => {
            throw new Error("offline");
        }) as unknown as typeof fetch,
    });
    expect(families.size).toBe(0);
});

test("an unreadable cache file is treated as no cache", async () => {
    const directory = cacheDir();
    writeFileSync(join(directory, "models-dev-families.json"), "{ not json");
    const calls = { count: 0 };
    const families = await modelFamilies({
        cacheDir: directory,
        fetch: answering(DOCUMENT, calls),
        now: NOW,
    });
    expect(families.get("z-ai/glm-5.2")).toBe("glm");
    expect(calls.count).toBe(1);
});

test("the cache holds only the OpenRouter families, not the whole document", async () => {
    const directory = cacheDir();
    await modelFamilies({
        cacheDir: directory,
        fetch: answering(DOCUMENT, { count: 0 }),
        now: NOW,
    });
    const written: unknown = JSON.parse(
        readFileSync(join(directory, "models-dev-families.json"), "utf8"),
    );
    expect(JSON.stringify(written)).not.toContain("anthropic\":{\"models");
    expect((written as { families: Record<string, string> }).families)
        .toEqual({
            "anthropic/claude-opus-5": "claude-opus",
            "z-ai/glm-5.2": "glm",
        });
});
