import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AsyncQueue } from "../../../src/engine/async-queue.ts";
import type { AgentUpdate } from "../../../src/engine/protocol.ts";
import type { TuiAgentClient } from "../../../clients/tui/main.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

function createPushClient(
    entries: readonly { kind: "user"; text: string }[],
): { client: TuiAgentClient; push: (update: AgentUpdate) => void } {
    const updates = new AsyncQueue<AgentUpdate>();
    let seq = 1;
    updates.push({ type: "history", entries, seq });
    const client: TuiAgentClient = {
        agentId: "reseed-test",
        workspace: "/work/vera",
        async send() {},
        receive(signal) {
            return updates.receive(signal);
        },
        async detach() {},
        close() {},
    };
    return {
        client,
        push(update) {
            updates.push({ ...update, seq: (seq += 1) } as AgentUpdate);
        },
    };
}

test("a history rebuild while scrolled up paints no empty transcript", async () => {
    const devRoot = join(tmpdir(), "vera-dev");
    mkdirSync(devRoot, { recursive: true });
    const home = mkdtempSync(join(devRoot, "tui-reseed-"));
    const entries = Array.from({ length: 300 }, (_, index) => ({
        kind: "user" as const,
        text: `ROW${index}`,
    }));
    const { client, push } = createPushClient(entries);
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 31,
        dependencies: () => ({ client, listAgents: async () => [] }),
    });
    const transcriptRows = (pane: string): number => pane.split("\n")
        .filter((line) => /ROW\d+|NEW\d+/.test(line)).length;
    try {
        await session.waitForVisiblePane("ROW299");
        await session.settle(60);
        for (let step = 0; step < 10; step += 1) {
            session.sendKey("C-u");
            await session.settle(0);
        }
        expect(transcriptRows(session.captureVisiblePane())).toBeGreaterThan(0);
        push({
            type: "history",
            entries: Array.from({ length: 300 }, (_, index) => ({
                kind: "user" as const,
                text: `NEW${index}`,
            })),
            seq: 2,
        });
        for (let frame = 0; frame < 4; frame += 1) {
            const pane = session.captureVisiblePane();
            expect(transcriptRows(pane), `frame ${frame}`).toBeGreaterThan(0);
            await session.settle(0);
        }
    } finally {
        await session.close();
    }
}, 60_000);
