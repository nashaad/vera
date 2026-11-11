import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    type TuiAgentClient,
    type TuiDependencies,
} from "../../../clients/tui/main.ts";
import { createInProcessChannel } from "../../../src/engine/message-channel.ts";
import type { ClientCommand } from "../../../src/engine/protocol.ts";
import { runHeadlessLoop } from "../../../src/engine/run-turn.ts";
import { HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE } from "../../../src/host/capabilities.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
} from "../../../src/model/types.ts";
import type { AgentUpdate } from "../../../src/engine/protocol.ts";
import { FauxAdapter } from "../../support/faux-adapter.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

const AGENT_ID = "019f8d27-4206-7f61-9123-a65fa174d97c";

interface DetachHarness {
    readonly dependencies: TuiDependencies;
    /** Policies the client released its attachment with, in order. */
    readonly released: string[];
    /** Session ids the client asked the host to stop. */
    readonly closed: string[];
    readonly sent: ClientCommand[];
    /** Updates the host-side loop emitted, including after the viewer left. */
    readonly emitted: AgentUpdate[];
    readonly turnFinished: () => boolean;
    readonly waitForTurnFinished: () => Promise<void>;
}

/**
 * A conversation whose engine runs beside the TUI the way a resident host
 * does: closing the viewer does not end the loop.
 */
function detachHarness(answers: readonly string[]): DetachHarness {
    const released: string[] = [];
    const closed: string[] = [];
    const sent: ClientCommand[] = [];
    const emitted: AgentUpdate[] = [];
    const channel = createInProcessChannel();
    const adapter: ModelAdapter = new FauxAdapter(
        answers.map(response),
        { chunkSize: 1, delayMs: 40 },
    );
    const tap = {
        send(update: AgentUpdate): void {
            emitted.push(update);
            channel.engine.send(update);
        },
        receive: (signal?: AbortSignal) => channel.engine.receive(signal),
    };
    void runHeadlessLoop(
        tap,
        adapter,
        "test",
        "high",
        { approvalMode: "auto" },
        {
            readModelSettings: () => ({ model: "test", reasoningEffort: "high" }),
            readApprovalMode: () => "auto",
            updateApprovalMode: async () => undefined,
            router: { updateModelSettings: async () => undefined },
        },
    );
    const turnFinished = (): boolean =>
        emitted.some((update) => update.type === "turn_finished");
    const waitForTurnFinished = async (): Promise<void> => {
        const deadline = Date.now() + 10_000;
        while (!turnFinished()) {
            if (Date.now() > deadline) throw new Error("turn never finished");
            await Bun.sleep(20);
        }
    };

    const client: TuiAgentClient = {
        agentId: AGENT_ID,
        supportsHostCapability: (capability: string): boolean =>
            capability === HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE,
        async send(command): Promise<void> {
            sent.push(command);
            channel.client.send(command);
        },
        receive: (signal) => channel.client.receive(signal),
        async release(policy) {
            released.push(policy);
            return { outcome: "detached" as const, remainingInteractiveClients: 0 };
        },
        async detach(): Promise<void> {},
        close(): void {},
    };

    return {
        dependencies: {
            client,
            async closeSession(agentId) {
                closed.push(agentId);
                return { status: "closed", sessionRetained: true };
            },
        },
        released,
        closed,
        sent,
        emitted,
        turnFinished,
        waitForTurnFinished,
    };
}

function turnRunning(pane: string): boolean {
    return pane.includes("Ctrl+X h keys") && !pane.includes("Ctrl+P commands");
}

function response(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

test("Ctrl+X D exits with keep_running while the turn is still running", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-detach-turn-"));
    const harness = detachHarness([
        "The crow leaves the wheel spinning and watches from the mast",
    ]);
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => harness.dependencies,
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("sail through the squall");
        session.sendKey("Enter");
        await session.waitForVisiblePaneWhere(turnRunning, "turn running");

        session.sendKey("C-x");
        await session.waitForVisiblePane("d Detach");
        session.sendText("d");

        const exit = await session.waitForSessionExit();
        expect(exit.agentId).toBe(AGENT_ID);
        expect(harness.released).toEqual(["keep_running"]);
        expect(harness.closed).toEqual([]);
        expect(harness.sent.some((command) => command.type === "abort"))
            .toBe(false);
        // The viewer is gone but the turn is still going.
        expect(harness.turnFinished()).toBe(false);
        await harness.waitForTurnFinished();
    } finally {
        await session.close();
    }
}, 15_000);

test("detaching an idle conversation leaves it live", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-detach-idle-"));
    const harness = detachHarness(["Ready when you are"]);
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => harness.dependencies,
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("say hello");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Ready when you are");

        session.sendKey("C-x");
        session.sendText("d");

        const exit = await session.waitForSessionExit();
        expect(exit.agentId).toBe(AGENT_ID);
        expect(harness.released).toEqual(["keep_running"]);
        expect(harness.closed).toEqual([]);
        expect(harness.sent.some((command) => command.type === "abort"))
            .toBe(false);
    } finally {
        await session.close();
    }
}, 15_000);

test("detaching during a stop sends no second abort and keeps the conversation", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-detach-stopping-"));
    const harness = detachHarness(["SLOW ANSWER"]);
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => harness.dependencies,
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("a long errand");
        session.sendKey("Enter");
        await session.waitForVisiblePaneWhere(turnRunning, "turn running");

        session.sendKey("Escape");
        await session.waitForVisiblePane("stopping…");
        session.sendKey("C-x");
        session.sendText("d");

        await session.waitForSessionExit();
        expect(harness.released).toEqual(["keep_running"]);
        expect(harness.closed).toEqual([]);
        expect(harness.sent.filter((command) => command.type === "abort"))
            .toHaveLength(1);
    } finally {
        await session.close();
    }
}, 15_000);

test("with the command palette open, Ctrl+X D does nothing", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-detach-overlay-"));
    const harness = detachHarness(["Ready when you are"]);
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => harness.dependencies,
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-p");
        await session.waitForVisiblePane("Commands");
        session.sendKey("C-x");
        session.sendText("d");
        await session.settle(80);

        expect(harness.released).toEqual([]);
        expect(session.captureVisiblePane()).toContain("Commands");

        session.sendKey("Escape");
        await session.settle();
        session.sendKey("C-x");
        session.sendText("d");
        await session.waitForSessionExit();
        expect(harness.released).toEqual(["keep_running"]);
    } finally {
        await session.close();
    }
}, 15_000);

test("detaching does not send the composer draft", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-detach-draft-"));
    const harness = detachHarness(["Ready when you are"]);
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => harness.dependencies,
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("say hello");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Ready when you are");
        session.sendText("half a thought");
        await session.waitForVisiblePane("half a thought");

        session.sendKey("C-x");
        session.sendText("d");
        await session.waitForSessionExit();

        expect(harness.released).toEqual(["keep_running"]);
        expect(harness.sent.some((command) =>
            command.type === "prompt" && command.content === "half a thought"
        )).toBe(false);
    } finally {
        await session.close();
    }
}, 15_000);
