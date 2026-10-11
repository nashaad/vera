import type { JsonValue } from "../../../src/sdk/hooks.ts";
import type {
    VeraExtensionApi,
    VeraExtensionToolRequest,
    VeraExtensionToolResult,
} from "../../../src/sdk/extensions.ts";
import {
    deleteComment,
    isCommentId,
    isDocName,
    isOutdated,
    isSessionId,
    listComments,
    readComment,
    readDoc,
    sessionDocNames,
    setCommentStatus,
    writeDoc,
    type DocRef,
} from "./doc-store.ts";

export const DOC_TOOLS = ["doc_read", "doc_write", "doc_edit", "doc_comments"] as const;
// Writes only this extension's own storage, so ask and auto mode run it without a prompt.
const STORAGE_WRITE = "extension.storage.write";

const NAME_PROPERTY = {
    type: "string",
    description: "Short doc name in lowercase letters, digits and dashes, such as plan or release-notes.",
};

export function activate(vera: VeraExtensionApi): void {
    const root = (): string => vera.storage.profile;
    const link = (doc: DocRef): string => {
        const url = vera.annex.pageUrl("docs");
        return url === undefined
            ? "The docs page is unavailable because the annex is not running."
            : `Doc page: ${url}?session=${encodeURIComponent(doc.sessionId)}&doc=${doc.name}`;
    };

    // The page server asks for this when the user ticks Send to Vera.
    vera.requests.handle("send-comment", async (payload: JsonValue): Promise<JsonValue> => {
        const { session, doc, id } = (payload ?? {}) as Record<string, unknown>;
        if (!isSessionId(session) || !isDocName(doc) || !isCommentId(id)) {
            throw new Error("send-comment needs a session, doc and comment id");
        }
        const comment = readComment(root(), { sessionId: session, name: doc }, id);
        if (comment === undefined) throw new Error(`No comment ${id}`);
        return await vera.sessions.send(session, commentMessage(doc, comment.quote, comment.body, id));
    });

    vera.tools.register({
        name: "doc_read",
        description:
            "Read one of this session's docs and how many review comments are open. Without a name, list the session's docs.",
        inputSchema: {
            type: "object",
            properties: { name: NAME_PROPERTY },
            additionalProperties: false,
        },
        run: (request) => withSession(request, (sessionId) => {
            if (request.input.name === undefined) {
                const names = sessionDocNames(root(), sessionId);
                return { output: names.length === 0 ? "No docs yet." : names.join("\n") };
            }
            return withDoc(sessionId, request.input.name, (doc) => {
                const stored = readDoc(root(), doc);
                if (stored === undefined) {
                    return { output: `No doc named ${doc.name}. Write one with doc_write.` };
                }
                const open = listComments(root(), doc)
                    .filter((comment) => comment.status === "open").length;
                return {
                    output: `${stored.markdown}\n\n(${open} open comment${open === 1 ? "" : "s"}; read them with doc_comments.)`,
                };
            });
        }),
    });

    vera.tools.register({
        name: "doc_write",
        permissionOperation: STORAGE_WRITE,
        description:
            "Create or replace one of this session's markdown docs. The user reads it on the docs page and can comment on any block. A fenced block marked `html embed` runs as a sandboxed page, for players or charts.",
        inputSchema: {
            type: "object",
            properties: {
                name: NAME_PROPERTY,
                markdown: { type: "string", description: "The whole doc as markdown." },
            },
            required: ["name", "markdown"],
            additionalProperties: false,
        },
        run: (request) => withSession(request, (sessionId) =>
            withDoc(sessionId, request.input.name, (doc) => {
                const markdown = request.input.markdown;
                if (typeof markdown !== "string" || markdown.trim().length === 0) {
                    return { output: "markdown must be a non-empty string.", isError: true };
                }
                writeDoc(root(), doc, markdown);
                const page = link(doc);
                // The notice shows in the transcript even when tool details are collapsed.
                return { output: `Saved ${doc.name}. ${page}`, presentation: { kind: "tool_notice", text: page } };
            })
        ),
    });

    vera.tools.register({
        name: "doc_edit",
        permissionOperation: STORAGE_WRITE,
        description:
            "Replace one exact passage of one of this session's docs. old_string must appear exactly once.",
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
            withDoc(sessionId, request.input.name, (doc) => {
                const { old_string: oldString, new_string: newString } = request.input;
                if (typeof oldString !== "string" || oldString.length === 0 || typeof newString !== "string") {
                    return { output: "old_string must be non-empty and new_string a string.", isError: true };
                }
                const stored = readDoc(root(), doc);
                if (stored === undefined) {
                    return { output: `No doc named ${doc.name}. Write one with doc_write.`, isError: true };
                }
                const count = stored.markdown.split(oldString).length - 1;
                if (count !== 1) {
                    return {
                        output: count === 0
                            ? `old_string is not in ${doc.name}.`
                            : `old_string appears ${count} times; include more context.`,
                        isError: true,
                    };
                }
                writeDoc(root(), doc, stored.markdown.replace(oldString, () => newString));
                return { output: `Updated ${doc.name}.` };
            })
        ),
    });

    vera.tools.register({
        name: "doc_comments",
        permissionOperation: STORAGE_WRITE,
        description:
            "List the user's comments on one of this session's docs, or close or delete one by id. A comment is outdated when the text it was left on has changed.",
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
            withDoc(sessionId, request.input.name, (doc) => {
                const { action, id } = request.input;
                if (action === "list") {
                    const markdown = readDoc(root(), doc)?.markdown ?? "";
                    const comments = listComments(root(), doc);
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
                    return setCommentStatus(root(), doc, id, "closed", "agent") === undefined
                        ? { output: `No comment ${id}.`, isError: true }
                        : { output: `Closed ${id}.` };
                }
                if (action === "delete") {
                    return deleteComment(root(), doc, id)
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
        return { output: "Docs need a stored session.", isError: true };
    }
    return run(request.sessionId);
}

function withDoc(
    sessionId: string,
    name: unknown,
    run: (doc: DocRef) => VeraExtensionToolResult,
): VeraExtensionToolResult {
    if (!isDocName(name)) {
        return { output: "name must use lowercase letters, digits and dashes.", isError: true };
    }
    return run({ sessionId, name });
}

export function commentMessage(doc: string, quote: string, body: string, id: string): string {
    return [
        `The user commented on doc ${doc}, on: ${firstLine(quote)}`,
        "",
        body,
        "",
        `Comment ${id}. Read the doc with doc_read, and close the comment with doc_comments once it is handled.`,
    ].join("\n");
}

function firstLine(text: string): string {
    const line = text.trim().split("\n")[0] ?? "";
    return line.length > 100 ? `${line.slice(0, 100)}...` : line;
}
