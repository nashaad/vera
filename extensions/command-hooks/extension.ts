import type {
    VeraExtensionApi,
    VeraExtensionCommandHookSpec,
} from "../../src/sdk/extensions.ts";
import type { JsonValue } from "../../src/sdk/hooks.ts";

interface CommandHookConfig {
    readonly phase: "pre_tool_use" | "post_tool_use" | "session_start";
    readonly argv: readonly string[];
    readonly protocol?: "vera" | "claude";
    readonly timeout_ms?: number;
}

export function activate(vera: VeraExtensionApi): void {
    const hooks = configuredHooks(vera.config);
    for (const hook of hooks) {
        const spec: VeraExtensionCommandHookSpec = {
            phase: hook.phase,
            argv: hook.argv,
            ...(hook.protocol === undefined
                ? {}
                : { protocol: hook.protocol }),
            ...(hook.timeout_ms === undefined
                ? {}
                : { timeoutMs: hook.timeout_ms }),
        };
        vera.hooks.registerCommand(spec);
    }
}

function configuredHooks(config: JsonValue): readonly CommandHookConfig[] {
    if (isPlainObject(config) && config.hooks === undefined) return [];
    if (!isPlainObject(config) || !Array.isArray(config.hooks)) {
        throw new Error("Command-hook config requires a hooks array");
    }
    return config.hooks.map((hook) => parseHook(hook));
}

function parseHook(value: unknown): CommandHookConfig {
    if (!isPlainObject(value)
        || (value.phase !== "pre_tool_use" && value.phase !== "post_tool_use" && value.phase !== "session_start")
        || !Array.isArray(value.argv)
        || !value.argv.every((argument) => typeof argument === "string")
        || (value.protocol !== undefined
            && value.protocol !== "vera"
            && value.protocol !== "claude")
        || (value.timeout_ms !== undefined
            && typeof value.timeout_ms !== "number")) {
        throw new Error("Invalid command-hook config entry");
    }
    return {
        phase: value.phase,
        argv: value.argv,
        ...(value.protocol === undefined
            ? {}
            : { protocol: value.protocol }),
        ...(value.timeout_ms === undefined
            ? {}
            : { timeout_ms: value.timeout_ms }),
    };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object"
        && value !== null
        && !Array.isArray(value);
}
