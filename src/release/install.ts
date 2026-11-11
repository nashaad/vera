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
    stopLeftoverPoolWorkers,
    type StartHost,
} from "./upgrade.ts";
import { readRecordedWorkers } from "../host/pool/worker-records.ts";
import { veraHomeDirectory } from "../profile-paths.ts";
import { verifyPackedRelease } from "./verify.ts";
import { targetPidIsAncestor } from "../host/process-ancestry.ts";
import type { HostLockRecord } from "../host/lockfile.ts";
import { stopResidentHostWhenIdle, type StopWhenIdleOptions, type StopWhenIdleOutcome } from "../host/force-stop.ts";
import { processIsAlive } from "../host/process-identity.ts";

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
    // Set to keep the old in-place hand-off; the default stops the host, moves current and leaves the start to the next vera.
    readonly hotHandOff?: boolean;
    readonly stopHost?: (options: StopWhenIdleOptions) => Promise<StopWhenIdleOutcome | undefined>;
    readonly isAlive?: (pid: number) => boolean;
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
        if (live === undefined && (await readRecordedWorkers(veraHomeDirectory())).length > 0) {
            assertPrefixMayManageHost(prefix, "install");
            await stopLeftoverPoolWorkers(veraHomeDirectory());
        }
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
    // Stopping the host from inside one of its sessions would end this command too, so that case keeps the hand-off.
    const hot = options.hotHandOff ?? (insideSession || process.env.VERA_HOT_UPDATE === "1");
    if (!hot) {
        const stopped = await stopForColdUpdate(live, options, report);
        if (stopped !== undefined) return stopped;
        if ((await readRecordedWorkers(veraHomeDirectory())).length > 0) {
            await stopLeftoverPoolWorkers(veraHomeDirectory());
        }
        activateRelease(packed.releaseRoot, prefix);
        report(`Installed ${buildId}. The next 'vera' starts it and runs the startup check.`);
        return {
            kind: "activated",
            buildId,
            releaseRoot: packed.releaseRoot,
            launcher: launcherPath(prefix),
            fromBuildId,
        };
    }
    const handOff = options.handOff ?? handOffUpdate;
    return handOff({ buildId, insideSession, prefix, report, readLiveHost });
}

// Waits for running turns, then stops the host. Returns an outcome only when current must not move.
async function stopForColdUpdate(
    live: HostLockRecord,
    options: InstallReleaseOptions,
    report: (line: string) => void,
): Promise<HandOffOutcome | undefined> {
    let announced = false;
    const outcome = await (options.stopHost ?? stopResidentHostWhenIdle)({
        onWaiting: (waiting) => {
            if (!announced) {
                announced = true;
                report("Waiting for running turns to end before the update.");
            }
            for (const target of waiting) report(`Waiting on ${target.name ?? target.session_id} (${target.status})`);
        },
    });
    if ((options.isAlive ?? processIsAlive)(live.pid)) {
        const reason = outcome === undefined ? "it did not answer" : `the stop ended with ${outcome.endedBy}`;
        return {
            kind: "not_moved",
            message: `Resident Vera host PID ${live.pid} is still running (${reason}), so current was not moved.`,
        };
    }
    return undefined;
}
