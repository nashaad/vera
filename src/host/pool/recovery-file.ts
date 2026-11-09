import { stat } from "node:fs/promises";

export interface RecoveryFileStamp {
    readonly device: bigint;
    readonly inode: bigint;
    readonly size: bigint;
    readonly modified: bigint;
    readonly changed: bigint;
}

export async function recoveryFileStamp(path: string): Promise<RecoveryFileStamp | null> {
    try {
        const value = await stat(path, { bigint: true });
        return { device: value.dev, inode: value.ino, size: value.size, modified: value.mtimeNs, changed: value.ctimeNs };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
}

export function sameRecoveryFile(left: RecoveryFileStamp | null, right: RecoveryFileStamp | null): boolean {
    if (left === null || right === null) return left === right;
    return left.device === right.device && left.inode === right.inode && left.size === right.size
        && left.modified === right.modified && left.changed === right.changed;
}
