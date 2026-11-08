import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { startTuiTestSession } from "../../support/tui-harness.ts";
import { createTuiResumeScenario } from "../../support/tui-resume-child.ts";

test("a timed-out test releases its session for the next test", () => {
    for (const stage of ["dependencies", "startup", "rendered", "frame"]) {
        const childHome = mkdtempSync(join(process.env.VERA_HOME ?? tmpdir(), "harness-child-"));
        const child = Bun.spawnSync([
            process.execPath,
            "test",
            resolve(import.meta.dir, "..", "..", "support", "tui-harness-timeout-child.ts"),
        ], {
            env: { ...process.env, VERA_HOME: childHome, VERA_HARNESS_TIMEOUT_STAGE: stage },
            stdout: "pipe",
            stderr: "pipe",
            timeout: 15_000,
            killSignal: "SIGKILL",
        });
        const output = child.stdout.toString() + child.stderr.toString();
        expect(child.exitCode).toBe(1);
        expect(output).toContain("first session opened");
        expect(output).toContain("replacement session opened");
        expect(output).toContain("this test timed out");
        if (stage === "frame") expect(output).toContain("frame callback started");
        expect(output).toContain("1 pass");
        expect(output).toContain("1 fail");
        expect(output).not.toContain("A TUI test session is already open");
    }
}, 70_000);

test("a stalled render obeys the pane wait deadline", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-render-timeout-"));
    const scenario = createTuiResumeScenario({ home });
    let releaseFrame = () => {};
    const blockedFrame = new Promise<void>((resolve) => {
        releaseFrame = resolve;
    });
    let stallFrame = () => {};
    let frameStarted = false;
    const session = await startTuiTestSession({
        home,
        waitTimeoutMs: 750,
        dependencies: (renderer) => {
            stallFrame = () => renderer.setFrameCallback(async () => {
                frameStarted = true;
                await blockedFrame;
            });
            return scenario.dependencies;
        },
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        stallFrame();
        await expect(session.waitForVisiblePane("a pane that never appears"))
            .rejects.toThrow("Timed out waiting for visible");
        expect(frameStarted).toBe(true);
    } finally {
        releaseFrame();
        await session.close();
    }
}, 10_000);
