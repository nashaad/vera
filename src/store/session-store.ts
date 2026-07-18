import { randomUUID } from "node:crypto";
import {
    chmod,
    mkdir,
    open,
    readFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ModelMessage } from "../model/types.ts";

export const SESSION_FORMAT_VERSION = 1;

export interface SessionHeader {
    readonly type: "session";
    readonly version: typeof SESSION_FORMAT_VERSION;
    readonly id: string;
    readonly timestamp: string;
    readonly cwd: string;
}

export interface SessionMessageEntry {
    readonly type: "message";
    readonly id: string;
    readonly parentId: string | null;
    readonly timestamp: string;
    readonly message: ModelMessage;
}

export interface CreateSessionStoreOptions {
    readonly sessionId: string;
    readonly cwd: string;
    readonly now?: () => Date;
    readonly createId?: () => string;
}

export interface OpenSessionStoreOptions {
    readonly now?: () => Date;
    readonly createId?: () => string;
}

export interface SessionMessageStore {
    appendMessage(message: ModelMessage): Promise<unknown>;
}

interface LoadedSessionFile {
    readonly header: SessionHeader;
    readonly entries: SessionMessageEntry[];
    readonly leafId: string | null;
}

export class SessionStore {
    readonly path: string;
    readonly header: SessionHeader;

    private readonly now: () => Date;
    private readonly createId: () => string;
    private readonly storedEntries: SessionMessageEntry[];
    private leafId: string | null;
    private pendingAppend: Promise<void> = Promise.resolve();

    private constructor(
        path: string,
        loaded: LoadedSessionFile,
        options: OpenSessionStoreOptions,
    ) {
        this.path = path;
        this.header = loaded.header;
        this.storedEntries = loaded.entries;
        this.leafId = loaded.leafId;
        this.now = options.now ?? (() => new Date());
        this.createId = options.createId ?? randomUUID;
    }

    static async create(
        path: string,
        options: CreateSessionStoreOptions,
    ): Promise<SessionStore> {
        const now = options.now ?? (() => new Date());
        const header: SessionHeader = {
            type: "session",
            version: SESSION_FORMAT_VERSION,
            id: nonEmpty(options.sessionId, "session ID"),
            timestamp: now().toISOString(),
            cwd: nonEmpty(options.cwd, "session cwd"),
        };

        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const file = await open(path, "wx", 0o600);
        try {
            await file.chmod(0o600);
            await file.writeFile(jsonLine(header), "utf8");
            await file.sync();
        } finally {
            await file.close();
        }

        return new SessionStore(
            path,
            { header, entries: [], leafId: null },
            {
                now,
                ...(options.createId === undefined
                    ? {}
                    : { createId: options.createId }),
            },
        );
    }

    static async open(
        path: string,
        options: OpenSessionStoreOptions = {},
    ): Promise<SessionStore> {
        const source = await readFile(path, "utf8");
        const completeSource = await removeUnterminatedTail(path, source);
        const loaded = parseSessionFile(path, completeSource);
        await chmod(path, 0o600);
        return new SessionStore(path, loaded, options);
    }

    entries(): readonly SessionMessageEntry[] {
        return this.storedEntries.slice();
    }

    messages(): readonly ModelMessage[] {
        const byId = new Map(this.storedEntries.map((entry) => [entry.id, entry]));
        const branch: ModelMessage[] = [];
        let currentId = this.leafId;

        while (currentId !== null) {
            const entry = byId.get(currentId);
            if (entry === undefined) {
                throw new Error(`Session entry ${currentId} is missing`);
            }
            branch.push(entry.message);
            currentId = entry.parentId;
        }

        return branch.reverse();
    }

    appendMessage(message: ModelMessage): Promise<SessionMessageEntry> {
        const result = this.pendingAppend.then(() => this.commitMessage(message));
        this.pendingAppend = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    private async commitMessage(
        message: ModelMessage,
    ): Promise<SessionMessageEntry> {
        if (!isModelMessage(message)) {
            throw new Error("Cannot append an invalid model message");
        }
        const entry: SessionMessageEntry = {
            type: "message",
            id: nonEmpty(this.createId(), "message entry ID"),
            parentId: this.leafId,
            timestamp: this.now().toISOString(),
            message,
        };
        if (this.storedEntries.some((candidate) => candidate.id === entry.id)) {
            throw new Error(`Session entry ID ${entry.id} already exists`);
        }

        const file = await open(this.path, "a", 0o600);
        try {
            await file.writeFile(jsonLine(entry), "utf8");
            await file.sync();
        } finally {
            await file.close();
        }

        this.storedEntries.push(entry);
        this.leafId = entry.id;
        return entry;
    }
}

export function defaultSessionPath(sessionId: string): string {
    return join(defaultSessionDirectory(), `${sessionId}.jsonl`);
}

export function defaultSessionDirectory(): string {
    return join(homedir(), ".vera", "sessions");
}

async function removeUnterminatedTail(
    path: string,
    source: string,
): Promise<string> {
    if (source.endsWith("\n")) {
        return source;
    }

    const finalNewline = source.lastIndexOf("\n");
    if (finalNewline < 0) {
        throw invalidSession(path, "has no complete header line");
    }
    const completeSource = source.slice(0, finalNewline + 1);
    const file = await open(path, "r+");
    try {
        await file.truncate(Buffer.byteLength(completeSource));
        await file.sync();
    } finally {
        await file.close();
    }
    return completeSource;
}

function parseSessionFile(path: string, source: string): LoadedSessionFile {
    const lines = source.slice(0, -1).split("\n");
    const header = parseHeader(path, lines[0]);
    const entries: SessionMessageEntry[] = [];
    const knownIds = new Set<string>();

    for (let index = 1; index < lines.length; index += 1) {
        const entry = parseMessageEntry(path, index + 1, lines[index]);
        if (knownIds.has(entry.id)) {
            throw invalidSession(path, `line ${index + 1} repeats entry ID ${entry.id}`);
        }
        if (entry.parentId !== null && !knownIds.has(entry.parentId)) {
            throw invalidSession(
                path,
                `line ${index + 1} references missing parent ${entry.parentId}`,
            );
        }
        knownIds.add(entry.id);
        entries.push(entry);
    }

    return {
        header,
        entries,
        leafId: entries.at(-1)?.id ?? null,
    };
}

function parseHeader(path: string, line: string | undefined): SessionHeader {
    const value = parseJsonObject(path, 1, line);
    if (
        value.type !== "session"
        || value.version !== SESSION_FORMAT_VERSION
        || typeof value.id !== "string"
        || value.id.length === 0
        || typeof value.timestamp !== "string"
        || typeof value.cwd !== "string"
        || value.cwd.length === 0
    ) {
        throw invalidSession(path, "line 1 is not a valid session header");
    }
    return value as unknown as SessionHeader;
}

function parseMessageEntry(
    path: string,
    lineNumber: number,
    line: string | undefined,
): SessionMessageEntry {
    const value = parseJsonObject(path, lineNumber, line);
    if (
        value.type !== "message"
        || typeof value.id !== "string"
        || value.id.length === 0
        || (value.parentId !== null && typeof value.parentId !== "string")
        || typeof value.timestamp !== "string"
        || !isModelMessage(value.message)
    ) {
        throw invalidSession(
            path,
            `line ${lineNumber} is not a valid message entry`,
        );
    }
    return value as unknown as SessionMessageEntry;
}

function parseJsonObject(
    path: string,
    lineNumber: number,
    line: string | undefined,
): Record<string, unknown> {
    let value: unknown;
    try {
        value = JSON.parse(line ?? "");
    } catch (cause) {
        throw invalidSession(path, `line ${lineNumber} is not valid JSON`, cause);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw invalidSession(path, `line ${lineNumber} is not a JSON object`);
    }
    return value as Record<string, unknown>;
}

function isModelMessage(value: unknown): value is ModelMessage {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const message = value as Record<string, unknown>;
    if (!Array.isArray(message.content)) {
        return false;
    }
    if (message.role === "user") {
        return (message.internal === undefined
            || typeof message.internal === "boolean")
            && message.content.every(isTextContent);
    }
    if (message.role === "tool_result") {
        return typeof message.toolCallId === "string"
            && typeof message.toolName === "string"
            && typeof message.isError === "boolean"
            && message.content.every(isTextContent);
    }
    if (message.role !== "assistant") {
        return false;
    }
    return isModelSource(message.source)
        && isModelUsage(message.usage)
        && isModelStopReason(message.stopReason)
        && (message.errorMessage === undefined
            || typeof message.errorMessage === "string")
        && message.content.every(isAssistantContent);
}

function isModelSource(value: unknown): boolean {
    if (!isRecord(value)) {
        return false;
    }
    return typeof value.provider === "string"
        && typeof value.api === "string"
        && typeof value.model === "string"
        && (value.responseModel === undefined
            || typeof value.responseModel === "string");
}

function isModelUsage(value: unknown): boolean {
    if (!isRecord(value)) {
        return false;
    }
    return typeof value.inputTokens === "number"
        && typeof value.outputTokens === "number"
        && typeof value.cachedInputTokens === "number"
        && typeof value.reasoningTokens === "number"
        && typeof value.totalTokens === "number"
        && (value.cost === undefined || typeof value.cost === "number");
}

function isModelStopReason(value: unknown): boolean {
    return value === "stop"
        || value === "length"
        || value === "tool_use"
        || value === "content_filter"
        || value === "aborted"
        || value === "error";
}

function isTextContent(value: unknown): boolean {
    return typeof value === "object"
        && value !== null
        && (value as Record<string, unknown>).type === "text"
        && typeof (value as Record<string, unknown>).text === "string";
}

function isAssistantContent(value: unknown): boolean {
    if (!isRecord(value)) {
        return false;
    }
    const content = value;
    if (content.type === "text" || content.type === "thinking") {
        return typeof content.text === "string"
            && (content.signature === undefined
                || typeof content.signature === "string");
    }
    return content.type === "tool_call"
        && typeof content.id === "string"
        && typeof content.name === "string"
        && isRecord(content.input)
        && (content.signature === undefined
            || typeof content.signature === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object"
        && value !== null
        && !Array.isArray(value);
}

function jsonLine(value: object): string {
    return `${JSON.stringify(value)}\n`;
}

function nonEmpty(value: string, name: string): string {
    if (value.length === 0) {
        throw new Error(`${name} must not be empty`);
    }
    return value;
}

function invalidSession(path: string, message: string, cause?: unknown): Error {
    return new Error(`Invalid session file ${path}: ${message}`, { cause });
}
