import {
    formatModelSubstitution,
    projectTranscript,
    type TranscriptEntry,
} from "./engine/protocol.ts";
import {
    importToolLabel,
    type SessionImportTool,
} from "./store/session-import-provenance.ts";
import { readSessionSnapshot } from "./store/session-store.ts";

export type SessionExportFormat = "markdown" | "json";

export interface SessionExport {
    readonly format_version: 4;
    readonly session: {
        readonly id: string;
        readonly started_at: string;
        readonly workspace: string;
        readonly imported_from?: ExportedImportProvenance;
    };
    readonly transcript: readonly TranscriptEntry[];
    readonly agent_failure?: {
        readonly id: string;
        readonly occurred_at: string;
        readonly detail: string;
    };
}

export interface ExportedImportProvenance {
    readonly tool: SessionImportTool;
    readonly source_session_id: string;
    readonly source_started_at: string;
    readonly imported_at: string;
    readonly message_count: number;
    readonly last_message_id: string;
}

export async function exportSession(
    sessionPath: string,
    format: SessionExportFormat = "markdown",
): Promise<string> {
    const snapshot = await readSessionSnapshot(sessionPath);
    const imported = snapshot.header.importedFrom;
    const exported: SessionExport = {
        format_version: 4,
        session: {
            id: snapshot.header.id,
            started_at: snapshot.header.timestamp,
            workspace: snapshot.header.cwd,
            ...(imported === undefined ? {} : {
                imported_from: {
                    tool: imported.tool,
                    source_session_id: imported.sourceSessionId,
                    source_started_at: imported.sourceStartedAt,
                    imported_at: imported.importedAt,
                    message_count: imported.messageCount,
                    last_message_id: imported.lastMessageId,
                },
            }),
        },
        transcript: projectTranscript(
            snapshot.messages,
            undefined,
            snapshot.messageIds,
            snapshot.harnessMessages,
        ),
        ...(snapshot.agentFailure === undefined
            ? {}
            : {
                agent_failure: {
                    id: snapshot.agentFailure.id,
                    occurred_at: snapshot.agentFailure.timestamp,
                    detail: snapshot.agentFailure.detail,
                },
            }),
    };
    return format === "json"
        ? `${JSON.stringify(exported, null, 2)}\n`
        : renderSessionMarkdown(exported);
}

export function renderSessionMarkdown(exported: SessionExport): string {
    const lines = [
        "# Vera conversation",
        "",
        `- Session: ${inlineCode(exported.session.id)}`,
        `- Workspace: ${inlineCode(exported.session.workspace)}`,
        `- Started: ${inlineCode(exported.session.started_at)}`,
    ];
    const imported = exported.session.imported_from;
    if (imported !== undefined) {
        lines.push(
            `- Imported from: ${importToolLabel(imported.tool)} session`
                + ` ${inlineCode(imported.source_session_id)}, first`
                + ` ${imported.message_count} messages`,
        );
    }

    const importedThrough = lastImportedEntry(exported);
    for (const [index, entry] of exported.transcript.entries()) {
        const heading = index <= importedThrough
                && imported !== undefined
                && (entry.kind === "assistant" || entry.kind === "empty")
            ? `## ${importToolLabel(imported.tool)}`
            : transcriptHeading(entry);
        lines.push("", heading, "");
        if (entry.kind === "tool") {
            lines.push(indentJson(entry.args));
        } else if (entry.kind === "tool_result") {
            lines.push(quoteMarkdown(
                entry.output.length === 0 ? "(no output)" : entry.output,
            ));
        } else if (entry.kind === "error") {
            lines.push(quoteMarkdown(
                entry.outcome === "aborted"
                    ? "Interrupted"
                    : entry.detail ?? "Model request failed",
            ));
        } else if (entry.kind === "empty") {
            lines.push(quoteMarkdown("No response"));
        } else if (entry.kind === "presentation") {
            if (entry.presentation.kind === "unified_diff") {
                const fence = markdownFence(entry.presentation.patch);
                lines.push(
                    `File: ${inlineCode(entry.presentation.path)}`,
                    "",
                    `${fence}diff`,
                    entry.presentation.patch.trimEnd(),
                    fence,
                );
            } else {
                lines.push(quoteMarkdown(entry.presentation.text));
            }
        } else {
            lines.push(quoteMarkdown(renderTranscriptText(entry)));
        }
    }
    if (exported.agent_failure !== undefined) {
        lines.push(
            "",
            "## Resident agent failure",
            "",
            quoteMarkdown(exported.agent_failure.detail),
            "",
            `Failure ID: ${inlineCode(exported.agent_failure.id)}`,
            `Occurred: ${inlineCode(exported.agent_failure.occurred_at)}`,
        );
    }
    return `${lines.join("\n")}\n`;
}

// Transcript entry ids are `<message id>#<n>`; -1 when no entry is imported.
function lastImportedEntry(exported: SessionExport): number {
    const boundary = exported.session.imported_from?.last_message_id;
    if (boundary === undefined) return -1;
    return exported.transcript.findLastIndex((entry) =>
        entry.id?.startsWith(`${boundary}#`) === true
    );
}

function markdownFence(content: string): string {
    const longest = Math.max(
        0,
        ...content.matchAll(/`+/g).map((match) => match[0].length),
    );
    return "`".repeat(Math.max(3, longest + 1));
}

function renderTranscriptText(
    entry: Extract<
        TranscriptEntry,
        { kind: "user" | "assistant" | "model_substitution" | "harness" }
    >,
): string {
    if (entry.kind === "model_substitution") {
        return formatModelSubstitution(entry.substitution);
    }
    if (entry.kind === "harness") return entry.text;
    if (entry.kind !== "user" || entry.attachments === undefined) return entry.text;
    const images = entry.attachments.map(
        (attachment) => `[Image attachment: ${attachment.name ?? attachment.id}]`,
    ).join("\n");
    return entry.text.length === 0 ? images : `${entry.text}\n${images}`;
}

function transcriptHeading(entry: TranscriptEntry): string {
    if (entry.kind === "user") {
        return "## You";
    }
    if (entry.kind === "assistant" || entry.kind === "empty") {
        return "## Vera";
    }
    if (entry.kind === "error") {
        return entry.outcome === "aborted" ? "## Interrupted" : "## Model error";
    }
    if (entry.kind === "model_substitution") {
        return "## Model substitution";
    }
    if (entry.kind === "harness") {
        return "## Vera";
    }
    if (entry.kind === "presentation") {
        return "## Tool result";
    }
    return `## Tool · ${escapeHeading(entry.tool)}`;
}

function quoteMarkdown(text: string): string {
    return text.split("\n").map((line) => `> ${line}`).join("\n");
}

function escapeHeading(text: string): string {
    return text
        .replace(/[\r\n]+/g, " ")
        .replace(/([\\`*_{}\[\]()<>#+.!|~-])/g, "\\$1");
}

function inlineCode(text: string): string {
    const flattened = text.replace(/[\r\n]+/g, " ");
    const longestRun = Math.max(
        0,
        ...Array.from(flattened.matchAll(/`+/g), (match) => match[0].length),
    );
    const fence = "`".repeat(longestRun + 1);
    return `${fence} ${flattened} ${fence}`;
}

function indentJson(value: Readonly<Record<string, unknown>>): string {
    return JSON.stringify(value, null, 2)
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n");
}
