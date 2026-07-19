import { mkdir, open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The prior state of one file, captured before a `write` or `edit` mutation.
 * `existed` is false when the file did not exist yet (an agent-created file);
 * in that case `content` is the empty string and carries no meaning.
 */
export interface CheckpointBlob {
    readonly existed: boolean;
    readonly content: string;
}

/**
 * A separate on-disk store for pre-change file blobs, one directory per
 * session. Each blob is a single JSON file named by its checkpoint id. The
 * session record holds only the small metadata entry that references the id;
 * the potentially large file contents live here instead of in the event log.
 *
 * The directory is created lazily on the first write, so a session that never
 * mutates a file leaves nothing behind.
 */
export class CheckpointStore {
    private readonly directory: string;
    private ensured = false;

    constructor(directory: string) {
        this.directory = directory;
    }

    async write(checkpointId: string, blob: CheckpointBlob): Promise<void> {
        const id = nonEmpty(checkpointId, "checkpoint id");
        await this.ensureDirectory();
        const record: CheckpointBlob = {
            existed: blob.existed,
            content: blob.existed ? blob.content : "",
        };
        const file = await open(this.blobPath(id), "wx", 0o600);
        try {
            await file.chmod(0o600);
            await file.writeFile(`${JSON.stringify(record)}\n`, "utf8");
            await file.sync();
        } finally {
            await file.close();
        }
    }

    async read(checkpointId: string): Promise<CheckpointBlob> {
        const id = nonEmpty(checkpointId, "checkpoint id");
        const source = await readFile(this.blobPath(id), "utf8");
        const value: unknown = JSON.parse(source);
        if (
            typeof value !== "object"
            || value === null
            || typeof (value as Record<string, unknown>).existed !== "boolean"
            || typeof (value as Record<string, unknown>).content !== "string"
        ) {
            throw new Error(`Checkpoint blob ${id} is malformed`);
        }
        const record = value as CheckpointBlob;
        return { existed: record.existed, content: record.content };
    }

    private async ensureDirectory(): Promise<void> {
        if (this.ensured) {
            return;
        }
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        this.ensured = true;
    }

    private blobPath(checkpointId: string): string {
        return join(this.directory, `${checkpointId}.json`);
    }
}

export function defaultCheckpointDirectory(sessionId: string): string {
    return join(homedir(), ".vera", "checkpoints", nonEmpty(sessionId, "session id"));
}

function nonEmpty(value: string, label: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`A ${label} is required`);
    }
    if (value.includes("/") || value.includes("\\") || value === "..") {
        throw new Error(`A ${label} must not contain path separators`);
    }
    return value;
}
