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

import {
    configuredModelFallback,
    configuredReviewer,
    configuredReviewers,
    configuredSubagentModel,
    eventLogEnabled,
    loadOptionalVeraConfig,
    loadOrCreateVeraConfig,
    developerOverrides,
    loadVeraConfig,
    updateVeraConfigDefaults,
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
        provider: "vera-strata",
        model: "strata",
        providers: {
            "vera-strata": {
                protocol: "openai-chat",
                base_url: "https://strata.example.com/v1/",
                credential: "api_key",
                api_key_env: "VERA_STRATA_API_KEY",
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
            name: "strata",
            provider: "vera-strata",
            model: "strata",
        }],
        model_routes: {},
        reviewer_profiles: {},
    }));

    expect(loadVeraConfig({ path })).toMatchObject({
        provider: "vera-strata",
        providers: {
            "vera-strata": {
                protocol: "openai-chat",
                base_url: "https://strata.example.com/v1",
                credential: "api_key",
                api_key_env: "VERA_STRATA_API_KEY",
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
            name: "strata",
            provider: "vera-strata",
            model: "strata",
        }],
    });
});

test("Vera config rejects undeclared and malformed provider instances", () => {
    const invalid = [
        { provider: "missing", providers: {} },
        {
            provider: "vera-strata",
            providers: {
                "vera-strata": {
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
                name: "strata",
                provider: "vera-strata",
                model: "strata",
            }],
            model_routes: {},
            reviewer_profiles: {},
        },
    ];
    for (const entry of invalid) {
        const path = temporaryConfigPath();
        writeFileSync(path, JSON.stringify({
            schema_version: 1,
            model: "strata",
            ...entry,
        }));
        expect(() => loadVeraConfig({ path })).toThrow("not a Vera config");
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

test("developer overrides merge field by field and read as off until enabled", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
    }));

    updateVeraConfigDefaults({ developer: { context_limit: 8_192 } }, { path });
    const stored = loadVeraConfig({ path });
    expect(stored.developer).toEqual({ context_limit: 8_192 });
    // Written but not in force: nothing reads an override while the block is
    // off, which is what makes turning it off one move rather than four.
    expect(developerOverrides(stored)).toBeUndefined();

    updateVeraConfigDefaults({ developer: { enabled: true } }, { path });
    const enabled = loadVeraConfig({ path });
    expect(developerOverrides(enabled))
        .toEqual({ context_limit: 8_192, enabled: true });

    updateVeraConfigDefaults({ developer: { context_limit: null } }, { path });
    expect(loadVeraConfig({ path }).developer).toEqual({ enabled: true });
});
