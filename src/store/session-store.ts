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
import type { ImageMediaType } from "../attachments/image.ts";
import {
    isModelTurnSettings,
    type ModelTurnSettings,
} from "../engine/model-settings.ts";
import {
    isApprovalMode,
    isCommandPrefix,
    type ApprovalMode,
    type CommandPrefix,
} from "../engine/permissions.ts";

export const SESSION_FORMAT_VERSION = 1;

export interface SessionHeader {
    readonly type: "session";
    readonly version: typeof SESSION_FORMAT_VERSION;
    readonly id: string;
    readonly timestamp: string;
    readonly cwd: string;
    readonly origin?: SessionOrigin;
}

export interface SessionOrigin {
    readonly sessionId: string;
    readonly entryId: string | null;
    readonly position: "before" | "at";
}

export interface SessionMessageEntry {
    readonly type: "message";
    readonly id: string;
    readonly parentId: string | null;
    readonly timestamp: string;
    readonly deliveryId?: string;
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

export interface SessionNameEntry {
    readonly type: "session_name";
    readonly timestamp: string;
    readonly name: string | null;
}

export interface SessionCommandPrefixEntry {
    readonly type: "command_prefix";
    readonly timestamp: string;
    readonly prefix: CommandPrefix;
}

export interface SessionAttachmentEntry {
    readonly type: "attachment";
    readonly timestamp: string;
    readonly attachment: SessionImageAttachmentMetadata;
}

export interface SessionAgentFailureEntry {
    readonly type: "agent_failure";
    readonly id: string;
    readonly timestamp: string;
    readonly detail: string;
}

export interface SessionImageAttachmentMetadata {
    readonly id: string;
    readonly name: string;
    readonly mediaType: ImageMediaType;
    readonly bytes: number;
    readonly width: number;
    readonly height: number;
    readonly sha256: string;
}

export interface SessionRewindEntry {
    readonly type: "rewind";
    readonly timestamp: string;
    readonly userMessageId: string;
    readonly previousHeadId: string;
    readonly headId: string | null;
}

export interface CreateSessionStoreOptions {
    readonly sessionId: string;
    readonly cwd: string;
    readonly origin?: SessionOrigin;
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

export interface ReadonlySessionSnapshot {
    readonly header: SessionHeader;
    readonly messages: readonly ModelMessage[];
    readonly agentFailure?: SessionAgentFailureEntry;
}

export interface SessionDeliveryInbox {
    pendingDeliveries(): readonly SessionDeliveryEntry[];
    appendDeliveryMessage(
        deliveryId: string,
        message: ModelMessage,
    ): Promise<SessionMessageEntry>;
}

interface LoadedSessionFile {
    readonly header: SessionHeader;
    readonly messageEntries: SessionMessageEntry[];
    readonly deliveryEntries: SessionDeliveryEntry[];
    readonly deliveryReceipts: Set<string>;
    readonly legacyDeliveryMessageIds: Map<string, string>;
    readonly modelSettingsEntries: SessionModelSettingsEntry[];
    readonly permissionsEntries: SessionPermissionsEntry[];
    readonly nameEntries: SessionNameEntry[];
    readonly commandPrefixEntries: SessionCommandPrefixEntry[];
    readonly attachmentEntries: SessionAttachmentEntry[];
    readonly agentFailure?: SessionAgentFailureEntry;
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
    private readonly legacyDeliveryMessageIds: Map<string, string>;
    private readonly modelSettingsEntries: SessionModelSettingsEntry[];
    private readonly permissionsEntries: SessionPermissionsEntry[];
    private readonly nameEntries: SessionNameEntry[];
    private readonly commandPrefixEntries: SessionCommandPrefixEntry[];
    private readonly attachmentEntries: SessionAttachmentEntry[];
    private agentFailureEntry: SessionAgentFailureEntry | undefined;
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
        this.legacyDeliveryMessageIds = loaded.legacyDeliveryMessageIds;
        this.modelSettingsEntries = loaded.modelSettingsEntries;
        this.permissionsEntries = loaded.permissionsEntries;
        this.nameEntries = loaded.nameEntries;
        this.commandPrefixEntries = loaded.commandPrefixEntries;
        this.attachmentEntries = loaded.attachmentEntries;
        this.agentFailureEntry = loaded.agentFailure;
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
            ...(options.origin === undefined
                ? {}
                : { origin: validSessionOrigin(options.origin) }),
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
                legacyDeliveryMessageIds: new Map(),
                modelSettingsEntries: [],
                permissionsEntries: [],
                nameEntries: [],
                commandPrefixEntries: [],
                attachmentEntries: [],
                agentFailure: undefined,
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

    activeEntries(): readonly SessionMessageEntry[] {
        return activeBranchEntries(this.storedEntries, this.leafId);
    }

    messages(): readonly ModelMessage[] {
        return this.activeEntries().map((entry) => entry.message);
    }

    activeHeadId(): string | null {
        return this.leafId;
    }

    pendingDeliveries(): readonly SessionDeliveryEntry[] {
        const activeEntries = this.activeEntries();
        const activeMessageIds = new Set(
            activeEntries.map((entry) => entry.id),
        );
        const deliveredOnActiveBranch = new Set(
            activeEntries.flatMap((entry) =>
                entry.deliveryId === undefined ? [] : [entry.deliveryId]
            ),
        );
        return this.deliveryEntries.filter(
            (delivery) => {
                const legacyMessageId = this.legacyDeliveryMessageIds.get(
                    delivery.id,
                );
                const legacyReceiptIsActive = this.deliveryReceipts.has(
                    delivery.id,
                ) && (
                    legacyMessageId === undefined
                    || activeMessageIds.has(legacyMessageId)
                );
                return !legacyReceiptIsActive
                    && !deliveredOnActiveBranch.has(delivery.id);
            },
        );
    }

    modelSettings(): ModelTurnSettings | undefined {
        const settings = this.modelSettingsEntries.at(-1)?.settings;
        return settings === undefined ? undefined : { ...settings };
    }

    approvalMode(): ApprovalMode | undefined {
        return this.permissionsEntries.at(-1)?.mode;
    }

    name(): string | undefined {
        return this.nameEntries.at(-1)?.name ?? undefined;
    }

    commandPrefixes(): readonly CommandPrefix[] {
        return this.commandPrefixEntries.map((entry) => ({
            tokens: [...entry.prefix.tokens],
        }));
    }

    attachmentRecords(): readonly SessionImageAttachmentMetadata[] {
        return this.attachmentEntries.map((entry) => ({ ...entry.attachment }));
    }

    agentFailure(): SessionAgentFailureEntry | undefined {
        return this.agentFailureEntry === undefined
            ? undefined
            : { ...this.agentFailureEntry };
    }

    appendMessage(message: ModelMessage): Promise<SessionMessageEntry> {
        const result = this.pendingAppend.then(() => {
            this.requireActive();
            return this.commitMessage(message);
        });
        this.pendingAppend = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    appendDeliveryMessage(
        deliveryId: string,
        message: ModelMessage,
    ): Promise<SessionMessageEntry> {
        const result = this.pendingAppend.then(() => {
            this.requireActive();
            return this.commitDeliveryMessage(deliveryId, message);
        });
        this.pendingAppend = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    appendModelSettings(
        settings: ModelTurnSettings,
    ): Promise<SessionModelSettingsEntry> {
        const result = this.pendingAppend.then(() => {
            this.requireActive();
            return this.commitModelSettings(settings);
        });
        this.pendingAppend = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    appendApprovalMode(mode: ApprovalMode): Promise<SessionPermissionsEntry> {
        const result = this.pendingAppend.then(() => {
            this.requireActive();
            return this.commitApprovalMode(mode);
        });
        this.pendingAppend = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    appendName(name: string | null): Promise<SessionNameEntry> {
        const result = this.pendingAppend.then(() => {
            this.requireActive();
            return this.commitName(name);
        });
        this.pendingAppend = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    appendCommandPrefix(
        prefix: CommandPrefix,
    ): Promise<SessionCommandPrefixEntry> {
        const result = this.pendingAppend.then(() => {
            this.requireActive();
            return this.commitCommandPrefix(prefix);
        });
        this.pendingAppend = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    appendAttachment(
        attachment: SessionImageAttachmentMetadata,
    ): Promise<SessionImageAttachmentMetadata> {
        const snapshot = copySessionImageAttachment(attachment);
        const result = this.pendingAppend.then(() => {
            this.requireActive();
            return this.commitAttachment(snapshot);
        });
        this.pendingAppend = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    appendAgentFailure(
        id: string,
        detail: string,
    ): Promise<SessionAgentFailureEntry> {
        const result = this.pendingAppend.then(() =>
            this.commitAgentFailure(id, detail)
        );
        this.pendingAppend = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    rewindBefore(userMessageId: string): Promise<SessionRewindEntry> {
        const result = this.pendingAppend.then(() => {
            this.requireActive();
            return this.commitRewind(userMessageId);
        });
        this.pendingAppend = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    recordDelivery(delivery: PendingDelivery): Promise<boolean> {
        const result = this.pendingAppend.then(() => {
            this.requireActive();
            return this.commitDelivery(delivery);
        });
        this.pendingAppend = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    private async commitMessage(
        message: ModelMessage,
        deliveryId?: string,
    ): Promise<SessionMessageEntry> {
        const snapshot = structuredClone(message);
        if (!isModelMessage(snapshot)) {
            throw new Error("Cannot append an invalid model message");
        }
        for (const attachmentId of messageAttachmentIds(snapshot)) {
            if (!this.attachmentEntries.some(
                (entry) => entry.attachment.id === attachmentId
            )) {
                throw new Error(
                    `Image attachment ${attachmentId} is not in this session`,
                );
            }
        }
        const entry: SessionMessageEntry = {
            type: "message",
            id: nonEmpty(this.createId(), "message entry ID"),
            parentId: this.leafId,
            timestamp: this.now().toISOString(),
            ...(deliveryId === undefined ? {} : { deliveryId }),
            message: snapshot,
        };
        if (this.storedEntries.some((candidate) => candidate.id === entry.id)) {
            throw new Error(`Session entry ID ${entry.id} already exists`);
        }

        await this.appendRecord(entry);

        this.storedEntries.push(entry);
        this.leafId = entry.id;
        return entry;
    }

    private async commitDeliveryMessage(
        requestedDeliveryId: string,
        message: ModelMessage,
    ): Promise<SessionMessageEntry> {
        const deliveryId = nonEmpty(requestedDeliveryId, "delivery ID");
        if (
            message.role !== "user"
            || message.internal !== true
        ) {
            throw new Error("A delivery message must be an internal user message");
        }
        if (
            !this.pendingDeliveries().some(
                (delivery) => delivery.id === deliveryId,
            )
        ) {
            throw new Error(`Delivery ${deliveryId} is not pending`);
        }
        return this.commitMessage(message, deliveryId);
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

    private async commitName(
        requestedName: string | null,
    ): Promise<SessionNameEntry> {
        const name = requestedName === null
            ? null
            : validSessionName(requestedName);
        const entry: SessionNameEntry = {
            type: "session_name",
            timestamp: this.now().toISOString(),
            name,
        };
        await this.appendRecord(entry);
        this.nameEntries.push(entry);
        return entry;
    }

    private async commitCommandPrefix(
        prefix: CommandPrefix,
    ): Promise<SessionCommandPrefixEntry> {
        if (!isCommandPrefix(prefix)) {
            throw new Error("Cannot append an invalid command prefix");
        }
        const entry: SessionCommandPrefixEntry = {
            type: "command_prefix",
            timestamp: this.now().toISOString(),
            prefix: { tokens: [...prefix.tokens] },
        };
        await this.appendRecord(entry);
        this.commandPrefixEntries.push(entry);
        return entry;
    }

    private async commitAttachment(
        attachment: SessionImageAttachmentMetadata,
    ): Promise<SessionImageAttachmentMetadata> {
        const stored = attachment;
        const existing = this.attachmentEntries.find(
            (entry) => entry.attachment.id === stored.id,
        );
        if (existing !== undefined) {
            if (!sameAttachmentContent(existing.attachment, stored)) {
                throw new Error(`Attachment ${stored.id} conflicts with stored metadata`);
            }
            return { ...existing.attachment };
        }
        const entry: SessionAttachmentEntry = {
            type: "attachment",
            timestamp: this.now().toISOString(),
            attachment: stored,
        };
        try {
            await this.appendRecord(entry);
        } catch (error) {
            const durable = await readDurableAttachment(this.path, stored.id);
            if (
                durable === undefined
                || !sameAttachmentContent(durable, stored)
            ) {
                throw error;
            }
            this.attachmentEntries.push({
                ...entry,
                attachment: durable,
            });
            return { ...durable };
        }
        this.attachmentEntries.push(entry);
        return { ...stored };
    }

    private async commitAgentFailure(
        requestedId: string,
        requestedDetail: string,
    ): Promise<SessionAgentFailureEntry> {
        const id = nonEmpty(requestedId, "agent failure ID");
        const detail = nonEmpty(requestedDetail, "agent failure detail");
        const existing = this.agentFailureEntry;
        if (existing !== undefined) {
            if (existing.id !== id || existing.detail !== detail) {
                throw new Error("Session already has a different agent failure");
            }
            return { ...existing };
        }
        const entry: SessionAgentFailureEntry = {
            type: "agent_failure",
            id,
            timestamp: this.now().toISOString(),
            detail,
        };
        await this.appendRecord(entry);
        this.agentFailureEntry = entry;
        return { ...entry };
    }

    private async commitRewind(
        requestedUserMessageId: string,
    ): Promise<SessionRewindEntry> {
        const userMessageId = nonEmpty(
            requestedUserMessageId,
            "rewind user-message ID",
        );
        const boundary = this.activeEntries().find(
            (entry) => entry.id === userMessageId,
        );
        if (
            boundary === undefined
            || boundary.message.role !== "user"
            || boundary.message.internal === true
        ) {
            throw new Error(
                `Rewind boundary ${userMessageId} is not an active user message`,
            );
        }
        if (this.leafId === null) {
            throw new Error("Cannot rewind an empty session");
        }
        const entry: SessionRewindEntry = {
            type: "rewind",
            timestamp: this.now().toISOString(),
            userMessageId,
            previousHeadId: this.leafId,
            headId: boundary.parentId,
        };
        await this.appendRecord(entry);
        this.leafId = entry.headId;
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

    private async appendRecord(record: object): Promise<void> {
        if (this.agentFailureEntry !== undefined) {
            throw new Error("Cannot append after the terminal agent failure");
        }
        const file = await open(this.path, "a", 0o600);
        try {
            await file.writeFile(jsonLine(record), "utf8");
            await file.sync();
        } finally {
            await file.close();
        }
    }

    private requireActive(): void {
        if (this.agentFailureEntry !== undefined) {
            throw new Error("Cannot append after the terminal agent failure");
        }
    }
}

async function readDurableAttachment(
    path: string,
    id: string,
): Promise<SessionImageAttachmentMetadata | undefined> {
    try {
        const source = await readFile(path, "utf8");
        const complete = completeSessionSource(path, source);
        return parseSessionFile(path, complete).attachmentEntries.find(
            (entry) => entry.attachment.id === id,
        )?.attachment;
    } catch {
        return undefined;
    }
}

export function defaultSessionPath(sessionId: string): string {
    return join(defaultSessionDirectory(), `${sessionId}.jsonl`);
}

export function defaultSessionDirectory(): string {
    return join(homedir(), ".vera", "sessions");
}

export async function readSessionSnapshot(
    path: string,
): Promise<ReadonlySessionSnapshot> {
    const source = await readFile(path, "utf8");
    const loaded = parseSessionFile(path, completeSessionSource(path, source));
    return {
        header: loaded.header,
        messages: activeBranchEntries(
            loaded.messageEntries,
            loaded.leafId,
        ).map((entry) => entry.message),
        ...(loaded.agentFailure === undefined
            ? {}
            : { agentFailure: { ...loaded.agentFailure } }),
    };
}

async function removeUnterminatedTail(
    path: string,
    source: string,
): Promise<string> {
    const completeSource = completeSessionSource(path, source);
    if (completeSource === source) {
        return source;
    }
    const file = await open(path, "r+");
    try {
        await file.truncate(Buffer.byteLength(completeSource));
        await file.sync();
    } finally {
        await file.close();
    }
    return completeSource;
}

function completeSessionSource(path: string, source: string): string {
    if (source.endsWith("\n")) {
        return source;
    }

    const finalNewline = source.lastIndexOf("\n");
    if (finalNewline < 0) {
        throw invalidSession(path, "has no complete header line");
    }
    return source.slice(0, finalNewline + 1);
}

function parseSessionFile(path: string, source: string): LoadedSessionFile {
    const lines = source.slice(0, -1).split("\n");
    const header = parseHeader(path, lines[0]);
    const messageEntries: SessionMessageEntry[] = [];
    const deliveryEntries: SessionDeliveryEntry[] = [];
    const deliveryReceipts = new Set<string>();
    const legacyDeliveryMessageIds = new Map<string, string>();
    const modelSettingsEntries: SessionModelSettingsEntry[] = [];
    const permissionsEntries: SessionPermissionsEntry[] = [];
    const nameEntries: SessionNameEntry[] = [];
    const commandPrefixEntries: SessionCommandPrefixEntry[] = [];
    const attachmentEntries: SessionAttachmentEntry[] = [];
    let agentFailure: SessionAgentFailureEntry | undefined;
    const knownMessageIds = new Set<string>();
    const knownDeliveryIds = new Set<string>();
    const knownAttachmentIds = new Set<string>();
    let leafId: string | null = null;

    for (let index = 1; index < lines.length; index += 1) {
        const lineNumber = index + 1;
        const value = parseJsonObject(path, lineNumber, lines[index]);
        if (agentFailure !== undefined) {
            if (value.type === "agent_failure") {
                const duplicate = parseAgentFailureEntry(
                    path,
                    lineNumber,
                    value,
                );
                if (
                    duplicate.id === agentFailure.id
                    && duplicate.detail === agentFailure.detail
                ) {
                    continue;
                }
            }
            throw invalidSession(
                path,
                `line ${lineNumber} follows the terminal agent failure`,
            );
        }
        if (value.type === "message") {
            const entry = parseMessageEntry(path, lineNumber, value);
            for (const attachmentId of messageAttachmentIds(entry.message)) {
                if (!knownAttachmentIds.has(attachmentId)) {
                    throw invalidSession(
                        path,
                        `line ${lineNumber} references missing attachment ${attachmentId}`,
                    );
                }
            }
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
            if (entry.parentId !== leafId) {
                throw invalidSession(
                    path,
                    `line ${lineNumber} does not extend the active head`,
                );
            }
            if (entry.deliveryId !== undefined) {
                if (!knownDeliveryIds.has(entry.deliveryId)) {
                    throw invalidSession(
                        path,
                        `line ${lineNumber} references missing delivery ${entry.deliveryId}`,
                    );
                }
                if (
                    entry.message.role !== "user"
                    || entry.message.internal !== true
                ) {
                    throw invalidSession(
                        path,
                        `line ${lineNumber} has a non-internal delivery message`,
                    );
                }
                if (
                    activeBranchEntries(messageEntries, leafId).some(
                        (candidate) =>
                            candidate.deliveryId === entry.deliveryId,
                    )
                ) {
                    throw invalidSession(
                        path,
                        `line ${lineNumber} repeats active delivery ${entry.deliveryId}`,
                    );
                }
            }
            knownMessageIds.add(entry.id);
            messageEntries.push(entry);
            leafId = entry.id;
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
            const activeHead = leafId === null
                ? undefined
                : messageEntries.find((entry) => entry.id === leafId);
            if (
                activeHead !== undefined
                && activeHead.deliveryId === undefined
                && activeHead.message.role === "user"
                && activeHead.message.internal === true
            ) {
                legacyDeliveryMessageIds.set(
                    receipt.deliveryId,
                    activeHead.id,
                );
            }
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
        if (value.type === "session_name") {
            nameEntries.push(
                parseSessionNameEntry(path, lineNumber, value),
            );
            continue;
        }
        if (value.type === "command_prefix") {
            commandPrefixEntries.push(
                parseCommandPrefixEntry(path, lineNumber, value),
            );
            continue;
        }
        if (value.type === "attachment") {
            const entry = parseAttachmentEntry(path, lineNumber, value);
            if (knownAttachmentIds.has(entry.attachment.id)) {
                const existing = attachmentEntries.find(
                    (candidate) => candidate.attachment.id === entry.attachment.id,
                );
                if (
                    existing !== undefined
                    && sameAttachmentContent(existing.attachment, entry.attachment)
                ) {
                    continue;
                }
                throw invalidSession(
                    path,
                    `line ${lineNumber} repeats attachment ID ${entry.attachment.id}`,
                );
            }
            knownAttachmentIds.add(entry.attachment.id);
            attachmentEntries.push(entry);
            continue;
        }
        if (value.type === "agent_failure") {
            agentFailure = parseAgentFailureEntry(path, lineNumber, value);
            continue;
        }
        if (value.type === "rewind") {
            const rewind = parseRewindEntry(path, lineNumber, value);
            if (rewind.previousHeadId !== leafId) {
                throw invalidSession(
                    path,
                    `line ${lineNumber} rewinds from inactive head ${rewind.previousHeadId}`,
                );
            }
            const boundary: SessionMessageEntry | undefined =
                activeBranchEntries(messageEntries, leafId).find(
                    (entry) => entry.id === rewind.userMessageId,
                );
            if (
                boundary === undefined
                || boundary.message.role !== "user"
                || boundary.message.internal === true
            ) {
                throw invalidSession(
                    path,
                    `line ${lineNumber} does not reference an active user message ${rewind.userMessageId}`,
                );
            }
            if (rewind.headId !== boundary.parentId) {
                throw invalidSession(
                    path,
                    `line ${lineNumber} has the wrong rewind target`,
                );
            }
            leafId = rewind.headId;
            continue;
        }
        if (value.type === "checkpoint") {
            parseRemovedFileCheckpointEntry(path, lineNumber, value);
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
        legacyDeliveryMessageIds,
        modelSettingsEntries,
        permissionsEntries,
        nameEntries,
        commandPrefixEntries,
        attachmentEntries,
        agentFailure,
        leafId,
    };
}

function parseAgentFailureEntry(
    path: string,
    lineNumber: number,
    value: Record<string, unknown>,
): SessionAgentFailureEntry {
    if (
        typeof value.id !== "string"
        || value.id.length === 0
        || typeof value.timestamp !== "string"
        || Number.isNaN(Date.parse(value.timestamp))
        || typeof value.detail !== "string"
        || value.detail.trim().length === 0
    ) {
        throw invalidSession(
            path,
            `line ${lineNumber} is not a valid agent failure entry`,
        );
    }
    return {
        type: "agent_failure",
        id: value.id,
        timestamp: value.timestamp,
        detail: value.detail,
    };
}

function parseAttachmentEntry(
    path: string,
    lineNumber: number,
    value: Record<string, unknown>,
): SessionAttachmentEntry {
    if (typeof value.timestamp !== "string") {
        throw invalidSession(
            path,
            `line ${lineNumber} is not a valid attachment entry`,
        );
    }
    try {
        return {
            type: "attachment",
            timestamp: value.timestamp,
            attachment: copySessionImageAttachment(
                value.attachment as SessionImageAttachmentMetadata,
            ),
        };
    } catch (cause) {
        throw invalidSession(
            path,
            `line ${lineNumber} is not a valid attachment entry`,
            cause,
        );
    }
}

function copySessionImageAttachment(
    value: SessionImageAttachmentMetadata,
): SessionImageAttachmentMetadata {
    if (!isRecord(value)) throw new Error("Invalid attachment metadata");
    const attachment = {
        id: value.id,
        name: value.name,
        mediaType: value.mediaType,
        bytes: value.bytes,
        width: value.width,
        height: value.height,
        sha256: value.sha256,
    };
    const extension = attachment.mediaType === "image/png" ? "png"
        : attachment.mediaType === "image/jpeg" ? "jpg"
        : attachment.mediaType === "image/gif" ? "gif"
        : attachment.mediaType === "image/webp" ? "webp"
        : undefined;
    if (
        extension === undefined
        || !isSha256(attachment.sha256)
        || attachment.id !== `${attachment.sha256}.${extension}`
        || typeof attachment.name !== "string"
        || attachment.name.length === 0
        || attachment.name.trim() !== attachment.name
        || attachment.name.includes("\0")
        || attachment.name.includes("/")
        || attachment.name.includes("\\")
        || Buffer.byteLength(attachment.name, "utf8") > 255
        || !Number.isSafeInteger(attachment.bytes)
        || attachment.bytes <= 0
        || !Number.isSafeInteger(attachment.width)
        || attachment.width <= 0
        || !Number.isSafeInteger(attachment.height)
        || attachment.height <= 0
    ) {
        throw new Error("Invalid attachment metadata");
    }
    return attachment;
}

function sameAttachmentContent(
    left: SessionImageAttachmentMetadata,
    right: SessionImageAttachmentMetadata,
): boolean {
    return left.id === right.id
        && left.mediaType === right.mediaType
        && left.bytes === right.bytes
        && left.width === right.width
        && left.height === right.height
        && left.sha256 === right.sha256;
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
        || (value.origin !== undefined && !isSessionOrigin(value.origin))
    ) {
        throw invalidSession(path, "line 1 is not a valid session header");
    }
    return value as unknown as SessionHeader;
}

function validSessionOrigin(origin: SessionOrigin): SessionOrigin {
    if (!isSessionOrigin(origin)) {
        throw new Error("Cannot create a session with invalid origin");
    }
    return {
        sessionId: origin.sessionId,
        entryId: origin.entryId,
        position: origin.position,
    };
}

function isSessionOrigin(value: unknown): value is SessionOrigin {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const origin = value as Record<string, unknown>;
    return typeof origin.sessionId === "string"
        && origin.sessionId.length > 0
        && (
            origin.entryId === null
            || (
                typeof origin.entryId === "string"
                && origin.entryId.length > 0
            )
        )
        && (origin.position === "before" || origin.position === "at");
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
        || (
            value.deliveryId !== undefined
            && (
                typeof value.deliveryId !== "string"
                || value.deliveryId.length === 0
            )
        )
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

function parseSessionNameEntry(
    path: string,
    lineNumber: number,
    value: Record<string, unknown>,
): SessionNameEntry {
    if (
        typeof value.timestamp !== "string"
        || (
            value.name !== null
            && (
                typeof value.name !== "string"
                || !isValidSessionName(value.name)
            )
        )
    ) {
        throw invalidSession(
            path,
            `line ${lineNumber} is not a valid session name entry`,
        );
    }
    return {
        type: "session_name",
        timestamp: value.timestamp,
        name: value.name,
    };
}

function parseCommandPrefixEntry(
    path: string,
    lineNumber: number,
    value: Record<string, unknown>,
): SessionCommandPrefixEntry {
    if (
        typeof value.timestamp !== "string"
        || !isCommandPrefix(value.prefix)
    ) {
        throw invalidSession(
            path,
            `line ${lineNumber} is not a valid command prefix entry`,
        );
    }
    return {
        type: "command_prefix",
        timestamp: value.timestamp,
        prefix: { tokens: [...value.prefix.tokens] },
    };
}

function parseRewindEntry(
    path: string,
    lineNumber: number,
    value: Record<string, unknown>,
): SessionRewindEntry {
    if (
        typeof value.timestamp !== "string"
        || typeof value.userMessageId !== "string"
        || value.userMessageId.length === 0
        || typeof value.previousHeadId !== "string"
        || value.previousHeadId.length === 0
        || (value.headId !== null && typeof value.headId !== "string")
    ) {
        throw invalidSession(
            path,
            `line ${lineNumber} is not a valid rewind entry`,
        );
    }
    return {
        type: "rewind",
        timestamp: value.timestamp,
        userMessageId: value.userMessageId,
        previousHeadId: value.previousHeadId,
        headId: value.headId,
    };
}

function activeBranchEntries(
    entries: readonly SessionMessageEntry[],
    leafId: string | null,
): readonly SessionMessageEntry[] {
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const branch: SessionMessageEntry[] = [];
    let currentId = leafId;
    while (currentId !== null) {
        const entry = byId.get(currentId);
        if (entry === undefined) {
            throw new Error(`Session entry ${currentId} is missing`);
        }
        branch.push(entry);
        currentId = entry.parentId;
    }
    return branch.reverse();
}

/**
 * File checkpoints were briefly written by Vera 2 before file undo was
 * removed. Validate and ignore those records so the surrounding conversation
 * remains readable without retaining any checkpoint behavior or API.
 */
function parseRemovedFileCheckpointEntry(
    path: string,
    lineNumber: number,
    value: Record<string, unknown>,
): void {
    const hasBoundaryMetadata = value.userMessageId !== undefined
        || value.beforeSha256 !== undefined
        || value.afterSha256 !== undefined;
    if (
        typeof value.timestamp !== "string"
        || typeof value.checkpointId !== "string"
        || value.checkpointId.length === 0
        || typeof value.path !== "string"
        || value.path.length === 0
        || typeof value.existedBefore !== "boolean"
        || (value.tool !== "write" && value.tool !== "edit")
        || (hasBoundaryMetadata && (
            typeof value.userMessageId !== "string"
            || value.userMessageId.length === 0
            || (value.existedBefore
                ? !isSha256(value.beforeSha256)
                : value.beforeSha256 !== null)
            || !isSha256(value.afterSha256)
        ))
    ) {
        throw invalidSession(
            path,
            `line ${lineNumber} is not a valid removed checkpoint entry`,
        );
    }
}

function isSha256(value: unknown): value is string {
    return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
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
            && message.content.every((content) =>
                isTextContent(content) || isImageAttachmentContent(content)
            );
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

function isImageAttachmentContent(value: unknown): boolean {
    return isRecord(value)
        && value.type === "image_attachment"
        && typeof value.attachmentId === "string"
        && value.attachmentId.length > 0;
}

function messageAttachmentIds(message: ModelMessage): readonly string[] {
    return message.role === "user"
        ? message.content.flatMap((content) =>
            content.type === "image_attachment" ? [content.attachmentId] : []
        )
        : [];
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

function validSessionName(value: string): string {
    const name = value.trim();
    if (!isValidSessionName(name)) {
        throw new Error("Session name must be 1 to 200 UTF-8 bytes");
    }
    return name;
}

function isValidSessionName(value: string): boolean {
    return value.length > 0
        && value === value.trim()
        && !value.includes("\0")
        && Buffer.byteLength(value, "utf8") <= 200;
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
