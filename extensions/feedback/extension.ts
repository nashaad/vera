import { saveFeedback, type FeedbackInput } from "../../src/feedback/store.ts";
import { selectedVeraHome } from "../../src/profile-paths.ts";
import type { VeraExtensionApi } from "../../src/sdk/extensions.ts";

export const FEEDBACK_TOOL_DESCRIPTION = "Save a bug report or feature request on this computer, with optional image files. Use when the user asks to file a report.";

export function activate(vera: VeraExtensionApi): void {
    vera.requests.handle("save", async (payload) => {
        const input = parseInput(payload);
        if (input.source !== "window" && input.source !== "terminal") throw new Error("Invalid report source.");
        return { path: await saveFeedback(selectedVeraHome(), input) };
    });
    vera.tools.register({
        name: "file_feedback",
        permissionOperation: "feedback.write",
        description: FEEDBACK_TOOL_DESCRIPTION,
        inputSchema: {
            type: "object",
            properties: {
                kind: { type: "string", enum: ["bug", "feature"] },
                title: { type: "string", maxLength: 200 },
                description: { type: "string", maxLength: 20_000 },
                image_paths: { type: "array", items: { type: "string" }, maxItems: 4 },
            },
            required: ["kind", "title", "description"],
            additionalProperties: false,
        },
        async run({ input, sessionId }) {
            try {
                const report = parseInput({ ...input, source: "chat", ...(sessionId === undefined ? {} : { session_id: sessionId }) });
                const path = await saveFeedback(selectedVeraHome(), report);
                return { output: `Report saved on this computer: ${path}` };
            } catch (error) {
                return { output: error instanceof Error ? error.message : String(error), isError: true };
            }
        },
    });
}

function parseInput(value: unknown): FeedbackInput {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid report.");
    const input = value as Record<string, unknown>;
    if (input.kind !== "bug" && input.kind !== "feature") throw new Error("Choose Bug or Feature request.");
    if (typeof input.title !== "string" || typeof input.description !== "string") throw new Error("Invalid report.");
    if (input.source !== "window" && input.source !== "terminal" && input.source !== "chat") throw new Error("Invalid report source.");
    if (input.session_id !== undefined && typeof input.session_id !== "string") throw new Error("Invalid session id.");
    if (input.image_paths !== undefined && (!Array.isArray(input.image_paths) || input.image_paths.some((item) => typeof item !== "string"))) throw new Error("Invalid image paths.");
    return {
        kind: input.kind, title: input.title, description: input.description, source: input.source,
        ...(input.session_id === undefined ? {} : { sessionId: input.session_id }),
        ...(input.image_paths === undefined ? {} : { imagePaths: input.image_paths as string[] }),
    };
}

export { activateClient } from "./client.ts";
