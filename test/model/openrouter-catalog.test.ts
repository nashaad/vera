import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    normalizeOpenRouterModels,
    refreshOpenRouterCatalog,
} from "../../src/model/openrouter-catalog.ts";
import { effectiveCatalog } from "../../src/model/catalog.ts";

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function cacheDir(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-openrouter-"));
    directories.push(directory);
    return directory;
}

function model(overrides: Record<string, unknown> = {}): unknown {
    return {
        id: "vendor/model",
        name: "Vendor: Model",
        context_length: 128_000,
        supported_parameters: ["tools", "temperature"],
        ...overrides,
    };
}

function respondWith(body: unknown, ok = true): typeof globalThis.fetch {
    return (async () => ({
        ok,
        json: async () => body,
    })) as unknown as typeof globalThis.fetch;
}

describe("normalizeOpenRouterModels", () => {
    test("keeps only models that accept tool calls", () => {
        const catalog = normalizeOpenRouterModels({
            data: [
                model(),
                model({
                    id: "vendor/chat-only",
                    supported_parameters: ["temperature"],
                }),
                model({ id: "vendor/no-parameters", supported_parameters: null }),
            ],
        });

        // Vera drives every turn through tool calls, so a model without them
        // would fail on its first turn rather than merely do less.
        expect(catalog.models.map((entry) => entry.id))
            .toEqual(["vendor/model"]);
    });

    test("carries the facts the picker shows", () => {
        const catalog = normalizeOpenRouterModels({ data: [model()] });

        expect(catalog.models[0]).toMatchObject({
            id: "vendor/model",
            label: "Vendor: Model",
            context_window: 128_000,
            tool_support: true,
        });
        expect(catalog.provider).toBe("openrouter");
        expect(catalog.fetched_at).toBeString();
    });

    test("reduces a paragraph description to its first sentence", () => {
        const catalog = normalizeOpenRouterModels({
            data: [model({
                description:
                    "A capable model.  It also does other things.\nAnd more.",
            })],
        });

        expect(catalog.models[0]?.description).toBe("A capable model.");
    });

    test("unwraps markdown, which a plain-text row cannot render", () => {
        const catalog = normalizeOpenRouterModels({
            data: [model({
                description:
                    "Fast variant of [Opus 5](/anthropic/claude-opus-5), a "
                    + "*124B* model from <https://example.com>. More text.",
            })],
        });

        expect(catalog.models[0]?.description).toBe(
            "Fast variant of Opus 5, a 124B model from https://example.com.",
        );
    });

    test("publishes levels strongest-first, and none without reasoning", () => {
        const reasoning = normalizeOpenRouterModels({
            data: [model({
                supported_parameters: ["tools", "reasoning_effort"],
            })],
        });
        // Anthropic models list the `reasoning` object without the
        // `reasoning_effort` shorthand; either word means an effort is taken.
        const reasoningObject = normalizeOpenRouterModels({
            data: [model({
                supported_parameters: ["tools", "reasoning"],
            })],
        });
        const plain = normalizeOpenRouterModels({ data: [model()] });

        // The order is the only thing that says which way is up, since level
        // ids are provider words rather than a scale.
        expect(reasoning.models[0]?.levels.map((level) => level.id))
            .toEqual(["high", "medium", "low"]);
        expect(reasoningObject.models[0]?.levels.map((level) => level.id))
            .toEqual(["high", "medium", "low"]);
        // Empty means no reasoning control at all, which is the truth here.
        expect(plain.models[0]?.levels).toEqual([]);
    });

    test("publishes the levels a model announces, ladder order", () => {
        const catalog = normalizeOpenRouterModels({
            data: [model({
                supported_parameters: ["tools", "reasoning_effort"],
                reasoning: {
                    supported_efforts: [
                        "low",
                        "max",
                        "medium",
                        "high",
                        "xhigh",
                        "none",
                    ],
                    default_effort: "medium",
                },
            })],
        });

        const entry = catalog.models[0];
        // Announced order is not trusted: the ladder decides which way is up.
        // `none` is not a depth, so it is not a row.
        expect(entry?.levels.map((level) => level.id))
            .toEqual(["max", "xhigh", "high", "medium", "low"]);
        expect(entry?.levels.map((level) => level.label))
            .toEqual(["Max", "Extra High", "High", "Medium", "Low"]);
        expect(entry?.default_level).toBe("medium");
    });

    test("a level outside the ladder is kept, after the ones on it", () => {
        const catalog = normalizeOpenRouterModels({
            data: [model({
                supported_parameters: ["tools", "reasoning_effort"],
                reasoning: { supported_efforts: ["low", "ultra", "high"] },
            })],
        });

        expect(catalog.models[0]?.levels.map((level) => level.id))
            .toEqual(["high", "low", "ultra"]);
        expect(catalog.models[0]?.levels.map((level) => level.label))
            .toEqual(["High", "Low", "Ultra"]);
    });

    test("a default the model does not list is not published", () => {
        const catalog = normalizeOpenRouterModels({
            data: [model({
                supported_parameters: ["tools", "reasoning_effort"],
                reasoning: {
                    supported_efforts: ["high", "low"],
                    default_effort: "none",
                },
            })],
        });

        expect(catalog.models[0]?.default_level).toBeUndefined();
    });

    test("an effort-taking model that lists no efforts keeps the three", () => {
        const catalog = normalizeOpenRouterModels({
            data: [model({
                supported_parameters: ["tools", "reasoning_effort"],
                reasoning: { mandatory: false },
            })],
        });

        expect(catalog.models[0]?.levels.map((level) => level.id))
            .toEqual(["high", "medium", "low"]);
    });

    test("a body that is not a model list yields no models", () => {
        expect(normalizeOpenRouterModels({}).models).toEqual([]);
        expect(normalizeOpenRouterModels(null).models).toEqual([]);
        expect(normalizeOpenRouterModels({ data: [{}, 7] }).models).toEqual([]);
    });
});

describe("refreshOpenRouterCatalog", () => {
    test("publishes a snapshot the catalog can read back", async () => {
        const directory = cacheDir();
        const catalog = await refreshOpenRouterCatalog({
            cacheDir: directory,
            fetch: respondWith({ data: [model()] }),
        });

        expect(catalog?.models.map((entry) => entry.id))
            .toEqual(["vendor/model"]);
        expect(
            effectiveCatalog("openrouter", { cacheDir: directory })
                .models.map((entry) => entry.id),
        ).toEqual(["vendor/model"]);
    });

    test("an unreachable endpoint falls back to the last snapshot", async () => {
        const directory = cacheDir();
        await refreshOpenRouterCatalog({
            cacheDir: directory,
            fetch: respondWith({ data: [model()] }),
        });

        const offline = await refreshOpenRouterCatalog({
            cacheDir: directory,
            fetch: (() => Promise.reject(new Error("offline"))) as unknown as
                typeof globalThis.fetch,
        });

        // A list from yesterday answers "which models can I run" far better
        // than an empty picker does.
        expect(offline?.models.map((entry) => entry.id))
            .toEqual(["vendor/model"]);
    });

    test("a refusal falls back too, rather than emptying the list", async () => {
        const directory = cacheDir();
        await refreshOpenRouterCatalog({
            cacheDir: directory,
            fetch: respondWith({ data: [model()] }),
        });

        expect(
            (await refreshOpenRouterCatalog({
                cacheDir: directory,
                fetch: respondWith("nope", false),
            }))?.models,
        ).toHaveLength(1);
    });

    test("nothing fresh and nothing remembered is undefined", async () => {
        expect(await refreshOpenRouterCatalog({
            cacheDir: cacheDir(),
            fetch: respondWith({ data: [] }),
        })).toBeUndefined();
    });

    test("a snapshot inside the max age is answered without a request", async () => {
        const directory = cacheDir();
        await refreshOpenRouterCatalog({
            cacheDir: directory,
            fetch: respondWith({ data: [model()] }),
        });

        let asked = false;
        const catalog = await refreshOpenRouterCatalog({
            cacheDir: directory,
            maxAgeMs: 3_600_000,
            fetch: (() => {
                asked = true;
                return Promise.reject(new Error("must not ask"));
            }) as unknown as typeof globalThis.fetch,
        });

        // Starting Vera is not a reason to call a provider.
        expect(asked).toBe(false);
        expect(catalog?.models.map((entry) => entry.id))
            .toEqual(["vendor/model"]);
    });

    test("a snapshot past the max age is refetched", async () => {
        const directory = cacheDir();
        mkdirSync(directory, { recursive: true });
        writeFileSync(
            join(directory, "openrouter.json"),
            JSON.stringify({
                schema_version: 2,
                provider: "openrouter",
                fetched_at: new Date(Date.now() - 30 * 86_400_000)
                    .toISOString(),
                models: [{ id: "remembered", label: "Remembered", levels: [] }],
            }),
        );

        const catalog = await refreshOpenRouterCatalog({
            cacheDir: directory,
            maxAgeMs: 86_400_000,
            fetch: respondWith({ data: [model()] }),
        });

        expect(catalog?.models.map((entry) => entry.id))
            .toEqual(["vendor/model"]);
    });

    test("a reachable endpoint with nothing usable keeps the snapshot", async () => {
        const directory = cacheDir();
        mkdirSync(directory, { recursive: true });
        writeFileSync(
            join(directory, "openrouter.json"),
            JSON.stringify({
                schema_version: 2,
                provider: "openrouter",
                models: [{ id: "remembered", label: "Remembered", levels: [] }],
            }),
        );

        expect(
            (await refreshOpenRouterCatalog({
                cacheDir: directory,
                fetch: respondWith({ data: [] }),
            }))?.models.map((entry) => entry.id),
        ).toEqual(["remembered"]);
    });
});
