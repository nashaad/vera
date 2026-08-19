import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createTuiExtensionCommandDependencies,
} from "../../support/tui-extension-command-child.ts";
import {
    startTuiTestSession,
    type TuiTestSession,
} from "../../support/tui-harness.ts";

function clearComposer(session: TuiTestSession, draft: string): void {
    for (let i = 0; i < draft.length; i += 1) {
        session.sendKey("BSpace");
    }
}

test("an open command palette gains late extension commands", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-help-late-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiExtensionCommandDependencies(home),
    });
    let pane = "";

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-p");
        await session.waitForVisiblePane("Commands");
        session.sendText("hello");
        await session.waitForVisiblePane("hello");
        pane = await session.waitForVisiblePane(
            "Say hello from an extension",
        );
        // Searching flattens the list into one ranked run, so the group
        // column goes away and its width returns to the descriptions.
        expect(pane).not.toContain("extensions ");
        expect(pane).toContain("hello");
    } finally {
        await session.close();
    }
}, 15_000);

test("extension slash commands stay in the TUI and render attributed results", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-extension-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiExtensionCommandDependencies(home),
    });
    let pane = "";

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/hello too early");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane(
            "Extension commands are still loading",
        );
        expect(existsSync(
            join(home, "extension-command-result.txt"),
        )).toBeFalse();
        // The tmux test cleared the composer with ctrl+c. Typing into the
        // native edit buffer right after a ctrl+c clear segfaults the virtual
        // test renderer (opentui 0.2.16), so this port clears it key by key;
        // the ctrl+c draft clear itself is covered by the draft test.
        clearComposer(session, "/hello too early");
        session.sendText("/hell");
        pane = await session.waitForVisiblePane(
            "/hello  Say hello from an extension",
        );
        expect(pane).toContain("/hello");
        session.sendKey("Tab");
        session.sendText(" fail");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane(
            "running /hello · ctrl+c quit",
        );
        expect(pane).toContain("running /hello");
        pane = await session.waitForVisiblePane(
            "test.extension/hello: extension failed for test",
        );
        expect(pane).toContain("ready");
        expect(pane).toContain("/hello fail");
        clearComposer(session, "/hello fail");
        session.sendText("/hello");
        session.sendText(" Nash");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane(
            "test.extension/hello [info]: Hello Nash",
        );
        expect(pane).toContain("ready");
        expect(readFileSync(
            join(home, "extension-command-result.txt"),
            "utf8",
        )).toBe("hello\nNash");
    } finally {
        await session.close();
    }
}, 15_000);
