import { expect, test } from "bun:test";

import { declaredPoolEntry } from "../../src/model/pool-admission.ts";

test("a catalog model enters with its description copied into the entry", () => {
    expect(declaredPoolEntry({
        id: "glm-5.2",
        label: "GLM-5.2",
        tool_support: true,
        context_window: 200_000,
        levels: [
            { id: "high", label: "High" },
            { id: "low", label: "Low" },
        ],
    })).toEqual({
        added: true,
        tools: true,
        context: 200_000,
        efforts: { high: "high", low: "low" },
    });
});

test("the provider's word for no reasoning lands on the ladder rung", () => {
    expect(declaredPoolEntry({
        id: "gpt-5.6-sol",
        label: "GPT-5.6-Sol",
        levels: [{ id: "none", label: "None" }, { id: "xhigh", label: "XHigh" }],
    })).toEqual({ added: true, efforts: { off: "none", xhigh: "xhigh" } });
});

test("a level the ladder cannot name is left out of the entry", () => {
    expect(declaredPoolEntry({
        id: "gpt-5.6-sol",
        label: "GPT-5.6-Sol",
        levels: [{ id: "ultra", label: "Ultra" }, { id: "high", label: "High" }],
    })).toEqual({ added: true, efforts: { high: "high" } });
});

test("a model the catalog never heard of enters on safe defaults", () => {
    // Nothing is claimed on its behalf, so nothing constrains it either: the
    // entry records only that the user added it, and every fact about the
    // model is still open.
    expect(declaredPoolEntry(undefined)).toEqual({ added: true });
});

test("a catalog model with no levels declares no efforts at all", () => {
    expect(declaredPoolEntry({
        id: "plain",
        label: "Plain",
        levels: [],
    })).toEqual({ added: true });
});
