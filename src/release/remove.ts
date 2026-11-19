import { existsSync, rmSync } from "node:fs";

import { defaultInstallPrefix, releaseDirectory } from "./layout.ts";
import { referenceReasons } from "./references.ts";

export class ReleaseInUseError extends Error {
    constructor(
        readonly buildId: string,
        readonly reasons: readonly string[],
    ) {
        const why = reasons.length === 0 ? "referenced" : reasons.join(", ");
        const damaged = reasons.includes("host-lock-damaged")
            ? " The host lockfile is damaged, so Vera cannot tell which release a running host uses."
            : "";
        const unknown = reasons.includes("host-build-unknown")
            ? " The host lockfile names no build, so Vera cannot tell which release the running host uses."
            : "";
        super(`Release ${buildId} is still ${why} and cannot be removed.${damaged}${unknown}`);
        this.name = "ReleaseInUseError";
    }
}

export function removeRelease(
    buildId: string,
    prefix = defaultInstallPrefix(),
): void {
    // One call: each reference check on a damaged lockfile runs ps.
    const reasons = referenceReasons(buildId, prefix);
    if (reasons.length > 0) {
        throw new ReleaseInUseError(buildId, reasons);
    }
    const path = releaseDirectory(buildId, prefix);
    if (!existsSync(path)) {
        return;
    }
    rmSync(path, { recursive: true, force: false });
}
