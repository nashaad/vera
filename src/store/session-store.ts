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
import {
    isModelTurnSettings,
    type ModelTurnSettings,
} from "../engine/model-settings.ts";
import { isApprovalMode, type ApprovalMode } from "../engine/permissions.ts";

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

export interface PendingDelivery {
    readonly id: string;
    readonly sourceAgentId: string;
    readonly content: string;
}

export interface SessionDeliveryEntry extends PendingDelivery {
    readonly type: "delivery";
    readonly timestamp: string;
}

export interface SessionDeliveryReceiptEntry {
    readonly type: "delivery_receipt";
    readonly deliveryId: string;
    readonly timestamp: string;
}

export interface SessionModelSettingsEntry {
    readonly type: "model_settings";
    readonly timestamp: string;
    readonly settings: ModelTurnSettings;
}

export interface SessionPermissionsEntry {
    readonly type: "permissions";
    readonly timestamp: string;
    readonly mode: ApprovalMode;
}

export type CheckpointTool = "write" | "edit";

export interface SessionCheckpointEntry {
    readonly type: "checkpoint";
    readonly timestamp: string;
    readonly checkpointId: string;
    readonly path: string;
    readonly existedBefore: boolean;
    readonly tool: CheckpointTool;
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

export interface SessionDeliveryInbox {
    pendingDeliveries(): readonly SessionDeliveryEntry[];
    acknowledgeDelivery(deliveryId: string): Promise<boolean>;
}

interface LoadedSessionFile {
    readonly header: SessionHeader;
    readonly messageEntries: SessionMessageEntry[];
    readonly deliveryEntries: SessionDeliveryEntry[];
    readonly deliveryReceipts: Set<string>;
    readonly modelSettingsEntries: SessionModelSettingsEntry[];
    readonly permissionsEntries: SessionPermissionsEntry[];
    readonly checkpointEntries: SessionCheckpointEntry[];
    readonly leafId: string | null;
}

export class SessionStore {
    readonly path: string;
    readonly header: SessionHeader;

    private readonly now: () => Date;
    private readonly createId: () => string;
    private readonly storedEntries: SessionMessageEntry[];
    private readonly deliveryEntries: SessionDeliveryEntry[];
    private readonly deliveryReceipts: Set<string>;
    private readonly modelSettingsEntries: SessionModelSettingsEntry[];
    private readonly permissionsEntries: SessionPermissionsEntry[];
    private readonly checkpointEntries: SessionCheckpointEntry[];
    private leafId: string | null;
    private pendingAppend: Promise<void> = Promise.resolve();

    private constructor(
        path: string,
        loaded: LoadedSessionFile,
        options: OpenSessionStoreOptions,
    ) {
        this.path = path;
        this.header = loaded.header;
        this.storedEntries = loaded.messageEntries;
        this.deliveryEntries = loaded.deliveryEntries;
        this.deliveryReceipts = loaded.deliveryReceipts;
        this.modelSettingsEntries = loaded.modelSettingsEntries;
        this.permissionsEntries = loaded.permissionsEntries;
        this.checkpointEntries = loaded.checkpointEntries;
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
            {
                header,
                messageEntries: [],
                deliveryEntries: [],
                deliveryReceipts: new Set(),
                modelSettingsEntries: [],
                permissionsEntries: [],
                checkpointEntries: [],
                leafId: null,
            },
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

    pendingDeliveries(): readonly SessionDeliveryEntry[] {
        return this.deliveryEntries.filter(
            (delivery) => !this.deliveryReceipts.has(delivery.id),
        );
    }

    modelSettings(): ModelTurnSettings | undefined {
        const settings = this.modelSettingsEntries.at(-1)?.settings;
        return settings === undefined ? undefined : { ...settings };
    }

    approvalMode(): ApprovalMode | undefined {
        return this.permissionsEntries.at(-1)?.mode;
    }

    checkpoints(): readonly SessionCheckpointEntry[] {
        return this.checkpointEntries.slice();
    }

    appendMessage(message: ModelMessage): Promise<SessionMessageEntry> {
        const result = this.pendingAppend.then(() => this.commitMessage(message));
        this.pendingAppend = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    appendModelSettings(
        settings: ModelTurnSettings,
    ): Promise<SessionModelSettingsEntry> {
        const result = this.pendingAppend.then(() =>
            this.commitModelSettings(settings)
        );
        this.pendingAppend = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    appendApprovalMode(mode: ApprovalMode): Promise<SessionPermissionsEntry> {
        const result = this.pendingAppend.then(() =>
            this.commitApprovalMode(mode)
        );
        this.pendingAppend = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    appendCheckpoint(
        checkpoint: Omit<SessionCheckpointEntry, "type" | "timestamp">,
    ): Promise<SessionCheckpointEntry> {
        const result = this.pendingAppend.then(() =>
            this.commitCheckpoint(checkpoint)
        );
        this.pendingAppend = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    recordDelivery(delivery: PendingDelivery): Promise<boolean> {
        const result = this.pendingAppend.then(() =>
            this.commitDelivery(delivery)
        );
        this.pendingAppend = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    acknowledgeDelivery(deliveryId: string): Promise<boolean> {
        const result = this.pendingAppend.then(() =>
            this.commitDeliveryReceipt(deliveryId)
        );
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

        await this.appendRecord(entry);

        this.storedEntries.push(entry);
        this.leafId = entry.id;
        return entry;
    }

    private async commitModelSettings(
        settings: ModelTurnSettings,
    ): Promise<SessionModelSettingsEntry> {
        if (!isModelTurnSettings(settings)) {
            throw new Error("Cannot append invalid model settings");
        }
        const entry: SessionModelSettingsEntry = {
            type: "model_settings",
            timestamp: this.now().toISOString(),
            settings: {
                model: settings.model.trim(),
                ...(settings.reasoningEffort === undefined
                    ? {}
                    : { reasoningEffort: settings.reasoningEffort }),
            },
        };
        await this.appendRecord(entry);
        this.modelSettingsEntries.push(entry);
        return entry;
    }

    private async commitApprovalMode(
        mode: ApprovalMode,
    ): Promise<SessionPermissionsEntry> {
        if (!isApprovalMode(mode)) {
            throw new Error("Cannot append invalid permissions mode");
        }
        const entry: SessionPermissionsEntry = {
            type: "permissions",
            timestamp: this.now().toISOString(),
            mode,
        };
        await this.appendRecord(entry);
        this.permissionsEntries.push(entry);
        return entry;
    }

    private async commitCheckpoint(
        checkpoint: Omit<SessionCheckpointEntry, "type" | "timestamp">,
    ): Promise<SessionCheckpointEntry> {
        const checkpointId = nonEmpty(checkpoint.checkpointId, "checkpoint ID");
        if (
            this.checkpointEntries.some(
                (entry) => entry.checkpointId === checkpointId,
            )
        ) {
            throw new Error(`Checkpoint ${checkpointId} already exists`);
        }
        const entry: SessionCheckpointEntry = {
            type: "checkpoint",
            timestamp: this.now().toISOString(),
            checkpointId,
            path: nonEmpty(checkpoint.path, "checkpoint path"),
            existedBefore: checkpoint.existedBefore,
            tool: checkpoint.tool,
        };
        await this.appendRecord(entry);
        this.checkpointEntries.push(entry);
        return entry;
    }

    private async commitDelivery(delivery: PendingDelivery): Promise<boolean> {
        const id = nonEmpty(delivery.id, "delivery ID");
        if (typeof delivery.content !== "string") {
            throw new Error("delivery content must be a string");
        }
        const sourceAgentId = nonEmpty(
            delivery.sourceAgentId,
            "delivery source agent ID",
        );
        const existing = this.deliveryEntries.find((entry) => entry.id === id);
        if (existing !== undefined) {
            if (
                existing.sourceAgentId !== sourceAgentId
                || existing.content !== delivery.content
            ) {
                throw new Error(`Delivery ${id} conflicts with its stored payload`);
            }
            return false;
        }
        const entry: SessionDeliveryEntry = {
            type: "delivery",
            id,
            sourceAgentId,
            content: delivery.content,
            timestamp: this.now().toISOString(),
        };
        await this.appendRecord(entry);
        this.deliveryEntries.push(entry);
        return true;
    }

    private async commitDeliveryReceipt(deliveryId: string): Promise<boolean> {
        const id = nonEmpty(deliveryId, "delivery ID");
        if (
            !this.deliveryEntries.some((delivery) => delivery.id === id)
            || this.deliveryReceipts.has(id)
        ) {
            return false;
        }
        const receipt: SessionDeliveryReceiptEntry = {
            type: "delivery_receipt",
            deliveryId: id,
            timestamp: this.now().toISOString(),
        };
        await this.appendRecord(receipt);
        this.deliveryReceipts.add(id);
        return true;
    }

    private async appendRecord(record: object): Promise<void> {
        const file = await open(this.path, "a", 0o600);
        try {
            await file.writeFile(jsonLine(record), "utf8");
            await file.sync();
        } finally {
            await file.close();
        }
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
    const messageEntries: SessionMessageEntry[] = [];
    const deliveryEntries: SessionDeliveryEntry[] = [];
    const deliveryReceipts = new Set<string>();
    const modelSettingsEntries: SessionModelSettingsEntry[] = [];
    const permissionsEntries: SessionPermissionsEntry[] = [];
    const checkpointEntries: SessionCheckpointEntry[] = [];
    const knownCheckpointIds = new Set<string>();
    const knownMessageIds = new Set<string>();
    const knownDeliveryIds = new Set<string>();

    for (let index = 1; index < lines.length; index += 1) {
        const lineNumber = index + 1;
        const value = parseJsonObject(path, lineNumber, lines[index]);
        if (value.type === "message") {
            const entry = parseMessageEntry(path, lineNumber, value);
            if (knownMessageIds.has(entry.id)) {
                throw invalidSession(
                    path,
                    `line ${lineNumber} repeats entry ID ${entry.id}`,
                );
            }
            if (
                entry.parentId !== null
                && !knownMessageIds.has(entry.parentId)
            ) {
                throw invalidSession(
                    path,
                    `line ${lineNumber} references missing parent ${entry.parentId}`,
                );
            }
            knownMessageIds.add(entry.id);
            messageEntries.push(entry);
            continue;
        }
        if (value.type === "delivery") {
            const entry = parseDeliveryEntry(path, lineNumber, value);
            if (knownDeliveryIds.has(entry.id)) {
                throw invalidSession(
                    path,
                    `line ${lineNumber} repeats delivery ID ${entry.id}`,
                );
            }
            knownDeliveryIds.add(entry.id);
            deliveryEntries.push(entry);
            continue;
        }
        if (value.type === "delivery_receipt") {
            const receipt = parseDeliveryReceipt(path, lineNumber, value);
            if (!knownDeliveryIds.has(receipt.deliveryId)) {
                throw invalidSession(
                    path,
                    `line ${lineNumber} references missing delivery ${receipt.deliveryId}`,
                );
            }
            if (deliveryReceipts.has(receipt.deliveryId)) {
                throw invalidSession(
                    path,
                    `line ${lineNumber} repeats delivery receipt ${receipt.deliveryId}`,
                );
            }
            deliveryReceipts.add(receipt.deliveryId);
            continue;
        }
        if (value.type === "model_settings") {
            modelSettingsEntries.push(
                parseModelSettingsEntry(path, lineNumber, value),
            );
            continue;
        }
        if (value.type === "permissions") {
            permissionsEntries.push(
                parsePermissionsEntry(path, lineNumber, value),
            );
            continue;
        }
        if (value.type === "checkpoint") {
            const entry = parseCheckpointEntry(path, lineNumber, value);
            if (knownCheckpointIds.has(entry.checkpointId)) {
                throw invalidSession(
                    path,
                    `line ${lineNumber} repeats checkpoint ${entry.checkpointId}`,
                );
            }
            knownCheckpointIds.add(entry.checkpointId);
            checkpointEntries.push(entry);
            continue;
        }
        throw invalidSession(
            path,
            `line ${lineNumber} is not a valid session entry`,
        );
    }

    return {
        header,
        messageEntries,
        deliveryEntries,
        deliveryReceipts,
        modelSettingsEntries,
        permissionsEntries,
        checkpointEntries,
        leafId: messageEntries.at(-1)?.id ?? null,
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
    value: Record<string, unknown>,
): SessionMessageEntry {
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

function parseDeliveryEntry(
    path: string,
    lineNumber: number,
    value: Record<string, unknown>,
): SessionDeliveryEntry {
    if (
        typeof value.id !== "string"
        || value.id.length === 0
        || typeof value.sourceAgentId !== "string"
        || value.sourceAgentId.length === 0
        || typeof value.content !== "string"
        || typeof value.timestamp !== "string"
    ) {
        throw invalidSession(
            path,
            `line ${lineNumber} is not a valid delivery entry`,
        );
    }
    return value as unknown as SessionDeliveryEntry;
}

function parseDeliveryReceipt(
    path: string,
    lineNumber: number,
    value: Record<string, unknown>,
): SessionDeliveryReceiptEntry {
    if (
        typeof value.deliveryId !== "string"
        || value.deliveryId.length === 0
        || typeof value.timestamp !== "string"
    ) {
        throw invalidSession(
            path,
            `line ${lineNumber} is not a valid delivery receipt`,
        );
    }
    return value as unknown as SessionDeliveryReceiptEntry;
}

function parseModelSettingsEntry(
    path: string,
    lineNumber: number,
    value: Record<string, unknown>,
): SessionModelSettingsEntry {
    if (
        typeof value.timestamp !== "string"
        || !isModelTurnSettings(value.settings)
    ) {
        throw invalidSession(
            path,
            `line ${lineNumber} is not a valid model settings entry`,
        );
    }
    const settings = value.settings;
    return {
        type: "model_settings",
        timestamp: value.timestamp,
        settings: {
            model: settings.model.trim(),
            ...(settings.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: settings.reasoningEffort }),
        },
    };
}

function parsePermissionsEntry(
    path: string,
    lineNumber: number,
    value: Record<string, unknown>,
): SessionPermissionsEntry {
    if (
        typeof value.timestamp !== "string"
        || !isApprovalMode(value.mode)
    ) {
        throw invalidSession(
            path,
            `line ${lineNumber} is not a valid permissions entry`,
        );
    }
    return {
        type: "permissions",
        timestamp: value.timestamp,
        mode: value.mode,
    };
}

function parseCheckpointEntry(
    path: string,
    lineNumber: number,
    value: Record<string, unknown>,
): SessionCheckpointEntry {
    if (
        typeof value.timestamp !== "string"
        || typeof value.checkpointId !== "string"
        || value.checkpointId.length === 0
        || typeof value.path !== "string"
        || value.path.length === 0
        || typeof value.existedBefore !== "boolean"
        || (value.tool !== "write" && value.tool !== "edit")
    ) {
        throw invalidSession(
            path,
            `line ${lineNumber} is not a valid checkpoint entry`,
        );
    }
    return {
        type: "checkpoint",
        timestamp: value.timestamp,
        checkpointId: value.checkpointId,
        path: value.path,
        existedBefore: value.existedBefore,
        tool: value.tool,
    };
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
