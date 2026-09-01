import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTuiRewindDependencies } from "../../support/tui-rewind-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

function ctxShare(pane: string): string | undefined {
    return pane.match(/ctx ~?(\S+)/)?.[1];
}

test("rewind drops the status ctx share before the next send", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-rewind-ctx-"));
    const session = await startTuiTestSession({
        home,
        width: 120,
        height: 32,
        dependencies: () => createTuiRewindDependencies({
            contextWindow: 32_768,
        }),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("hi");
        session.sendKey("Enter");
        await session.waitForVisiblePane("FIRST ANSWER");
        const afterFirst = await session.waitForVisiblePane("ctx ~");
        const firstShare = ctxShare(afterFirst);
        expect(firstShare).toBeDefined();

        session.sendText(`read this ${"x".repeat(12_000)}`);
        session.sendKey("Enter");
        await session.waitForVisiblePane("SECOND ANSWER");
        const afterSecond = await session.waitForVisiblePaneWhere(
            (current) => {
                const share = ctxShare(current);
                return share !== undefined && share !== firstShare;
            },
            "status ctx grew after the fat prompt",
        );
        const secondShare = ctxShare(afterSecond);
        expect(secondShare).not.toBe(firstShare);

        session.sendText("/rewind");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Rewind: select a point");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Rewind conversation");
        session.sendText("1");
        await session.waitForVisiblePane("Confirm rewind");
        session.sendKey("Enter");
        const afterRewind = await session.waitForVisiblePaneWhere(
            (current) => current.includes("FIRST ANSWER")
                && !current.includes("SECOND ANSWER")
                && !current.includes("Confirm rewind")
                && ctxShare(current) !== secondShare,
            "rewound occupancy before the next send",
        );
        expect(afterRewind).toContain("FIRST ANSWER");
        expect(afterRewind).not.toContain("SECOND ANSWER");
        expect(ctxShare(afterRewind)).toBe(firstShare);
    } finally {
        await session.close();
    }
}, 20_000);
