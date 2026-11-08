import { test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startTuiTestSession } from "./tui-harness.ts";
import { createTuiResumeScenario } from "./tui-resume-child.ts";

async function openSession(stallDependencies = false) {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-timeout-"));
    const scenario = createTuiResumeScenario({ home });
    let stallFrame = () => {};
    let markFrameStarted = () => {};
    const frameStarted = new Promise<void>((resolve) => {
        markFrameStarted = resolve;
    });
    const session = await startTuiTestSession({
        home,
        dependencies: (renderer) => {
            stallFrame = () => renderer.setFrameCallback(async () => {
                console.error("frame callback started");
                markFrameStarted();
                await new Promise(() => {});
            });
            return stallDependencies ? new Promise(() => {}) : scenario.dependencies;
        },
    });
    return { session, stallFrame, frameStarted };
}

test("a test times out with an open session", async () => {
    const stage = process.env.VERA_HARNESS_TIMEOUT_STAGE;
    const { session, stallFrame, frameStarted } = await openSession(stage === "dependencies");
    if (stage === "rendered" || stage === "frame") {
        await session.waitForVisiblePane("Start a conversation");
    }
    if (stage === "frame") {
        stallFrame();
        void session.waitForVisiblePane("a pane that never appears").catch(() => undefined);
        await frameStarted;
    }
    console.error("first session opened");
    await new Promise(() => {});
}, 1_000);

test("the next test opens a session", async () => {
    const { session } = await openSession();
    try {
        await session.waitForVisiblePane("Start a conversation");
        console.error("replacement session opened");
    } finally {
        await session.close();
    }
}, 10_000);
