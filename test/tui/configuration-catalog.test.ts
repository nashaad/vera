import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { VeraConfig } from "../../src/config.ts";
import {
    buildConfigurationCatalog,
    VERA_CONFIG_CATALOG_KEYS,
} from "../../clients/tui/configuration-catalog.ts";
import {
    handleTuiSettingsPickerKey,
    startTuiConfigurationCatalog,
    startTuiSettingsPicker,
    tuiPickerMenuAncestor,
    withTuiPickerParent,
} from "../../clients/tui/settings-picker.ts";

function context(home: string, projectRoot: string, config: VeraConfig) {
    const profile = join(home, "profiles", "default");
    mkdirSync(join(projectRoot, ".vera"), { recursive: true });
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "tui.json"), JSON.stringify({
        theme: "nightowl",
        animation: "shimmer",
        keybindings: { open_settings: "ctrl+comma" },
    }));
    return {
        config,
        projectRoot,
        environment: {
            VERA_HOME: home,
            VERA_PROFILE: "default",
            VERA_POOL_FILE: join(profile, "pool.json"),
            OLLAMA_HOST: "http://localhost:11434",
            OPENROUTER_API_KEY: "secret-must-not-appear",
            VISUAL: "nvim",
        },
        authStorage: {
            getCredential: (provider: string) => provider === "deepseek"
                ? { type: "api_key" as const, key: "another-secret" }
                : undefined,
        },
    };
}

test("the settings catalog names every supported config root and unknown fields", () => {
    const home = mkdtempSync(join(tmpdir(), "vera-catalog-home-"));
    const projectRoot = mkdtempSync(join(tmpdir(), "vera-catalog-project-"));
    const raw = {
        schema_version: 1,
        provider: "openrouter",
        model: "openai/gpt-5",
        approval_mode: "auto",
        permission_profiles: { old: {} },
        event_log: { enabled: false },
        tips: { enabled: false },
        unknown_lever: "ignored by the parser",
    } as unknown as VeraConfig;
    mkdirSync(join(home, "profiles", "default"), { recursive: true });
    writeFileSync(
        join(home, "profiles", "default", "config.json"),
        JSON.stringify(raw),
    );

    const entries = buildConfigurationCatalog(
        context(home, projectRoot, raw),
    );
    const ids = new Set(entries.map((entry) => entry.id));
    expect(ids).toContain("config.event_log");
    expect(ids).toContain("config.tips");
    expect(ids).toContain("config.permission_profiles");
    expect(ids).toContain("config.unknown.unknown_lever");
    expect(ids).toContain("launch.provider.ollama.endpoint");
    expect(ids).toContain("launch.bare");
    expect(ids).toContain("launch.visual");
    for (const key of VERA_CONFIG_CATALOG_KEYS) {
        if (key === "permission_profiles") continue;
        expect(
            entries.some((entry) => entry.location.includes(`#${key}`)),
        ).toBe(true);
    }
    for (const entry of entries) {
        expect(entry.location.length).toBeGreaterThan(0);
        expect(entry.scope.length).toBeGreaterThan(0);
        expect(entry.apply.length).toBeGreaterThan(0);
        expect(entry.description).not.toContain("secret-must-not-appear");
        expect(entry.description).not.toContain("another-secret");
        expect(entry.value).not.toContain("secret-must-not-appear");
        expect(entry.value).not.toContain("another-secret");
    }
});

test("the catalog exposes nested levers, exact ownership, fallbacks, and redaction", () => {
    const home = mkdtempSync(join(tmpdir(), "vera-catalog-home-"));
    const projectRoot = mkdtempSync(join(tmpdir(), "vera-catalog-project-"));
    const profile = join(home, "profiles", "default");
    mkdirSync(profile, { recursive: true });
    const raw = {
        schema_version: 1,
        provider: "openrouter",
        model: "openai/gpt-5",
        approval_mode: "auto",
        event_log: { enabled: false, extra: true },
        compaction: { trigger_tokens: 12345, target_tokens: 5000 },
        reviewer: {
            model: "openai/gpt-5",
            escalation_model: "openai/gpt-5-mini",
        },
        provider_endpoints: {
            openrouter: "https://user:feed-secret@example.test/v1?api_key=url-secret",
        },
        model_feed_url: "https://user:feed-secret@example.test/feed?sig=url-secret",
        extensions: [{
            path: "/tmp/example-extension",
            enabled: true,
            config: { cookie: "extension-cookie-secret", mode: "fast" },
        }],
        hooks: [{
            phase: "pre_tool_use",
            argv: ["hook.sh", "--token", "hook-secret"],
        }],
        reviewer_profiles: {
            strict: {
                model_route: "reviewers",
                policy: "be strict",
                timeout_ms: 10_000,
            },
        },
        models: [{
            name: "reviewer-model",
            provider: "openrouter",
            model: "openai/gpt-5",
        }],
        model_routes: { reviewers: ["reviewer-model"] },
        model_assignments: {
            extra: { model_route: "reviewers", unknown_assignment_field: true },
        },
        permission_modes: {
            custom: {
                default: "ask",
                rules: [{
                    when: { tool: "bash", unknown_predicate_field: true },
                    then: "ask",
                }],
            },
        },
    } as unknown as VeraConfig;
    writeFileSync(join(profile, "config.json"), JSON.stringify(raw));
    writeFileSync(join(profile, "tui.json"), JSON.stringify({
        theme: "not-a-theme",
        animation_interval_ms: 1,
        mystery: "ignored",
        extensions: { example: { api_token: "extension-secret", mode: "fast" } },
    }));
    writeFileSync(join(profile, "spawn-consent.json"), JSON.stringify({
        spawn_on_event: { confirmed_at: "2026-08-25T12:00:00.000Z" },
    }));
    mkdirSync(join(projectRoot, ".vera"), { recursive: true });
    writeFileSync(join(projectRoot, ".vera", "config.json"), JSON.stringify({
        inbox: { admit: ["vera"], unknown_project_nested: true },
        unknown_project_root: true,
    }));

    const catalogContext = context(home, projectRoot, {
        ...raw,
        permission_modes: {
            custom: {
                name: "custom",
                defaultOutcome: "ask",
                rules: [],
            },
        },
    } as unknown as VeraConfig);
    writeFileSync(join(profile, "tui.json"), JSON.stringify({
        theme: "not-a-theme",
        animation_interval_ms: 1,
        mystery: "ignored",
        extensions: { example: { api_token: "extension-secret", mode: "fast" } },
    }));
    const entries = buildConfigurationCatalog(catalogContext);
    for (const entry of entries) {
        for (const fact of entry.facts ?? []) {
            if (typeof fact[1] !== "string") {
                throw new Error(`non-string fact: ${entry.id} ${String(fact[0])}`);
            }
        }
    }
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    expect(byId.has("config.unknown.event_log_extra")).toBe(true);
    expect(byId.has("tui.unknown.mystery")).toBe(true);
    expect(byId.has("tui.invalid.theme")).toBe(true);
    expect(byId.has("tui.invalid.animation_interval_ms")).toBe(true);
    expect(byId.has("state.spawn_consent")).toBe(true);
    expect(byId.has("extensions.profile.registry")).toBe(true);
    expect(byId.has("extensions.project.registry")).toBe(true);
    expect(byId.has("agents.default_pair")).toBe(true);
    expect(byId.has("launch.arc_config")).toBe(true);
    expect(byId.has("config.unknown.model_assignments_extra_unknown_assignment_field")).toBe(true);
    expect(byId.has("config.unknown.permission_modes_custom_rules_0_when_unknown_predicate_field")).toBe(true);
    expect(byId.has("project.config.unknown.unknown_project_root")).toBe(true);
    expect(byId.has("project.config.unknown.inbox_unknown_project_nested")).toBe(true);
    expect(byId.has("config.unknown.hooks_0_unknown_hook_field")).toBe(false);
    expect(byId.get("config.provider")?.action).toEqual({
        kind: "raw",
        path: join(profile, "config.json"),
    });
    expect(byId.get("config.extensions")?.action).toEqual({
        kind: "raw",
        path: join(profile, "config.json"),
    });
    expect(byId.get("agents.profile")?.action.kind).toBe("raw");
    expect(byId.get("agents.project")?.action.kind).toBe("raw");

    const compaction = byId.get("config.compaction");
    expect(compaction?.facts).toEqual(expect.arrayContaining([
        ["trigger_tokens", "12345"],
        ["target_tokens", "5000"],
    ]));
    expect(byId.get("config.model_feed_url")?.value).not.toContain("url-secret");
    expect(byId.get("config.provider_endpoints")?.facts?.join(" ")).not.toContain("url-secret");
    expect(JSON.stringify(entries)).not.toContain("extension-secret");
    expect(JSON.stringify(entries)).not.toContain("extension-cookie-secret");
    expect(JSON.stringify(entries)).not.toContain("hook-secret");
    expect(JSON.stringify(entries)).not.toContain("feed-secret");
    expect(JSON.stringify(entries)).not.toContain("url-secret");
    expect(entries.some((entry) => entry.id === "config.unknown.reviewer_profiles_strict_model_route")).toBe(false);
    expect(entries.some((entry) => entry.id === "config.unknown.reviewer_profiles_strict_policy")).toBe(false);

    const picker = startTuiConfigurationCatalog(entries);
    const compactionOption = picker.options.find(
        (option) => option.value === "config.compaction",
    );
    expect(compactionOption?.searchText).toContain("trigger_tokens");
    expect(compactionOption?.searchText).toContain("config.compaction");
    expect(compactionOption?.detailFacts).toEqual(expect.arrayContaining([
        ["trigger_tokens", "12345"],
    ]));
});

test("the catalog picker carries its registry entry through Enter", () => {
    const entries = [{
        id: "test.setting",
        group: "Test",
        label: "Test setting",
        description: "a setting used by the picker test",
        value: "current",
        location: "/tmp/config.json#test",
        scope: "profile",
        apply: "new sessions",
        action: { kind: "raw" as const, path: "/tmp/config.json" },
    }];
    const picker = startTuiConfigurationCatalog(entries);
    const transition = handleTuiSettingsPickerKey(picker, { name: "enter" });
    expect(transition.selection).toEqual({
        kind: "configuration",
        entry: entries[0]!,
    });
});

test("catalog navigation returns to the catalog and validates project admission", () => {
    const home = mkdtempSync(join(tmpdir(), "vera-catalog-home-"));
    const projectRoot = mkdtempSync(join(tmpdir(), "vera-catalog-project-"));
    const raw = {
        schema_version: 1,
        provider: "openrouter",
        model: "openai/gpt-5",
        approval_mode: "auto",
    } as unknown as VeraConfig;
    const profile = join(home, "profiles", "default");
    mkdirSync(profile, { recursive: true });
    mkdirSync(join(projectRoot, ".vera"), { recursive: true });
    writeFileSync(join(profile, "config.json"), JSON.stringify(raw));
    writeFileSync(
        join(projectRoot, ".vera", "config.json"),
        JSON.stringify({ inbox: { admit: ["*", "vera", "vera"] } }),
    );

    const entries = buildConfigurationCatalog(context(home, projectRoot, raw));
    expect(entries.find((entry) => entry.id === "project.inbox")?.value)
        .toBe("none");

    const catalog = startTuiConfigurationCatalog(entries);
    const child = withTuiPickerParent(
        startTuiSettingsPicker("theme", undefined, undefined, undefined),
        catalog,
    );
    expect(tuiPickerMenuAncestor(child)).toBe(catalog);
});

test("dynamic provider entries cannot shadow provider advanced options", () => {
    const home = mkdtempSync(join(tmpdir(), "vera-catalog-home-"));
    const projectRoot = mkdtempSync(join(tmpdir(), "vera-catalog-project-"));
    const profile = join(home, "profiles", "default");
    mkdirSync(profile, { recursive: true });
    const raw = {
        schema_version: 1,
        provider: "advanced",
        model: "model",
        approval_mode: "auto",
        providers: {
            advanced: {
                protocol: "openai-chat",
                base_url: "https://example.test/v1",
                credential: "none",
            },
        },
    } as unknown as VeraConfig;
    writeFileSync(join(profile, "config.json"), JSON.stringify(raw));

    const entries = buildConfigurationCatalog(context(home, projectRoot, raw));
    const dynamic = entries.find((entry) =>
        entry.id === "config.providers.entry.advanced");
    const advanced = entries.find((entry) =>
        entry.id === "config.providers.advanced");
    expect(dynamic?.label).toBe("Custom provider: advanced");
    expect(advanced?.action).toEqual({
        kind: "raw",
        path: join(profile, "config.json"),
    });
});
