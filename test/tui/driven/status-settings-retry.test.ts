import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSettingsAnsweringClient } from "../../support/settings-answering-client.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("a missed model snapshot is asked for again after history", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-test-"));
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 31,
        dependencies: () => ({
            client: createSettingsAnsweringClient({
                agentId: "retry-session",
                workspace: "/work/vera",
                model: "retry-model",
                mode: "auto",
                ignoreFirstModelSettingsRequest: true,
                initialUpdates: [
                    {
                        type: "history",
                        entries: [{ kind: "user", text: "HELLOWORLD" }],
                        seq: 0,
                    },
                    {
                        type: "context",
                        measurement: {
                            tokens: 1_000,
                            capacity: 204_800,
                            estimated: false,
                        },
                        seq: 1,
                    },
                ],
            }),
            listAgents: async () => [],
        }),
    });

    try {
        const pane = await session.waitForVisiblePaneWhere(
            (frame) => frame.includes("retry-model"),
            "the status line names the model",
        );
        expect(pane).toContain("HELLOWORLD");
        expect(pane).not.toContain("loading · LOADING");
    } finally {
        await session.close();
    }
}, 30_000);
