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
        return {
            output: await readFileInWorkspace(context.workspace, path),
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
        return {
            output: await writeFileInWorkspace(context.workspace, path, content),
            isError: false,
        };
    },
};

export async function readFileInWorkspace(
    workspace: string,
    requestedPath: string,
): Promise<string> {
    const safePath = await safeReadPath(workspace, requestedPath);
    return Bun.file(safePath).text();
}

export async function writeFileInWorkspace(
    workspace: string,
    requestedPath: string,
    content: string,
): Promise<string> {
    const safePath = await safeWritePath(workspace, requestedPath);
    const bytesWritten = await Bun.write(safePath, content);
    return `Wrote ${bytesWritten} bytes to ${requestedPath}`;
}

async function safeReadPath(
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
