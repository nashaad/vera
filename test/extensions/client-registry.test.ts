import {
    afterEach,
    expect,
    test,
} from "bun:test";
import {
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonValue } from "../../src/sdk/hooks.ts";
import type {
    VeraClientModelSettingsListener,
    VeraClientModelSettingsSnapshot,
    VeraClientPickerRequest,
    VeraClientPickerResult,
} from "../../src/sdk/extensions.ts";
import {
    startClientExtensionRegistry,
    type ClientExtensionConfig,
    type ClientExtensionModelSettingsAdapter,
    type ClientExtensionPickerAdapter,
    type ClientExtensionPreferencesAdapter,
    type ClientExtensionRegistryFailure,
} from "../../src/extensions/client-registry.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("client registry exposes client-owned services without TUI objects", async () => {
    const workspace = createDirectory();
    const cleanupPath = join(workspace, "cleanup.txt");
    const extension = createExtension("client.presets", [
        "client.commands.register",
        "client.keybindings.register",
        "client.preferences",
        "client.model_settings",
        "client.ui.picker",
    ], `
        import { appendFile } from "node:fs/promises";

        export async function activateClient(vera) {
            const initial = vera.modelSettings.current();
            await vera.preferences.set("slots", [
                initial.provider,
                initial.model,
                initial.reasoningEffort,
            ]);
            vera.modelSettings.onChanged((settings) => {
                void Bun.write(
                    ${JSON.stringify(join(workspace, "changed.json"))},
                    JSON.stringify(settings),
                );
            });
            vera.commands.register({
                name: "pick-model",
                description: "Pick a model",
                usage: "/pick-model",
                palette: {
                    label: "Pick model",
                    group: "Settings",
                    keyHint: "shift+tab",
                },
                async run({ workspace, signal }) {
                    const picked = await vera.ui.requestPicker({
                        title: "Models",
                        rows: [
                            { id: "fast", label: "Fast" },
                            { id: "deep", label: "Deep", current: true },
                        ],
                        selectedId: "deep",
                        actions: [
                            { id: "apply", label: "Apply", keys: ["enter"] },
                            { id: "save", label: "Save", keys: ["s"] },
                        ],
                    }, signal);
                    if (picked.outcome === "cancelled") {
                        return { kind: "notice", level: "info", text: "cancelled" };
                    }
                    const updated = await vera.modelSettings.update({
                        provider: "openrouter",
                        model: picked.rowId,
                        reasoningEffort: "high",
                    }, signal);
                    return {
                        kind: "text",
                        text: workspace + ":" + updated.status,
                    };
                },
            });
            vera.keybindings.register({
                id: "cycle-model",
                description: "Cycle models",
                keys: ["shift+tab"],
                async run({ workspace }) {
                    await vera.preferences.set("last-workspace", workspace);
                },
            });
            vera.onDispose(() =>
                appendFile(${JSON.stringify(cleanupPath)}, "disposed\\n")
            );
        }
    `);
    const harness = createHarness();
    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension, { user: "Nash" })],
        ...harness.adapters,
    });

    expect(registry.commands()).toEqual([{
        name: "pick-model",
        description: "Pick a model",
        usage: "/pick-model",
        source: "client.presets",
        palette: {
            label: "Pick model",
            group: "Settings",
            keyHint: "shift+tab",
        },
    }]);
    expect(registry.keybindings()).toEqual([{
        id: "cycle-model",
        description: "Cycle models",
        keys: ["shift+tab"],
        source: "client.presets",
    }]);
    expect(harness.preferences.get("client.presets:slots")).toEqual([
        "openrouter",
        "initial",
        "low",
    ]);

    await expect(registry.invokeCommand(
        "pick-model",
        "",
        workspace,
    )).resolves.toEqual({
        version: 1,
        source: "client.presets/pick-model",
        body: {
            kind: "text",
            text: `${workspace}:accepted`,
        },
    });
    expect(harness.pickers).toEqual([{
        extensionId: "client.presets",
        request: {
            title: "Models",
            rows: [
                { id: "fast", label: "Fast" },
                { id: "deep", label: "Deep", current: true },
            ],
            selectedId: "deep",
            actions: [
                { id: "apply", label: "Apply", keys: ["enter"] },
                { id: "save", label: "Save", keys: ["s"] },
            ],
        },
    }]);
    expect(harness.updates).toEqual([{
        provider: "openrouter",
        model: "deep",
        reasoningEffort: "high",
    }]);

    await registry.invokeKeybinding("cycle-model", workspace);
    expect(harness.preferences.get("client.presets:last-workspace"))
        .toBe(workspace);

    harness.emitSettings({
        provider: "openai-codex",
        model: "gpt-test",
        reasoningEffort: "medium",
    });
    await waitFor(() => Bun.file(join(workspace, "changed.json")).size > 0);
    expect(JSON.parse(readFileSync(
        join(workspace, "changed.json"),
        "utf8",
    ))).toEqual({
        provider: "openai-codex",
        model: "gpt-test",
        reasoningEffort: "medium",
    });

    await registry.close();
    expect(harness.listenerCount()).toBe(0);
    expect(readFileSync(cleanupPath, "utf8")).toBe("disposed\n");
});

test("client registry keeps command and keybinding ownership atomic", async () => {
    const first = createExtension("client.first", [
        "client.commands.register",
        "client.keybindings.register",
    ], contributionSource("shared", "shared-key"));
    const collision = createExtension("client.collision", [
        "client.commands.register",
        "client.keybindings.register",
    ], contributionSource("shared", "other-key", "ctrl+k"));
    const reserved = createExtension("client.reserved", [
        "client.commands.register",
        "client.keybindings.register",
    ], contributionSource("allowed", "reserved-key", "shift+tab"));
    const failures: ClientExtensionRegistryFailure[] = [];
    const harness = createHarness();
    const registry = await startClientExtensionRegistry({
        extensions: [
            configured(first),
            configured(collision),
            configured(reserved),
        ],
        reservedKeybindingKeys: ["shift+tab"],
        onFailure: (failure) => failures.push(failure),
        ...harness.adapters,
    });

    expect(registry.commands().map(({ name }) => name)).toEqual(["shared"]);
    expect(registry.keybindings().map(({ id }) => id)).toEqual(["shared-key"]);
    expect(failures.map(({ message }) => message)).toEqual([
        expect.stringContaining("/shared"),
        expect.stringContaining("shift+tab"),
    ]);
    await registry.close();
});

test("client capabilities are required and later extensions still load", async () => {
    const undeclared = createExtension(
        "client.undeclared",
        ["client.preferences"],
        `
        export function activateClient(vera) {
            vera.commands.register({
                name: "hidden",
                description: "Hidden",
                usage: "/hidden",
                run() { return { kind: "text", text: "no" }; },
            });
        }
        `,
    );
    const healthy = createExtension(
        "client.healthy",
        ["client.commands.register"],
        contributionSource("healthy"),
    );
    const failures: ClientExtensionRegistryFailure[] = [];
    const harness = createHarness();
    const registry = await startClientExtensionRegistry({
        extensions: [configured(undeclared), configured(healthy)],
        onFailure: (failure) => failures.push(failure),
        ...harness.adapters,
    });

    expect(registry.commands().map(({ name }) => name)).toEqual(["healthy"]);
    expect(failures[0]?.message).toContain(
        "did not declare client.commands.register",
    );
    await registry.close();
});

test("command timeouts abort cooperative handlers and preserve later use", async () => {
    const extension = createExtension(
        "client.timeout",
        ["client.commands.register"],
        `
            export function activateClient(vera) {
                vera.commands.register({
                    name: "work",
                    description: "Work",
                    usage: "/work",
                    async run({ argumentsText, signal }) {
                        if (argumentsText === "fast") {
                            return { kind: "text", text: "ready" };
                        }
                        await new Promise((resolve) => {
                            signal.addEventListener("abort", resolve, {
                                once: true,
                            });
                        });
                        return { kind: "text", text: "late" };
                    },
                });
            }
        `,
    );
    const harness = createHarness();
    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        handlerTimeoutMs: 10,
        ...harness.adapters,
    });

    await expect(registry.invokeCommand(
        "work",
        "slow",
        createDirectory(),
    )).rejects.toThrow("timed out after 10ms");
    await expect(registry.invokeCommand(
        "work",
        "fast",
        createDirectory(),
    )).resolves.toMatchObject({
        body: { kind: "text", text: "ready" },
    });
    await registry.close();
});

test("command timeout reaches picker calls when the extension omits the signal", async () => {
    let pickerAborted = false;
    const extension = createExtension(
        "client.picker-timeout",
        ["client.commands.register", "client.ui.picker"],
        `
            export function activateClient(vera) {
                vera.commands.register({
                    name: "pick",
                    description: "Pick",
                    usage: "/pick",
                    async run() {
                        await vera.ui.requestPicker({
                            title: "Waiting",
                            rows: [{ id: "one", label: "One" }],
                            actions: [{ id: "choose", label: "Choose", keys: ["enter"] }],
                        });
                        return { kind: "text", text: "late" };
                    },
                });
            }
        `,
    );
    const harness = createHarness();
    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        handlerTimeoutMs: 10,
        ...harness.adapters,
        picker: {
            request(_extensionId, _request, signal) {
                return new Promise((resolve) => {
                    signal.addEventListener("abort", () => {
                        pickerAborted = true;
                        resolve({ outcome: "cancelled" });
                    }, { once: true });
                });
            },
        },
    });

    await expect(registry.invokeCommand(
        "pick",
        "",
        createDirectory(),
    )).rejects.toThrow("timed out after 10ms");
    expect(pickerAborted).toBe(true);
    await registry.close();
});

test("interactive commands remain active until the client cancels them", async () => {
    const extension = createExtension(
        "client.interactive",
        ["client.commands.register", "client.ui.picker"],
        `
            export function activateClient(vera) {
                vera.commands.register({
                    name: "pick",
                    description: "Pick",
                    usage: "/pick",
                    interactive: true,
                    async run() {
                        await vera.ui.requestPicker({
                            title: "Waiting",
                            rows: [{ id: "one", label: "One" }],
                            actions: [{ id: "choose", label: "Choose", keys: ["enter"] }],
                        });
                        return { kind: "notice", level: "info", text: "closed" };
                    },
                });
            }
        `,
    );
    const harness = createHarness();
    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        handlerTimeoutMs: 10,
        ...harness.adapters,
        picker: {
            request(_extensionId, _request, signal) {
                return new Promise((resolve) => {
                    signal.addEventListener("abort", () => {
                        resolve({ outcome: "cancelled" });
                    }, { once: true });
                });
            },
        },
    });
    const controller = new AbortController();
    const invocation = registry.invokeCommand(
        "pick",
        "",
        createDirectory(),
        controller.signal,
    );
    const outcome = await Promise.race([
        invocation.then(() => "settled", () => "settled"),
        Bun.sleep(30).then(() => "pending"),
    ]);
    expect(outcome).toBe("pending");

    controller.abort();
    await expect(invocation).rejects.toThrow("aborted");
    await registry.close();
});

test("bundled preset uses the same public seams as a user extension", async () => {
    const extension = join(
        import.meta.dir,
        "../../extensions/model-presets",
    );
    const preferences = new Map<string, JsonValue>();
    const updates: unknown[] = [];
    const pickerResults: VeraClientPickerResult[] = [
        { outcome: "selected", rowId: "slot-2", actionId: "choose" },
        { outcome: "cancelled" },
    ];
    let pickerIndex = 0;
    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        preferences: {
            async get(namespace, key) {
                return preferences.get(`${namespace}:${key}`);
            },
            async set(namespace, key, value) {
                preferences.set(`${namespace}:${key}`, value);
            },
            async delete(namespace, key) {
                preferences.delete(`${namespace}:${key}`);
            },
        },
        modelSettings: {
            current: () => ({
                provider: "openrouter",
                model: "moonshotai/kimi-k3",
                reasoningEffort: "low",
            }),
            async update(patch) {
                updates.push(patch);
                return {
                    status: "accepted",
                    settings: {
                        provider: patch.provider,
                        model: patch.model ?? "moonshotai/kimi-k3",
                        reasoningEffort: patch.reasoningEffort ?? "low",
                    },
                };
            },
            subscribe: () => () => undefined,
        },
        picker: {
            async request(_extensionId, request) {
                expect(request.title).toBe("Model presets");
                expect(request.rows).toHaveLength(4);
                return pickerResults[pickerIndex++]
                    ?? { outcome: "cancelled" };
            },
        },
    });

    expect(registry.commands()).toEqual([expect.objectContaining({
        name: "preset",
        source: "vera.model-presets",
    })]);
    expect(registry.keybindings()).toEqual([expect.objectContaining({
        id: "cycle-preset",
        keys: ["shift+tab"],
    })]);

    await registry.invokeCommand("preset", "", createDirectory());
    expect(preferences.get("vera.model-presets:slots")).toEqual([
        null,
        {
            provider: "openrouter",
            model: "moonshotai/kimi-k3",
            reasoningEffort: "low",
        },
        null,
        null,
    ]);

    preferences.set("vera.model-presets:slots", [
        {
            provider: "openai-codex",
            model: "gpt-5.6",
            reasoningEffort: "high",
        },
        null,
        null,
        null,
    ]);
    pickerIndex = 0;
    pickerResults[0] = {
        outcome: "selected",
        rowId: "slot-1",
        actionId: "choose",
    };
    await registry.invokeCommand("preset", "", createDirectory());
    expect(updates).toEqual([{
        provider: "openai-codex",
        model: "gpt-5.6",
        reasoningEffort: "high",
    }]);
    await registry.close();

    const source = readFileSync(
        join(extension, "extension.ts"),
        "utf8",
    );
    expect(source).not.toContain("../src");
    expect(source).not.toContain("clients/tui");
});

test("modelSettings.currentLevels finds the current model's own levels off availableModels", async () => {
    const workspace = createDirectory();
    const extension = createExtension("client.levels", [
        "client.commands.register",
        "client.model_settings",
    ], `
        export function activateClient(vera) {
            vera.commands.register({
                name: "levels",
                description: "Levels",
                usage: "/levels",
                run() {
                    return {
                        kind: "text",
                        text: JSON.stringify(vera.modelSettings.currentLevels()),
                    };
                },
            });
        }
    `);
    const availableModels = [
        {
            provider: "openai-codex",
            model: "gpt-5.6-sol",
            label: "gpt-5.6-sol",
            description: "",
            levels: [
                { id: "low", label: "Low" },
                { id: "max", label: "Max" },
            ],
            defaultLevel: "low",
        },
        // Not the current model: its levels must not leak into the answer.
        {
            provider: "ollama",
            model: "qwen3",
            label: "qwen3",
            description: "",
            levels: [{ id: "high", label: "High" }],
        },
    ];
    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        preferences: {
            async get() { return undefined; },
            async set() {},
            async delete() {},
        },
        modelSettings: {
            current: () => ({
                provider: "openai-codex",
                model: "gpt-5.6-sol",
                reasoningEffort: "low",
                availableModels,
            }),
            async update(patch) {
                return {
                    status: "accepted",
                    settings: {
                        provider: "openai-codex",
                        model: "gpt-5.6-sol",
                        reasoningEffort: patch.reasoningEffort ?? "low",
                    },
                };
            },
            subscribe: () => () => undefined,
        },
        picker: {
            async request() {
                return { outcome: "cancelled" };
            },
        },
    });

    const result = await registry.invokeCommand("levels", "", workspace);
    expect(JSON.parse((result?.body as { text: string }).text)).toEqual([
        { id: "low", label: "Low" },
        { id: "max", label: "Max" },
    ]);

    await registry.close();
});

test("modelSettings.currentLevels is empty for a model missing from availableModels", async () => {
    const workspace = createDirectory();
    const extension = createExtension("client.no-levels", [
        "client.commands.register",
        "client.model_settings",
    ], `
        export function activateClient(vera) {
            vera.commands.register({
                name: "levels",
                description: "Levels",
                usage: "/levels",
                run() {
                    return {
                        kind: "text",
                        text: JSON.stringify(vera.modelSettings.currentLevels()),
                    };
                },
            });
        }
    `);
    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        preferences: {
            async get() { return undefined; },
            async set() {},
            async delete() {},
        },
        // The default harness-shaped snapshot below carries no
        // `availableModels` at all, the same as a model reached through an
        // escape hatch the client has no facts about.
        modelSettings: {
            current: () => ({
                provider: "openrouter",
                model: "unknown/model",
                reasoningEffort: "low",
            }),
            async update(patch) {
                return {
                    status: "accepted",
                    settings: {
                        provider: "openrouter",
                        model: "unknown/model",
                        reasoningEffort: patch.reasoningEffort ?? "low",
                    },
                };
            },
            subscribe: () => () => undefined,
        },
        picker: {
            async request() {
                return { outcome: "cancelled" };
            },
        },
    });

    const result = await registry.invokeCommand("levels", "", workspace);
    expect(JSON.parse((result?.body as { text: string }).text)).toEqual([]);

    await registry.close();
});

test("bundled reasoning cycle uses the same public seams as a user extension", async () => {
    const extension = join(
        import.meta.dir,
        "../../extensions/reasoning-cycle",
    );
    const availableModels = [
        {
            provider: "openai-codex",
            model: "gpt-5.6-sol",
            label: "gpt-5.6-sol",
            description: "",
            // Most capable first, the order a catalog stores levels in.
            levels: [
                { id: "high", label: "High" },
                { id: "medium", label: "Medium" },
                { id: "low", label: "Low" },
            ],
            defaultLevel: "medium",
        },
        {
            provider: "ollama",
            model: "qwen3",
            label: "qwen3",
            description: "",
            levels: [],
        },
    ];
    let current: VeraClientModelSettingsSnapshot = {
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "low",
        availableModels,
    };
    const updates: unknown[] = [];
    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        preferences: {
            async get() { return undefined; },
            async set() {},
            async delete() {},
        },
        modelSettings: {
            current: () => current,
            async update(patch) {
                updates.push(patch);
                current = {
                    ...current,
                    reasoningEffort: patch.reasoningEffort ?? current.reasoningEffort,
                };
                return { status: "accepted", settings: current };
            },
            subscribe: () => () => undefined,
        },
        picker: {
            async request() {
                return { outcome: "cancelled" };
            },
        },
    });

    expect(registry.keybindings()).toEqual([expect.objectContaining({
        id: "cycle-reasoning",
        keys: ["ctrl+t"],
    })]);

    // Each press asks for more thinking, not less.
    await registry.invokeKeybinding("cycle-reasoning", createDirectory());
    expect(updates).toEqual([{ reasoningEffort: "medium" }]);

    await registry.invokeKeybinding("cycle-reasoning", createDirectory());
    expect(updates[1]).toEqual({ reasoningEffort: "high" });

    // Past the model's top level it wraps back to its lowest.
    await registry.invokeKeybinding("cycle-reasoning", createDirectory());
    expect(updates[2]).toEqual({ reasoningEffort: "low" });

    // A level this model has never heard of does not make the first press
    // jump to the top. Placement runs through the host's shared rule, which
    // puts "ultra" on this model's default of "medium", so one step up from
    // there is "high".
    current = {
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "ultra",
        availableModels,
    };
    await registry.invokeKeybinding("cycle-reasoning", createDirectory());
    expect(updates[3]).toEqual({ reasoningEffort: "high" });

    // A model with no levels at all has nothing to cycle: the same notice
    // text the TUI's own level pane already shows for this case.
    current = {
        provider: "ollama",
        model: "qwen3",
        reasoningEffort: undefined,
        availableModels,
    };
    await expect(
        registry.invokeKeybinding("cycle-reasoning", createDirectory()),
    ).rejects.toThrow("qwen3 has no reasoning effort setting");

    await registry.close();

    const source = readFileSync(join(extension, "extension.ts"), "utf8");
    expect(source).not.toContain("../src");
    expect(source).not.toContain("clients/tui");
});

function createHarness(): {
    readonly adapters: {
        readonly preferences: ClientExtensionPreferencesAdapter;
        readonly modelSettings: ClientExtensionModelSettingsAdapter;
        readonly picker: ClientExtensionPickerAdapter;
    };
    readonly preferences: Map<string, JsonValue>;
    readonly updates: unknown[];
    readonly pickers: unknown[];
    emitSettings(settings: VeraClientModelSettingsSnapshot): void;
    listenerCount(): number;
} {
    const preferences = new Map<string, JsonValue>();
    const updates: unknown[] = [];
    const pickers: unknown[] = [];
    const listeners = new Set<VeraClientModelSettingsListener>();
    const preferencesAdapter: ClientExtensionPreferencesAdapter = {
        async get(namespace, key) {
            return preferences.get(`${namespace}:${key}`);
        },
        async set(namespace, key, value) {
            preferences.set(`${namespace}:${key}`, value);
        },
        async delete(namespace, key) {
            preferences.delete(`${namespace}:${key}`);
        },
    };
    const modelSettings: ClientExtensionModelSettingsAdapter = {
        current() {
            return {
                provider: "openrouter",
                model: "initial",
                reasoningEffort: "low",
            };
        },
        async update(patch) {
            updates.push(patch);
            return {
                status: "accepted",
                settings: {
                    provider: patch.provider,
                    model: patch.model ?? "initial",
                    reasoningEffort: patch.reasoningEffort ?? undefined,
                },
            };
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
    const picker: ClientExtensionPickerAdapter = {
        async request(extensionId, request) {
            pickers.push({ extensionId, request });
            return {
                outcome: "selected",
                rowId: "deep",
                actionId: "apply",
            };
        },
    };
    return {
        adapters: {
            preferences: preferencesAdapter,
            modelSettings,
            picker,
        },
        preferences,
        updates,
        pickers,
        emitSettings(settings) {
            for (const listener of listeners) {
                listener(settings);
            }
        },
        listenerCount: () => listeners.size,
    };
}

function contributionSource(
    command: string,
    keybinding?: string,
    key = "ctrl+k",
): string {
    return `
        export function activateClient(vera) {
            vera.commands.register({
                name: ${JSON.stringify(command)},
                description: "Command",
                usage: "/${command}",
                run() { return { kind: "text", text: "ok" }; },
            });
            ${keybinding === undefined ? "" : `
                vera.keybindings.register({
                    id: ${JSON.stringify(keybinding)},
                    description: "Key",
                    keys: [${JSON.stringify(key)}],
                    run() {},
                });
            `}
        }
    `;
}

function createExtension(
    id: string,
    capabilities: readonly string[],
    source: string,
): string {
    const directory = createDirectory();
    writeFileSync(join(directory, "vera.extension.json"), JSON.stringify({
        id,
        version: "1.0.0",
        sdk: "1",
        entrypoint: "./extension.ts",
        capabilities,
    }));
    writeFileSync(join(directory, "extension.ts"), source);
    return directory;
}

function configured(
    path: string,
    config: JsonValue = null,
): ClientExtensionConfig {
    return { path, enabled: true, config };
}

function createDirectory(): string {
    const directory = join(
        tmpdir(),
        `vera-client-extension-${crypto.randomUUID()}`,
    );
    mkdirSync(directory);
    temporaryDirectories.push(directory);
    return directory;
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) {
            return;
        }
        await Bun.sleep(5);
    }
    throw new Error("condition was not reached");
}
