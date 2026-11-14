import { constants } from "node:fs";
import { open, realpath, stat, unlink } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { FILE_COUNT_LIMIT, FILE_SIZE_LIMIT } from "./file-limits.ts";

export { FILE_COUNT_LIMIT, FILE_SIZE_LIMIT } from "./file-limits.ts";

export interface FileLocation {
    readonly workspace: string;
    readonly chat: boolean;
}

export function fileErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : "";
    return ["Folders cannot be attached to a chat.", "Files must be 20 MB or smaller.",
        "That is not a regular file.", "A message can have up to 8 files.",
        "Could not copy the file.", "Could not find an unused file name.",
        "The session folder is not available."].includes(message) ? message : "Could not attach these files.";
}

export async function checkFile(path: string, location: FileLocation): Promise<"file" | "folder"> {
    const source = resolve(location.workspace, path);
    const info = await stat(source);
    if (info.isDirectory()) {
        if (location.chat) throw new Error("Folders cannot be attached to a chat.");
        return "folder";
    }
    if (!info.isFile()) throw new Error("That is not a regular file.");
    if (info.size > FILE_SIZE_LIMIT) throw new Error("Files must be 20 MB or smaller.");
    return "file";
}

export async function prepareFiles(paths: readonly string[], location: FileLocation): Promise<readonly string[]> {
    if (paths.length > FILE_COUNT_LIMIT) throw new Error("A message can have up to 8 files.");
    const results: string[] = [];
    try {
        for (const path of paths) {
            await checkFile(path, location);
            const source = await realpath(resolve(location.workspace, path));
            if (location.chat) {
                results.push(await copyToChat(source, location.workspace));
            } else {
                const workspace = await realpath(location.workspace);
                const local = relative(workspace, source);
                results.push(local === "" ? "." : local.startsWith(`..${sep}`) || local === ".." || isAbsolute(local) ? source : local);
            }
        }
    } catch (error) {
        if (location.chat) await Promise.all(results.map((name) => unlink(join(location.workspace, name)).catch(() => {})));
        throw error;
    }
    return results;
}

async function copyToChat(source: string, workspace: string): Promise<string> {
    const name = basename(source);
    const extension = extname(name);
    const stem = name.slice(0, name.length - extension.length);
    const input = await open(source, constants.O_RDONLY);
    try {
        for (let number = 1; number <= 10000; number += 1) {
            const candidate = number === 1 ? name : `${stem} ${number}${extension}`;
            const destination = join(workspace, candidate);
            let output;
            try {
                output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
                throw error;
            }
            try {
                const buffer = Buffer.allocUnsafe(64 * 1024);
                let total = 0;
                while (true) {
                    const { bytesRead } = await input.read(buffer, 0, buffer.length, total);
                    if (bytesRead === 0) break;
                    total += bytesRead;
                    if (total > FILE_SIZE_LIMIT) throw new Error("Files must be 20 MB or smaller.");
                    let written = 0;
                    while (written < bytesRead) {
                        const result = await output.write(buffer, written, bytesRead - written);
                        if (result.bytesWritten === 0) throw new Error("Could not copy the file.");
                        written += result.bytesWritten;
                    }
                }
                return candidate;
            } catch (error) {
                await output.close().catch(() => {});
                await unlink(destination).catch(() => {});
                throw error;
            } finally {
                await output.close().catch(() => {});
            }
        }
        throw new Error("Could not find an unused file name.");
    } finally {
        await input.close();
    }
}

