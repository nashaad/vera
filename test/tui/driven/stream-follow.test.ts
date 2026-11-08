import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentUpdate } from "../../../src/engine/protocol.ts";
import { createSettingsAnsweringClient } from "../../support/settings-answering-client.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

const LINES = 260;
const CHUNK_CHARS = 26;
const CHUNK_INTERVAL_MS = 6;

function reply(): string {
    return Array.from(
        { length: LINES },
        (_, index) =>
            `LINE${String(index + 1).padStart(3, "0")} the pirate crow charts the cove at dusk`,
    ).join("\n");
}

function newestLine(pane: string): number {
    const numbers = [...pane.matchAll(/LINE(\d{3})/g)].map((match) => Number(match[1]));
    return numbers.length === 0 ? 0 : Math.max(...numbers);
}

test("a fast stream keeps the body within a few lines of the newest text", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-test-"));
    const text = reply();
    let delivered = 0;
    let streaming: ReturnType<typeof setInterval> | undefined;
    const session = await startTuiTestSession({
        home,
        width: 120,
        height: 31,
        dependencies: () => ({
            client: createSettingsAnsweringClient({
                agentId: "stream-follow",
                workspace: "/work/vera",
                model: "stream-model",
                mode: "review",
                onCommand: (command, push) => {
                    if (command.type !== "prompt") return;
                    let seq = 1;
                    push({ type: "user_prompt", content: "tell a long story", seq });
                    push({ type: "status", state: "working", seq: (seq += 1) });
                    streaming = setInterval(() => {
                        if (delivered >= text.length) {
                            clearInterval(streaming);
                            push({ type: "status", state: "idle", seq: (seq += 1) });
                            push({ type: "turn_finished", seq: (seq += 1) });
                            return;
                        }
                        const update: AgentUpdate = {
                            type: "assistant_delta",
                            text: text.slice(delivered, delivered + CHUNK_CHARS),
                            seq: (seq += 1),
                        };
                        delivered += CHUNK_CHARS;
                        push(update);
                    }, CHUNK_INTERVAL_MS);
                },
            }),
            listAgents: async () => [],
        }),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("go");
        session.sendKey("Enter");
        await session.waitForVisiblePane("tell a long story");

        let worstLag = 0;
        let frozenFor = 0;
        let longestFrozen = 0;
        let previousNewest = 0;
        while (delivered < text.length) {
            await session.settle(25);
            const deliveredLines = text.slice(0, delivered).split("\n").length;
            const newest = newestLine(session.captureVisiblePane());
            if (deliveredLines > 120) {
                worstLag = Math.max(worstLag, deliveredLines - newest);
                frozenFor = newest === previousNewest ? frozenFor + 25 : 0;
                longestFrozen = Math.max(longestFrozen, frozenFor);
            }
            previousNewest = newest;
        }
        clearInterval(streaming);

        expect(worstLag).toBeLessThanOrEqual(25);
        expect(longestFrozen).toBeLessThan(500);
    } finally {
        clearInterval(streaming);
        await session.close();
    }
}, 60_000);
