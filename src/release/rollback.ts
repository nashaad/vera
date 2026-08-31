import { existsSync } from "node:fs";

import { activateRelease } from "./activate.ts";
import {
    currentReleaseBuildId,
    defaultInstallPrefix,
    releaseDirectory,
    rollbackReleaseBuildId,
} from "./layout.ts";
import { readStampedRelease } from "./stamp.ts";

export class RollbackUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RollbackUnavailableError";
    }
}

export interface RolledBackRelease {
    readonly prefix: string;
    readonly fromBuildId: string | undefined;
    readonly toBuildId: string;
    readonly releaseRoot: string;
}

/**
 * Point `current` at the pinned known-good release. Same atomic symlink
 * swap as activation. Does not pack, does not talk to Git, and does not
 * use the network.
 */
export function rollbackLocalInstall(
    prefix = defaultInstallPrefix(),
): RolledBackRelease {
    const pin = rollbackReleaseBuildId(prefix);
    if (pin === undefined) {
        throw new RollbackUnavailableError(
            "No rollback pin. There is no retained known-good release to restore.",
        );
    }
    const current = currentReleaseBuildId(prefix);
    if (current === pin) {
        throw new RollbackUnavailableError(
            `Already on rollback pin ${pin}.`,
        );
    }
    const releaseRoot = releaseDirectory(pin, prefix);
    if (!existsSync(releaseRoot)) {
        throw new RollbackUnavailableError(
            `Rollback pin ${pin} is not retained at ${releaseRoot}.`,
        );
    }
    readStampedRelease(releaseRoot);
    activateRelease(releaseRoot, prefix);
    return {
        prefix,
        fromBuildId: current,
        toBuildId: pin,
        releaseRoot,
    };
}
