import { expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { VERA_TUI_THEME } from "../../../clients/tui/theme.ts";
import type { TuiTestSession } from "../../support/tui-harness.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../../src/store/session-store.ts";
import type { ClientCommand } from "../../../src/engine/protocol.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";
import { createTuiCatalogRefreshDependencies } from "../../support/tui-catalog-refresh-child.ts";
import { createSettingsAnsweringClient } from "../../support/settings-answering-client.ts";

function expectHighlighted(session: TuiTestSession, model: string): void {
    const span = session.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes(model));
    expect(span?.bg.toInts()).toEqual(RGBA.fromHex(VERA_TUI_THEME.hud?.accent ?? VERA_TUI_THEME.accent).toInts());
}

test("HUD loads persisted recents on first opening, bounds its groups, and preserves staging on late replies", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-hud-recents-"));
    const store = await SessionStore.create(join(home, "history.jsonl"), { sessionId: "hud-history", cwd: home });
    for (const model of ["older", "recent-a", "recent-b", "recent-c", "recent-d", "recent-e", "current"]) {
        await store.appendModelSettings({ provider: "demo", model });
    }
    const reopened = await SessionStore.open(store.path);
    const pooled = Array.from({ length: 14 }, (_, index) => ({ provider: "demo", model: `library-${index}`,
        label: `Library ${index}`, levels: [], available: true, verified: false }));
    // Membership and recency overlap; the model must occupy only one choice.
    pooled.push({ provider: "demo", model: "recent-e", label: "recent-e", levels: [], available: true, verified: false });
    const commands: ClientCommand[] = [];
    const replies: Array<() => void> = [];
    const session = await startTuiTestSession({ home, width: 120, height: 48,
        dependencies: () => ({ ...createTuiCatalogRefreshDependencies(),
            client: createSettingsAnsweringClient({ agentId: "hud-history", model: "current", mode: "ask",
                modelSettings: { provider: "demo", pooled, availableModels: pooled },
                onCommand(command, push) {
                    commands.push(command);
                    if (command.type === "get_session_model_settings_history") {
                        replies.push(() => push({ type: "session_model_settings_history", requestId: command.requestId,
                            entries: reopened.modelSettingsHistory().map((entry) => ({ ...entry, origin: entry.origin ?? "user" })), seq: 50 }));
                    }
                },
            }),
        }) });
    try {
        await session.waitForVisiblePane("demo/current");
        session.sendKey("BTab");
        await session.waitForVisiblePane("From Model Library");
        session.sendKey("Tab"); session.sendKey("Tab");
        await session.waitForVisiblePane("› MODEL");
        for (let index = 0; index < 9; index++) session.sendKey("Down");
        await session.settle();
        expectHighlighted(session, "Library 8");
        expect(replies).toHaveLength(1);
        replies[0]!();
        const pane = await session.waitForVisiblePane("Recent");
        expectHighlighted(session, "Library 8");
        expect(pane).toContain("› MODEL");
        expect(pane).toContain("More models: /model");
        const rows = pane.split("\n").filter((line) => /\s+(?:current|recent-[a-z]|Library \d+)\s+demo\s*$/.test(line));
        expect(rows).toHaveLength(10);
        expect(rows.filter((line) => line.includes("recent-"))).toHaveLength(5);
        expect(rows.filter((line) => line.includes("recent-e"))).toHaveLength(1);
        expect(rows.filter((line) => line.includes("Library"))).toHaveLength(4);
        expect(pane).not.toContain("○");
        expect(pane.match(/›/g)).toHaveLength(1);
        expect(pane).not.toContain("older");
        session.sendKey("Escape");
        await session.waitForVisiblePaneWhere((text) => !text.includes("EFFORT"), "HUD to close");
        session.sendKey("BTab"); await session.waitForVisiblePane("Recent");
        await session.settle();
        expect(replies).toHaveLength(2);
        // The first opening's reply cannot consume the new opening's request.
        replies[0]!(); await session.settle();
        replies[1]!(); await session.settle();
        session.sendKey("Tab"); session.sendKey("Tab"); session.sendKey("Down");
        await session.settle();
        expectHighlighted(session, "recent-e");
        session.sendKey("Enter");
        await session.waitForVisiblePaneWhere((text) => !text.includes("EFFORT"), "HUD apply to close");
        expect(commands.filter((command) => command.type === "update_session_model_settings")).toMatchObject([
            { patch: { provider: "demo", model: "recent-e" } },
        ]);
        expect(commands.some((command) => command.type === "update_model_settings" || command.type === "pool_add" || command.type === "prompt")).toBe(false);
        replies[1]!(); await session.settle();
        expect(session.captureVisiblePane()).not.toContain("EFFORT");
    } finally { await session.close(); }
}, 20_000);
