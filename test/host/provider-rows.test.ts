import { expect, test } from "bun:test";

import { withProviderRows } from "../../src/host/runtime.ts";

const row = (provider: string, model: string, description = "") => ({
    provider,
    model,
    label: model,
    description,
});

test("a refreshed provider replaces only its own rows", () => {
    const before = [
        row("ollama", "llama4"),
        row("openrouter", "one/model"),
        row("openrouter", "two/model"),
    ];
    const after = withProviderRows(before, "openrouter", [
        row("openrouter", "three/model"),
    ]);
    expect(after.map((model) => model.model)).toEqual(["llama4", "three/model"]);
});

test("a provider that answers with nothing leaves the list alone", () => {
    const before = [row("openrouter", "one/model")];
    expect(withProviderRows(before, "openrouter", [])).toBe(before);
});

test("the configured model keeps its row when the fetch does not name it", () => {
    const before = [
        row("openrouter", "private/model", "configured model"),
        row("openrouter", "one/model"),
    ];
    const after = withProviderRows(before, "openrouter", [
        row("openrouter", "two/model"),
    ]);
    expect(after.map((model) => model.model))
        .toEqual(["private/model", "two/model"]);
});
