import type { VeraExtensionConfig } from "../../config.ts";
import { veraMachineDirectoryIn } from "../../profile-paths.ts";
import {
    startExtensionRegistry,
    type ExtensionRegistry,
    type ExtensionRegistryFailure,
} from "../../extensions/registry.ts";

export interface WorkerExtensionStart {
    readonly registry: ExtensionRegistry | undefined;
    /** Every extension that failed to activate, joined for one turn error. */
    readonly activationFailure: string | undefined;
    /** The registry itself could not start. */
    readonly startFailure: Error | undefined;
}

// Shared by resident workers and hostless print so both load a home's
// extensions and report their failures the same way.
export async function startWorkerExtensions(
    extensions: readonly VeraExtensionConfig[] | undefined,
    home: string | undefined,
): Promise<WorkerExtensionStart> {
    const failures: ExtensionRegistryFailure[] = [];
    let registry: ExtensionRegistry | undefined;
    let startFailure: Error | undefined;
    if (extensions !== undefined && extensions.length > 0) {
        try {
            registry = await startExtensionRegistry({
                extensions,
                ...(home === undefined
                    ? {}
                    : {
                        storageRoots: {
                            profile: home,
                            machine: veraMachineDirectoryIn(home),
                        },
                    }),
                onFailure: (failure) => {
                    failures.push(failure);
                },
            });
        } catch (error) {
            startFailure = error instanceof Error
                ? error
                : new Error(String(error));
        }
    }
    return {
        registry,
        activationFailure: failures.length === 0
            ? undefined
            : failures.map(activationFailureDetail).join("; "),
        startFailure,
    };
}

function activationFailureDetail(failure: ExtensionRegistryFailure): string {
    return `Extension ${failure.extensionId ?? failure.path} failed to activate: `
        + failure.message;
}
