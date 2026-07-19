import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

import type { RegisteredTool } from "./types.ts";

export const readTool: RegisteredTool = {
    definition: {
        name: "read",
        description: "Read a UTF-8 text file inside the workspace.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string" },
            },
            required: ["path"],
            additionalProperties: false,
        },
    },
    async execute(input, context) {
        const path = requiredString(input, "path", "read");
        const safePath = await resolveReadPath(context.workspace, path);
        const content = await Bun.file(safePath).text();
        context.recordFileSnapshot(safePath, content);
        return {
            kind: "output",
            output: content,
            isError: false,
        };
    },
};

export const writeTool: RegisteredTool = {
    definition: {
        name: "write",
        description: "Write a UTF-8 text file inside the workspace.",
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
            const safePath = await safeWritePath(context.workspace, path);
            const prior = await readPriorContent(safePath);
            await context.recordCheckpoint({
                path: safePath,
                existedBefore: prior !== null,
                priorContent: prior ?? "",
                intendedContent: content,
                tool: "write",
            });
            const bytesWritten = await Bun.write(safePath, content);
            context.recordFileSnapshot(safePath, content);
            return {
                kind: "output",
                output: `Wrote ${bytesWritten} bytes to ${path}`,
                isError: false,
            };
        });
    },
};

async function readPriorContent(safePath: string): Promise<string | null> {
    try {
        return await Bun.file(safePath).text();
    } catch (error) {
        if (isMissingPathError(error)) {
            return null;
        }
        throw error;
    }
}

export async function resolveReadPath(
    workspace: string,
    requestedPath: string,
): Promise<string> {
    const root = await realpath(workspace);
    const candidate = resolve(root, requestedPath);
    assertInsideWorkspace(root, candidate);

    const target = await realpath(candidate);
    assertInsideWorkspace(root, target);
    return target;
}

async function safeWritePath(
    workspace: string,
    requestedPath: string,
): Promise<string> {
    const root = await realpath(workspace);
    const candidate = resolve(root, requestedPath);
    assertInsideWorkspace(root, candidate);

    try {
        const target = await realpath(candidate);
        assertInsideWorkspace(root, target);
        return target;
    } catch (error) {
        if (!isMissingPathError(error)) {
            throw error;
        }
    }

    if (await pathEntryExists(candidate)) {
        throw new Error(`Path is an unresolved symbolic link: ${requestedPath}`);
    }

    const parent = await realpath(dirname(candidate));
    assertInsideWorkspace(root, parent);
    return join(parent, basename(candidate));
}

function assertInsideWorkspace(root: string, candidate: string): void {
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
        throw new Error(`Path is outside the workspace: ${candidate}`);
    }
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
