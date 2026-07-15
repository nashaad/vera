import {
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const INSTANCE_RECORD_SCHEMA_VERSION = 1;

export type InstanceClient = "stdio" | "tui";

export interface InstanceRecord {
    readonly schema_version: typeof INSTANCE_RECORD_SCHEMA_VERSION;
    readonly instance_id: string;
    readonly pid: number;
    readonly client: InstanceClient;
    readonly workspace_path: string;
    readonly started_at: string;
}

export interface RegisterInstanceInput {
    readonly client: InstanceClient;
    readonly workspacePath: string;
}

export interface InstanceRegistration {
    readonly record: InstanceRecord;
    remove(): void;
}

export interface InstanceDirectory {
    register(input: RegisterInstanceInput): InstanceRegistration;
    list(): readonly InstanceRecord[];
}

export interface InstanceDirectoryOptions {
    readonly path?: string;
    readonly pid?: number;
    readonly now?: () => Date;
    readonly createInstanceId?: () => string;
    readonly isProcessAlive?: (pid: number) => boolean;
}

export function defaultInstanceDirectoryPath(): string {
    return join(homedir(), ".vera", "instances");
}

export function createInstanceDirectory(
    options: InstanceDirectoryOptions = {},
): InstanceDirectory {
    const directoryPath = options.path ?? defaultInstanceDirectoryPath();
    const pid = options.pid ?? process.pid;
    const now = options.now ?? (() => new Date());
    const createInstanceId = options.createInstanceId ?? randomUUID;
    const isProcessAlive = options.isProcessAlive ?? processIsAlive;

    return {
        register(input: RegisterInstanceInput): InstanceRegistration {
            const record: InstanceRecord = {
                schema_version: INSTANCE_RECORD_SCHEMA_VERSION,
                instance_id: createInstanceId(),
                pid,
                client: input.client,
                workspace_path: input.workspacePath,
                started_at: now().toISOString(),
            };

            mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
            writeRecordAtomically(directoryPath, record);

            return {
                record,
                remove(): void {
                    removeIfOwned(directoryPath, record);
                },
            };
        },

        list(): readonly InstanceRecord[] {
            let fileNames: string[];
            try {
                fileNames = readdirSync(directoryPath);
            } catch (error) {
                if (isMissingFileError(error)) {
                    return [];
                }
                throw error;
            }

            const records: InstanceRecord[] = [];
            for (const fileName of fileNames.sort()) {
                const record = readRecord(join(directoryPath, fileName));
                if (record === undefined || fileName !== `${record.pid}.json`) {
                    continue;
                }

                if (!isProcessAlive(record.pid)) {
                    removeIfOwned(directoryPath, record);
                    continue;
                }

                records.push(record);
            }

            return records.sort((left, right) =>
                left.started_at.localeCompare(right.started_at)
                    || left.instance_id.localeCompare(right.instance_id)
            );
        },
    };
}

function writeRecordAtomically(
    directoryPath: string,
    record: InstanceRecord,
): void {
    const recordPath = join(directoryPath, `${record.pid}.json`);
    const temporaryPath = join(
        directoryPath,
        `.${record.pid}.${record.instance_id}.tmp`,
    );

    try {
        writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
        });
        renameSync(temporaryPath, recordPath);
    } catch (error) {
        try {
            unlinkSync(temporaryPath);
        } catch {
            // The write may have failed before the temporary file existed.
        }
        throw error;
    }
}

function removeIfOwned(
    directoryPath: string,
    expected: InstanceRecord,
): void {
    const recordPath = join(directoryPath, `${expected.pid}.json`);
    const current = readRecord(recordPath);
    if (current?.instance_id !== expected.instance_id) {
        return;
    }

    try {
        unlinkSync(recordPath);
    } catch (error) {
        if (!isMissingFileError(error)) {
            throw error;
        }
    }
}

function readRecord(path: string): InstanceRecord | undefined {
    let contents: string;
    try {
        contents = readFileSync(path, "utf8");
    } catch (error) {
        if (isMissingFileError(error)) {
            return undefined;
        }
        throw error;
    }

    try {
        return parseInstanceRecord(JSON.parse(contents));
    } catch {
        return undefined;
    }
}

function parseInstanceRecord(value: unknown): InstanceRecord | undefined {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }

    const record = value as Record<string, unknown>;
    if (
        record.schema_version !== INSTANCE_RECORD_SCHEMA_VERSION
        || typeof record.instance_id !== "string"
        || record.instance_id.length === 0
        || !Number.isInteger(record.pid)
        || (record.pid as number) <= 0
        || (record.client !== "stdio" && record.client !== "tui")
        || typeof record.workspace_path !== "string"
        || typeof record.started_at !== "string"
        || Number.isNaN(Date.parse(record.started_at))
    ) {
        return undefined;
    }

    return record as unknown as InstanceRecord;
}

function processIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

function isMissingFileError(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
}
