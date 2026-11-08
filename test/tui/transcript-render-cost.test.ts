import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentUpdate, ClientCommand } from "../../src/engine/protocol.ts";
import { createSettingsAnsweringClient } from "../support/settings-answering-client.ts";
import { startTuiTestSession } from "../support/tui-harness.ts";

const DELTAS = 150;

function history(count: number): AgentUpdate {
    const entries = Array.from({ length: count }, (_, index) => (
        index % 2 === 0
            ? { kind: "user" as const, text: `ROW${index} ${"words ".repeat(12)}` }
            : { kind: "assistant" as const, text: `ANSWER${index} ${"words ".repeat(12)}` }
    ));
    return { type: "history", entries, seq: 0 };
}

async function millisecondsPerDelta(count: number): Promise<number> {
    const home = mkdtempSync(join(tmpdir(), "vera-render-cost-"));
    let push: ((update: AgentUpdate) => void) | undefined;
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 31,
        dependencies: () => ({
            client: createSettingsAnsweringClient({
                agentId: `cost-${count}`,
                workspace: "/work/vera",
                model: "cost-model",
                mode: "review",
                initialUpdates: [history(count)],
                onCommand: (command: ClientCommand, send) => {
                    if (command.type === "prompt") push = send;
                },
            }),
            listAgents: async () => [],
        }),
    });
    try {
        await session.waitForVisiblePane(`ROW${count - 2}`);
        session.sendText("go");
        session.sendKey("Enter");
        await session.settle(300);
        if (push === undefined) throw new Error("prompt never reached the client");
        const send = push;
        const started = performance.now();
        for (let index = 0; index < DELTAS; index += 1) {
            send({
                type: "assistant_delta",
                text: `TOKEN${index} `,
                seq: 1000 + index,
            });
            await Bun.sleep(0);
        }
        await session.waitForVisiblePane(`TOKEN${DELTAS - 1}`);
        return (performance.now() - started) / DELTAS;
    } finally {
        await session.close();
        rmSync(home, { recursive: true, force: true });
    }
}

test("streamed deltas cost the same at 100 and 5000 transcript entries", async () => {
    const small = await millisecondsPerDelta(100);
    const large = await millisecondsPerDelta(5000);
    console.log(`render cost per delta: 100 entries ${small.toFixed(3)} ms, 5000 entries ${large.toFixed(3)} ms`);
    expect(large).toBeLessThan(small * 5);
}, 60_000);
