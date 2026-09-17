import { expect, test } from "bun:test";
import { join } from "node:path";

import { defaultHostExtensionConfigs } from "../../src/extensions/bundled-host.ts";
import { bundledClientExtensionConfigs } from "../../src/extensions/bundled-client.ts";
import { startExtensionRegistry } from "../../src/extensions/registry.ts";
import { startClientExtensionRegistry } from "../../src/extensions/client-registry.ts";
import { loadExtensionManifest } from "../../src/extensions/manifest.ts";
import { mergeExtensionScopes } from "../../src/extensions/discovery.ts";
import { configuredTuiClientExtensions } from "../../clients/tui/client-extension-host.ts";
import type { VeraExtensionConfig } from "../../src/config.ts";
import { planExtensionConfig } from "../../extensions/plan/extension.ts";

const root = join(import.meta.dir, "../..");
const ids = (entries: readonly VeraExtensionConfig[]): string[] =>
    entries.map((entry) => loadExtensionManifest(entry.path).manifest.id);

function copy(name: string, config = {}, enabled = true): VeraExtensionConfig {
    return { path: join(root, "extensions", name), enabled, config };
}

test("Plan options require explicit opt-in and preserve the skill allow-list", () => {
    expect(planExtensionConfig(undefined)).toEqual({
        allowSkillScripts: false, composeSuggestion: false,
    });
    expect(planExtensionConfig({ skills: [" search-sessions "] })).toEqual({
        allowSkillScripts: false, composeSuggestion: false,
        skills: ["search-sessions"],
    });
    expect(planExtensionConfig({
        allow_skill_scripts: "true", compose_suggestion: 1, skills: [],
    })).toEqual({ allowSkillScripts: false, composeSuggestion: false, skills: [] });
});

async function client(extensions: readonly VeraExtensionConfig[]) {
    const failures: string[] = [];
    const activity: string[] = [];
    const unexpected = (operation: string): never => {
        activity.push(operation);
        throw new Error(`Unexpected activation call: ${operation}`);
    };
    const registry = await startClientExtensionRegistry({
        extensions,
        preferences: { async get() { return undefined; }, async set() {}, async delete() {} },
        modelSettings: {
            current: () => undefined,
            async update() { return { status: "rejected", reason: "unavailable" }; },
            subscribe: () => () => {},
        },
        picker: { async request() { return { outcome: "cancelled" }; } },
        notice: { post() {} },
        agents: {
            visible: () => [],
            async create() { return unexpected("No conversation should start during activation"); },
            async open() { return unexpected("No conversation should open during activation"); },
            async message() { return unexpected("No message should be sent during activation"); },
        },
        mentions: { set() {} },
        context: {
            current() { return unexpected("No context read during activation"); },
            async sources() { return unexpected("No source scan during activation"); },
        },
        sessions: { async list() { return unexpected("No session scan during activation"); } },
        experimentalTui: {
            mount() { return unexpected("No view during activation"); },
            mountRenderable() { return unexpected("No view during activation"); },
            openDocument() { return unexpected("No document during activation"); },
            events: { on: () => () => {} },
            agentSurface: { current: () => undefined, cycleLayout: () => false, toggleFocus: () => false },
        },
        onFailure: (failure) => failures.push(failure.message),
    });
    expect(activity).toEqual([]);
    return { registry, failures };
}

test("included host extensions start with a bounded Plan and no command hooks", async () => {
    const failures: string[] = [];
    const registry = await startExtensionRegistry({
        extensions: defaultHostExtensionConfigs([]),
        onFailure: (failure) => failures.push(failure.message),
    });
    try {
        expect(failures).toEqual([]);
        expect(registry.agents().find((entry) => entry.name === "plan"))
            .toMatchObject({
                tools: ["read", "grep", "list"],
                posture: "readonly",
                forbiddenAccess: ["auto", "full_access"],
            });
        expect(registry.preToolUseHooks()).toEqual([]);
        expect(registry.postToolUseHooks()).toEqual([]);
    } finally {
        await registry.close();
    }
});

test("included client extensions register commands without starting work", async () => {
    const { registry, failures } = await client(bundledClientExtensionConfigs([]));
    try {
        expect(failures).toEqual([]);
        expect(registry.loadedExtensionIds()).toContain("vera.btw");
        expect(registry.loadedExtensionIds()).toContain("example.context");
        for (const name of ["context", "dashboard"]) {
            expect(registry.commands().filter((entry) => entry.name === name)).toHaveLength(1);
        }
        expect(registry.commands().find((entry) => entry.name === "diff")).toBeDefined();
        expect(registry.loadedExtensionIds()).toContain("example.plan");
        expect(registry.commands().filter((entry) => ["btw", "pair"].includes(entry.name)))
            .toHaveLength(2);
        expect(registry.composeSuggesters()).toEqual([]);
    } finally {
        await registry.close();
    }
});

test("each included battery can be disabled on both applicable sides", () => {
    const disabled = ["example.command-hooks", "example.plan", "vera.btw", "vera.diff", "example.context"];
    for (const id of disabled) {
        expect(ids(defaultHostExtensionConfigs(disabled))).not.toContain(id);
        expect(ids(bundledClientExtensionConfigs(disabled))).not.toContain(id);
    }
});

test("explicit legacy paths replace included copies and retain Plan options", async () => {
    const explicit = [copy("plan", { allow_skill_scripts: true, compose_suggestion: true }), copy("btw")];
    const hostEntries = mergeExtensionScopes(defaultHostExtensionConfigs([]), explicit);
    const clientEntries = configuredTuiClientExtensions([], explicit);
    for (const entries of [hostEntries, clientEntries]) {
        expect(ids(entries).filter((id) => id === "example.plan")).toHaveLength(1);
        expect(ids(entries).filter((id) => id === "vera.btw")).toHaveLength(1);
    }
    const hostFailures: string[] = [];
    const host = await startExtensionRegistry({
        extensions: hostEntries,
        onFailure: (failure) => hostFailures.push(failure.message),
    });
    const { registry, failures } = await client(clientEntries);
    try {
        expect(hostFailures).toEqual([]);
        expect(failures).toEqual([]);
        expect(host.agents().find((entry) => entry.name === "plan")?.tools)
            .toEqual(["read", "grep", "list", "skill_script"]);
        expect(registry.composeSuggesters()).toHaveLength(1);
        expect(registry.composeSuggesters()[0]?.matches("make a plan"))
            .toBe(true);
    } finally {
        await registry.close();
        await host.close();
    }
});

test("a disabled explicit copy suppresses the included copy", async () => {
    const explicit = [copy("plan", {}, false), copy("btw", {}, false)];
    const { registry, failures } = await client(configuredTuiClientExtensions([], explicit));
    const host = await startExtensionRegistry({
        extensions: mergeExtensionScopes(defaultHostExtensionConfigs([]), explicit),
    });
    try {
        expect(failures).toEqual([]);
        expect(registry.loadedExtensionIds()).not.toContain("vera.btw");
        expect(registry.loadedExtensionIds()).not.toContain("example.plan");
        expect(host.agents().some((entry) => entry.name === "plan")).toBe(false);
    } finally {
        await registry.close();
        await host.close();
    }
});

test("malformed supplied hook configuration still fails activation", async () => {
    const failures: string[] = [];
    const registry = await startExtensionRegistry({
        extensions: [copy("command-hooks", { hooks: "invalid" })],
        onFailure: (failure) => failures.push(failure.message),
    });
    try {
        expect(failures).toEqual([
            expect.stringContaining("Command-hook config requires a hooks array"),
        ]);
    } finally {
        await registry.close();
    }
});

for (const mode of ["override", "disabled-copy", "disabled-builtin"] as const) {
    test(`Context ${mode} retains ID-based command ownership`, async () => {
        const explicit = mode === "disabled-builtin" ? [] : [{
            path: join(root, "extensions/context"),
            enabled: mode === "override",
            config: { retained: true },
        }];
        const entries = configuredTuiClientExtensions(
            mode === "disabled-builtin" ? ["example.context"] : [], explicit,
        );
        const context = entries.filter((entry) => loadExtensionManifest(entry.path).manifest.id === "example.context");
        expect(context).toHaveLength(mode === "disabled-builtin" ? 0 : 1);
        if (mode !== "disabled-builtin") expect(context[0]).toEqual(explicit[0]);
        const { registry, failures } = await client(entries);
        try {
            expect(failures).toEqual([]);
            for (const name of ["context", "dashboard"]) {
                expect(registry.commands().filter((entry) => entry.name === name))
                    .toHaveLength(mode === "override" ? 1 : 0);
            }
        } finally {
            await registry.close();
        }
    });
}
