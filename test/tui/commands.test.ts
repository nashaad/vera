import { expect, test } from "bun:test";

import {
    BUILTIN_COMMANDS,
    createBuiltinTuiCommandRegistry,
    createConfiguredBuiltinTuiCommandRegistry,
    extensionCommandResultText,
    registerExtensionTuiCommands,
    renderTuiCommandSuggestions,
    tuiArgumentCompletion,
    tuiArgumentSuggestions,
    tuiSuggestionWindow,
    tuiCommandSuggestionsText,
    tuiCommandScope,
    TuiCommandRegistry,
    tuiWithArgument,
    type TuiCommandAction,
} from "../../clients/tui/commands.ts";

test("every slash action has an explicit pane scope", () => {
    const actions = [
        { type: "open_rewind" },
        { type: "open_fork" },
        { type: "update_model", model: "m" },
        { type: "update_reasoning", reasoningEffort: "low" },
        { type: "update_permissions", mode: "ask" },
        { type: "open_model_picker" },
        { type: "open_reasoning_picker" },
        { type: "open_permissions_picker" },
        { type: "open_preferences_list" },
        { type: "open_settings_menu" },
        { type: "open_command_palette" },
        { type: "prefill_composer", text: "/rename " },
        { type: "open_theme_picker" },
        { type: "open_resume_picker" },
        { type: "open_subagents_picker" },
        { type: "go_to_parent" },
        { type: "reconnect" },
        { type: "create_session" },
        { type: "update_session_name", name: "name" },
        { type: "clone_session" },
        { type: "compact_session" },
        { type: "show_diagnostics" },
        { type: "show_pool" },
        { type: "pool_current_model" },
        {
            type: "run_extension",
            command: "x",
            argumentsText: "",
            source: "test",
            origin: "client",
        },
        { type: "command_error", message: "bad" },
    ] satisfies readonly TuiCommandAction[];

    expect(actions.map((action) => [action.type, tuiCommandScope(action)]))
        .toEqual([
            ["open_rewind", "main_session"],
            ["open_fork", "main_session"],
            ["update_model", "focused_agent"],
            ["update_reasoning", "focused_agent"],
            ["update_permissions", "focused_agent"],
            ["open_model_picker", "focused_agent"],
            ["open_reasoning_picker", "focused_agent"],
            ["open_permissions_picker", "focused_agent"],
            ["open_preferences_list", "application"],
            ["open_settings_menu", "focused_agent"],
            ["open_command_palette", "application"],
            ["prefill_composer", "application"],
            ["open_theme_picker", "application"],
            ["open_resume_picker", "main_session"],
            ["open_subagents_picker", "main_session"],
            ["go_to_parent", "main_session"],
            ["reconnect", "main_session"],
            ["create_session", "main_session"],
            ["update_session_name", "main_session"],
            ["clone_session", "main_session"],
            ["compact_session", "main_session"],
            ["show_diagnostics", "application"],
            ["show_pool", "application"],
            ["pool_current_model", "application"],
            ["run_extension", "application"],
            ["command_error", "application"],
        ]);
});

test("built-in TUI commands match the public command catalog", () => {
    const registry = createBuiltinTuiCommandRegistry();

    expect(registry.registeredCommands()).toEqual(BUILTIN_COMMANDS);
    for (const command of BUILTIN_COMMANDS) {
        expect(registry.dispatch(`/${command.name}`)).toBeDefined();
    }
});

test("palette actions can exist without slash command aliases", () => {
    const registry = createBuiltinTuiCommandRegistry();

    expect(registry.registeredPaletteActions()).toContainEqual({
        name: "granted_permissions",
        label: "Review granted permissions",
        description: "see and revoke what you have approved",
        group: "Settings",
        action: { type: "open_preferences_list" },
    });
    expect(registry.suggestions("/granted_permissions")).toEqual([]);
    expect(registry.dispatch("/granted_permissions")).toBeUndefined();
});

test("every builtin command except the palette itself has a palette row", () => {
    const registry = createBuiltinTuiCommandRegistry();
    const slashNames = new Set(
        registry.registeredPaletteActions()
            .map((action) => action.slashName)
            .filter((name) => name !== undefined),
    );

    // The palette does not list itself: you are already looking at it.
    expect(BUILTIN_COMMANDS.map((command) => command.name)
        .filter((name) => !slashNames.has(name))).toEqual(["palette"]);
});

test("the rewind command returns a client-owned action", () => {
    const registry = createBuiltinTuiCommandRegistry();

    expect(registry.dispatch("/rewind")).toEqual({ type: "open_rewind" });
    expect(registry.dispatch("  /rewind  ")).toEqual({ type: "open_rewind" });
});

test("the fork command opens the prompt picker", () => {
    const registry = createBuiltinTuiCommandRegistry();

    expect(registry.dispatch("/fork")).toEqual({ type: "open_fork" });
    expect(registry.dispatch("/for")).toEqual({ type: "open_fork" });
    expect(registry.dispatch("/fork now")).toEqual({
        type: "command_error",
        message: "Usage: /fork",
    });
});

test("typing slash exposes the built-in rewind command", () => {
    const registry = createBuiltinTuiCommandRegistry();

    expect(registry.suggestions("/")).toEqual(BUILTIN_COMMANDS);
    expect(registry.suggestions("/rew")).toEqual([BUILTIN_COMMANDS[0]]);
    expect(registry.suggestions("/unknown")).toEqual([]);
    expect(registry.suggestions("message /rew")).toEqual([]);
    expect(registry.suggestions("/rewind now")).toEqual([]);
    expect(tuiCommandSuggestionsText(renderTuiCommandSuggestions(
        registry.suggestions("/"),
    ))).toContain("/model        Change the model for the next turn");
    expect(tuiCommandSuggestionsText(renderTuiCommandSuggestions(
        registry.suggestions("/"),
    ))).toContain("/fork         Fork from an earlier prompt");
    // The highlighted command carries the chevron marker; others are indented.
    expect(tuiCommandSuggestionsText(renderTuiCommandSuggestions(
        registry.suggestions("/"),
        0,
    ))).toContain("› /rewind");
    expect(registry.completion("/rew")).toBe("/rewind");
    expect(registry.completion("  /rew")).toBe("  /rewind");
    expect(registry.completion("/rewind")).toBeUndefined();
    expect(registry.completion("/wat")).toBeUndefined();
    expect(registry.completion("/rew now")).toBeUndefined();
    expect(registry.completion("rew")).toBeUndefined();
});

test("completion automatically includes every registered command", () => {
    const registry = new TuiCommandRegistry();
    for (const name of ["rewind", "rewrite"]) {
        registry.registerCommand({
            name,
            description: `${name} something`,
            usage: `/${name}`,
            action: { type: "open_rewind" },
        });
    }

    expect(registry.completion("/re")).toBe("/rew");
    expect(registry.completion("/rew")).toBeUndefined();
    expect(registry.completion("/rewri")).toBe("/rewrite");
});

test("the rewind command rejects arguments locally", () => {
    const registry = createBuiltinTuiCommandRegistry();

    expect(registry.dispatch("/rewind now")).toEqual({
        type: "command_error",
        message: "Usage: /rewind",
    });
    expect(registry.dispatch("/rewind\nlater")).toEqual({
        type: "command_error",
        message: "Usage: /rewind",
    });
});

test("model, reasoning, and permissions commands return typed updates", () => {
    const registry = createBuiltinTuiCommandRegistry();

    expect(registry.dispatch("/model moonshotai/kimi-k3")).toEqual({
        type: "update_model",
        model: "moonshotai/kimi-k3",
    });
    expect(registry.dispatch("/effort max")).toEqual({
        type: "update_reasoning",
        reasoningEffort: "max",
    });
    expect(registry.dispatch("/permissions ask")).toEqual({
        type: "update_permissions",
        mode: "ask",
    });
    expect(registry.dispatch("/permissions unattended")).toEqual({
        type: "update_permissions",
        mode: "unattended",
    });
    expect(registry.dispatch("/eff")).toEqual({
        type: "open_reasoning_picker",
    });
    expect(registry.dispatch("/mod")).toEqual({
        type: "open_model_picker",
    });
    expect(registry.dispatch("/perm")).toEqual({
        type: "open_permissions_picker",
    });
    // A provider-native level is not policed against Vera's own
    // off/low/medium/high/max words: it flows through as typed.
    expect(registry.dispatch("/effort turbo")).toEqual({
        type: "update_reasoning",
        reasoningEffort: "turbo",
    });
    expect(registry.dispatch("/model")).toEqual({
        type: "open_model_picker",
    });
    expect(registry.dispatch("/effort")).toEqual({
        type: "open_reasoning_picker",
    });
    expect(registry.dispatch("/permissions")).toEqual({
        type: "open_permissions_picker",
    });
    expect(registry.dispatch("/themes")).toEqual({
        type: "open_theme_picker",
    });
    expect(registry.dispatch("/them")).toEqual({
        type: "open_theme_picker",
    });
    expect(registry.dispatch("/resume")).toEqual({
        type: "open_resume_picker",
    });
    expect(registry.dispatch("/res")).toEqual({
        type: "open_resume_picker",
    });
    expect(registry.dispatch("/clear")).toEqual({
        type: "create_session",
    });
    expect(registry.dispatch("/c")).toBeUndefined();
    expect(registry.dispatch("/cle")).toEqual({ type: "create_session" });
    expect(registry.dispatch("/rename Planning")).toEqual({
        type: "update_session_name",
        name: "Planning",
    });
    expect(registry.dispatch("/rename")).toEqual({
        type: "update_session_name",
        name: null,
    });
    expect(registry.dispatch("/clone")).toEqual({
        type: "clone_session",
    });
    expect(registry.dispatch("/clo")).toEqual({ type: "clone_session" });
});

test("ordinary and unknown slash input remain ordinary prompts", () => {
    const registry = createBuiltinTuiCommandRegistry();

    expect(registry.dispatch("inspect /rewind handling")).toBeUndefined();
    expect(registry.dispatch("/unknown")).toBeUndefined();
    expect(registry.dispatch("/image /tmp/screen.png")).toBeUndefined();
    expect(registry.dispatch("/rewind-later")).toBeUndefined();
    expect(registry.dispatch("/r")).toBeUndefined();
    expect(registry.dispatch("/Rewind")).toBeUndefined();
});

test("TUI command registration rejects duplicate names", () => {
    const registry = new TuiCommandRegistry();
    const command = {
        name: "test",
        description: "Test the command registry",
        usage: "/test",
        action: { type: "open_rewind" } as const,
    };

    registry.registerCommand(command);
    expect(() => registry.registerCommand(command))
        .toThrow("Duplicate TUI command: /test");
});

test("extension commands join discovery and dispatch as plain actions", () => {
    const registry = createBuiltinTuiCommandRegistry();
    registerExtensionTuiCommands(registry, [{
        name: "hello",
        description: "Say hello",
        usage: "/hello [name]",
        source: "test.extension",
    }]);

    expect(registry.suggestions("/hel")).toEqual([{
        name: "hello",
        description: "Say hello",
        usage: "/hello [name]",
    }]);
    expect(registry.dispatch("/hello Nash")).toEqual({
        type: "run_extension",
        command: "hello",
        argumentsText: "Nash",
        source: "test.extension",
        origin: "host",
    });
});

test("conditional extension commands follow their live availability", () => {
    const registry = createBuiltinTuiCommandRegistry();
    let available = false;
    registerExtensionTuiCommands(registry, [{
        name: "remove",
        description: "Remove the sidekick",
        usage: "/remove",
        source: "test.extension",
        isAvailable: () => available,
    }]);

    expect(registry.suggestions("/rem")).toEqual([]);
    expect(registry.registeredPaletteActions().some(
        (entry) => entry.slashName === "remove",
    )).toBe(false);
    expect(registry.dispatch("/remove")).toEqual({
        type: "command_error",
        message: "/remove is unavailable",
    });

    available = true;
    expect(registry.suggestions("/rem").map((command) => command.name))
        .toEqual(["remove"]);
    expect(registry.registeredPaletteActions().some(
        (entry) => entry.slashName === "remove",
    )).toBe(true);
    expect(registry.dispatch("/remove")).toMatchObject({
        type: "run_extension",
        command: "remove",
    });
});

test("a hidden command still reserves its name atomically", () => {
    const registry = new TuiCommandRegistry();
    registry.registerCommand({
        name: "hidden",
        description: "Hidden command",
        usage: "/hidden",
        isAvailable: () => false,
        action: { type: "open_rewind" },
    });

    expect(() => registerExtensionTuiCommands(registry, [{
        name: "new-command",
        description: "A command before the collision",
        usage: "/new-command",
        source: "test.extension",
    }, {
        name: "hidden",
        description: "Colliding command",
        usage: "/hidden",
        source: "test.extension",
    }])).toThrow("Duplicate TUI command: /hidden");
    expect(registry.hasCommand("new-command")).toBe(false);
});

test("a live catalog can keep later command owners out", () => {
    const registry = new TuiCommandRegistry();
    let firstAvailable = false;
    registry.registerCommand({
        name: "first",
        description: "First command",
        usage: "/first",
        isAvailable: () => firstAvailable,
        action: { type: "open_rewind" },
    });
    const firstOwnerNames = new Set(registry.commandNames());
    registry.registerCommand({
        name: "later",
        description: "Later command",
        usage: "/later",
        action: { type: "open_rewind" },
    });

    expect(registry.registeredCommands(firstOwnerNames)).toEqual([]);
    firstAvailable = true;
    expect(registry.registeredCommands(firstOwnerNames).map(
        (command) => command.name,
    )).toEqual(["first"]);
});

test("extension commands cannot override built-in commands", () => {
    const registry = createBuiltinTuiCommandRegistry();

    expect(() => registerExtensionTuiCommands(registry, [{
        name: "rewind",
        description: "Replace rewind",
        usage: "/rewind",
        source: "test.extension",
    }])).toThrow("Duplicate TUI command: /rewind");
    expect(registry.dispatch("/rewind")).toEqual({ type: "open_rewind" });
});

test("an extension command collision registers none of the batch", () => {
    const registry = createBuiltinTuiCommandRegistry();

    expect(() => registerExtensionTuiCommands(registry, [{
        name: "hello",
        description: "Say hello",
        usage: "/hello",
        source: "test.extension",
    }, {
        name: "rewind",
        description: "Replace rewind",
        usage: "/rewind",
        source: "test.extension",
    }])).toThrow("Duplicate TUI command: /rewind");
    expect(registry.dispatch("/hello")).toBeUndefined();
});

test("extension prefixes cannot disable built-in abbreviations", () => {
    const registry = createBuiltinTuiCommandRegistry();
    registerExtensionTuiCommands(registry, [{
        name: "restore",
        description: "Restore something",
        usage: "/restore",
        source: "test.extension",
    }]);

    expect(registry.dispatch("/res")).toEqual({
        type: "open_resume_picker",
    });
    expect(registry.dispatch("/rest")).toEqual({
        type: "run_extension",
        command: "restore",
        argumentsText: "",
        source: "test.extension",
        origin: "host",
    });
});

test("extension command results preserve their typed presentation", () => {
    expect(extensionCommandResultText({
        version: 1,
        source: "test.extension/plain",
        body: { kind: "text", text: "plain result" },
    })).toBe("test.extension/plain: plain result");
    expect(extensionCommandResultText({
        version: 1,
        source: "test.extension/check",
        body: {
            kind: "notice",
            level: "warning",
            text: "check this",
        },
    })).toBe("test.extension/check [warning]: check this");
});

test("quickslot is supplied by the bundled extension, not the core catalog", () => {
    const registry = createBuiltinTuiCommandRegistry();

    expect(registry.dispatch("/quickslot")).toBeUndefined();
    expect(registry.suggestions("/p").map((command) => command.name))
        .toEqual(["permissions", "parent", "pool", "palette"]);
    expect(registry.dispatch("/p")).toBeUndefined();
    expect(registry.dispatch("/pa")).toBeUndefined();
    expect(registry.dispatch("/pal")).toEqual({ type: "open_command_palette" });
    expect(registry.dispatch("/pool")).toEqual({ type: "show_pool" });
    expect(registry.dispatch("/pool add")).toEqual({ type: "pool_current_model" });
    expect(registry.dispatch("/par")).toEqual({ type: "go_to_parent" });
    expect(registry.dispatch("/pe")).toEqual({ type: "open_permissions_picker" });
});

test("the bundled quickslot can be explicitly disabled for a replacement", () => {
    const registry = createConfiguredBuiltinTuiCommandRegistry([
        "vera.model-presets",
    ]);

    expect(registry.dispatch("/quickslot")).toBeUndefined();
    expect(registry.registeredPaletteActions().some(
        (action) => action.name === "quickslot",
    )).toBe(false);
});

test("only a declaring command completes its first argument", () => {
    const registry = new TuiCommandRegistry();
    registerExtensionTuiCommands(registry, [
        {
            name: "add",
            description: "Add a seat",
            usage: "/add <model> as <alias>",
            source: "advisor",
            arguments: "model",
        },
        {
            name: "drop",
            description: "Drop a seat",
            usage: "/drop <alias>",
            source: "advisor",
        },
    ], "client");

    expect(registry.argumentPrefix("/add gpt")).toEqual({
        kind: "model",
        prefix: "gpt",
    });
    expect(registry.argumentPrefix("/add ")).toEqual({
        kind: "model",
        prefix: "",
    });
    // Past the first argument, and on a command that asks for nothing.
    expect(registry.argumentPrefix("/add gpt-5.5 as m1")).toBeUndefined();
    expect(registry.argumentPrefix("/drop m1")).toBeUndefined();
    expect(registry.argumentPrefix("/add")).toBeUndefined();
    expect(registry.argumentPrefix("hello /add gpt")).toBeUndefined();
});

test("argument suggestions put prefix matches ahead of the rest", () => {
    const models = ["sonnet", "openai/gpt-5.5", "gpt-5.5-codex"];

    expect(tuiArgumentSuggestions(models, "")).toEqual(models);
    expect(tuiArgumentSuggestions(models, "gpt")).toEqual([
        "gpt-5.5-codex",
        "openai/gpt-5.5",
    ]);
    expect(tuiArgumentSuggestions(models, "SON")).toEqual(["sonnet"]);
    expect(tuiArgumentSuggestions(models, "zzz")).toEqual([]);
});

test("argument completion types only what every match shares", () => {
    const models = ["gpt-5.5", "gpt-5.5-codex", "sonnet"];

    expect(tuiArgumentCompletion(models, "g")).toBe("gpt-5.5");
    // Whole already: Tab steps past the name rather than doing nothing.
    expect(tuiArgumentCompletion(models, "gpt-5.5")).toBe("gpt-5.5 ");
    expect(tuiArgumentCompletion(models, "sonnet")).toBe("sonnet ");
    expect(tuiArgumentCompletion(models, "son")).toBe("sonnet");
    expect(tuiArgumentCompletion(models, "zzz")).toBeUndefined();
});

test("a chosen argument replaces the half-typed one", () => {
    expect(tuiWithArgument("/add gpt", "gpt-5.5")).toBe("/add gpt-5.5");
    expect(tuiWithArgument("/add ", "sonnet")).toBe("/add sonnet");
});

test("a list that fits is shown whole", () => {
    expect(tuiSuggestionWindow(4, 0, 10)).toEqual({
        start: 0,
        rows: 4,
        hidden: 0,
    });
});

test("a list too long for the pane gives up a row to say how many are left", () => {
    expect(tuiSuggestionWindow(20, 0, 6)).toEqual({
        start: 0,
        rows: 5,
        hidden: 15,
    });
});

test("the window follows the highlighted row down the list", () => {
    // The nineteenth of twenty, with room for five: the last five.
    expect(tuiSuggestionWindow(20, 18, 6)).toEqual({
        start: 14,
        rows: 5,
        hidden: 15,
    });
    // And no further: the end of the list is the end of the scroll.
    expect(tuiSuggestionWindow(20, 19, 6)).toEqual({
        start: 15,
        rows: 5,
        hidden: 15,
    });
});

test("room for nothing still leaves one row", () => {
    expect(tuiSuggestionWindow(20, 0, 0)).toEqual({
        start: 0,
        rows: 1,
        hidden: 19,
    });
});
