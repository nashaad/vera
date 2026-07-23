import {
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import type { ApprovalMode } from "./engine/permissions.ts";
import type { ModelFallbackPolicy } from "./engine/recovery.ts";
import type { ToolReviewerSettings } from "./engine/reviewer.ts";
import type { ModelReasoningEffort } from "./model/types.ts";

export const VERA_CONFIG_SCHEMA_VERSION = 1;

export type VeraProviderId = "openrouter" | "openai-codex" | "ollama";

export interface VeraModelFallbackConfig {
    readonly model: string;
    readonly after_failures: number;
}

/**
 * Model used by the automatic approval reviewer in `approve_for_me`. Every
 * boundary crossing costs one of these calls, so it is configured separately
 * from the agent model rather than inheriting it.
 */
export interface VeraReviewerConfig {
    readonly provider?: VeraProviderId;
    readonly model: string;
    readonly reasoning_effort?: ModelReasoningEffort;
    readonly timeout_ms?: number;
}

export interface VeraConfig {
    readonly schema_version: typeof VERA_CONFIG_SCHEMA_VERSION;
    readonly provider: VeraProviderId;
    readonly model: string;
    readonly reasoning_effort?: ModelReasoningEffort;
    readonly approval_mode: ApprovalMode;
    readonly fallback?: VeraModelFallbackConfig;
    readonly reviewer?: VeraReviewerConfig;
}

export interface LoadVeraConfigOptions {
    readonly path?: string;
}

export interface VeraConfigDefaultsPatch {
    readonly provider?: VeraProviderId;
    readonly model?: string;
    readonly reasoning_effort?: ModelReasoningEffort;
    readonly approval_mode?: ApprovalMode;
}

export function defaultVeraConfigPath(): string {
    return join(homedir(), ".vera", "config.json");
}

export function loadVeraConfig(
    options: LoadVeraConfigOptions = {},
): VeraConfig {
    const path = options.path ?? defaultVeraConfigPath();
    let source: string;

    try {
        source = readFileSync(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new Error(
                `Vera config not found at ${path}. Create it with schema_version 1, an optional provider, a model string, an optional reasoning_effort, an optional approval_mode, and an optional fallback.`,
            );
        }
        throw error;
    }

    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid JSON in Vera config at ${path}: ${message}`);
    }

    const config = parseVeraConfig(value);
    if (config === undefined) {
        throw new Error(
            `Invalid Vera config at ${path}: expected schema_version 1, provider openrouter, openai-codex, or ollama, a non-empty model string, optional reasoning_effort off, low, medium, high, or max, optional approval_mode ask, approve_for_me, or full_access, and optional fallback with a different model and after_failures from 1 to 3. OpenAI Codex fallback requires reasoning_effort to be omitted.`,
        );
    }
    return config;
}

export function updateVeraConfigDefaults(
    patch: VeraConfigDefaultsPatch,
    options: LoadVeraConfigOptions = {},
): VeraConfig {
    const path = options.path ?? defaultVeraConfigPath();
    const current = loadVeraConfig({ path });
    const updated: VeraConfig = {
        ...current,
        ...(patch.provider === undefined ? {} : { provider: patch.provider }),
        ...(patch.model === undefined ? {} : { model: patch.model }),
        ...(patch.reasoning_effort === undefined
            ? {}
            : { reasoning_effort: patch.reasoning_effort }),
        ...(patch.provider === "openai-codex"
            ? { reasoning_effort: undefined }
            : {}),
        ...(patch.approval_mode === undefined
            ? {}
            : { approval_mode: patch.approval_mode }),
        ...(patch.provider !== undefined && patch.provider !== current.provider
            ? { fallback: undefined }
            : {}),
        ...(patch.model !== undefined && current.fallback?.model === patch.model
            ? { fallback: undefined }
            : {}),
    };
    const directory = dirname(path);
    const temporaryPath = join(directory, `.config-${randomUUID()}.tmp`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(temporaryPath, `${JSON.stringify(updated, null, 2)}\n`, {
        mode: 0o600,
    });
    renameSync(temporaryPath, path);
    return updated;
}

function parseVeraConfig(value: unknown): VeraConfig | undefined {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }

    const config = value as Record<string, unknown>;
    const fallback = parseModelFallback(config.fallback, config.model);
    const reviewer = parseReviewer(config.reviewer);
    if (
        (config.reviewer !== undefined && reviewer === undefined)
        ||
        config.schema_version !== VERA_CONFIG_SCHEMA_VERSION
        || (config.provider !== undefined
            && config.provider !== "openrouter"
            && config.provider !== "openai-codex"
            && config.provider !== "ollama")
        || typeof config.model !== "string"
        || config.model.trim().length === 0
        || (config.reasoning_effort !== undefined
            && config.reasoning_effort !== "off"
            && config.reasoning_effort !== "low"
            && config.reasoning_effort !== "medium"
            && config.reasoning_effort !== "high"
            && config.reasoning_effort !== "max")
        || (config.approval_mode !== undefined
            && config.approval_mode !== "ask"
            && config.approval_mode !== "approve_for_me"
            && config.approval_mode !== "full_access")
        || (config.fallback !== undefined && fallback === undefined)
        || (fallback !== undefined
            && config.provider === "openai-codex"
            && config.reasoning_effort !== undefined)
    ) {
        return undefined;
    }

    return {
        schema_version: VERA_CONFIG_SCHEMA_VERSION,
        provider: config.provider ?? "openrouter",
        model: config.model.trim(),
        approval_mode: config.approval_mode ?? "approve_for_me",
        ...(config.reasoning_effort === undefined
            ? {}
            : { reasoning_effort: config.reasoning_effort }),
        ...(fallback === undefined ? {} : { fallback }),
        ...(reviewer === undefined ? {} : { reviewer }),
    };
}

function parseReviewer(value: unknown): VeraReviewerConfig | undefined {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }
    const reviewer = value as Record<string, unknown>;
    if (
        typeof reviewer.model !== "string"
        || reviewer.model.trim().length === 0
        || (reviewer.provider !== undefined
            && reviewer.provider !== "openrouter"
            && reviewer.provider !== "openai-codex"
            && reviewer.provider !== "ollama")
        || (reviewer.reasoning_effort !== undefined
            && !isReasoningEffort(reviewer.reasoning_effort))
        || (reviewer.timeout_ms !== undefined
            && (typeof reviewer.timeout_ms !== "number"
                || !Number.isInteger(reviewer.timeout_ms)
                || reviewer.timeout_ms < 1_000
                || reviewer.timeout_ms > 600_000))
    ) {
        return undefined;
    }
    return {
        model: reviewer.model.trim(),
        ...(reviewer.provider === undefined
            ? {}
            : { provider: reviewer.provider as VeraProviderId }),
        ...(reviewer.reasoning_effort === undefined
            ? {}
            : { reasoning_effort: reviewer.reasoning_effort }),
        ...(reviewer.timeout_ms === undefined
            ? {}
            : { timeout_ms: reviewer.timeout_ms }),
    };
}

function isReasoningEffort(value: unknown): value is ModelReasoningEffort {
    return value === "off"
        || value === "low"
        || value === "medium"
        || value === "high"
        || value === "max";
}

/**
 * Maps the reviewer block onto engine settings. Returns `undefined` when no
 * reviewer is configured, which leaves the reviewer on the agent's own model.
 */
export function configuredReviewer(
    config: VeraConfig,
): ToolReviewerSettings | undefined {
    const reviewer = config.reviewer;
    if (reviewer === undefined) {
        return undefined;
    }
    return {
        model: reviewer.model,
        ...(reviewer.provider === undefined
            ? {}
            : { provider: reviewer.provider }),
        ...(reviewer.reasoning_effort === undefined
            ? {}
            : { reasoningEffort: reviewer.reasoning_effort }),
        ...(reviewer.timeout_ms === undefined
            ? {}
            : { timeoutMs: reviewer.timeout_ms }),
    };
}

export function configuredModelFallback(
    config: VeraConfig,
): ModelFallbackPolicy | undefined {
    if (config.fallback === undefined) {
        return undefined;
    }
    return {
        provider: config.provider,
        model: config.fallback.model,
        afterFailures: config.fallback.after_failures,
    };
}

function parseModelFallback(
    value: unknown,
    primaryModel: unknown,
): VeraModelFallbackConfig | undefined {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }
    const fallback = value as Record<string, unknown>;
    if (
        typeof fallback.model !== "string"
        || fallback.model.trim().length === 0
        || typeof fallback.after_failures !== "number"
        || !Number.isInteger(fallback.after_failures)
        || fallback.after_failures < 1
        || fallback.after_failures > 3
        || (typeof primaryModel === "string"
            && fallback.model.trim() === primaryModel.trim())
    ) {
        return undefined;
    }
    return {
        model: fallback.model.trim(),
        after_failures: fallback.after_failures,
    };
}
