import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    CURATED_FRESHNESS_MS,
    curatedKey,
    curatedKeys,
    curatedModels,
    parseCuratedList,
    curatedSelection,
    readCuratedCache,
    refreshCuratedModels,
    startCuratedRefresh,
    writeCuratedCache,
} from "../../src/model/curated-models.ts";
import { effectiveCatalog } from "../../src/model/catalog.ts";

const LIST = {
    schema_version: 3,
    updated_at: "2026-09-18",
    about: "Models I reach for.",
    models: [
        { make: "Alibaba", model: "qwen3.8-max", note: "Good for everyday work." },
        { make: "Z.ai", model: "glm-5.3" },
    ],
};

function tempPath(name = "curated-models.json"): string {
    return join(mkdtempSync(join(tmpdir(), "vera-curated-")), name);
}

function answering(body: unknown, status = 200) {
    const calls: string[] = [];
    const fetch = async (url: string): Promise<Response> => {
        calls.push(url);
        return new Response(JSON.stringify(body), { status });
    };
    return { calls, fetch };
}

test("a curated list parses, and a row missing a make is dropped", () => {
    const parsed = parseCuratedList({
        ...LIST,
        models: [...LIST.models, { model: "no-make" }, { make: "X" }],
    });

    expect(parsed?.updated_at).toBe("2026-09-18");
    expect(parsed?.models.map((entry) => entry.model))
        .toEqual(["qwen3.8-max", "glm-5.3"]);
});

test("a list of another schema version does not parse", () => {
    expect(parseCuratedList({ ...LIST, schema_version: 2 })).toBeUndefined();
    expect(parseCuratedList({ schema_version: 3, models: [] })).toBeUndefined();
});

test("the key drops the namespace, the batch suffix and the dated release", () => {
    expect(curatedKey("qwen/qwen3.8-max-0902")).toBe("qwen3.8-max");
    expect(curatedKey("deepseek/deepseek-v4-pro-0813:batch")).toBe("deepseek-v4-pro");
    expect(curatedKey("~z-ai/glm-latest")).toBe("glm-latest");
    expect(curatedKey("qwen3.8-27b")).toBe("qwen3.8-27b");
});

test("one curated row matches the same model however a provider names it", () => {
    const keys = curatedKeys([{ make: "Alibaba", model: "qwen3.8-max" }]);

    expect(keys.has(curatedKey("qwen/qwen3.8-max-0902"))).toBe(true);
    expect(keys.has(curatedKey("qwen3.8-max"))).toBe(true);
});

test("a fetch writes the cache and the day after reads it back", async () => {
    const path = tempPath();
    const first = answering(LIST);
    const fetched = await refreshCuratedModels({
        url: "https://curated.test/list.json", fetch: first.fetch, path, now: 1_000,
    });

    expect(fetched.source).toBe("fetched");
    expect(fetched.list?.models).toHaveLength(2);
    expect(readCuratedCache(path)?.fetched_at).toBe(new Date(1_000).toISOString());

    const second = answering(LIST);
    const cached = await refreshCuratedModels({
        url: "https://curated.test/list.json", fetch: second.fetch, path, now: 2_000,
    });

    expect(cached.source).toBe("cache");
    expect(second.calls).toEqual([]);
});

test("a cache older than a day is fetched again", async () => {
    const path = tempPath();
    writeCuratedCache(
        { fetched_at: new Date(0).toISOString(), list: parseCuratedList(LIST)! },
        path,
    );
    const again = answering(LIST);
    const result = await refreshCuratedModels({
        url: "https://curated.test/list.json",
        fetch: again.fetch,
        path,
        now: CURATED_FRESHNESS_MS + 1,
    });

    expect(result.source).toBe("fetched");
    expect(again.calls).toHaveLength(1);
});

test("a refused fetch keeps the cached list and says why", async () => {
    const path = tempPath();
    writeCuratedCache(
        { fetched_at: new Date(0).toISOString(), list: parseCuratedList(LIST)! },
        path,
    );
    const refused = answering({}, 404);
    const result = await refreshCuratedModels({
        url: "https://curated.test/list.json",
        fetch: refused.fetch,
        path,
        now: CURATED_FRESHNESS_MS + 1,
    });

    expect(result.source).toBe("cache");
    expect(result.refusal).toBe("curated fetch answered 404");
    expect(result.list?.models).toHaveLength(2);
});

test("an unreachable address with no cache leaves the picks to the shipped ones", async () => {
    const path = tempPath();
    const result = await refreshCuratedModels({
        url: "https://curated.test/list.json",
        fetch: async () => { throw new Error("offline"); },
        path,
        now: 1,
    });

    expect(result.source).toBe("none");
    expect(result.refusal).toBe("offline");
    expect(curatedModels(path)).toEqual([]);
});

test("a damaged cache file reads as no picks at all", () => {
    const path = tempPath();
    writeFileSync(path, "{ not json");

    expect(readCuratedCache(path)).toBeUndefined();
    expect(curatedModels(path)).toEqual([]);
});

test("an empty address makes no request", () => {
    let called = 0;
    const refresh = startCuratedRefresh({
        url: "",
        fetch: async () => { called += 1; return new Response("{}"); },
    });
    refresh.close();

    expect(called).toBe(0);
});

test("one pick takes one row: not the batch variant, not the dated release", () => {
    const keys = curatedKeys([{ make: "DeepSeek", model: "deepseek-v4-pro" }]);
    const chosen = curatedSelection([
        "deepseek/deepseek-v4-pro",
        "deepseek/deepseek-v4-pro-0813",
        "deepseek/deepseek-v4-pro-0813:batch",
    ], keys);

    expect([...chosen]).toEqual(["deepseek/deepseek-v4-pro"]);
});

test("with only dated releases listed, the newest one carries the pick", () => {
    const keys = curatedKeys([{ make: "Alibaba", model: "qwen3.8-max" }]);
    const chosen = curatedSelection(
        ["qwen/qwen3.8-max-0701", "qwen/qwen3.8-max-0902"],
        keys,
    );

    expect([...chosen]).toEqual(["qwen/qwen3.8-max-0902"]);
});

test("a curated pick marks the provider row it matches", () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "vera-curated-catalog-"));
    writeFileSync(join(cacheDir, "openrouter.json"), JSON.stringify({
        schema_version: 2,
        provider: "openrouter",
        models: [
            { id: "qwen/qwen3.8-max-0902", label: "Qwen3.8 Max", levels: [] },
            { id: "qwen/qwen3.8-max-0902:batch", label: "Qwen3.8 Max batch", levels: [] },
            { id: "qwen/qwen3.8-27b", label: "Qwen3.8 27B", levels: [] },
        ],
    }));
    const catalog = effectiveCatalog("openrouter", {
        cacheDir,
        recommended: [],
        curated: [{ make: "Alibaba", model: "qwen3.8-max" }],
    });

    const marked = catalog.models.filter((model) => model.recommended === true);
    expect(marked.map((model) => model.id)).toEqual(["qwen/qwen3.8-max-0902"]);
});

test("the cache file the writer leaves behind parses as JSON", () => {
    const path = tempPath();
    writeCuratedCache(
        { fetched_at: new Date(0).toISOString(), list: parseCuratedList(LIST)! },
        path,
    );

    expect(JSON.parse(readFileSync(path, "utf8")).list.models).toHaveLength(2);
});
