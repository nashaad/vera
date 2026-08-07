import { expect, test } from "bun:test";

import { parsePoolFile, type PoolFile } from "../../src/model/pool-file.ts";
import {
    poolNameOf,
    poolNameRefusal,
    poolNames,
    resolvePoolRef,
} from "../../src/model/pool-names.ts";

function pool(models: Record<string, unknown>): PoolFile {
    return parsePoolFile({ models }).file;
}

const named = pool({
    "openrouter/frost-1": { tools: true, name: "frosty" },
    "cerebras/warm-1": { tools: true },
});

test("a name resolves to the entry that holds it", () => {
    expect(resolvePoolRef(named, "frosty")).toBe("openrouter/frost-1");
    expect(poolNameOf(named, "openrouter/frost-1")).toBe("frosty");
    expect(poolNameOf(named, "cerebras/warm-1")).toBeUndefined();
});

test("a ref with a slash is an id, and only a pooled id resolves", () => {
    expect(resolvePoolRef(named, "cerebras/warm-1")).toBe("cerebras/warm-1");
    expect(resolvePoolRef(named, "openrouter/never-added")).toBeUndefined();
    expect(resolvePoolRef(named, "nobody")).toBeUndefined();
});

test("a learned-only entry carries neither name nor ref", () => {
    const learned = pool({
        "openrouter/seen-1": {
            name: "seen",
            learned: { "efforts.xhigh": { ok: false } },
        },
    });

    expect(poolNames(learned)).toEqual([]);
    expect(resolvePoolRef(learned, "seen")).toBeUndefined();
});

test("a name two entries claim names neither of them", () => {
    const shared = pool({
        "openrouter/one": { tools: true, name: "twin" },
        "cerebras/two": { tools: true, name: "twin" },
    });

    expect(poolNames(shared)).toEqual([]);
    expect(resolvePoolRef(shared, "twin")).toBeUndefined();
});

test("names are refused for shape, for collisions, and off the pool", () => {
    expect(poolNameRefusal(named, "openrouter/frost-1", "chilly"))
        .toBeUndefined();
    // Keeping its own name is not a collision with itself.
    expect(poolNameRefusal(named, "openrouter/frost-1", "frosty"))
        .toBeUndefined();
    expect(poolNameRefusal(named, "cerebras/warm-1", "Frosty"))
        .toBe("malformed");
    expect(poolNameRefusal(named, "cerebras/warm-1", "open/router"))
        .toBe("malformed");
    expect(poolNameRefusal(named, "cerebras/warm-1", "frosty")).toBe("taken");
    expect(poolNameRefusal(named, "openrouter/absent", "spare"))
        .toBe("not_pooled");
});
