import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TuiAgentClient } from "../../../clients/tui/main.ts";
import { HistoryPageRequestError } from "../../../src/host/attached-client.ts";
import type { HistoryPageResponse } from "../../../src/host/protocol.ts";
import { createSettingsAnsweringClient } from "../../support/settings-answering-client.ts";
import { createTuiResumeScenario } from "../../support/tui-resume-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

const PAGING = "agent.history-paging.v1";
const TAIL_LENGTH = 60;

interface PagedSession {
    readonly session: Awaited<ReturnType<typeof startTuiTestSession>>;
    readonly requestedBefore: () => string | undefined;
    readonly release: () => void;
}

async function startPagedSession(olderCount: number): Promise<PagedSession> {
    const devRoot = join(tmpdir(), "vera-dev");
    mkdirSync(devRoot, { recursive: true });
    const home = mkdtempSync(join(devRoot, "tui-paging-"));
    const tail = Array.from({ length: TAIL_LENGTH }, (_, index) => ({
        kind: "user" as const,
        text: `TAIL${index}`,
        id: `tail-${index}`,
    }));
    const older = Array.from({ length: olderCount }, (_, index) => ({
        kind: "user" as const,
        text: `OLDER${index}`,
        id: `older-${index}`,
    }));
    const base = createSettingsAnsweringClient({
        agentId: "paging-test",
        workspace: "/work/vera",
        model: "paging-model",
        mode: "review",
        initialUpdates: [{
            type: "history",
            entries: tail,
            seq: 0,
            page: {
                pageVersion: 1,
                hasMore: true,
                olderBefore: "tail-0",
                headId: "tail-59",
                tailId: "tail-59",
            },
        }],
    });
    let requestedBefore: string | undefined;
    let resolvePage: (() => void) | undefined;
    const client: TuiAgentClient = {
        ...base,
        supportsHostCapability: (capability) => capability === PAGING,
        requestHistoryPage: (before) => {
            requestedBefore = before;
            return new Promise<HistoryPageResponse>((resolve) => {
                resolvePage = () => resolve({
                    type: "history_page",
                    request_id: "history-page-test",
                    before,
                    entries: older,
                    page: {
                        pageVersion: 1,
                        hasMore: false,
                        olderBefore: `older-0`,
                        headId: "tail-59",
                        tailId: `older-${older.length - 1}`,
                    },
                });
            });
        },
    };
    const session = await startTuiTestSession({
        home,
        width: 120,
        height: 40,
        dependencies: () => ({ client, listAgents: async () => [] }),
    });
    return {
        session,
        requestedBefore: () => requestedBefore,
        release: () => resolvePage?.(),
    };
}

function topTail(pane: string): number | undefined {
    const found = pane.split("\n")
        .filter((line) => !line.includes("Session:"))
        .map((line) => /TAIL(\d+)/.exec(line)?.[1])
        .find((row) => row !== undefined);
    return found === undefined ? undefined : Number(found);
}

function transcriptRows(pane: string): number {
    return pane.split("\n")
        .filter((line) => !line.includes("Session:"))
        .filter((line) => /(TAIL|OLDER)\d+/.test(line)).length;
}

function entryRow(pane: string, tail: number): number | undefined {
    const index = pane.split("\n").findIndex((line) =>
        new RegExp(`TAIL${tail}(?!\\d)`).test(line)
    );
    return index === -1 ? undefined : index;
}

async function scrollUntilLoadingRowShows(session: Awaited<ReturnType<typeof startTuiTestSession>>): Promise<void> {
    for (let step = 0; step < 30; step += 1) {
        session.sendKey("C-u");
        await session.settle(0);
        if (session.captureVisiblePane().includes("Loading earlier history")) return;
    }
    throw new Error("the loading row never came on screen");
}

async function scrollToRequest(
    session: Awaited<ReturnType<typeof startTuiTestSession>>,
    marker = "TAIL59",
): Promise<void> {
    await session.waitForVisiblePane(marker);
    await session.settle(60);
    await scrollUntilLoadingRowShows(session);
}

test("Ctrl+D keeps its movement when a page arrives", async () => {
    const paged = await startPagedSession(60);
    try {
        await scrollToRequest(paged.session);
        expect(paged.requestedBefore()).toBe("tail-0");
        expect(paged.session.captureVisiblePane()).toContain("Loading earlier history…");
        for (let step = 0; step < 6; step += 1) {
            paged.session.sendKey("C-d");
            await paged.session.settle(0);
        }
        const beforeReply = topTail(paged.session.captureVisiblePane());
        expect(beforeReply).toBeGreaterThan(0);
        paged.release();
        await paged.session.waitForVisiblePaneWhere(
            (pane) => !pane.includes("Loading earlier history"),
            "page reply",
        );
        expect(topTail(paged.session.captureVisiblePane())).toBe(beforeReply);
        paged.session.sendKey("C-d");
        await paged.session.settle(0);
        expect(topTail(paged.session.captureVisiblePane())).toBeGreaterThan(beforeReply!);
    } finally {
        paged.release();
        await paged.session.close();
    }
}, 30_000);

test("plain scroll-up paints no empty transcript", async () => {
    const paged = await startPagedSession(60);
    try {
        await paged.session.waitForVisiblePane("TAIL59");
        await paged.session.settle(60);
        for (let step = 0; step < 14; step += 1) {
            paged.session.sendKey("C-u");
            await paged.session.settle(0);
            const pane = paged.session.captureVisiblePane();
            expect(transcriptRows(pane), `step ${step}`).toBeGreaterThan(0);
        }
    } finally {
        paged.release();
        await paged.session.close();
    }
}, 30_000);

test("the loading row keeps the reader's place", async () => {
    const paged = await startPagedSession(60);
    try {
        await paged.session.waitForVisiblePane("TAIL59");
        await paged.session.settle(60);
        await scrollToRequest(paged.session);
        expect(paged.requestedBefore()).toBe("tail-0");
        const shown = paged.session.captureVisiblePane();
        expect(shown).toContain("Loading earlier history…");
        const top = topTail(shown);
        expect(top).toBeDefined();
        const rowBefore = entryRow(shown, top!);
        paged.release();
        await paged.session.waitForVisiblePaneWhere(
            (pane) => !pane.includes("Loading earlier history"),
            "page reply",
        );
        const rowAfter = entryRow(paged.session.captureVisiblePane(), top!);
        expect(rowAfter).toBeDefined();
        expect(Math.abs(rowAfter! - rowBefore!)).toBeLessThanOrEqual(2);
    } finally {
        paged.release();
        await paged.session.close();
    }
}, 30_000);

for (const olderCount of [1, 60]) {
    test(`a page reply with ${olderCount} entries paints no empty transcript`, async () => {
        const paged = await startPagedSession(olderCount);
        try {
            await scrollToRequest(paged.session);
            expect(paged.requestedBefore()).toBe("tail-0");
            expect(paged.session.captureVisiblePane()).toContain("Loading earlier history…");
            paged.release();
            await paged.session.waitForVisiblePaneWhere(
                (pane) => !pane.includes("Loading earlier history"),
                "page reply",
            );
            for (let frame = 0; frame < 4; frame += 1) {
                const pane = paged.session.captureVisiblePane();
                expect(transcriptRows(pane)).toBeGreaterThan(0);
                await paged.session.settle(0);
            }
        } finally {
            paged.release();
            await paged.session.close();
        }
    }, 30_000);
}

type TestSession = Awaited<ReturnType<typeof startTuiTestSession>>;

const TOO_LARGE_TEXT = "Earlier history is too large to show.";

interface Conversation {
    readonly client: TuiAgentClient;
    readonly requested: string[];
    readonly release: () => void;
}

interface ConversationOptions {
    readonly agentId: string;
    /** Prefixes the loaded tail, so two conversations never share a row. */
    readonly tail: string;
    readonly older: string;
    /** "older" answers with rows from before the tail, "empty" with a page that adds nothing, and an Error rejects. */
    readonly reply: "older" | "empty" | Error;
    /** Holds each answer until release(). */
    readonly hold?: boolean;
    /** Requests past this many never settle, so a retry loop stops and the count assertion reports it. */
    readonly settleLimit?: number;
}

function conversation(options: ConversationOptions): Conversation {
    const idPrefix = options.tail.toLowerCase();
    const olderPrefix = options.older.toLowerCase();
    const requested: string[] = [];
    const held: Array<() => void> = [];
    const tail = Array.from({ length: TAIL_LENGTH }, (_, index) => ({
        kind: "user" as const,
        text: `${options.tail}${index}`,
        id: `${idPrefix}-${index}`,
    }));
    const headId = `${idPrefix}-${TAIL_LENGTH - 1}`;
    const base = createSettingsAnsweringClient({
        agentId: options.agentId,
        workspace: "/work/vera",
        model: "paging-model",
        mode: "review",
        initialUpdates: [{
            type: "history",
            entries: tail,
            seq: 0,
            page: {
                pageVersion: 1,
                hasMore: true,
                olderBefore: `${idPrefix}-0`,
                headId,
                tailId: headId,
            },
        }],
    });
    const answer = (before: string): HistoryPageResponse => {
        if (options.reply === "empty") {
            return {
                type: "history_page",
                request_id: `${idPrefix}-page`,
                before,
                entries: [],
                page: { pageVersion: 1, hasMore: true, olderBefore: before, headId, tailId: headId },
            };
        }
        return {
            type: "history_page",
            request_id: `${idPrefix}-page`,
            before,
            entries: Array.from({ length: 3 }, (_, index) => ({
                kind: "user" as const,
                text: `${options.older}${index}`,
                id: `${olderPrefix}-${index}`,
            })),
            page: { pageVersion: 1, hasMore: false, headId, tailId: `${olderPrefix}-2` },
        };
    };
    return {
        client: {
            ...base,
            supportsHostCapability: (capability) => capability === PAGING,
            requestHistoryPage: (before) => {
                requested.push(before);
                if (options.settleLimit !== undefined && requested.length > options.settleLimit) {
                    return new Promise<HistoryPageResponse>(() => {});
                }
                if (options.reply instanceof Error) return Promise.reject(options.reply);
                return new Promise<HistoryPageResponse>((resolve) => {
                    const send = (): void => resolve(answer(before));
                    if (options.hold === true) held.push(send);
                    else send();
                });
            },
        },
        requested,
        release: () => {
            for (const send of held.splice(0)) send();
        },
    };
}

async function switchToNextConversation(session: TestSession): Promise<void> {
    session.sendText("/resume");
    session.sendKey("Enter");
    await session.waitForVisiblePane("Continue the theme picker");
    session.sendKey("Down");
    session.sendKey("Enter");
    // Enter confirms SESSION_LEAVE_OPTIONS[0], Stop & switch.
    await session.waitForVisiblePane("Stop & switch");
    session.sendKey("Enter");
}

async function moveToTailAfterSwitch(session: TestSession): Promise<void> {
    await session.waitForVisiblePane("BTAIL59");
    session.sendKeyWithModifiers("end", { ctrl: true });
}

async function scrollUntilPaneShows(session: TestSession, text: string): Promise<void> {
    for (let step = 0; step < 60; step += 1) {
        if (session.captureVisiblePane().includes(text)) return;
        session.sendKey("C-u");
        await session.settle(30);
    }
    throw new Error(`${text} never came on screen`);
}

async function settleFor(session: TestSession, ms: number): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until) await session.settle(50);
}

async function settleUntil(
    session: TestSession,
    done: () => boolean,
    what: string,
): Promise<void> {
    for (let step = 0; step < 100; step += 1) {
        if (done()) return;
        await session.settle(50);
    }
    throw new Error(`timed out waiting for ${what}`);
}

async function countSearchRequests(reply: "empty" | Error): Promise<number> {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-paging-search-"));
    const paged = conversation({
        agentId: "paging-test",
        tail: "TAIL",
        older: "OLDER",
        reply,
        settleLimit: 6,
    });
    const session = await startTuiTestSession({
        home,
        width: 120,
        height: 40,
        dependencies: () => ({
            client: paged.client,
            listAgents: async () => [],
            searchSessions: async () => ({
                truncated: false,
                results: [{
                    session_id: "paging-test",
                    session_path: join(home, "sessions", "paged.jsonl"),
                    title: "a paged conversation",
                    workspace: "/work/vera",
                    updated_at: "2026-11-06T10:00:00.000Z",
                    hits: [{
                        kind: "user_message" as const,
                        snippet: "OLDER42",
                        entry_id: "older-42",
                    }],
                }],
            }),
        }),
    });
    try {
        await session.waitForVisiblePane("TAIL59");
        await session.settle(60);
        session.sendKey("C-f");
        await session.waitForVisiblePane("Search");
        session.sendText("OLDER42");
        await session.waitForVisiblePane("a paged conversation");
        session.sendKey("Enter");
        await settleUntil(session, () => paged.requested.length > 0, "the first page request");
        // The target is never loaded, so every request after the first is a retry.
        await settleFor(session, 2_500);
        return paged.requested.length;
    } finally {
        paged.release();
        await session.close();
    }
}

test("a page still out when the conversation changes does not hold paging in the next one", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-paging-switch-"));
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
        older: "BOLDER",
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
        await scrollToRequest(session);
        expect(first.requested).toEqual(["tail-0"]);
        await switchToNextConversation(session);
        await moveToTailAfterSwitch(session);
        await scrollToRequest(session, "BTAIL59");
        expect(second.requested).toEqual(["btail-0"]);
        second.release();
        await scrollUntilPaneShows(session, "BOLDER0");
        first.release();
        await settleFor(session, 300);
        expect(session.captureVisiblePane().replace(/BOLDER/g, "")).not.toContain("OLDER");
    } finally {
        first.release();
        second.release();
        await session.close();
    }
}, 30_000);

test("a too-large page does not turn paging off in the next conversation", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-paging-blocked-"));
    const scenario = createTuiResumeScenario({ home });
    const first = conversation({
        agentId: "current-session-id",
        tail: "TAIL",
        older: "OLDER",
        reply: new HistoryPageRequestError("page_too_large"),
    });
    const second = conversation({
        agentId: "target-session-id",
        tail: "BTAIL",
        older: "BOLDER",
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
        await session.waitForVisiblePane("TAIL59");
        await session.settle(60);
        await scrollUntilPaneShows(session, TOO_LARGE_TEXT);
        expect(first.requested).toEqual(["tail-0"]);
        await switchToNextConversation(session);
        await moveToTailAfterSwitch(session);
        await session.waitForVisiblePane("BTAIL59");
        expect(session.captureVisiblePane()).not.toContain(TOO_LARGE_TEXT);
        await scrollToRequest(session, "BTAIL59");
        expect(second.requested).toEqual(["btail-0"]);
        second.release();
        await scrollUntilPaneShows(session, "BOLDER0");
    } finally {
        second.release();
        await session.close();
    }
}, 30_000);

test("a search target no page reaches asks for one request per retry window", async () => {
    const requests = await countSearchRequests("empty");
    expect(requests).toBeGreaterThanOrEqual(1);
    expect(requests).toBeLessThanOrEqual(4);
}, 30_000);

test("a search target asks no faster than one retry window while the attachment is closed", async () => {
    const requests = await countSearchRequests(new Error("Agent attachment is closed"));
    expect(requests).toBeGreaterThanOrEqual(1);
    expect(requests).toBeLessThanOrEqual(4);
}, 30_000);
