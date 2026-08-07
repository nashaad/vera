import {
    cp,
    mkdir,
    mkdtemp,
    rm,
    stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import trash from "trash";

export interface SessionArtifacts {
    readonly sessionPath: string;
    readonly attachmentsPath: string;
    readonly eventLogPath?: string;
}

export interface TrashSessionArtifactsOptions {
    readonly moveToTrash?: (paths: readonly string[]) => Promise<void>;
    readonly removeOriginal?: (path: string) => Promise<void>;
}

export async function trashSessionArtifacts(
    artifacts: SessionArtifacts,
    options: TrashSessionArtifactsOptions = {},
): Promise<void> {
    const stagingRoot = await mkdtemp(join(tmpdir(), "vera-session-trash-"));
    const recoveryBundle = join(stagingRoot, "recovery");
    const trashRoot = await mkdtemp(join(tmpdir(), "vera-session-trash-"));
    const trashBundle = join(trashRoot, "Vera Session");
    const existing = await existingArtifacts(artifacts);
    try {
        await mkdir(recoveryBundle);
        await Promise.all(existing.map(({ path, stagedName }) =>
            cp(path, join(recoveryBundle, stagedName), {
                recursive: true,
                force: false,
            })
        ));
        await cp(recoveryBundle, trashBundle, {
            recursive: true,
            force: false,
        });
        await (options.moveToTrash ?? ((paths) => trash([...paths])))(
            [trashBundle],
        );

        // The recoverable trash copy exists before originals are removed.
        // Keep the primary JSONL last so any earlier failure remains resumable.
        for (const artifact of existing.toReversed()) {
            await (options.removeOriginal
                ?? ((path) => rm(path, { recursive: true })))(artifact.path);
        }
        await rm(stagingRoot, { recursive: true, force: true });
        await rm(trashRoot, { recursive: true, force: true });
    } catch (error) {
        for (const artifact of existing) {
            if (!(await exists(artifact.path))) {
                try {
                    await cp(
                        join(recoveryBundle, artifact.stagedName),
                        artifact.path,
                        { recursive: true, force: false },
                    );
                } catch {
                    // The trash bundle remains the recovery source if restore fails.
                }
            }
        }
        await rm(stagingRoot, { recursive: true, force: true });
        await rm(trashRoot, { recursive: true, force: true });
        throw error;
    }
}

async function existingArtifacts(
    artifacts: SessionArtifacts,
): Promise<Array<{ readonly path: string; readonly stagedName: string }>> {
    const candidates = [
        { path: artifacts.sessionPath, stagedName: "session.jsonl" },
        ...(artifacts.eventLogPath === undefined
            ? []
            : [{ path: artifacts.eventLogPath, stagedName: "events.jsonl" }]),
        { path: artifacts.attachmentsPath, stagedName: "attachments" },
    ];
    const existing = [];
    for (const candidate of candidates) {
        try {
            await stat(candidate.path);
            existing.push(candidate);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
        }
    }
    if (!existing.some((artifact) => artifact.path === artifacts.sessionPath)) {
        throw new Error("Session file is unavailable");
    }
    return existing;
}

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return false;
        }
        throw error;
    }
}
