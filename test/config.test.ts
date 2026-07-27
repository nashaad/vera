import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    configuredModelFallback,
    configuredReviewer,
    loadOptionalVeraConfig,
    loadVeraConfig,
    updateVeraConfigDefaults,
} from "../src/config.ts";
import { addToStash, readStash } from "../src/model/stash-store.ts";

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
            "Invalid Vera config",
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
        "expected schema_version 1, provider openrouter, openai-codex, or ollama, a non-empty model string",
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

test("updating the defaults preserves keys the config type does not model", () => {
    // The stash store writes into the same file, under a key `VeraConfig` has
    // no field for. Before this, changing model round-tripped the file through
    // the type and silently erased the user's whole stash.
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        approval_mode: "ask",
    }));
    addToStash({ provider: "openai-codex", model: "gpt-5.6-sol" }, { path });

    updateVeraConfigDefaults({ model: "some-other-model" }, { path });

    expect(readStash({ path })).toEqual([
        { provider: "openai-codex", model: "gpt-5.6-sol" },
    ]);
    expect(loadVeraConfig({ path }).model).toBe("some-other-model");
});

test("preserving unmodelled keys still allows a default to be cleared", () => {
    // The typed update wins over the raw value even when it sets a field to
    // undefined, so clearing is not a casualty of preserving unknown keys.
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoning_effort: "high",
        approval_mode: "ask",
        stash: ["openai-codex/gpt-5.6-sol"],
    }));

    updateVeraConfigDefaults({ reasoning_effort: null }, { path });

    const written: unknown = JSON.parse(readFileSync(path, "utf8"));
    expect(written).not.toHaveProperty("reasoning_effort");
    expect(written).toHaveProperty("stash", ["openai-codex/gpt-5.6-sol"]);
});

function temporaryConfigPath(): string {
    return join(mkdtempSync(join(tmpdir(), "vera-config-")), "config.json");
}
