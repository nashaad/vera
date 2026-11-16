import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CORE_EXTENSIONS_DIRECTORY, SHIPPED_EXTENSIONS_DIRECTORY } from "../../src/extensions/included.ts";
import { startExtensionRegistry } from "../../src/extensions/registry.ts";
import type { SandboxCommandRequest, CommandSandbox } from "../../src/sandbox/types.ts";
import { executeToolHandler } from "../../src/tools/execute.ts";
import {
    ManagedProcessRegistry,
    type ManagedProcessObservationSettlement,
    type ManagedProcessObservationStart,
} from "../../src/tools/process-runtime.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";

const directories: string[] = [];
const globals = globalThis as unknown as Record<string, unknown>;

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
    delete globals.crowLaunch;
});

test("@core a declared launch is bound, one-shot, and waits for durable registration", async () => {
    const workspace = directory();
    const extension = makeExtension(`
        export function activate(vera) {
            vera.tools.register({
                name: "crow_command", description: "Start a crow command.",
                inputSchema: {
                    type: "object", properties: { script: { type: "string" } },
                    required: ["script"],
                },
                commandInput: "script",
                async run(request) {
                    request.input.script = "printf wrong";
                    request.workspace = "/wrong";
                    globalThis.crowLaunch = request.startProcess;
                    const first = await request.startProcess("Crow checks the cargo");
                    let second;
                    try { await request.startProcess("Crow changes course"); }
                    catch (error) { second = error.message; }
                    return { output: JSON.stringify({ first, second }) };
                },
            });
        }
    `);
    const starts: ManagedProcessObservationStart[] = [];
    const settlements: ManagedProcessObservationSettlement[] = [];
    const prepared: SandboxCommandRequest[] = [];
    const gate = deferred();
    const sandbox: CommandSandbox = {
        async prepare(request) { prepared.push(request); return {}; },
        async settle() { return { suffix: "", violations: [] }; },
        settleSync() { return { suffix: "", violations: [] }; },
        finishUnwrapped() {},
        release() {},
        commandEnded() {},
    };
    const processes = new ManagedProcessRegistry({
        sandbox,
        async onObservationStarted(start) { starts.push(start); await gate.promise; },
        async onObservationSettled(settlement) { settlements.push(settlement); },
    });
    const registry = await startExtensionRegistry({ extensions: [{ path: extension, enabled: true, config: null }] });
    const runtime = new ToolRuntime(workspace, undefined, undefined, { CROW_SONG: "ahoy" }, undefined, processes.scope("crow-owner"));
    runtime.sessionId = "crow-owner";
    runtime.readApprovalMode = () => "auto";
    let finished = false;
    const command = "printf '%s|%s' \"$CROW_SONG\" \"$PWD\"";
    const execution = executeToolHandler({
        type: "tool_call", id: "crow-call", name: "crow_command", input: { script: command },
    }, runtime, new AbortController().signal, registry.tools()).then((result) => {
        finished = true;
        return result;
    });
    try {
        await waitFor(() => starts.length === 1);
        await Bun.sleep(80);
        expect(finished).toBe(false);
        expect(settlements).toHaveLength(0);
        gate.resolve();
        const result = await execution;
        expect(result.kind).toBe("output");
        if (result.kind !== "output") throw new Error("missing output");
        expect(result.isError).toBe(false);
        expect(JSON.parse(result.output).second).toContain("no longer available");
        await waitFor(() => settlements.length === 1);
        expect(starts[0]).toMatchObject({
            ownerId: "crow-owner", extensionId: "crow.extension", description: "Crow checks the cargo",
        });
        expect(settlements[0]).toMatchObject({ exitCode: 0, outputTail: `ahoy|${workspace}` });
        expect(prepared[0]).toMatchObject({
            command, cwd: workspace, workspace, sessionId: "crow-owner",
            toolCallId: "crow-call", approvalMode: "auto", env: { CROW_SONG: "ahoy" },
        });
        const callback = globals.crowLaunch as (description: string) => Promise<unknown>;
        await expect(callback("Crow returns")).rejects.toThrow("no longer available");
        expect(processes.scope("other-owner").read(starts[0]!.processId)).toBeUndefined();
    } finally {
        gate.resolve();
        await runtime.close();
        await processes.close();
        await registry.close();
    }
});

test("@core cancellation during start acknowledgement returns before eventual settlement", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<ManagedProcessObservationSettlement>();
    const events: string[] = [];
    const processes = new ManagedProcessRegistry({
        async onObservationStarted() {
            events.push("started");
            started.resolve();
            await release.promise;
            events.push("registered");
        },
        async onObservationSettled(value) {
            events.push("settled");
            settled.resolve(value);
        },
    });
    const controller = new AbortController();
    const run = processes.scope("crow-owner").run({
        command: "sleep 5", cwd: process.cwd(), env: process.env, interactive: false,
        yieldAfterMs: 0, signal: controller.signal,
        observation: { extensionId: "crow.extension", description: "Crow checks the cargo" },
    });
    try {
        await started.promise;
        controller.abort();
        const result = await Promise.race([run, Bun.sleep(1000).then(() => "timed out" as const)]);
        expect(result).not.toBe("timed out");
        if (result === "timed out") throw new Error("Cancellation waited for registration");
        expect(result.kind).toBe("aborted");
        if (result.kind !== "aborted") throw new Error("Expected an aborted process");
        expect(result.terminated).toBe(true);
        expect(events).toEqual(["started"]);
        release.resolve();
        expect((await settled.promise).processId).toBe(result.snapshot.processId);
        expect(events).toEqual(["started", "registered", "settled"]);
    } finally {
        release.resolve();
        await run;
        await processes.close();
    }
});

test("@core a retained launch is revoked when its handler ends or is cancelled", async () => {
    const extension = makeExtension(`
        export function activate(vera) {
            vera.tools.register({
                name: "crow_command", description: "Start a crow command.",
                inputSchema: {
                    type: "object", properties: { script: { type: "string" }, wait: { type: "boolean" } },
                    required: ["script"],
                },
                commandInput: "script",
                async run({ input, signal, startProcess }) {
                    globalThis.crowLaunch = startProcess;
                    if (input.wait) await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
                    return { output: "crow ready" };
                },
            });
        }
    `);
    const starts: ManagedProcessObservationStart[] = [];
    const processes = new ManagedProcessRegistry({
        async onObservationStarted(start) { starts.push(start); },
        async onObservationSettled() {},
    });
    const registry = await startExtensionRegistry({ extensions: [{ path: extension, enabled: true, config: null }] });
    const runtime = new ToolRuntime(directory(), undefined, undefined, undefined, undefined, processes.scope("crow-owner"));
    const call = (wait: boolean, signal: AbortSignal) => executeToolHandler({
        type: "tool_call", id: "crow-call", name: "crow_command", input: { script: "printf crow", wait },
    }, runtime, signal, registry.tools());
    try {
        await call(false, new AbortController().signal);
        let callback = globals.crowLaunch as (description: string) => Promise<unknown>;
        await expect(callback("Crow wakes late")).rejects.toThrow("no longer available");
        delete globals.crowLaunch;
        const controller = new AbortController();
        const running = call(true, controller.signal);
        await waitFor(() => globals.crowLaunch !== undefined);
        callback = globals.crowLaunch as (description: string) => Promise<unknown>;
        controller.abort();
        await running;
        await expect(callback("Crow wakes after cancellation")).rejects.toThrow("no longer available");
        expect(starts).toHaveLength(0);
    } finally {
        await runtime.close();
        await processes.close();
        await registry.close();
    }
});

test("@core observation tails follow capture order across stdout and stderr", async () => {
    for (const command of [
        "printf 'old-stderr\\n' >&2; sleep 0.05; printf 'new-stdout\\n'",
        "printf 'old-stdout\\n'; sleep 0.05; printf 'new-stderr\\n' >&2",
    ]) {
        const settlements: ManagedProcessObservationSettlement[] = [];
        const processes = new ManagedProcessRegistry({
            async onObservationStarted() {},
            async onObservationSettled(settlement) { settlements.push(settlement); },
        });
        try {
            const result = await processes.scope("crow-owner").run({
                command, cwd: process.cwd(), env: process.env, interactive: false,
                observation: { extensionId: "crow.extension", description: "Crow checks the hold" },
            });
            expect(result.kind).toBe("exited");
            expect(settlements).toHaveLength(1);
            const [old, recent] = command.includes("old-stderr")
                ? ["old-stderr", "new-stdout"] : ["old-stdout", "new-stderr"];
            expect(settlements[0]!.outputTail).toBe(`${old}\n${recent}\n`);
            expect(settlements[0]!.outputTruncated).toBe(false);
        } finally {
            await processes.close();
        }
    }
});

test("@core observation tails preserve split UTF-8 across interleaved streams", async () => {
    for (const command of [
        "printf '\\360\\237'; sleep 0.05; printf X >&2; sleep 0.05; printf '\\246\\234'",
        "printf '\\360\\237' >&2; sleep 0.05; printf X; sleep 0.05; printf '\\246\\234' >&2",
        "printf '\\357\\277\\275'; sleep 0.05; printf X >&2; sleep 0.05; printf '\\357\\277\\275'",
    ]) {
        const settlements: ManagedProcessObservationSettlement[] = [];
        const processes = new ManagedProcessRegistry({
            async onObservationStarted() {},
            async onObservationSettled(settlement) { settlements.push(settlement); },
        });
        try {
            const result = await processes.scope("crow-owner").run({
                command, cwd: process.cwd(), env: process.env, interactive: false,
                observation: { extensionId: "crow.extension", description: "Crow checks the hold" },
            });
            expect(result.kind).toBe("exited");
            expect(settlements).toHaveLength(1);
            expect(settlements[0]!.outputTail).toBe(command.includes("\\357") ? "�X�" : "X🦜");
            expect(settlements[0]!.outputTruncated).toBe(false);
        } finally {
            await processes.close();
        }
    }
});

test("@core observation tail truncation preserves complete UTF-8 characters", async () => {
    const settlements: ManagedProcessObservationSettlement[] = [];
    const processes = new ManagedProcessRegistry({
        async onObservationStarted() {},
        async onObservationSettled(settlement) { settlements.push(settlement); },
    });
    try {
        const result = await processes.scope("crow-owner").run({
            command: "printf '\\342\\202\\254'; sleep 0.05; printf '%8191s' '' | tr ' ' x",
            cwd: process.cwd(), env: process.env, interactive: false,
            observation: { extensionId: "crow.extension", description: "Crow checks the hold" },
        });
        expect(result.kind).toBe("exited");
        expect(settlements).toHaveLength(1);
        expect(settlements[0]!.outputTail).toBe("x".repeat(8191));
        expect(settlements[0]!.outputTruncated).toBe(true);
    } finally {
        await processes.close();
    }
});

test("@core command input classification is reserved to shipped extension directories", async () => {
    const source = `
        export function activate(vera) {
            vera.tools.register({
                name: "crow_command", description: "Start a crow command.",
                inputSchema: { type: "object", properties: { script: { type: "string" } }, required: ["script"] },
                commandInput: "script",
                async run() { return { output: "ready" }; },
            });
        }
    `;
    for (const trust of ["installed", "symlink", "core", "shipped"] as const) {
        const failures: string[] = [];
        const extension = makeExtension(source, trust === "symlink" ? "installed" : trust);
        const path = trust === "symlink"
            ? join(CORE_EXTENSIONS_DIRECTORY, "chat", `.crow-test-${crypto.randomUUID()}`)
            : extension;
        if (trust === "symlink") {
            symlinkSync(extension, path, "dir");
            directories.push(path);
        }
        const registry = await startExtensionRegistry({
            extensions: [{ path, enabled: true, config: null }],
            onFailure: (failure) => failures.push(failure.message),
        });
        try {
            if (trust === "installed" || trust === "symlink") {
                expect(registry.tools()).toEqual([]);
                expect(failures.join("\n")).toContain("reserved command input");
            } else {
                expect(failures).toEqual([]);
                expect(registry.tools()).toHaveLength(1);
                expect(registry.tools()[0]!.commandInput).toBe("script");
            }
        } finally {
            await registry.close();
        }
    }
});

function directory(): string {
    const path = join(tmpdir(), `vera-crow-${crypto.randomUUID()}`);
    mkdirSync(path);
    directories.push(path);
    return path;
}

function makeExtension(source: string, trust: "core" | "shipped" | "installed" = "core"): string {
    const path = trust === "installed"
        ? directory()
        : join(trust === "core" ? CORE_EXTENSIONS_DIRECTORY : SHIPPED_EXTENSIONS_DIRECTORY,
            trust === "core" ? "chat" : "artifacts", `.crow-test-${crypto.randomUUID()}`);
    if (trust !== "installed") {
        mkdirSync(path);
        directories.push(path);
    }
    writeFileSync(join(path, "vera.extension.json"), JSON.stringify({
        id: "crow.extension", version: "1.0.0", sdk: "1", entrypoint: "./extension.ts",
        capabilities: ["tools.register"], unreviewed_tools: ["crow_command"],
    }));
    writeFileSync(join(path, "extension.ts"), source);
    return path;
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        if (predicate()) return;
        await Bun.sleep(5);
    }
    throw new Error("condition was not reached");
}
