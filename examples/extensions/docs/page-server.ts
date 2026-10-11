import { userInfo } from "node:os";

import type { VeraAnnexPageApi, VeraMarkdownBlock } from "../../../src/sdk/annex-pages.ts";
import {
    addComment,
    deleteComment,
    docTitle,
    isDocName,
    isOutdated,
    isSessionId,
    listComments,
    listDocs,
    markCommentSent,
    readDoc,
    setCommentStatus,
    type DocComment,
    type DocRef,
} from "./doc-store.ts";

const MAX_COMMENT_LENGTH = 4000;

export interface PlacedComment extends DocComment {
    readonly outdated: boolean;
    readonly blockIndex: number;
}

export function activatePage(page: VeraAnnexPageApi): void {
    const root = (): string => page.storage.profile;
    const viewer = viewerName();

    page.route("docs", () => json({ docs: listDocs(root()) }));

    page.route("doc", (_request, url) => {
        const ref = docRef(url.searchParams.get("session"), url.searchParams.get("doc"));
        if (ref === undefined) return json({ error: "unknown doc" }, 400);
        const doc = readDoc(root(), ref);
        const blocks = doc === undefined ? [] : page.markdownBlocks(doc.markdown);
        const comments = placeComments(listComments(root(), ref), doc?.markdown ?? "", blocks);
        const state = {
            ...ref,
            title: doc === undefined ? ref.name : docTitle(doc.markdown, ref.name),
            viewer,
            exists: doc !== undefined,
            updatedAt: doc?.updatedAt,
            blocks,
            comments,
        };
        return json({ ...state, version: String(Bun.hash(JSON.stringify(state))) });
    });

    page.route("comments", async (request) => {
        if (request.method !== "POST") return json({ error: "use POST" }, 405);
        const body = await request.json() as Record<string, unknown>;
        const { session, doc, quote, index, text, send } = body;
        const ref = docRef(session, doc);
        if (
            ref === undefined
            || typeof quote !== "string"
            || typeof index !== "number"
            || typeof text !== "string"
            || text.trim().length === 0
            || text.length > MAX_COMMENT_LENGTH
            || (send !== undefined && typeof send !== "boolean")
        ) {
            return json({ error: "invalid comment" }, 400);
        }
        const comment = addComment(root(), ref, { quote, index, body: text.trim() });
        if (send !== true) return json({ comment });
        const sent = await sendComment(page, ref, comment.id);
        const stored = sent === "queued" ? markCommentSent(root(), ref, comment.id) : undefined;
        return json({ comment: stored ?? comment, sent });
    });

    page.route("comment", async (request) => {
        if (request.method !== "POST") return json({ error: "use POST" }, 405);
        const body = await request.json() as Record<string, unknown>;
        const { session, doc, id, action } = body;
        const ref = docRef(session, doc);
        if (ref === undefined || typeof id !== "string") {
            return json({ error: "invalid request" }, 400);
        }
        if (action === "delete") {
            return deleteComment(root(), ref, id) ? json({ ok: true }) : json({ error: "not found" }, 404);
        }
        if (action === "close" || action === "reopen") {
            const updated = setCommentStatus(root(), ref, id, action === "close" ? "closed" : "open", "user");
            return updated === undefined ? json({ error: "not found" }, 404) : json({ comment: updated });
        }
        return json({ error: "unknown action" }, 400);
    });
}

export type SendResult = "queued" | "not_found" | "failed";

// The comment is saved either way; only the inbox copy can fail.
async function sendComment(page: VeraAnnexPageApi, ref: DocRef, id: string): Promise<SendResult> {
    try {
        const outcome = await page.host.request("send-comment", { session: ref.sessionId, doc: ref.name, id });
        return outcome === "queued" || outcome === "not_found" ? outcome : "failed";
    } catch {
        return "failed";
    }
}

// A live comment sits under the block it quotes, picking the match nearest
// where it was left. An outdated one keeps its old position.
export function placeComments(
    comments: readonly DocComment[],
    markdown: string,
    blocks: readonly VeraMarkdownBlock[],
): readonly PlacedComment[] {
    const last = Math.max(0, blocks.length - 1);
    return comments.map((comment) => {
        const outdated = isOutdated(comment, markdown);
        const quote = comment.quote.trim();
        const exact = nearest(blocks, comment.index, (block) => block.text === quote);
        const containing = exact ?? nearest(blocks, comment.index, (block) => block.text.includes(quote));
        const blockIndex = outdated || containing === undefined
            ? Math.min(comment.index, last)
            : containing;
        return { ...comment, outdated, blockIndex };
    });
}

function nearest(
    blocks: readonly VeraMarkdownBlock[],
    target: number,
    matches: (block: VeraMarkdownBlock) => boolean,
): number | undefined {
    let best: number | undefined;
    blocks.forEach((block, index) => {
        if (!matches(block)) return;
        if (best === undefined || Math.abs(index - target) < Math.abs(best - target)) {
            best = index;
        }
    });
    return best;
}

function viewerName(): string {
    try {
        return userInfo().username || "You";
    } catch {
        return "You";
    }
}

function docRef(session: unknown, doc: unknown): DocRef | undefined {
    return isSessionId(session) && isDocName(doc) ? { sessionId: session, name: doc } : undefined;
}

function json(body: unknown, status = 200): Response {
    return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
