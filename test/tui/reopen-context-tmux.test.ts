import { expect, test } from "bun:test";
import { startReopenTmux } from "../support/reopen-tmux.ts";

test("resuming shows the stored request estimate in the footer", async () => {
    const session = startReopenTmux("context");
    try {
        const pane = await session.waitFor((value) => value.includes("The crow is aboard.") && value.includes("ctx"), "resumed conversation");
        expect(pane).toContain("ctx ~8.5k");
    } finally {
        await session.close();
    }
}, 15_000);
