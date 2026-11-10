import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HistoryPageRequestError } from "../../../src/host/attached-client.ts";
import type { HistoryPageResponse } from "../../../src/host/protocol.ts";
import type { TranscriptEntry } from "../../../src/engine/protocol.ts";
import { conversation, settleUntil, switchToNextConversationFromList, type TestSession } from "../../support/paged-conversation.ts";
import { createTuiResumeScenario } from "../../support/tui-resume-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

function freshHome(): string {
    const root = join(tmpdir(), "vera-dev");
    mkdirSync(root, { recursive: true });
    return mkdtempSync(join(root, "reveal-history-"));
}

function revealExtension(home: string): { readonly path: string; readonly resultPath: string } {
    const path = join(home, "reveal-extension");
    const resultPath = join(home, "reveal-result.json");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "vera.extension.json"), JSON.stringify({
        id: "test.reveal-history",
        version: "1.0.0",
        sdk: "1",
        entrypoint: "./extension.ts",
        capabilities: ["client.commands.register", "client.ui.reveal"],
    }));
    writeFileSync(join(path, "extension.ts"), `
        export function activateClient(vera) {
            vera.commands.register({
                name: "reveal-test",
                description: "Reveal a transcript entry",
                usage: "/reveal-test <id>",
                async run({ argumentsText }) {
                    const targets = argumentsText.split(" ").map((id) =>
                        id === "END" ? { end: true } : { entryId: id });
                    try {
                        const results = await Promise.all(targets.map((target) => vera.ui.reveal(target)));
                        await Bun.write(vera.config.resultPath, JSON.stringify({ results }));
                    } catch (error) {
                        await Bun.write(vera.config.resultPath, JSON.stringify({ error: error.message }));
                    }
                    return { kind: "handled" };
                },
            });
        }
    `);
    return { path, resultPath };
}

async function result(session: TestSession, path: string): Promise<unknown> {
    await settleUntil(session, () => existsSync(path), "the reveal result");
    return JSON.parse(readFileSync(path, "utf8"));
}

async function startReveal(
    options: { readonly pages?: number; readonly reply?: "older" | "empty" | Error; readonly hold?: boolean } = {},
) {
    const home = freshHome();
    const extension = revealExtension(home);
    const paged = conversation({
        agentId: "current-session-id", tail: "TAIL", older: "OLDER",
        reply: options.reply ?? "older", pages: options.pages ?? 1, hold: options.hold,
    });
    const session = await startTuiTestSession({
        home, width: 120, height: 40,
        dependencies: () => ({
            client: paged.client,
            listAgents: async () => [],
            clientExtensions: [{ path: extension.path, enabled: true, config: { resultPath: extension.resultPath } }],
        }),
    });
    await session.waitForVisiblePane("TAIL59");
    return { session, paged, ...extension };
}

async function startWithPage(entries: readonly TranscriptEntry[]) {
    const home = freshHome();
    const extension = revealExtension(home);
    const paged = conversation({ agentId: "current-session-id", tail: "TAIL", older: "OLDER", reply: "older" });
    const requested: string[] = [];
    const client = {
        ...paged.client,
        requestHistoryPage: async (before: string): Promise<HistoryPageResponse> => {
            requested.push(before);
            return {
                type: "history_page", request_id: "page", before, entries,
                page: { pageVersion: 1, hasMore: false },
            };
        },
    };
    const session = await startTuiTestSession({
        home, width: 120, height: 40,
        dependencies: () => ({
            client, listAgents: async () => [],
            clientExtensions: [{ path: extension.path, enabled: true, config: { resultPath: extension.resultPath } }],
        }),
    });
    await session.waitForVisiblePane("TAIL59");
    return { session, paged, requested, ...extension };
}

function runReveal(session: TestSession, targets: string): void {
    session.sendText(`/reveal-test ${targets}`);
    session.sendKey("Enter");
}

test("reveal loads several pages and lands on an earlier entry", async () => {
    const { session, paged, resultPath } = await startReveal({ pages: 3 });
    try {
        runReveal(session, "older-0");
        expect(await result(session, resultPath)).toEqual({ results: [true] });
        await session.waitForVisiblePane("OLDER0");
        expect(paged.requested).toEqual(["tail-0", "older-before-1", "older-before-2"]);
    } finally {
        paged.release();
        await session.close();
    }
}, 30_000);

test("reveal returns false after the last page when the id is absent", async () => {
    const { session, paged, resultPath } = await startReveal({ pages: 3 });
    try {
        runReveal(session, "missing");
        expect(await result(session, resultPath)).toEqual({ results: [false] });
        expect(paged.requested).toEqual(["tail-0", "older-before-1", "older-before-2"]);
    } finally {
        paged.release();
        await session.close();
    }
}, 30_000);

test("an absent entry is not confused with another entry from the same message", async () => {
    const { session, paged, resultPath } = await startReveal();
    try {
        runReveal(session, "tail-59#missing");
        expect(await result(session, resultPath)).toEqual({ results: [false] });
        expect(paged.requested).toEqual(["tail-0"]);
    } finally {
        paged.release();
        await session.close();
    }
}, 30_000);

test("reveal lands on an earlier edit entry", async () => {
    const { session, paged, requested, resultPath } = await startWithPage([{
        kind: "presentation", id: "edit-0",
        presentation: { kind: "unified_diff", path: "older-map.txt", patch: "--- a\n+++ b\n@@ -0,0 +1 @@\n+treasure\n" },
    }]);
    try {
        runReveal(session, "edit-0");
        expect(await result(session, resultPath)).toEqual({ results: [true] });
        await session.waitForVisiblePane("older-map.txt");
        expect(requested).toEqual(["tail-0"]);
    } finally {
        paged.release();
        await session.close();
    }
}, 30_000);

for (const id of ["poll-1", "result-1"]) {
    test(`reveal lands on folded activity for ${id}`, async () => {
        const { session, paged, requested, resultPath } = await startWithPage([
            { kind: "tool", id: "poll-0", tool: "process", args: { action: "read", process_id: "process-1" } },
            { kind: "tool_result", id: "result-0", tool: "process", output: "waiting", isError: false },
            { kind: "tool", id: "poll-1", tool: "process", args: { action: "read", process_id: "process-1" } },
            { kind: "tool_result", id: "result-1", tool: "process", output: "finished", isError: false },
        ]);
        try {
            runReveal(session, id);
            expect(await result(session, resultPath)).toEqual({ results: [true] });
            await session.waitForVisiblePane("Waited");
            expect(requested).toEqual(["tail-0"]);
        } finally {
            paged.release();
            await session.close();
        }
    }, 30_000);
}

test("reveal lands on a repeated tool entry folded into an earlier row", async () => {
    const { session, paged, resultPath } = await startWithPage([
        { kind: "tool", id: "read-0", tool: "read", args: { path: "treasure.txt" } },
        { kind: "tool", id: "read-1", tool: "read", args: { path: "treasure.txt" } },
    ]);
    try {
        runReveal(session, "read-1");
        expect(await result(session, resultPath)).toEqual({ results: [true] });
        await session.waitForVisiblePane("treasure.txt");
    } finally {
        paged.release();
        await session.close();
    }
}, 30_000);

test("reveal continues when an empty page advances the cursor", async () => {
    const home = freshHome();
    const extension = revealExtension(home);
    const paged = conversation({ agentId: "current-session-id", tail: "TAIL", older: "OLDER", reply: "older" });
    const requested: string[] = [];
    const client = {
        ...paged.client,
        requestHistoryPage: async (before: string): Promise<HistoryPageResponse> => {
            requested.push(before);
            return before === "tail-0"
                ? { type: "history_page", request_id: "first", before, entries: [], page: { pageVersion: 1, hasMore: true, olderBefore: "next" } }
                : { type: "history_page", request_id: "second", before, entries: [{ kind: "user", id: "older-0", text: "OLDER0" }], page: { pageVersion: 1, hasMore: false } };
        },
    };
    const session = await startTuiTestSession({
        home, width: 120, height: 40,
        dependencies: () => ({
            client, listAgents: async () => [],
            clientExtensions: [{ path: extension.path, enabled: true, config: { resultPath: extension.resultPath } }],
        }),
    });
    try {
        await session.waitForVisiblePane("TAIL59");
        runReveal(session, "older-0");
        expect(await result(session, extension.resultPath)).toEqual({ results: [true] });
        await session.waitForVisiblePane("OLDER0");
        expect(requested).toEqual(["tail-0", "next"]);
    } finally {
        paged.release();
        await session.close();
    }
}, 30_000);

test("reveal rejects if older history exists but cannot be requested", async () => {
    const home = freshHome();
    const extension = revealExtension(home);
    const paged = conversation({ agentId: "current-session-id", tail: "TAIL", older: "OLDER", reply: "older" });
    const client = { ...paged.client, supportsHostCapability: () => false };
    const session = await startTuiTestSession({
        home, width: 120, height: 40,
        dependencies: () => ({
            client, listAgents: async () => [],
            clientExtensions: [{ path: extension.path, enabled: true, config: { resultPath: extension.resultPath } }],
        }),
    });
    try {
        await session.waitForVisiblePane("TAIL59");
        runReveal(session, "missing");
        expect(await result(session, extension.resultPath)).toEqual({ error: "History page request failed: unavailable" });
        expect(paged.requested).toEqual([]);
    } finally {
        paged.release();
        await session.close();
    }
}, 30_000);

test("a reveal returns false when the conversation changes during a page", async () => {
    const home = freshHome();
    const extension = revealExtension(home);
    const scenario = createTuiResumeScenario({ home });
    const first = conversation({ agentId: "current-session-id", tail: "TAIL", older: "OLDER", reply: "older", hold: true });
    const second = conversation({ agentId: "target-session-id", tail: "BTAIL", older: "NEXT", reply: "older" });
    const session = await startTuiTestSession({
        home, width: 120, height: 40,
        dependencies: () => ({
            ...scenario.dependencies,
            client: first.client,
            resumeSession: async () => second.client,
            clientExtensions: [{ path: extension.path, enabled: true, config: { resultPath: extension.resultPath } }],
        }),
    });
    try {
        await session.waitForVisiblePane("TAIL59");
        runReveal(session, "older-0");
        await settleUntil(session, () => first.requested.length > 0, "the page request");
        await switchToNextConversationFromList(session);
        expect(await result(session, extension.resultPath)).toEqual({ results: [false] });
        await session.waitForVisiblePane("BTAIL59");
        expect(session.captureVisiblePane()).not.toContain("OLDER0");
    } finally {
        first.release();
        second.release();
        await session.close();
    }
}, 30_000);

test("a reveal returns false when its client detaches during a page", async () => {
    const home = freshHome();
    const extension = revealExtension(home);
    const paged = conversation({ agentId: "current-session-id", tail: "TAIL", older: "OLDER", reply: "older" });
    const requested: string[] = [];
    const page = Promise.withResolvers<HistoryPageResponse>();
    const client = {
        ...paged.client,
        requestHistoryPage: (before: string) => {
            requested.push(before);
            return page.promise;
        },
        detach: async () => { page.reject(new DOMException("Agent attachment is detached", "AbortError")); },
    };
    const session = await startTuiTestSession({
        home, width: 120, height: 40,
        dependencies: () => ({
            client,
            listAgents: async () => [],
            clientExtensions: [{ path: extension.path, enabled: true, config: { resultPath: extension.resultPath } }],
        }),
    });
    try {
        await session.waitForVisiblePane("TAIL59");
        runReveal(session, "older-0");
        await settleUntil(session, () => requested.length > 0, "the page request");
        await client.detach();
        expect(await result(session, extension.resultPath)).toEqual({ results: [false] });
    } finally {
        paged.release();
        await session.close();
    }
}, 30_000);

for (const reply of [new HistoryPageRequestError("unavailable"), "empty"] as const) {
    test(`reveal rejects when a page ${reply === "empty" ? "makes no progress" : "fails"}`, async () => {
        const { session, paged, resultPath } = await startReveal({ reply });
        try {
            runReveal(session, "missing");
            expect(await result(session, resultPath)).toEqual({ error: "History page request failed: unavailable" });
            expect(paged.requested).toEqual(["tail-0"]);
        } finally {
            paged.release();
            await session.close();
        }
    }, 30_000);
}

test("a newer reveal cancels the first waiter and shares its page", async () => {
    const { session, paged, resultPath } = await startReveal({ hold: true });
    try {
        runReveal(session, "older-0 older-1");
        await settleUntil(session, () => paged.requested.length > 0, "the page request");
        expect(paged.requested).toEqual(["tail-0"]);
        paged.release();
        expect(await result(session, resultPath)).toEqual({ results: [false, true] });
        await session.waitForVisiblePane("OLDER1");
        expect(paged.requested).toEqual(["tail-0"]);
    } finally {
        paged.release();
        await session.close();
    }
}, 30_000);

test("revealing the end resolves true", async () => {
    const { session, paged, resultPath } = await startReveal();
    try {
        session.sendKey("C-u");
        await session.settle(50);
        runReveal(session, "END");
        expect(await result(session, resultPath)).toEqual({ results: [true] });
        await session.waitForVisiblePane("TAIL59");
    } finally {
        paged.release();
        await session.close();
    }
}, 30_000);
