import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    PoolFileWriteRefusedError,
    addPoolModel,
    readUserPoolFile,
    recordLearned,
    removePoolModel,
} from "../../src/model/pool-file-store.ts";

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function poolPath(text?: string): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-pool-store-"));
    directories.push(directory);
    const path = join(directory, "pool.json");
    if (text !== undefined) {
        writeFileSync(path, text);
    }
    return path;
}

test("a missing file is created by the first write", () => {
    const path = poolPath();

    addPoolModel("cerebras/m", { tools: true }, { path });

    expect(readUserPoolFile({ path }).models["cerebras/m"]).toEqual({
        tools: true,
    });
});

test("a commented file is edited without losing its declared entries", () => {
    const path = poolPath(`{
    // hand written
    "models": { "cerebras/m": { "efforts": { "high": "high" } } }
}`);

    recordLearned(
        "cerebras/m",
        { "efforts.xhigh": { ok: false, seen: "2026-08-06" } },
        { path },
    );

    const file = readUserPoolFile({ path });
    expect(file.models["cerebras/m"]?.efforts).toEqual({ high: "high" });
    expect(file.models["cerebras/m"]?.learned?.["efforts.xhigh"]?.ok)
        .toBe(false);
});

test("a learned write over an unparseable file is refused, not applied", () => {
    const text = `{ "models": { "cerebras/m": { "efforts": { high: high } } } }`;
    const path = poolPath(text);

    expect(() =>
        recordLearned(
            "cerebras/m",
            { "efforts.xhigh": { ok: false, seen: "2026-08-06" } },
            { path },
        )
    ).toThrow(PoolFileWriteRefusedError);
    expect(readFileSync(path, "utf8")).toBe(text);
});

test("a write is refused when any single entry failed to parse", () => {
    const text = JSON.stringify({
        models: {
            "cerebras/m": { efforts: { high: "high" } },
            "no-provider": {},
        },
    });
    const path = poolPath(text);

    expect(() => addPoolModel("cerebras/other", {}, { path }))
        .toThrow(PoolFileWriteRefusedError);
    expect(readFileSync(path, "utf8")).toBe(text);
});

test("an unknown field does not block a write and survives it verbatim", () => {
    const path = poolPath(JSON.stringify({
        models: { "cerebras/m": { userPath: "/tmp/somewhere", family: "m" } },
        nickname: "mine",
    }));

    addPoolModel("cerebras/other", {}, { path });

    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.nickname).toBe("mine");
    expect(written.models["cerebras/m"].userPath).toBe("/tmp/somewhere");
    expect(written.models["cerebras/m"].family).toBe("m");
    expect(written.models["cerebras/other"]).toEqual({});
});

test("an entry's unknown fields go with it when the entry is removed", () => {
    const path = poolPath(JSON.stringify({
        models: { "cerebras/m": { userPath: "/tmp/somewhere" } },
    }));

    removePoolModel("cerebras/m", { path });

    expect(JSON.parse(readFileSync(path, "utf8")).models).toEqual({});
});
