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

test("a client extension can return text to its invoking composer", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-compose-write-"));
    const focusResultPath = join(home, "compose-focus-result.txt");
    const session = await startTuiTestSession({
        home,
        dependencies: () => ({
            ...createTuiExtensionCommandDependencies(home),
            disabledBuiltinExtensions: [
                "vera.model-presets",
                "vera.reasoning-cycle",
            ],
            clientExtensions: [{
                path: join(
                    import.meta.dir,
                    "../../support/fixtures/compose-write-extension",
                ),
                enabled: true,
                config: { focusResultPath },
            }],
        }),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/compose-w");
        await session.waitForVisiblePane("Insert text into the composer");
        session.sendKey("Tab");
        session.sendKey("Enter");
        let pane = await session.waitForVisiblePaneWhere(
            (frame) => frame.includes("inserted by extension")
                && !frame.includes("running /compose-write"),
            "returned composer text after the extension command settled",
        );

        // Focus returned explicitly, and the command's Enter was consumed
        // before the extension ran: this edits the draft instead of submitting.
        session.sendText("!");
        pane = await session.waitForVisiblePane("inserted by extension!");
        expect(pane).toContain("ready");

        clearComposer(session, "inserted by extension!");
        session.sendText("/compose-focus-g");
        await session.waitForVisiblePane(
            "Check composer focus around an extension modal",
        );
        session.sendKey("Tab");
        session.sendKey("Enter");
        for (let attempt = 0; attempt < 100; attempt += 1) {
            if (existsSync(focusResultPath)) break;
            await Bun.sleep(20);
        }
        expect(readFileSync(focusResultPath, "utf8")).toBe(
            "ineligible/accepted",
        );
    } finally {
        await session.close();
    }
}, 15_000);

test("/extensions opens a manager list, not an inspect dump", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-extensions-list-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiExtensionCommandDependencies(home),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/extensions");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane("No extensions installed");
        expect(pane).toContain("/extension install <path>");
        expect(pane).not.toContain("drag a section");
        expect(pane).not.toContain("enter copies all");
        session.sendKey("Escape");
        await session.waitForVisiblePane("Start a conversation");
    } finally {
        await session.close();
    }
}, 15_000);
