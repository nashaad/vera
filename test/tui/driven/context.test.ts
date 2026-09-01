import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emptyUsage } from "../../../src/model/types.ts";
import { SessionStore } from "../../../src/store/session-store.ts";
import { createTuiChildDependencies } from "../../support/tui-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

const CONTEXT_EXTENSION = join(
    import.meta.dir,
    "../../../examples/extensions/context",
);

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
            clientExtensions: [{
                path: CONTEXT_EXTENSION,
                enabled: true,
                config: null,
            }],
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

test("slash context lists the name and ghosts [all] after a space", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-context-slash-"));
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 24,
        dependencies: () => createTuiChildDependencies({
            clientExtensions: [{
                path: CONTEXT_EXTENSION,
                enabled: true,
                config: null,
            }],
        }),
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
            (current) => current.includes("/context [all]"),
            "context argument ghost",
        );
        expect(pane).not.toMatch(/Show context usage/);
    } finally {
        await session.close();
    }
}, 15_000);
