import { constants } from "node:fs";
import {
    lstat,
    open,
    realpath,
    rm,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";

import {
    sha256Text,
    type CheckpointBlob,
    type CheckpointStore,
} from "../store/checkpoint-store.ts";
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

export type BoundaryFileRestoreStatus =
    | "clean"
    | "already_restored"
    | "intervening_change"
    | "changed"
    | "missing"
    | "unexpected"
    | "unreadable"
    | "unverifiable";

export type BoundaryFileRestoreAction = "restore" | "remove" | "none";

export interface BoundaryFileRestorePlan {
    readonly path: string;
    readonly checkpointId: string;
    readonly mutationCount: number;
    readonly status: BoundaryFileRestoreStatus;
    readonly action: BoundaryFileRestoreAction;
}

export interface BoundaryRestorePlan {
    readonly boundaryId: string;
    readonly applicable: boolean;
    readonly files: readonly BoundaryFileRestorePlan[];
}

interface FileCheckpointGroup {
    readonly path: string;
    readonly checkpoints: readonly SessionCheckpointEntry[];
}

interface MissingFileState {
    readonly kind: "missing";
}

interface RegularFileState {
    readonly kind: "file";
    readonly sha256: string;
}

interface UnexpectedFileState {
    readonly kind: "unexpected";
}

interface UnreadableFileState {
    readonly kind: "unreadable";
}

type FileState =
    | MissingFileState
    | RegularFileState
    | UnexpectedFileState
    | UnreadableFileState;

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
 * Build an engine-owned preview for direct file mutations at and after one
 * durable user-message boundary. The preview contains no file contents and is
 * safe to serialize later; only the engine reads paths and checkpoint blobs.
 */
export async function planBoundaryFileRestore(
    store: SessionStore,
    checkpointStore: CheckpointStore,
    boundaryId: string,
): Promise<BoundaryRestorePlan> {
    const groups = checkpointGroupsAtOrAfter(store, boundaryId);
    let workspace: string;
    try {
        workspace = await realpath(store.header.cwd);
    } catch {
        return {
            boundaryId,
            applicable: false,
            files: groups.map((group) => blockedFilePlan(group, "unreadable")),
        };
    }

    const files: BoundaryFileRestorePlan[] = [];
    for (const group of groups) {
        files.push(await classifyFileGroup(
            checkpointStore,
            workspace,
            group,
        ));
    }
    return {
        boundaryId,
        applicable: files.every((file) =>
            file.status === "clean" || file.status === "already_restored"
        ),
        files,
    };
}

function checkpointGroupsAtOrAfter(
    store: SessionStore,
    boundaryId: string,
): readonly FileCheckpointGroup[] {
    const records = store.checkpointTimeline();
    const boundaryIndex = records.findIndex((record) =>
        record.type === "message"
        && record.id === boundaryId
        && record.message.role === "user"
        && record.message.internal !== true
    );
    if (boundaryIndex < 0) {
        throw new Error(`Unknown user-message boundary ${boundaryId}`);
    }

    const selectedRecords = records.slice(boundaryIndex);
    const includedBoundaries = new Set<string>();
    const checkpoints: SessionCheckpointEntry[] = [];
    for (const record of selectedRecords) {
        if (
            record.type === "message"
            && record.message.role === "user"
            && record.message.internal !== true
        ) {
            includedBoundaries.add(record.id);
            continue;
        }
        if (
            record.type === "checkpoint"
            && (record.userMessageId === undefined
                || includedBoundaries.has(record.userMessageId))
        ) {
            checkpoints.push(record);
        }
    }
    return groupCheckpoints(checkpoints);
}

function groupCheckpoints(
    checkpoints: readonly SessionCheckpointEntry[],
): readonly FileCheckpointGroup[] {
    const groups = new Map<string, SessionCheckpointEntry[]>();
    for (const checkpoint of checkpoints) {
        const group = groups.get(checkpoint.path);
        if (group === undefined) {
            groups.set(checkpoint.path, [checkpoint]);
        } else {
            group.push(checkpoint);
        }
    }
    return [...groups].map(([path, grouped]) => ({
        path,
        checkpoints: grouped,
    }));
}

async function classifyFileGroup(
    checkpointStore: CheckpointStore,
    workspace: string,
    group: FileCheckpointGroup,
): Promise<BoundaryFileRestorePlan> {
    const chain = checkpointChainStatus(group.checkpoints);
    if (chain === "unverifiable") {
        return blockedFilePlan(group, "unverifiable");
    }

    const earliest = group.checkpoints[0]!;
    const latest = group.checkpoints.at(-1)!;
    const target = await readValidatedTarget(checkpointStore, group.checkpoints);
    if (target === undefined) {
        return blockedFilePlan(group, "unreadable");
    }

    const current = await inspectFile(workspace, group.path);
    if (current.kind === "unexpected" || current.kind === "unreadable") {
        return blockedFilePlan(group, current.kind);
    }
    if (current.kind === "missing") {
        return target.existed
            ? blockedFilePlan(group, "missing")
            : readyFilePlan(group, "already_restored", "none");
    }

    const targetSha256 = target.existed ? sha256Text(target.content) : null;
    if (targetSha256 !== null && current.sha256 === targetSha256) {
        return readyFilePlan(group, "already_restored", "none");
    }
    if (chain === "intervening_change") {
        return blockedFilePlan(group, "intervening_change");
    }
    if (current.sha256 === latest.afterSha256) {
        return readyFilePlan(
            group,
            "clean",
            target.existed ? "restore" : "remove",
        );
    }
    return blockedFilePlan(group, target.existed ? "changed" : "unexpected");
}

async function readValidatedTarget(
    checkpointStore: CheckpointStore,
    checkpoints: readonly SessionCheckpointEntry[],
): Promise<CheckpointBlob | undefined> {
    let target: CheckpointBlob | undefined;
    for (const [index, checkpoint] of checkpoints.entries()) {
        let blob: CheckpointBlob;
        try {
            blob = await checkpointStore.read(checkpoint.checkpointId);
        } catch {
            return undefined;
        }
        if (!validTargetBlob(checkpoint, blob)) {
            return undefined;
        }
        if (index === 0) {
            target = blob;
        }
    }
    return target;
}

function validTargetBlob(
    checkpoint: SessionCheckpointEntry,
    blob: CheckpointBlob,
): boolean {
    return checkpoint.existedBefore === blob.existed
        && (blob.existed
            ? sha256Text(blob.content) === checkpoint.beforeSha256
            : blob.content === "" && checkpoint.beforeSha256 === null);
}

async function inspectFile(
    workspace: string,
    path: string,
): Promise<FileState> {
    if (!isInsideWorkspace(workspace, path)) {
        return { kind: "unexpected" };
    }

    let metadata;
    try {
        metadata = await lstat(path);
    } catch (error) {
        if (!isMissingPathError(error)) {
            return { kind: "unreadable" };
        }
        return await inspectMissingPath(workspace, path);
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
        return { kind: "unexpected" };
    }

    try {
        if (await realpath(path) !== path) {
            return { kind: "unexpected" };
        }
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const openedMetadata = await file.stat();
            if (
                !openedMetadata.isFile()
                || openedMetadata.dev !== metadata.dev
                || openedMetadata.ino !== metadata.ino
            ) {
                return { kind: "unexpected" };
            }
            const content = await file.readFile("utf8");
            const finalMetadata = await lstat(path);
            if (
                !finalMetadata.isFile()
                || finalMetadata.isSymbolicLink()
                || finalMetadata.dev !== openedMetadata.dev
                || finalMetadata.ino !== openedMetadata.ino
                || await realpath(path) !== path
            ) {
                return { kind: "unexpected" };
            }
            return { kind: "file", sha256: sha256Text(content) };
        } finally {
            await file.close();
        }
    } catch (error) {
        return isUnsafePathError(error)
            ? { kind: "unexpected" }
            : { kind: "unreadable" };
    }
}

async function inspectMissingPath(
    workspace: string,
    path: string,
): Promise<FileState> {
    try {
        const parent = dirname(path);
        return await realpath(parent) === parent && isInsideWorkspace(workspace, parent)
            ? { kind: "missing" }
            : { kind: "unexpected" };
    } catch (error) {
        return isMissingPathError(error) || isUnsafePathError(error)
            ? { kind: "unexpected" }
            : { kind: "unreadable" };
    }
}

function isInsideWorkspace(workspace: string, path: string): boolean {
    if (!isAbsolute(path)) {
        return false;
    }
    const pathFromWorkspace = relative(workspace, path);
    return pathFromWorkspace === ""
        || (!pathFromWorkspace.startsWith(`..${sep}`)
            && pathFromWorkspace !== ".."
            && !isAbsolute(pathFromWorkspace));
}

function isMissingPathError(value: unknown): boolean {
    return value instanceof Error
        && "code" in value
        && value.code === "ENOENT";
}

function isUnsafePathError(value: unknown): boolean {
    return value instanceof Error
        && "code" in value
        && (value.code === "ELOOP" || value.code === "ENOTDIR");
}

function readyFilePlan(
    group: FileCheckpointGroup,
    status: "clean" | "already_restored",
    action: BoundaryFileRestoreAction,
): BoundaryFileRestorePlan {
    return {
        path: group.path,
        checkpointId: group.checkpoints[0]!.checkpointId,
        mutationCount: group.checkpoints.length,
        status,
        action,
    };
}

function blockedFilePlan(
    group: FileCheckpointGroup,
    status: Exclude<BoundaryFileRestoreStatus, "clean" | "already_restored">,
): BoundaryFileRestorePlan {
    return {
        path: group.path,
        checkpointId: group.checkpoints[0]!.checkpointId,
        mutationCount: group.checkpoints.length,
        status,
        action: "none",
    };
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
