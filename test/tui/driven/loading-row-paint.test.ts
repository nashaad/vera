import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TuiAgentClient } from "../../../clients/tui/main.ts";
import type { HistoryPageResponse } from "../../../src/host/protocol.ts";
import { createSettingsAnsweringClient } from "../../support/settings-answering-client.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

const PAGING = "agent.history-paging.v1";
const LOADING = "Loading earlier history";
const LABEL = /TAIL(\d+)/;

interface InFlightFacts {
    readonly framesShowingRow: number;
    readonly topLabelsWhileInFlight: ReadonlySet<string>;
}

// Samples the frames after a history request is made, while the page is in flight or answered.
async function sampleInFlight(delayMs: number): Promise<InFlightFacts> {
    const devRoot = join(tmpdir(), "vera-dev");
    mkdirSync(devRoot, { recursive: true });
    const home = mkdtempSync(join(devRoot, "tui-loading-row-paint-"));
    const base = createSettingsAnsweringClient({
        agentId: "loading-row-paint-test",
        workspace: "/work/vera",
        model: "loading-row-paint-model",
        mode: "review",
        initialUpdates: [{
            type: "history",
            entries: Array.from({ length: 60 }, (_, index) => ({
                kind: "user" as const,
                text: `TAIL${index}`,
                id: `tail-${index}`,
            })),
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
    let requested = false;
    const client: TuiAgentClient = {
        ...base,
        supportsHostCapability: (capability) => capability === PAGING,
        requestHistoryPage: (before) => {
            requested = true;
            const page: HistoryPageResponse = {
                type: "history_page",
                request_id: "loading-row-paint",
                before,
                entries: [{ kind: "user", text: "OLDER0", id: "older-0" }],
                page: {
                    pageVersion: 1,
                    hasMore: false,
                    olderBefore: "older-0",
                    headId: "tail-59",
                    tailId: "older-0",
                },
            };
            return delayMs === 0
                ? Promise.resolve(page)
                : new Promise<HistoryPageResponse>((resolve) => {
                    setTimeout(() => resolve(page), delayMs);
                });
        },
    };
    const session = await startTuiTestSession({
        home,
        width: 120,
        height: 40,
        dependencies: () => ({ client, listAgents: async () => [] }),
    });
    try {
        await session.waitForVisiblePane("TAIL59");
        for (let press = 0; press < 60 && !requested; press += 1) {
            session.sendKey("C-u");
            await session.settle(20);
        }
        expect(requested).toBe(true);
        let framesShowingRow = 0;
        const topLabelsWhileInFlight = new Set<string>();
        for (let frame = 0; frame < 25; frame += 1) {
            await session.settle(16);
            const pane = session.captureVisiblePane();
            if (pane.includes(LOADING)) framesShowingRow += 1;
            const top = LABEL.exec(pane);
            if (top !== null) topLabelsWhileInFlight.add(top[0]);
        }
        return { framesShowingRow, topLabelsWhileInFlight };
    } finally {
        await session.close();
    }
}

test("the loading row is off screen at the prefetch point while a 150 ms page is in flight", async () => {
    const facts = await sampleInFlight(150);
    expect(facts.framesShowingRow).toBe(0);
    expect(facts.topLabelsWhileInFlight.size).toBe(1);
}, 120_000);

test("the loading row is off screen at the prefetch point when the page answers at once", async () => {
    const facts = await sampleInFlight(0);
    expect(facts.framesShowingRow).toBe(0);
}, 120_000);
