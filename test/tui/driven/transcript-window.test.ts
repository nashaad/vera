import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentUpdate } from "../../../src/engine/protocol.ts";
import { createSettingsAnsweringClient } from "../../support/settings-answering-client.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("a dropped reasoning row leaves the transcript", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-test-"));
    let finishTurn: (() => void) | undefined;
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 31,
        dependencies: () => ({
            client: createSettingsAnsweringClient({
                agentId: "window-session",
                workspace: "/work/vera",
                model: "window-model",
                mode: "review",
                onCommand: (command, push) => {
                    if (command.type !== "prompt") return;
                    push({ type: "user_prompt", content: "ASKQUESTION", seq: 1 });
                    push({
                        type: "assistant_thinking",
                        text: "REASONINGROW",
                        seq: 2,
                    });
                    // The turn ends in a later batch, so the reasoning row is
                    // built and laid out before anything drops it.
                    finishTurn = () => {
                        push({ type: "status", state: "waiting", seq: 3 });
                        push({ type: "turn_finished", seq: 4 });
                    };
                },
            }),
            listAgents: async () => [],
        }),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("go");
        session.sendKey("Enter");
        await session.waitForVisiblePane("REASONINGROW");
        finishTurn?.();
        const pane = await session.waitForVisiblePaneWhere(
            (frame) => !frame.includes("REASONINGROW"),
            "the reasoning row is gone",
        );
        expect(pane).toContain("ASKQUESTION");
    } finally {
        await session.close();
    }
}, 30_000);

test("a resize keeps the reader on the entry they were reading", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-test-"));
    const entries = Array.from({ length: 400 }, (_, index) => ({
        kind: "user" as const,
        text: `ROW${index} ${"wordy ".repeat(40)}`,
    }));
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 31,
        dependencies: () => ({
            client: createSettingsAnsweringClient({
                agentId: "resize-session",
                workspace: "/work/vera",
                model: "resize-model",
                mode: "review",
                initialUpdates: [{ type: "history", entries, seq: 0 }],
            }),
            listAgents: async () => [],
        }),
    });

    try {
        await session.waitForVisiblePane("ROW399");
        for (let step = 0; step < 12; step += 1) {
            session.sendKey("C-u");
            await session.settle(20);
        }
        for (let step = 0; step < 4; step += 1) {
            session.sendKey("C-d");
            await session.settle(20);
        }
        const topmost = (pane: string): string | undefined =>
            pane.split("\n")
                // The session title carries the first entry's text, which is
                // not where the reader is.
                .filter((line) => !line.includes("Session:"))
                .map((line) => /ROW(\d+)/.exec(line)?.[1])
                .find((row) => row !== undefined);
        const anchor = topmost(session.captureVisiblePane());
        expect(anchor).toBeDefined();

        session.resize(64, 31);
        await session.settle(120);
        await session.settle(120);
        // The anchored entry is put back in view; whether the tail of the
        // entry before it still fits above depends on the new wrap.
        const settledTop = topmost(session.captureVisiblePane());
        expect(settledTop).toBeDefined();
        expect(Number(settledTop)).toBeGreaterThanOrEqual(Number(anchor) - 1);
        expect(Number(settledTop)).toBeLessThanOrEqual(Number(anchor));
    } finally {
        await session.close();
    }
}, 30_000);

test("scrolling up and back down returns the transcript to where it was", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-test-"));
    const entries = Array.from({ length: 300 }, (_, index) => {
        if (index % 3 === 0) {
            return {
                kind: "user" as const,
                text: `ROW${index} ${"wordy ".repeat(30)}`,
            };
        }
        if (index % 3 === 1) {
            return {
                kind: "tool" as const,
                tool: "read",
                args: { path: `/work/row-${index}.ts` },
            };
        }
        return {
            kind: "tool_result" as const,
            tool: "read",
            output: `ROW${index} ${"wordy ".repeat(30)}`,
            isError: false,
        };
    });
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 31,
        dependencies: () => ({
            client: createSettingsAnsweringClient({
                agentId: "drift-session",
                workspace: "/work/vera",
                model: "drift-model",
                mode: "review",
                initialUpdates: [{ type: "history", entries, seq: 0 }],
            }),
            listAgents: async () => [],
        }),
    });

    try {
        await session.waitForVisiblePane("ROW297");
        await session.settle(120);
        const atTail = session.captureVisiblePane();
        for (let step = 0; step < 40; step += 1) {
            session.sendKey("C-u");
            await session.settle(20);
        }
        session.sendKeyWithModifiers("end", { ctrl: true });
        await session.settle(200);
        await session.settle(200);
        expect(session.captureVisiblePane()).toBe(atTail);
    } finally {
        await session.close();
    }
}, 30_000);

test("scrolling up never carries the reader back down a page", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-test-"));
    const entries = Array.from({ length: 300 }, (_, index) => (
        index % 2 === 0
            ? { kind: "user" as const, text: `ROW${index} ${"wordy ".repeat(30)}` }
            : {
                kind: "tool_result" as const,
                tool: "read",
                output: `ROW${index} ${"wordy ".repeat(30)}`,
                isError: false,
            }
    ));
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 31,
        dependencies: () => ({
            client: createSettingsAnsweringClient({
                agentId: "updrift-session",
                workspace: "/work/vera",
                model: "updrift-model",
                mode: "review",
                initialUpdates: [{ type: "history", entries, seq: 0 }],
            }),
            listAgents: async () => [],
        }),
    });

    const topmost = (pane: string): number | undefined => {
        const found = pane.split("\n")
            .filter((line) => !line.includes("Session:"))
            .map((line) => /ROW(\d+)/.exec(line)?.[1])
            .find((row) => row !== undefined);
        return found === undefined ? undefined : Number(found);
    };

    try {
        await session.waitForVisiblePane("ROW294");
        await session.settle(120);
        let previous = topmost(session.captureVisiblePane()) ?? 299;
        for (let step = 0; step < 90; step += 1) {
            session.sendKey("C-u");
            await session.settle(30);
            const current = topmost(session.captureVisiblePane());
            if (current === undefined) continue;
            expect(current).toBeLessThanOrEqual(previous);
            previous = current;
        }
        expect(previous).toBe(0);
    } finally {
        await session.close();
    }
}, 60_000);
