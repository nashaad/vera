import { expect, test } from "bun:test";

import { poolReachability } from "../../src/model/assignment-reachability.ts";
import type { PoolFile } from "../../src/model/pool-file.ts";

function pool(models: string[], deny?: string[]): PoolFile {
    return {
        defaults: deny === undefined ? {} : { deny },
        models: Object.fromEntries(models.map((id) => [id, {}])),
    };
}

const ENTRY = {
    provider: "openrouter" as const,
    model: "z-ai/glm-5.2",
    name: "glm_low",
};

test("a pooled model is reachable", () => {
    expect(poolReachability(pool(["openrouter/z-ai/glm-5.2"]))(ENTRY))
        .toBe(true);
});

test("a model absent from the pool is not reachable", () => {
    expect(poolReachability(pool(["openrouter/other"]))(ENTRY)).toBe(false);
});

test("a pooled model the pool denies is not reachable", () => {
    const file = pool(["openrouter/z-ai/glm-5.2"], ["openrouter/*"]);
    expect(poolReachability(file)(ENTRY)).toBe(false);
});
