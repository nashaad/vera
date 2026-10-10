import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commandHookPhase, createCommandHook } from "../../src/extensions/command-hook.ts";
import { startExtensionRegistry } from "../../src/extensions/registry.ts";
import type {
    PreCompactHook,
    PreToolUseHook,
    PreTurnHook,
    PreTurnHookPayload,
    SessionEndHook,
    SessionStartHook,
    SubagentFinishedHook,
    TurnEndingHook,
    TurnEndingHookPayload,
} from "../../src/sdk/hooks.ts";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function directory(): string {
    const root = mkdtempSync(join(tmpdir(), "vera-claude-hooks-"));
    roots.push(root);
    return root;
}

// A bun one-liner as argv; `body` sees the parsed stdin as `p`.
function script(body: string): string[] {
    return [process.execPath, "-e", `const p = await Bun.stdin.json(); ${body}`];
}

const preTurn: PreTurnHookPayload = {
    type: "pre_turn",
    sessionId: "crow-1",
    workspace: "/nest",
    prompt: "where is the treasure?",
    model: "faux/test",
    tools: ["read"],
    arrivedDuringTurn: false,
    spawned: false,
};

const turnEnding: TurnEndingHookPayload = {
    type: "turn_ending",
    sessionId: "crow-1",
    workspace: "/nest",
    prompt: "where is the treasure?",
    reply: "done",
    spawned: false,
    continuations: 0,
};

test("Claude event names need the claude protocol and map to Vera phases", () => {
    expect(commandHookPhase("UserPromptSubmit", "claude")).toBe("pre_turn");
    expect(commandHookPhase("Stop", "claude")).toBe("turn_ending");
    expect(commandHookPhase("SubagentStop", "claude")).toBe("turn_ending");
    expect(commandHookPhase("PreCompact", "claude")).toBe("pre_compact");
    expect(commandHookPhase("SessionEnd", "claude")).toBe("session_end");
    expect(commandHookPhase("turn_ending", "claude")).toBe("turn_ending");
    expect(commandHookPhase("subagent_finished", undefined)).toBe("subagent_finished");
    expect(() => commandHookPhase("Stop", undefined)).toThrow("needs the claude protocol");
    expect(() => commandHookPhase("Stop", "vera")).toThrow("needs the claude protocol");
    expect(() => commandHookPhase("subagent_finished", "claude")).toThrow("does not support subagent_finished");
    expect(() => commandHookPhase("Notification", "claude")).toThrow("Unknown command hook phase");
});

test("UserPromptSubmit gets the prompt and returns context as JSON or plain text", async () => {
    const json = createCommandHook({
        phase: "UserPromptSubmit",
        protocol: "claude",
        argv: script('console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"UserPromptSubmit", additionalContext:JSON.stringify(p)}}));'),
    }) as PreTurnHook;
    const result = await json(preTurn);
    if (result.power !== "mutate" || result.context === undefined) throw new Error("context missing");
    expect(JSON.parse(result.context)).toEqual({
        session_id: "crow-1",
        cwd: "/nest",
        hook_event_name: "UserPromptSubmit",
        prompt: "where is the treasure?",
    });

    const plain = createCommandHook({
        phase: "pre_turn",
        protocol: "claude",
        argv: script('console.log("The crow buried it under the third palm.");'),
    }) as PreTurnHook;
    expect(await plain(preTurn)).toEqual({
        power: "mutate",
        context: "The crow buried it under the third palm.",
    });
});

test("UserPromptSubmit blocks with decision block or exit 2", async () => {
    const decision = createCommandHook({
        phase: "UserPromptSubmit",
        protocol: "claude",
        argv: script('console.log(JSON.stringify({decision:"block", reason:"No digging on deck."}));'),
    }) as PreTurnHook;
    expect(await decision(preTurn)).toEqual({ power: "block", reason: "No digging on deck." });

    const exit2 = createCommandHook({
        phase: "UserPromptSubmit",
        protocol: "claude",
        argv: script('console.error("The parrot objects."); process.exit(2);'),
    }) as PreTurnHook;
    expect(await exit2(preTurn)).toEqual({ power: "block", reason: "The parrot objects." });

    const silent = createCommandHook({
        phase: "UserPromptSubmit",
        protocol: "claude",
        argv: script("process.exit(2);"),
    }) as PreTurnHook;
    await expect(silent(preTurn)).rejects.toThrow("without a reason on stderr");
});

test("Stop continues the turn with the block reason and sees stop_hook_active", async () => {
    const decision = createCommandHook({
        phase: "Stop",
        protocol: "claude",
        argv: script('console.log(JSON.stringify(p.stop_hook_active ? {} : {decision:"block", reason:JSON.stringify(p)}));'),
    }) as TurnEndingHook;
    const first = await decision(turnEnding);
    if (first.power !== "continue") throw new Error("expected continue");
    expect(JSON.parse(first.context)).toEqual({
        session_id: "crow-1",
        cwd: "/nest",
        hook_event_name: "Stop",
        stop_hook_active: false,
        last_assistant_message: "done",
    });
    expect(await decision({ ...turnEnding, continuations: 1 })).toEqual({ power: "observe" });

    const exit2 = createCommandHook({
        phase: "turn_ending",
        protocol: "claude",
        argv: script('console.error("Draw the map before you say done."); process.exit(2);'),
    }) as TurnEndingHook;
    expect(await exit2(turnEnding)).toEqual({
        power: "continue",
        context: "Draw the map before you say done.",
    });
});

test("Stop runs at top level only and SubagentStop in subagents only", async () => {
    const root = directory();
    const ran = (name: string) => script(`await Bun.write(${JSON.stringify(join(root, name))}, JSON.stringify(p)); process.exit(2);`);
    const stop = createCommandHook({ phase: "Stop", protocol: "claude", argv: ran("stop") }) as TurnEndingHook;
    const subagentStop = createCommandHook({
        phase: "SubagentStop",
        protocol: "claude",
        argv: ran("subagent"),
    }) as TurnEndingHook;
    const child = { ...turnEnding, sessionId: "crow-2", spawned: true };

    expect(await stop(child)).toEqual({ power: "observe" });
    expect(existsSync(join(root, "stop"))).toBe(false);
    expect(await subagentStop(turnEnding)).toEqual({ power: "observe" });
    expect(existsSync(join(root, "subagent"))).toBe(false);

    await expect(subagentStop(child)).rejects.toThrow("without a reason on stderr");
    expect(JSON.parse(readFileSync(join(root, "subagent"), "utf8"))).toEqual({
        session_id: "crow-2",
        cwd: "/nest",
        hook_event_name: "SubagentStop",
        stop_hook_active: false,
        last_assistant_message: "done",
        agent_id: "crow-2",
    });
});

test("UserPromptSubmit does not run in a subagent", async () => {
    const root = directory();
    const hook = createCommandHook({
        phase: "UserPromptSubmit",
        protocol: "claude",
        argv: script(`await Bun.write(${JSON.stringify(join(root, "ran"))}, "yes");`),
    }) as PreTurnHook;
    expect(await hook({ ...preTurn, spawned: true })).toEqual({ power: "observe" });
    expect(existsSync(join(root, "ran"))).toBe(false);
});

test("PreCompact and SessionEnd receive Claude payloads and skip subagents", async () => {
    const root = directory();
    const write = (name: string) => script(`await Bun.write(${JSON.stringify(join(root, name))}, JSON.stringify(p));`);
    const compact = createCommandHook({ phase: "PreCompact", protocol: "claude", argv: write("compact") }) as PreCompactHook;
    const end = createCommandHook({ phase: "session_end", protocol: "claude", argv: write("end") }) as SessionEndHook;

    await compact({
        type: "pre_compact", sessionId: "crow-1", workspace: "/nest",
        reason: "automatic", tokens: 900, spawned: true,
    });
    expect(existsSync(join(root, "compact"))).toBe(false);
    await compact({
        type: "pre_compact", sessionId: "crow-1", workspace: "/nest",
        reason: "automatic", tokens: 900, spawned: false,
    });
    expect(JSON.parse(readFileSync(join(root, "compact"), "utf8"))).toEqual({
        session_id: "crow-1",
        cwd: "/nest",
        hook_event_name: "PreCompact",
        trigger: "auto",
        custom_instructions: "",
    });

    await end({
        type: "session_end", sessionId: "crow-1", workspace: "/nest",
        reason: "closed", turns: 2, spawned: false,
    });
    expect(JSON.parse(readFileSync(join(root, "end"), "utf8"))).toEqual({
        session_id: "crow-1",
        cwd: "/nest",
        hook_event_name: "SessionEnd",
        reason: "other",
    });
});

test("PreToolUse blocks on exit 2 and ignores plain stdout", async () => {
    const payload = {
        type: "pre_tool_use" as const,
        sessionId: "crow-1",
        workspace: "/nest",
        toolCall: { id: "call-1", name: "bash", input: { command: "rm -rf chest" } },
    };
    const exit2 = createCommandHook({
        phase: "PreToolUse",
        protocol: "claude",
        argv: script('console.error("Leave the chest."); process.exit(2);'),
    }) as PreToolUseHook;
    expect(await exit2(payload)).toEqual({ power: "block", reason: "Leave the chest." });

    const chatty = createCommandHook({
        phase: "pre_tool_use",
        protocol: "claude",
        argv: script('console.log("checked the rigging");'),
    }) as PreToolUseHook;
    expect(await chatty(payload)).toEqual({ power: "observe" });
});

test("SessionStart takes plain stdout as context and ignores exit 2", async () => {
    const payload = { type: "session_start" as const, sessionId: "crow-1", workspace: "/nest", reason: "start" as const };
    const plain = createCommandHook({
        phase: "SessionStart",
        protocol: "claude",
        argv: script('console.log("The crow likes short answers.");'),
    }) as SessionStartHook;
    expect(await plain(payload)).toEqual({ power: "mutate", context: "The crow likes short answers." });

    const exit2 = createCommandHook({
        phase: "SessionStart",
        protocol: "claude",
        argv: script('console.error("not now"); process.exit(2);'),
    }) as SessionStartHook;
    expect(await exit2(payload)).toEqual({ power: "observe" });
});

test("vera-protocol commands run on the new phases", async () => {
    const root = directory();
    const preTurnHook = createCommandHook({
        phase: "pre_turn",
        argv: script('console.log(JSON.stringify({power:"mutate", context:"spawned=" + p.spawned}));'),
    }) as PreTurnHook;
    expect(await preTurnHook(preTurn)).toEqual({ power: "mutate", context: "spawned=false" });

    const finished = createCommandHook({
        phase: "subagent_finished",
        argv: script(`await Bun.write(${JSON.stringify(join(root, "finished"))}, JSON.stringify(p));`),
    }) as SubagentFinishedHook;
    const payload = {
        type: "subagent_finished" as const,
        parentSessionId: "crow-1",
        subagentId: "crow-2",
        workspace: "/nest",
        background: false,
        outcome: "completed" as const,
        text: "twelve cannons below deck",
    };
    await finished(payload);
    expect(JSON.parse(readFileSync(join(root, "finished"), "utf8"))).toEqual(payload);

    const failing = createCommandHook({
        phase: "session_end",
        argv: script("process.exit(1);"),
    }) as SessionEndHook;
    await expect(failing({
        type: "session_end", sessionId: "crow-1", workspace: "/nest",
        reason: "closed", turns: 0, spawned: false,
    })).rejects.toThrow("exited with status 1");
});

test("extensions register command hooks for every phase through hooks.command", async () => {
    const root = directory();
    writeFileSync(join(root, "vera.extension.json"), JSON.stringify({
        id: "test.crow-commands",
        version: "1.0.0",
        sdk: "1",
        entrypoint: "extension.ts",
        capabilities: ["hooks.command"],
        contributes: {},
    }));
    const argv = JSON.stringify(script('console.log("x");'));
    writeFileSync(join(root, "extension.ts"), `
        export function activate(vera) {
            for (const phase of ["UserPromptSubmit", "Stop", "SubagentStop", "PreCompact", "SessionEnd"]) {
                vera.hooks.registerCommand({ phase, protocol: "claude", argv: ${argv} });
            }
            vera.hooks.registerCommand({ phase: "subagent_finished", argv: ${argv} });
        }
    `);
    const registry = await startExtensionRegistry({
        extensions: [{ path: root, enabled: true, config: null }],
    });
    try {
        expect(registry.preTurnHooks().map((hook) => hook.extensionId)).toEqual(["test.crow-commands"]);
        expect(registry.turnEndingHooks()).toHaveLength(2);
        expect(registry.preCompactHooks()).toHaveLength(1);
        expect(registry.sessionEndHooks()).toHaveLength(1);
        expect(registry.subagentFinishedHooks()).toHaveLength(1);
        expect(await registry.preTurnHooks()[0]!.run(preTurn)).toEqual({ power: "mutate", context: "x" });
    } finally {
        await registry.close();
    }
});
