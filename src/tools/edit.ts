import { resolveReadPath } from "./files.ts";
import type { ToolRuntime } from "./runtime.ts";
import type { RegisteredTool, ToolExecutionResult } from "./types.ts";

interface TextEdit {
    readonly oldString: string;
    readonly newString: string;
}

interface MatchResult {
    readonly count: number;
    readonly index: number;
}

export const editTool: RegisteredTool = {
    permissionInputs: [{ field: "path", kind: "path", verb: "write" }],
    definition: {
        name: "edit",
        description: "Edit a previously read file using exact text replacements.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string" },
                edits: {
                    type: "array",
                    minItems: 1,
                    items: {
                        type: "object",
                        properties: {
                            old_string: { type: "string" },
                            new_string: { type: "string" },
                        },
                        required: ["old_string", "new_string"],
                        additionalProperties: false,
                    },
                },
            },
            required: ["path", "edits"],
            additionalProperties: false,
        },
    },
    execute(input, runtime): Promise<ToolExecutionResult> {
        assertOnlyFields(input, ["path", "edits"], "edit tool");
        const path = requiredString(input, "path");
        const edits = parseEdits(input.edits);
        return editFileInWorkspace(runtime, path, edits);
    },
};

async function editFileInWorkspace(
    runtime: ToolRuntime,
    requestedPath: string,
    edits: readonly TextEdit[],
): Promise<ToolExecutionResult> {
    return runtime.enqueueFileMutation(async () => {
        const path = await resolveReadPath(runtime.workspace, requestedPath);
        const originalContent = await Bun.file(path).text();
        runtime.assertFreshFileSnapshot(path, originalContent, requestedPath);

        let editedContent = originalContent;
        for (const [index, edit] of edits.entries()) {
            const match = findExactMatches(editedContent, edit.oldString);
            if (match.count !== 1) {
                throw new Error(
                    `edits[${index}].old_string matched ${match.count} times in ${requestedPath}; expected exactly 1`,
                );
            }
            editedContent = editedContent.slice(0, match.index)
                + edit.newString
                + editedContent.slice(match.index + edit.oldString.length);
        }

        await Bun.write(path, editedContent);
        runtime.recordFileSnapshot(path, editedContent);
        return {
            kind: "output",
            output: `Applied ${edits.length} edit${edits.length === 1 ? "" : "s"} to ${requestedPath}`,
            isError: false,
        };
    });
}

function parseEdits(value: unknown): TextEdit[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error("edit tool requires a non-empty edits array");
    }

    return value.map((item, index) => {
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
            throw new Error(`edit tool requires edits[${index}] to be an object`);
        }
        assertOnlyFields(
            item,
            ["old_string", "new_string"],
            `edits[${index}]`,
        );
        const oldString = requiredString(item, "old_string", `edits[${index}]`);
        if (oldString.length === 0) {
            throw new Error(`edits[${index}].old_string must not be empty`);
        }
        return {
            oldString,
            newString: requiredString(item, "new_string", `edits[${index}]`),
        };
    });
}

function assertOnlyFields(
    input: Readonly<Record<string, unknown>>,
    allowedFields: readonly string[],
    parent: string,
): void {
    const unexpectedField = Object.keys(input).find(
        (field) => !allowedFields.includes(field),
    );
    if (unexpectedField !== undefined) {
        throw new Error(`${parent} does not allow ${unexpectedField}`);
    }
}

function requiredString(
    input: Readonly<Record<string, unknown>>,
    field: string,
    parent = "edit tool",
): string {
    const value = input[field];
    if (typeof value !== "string") {
        throw new Error(`${parent} requires a string ${field}`);
    }
    return value;
}

function findExactMatches(content: string, oldString: string): MatchResult {
    let count = 0;
    let firstIndex = -1;
    let searchFrom = 0;

    while (searchFrom <= content.length - oldString.length) {
        const index = content.indexOf(oldString, searchFrom);
        if (index === -1) {
            break;
        }
        if (count === 0) {
            firstIndex = index;
        }
        count += 1;
        searchFrom = index + 1;
    }

    return { count, index: firstIndex };
}
