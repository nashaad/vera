import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emptyUsage } from "../../../src/model/types.ts";
import { SessionStore } from "../../../src/store/session-store.ts";
import { createTuiChildDependencies } from "../../support/tui-child.ts";
import { startTuiTestSession, type TuiTestSession } from "../../support/tui-harness.ts";

function selectedExtension(pane: string): string | undefined {
    return pane.match(/›\s+(\S+)/)?.[1];
}

async function selectContextExtension(session: TuiTestSession): Promise<string> {
    let pane = await session.waitForVisiblePaneWhere(
        (current) => current.includes("Extensions") && selectedExtension(current) !== undefined,
        "extension list selection",
    );
    for (let index = 0; index < 100; index += 1) {
        const selected = selectedExtension(pane);
        if (selected === "vera.context") return pane;
        session.sendKey("Down");
        pane = await session.waitForVisiblePaneWhere(
            (current) => selectedExtension(current) !== undefined
                && selectedExtension(current) !== selected,
            `extension selection after ${selected}`,
        );
    }
    throw new Error("Context extension was not found");
}

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
        await session.waitForVisiblePane("test · high");
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
            height: 48,
            dependencies: () => ({
                ...createTuiChildDependencies({
                    clientExtensions: [{
                        path: join(import.meta.dir, "../../../src/core-extensions/context"),
                        enabled,
                        config: {},
                    }],
                }),
                disabledIncludedExtensions: enabled ? ["vera.context"] : [],
            }),
        });
        try {
            await session.waitForVisiblePane("Start a conversation");
            session.sendText("/extensions");
            session.sendKey("Enter");
            const pane = await selectContextExtension(session);
            expect(pane.split("\n").find((line) => line.includes("› vera.context")))
                .toContain(enabled ? "enabled" : "disabled");
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
        height: 48,
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
        await selectContextExtension(session);
    } finally {
        await session.close();
    }
}, 15_000);

test("resuming a session with large instructions warns once and /context repeats it", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-context-budget-"));
    const sessionPath = join(home, "sessions", "budget.jsonl");
    const store = await SessionStore.create(sessionPath, {
        sessionId: "budget-session",
        cwd: home,
    });
    await store.appendMessage({
        role: "user",
        content: [{ type: "text", text: "hello" }],
    });
    await store.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "hello from a heavy session" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: { ...emptyUsage(), inputTokens: 8_107, outputTokens: 8, totalTokens: 8_115 },
        stopReason: "stop",
    });
    await store.appendContextMeasurement({
        tokens: 8_107,
        capacity: 200_000,
        estimated: true,
        projection: {
            estimatedTokens: 8_107,
            components: [{
                kind: "prompt_contribution",
                id: "core.user-rules",
                owner: "core",
                source: "contextual",
                displayName: "User rules",
                count: 1,
                estimatedTokens: 8_007,
                parts: [{
                    id: "rules-global",
                    displayName: "global.md",
                    scope: "user",
                    bytes: 32_028,
                    estimatedTokens: 8_007,
                }],
            }, {
                kind: "message",
                id: "message:1",
                owner: "session",
                source: "user",
                displayName: "user message",
                count: 1,
                estimatedTokens: 100,
            }],
        },
    });

    const startSession = () => startTuiTestSession({
        home,
        width: 100,
        height: 40,
        dependencies: () => createTuiChildDependencies({
            resumeSessionPath: sessionPath,
            agentId: "budget-session",
        }),
    });
    const session = await startSession();

    try {
        const pane = await session.waitForVisiblePane("Starting instructions are 8,018 tokens");
        const shown = pane.split("Starting instructions are").length - 1;
        expect(shown).toBeGreaterThanOrEqual(1);
        expect(shown).toBeLessThanOrEqual(2);
        expect(pane).toContain("Starting instructions are 8,018 tokens, over the 8,000 budget. See /context to trim.");
        session.sendText("/context");
        session.sendKey("Enter");
        const report = await session.waitForVisiblePane("INSTRUCTIONS");
        expect(report).toContain("!  8,018, over the 8,000 budget. Biggest: global.md (8.0k).");
        expect(report).not.toContain("rides every turn");
    } finally {
        await session.close();
    }

    const resumed = await startSession();
    try {
        await resumed.waitForVisiblePane("hello from a heavy session");
        await resumed.settle(300);
        expect(resumed.captureVisiblePane()).not.toContain("Starting instructions are");
    } finally {
        await resumed.close();
    }
}, 15_000);
