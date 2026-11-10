import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSettingsAnsweringClient } from "../../support/settings-answering-client.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

const VOYAGE_LABEL = /P\d+/;

async function openBurstSession(): Promise<Awaited<ReturnType<typeof startTuiTestSession>>> {
    const devRoot = join(tmpdir(), "vera-dev");
    mkdirSync(devRoot, { recursive: true });
    const home = mkdtempSync(join(devRoot, "tui-burst-blank-"));
    const client = createSettingsAnsweringClient({
        agentId: "burst-blank-test",
        workspace: "/work/vera",
        model: "burst-blank-model",
        mode: "review",
        initialUpdates: [{
            type: "history",
            entries: Array.from({ length: 600 }, (_, index) => ({
                kind: "user" as const,
                text: `P${index}`,
                id: `p-${index}`,
            })),
            seq: 0,
            page: {
                pageVersion: 1,
                hasMore: false,
                olderBefore: "p-0",
                headId: "p-599",
                tailId: "p-599",
            },
        }],
    });
    return startTuiTestSession({
        home,
        width: 120,
        height: 40,
        dependencies: () => ({ client, listAgents: async () => [] }),
    });
}

test("thirty Ctrl+U presses before one frame leave voyages on screen", async () => {
    const session = await openBurstSession();
    try {
        await session.waitForVisiblePane("P599");
        await session.settle(60);
        for (let press = 0; press < 30; press += 1) session.sendKey("C-u");
        const labelled: boolean[] = [];
        for (let frame = 0; frame < 13; frame += 1) {
            await session.settle(40);
            labelled.push(VOYAGE_LABEL.test(session.captureVisiblePane()));
        }
        expect(labelled).toEqual(Array.from({ length: 13 }, () => true));
    } finally {
        await session.close();
    }
}, 120_000);

test("Ctrl+U presses 30 ms apart leave every frame labelled", async () => {
    const session = await openBurstSession();
    try {
        await session.waitForVisiblePane("P599");
        await session.settle(60);
        const labelled: boolean[] = [];
        for (let press = 0; press < 60; press += 1) {
            session.sendKey("C-u");
            await session.settle(30);
            labelled.push(VOYAGE_LABEL.test(session.captureVisiblePane()));
        }
        expect(labelled).toEqual(Array.from({ length: 60 }, () => true));
    } finally {
        await session.close();
    }
}, 120_000);
