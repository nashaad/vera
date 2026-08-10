import type { RegisteredTool, ToolOutput } from "./types.ts";
import { resolveReadPath } from "./files.ts";

const DEFAULT_MAX_RESULTS = 250;
const MAX_RESULTS_CAP = 1000;

const DESCRIPTION = [
    "List files and directories under a path using filesystem APIs, not by",
    "parsing `ls`. Read-only. Always use this tool instead of running `ls`,",
    "`find`, or `tree` through the bash tool: those go through a shell, cost a",
    "permission decision, and have no result cap. Use `glob` to filter and",
    "`offset` to page through a large directory.",
].join(" ");

export const listTool: RegisteredTool = {
    permissionInputs: [{ field: "path", kind: "path", verb: "read" }],
    definition: {
        name: "list",
        description: DESCRIPTION,
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string" },
                glob: { type: "string" },
                recursive: { type: "boolean" },
                hidden: { type: "boolean" },
                offset: { type: "integer", minimum: 0 },
                max_results: { type: "integer", minimum: 1 },
            },
            required: ["path"],
            additionalProperties: false,
        },
    },
    async execute(input, context): Promise<ToolOutput> {
        const requestedPath = workspacePath(input, "path");
        const targetPath = await resolveReadPath(
            context.workspace,
            requestedPath,
        );
        const recursive = input.recursive === true;
        const hidden = input.hidden === true;
        const globValue = input.glob;
        if (globValue !== undefined && typeof globValue !== "string") {
            throw new Error("list tool glob must be a string");
        }
        const maxResults = parseMaxResults(input.max_results);
        const offset = parseOffset(input.offset);
        const pattern = `${recursive ? "**/" : ""}${globValue ?? "*"}`;

        const glob = new Bun.Glob(pattern);
        const paths: string[] = [];
        for await (
            const entry of glob.scan({
                cwd: targetPath,
                dot: hidden,
                onlyFiles: false,
                absolute: true,
            })
        ) {
            paths.push(entry);
        }
        paths.sort();
        return {
            kind: "output",
            output: formatEntries(paths, maxResults, offset),
            isError: false,
        };
    },
};

/**
 * A recursive scan of a large tree can run to tens of thousands of entries, so
 * the window is capped and its bounds are stated. Without this the tool is a
 * context-flooding hazard and the model learns to avoid it.
 */
function formatEntries(
    paths: readonly string[],
    maxResults: number,
    offset: number,
): string {
    if (paths.length === 0) {
        return "(no entries)";
    }
    if (offset >= paths.length) {
        return `(no entries at offset ${offset}; ${paths.length} total)`;
    }
    const shown = paths.slice(offset, offset + maxResults);
    const end = offset + shown.length;
    if (offset === 0 && end >= paths.length) {
        return shown.join("\n");
    }
    return `${shown.join("\n")}\n(showing ${offset + 1}-${end} of `
        + `${paths.length}; pass offset=${end} for more)`;
}

function parseMaxResults(value: unknown): number {
    if (value === undefined) {
        return DEFAULT_MAX_RESULTS;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        throw new Error("list tool max_results must be a positive integer");
    }
    return Math.min(value, MAX_RESULTS_CAP);
}

function parseOffset(value: unknown): number {
    if (value === undefined) {
        return 0;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw new Error("list tool offset must be a non-negative integer");
    }
    return value;
}

function workspacePath(
    input: Readonly<Record<string, unknown>>,
    field: string,
): string {
    const value = input[field];
    if (typeof value !== "string") {
        throw new Error(`list tool requires a string ${field}`);
    }
    return value || ".";
}
