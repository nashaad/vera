import type { VeraConfig } from "../../src/config.ts";
import {
    failingWorkerAdapter,
    workerAdapterWithMiddleware,
} from "../../src/host/worker/middleware.ts";
import { startWorkerExtensions } from "../../src/host/worker/extensions.ts";
import { veraProfileDirectory } from "../../src/profile-paths.ts";
import {
    defaultRunAdapterFactory,
    homeConfig,
    type RunAdapterFactory,
} from "../../src/sdk/home-run.ts";

export interface PrintExtensions {
    readonly config: VeraConfig;
    readonly createAdapter: RunAdapterFactory;
    close(): Promise<void>;
}

// Print mode runs the home's config extensions as a resident worker does, but
// only their model middleware applies. An extension that fails to load ends
// the turn with the worker's message instead of running without it.
export async function startPrintExtensions(): Promise<PrintExtensions> {
    const home = veraProfileDirectory();
    const config = homeConfig(home);
    const started = await startWorkerExtensions(config.extensions, home);
    const failure = started.startFailure === undefined
        ? started.activationFailure
        : started.startFailure.message.trim() || "Print run stopped unexpectedly";
    const defaultAdapter = defaultRunAdapterFactory();
    return {
        config,
        createAdapter: (selected, workspace, session) => {
            if (failure !== undefined) {
                return failingWorkerAdapter(failure, selected.model);
            }
            return workerAdapterWithMiddleware(
                defaultAdapter(selected, workspace, session),
                started.registry?.modelMiddleware() ?? [],
                {
                    session: {
                        path: session.sessionPath,
                        header: { id: session.sessionId, cwd: workspace },
                        lineCount: 0,
                    },
                    provider: selected.provider,
                    inbound: () => undefined,
                },
            );
        },
        close: async () => {
            await started.registry?.close();
        },
    };
}
