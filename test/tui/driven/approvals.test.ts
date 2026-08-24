import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createTuiAutoReviewDependencies,
} from "../../support/tui-auto-review-child.ts";
import {
    createTuiApprovalDependencies,
} from "../../support/tui-approval-child.ts";
import {
    createTuiChildApprovalDependencies,
} from "../../support/tui-child-approval-child.ts";
import {
    createTuiQuestionDependencies,
} from "../../support/tui-question-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("auto reviews a boundary crossing without asking the user", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-auto-review-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiAutoReviewDependencies(home),
    });
    let pane = "";

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("run the routine command");
        session.sendKey("Enter");

        pane = await session.waitForVisiblePane("AUTO REVIEW COMPLETED");
        expect(readFileSync(join(home, "auto-review-invoked"), "utf8"))
            .toBe("allowed\n");
        expect(pane).toContain(
            "Auto review approved bash (risk: low, authorization: high):",
        );
        expect(pane.replace(/\s+/g, " ")).toContain(
            "Routine command requested by the user.",
        );
        // `env` prints as many lines as the machine has variables, so
        // the row is pinned by its command and its details hint.
        expect(pane).toContain("Ran  env AUTO_REVIEW=ran");
        expect(pane).toContain("ctrl+t details");
        expect(pane).toContain("auto");
        expect(pane).not.toContain("Permission required");
        expect(pane).not.toContain("Allow once");
    } finally {
        await session.close();
    }
}, 15_000);

test("approval actions stay visible above long details", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-approval-layout-"));
    const session = await startTuiTestSession({
        home,
        width: 42,
        height: 10,
        dependencies: () => createTuiApprovalDependencies(),
    });
    let pane = "";

    try {
        pane = await session.waitForVisiblePane("Allow once");
        expect(pane).toContain("Permission required");
        expect(pane).toContain("$ grep");
        expect(pane).not.toContain("approval required ·");
        expect(pane).not.toContain("gpt-5.6-sol");

        // Down moves the highlight across the answers, so the details
        // scroll by page.
        for (let index = 0; index < 20; index += 1) {
            session.sendKey("NPage");
        }
        pane = await session.waitForVisiblePaneWhere(
            (current) => current.includes(
                "Session and always are unavailable.",
            ) && !current.includes("$ grep"),
            "scrolled approval actions",
        );
        expect(pane).toContain("Allow once");
        expect(pane).not.toContain("$ grep");
    } finally {
        await session.close();
    }
}, 15_000);

test("an extension modal cannot intercept a native approval answer", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-approval-priority-"));
    const mountedPath = join(home, "extension-modal-mounted");
    const interceptedPath = join(home, "extension-modal-intercepted");
    const session = await startTuiTestSession({
        home,
        width: 80,
        height: 18,
        dependencies: () => ({
            ...createTuiApprovalDependencies(),
            disabledBuiltinExtensions: [
                "vera.model-presets",
                "vera.reasoning-cycle",
            ],
            clientExtensions: [{
                path: join(
                    import.meta.dir,
                    "../../support/fixtures/priority-modal-extension",
                ),
                enabled: true,
                config: { mountedPath, interceptedPath },
            }],
        }),
    });

    try {
        await session.waitForVisiblePane("Allow once");
        for (let attempt = 0; attempt < 100; attempt += 1) {
            if (existsSync(mountedPath)) break;
            await Bun.sleep(10);
        }
        expect(readFileSync(mountedPath, "utf8")).toBe("mounted");

        session.sendKey("1");
        const pane = await session.waitForVisiblePane("RESPONSE AFTER APPROVAL");
        expect(pane).not.toContain("Permission required");
        expect(existsSync(interceptedPath)).toBe(false);
    } finally {
        await session.close();
    }
}, 15_000);

test("child approval shows only exact allow and deny", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-child-approval-"));
    const session = await startTuiTestSession({
        home,
        width: 80,
        height: 18,
        dependencies: () => createTuiChildApprovalDependencies(),
    });
    let pane = "";

    try {
        pane = await session.waitForVisiblePane("Requested by agent 5a5d7460");
        expect(pane).toContain("Task: Write the child approval marker");
        expect(pane).toContain("1 Allow once");
        expect(pane).toContain("3 Deny");
        expect(pane).not.toContain("2 Session");
        expect(pane).not.toContain("4 Always");
        expect(pane).not.toContain("session prefix");
        expect(pane).not.toContain("ask.default");

        session.sendKey("1");
        await session.waitForVisiblePaneWhere(
            (current) => !current.includes("Requested by agent"),
            "closed child approval",
        );
    } finally {
        await session.close();
    }
}, 15_000);

test("user question accepts a digit immediately and restores composer focus", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-question-"));
    const session = await startTuiTestSession({
        home,
        width: 42,
        height: 20,
        dependencies: () => createTuiQuestionDependencies(),
    });
    let pane = "";

    try {
        pane = await session.waitForVisiblePane("1. Preview");
        expect(pane).toContain("Which release channel");
        expect(pane).toContain("recommended");
        expect(pane).toContain("Ships weekly.");
        expect(pane).toContain("2. Stable");
        expect(pane).toContain("3. Nightly");
        expect(pane.indexOf("1. Preview")).toBeLessThan(pane.indexOf("2. Stable"));
        expect(pane.indexOf("recommended")).toBeGreaterThan(
            pane.indexOf("1. Preview"),
        );
        expect(pane.indexOf("recommended")).toBeLessThan(pane.indexOf("2. Stable"));
        expect(pane).not.toContain("question waiting");
        expect(pane).not.toContain("gpt-5.6-sol");
        // The reproduction for the status-line collision: above the short
        // terminal threshold the overlay clears the status line's row, so
        // its final line of key hints survives instead of being drawn over.
        // The 42x10 approval test covers the other side of the threshold,
        // where the row goes back to the content.
        expect(pane).toContain("esc dismiss");

        session.sendText("1");
        pane = await session.waitForVisiblePane(
            "Selection received: preview-channel",
        );
        expect(pane).not.toContain("esc dismiss");

        session.sendText("focus restored");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("FOCUS RESTORED");
        expect(pane).toContain("focus restored");
    } finally {
        await session.close();
    }
}, 15_000);
