import type { ModelAdapter } from "../model/types.ts";
import {
    poolEffortLevels,
} from "../model/effort-levels.ts";
import { poolImageSupport } from "../model/image-support.ts";
import { createPoolEffortPool } from "../model/effort-pool.ts";
import type { FailedRequestCapture } from "./failed-request-capture.ts";
import { apiKey } from "./auth-storage.ts";
import { createOpenAICodexAdapter } from "./openai-codex.ts";
import { createOpenRouterAdapter } from "./openrouter.ts";
import { createOllamaAdapter } from "./ollama-openai.ts";
import { openRouterAllowanceScope } from "./openrouter-allowance-guard.ts";
import type { ProviderDescriptor } from "./registry.ts";
import type { ConfiguredProviderOptions } from "./configured.ts";
import { UserFacingError } from "../user-facing-error.ts";

export interface ExecutableProviderContribution {
    readonly behaviorId: string;
    createAdapter(
        provider: ProviderDescriptor,
        options: ConfiguredProviderOptions,
    ): ModelAdapter;
}

/**
 * The typed seam for behavior that data cannot express. Plain definitions name
 * a behavior id; this local registry supplies the implementation without
 * crossing the host/client boundary with callbacks or adapter instances.
 */
const CONTRIBUTIONS: Readonly<Record<string, ExecutableProviderContribution>> = {
    "openai-codex": {
        behaviorId: "openai-codex",
        createAdapter: (_provider, options) => createOpenAICodexAdapter({
            ...(options.authStorage === undefined ? {} : { authStorage: options.authStorage }),
            ...(options.fetch === undefined ? {} : { fetch: options.fetch as typeof globalThis.fetch }),
        }),
    },
    openrouter: {
        behaviorId: "openrouter",
        createAdapter: (provider, options) => {
            const pool = createPoolEffortPool(
                options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot },
            );
            const key = requiredApiKey(provider, options);
            return createOpenRouterAdapter({
                apiKey: key,
                ...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
                effortLevels: options.effortLevels
                    ?? poolEffortLevels({ provider: provider.id, pool }),
                imageSupport: options.imageSupport
                    ?? poolImageSupport({ provider: provider.id, pool }),
                ...(options.openRouterAllowanceGuard === undefined
                    ? {}
                    : {
                        allowanceGuard: options.openRouterAllowanceGuard,
                        allowanceScope: openRouterAllowanceScope(key),
                    }),
                ...capture(options),
            });
        },
    },
    ollama: {
        behaviorId: "ollama",
        createAdapter: (provider, options) => createOllamaAdapter({
            host: ollamaHost(
                provider.endpointOverridden !== true
                && provider.envVar === "OLLAMA_HOST"
                    ? (options.env ?? process.env).OLLAMA_HOST
                        ?? provider.baseUrl
                        ?? "http://127.0.0.1:11434"
                    : provider.baseUrl ?? "http://127.0.0.1:11434",
            ),
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            ...(options.log === undefined ? {} : { log: options.log }),
            ...capture(options),
        }),
    },
};

export function createExecutableProviderAdapter(
    behaviorId: string | undefined,
    provider: ProviderDescriptor,
    options: ConfiguredProviderOptions,
): ModelAdapter {
    if (behaviorId === undefined) {
        throw new Error(`Provider ${provider.id} has no executable contribution`);
    }
    const contribution = CONTRIBUTIONS[behaviorId];
    if (contribution === undefined) {
        throw new Error(`Unknown executable provider behavior ${behaviorId}`);
    }
    return contribution.createAdapter(provider, options);
}

export function executableProviderBehaviorIds(): readonly string[] {
    return Object.keys(CONTRIBUTIONS).sort();
}

function requiredApiKey(
    provider: ProviderDescriptor,
    options: ConfiguredProviderOptions,
): string {
    const stored = options.authStorage === undefined
        ? undefined
        : apiKey(options.authStorage, provider.id);
    if (stored !== undefined && stored.length > 0) return stored;
    const envVar = provider.envVar;
    const fromEnv = envVar === undefined
        ? undefined
        : (options.env ?? process.env)[envVar];
    if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
    throw new UserFacingError(
        `No credentials for provider ${provider.id}. Connect it from the model pane (ctrl+e)${
            envVar === undefined ? "" : ` or set ${envVar}`
        }.`,
    );
}

function capture(
    options: ConfiguredProviderOptions,
): { captureFailedRequest?: FailedRequestCapture } {
    return options.captureFailedRequest === undefined
        ? {}
        : { captureFailedRequest: options.captureFailedRequest };
}

function ollamaHost(value: string): string {
    return value.replace(/\/+$/, "").replace(/\/v1$/, "");
}
