import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolHooks } from "../../src/engine/hooks.ts";
import { createCommandHook } from "../../src/extensions/command-hook.ts";
import { startExtensionRegistry, type ExtensionRegistryFailure } from "../../src/extensions/registry.ts";
import type { SessionStartHook, SessionStartHookPayload } from "../../src/sdk/hooks.ts";
import { loadVeraConfig } from "../../src/config.ts";

const roots: string[] = [];
const payload: SessionStartHookPayload = {
    type: "session_start", sessionId: "session", workspace: "/work", reason: "start",
};

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function directory(): string {
    const root = mkdtempSync(join(tmpdir(), "vera-start-extension-"));
    roots.push(root);
    return root;
}

function extension(capabilities: string[], source: string): string {
    const root = directory();
    writeFileSync(join(root, "vera.extension.json"), JSON.stringify({
        id: "test.start", version: "1.0.0", sdk: "1", entrypoint: "extension.ts", capabilities, contributes: {},
    }));
    writeFileSync(join(root, "extension.ts"), source);
    return root;
}

test("session-start registration requires its capability and activation phase", async () => {
    const failures: ExtensionRegistryFailure[] = [];
    const denied = await startExtensionRegistry({
        extensions: [{ path: extension(["commands.register"], 'export function activate(api) { api.hooks.registerSessionStart(() => ({power: "observe"})); }'), enabled: true, config: {} }],
        onFailure: (failure) => { failures.push(failure); },
    });
    expect(failures[0]?.message).toContain("hooks.session_start");
    expect(denied.sessionStartHooks()).toEqual([]);
    await denied.close();
    const path = extension(["hooks.session_start"], `
        export function activate(api) {
            const remove = api.hooks.registerSessionStart(() => ({ power: "mutate", context: "removed" }));
            remove();
            api.hooks.registerSessionStart(() => {
                try { api.hooks.registerSessionStart(() => ({ power: "observe" })); }
                catch (error) { return { power: "mutate", context: error.message }; }
                throw new Error("late registration was accepted");
            });
        }
    `);
    const registry = await startExtensionRegistry({ extensions: [{ path, enabled: true, config: {} }] });
    try {
        const hooks = new ToolHooks();
        for (const hook of registry.sessionStartHooks()) hooks.registerSessionStart(hook);
        expect(await hooks.runSessionStart(payload, { timeoutMs: 100 })).toEqual([
            { index: 1, context: "Extension hooks must be registered during activation" },
        ]);
    } finally {
        await registry.close();
    }
});

test("native command hooks receive the payload and return bounded context", async () => {
    const hook = createCommandHook({
        phase: "session_start",
        argv: [process.execPath, "-e", 'const p = await Bun.stdin.json(); console.log(JSON.stringify({power:"mutate", context:JSON.stringify(p)}));'],
    }) as SessionStartHook;
    expect(await hook(payload)).toEqual({ power: "mutate", context: JSON.stringify(payload) });
});

test("the existing compatibility protocol translates session reasons and additionalContext", async () => {
    const hook = createCommandHook({
        phase: "session_start", protocol: "claude",
        argv: [process.execPath, "-e", 'const p = await Bun.stdin.json(); console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"SessionStart", additionalContext:JSON.stringify(p)}}));'],
    }) as SessionStartHook;
    for (const reason of ["start", "resume", "compacted"] as const) {
        const result = await hook({ ...payload, reason });
        expect(result.power).toBe("mutate");
        if (result.power !== "mutate") throw new Error("Context missing");
        expect(JSON.parse(result.context)).toEqual({
            session_id: "session", cwd: "/work", hook_event_name: "SessionStart",
            source: reason === "start" ? "startup" : reason === "compacted" ? "compact" : "resume",
        });
    }
});

test("session-start command results accept the full context cap including JSON escapes", async () => {
    const hooks = new ToolHooks();
    hooks.registerSessionStart(createCommandHook({
        phase: "session_start",
        argv: [process.execPath, "-e", 'console.log(JSON.stringify({power:"mutate",context:"\\u0000".repeat(128*1024)}));'],
    }) as SessionStartHook);
    const result = await hooks.runSessionStart(payload, { timeoutMs: 1000 });
    expect(result[0]?.context.length).toBe(128 * 1024);
});

test("a malformed or nonzero command result logs and the following hook runs", async () => {
    const hooks = new ToolHooks();
    for (const script of ['console.log("not json")', 'process.exit(1)', 'console.log(JSON.stringify({power:"mutate",context:"x".repeat(128*1024+1)}))']) {
        hooks.registerSessionStart(createCommandHook({ phase: "session_start", argv: [process.execPath, "-e", script] }) as SessionStartHook);
    }
    hooks.registerSessionStart(() => ({ power: "mutate", context: "later" }));
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
        expect(await hooks.runSessionStart(payload, { timeoutMs: 1000 })).toEqual([{ index: 4, context: "later" }]);
        expect(warning).toHaveBeenCalledTimes(3);
    } finally {
        warning.mockRestore();
    }
});

test("a timed-out command has exited when its rejection arrives", async () => {
    const pidPath = join(directory(), "pid");
    const hook = createCommandHook({
        phase: "session_start", timeoutMs: 200,
        argv: [process.execPath, "-e", `await Bun.write(${JSON.stringify(pidPath)}, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 100);`],
    }) as SessionStartHook;
    await expect(hook(payload)).rejects.toThrow("timed out");
    const pid = Number(readFileSync(pidPath, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
});

test("the existing user config accepts session_start and keeps the home hooks boundary", () => {
    const root = directory();
    const path = join(root, "config.json");
    mkdirSync(join(root, "hooks"));
    writeFileSync(path, JSON.stringify({
        schema_version: 1, provider: "openrouter", model: "test",
        hooks: [{ phase: "session_start", argv: ["greet"], timeout_ms: 1000 }],
    }));
    expect(loadVeraConfig({ path }).hooks).toEqual([
        { phase: "session_start", argv: [join(root, "hooks", "greet")], timeout_ms: 1000 },
    ]);
    writeFileSync(path, JSON.stringify({
        schema_version: 1, provider: "openrouter", model: "test",
        hooks: [{ phase: "session_start", argv: ["../outside"] }],
    }));
    expect(() => loadVeraConfig({ path })).toThrow("outside");
});

test("extensions can register session-start commands through hooks.command", async () => {
    const root = extension(["hooks.command"], `
        export function activate(api) {
            api.hooks.registerCommand({ phase: "session_start", argv: ${JSON.stringify([process.execPath, "-e", 'console.log(JSON.stringify({power:"mutate",context:"command context"}))'])} });
        }
    `);
    const registry = await startExtensionRegistry({ extensions: [{ path: root, enabled: true, config: {} }] });
    try {
        const hooks = new ToolHooks();
        for (const hook of registry.sessionStartHooks()) hooks.registerSessionStart(hook);
        expect(await hooks.runSessionStart(payload, { timeoutMs: 1000 })).toEqual([{ index: 1, context: "command context" }]);
    } finally {
        await registry.close();
    }
});

test("an empty compatibility response contributes no context", async () => {
    const hook = createCommandHook({
        phase: "session_start", protocol: "claude",
        argv: [process.execPath, "-e", "await Bun.stdin.text();"],
    }) as SessionStartHook;
    expect(await hook(payload)).toEqual({ power: "observe" });
});
