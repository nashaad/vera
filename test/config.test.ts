import { expect, test } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { catalogMaxAgeMs } from "../src/host/runtime.ts";
import { DEFAULT_CATALOG_MAX_AGE_MS } from "../src/model/catalog-cache.ts";
import { OVERRIDE_KEYS } from "../src/engine/override-rows.ts";

import {
    configuredCompaction,
    configuredModelFallback,
    configuredReviewer,
    configuredReviewers,
    configuredSubagentModel,
    eventLogEnabled,
    loadOptionalVeraConfig,
    loadOrCreateVeraConfig,
    configuredCompactionOverrides,
    configuredToolResults,
    configuredOverrides,
    overridePatchDefaults,
    loadVeraConfig,
    updateVeraConfigDefaults,
    type VeraConfig,
    VeraConfigError,
} from "../src/config.ts";

test("Vera config loads the shared model choice", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "  anthropic/example-model  ",
    }));

    expect(loadVeraConfig({ path })).toEqual({
        schema_version: 1,
        provider: "openrouter",
        model: "anthropic/example-model",
        approval_mode: "auto",
    });
});

test("Vera config persists and clears the global context limit", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        context_limit: 204_800,
    }));

    expect(loadVeraConfig({ path }).context_limit).toBe(204_800);
    updateVeraConfigDefaults({ context_limit: null }, { path });
    expect(JSON.parse(readFileSync(path, "utf8")))
        .not.toHaveProperty("context_limit");
});

test("Vera config loads named provider instances", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        provider: "vera-sample",
        model: "sample",
        providers: {
            "vera-sample": {
                protocol: "openai-chat",
                base_url: "https://sample.example.com/v1/",
                credential: "api_key",
                api_key_env: "VERA_SAMPLE_API_KEY",
            },
            "lab-anthropic": {
                protocol: "anthropic-messages",
                base_url: "https://models.example.com/v1",
                credential: "none",
                images: true,
                max_tokens: 16_000,
                thinking: "adaptive",
            },
        },
        models: [{
            name: "sample",
            provider: "vera-sample",
            model: "sample",
        }],
        model_routes: {},
        reviewer_profiles: {},
    }));

    expect(loadVeraConfig({ path })).toMatchObject({
        provider: "vera-sample",
        providers: {
            "vera-sample": {
                protocol: "openai-chat",
                base_url: "https://sample.example.com/v1",
                credential: "api_key",
                api_key_env: "VERA_SAMPLE_API_KEY",
            },
            "lab-anthropic": {
                protocol: "anthropic-messages",
                base_url: "https://models.example.com/v1",
                credential: "none",
                images: true,
                max_tokens: 16_000,
                thinking: "adaptive",
            },
        },
        models: [{
            name: "sample",
            provider: "vera-sample",
            model: "sample",
        }],
    });
});

test("Vera config rejects undeclared and malformed provider instances", () => {
    const invalid = [
        { provider: "missing", providers: {} },
        {
            provider: "vera-sample",
            providers: {
                "vera-sample": {
                    protocol: "openai-chat",
                    base_url: "http://remote.example.com/v1",
                    credential: "none",
                },
            },
        },
        {
            provider: "openrouter",
            providers: {
                openrouter: {
                    protocol: "openai-chat",
                    base_url: "https://example.com/v1",
                    credential: "none",
                },
            },
        },
        {
            provider: "lab-anthropic",
            providers: {
                "lab-anthropic": {
                    protocol: "anthropic-messages",
                    base_url: "https://example.com/v1",
                    credential: "none",
                    max_tokens: 0,
                },
            },
        },
        {
            provider: "lab-openai",
            providers: {
                "lab-openai": {
                    protocol: "openai-chat",
                    base_url: "https://example.com/v1",
                    credential: "none",
                    thinking: "adaptive",
                },
            },
        },
        {
            provider: "openrouter",
            providers: {},
            models: [{
                name: "sample",
                provider: "vera-sample",
                model: "sample",
            }],
            model_routes: {},
            reviewer_profiles: {},
        },
        {
            provider: "./../../config",
            providers: {
                "./../../config": {
                    protocol: "openai-chat",
                    base_url: "https://example.com/v1",
                    credential: "none",
                },
            },
        },
    ];
    for (const entry of invalid) {
        const path = temporaryConfigPath();
        writeFileSync(path, JSON.stringify({
            schema_version: 1,
            model: "sample",
            ...entry,
        }));
        expect(() => loadVeraConfig({ path })).toThrow("not a Vera config");
    }
});

test("Vera config preserves independent dialog header and search styles", () => {
    for (const header_style of ["underline", "box"] as const) for (const search_style of [undefined, "border", "fill", "plain"] as const) {
        const path = temporaryConfigPath();
        const dialogs = { header_style, ...(search_style === undefined ? {} : { search_style }) };
        writeFileSync(path, JSON.stringify({ schema_version: 1, model: "anthropic/example-model", tui: { dialogs } }));
        expect(loadVeraConfig({ path }).tui?.dialogs).toEqual(dialogs);
        updateVeraConfigDefaults({ model: "anthropic/other-model" }, { path });
        expect(loadVeraConfig({ path }).tui?.dialogs).toEqual(dialogs);
    }
});

test("Vera config keeps the sidebar launch setting across a defaults update", () => {
    for (const open_at_launch of [true, false]) {
        const path = temporaryConfigPath();
        writeFileSync(path, JSON.stringify({ schema_version: 1, model: "anthropic/example-model", tui: { sidebar: { open_at_launch } } }));
        expect(loadVeraConfig({ path }).tui?.sidebar).toEqual({ open_at_launch });
        updateVeraConfigDefaults({ model: "anthropic/other-model" }, { path });
        expect(loadVeraConfig({ path }).tui?.sidebar).toEqual({ open_at_launch });
    }
});

test("the optional load tolerates absence but not damage", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "vera-config-")), "none.json");
    expect(loadOptionalVeraConfig({ path: missing })).toBeUndefined();

    const damaged = temporaryConfigPath();
    writeFileSync(damaged, "{ not json");
    // The distinction the TUI relies on: a client with no config gets defaults,
    // a client with a broken config still hears about it.
    expect(() => loadOptionalVeraConfig({ path: damaged })).toThrow();

    const present = temporaryConfigPath();
    writeFileSync(present, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
    }));
    expect(loadOptionalVeraConfig({ path: present })?.model)
        .toBe("anthropic/example-model");
});

test("Vera config carries client-owned TUI appearance settings", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        tui: {
            transcript: {
                padding_left: 1,
                padding_right: 3,
                activity_indent: 4,
                message_spacing: 2,
                tool_group_spacing: 1,
                separator_visible: false,
                separator_spacing_before: 0,
                separator_spacing_after: 2,
                separator_color: "#191919",
            },
            composer: {
                margin_horizontal: 3,
                padding_horizontal: 2,
                tip_indent: 4,
                boundary_color: "#303030",
            },
        },
    }));

    expect(loadVeraConfig({ path }).tui).toEqual({
        transcript: {
            padding_left: 1,
            padding_right: 3,
            activity_indent: 4,
            message_spacing: 2,
            tool_group_spacing: 1,
            separator_visible: false,
            separator_spacing_before: 0,
            separator_spacing_after: 2,
            separator_color: "#191919",
        },
        composer: {
            margin_horizontal: 3,
            padding_horizontal: 2,
            tip_indent: 4,
            boundary_color: "#303030",
        },
    });
});

test("Vera config rejects malformed TUI appearance settings", () => {
    const invalid = [
        { dialogs: [] },
        { dialogs: { header_style: "boxed" } },
        { dialogs: { header_style: null } },
        { dialogs: { search_style: "both" } },
        { dialogs: { search_style: null } },
        { sidebar: [] },
        { sidebar: { open_at_launch: "yes" } },
        { sidebar: { open_at_launch: null } },
        { transcript: [] },
        { transcript: { padding_left: -1 } },
        { transcript: { activity_indent: 0 } },
        { transcript: { message_spacing: 1.5 } },
        { transcript: { separator_visible: "no" } },
        { transcript: { separator_spacing_before: -1 } },
        { transcript: { separator_spacing_after: 6 } },
        { transcript: { separator_color: "dim" } },
        { composer: { margin_horizontal: 21 } },
        { composer: { padding_horizontal: -1 } },
        { composer: { tip_indent: "3" } },
        { composer: { boundary_color: "#1234" } },
    ];
    for (const tui of invalid) {
        const path = temporaryConfigPath();
        writeFileSync(path, JSON.stringify({
            schema_version: 1,
            model: "anthropic/example-model",
            tui,
        }));
        expect(() => loadVeraConfig({ path })).toThrow("not a Vera config");
    }
});

test("Vera config carries a subagent default model", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        subagent: {
            provider: "openrouter",
            model: "  openai/gpt-luna-medium  ",
            reasoning_effort: "medium",
        },
    }));

    const config = loadVeraConfig({ path });
    expect(config.subagent).toEqual({
        provider: "openrouter",
        model: "openai/gpt-luna-medium",
        reasoning_effort: "medium",
    });
    expect(configuredSubagentModel(config)).toEqual({
        provider: "openrouter",
        model: "openai/gpt-luna-medium",
        reasoningEffort: "medium",
    });
});

test("Vera config carries reviewer two-tier settings", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        provider: "openrouter",
        model: "anthropic/example-model",
        reviewer: {
            provider: "openrouter",
            model: "anthropic/review-model",
            two_tier: true,
            escalation_reasoning_effort: "high",
        },
    }));

    const config = loadVeraConfig({ path });

    expect(config.reviewer).toEqual({
        provider: "openrouter",
        model: "anthropic/review-model",
        two_tier: true,
        escalation_reasoning_effort: "high",
    });
    expect(configuredReviewer(config)).toEqual({
        models: [{
            provider: "openrouter",
            model: "anthropic/review-model",
        }],
        twoTier: true,
        escalationModel: {
            provider: "openrouter",
            model: "anthropic/review-model",
            reasoningEffort: "high",
        },
    });
});

test("Vera config leaves reviewer two-tier off by default", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        reviewer: {
            model: "anthropic/review-model",
            escalation_model: "anthropic/second-review-model",
        },
    }));

    expect(configuredReviewer(loadVeraConfig({ path }))).toEqual({
        models: [{ model: "anthropic/review-model" }],
        escalationModel: { model: "anthropic/second-review-model" },
    });
});

test("a damaged reviewer two-tier flag fails the load", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        reviewer: {
            model: "anthropic/review-model",
            two_tier: "yes",
        },
    }));

    expect(() => loadVeraConfig({ path })).toThrow();
});

test("a damaged subagent block fails the load rather than being dropped", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        subagent: { model: "   " },
    }));

    expect(() => loadVeraConfig({ path })).toThrow();
});

test("Vera config selects OpenAI Codex", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoning_effort: "off",
    }));

    expect(loadVeraConfig({ path })).toEqual({
        schema_version: 1,
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoning_effort: "off",
        approval_mode: "auto",
    });
});

test("Vera config selects Ollama without an API key", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        provider: "ollama",
        model: "gemma4:26b",
        reasoning_effort: "off",
    }));

    expect(loadVeraConfig({ path })).toEqual({
        schema_version: 1,
        provider: "ollama",
        model: "gemma4:26b",
        reasoning_effort: "off",
        approval_mode: "auto",
    });
});

test("Vera config loads each approval mode", () => {
    for (const approval_mode of ["ask", "auto", "full_access"] as const) {
        const path = temporaryConfigPath();
        writeFileSync(path, JSON.stringify({
            schema_version: 1,
            model: "anthropic/example-model",
            approval_mode,
        }));

        expect(loadVeraConfig({ path }).approval_mode).toBe(approval_mode);
    }
});

test("Vera config loads explicit extension paths and JSON settings", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        disabled_builtin_extensions: ["vera.model-presets"],
        extensions: [{
            path: "  /tmp/context-tools  ",
            enabled: false,
            config: {
                strategy: "hierarchical",
                levels: 3,
            },
        }, {
            path: "/tmp/session-graph",
        }],
    }));

    expect(loadVeraConfig({ path }).extensions).toEqual([{
        path: "/tmp/context-tools",
        enabled: false,
        config: {
            strategy: "hierarchical",
            levels: 3,
        },
    }, {
        path: "/tmp/session-graph",
        enabled: true,
        config: {},
    }]);
    expect(loadVeraConfig({ path }).disabled_builtin_extensions).toEqual([
        "vera.model-presets",
    ]);
});

test("Vera config discovers global extension directories", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-config-"));
    const extensionDirectory = join(root, "extensions");
    const extension = join(extensionDirectory, "web-search");
    mkdirSync(extension, { recursive: true });
    writeFileSync(
        join(extension, "vera.extension.json"),
        JSON.stringify({
            id: "nash.web-search",
            version: "0.1.0",
            sdk: "1",
            entrypoint: "./index.ts",
            capabilities: ["tools.register"],
        }),
    );
    const path = join(root, "config.json");
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        provider: "openrouter",
        model: "test/model",
    }));

    expect(loadVeraConfig({ path, extensionDirectory }).extensions).toEqual([{
        path: extension,
        enabled: true,
        config: {},
    }]);
});

test("an explicit extension entry overrides its discovered defaults", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-config-"));
    const extensionDirectory = join(root, "extensions");
    const extension = join(extensionDirectory, "web-search");
    mkdirSync(extension, { recursive: true });
    writeFileSync(join(extension, "vera.extension.json"), "{}");
    const path = join(root, "config.json");
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        provider: "openrouter",
        model: "test/model",
        extensions: [{
            path: extension,
            enabled: false,
            config: { provider: "brave" },
        }],
    }));

    expect(loadVeraConfig({ path, extensionDirectory }).extensions).toEqual([{
        path: extension,
        enabled: false,
        config: { provider: "brave" },
    }]);
});

test("a configured symlink can disable the same discovered extension", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-config-"));
    const extensionDirectory = join(root, "extensions");
    const extension = join(extensionDirectory, "web-search");
    const alias = join(root, "web-search-alias");
    mkdirSync(extension, { recursive: true });
    writeFileSync(join(extension, "vera.extension.json"), "{}");
    symlinkSync(extension, alias);
    const path = join(root, "config.json");
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        provider: "openrouter",
        model: "test/model",
        extensions: [{
            path: alias,
            enabled: false,
        }],
    }));

    expect(loadVeraConfig({ path }).extensions).toEqual([{
        path: alias,
        enabled: false,
        config: {},
    }]);
});

test("global discovery does not follow child symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-config-"));
    const extensionDirectory = join(root, "extensions");
    const outside = join(root, "outside");
    mkdirSync(extensionDirectory, { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, "vera.extension.json"), "{}");
    symlinkSync(outside, join(extensionDirectory, "linked"));
    const path = join(root, "config.json");
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        provider: "openrouter",
        model: "test/model",
    }));

    expect(loadVeraConfig({ path }).extensions).toBeUndefined();
});

test("VERA_EXTENSIONS replaces the configured extension list", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-config-"));
    const extensionDirectory = join(root, "extensions");
    const discovered = join(extensionDirectory, "web-search");
    mkdirSync(discovered, { recursive: true });
    writeFileSync(join(discovered, "vera.extension.json"), "{}");
    const path = join(root, "config.json");
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        provider: "openrouter",
        model: "test/model",
        extensions: [{ path: "/tmp/session-graph" }],
    }));

    const previous = process.env.VERA_EXTENSIONS;
    process.env.VERA_EXTENSIONS = ` ${root}/side , , ${root}/other `;
    try {
        expect(loadVeraConfig({ path, extensionDirectory }).extensions)
            .toEqual([{
                path: join(root, "side"),
                enabled: true,
                config: {},
            }, {
                path: join(root, "other"),
                enabled: true,
                config: {},
            }]);
    } finally {
        if (previous === undefined) {
            delete process.env.VERA_EXTENSIONS;
        } else {
            process.env.VERA_EXTENSIONS = previous;
        }
    }
});

test("Vera config reads the experimental inbox flag and defaults it off", () => {
    const bare = temporaryConfigPath();
    writeFileSync(bare, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
    }));
    expect(loadVeraConfig({ path: bare }).experimental).toBeUndefined();

    const enabled = temporaryConfigPath();
    writeFileSync(enabled, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        experimental: { inbox: true },
    }));
    expect(loadVeraConfig({ path: enabled }).experimental).toEqual({
        inbox: true,
    });
});

test("Vera config rejects a non-boolean experimental inbox flag", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        experimental: { inbox: "yes" },
    }));

    expect(() => loadVeraConfig({ path })).toThrow();
});

test("Vera config reads source-family inbox admission", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        inbox: { admit: [" filesystem ", "arc"] },
    }));

    expect(loadVeraConfig({ path }).inbox).toEqual({
        admit: ["filesystem", "arc"],
    });
});

test("Vera config rejects wildcard and duplicate inbox admission", () => {
    for (const admit of [["*"], ["arc", "arc"]]) {
        const path = temporaryConfigPath();
        writeFileSync(path, JSON.stringify({
            schema_version: 1,
            model: "anthropic/example-model",
            inbox: { admit },
        }));

        expect(() => loadVeraConfig({ path })).toThrow();
    }
});

test("Vera config reads the event log flag and defaults it on", () => {
    const bare = temporaryConfigPath();
    writeFileSync(bare, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
    }));
    expect(eventLogEnabled(loadVeraConfig({ path: bare }))).toBe(true);

    const off = temporaryConfigPath();
    writeFileSync(off, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        event_log: { enabled: false },
    }));
    expect(eventLogEnabled(loadVeraConfig({ path: off }))).toBe(false);

    const on = temporaryConfigPath();
    writeFileSync(on, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        event_log: { enabled: true },
    }));
    expect(eventLogEnabled(loadVeraConfig({ path: on }))).toBe(true);
});

test("Vera config rejects a non-boolean event log flag", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        event_log: { enabled: "yes" },
    }));

    expect(() => loadVeraConfig({ path })).toThrow();
});

test("Vera config keeps an http model feed url and defaults it absent", () => {
    const bare = temporaryConfigPath();
    writeFileSync(bare, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
    }));
    expect(loadVeraConfig({ path: bare }).model_feed_url).toBeUndefined();

    const set = temporaryConfigPath();
    writeFileSync(set, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        model_feed_url: " https://example.test/vera-curated.json ",
    }));
    expect(loadVeraConfig({ path: set }).model_feed_url)
        .toBe("https://example.test/vera-curated.json");
});

test("Vera config rejects a model feed url that is not http", () => {
    for (const url of ["", "not a url", "file:///etc/passwd", 7]) {
        const path = temporaryConfigPath();
        writeFileSync(path, JSON.stringify({
            schema_version: 1,
            model: "anthropic/example-model",
            model_feed_url: url,
        }));

        expect(() => loadVeraConfig({ path })).toThrow();
    }
});

test("Vera config keeps a model picker age cutoff and defaults it absent", () => {
    const bare = temporaryConfigPath();
    writeFileSync(bare, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
    }));
    expect(loadVeraConfig({ path: bare }).model_picker_max_age_months)
        .toBeUndefined();

    const set = temporaryConfigPath();
    writeFileSync(set, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        model_picker_max_age_months: 0,
    }));
    expect(loadVeraConfig({ path: set }).model_picker_max_age_months).toBe(0);
});

test("Vera config rejects a model picker age cutoff that is not a count", () => {
    for (const months of ["6", -1, Number.NaN, null]) {
        const path = temporaryConfigPath();
        writeFileSync(path, JSON.stringify({
            schema_version: 1,
            model: "anthropic/example-model",
            model_picker_max_age_months: months,
        }));

        expect(() => loadVeraConfig({ path })).toThrow();
    }
});

test("Vera config carries the version collapse switch, off when absent", () => {
    const bare = temporaryConfigPath();
    writeFileSync(bare, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
    }));
    expect(loadVeraConfig({ path: bare }).model_picker_collapse_versions)
        .toBeUndefined();

    const set = temporaryConfigPath();
    writeFileSync(set, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        model_picker_collapse_versions: true,
    }));
    expect(loadVeraConfig({ path: set }).model_picker_collapse_versions)
        .toBe(true);
});

test("Vera config rejects a version collapse switch that is not a flag", () => {
    for (const value of ["true", 1, null]) {
        const path = temporaryConfigPath();
        writeFileSync(path, JSON.stringify({
            schema_version: 1,
            model: "anthropic/example-model",
            model_picker_collapse_versions: value,
        }));

        expect(() => loadVeraConfig({ path })).toThrow();
    }
});

test("Vera config rejects malformed extension entries", () => {
    for (const extensions of [
        {},
        [null],
        [{ path: "" }],
        [{ path: "./context-tools" }],
        [{ path: "/tmp/example", enabled: "yes" }],
    ]) {
        const path = temporaryConfigPath();
        writeFileSync(path, JSON.stringify({
            schema_version: 1,
            model: "anthropic/example-model",
            extensions,
        }));

        expect(() => loadVeraConfig({ path })).toThrow(
            "not a Vera config",
        );
    }
});

test("Vera config migrates the former automatic mode name", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        approval_mode: "approve_for_me",
    }));

    expect(loadVeraConfig({ path }).approval_mode).toBe("auto");
});

test("Vera config loads the shared catalog, routes, and reviewer profiles", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        approval_mode: "unattended",
        models: [{
            provider: "openrouter",
            model: "anthropic/claude-opus-4.8",
            reasoning_effort: "max",
        }],
        model_routes: {
            permission_review: [
                "anthropic_claude_opus_4_8_max_openrouter",
            ],
        },
        reviewer_profiles: {
            default: {
                model_route: "permission_review",
                policy: "Allow ordinary actions that follow from the request.",
            },
        },
        permission_modes: {
            unattended: {
                default: "review",
                reviewer_profile: "default",
                rules: [{
                    when: { verb: "read" },
                    then: "allow",
                }],
            },
        },
    }));

    const config = loadVeraConfig({ path });
    expect(config).toMatchObject({
        approval_mode: "unattended",
        models: [{
            name: "anthropic_claude_opus_4_8_max_openrouter",
            provider: "openrouter",
            model: "anthropic/claude-opus-4.8",
            reasoning_effort: "max",
        }],
        model_routes: {
            permission_review: [
                "anthropic_claude_opus_4_8_max_openrouter",
            ],
        },
        reviewer_profiles: {
            default: {
                model_route: "permission_review",
                policy: "Allow ordinary actions that follow from the request.",
            },
        },
        permission_modes: {
            unattended: {
                name: "unattended",
                defaultOutcome: "review",
                reviewerProfile: "default",
                rules: [{
                    name: "unattended.rules.0",
                    when: { verb: "read" },
                    then: "allow",
                }],
            },
        },
    });
    expect(configuredReviewer(config)).toEqual({
        models: [{
            provider: "openrouter",
            model: "anthropic/claude-opus-4.8",
            reasoningEffort: "max",
        }],
        policy: "Allow ordinary actions that follow from the request.",
    });

    updateVeraConfigDefaults({ approval_mode: "ask" }, { path });
    expect(loadVeraConfig({ path }).permission_modes)
        .toEqual(config.permission_modes);
});

test("the deprecated permission_profiles config key still loads, as permission_modes", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        approval_mode: "ask",
        permission_profiles: {
            quiet: {
                default: "ask",
                rules: [],
            },
        },
    }));

    const config = loadVeraConfig({ path });
    expect(config.permission_modes).toEqual({
        quiet: { name: "quiet", defaultOutcome: "ask", rules: [] },
    });
    expect((config as unknown as Record<string, unknown>).permission_profiles)
        .toBeUndefined();

    // Saving migrates the config forward onto the new key.
    updateVeraConfigDefaults({ approval_mode: "ask" }, { path });
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw.permission_modes).toEqual({
        quiet: { default: "ask", rules: [] },
    });
    expect(raw.permission_profiles).toBeUndefined();
});

test("Vera config loads an engine model fallback", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "primary/model",
        fallback: {
            model: "  backup/model  ",
            after_failures: 2,
        },
    }));

    const config = loadVeraConfig({ path });
    expect(config.fallback).toEqual({
        model: "backup/model",
        after_failures: 2,
    });
    expect(configuredModelFallback(config)).toEqual({
        provider: "openrouter",
        model: "backup/model",
        afterFailures: 2,
    });
});

test("Vera config rejects an unreachable or circular fallback", () => {
    for (const fallback of [
        { model: "primary/model", after_failures: 2 },
        { model: "backup/model", after_failures: 4 },
        { model: "backup/model", after_failures: 1.5 },
    ]) {
        const path = temporaryConfigPath();
        writeFileSync(path, JSON.stringify({
            schema_version: 1,
            model: "primary/model",
            fallback,
        }));

        expect(() => loadVeraConfig({ path })).toThrow(
            "optional fallback with a different model and after_failures from 1 to 3",
        );
    }
});

test("a codex fallback no longer forbids a reasoning effort outright", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoning_effort: "medium",
        fallback: {
            model: "different-backup",
            after_failures: 2,
        },
    }));

    // This combination used to fail the whole config, because a fallback model
    // with no reasoning profile would carry the effort into the adapter and
    // throw. Recovery now drops the effort at the moment it falls back, so the
    // primary model keeps a dial it can genuinely use.
    expect(loadVeraConfig({ path })).toMatchObject({
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoning_effort: "medium",
    });
});

test("Vera config rejects a missing model", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({ schema_version: 1 }));

    expect(() => loadVeraConfig({ path })).toThrow(
        "expected schema_version 1, provider openrouter, openai-codex, ollama, omlx, cerebras, deepseek, or a name declared in providers, a non-empty model string",
    );
});

test("Vera config accepts a provider-native reasoning effort string", () => {
    // reasoning_effort is validated against the levels a model actually
    // offers, not a fixed word list, so a name outside Vera's own
    // off/low/medium/high/max vocabulary is not rejected at parse time.
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        reasoning_effort: "ultra",
    }));

    expect(loadVeraConfig({ path }).reasoning_effort).toBe("ultra");
});

test("Vera config rejects an empty reasoning effort", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        reasoning_effort: "",
    }));

    expect(() => loadVeraConfig({ path })).toThrow(
        "optional non-empty reasoning_effort string",
    );
});

test("Vera config rejects an unknown approval mode", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        approval_mode: "sometimes",
    }));

    expect(() => loadVeraConfig({ path })).toThrow(
        "optional approval_mode ask, auto, or full_access",
    );
});

test("Vera config reports its missing path", () => {
    const path = join(mkdtempSync(join(tmpdir(), "vera-config-")), "missing.json");

    expect(() => loadVeraConfig({ path })).toThrow(
        `Vera config not found at ${path}`,
    );
});

test("settings changes become defaults for newly created chats", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        provider: "openrouter",
        model: "moonshotai/kimi-k3",
        reasoning_effort: "max",
        approval_mode: "auto",
    }));

    expect(updateVeraConfigDefaults({
        model: "z-ai/glm-5.2",
        reasoning_effort: "high",
        approval_mode: "ask",
    }, { path })).toMatchObject({
        model: "z-ai/glm-5.2",
        reasoning_effort: "high",
        approval_mode: "ask",
    });
    expect(loadVeraConfig({ path })).toMatchObject({
        model: "z-ai/glm-5.2",
        reasoning_effort: "high",
        approval_mode: "ask",
    });
});

test("a null reasoning effort clears the stored default", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoning_effort: "high",
    }));

    // Omitting the field keeps whatever is stored, which is right for a patch
    // that is not about reasoning. Moving to a model that has no effort has to
    // say so, or the stale default outlives the model it belonged to.
    expect(updateVeraConfigDefaults({
        model: "gpt-5.6-codex",
        reasoning_effort: null,
    }, { path })).toMatchObject({
        model: "gpt-5.6-codex",
        reasoning_effort: undefined,
    });
    expect(loadVeraConfig({ path }).reasoning_effort).toBeUndefined();
});

test("a codex default keeps a reasoning effort its model supports", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        provider: "openrouter",
        model: "moonshotai/kimi-k3",
    }));

    expect(updateVeraConfigDefaults({
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoning_effort: "medium",
    }, { path })).toMatchObject({
        provider: "openai-codex",
        reasoning_effort: "medium",
    });
});

test("switching providers clears a provider-specific fallback", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        provider: "openrouter",
        model: "primary/model",
        fallback: { model: "backup/model", after_failures: 2 },
    }));

    expect(updateVeraConfigDefaults({
        provider: "ollama",
        model: "local-model",
    }, { path })).toMatchObject({
        provider: "ollama",
        model: "local-model",
        fallback: undefined,
    });
});

test("updating the defaults does not resurrect a migrated pool key", () => {
    // The pool used to live in this file. A key this file migrated away from
    // is not a foreign key, so carrying it across would put the dead copy back
    // and leave two records of the pool.
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        approval_mode: "ask",
        pool: [{ provider: "openai-codex", model: "gpt-5.6-sol" }],
    }));

    updateVeraConfigDefaults({ model: "some-other-model" }, { path });

    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    expect((raw as Record<string, unknown>).pool).toBeUndefined();
    expect(loadVeraConfig({ path }).model).toBe("some-other-model");
});

test("clearing a default removes the key from the written file", () => {
    // The typed update wins over the raw value even when it sets a field to
    // undefined, so clearing is not a casualty of preserving unknown keys.
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoning_effort: "high",
        approval_mode: "ask",
    }));

    updateVeraConfigDefaults({ reasoning_effort: null }, { path });

    const written: unknown = JSON.parse(readFileSync(path, "utf8"));
    expect(written).not.toHaveProperty("reasoning_effort");
    expect(written).toHaveProperty("approval_mode", "ask");
});

function temporaryConfigPath(): string {
    return join(mkdtempSync(join(tmpdir(), "vera-config-")), "config.json");
}

test("Vera config loads disabled prompt contribution ids", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        disabled_prompt_contributions: [" core.scratchpad "],
    }));

    expect(loadVeraConfig({ path }).disabled_prompt_contributions).toEqual([
        "core.scratchpad",
    ]);
});

test("Vera config rejects malformed disabled prompt contribution lists", () => {
    for (const disabled_prompt_contributions of [
        "core.scratchpad",
        [""],
        [42],
        ["core.scratchpad", "core.scratchpad"],
    ]) {
        const path = temporaryConfigPath();
        writeFileSync(path, JSON.stringify({
            schema_version: 1,
            model: "anthropic/example-model",
            disabled_prompt_contributions,
        }));

        expect(() => loadVeraConfig({ path })).toThrow(
            "not a Vera config",
        );
    }
});

test("a damaged config names the file and the parse problem", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, "{ not json");

    expect(() => loadVeraConfig({ path })).toThrow(VeraConfigError);
    expect(() => loadVeraConfig({ path })).toThrow(
        `Vera config at ${path} could not be read: it is not valid JSON`,
    );
});

test("a plain reviewer block is the default profile beside a catalog", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        models: [{
            provider: "openrouter",
            model: "anthropic/claude-opus-4.8",
            reasoning_effort: "max",
        }],
        model_routes: {
            deep: ["anthropic_claude_opus_4_8_max_openrouter"],
        },
        reviewer_profiles: {
            deep: { model_route: "deep", policy: "Be careful." },
        },
        reviewer: {
            model: "haiku",
            provider: "openrouter",
            fallback_model: "sonnet",
        },
    }));

    const reviewers = configuredReviewers(loadVeraConfig({ path }));
    expect(Object.keys(reviewers).toSorted()).toEqual(["deep", "default"]);
    expect(reviewers.default?.models).toEqual([
        { model: "haiku", provider: "openrouter" },
        { model: "sonnet", provider: "openrouter" },
    ]);
});

test("an inline classifier assignment supplies the default reviewer", () => {
    const config: VeraConfig = {
        schema_version: 1,
        provider: "openrouter",
        model: "agent",
        approval_mode: "auto",
        model_assignments: {
            reviewer: {
                models: [{
                    name: "classifier",
                    provider: "openrouter",
                    model: "qwen/qwen3.8-max",
                    reasoning_effort: "medium",
                }],
            },
        },
    };

    expect(configuredReviewer(config)).toEqual({
        models: [{
            provider: "openrouter",
            model: "qwen/qwen3.8-max",
            reasoningEffort: "medium",
        }],
    });
});

test("the direct classifier picker overrides a default profile route", () => {
    const config: VeraConfig = {
        schema_version: 1,
        provider: "openrouter",
        model: "agent",
        approval_mode: "auto",
        model_assignments: {
            reviewer: {
                models: [{
                    name: "assigned",
                    provider: "openrouter",
                    model: "assigned-classifier",
                }],
            },
        },
        reviewer_profiles: {
            default: {
                policy: "Keep this policy.",
                timeout_ms: 12_000,
            },
        },
        reviewer: {
            provider: "openrouter",
            model: "picker-classifier",
        },
    };

    expect(configuredReviewer(config)).toEqual({
        models: [{
            provider: "openrouter",
            model: "picker-classifier",
        }],
        policy: "Keep this policy.",
        timeoutMs: 12_000,
    });
});

test("a configured hook is bound to the profile's hooks directory", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        hooks: [
            { phase: "pre_tool_use", argv: ["guard.ts", "--strict"] },
            {
                phase: "post_tool_use",
                argv: ["./nested/note.ts"],
                protocol: "vera",
                timeout_ms: 2000,
            },
        ],
    }));

    expect(loadVeraConfig({ path }).hooks).toEqual([
        {
            phase: "pre_tool_use",
            argv: [join(dirname(path), "hooks", "guard.ts"), "--strict"],
        },
        {
            phase: "post_tool_use",
            argv: [join(dirname(path), "hooks", "nested", "note.ts")],
            protocol: "vera",
            timeout_ms: 2000,
        },
    ]);
});

test("a hook command outside the hooks directory is refused at load", () => {
    // The door is the profile's own hooks directory. A config that travels
    // between machines cannot name an arbitrary binary on this one.
    for (const argv of [["/bin/sh"], ["../escape.ts"], ["."]]) {
        const path = temporaryConfigPath();
        writeFileSync(path, JSON.stringify({
            schema_version: 1,
            model: "anthropic/example-model",
            hooks: [{ phase: "pre_tool_use", argv }],
        }));
        expect(() => loadVeraConfig({ path })).toThrow(VeraConfigError);
    }
});

test("a malformed hook entry rejects the config", () => {
    for (const hook of [
        { phase: "on_start", argv: ["guard.ts"] },
        { phase: "pre_tool_use", argv: [] },
        { phase: "pre_tool_use", argv: ["guard.ts"], protocol: "shell" },
        { phase: "pre_tool_use", argv: ["guard.ts"], timeout_ms: 0 },
    ]) {
        const path = temporaryConfigPath();
        writeFileSync(path, JSON.stringify({
            schema_version: 1,
            model: "anthropic/example-model",
            hooks: [hook],
        }));
        expect(() => loadVeraConfig({ path })).toThrow("not a Vera config");
    }
});

test("writing config defaults keeps hook commands as the user wrote them", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        hooks: [{ phase: "pre_tool_use", argv: ["guard.ts"] }],
    }));

    updateVeraConfigDefaults({ model: "anthropic/other-model" }, { path });

    expect(JSON.parse(readFileSync(path, "utf8")).hooks)
        .toEqual([{ phase: "pre_tool_use", argv: ["guard.ts"] }]);
});

test("a machine with no config gets one made rather than an error", () => {
    const path = temporaryConfigPath();

    const created = loadOrCreateVeraConfig({ path });

    // Read back through the real reader: the file a start writes has to be one
    // the next start accepts.
    expect(loadVeraConfig({ path })).toEqual(created);
    expect(created.schema_version).toBe(1);
    expect(created.model.length).toBeGreaterThan(0);
    expect(created.approval_mode).toBe("auto");

    // The mode is the parser's default, not a decision the file records. A
    // created config settles a model and leaves the permissions posture to
    // whoever chooses one.
    expect(JSON.parse(readFileSync(path, "utf8")))
        .not.toHaveProperty("approval_mode");
});

test("a config that is already there is read, not replaced", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        approval_mode: "ask",
    }));

    const config = loadOrCreateVeraConfig({ path });

    expect(config.model).toBe("anthropic/example-model");
    expect(config.approval_mode).toBe("ask");
});

test("a config that exists but cannot be parsed is still refused", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, "{ not json");

    // An edit to fix, not an absence to fill: overwriting it would throw the
    // user's own file away.
    expect(() => loadOrCreateVeraConfig({ path })).toThrow(VeraConfigError);
    expect(readFileSync(path, "utf8")).toBe("{ not json");
});

test("Vera config carries a catalog max age, defaulted to a week when absent", () => {
    const bare = temporaryConfigPath();
    writeFileSync(bare, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
    }));
    const config = loadVeraConfig({ path: bare });
    expect(config.model_catalog_max_age_days).toBeUndefined();
    expect(catalogMaxAgeMs(config)).toBe(DEFAULT_CATALOG_MAX_AGE_MS);

    const set = temporaryConfigPath();
    writeFileSync(set, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        model_catalog_max_age_days: 0,
    }));
    const always = loadVeraConfig({ path: set });
    expect(always.model_catalog_max_age_days).toBe(0);
    // Zero is the opt-out: ask the provider on every start, as Vera used to.
    expect(catalogMaxAgeMs(always)).toBe(0);
});

test("Vera config rejects a catalog max age that is not a count", () => {
    for (const days of ["7", -1, Number.NaN, null]) {
        const path = temporaryConfigPath();
        writeFileSync(path, JSON.stringify({
            schema_version: 1,
            model: "anthropic/example-model",
            model_catalog_max_age_days: days,
        }));

        expect(() => loadVeraConfig({ path })).toThrow();
    }
});

test("a tool result patch merges field by field", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
    }));

    updateVeraConfigDefaults({ tool_results: { ceiling_bytes: 8_192 } }, { path });
    expect(loadVeraConfig({ path }).tool_results)
        .toEqual({ ceiling_bytes: 8_192 });

    updateVeraConfigDefaults({ tool_results: { aging_level: "tight" } }, { path });
    expect(loadVeraConfig({ path }).tool_results)
        .toEqual({ ceiling_bytes: 8_192, aging_level: "tight" });

    updateVeraConfigDefaults({ tool_results: { ceiling_bytes: null } }, { path });
    expect(loadVeraConfig({ path }).tool_results).toEqual({ aging_level: "tight" });
});

test("configured overrides carry only what the config wrote", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        context_limit: 32_768,
        compaction: { trigger_fraction: 0.6 },
        tool_results: { ceiling_bytes: 8_192, aging_level: "auto" },
    }));

    // `auto` is what a session does with nothing set, so it is not a value the
    // pane should show as chosen.
    expect(configuredOverrides(loadVeraConfig({ path }))).toEqual({
        contextLimit: 32_768,
        compactionTriggerFraction: 0.6,
        toolResultCeilingBytes: 8_192,
    });
});

test("an override patch lands in the blocks its levers belong to", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
    }));

    updateVeraConfigDefaults(
        overridePatchDefaults({
            contextLimit: 32_768,
            compactionTriggerFraction: 0.6,
            summaryWordCap: 500,
            toolResultCeilingBytes: 8_192,
            toolResultAgingLevel: "tight",
        }),
        { path },
    );

    expect(configuredOverrides(loadVeraConfig({ path }))).toEqual({
        contextLimit: 32_768,
        compactionTriggerFraction: 0.6,
        summaryWordCap: 500,
        toolResultCeilingBytes: 8_192,
        toolResultAgingLevel: "tight",
    });
});

test("a reset clears every lever and leaves the rest of the config alone", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        context_limit: 32_768,
        approval_mode: "ask",
        models: [{ provider: "openrouter", model: "anthropic/claude-opus-4.8" }],
        model_routes: { summarizer: ["anthropic_claude_opus_4_8_openrouter"] },
        reviewer_profiles: {},
        compaction: {
            strategy: "vera/full-summary",
            models: { summarizer: "summarizer" },
            trigger_fraction: 0.6,
        },
        tool_results: { ceiling_bytes: 8_192 },
    }));

    const cleared: Record<string, null> = {};
    for (const key of OVERRIDE_KEYS) {
        cleared[key] = null;
    }
    updateVeraConfigDefaults(overridePatchDefaults(cleared), { path });

    const config = loadVeraConfig({ path });
    expect(configuredOverrides(config)).toEqual({});
    // The strategy is a binding, not a number, so a reset must not unbind it.
    expect(config.compaction?.strategy).toBe("vera/full-summary");
    expect(config.approval_mode).toBe("ask");
});

test("tool result limits load as written", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        tool_results: {
            ceiling_bytes: 32_768,
            total_budget_bytes: 262_144,
            stub_after_turns: 5,
            aging_level: "tight",
        },
    }));

    expect(loadVeraConfig({ path }).tool_results).toEqual({
        ceiling_bytes: 32_768,
        total_budget_bytes: 262_144,
        stub_after_turns: 5,
        aging_level: "tight",
    });
});

test("an absent tool result block leaves the key off the config", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
    }));

    expect(loadVeraConfig({ path }).tool_results).toBeUndefined();
});

test("a partial tool result block keeps only the keys it names", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        tool_results: { stub_after_turns: 0 },
    }));

    expect(loadVeraConfig({ path }).tool_results)
        .toEqual({ stub_after_turns: 0 });
});

test("Vera config rejects unusable tool result limits", () => {
    // The control: without it every case below passes on a parser that
    // rejects everything.
    const accepted = temporaryConfigPath();
    writeFileSync(accepted, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        tool_results: { ceiling_bytes: 1 },
    }));
    expect(loadVeraConfig({ path: accepted }).tool_results)
        .toEqual({ ceiling_bytes: 1 });

    const rejected: readonly unknown[] = [
        [],
        "tight",
        { ceiling_bytes: 0 },
        { ceiling_bytes: 1.5 },
        { ceiling_bytes: "65536" },
        { total_budget_bytes: -1 },
        { stub_after_turns: -1 },
        { stub_after_turns: 2.5 },
        { aging_level: "loose" },
        { aging_level: 3 },
        { ceiling_bytes: 262_144, total_budget_bytes: 131_072 },
        { ceiling_bytes: Number.MAX_SAFE_INTEGER + 1 },
        { stub_after_turns: Number.MAX_SAFE_INTEGER + 1 },
        // Each alone contradicts the other's standing value: the ceiling is
        // 64 KiB and the budget for all results together is 128 KiB.
        { ceiling_bytes: 200_000 },
        { total_budget_bytes: 32_768 },
    ];

    for (const tool_results of rejected) {
        const path = temporaryConfigPath();
        writeFileSync(path, JSON.stringify({
            schema_version: 1,
            model: "anthropic/example-model",
            tool_results,
        }));

        expect(() => loadVeraConfig({ path })).toThrow();
    }
});

test("a ceiling equal to the whole budget is allowed", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        tool_results: { ceiling_bytes: 65_536, total_budget_bytes: 65_536 },
    }));

    expect(loadVeraConfig({ path }).tool_results)
        .toEqual({ ceiling_bytes: 65_536, total_budget_bytes: 65_536 });
});

test("a numbers-only compaction block survives a full config load", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        compaction: {
            trigger_fraction: 0.7,
            target_fraction: 0.4,
            min_summary_tokens: 500,
            max_attempts: 2,
            summary_word_cap: 2_000,
            assumed_window_tokens: 64_000,
            unknown_target_fraction: 0.3,
        },
    }));

    const loaded = loadVeraConfig({ path });
    expect(loaded.compaction).toEqual({
        trigger_fraction: 0.7,
        target_fraction: 0.4,
        min_summary_tokens: 500,
        max_attempts: 2,
        summary_word_cap: 2_000,
        assumed_window_tokens: 64_000,
        unknown_target_fraction: 0.3,
    });
    // Numbers alone bind no strategy, so the session keeps the compaction it
    // would have run anyway.
    expect(configuredCompaction(loaded)).toBeUndefined();
});

test("an unrelated write leaves a stored compaction block alone", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        compaction: { trigger_fraction: 0.7 },
        tool_results: { stub_after_turns: 4 },
    }));

    updateVeraConfigDefaults({ model: "anthropic/other-model" }, { path });
    const reloaded = loadVeraConfig({ path });
    expect(reloaded.model).toBe("anthropic/other-model");
    expect(reloaded.compaction).toEqual({ trigger_fraction: 0.7 });
    expect(reloaded.tool_results).toEqual({ stub_after_turns: 4 });
});

test("a written compaction number leaves the strategy and its routes alone", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        models: [{ provider: "openrouter", model: "anthropic/claude-opus-4.8" }],
        model_routes: { summarizer: ["anthropic_claude_opus_4_8_openrouter"] },
        reviewer_profiles: {},
        compaction: {
            strategy: "vera/full-summary",
            models: { summarizer: "summarizer" },
            trigger_fraction: 0.7,
        },
    }));

    updateVeraConfigDefaults({ compaction: { summary_word_cap: 300 } }, {
        path,
    });

    // Retuning a number must not unbind the models compaction runs on.
    expect(loadVeraConfig({ path }).compaction).toEqual({
        strategy: "vera/full-summary",
        models: { summarizer: "summarizer" },
        trigger_fraction: 0.7,
        summary_word_cap: 300,
    });

    updateVeraConfigDefaults({ compaction: { trigger_fraction: null } }, {
        path,
    });
    expect(loadVeraConfig({ path }).compaction?.trigger_fraction)
        .toBeUndefined();
});

test("compaction numbers retune the scheduler on their own", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        compaction: {
            trigger_fraction: 0.6,
            trigger_tokens: 40_000,
            target_tokens: 12_000,
            target_fraction: 0.3,
            summary_word_cap: 400,
            retained_user_turns: 5,
        },
    }));

    // Developer mode decides what a pane shows, not which numbers are live.
    expect(configuredCompactionOverrides(loadVeraConfig({ path }))).toEqual({
        triggerFraction: 0.6,
        triggerTokens: 40_000,
        targetTokens: 12_000,
        postCompactionTargetFraction: 0.3,
        summaryWordCap: 400,
        retainedUserTurns: 5,
    });
});

test("tool result limits reach the engine in its own terms", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        tool_results: {
            ceiling_bytes: 16_384,
            total_budget_bytes: 49_152,
            stub_after_turns: 1,
            aging_level: "tight",
        },
    }));

    expect(configuredToolResults(loadVeraConfig({ path }))).toEqual({
        ceilingBytes: 16_384,
        totalBudgetBytes: 49_152,
        stubAfterTurns: 1,
        agingLevel: "tight",
    });
});

test("an auto aging level leaves the row to the window", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        tool_results: { aging_level: "auto", stub_after_turns: 0 },
    }));

    // `auto` is the absence of a choice, so it must not pin a row.
    expect(configuredToolResults(loadVeraConfig({ path }))).toEqual({
        stubAfterTurns: 0,
    });
});

test("an empty tool result block limits nothing", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        tool_results: {},
    }));

    expect(configuredToolResults(loadVeraConfig({ path }))).toBeUndefined();
});

test("a compaction block with no numbers overrides nothing", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        models: [{ provider: "openrouter", model: "anthropic/claude-opus-4.8" }],
        model_routes: { summarizer: ["anthropic_claude_opus_4_8_openrouter"] },
        reviewer_profiles: {},
        compaction: {
            strategy: "vera/full-summary",
            models: { summarizer: "summarizer" },
        },
    }));

    expect(configuredCompactionOverrides(loadVeraConfig({ path })))
        .toBeUndefined();

    const bare = temporaryConfigPath();
    writeFileSync(bare, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
    }));
    expect(configuredCompactionOverrides(loadVeraConfig({ path: bare })))
        .toBeUndefined();
});
