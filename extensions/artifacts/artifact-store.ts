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
const ARTIFACT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const COMMENT_ID = /^c-[a-z0-9-]{1,64}$/;

export type CommentStatus = "open" | "closed";

export interface ArtifactComment {
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

export interface StoredArtifact {
    readonly markdown: string;
    readonly updatedAt: string;
}

export interface ArtifactRef {
    readonly sessionId: string;
    readonly name: string;
}

export interface ArtifactSummary extends ArtifactRef {
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

export function isArtifactName(value: unknown): value is string {
    return typeof value === "string" && ARTIFACT_NAME.test(value);
}

export function artifactDirectory(root: string, artifact: ArtifactRef): string {
    if (!isSessionId(artifact.sessionId)) throw new Error(`Invalid session id: ${artifact.sessionId}`);
    if (!isArtifactName(artifact.name)) {
        throw new Error(`Invalid artifact name "${artifact.name}": use lowercase letters, digits and dashes.`);
    }
    return join(root, "artifacts", artifact.sessionId, artifact.name);
}

export function readArtifact(root: string, artifact: ArtifactRef): StoredArtifact | undefined {
    const path = join(artifactDirectory(root, artifact), "artifact.md");
    if (!existsSync(path)) return undefined;
    return {
        markdown: readFileSync(path, "utf8"),
        updatedAt: statSync(path).mtime.toISOString(),
    };
}

export function writeArtifact(root: string, artifact: ArtifactRef, markdown: string): void {
    const directory = artifactDirectory(root, artifact);
    mkdirSync(directory, { recursive: true });
    atomicWrite(join(directory, "artifact.md"), markdown);
}

export function sessionArtifactNames(root: string, sessionId: string): readonly string[] {
    if (!isSessionId(sessionId)) return [];
    const directory = join(root, "artifacts", sessionId);
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
        .filter((name) => isArtifactName(name) && existsSync(join(directory, name, "artifact.md")))
        .sort();
}

export function listComments(root: string, artifact: ArtifactRef): readonly ArtifactComment[] {
    const directory = join(artifactDirectory(root, artifact), "comments");
    if (!existsSync(directory)) return [];
    const comments: ArtifactComment[] = [];
    for (const name of readdirSync(directory)) {
        if (!name.endsWith(".json")) continue;
        try {
            comments.push(JSON.parse(readFileSync(join(directory, name), "utf8")) as ArtifactComment);
        } catch {
            // A half-written file from a crash; the next write replaces it.
        }
    }
    return comments.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function addComment(
    root: string,
    artifact: ArtifactRef,
    input: { readonly quote: string; readonly index: number; readonly body: string },
): ArtifactComment {
    const now = new Date();
    const comment: ArtifactComment = {
        id: `c-${now.getTime().toString(36)}-${crypto.randomUUID().slice(0, 8)}`,
        quote: input.quote,
        index: Math.max(0, Math.floor(input.index)),
        body: input.body,
        createdAt: now.toISOString(),
        status: "open",
    };
    saveComment(root, artifact, comment);
    return comment;
}

export function setCommentStatus(
    root: string,
    artifact: ArtifactRef,
    id: string,
    status: CommentStatus,
    by: "agent" | "user",
): ArtifactComment | undefined {
    const existing = readComment(root, artifact, id);
    if (existing === undefined) return undefined;
    const { closedAt: _closedAt, closedBy: _closedBy, ...rest } = existing;
    const updated: ArtifactComment = status === "closed"
        ? { ...rest, status, closedAt: new Date().toISOString(), closedBy: by }
        : { ...rest, status };
    saveComment(root, artifact, updated);
    return updated;
}

export function markCommentSent(root: string, artifact: ArtifactRef, id: string): ArtifactComment | undefined {
    const existing = readComment(root, artifact, id);
    if (existing === undefined) return undefined;
    const updated: ArtifactComment = { ...existing, sentAt: new Date().toISOString() };
    saveComment(root, artifact, updated);
    return updated;
}

export function deleteComment(root: string, artifact: ArtifactRef, id: string): boolean {
    const path = commentPath(root, artifact, id);
    if (!existsSync(path)) return false;
    rmSync(path);
    return true;
}

/** A comment is outdated once the text it was left on is gone from the artifact. */
export function isOutdated(comment: ArtifactComment, markdown: string): boolean {
    return !markdown.includes(comment.quote.trim());
}

export function listArtifacts(root: string): readonly ArtifactSummary[] {
    const directory = join(root, "artifacts");
    if (!existsSync(directory)) return [];
    const artifacts: ArtifactSummary[] = [];
    for (const sessionId of readdirSync(directory)) {
        for (const name of sessionArtifactNames(root, sessionId)) {
            const ref = { sessionId, name };
            const artifact = readArtifact(root, ref);
            if (artifact === undefined) continue;
            artifacts.push({
                ...ref,
                title: artifactTitle(artifact.markdown, name),
                updatedAt: artifact.updatedAt,
                openComments: listComments(root, ref)
                    .filter((comment) => comment.status === "open").length,
            });
        }
    }
    return artifacts.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function artifactTitle(markdown: string, fallback: string): string {
    const heading = /^#{1,6}\s+(.+)$/m.exec(markdown);
    const line = heading?.[1] ?? markdown.split("\n").find((text) => text.trim().length > 0) ?? "";
    return line.trim().slice(0, 120) || fallback;
}

export function readComment(root: string, artifact: ArtifactRef, id: string): ArtifactComment | undefined {
    const path = commentPath(root, artifact, id);
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as ArtifactComment;
}

function saveComment(root: string, artifact: ArtifactRef, comment: ArtifactComment): void {
    mkdirSync(join(artifactDirectory(root, artifact), "comments"), { recursive: true });
    atomicWrite(commentPath(root, artifact, comment.id), `${JSON.stringify(comment, null, 2)}\n`);
}

function commentPath(root: string, artifact: ArtifactRef, id: string): string {
    if (!COMMENT_ID.test(id)) throw new Error(`Invalid comment id: ${id}`);
    return join(artifactDirectory(root, artifact), "comments", `${id}.json`);
}

function atomicWrite(path: string, content: string): void {
    const temporary = `${path}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(temporary, content);
    renameSync(temporary, path);
}
