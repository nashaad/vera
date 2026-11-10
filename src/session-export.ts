import {
    formatHookContext,
    formatModelSubstitution,
    type TranscriptEntry,
} from "./engine/protocol.ts";
import {
    importToolLabel,
    type SessionImportTool,
} from "./store/session-import-provenance.ts";
import { SessionStore } from "./store/session-store.ts";
import { projectIndexedMessage, walkSessionTranscript } from "./session-transcript.ts";

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
    const store = await SessionStore.openReadOnly(sessionPath);
    try {
        const imported = store.header.importedFrom;
        const session: SessionExport["session"] = {
            id: store.header.id,
            started_at: store.header.timestamp,
            workspace: store.header.cwd,
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
        };
        const failure = store.agentFailure();
        const agentFailure: SessionExport["agent_failure"] = failure === undefined ? undefined : {
            id: failure.id, occurred_at: failure.timestamp, detail: failure.detail,
        };
        const headId = store.activeHeadId();
        const limit = store.appendedLineCount();
        if (format === "json") {
            const prefix = JSON.stringify({ format_version: 4, session }, null, 2);
            const chunks = [prefix.slice(0, -2), ',\n  "transcript": ['];
            let count = 0;
            for await (const entry of walkSessionTranscript(store, headId, limit, false)) {
                if (!isExportedEntry(entry)) continue;
                chunks.push(count++ === 0 ? "\n" : ",\n");
                chunks.push(JSON.stringify(entry, null, 2).replace(/^/gm, "    "));
            }
            chunks.push(count === 0 ? "]" : "\n  ]");
            if (agentFailure !== undefined) {
                chunks.push(',\n  "agent_failure": ', JSON.stringify(agentFailure, null, 2).replaceAll("\n", "\n  "));
            }
            chunks.push("\n}\n");
            return chunks.join("");
        }
        const lines = markdownHeader(session);
        const boundary = session.imported_from?.last_message_id;
        let lastImportedId: string | undefined;
        if (boundary !== undefined && headId !== null) {
            for await (const message of store.walkMessageAncestors(headId)) {
                if (message.id !== boundary && !message.id.startsWith(`${boundary}#`)) continue;
                if ((await projectIndexedMessage(store, message, false)).some((entry) =>
                    isExportedEntry(entry) && entry.id?.startsWith(`${boundary}#`) === true
                )) {
                    lastImportedId = message.id;
                    break;
                }
            }
        }
        let importedThroughBoundary = lastImportedId !== undefined;
        let sawBoundary = false;
        for await (const entry of walkSessionTranscript(store, headId, limit, false)) {
            if (!isExportedEntry(entry)) continue;
            const hash = entry.id?.lastIndexOf("#") ?? -1;
            const isBoundary = hash > 0 && entry.id?.slice(0, hash) === lastImportedId;
            if (sawBoundary && !isBoundary) importedThroughBoundary = false;
            appendMarkdownEntry(lines, entry, importedThroughBoundary ? session.imported_from : undefined);
            if (isBoundary) sawBoundary = true;
        }
        appendMarkdownFailure(lines, agentFailure);
        return `${lines.join("\n")}\n`;
    } finally {
        await store.closeReadOnly();
    }
}

export function renderSessionMarkdown(exported: SessionExport): string {
    const transcript = exported.transcript.filter(isExportedEntry);
    const lines = markdownHeader(exported.session);
    const importedThrough = lastImportedEntry({ ...exported, transcript });
    for (const [index, entry] of transcript.entries()) {
        appendMarkdownEntry(lines, entry, index <= importedThrough ? exported.session.imported_from : undefined);
    }
    appendMarkdownFailure(lines, exported.agent_failure);
    return `${lines.join("\n")}\n`;
}

function markdownHeader(session: SessionExport["session"]): string[] {
    const lines = [
        "# Vera conversation",
        "",
        `- Session: ${inlineCode(session.id)}`,
        `- Workspace: ${inlineCode(session.workspace)}`,
        `- Started: ${inlineCode(session.started_at)}`,
    ];
    const imported = session.imported_from;
    if (imported !== undefined) {
        lines.push(
            `- Imported from: ${importToolLabel(imported.tool)} session`
                + ` ${inlineCode(imported.source_session_id)}, first`
                + ` ${imported.message_count} messages`,
        );
    }
    return lines;
}

function appendMarkdownEntry(lines: string[], entry: ExportedTranscriptEntry, imported: ExportedImportProvenance | undefined): void {
    const heading = imported !== undefined
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
    } else if (entry.kind === "delivery") {
        lines.push(quoteMarkdown(entry.content));
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
        } else if (entry.presentation.kind === "checklist") {
            if (entry.presentation.title !== undefined) {
                lines.push(`**${entry.presentation.title}**`, "");
            }
            for (const item of entry.presentation.items) {
                lines.push(`- [${item.done ? "x" : " "}] ${item.text}`);
            }
        } else {
            lines.push(quoteMarkdown(entry.presentation.text));
        }
    } else {
        lines.push(quoteMarkdown(renderTranscriptText(entry)));
    }
}

function appendMarkdownFailure(lines: string[], failure: SessionExport["agent_failure"]): void {
    if (failure !== undefined) {
        lines.push(
            "",
            "## Resident agent failure",
            "",
            quoteMarkdown(failure.detail),
            "",
            `Failure ID: ${inlineCode(failure.id)}`,
            `Occurred: ${inlineCode(failure.occurred_at)}`,
        );
    }
}

type ExportedTranscriptEntry = Exclude<TranscriptEntry, { kind: "reasoning" }>;

function isExportedEntry(entry: TranscriptEntry): entry is ExportedTranscriptEntry {
    return entry.kind !== "reasoning";
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
        { kind: "user" | "assistant" | "model_substitution" | "harness" | "hook_context" }
    >,
): string {
    if (entry.kind === "hook_context") return formatHookContext(entry.phase, entry.source, entry.display);
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

function transcriptHeading(entry: ExportedTranscriptEntry): string {
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
    if (entry.kind === "harness" || entry.kind === "hook_context") {
        return "## Vera";
    }
    if (entry.kind === "presentation") {
        return "## Tool result";
    }
    if (entry.kind === "delivery") {
        return `## Message · ${escapeHeading(entry.sourceAgentId)}`;
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
