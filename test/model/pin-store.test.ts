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
    addPin,
    markPinUsed,
    readPins,
    removePin,
    resolvePins,
} from "../../src/model/pin-store.ts";

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("add puts entries at the front and re-adding moves without duplicating", () => {
    const path = temporaryConfigPath();

    addPin(entry("openai-codex", "gpt-5.6-sol"), { path });
    addPin(entry("openrouter", "anthropic/example-model"), { path });
    addPin(entry("openai-codex", "gpt-5.6-sol"), { path });

    expect(readPins({ path })).toEqual([
        entry("openai-codex", "gpt-5.6-sol"),
        entry("openrouter", "anthropic/example-model"),
    ]);
});

test("remove deletes any position and ignores missing entries", () => {
    const path = temporaryConfigPath();
    addPin(entry("one", "first"), { path });
    addPin(entry("two", "second"), { path });
    addPin(entry("three", "third"), { path });

    removePin(entry("two", "second"), { path });
    removePin(entry("missing", "model"), { path });

    expect(readPins({ path })).toEqual([
        entry("three", "third"),
        entry("one", "first"),
    ]);
});

test("mark used moves an existing entry and does not add a missing entry", () => {
    const path = temporaryConfigPath();
    addPin(entry("one", "first"), { path });
    addPin(entry("two", "second"), { path });

    markPinUsed(entry("one", "first"), { path });
    markPinUsed(entry("missing", "model"), { path });

    expect(readPins({ path })).toEqual([
        entry("one", "first"),
        entry("two", "second"),
    ]);
});

test("resolve preserves order and keeps unavailable identifiers", () => {
    const known = catalogModel("known/model", "Known model");
    const pinned = [
        entry("openrouter", "unknown/model"),
        entry("openai-codex", "known/model"),
    ];

    expect(resolvePins(pinned, new Map([
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

test("read degrades to an empty pinned for absent or invalid storage", () => {
    const path = temporaryConfigPath();
    expect(readPins({ path })).toEqual([]);

    writeFileSync(path, JSON.stringify({ schema_version: 1 }));
    expect(readPins({ path })).toEqual([]);

    writeFileSync(path, "{broken");
    expect(readPins({ path })).toEqual([]);

    writeFileSync(path, JSON.stringify({ pinned: [null, 2, {}] }));
    expect(readPins({ path })).toEqual([]);
});

test("read filters non-string pinned values and splits only the first slash", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        pinned: [
            "openrouter/anthropic/example-model",
            null,
            2,
        ],
    }));

    expect(readPins({ path })).toEqual([
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

    addPin(entry("openai-codex", "gpt-5.6-sol"), { path });

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        schema_version: 1,
        model: "existing-model",
        nested: { keep: true },
        pinned: ["openai-codex/gpt-5.6-sol"],
    });
});

test("each write reads changes made by the previous write", () => {
    const path = temporaryConfigPath();

    addPin(entry("first", "model"), { path });
    addPin(entry("second", "model"), { path });

    expect(readPins({ path })).toEqual([
        entry("second", "model"),
        entry("first", "model"),
    ]);
});

function temporaryConfigPath(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-pinned-store-"));
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
