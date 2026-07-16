import type { VeraConfig } from "../config.ts";
import { createOpenAICodexAdapter } from "../model/openai-codex.ts";
import { createOpenRouterAdapter } from "../model/openrouter.ts";
import type { ModelAdapter } from "../model/types.ts";
import type { AuthStorage } from "./auth-storage.ts";

export interface ConfiguredProviderOptions {
    readonly authStorage?: AuthStorage;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly fetch?: typeof globalThis.fetch;
}

export function createConfiguredModelAdapter(
    config: VeraConfig,
    options: ConfiguredProviderOptions = {},
): ModelAdapter {
    if (config.provider === "openai-codex") {
        return createOpenAICodexAdapter({
            ...(options.authStorage === undefined
                ? {}
                : { authStorage: options.authStorage }),
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });
    }

    const apiKey = (options.env ?? process.env).OPENROUTER_API_KEY;
    if (!apiKey) {
        throw new Error("OPENROUTER_API_KEY is required for provider openrouter");
    }
    return createOpenRouterAdapter({ apiKey });
}
