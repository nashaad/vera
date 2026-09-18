import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../../src/store/session-store.ts";
import type { ClientCommand } from "../../../src/engine/protocol.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";
import { createTuiCatalogRefreshDependencies } from "../../support/tui-catalog-refresh-child.ts";
import { createSettingsAnsweringClient } from "../../support/settings-answering-client.ts";

test("the switcher lists persisted recents once the history reply lands", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-switcher-recents-"));
    const store = await SessionStore.create(join(home, "history.jsonl"), { sessionId: "switcher-history", cwd: home });
    for (const model of ["older", "recent-a", "recent-b", "current"]) {
        await store.appendModelSettings({ provider: "demo", model });
    }
    const reopened = await SessionStore.open(store.path);
    const entry = (model: string) => ({
        provider: "demo", model, label: model, levels: [], available: true, verified: false,
    });
    // Recents only show as recents while they are not already favorites.
    const pooled = ["current", "spare"].map(entry);
    const available = [...pooled, ...["recent-a", "recent-b", "older"].map(entry)];
    const commands: ClientCommand[] = [];
    const replies: Array<() => void> = [];
    const session = await startTuiTestSession({ home, width: 120, height: 40,
        dependencies: () => ({ ...createTuiCatalogRefreshDependencies(),
            client: createSettingsAnsweringClient({ agentId: "switcher-history", model: "current", mode: "ask",
                modelSettings: { provider: "demo", pooled, availableModels: available },
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
        session.sendText("/model"); session.sendKey("Enter");
        await session.waitForVisiblePane("Switch model");
        expect(session.captureVisiblePane()).not.toContain("recent-b");
        expect(replies).toHaveLength(1);
        replies[0]!();
        const pane = await session.waitForVisiblePaneWhere(
            (text) => text.includes("recent-b"),
            "the recents to join the list",
        );
        // Newest first, and the live model stays where it already is.
        const listed = pane.split("\n").flatMap((line) =>
            /^[\s▌┃│]*(current|spare|older|recent-[ab])\b/.exec(line)?.[1] ?? []
        );
        expect(listed).toEqual(["current", "spare", "recent-b", "recent-a", "older"]);
        session.sendKey("Escape");
        await session.waitForVisiblePaneWhere((text) => !text.includes("Switch model"), "the switcher to close");
        expect(commands.some((command) => command.type === "update_session_model_settings")).toBe(false);
    } finally { await session.close(); }
}, 20_000);
