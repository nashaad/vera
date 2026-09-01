
import { createFailedRequestCapture } from
    "../../providers/failed-request-capture.ts";
import {
    createAuthStorage,
    credentialFingerprint,
} from "../../providers/auth-storage.ts";
import { createConfiguredModelAdapter } from "../../providers/configured.ts";
import { OpenRouterAllowanceGuard } from
    "../../providers/openrouter-allowance-guard.ts";
import {
    adapterCacheFingerprint,
    applyModelRequestOptions,
    ProviderRoutingAdapter,
    type PrepareModelRequest,
} from "../../providers/routing.ts";
import type { ModelAdapter } from "../../model/types.ts";
import {
    createLiveVeraConfigReader,
    type VeraConfig,
} from "../../config.ts";

export interface WorkerAdapterOptions {
    readonly config: VeraConfig;
    readonly configPath?: string;
    readonly provider: string;
    readonly projectRoot: string;
    readonly sessionId: string;
}

export function createWorkerAdapterOptions(
    config: VeraConfig,
    configPath: string,
    context: Omit<WorkerAdapterOptions, "config" | "configPath">,
): WorkerAdapterOptions {
    return { ...context, config, configPath };
}

export function createWorkerAdapter(
    options: WorkerAdapterOptions,
): ModelAdapter {
    const authStorage = createAuthStorage();
    const allowanceGuard = new OpenRouterAllowanceGuard();
    const captureFailedRequest = createFailedRequestCapture({
        sessionId: options.sessionId,
    });
    const currentConfig = createLiveVeraConfigReader(options.config, {
        ...(options.configPath === undefined ? {} : { path: options.configPath }),
    });
    return new ProviderRoutingAdapter(
        (provider: string) => {
            const config = currentConfig();
            return createConfiguredModelAdapter({
                ...config,
                provider: provider as VeraConfig["provider"],
            }, {
                authStorage,
                openRouterAllowanceGuard: allowanceGuard,
                projectRoot: options.projectRoot,
                captureFailedRequest,
            });
        },
        options.provider,
        (provider: string) => adapterCacheFingerprint(
            currentConfig(),
            credentialFingerprint(authStorage, provider),
            provider,
        ),
        (request, provider) =>
            applyModelRequestOptions(request, currentConfig(), provider),
    );
}

export function createWorkerRequestPreparer(
    options: Pick<WorkerAdapterOptions, "config" | "configPath">,
): PrepareModelRequest {
    const currentConfig = createLiveVeraConfigReader(options.config, {
        ...(options.configPath === undefined ? {} : { path: options.configPath }),
    });
    return (request, provider) =>
        applyModelRequestOptions(request, currentConfig(), provider);
}

export default createWorkerAdapter;
