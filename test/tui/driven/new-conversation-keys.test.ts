import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTuiNewSessionScenario } from "../../support/tui-new-session-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

for (const digit of ["1", "2"]) {
    test(`new conversation ${digit} starts without Enter and applies its leave choice`, async () => {
        const home = mkdtempSync(join(tmpdir(), "vera-new-keys-"));
        const scenario = createTuiNewSessionScenario({ home, succeedFirst: true });
        const session = await startTuiTestSession({ home, dependencies: () => scenario.dependencies });
        try {
            await session.waitForVisiblePane("current-model");
            session.sendText("/clear");
            session.sendKey("Enter");
            await session.waitForVisiblePane("Close this conversation");
            if (digit === "1") session.sendKey("Down");
            session.sendText(digit);
            const pane = await session.waitForVisiblePane("fresh-model");
            expect(pane).not.toContain("Close this conversation");
            session.sendKey("C-c");
            await scenario.finish(await session.waitForSessionExit());
            expect(readFileSync(join(home, "new-session-result.txt"), "utf8")).toBe(
                "new-session-id\ndetached\nnext detached\nattempts 1\n/work/vera\nclosed "
                    + (digit === "1" ? "current-session-id,new-session-id" : "new-session-id"),
            );
        } finally {
            await session.close();
        }
    }, 15_000);
}
