import { expect, test } from "bun:test";

import { CommandRegistry } from "../../clients/ui/src/commands/registry.ts";
import { registerNavigationCommands, NAVIGATION_COMMANDS } from "../../clients/ui/src/commands/navigation-commands.ts";
import { focusAndSelectSearch, settingsSearchFocus } from "../../clients/ui/src/pages/focusSearch.ts";
import { SETTINGS_SECTIONS } from "../../clients/ui/src/pages/settings/sections.ts";

test("@core Cmd+, requests focused Settings search on each invocation", () => {
    const registry = new CommandRegistry();
    const routes: unknown[] = [];
    let focusRequests = 0;
    const unsubscribe = settingsSearchFocus.subscribe(() => {
        if (settingsSearchFocus.take()) focusRequests += 1;
    });
    const dispose = registerNavigationCommands(registry, (action) => routes.push(action));

    try {
        expect(registry.execute(NAVIGATION_COMMANDS.settings)).toBe(true);
        expect(registry.execute(NAVIGATION_COMMANDS.settings)).toBe(true);
        expect(focusRequests).toBe(2);
        expect(routes).toEqual([
            { type: "navigate", route: { kind: "settings" } },
            { type: "navigate", route: { kind: "settings" } },
        ]);
    } finally {
        dispose();
        unsubscribe();
    }
});

test("Cmd+, focuses the rail search and selects its text", () => {
    const calls: string[] = [];
    focusAndSelectSearch({
        focus: () => calls.push("focus"),
        select: () => calls.push("select"),
    });
    expect(calls).toEqual(["focus", "select"]);
});

test("Models follows Providers in the Settings rail and has the approved search terms", () => {
    const providersIndex = SETTINGS_SECTIONS.findIndex((section) => section.id === "providers");
    const models = SETTINGS_SECTIONS[providersIndex + 1];

    expect(models?.id).toBe("models");
    expect(models?.name).toBe("Models");
    expect(models?.group).toBe("Settings");
    expect(models?.terms).toBe("model picker favorites shortlist catalog search refresh");
    expect("file" in (models ?? {})).toBe(false);
});
