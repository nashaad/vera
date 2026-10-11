import type { JsonValue } from "../../src/sdk/hooks.ts";
import type {
    VeraExtensionApi,
    VeraExtensionToolRequest,
    VeraExtensionToolResult,
} from "../../src/sdk/extensions.ts";
import {
    deleteComment,
    isCommentId,
    isArtifactName,
    isOutdated,
    isSessionId,
    listComments,
    readComment,
    readArtifact,
    sessionArtifactNames,
    setCommentStatus,
    writeArtifact,
    type ArtifactRef,
} from "./artifact-store.ts";

export const ARTIFACT_TOOLS = ["artifact_read", "artifact_write", "artifact_edit", "artifact_comments"] as const;
const STORAGE_READ = "extension.storage.read";
// Writes only this extension's own storage, so ask and auto mode run it without a prompt.
const STORAGE_WRITE = "extension.storage.write";

const NAME_PROPERTY = {
    type: "string",
    description: "Short artifact name in lowercase letters, digits and dashes, such as plan or release-notes.",
};

export function activate(vera: VeraExtensionApi): void {
    const root = (): string => vera.storage.profile;
    const link = (artifact: ArtifactRef): string => {
        const url = vera.annex.pageUrl("artifacts");
        return url === undefined
            ? "The artifacts page is unavailable because the annex is not running."
            : `Artifact page: ${url}?session=${encodeURIComponent(artifact.sessionId)}&artifact=${artifact.name}`;
    };

    // The page server asks for this when the user ticks Send to Vera.
    vera.requests.handle("send-comment", async (payload: JsonValue): Promise<JsonValue> => {
        const { session, artifact, id } = (payload ?? {}) as Record<string, unknown>;
        if (!isSessionId(session) || !isArtifactName(artifact) || !isCommentId(id)) {
            throw new Error("send-comment needs a session, artifact and comment id");
        }
        const comment = readComment(root(), { sessionId: session, name: artifact }, id);
        if (comment === undefined) throw new Error(`No comment ${id}`);
        return await vera.sessions.send(session, commentMessage(artifact, comment.quote, comment.body, id));
    });

    vera.tools.register({
        name: "artifact_read",
        description:
            "Read one of this session's artifacts and how many review comments are open. Without a name, list the session's artifacts.",
        inputSchema: {
            type: "object",
            properties: { name: NAME_PROPERTY },
            additionalProperties: false,
        },
        permissionOperation: STORAGE_READ,
        run: (request) => withSession(request, (sessionId) => {
            // Some models send an empty string or null for an optional field.
            const name = request.input.name;
            if (name === undefined || name === null || name === "") {
                const names = sessionArtifactNames(root(), sessionId);
                return { output: names.length === 0 ? "No artifacts yet." : names.join("\n") };
            }
            return withArtifact(sessionId, name, (artifact) => {
                const stored = readArtifact(root(), artifact);
                if (stored === undefined) {
                    return { output: `No artifact named ${artifact.name}. Write one with artifact_write.` };
                }
                const open = listComments(root(), artifact)
                    .filter((comment) => comment.status === "open").length;
                return {
                    output: `${stored.markdown}\n\n(${open} open comment${open === 1 ? "" : "s"}; read them with artifact_comments.)`,
                };
            });
        }),
    });

    vera.tools.register({
        name: "artifact_write",
        permissionOperation: STORAGE_WRITE,
        description:
            "Create or replace one of this session's markdown artifacts. The user reads it on the artifacts page and can comment on any block. A fenced block marked `html embed` runs as a sandboxed page, for players or charts.",
        inputSchema: {
            type: "object",
            properties: {
                name: NAME_PROPERTY,
                markdown: { type: "string", description: "The whole artifact as markdown." },
            },
            required: ["name", "markdown"],
            additionalProperties: false,
        },
        run: (request) => withSession(request, (sessionId) =>
            withArtifact(sessionId, request.input.name, (artifact) => {
                const markdown = request.input.markdown;
                if (typeof markdown !== "string" || markdown.trim().length === 0) {
                    return { output: "markdown must be a non-empty string.", isError: true };
                }
                writeArtifact(root(), artifact, markdown);
                const page = link(artifact);
                // The notice shows in the transcript even when tool details are collapsed.
                return { output: `Saved ${artifact.name}. ${page}`, presentation: { kind: "tool_notice", text: page } };
            })
        ),
    });

    vera.tools.register({
        name: "artifact_edit",
        permissionOperation: STORAGE_WRITE,
        description:
            "Replace one exact passage of one of this session's artifacts. old_string must appear exactly once.",
        inputSchema: {
            type: "object",
            properties: {
                name: NAME_PROPERTY,
                old_string: { type: "string" },
                new_string: { type: "string" },
            },
            required: ["name", "old_string", "new_string"],
            additionalProperties: false,
        },
        run: (request) => withSession(request, (sessionId) =>
            withArtifact(sessionId, request.input.name, (artifact) => {
                const { old_string: oldString, new_string: newString } = request.input;
                if (typeof oldString !== "string" || oldString.length === 0 || typeof newString !== "string") {
                    return { output: "old_string must be non-empty and new_string a string.", isError: true };
                }
                const stored = readArtifact(root(), artifact);
                if (stored === undefined) {
                    return { output: `No artifact named ${artifact.name}. Write one with artifact_write.`, isError: true };
                }
                const count = stored.markdown.split(oldString).length - 1;
                if (count !== 1) {
                    return {
                        output: count === 0
                            ? `old_string is not in ${artifact.name}.`
                            : `old_string appears ${count} times; include more context.`,
                        isError: true,
                    };
                }
                writeArtifact(root(), artifact, stored.markdown.replace(oldString, () => newString));
                return { output: `Updated ${artifact.name}.` };
            })
        ),
    });

    vera.tools.register({
        name: "artifact_comments",
        permissionOperation: STORAGE_WRITE,
        description:
            "List the user's comments on one of this session's artifacts, or close or delete one by id. A comment is outdated when the text it was left on has changed.",
        inputSchema: {
            type: "object",
            properties: {
                name: NAME_PROPERTY,
                action: { type: "string", enum: ["list", "close", "delete"] },
                id: { type: "string", description: "Comment id, for close and delete." },
            },
            required: ["name", "action"],
            additionalProperties: false,
        },
        run: (request) => withSession(request, (sessionId) =>
            withArtifact(sessionId, request.input.name, (artifact) => {
                const { action, id } = request.input;
                if (action === "list") {
                    const markdown = readArtifact(root(), artifact)?.markdown ?? "";
                    const comments = listComments(root(), artifact);
                    if (comments.length === 0) return { output: "No comments." };
                    return {
                        output: comments.map((comment) => {
                            const flags = [
                                comment.status,
                                ...(isOutdated(comment, markdown) ? ["outdated"] : []),
                            ].join(", ");
                            return `${comment.id} (${flags})\n  on: ${firstLine(comment.quote)}\n  ${comment.body}`;
                        }).join("\n\n"),
                    };
                }
                if (typeof id !== "string" || id.length === 0) {
                    return { output: "id is required for close and delete.", isError: true };
                }
                if (action === "close") {
                    return setCommentStatus(root(), artifact, id, "closed", "agent") === undefined
                        ? { output: `No comment ${id}.`, isError: true }
                        : { output: `Closed ${id}.` };
                }
                if (action === "delete") {
                    return deleteComment(root(), artifact, id)
                        ? { output: `Deleted ${id}.` }
                        : { output: `No comment ${id}.`, isError: true };
                }
                return { output: "action must be list, close, or delete.", isError: true };
            })
        ),
    });
}

function withSession(
    request: VeraExtensionToolRequest,
    run: (sessionId: string) => VeraExtensionToolResult,
): VeraExtensionToolResult {
    if (request.sessionId === undefined) {
        return { output: "Artifacts need a stored session.", isError: true };
    }
    return run(request.sessionId);
}

function withArtifact(
    sessionId: string,
    name: unknown,
    run: (artifact: ArtifactRef) => VeraExtensionToolResult,
): VeraExtensionToolResult {
    if (!isArtifactName(name)) {
        return { output: "name must use lowercase letters, digits and dashes.", isError: true };
    }
    return run({ sessionId, name });
}

export function commentMessage(artifact: string, quote: string, body: string, id: string): string {
    return [
        `The user commented on artifact ${artifact}, on: ${firstLine(quote)}`,
        "",
        body,
        "",
        `Comment ${id}. Read the artifact with artifact_read, and close the comment with artifact_comments once it is handled.`,
    ].join("\n");
}

function firstLine(text: string): string {
    const line = text.trim().split("\n")[0] ?? "";
    return line.length > 100 ? `${line.slice(0, 100)}...` : line;
}
