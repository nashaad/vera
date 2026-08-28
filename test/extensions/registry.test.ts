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
import { createCommandHook } from "../../src/extensions/command-hook.ts";
import {
    startExtensionRegistry,
    type ExtensionRegistryFailure,
} from "../../src/extensions/registry.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";
import type { LiteralSecretFinding } from "../../src/extensions/literal-secret.ts";
import {
    veraMachineDirectory,
    veraProfileDirectory,
} from "../../src/profile-paths.ts";
import type { PreToolUseHook } from "../../src/sdk/hooks.ts";
import {
    decideToolPermission,
    extractPermissionActions,
} from "../../src/engine/permissions.ts";
import {
    executeToolHandler,
    toolDefinitionsForCapabilities,
} from "../../src/tools/execute.ts";
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

test("registry reports one activation timing for each enabled host extension", async () => {
    const loaded = createExtension("loaded.extension", `
        export function activate() {}
    `);
    const failed = createExtension("failed.extension", `
        export function activate() {
            throw new Error("activation failed");
        }
    `);
    const timings: Array<{
        extensionId: string;
        durationMs: number;
        outcome: "loaded" | "failed";
    }> = [];

    const registry = await startExtensionRegistry({
        extensions: [configured(loaded), configured(failed)],
        onActivationTiming: (timing) => timings.push(timing),
    });

    expect(timings).toHaveLength(2);
    expect(timings.map(({ extensionId, outcome }) => ({
        extensionId,
        outcome,
    }))).toEqual([
        { extensionId: "loaded.extension", outcome: "loaded" },
        { extensionId: "failed.extension", outcome: "failed" },
    ]);
    expect(timings.every((timing) => timing.durationMs >= 0)).toBeTrue();
    await registry.close();
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
                invocation: "top_level",
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
    expect(tools[0]?.invocation).toBe("top_level");
    expect(toolDefinitionsForCapabilities([], false, tools, "subagent"))
        .not.toContainEqual(expect.objectContaining({ name: "web_search" }));
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
    await expect(executeToolHandler(
        {
            type: "tool_call",
            id: "search-child",
            name: "web_search",
            input: { query: "dag" },
        },
        new ToolRuntime(
            workspace,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            true,
        ),
        new AbortController().signal,
        tools,
    )).resolves.toEqual({
        kind: "output",
        output: "The web_search tool is available only to top-level sessions.",
        isError: true,
    });

    await registry.close();
});

test("public hook capabilities register in order, carry plain identity, and isolate failures", async () => {
    const extension = createExtension("hooks.extension", `
        export function activate(vera) {
            vera.hooks.registerPreToolUse((payload) => {
                if (payload.sessionId !== "session-1" || payload.workspace !== "/work") {
                    return { power: "block", reason: "identity missing" };
                }
                return { power: "mutate", input: { command: "changed" } };
            });
            vera.hooks.registerPostToolUse((payload) => {
                if (payload.sessionId !== "session-1" || payload.workspace !== "/work") {
                    return { power: "mutate", patch: { isError: true } };
                }
                return { power: "observe" };
            });
        }
    `, ["hooks.pre_tool_use", "hooks.post_tool_use"]);
    const registry = await startExtensionRegistry({
        extensions: [configured(extension)],
    });
    const hooks = new ToolHooks();
    for (const hook of registry.preToolUseHooks()) hooks.registerPreToolUse(hook);
    for (const hook of registry.postToolUseHooks()) hooks.registerPostToolUse(hook);

    const pre = await hooks.runPreToolUse({
        type: "pre_tool_use",
        sessionId: "session-1",
        workspace: "/work",
        toolCall: { id: "call-1", name: "bash", input: { command: "pwd" } },
    }, { timeoutMs: 100 });
    expect(pre).toMatchObject({
        result: { power: "mutate", input: { command: "changed" } },
    });
    expect(await hooks.runPostToolUse({
        type: "post_tool_use",
        sessionId: "session-1",
        workspace: "/work",
        toolCall: pre.toolCall,
        result: {
            toolCallId: "call-1",
            toolName: "bash",
            content: [{ type: "text", text: "ok" }],
            isError: false,
        },
        durationMs: 1,
    }, { timeoutMs: 100 })).toMatchObject({ isError: false });

    await registry.close();
});

test("pre-turn hook registration is capability-gated and can mutate the payload", async () => {
    const failures: ExtensionRegistryFailure[] = [];
    const denied = createExtension("denied-pre-turn.extension", `
        export function activate(vera) {
            vera.hooks.registerPreTurn(() => ({ power: "observe" }));
        }
    `);
    const deniedRegistry = await startExtensionRegistry({
        extensions: [configured(denied)],
        onFailure: (failure) => failures.push(failure),
    });
    expect(deniedRegistry.preTurnHooks()).toEqual([]);
    expect(failures[0]?.message).toContain("hooks.pre_turn");
    await deniedRegistry.close();

    const extension = createExtension("pre-turn.extension", `
        export function activate(vera) {
            vera.hooks.registerPreTurn((payload) => {
                if (payload.prompt !== "review this" || payload.workspace !== "/work") {
                    return { power: "block", reason: "identity missing" };
                }
                return { power: "mutate", tools: ["read"], model: "cheap" };
            });
        }
    `, ["hooks.pre_turn"]);
    const registry = await startExtensionRegistry({
        extensions: [configured(extension)],
    });
    const hooks = new ToolHooks();
    for (const hook of registry.preTurnHooks()) hooks.registerPreTurn(hook);
    const outcome = await hooks.runPreTurn({
        type: "pre_turn",
        sessionId: "session-1",
        workspace: "/work",
        prompt: "review this",
        model: "reviewer",
        tools: ["read", "write"],
    }, { timeoutMs: 100 });
    expect(outcome.payload.tools).toEqual(["read"]);
    expect(outcome.payload.model).toBe("cheap");
    await registry.close();
});

test("a throwing extension pre-turn hook does not break the engine chain", async () => {
    const extension = createExtension("broken-pre-turn.extension", `
        export function activate(vera) {
            vera.hooks.registerPreTurn(() => { throw new Error("broken"); });
            vera.hooks.registerPreTurn(() => ({ power: "mutate", model: "after-broken" }));
        }
    `, ["hooks.pre_turn"]);
    const registry = await startExtensionRegistry({
        extensions: [configured(extension)],
    });
    const hooks = new ToolHooks();
    for (const hook of registry.preTurnHooks()) hooks.registerPreTurn(hook);
    const outcome = await hooks.runPreTurn({
        type: "pre_turn",
        workspace: "/work",
        prompt: "review this",
        model: "reviewer",
        tools: ["read"],
    }, { timeoutMs: 100 });
    expect(outcome.payload.model).toBe("after-broken");
    await registry.close();
});

test("a model request hook contributes one namespaced plain value", async () => {
    const extension = createExtension("strata.extension", `
        export function activate(vera) {
            vera.hooks.registerModelRequest("strata", (payload) => ({
                corpus: {
                    path: payload.workspace,
                    session: payload.sessionId,
                },
            }));
        }
    `, ["hooks.model_request"]);
    const registry = await startExtensionRegistry({
        extensions: [configured(extension)],
    });

    const [hook] = registry.modelRequestHooks();
    expect(hook?.namespace).toBe("strata");
    expect(await hook?.run({
        type: "model_request",
        provider: "vera-strata",
        model: "strata",
        sessionId: "session-1",
        workspace: "/work",
        signal: new AbortController().signal,
    })).toEqual({
        corpus: { path: "/work", session: "session-1" },
    });
    await registry.close();
});

test("duplicate model request namespaces disable the later extension at activation", async () => {
    const failures: ExtensionRegistryFailure[] = [];
    const first = createExtension("first-strata.extension", `
        export function activate(vera) {
            vera.hooks.registerModelRequest("strata", () => ({ source: "first" }));
        }
    `, ["hooks.model_request"]);
    const second = createExtension("second-strata.extension", `
        export function activate(vera) {
            vera.hooks.registerModelRequest("strata", () => ({ source: "second" }));
        }
    `, ["hooks.model_request"]);
    const registry = await startExtensionRegistry({
        extensions: [configured(first), configured(second)],
        onFailure: (failure) => failures.push(failure),
    });

    expect(registry.modelRequestHooks()).toHaveLength(1);
    expect(await registry.modelRequestHooks()[0]?.run({
        type: "model_request",
        provider: "vera-strata",
        model: "strata",
        sessionId: "session-1",
        workspace: "/work",
    })).toEqual({ source: "first" });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain(
        "Duplicate model request namespace: strata",
    );
    await registry.close();
});

test("hook registration is capability-gated and unregisterable", async () => {
    const failures: ExtensionRegistryFailure[] = [];
    const denied = createExtension("denied-hooks.extension", `
        export function activate(vera) {
            vera.hooks.registerPreToolUse(() => ({ power: "observe" }));
        }
    `);
    const registry = await startExtensionRegistry({
        extensions: [configured(denied)],
        onFailure: (failure) => failures.push(failure),
    });
    expect(registry.preToolUseHooks()).toEqual([]);
    expect(failures[0]?.message).toContain("hooks.pre_tool_use");
    await registry.close();

    const removable = createExtension("removable-hooks.extension", `
        export function activate(vera) {
            const dispose = vera.hooks.registerPreToolUse(() => ({ power: "observe" }));
            vera.commands.register({
                name: "remove-hook",
                description: "Remove hook",
                usage: "/remove_hook",
                run() { dispose(); return { kind: "text", text: "removed" }; },
            });
        }
    `, ["hooks.pre_tool_use", "commands.register"]);
    const removableFailures: ExtensionRegistryFailure[] = [];
    const second = await startExtensionRegistry({
        extensions: [configured(removable)],
        onFailure: (failure) => removableFailures.push(failure),
    });
    expect(removableFailures).toEqual([]);
    expect(second.preToolUseHooks()).toHaveLength(1);
    await second.invokeCommand("remove-hook", "", "/work");
    expect(second.preToolUseHooks()).toHaveLength(0);
    await second.close();
});

test("a throwing or malformed extension hook does not break the engine hook chain", async () => {
    const extension = createExtension("broken-hooks.extension", `
        export function activate(vera) {
            vera.hooks.registerPreToolUse(() => { throw new Error("broken"); });
            vera.hooks.registerPreToolUse(() => ({
                power: "mutate", input: { command: "after-broken" },
            }));
            vera.hooks.registerPostToolUse(() => ({ power: "invalid" }));
            vera.hooks.registerPostToolUse(() => ({ power: "observe" }));
        }
    `, ["hooks.pre_tool_use", "hooks.post_tool_use"]);
    const registry = await startExtensionRegistry({
        extensions: [configured(extension)],
    });
    const hooks = new ToolHooks();
    for (const hook of registry.preToolUseHooks()) hooks.registerPreToolUse(hook);
    for (const hook of registry.postToolUseHooks()) hooks.registerPostToolUse(hook);
    const pre = await hooks.runPreToolUse({
        type: "pre_tool_use",
        sessionId: "session-1",
        workspace: "/work",
        toolCall: { id: "call-1", name: "bash", input: { command: "pwd" } },
    }, { timeoutMs: 100 });
    expect(pre.result).toEqual({
        power: "mutate",
        input: { command: "after-broken" },
    });
    await expect(hooks.runPostToolUse({
        type: "post_tool_use",
        sessionId: "session-1",
        workspace: "/work",
        toolCall: pre.toolCall,
        result: {
            toolCallId: "call-1",
            toolName: "bash",
            content: [{ type: "text", text: "ok" }],
            isError: false,
        },
        durationMs: 1,
    }, { timeoutMs: 100 })).resolves.toMatchObject({ isError: false });
    await registry.close();
});

test("extension hook mutations are bounded before entering the engine chain", async () => {
    const extension = createExtension("oversized-hooks.extension", `
        export function activate(vera) {
            vera.hooks.registerPreToolUse(() => ({
                power: "mutate", input: { value: "x".repeat(70 * 1024) },
            }));
            vera.hooks.registerPostToolUse(() => ({
                power: "mutate", patch: { content: [{
                    type: "text", text: "x".repeat(70 * 1024),
                }] },
            }));
        }
    `, ["hooks.pre_tool_use", "hooks.post_tool_use"]);
    const registry = await startExtensionRegistry({
        extensions: [configured(extension)],
    });
    const hooks = new ToolHooks();
    for (const hook of registry.preToolUseHooks()) hooks.registerPreToolUse(hook);
    for (const hook of registry.postToolUseHooks()) hooks.registerPostToolUse(hook);
    const pre = await hooks.runPreToolUse({
        type: "pre_tool_use",
        sessionId: "session-1",
        workspace: "/work",
        toolCall: { id: "call-1", name: "read", input: { path: "file" } },
    }, { timeoutMs: 100 });
    expect(pre.result).toEqual({ power: "observe" });
    const post = await hooks.runPostToolUse({
        type: "post_tool_use",
        sessionId: "session-1",
        workspace: "/work",
        toolCall: pre.toolCall,
        result: {
            toolCallId: "call-1",
            toolName: "read",
            content: [{ type: "text", text: "ok" }],
            isError: false,
        },
        durationMs: 1,
    }, { timeoutMs: 100 });
    expect(post.content).toEqual([{ type: "text", text: "ok" }]);
    await registry.close();
});

test("the command hook adapter exchanges bounded JSON over an argv-only process", async () => {
    const workspace = createDirectory();
    const script = join(workspace, "hook.mjs");
    writeFileSync(script, `
        let input = "";
        process.stdin.on("data", (chunk) => input += chunk);
        process.stdin.on("end", () => {
            const payload = JSON.parse(input);
            process.stdout.write(JSON.stringify({
                power: payload.toolCall.name === "read" ? "block" : "observe",
                ...(payload.toolCall.name === "read" ? { reason: "argv fixture" } : {}),
            }));
        });
    `);
    const extension = createExtension("command-hooks.extension", `
        export function activate(vera) {
            vera.hooks.registerCommand({
                phase: "pre_tool_use",
                argv: [${JSON.stringify(process.execPath)}, ${JSON.stringify(script)}],
            });
        }
    `, ["hooks.command"]);
    const registry = await startExtensionRegistry({
        extensions: [configured(extension)],
    });
    const hooks = new ToolHooks();
    for (const hook of registry.preToolUseHooks()) hooks.registerPreToolUse(hook);
    await expect(hooks.runPreToolUse({
        type: "pre_tool_use",
        sessionId: "session-1",
        workspace,
        toolCall: { id: "read-1", name: "read", input: { path: "x" } },
    }, { timeoutMs: 500 })).resolves.toMatchObject({
        result: { power: "block", reason: "argv fixture" },
    });
    await registry.close();
});

test("the command hook adapter runs the repository checkout guard", async () => {
    const script = join(
        process.cwd(),
        ".claude/hooks/guard-main-checkout.sh",
    );
    const registry = await startExtensionRegistry({
        extensions: [{
            path: join(process.cwd(), "examples/extensions/command-hooks"),
            enabled: true,
            config: {
                hooks: [{
                    phase: "pre_tool_use",
                    protocol: "claude",
                    argv: [script],
                }],
            },
        }],
    });
    const hooks = new ToolHooks();
    for (const hook of registry.preToolUseHooks()) {
        hooks.registerPreToolUse(hook);
    }

    const blocked = await hooks.runPreToolUse({
        type: "pre_tool_use",
        sessionId: "session-1",
        workspace: "/Users/nash/Projects/vera",
        toolCall: {
            id: "switch-1",
            name: "bash",
            input: { command: "git switch feature" },
        },
    }, { timeoutMs: 1_500 });
    expect(blocked.result).toMatchObject({
        power: "block",
        reason: expect.stringContaining("Use a linked worktree instead"),
    });

    const allowed = await hooks.runPreToolUse({
        type: "pre_tool_use",
        sessionId: "session-1",
        workspace: "/Users/nash/Projects/vera",
        toolCall: {
            id: "status-1",
            name: "bash",
            input: { command: "git status --short" },
        },
    }, { timeoutMs: 1_500 });
    expect(allowed.result).toEqual({ power: "observe" });

    await registry.close();
});

test("Claude command-hook compatibility rejects unsupported responses", async () => {
    expect(() => createCommandHook({
        phase: "post_tool_use",
        protocol: "claude",
        argv: [process.execPath, "-e", "console.log('{}')"],
    })).toThrow("support pre_tool_use only");
});

test("command hooks reject oversized input before spawning a process", async () => {
    const hook = createCommandHook({
        phase: "pre_tool_use",
        argv: [process.execPath, "-e", "process.stdout.write('{}')"],
    }) as PreToolUseHook;

    await expect(hook({
        type: "pre_tool_use",
        sessionId: "session-1",
        workspace: "/work",
        toolCall: {
            id: "large-1",
            name: "read",
            input: { content: "x".repeat(256 * 1_024) },
        },
    })).rejects.toThrow("input exceeded its byte bound");
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

test("registry reserves the first-party skill script tool name", async () => {
    const extension = createExtension("skill-collision.extension", `
        export function activate(vera) {
            vera.tools.register({
                name: "skill_script",
                description: "Replace the skill runner",
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
        "Extension tool skill_script collides with a built-in tool",
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
    contributes?: unknown,
): string {
    const directory = createDirectory();
    writeFileSync(join(directory, "vera.extension.json"), JSON.stringify({
        id,
        version: "1.0.0",
        sdk: "1",
        entrypoint: "./extension.ts",
        capabilities,
        ...(contributes === undefined ? {} : { contributes }),
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

test("a declaration-only extension contributes its watches to the host set", async () => {
    const extension = createExtension(
        "acme.arc-bridge",
        "export function activate() {}\n",
        [],
        {
            watches: [
                {
                    id: "main",
                    source_family: "arc",
                    config: { server: "https://arc.local" },
                    address: "coordinator",
                },
            ],
        },
    );
    const failures: ExtensionRegistryFailure[] = [];

    const registry = await startExtensionRegistry({
        extensions: [configured(extension)],
        onFailure: (failure) => failures.push(failure),
    });

    expect(failures).toEqual([]);
    expect(registry.contributions().frozen()).toBe(true);
    expect(registry.contributions().watches()).toEqual([
        {
            id: "acme.arc-bridge/main",
            localId: "main",
            extensionId: "acme.arc-bridge",
            definition: {
                id: "main",
                source_family: "arc",
                config: { server: "https://arc.local" },
                address: "coordinator",
                flood: "shed",
            },
        },
    ]);
    await registry.close();
});

test("a malformed contribution disables the extension before its code is imported", async () => {
    const workspace = createDirectory();
    const importedPath = join(workspace, "imported.txt");
    const extension = createExtension(
        "acme.arc-bridge",
        `
        import { writeFileSync } from "node:fs";
        writeFileSync(${JSON.stringify(importedPath)}, "imported");
        export function activate() {}
        `,
        [],
        { watches: [{ id: "main" }] },
    );
    const failures: ExtensionRegistryFailure[] = [];

    const registry = await startExtensionRegistry({
        extensions: [configured(extension)],
        onFailure: (failure) => failures.push(failure),
    });

    expect(failures[0]?.message).toContain("acme.arc-bridge");
    expect(failures[0]?.message).toContain("source_family");
    expect(registry.contributions().watches()).toEqual([]);
    expect(existsSync(importedPath)).toBe(false);
    await registry.close();
});

test("two extensions may declare the same local watch id", async () => {
    const first = createExtension(
        "acme.arc-bridge",
        "export function activate() {}\n",
        [],
        { watches: [{ id: "main", source_family: "arc" }] },
    );
    const second = createExtension(
        "other.arc-bridge",
        "export function activate() {}\n",
        [],
        { watches: [{ id: "main", source_family: "arc" }] },
    );
    const failures: ExtensionRegistryFailure[] = [];

    const registry = await startExtensionRegistry({
        extensions: [configured(first), configured(second)],
        onFailure: (failure) => failures.push(failure),
    });

    expect(failures).toEqual([]);
    expect(registry.contributions().watches().map((entry) => entry.id))
        .toEqual(["acme.arc-bridge/main", "other.arc-bridge/main"]);
    await registry.close();
    expect(registry.contributions().watches()).toEqual([]);
});

test("a failed activation withdraws that extension's contributions", async () => {
    const extension = createExtension(
        "acme.arc-bridge",
        `export function activate() { throw new Error("no"); }`,
        [],
        { watches: [{ id: "main", source_family: "arc" }] },
    );
    const failures: ExtensionRegistryFailure[] = [];

    const registry = await startExtensionRegistry({
        extensions: [configured(extension)],
        onFailure: (failure) => failures.push(failure),
    });

    expect(failures[0]?.extensionId).toBe("acme.arc-bridge");
    expect(registry.contributions().watches()).toEqual([]);
    await registry.close();
});

test("an extension gets its own directory in the tier it asks for", async () => {
    const reported = join(createDirectory(), "storage.json");
    const extension = createExtension("storage.probe", `
        import { writeFileSync } from "node:fs";
        export function activate(vera) {
            writeFileSync(${JSON.stringify(reported)}, JSON.stringify({
                profile: vera.storage.profile,
                machine: vera.storage.machine,
            }));
        }
    `);

    const registry = await startExtensionRegistry({
        extensions: [configured(extension)],
    });
    await registry.close();

    const storage = JSON.parse(readFileSync(reported, "utf8")) as {
        profile: string;
        machine: string;
    };
    expect(storage.profile).toBe(join(veraProfileDirectory(), "storage.probe"));
    expect(storage.machine).toBe(join(veraMachineDirectory(), "storage.probe"));
    // Reading the path is what creates it, so an extension never has to.
    expect(existsSync(storage.profile)).toBe(true);
    expect(existsSync(storage.machine)).toBe(true);
    rmSync(storage.profile, { recursive: true, force: true });
    rmSync(storage.machine, { recursive: true, force: true });
});

test("an env reference is resolved before the extension sees its config", async () => {
    const receivedPath = join(createDirectory(), "received.txt");
    const extension = createExtension("env.extension", `
        import { writeFileSync } from "node:fs";
        export function activate(vera) {
            writeFileSync(
                ${JSON.stringify(receivedPath)},
                JSON.stringify(vera.config),
            );
        }
    `);
    process.env.VERA_TEST_ENV_REF = "resolved-value";

    let registry;
    try {
        registry = await startExtensionRegistry({
            extensions: [{
                path: extension,
                enabled: true,
                config: { servers: { one: { token: "{env:VERA_TEST_ENV_REF}" } } },
            }],
        });
    } finally {
        delete process.env.VERA_TEST_ENV_REF;
    }

    expect(JSON.parse(readFileSync(receivedPath, "utf8"))).toEqual({
        servers: { one: { token: "resolved-value" } },
    });
    await registry.close();
});

test("an unset env reference disables only the extension that named it", async () => {
    const missing = createExtension("missing.extension", `
        export function activate() {}
    `, ["commands.register"]);
    const healthy = createExtension(
        "healthy.extension",
        commandSource("healthy", "ok"),
    );
    const failures: ExtensionRegistryFailure[] = [];

    const registry = await startExtensionRegistry({
        extensions: [
            { path: missing, enabled: true, config: { token: "{env:VERA_TEST_ABSENT}" } },
            configured(healthy),
        ],
        onFailure(failure) {
            failures.push(failure);
        },
    });

    expect(registry.commands().map((command) => command.name)).toEqual([
        "healthy",
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.extensionId).toBe("missing.extension");
    expect(failures[0]?.message).toContain("VERA_TEST_ABSENT");
    await registry.close();
});

test("a literal credential in config is reported and the extension still loads", async () => {
    const extension = createExtension(
        "secretful.extension",
        commandSource("secretful", "ok"),
    );
    const findings: LiteralSecretFinding[] = [];

    const registry = await startExtensionRegistry({
        extensions: [{
            path: extension,
            enabled: true,
            config: { servers: { one: { token: "ghp_abcdefghijklmnop" } } },
        }],
        onLiteralSecret(finding) {
            findings.push(finding);
        },
    });

    expect(registry.commands().map((command) => command.name)).toEqual([
        "secretful",
    ]);
    expect(findings).toEqual([{
        extensionId: "secretful.extension",
        configPath: "servers.one.token",
        prefix: "ghp_",
    }]);
    await registry.close();
});

test("a resolved env reference is not reported as a literal credential", async () => {
    const extension = createExtension(
        "resolved.extension",
        commandSource("resolved", "ok"),
    );
    const findings: LiteralSecretFinding[] = [];
    process.env.VERA_TEST_SECRET_REF = "ghp_abcdefghijklmnop";

    let registry;
    try {
        registry = await startExtensionRegistry({
            extensions: [{
                path: extension,
                enabled: true,
                config: { token: "{env:VERA_TEST_SECRET_REF}" },
            }],
            onLiteralSecret(finding) {
                findings.push(finding);
            },
        });
    } finally {
        delete process.env.VERA_TEST_SECRET_REF;
    }

    expect(findings).toEqual([]);
    await registry.close();
});
