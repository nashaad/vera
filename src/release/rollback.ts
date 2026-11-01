import { existsSync } from "node:fs";

import {
    currentReleaseBuildId,
    defaultInstallPrefix,
    releaseDirectory,
    rollbackReleaseBuildId,
} from "./layout.ts";
import type { ReleaseManifest } from "./manifest.ts";
import { readStampedRelease } from "./stamp.ts";
import {
    readUpgradeJournal,
    recoverInterruptedUpgrade,
    upgradeLocalInstall,
    type UpgradeLocalOptions,
} from "./upgrade.ts";

export class RollbackUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RollbackUnavailableError";
    }
}

export interface RolledBackRelease {
    readonly kind: "rolled_back";
    readonly prefix: string;
    readonly fromBuildId: string | undefined;
    readonly toBuildId: string;
    readonly releaseRoot: string;
}

// A rollback that found an interrupted install or rollback finishes it and
// stops: rolling back again would undo the rollback it finished.
export interface FinishedInterruptedSwitch {
    readonly kind: "finished_interrupted";
    readonly prefix: string;
    readonly activeBuildId: string | undefined;
}

export type RollbackOutcome = RolledBackRelease | FinishedInterruptedSwitch;

export type RollbackHostOptions = Pick<
    UpgradeLocalOptions,
    "drainHost" | "startHost"
>;

// Switches the same way an upgrade does: the resident host is stopped before
// the switch, and the pinned release's host is started afterward if one ran.
export async function rollbackLocalInstall(
    prefix = defaultInstallPrefix(),
    hosts: RollbackHostOptions = {},
): Promise<RollbackOutcome> {
    if (await readUpgradeJournal(prefix) !== undefined) {
        const recovered = await recoverInterruptedUpgrade({
            prefix,
            operation: "rollback",
            ...(hosts.startHost === undefined ? {} : { startHost: hosts.startHost }),
        });
        return {
            kind: "finished_interrupted",
            prefix,
            activeBuildId: recovered.buildId,
        };
    }
    const target = resolveRollbackTarget(prefix);
    const upgraded = await upgradeLocalInstall({
        prefix,
        operation: "rollback",
        pack: async () => ({
            prefix,
            releaseRoot: target.releaseRoot,
            manifest: target.manifest,
        }),
        // The stamp check in resolveRollbackTarget is the whole check: a
        // retained release can predate files the current verifier requires.
        verify: () => {},
        ...(hosts.drainHost === undefined ? {} : { drainHost: hosts.drainHost }),
        ...(hosts.startHost === undefined ? {} : { startHost: hosts.startHost }),
    });
    return {
        kind: "rolled_back",
        prefix,
        fromBuildId: upgraded.fromBuildId ?? undefined,
        toBuildId: upgraded.manifest.build_id,
        releaseRoot: upgraded.releaseRoot,
    };
}

function resolveRollbackTarget(prefix: string): {
    readonly releaseRoot: string;
    readonly manifest: ReleaseManifest;
} {
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
    return { releaseRoot, manifest: readStampedRelease(releaseRoot) };
}
