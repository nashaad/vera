import { expect, test } from "bun:test";
import { mkdtempSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTuiResumeScenario } from "../support/tui-resume-child.ts";
import { startTuiTestSession } from "../support/tui-harness.ts";

const cases = [
    { name: "unwritten", hasSessionFile: false },
    { name: "saved", hasSessionFile: true },
    {
        name: "unwritten while another client is live",
        hasSessionFile: false,
        otherInteractiveAttachments: 1,
    },
] as const;

for (const scenarioOptions of cases) {
    test(`@core closing a ${scenarioOptions.name} idle conversation`, async () => {
        const home = mkdtempSync(join(tmpdir(), "vera-tui-lazy-close-"));
        const scenario = createTuiResumeScenario({
            home,
            ...("otherInteractiveAttachments" in scenarioOptions
                ? { otherInteractiveAttachments: scenarioOptions.otherInteractiveAttachments }
                : {}),
        });
        if (!scenarioOptions.hasSessionFile) {
            unlinkSync(join(home, "sessions", "current.jsonl"));
        }
        const stopped: string[] = [];
        const session = await startTuiTestSession({
            home,
            dependencies: () => ({
                ...scenario.dependencies,
                closeSession: async (id) => {
                    stopped.push(id);
                    return scenario.dependencies.closeSession!(id);
                },
            }),
        });
        try {
            await session.waitForVisiblePane("Start a conversation");
            session.sendKey("C-w");
            const pane = await session.waitForVisiblePane(
                scenarioOptions.hasSessionFile
                    ? "current on disk"
                    : "Start a conversation",
            );
            expect(pane).not.toContain("Could not close this conversation");
            if (scenarioOptions.hasSessionFile) {
                expect(pane).toContain("current on disk");
                expect(stopped).toEqual(["current-session-id"]);
            } else if ("otherInteractiveAttachments" in scenarioOptions) {
                expect(stopped).toEqual([]);
            } else {
                expect(stopped).toEqual(["current-session-id"]);
            }
        } finally {
            await session.close();
        }
    }, 15_000);
}
