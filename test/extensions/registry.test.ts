import {
    afterEach,
    expect,
    test,
} from "bun:test";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { VeraExtensionConfig } from "../../src/config.ts";
import {
    RESERVED_EXTENSION_COMMAND_NAMES,
} from "../../src/extensions/commands.ts";
import {
    startExtensionRegistry,
    type ExtensionRegistryFailure,
} from "../../src/extensions/registry.ts";
import {
    decideToolPermission,
    extractPermissionActions,
} from "../../src/engine/permissions.ts";
import { executeToolHandler } from "../../src/tools/execute.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("registry loads enabled extensions, invokes by workspace, and closes in reverse order", async () => {
    const workspace = createDirectory();
    const cleanupPath = join(workspace, "cleanup.txt");
    const first = createExtension("first.extension", `
        import { appendFileSync } from "node:fs";
        export function activate(vera) {
            vera.commands.register({
                name: "alpha",
                description: "Alpha",
                usage: "/alpha",
                run({ workspace }) {
                    return { kind: "text", text: workspace };
                },
            });
            vera.onDispose(() => appendFileSync(
                ${JSON.stringify(cleanupPath)},
                "first\\n",
            ));
        }
    `);
    const disabled = createExtension("disabled.extension", `
        export function activate() {
            throw new Error("must not load");
        }
    `);
    const second = createExtension("second.extension", `
        import { appendFileSync } from "node:fs";
        export function activate(vera) {
            vera.commands.register({
                name: "beta",
                description: "Beta",
                usage: "/beta",
                run() {
                    return { kind: "notice", level: "info", text: "ok" };
                },
            });
            vera.onDispose(() => appendFileSync(
                ${JSON.stringify(cleanupPath)},
                "second\\n",
            ));
        }
    `);

    const registry = await startExtensionRegistry({
        extensions: [
            configured(first),
            configured(disabled, false),
            configured(second),
        ],
    });

    expect(registry.commands().map((command) => command.name)).toEqual([
        "alpha",
        "beta",
    ]);
    await expect(registry.invokeCommand("alpha", "", workspace))
        .resolves.toEqual({
            version: 1,
            source: "first.extension/alpha",
            body: { kind: "text", text: workspace },
        });

    await registry.close();
    expect(readFileSync(cleanupPath, "utf8")).toBe("second\nfirst\n");
});

test("registry exposes extension tools through the ordinary tool and permission paths", async () => {
    const workspace = createDirectory();
    const extension = createExtension("search.extension", `
        export function activate(vera) {
            vera.tools.register({
                name: "web_search",
                description: "Search the web",
                inputSchema: {
                    type: "object",
                    properties: { query: { type: "string" } },
                    required: ["query"],
                    additionalProperties: false,
                },
                parallel: true,
                permissionOperation: "web.search",
                run({ input, workspace }) {
                    return {
                        output: workspace + ":" + input.query,
                        presentation: {
                            kind: "tool_notice",
                            text: "Rendered result",
                        },
                    };
                },
            });
        }
    `, ["tools.register"]);
    const registry = await startExtensionRegistry({
        extensions: [configured(extension)],
    });
    const tools = registry.tools();

    expect(tools.map((tool) => tool.definition.name)).toEqual(["web_search"]);
    expect(decideToolPermission(
        "ask",
        { id: "search-1", name: "web_search", input: { query: "dag" } },
        workspace,
        [],
        { extensionTools: tools },
    )).toMatchObject({
        behavior: "ask",
        actions: [{ action: { operation: "web.search" } }],
    });
    await expect(executeToolHandler(
        {
            type: "tool_call",
            id: "search-1",
            name: "web_search",
            input: { query: "dag" },
        },
        new ToolRuntime(workspace),
        new AbortController().signal,
        tools,
    )).resolves.toEqual({
        kind: "output",
        output: `${workspace}:dag`,
        isError: false,
        presentation: {
            kind: "tool_notice",
            text: "Rendered result",
        },
    });

    await registry.close();
});

test("registry rejects extension tools that collide with built-ins", async () => {
    const extension = createExtension("collision.extension", `
        export function activate(vera) {
            vera.tools.register({
                name: "read",
                description: "Replace read",
                inputSchema: { type: "object", properties: {} },
                run() { return { output: "wrong" }; },
            });
        }
    `, ["tools.register"]);
    const failures: ExtensionRegistryFailure[] = [];
    const registry = await startExtensionRegistry({
        extensions: [configured(extension)],
        onFailure: (failure) => failures.push(failure),
    });

    expect(registry.tools()).toEqual([]);
    expect(failures[0]?.message).toContain(
        "Extension tool read collides with a built-in tool",
    );
    await registry.close();
});

test("extension tool presentations reject client-owned fields", async () => {
    const extension = createExtension("presentation.extension", `
        export function activate(vera) {
            vera.tools.register({
                name: "present",
                description: "Present text",
                inputSchema: { type: "object", properties: {} },
                run() {
                    return {
                        output: "model output",
                        presentation: {
                            kind: "tool_notice",
                            text: "client output",
                            color: "red",
                            focus: true,
                        },
                    };
                },
            });
        }
    `, ["tools.register"]);
    const registry = await startExtensionRegistry({
        extensions: [configured(extension)],
    });

    await expect(executeToolHandler(
        {
            type: "tool_call",
            id: "present-1",
            name: "present",
            input: {},
        },
        new ToolRuntime(createDirectory()),
        new AbortController().signal,
        registry.tools(),
    )).resolves.toMatchObject({
        kind: "output",
        isError: true,
        output: expect.stringContaining("returned an invalid result"),
    });
    await registry.close();
});

test("an extension operation cannot hide its declared path actions", async () => {
    const extension = createExtension("path.extension", `
        export function activate(vera) {
            vera.tools.register({
                name: "indexed_read",
                description: "Read through an index",
                inputSchema: {
                    type: "object",
                    properties: { path: { type: "string" } },
                    required: ["path"],
                    additionalProperties: false,
                },
                permissionOperation: "index.read",
                permissionInputs: [{
                    field: "path",
                    kind: "path",
                    verb: "read",
                }],
                run() { return { output: "ok" }; },
            });
        }
    `, ["tools.register"]);
    const registry = await startExtensionRegistry({
        extensions: [configured(extension)],
    });

    expect(extractPermissionActions({
        toolCall: {
            id: "read-1",
            name: "indexed_read",
            input: { path: "../outside.txt" },
        },
        workspace: "/workspace",
        homeDirectory: "/home/test",
    }, registry.tools())).toMatchObject([
        { operation: "index.read" },
        { verb: "read", scope: "outside_workspace" },
    ]);

    await registry.close();
});

test("extension tool input is isolated from the engine-owned tool call", async () => {
    const extension = createExtension("mutation.extension", `
        export function activate(vera) {
            vera.tools.register({
                name: "mutate_input",
                description: "Try to mutate input",
                inputSchema: {
                    type: "object",
                    properties: { nested: { type: "object" } },
                    required: ["nested"],
                    additionalProperties: false,
                },
                run({ input }) {
                    input.nested.value = "changed";
                    return { output: input.nested.value };
                },
            });
        }
    `, ["tools.register"]);
    const registry = await startExtensionRegistry({
        extensions: [configured(extension)],
    });
    const nested = { value: "original" };

    await executeToolHandler(
        {
            type: "tool_call",
            id: "mutate-1",
            name: "mutate_input",
            input: { nested },
        },
        new ToolRuntime(createDirectory()),
        new AbortController().signal,
        registry.tools(),
    );

    expect(nested.value).toBe("original");
    await registry.close();
});

test("an extension tool timeout becomes an error result and the next call works", async () => {
    const extension = createExtension("timeout.extension", `
        export function activate(vera) {
            vera.tools.register({
                name: "sometimes_slow",
                description: "Test timeout recovery",
                inputSchema: {
                    type: "object",
                    properties: { slow: { type: "boolean" } },
                    additionalProperties: false,
                },
                async run({ input, signal }) {
                    if (!input.slow) {
                        return { output: "ready" };
                    }
                    await new Promise((resolve) =>
                        signal.addEventListener("abort", resolve, { once: true })
                    );
                    return { output: "late" };
                },
            });
        }
    `, ["tools.register"]);
    const registry = await startExtensionRegistry({
        extensions: [configured(extension)],
        handlerTimeoutMs: 20,
    });
    const tools = registry.tools();
    const runtime = new ToolRuntime(createDirectory());

    await expect(executeToolHandler(
        {
            type: "tool_call",
            id: "slow-1",
            name: "sometimes_slow",
            input: { slow: true },
        },
        runtime,
        new AbortController().signal,
        tools,
    )).resolves.toMatchObject({
        kind: "output",
        isError: true,
        output: expect.stringContaining("timed out"),
    });
    await expect(executeToolHandler(
        {
            type: "tool_call",
            id: "ready-1",
            name: "sometimes_slow",
            input: { slow: false },
        },
        runtime,
        new AbortController().signal,
        tools,
    )).resolves.toEqual({
        kind: "output",
        output: "ready",
        isError: false,
    });

    await registry.close();
});

test("registry keeps the first extension for duplicate IDs and command collisions", async () => {
    const first = createExtension("same.extension", commandSource(
        "shared",
        "first",
    ));
    const duplicateId = createExtension(
        "same.extension",
        commandSource("other", "duplicate"),
    );
    const collision = createExtension(
        "collision.extension",
        commandSource("shared", "collision"),
    );
    const healthy = createExtension(
        "healthy.extension",
        commandSource("healthy", "ready"),
    );
    const failures: ExtensionRegistryFailure[] = [];

    const registry = await startExtensionRegistry({
        extensions: [
            configured(first),
            configured(duplicateId),
            configured(collision),
            configured(healthy),
        ],
        onFailure: (failure) => failures.push(failure),
    });

    expect(registry.commands().map((command) => command.name)).toEqual([
        "shared",
        "healthy",
    ]);
    await expect(registry.invokeCommand("shared", "", createDirectory()))
        .resolves.toMatchObject({ body: { kind: "text", text: "first" } });
    await expect(registry.invokeCommand("healthy", "", createDirectory()))
        .resolves.toMatchObject({ body: { kind: "text", text: "ready" } });
    expect(failures.map((failure) => failure.message)).toEqual([
        "Duplicate extension ID: same.extension",
        expect.stringContaining("collides with same.extension"),
    ]);

    await registry.close();
});

test("registry rejects duplicate command registration as one failed extension", async () => {
    const duplicate = createExtension("duplicate.extension", `
        export function activate(vera) {
            vera.commands.register({
                name: "same",
                description: "Same",
                usage: "/same",
                run() { return { kind: "text", text: "first" }; },
            });
            vera.commands.register({
                name: "same",
                description: "Same again",
                usage: "/same",
                run() { return { kind: "text", text: "second" }; },
            });
        }
    `);
    const healthy = createExtension(
        "healthy.extension",
        commandSource("healthy", "ready"),
    );
    const failures: ExtensionRegistryFailure[] = [];

    const registry = await startExtensionRegistry({
        extensions: [configured(duplicate), configured(healthy)],
        onFailure: (failure) => failures.push(failure),
    });

    expect(registry.commands().map((command) => command.name)).toEqual([
        "healthy",
    ]);
    expect(failures[0]?.message).toContain(
        "Duplicate extension command: same",
    );
    await expect(registry.invokeCommand("healthy", "", createDirectory()))
        .resolves.toMatchObject({ body: { kind: "text", text: "ready" } });
    await registry.close();
});

test("registry rejects every reserved command without publishing the extension", async () => {
    for (const name of RESERVED_EXTENSION_COMMAND_NAMES) {
        const extension = createExtension(
            `reserved-${name}.extension`,
            commandSource(name, "not allowed"),
        );
        const failures: ExtensionRegistryFailure[] = [];
        const registry = await startExtensionRegistry({
            extensions: [configured(extension)],
            onFailure: (failure) => failures.push(failure),
        });

        expect(registry.commands()).toEqual([]);
        expect(failures[0]?.message).toContain(
            `/${name} from reserved-${name}.extension collides with a built-in client command`,
        );
        await registry.close();
    }
});

test("registry reports a malformed module and keeps later extensions usable", async () => {
    const broken = createExtension("broken.extension", `
        export default function activate() {}
    `);
    const healthy = createExtension(
        "healthy.extension",
        commandSource("healthy", "ready"),
    );
    const failures: ExtensionRegistryFailure[] = [];

    const registry = await startExtensionRegistry({
        extensions: [configured(broken), configured(healthy)],
        onFailure: (failure) => failures.push(failure),
    });

    expect(registry.commands().map((command) => command.name)).toEqual([
        "healthy",
    ]);
    expect(failures[0]?.message).toContain(
        "must export an activate function",
    );
    await expect(registry.invokeCommand("healthy", "", createDirectory()))
        .resolves.toMatchObject({ body: { kind: "text", text: "ready" } });
    await registry.close();
});

test("activation timeout publishes nothing and does not block later extensions", async () => {
    const slow = createExtension("slow.extension", `
        export async function activate(vera) {
            vera.commands.register({
                name: "slow",
                description: "Slow",
                usage: "/slow",
                run() { return { kind: "text", text: "late" }; },
            });
            await new Promise(() => {});
        }
    `);
    const healthy = createExtension(
        "healthy.extension",
        commandSource("healthy", "ready"),
    );
    const failures: ExtensionRegistryFailure[] = [];

    const registry = await startExtensionRegistry({
        extensions: [configured(slow), configured(healthy)],
        activationTimeoutMs: 20,
        onFailure: (failure) => failures.push(failure),
    });

    expect(registry.commands().map((command) => command.name)).toEqual([
        "healthy",
    ]);
    expect(failures[0]?.message).toContain(
        "activation timed out after 20ms",
    );
    await registry.close();
});

test("invalid handler results do not poison the extension or the next command", async () => {
    const extension = createExtension("results.extension", `
        export function activate(vera) {
            vera.commands.register({
                name: "bad",
                description: "Bad result",
                usage: "/bad",
                run() { return { kind: "unsupported", text: "no" }; },
            });
            vera.commands.register({
                name: "good",
                description: "Good result",
                usage: "/good",
                run() { return { kind: "text", text: "ready" }; },
            });
        }
    `);
    const registry = await startExtensionRegistry({
        extensions: [configured(extension)],
    });

    await expect(registry.invokeCommand("bad", "", createDirectory()))
        .rejects.toThrow("returned an invalid result");
    await expect(registry.invokeCommand("good", "", createDirectory()))
        .resolves.toMatchObject({ body: { kind: "text", text: "ready" } });
    await registry.close();
});

test("async command timeout cancels the handler and preserves the next invocation", async () => {
    const workspace = createDirectory();
    const startedPath = join(workspace, "started.txt");
    const abortedPath = join(workspace, "aborted.txt");
    const extension = createExtension("timeout.extension", blockingCommandSource(
        "work",
        startedPath,
        abortedPath,
    ));
    const registry = await startExtensionRegistry({
        extensions: [configured(extension)],
        handlerTimeoutMs: 20,
    });

    const invocation = registry.invokeCommand("work", "slow", workspace);
    await waitFor(() => existsSync(startedPath));
    await expect(invocation)
        .rejects.toThrow("timed out after 20ms");
    expect(readFileSync(abortedPath, "utf8")).toBe("aborted");
    await expect(registry.invokeCommand("work", "fast", workspace))
        .resolves.toMatchObject({ body: { kind: "text", text: "ready" } });
    await registry.close();
});

test("parent cancellation reaches the handler and preserves the next invocation", async () => {
    const workspace = createDirectory();
    const startedPath = join(workspace, "started.txt");
    const abortedPath = join(workspace, "aborted.txt");
    const extension = createExtension("cancel.extension", blockingCommandSource(
        "work",
        startedPath,
        abortedPath,
    ));
    const registry = await startExtensionRegistry({
        extensions: [configured(extension)],
        handlerTimeoutMs: 1_000,
    });
    const controller = new AbortController();

    const invocation = registry.invokeCommand(
        "work",
        "slow",
        workspace,
        controller.signal,
    );
    await waitFor(() => existsSync(startedPath));
    controller.abort(new Error("parent cancelled"));

    await expect(invocation).rejects.toThrow();
    expect(readFileSync(abortedPath, "utf8")).toBe("aborted");
    await expect(registry.invokeCommand("work", "fast", workspace))
        .resolves.toMatchObject({ body: { kind: "text", text: "ready" } });
    await registry.close();
});

test("an already-cancelled invocation never enters extension code", async () => {
    const workspace = createDirectory();
    const enteredPath = join(workspace, "entered.txt");
    const extension = createExtension("pre-cancel.extension", `
        import { writeFileSync } from "node:fs";
        export function activate(vera) {
            vera.commands.register({
                name: "work",
                description: "Work",
                usage: "/work",
                run() {
                    writeFileSync(${JSON.stringify(enteredPath)}, "entered");
                    return { kind: "text", text: "late" };
                },
            });
        }
    `);
    const registry = await startExtensionRegistry({
        extensions: [configured(extension)],
    });
    const controller = new AbortController();
    controller.abort();

    await expect(registry.invokeCommand(
        "work",
        "",
        workspace,
        controller.signal,
    )).rejects.toThrow();
    expect(existsSync(enteredPath)).toBe(false);
    await registry.close();
});

test("close cancels an active invocation before running its disposer", async () => {
    const workspace = createDirectory();
    const startedPath = join(workspace, "started.txt");
    const orderPath = join(workspace, "order.txt");
    const extension = createExtension("closing.extension", `
        import { appendFileSync, writeFileSync } from "node:fs";
        export function activate(vera) {
            vera.commands.register({
                name: "wait",
                description: "Wait",
                usage: "/wait",
                run({ signal }) {
                    writeFileSync(${JSON.stringify(startedPath)}, "started");
                    return new Promise((resolve) => {
                        signal.addEventListener("abort", () => {
                            appendFileSync(
                                ${JSON.stringify(orderPath)},
                                "handler-aborted\\n",
                            );
                            resolve({ kind: "text", text: "late" });
                        }, { once: true });
                    });
                },
            });
            vera.onDispose(() => appendFileSync(
                ${JSON.stringify(orderPath)},
                "disposed\\n",
            ));
        }
    `);
    const registry = await startExtensionRegistry({
        extensions: [configured(extension)],
        handlerTimeoutMs: 1_000,
    });

    const invocation = registry.invokeCommand("wait", "", workspace);
    await waitFor(() => existsSync(startedPath));
    const closing = registry.close();

    await expect(invocation).rejects.toThrow();
    await expect(closing).resolves.toBeUndefined();
    expect(readFileSync(orderPath, "utf8")).toBe(
        "handler-aborted\ndisposed\n",
    );
    await expect(registry.invokeCommand("wait", "", workspace))
        .rejects.toThrow("Extension registry is closing");
});

test("close does not dispose resources while a handler ignores cancellation", async () => {
    const workspace = createDirectory();
    const startedPath = join(workspace, "started.txt");
    const disposedPath = join(workspace, "disposed.txt");
    const extension = createExtension("stuck.extension", `
        import { writeFileSync } from "node:fs";
        export function activate(vera) {
            vera.commands.register({
                name: "wait",
                description: "Wait",
                usage: "/wait",
                run() {
                    writeFileSync(${JSON.stringify(startedPath)}, "started");
                    return new Promise(() => {});
                },
            });
            vera.onDispose(() => {
                writeFileSync(${JSON.stringify(disposedPath)}, "disposed");
            });
        }
    `);
    const registry = await startExtensionRegistry({
        extensions: [configured(extension)],
        disposeTimeoutMs: 20,
        handlerTimeoutMs: 1_000,
    });

    void registry.invokeCommand("wait", "", workspace).catch(() => undefined);
    await waitFor(() => existsSync(startedPath));

    await expect(registry.close()).rejects.toThrow(
        "active handlers did not stop",
    );
    expect(existsSync(disposedPath)).toBe(false);
});

test("disposer failures do not prevent reverse-order cleanup", async () => {
    const workspace = createDirectory();
    const orderPath = join(workspace, "order.txt");
    const extension = createExtension("cleanup.extension", `
        import { appendFileSync } from "node:fs";
        export function activate(vera) {
            vera.onDispose(() => appendFileSync(
                ${JSON.stringify(orderPath)},
                "first\\n",
            ));
            vera.onDispose(() => {
                appendFileSync(
                    ${JSON.stringify(orderPath)},
                    "second\\n",
                );
                throw new Error("second disposer failed");
            });
        }
    `);
    const registry = await startExtensionRegistry({
        extensions: [configured(extension)],
    });

    await expect(registry.close()).rejects.toThrow(
        "second disposer failed",
    );
    expect(readFileSync(orderPath, "utf8")).toBe("second\nfirst\n");
    await expect(registry.close()).rejects.toThrow(
        "second disposer failed",
    );
});

function createExtension(
    id: string,
    source: string,
    capabilities: readonly string[] = ["commands.register"],
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

function commandSource(name: string, text: string): string {
    return `
        export function activate(vera) {
            vera.commands.register({
                name: ${JSON.stringify(name)},
                description: "Test command",
                usage: "/${name}",
                run() {
                    return { kind: "text", text: ${JSON.stringify(text)} };
                },
            });
        }
    `;
}

function blockingCommandSource(
    name: string,
    startedPath: string,
    abortedPath: string,
): string {
    return `
        import { writeFileSync } from "node:fs";
        export function activate(vera) {
            vera.commands.register({
                name: ${JSON.stringify(name)},
                description: "Test command",
                usage: "/${name}",
                run({ argumentsText, signal }) {
                    writeFileSync(
                        ${JSON.stringify(startedPath)},
                        "started",
                    );
                    if (argumentsText !== "slow") {
                        return { kind: "text", text: "ready" };
                    }
                    return new Promise((resolve) => {
                        signal.addEventListener("abort", () => {
                            writeFileSync(
                                ${JSON.stringify(abortedPath)},
                                "aborted",
                            );
                            resolve({ kind: "text", text: "late" });
                        }, { once: true });
                    });
                },
            });
        }
    `;
}

function configured(
    path: string,
    enabled: boolean = true,
): VeraExtensionConfig {
    return { path, enabled, config: null };
}

function createDirectory(): string {
    const directory = join(
        tmpdir(),
        `vera-extension-registry-${crypto.randomUUID()}`,
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
