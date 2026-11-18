import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentUpdate } from "../../../src/engine/protocol.ts";
import type { RegisteredAgentSummary } from "../../../src/host/agent-registry.ts";
import { ManagedProcessRegistry } from "../../../src/tools/process-runtime.ts";
import { createSettingsAnsweringClient } from "../../support/settings-answering-client.ts";
import { createTuiNewSessionScenario } from "../../support/tui-new-session-child.ts";
import { createTuiResumeScenario } from "../../support/tui-resume-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

for (const trigger of ["/close", "C-w"] as const) {
    test(`@core ${trigger} opens the close picker for a background command`, async () => {
        const home = mkdtempSync(join(tmpdir(), "vera-tui-idle-close-"));
        const scenario = createTuiResumeScenario({ home });
        const session = await startTuiTestSession({
            home,
            dependencies: () => ({
                ...scenario.dependencies,
                listSessionPage: async () => ({ agents: [{
                    id: "current-session-id", background_commands: 1,
                } as RegisteredAgentSummary] }),
            }),
        });
        try {
            await session.waitForVisiblePane("Start a conversation");
            if (trigger === "/close") {
                session.sendText(trigger);
                session.sendKey("Enter");
            } else {
                session.sendKey(trigger);
            }
            const pane = await session.waitForVisiblePane("Stop & close");
            expect(pane.replace(/\s+/g, " "))
                .toContain("stop this conversation and its 1 background command");
            expect(pane).not.toContain("running turn");
            session.sendKey("Escape");
            await session.waitForVisiblePaneWhere(
                (visible) => !visible.includes("Stop & close"),
                "the close confirmation to dismiss",
            );
        } finally {
            await session.close();
        }
    }, 15_000);
}

test("@core a working conversation describes its two background commands", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-working-close-"));
    const scenario = createTuiResumeScenario({ home, inFlight: true });
    const session = await startTuiTestSession({
        home,
        dependencies: () => ({
            ...scenario.dependencies,
            listSessionPage: async () => ({ agents: [{
                id: "current-session-id", background_commands: 2,
            } as RegisteredAgentSummary] }),
        }),
    });
    try {
        await session.waitForVisiblePane("TURN IN FLIGHT");
        session.sendKey("C-w");
        const pane = await session.waitForVisiblePane("Stop & close");
        expect(pane.replace(/\s+/g, " "))
            .toContain("stop this conversation and its 2 background commands");
        expect(pane).not.toContain("running turn");
    } finally {
        await session.close();
    }
}, 15_000);

test("@core close picker keys stop or keep the conversation", async () => {
    const choices = [
        { keys: ["1"], closes: true },
        { keys: ["2"], closes: false },
        { keys: ["Escape"], closes: false },
        { keys: ["Enter"], closes: true },
        { keys: ["Down", "Enter"], closes: false },
    ];
    for (const choice of choices) {
        const home = mkdtempSync(join(tmpdir(), "vera-tui-close-choice-"));
        const scenario = createTuiResumeScenario({ home });
        const closed: string[] = [];
        const session = await startTuiTestSession({
            home,
            dependencies: () => ({
                ...scenario.dependencies,
                listSessionPage: async () => ({ agents: [{
                    id: "current-session-id", background_commands: 1,
                } as RegisteredAgentSummary] }),
                closeSession: async (id) => {
                    closed.push(id);
                    return scenario.dependencies.closeSession!(id);
                },
            }),
        });
        try {
            await session.waitForVisiblePane("Start a conversation");
            session.sendKey("C-w");
            await session.waitForVisiblePane("Stop & close");
            for (const key of choice.keys) {
                if (key === "1" || key === "2") session.sendText(key);
                else session.sendKey(key);
            }
            if (choice.closes) {
                await session.waitForVisiblePane("This conversation is idle.");
                expect(closed).toEqual(["current-session-id"]);
            } else {
                await session.waitForVisiblePane("conversation kept running");
                expect(closed).toEqual([]);
            }
        } finally {
            await session.close();
        }
    }
}, 15_000);

test("@core the close picker retains its reason when the turn finishes", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-close-turn-finished-"));
    const scenario = createTuiResumeScenario({ home });
    let push: ((update: AgentUpdate) => void) | undefined;
    const client = createSettingsAnsweringClient({
        agentId: "current-session-id",
        model: "current-model",
        initialUpdates: [{
            type: "history",
            entries: [{ kind: "assistant", text: "TURN IN FLIGHT" }],
            status: "working",
            seq: 0,
        }],
        onCommand: (_, send) => { push = send; },
    });
    const session = await startTuiTestSession({
        home,
        dependencies: () => ({
            ...scenario.dependencies,
            client,
            listSessionPage: async () => { throw new Error("lookup unavailable"); },
        }),
    });
    try {
        await session.waitForVisiblePane("TURN IN FLIGHT");
        expect(push).toBeDefined();
        session.sendKey("C-w");
        await session.waitForVisiblePane("Stop & close");
        push!({ type: "turn_finished", seq: 50 });
        await session.settle(100);
        const pane = session.captureVisiblePane();
        expect(pane.replace(/\s+/g, " "))
            .toContain("stop this conversation and its running turn");
        expect(pane).toContain("Keep running");
    } finally {
        await session.close();
    }
}, 15_000);

test("@core a pending request stays behind the close picker", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-close-pending-"));
    const scenario = createTuiResumeScenario({ home });
    let push: ((update: AgentUpdate) => void) | undefined;
    let finishLookup: (() => void) | undefined;
    const client = createSettingsAnsweringClient({
        agentId: "current-session-id",
        model: "current-model",
        initialUpdates: [{ type: "history", entries: [], seq: 0 }],
        onCommand: (_, send) => { push = send; },
    });
    const session = await startTuiTestSession({
        home,
        dependencies: () => ({
            ...scenario.dependencies,
            client,
            listSessionPage: async () => {
                await new Promise<void>((resolve) => { finishLookup = resolve; });
                return { agents: [{ id: "current-session-id" } as RegisteredAgentSummary] };
            },
        }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-w");
        await session.settle(50);
        expect(push).toBeDefined();
        expect(finishLookup).toBeDefined();
        push!({
            type: "ui_request",
            requestId: "close-question",
            request: {
                type: "user_question",
                question: "Which route?",
                choices: [{ id: "north", label: "North" }],
            },
            seq: 10,
        });
        await session.waitForVisiblePane("Which route?");
        finishLookup!();
        const pane = await session.waitForVisiblePane("Stop & close");
        expect(pane.replace(/\s+/g, " "))
            .toContain("stop this conversation and its running turn");
        session.sendKey("Escape");
        await session.waitForVisiblePaneWhere(
            (visible) => visible.includes("Which route?") && !visible.includes("Stop & close"),
            "the restored pending request",
        );
    } finally {
        await session.close();
    }
}, 15_000);

test("@core an idle conversation with no background commands closes immediately", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-idle-zero-close-"));
    const scenario = createTuiResumeScenario({ home });
    const session = await startTuiTestSession({
        home,
        dependencies: () => ({
            ...scenario.dependencies,
            listSessionPage: async () => ({ agents: [{
                id: "current-session-id",
            } as RegisteredAgentSummary] }),
        }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-w");
        const pane = await session.waitForVisiblePane("This conversation is idle.");
        expect(pane).not.toContain("Stop & close");
    } finally {
        await session.close();
    }
}, 15_000);

test("@core a failed count lookup closes an idle conversation without a warning", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-close-lookup-"));
    const scenario = createTuiResumeScenario({ home });
    const session = await startTuiTestSession({
        home,
        dependencies: () => ({
            ...scenario.dependencies,
            listSessionPage: async () => { throw new Error("lookup unavailable"); },
        }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-w");
        const pane = await session.waitForVisiblePane("This conversation is idle.");
        expect(pane).not.toContain("background command");
        expect(pane).not.toContain("lookup unavailable");
    } finally {
        await session.close();
    }
}, 15_000);

for (const lookup of ["zero", "failed"] as const) {
    test(`@core a ${lookup} count lookup still confirms a working conversation`, async () => {
        const home = mkdtempSync(join(tmpdir(), "vera-tui-working-lookup-"));
        const scenario = createTuiResumeScenario({ home, inFlight: true });
        const session = await startTuiTestSession({
            home,
            dependencies: () => ({
                ...scenario.dependencies,
                listSessionPage: async () => {
                    if (lookup === "failed") throw new Error("lookup unavailable");
                    return { agents: [{ id: "current-session-id" } as RegisteredAgentSummary] };
                },
            }),
        });
        try {
            await session.waitForVisiblePane("TURN IN FLIGHT");
            session.sendKey("C-w");
            const pane = await session.waitForVisiblePane("Stop & close");
            expect(pane.replace(/\s+/g, " "))
                .toContain("stop this conversation and its running turn");
            expect(pane).not.toContain("background command");
            expect(pane).not.toContain("lookup unavailable");
        } finally {
            await session.close();
        }
    }, 15_000);
}

for (const command of ["/clear", "/clear stop"] as const) {
    test(`@core a failed count lookup follows the zero-count ${command} path`, async () => {
        const home = mkdtempSync(join(tmpdir(), "vera-tui-create-lookup-"));
        const scenario = createTuiNewSessionScenario({ home, succeedFirst: true });
        const session = await startTuiTestSession({
            home,
            dependencies: () => ({
                ...scenario.dependencies,
                listSessionPage: async () => { throw new Error("lookup unavailable"); },
            }),
        });
        try {
            await session.waitForVisiblePane("Start a conversation");
            session.sendText(command);
            session.sendKey("Enter");
            if (command === "/clear") {
                const pane = await session.waitForVisiblePane("Close this conversation");
                expect(pane).not.toContain("background command");
                expect(pane).not.toContain("lookup unavailable");
                session.sendText("1");
            }
            const pane = await session.waitForVisiblePane("fresh-model");
            expect(pane).not.toContain("lookup unavailable");
        } finally {
            await session.close();
        }
    }, 15_000);
}

test("@core new-conversation lookup is ignored after switching clients", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-create-switch-"));
    const scenario = createTuiResumeScenario({ home, targetLive: true });
    let finishLookup: (() => void) | undefined;
    let lookups = 0;
    const session = await startTuiTestSession({
        home,
        dependencies: () => ({
            ...scenario.dependencies,
            listSessionPage: async () => {
                lookups += 1;
                if (lookups === 1) {
                    await new Promise<void>((resolve) => { finishLookup = resolve; });
                }
                return { agents: [
                    { id: "current-session-id", background_commands: 1 } as RegisteredAgentSummary,
                    { id: "target-session-id", background_commands: 2 } as RegisteredAgentSummary,
                ] };
            },
        }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-n");
        await session.settle(50);
        expect(finishLookup).toBeDefined();

        session.sendText("/resume");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Continue the theme picker");
        session.sendKey("Up");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Switch, keep running");
        session.sendText("2");
        await session.waitForVisiblePane("RESUMED HISTORY LOADED");
        expect(lookups).toBe(2);

        finishLookup!();
        await session.settle(100);
        expect(session.captureVisiblePane()).not.toContain("Close this conversation");

        session.sendKey("C-n");
        const picker = await session.waitForVisiblePane("Close this conversation");
        expect(picker.replace(/\s+/g, " "))
            .toContain("stop it and its 2 background commands");
        expect(lookups).toBe(3);
    } finally {
        finishLookup?.();
        await session.close();
    }
}, 15_000);

test("@core /clear stop describes stopping its background command", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-background-close-"));
    const scenario = createTuiNewSessionScenario({ home, succeedFirst: true });
    const session = await startTuiTestSession({
        home,
        dependencies: () => ({
            ...scenario.dependencies,
            listSessionPage: async () => ({
                agents: [{
                    id: "current-session-id",
                    background_commands: 1,
                } as RegisteredAgentSummary],
            }),
        }),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/clear stop");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane(
            "stop it and its 1 background command",
        );
        expect(pane).toContain("Close this conversation");
        session.sendKey("Enter");
        await session.waitForVisiblePane("fresh-model");
        session.sendKey("C-c");
        session.sendKey("C-c");
        const exit = await session.waitForSessionExit();
        await scenario.finish(exit);
        expect(readFileSync(join(home, "new-session-result.txt"), "utf8"))
            .toContain("closed current-session-id,new-session-id");
    } finally {
        await session.close();
    }
}, 15_000);

test("@core close after switching shows the destination's background command", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-switch-close-"));
    const registry = new ManagedProcessRegistry();
    const scenario = createTuiResumeScenario({ home, targetLive: true });
    let session: Awaited<ReturnType<typeof startTuiTestSession>> | undefined;
    const listed: string[] = [];
    try {
        for (const id of ["current-session-id", "current-session-id", "target-session-id"]) {
            const result = await registry.scope(id).run({
                command: "sleep 600",
                cwd: process.cwd(),
                env: process.env,
                yieldAfterMs: 0,
                interactive: false,
            });
            expect(result.kind).toBe("running");
        }
        session = await startTuiTestSession({
            home,
            dependencies: () => ({
                ...scenario.dependencies,
                listSessionPage: async () => ({
                    agents: ["current-session-id", "target-session-id"].map((id) => {
                        listed.push(id);
                        return { id, background_commands: registry.liveCount(id) } as RegisteredAgentSummary;
                    }),
                }),
            }),
        });
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/resume");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Continue the theme picker");
        session.sendKey("Up");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Switch, keep running");
        session.sendText("2");
        await session.waitForVisiblePane("RESUMED HISTORY LOADED");
        listed.length = 0;
        session.sendText("/close");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane("Stop & close");
        expect(pane.replace(/\s+/g, " "))
            .toContain("stop this conversation and its 1 background command");
        expect(listed).toContain("target-session-id");
        session.sendKey("Escape");
        await session.waitForVisiblePane("conversation kept running");
        expect(registry.liveCount("current-session-id")).toBe(2);
        expect(registry.liveCount("target-session-id")).toBe(1);
    } finally {
        await session?.close();
        await registry.close();
    }
}, 15_000);

test("@core switch reads background commands after the conversation picker opens", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-background-switch-"));
    const scenario = createTuiResumeScenario({ home });
    let count = 0;
    let lookups = 0;
    let unavailable = false;
    const session = await startTuiTestSession({
        home,
        dependencies: () => ({
            ...scenario.dependencies,
            listSessionPage: async () => {
                lookups++;
                if (unavailable) throw new Error("unavailable");
                return {
                    agents: [{
                        id: "current-session-id",
                        ...(count > 0 ? { background_commands: count } : {}),
                    } as RegisteredAgentSummary],
                };
            },
        }),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/resume");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Continue the theme picker");
        expect(lookups).toBe(0);
        count = 1;
        session.sendKey("Down");
        session.sendKey("Enter");
        const warning = await session.waitForVisiblePane(
            "stop this conversation and its 1 background",
        );
        expect(warning).toContain("command, then open the one you picked");
        expect(lookups).toBe(1);
        session.sendKey("Down");
        await session.settle(50);
        session.sendKey("Up");
        await session.settle(50);
        expect(lookups).toBe(1);
        session.sendKey("Escape");
        await session.waitForVisiblePaneWhere(
            (visible) => visible.includes("Continue the theme picker")
                && !visible.includes("Stop & switch"),
            "the conversation picker after cancelling the leave menu",
        );
        count = 0;
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane("Stop & switch");
        expect(pane).not.toContain("background command");
        expect(lookups).toBe(2);
        session.sendKey("Escape");
        await session.waitForVisiblePaneWhere(
            (visible) => visible.includes("Continue the theme picker")
                && !visible.includes("Stop & switch"),
            "the conversation picker after cancelling again",
        );
        unavailable = true;
        session.sendKey("Enter");
        const fallback = await session.waitForVisiblePane("Stop & switch");
        expect(fallback).not.toContain("unavailable");
        expect(lookups).toBe(3);
    } finally {
        await session.close();
    }
}, 15_000);
