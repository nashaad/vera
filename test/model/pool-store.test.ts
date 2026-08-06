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
    addPoolEntry,
    markPoolEntryNeedsReverify,
    readPool,
    removePoolEntry,
    resolvePool,
    type PoolVerification,
} from "../../src/model/pool-store.ts";

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("add puts entries at the front and re-adding moves without duplicating", () => {
    const path = temporaryConfigPath();

    addPoolEntry(entry("openai-codex", "gpt-5.6-sol"), { path });
    addPoolEntry(entry("openrouter", "anthropic/example-model"), { path });
    addPoolEntry(entry("openai-codex", "gpt-5.6-sol"), { path });

    expect(readPool({ path })).toEqual([
        entry("openai-codex", "gpt-5.6-sol"),
        entry("openrouter", "anthropic/example-model"),
    ]);
});

test("remove deletes any position and ignores missing entries", () => {
    const path = temporaryConfigPath();
    addPoolEntry(entry("one", "first"), { path });
    addPoolEntry(entry("two", "second"), { path });
    addPoolEntry(entry("three", "third"), { path });

    removePoolEntry(entry("two", "second"), { path });
    removePoolEntry(entry("missing", "model"), { path });

    expect(readPool({ path })).toEqual([
        entry("three", "third"),
        entry("one", "first"),
    ]);
});

test("a verification record round-trips through the store intact", () => {
    const path = temporaryConfigPath();
    const admitted = {
        ...entry("openrouter", "anthropic/example-model"),
        verification: verification(),
    };

    addPoolEntry(admitted, { path });

    expect(readPool({ path })).toEqual([admitted]);
});

test("legacy pinned identifiers read as pool entries with no verification", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        pinned: [
            "openrouter/anthropic/example-model",
            null,
            2,
        ],
    }));

    expect(readPool({ path })).toEqual([
        entry("openrouter", "anthropic/example-model"),
    ]);
});

test("a write migrates legacy pinned into pool and drops the old key", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "existing-model",
        pinned: ["openrouter/anthropic/example-model"],
    }));

    addPoolEntry(entry("openai-codex", "gpt-5.6-sol"), { path });

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        schema_version: 1,
        model: "existing-model",
        pool: [
            entry("openai-codex", "gpt-5.6-sol"),
            entry("openrouter", "anthropic/example-model"),
        ],
    });
});

test("resolve marks unverified and needs-reverify entries as needs_verify", () => {
    const known = catalogModel("known/model", "Known model");
    const verified = {
        ...entry("openai-codex", "known/model"),
        verification: verification(),
    };
    const flagged = {
        ...entry("openrouter", "flagged/model"),
        verification: { ...verification(), needs_reverify: true },
    };
    const unverified = entry("openrouter", "unknown/model");

    expect(resolvePool([verified, flagged, unverified], new Map([
        ["openai-codex/known/model", known],
    ]))).toEqual([
        { status: "ready", ...verified, catalogModel: known },
        { status: "needs_verify", ...flagged },
        { status: "needs_verify", ...unverified },
    ]);
});

test("marking needs-reverify flips only the named verified entry", () => {
    const path = temporaryConfigPath();
    addPoolEntry(entry("two", "unverified"), { path });
    addPoolEntry({
        ...entry("one", "verified"),
        verification: verification(),
    }, { path });

    markPoolEntryNeedsReverify(entry("one", "verified"), { path });
    markPoolEntryNeedsReverify(entry("two", "unverified"), { path });

    expect(readPool({ path })).toEqual([
        {
            ...entry("one", "verified"),
            verification: { ...verification(), needs_reverify: true },
        },
        entry("two", "unverified"),
    ]);
});

test("read degrades to an empty pool for absent or invalid storage", () => {
    const path = temporaryConfigPath();
    expect(readPool({ path })).toEqual([]);

    writeFileSync(path, JSON.stringify({ schema_version: 1 }));
    expect(readPool({ path })).toEqual([]);

    writeFileSync(path, "{broken");
    expect(readPool({ path })).toEqual([]);

    writeFileSync(path, JSON.stringify({ pool: [null, 2, {}, "text"] }));
    expect(readPool({ path })).toEqual([]);
});

test("writes preserve unrelated top-level config keys", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "existing-model",
        nested: { keep: true },
    }));

    addPoolEntry(entry("openai-codex", "gpt-5.6-sol"), { path });

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        schema_version: 1,
        model: "existing-model",
        nested: { keep: true },
        pool: [entry("openai-codex", "gpt-5.6-sol")],
    });
});

test("each write reads changes made by the previous write", () => {
    const path = temporaryConfigPath();

    addPoolEntry(entry("first", "model"), { path });
    addPoolEntry(entry("second", "model"), { path });

    expect(readPool({ path })).toEqual([
        entry("second", "model"),
        entry("first", "model"),
    ]);
});

function temporaryConfigPath(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-pool-store-"));
    directories.push(directory);
    return join(directory, "config.json");
}

function entry(provider: string, model: string) {
    return { provider, model };
}

function verification(): PoolVerification {
    return {
        verified_at: "2026-08-01T00:00:00.000Z",
        response_model: "example-model-v2",
        levels: [{ vera_effort: "high", provider_effort: "high" }],
        checked: "user_key",
    };
}

function catalogModel(id: string, label: string): CatalogModel {
    return {
        id,
        label,
        levels: [],
    };
}
