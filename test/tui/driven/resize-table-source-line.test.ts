import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSettingsAnsweringClient } from "../../support/settings-answering-client.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

const HEIGHT = 40;

test("source rows remain anchored inside Markdown tables", async () => {
    const phrase = "the pirate crow checks the harbour ledger";
    const rows = Array.from({ length: 150 }, (_, index) => {
        const tag = `R${String(index + 1).padStart(3, "0")}`;
        return `| ${tag} | ${tag} ${phrase}${index % 5 === 0 ? ` ${phrase} ${phrase}` : ""} |`;
    });
    const text = ["| Log | Note |", "| --- | --- |", ...rows].join("\n");
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-tui-test-")),
        width: 120,
        height: HEIGHT,
        dependencies: () => ({
            client: createSettingsAnsweringClient({
                agentId: "resize-table",
                model: "resize-anchor-model",
                mode: "auto",
                initialUpdates: [{ type: "history", entries: [{ kind: "assistant", text }], seq: 0 }],
            }),
            listAgents: async () => [],
        }),
    });
    try {
        await session.waitForVisiblePane("R150");
        for (let press = 0; press < 12; press += 1) {
            session.sendKey("C-u");
            await session.settle(30);
        }
        for (let step = 0; step < 8 && !/R\d{3}/.test(session.captureVisiblePane().split("\n")[1]!); step += 1) {
            session.sendKeyWithModifiers("up", { ctrl: true });
            await session.settle(50);
        }
        const before = /R\d{3}/.exec(session.captureVisiblePane().split("\n")[1]!)?.[0];
        expect(before).toBeDefined();
        for (const width of [70, 120]) {
            session.resize(width, HEIGHT);
            await session.settle(150);
            await session.settle(150);
            expect(session.captureVisiblePane().split("\n")[1]).toContain(before!);
        }
    } finally {
        await session.close();
    }
}, 30_000);
