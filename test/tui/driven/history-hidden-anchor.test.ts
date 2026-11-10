import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TuiAgentClient } from "../../../clients/tui/main.ts";
import type { HistoryPageResponse } from "../../../src/host/protocol.ts";
import { createSettingsAnsweringClient } from "../../support/settings-answering-client.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

const PAGING = "agent.history-paging.v1";
const GROUP_HEADER = /\bExplored\b/;

function voyage(prefix: string, index: number): string {
    const head = `${prefix}${index}`;
    return [head, ...Array.from({ length: 7 }, (_, line) => `${head} line ${line}`)].join("\n");
}

function groupHeaderRow(pane: string): number | undefined {
    const row = pane.split("\n").findIndex((line) => GROUP_HEADER.test(line));
    return row === -1 ? undefined : row;
}

test("a landing page leaves a collapsed tool group at the top on its row", async () => {
    const devRoot = join(tmpdir(), "vera-dev");
    mkdirSync(devRoot, { recursive: true });
    const home = mkdtempSync(join(devRoot, "tui-hidden-anchor-"));
    // Completed reads fold under their header, so their call and result rows are hidden.
    const group = [
        { kind: "tool" as const, tool: "read", args: { path: "/work/group-a.ts" }, id: "call-a" },
        { kind: "tool_result" as const, tool: "read", output: "alpha\nbeta\ngamma", isError: false, id: "result-a" },
        { kind: "tool" as const, tool: "read", args: { path: "/work/group-b.ts" }, id: "call-b" },
        { kind: "tool_result" as const, tool: "read", output: "delta\nepsilon\nzeta", isError: false, id: "result-b" },
    ];
    const tail = [
        ...group,
        ...Array.from({ length: 60 }, (_, index) => ({
            kind: "user" as const,
            text: voyage("TAIL", index),
            id: `tail-${index}`,
        })),
    ];
    const older = Array.from({ length: 100 }, (_, index) => ({
        kind: "user" as const,
        text: voyage("OLDER", index),
        id: `older-${index}`,
    }));
    const base = createSettingsAnsweringClient({
        agentId: "hidden-anchor-test",
        workspace: "/work/vera",
        model: "hidden-anchor-model",
        mode: "review",
        initialUpdates: [{
            type: "history",
            entries: tail,
            seq: 0,
            page: { pageVersion: 1, hasMore: true, olderBefore: "tail-0", headId: "tail-59", tailId: "tail-59" },
        }],
    });
    let requested = false;
    const gate: { release?: () => void } = {};
    const client: TuiAgentClient = {
        ...base,
        supportsHostCapability: (capability) => capability === PAGING,
        requestHistoryPage: (before) => {
            requested = true;
            return new Promise<HistoryPageResponse>((resolve) => {
                gate.release = () => resolve({
                    type: "history_page",
                    request_id: "hidden-anchor-test",
                    before,
                    entries: older,
                    page: { pageVersion: 1, hasMore: true, olderBefore: "older-0", headId: "tail-59", tailId: "tail-59" },
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
    try {
        await session.waitForVisiblePane("TAIL59");
        await session.settle(60);
        for (let press = 0; press < 80 && !requested; press += 1) {
            session.sendKey("C-u");
            await session.settle(30);
        }
        expect(requested).toBe(true);
        for (let press = 0; press < 3; press += 1) {
            session.sendKey("C-u");
            await session.settle(30);
        }
        const before = groupHeaderRow(session.captureVisiblePane());
        expect(before).toBeDefined();

        gate.release?.();
        const landed: (number | undefined)[] = [];
        for (let sample = 0; sample < 24; sample += 1) {
            await session.settle(25);
            landed.push(groupHeaderRow(session.captureVisiblePane()));
        }
        const drift = landed.map((row) =>
            row === undefined || before === undefined
                ? Number.POSITIVE_INFINITY
                : Math.abs(row - before)
        );
        expect(Math.max(...drift)).toBeLessThanOrEqual(1);
    } finally {
        gate.release?.();
        await session.close();
    }
}, 120_000);
