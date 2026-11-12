import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadVeraConfig, VeraConfigError } from "../src/config.ts";

function configPath(hooks: unknown): string {
    const path = join(mkdtempSync(join(tmpdir(), "vera-config-trigger-hook-")), "config.json");
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        hooks,
    }));
    return path;
}

test("the context size trigger phase is accepted for the Vera protocol", () => {
    const path = configPath([
        { phase: "context_size_trigger", argv: ["lookout.ts"] },
    ]);
    expect(loadVeraConfig({ path }).hooks?.map((hook) => hook.phase))
        .toEqual(["context_size_trigger"]);
});

test("the context size trigger phase has no claude protocol event", () => {
    const path = configPath([
        { phase: "context_size_trigger", argv: ["lookout.ts"], protocol: "claude" },
    ]);
    expect(() => loadVeraConfig({ path })).toThrow(VeraConfigError);
});

function eventsPath(contextSizeEvents: unknown): string {
    const path = join(mkdtempSync(join(tmpdir(), "vera-config-size-events-")), "config.json");
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        context_size_events: contextSizeEvents,
    }));
    return path;
}

test("context size events load sorted with duplicates removed", () => {
    expect(loadVeraConfig({ path: eventsPath([0.9, 0.5, 0.7, 0.5]) }).context_size_events)
        .toEqual([0.5, 0.7, 0.9]);
    expect(loadVeraConfig({ path: eventsPath([]) }).context_size_events).toEqual([]);
});

test("an absent context size events key stays undefined", () => {
    expect(loadVeraConfig({ path: configPath([]) }).context_size_events).toBeUndefined();
});

test("context size events reject values outside the window", () => {
    for (const value of [[0], [-0.2], [1.1], ["0.5"], [null], 0.5, null, {}]) {
        expect(() => loadVeraConfig({ path: eventsPath(value) })).toThrow(
            "context_size_events: expected an array of numbers above 0 and at most 1",
        );
    }
});
