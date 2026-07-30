import type { PermissionPredicate } from "../../src/engine/permissions.ts";
import type { ToolApprovalUiRequestUpdate } from "../../src/engine/protocol.ts";

/**
 * The body of the permission panel: the call itself, rendered as the tool
 * means it rather than as its serialized arguments. A JSON dump is what an
 * unknown tool falls back to, not what every tool gets.
 */
export type TuiApprovalTone = "text" | "muted" | "path" | "add" | "del";

export interface TuiApprovalLine {
    readonly text: string;
    readonly tone: TuiApprovalTone;
}

export interface TuiApprovalBody {
    readonly lines: readonly TuiApprovalLine[];
    /** Lines the cap is holding back, zero when everything is on screen. */
    readonly hidden: number;
}

/**
 * How tall the body may grow before it is capped. The panel sits above the
 * footer and may not push it off the screen, so a long call scrolls behind a
 * count rather than pressing the answers down.
 */
export const TUI_APPROVAL_BODY_LINES = 15;

export function tuiApprovalBody(
    update: ToolApprovalUiRequestUpdate,
    expanded = false,
    inlineScope = true,
): TuiApprovalBody {
    const lines = [
        ...sourceLines(update),
        ...callLines(update),
        ...scopeLines(update, inlineScope),
    ];
    if (expanded || lines.length <= TUI_APPROVAL_BODY_LINES) {
        return { lines, hidden: 0 };
    }
    const hidden = lines.length - TUI_APPROVAL_BODY_LINES;
    return {
        lines: [
            ...lines.slice(0, TUI_APPROVAL_BODY_LINES),
            { text: `… ${hidden} more lines · ctrl+r expand`, tone: "muted" },
        ],
        hidden,
    };
}

/** The panel body as plain text, for the headless renderer and for tests. */
export function tuiApprovalBodyText(
    update: ToolApprovalUiRequestUpdate,
    expanded = false,
    inlineScope = true,
): string {
    return tuiApprovalBody(update, expanded, inlineScope).lines
        .map((line) => line.text)
        .join("\n");
}

function sourceLines(
    update: ToolApprovalUiRequestUpdate,
): readonly TuiApprovalLine[] {
    const agent = update.request.sourceAgentId;
    if (agent === undefined) {
        return [];
    }
    const task = update.request.sourceTask;
    return [
        { text: `Requested by agent ${agent.slice(0, 8)}`, tone: "muted" },
        ...(task === undefined
            ? []
            : [{ text: `Task: ${task}`, tone: "muted" as const }]),
        { text: "", tone: "muted" },
    ];
}

function callLines(
    update: ToolApprovalUiRequestUpdate,
): readonly TuiApprovalLine[] {
    const call = update.request.toolCall;
    const input = call.input as Record<string, unknown>;
    if (call.name === "bash") {
        return bashLines(input, update.request.warning);
    }
    if (call.name === "edit") {
        return editLines(input);
    }
    if (call.name === "write") {
        return writeLines(input);
    }
    return [{
        text: `${call.name} ${JSON.stringify(call.input)}`,
        tone: "text",
    }];
}

function bashLines(
    input: Record<string, unknown>,
    warning: string,
): readonly TuiApprovalLine[] {
    const command = stringField(input, "command");
    if (command === undefined) {
        return [{ text: `bash ${JSON.stringify(input)}`, tone: "text" }];
    }
    return [
        ...command.split("\n").map((line, index) => ({
            text: index === 0 ? `$ ${line}` : `  ${line}`,
            tone: "text" as const,
        })),
        // The authority warning is about running a process, so it belongs to
        // the tool that runs one.
        { text: "", tone: "muted" },
        { text: warning, tone: "muted" },
    ];
}

function editLines(
    input: Record<string, unknown>,
): readonly TuiApprovalLine[] {
    const path = stringField(input, "path");
    const edits = Array.isArray(input.edits) ? input.edits : [];
    if (path === undefined || edits.length === 0) {
        return [{ text: `edit ${JSON.stringify(input)}`, tone: "text" }];
    }
    const lines: TuiApprovalLine[] = [
        { text: tuiApprovalPath(path), tone: "path" },
    ];
    // The file's own line numbers are not in the call, and the client does not
    // read a workspace that may not be on this machine, so the hunks are shown
    // in the order the call makes them rather than against a numbered file.
    edits.forEach((edit, index) => {
        const hunk = edit as Record<string, unknown>;
        if (index > 0) {
            lines.push({ text: "", tone: "muted" });
        }
        for (const line of (stringField(hunk, "old_string") ?? "").split("\n")) {
            lines.push({ text: `- ${line}`, tone: "del" });
        }
        for (const line of (stringField(hunk, "new_string") ?? "").split("\n")) {
            lines.push({ text: `+ ${line}`, tone: "add" });
        }
    });
    return lines;
}

function writeLines(
    input: Record<string, unknown>,
): readonly TuiApprovalLine[] {
    const path = stringField(input, "path");
    const content = stringField(input, "content");
    if (path === undefined || content === undefined) {
        return [{ text: `write ${JSON.stringify(input)}`, tone: "text" }];
    }
    const lines = content === "" ? [] : content.split("\n");
    return [
        { text: tuiApprovalPath(path), tone: "path" },
        {
            text: `${lines.length} ${lines.length === 1 ? "line" : "lines"}`,
            tone: "muted",
        },
        // What is about to be written is the thing being approved, so it is in
        // the body. The cap is what keeps a large file out of the panel.
        ...lines.map((line) => ({ text: `+ ${line}`, tone: "add" as const })),
    ];
}

/**
 * A path the user can place at a glance: relative inside the project, absolute
 * outside it, where the absolute form is the part that matters.
 */
export function tuiApprovalPath(path: string): string {
    const workspace = `${process.cwd()}/`;
    return path.startsWith(workspace) ? path.slice(workspace.length) : path;
}

/**
 * A predicate in full, since a decision stores all of it. Every field that
 * narrows the grant is written, so the label can never claim less than what is
 * being remembered.
 */
export function describeGrantPredicate(
    when: PermissionPredicate,
): string {
    const parts = [
        when.verb,
        when.operation,
        when.executable,
        when.tool !== undefined && when.executable === undefined
            ? when.tool
            : undefined,
        when.pathGlob,
        when.path === undefined ? undefined : tuiApprovalPath(when.path),
        when.scope,
    ].filter((part): part is string => part !== undefined);
    return parts.length === 0 ? "similar actions" : parts.join(" ");
}

/**
 * What the remembering rows cannot offer. When a predicate rides on the choice
 * label the body says nothing, so the same scope is never stated twice.
 */
function scopeLines(
    update: ToolApprovalUiRequestUpdate,
    inlineScope: boolean,
): readonly TuiApprovalLine[] {
    if (update.request.sourceAgentId !== undefined) {
        return [];
    }
    const grants = update.request.permissionGrants;
    if (grants === undefined) {
        return [
            { text: "", tone: "muted" },
            { text: "Session and always are unavailable.", tone: "muted" },
        ];
    }
    // One predicate rides on the choice label when the row can hold it. A set
    // of them never can, so it is written out rather than summarized by
    // whichever one came first.
    if (grants.length === 1 && inlineScope) {
        return [];
    }
    return [
        { text: "", tone: "muted" },
        { text: "Session and always remember:", tone: "muted" },
        ...grants.map((grant) => ({
            text: `- ${describeGrantPredicate(grant.when)}`,
            tone: "muted" as const,
        })),
    ];
}

function stringField(
    input: Record<string, unknown>,
    name: string,
): string | undefined {
    const value = input[name];
    return typeof value === "string" ? value : undefined;
}
