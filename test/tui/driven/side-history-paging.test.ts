import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveTuiPersistedAgentPane } from "../../../clients/tui/theme-preference.ts";
import { conversation, type Conversation, type ConversationOptions, type TestSession } from "../../support/paged-conversation.ts";
import { createSettingsAnsweringClient } from "../../support/settings-answering-client.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

async function restoredSidePane(
    options: Omit<ConversationOptions, "agentId" | "reply">,
): Promise<{ readonly session: TestSession; readonly side: Conversation }> {
    const root = join(tmpdir(), "vera-dev");
    mkdirSync(root, { recursive: true });
    const home = mkdtempSync(join(root, "side-paging-"));
    const side = conversation({ ...options, agentId: "side", reply: "older" });
    const main = createSettingsAnsweringClient({
        agentId: "main", workspace: "/work/vera", model: "paging-model", mode: "review",
        initialUpdates: [{ type: "history", seq: 0, entries: [{ kind: "user", text: "MAIN" }] }],
    });
    saveTuiPersistedAgentPane("main", {
        mainAgentId: "main", sidebarAgentId: "side", owner: "vera.btw",
    }, join(home, ".vera", "tui.json"));
    const session = await startTuiTestSession({
        home, width: 180, height: 40,
        dependencies: () => ({ client: main, listAgents: async () => [], attachAgent: async () => side.client }),
    });
    return { session, side };
}

async function climbSidePane(session: TestSession, first: string, rowsPerStep: number): Promise<void> {
    for (let step = 0; step < 240 && !session.captureVisiblePane().includes(first); step += 1) {
        await session.sendMouseWheel("up", 160, 5, rowsPerStep);
        await session.settle(30);
    }
}

test("wheel scrolling a restored side pane reaches its first entry", async () => {
    const { session, side } = await restoredSidePane({ tail: "STAIL", older: "SOLDER", pages: 3 });
    try {
        await session.waitForVisiblePane("STAIL59");
        await climbSidePane(session, "SOLDER0", 4);
        expect(side.requested).toEqual(["stail-0", "solder-before-1", "solder-before-2"]);
        expect(session.captureVisiblePane()).toContain("SOLDER0");
    } finally {
        side.release();
        await session.close();
    }
}, 30_000);

test("the side pane's jump label returns a long history to its tail", async () => {
    const { session, side } = await restoredSidePane({ tail: "JTAIL", older: "JOLDER", tailLength: 200 });
    try {
        await session.waitForVisiblePane("JTAIL199");
        await climbSidePane(session, "JOLDER0", 16);
        expect(session.captureVisiblePane()).toContain("JOLDER0");

        const lines = session.captureVisiblePane().split("\n");
        const row = lines.findIndex((line) => line.includes("Jump to bottom"));
        expect(row).toBeGreaterThanOrEqual(0);
        await session.sendMouseClick((lines[row] ?? "").indexOf("Jump to bottom") + 2, row);
        await session.settle(30);
        await session.settle(30);
        expect(session.captureVisiblePane()).toContain("JTAIL199");
        expect(session.captureVisiblePane()).not.toContain("Jump to bottom");
    } finally {
        side.release();
        await session.close();
    }
}, 30_000);
