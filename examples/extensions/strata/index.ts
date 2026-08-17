import type { VeraExtensionApi } from "../../../src/sdk/extensions.ts";
import type {
    JsonObject,
    ModelRequestHookPayload,
} from "../../../src/sdk/hooks.ts";

interface StrataExtensionConfig {
    readonly provider: string;
    readonly model: string;
    readonly force: boolean;
    readonly progress?: "hidden" | "summary" | "detailed";
}

const DEFAULT_CONFIG: StrataExtensionConfig = {
    provider: "vera-strata",
    model: "strata",
    force: true,
};

export function activate(vera: VeraExtensionApi): void {
    const config = parseConfig(vera.config);
    vera.hooks.registerModelRequest("strata", (payload) =>
        strataContribution(payload, config)
    );
}

export function strataContribution(
    payload: ModelRequestHookPayload,
    config: StrataExtensionConfig = DEFAULT_CONFIG,
): JsonObject | undefined {
    if (payload.provider !== config.provider || payload.model !== config.model) {
        return undefined;
    }
    return {
        corpus: { path: payload.workspace },
        force: config.force,
        ...(config.progress === undefined ? {} : { progress: config.progress }),
    };
}

function parseConfig(value: unknown): StrataExtensionConfig {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return DEFAULT_CONFIG;
    }
    const raw = value as Record<string, unknown>;
    const progress = raw.progress === "hidden"
            || raw.progress === "summary"
            || raw.progress === "detailed"
        ? raw.progress
        : undefined;
    return {
        provider: nonEmpty(raw.provider) ?? DEFAULT_CONFIG.provider,
        model: nonEmpty(raw.model) ?? DEFAULT_CONFIG.model,
        force: typeof raw.force === "boolean" ? raw.force : DEFAULT_CONFIG.force,
        ...(progress === undefined ? {} : { progress }),
    };
}

function nonEmpty(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : undefined;
}
