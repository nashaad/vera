import { expect, test } from "bun:test";

import { CommandRegistry } from "../../clients/ui/src/commands/registry.ts";
import { registerNavigationCommands } from "../../clients/ui/src/commands/navigation-commands.ts";
import { registerOverlayCommands } from "../../clients/ui/src/commands/overlay-commands.ts";
import { showCommand, showTarget } from "../../clients/ui/src/commands/show-target.ts";
import { SETTINGS_SECTIONS } from "../../clients/ui/src/pages/settings/sections.ts";
import {
    requestSettingsSection,
    subscribeRequestedSection,
    takeRequestedSection,
} from "../../clients/ui/src/pages/settings/requestedSection.ts";
import { pageCards } from "../../clients/ui/src/pages/tour.ts";
import { initialWatch, reduceWatch } from "../../clients/ui/src/session/transcript.ts";
import { parseSessionLine } from "../../clients/ui/src/session/wire.ts";
import { SHOW_TARGETS } from "../../src/help/show-targets.ts";

function registered(): CommandRegistry {
    const registry = new CommandRegistry();
    registerOverlayCommands(registry);
    registerNavigationCommands(registry, () => undefined);
    return registry;
}

test("@core the window has a registered command for every show target", () => {
    const registry = registered();
    for (const target of SHOW_TARGETS) {
        const command = showCommand(target.id);
        expect(command).toBeDefined();
        expect(registry.has(command ?? "")).toBe(true);
    }
});

test("@core a page target runs the command the Tour page's route belongs to", () => {
    const routes: string[] = [];
    const registry = new CommandRegistry();
    registerNavigationCommands(registry, (action) => {
        if (action.type === "navigate") routes.push(action.route.kind);
    });
    for (const card of pageCards("/work/crow")) {
        if (card.id === "workspace" || card.action?.kind !== "route") continue;
        routes.length = 0;
        expect(showTarget(`page.${card.id}`, (command) => registry.execute(command))).toBe(true);
        expect(routes).toEqual([card.action.route.kind]);
    }
});

test("@core a settings target opens Settings and asks for its section once", () => {
    const opened: string[] = [];
    for (const section of SETTINGS_SECTIONS) {
        expect(showTarget(`settings.${section.id}`, (command) => opened.push(command))).toBe(true);
        expect(takeRequestedSection()).toBe(section.id);
        expect(takeRequestedSection()).toBeUndefined();
    }
    expect(opened).toEqual(SETTINGS_SECTIONS.map(() => "go.settings"));
});

test("@core a target the window does not know opens nothing", () => {
    const opened: string[] = [];
    expect(showTarget("dialog.pirate-map", (command) => opened.push(command))).toBe(false);
    expect(showTarget("settings.treasure", (command) => opened.push(command))).toBe(false);
    expect(opened).toEqual([]);
    expect(takeRequestedSection()).toBeUndefined();
});

test("@core a requested section is dropped after a few seconds and reaches an open page", () => {
    requestSettingsSection("providers", 1000);
    expect(takeRequestedSection(7000)).toBeUndefined();
    let heard = 0;
    const off = subscribeRequestedSection(() => {
        heard += 1;
    });
    requestSettingsSection("keyboard");
    expect(heard).toBe(1);
    expect(takeRequestedSection()).toBe("keyboard");
    off();
    requestSettingsSection("data");
    expect(heard).toBe(1);
    takeRequestedSection();
});

test("@core the session_show line parses and leaves the transcript as it was", () => {
    const message = parseSessionLine(JSON.stringify({ type: "session_show", agent_id: "agent-a", target: "dialog.themes" }));
    expect(message).toEqual({ type: "session_show", target: "dialog.themes" });
    const before = initialWatch("agent-a");
    expect(reduceWatch(before, message!)).toBe(before);
    expect(parseSessionLine(JSON.stringify({ type: "session_show", agent_id: "agent-a" }))).toBeUndefined();
});
