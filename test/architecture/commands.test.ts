import { expect, test } from "bun:test";

import {
    BUILTIN_COMMANDS,
    createBuiltinTuiCommandRegistry,
} from "../../clients/tui/commands.ts";

test("every registered command is in the catalog the help pane reads", () => {
    const registry = createBuiltinTuiCommandRegistry();
    const registered = registry.registeredCommands().map(
        (command) => command.name,
    );
    const catalog = new Set<string>(
        BUILTIN_COMMANDS.map((command) => command.name),
    );
    // A command registered but absent from `BUILTIN_COMMANDS` works and is
    // undiscoverable, which is the worst of both: the help pane and the
    // palette both build from the catalog.
    expect(registered.filter((name) => !catalog.has(name))).toEqual([]);
});

test("the agent surface is a command, not a chord that changes state", () => {
    const registry = createBuiltinTuiCommandRegistry();
    expect(registry.dispatch("/agent")).toEqual({ type: "open_agent_picker" });
    expect(registry.dispatch("/agent reviewer")).toEqual({
        type: "wear_agent",
        name: "reviewer",
    });
    expect(registry.dispatch("/agent Not A Name")?.type)
        .toBe("command_error");
});

test("permissions changes the persistent default", () => {
    const registry = createBuiltinTuiCommandRegistry();
    expect(registry.dispatch("/permissions readonly")).toEqual({
        type: "update_permissions",
        mode: "readonly",
        scope: "global",
    });
    // Keep accepting the old explicit spelling for scripts and muscle memory.
    expect(registry.dispatch("/permissions readonly default")).toEqual({
        type: "update_permissions",
        mode: "readonly",
        scope: "global",
    });
    expect(registry.dispatch("/permissions readonly everywhere")?.type)
        .toBe("command_error");
});
