import { activateRelease } from "./activate.ts";
import { currentReleaseBuildId, launcherPath } from "./layout.ts";
import type { ReleaseManifest } from "./manifest.ts";
import {
    defaultReadLiveHost,
    handOffUpdate,
    type HandOffOptions,
    type HandOffOutcome,
} from "./handoff.ts";
import {
    assertPrefixMayManageHost,
    defaultEnsureHost,
    recoverInterruptedUpgrade,
    type StartHost,
} from "./upgrade.ts";
import { verifyPackedRelease } from "./verify.ts";
import { targetPidIsAncestor } from "../host/process-ancestry.ts";
import type { HostLockRecord } from "../host/lockfile.ts";

export interface PackedInstallRelease {
    readonly releaseRoot: string;
    readonly manifest: ReleaseManifest;
}

export interface InstallReleaseOptions {
    readonly prefix: string;
    readonly pack: () => Promise<PackedInstallRelease>;
    readonly verify?: (releaseRoot: string) => void;
    readonly readLiveHost?: () => Promise<HostLockRecord | undefined>;
    readonly handOff?: (options: HandOffOptions) => Promise<HandOffOutcome>;
    readonly report?: (line: string) => void;
}

export interface ActivatedInstall {
    readonly kind: "activated";
    readonly buildId: string;
    readonly releaseRoot: string;
    readonly launcher: string;
    readonly fromBuildId: string | null;
}

export type InstallOutcome = ActivatedInstall | HandOffOutcome;

const startHostForInstall: StartHost = (releaseRoot, recorder) =>
    defaultEnsureHost(releaseRoot, { operation: "install", recorder });

// With no live host, or the same build already running, current moves now.
// Otherwise the running host moves current when it is idle.
export async function installRelease(options: InstallReleaseOptions): Promise<InstallOutcome> {
    const prefix = options.prefix;
    const report = options.report ?? ((line: string) => process.stderr.write(`${line}\n`));
    const readLiveHost = options.readLiveHost ?? defaultReadLiveHost;
    await recoverInterruptedUpgrade({ prefix, startHost: startHostForInstall, operation: "install" });
    const fromBuildId = currentReleaseBuildId(prefix) ?? null;
    const packed = await options.pack();
    (options.verify ?? ((root: string) => verifyPackedRelease(root, prefix)))(packed.releaseRoot);
    const buildId = packed.manifest.build_id;
    const live = await readLiveHost();
    if (live === undefined || live.build_id === buildId) {
        activateRelease(packed.releaseRoot, prefix);
        return {
            kind: "activated",
            buildId,
            releaseRoot: packed.releaseRoot,
            launcher: launcherPath(prefix),
            fromBuildId,
        };
    }
    assertPrefixMayManageHost(prefix, "install");
    const insideSession = targetPidIsAncestor(live.pid) === true;
    const handOff = options.handOff ?? handOffUpdate;
    return handOff({ buildId, insideSession, prefix, report, readLiveHost });
}
