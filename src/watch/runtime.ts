import type { OwnedWatchContribution } from "../extensions/contribution-set.ts";
import type { Inbox } from "../store/inbox.ts";
import { WatchAdmission, type AdmissionLimits } from "./admission.ts";
import { createArcConnector, type WatchSecretResolver } from "./arc-connector.ts";
import { createFilesystemConnector } from "./filesystem-connector.ts";
import { SupervisedWatch, type WatchStatus } from "./supervisor.ts";
import type { WatchConnector } from "./source.ts";

export interface WatchRuntimeOptions {
    readonly inbox: Inbox;
    readonly watches: readonly OwnedWatchContribution[];
    readonly connectors?: readonly WatchConnector[];
    readonly onAppended?: () => void;
    readonly secret?: WatchSecretResolver;
    readonly limits?: Partial<AdmissionLimits>;
    readonly now?: () => number;
    readonly onStateChange?: (status: WatchStatus) => void;
}

export interface WatchRuntime {
    statuses(): readonly WatchStatus[];
    close(): Promise<void>;
}

export function startWatchRuntime(options: WatchRuntimeOptions): WatchRuntime {
    const connectors = new Map<string, WatchConnector>();
    for (
        const connector of options.connectors
            ?? [
                createArcConnector(
                    options.secret === undefined ? {} : { secret: options.secret },
                ),
                createFilesystemConnector(),
            ]
    ) {
        connectors.set(connector.sourceFamily, connector);
    }

    const supervised: SupervisedWatch[] = [];
    const unsupported: WatchStatus[] = [];

    for (const watch of options.watches) {
        const connector = connectors.get(watch.definition.source_family);
        if (connector === undefined) {
            unsupported.push({
                watchId: watch.id,
                extensionId: watch.extensionId,
                sourceFamily: watch.definition.source_family,
                state: "quarantined",
                failures: 0,
                lastError:
                    `no connector for source family ${watch.definition.source_family}`,
                nextRetryInMs: null,
            });
            continue;
        }
        const admission = new WatchAdmission({
            inbox: options.inbox,
            watchId: watch.id,
            address: watch.definition.address ?? null,
            flood: watch.definition.flood,
            ...(options.limits === undefined ? {} : { limits: options.limits }),
            ...(options.now === undefined ? {} : { now: options.now }),
            ...(options.onAppended === undefined
                ? {}
                : { onAppended: options.onAppended }),
        });
        const task = new SupervisedWatch({
            watch,
            connector,
            admission,
            ...(options.now === undefined ? {} : { now: options.now }),
            ...(options.onStateChange === undefined
                ? {}
                : { onStateChange: options.onStateChange }),
        });
        supervised.push(task);
        task.start();
    }

    return {
        statuses(): readonly WatchStatus[] {
            return [...supervised.map((task) => task.status()), ...unsupported];
        },
        async close(): Promise<void> {
            await Promise.all(supervised.map((task) => task.stop()));
        },
    };
}

export function startWatchRuntimeIfEnabled(
    inbox: Inbox | null,
    options: Omit<WatchRuntimeOptions, "inbox">,
): WatchRuntime | null {
    if (inbox === null || options.watches.length === 0) {
        return null;
    }
    return startWatchRuntime({ ...options, inbox });
}
