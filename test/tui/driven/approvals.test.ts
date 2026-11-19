import { expect, test } from "bun:test";
import { TextAttributes } from "@opentui/core";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createTuiAutoReviewDependencies,
} from "../../support/tui-auto-review-child.ts";
import {
    createTuiApprovalDependencies,
    createTuiSwitchApprovalDependencies,
} from "../../support/tui-approval-child.ts";
import {
    createTuiChildApprovalDependencies,
} from "../../support/tui-child-approval-child.ts";
import {
    createTuiQuestionDependencies,
} from "../../support/tui-question-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";
import { SessionStore } from "../../../src/store/session-store.ts";

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
        expect(pane).toContain("─ 1 auto-approved ─");
        expect(pane).not.toContain("Classifier allowed");
        // `env` prints as many lines as the machine has variables, so
        // the row is pinned by its command and its details hint.
        expect(pane).toContain("Ran  env AUTO_REVIEW=ran");
        expect(pane).toContain("Ctrl+T details");
        expect(pane).toContain("auto");
        expect(pane).not.toContain("Permission required");
        expect(pane).not.toContain("3 Deny");

        const lines = pane.split("\n");
        const row = lines.findIndex((line) => line.includes("─ 1 auto-approved ─"));
        const column = lines[row]?.indexOf("auto-approved") ?? -1;
        await session.sendMouseClick(column, row);
        pane = await session.waitForVisiblePane("↳ Routine command requested by the user.");
        const reasonRow = pane.split("\n").findIndex((line) => line.includes("↳ Routine"));
        expect(pane.split("\n")[reasonRow - 1]?.trim()).toBe("env AUTO_REVIEW=ran");
        const reasonSpan = session.captureSpans().lines
            .flatMap((line) => line.spans)
            .find((span) => span.text.includes("Routine command"));
        expect((reasonSpan?.attributes ?? 0) & TextAttributes.ITALIC).toBe(TextAttributes.ITALIC);
        await session.sendMouseClick(column, row);
        pane = await session.waitForVisiblePaneWhere(
            (current) => !current.includes("Routine command requested"),
            "closed auto-approved list",
        );
    } finally {
        await session.close();
    }
}, 15_000);

test("a classifier denial stays in the transcript after the turn ends", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-auto-deny-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiAutoReviewDependencies(home, "deny"),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("run the routine command");
        session.sendKey("Enter");

        await session.waitForVisiblePane("AUTO REVIEW COMPLETED");
        // The turn's history refresh replaces live rows, so wait past it.
        await session.settle(500);
        const pane = session.captureVisiblePane();
        expect(readFileSync(join(home, "auto-review-invoked"), "utf8"))
            .toBe("denied\n");
        expect(pane).toMatch(
            /^ {2}× CLASSIFIER DENIED · bash did not run\n {4}Critical risk: Scuttles the ship, which the user never asked for\.$/m,
        );
        expect(pane.split("CLASSIFIER DENIED")).toHaveLength(2);
        expect(pane).toMatch(/^ {2}Did not run\n {2}└ env AUTO_REVIEW=ran\n\n {2}× CLASSIFIER DENIED/m);
        // The reason is said once, by the denial row.
        expect(pane.split("Scuttles the ship")).toHaveLength(2);
        expect(pane).not.toContain("Ran  env");
        expect(pane.indexOf("CLASSIFIER DENIED")).toBeLessThan(pane.indexOf("AUTO REVIEW COMPLETED"));
    } finally {
        await session.close();
    }
}, 15_000);

test("a denied classifier action can be approved once and persists as a normal result", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-denial-yes-"));
    const sessionPath = join(home, "auto-review-session.jsonl");
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 24,
        dependencies: () => createTuiAutoReviewDependencies(home, "deny", {
            mediateDenial: true,
        }),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("run the routine command");
        session.sendKey("Enter");

        const pane = await session.waitForVisiblePane("1 Yes, this time");
        expect(pane.replaceAll("┃", " ").replaceAll(/\s+/g, " ")).toContain(
            "Scuttles the ship, which the user never asked for.",
        );
        expect(pane).toContain("2 No");
        expect(pane).not.toContain("3 ");
        expect(pane).not.toContain("Tab to tell Vera what to do instead");
        expect(pane).not.toContain("always allow");

        session.sendKey("1");
        const completed = await session.waitForVisiblePane("AUTO REVIEW COMPLETED");
        expect(completed).toContain("Ran  env AUTO_REVIEW=ran");
        expect(completed).not.toContain("CLASSIFIER DENIED");
        expect(completed).not.toContain("Did not run");

        const reopened = await SessionStore.open(sessionPath);
        const toolResults = reopened.messages().filter((message) =>
            message.role === "tool_result"
                && message.toolCallId === "auto-reviewed-command"
        );
        expect(toolResults).toHaveLength(1);
        const result = toolResults[0];
        expect(result?.role).toBe("tool_result");
        if (result?.role === "tool_result") {
            expect(result.isError).toBe(false);
            expect(result.classifierOutcome).toBeUndefined();
            expect(result.content.map((part) => part.text ?? "").join(" "))
                .toContain("AUTO_REVIEW=ran");
        }
    } finally {
        await session.close();
    }
}, 15_000);

test("a denied classifier action refused by the user persists its denial", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-denial-no-"));
    const sessionPath = join(home, "auto-review-session.jsonl");
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 24,
        dependencies: () => createTuiAutoReviewDependencies(home, "deny", {
            mediateDenial: true,
        }),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("run the routine command");
        session.sendKey("Enter");

        const pane = await session.waitForVisiblePane("1 Yes, this time");
        expect(pane.replaceAll("┃", " ").replaceAll(/\s+/g, " ")).toContain(
            "Scuttles the ship, which the user never asked for.",
        );
        expect(pane).toContain("2 No");
        expect(pane).not.toContain("3 ");
        expect(pane).not.toContain("Tab to tell Vera what to do instead");

        session.sendKey("2");
        const completed = await session.waitForVisiblePane("AUTO REVIEW COMPLETED");
        expect(completed).toContain("CLASSIFIER DENIED");
        expect(completed).toContain("Did not run");
        expect(readFileSync(join(home, "auto-review-invoked"), "utf8"))
            .toBe("denied\n");

        const reopened = await SessionStore.open(sessionPath);
        const result = reopened.messages().find((message) =>
            message.role === "tool_result"
                && message.toolCallId === "auto-reviewed-command"
        );
        expect(result?.role).toBe("tool_result");
        if (result?.role === "tool_result") {
            expect(result.isError).toBe(true);
            expect(result.classifierOutcome).toEqual({
                kind: "denied",
                riskLevel: "critical",
                reason: "Scuttles the ship, which the user never asked for.",
            });
        }
    } finally {
        await session.close();
    }
}, 15_000);

test("a classifier timeout asks the user and keeps the turn going", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-auto-timeout-"));
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 24,
        dependencies: () => createTuiAutoReviewDependencies(home, "timeout"),
    });
    let pane = "";

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("run the routine command");
        session.sendKey("Enter");

        pane = await session.waitForVisiblePane("1 Yes, for this chat");
        const flat = pane
            .split("\n")
            .map((line) => line.replace(/^┃\s?/, "").trim())
            .join(" ");
        expect(readFileSync(join(home, "auto-review-invoked"), "utf8"))
            .toBe("timed out\n");
        expect(pane).toContain("Run this command?");
        expect(flat).toContain("did not answer within 60s, so Vera is asking you instead.");
        expect(flat).toContain("Fix: open /settings, then Classifier");
        expect(pane).not.toContain("CLASSIFIER FAILED");

        session.sendKey("C-r");
        await session.waitForVisiblePane("Ctrl+R collapse");
        session.sendKey("C-r");
        session.sendKey("Tab");
        const editing = await session.waitForVisiblePane("enter send");
        expect(editing).not.toContain("Ctrl+R collapse");
        session.sendText("try another route");
        await session.waitForVisiblePane("try another route");
        session.sendKey("BTab");
        await session.settle();
        expect(session.captureVisiblePane()).toContain("enter send");
        expect(session.captureVisiblePane()).toContain("try another route");
        session.sendKey("C-r");
        await session.waitForVisiblePane("Ctrl+R collapse");
        session.sendKey("C-r");
        session.sendKey("Tab");
        pane = await session.waitForVisiblePane("Tab to tell Vera what to do instead");
        expect(pane).not.toContain("try another route");
        session.sendKey("1");
        pane = await session.waitForVisiblePane("AUTO REVIEW COMPLETED");
        expect(pane).toContain("Ran  env AUTO_REVIEW=ran");
        expect(pane).not.toContain("CLASSIFIER FAILED");
        expect(pane).not.toContain("Run this command?");
        expect(pane).not.toContain("Did not run");
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
        pane = await session.waitForVisiblePane("1 Yes, this time");
        expect(pane).toContain("$ grep");
        expect(pane).not.toContain("approval required ·");
        expect(pane).not.toContain("gpt-5.6-sol");

        // Down moves the highlight across the answers, so the details
        // scroll by page.
        for (let index = 0; index < 20; index += 1) {
            session.sendKey("NPage");
        }
        pane = await session.waitForVisiblePaneWhere(
            (current) => current.includes('*.md"')
                && !current.includes("$ grep"),
            "scrolled approval actions",
        );
        expect(pane).toContain("1 Yes, this time");
        expect(pane).not.toContain("$ grep");
    } finally {
        await session.close();
    }
}, 15_000);

test("approval Tab and Ctrl+R work in the list and typed answer", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-approval-keys-"));
    const session = await startTuiTestSession({
        home,
        width: 110,
        height: 28,
        dependencies: () => createTuiApprovalDependencies(),
    });

    try {
        await session.waitForVisiblePane("Tab to tell Vera what to do instead");
        session.sendKey("C-r");
        await session.waitForVisiblePane("Ctrl+R collapse");
        session.sendKey("C-r");
        session.sendKey("Tab");
        const editing = await session.waitForVisiblePane("enter send");
        expect(editing).not.toContain("Ctrl+R collapse");
        session.sendText("try another route");
        await session.waitForVisiblePane("try another route");
        session.sendKey("C-r");
        await session.waitForVisiblePane("Ctrl+R collapse");
        session.sendKey("C-r");
        session.sendKey("Tab");
        const pane = await session.waitForVisiblePane("Tab to tell Vera what to do instead");
        expect(pane).not.toContain("try another route");
        session.sendKey("2");
        await session.waitForVisiblePane("RESPONSE AFTER APPROVAL");
    } finally {
        await session.close();
    }
}, 15_000);

test("answer 3 sends the allow, then the session mode change", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-switch-approval-"));
    const session = await startTuiTestSession({
        home,
        width: 80,
        height: 18,
        dependencies: () => createTuiSwitchApprovalDependencies(home),
    });

    try {
        const pane = await session.waitForVisiblePane("Yes, and switch to Approve for me");
        expect(pane).toContain("1 Yes, for this chat");
        expect(pane).toContain("2 Yes, and always allow grep commands");
        expect(pane).toContain("4 No");

        session.sendKey("3");
        await session.waitForVisiblePane("RESPONSE AFTER APPROVAL");

        const sent = readFileSync(join(home, "sent.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as {
                readonly type: string;
                readonly requestId?: string;
                readonly mode?: string;
                readonly response?: unknown;
            });
        const answerAt = sent.findIndex((command) =>
            command.type === "ui_response" && command.requestId === "switch-approval"
        );
        const modeAt = sent.findIndex((command) => command.type === "update_session_permission_mode");
        expect(sent[answerAt]?.response).toEqual({ type: "tool_approval", decision: "allow_once" });
        expect(sent[modeAt]?.mode).toBe("auto");
        expect(modeAt).toBe(answerAt + 1);
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
            disabledIncludedExtensions: [
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
        await session.waitForVisiblePane("1 Yes, this time");
        for (let attempt = 0; attempt < 100; attempt += 1) {
            if (existsSync(mountedPath)) break;
            await Bun.sleep(10);
        }
        expect(readFileSync(mountedPath, "utf8")).toBe("mounted");

        session.sendKey("1");
        const pane = await session.waitForVisiblePane("RESPONSE AFTER APPROVAL");
        expect(pane).not.toContain("Run this command?");
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
        expect(pane).toContain("1 Yes, this time");
        expect(pane).toContain("2 No");
        expect(pane).not.toContain("Yes, for this chat");
        expect(pane).not.toContain("always allow");
        expect(pane).not.toContain("switch to Approve");
        expect(pane).not.toContain("to tell Vera");
        expect(pane).not.toContain("this chat");
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
