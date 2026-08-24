import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TranscriptEntry } from "../../../src/engine/protocol.ts";
import { createSettingsAnsweringClient } from "../../support/settings-answering-client.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

const answer = (marker: string): string =>
    [
        `## ${marker}HEADING`,
        "",
        `- ${marker}ONE`,
        `- ${marker}TWO`,
        "",
        "```ts",
        `const ${marker}CODE = 1;`,
        "```",
    ].join("\n");

// Kept small on purpose: a leaked wasm measure callback per text renderable
// caps how many rows a single test run can build across all its sessions.
const earlier: TranscriptEntry[] = Array.from({ length: 2 }, (_, index) => ({
    kind: "user" as const,
    text: `ROW${index}`,
}));

/**
 * The engine delivers the whole transcript when a turn ends, repeating rows
 * that are already on screen. Those rows have to survive the delivery: a
 * markdown row rebuilt from scratch paints empty for the frame between its
 * construction and its first layout, which is the flash this guards.
 *
 * Both turns run in one session to keep that ceiling in reach.
 */
test("a delivered history keeps finished answers on every frame", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-test-"));
    const delivered: TranscriptEntry[] = [...earlier];
    let finishTurn: (() => void) | undefined;
    let turn = 0;
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 31,
        dependencies: () => ({
            client: createSettingsAnsweringClient({
                agentId: "finalize-session",
                workspace: "/work/vera",
                model: "finalize-model",
                mode: "review",
                initialUpdates: [
                    { type: "history", entries: earlier, seq: 0 },
                ],
                onCommand: (command, push) => {
                    if (command.type !== "prompt") return;
                    turn += 1;
                    const marker = turn === 1 ? "PLAIN" : "TOOLED";
                    const base = turn * 100;
                    push({
                        type: "user_prompt",
                        content: `${marker}PROMPT`,
                        seq: base,
                    });
                    delivered.push({
                        kind: "user",
                        text: `${marker}PROMPT`,
                    });
                    // The second turn runs a tool first, which is the shape
                    // the flash was reported on.
                    if (turn === 2) {
                        const args = { path: "TOOLEDPATH" };
                        push({
                            type: "tool_started",
                            tool: "read_file",
                            args,
                            seq: base + 1,
                        });
                        push({
                            type: "tool_finished",
                            tool: "read_file",
                            output: "TOOLEDOUTPUT",
                            isError: false,
                            seq: base + 2,
                        });
                        delivered.push(
                            { kind: "tool", tool: "read_file", args },
                            {
                                kind: "tool_result",
                                tool: "read_file",
                                output: "TOOLEDOUTPUT",
                                isError: false,
                            },
                        );
                    }
                    push({
                        type: "assistant_delta",
                        text: answer(marker),
                        seq: base + 3,
                    });
                    delivered.push({
                        kind: "assistant",
                        text: answer(marker),
                    });
                    const entries = [...delivered];
                    finishTurn = () => {
                        push({ type: "history", entries, seq: base + 4 });
                        push({
                            type: "status",
                            state: "waiting",
                            seq: base + 5,
                        });
                        push({ type: "turn_finished", seq: base + 6 });
                    };
                },
            }),
            listAgents: async () => [],
        }),
    });

    const framesKeeping = async (marker: string): Promise<number[]> => {
        const missing: number[] = [];
        for (let frame = 0; frame < 40; frame += 1) {
            await session.settle(1);
            if (!session.captureVisiblePane().includes(`${marker}HEADING`)) {
                missing.push(frame);
            }
        }
        return missing;
    };

    try {
        await session.waitForVisiblePane("ROW1");

        session.sendText("go");
        session.sendKey("Enter");
        await session.waitForVisiblePane("PLAINHEADING");
        finishTurn?.();
        expect(await framesKeeping("PLAIN")).toEqual([]);
        expect(session.captureVisiblePane()).toContain("PLAINCODE");

        session.sendText("again");
        session.sendKey("Enter");
        await session.waitForVisiblePane("TOOLEDHEADING");
        finishTurn?.();
        expect(await framesKeeping("TOOLED")).toEqual([]);
        expect(session.captureVisiblePane()).toContain("TOOLEDCODE");
    } finally {
        await session.close();
    }
}, 30_000);
