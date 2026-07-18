import { randomUUID } from "node:crypto";
import {
    chmod,
    link,
    mkdir,
    open,
    readFile,
    unlink,
} from "node:fs/promises";
import { dirname } from "node:path";

interface StartupClaimRecord {
    readonly pid: number;
    readonly token: string;
}

interface StartupClaimFile {
    readonly source: string;
    readonly record?: StartupClaimRecord;
}

export interface HostStartupClaim {
    release(): Promise<void>;
}

export interface AcquireHostStartupClaimOptions {
    readonly path: string;
    readonly pid?: number;
    readonly createToken?: () => string;
    readonly isProcessAlive?: (pid: number) => boolean;
}

export class HostStartupInProgressError extends Error {
    constructor() {
        super("Resident host startup is already in progress");
        this.name = "HostStartupInProgressError";
    }
}

export async function acquireHostStartupClaim(
    options: AcquireHostStartupClaimOptions,
): Promise<HostStartupClaim> {
    const pid = options.pid ?? process.pid;
    if (!Number.isInteger(pid) || pid <= 0) {
        throw new Error("Host startup PID must be a positive integer");
    }
    const isProcessAlive = options.isProcessAlive ?? processIsAlive;
    const record: StartupClaimRecord = {
        pid,
        token: nonEmpty(
            (options.createToken ?? randomUUID)(),
            "host startup token",
        ),
    };
    const source = `${JSON.stringify(record)}\n`;
    await mkdir(dirname(options.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(options.path), 0o700);
    const temporaryPath = `${options.path}.${randomUUID()}.tmp`;
    const temporaryFile = await open(temporaryPath, "wx", 0o600);
    try {
        await temporaryFile.chmod(0o600);
        await temporaryFile.writeFile(source, "utf8");
        await temporaryFile.sync();
    } finally {
        await temporaryFile.close();
    }

    let published = false;
    try {
        while (true) {
            try {
                await link(temporaryPath, options.path);
                published = true;
                return {
                    release: () => removeIfOwned(options.path, record.token),
                };
            } catch (error) {
                if (!isAlreadyExistsError(error)) {
                    throw error;
                }
            }

            const existing = await readClaimFile(options.path);
            if (existing === undefined) {
                continue;
            }
            if (
                existing.record !== undefined
                && isProcessAlive(existing.record.pid)
            ) {
                throw new HostStartupInProgressError();
            }
            await removeIfUnchanged(options.path, existing.source);
        }
    } finally {
        try {
            await removeFile(temporaryPath);
        } catch (error) {
            if (!published) {
                throw error;
            }
            // The claim is valid even if its temporary hard link remains.
        }
    }
}

async function removeIfOwned(
    path: string,
    expectedToken: string,
): Promise<void> {
    const current = await readClaimFile(path);
    if (current?.record?.token !== expectedToken) {
        return;
    }
    await removeFile(path);
}

async function removeIfUnchanged(
    path: string,
    expectedSource: string,
): Promise<void> {
    const current = await readClaimFile(path);
    if (current?.source !== expectedSource) {
        return;
    }
    await removeFile(path);
}

async function removeFile(path: string): Promise<void> {
    try {
        await unlink(path);
    } catch (error) {
        if (!isMissingFileError(error)) {
            throw error;
        }
    }
}

async function readClaimFile(path: string): Promise<StartupClaimFile | undefined> {
    let source: string;
    try {
        source = await readFile(path, "utf8");
    } catch (error) {
        if (isMissingFileError(error)) {
            return undefined;
        }
        throw error;
    }

    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch {
        return { source };
    }
    if (typeof value !== "object" || value === null) {
        return { source };
    }
    const record = value as Record<string, unknown>;
    if (
        !Number.isInteger(record.pid)
        || (record.pid as number) <= 0
        || typeof record.token !== "string"
        || record.token.length === 0
    ) {
        return { source };
    }
    return {
        source,
        record: record as unknown as StartupClaimRecord,
    };
}

function processIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

function nonEmpty(value: string, name: string): string {
    if (value.length === 0) {
        throw new Error(`${name} must not be empty`);
    }
    return value;
}

function isAlreadyExistsError(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isMissingFileError(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
}
