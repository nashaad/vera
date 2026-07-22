import { projectTranscript, type TranscriptEntry } from "./engine/protocol.ts";
import { readSessionSnapshot } from "./store/session-store.ts";

export type SessionExportFormat = "markdown" | "json";

export interface SessionExport {
    readonly format_version: 3;
    readonly session: {
        readonly id: string;
        readonly started_at: string;
        readonly workspace: string;
    };
    readonly transcript: readonly TranscriptEntry[];
    readonly agent_failure?: {
        readonly id: string;
        readonly occurred_at: string;
        readonly detail: string;
    };
}

export async function exportSession(
    sessionPath: string,
    format: SessionExportFormat = "markdown",
): Promise<string> {
    const snapshot = await readSessionSnapshot(sessionPath);
    const exported: SessionExport = {
        format_version: 3,
        session: {
            id: snapshot.header.id,
            started_at: snapshot.header.timestamp,
            workspace: snapshot.header.cwd,
        },
        transcript: projectTranscript(snapshot.messages),
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

    for (const entry of exported.transcript) {
        lines.push("", transcriptHeading(entry), "");
        if (entry.kind === "tool") {
            lines.push(indentJson(entry.args));
        } else if (entry.kind === "error") {
            lines.push(quoteMarkdown(entry.detail ?? "Model request failed"));
        } else {
            lines.push(quoteMarkdown(entry.text));
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

function transcriptHeading(entry: TranscriptEntry): string {
    return entry.kind === "user"
        ? "## You"
        : entry.kind === "assistant"
            ? "## Vera"
            : entry.kind === "error"
                ? "## Model error"
                : `## Tool · ${escapeHeading(entry.tool)}`;
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
