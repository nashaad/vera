import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ApprovalMode } from "./engine/permissions.ts";
import type { ModelFallbackPolicy } from "./engine/recovery.ts";
import type { ModelReasoningEffort } from "./model/types.ts";

export const VERA_CONFIG_SCHEMA_VERSION = 1;

export type VeraProviderId = "openrouter" | "openai-codex";

export interface VeraModelFallbackConfig {
    readonly model: string;
    readonly after_failures: number;
}

export interface VeraConfig {
    readonly schema_version: typeof VERA_CONFIG_SCHEMA_VERSION;
    readonly provider: VeraProviderId;
    readonly model: string;
    readonly reasoning_effort?: ModelReasoningEffort;
    readonly approval_mode: ApprovalMode;
    readonly fallback?: VeraModelFallbackConfig;
}

export interface LoadVeraConfigOptions {
    readonly path?: string;
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
            `Invalid Vera config at ${path}: expected schema_version 1, provider openrouter or openai-codex, a non-empty model string, optional reasoning_effort off, low, medium, high, or max, optional approval_mode ask, approve_for_me, or full_access, and optional fallback with a different model and after_failures from 1 to 3. OpenAI Codex fallback requires reasoning_effort to be omitted.`,
        );
    }
    return config;
}

function parseVeraConfig(value: unknown): VeraConfig | undefined {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }

    const config = value as Record<string, unknown>;
    const fallback = parseModelFallback(config.fallback, config.model);
    if (
        config.schema_version !== VERA_CONFIG_SCHEMA_VERSION
        || (config.provider !== undefined
            && config.provider !== "openrouter"
            && config.provider !== "openai-codex")
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
    };
}

export function configuredModelFallback(
    config: VeraConfig,
): ModelFallbackPolicy | undefined {
    if (config.fallback === undefined) {
        return undefined;
    }
    return {
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
