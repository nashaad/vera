import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentUpdate } from "../../../src/engine/protocol.ts";
import { createSettingsAnsweringClient } from "../../support/settings-answering-client.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

interface HistoryEntry {
    kind: "user" | "assistant";
    text: string;
}

function historyEntries(): HistoryEntry[] {
    const out: HistoryEntry[] = [];
    for (let n = 1; n <= 60; n += 1) {
        const id = String(n).padStart(3, "0");
        out.push({ kind: "user", text: `q${id} question` });
        out.push({
            kind: "assistant",
            text: `MED${id} salt wind over the rigging, and a loose halyard end-MED${id}`,
        });
    }
    return out;
}

async function openScrolledToTop(entries: readonly HistoryEntry[]) {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-test-"));
    let push: ((update: AgentUpdate) => void) | undefined;
    const session = await startTuiTestSession({
        home,
        width: 120,
        height: 40,
        dependencies: () => ({
            client: createSettingsAnsweringClient({
                agentId: "resync-session",
                workspace: "/work/vera",
                model: "resync-model",
                mode: "review",
                initialUpdates: [{ type: "history", entries, seq: 0 }],
                onCommand: (command, pushUpdate) => {
                    if (command.type === "prompt") push = pushUpdate;
                },
            }),
            listAgents: async () => [],
        }),
    });
    await session.waitForVisiblePane("MED060");
    session.sendText("go");
    session.sendKey("Enter");
    await session.waitForVisiblePaneWhere(() => push !== undefined, "the prompt reached the client");
    push!({ type: "status", state: "waiting", seq: 1 });
    push!({ type: "turn_finished", seq: 2 });
    await session.settle(60);
    for (let press = 0; press < 90; press += 1) {
        if (session.captureVisiblePane().includes("q001 question")) break;
        session.sendKey("C-u");
        await session.settle(20);
    }
    await session.settle(100);
    expect(session.captureVisiblePane()).toContain("q001 question");
    return { session, push: push! };
}

async function framesAfter(
    session: Awaited<ReturnType<typeof openScrolledToTop>>["session"],
    count: number,
): Promise<string[]> {
    const frames: string[] = [];
    for (let frame = 0; frame < count; frame += 1) {
        await session.settle(1);
        frames.push(session.captureVisiblePane());
    }
    return frames;
}

// The host resends history when a turn ends. A window that stops short of the tail must keep its nodes.
test("a history resync keeps the entries on screen for a reader at the top", async () => {
    const entries = historyEntries();
    const { session, push } = await openScrolledToTop(entries);
    try {
        push({
            type: "history",
            entries: [...entries, { kind: "user", text: "go" }],
            seq: 3,
        });
        const frames = await framesAfter(session, 40);
        const blank = frames.filter((pane) => !pane.includes("q001 question") || !pane.includes("MED001 salt"));
        expect(blank.length).toBe(0);
    } finally {
        await session.close();
    }
}, 60_000);

test("a history resync that changes a later entry rebuilds from that entry on", async () => {
    const entries = historyEntries();
    const { session, push } = await openScrolledToTop(entries);
    try {
        const changed = entries.map((entry, index) =>
            index === 19 ? { ...entry, text: "CHANGED010 the tide table says half past never" } : entry,
        );
        push({ type: "history", entries: changed, seq: 3 });
        const frames = await framesAfter(session, 20);
        expect(frames.filter((pane) => !pane.includes("q001 question")).length).toBe(0);
        let pane = session.captureVisiblePane();
        for (let press = 0; press < 40 && !pane.includes("CHANGED010"); press += 1) {
            session.sendKey("C-d");
            await session.settle(40);
            pane = session.captureVisiblePane();
        }
        expect(pane).toContain("CHANGED010 the tide table");
        expect(pane).not.toContain("MED010 salt");
    } finally {
        await session.close();
    }
}, 60_000);
