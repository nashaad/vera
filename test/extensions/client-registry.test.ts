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
    type ClientExtensionNoticeAdapter,
    type ClientExtensionPickerAdapter,
    type ClientExtensionPreferencesAdapter,
    type ClientExtensionRegistryFailure,
} from "../../src/extensions/client-registry.ts";
import type { StatusLineSnapshot } from "../../src/extensions/status-line.ts";

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
                        subtitle: "Choose one",
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
            subtitle: "Choose one",
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

test("client picker rejects a non-string subtitle", async () => {
    const extension = createExtension(
        "client.invalid-subtitle",
        ["client.commands.register", "client.ui.picker"],
        `
            export function activateClient(vera) {
                vera.commands.register({
                    name: "pick",
                    description: "Pick",
                    usage: "/pick",
                    async run() {
                        await vera.ui.requestPicker({
                            title: "Models",
                            subtitle: 42,
                            rows: [{ id: "one", label: "One" }],
                            actions: [{ id: "apply", label: "Apply", keys: ["enter"] }],
                        });
                        return { kind: "text", text: "unreachable" };
                    },
                });
            }
        `,
    );
    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        ...createHarness().adapters,
    });

    await expect(registry.invokeCommand(
        "pick",
        "",
        createDirectory(),
    )).rejects.toThrow("Invalid client extension picker request");
    await registry.close();
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
        notice: { post() {} },
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
        notice: { post() {} },
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
        notice: { post() {} },
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
        notice: { post() {} },
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
        readonly notice: ClientExtensionNoticeAdapter;
    };
    readonly preferences: Map<string, JsonValue>;
    readonly updates: unknown[];
    readonly pickers: unknown[];
    readonly notices: unknown[];
    emitSettings(settings: VeraClientModelSettingsSnapshot): void;
    listenerCount(): number;
} {
    const preferences = new Map<string, JsonValue>();
    const updates: unknown[] = [];
    const pickers: unknown[] = [];
    const notices: unknown[] = [];
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
    const notice: ClientExtensionNoticeAdapter = {
        post(extensionId, text) {
            notices.push({ extensionId, text });
        },
    };
    return {
        adapters: {
            preferences: preferencesAdapter,
            modelSettings,
            picker,
            notice,
        },
        preferences,
        updates,
        pickers,
        notices,
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

const SNAPSHOT: StatusLineSnapshot = {
    version: 1,
    turn: "working",
    workspace: "/workspace",
    runningBackgroundAgents: 2,
    model: { provider: "openrouter", model: "glm-5.2", reasoningEffort: "max" },
    approvalMode: "auto",
    context: { tokens: 100, capacity: 400, estimated: true },
};

test("a status line renderer answers the repaint with semantic segments", async () => {
    const extension = createExtension(
        "client.status",
        ["client.status_line"],
        `
            export function activateClient(vera) {
                vera.statusLine.register({
                    render(snapshot) {
                        return [
                            { kind: "turn", state: snapshot.turn },
                            {
                                kind: "background_agents",
                                running: snapshot.runningBackgroundAgents,
                            },
                            { kind: "model", model: snapshot.model.model },
                        ];
                    },
                });
            }
        `,
    );
    const harness = createHarness();
    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        ...harness.adapters,
    });

    expect(registry.statusLineOwner()).toBe("client.status");
    expect(registry.renderStatusLine(SNAPSHOT)).toEqual([
        { kind: "turn", state: "working" },
        { kind: "background_agents", running: 2 },
        { kind: "model", model: "glm-5.2" },
    ]);
    await registry.close();
});

test("a failing status line renderer falls back and is retired after three strikes", async () => {
    const extension = createExtension(
        "client.status-broken",
        ["client.status_line"],
        `
            let calls = 0;
            export function activateClient(vera) {
                vera.statusLine.register({
                    render() {
                        calls += 1;
                        if (calls === 1) {
                            throw new Error("no status for you");
                        }
                        if (calls === 2) {
                            return [{ kind: "wat", text: "hello" }];
                        }
                        return Promise.resolve([]);
                    },
                });
            }
        `,
    );
    const failures: ClientExtensionRegistryFailure[] = [];
    const harness = createHarness();
    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        onFailure: (failure) => failures.push(failure),
        ...harness.adapters,
    });

    // Throwing, garbage, and a promise are all the same answer to a repaint:
    // nothing usable, so the client renders the status line itself.
    expect(registry.renderStatusLine(SNAPSHOT)).toBeUndefined();
    expect(registry.renderStatusLine(SNAPSHOT)).toBeUndefined();
    expect(registry.renderStatusLine(SNAPSHOT)).toBeUndefined();
    expect(registry.statusLineOwner()).toBeUndefined();
    expect(registry.renderStatusLine(SNAPSHOT)).toBeUndefined();
    expect(failures).toHaveLength(3);
    expect(failures[0]?.message).toContain("no status for you");
    expect(failures[2]?.message).toContain("handed back to the client");
    await registry.close();
});

test("a slow status line renderer is retired rather than left in the repaint", async () => {
    const extension = createExtension(
        "client.status-slow",
        ["client.status_line"],
        `
            export function activateClient(vera) {
                vera.statusLine.register({
                    render() {
                        const until = Date.now() + 20;
                        while (Date.now() < until) {}
                        return [{ kind: "free_note", text: "late" }];
                    },
                });
            }
        `,
    );
    const failures: ClientExtensionRegistryFailure[] = [];
    const harness = createHarness();
    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        statusLineBudgetMs: 1,
        onFailure: (failure) => failures.push(failure),
        ...harness.adapters,
    });

    expect(registry.renderStatusLine(SNAPSHOT)).toBeUndefined();
    expect(failures[0]?.message).toContain("budget");
    await registry.close();
});

test("only one extension owns the status line", async () => {
    const source = `
        export function activateClient(vera) {
            vera.statusLine.register({
                render: () => [{ kind: "free_note", text: "mine" }],
            });
        }
    `;
    const first = createExtension(
        "client.status-first",
        ["client.status_line"],
        source,
    );
    const second = createExtension(
        "client.status-second",
        ["client.status_line"],
        source,
    );
    const failures: ClientExtensionRegistryFailure[] = [];
    const harness = createHarness();
    const registry = await startClientExtensionRegistry({
        extensions: [configured(first), configured(second)],
        onFailure: (failure) => failures.push(failure),
        ...harness.adapters,
    });

    expect(registry.statusLineOwner()).toBe("client.status-first");
    expect(failures[0]?.message).toContain(
        "status line from client.status-second collides with client.status-first",
    );
    await registry.close();
});

test("a status line renderer needs the declared capability", async () => {
    const extension = createExtension(
        "client.status-undeclared",
        ["client.commands.register"],
        `
            export function activateClient(vera) {
                vera.statusLine.register({ render: () => [] });
            }
        `,
    );
    const failures: ClientExtensionRegistryFailure[] = [];
    const harness = createHarness();
    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        onFailure: (failure) => failures.push(failure),
        ...harness.adapters,
    });

    expect(registry.statusLineOwner()).toBeUndefined();
    expect(registry.renderStatusLine(SNAPSHOT)).toBeUndefined();
    expect(failures[0]?.message).toContain("did not declare client.status_line");
    await registry.close();
});

test("preset cycling walks slots, not models, so a duplicate does not stick", async () => {
    const extension = join(import.meta.dir, "../../extensions/model-presets");
    const preferences = new Map<string, JsonValue>();
    // Nash's real layout: slot 3 and slot 4 hold the same preset. Matching the
    // current model against the slots answers slot 3 both times, which is what
    // pinned the cycle there and stopped it ever reaching slot 1 again.
    const slots = [
        { provider: "openrouter", model: "z-ai/glm-5.2", reasoningEffort: "max" },
        {
            provider: "openrouter",
            model: "deepseek/deepseek-v4-pro",
            reasoningEffort: "max",
        },
        { provider: "openrouter", model: "moonshotai/kimi-k3", reasoningEffort: "low" },
        { provider: "openrouter", model: "moonshotai/kimi-k3", reasoningEffort: "low" },
    ];
    preferences.set("vera.model-presets:slots", slots);
    preferences.set("vera.model-presets:current-slot", 2);
    let settings = { ...slots[2]! };
    let pickerRequests = 0;

    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        notice: { post() {} },
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
            current: () => settings,
            async update(patch) {
                settings = {
                    provider: patch.provider!,
                    model: patch.model!,
                    reasoningEffort: patch.reasoningEffort!,
                };
                return { status: "accepted", settings };
            },
            subscribe: () => () => undefined,
        },
        picker: {
            async request() {
                pickerRequests += 1;
                return { outcome: "cancelled" };
            },
        },
    });

    const workspace = createDirectory();
    const cycle = async () => {
        await registry.invokeKeybinding("cycle-preset", workspace);
        return `${settings.model} · ${settings.reasoningEffort}`;
    };

    // Four presses from slot 3 visit slot 4, wrap to slot 1, and come back.
    expect(await cycle()).toBe("moonshotai/kimi-k3 · low");
    expect(preferences.get("vera.model-presets:current-slot")).toBe(3);
    expect(await cycle()).toBe("z-ai/glm-5.2 · max");
    expect(await cycle()).toBe("deepseek/deepseek-v4-pro · max");
    expect(await cycle()).toBe("moonshotai/kimi-k3 · low");
    expect(preferences.get("vera.model-presets:current-slot")).toBe(2);

    // The model picker changes the model without telling this extension, so the
    // remembered slot stops matching and the value lookup takes over.
    settings = { ...slots[0]! };
    expect(await cycle()).toBe("deepseek/deepseek-v4-pro · max");

    expect(pickerRequests).toBe(0);
    await registry.close();
});

test("cycling with nothing to cycle to shows the slots instead of doing nothing", async () => {
    const extension = join(import.meta.dir, "../../extensions/model-presets");
    const preferences = new Map<string, JsonValue>();
    const only = {
        provider: "openrouter",
        model: "moonshotai/kimi-k3",
        reasoningEffort: "low",
    };
    preferences.set("vera.model-presets:slots", [only, null, null, null]);
    let pickerRequests = 0;

    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        notice: { post() {} },
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
            current: () => only,
            async update() {
                throw new Error("cycling had nowhere to go and applied a preset");
            },
            subscribe: () => () => undefined,
        },
        picker: {
            async request() {
                pickerRequests += 1;
                return { outcome: "cancelled" };
            },
        },
    });

    const workspace = createDirectory();
    // One filled slot that is already current, and then none at all. A
    // keybinding cannot put a line on screen, so the slots are the answer.
    await registry.invokeKeybinding("cycle-preset", workspace);
    preferences.set("vera.model-presets:slots", [null, null, null, null]);
    await registry.invokeKeybinding("cycle-preset", workspace);
    expect(pickerRequests).toBe(2);
    await registry.close();
});

test("ui.notice posts one transcript line, and refuses an empty one", async () => {
    const workspace = createDirectory();
    const extension = createExtension("client.talker", [
        "client.commands.register",
        "client.ui.notice",
    ], `
        export function activateClient(vera) {
            vera.commands.register({
                name: "say",
                description: "Say",
                usage: "/say",
                run({ argumentsText }) {
                    vera.ui.notice(argumentsText);
                    return { kind: "text", text: "said" };
                },
            });
        }
    `);
    const harness = createHarness();
    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        ...harness.adapters,
    });

    await registry.invokeCommand("say", "  preset 1: kimi-k3 · medium  ", workspace);
    expect(harness.notices).toEqual([{
        extensionId: "client.talker",
        text: "preset 1: kimi-k3 · medium",
    }]);
    await expect(registry.invokeCommand("say", "", workspace))
        .rejects.toThrow("notice text must not be empty");

    await registry.close();
});

test("ui.notice needs its own capability", async () => {
    const workspace = createDirectory();
    const extension = createExtension("client.quiet", [
        "client.commands.register",
    ], `
        export function activateClient(vera) {
            vera.commands.register({
                name: "say",
                description: "Say",
                usage: "/say",
                run() {
                    vera.ui.notice("hello");
                    return { kind: "text", text: "said" };
                },
            });
        }
    `);
    const harness = createHarness();
    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        ...harness.adapters,
    });

    await expect(registry.invokeCommand("say", "", workspace))
        .rejects.toThrow("client.ui.notice");
    expect(harness.notices).toEqual([]);
    await registry.close();
});

test("modelSettings.availability answers runnable, pooled and verified", async () => {
    const workspace = createDirectory();
    const extension = createExtension("client.availability", [
        "client.commands.register",
        "client.model_settings",
    ], `
        export function activateClient(vera) {
            vera.commands.register({
                name: "check",
                description: "Check",
                usage: "/check",
                run() {
                    return {
                        kind: "text",
                        text: JSON.stringify({
                            offered: vera.modelSettings.availability({
                                provider: "openrouter",
                                model: "moonshotai/kimi-k3",
                            }),
                            pooledOnly: vera.modelSettings.availability({
                                provider: "openai-codex",
                                model: "gpt-5.6-sol",
                            }),
                            gone: vera.modelSettings.availability({
                                model: "nothing/here",
                            }),
                        }),
                    };
                },
            });
        }
    `);
    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        notice: { post() {} },
        preferences: {
            async get() { return undefined; },
            async set() {},
            async delete() {},
        },
        modelSettings: {
            current: () => ({
                provider: "openrouter",
                model: "moonshotai/kimi-k3",
                availableModels: [{
                    provider: "openrouter",
                    model: "moonshotai/kimi-k3",
                    label: "Kimi K3",
                    description: "",
                    levels: [],
                }],
                pooled: [{
                    provider: "openai-codex",
                    model: "gpt-5.6-sol",
                    label: "GPT-5.6-Sol",
                    available: false,
                    verified: true,
                    levels: [],
                }],
            }),
            async update() {
                return { status: "rejected", reason: "invalid" };
            },
            subscribe: () => () => undefined,
        },
        picker: {
            async request() {
                return { outcome: "cancelled" };
            },
        },
    });

    const result = await registry.invokeCommand("check", "", workspace);
    expect(JSON.parse((result?.body as { text: string }).text)).toEqual({
        offered: { runnable: true, pooled: false, verified: false },
        // In the pool, probed, and still not runnable: the provider is not
        // offering it right now, so a switch to it would not land.
        pooledOnly: { runnable: false, pooled: true, verified: true },
        gone: { runnable: false, pooled: false, verified: false },
    });

    await registry.close();
});

test("the preset cycle names the slot it lands on and steps over dead slots", async () => {
    const extension = join(
        import.meta.dir,
        "../../extensions/model-presets",
    );
    const preferences = new Map<string, JsonValue>([[
        "vera.model-presets:slots",
        [
            { provider: "openrouter", model: "kimi-k3", reasoningEffort: "low" },
            { provider: "openrouter", model: "gone", reasoningEffort: "high" },
            { provider: "openrouter", model: "glm-5.2", reasoningEffort: "medium" },
            null,
        ],
    ]]);
    const updates: unknown[] = [];
    const notices: string[] = [];
    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        notice: {
            post(_extensionId, text) {
                notices.push(text);
            },
        },
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
                model: "kimi-k3",
                reasoningEffort: "low",
                availableModels: [
                    {
                        provider: "openrouter",
                        model: "kimi-k3",
                        label: "Kimi K3",
                        description: "",
                        levels: [],
                    },
                    {
                        provider: "openrouter",
                        model: "glm-5.2",
                        label: "GLM-5.2",
                        description: "",
                        levels: [],
                    },
                ],
            }),
            async update(patch) {
                updates.push(patch);
                return {
                    status: "accepted",
                    settings: {
                        provider: "openrouter",
                        model: patch.model ?? "kimi-k3",
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

    // Slot 2 holds a model no provider is offering, so the cycle goes past it
    // to slot 3. Slot 2 keeps its preset: the provider may come back.
    await registry.invokeKeybinding("cycle-preset", createDirectory());
    expect(updates).toEqual([{
        provider: "openrouter",
        model: "glm-5.2",
        reasoningEffort: "medium",
    }]);
    expect(notices).toEqual(["preset 3: glm-5.2 · medium"]);
    expect((preferences.get("vera.model-presets:slots") as unknown[])[1])
        .toEqual({
            provider: "openrouter",
            model: "gone",
            reasoningEffort: "high",
        });

    await registry.close();
});

/**
 * The pool as the extension sees it: one named entry and one plain one, both
 * offered by a connected provider so availability answers runnable.
 */
function poolWithFrosty(
    frosty: { readonly provider: string; readonly model: string },
): Pick<VeraClientModelSettingsSnapshot, "availableModels" | "pooled"> {
    const models = [
        { ...frosty, poolName: "frosty" },
        { provider: "openrouter", model: "kimi-k3", poolName: undefined },
    ];
    return {
        availableModels: models.map((entry) => ({
            provider: entry.provider,
            model: entry.model,
            label: entry.model,
            description: "",
            levels: [],
        })),
        pooled: models.map((entry) => ({
            provider: entry.provider,
            model: entry.model,
            label: entry.model,
            ...(entry.poolName === undefined
                ? {}
                : { poolName: entry.poolName }),
            available: true,
            verified: true,
            levels: [],
        })),
    };
}

test("a preset holding a pool name resolves through the pool on every use", async () => {
    const extension = join(import.meta.dir, "../../extensions/model-presets");
    const preferences = new Map<string, JsonValue>([[
        "vera.model-presets:slots",
        [
            { name: "frosty", reasoningEffort: "high" },
            // Saved by an earlier build, in the id form and with the disk
            // spelling of the effort. It has to keep working.
            { provider: "openrouter", model: "kimi-k3", reasoning_effort: "low" },
            null,
            null,
        ],
    ]]);
    const updates: unknown[] = [];
    const notices: string[] = [];
    let frosty = { provider: "ollama", model: "qwen3:1.7b" };
    let settings: VeraClientModelSettingsSnapshot = {
        provider: "openrouter",
        model: "kimi-k3",
        reasoningEffort: "low",
        ...poolWithFrosty(frosty),
    };
    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        notice: {
            post(_extensionId, text) {
                notices.push(text);
            },
        },
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
            current: () => settings,
            async update(patch) {
                updates.push(patch);
                settings = {
                    provider: patch.provider!,
                    model: patch.model!,
                    reasoningEffort: patch.reasoningEffort!,
                    ...poolWithFrosty(frosty),
                };
                return { status: "accepted", settings };
            },
            subscribe: () => () => undefined,
        },
        picker: {
            async request() {
                return { outcome: "cancelled" };
            },
        },
    });

    const workspace = createDirectory();
    await registry.invokeKeybinding("cycle-preset", workspace);
    expect(updates).toEqual([{
        provider: "ollama",
        model: "qwen3:1.7b",
        reasoningEffort: "high",
    }]);
    expect(notices).toEqual(["preset 1: frosty · high"]);

    // The name is pointed at another entry. The slot follows it, which is the
    // reason it stores the name rather than the id the name resolved to.
    frosty = { provider: "ollama", model: "qwen3:8b" };
    settings = { ...settings, ...poolWithFrosty(frosty) };
    await registry.invokeKeybinding("cycle-preset", workspace);
    await registry.invokeKeybinding("cycle-preset", workspace);
    expect(updates.slice(1)).toEqual([
        // The model stopped matching the slot it came from, so the cycle
        // restarts at slot 1, which now stands for a different model.
        { provider: "ollama", model: "qwen3:8b", reasoningEffort: "high" },
        { provider: "openrouter", model: "kimi-k3", reasoningEffort: "low" },
    ]);

    await registry.close();
});

test("a preset whose pool name is gone reads as stale and refuses to apply", async () => {
    const extension = join(import.meta.dir, "../../extensions/model-presets");
    const preferences = new Map<string, JsonValue>([[
        "vera.model-presets:slots",
        [
            { name: "frosty", reasoningEffort: "high" },
            { provider: "openrouter", model: "kimi-k3", reasoningEffort: "low" },
            { provider: "openrouter", model: "kimi-k3", reasoningEffort: "high" },
            null,
        ],
    ]]);
    const updates: unknown[] = [];
    const notices: string[] = [];
    const requests: VeraClientPickerRequest[] = [];
    const results: VeraClientPickerResult[] = [
        { outcome: "selected", rowId: "slot-1", actionId: "choose" },
    ];
    let index = 0;
    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        notice: {
            post(_extensionId, text) {
                notices.push(text);
            },
        },
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
            // The pool still runs kimi-k3, but nothing in it is named frosty
            // now: the name was taken away, or two entries claim it.
            current: () => ({
                provider: "openrouter",
                model: "kimi-k3",
                reasoningEffort: "low",
                availableModels: poolWithFrosty({
                    provider: "ollama",
                    model: "qwen3:1.7b",
                }).availableModels,
                pooled: [],
            }),
            async update(patch) {
                updates.push(patch);
                return {
                    status: "accepted",
                    settings: {
                        provider: patch.provider!,
                        model: patch.model!,
                        reasoningEffort: patch.reasoningEffort!,
                    },
                };
            },
            subscribe: () => () => undefined,
        },
        picker: {
            async request(_extensionId, request) {
                requests.push(request);
                return results[index++] ?? { outcome: "cancelled" };
            },
        },
    });

    const workspace = createDirectory();
    await registry.invokeCommand("preset", "", workspace);
    expect(requests[0]?.rows[0]?.description).toBe("frosty · high · stale name");
    // Enter on the stale slot has to say so. Leaving the model where it is
    // without a word would read as the key having done nothing.
    expect(updates).toEqual([]);
    expect(notices).toEqual(["preset 1: no pooled model named frosty"]);

    // The cycle steps over it to the next slot that can still be applied.
    await registry.invokeKeybinding("cycle-preset", workspace);
    expect(updates).toEqual([{
        provider: "openrouter",
        model: "kimi-k3",
        reasoningEffort: "high",
    }]);
    // Stale is not a reason to lose the slot: the name may come back.
    expect((preferences.get("vera.model-presets:slots") as unknown[])[0])
        .toEqual({ name: "frosty", reasoningEffort: "high" });

    await registry.close();
});

test("saving the model you are on stores its pool name when it has one", async () => {
    const saved = await saveCurrentIntoFirstSlot({
        provider: "ollama",
        model: "qwen3:1.7b",
        reasoningEffort: "high",
        ...poolWithFrosty({ provider: "ollama", model: "qwen3:1.7b" }),
    });

    expect(saved).toEqual({ name: "frosty", reasoningEffort: "high" });
});

test("saving an unnamed model stores the id, since there is no name to keep", async () => {
    const saved = await saveCurrentIntoFirstSlot({
        provider: "openrouter",
        model: "kimi-k3",
        reasoningEffort: "low",
        ...poolWithFrosty({ provider: "ollama", model: "qwen3:1.7b" }),
    });

    expect(saved).toEqual({
        provider: "openrouter",
        model: "kimi-k3",
        reasoningEffort: "low",
    });
});

/** Opens the preset picker, saves into slot 1, and returns what was stored. */
async function saveCurrentIntoFirstSlot(
    current: VeraClientModelSettingsSnapshot,
): Promise<unknown> {
    const extension = join(import.meta.dir, "../../extensions/model-presets");
    const preferences = new Map<string, JsonValue>();
    const results: VeraClientPickerResult[] = [
        { outcome: "selected", rowId: "slot-1", actionId: "save" },
        { outcome: "cancelled" },
    ];
    let index = 0;
    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        notice: { post() {} },
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
            current: () => current,
            async update() {
                throw new Error("saving a preset changed the model");
            },
            subscribe: () => () => undefined,
        },
        picker: {
            async request() {
                return results[index++] ?? { outcome: "cancelled" };
            },
        },
    });

    await registry.invokeCommand("preset", "", createDirectory());
    await registry.close();
    return (preferences.get("vera.model-presets:slots") as unknown[])[0];
}
