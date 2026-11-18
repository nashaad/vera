import { join } from "node:path";

import type { StopWhenIdleOptions, StopWhenIdleOutcome } from "../host/force-stop.ts";
import type { HostLockRecord } from "../host/lockfile.ts";
import { acquireHostStartupClaim, HostStartupInProgressError } from "../host/startup-claim.ts";
import { selectedVeraHome } from "../profile-paths.ts";
import { currentReleaseBuildId } from "./layout.ts";
import { cliHostRequester } from "../host/requester.ts";

export async function reconcileColdHost(
    prefix: string,
    readLiveHost: () => Promise<HostLockRecord | undefined>,
    stopHost: (options: StopWhenIdleOptions) => Promise<StopWhenIdleOutcome | undefined>,
): Promise<void> {
    const path = join(selectedVeraHome(), "boot.lock");
    for (;;) {
        try {
            const claim = await acquireHostStartupClaim({ path, maxClaimAgeMs: 15 * 60_000 });
            try {
                const current = currentReleaseBuildId(prefix);
                const host = await readLiveHost();
                if (current !== undefined && host?.build_id !== undefined && host.build_id !== current) {
                    await stopHost({ requester: cliHostRequester("install reconcile") });
                }
                return;
            } finally {
                await claim.release().catch(() => {});
            }
        } catch (error) {
            if (!(error instanceof HostStartupInProgressError)) throw error;
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }
}
