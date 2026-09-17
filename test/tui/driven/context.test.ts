import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emptyUsage } from "../../../src/model/types.ts";
import { SessionStore } from "../../../src/store/session-store.ts";
import { createTuiChildDependencies } from "../../support/tui-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("/context after resume still names the stored request recipe", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-context-resume-"));
    const sessionPath = join(home, "sessions", "resume.jsonl");
    const store = await SessionStore.create(sessionPath, {
        sessionId: "resume-session",
        cwd: home,
    });
    await store.appendMessage({
        role: "user",
        content: [{ type: "text", text: "inspect the files" }],
    });
    await store.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "hello from before resume" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: {
            ...emptyUsage(),
            inputTokens: 70,
            outputTokens: 8,
            totalTokens: 78,
        },
        stopReason: "stop",
    });
    await store.appendContextMeasurement({
        tokens: 70,
        capacity: 100,
        estimated: true,
        projection: {
            estimatedTokens: 70,
            components: [{
                kind: "prompt_contribution",
                id: "core.project-instructions",
                owner: "core",
                source: "contextual",
                displayName: "Project instructions",
                count: 1,
                estimatedTokens: 60,
                parts: [{
                    id: "agents-local",
                    displayName: "AGENTS.local.md",
                    scope: "project",
                    bytes: 240,
                    estimatedTokens: 60,
                }],
            }, {
                kind: "message",
                id: "message:1",
                owner: "session",
                source: "user",
                displayName: "user message",
                count: 1,
                estimatedTokens: 10,
            }],
        },
        compaction: {
            triggerFraction: 0.8,
            triggerTokens: 80,
        },
    });

    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 40,
        dependencies: () => createTuiChildDependencies({
            resumeSessionPath: sessionPath,
        }),
    });

    try {
        await session.waitForVisiblePane("hello from before resume");
        await session.waitForVisiblePane("test · HIGH");
        session.sendText("/context");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane("BREAKDOWN");
        expect(pane).toContain("AGENTS.local.md");
        expect(pane).toContain("Instructions");
        expect(pane).not.toContain("No category split in this snapshot.");
    } finally {
        await session.close();
    }
}, 15_000);

test("slash context lists the name and ghosts [all|sources] after a space", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-context-slash-"));
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 24,
        dependencies: () => createTuiChildDependencies(),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/context");
        let pane = await session.waitForVisiblePaneWhere(
            (current) => /\/context\s+Show context usage/.test(current),
            "slash context suggestion",
        );
        expect(pane).not.toMatch(/\/context \[all\]/);
        session.sendText(" ");
        pane = await session.waitForVisiblePaneWhere(
            (current) => current.includes("/context [all|sources]"),
            "context argument ghost",
        );
        expect(pane).not.toMatch(/Show context usage/);
    } finally {
        await session.close();
    }
}, 15_000);

for (const enabled of [false, true]) {
    test(`/extensions reports an explicit Context copy as ${enabled ? "enabled" : "disabled"}`, async () => {
        const home = mkdtempSync(join(tmpdir(), "vera-tui-context-status-"));
        const session = await startTuiTestSession({
            home,
            width: 100,
            height: 40,
            dependencies: () => ({
                ...createTuiChildDependencies({
                    clientExtensions: [{
                        path: join(import.meta.dir, "../../../extensions/context"),
                        enabled,
                        config: {},
                    }],
                }),
                disabledBuiltinExtensions: enabled ? ["example.context"] : [],
            }),
        });
        try {
            await session.waitForVisiblePane("Start a conversation");
            session.sendText("/extensions");
            session.sendKey("Enter");
            await session.waitForVisiblePaneWhere(
                (pane) => pane.split("\n").some((line) =>
                    line.includes("example.context")
                    && line.includes(enabled ? "enabled" : "disabled")),
                "effective Context enabled state",
            );
            session.sendKey("Escape");
            await session.waitForVisiblePane("Start a conversation");
        } finally {
            await session.close();
        }
    }, 15_000);
}

test("closing Dashboard returns every following character to the composer", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-dashboard-focus-"));
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 40,
        dependencies: () => createTuiChildDependencies(),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/dashboard");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Vera dashboard");
        session.sendKey("Escape");
        await session.waitForVisiblePaneWhere(
            (pane) => !pane.includes("Vera dashboard") && pane.includes("Message Vera"),
            "Dashboard closed",
        );
        session.sendText("/extensions");
        const pane = await session.waitForVisiblePane("│ /extensions");
        expect(pane).not.toContain("│ ons");
        session.sendKey("Enter");
        await session.waitForVisiblePane("example.context");
    } finally {
        await session.close();
    }
}, 15_000);
