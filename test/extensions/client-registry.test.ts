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
    VeraClientOneshotRequest,
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
    type ClientExtensionAgentsAdapter,
    type ClientExtensionExperimentalTuiAdapter,
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

test("compose suggesters preserve their current-agent scope", async () => {
    const extension = createExtension(
        "client.compose-scope",
        ["client.compose.suggester"],
        `
            export function activateClient(vera) {
                vera.compose.registerSuggester({
                    agent: "plan",
                    hint: "Create a plan?",
                    fromAgents: [" default ", "reviewer", "default"],
                    match: (text) => text.includes("plan"),
                });
            }
        `,
    );
    const harness = createHarness();
    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        ...harness.adapters,
    });

    expect(registry.composeSuggesters()).toHaveLength(1);
    expect(registry.composeSuggesters()[0]).toMatchObject({
        id: "plan",
        agent: "plan",
        hint: "Create a plan?",
        fromAgents: ["default", "reviewer"],
    });
    expect(registry.composeSuggesters()[0]?.matches("make a plan")).toBe(true);
    await registry.close();
});

test("composer writes stay bound to the invoking command and keybinding", async () => {
    const extension = createExtension(
        "client.compose-write",
        [
            "client.commands.register",
            "client.keybindings.register",
            "client.compose.write",
            "client.ui.notice",
        ],
        `
            export function activateClient(vera) {
                vera.commands.register({
                    name: "compose",
                    description: "Write into the composer",
                    usage: "/compose",
                    async run() {
                        const inserted = vera.compose.insert("command text");
                        await Promise.resolve();
                        const focused = vera.compose.focus();
                        setTimeout(() => {
                            vera.ui.notice(JSON.stringify(
                                vera.compose.insert("too late")
                            ));
                        }, 0);
                        return {
                            kind: "text",
                            text: JSON.stringify({ inserted, focused }),
                        };
                    },
                });
                vera.keybindings.register({
                    id: "compose-key",
                    description: "Write from a chord",
                    keys: ["ctrl+j"],
                    run() { vera.compose.insert("key text"); },
                });
            }
        `,
    );
    const harness = createHarness();
    const targets = [{ name: "command" }, { name: "key" }];
    const writes: unknown[] = [];
    let captures = 0;
    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        ...harness.adapters,
        compose: {
            capture(extensionId) {
                expect(extensionId).toBe("client.compose-write");
                return targets[captures++];
            },
            insert(extensionId, target, text) {
                writes.push({ extensionId, target, text });
                return { status: "accepted" };
            },
            focus(extensionId, target) {
                expect({ extensionId, target }).toEqual({
                    extensionId: "client.compose-write",
                    target: targets[0]!,
                });
                return { status: "ineligible" };
            },
        },
    });

    const result = await registry.invokeCommand("compose", "", "/tmp");
    expect(JSON.parse((result?.body as { text: string }).text)).toEqual({
        inserted: { status: "accepted" },
        focused: { status: "ineligible" },
    });
    await registry.invokeKeybinding("compose-key", "/tmp");
    await waitFor(() => harness.notices.length === 1);

    expect(writes).toEqual([
        {
            extensionId: "client.compose-write",
            target: targets[0],
            text: "command text",
        },
        {
            extensionId: "client.compose-write",
            target: targets[1],
            text: "key text",
        },
    ]);
    expect(harness.notices).toEqual([{
        extensionId: "client.compose-write",
        text: JSON.stringify({ status: "stale" }),
    }]);
    await registry.close();
});

test("composer writes require their declared capability", async () => {
    const extension = createExtension(
        "client.compose-undeclared",
        ["client.commands.register"],
        `
            export function activateClient(vera) {
                vera.commands.register({
                    name: "compose",
                    description: "Write into the composer",
                    usage: "/compose",
                    run() { vera.compose.insert("no"); },
                });
            }
        `,
    );
    const harness = createHarness();
    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        ...harness.adapters,
        compose: {
            capture: () => ({}),
            insert: () => ({ status: "accepted" }),
            focus: () => ({ status: "accepted" }),
        },
    });

    await expect(registry.invokeCommand("compose", "", "/tmp")).rejects.toThrow(
        "did not declare client.compose.write",
    );
    await registry.close();
});

test("compose suggesters require distinct dismissal identities", async () => {
    const extension = createExtension(
        "client.compose-duplicate",
        ["client.compose.suggester"],
        `
            export function activateClient(vera) {
                for (const hint of ["Plan?", "Strategy?"]) {
                    vera.compose.registerSuggester({
                        agent: "plan",
                        hint,
                        match: () => true,
                    });
                }
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

    expect(registry.composeSuggesters()).toEqual([]);
    expect(failures[0]?.message).toContain(
        "Duplicate client extension compose suggester: plan",
    );
    await registry.close();
});

test("compose suggesters reject an empty current-agent scope", async () => {
    const extension = createExtension(
        "client.compose-empty-scope",
        ["client.compose.suggester"],
        `
            export function activateClient(vera) {
                vera.compose.registerSuggester({
                    agent: "plan",
                    hint: "Create a plan?",
                    fromAgents: [],
                    match: () => true,
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

    expect(registry.composeSuggesters()).toEqual([]);
    expect(failures[0]?.message).toContain(
        "Invalid client extension compose suggester registration",
    );
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
        keys: ["ctrl+y"],
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

test("an extension can create, open, and message hosted agents through the client", async () => {
    const extension = createExtension("client.agents", [
        "client.commands.register",
        "client.agents",
    ], `
        export function activateClient(vera) {
            vera.commands.register({
                name: "delegate",
                description: "Delegate",
                usage: "/delegate <message>",
                async run({ argumentsText, signal }) {
                    const created = await vera.agents.create({
                        pane: "sidebar",
                        approvalMode: "readonly",
                    }, signal);
                    await vera.agents.open({
                        agentId: created.agentId,
                        pane: "main",
                    }, signal);
                    await vera.agents.message({
                        agentId: created.agentId,
                        text: argumentsText,
                    }, signal);
                },
            });
        }
    `);
    const calls: unknown[] = [];
    const agents: ClientExtensionAgentsAdapter = {
        visible(extensionId) {
            calls.push({ operation: "visible", extensionId });
            return [{ agentId: "agent-1", pane: "main" }];
        },
        async create(extensionId, request) {
            calls.push({ operation: "create", extensionId, request });
            return { agentId: "agent-2" };
        },
        async open(extensionId, request) {
            calls.push({ operation: "open", extensionId, request });
        },
        async message(extensionId, request) {
            calls.push({ operation: "message", extensionId, request });
        },
    };
    const harness = createHarness();
    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        ...harness.adapters,
        agents,
    });

    await registry.invokeCommand("delegate", " inspect this ", "/workspace");
    expect(calls).toEqual([
        {
            operation: "create",
            extensionId: "client.agents",
            request: { pane: "sidebar", approvalMode: "readonly" },
        },
        {
            operation: "open",
            extensionId: "client.agents",
            request: { agentId: "agent-2", pane: "main" },
        },
        {
            operation: "message",
            extensionId: "client.agents",
            request: { agentId: "agent-2", text: "inspect this" },
        },
    ]);
    await registry.close();
});

test("experimental hosted-agent addressing is validated and remains plain data", async () => {
    const extension = createExtension("client.addressing", [
        "client.agents",
    ], `
        export function activateClient(vera) {
            vera.agents.declareExperimentalAddressing({
                primary: "author",
                secondary: "critic",
            });
        }
    `);
    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        ...createHarness().adapters,
        agents: {
            visible: () => [],
            async create() { return { agentId: "created" }; },
            async open() {},
            async message() {},
        },
    });

    expect(registry.experimentalHostedAgentAddressing("client.addressing"))
        .toEqual({ primary: "author", secondary: "critic" });
    const returned = registry.experimentalHostedAgentAddressing(
        "client.addressing",
    ) as { primary: string; secondary: string };
    returned.primary = "mutated";
    expect(registry.experimentalHostedAgentAddressing("client.addressing"))
        .toEqual({ primary: "author", secondary: "critic" });
    await registry.close();
});

test("experimental hosted-agent addressing rejects collisions and ambiguity", async () => {
    const invalid = [
        { primary: "same", secondary: "same" },
        { primary: "has space", secondary: "critic" },
        { primary: "@author", secondary: "critic" },
        { primary: "all", secondary: "critic" },
        { primary: "author", secondary: "critic", broadcast: "critic" },
    ];
    const failures: ClientExtensionRegistryFailure[] = [];
    for (const [index, addressing] of invalid.entries()) {
        const extension = createExtension(`client.invalid-address-${index}`, [
            "client.agents",
        ], `
            export function activateClient(vera) {
                vera.agents.declareExperimentalAddressing(${JSON.stringify(addressing)});
            }
        `);
        const registry = await startClientExtensionRegistry({
            extensions: [configured(extension)],
            ...createHarness().adapters,
            agents: {
                visible: () => [],
                async create() { return { agentId: "created" }; },
                async open() {},
                async message() {},
            },
            onFailure(failure) {
                failures.push(failure);
            },
        });
        expect(registry.experimentalHostedAgentAddressing(
            `client.invalid-address-${index}`,
        )).toBeUndefined();
        await registry.close();
    }
    expect(failures).toHaveLength(invalid.length);
});

test("experimental TUI views and event subscriptions clean up with the extension", async () => {
    const extension = createExtension("client.tui", [
        "client.experimental_tui",
    ], `
        export function activateClient(vera) {
            vera.experimentalTui.events.on("conversation_changed", () => {});
            vera.experimentalTui.events.on("transcript_changed", () => {});
            vera.experimentalTui.mount({
                id: "panel",
                slot: "footer",
                focusable: true,
                render: ({ theme }) => ({
                    kind: "stack",
                    direction: "column",
                    children: [
                        { kind: "text", text: "hello", tone: "accent" },
                        { kind: "button", label: "Open", action: "open" },
                    ],
                }),
                keybindings: [{ keys: ["ctrl+shift+o"], action: "open" }],
            });
            vera.experimentalTui.mountRenderable({
                id: "raw-panel",
                slot: "footer",
                create() { return {}; },
            });
        }
    `);
    const mounted: { extensionId: string; id: string }[] = [];
    const disposed: string[] = [];
    const subscriptions: string[] = [];
    const experimentalTui: ClientExtensionExperimentalTuiAdapter = {
        mount(extensionId, spec) {
            mounted.push({ extensionId, id: spec.id });
            return async () => {
                disposed.push(`${extensionId}:${spec.id}`);
            };
        },
        mountRenderable(extensionId, spec) {
            mounted.push({ extensionId, id: spec.id });
            return async () => {
                disposed.push(`${extensionId}:${spec.id}`);
            };
        },
        events: {
            on(_extensionId: string, ...args: any[]) {
                subscriptions.push(String(args[0]));
                return async () => {
                    subscriptions.push(`disposed:${String(args[0])}`);
                };
            },
        },
        agentSurface: {
            current() { return undefined; },
            cycleLayout() { return false; },
            toggleFocus() { return false; },
        },
    };
    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        ...createHarness().adapters,
        experimentalTui,
    });

    expect(mounted).toEqual([
        { extensionId: "client.tui", id: "panel" },
        { extensionId: "client.tui", id: "raw-panel" },
    ]);
    expect(subscriptions).toEqual([
        "conversation_changed",
        "transcript_changed",
    ]);
    await registry.close();
    expect(disposed).toEqual([
        "client.tui:raw-panel",
        "client.tui:panel",
    ]);
    expect(subscriptions).toEqual([
        "conversation_changed",
        "transcript_changed",
        "disposed:transcript_changed",
        "disposed:conversation_changed",
    ]);
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

test("a message interceptor sees submitted messages and can replace or handle them", async () => {
    const extension = createExtension("client.seats", [
        "client.messages.intercept",
    ], `
        export function activateClient(vera) {
            vera.messages.intercept((message) => {
                if (message.text.startsWith("@all ")) {
                    return { kind: "handled" };
                }
                if (message.text.startsWith("@m1 ")) {
                    return {
                        kind: "replace",
                        text: message.text.slice("@m1 ".length),
                    };
                }
                return undefined;
            });
        }
    `);
    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        ...createHarness().adapters,
    });

    expect(registry.hasMessageInterceptors()).toBe(true);
    const outgoing = { workspace: "/tmp/workspace", imageCount: 0 };
    expect(await registry.interceptMessage({ ...outgoing, text: "@all hello" }))
        .toEqual({ kind: "handled" });
    expect(await registry.interceptMessage({ ...outgoing, text: "@m1 hello" }))
        .toEqual({ kind: "replace", text: "hello" });
    // Returning nothing must not swallow the message.
    expect(await registry.interceptMessage({ ...outgoing, text: "hello" }))
        .toEqual({ kind: "pass" });
    await registry.close();
});

test("a failing message interceptor passes the message through", async () => {
    const extension = createExtension("client.broken", [
        "client.messages.intercept",
    ], `
        export function activateClient(vera) {
            vera.messages.intercept(() => {
                throw new Error("interceptor exploded");
            });
        }
    `);
    const failures: ClientExtensionRegistryFailure[] = [];
    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        ...createHarness().adapters,
        onFailure: (failure) => failures.push(failure),
    });

    expect(await registry.interceptMessage({
        text: "hello",
        workspace: "/tmp/workspace",
        imageCount: 0,
    })).toEqual({ kind: "pass" });
    expect(failures.map((failure) => failure.extensionId)).toEqual([
        "client.broken",
    ]);
    await registry.close();
});

test("intercepting messages requires the capability", async () => {
    const extension = createExtension("client.undeclared", [
        "client.ui.notice",
    ], `
        export function activateClient(vera) {
            vera.messages.intercept(() => undefined);
        }
    `);
    const failures: ClientExtensionRegistryFailure[] = [];
    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        ...createHarness().adapters,
        onFailure: (failure) => failures.push(failure),
    });

    expect(registry.hasMessageInterceptors()).toBe(false);
    expect(failures[0]?.message).toContain("client.messages.intercept");
    await registry.close();
});

test("a oneshot reaches the client adapter and returns the named model's answer", async () => {
    const extension = createExtension("client.seat", [
        "client.oneshot",
        "client.ui.notice",
        "client.commands.register",
    ], `
        export function activateClient(vera) {
            vera.commands.register({
                name: "ask",
                description: "ask the second seat",
                usage: "/ask",
                async run() {
                    const answer = await vera.oneshot({
                        model: "claude-opus-5",
                        messages: [{ role: "user", content: "hello" }],
                    });
                    vera.ui.notice(answer.model + ": " + answer.text);
                },
            });
        }
    `);
    const harness = createHarness();
    const asked: VeraClientOneshotRequest[] = [];
    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        ...harness.adapters,
        oneshot: {
            async request(_extensionId, request) {
                asked.push(request);
                return { text: "an answer", model: request.model };
            },
        },
    });

    await registry.invokeCommand("ask", "", "/tmp/workspace");
    expect(asked.map((request) => request.model)).toEqual(["claude-opus-5"]);
    expect(harness.notices).toEqual([
        { extensionId: "client.seat", text: "claude-opus-5: an answer" },
    ]);
    await registry.close();
});

test("oneshot requires the capability", async () => {
    const extension = createExtension("client.nocap", ["client.commands.register"], `
        export function activateClient(vera) {
            vera.commands.register({
                name: "ask",
                description: "ask",
                usage: "/ask",
                async run() {
                    await vera.oneshot({
                        model: "claude-opus-5",
                        messages: [{ role: "user", content: "hello" }],
                    });
                },
            });
        }
    `);
    const failures: ClientExtensionRegistryFailure[] = [];
    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        ...createHarness().adapters,
        oneshot: { async request() { throw new Error("must not be reached"); } },
        onFailure: (failure) => failures.push(failure),
    });

    await expect(registry.invokeCommand("ask", "", "/tmp/workspace"))
        .rejects.toThrow("client.oneshot");
    expect(failures).toEqual([]);
    await registry.close();
});

test("an extension writes a labeled block into the transcript", async () => {
    const extension = createExtension("client.block", [
        "client.ui.transcript",
        "client.commands.register",
    ], `
        export function activateClient(vera) {
            vera.commands.register({
                name: "say",
                description: "write a block",
                usage: "/say",
                run() {
                    vera.ui.transcript({
                        label: "  m1 (claude-opus-5)  ",
                        text: "a longer answer\\n\\nwith paragraphs",
                    });
                },
            });
        }
    `);
    const blocks: unknown[] = [];
    const failures: ClientExtensionRegistryFailure[] = [];
    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        ...createHarness().adapters,
        onFailure: (failure) => failures.push(failure),
        transcript: {
            append(extensionId, block) {
                blocks.push({ extensionId, ...block });
            },
        },
    });

    expect(failures).toEqual([]);
    await registry.invokeCommand("say", "", "/tmp/workspace");
    expect(blocks).toEqual([{
        extensionId: "client.block",
        label: "m1 (claude-opus-5)",
        text: "a longer answer\n\nwith paragraphs",
    }]);
    await registry.close();
});

test("a new client registry imports edited extension entrypoint code", async () => {
    const extension = createExtension("client.reloadable", [
        "client.commands.register",
    ], reloadableCommandSource("before"));
    const adapters = createHarness().adapters;
    const first = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        ...adapters,
    });
    expect((await first.invokeCommand("version", "", "/tmp"))?.body)
        .toEqual({ kind: "text", text: "before" });
    await first.close();

    writeFileSync(
        join(extension, "extension.ts"),
        reloadableCommandSource("after"),
    );
    const second = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        ...adapters,
    });
    expect((await second.invokeCommand("version", "", "/tmp"))?.body)
        .toEqual({ kind: "text", text: "after" });
    await second.close();
});

function reloadableCommandSource(text: string): string {
    return `
        export function activateClient(vera) {
            vera.commands.register({
                name: "version",
                description: "Report version",
                usage: "/version",
                run() { return { kind: "text", text: ${JSON.stringify(text)} }; },
            });
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

    await registry.invokeCommand("say", "  quickslot 1: kimi-k3 · medium  ", workspace);
    expect(harness.notices).toEqual([{
        extensionId: "client.talker",
        text: "quickslot 1: kimi-k3 · medium",
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


/**
 * The pool as the extension sees it: one named entry and one plain one, both
 * offered by a connected provider so availability answers runnable.
 */





test("a declared argument kind reaches the client, a bogus one is refused", async () => {
    const good = createExtension(
        "client.arguments",
        ["client.commands.register"],
        `
            export function activateClient(vera) {
                vera.commands.register({
                    name: "add",
                    description: "Add a seat",
                    usage: "/add <model>",
                    arguments: "model",
                    run() {
                        return { kind: "text", text: "added" };
                    },
                });
            }
        `,
    );
    const registry = await startClientExtensionRegistry({
        extensions: [configured(good)],
        ...createHarness().adapters,
    });
    expect(registry.commands()).toEqual([{
        name: "add",
        description: "Add a seat",
        usage: "/add <model>",
        source: "client.arguments",
        arguments: "model",
    }]);
    await registry.close();

    const bad = createExtension(
        "client.bad-arguments",
        ["client.commands.register"],
        `
            export function activateClient(vera) {
                vera.commands.register({
                    name: "add",
                    description: "Add a seat",
                    usage: "/add <model>",
                    arguments: "colour",
                    run() {
                        return { kind: "text", text: "added" };
                    },
                });
            }
        `,
    );
    const refused = await startClientExtensionRegistry({
        extensions: [configured(bad)],
        ...createHarness().adapters,
    });
    expect(refused.commands()).toEqual([]);
    await refused.close();
});
test("a registered tip is namespaced, defaults its cooldown, and honours when", async () => {
    const extension = createExtension(
        "client.tipper",
        ["client.tips.register"],
        `
            export function activateClient(vera) {
                vera.tips.register({ id: "welcome", text: "  Try /help  " });
                vera.tips.register({
                    id: "pooled",
                    text: "Name a pooled model",
                    cooldownLaunches: 3,
                    when: (context) => context.pooledCount > 0,
                });
                vera.tips.register({
                    id: "broken",
                    text: "Never shown",
                    when: () => { throw new Error("nope"); },
                });
            }
        `,
    );
    const harness = createHarness();
    const registry = await startClientExtensionRegistry({
        extensions: [configured(extension)],
        ...harness.adapters,
    });

    const tips = registry.tips();
    expect(tips.map((tip) => tip.id)).toEqual([
        "client.tipper:welcome",
        "client.tipper:pooled",
        "client.tipper:broken",
    ]);
    expect(tips[0]?.text).toBe("Try /help");
    expect(tips[0]?.cooldownLaunches).toBe(10);
    expect(tips[1]?.cooldownLaunches).toBe(3);
    expect(tips[0]?.source).toBe("client.tipper");

    const context = {
        launches: 1,
        pooledCount: 0,
        namedPoolCount: 0,
        anyVerified: false,
        inModelPicker: false,
    };
    expect(tips[0]?.isRelevant(context)).toBe(true);
    expect(tips[1]?.isRelevant(context)).toBe(false);
    expect(tips[1]?.isRelevant({ ...context, pooledCount: 2 })).toBe(true);
    // A predicate that throws reads as "not now", not as a crash.
    expect(tips[2]?.isRelevant(context)).toBe(false);

    await registry.close();
});

test("a tip registration without the capability fails the extension", async () => {
    const extension = createExtension(
        "client.tip-undeclared",
        ["client.commands.register"],
        `
            export function activateClient(vera) {
                vera.tips.register({ id: "welcome", text: "Try /help" });
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

    expect(registry.tips()).toEqual([]);
    expect(failures[0]?.message).toContain(
        "did not declare client.tips.register",
    );
    await registry.close();
});

test("a duplicate tip id fails the extension", async () => {
    const extension = createExtension(
        "client.tip-dupe",
        ["client.tips.register"],
        `
            export function activateClient(vera) {
                vera.tips.register({ id: "welcome", text: "Try /help" });
                vera.tips.register({ id: "welcome", text: "Try /help again" });
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

    expect(registry.tips()).toEqual([]);
    expect(failures[0]?.message).toContain("Duplicate client extension tip");
    await registry.close();
});
