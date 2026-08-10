import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import {
    MEMORY_INDEX_FILENAME,
    MEMORY_INDEX_MAX_BYTES,
    MEMORY_INDEX_WARN_BYTES,
    MEMORY_TOPIC_MAX_BYTES,
    projectMemoryDir,
    userMemoryDir,
} from "./memory-paths.ts";

/** Maximum number of topic bodies admitted to one model request. */
export const MEMORY_TOPIC_MAX_COUNT = 8;
/** Maximum UTF-8 bytes of topic bodies admitted to one model request. */
export const MEMORY_TOPIC_MAX_TOTAL_BYTES = 64 * 1024;
const TOPIC_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
const INDEX_ENTRY = /^\s*-\s*\[([^\]]+)\]\(([^)]+)\)\s*:\s*(\S(?:.*\S)?)\s*$/;

/**
 * The directory a project's memory is keyed on, resolved once per agent by
 * the owner. `source` is `workspace` when the owner had no repository to
 * resolve, which is an ordinary case: a checkout is not required to run.
 */
export interface InstructionRoot {
    readonly path: string;
    readonly source: "git" | "workspace";
}

export type MemoryScope = "user" | "project";

export interface MemoryIndexFile {
    readonly scope: MemoryScope;
    readonly dir: string;
    readonly path: string;
    readonly content: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly topics: readonly MemoryTopicMetadata[];
    readonly modifiedAt: number;
}

export type MemoryTopicAvailability =
    | "available"
    | "missing"
    | "stale"
    | "invalid"
    | "unreadable"
    | "oversized"
    | "loaded";

export interface MemoryTopicMetadata {
    readonly scope: MemoryScope;
    readonly file: string;
    readonly path: string;
    readonly title?: string;
    readonly hook?: string;
    readonly availability: MemoryTopicAvailability;
    readonly bytes?: number;
}

export interface MemoryTopicBody extends MemoryTopicMetadata {
    readonly availability: "loaded";
    readonly content: string;
    readonly bytes: number;
    readonly sha256: string;
}

export interface MemoryMetadata {
    readonly files: readonly {
        readonly scope: MemoryScope;
        readonly bytes: number;
        readonly sha256: string;
        readonly topics: readonly MemoryTopicMetadata[];
    }[];
    readonly loadedTopics?: readonly {
        readonly scope: MemoryScope;
        readonly file: string;
        readonly bytes: number;
        readonly sha256: string;
    }[];
    readonly recommendations?: readonly MemoryTopicMetadata[];
    readonly warnings: readonly string[];
}

/**
 * Where each scope's index lives. Defaulted from `memory-paths`; passed
 * explicitly only by callers that must not read the real home directory.
 */
export interface MemoryDirectories {
    readonly user: string;
    readonly project: string;
}

export interface MemorySnapshot {
    readonly files: readonly MemoryIndexFile[];
    readonly loadedTopics: readonly MemoryTopicBody[];
    readonly recommendations: readonly MemoryTopicMetadata[];
    readonly warnings: readonly string[];
}

export interface LoadMemoryOptions {
    /** The current user request; omitted for delivery turns and discovery-only loads. */
    readonly query?: string;
}

/**
 * Reads the index of each scope and nothing else. Topic files are left for
 * the agent to read with the file tools when a hook in the index matches.
 */
export async function loadMemory(
    instructionRoot: InstructionRoot,
    directories: MemoryDirectories = {
        user: userMemoryDir(),
        project: projectMemoryDir(instructionRoot.path),
    },
    options: LoadMemoryOptions = {},
): Promise<MemorySnapshot> {
    const files: MemoryIndexFile[] = [];
    const warnings: string[] = [];

    const rootMissing = !await isDirectory(instructionRoot.path);
    if (rootMissing) {
        warnings.push(
            `the instruction root ${instructionRoot.path} does not exist, `
                + "so no project memory was loaded",
        );
    }

    const scopes: readonly { scope: MemoryScope; dir: string }[] = [
        { scope: "user", dir: directories.user },
        ...(rootMissing
            ? []
            : [{ scope: "project" as const, dir: directories.project }]),
    ];

    for (const { scope, dir } of scopes) {
        const loaded = await loadIndex(scope, dir, warnings);
        if (loaded !== undefined) {
            files.push(loaded);
        }
    }

    if (
        instructionRoot.source === "workspace"
        && files.some((file) => file.scope === "project")
    ) {
        warnings.push(
            `project memory is keyed on ${instructionRoot.path}, which is `
                + "not a git repository",
        );
    }

    const topics = files.flatMap((file) => file.topics);
    const recommendations = options.query === undefined
        ? []
        : matchTopics(topics, options.query);
    const loadedTopics: MemoryTopicBody[] = [];
    let admittedBytes = 0;
    for (const topic of recommendations) {
        if (loadedTopics.length >= MEMORY_TOPIC_MAX_COUNT) {
            warnings.push(
                `memory topic bound reached at ${MEMORY_TOPIC_MAX_COUNT}; `
                    + `${recommendations.length - loadedTopics.length} matching topic(s) were not read`,
            );
            break;
        }
        const loaded = await readTopic(topic, files, warnings);
        if (loaded === undefined) continue;
        if (admittedBytes + loaded.bytes > MEMORY_TOPIC_MAX_TOTAL_BYTES) {
            warnings.push(
                `memory topic byte bound reached at ${MEMORY_TOPIC_MAX_TOTAL_BYTES}; `
                    + `${topic.scope}/${topic.file} was not read`,
            );
            continue;
        }
        loadedTopics.push(loaded);
        admittedBytes += loaded.bytes;
    }

    return { files, loadedTopics, recommendations, warnings };
}

export function memoryMetadata(snapshot: MemorySnapshot): MemoryMetadata {
    return {
        files: snapshot.files.map(({ scope, bytes, sha256, topics }) => ({
            scope,
            bytes,
            sha256,
            topics,
        })),
        ...(snapshot.loadedTopics.length === 0 ? {} : {
            loadedTopics: snapshot.loadedTopics.map(({ scope, file, bytes, sha256 }) => ({
                scope,
                file,
                bytes,
                sha256,
            })),
        }),
        ...(snapshot.recommendations.length === 0 ? {} : {
            recommendations: [...snapshot.recommendations],
        }),
        warnings: [...snapshot.warnings],
    };
}

async function loadIndex(
    scope: MemoryScope,
    dir: string,
    warnings: string[],
): Promise<MemoryIndexFile | undefined> {
    const label = `the ${scope} memory index`;
    const path = join(dir, MEMORY_INDEX_FILENAME);
    let bytes: Uint8Array;
    let modifiedAt = 0;
    try {
        const details = await stat(path);
        if (!details.isFile()) {
            warnings.push(`${label} exists but is not a regular file`);
            return undefined;
        }
        if (details.size > MEMORY_INDEX_MAX_BYTES) {
            warnings.push(
                `${label} is ${details.size} bytes; the `
                    + `${MEMORY_INDEX_MAX_BYTES}-byte limit was exceeded`,
            );
            return undefined;
        }
        modifiedAt = details.mtimeMs;
        bytes = await readFile(path);
        if (bytes.byteLength > MEMORY_INDEX_MAX_BYTES) {
            warnings.push(
                `${label} grew beyond the ${MEMORY_INDEX_MAX_BYTES}-byte `
                    + "limit while it was being read",
            );
            return undefined;
        }
    } catch (error) {
        if (isMissingFile(error)) {
            return undefined;
        }
        warnings.push(`${label} could not be read: ${errorMessage(error)}`);
        return undefined;
    }

    let content: string;
    try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        warnings.push(`${label} is not valid UTF-8 and was omitted`);
        return undefined;
    }

    if (bytes.byteLength > MEMORY_INDEX_WARN_BYTES) {
        warnings.push(
            `${label} is ${bytes.byteLength} bytes; it is refused past `
                + `${MEMORY_INDEX_MAX_BYTES} bytes, so move detail into `
                + "topic files",
        );
    }

    return {
        scope,
        dir,
        path,
        content,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        topics: await parseTopics(scope, dir, content, modifiedAt, warnings),
        modifiedAt,
    };
}

async function parseTopics(
    scope: MemoryScope,
    dir: string,
    content: string,
    indexModifiedAt: number,
    warnings: string[],
): Promise<readonly MemoryTopicMetadata[]> {
    const topics: MemoryTopicMetadata[] = [];
    const seen = new Set<string>();
    for (const [lineNumber, line] of content.split(/\r?\n/).entries()) {
        if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
        const match = INDEX_ENTRY.exec(line);
        if (match === null) {
            warnings.push(`${scope} memory index line ${lineNumber + 1} is invalid and was omitted`);
            continue;
        }
        const title = match[1];
        const file = match[2];
        const hook = match[3];
        if (title === undefined || file === undefined || hook === undefined) {
            warnings.push(`${scope} memory index line ${lineNumber + 1} is invalid and was omitted`);
            continue;
        }
        const path = join(dir, file);
        if (!TOPIC_FILENAME.test(file) || file.includes("..") || basename(path) !== file) {
            topics.push({ scope, file, path, title, hook, availability: "invalid" });
            warnings.push(`${scope} memory topic ${file} is an invalid path`);
            continue;
        }
        if (seen.has(file)) {
            topics.push({ scope, file, path, title, hook, availability: "invalid" });
            warnings.push(`${scope} memory topic ${file} is duplicated in the index`);
            continue;
        }
        seen.add(file);
        topics.push({
            scope,
            file,
            path,
            title,
            hook,
            ...(await topicStat(path, indexModifiedAt)),
        });
    }
    return topics;
}

async function topicStat(
    path: string,
    indexModifiedAt: number,
): Promise<{ readonly availability: MemoryTopicAvailability; readonly bytes?: number }> {
    try {
        const details = await stat(path);
        if (!details.isFile()) return { availability: "unreadable" };
        if (details.size > MEMORY_TOPIC_MAX_BYTES) {
            return { availability: "oversized", bytes: details.size };
        }
        if (details.mtimeMs > indexModifiedAt) {
            return { availability: "stale", bytes: details.size };
        }
        return { availability: "available", bytes: details.size };
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return { availability: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable" };
    }
}

function matchTopics(
    topics: readonly MemoryTopicMetadata[],
    query: string,
): readonly MemoryTopicMetadata[] {
    const queryTokens = tokens(query);
    if (queryTokens.length === 0) return [];
    return topics
        .map((topic, index) => {
            const hookTokens = tokens(`${topic.title ?? ""} ${topic.hook ?? ""}`);
            const overlap = hookTokens.filter((token) => queryTokens.includes(token));
            const phrase = normalize(`${topic.title ?? ""} ${topic.hook ?? ""}`);
            const queryText = normalize(query);
            const relevant = phrase.length > 0 && queryText.includes(phrase)
                || hookTokens.length > 0 && hookTokens.every((token) => queryTokens.includes(token))
                || overlap.length >= Math.min(2, hookTokens.length);
            return { topic, index, score: relevant ? overlap.length : 0 };
        })
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score
            || scopeOrder(a.topic.scope) - scopeOrder(b.topic.scope)
            || a.topic.file.localeCompare(b.topic.file)
            || a.index - b.index)
        .map((entry) => entry.topic);
}

function scopeOrder(scope: MemoryScope): number {
    return scope === "user" ? 0 : 1;
}

function tokens(value: string): string[] {
    return [...new Set(normalize(value).split(/[^a-z0-9]+/).filter((token) => token.length > 2 && !STOP_WORDS.has(token)))];
}

const STOP_WORDS = new Set(["the", "and", "for", "with", "that", "this", "when", "where", "what", "how", "are", "from", "into", "your", "user", "project"]);

function normalize(value: string): string {
    return value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

async function readTopic(
    topic: MemoryTopicMetadata,
    files: readonly MemoryIndexFile[],
    warnings: string[],
): Promise<MemoryTopicBody | undefined> {
    if (topic.availability !== "available") {
        warnings.push(`memory topic ${topic.scope}/${topic.file} was not loaded: ${topic.availability}`);
        return undefined;
    }
    try {
        const details = await stat(topic.path);
        const index = files.find((file) => file.scope === topic.scope);
        if (!details.isFile()) throw new Error("unreadable");
        if (details.size > MEMORY_TOPIC_MAX_BYTES) throw new Error("oversized");
        if (index !== undefined && details.mtimeMs > index.modifiedAt) throw new Error("stale");
        const bytes = await readFile(topic.path);
        if (bytes.byteLength > MEMORY_TOPIC_MAX_BYTES) throw new Error("oversized");
        let content: string;
        try {
            content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
            warnings.push(`memory topic ${topic.scope}/${topic.file} was not loaded: invalid`);
            return undefined;
        }
        return {
            scope: topic.scope,
            file: topic.file,
            path: topic.path,
            ...(topic.title === undefined ? {} : { title: topic.title }),
            ...(topic.hook === undefined ? {} : { hook: topic.hook }),
            availability: "loaded",
            content,
            bytes: bytes.byteLength,
            sha256: createHash("sha256").update(bytes).digest("hex"),
        };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const normalized = reason === "oversized" || reason === "stale" || reason === "unreadable" ? reason : reason.includes("UTF-8") ? "invalid" : "unreadable";
        warnings.push(`memory topic ${topic.scope}/${topic.file} was not loaded: ${normalized}`);
        return undefined;
    }
}

async function isDirectory(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory();
    } catch {
        return false;
    }
}

function isMissingFile(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
