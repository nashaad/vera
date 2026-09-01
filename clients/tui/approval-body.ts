import { structuredPatch } from "diff";

import type { PermissionPredicate } from "../../src/engine/permissions.ts";
import type { ToolApprovalUiRequestUpdate } from "../../src/engine/protocol.ts";
import { tuiDisplayPath } from "./state.ts";

export type TuiApprovalTone = "text" | "muted" | "path" | "add" | "del";

export interface TuiApprovalLine {
    readonly text: string;
    readonly tone: TuiApprovalTone;
}

export interface TuiApprovalBody {
    readonly lines: readonly TuiApprovalLine[];
    readonly hidden: number;
}

export const TUI_APPROVAL_BODY_LINES = 15;

const EDIT_DIFF_CONTEXT = 3;

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
    edits.forEach((edit, index) => {
        const hunk = edit as Record<string, unknown>;
        if (index > 0) {
            lines.push({ text: "", tone: "muted" });
        }
        lines.push(...tuiEditHunkLines(
            stringField(hunk, "old_string") ?? "",
            stringField(hunk, "new_string") ?? "",
        ));
    });
    return lines;
}

/** The change between two strings as plain-data hunks: unchanged lines dimmed with one leading space and no marker, removed lines `-`, added lines `+`. */
export function tuiEditHunkLines(
    oldString: string,
    newString: string,
): readonly TuiApprovalLine[] {
    const patch = structuredPatch("old", "new", oldString, newString, "", "", {
        context: EDIT_DIFF_CONTEXT,
    });
    const lines: TuiApprovalLine[] = [];
    patch.hunks.forEach((hunk, index) => {
        if (index > 0) {
            lines.push({ text: " …", tone: "muted" });
        }
        for (const raw of hunk.lines) {
            if (raw === "\\ No newline at end of file") {
                continue;
            }
            const marker = raw.charAt(0);
            const content = raw.slice(1);
            if (marker === "+") {
                lines.push({ text: `+ ${content}`, tone: "add" });
            } else if (marker === "-") {
                lines.push({ text: `- ${content}`, tone: "del" });
            } else {
                lines.push({ text: ` ${content}`, tone: "muted" });
            }
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
        ...lines.map((line) => ({ text: `+ ${line}`, tone: "add" as const })),
    ];
}

export function tuiApprovalPath(path: string): string {
    return tuiDisplayPath(path);
}

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
