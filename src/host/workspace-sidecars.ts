import { join, resolve } from "node:path";

import { discoverProjectExtensionConfigs } from "../extensions/discovery.ts";
import {
    startExtensionRegistry,
    type ExtensionRegistry,
} from "../extensions/registry.ts";
import { workspaceKey } from "../workspace-key.ts";
import {
    startSidecarRuntimeIfNeeded,
    type SidecarRuntime,
    type SidecarStatus,
} from "./sidecar-runtime.ts";

export interface WorkspaceSidecarSupervisorOptions {
    readonly socketPath: () => string;
    readonly logDirectory: string;
    readonly onStateChange?: (status: SidecarStatus) => void;
}

export interface WorkspaceSidecarSupervisor {
    acquire(workspace: string): Promise<void>;
    release(workspace: string): Promise<void>;
    held(workspace: string): boolean;
    close(): Promise<void>;
}

interface WorkspaceSidecarLease {
    refs: number;
    readonly registry: ExtensionRegistry | undefined;
    readonly sidecars: SidecarRuntime | null;
}

/**
 * One sidecar runtime per workspace, shared by every live session in that
 * checkout. The host does not own a project list; sessions acquire and
 * release a workspace key.
 */
export function createWorkspaceSidecarSupervisor(
    options: WorkspaceSidecarSupervisorOptions,
): WorkspaceSidecarSupervisor {
    const leases = new Map<string, WorkspaceSidecarLease>();

    return {
        async acquire(workspace: string): Promise<void> {
            const key = workspaceKey(resolve(workspace));
            const existing = leases.get(key);
            if (existing !== undefined) {
                existing.refs += 1;
                return;
            }
            const configs = discoverProjectExtensionConfigs(workspace);
            const registry = configs.length === 0
                ? undefined
                : await startExtensionRegistry({ extensions: configs });
            const sidecars = registry === undefined
                ? null
                : startSidecarRuntimeIfNeeded({
                    sidecars: registry.contributions().sidecars(),
                    socketPath: options.socketPath(),
                    logDirectory: join(options.logDirectory, key),
                    ...(options.onStateChange === undefined
                        ? {}
                        : { onStateChange: options.onStateChange }),
                });
            leases.set(key, { refs: 1, registry, sidecars });
        },
        async release(workspace: string): Promise<void> {
            const key = workspaceKey(resolve(workspace));
            const existing = leases.get(key);
            if (existing === undefined) return;
            existing.refs -= 1;
            if (existing.refs > 0) return;
            leases.delete(key);
            await existing.sidecars?.close();
            await existing.registry?.close();
        },
        held(workspace: string): boolean {
            return leases.has(workspaceKey(resolve(workspace)));
        },
        async close(): Promise<void> {
            const remaining = [...leases.values()];
            leases.clear();
            for (const lease of remaining) {
                await lease.sidecars?.close();
                await lease.registry?.close();
            }
        },
    };
}
