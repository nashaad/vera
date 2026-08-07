import { expect, test } from "bun:test";

import { parsePoolFileText } from "../../src/model/pool-file.ts";

test("a full pool file parses into declared fields", () => {
    const parsed = parsePoolFileText(JSON.stringify({
        defaults: {
            subagent: "self",
            subagentEffort: "medium",
            allow: ["*"],
            deny: ["openrouter/*:free"],
        },
        models: {
            "bedrock/claude-sonnet-5": {
                family: "claude",
                tools: true,
                context: 1000000,
                efforts: { off: null, low: "low", xhigh: "xhigh" },
                fallback: ["bedrock/claude-haiku-4-5"],
                learned: {
                    "efforts.xhigh": {
                        ok: false,
                        seen: "2026-08-06",
                        error: "unsupported reasoning effort",
                    },
                },
            },
        },
    }));

    expect(parsed.issues).toEqual([]);
    expect(parsed.file.defaults.deny).toEqual(["openrouter/*:free"]);
    expect(parsed.file.models["bedrock/claude-sonnet-5"]).toEqual({
        family: "claude",
        tools: true,
        context: 1000000,
        efforts: { off: null, low: "low", xhigh: "xhigh" },
        fallback: ["bedrock/claude-haiku-4-5"],
        learned: {
            "efforts.xhigh": {
                ok: false,
                seen: "2026-08-06",
                error: "unsupported reasoning effort",
            },
        },
    });
});

test("a missing effort key is left absent rather than defaulted", () => {
    const parsed = parsePoolFileText(JSON.stringify({
        models: { "openai/gpt-5": { efforts: { medium: "medium" } } },
    }));

    expect(parsed.file.models["openai/gpt-5"]?.efforts)
        .toEqual({ medium: "medium" });
    expect("high" in (parsed.file.models["openai/gpt-5"]?.efforts ?? {}))
        .toBe(false);
});

test("a cross-provider fallback reference is rejected", () => {
    const parsed = parsePoolFileText(JSON.stringify({
        models: {
            "bedrock/claude-sonnet-5": {
                fallback: ["bedrock/claude-haiku-4-5", "anthropic/claude-haiku-4-5"],
            },
        },
    }));

    expect(parsed.file.models["bedrock/claude-sonnet-5"]?.fallback)
        .toEqual(["bedrock/claude-haiku-4-5"]);
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]?.path)
        .toBe("models.bedrock/claude-sonnet-5.fallback");
});

test("a model id without a provider is dropped with an issue", () => {
    const parsed = parsePoolFileText(JSON.stringify({
        models: { "claude-sonnet-5": {}, "bedrock/claude-sonnet-5": {} },
    }));

    expect(Object.keys(parsed.file.models)).toEqual(["bedrock/claude-sonnet-5"]);
    expect(parsed.issues[0]?.path).toBe("models.claude-sonnet-5");
});

test("an unknown effort level is dropped and the rest of the entry survives", () => {
    const parsed = parsePoolFileText(JSON.stringify({
        models: {
            "openai/gpt-5": {
                tools: true,
                efforts: { ultra: "ultra", high: "high" },
            },
        },
    }));

    expect(parsed.file.models["openai/gpt-5"])
        .toEqual({ tools: true, efforts: { high: "high" } });
    expect(parsed.issues[0]?.path).toBe("models.openai/gpt-5.efforts.ultra");
});

test("a malformed learned fact is dropped", () => {
    const parsed = parsePoolFileText(JSON.stringify({
        models: {
            "openai/gpt-5": {
                learned: {
                    tools: { ok: true, seen: "2026-08-06" },
                    "efforts.high": { ok: "no" },
                },
            },
        },
    }));

    expect(parsed.file.models["openai/gpt-5"]?.learned)
        .toEqual({ tools: { ok: true, seen: "2026-08-06" } });
    expect(parsed.issues).toHaveLength(1);
});

test("invalid JSON yields an empty file and one issue", () => {
    const parsed = parsePoolFileText("{ not json");

    expect(parsed.file).toEqual({ defaults: {}, models: {} });
    expect(parsed.issues).toHaveLength(1);
});

test("line and block comments parse as if they were not there", () => {
    const parsed = parsePoolFileText(`{
    // the pool the user hand-wrote
    "models": {
        /* one entry */
        "cerebras/m": { "efforts": { "high": "high" } }
    } // the pool
}`);

    expect(parsed.issues).toEqual([]);
    expect(parsed.file.models["cerebras/m"]?.efforts).toEqual({ high: "high" });
});

test("a comment marker inside a string stays part of the string", () => {
    const parsed = parsePoolFileText(
        `{ "defaults": { "deny": ["openrouter/*://free"] } }`,
    );

    expect(parsed.issues).toEqual([]);
    expect(parsed.file.defaults.deny).toEqual(["openrouter/*://free"]);
});

test("an unknown field is kept out of the file and reported as a warning", () => {
    const parsed = parsePoolFileText(JSON.stringify({
        defaults: { subagnet: "self" },
        models: { "openrouter/one": { familly: "kimi" } },
        pinnned: ["openrouter/one"],
    }));

    const warnings = parsed.issues.filter(
        (issue) => issue.severity === "warning",
    );
    expect(warnings.map((issue) => issue.path)).toEqual([
        "pinnned",
        "defaults.subagnet",
        "models.openrouter/one.familly",
    ]);
    for (const warning of warnings) {
        expect(warning.message).toContain("unknown field");
    }
    expect(parsed.file.defaults).toEqual({});
    expect(parsed.preserved).toEqual({
        root: { pinnned: ["openrouter/one"] },
        defaults: { subagnet: "self" },
        models: { "openrouter/one": { familly: "kimi" } },
    });
});

test("a legacy pinned key is kept verbatim and read by nothing", () => {
    const parsed = parsePoolFileText(JSON.stringify({
        models: { "openrouter/one": {} },
        pinned: ["openrouter/one"],
    }));

    expect(parsed.issues.map((issue) => issue.path)).toEqual(["pinned"]);
    expect(parsed.preserved.root).toEqual({ pinned: ["openrouter/one"] });
});

test("a malformed name is dropped and the rest of the entry survives", () => {
    const parsed = parsePoolFileText(JSON.stringify({
        models: { "openrouter/one": { name: "Frosty One", family: "kimi" } },
    }));

    expect(parsed.issues[0]?.path).toBe("models.openrouter/one.name");
    expect(parsed.file.models["openrouter/one"]).toEqual({ family: "kimi" });
});

test("a name two entries claim is reported against both", () => {
    const parsed = parsePoolFileText(JSON.stringify({
        models: {
            "openrouter/one": { name: "twin" },
            "cerebras/two": { name: "twin" },
        },
    }));

    expect(parsed.issues.map((issue) => issue.path)).toEqual([
        "models.openrouter/one.name",
        "models.cerebras/two.name",
    ]);
    for (const issue of parsed.issues) {
        expect(issue.message).toContain("names none");
    }
});
