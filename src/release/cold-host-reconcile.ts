import { join } from "node:path";

import type { StopWhenIdleOptions, StopWhenIdleOutcome } from "../host/force-stop.ts";
import type { HostLockRecord } from "../host/lockfile.ts";
import { acquireHostStartupClaim, HostStartupInProgressError } from "../host/startup-claim.ts";
import { selectedVeraHome } from "../profile-paths.ts";
import { currentReleaseBuildId } from "./layout.ts";

// A boot that holds the claim this long is not waited for: current has already moved, and a host that
// still runs the old build is stopped by the next update.
const DEFAULT_MAX_WAIT_MS = 60_000;

export async function reconcileColdHost(
    prefix: string,
    readLiveHost: () => Promise<HostLockRecord | undefined>,
    stopHost: (options: StopWhenIdleOptions) => Promise<StopWhenIdleOutcome | undefined>,
    maxWaitMs = DEFAULT_MAX_WAIT_MS,
): Promise<void> {
    const path = join(selectedVeraHome(), "boot.lock");
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
        try {
            const claim = await acquireHostStartupClaim({ path, maxClaimAgeMs: 15 * 60_000 });
            try {
                const current = currentReleaseBuildId(prefix);
                const host = await readLiveHost();
                if (current !== undefined && host?.build_id !== undefined && host.build_id !== current) {
                    await stopHost({});
                }
                return;
            } finally {
                await claim.release().catch(() => {});
            }
        } catch (error) {
            if (!(error instanceof HostStartupInProgressError)) throw error;
            if (Date.now() >= deadline) return;
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }
}
