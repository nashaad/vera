import { afterEach, expect, test } from "bun:test";
import {
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CatalogModel } from "../../src/model/catalog-shape.ts";
import {
    addToStash,
    markStashEntryUsed,
    readStash,
    removeFromStash,
    resolveStash,
} from "../../src/model/stash-store.ts";

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("add puts entries at the front and re-adding moves without duplicating", () => {
    const path = temporaryConfigPath();

    addToStash(entry("openai-codex", "gpt-5.6-sol"), { path });
    addToStash(entry("openrouter", "anthropic/example-model"), { path });
    addToStash(entry("openai-codex", "gpt-5.6-sol"), { path });

    expect(readStash({ path })).toEqual([
        entry("openai-codex", "gpt-5.6-sol"),
        entry("openrouter", "anthropic/example-model"),
    ]);
});

test("remove deletes any position and ignores missing entries", () => {
    const path = temporaryConfigPath();
    addToStash(entry("one", "first"), { path });
    addToStash(entry("two", "second"), { path });
    addToStash(entry("three", "third"), { path });

    removeFromStash(entry("two", "second"), { path });
    removeFromStash(entry("missing", "model"), { path });

    expect(readStash({ path })).toEqual([
        entry("three", "third"),
        entry("one", "first"),
    ]);
});

test("mark used moves an existing entry and does not add a missing entry", () => {
    const path = temporaryConfigPath();
    addToStash(entry("one", "first"), { path });
    addToStash(entry("two", "second"), { path });

    markStashEntryUsed(entry("one", "first"), { path });
    markStashEntryUsed(entry("missing", "model"), { path });

    expect(readStash({ path })).toEqual([
        entry("one", "first"),
        entry("two", "second"),
    ]);
});

test("resolve preserves order and keeps unavailable identifiers", () => {
    const known = catalogModel("known/model", "Known model");
    const stash = [
        entry("openrouter", "unknown/model"),
        entry("openai-codex", "known/model"),
    ];

    expect(resolveStash(stash, new Map([
        ["openai-codex/known/model", known],
    ]))).toEqual([
        {
            status: "unavailable",
            provider: "openrouter",
            model: "unknown/model",
        },
        {
            status: "resolved",
            provider: "openai-codex",
            model: "known/model",
            catalogModel: known,
        },
    ]);
});

test("read degrades to an empty stash for absent or invalid storage", () => {
    const path = temporaryConfigPath();
    expect(readStash({ path })).toEqual([]);

    writeFileSync(path, JSON.stringify({ schema_version: 1 }));
    expect(readStash({ path })).toEqual([]);

    writeFileSync(path, "{broken");
    expect(readStash({ path })).toEqual([]);

    writeFileSync(path, JSON.stringify({ stash: [null, 2, {}] }));
    expect(readStash({ path })).toEqual([]);
});

test("read filters non-string stash values and splits only the first slash", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        stash: [
            "openrouter/anthropic/example-model",
            null,
            2,
        ],
    }));

    expect(readStash({ path })).toEqual([
        entry("openrouter", "anthropic/example-model"),
    ]);
});

test("writes preserve unrelated top-level config keys", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "existing-model",
        nested: { keep: true },
    }));

    addToStash(entry("openai-codex", "gpt-5.6-sol"), { path });

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        schema_version: 1,
        model: "existing-model",
        nested: { keep: true },
        stash: ["openai-codex/gpt-5.6-sol"],
    });
});

test("each write reads changes made by the previous write", () => {
    const path = temporaryConfigPath();

    addToStash(entry("first", "model"), { path });
    addToStash(entry("second", "model"), { path });

    expect(readStash({ path })).toEqual([
        entry("second", "model"),
        entry("first", "model"),
    ]);
});

function temporaryConfigPath(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-stash-store-"));
    directories.push(directory);
    return join(directory, "config.json");
}

function entry(provider: string, model: string) {
    return { provider, model };
}

function catalogModel(id: string, label: string): CatalogModel {
    return {
        id,
        label,
        levels: [],
    };
}
