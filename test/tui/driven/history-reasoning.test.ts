import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emptyUsage } from "../../../src/model/types.ts";
import { SessionStore } from "../../../src/store/session-store.ts";
import { createTuiChildDependencies } from "../../support/tui-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("Ctrl+O opens a saved reasoning row after resume", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-reasoning-resume-"));
    const sessionPath = join(home, "sessions", "resume.jsonl");
    const store = await SessionStore.create(sessionPath, { sessionId: "crow", cwd: home });
    await store.appendMessage({ role: "user", content: [{ type: "text", text: "find the island" }] });
    await store.appendMessage({
        role: "assistant",
        content: [
            { type: "thinking", text: "Follow the northern stars." },
            { type: "text", text: "Sail north." },
        ],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    });
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => createTuiChildDependencies({ resumeSessionPath: sessionPath }),
    });
    try {
        let pane = await session.waitForVisiblePane("Reasoning summary");
        expect(pane).toContain("Reasoning summary  Ctrl+O reasoning");
        expect(pane).not.toContain("Follow the northern stars.");
        expect(pane).not.toMatch(/Reasoning summary: \d/);
        session.sendKey("C-o");
        pane = await session.waitForVisiblePane("Follow the northern stars.");
        expect(pane).toContain("Ctrl+O hide reasoning");
        await session.waitForVisiblePane("Sail north.");
    } finally {
        await session.close();
    }
}, 15_000);
