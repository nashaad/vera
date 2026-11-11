import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolHooks } from "../../src/engine/hooks.ts";
import { startExtensionRegistry, type ExtensionRegistry } from "../../src/extensions/registry.ts";

type Phase = "pre_tool_use" | "pre_turn";

const roots: string[] = [];
const registries: ExtensionRegistry[] = [];

afterEach(async () => {
    for (const registry of registries.splice(0)) await registry.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function load(source: string, capabilities: string[]) {
    const root = mkdtempSync(join(tmpdir(), "vera-failure-policy-"));
    roots.push(root);
    writeFileSync(join(root, "vera.extension.json"), JSON.stringify({
        id: "test.crow",
        version: "1.0.0",
        sdk: "1",
        entrypoint: "./extension.ts",
        capabilities,
    }));
    writeFileSync(join(root, "extension.ts"), `export function activate(vera) { ${source} }`);
    const failures: string[] = [];
    const registry = await startExtensionRegistry({
        extensions: [{ path: root, enabled: true, config: null }],
        storageRoots: { profile: root, machine: root },
        onFailure: (failure) => failures.push(failure.message),
    });
    registries.push(registry);
    return { registry, failures };
}

async function invoke(registry: ExtensionRegistry, phase: Phase, timeoutMs = 2_000) {
    const hooks = new ToolHooks();
    for (const hook of registry.preToolUseHooks()) hooks.registerPreToolUse(hook);
    for (const hook of registry.preTurnHooks()) hooks.registerPreTurn(hook.run, hook.extensionId);
    const reports: string[] = [];
    const options = { timeoutMs, onFailure: (error: string) => reports.push(error) };
    const outcome = phase === "pre_tool_use"
        ? await hooks.runPreToolUse({
            type: "pre_tool_use",
            workspace: "/work",
            toolCall: { id: "call", name: "read", input: {} },
        }, options)
        : await hooks.runPreTurn({
            type: "pre_turn",
            workspace: "/work",
            prompt: "find the treasure",
            model: "test",
            tools: ["read"],
            arrivedDuringTurn: false,
            spawned: false,
        }, options);
    return { result: outcome.result, reports };
}

function reason(phase: Phase, failure: string): string {
    const action = phase === "pre_tool_use" ? "this tool call did not run" : "this prompt was not run";
    return `Extension test.crow's ${phase} hook failed (${failure}) and denies on failure, so ${action}.`;
}

for (const phase of ["pre_tool_use", "pre_turn"] as const) {
    const method = phase === "pre_tool_use" ? "registerPreToolUse" : "registerPreTurn";
    const capability = `hooks.${phase}`;

    test(`${phase} default observes a throw and runs the next extension hook`, async () => {
        const { registry, failures } = await load(`
            vera.hooks.${method}(() => { throw new Error("broken"); });
            vera.hooks.${method}(() => ({ power: "block", reason: "later hook" }));
        `, [capability]);
        expect(failures).toEqual([]);
        expect((await invoke(registry, phase)).result).toEqual({ power: "block", reason: "later hook" });
    });

    test(`${phase} resolves non-JSON data according to its declared policy`, async () => {
        const result = phase === "pre_tool_use"
            ? '{ power: "mutate", input: { value: NaN } }'
            : '{ power: "observe", extra: NaN }';
        const path = phase === "pre_tool_use" ? "$.input.value" : "$.extra";
        const undeclared = await load(`vera.hooks.${method}(() => (${result}));`, [capability]);
        await expect(invoke(undeclared.registry, phase)).rejects.toThrow(
            `Hook data at ${path} must contain a finite number`,
        );
        const allowed = await load(`
            vera.hooks.${method}(() => (${result}), { onFailure: "allow" });
            vera.hooks.${method}(() => ({ power: "block", reason: "later hook" }));
        `, [capability]);
        expect((await invoke(allowed.registry, phase)).result).toEqual({ power: "block", reason: "later hook" });
        const denied = await load(`vera.hooks.${method}(() => (${result}), { onFailure: "deny" });`, [capability]);
        expect((await invoke(denied.registry, phase)).result).toEqual({
            power: "block", reason: reason(phase, "returned an invalid result"),
        });
    });

    test(`${phase} explicit allow observes a throw and an invalid result`, async () => {
        const { registry } = await load(`
            vera.hooks.${method}(() => { throw new Error("broken"); }, { onFailure: "allow" });
            vera.hooks.${method}(() => ({ power: "invalid" }), { onFailure: "allow" });
            vera.hooks.${method}(() => ({ power: "observe", extra: NaN }), { onFailure: "allow" });
            vera.hooks.${method}(() => ({ power: "block", reason: "later hook" }));
        `, [capability]);
        expect((await invoke(registry, phase)).result).toEqual({ power: "block", reason: "later hook" });
    });

    test(`${phase} deny blocks on a throw and keeps its message to one line`, async () => {
        const { registry } = await load(`
            vera.hooks.${method}(() => { throw new Error("broken\\nsecond line"); }, { onFailure: "deny" });
        `, [capability]);
        expect((await invoke(registry, phase)).result).toEqual({
            power: "block", reason: reason(phase, "threw: broken"),
        });
    });

    test(`${phase} deny bounds an error message and handles non-stringifiable throws`, async () => {
        const long = await load(`
            vera.hooks.${method}(() => { throw new Error("x".repeat(300)); }, { onFailure: "deny" });
        `, [capability]);
        expect((await invoke(long.registry, phase)).result).toEqual({
            power: "block", reason: reason(phase, `threw: ${"x".repeat(200)}`),
        });
        const unusual = await load(`
            vera.hooks.${method}(() => { throw Object.create(null); }, { onFailure: "deny" });
        `, [capability]);
        expect((await invoke(unusual.registry, phase)).result).toEqual({
            power: "block", reason: reason(phase, "threw: unknown error"),
        });
    });

    test(`${phase} deny blocks an invalid result`, async () => {
        const { registry } = await load(`
            vera.hooks.${method}(() => ({ power: "invalid" }), { onFailure: "deny" });
        `, [capability]);
        expect((await invoke(registry, phase)).result).toEqual({
            power: "block", reason: reason(phase, "returned an invalid result"),
        });
    });

    for (const value of ["NaN", "undefined", "() => {}", "new Date()"] as const) {
        test(`${phase} deny blocks non-JSON result data: ${value}`, async () => {
            const { registry } = await load(`
                vera.hooks.${method}(() => ({ power: "observe", extra: ${value} }), { onFailure: "deny" });
            `, [capability]);
            expect((await invoke(registry, phase)).result).toEqual({
                power: "block", reason: reason(phase, "returned an invalid result"),
            });
        });
    }

    test(`${phase} deny blocks a shared deadline and reports the timeout`, async () => {
        const { registry } = await load(`
            vera.hooks.${method}(() => new Promise(() => {}), { onFailure: "deny" });
        `, [capability]);
        expect(await invoke(registry, phase, 30)).toEqual({
            result: { power: "block", reason: reason(phase, "timed out after 30ms") },
            reports: [`${phase} hooks timed out after 30ms`],
        });
    });

    test(`${phase} deny leaves a normal block result unchanged`, async () => {
        const { registry } = await load(`
            vera.hooks.${method}(() => ({ power: "block", reason: "keep the treasure" }), { onFailure: "deny" });
        `, [capability]);
        expect((await invoke(registry, phase)).result).toEqual({ power: "block", reason: "keep the treasure" });
    });

    test(`${phase} deny leaves a normal mutation unchanged`, async () => {
        const result = phase === "pre_tool_use"
            ? { power: "mutate" as const, input: { path: "treasure" } }
            : { power: "mutate" as const, model: "crow" };
        const { registry } = await load(`
            vera.hooks.${method}(() => (${JSON.stringify(result)}), { onFailure: "deny" });
        `, [capability]);
        expect((await invoke(registry, phase)).result).toEqual(result);
    });

    test(`${phase} explicit allow proceeds after its shared deadline`, async () => {
        const { registry } = await load(`
            vera.hooks.${method}(() => new Promise(() => {}), { onFailure: "allow" });
        `, [capability]);
        expect(await invoke(registry, phase, 30)).toEqual({
            result: { power: "observe" },
            reports: [`${phase} hooks timed out after 30ms`],
        });
    });

    for (const [name, script, failure] of [
        ["bad exit", "process.exit(7)", "threw: Command hook exited with status 7"],
        ["bad JSON", "process.stdout.write('no json')", "returned an invalid result"],
        ["invalid result", "process.stdout.write(JSON.stringify({power:'invalid'}))", "returned an invalid result"],
        ["timeout", "setInterval(() => {}, 1000)", "timed out after 200ms"],
    ] as const) {
        test(`${phase} command deny blocks on ${name}`, async () => {
            const { registry, failures } = await load(`
                vera.hooks.registerCommand({
                    phase: ${JSON.stringify(phase)},
                    argv: [${JSON.stringify(process.execPath)}, "-e", ${JSON.stringify(script)}],
                    timeoutMs: ${name === "timeout" ? 200 : 1500},
                    onFailure: "deny",
                });
            `, ["hooks.command"]);
            expect(failures).toEqual([]);
            expect((await invoke(registry, phase)).result).toEqual({ power: "block", reason: reason(phase, failure) });
        });
    }

    test(`${phase} command default observes a bad exit`, async () => {
        const { registry } = await load(`
            vera.hooks.registerCommand({ phase: ${JSON.stringify(phase)}, argv: [${JSON.stringify(process.execPath)}, "-e", "process.exit(7)"] });
        `, ["hooks.command"]);
        expect((await invoke(registry, phase)).result).toEqual({ power: "observe" });
    });

    test(`${phase} command deny preserves a normal result`, async () => {
        const { registry } = await load(`
            vera.hooks.registerCommand({ phase: ${JSON.stringify(phase)}, argv: [${JSON.stringify(process.execPath)}, "-e", "process.stdout.write(JSON.stringify({power:'block',reason:'keep it'}))"], onFailure: "deny" });
        `, ["hooks.command"]);
        expect((await invoke(registry, phase)).result).toEqual({ power: "block", reason: "keep it" });
    });
}

const nonBlocking = [
    ["registerPostToolUse", "post_tool_use"],
    ["registerSessionStart", "session_start"],
    ["registerTurnEnding", "turn_ending"],
    ["registerTurnFinished", "turn_finished"],
    ["registerSessionUpdated", "session_updated"],
    ["registerPreCompact", "pre_compact"],
    ["registerContextSizeTrigger", "context_size_trigger"],
    ["registerSessionEnd", "session_end"],
    ["registerSubagentFinished", "subagent_finished"],
] as const;

for (const [method, phase] of nonBlocking) {
    test(`${phase} accepts allow and rejects deny at registration`, async () => {
        const allowed = await load(`vera.hooks.${method}(() => {}, { onFailure: "allow" });`, [`hooks.${phase}`]);
        expect(allowed.failures).toEqual([]);
        const denied = await load(`vera.hooks.${method}(() => {}, { onFailure: "deny" });`, [`hooks.${phase}`]);
        expect(denied.failures).toEqual([expect.stringContaining(`${phase} hook cannot deny on failure`)]);
    });
}

for (const [method, phase, argumentsText] of [
    ["registerModelRequest", "model_request", '"crow", () => ({})'],
    ["registerModelMiddleware", "model_middleware", "(adapter) => adapter"],
] as const) {
    for (const policy of ["allow", "deny"] as const) {
        test(`${phase} rejects the ${policy} failure policy`, async () => {
            const { failures } = await load(`vera.hooks.${method}(${argumentsText}, { onFailure: "${policy}" });`, [`hooks.${phase}`]);
            expect(failures).toEqual([expect.stringContaining("failure there stops the request")]);
        });
    }
}

test("command hooks reject deny for a phase without a block result", async () => {
    const { failures } = await load(`
        vera.hooks.registerCommand({ phase: "turn_ending", argv: ["/bin/true"], onFailure: "deny" });
    `, ["hooks.command"]);
    expect(failures).toEqual([expect.stringContaining("turn_ending hook cannot deny on failure")]);
});

for (const phase of ["post_tool_use", "session_start", "turn_ending", "pre_compact", "context_size_trigger", "session_end", "subagent_finished"] as const) {
    test(`${phase} command accepts allow and rejects deny`, async () => {
        const allowed = await load(`vera.hooks.registerCommand({ phase: "${phase}", argv: ["/bin/true"], onFailure: "allow" });`, ["hooks.command"]);
        expect(allowed.failures).toEqual([]);
        const denied = await load(`vera.hooks.registerCommand({ phase: "${phase}", argv: ["/bin/true"], onFailure: "deny" });`, ["hooks.command"]);
        expect(denied.failures).toEqual([expect.stringContaining(`${phase} hook cannot deny on failure`)]);
    });
}

test("invalid failure policies fail registration", async () => {
    const first = await load(`vera.hooks.registerPreToolUse(() => ({ power: "observe" }), { onFailure: "ignore" });`, ["hooks.pre_tool_use"]);
    expect(first.failures).toEqual([expect.stringContaining("onFailure must be allow or deny")]);
    const second = await load(`vera.hooks.registerCommand({ phase: "pre_turn", argv: ["/bin/true"], onFailure: "ignore" });`, ["hooks.command"]);
    expect(second.failures).toEqual([expect.stringContaining("onFailure must be allow or deny")]);
});

test("the included command-hooks extension forwards its configured policy", async () => {
    const failures: string[] = [];
    const registry = await startExtensionRegistry({
        extensions: [{
            path: join(process.cwd(), "src/core-extensions/command-hooks"),
            enabled: true,
            config: {
                hooks: [{
                    phase: "pre_tool_use",
                    argv: [process.execPath, "-e", "process.exit(7)"],
                    onFailure: "deny",
                }],
            },
        }],
        onFailure: (failure) => failures.push(failure.message),
    });
    registries.push(registry);
    expect(failures).toEqual([]);
    expect((await invoke(registry, "pre_tool_use")).result).toEqual({
        power: "block",
        reason: "Extension vera.command-hooks's pre_tool_use hook failed (threw: Command hook exited with status 7) and denies on failure, so this tool call did not run.",
    });
});

test("the included command-hooks extension rejects an invalid configured policy", async () => {
    const failures: string[] = [];
    const registry = await startExtensionRegistry({
        extensions: [{
            path: join(process.cwd(), "src/core-extensions/command-hooks"),
            enabled: true,
            config: { hooks: [{ phase: "pre_turn", argv: ["/bin/true"], onFailure: "ignore" }] },
        }],
        onFailure: (failure) => failures.push(failure.message),
    });
    registries.push(registry);
    expect(failures).toEqual([expect.stringContaining("Invalid command-hook config entry")]);
});
