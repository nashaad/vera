import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type { RegisteredTool } from "./types.ts";
import type { HookToolCall } from "../sdk/hooks.ts";

export const readTool: RegisteredTool = {
    definition: {
        name: "read",
        description: "Read a UTF-8 text file at any path available to Vera. Relative paths resolve from the workspace.",
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
        description: "Write a UTF-8 text file at any path available to Vera. Relative paths resolve from the workspace.",
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
