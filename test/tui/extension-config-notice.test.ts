import { expect, test } from "bun:test";

import {
    EXTENSION_CONFIG_NOTICE_KEY,
    foldExtensionConfigNotice,
} from "../../clients/tui/main/extensions-ops.ts";
import { createTuiState } from "../../clients/tui/state.ts";

const FOOTER = "The TUI side reloads now; restart the host for the host side.";
const DISABLED_MCP =
    "Disabled vera.mcp. Use Reconnect host (Ctrl+P) to unload it.";

test("a host notice folds into the extensions card with the restart footer", () => {
    const folded = foldExtensionConfigNotice(createTuiState(), DISABLED_MCP);
    const card = folded?.entries.at(-1);
    expect(card?.kind).toBe("notice");
    if (card?.kind !== "notice") throw new Error("no notice card");
    expect(card.card).toBe(true);
    expect(card.text).toBe(`${DISABLED_MCP}\n${FOOTER}`);
    expect(card.summary).toBe(DISABLED_MCP);
    expect(EXTENSION_CONFIG_NOTICE_KEY).toBe("extensions_config");
});

test("a replayed notice does not repeat the line", () => {
    const once = foldExtensionConfigNotice(createTuiState(), DISABLED_MCP);
    expect(once).toBeDefined();
    expect(foldExtensionConfigNotice(once!, DISABLED_MCP)).toBeUndefined();
});

test("a second change replaces the card with both lines", () => {
    const once = foldExtensionConfigNotice(createTuiState(), DISABLED_MCP)!;
    const twice = foldExtensionConfigNotice(once, "Enabled vera.btw.")!;
    const card = twice.entries.at(-1);
    if (card?.kind !== "notice") throw new Error("no notice card");
    expect(card.text).toBe(
        `${DISABLED_MCP}\nEnabled vera.btw.\n${FOOTER}`,
    );
    expect(card.summary).toBe(
        "2 extension changes. Use Reconnect host (Ctrl+P) to apply them.",
    );
});

test("a client-only change carries no restart hint of its own", () => {
    const folded = foldExtensionConfigNotice(createTuiState(), "Disabled acme.notes.")!;
    const card = folded.entries.at(-1);
    if (card?.kind !== "notice") throw new Error("no notice card");
    expect(card.summary).toBe("Disabled acme.notes.");
    expect(card.text).toBe(`Disabled acme.notes.\n${FOOTER}`);
});
