import { basename, dirname, join } from "node:path";

import { canonicalPath } from "../canonical-path.ts";
import { acquireHostStartupClaim, type HostStartupClaim } from "./startup-claim.ts";

export function acquireStopStartupClaim(path: string): Promise<HostStartupClaim> {
    const resolved = join(canonicalPath(dirname(path)), basename(path));
    return acquireHostStartupClaim({ path: resolved, maxClaimAgeMs: Number.POSITIVE_INFINITY });
}
