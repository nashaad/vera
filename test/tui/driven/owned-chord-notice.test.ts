import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTuiExtensionCommandDependencies } from "../../support/tui-extension-command-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("a client extension that binds a key Vera owns starts the TUI and names the key", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-owned-chord-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => ({
            ...createTuiExtensionCommandDependencies(home),
            disabledIncludedExtensions: [
                "vera.model-presets",
                "vera.reasoning-cycle",
            ],
            clientExtensions: [{
                path: join(import.meta.dir, "../../support/fixtures/owned-chord-extension"),
                enabled: true,
                config: {},
            }],
        }),
    });

    try {
        const pane = await session.waitForVisiblePaneWhere(
            (frame) => frame.includes("Message Vera")
                && frame.includes("owned-chord-probe cannot use ctrl+p"),
            "the composer with the owned-key notice",
        );
        expect(pane).toContain("Vera already uses it to open the command palette");

        session.sendKey("C-c");
        session.sendKey("C-c");
        await session.waitForSessionExit();
    } finally {
        await session.close();
    }
}, 15_000);
