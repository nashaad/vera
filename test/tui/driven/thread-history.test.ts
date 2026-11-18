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
import { startTuiTestSession as startTuiWithDependencies } from "../../support/tui-harness.ts";
import { saveTuiPersistedAgentPane } from "../../../clients/tui/theme-preference.ts";

const PICKER_MARK = "Thread history";
const FAILED_MARK = "History page request failed: unavailable";
const THREAD_HISTORY_EXTENSION = join(import.meta.dir, "../../support/fixtures/thread-history-extension");

function startTuiTestSession(options: Parameters<typeof startTuiWithDependencies>[0]) {
    return startTuiWithDependencies({
        ...options,
        dependencies: async (renderer) => ({
            ...await options.dependencies(renderer),
            clientExtensions: [{ path: THREAD_HISTORY_EXTENSION, enabled: true, config: {} }],
        }),
    });
}

function freshHome(name: string): string {
    const devRoot = join(tmpdir(), "vera-dev");
    mkdirSync(devRoot, { recursive: true });
    return mkdtempSync(join(devRoot, name));
}

function openThreadHistory(session: TestSession): void {
    session.sendText("/thread-history");
    session.sendKey("Enter");
}

// Sends the command only after the transcript has loaded.
async function openThreadHistoryWhenLoaded(session: TestSession, marker: string): Promise<void> {
    await session.waitForVisiblePane(marker);
    await session.settle(60);
    openThreadHistory(session);
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

test("a history load during a conversation change leaves no output in the next one", async () => {
    const home = freshHome("thread-switch-");
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
        await openThreadHistoryWhenLoaded(session, "TAIL59");
        await settleUntil(session, () => first.requested.length > 0, "the extension's page request");
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

test("an extension loads every earlier page before reading entries", async () => {
    const paged = conversation({
        agentId: "current-session-id",
        tail: "TAIL",
        older: "OLDER",
        reply: "older",
        pages: 3,
    });
    const session = await startTuiTestSession({
        home: freshHome("thread-long-"),
        width: 120,
        height: 40,
        dependencies: () => ({ client: paged.client, listAgents: async () => [] }),
    });
    try {
        await openThreadHistoryWhenLoaded(session, "TAIL59");
        await session.waitForVisiblePane(PICKER_MARK);
        expect(paged.requested).toEqual(["tail-0", "older-before-1", "older-before-2"]);
        expect(session.captureVisiblePane()).toContain("OLDER0");
    } finally {
        await session.close();
    }
}, 30_000);

test("an extension reveals a selected earlier entry", async () => {
    const paged = conversation({
        agentId: "current-session-id", tail: "TAIL", older: "OLDER", reply: "older", pages: 3,
    });
    const session = await startTuiTestSession({
        home: freshHome("thread-jump-"),
        width: 120,
        height: 40,
        dependencies: () => ({ client: paged.client, listAgents: async () => [] }),
    });
    try {
        await openThreadHistoryWhenLoaded(session, "TAIL59");
        await session.waitForVisiblePane(PICKER_MARK);
        session.sendKey("Tab");
        session.sendText("OLDER0");
        await session.waitForVisiblePaneWhere(
            (pane) => pane.includes("OLDER0") && !pane.includes("OLDER1"),
            "the filtered earlier thread entry",
        );
        session.sendKey("Enter");
        await session.waitForVisiblePaneWhere(
            (pane) => !pane.includes(PICKER_MARK) && pane.includes("OLDER0"),
            "the earlier thread entry",
        );
    } finally {
        paged.release();
        await session.close();
    }
}, 30_000);

test("an extension joins a page already loading instead of asking again", async () => {
    const paged = conversation({
        agentId: "current-session-id",
        tail: "TAIL",
        older: "OLDER",
        reply: "older",
        hold: true,
    });
    const session = await startTuiTestSession({
        home: freshHome("thread-join-"),
        width: 120,
        height: 40,
        dependencies: () => ({ client: paged.client, listAgents: async () => [] }),
    });
    try {
        await scrollToRequest(session);
        expect(paged.requested).toEqual(["tail-0"]);
        openThreadHistory(session);
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

test("an extension reports a page that adds nothing once", async () => {
    const paged = conversation({
        agentId: "current-session-id",
        tail: "TAIL",
        older: "OLDER",
        reply: "empty",
    });
    const session = await startTuiTestSession({
        home: freshHome("thread-empty-"),
        width: 120,
        height: 40,
        dependencies: () => ({ client: paged.client, listAgents: async () => [] }),
    });
    try {
        await openThreadHistoryWhenLoaded(session, "TAIL59");
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

test("an extension reports a rejected history page once", async () => {
    const paged = conversation({
        agentId: "current-session-id",
        tail: "TAIL",
        older: "OLDER",
        reply: new Error("page transport failed"),
    });
    const session = await startTuiTestSession({
        home: freshHome("thread-rejected-"),
        width: 120,
        height: 40,
        dependencies: () => ({ client: paged.client, listAgents: async () => [] }),
    });
    try {
        await openThreadHistoryWhenLoaded(session, "TAIL59");
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

test("an extension on a client that cannot page lists its loaded entries", async () => {
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
        home: freshHome("thread-plain-"),
        width: 120,
        height: 40,
        dependencies: () => ({ client, listAgents: async () => [] }),
    });
    try {
        await openThreadHistoryWhenLoaded(session, "PLAIN4");
        await session.waitForVisiblePane(PICKER_MARK);
        const pane = session.captureVisiblePane();
        expect(pane).toContain("PLAIN0");
        expect(pane).not.toContain("History page request failed");
    } finally {
        await session.close();
    }
}, 30_000);

test("focus can move to the side pane while an extension loads history", async () => {
    const home = freshHome("thread-focus-");
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
            sidebarAgentId: "thread-sidebar-id",
            owner: "vera.btw",
        },
        join(home, ".vera", "tui.json"),
    );
    const sidebarClient = createSettingsAnsweringClient({
        agentId: "thread-sidebar-id",
        workspace: "/work/vera",
        model: "sidebar-model",
        mode: "auto",
        initialUpdates: [{
            type: "history",
            entries: [{ kind: "assistant", text: "SIDEBAR THREAD TEXT" }],
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
        await session.waitForVisiblePane("SIDEBAR THREAD TEXT");
        // Activating the side pane focuses it, so focus returns to the main conversation first.
        session.sendKey("C-g");
        await session.waitForVisiblePaneWhere(
            (pane) => pane.includes("Ctrl+G") && !pane.includes("Ctrl+G vera"),
            "the main conversation focused",
        );
        await openThreadHistoryWhenLoaded(session, "TAIL59");
        await settleUntil(session, () => paged.requested.length > 0, "the extension's page request");
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

test("a same-session reconnect fails an extension history load", async () => {
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
        home: freshHome("thread-reconnect-"),
        width: 120,
        height: 40,
        dependencies: () => ({
            client: paged.client,
            listAgents: async () => [],
            reconnectSession: async () => reconnected.client,
        }),
    });
    try {
        await openThreadHistoryWhenLoaded(session, "TAIL59");
        await settleUntil(session, () => paged.requested.length > 0, "the extension's page request");
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
