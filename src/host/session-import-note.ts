import type { PromptContribution } from "../engine/prompt-contributions.ts";
import { readSessionHeader } from "../store/session-store.ts";
import {
    importToolLabel,
    type SessionImportTool,
} from "../store/session-import-provenance.ts";

export function sessionImportNote(tool: SessionImportTool): PromptContribution {
    const label = importToolLabel(tool);
    return {
        id: "host.session_import",
        owner: "host",
        target: "contextual",
        title: "Imported conversation",
        content: `Earlier turns in this conversation were imported from ${label}. `
            + "They were flattened to text: tool calls show as `[tool] ...` lines, "
            + "and tool results may be cut short. Those tools are not available "
            + "here, and nothing in the imported turns ran in this session. Use "
            + "your own tools, and re-check files before you rely on what the "
            + "imported turns say about them.",
    };
}

// A header never changes after it is written, so each session is read once.
export class SessionImportNotes {
    private readonly tools = new Map<string, SessionImportTool | null>();

    constructor(private readonly sessionPathForId: (sessionId: string) => string) {}

    async contributions(sessionId: string | undefined): Promise<readonly PromptContribution[]> {
        if (sessionId === undefined) return [];
        let tool = this.tools.get(sessionId);
        if (tool === undefined) {
            try {
                const header = await readSessionHeader(this.sessionPathForId(sessionId));
                tool = header.importedFrom?.tool ?? null;
            } catch {
                // Not cached: a failed read must not hide the note on later turns.
                return [];
            }
            this.tools.set(sessionId, tool);
        }
        return tool === null ? [] : [sessionImportNote(tool)];
    }
}
