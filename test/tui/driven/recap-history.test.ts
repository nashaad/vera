import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSettingsAnsweringClient } from "../../support/settings-answering-client.ts";
import {
    conversation,
    scrollToRequest,
    settleFor,
    settleUntil,
    switchToNextConversationFromList,
    type TestSession,
} from "../../support/paged-conversation.ts";
import { createTuiResumeScenario } from "../../support/tui-resume-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";
import { saveTuiPersistedAgentPane } from "../../../clients/tui/theme-preference.ts";

const PICKER_MARK = "Search phases";
const FAILED_MARK = "History page request failed: unavailable";

function freshHome(name: string): string {
    const devRoot = join(tmpdir(), "vera-dev");
    mkdirSync(devRoot, { recursive: true });
    return mkdtempSync(join(devRoot, name));
}

function openRecap(session: TestSession): void {
    session.sendText("/recap");
    session.sendKey("Enter");
}

// Sends the command only after the transcript has loaded.
async function openRecapWhenLoaded(session: TestSession, marker: string): Promise<void> {
    await session.waitForVisiblePane(marker);
    await session.settle(60);
    openRecap(session);
}

function occurrences(pane: string, text: string): number {
    return pane.split(text).length - 1;
}

async function reconnectFromPalette(session: TestSession): Promise<void> {
    session.sendKey("C-p");
    await session.waitForVisiblePane("Reconnect host");
    session.sendText("reconnect host");
    session.sendKey("Enter");
}

test("a recap still loading when the conversation changes leaves no output in the next one", async () => {
    const home = freshHome("recap-switch-");
    const scenario = createTuiResumeScenario({ home });
    const first = conversation({
        agentId: "current-session-id",
        tail: "TAIL",
        older: "OLDER",
        reply: "older",
        hold: true,
    });
    const second = conversation({
        agentId: "target-session-id",
        tail: "BTAIL",
        older: "NEXT",
        reply: "older",
        hold: true,
    });
    const session = await startTuiTestSession({
        home,
        width: 120,
        height: 40,
        dependencies: () => ({
            ...scenario.dependencies,
            client: first.client,
            resumeSession: async () => second.client,
        }),
    });
    try {
        await openRecapWhenLoaded(session, "TAIL59");
        await settleUntil(session, () => first.requested.length > 0, "the recap's page request");
        expect(first.requested).toEqual(["tail-0"]);
        await switchToNextConversationFromList(session);
        await session.waitForVisiblePane("BTAIL59");
        await settleFor(session, 300);
        expect(second.requested).toEqual([]);
        const pane = session.captureVisiblePane();
        expect(pane).not.toContain(PICKER_MARK);
        expect(pane).not.toContain("Loading earlier history");
        first.release();
        await settleFor(session, 300);
        expect(session.captureVisiblePane()).not.toContain("OLDER");
        expect(session.captureVisiblePane()).not.toContain(PICKER_MARK);
    } finally {
        first.release();
        second.release();
        await session.close();
    }
}, 30_000);

test("a recap of a long conversation loads its earlier pages before it lists phases", async () => {
    const paged = conversation({
        agentId: "current-session-id",
        tail: "TAIL",
        older: "OLDER",
        reply: "older",
        pages: 3,
    });
    const session = await startTuiTestSession({
        home: freshHome("recap-long-"),
        width: 120,
        height: 40,
        dependencies: () => ({ client: paged.client, listAgents: async () => [] }),
    });
    try {
        await openRecapWhenLoaded(session, "TAIL59");
        await session.waitForVisiblePane(PICKER_MARK);
        expect(paged.requested).toEqual(["tail-0", "older-before-1", "older-before-2"]);
        expect(session.captureVisiblePane()).toContain("OLDER0");
    } finally {
        await session.close();
    }
}, 30_000);

test("a recap jumps to a selected earlier entry", async () => {
    const paged = conversation({
        agentId: "current-session-id", tail: "TAIL", older: "OLDER", reply: "older", pages: 3,
    });
    const session = await startTuiTestSession({
        home: freshHome("recap-jump-"),
        width: 120,
        height: 40,
        dependencies: () => ({ client: paged.client, listAgents: async () => [] }),
    });
    try {
        await openRecapWhenLoaded(session, "TAIL59");
        await session.waitForVisiblePane(PICKER_MARK);
        session.sendText("OLDER0");
        await session.waitForVisiblePane("OLDER0");
        session.sendKey("Enter");
        await session.waitForVisiblePaneWhere(
            (pane) => !pane.includes(PICKER_MARK) && pane.includes("OLDER0"),
            "the earlier recap entry",
        );
    } finally {
        paged.release();
        await session.close();
    }
}, 30_000);

test("a recap that finds a page already out joins it instead of asking again", async () => {
    const paged = conversation({
        agentId: "current-session-id",
        tail: "TAIL",
        older: "OLDER",
        reply: "older",
        hold: true,
    });
    const session = await startTuiTestSession({
        home: freshHome("recap-join-"),
        width: 120,
        height: 40,
        dependencies: () => ({ client: paged.client, listAgents: async () => [] }),
    });
    try {
        await scrollToRequest(session);
        expect(paged.requested).toEqual(["tail-0"]);
        openRecap(session);
        await settleFor(session, 300);
        expect(paged.requested).toEqual(["tail-0"]);
        expect(session.captureVisiblePane()).not.toContain(PICKER_MARK);
        paged.release();
        await session.waitForVisiblePane(PICKER_MARK);
        expect(paged.requested).toEqual(["tail-0"]);
    } finally {
        paged.release();
        await session.close();
    }
}, 30_000);

test("a recap whose page adds nothing reports the failure once", async () => {
    const paged = conversation({
        agentId: "current-session-id",
        tail: "TAIL",
        older: "OLDER",
        reply: "empty",
    });
    const session = await startTuiTestSession({
        home: freshHome("recap-empty-"),
        width: 120,
        height: 40,
        dependencies: () => ({ client: paged.client, listAgents: async () => [] }),
    });
    try {
        await openRecapWhenLoaded(session, "TAIL59");
        await session.waitForVisiblePane(FAILED_MARK);
        await settleFor(session, 300);
        expect(paged.requested).toEqual(["tail-0"]);
        const pane = session.captureVisiblePane();
        expect(occurrences(pane, FAILED_MARK)).toBe(1);
        expect(pane).not.toContain(PICKER_MARK);
    } finally {
        await session.close();
    }
}, 30_000);

test("a recap on a client that cannot page lists the entries it has", async () => {
    const client = createSettingsAnsweringClient({
        agentId: "plain-session-id",
        workspace: "/work/vera",
        model: "paging-model",
        mode: "review",
        initialUpdates: [{
            type: "history",
            entries: Array.from({ length: 5 }, (_, index) => ({
                kind: "user" as const,
                text: `PLAIN${index}`,
                id: `plain-${index}`,
            })),
            seq: 0,
            page: {
                pageVersion: 1,
                hasMore: true,
                olderBefore: "plain-0",
                headId: "plain-4",
                tailId: "plain-4",
            },
        }],
    });
    const session = await startTuiTestSession({
        home: freshHome("recap-plain-"),
        width: 120,
        height: 40,
        dependencies: () => ({ client, listAgents: async () => [] }),
    });
    try {
        await openRecapWhenLoaded(session, "PLAIN4");
        await session.waitForVisiblePane(PICKER_MARK);
        const pane = session.captureVisiblePane();
        expect(pane).toContain("PLAIN0");
        expect(pane).not.toContain("History page request failed");
    } finally {
        await session.close();
    }
}, 30_000);

test("/recap with a held page, focus moves to the side pane, page released, recap output appears", async () => {
    const home = freshHome("recap-focus-");
    const paged = conversation({
        agentId: "current-session-id",
        tail: "TAIL",
        older: "OLDER",
        reply: "older",
        hold: true,
    });
    saveTuiPersistedAgentPane(
        "current-session-id",
        {
            mainAgentId: "current-session-id",
            sidebarAgentId: "recap-sidebar-id",
            owner: "vera.btw",
        },
        join(home, ".vera", "tui.json"),
    );
    const sidebarClient = createSettingsAnsweringClient({
        agentId: "recap-sidebar-id",
        workspace: "/work/vera",
        model: "sidebar-model",
        mode: "auto",
        initialUpdates: [{
            type: "history",
            entries: [{ kind: "assistant", text: "SIDEBAR RECAP TEXT" }],
            seq: 0,
        }],
    });
    // The footer drops its trailing segments on narrower terminals, and the focus cue is one of them.
    const session = await startTuiTestSession({
        home,
        width: 180,
        height: 40,
        dependencies: () => ({
            client: paged.client,
            listAgents: async () => [],
            attachAgent: async () => sidebarClient,
        }),
    });
    try {
        await session.waitForVisiblePane("SIDEBAR RECAP TEXT");
        // Activating the side pane focuses it, so focus returns to the main conversation before the recap starts.
        session.sendKey("C-g");
        await session.waitForVisiblePaneWhere(
            (pane) => pane.includes("Ctrl+G") && !pane.includes("Ctrl+G vera"),
            "the main conversation focused",
        );
        await openRecapWhenLoaded(session, "TAIL59");
        await settleUntil(session, () => paged.requested.length > 0, "the recap's page request");
        session.sendKey("C-g");
        await session.waitForVisiblePane("Ctrl+G vera");
        await settleFor(session, 300);
        paged.release();
        await session.waitForVisiblePane(PICKER_MARK);
        expect(paged.requested).toEqual(["tail-0"]);
    } finally {
        paged.release();
        await session.close();
    }
}, 30_000);

test("a same-session reconnect fails a recap still loading with the history error", async () => {
    const paged = conversation({
        agentId: "current-session-id",
        tail: "TAIL",
        older: "OLDER",
        reply: "older",
        hold: true,
    });
    const reconnected = conversation({
        agentId: "current-session-id",
        tail: "RTAIL",
        older: "ROLDER",
        reply: "older",
    });
    const session = await startTuiTestSession({
        home: freshHome("recap-reconnect-"),
        width: 120,
        height: 40,
        dependencies: () => ({
            client: paged.client,
            listAgents: async () => [],
            reconnectSession: async () => reconnected.client,
        }),
    });
    try {
        await openRecapWhenLoaded(session, "TAIL59");
        await settleUntil(session, () => paged.requested.length > 0, "the recap's page request");
        await reconnectFromPalette(session);
        await session.waitForVisiblePane(FAILED_MARK);
        await settleFor(session, 300);
        const pane = session.captureVisiblePane();
        expect(occurrences(pane, FAILED_MARK)).toBe(1);
        expect(pane).not.toContain(PICKER_MARK);
    } finally {
        paged.release();
        await session.close();
    }
}, 30_000);
