import { rm } from "node:fs/promises";

import type { CheckpointStore } from "../store/checkpoint-store.ts";
import type {
    SessionCheckpointEntry,
    SessionStore,
} from "../store/session-store.ts";

export type CheckpointRestoreAction = "restored" | "removed";

export interface CheckpointRestoreResult {
    readonly checkpointId: string;
    readonly path: string;
    readonly action: CheckpointRestoreAction;
}

export type CheckpointChainStatus =
    | "continuous"
    | "intervening_change"
    | "unverifiable";

/**
 * Check whether one file's chronological checkpoints form an exact chain.
 * Legacy checkpoints have no digests and are safe to inspect but not safe to
 * use for a boundary restore without an explicit legacy policy.
 */
export function checkpointChainStatus(
    checkpoints: readonly SessionCheckpointEntry[],
): CheckpointChainStatus {
    if (checkpoints.length === 0) {
        throw new Error("A checkpoint chain must not be empty");
    }
    const path = checkpoints[0]!.path;
    if (checkpoints.some((checkpoint) => checkpoint.path !== path)) {
        throw new Error("A checkpoint chain must contain exactly one path");
    }
    if (checkpoints.some((checkpoint) =>
        checkpoint.userMessageId === undefined
        || checkpoint.beforeSha256 === undefined
        || checkpoint.afterSha256 === undefined
    )) {
        return "unverifiable";
    }

    for (let index = 1; index < checkpoints.length; index += 1) {
        const previous = checkpoints[index - 1]!;
        const current = checkpoints[index]!;
        if (previous.afterSha256 !== current.beforeSha256) {
            return "intervening_change";
        }
    }
    return "continuous";
}

/**
 * The direct file mutations this session can restore, oldest first. This is the
 * engine-owned seam a later interactive picker or RPC surface calls; it does not
 * render anything or cross the wire itself.
 */
export function listCheckpoints(
    store: SessionStore,
): readonly SessionCheckpointEntry[] {
    return store.checkpoints();
}

/**
 * Restore one file to the state captured before its `write`/`edit`. A file that
 * existed is rewritten with its prior contents; a file the agent created is
 * removed. This reverses only the file change: it makes no claim about bash,
 * deployments, databases, or remote effects, which were never captured.
 */
export async function restoreCheckpoint(
    store: SessionStore,
    checkpointStore: CheckpointStore,
    checkpointId: string,
): Promise<CheckpointRestoreResult> {
    const entry = store
        .checkpoints()
        .find((candidate) => candidate.checkpointId === checkpointId);
    if (entry === undefined) {
        throw new Error(`Unknown checkpoint ${checkpointId}`);
    }

    const blob = await checkpointStore.read(checkpointId);
    if (entry.existedBefore !== blob.existed) {
        throw new Error(
            `Checkpoint ${checkpointId} disagrees with its stored blob`,
        );
    }

    if (blob.existed) {
        await Bun.write(entry.path, blob.content);
        return {
            checkpointId,
            path: entry.path,
            action: "restored",
        };
    }

    await rm(entry.path, { force: true });
    return {
        checkpointId,
        path: entry.path,
        action: "removed",
    };
}
