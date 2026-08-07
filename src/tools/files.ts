import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { editDiffPresentation } from "./diff-presentation.ts";
import type { RegisteredTool } from "./types.ts";
import type { HookToolCall } from "../sdk/hooks.ts";

/**
 * How much of a file one call may read when it names no range. A file larger
 * than this is read from its start and says how to continue, rather than being
 * buffered whole: the buffer is spent before any later limit could apply.
 */
export const READ_MAX_BYTES = 1024 * 1024;

/** How much of the head is inspected before deciding a file is not text. */
const BINARY_PROBE_BYTES = 8 * 1024;

export const readTool: RegisteredTool = {
    permissionInputs: [{ field: "path", kind: "path", verb: "read" }],
    definition: {
        name: "read",
        description: "Read a UTF-8 text file at any path available to Vera. "
            + "Relative paths resolve from the workspace. `offset` and `limit` "
            + "are byte counts, not lines, and a call that names neither reads "
            + `from the start of the file up to ${READ_MAX_BYTES} bytes.`,
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string" },
                offset: {
                    type: "integer",
                    minimum: 0,
                    description: "Byte offset to start reading from.",
                },
                limit: {
                    type: "integer",
                    minimum: 1,
                    description: "How many bytes to read.",
                },
            },
            required: ["path"],
            additionalProperties: false,
        },
    },
    async execute(input, context) {
        const path = requiredString(input, "path", "read");
        const offset = optionalInteger(input, "offset", 0) ?? 0;
        const limit = optionalInteger(input, "limit", 1);
        const safePath = await resolveReadPath(context.workspace, path);
        const file = Bun.file(safePath);
        // Stat first: the size decides whether this is a whole-file read, a
        // range, or a refusal, and asking costs nothing next to reading.
        const size = file.size;

        if (offset >= size && size > 0) {
            return {
                kind: "output",
                output: `Offset ${offset} is past the end of ${path} `
                    + `(${size} bytes).`,
                isError: true,
            };
        }

        const binary = await binaryRefusal(file, path, size);
        if (binary !== undefined) {
            return { kind: "output", output: binary, isError: true };
        }

        const wanted = limit ?? READ_MAX_BYTES;
        const end = Math.min(size, offset + wanted);
        const content = await file.slice(offset, end).text();
        const whole = offset === 0 && end === size;
        if (whole) {
            // Only a whole file is a snapshot: `edit` compares its own read of
            // the file against this, and a range would never match.
            context.recordFileSnapshot(safePath, content);
            return { kind: "output", output: content, isError: false };
        }
        return {
            kind: "output",
            output: `${content}\n[vera] Showed bytes ${offset}-${end} of `
                + `${path} (${size} bytes total). Read further with `
                + `offset=${end}. Editing this file needs a whole-file read `
                + "first.",
            isError: false,
        };
    },
};

/**
 * Bytes a text decoder cannot make sense of, probed on the head rather than
 * the whole file. A NUL is the giveaway no text format has, and an invalid
 * UTF-8 sequence in the first pages means the rest is not going to decode
 * either. The message names the size and a way through, because "not text" is
 * usually the start of a question about what the file is, not the end of one.
 */
async function binaryRefusal(
    file: ReturnType<typeof Bun.file>,
    path: string,
    size: number,
): Promise<string | undefined> {
    if (size === 0) {
        return undefined;
    }
    const probe = new Uint8Array(
        await file.slice(0, Math.min(size, BINARY_PROBE_BYTES)).arrayBuffer(),
    );
    const decodable = probe.includes(0)
        ? false
        : isDecodableUtf8(probe, probe.length < size);
    if (decodable) {
        return undefined;
    }
    return `${path} is not UTF-8 text (${size} bytes). Read a byte range of `
        + "it with offset and limit if you need the bytes, or inspect it "
        + "through bash (for example `file` or `xxd`).";
}

/**
 * A probe cut off mid-character is not evidence of anything, so a truncated
 * probe is decoded leniently at its tail: only bytes no UTF-8 sequence can
 * start count against the file.
 */
function isDecodableUtf8(probe: Uint8Array, partial: boolean): boolean {
    try {
        new TextDecoder("utf-8", { fatal: true }).decode(probe);
        return true;
    } catch {
        if (!partial) {
            return false;
        }
        try {
            new TextDecoder("utf-8", { fatal: true })
                .decode(probe.subarray(0, Math.max(0, probe.length - 4)));
            return true;
        } catch {
            return false;
        }
    }
}

function optionalInteger(
    input: Readonly<Record<string, unknown>>,
    field: string,
    minimum: number,
): number | undefined {
    const value = input[field];
    if (value === undefined) {
        return undefined;
    }
    if (
        typeof value !== "number"
        || !Number.isInteger(value)
        || value < minimum
    ) {
        throw new Error(
            `read tool ${field} must be an integer of at least ${minimum}`,
        );
    }
    return value;
}

export const writeTool: RegisteredTool = {
    permissionInputs: [{ field: "path", kind: "path", verb: "write" }],
    definition: {
        name: "write",
        description: "Create a new UTF-8 text file, or completely replace an existing one. Replacement is total: any existing content not included in this call is destroyed. To modify an existing file (append, insert, or change part of it), use edit instead. Relative paths resolve from the workspace.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string" },
                content: { type: "string" },
            },
            required: ["path", "content"],
            additionalProperties: false,
        },
    },
    async execute(input, context) {
        const path = requiredString(input, "path", "write");
        const content = requiredString(input, "content", "write");
        return context.enqueueFileMutation(async () => {
            const safePath = await resolveWritePath(context.workspace, path);
            const previousFile = Bun.file(safePath);
            const existedBefore = await previousFile.exists();
            const previousContent = existedBefore ? await previousFile.text() : "";
            if (existedBefore) {
                await context.stashPreimage(safePath, previousContent);
            }
            const bytesWritten = await Bun.write(safePath, content);
            context.recordFileSnapshot(safePath, content);
            return {
                kind: "output",
                output: writeResultSummary(
                    path,
                    content,
                    bytesWritten,
                    existedBefore,
                    previousContent,
                ),
                isError: false,
                presentation: editDiffPresentation(
                    path,
                    previousContent,
                    content,
                    context.stashDirectory,
                ),
            };
        });
    },
};

export function writeResultSummary(
    path: string,
    content: string,
    bytesWritten: number,
    existedBefore: boolean,
    previousContent: string,
): string {
    const written = `Wrote ${lineCount(content)} (${bytesWritten.toLocaleString()} bytes) to ${path}`;
    if (!existedBefore) {
        return `${written} (new file)`;
    }
    return `${written}, fully replacing the previous content: ${lineCount(previousContent)} (${Buffer.byteLength(previousContent).toLocaleString()} bytes)`;
}

function lineCount(content: string): string {
    const count = content === ""
        ? 0
        : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
    return `${count.toLocaleString()} line${count === 1 ? "" : "s"}`;
}

export async function resolveReadPath(
    workspace: string,
    requestedPath: string,
): Promise<string> {
    const root = await realpath(workspace);
    const candidate = resolve(root, requestedPath);
    return realpath(candidate);
}

export async function resolveWritePath(
    workspace: string,
    requestedPath: string,
): Promise<string> {
    const root = await realpath(workspace);
    const candidate = resolve(root, requestedPath);

    try {
        return await realpath(candidate);
    } catch (error) {
        if (!isMissingPathError(error)) {
            throw error;
        }
    }

    if (await pathEntryExists(candidate)) {
        throw new Error(`Path is an unresolved symbolic link: ${requestedPath}`);
    }

    const parent = await realpath(dirname(candidate));
    return join(parent, basename(candidate));
}

export async function resolveFileToolPermissionCall(
    workspace: string,
    toolCall: HookToolCall,
): Promise<HookToolCall> {
    if (
        toolCall.name !== "read"
        && toolCall.name !== "write"
        && toolCall.name !== "edit"
    ) {
        return toolCall;
    }
    const requestedPath = toolCall.input.path;
    if (typeof requestedPath !== "string") {
        return toolCall;
    }
    const path = toolCall.name === "write"
        ? await resolveWritePath(workspace, requestedPath)
        : await resolveReadPath(workspace, requestedPath);
    return {
        ...toolCall,
        input: { ...toolCall.input, path },
    };
}

export async function resolveFileToolPermissionContext(
    workspace: string,
    toolCall: HookToolCall,
): Promise<{ readonly workspace: string; readonly toolCall: HookToolCall }> {
    return {
        workspace: await realpath(workspace),
        toolCall: await resolveFileToolPermissionCall(workspace, toolCall),
    };
}

async function pathEntryExists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch (error) {
        if (isMissingPathError(error)) {
            return false;
        }
        throw error;
    }
}

function isMissingPathError(value: unknown): boolean {
    return value instanceof Error
        && "code" in value
        && value.code === "ENOENT";
}

function requiredString(
    input: Readonly<Record<string, unknown>>,
    field: string,
    tool: string,
): string {
    const value = input[field];
    if (typeof value !== "string") {
        throw new Error(`${tool} tool requires a string ${field}`);
    }
    return value;
}
