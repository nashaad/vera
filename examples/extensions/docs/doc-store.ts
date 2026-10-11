import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";

// The host's tools and the annex's page both write here, so each comment is
// its own file and every write is a rename.

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DOC_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const COMMENT_ID = /^c-[a-z0-9-]{1,64}$/;

export type CommentStatus = "open" | "closed";

export interface DocComment {
    readonly id: string;
    /** The block's markdown when the comment was left. */
    readonly quote: string;
    readonly index: number;
    readonly body: string;
    readonly createdAt: string;
    readonly status: CommentStatus;
    readonly closedAt?: string;
    readonly closedBy?: "agent" | "user";
    /** Set when the comment was also sent to the session's inbox. */
    readonly sentAt?: string;
}

export interface StoredDoc {
    readonly markdown: string;
    readonly updatedAt: string;
}

export interface DocRef {
    readonly sessionId: string;
    readonly name: string;
}

export interface DocSummary extends DocRef {
    readonly title: string;
    readonly updatedAt: string;
    readonly openComments: number;
}

export function isSessionId(value: unknown): value is string {
    return typeof value === "string" && SESSION_ID.test(value);
}

export function isCommentId(value: unknown): value is string {
    return typeof value === "string" && COMMENT_ID.test(value);
}

export function isDocName(value: unknown): value is string {
    return typeof value === "string" && DOC_NAME.test(value);
}

export function docDirectory(root: string, doc: DocRef): string {
    if (!isSessionId(doc.sessionId)) throw new Error(`Invalid session id: ${doc.sessionId}`);
    if (!isDocName(doc.name)) {
        throw new Error(`Invalid doc name "${doc.name}": use lowercase letters, digits and dashes.`);
    }
    return join(root, "docs", doc.sessionId, doc.name);
}

export function readDoc(root: string, doc: DocRef): StoredDoc | undefined {
    const path = join(docDirectory(root, doc), "doc.md");
    if (!existsSync(path)) return undefined;
    return {
        markdown: readFileSync(path, "utf8"),
        updatedAt: statSync(path).mtime.toISOString(),
    };
}

export function writeDoc(root: string, doc: DocRef, markdown: string): void {
    const directory = docDirectory(root, doc);
    mkdirSync(directory, { recursive: true });
    atomicWrite(join(directory, "doc.md"), markdown);
}

export function sessionDocNames(root: string, sessionId: string): readonly string[] {
    if (!isSessionId(sessionId)) return [];
    const directory = join(root, "docs", sessionId);
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
        .filter((name) => isDocName(name) && existsSync(join(directory, name, "doc.md")))
        .sort();
}

export function listComments(root: string, doc: DocRef): readonly DocComment[] {
    const directory = join(docDirectory(root, doc), "comments");
    if (!existsSync(directory)) return [];
    const comments: DocComment[] = [];
    for (const name of readdirSync(directory)) {
        if (!name.endsWith(".json")) continue;
        try {
            comments.push(JSON.parse(readFileSync(join(directory, name), "utf8")) as DocComment);
        } catch {
            // A half-written file from a crash; the next write replaces it.
        }
    }
    return comments.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function addComment(
    root: string,
    doc: DocRef,
    input: { readonly quote: string; readonly index: number; readonly body: string },
): DocComment {
    const now = new Date();
    const comment: DocComment = {
        id: `c-${now.getTime().toString(36)}-${crypto.randomUUID().slice(0, 8)}`,
        quote: input.quote,
        index: Math.max(0, Math.floor(input.index)),
        body: input.body,
        createdAt: now.toISOString(),
        status: "open",
    };
    saveComment(root, doc, comment);
    return comment;
}

export function setCommentStatus(
    root: string,
    doc: DocRef,
    id: string,
    status: CommentStatus,
    by: "agent" | "user",
): DocComment | undefined {
    const existing = readComment(root, doc, id);
    if (existing === undefined) return undefined;
    const { closedAt: _closedAt, closedBy: _closedBy, ...rest } = existing;
    const updated: DocComment = status === "closed"
        ? { ...rest, status, closedAt: new Date().toISOString(), closedBy: by }
        : { ...rest, status };
    saveComment(root, doc, updated);
    return updated;
}

export function markCommentSent(root: string, doc: DocRef, id: string): DocComment | undefined {
    const existing = readComment(root, doc, id);
    if (existing === undefined) return undefined;
    const updated: DocComment = { ...existing, sentAt: new Date().toISOString() };
    saveComment(root, doc, updated);
    return updated;
}

export function deleteComment(root: string, doc: DocRef, id: string): boolean {
    const path = commentPath(root, doc, id);
    if (!existsSync(path)) return false;
    rmSync(path);
    return true;
}

/** A comment is outdated once the text it was left on is gone from the doc. */
export function isOutdated(comment: DocComment, markdown: string): boolean {
    return !markdown.includes(comment.quote.trim());
}

export function listDocs(root: string): readonly DocSummary[] {
    const directory = join(root, "docs");
    if (!existsSync(directory)) return [];
    const docs: DocSummary[] = [];
    for (const sessionId of readdirSync(directory)) {
        for (const name of sessionDocNames(root, sessionId)) {
            const ref = { sessionId, name };
            const doc = readDoc(root, ref);
            if (doc === undefined) continue;
            docs.push({
                ...ref,
                title: docTitle(doc.markdown, name),
                updatedAt: doc.updatedAt,
                openComments: listComments(root, ref)
                    .filter((comment) => comment.status === "open").length,
            });
        }
    }
    return docs.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function docTitle(markdown: string, fallback: string): string {
    const heading = /^#{1,6}\s+(.+)$/m.exec(markdown);
    const line = heading?.[1] ?? markdown.split("\n").find((text) => text.trim().length > 0) ?? "";
    return line.trim().slice(0, 120) || fallback;
}

export function readComment(root: string, doc: DocRef, id: string): DocComment | undefined {
    const path = commentPath(root, doc, id);
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as DocComment;
}

function saveComment(root: string, doc: DocRef, comment: DocComment): void {
    mkdirSync(join(docDirectory(root, doc), "comments"), { recursive: true });
    atomicWrite(commentPath(root, doc, comment.id), `${JSON.stringify(comment, null, 2)}\n`);
}

function commentPath(root: string, doc: DocRef, id: string): string {
    if (!COMMENT_ID.test(id)) throw new Error(`Invalid comment id: ${id}`);
    return join(docDirectory(root, doc), "comments", `${id}.json`);
}

function atomicWrite(path: string, content: string): void {
    const temporary = `${path}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(temporary, content);
    renameSync(temporary, path);
}
