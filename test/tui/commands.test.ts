import { expect, test } from "bun:test";

import {
    BUILTIN_COMMANDS,
    createBuiltinTuiCommandRegistry,
    extensionCommandResultText,
    registerExtensionTuiCommands,
    renderTuiCommandSuggestions,
    tuiCommandSuggestionsText,
    TuiCommandRegistry,
} from "../../clients/tui/commands.ts";

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
    ))).toContain("/model  Change the model for the next turn");
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
    expect(registry.dispatch("/reasoning max")).toEqual({
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
    expect(registry.dispatch("/reas")).toEqual({
        type: "open_reasoning_picker",
    });
    expect(registry.dispatch("/mod")).toEqual({
        type: "open_model_picker",
    });
    expect(registry.dispatch("/perm")).toEqual({
        type: "open_permissions_picker",
    });
    expect(registry.dispatch("/reasoning turbo")).toMatchObject({
        type: "command_error",
    });
    expect(registry.dispatch("/model")).toEqual({
        type: "open_model_picker",
    });
    expect(registry.dispatch("/reasoning")).toEqual({
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
