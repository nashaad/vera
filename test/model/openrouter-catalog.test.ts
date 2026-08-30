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

    test("normalizes listed input and output prices to USD per million", () => {
        const catalog = normalizeOpenRouterModels({
            data: [
                model({
                    pricing: {
                        prompt: "0.0000002",
                        completion: "0.0000012",
                    },
                }),
                model({
                    id: "vendor/unpriced",
                    pricing: { prompt: "free-ish", completion: "0.000001" },
                }),
                model({
                    id: "vendor/unknown",
                    pricing: { prompt: "-1", completion: "0.000001" },
                }),
            ],
        });

        expect(catalog.models[0]?.pricing).toEqual({ input: 0.2, output: 1.2 });
        expect(catalog.models[1]?.pricing).toBeUndefined();
        expect(catalog.models[2]?.pricing).toBeUndefined();
    });

    test("keeps a listed cache-hit rate when OpenRouter publishes one", () => {
        const catalog = normalizeOpenRouterModels({
            data: [model({
                pricing: {
                    prompt: "0.000002",
                    completion: "0.000006",
                    input_cache_read: "0.0000002",
                },
            })],
        });

        expect(catalog.models[0]?.pricing).toEqual({
            input: 2,
            output: 6,
            cache: 0.2,
        });
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

    test("a model whose only effort is none gets no levels", () => {
        const catalog = normalizeOpenRouterModels({
            data: [model({
                supported_parameters: ["tools", "reasoning_effort"],
                reasoning: { supported_efforts: ["none"] },
            })],
        });

        // It stated its vocabulary and Vera offers none of it. That is an
        // answer, so the three documented levels are not put in its mouth.
        expect(catalog.models[0]?.levels).toEqual([]);
    });

    test("an underscored level reads as words", () => {
        const catalog = normalizeOpenRouterModels({
            data: [model({
                supported_parameters: ["tools", "reasoning_effort"],
                reasoning: { supported_efforts: ["ultra_high"] },
            })],
        });

        expect(catalog.models[0]?.levels.map((level) => level.label))
            .toEqual(["Ultra High"]);
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

    test("persists pricing through the discovery snapshot", async () => {
        const directory = cacheDir();
        await refreshOpenRouterCatalog({
            cacheDir: directory,
            fetch: respondWith({ data: [model({
                pricing: { prompt: "0.0000002", completion: "0.0000012" },
            })] }),
        });

        expect(
            effectiveCatalog("openrouter", { cacheDir: directory })
                .models[0]?.pricing,
        ).toEqual({ input: 0.2, output: 1.2 });
    });

    test("a malformed pricing object on one row is omitted for that row", () => {
        const directory = cacheDir();
        mkdirSync(directory, { recursive: true });
        writeFileSync(
            join(directory, "openrouter.json"),
            JSON.stringify({
                schema_version: 2,
                provider: "openrouter",
                fetched_at: "2026-08-29T00:00:00Z",
                models: [
                    {
                        id: "good",
                        label: "Good",
                        pricing: { input: 3, output: 15 },
                        levels: [],
                    },
                    {
                        id: "bad",
                        label: "Bad",
                        pricing: { input: -1, output: 2 },
                        levels: [],
                    },
                ],
            }),
        );

        const catalog = effectiveCatalog("openrouter", { cacheDir: directory });
        expect(catalog.models.map((entry) => entry.id)).toEqual(["bad", "good"]);
        expect(catalog.models.find((entry) => entry.id === "good")?.pricing)
            .toEqual({ input: 3, output: 15 });
        expect(catalog.models.find((entry) => entry.id === "bad")?.pricing)
            .toBeUndefined();
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
