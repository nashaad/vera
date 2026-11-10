import type { TuiAgentClient } from "../../clients/tui/main.ts";
import type { HistoryPageResponse } from "../../src/host/protocol.ts";
import { createSettingsAnsweringClient } from "./settings-answering-client.ts";
import type { startTuiTestSession } from "./tui-harness.ts";

export const PAGING = "agent.history-paging.v1";
export const TAIL_LENGTH = 60;
const OLDER_PAGE_SIZE = 3;

export type TestSession = Awaited<ReturnType<typeof startTuiTestSession>>;

export interface Conversation {
    readonly client: TuiAgentClient;
    readonly requested: string[];
    readonly release: () => void;
}

export interface ConversationOptions {
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
    /** Older pages the host holds, nearest the tail first. Defaults to one page that ends the history. */
    readonly pages?: number;
    /** Rows in the first page. Defaults to TAIL_LENGTH. */
    readonly tailLength?: number;
}

export function conversation(options: ConversationOptions): Conversation {
    const idPrefix = options.tail.toLowerCase();
    const olderPrefix = options.older.toLowerCase();
    const requested: string[] = [];
    const held: Array<() => void> = [];
    const pageCount = options.pages ?? 1;
    let answered = 0;
    const tailLength = options.tailLength ?? TAIL_LENGTH;
    const tail = Array.from({ length: tailLength }, (_, index) => ({
        kind: "user" as const,
        text: `${options.tail}${index}`,
        id: `${idPrefix}-${index}`,
    }));
    const headId = `${idPrefix}-${tailLength - 1}`;
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
        // Pages are answered oldest last, so the first answer holds the highest indexes.
        const page = answered;
        answered += 1;
        const low = (pageCount - 1 - page) * OLDER_PAGE_SIZE;
        const high = low + OLDER_PAGE_SIZE - 1;
        const oldest = page === pageCount - 1;
        return {
            type: "history_page",
            request_id: `${idPrefix}-page`,
            before,
            entries: Array.from({ length: OLDER_PAGE_SIZE }, (_, index) => ({
                kind: "user" as const,
                text: `${options.older}${low + index}`,
                id: `${olderPrefix}-${low + index}`,
            })),
            page: oldest
                ? { pageVersion: 1, hasMore: false, headId, tailId: `${olderPrefix}-${high}` }
                : {
                    pageVersion: 1,
                    hasMore: true,
                    olderBefore: `${olderPrefix}-before-${page + 1}`,
                    headId,
                    tailId: `${olderPrefix}-${high}`,
                },
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

export async function switchToNextConversation(session: TestSession): Promise<void> {
    session.sendText("/resume");
    session.sendKey("Enter");
    await session.waitForVisiblePane("Continue the theme picker");
    session.sendKey("Down");
    session.sendKey("Enter");
    // Enter confirms SESSION_LEAVE_OPTIONS[0], Stop & switch.
    await session.waitForVisiblePane("Stop & switch");
    session.sendKey("Enter");
}

// Ctrl+E opens the same list outside the /resume submit guard, so it works while an extension command runs.
export async function switchToNextConversationFromList(session: TestSession): Promise<void> {
    session.sendKey("C-e");
    await session.waitForVisiblePane("Continue the theme picker");
    session.sendKey("Down");
    session.sendKey("Enter");
    // Enter confirms SESSION_LEAVE_OPTIONS[0], Stop & switch.
    await session.waitForVisiblePane("Stop & switch");
    session.sendKey("Enter");
}

export async function moveToTailAfterSwitch(session: TestSession): Promise<void> {
    await session.waitForVisiblePane("BTAIL59");
    session.sendKeyWithModifiers("end", { ctrl: true });
}

export async function scrollUntilPaneShows(session: TestSession, text: string): Promise<void> {
    for (let step = 0; step < 60; step += 1) {
        if (session.captureVisiblePane().includes(text)) return;
        session.sendKey("C-u");
        await session.settle(30);
    }
    throw new Error(`${text} never came on screen`);
}

export async function wheelUp(session: TestSession): Promise<void> {
    await session.sendMouseWheel("up", 20, 5);
    await session.settle(30);
}

export async function settleFor(session: TestSession, ms: number): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until) await session.settle(50);
}

export async function settleUntil(
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

export async function scrollUntilLoadingRowShows(session: Awaited<ReturnType<typeof startTuiTestSession>>): Promise<void> {
    for (let step = 0; step < 30; step += 1) {
        session.sendKey("C-u");
        await session.settle(0);
        if (session.captureVisiblePane().includes("Loading earlier history")) return;
    }
    throw new Error("the loading row never came on screen");
}

export async function scrollToRequest(
    session: Awaited<ReturnType<typeof startTuiTestSession>>,
    marker = "TAIL59",
): Promise<void> {
    await session.waitForVisiblePane(marker);
    await session.settle(60);
    await scrollUntilLoadingRowShows(session);
}
