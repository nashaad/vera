import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import {
    ImportRejectedError,
    ImportSourceReader,
    type ParsedImport,
} from "../session-import/index.ts";
import type { SessionImportRejection } from "./protocol.ts";

export interface SourceParsed {
    readonly status: "parsed";
    readonly parsed: ParsedImport;
    readonly sha256: string;
}

export interface SourceRejected {
    readonly status: "rejected";
    readonly reason: SessionImportRejection;
}

export type SourceParse = SourceParsed | SourceRejected;

const CHILD_ENTRY = fileURLToPath(new URL("./session-import-child.ts", import.meta.url));
const STDERR_TAIL_CHARS = 2000;

// Line by line: a source file can be hundreds of megabytes.
export async function parseSourceFile(path: string): Promise<SourceParse> {
    const hash = createHash("sha256");
    const reader = new ImportSourceReader();
    try {
        const stream = createReadStream(path);
        stream.on("data", (chunk) => hash.update(chunk));
        for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
            reader.addLine(line);
        }
    } catch {
        return { status: "rejected", reason: "unreadable" };
    }
    try {
        return { status: "parsed", parsed: reader.finish(), sha256: hash.digest("hex") };
    } catch (error) {
        if (error instanceof ImportRejectedError) {
            return { status: "rejected", reason: error.reason };
        }
        throw error;
    }
}

// The runtime keeps the memory a parse used, so a large file is parsed in a
// process that exits afterwards.
export function parseSourceFileInChild(path: string): Promise<SourceParse> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [CHILD_ENTRY, path], {
            argv0: "vera-import",
            stdio: ["ignore", "pipe", "pipe"],
        });
        const stdout: Buffer[] = [];
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => {
            stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
        });
        child.once("error", reject);
        child.once("close", (code, signal) => {
            if (code !== 0) {
                reject(new Error(
                    `The import parser exited with ${signal ?? `code ${code}`}: ${stderr.trim()}`,
                ));
                return;
            }
            try {
                resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")) as SourceParse);
            } catch {
                reject(new Error("The import parser returned no result"));
            }
        });
    });
}
