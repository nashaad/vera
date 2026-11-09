import {
    emptyUsage,
    isClassifierOutcome,
    isHookDisplay,
    isToolPresentation,
    isTurnTiming,
} from "../model/types.ts";
import { randomUUID } from "node:crypto";
import {
    chmod,
    mkdir,
    open,
    readFile,
    rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import type { AgentSnapshot } from "../agents/snapshot.ts";
import type { AssistantMessage, ModelMessage, ModelUsage } from "../model/types.ts";
import { assertToolCallsPaired } from "../model/tool-pairing.ts";
import {
    assembleAgedToolResults,
    type ToolResultAgingPolicy,
    type ToolResultHistoryEntry,
} from "../engine/tool-result-history.ts";
import type { ImageMediaType } from "../attachments/image.ts";
import {
    isModelTurnSettings,
    type ModelTurnSettings,
} from "../engine/model-settings.ts";
import { isLegacyUnscopedGrant, migratePermissionGrant } from "../engine/permission-compat.ts";
import {
    isApprovalMode,
    isPermissionGrant,
    isPermissionGrantProposal,
    parseApprovalMode,
    type ApprovalMode,
    type PermissionGrant,
    type PermissionGrantProposal,
} from "../engine/permissions.ts";
import {
    isContextAssemblyMode,
    type ContextAssemblyMode,
} from "../startup-profile.ts";
import {
    selectedVeraHome,
    veraRuntimeDirectoryIn,
} from "../profile-paths.ts";
import {
    isContextMeasurement,
    type ContextMeasurement,
    type ContextProjectionComponent,
} from "../engine/context-measurement.ts";
import {
    aggregateContextMeasurement,
    applyContextMeasurementRecipe,
    compactContextMeasurement,
    CONTEXT_MEASUREMENT_KEYFRAME_INTERVAL,
    contextMeasurementDelta,
    contextMeasurementKeyframe,
    isContextMeasurementRecipe,
    replaceContextMeasurementDelta,
    type ContextMeasurementRecipe,
} from "./context-measurement-record.ts";
import {
    isSessionImportProvenance,
    type SessionImportProvenance,
} from "./session-import-provenance.ts";

export const SESSION_FORMAT_VERSION = 1;

export const CRASHED_TOOL_RESULT = "The host stopped before this tool call finished, "
    + "so its result was not recorded and its effect is unknown. "
    + "Check the workspace before relying on it or running it again.";
export const CRASH_CUT_MESSAGE = "Vera crashed before this turn finished.";
export const WORKER_EXIT_TURN_MESSAGE = "This turn stopped because its session process exited. Send it again to retry.";
export const CRASH_QUEUED_PROMPT_MESSAGE = "Vera crashed before sending the queued prompt.";
export const CRASH_QUEUED_PROMPTS_MESSAGE = "Vera crashed before sending the queued prompts.";

export interface SessionHeader {
    readonly type: "session";
    readonly version: typeof SESSION_FORMAT_VERSION;
    readonly id: string;
    readonly timestamp: string;
    readonly cwd: string;
    readonly origin?: SessionOrigin;
    readonly parentId?: string;
    readonly delegation?: SessionDelegation;
    readonly contextAssemblyMode?: Exclude<ContextAssemblyMode, "default">;
    readonly importedFrom?: SessionImportProvenance;
}

export function sessionIsSubagent(header: SessionHeader): boolean {
    return header.parentId !== undefined || header.delegation !== undefined;
}

export interface SessionDelegation {
    readonly kind: "subagent";
    readonly parentId: string;
    readonly models: readonly ModelTurnSettings[];
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
    readonly queuedPromptId?: string;
    readonly unsentPrompts?: readonly UnsentPrompt[];
    readonly message: ModelMessage;
}

export interface SessionTurnStartEntry extends Omit<SessionMessageEntry, "type"> {
    readonly type: "turn_start";
}

export interface UnsentPrompt {
    readonly content: string;
    readonly attachmentIds?: readonly string[];
}

export interface SessionQueuedPromptEntry extends UnsentPrompt {
    readonly type: "queued_prompt";
    readonly id: string;
    readonly timestamp: string;
}

export interface PendingDelivery {
    readonly id: string;
    readonly sourceAgentId: string;
    readonly content: string;
    readonly kind?: "attention" | "completion" | "peer";
    /** Set when an extension sent it, so a client shows its text without agent wording. */
    readonly sourceKind?: "extension";
    readonly peer?: PeerDeliveryFacts;
}

// Set on a peer message delivered whole; older peer deliveries are only a notice and lack it.
export interface PeerDeliveryFacts {
    readonly fromLabel: string;
    readonly messageId: number;
    readonly replyTo?: number;
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

export type SessionSettingOrigin = "agent-default" | "user";

export interface SessionModelSettingsEntry {
    readonly type: "model_settings";
    readonly timestamp: string;
    readonly settings: ModelTurnSettings;
    readonly origin?: SessionSettingOrigin;
}

export interface SessionSelectedAgentEntry {
    readonly type: "agent_select";
    readonly timestamp: string;
    readonly name: string;
    readonly snapshot: AgentSnapshot;
}

export interface SessionPermissionsEntry {
    readonly type: "permissions";
    readonly timestamp: string;
    readonly mode: ApprovalMode;
    readonly origin?: SessionSettingOrigin;
}

export interface SessionHarnessMessageEntry {
    readonly type: "harness_message";
    readonly timestamp: string;
    readonly afterMessageId: string | null;
    readonly text: string;
    readonly tone: "primary" | "soft" | "error";
    readonly crashCut?: true;
    readonly unsentPrompts?: readonly UnsentPrompt[];
}

interface CommitHarnessMessageOptions {
    readonly crashCut?: true;
    readonly unsentPrompts?: readonly UnsentPrompt[];
    readonly afterMessageId?: string | null;
}

export interface SessionNameEntry {
    readonly type: "session_name";
    readonly timestamp: string;
    readonly name: string | null;
}

export interface SessionIdentityEntry {
    readonly type: "session_identity";
    readonly timestamp: string;
    readonly name: string;
    readonly key: string;
}

export interface SessionPermissionGrantsEntry {
    readonly type: "permission_grants";
    readonly id: string;
    readonly timestamp: string;
    readonly grants: readonly PermissionGrant[];
}

export interface SessionPermissionGrantRevocationEntry {
    readonly type: "permission_grant_revocation";
    readonly timestamp: string;
    readonly ids: readonly string[];
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
    readonly source?: string;
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

export interface SessionCompactionEntry {
    readonly type: "compaction";
    readonly id: string;
    readonly timestamp: string;
    readonly boundaryMessageId: string;
    readonly firstRetainedMessageId: string | null;
    readonly projection: readonly ModelMessage[];
    readonly measured: SessionCompactionMeasurement;
    readonly diagnostics?: SessionCompactionDiagnostics;
    readonly billed?: SessionCompactionBilled;
}

/** Billing for a side question asked of this session; nothing the model sees. */
export interface SessionAskEntry {
    readonly type: "session_ask";
    readonly id: string;
    readonly timestamp: string;
    readonly billed: SessionCompactionBilled;
}

export interface SessionCompactionMeasurement {
    readonly inputTokens: number;
    readonly contextWindow?: number;
    readonly model?: string;
    readonly estimated: boolean;
}

export interface SessionCompactionDiagnostics {
    readonly strategy: string;
    readonly route?: string;
    readonly catalogEntry?: string;
    readonly provider?: string;
    readonly model?: string;
}

export interface SessionContextMeasurementEntry {
    readonly type: "context_measurement";
    readonly timestamp: string;
    readonly afterMessageId: string | null;
    readonly measurement: ContextMeasurement;
    /** Present when the components are held as a delta against the previous retained entry. */
    readonly retainedRecipe?: ContextMeasurementRecipe;
}

export interface SessionCompactionBilled {
    readonly provider: string;
    readonly model: string;
    readonly usage: ModelUsage;
}

export interface AppendCompactionRequest {
    readonly boundaryMessageId: string;
    readonly firstRetainedMessageId: string | null;
    readonly projection: readonly ModelMessage[];
    readonly measured: SessionCompactionMeasurement;
    readonly diagnostics?: SessionCompactionDiagnostics;
    readonly billed?: SessionCompactionBilled;
}

/** The part of a file handle that appending a record uses. */
export interface SessionAppendFile {
    stat(): Promise<{ readonly size: number }>;
    writeFile(data: string, encoding: "utf8"): Promise<void>;
    truncate(length: number): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
}

export type OpenSessionAppendFile = (path: string) => Promise<SessionAppendFile>;

export interface CreateSessionStoreOptions {
    readonly sessionId: string;
    readonly cwd: string;
    readonly origin?: SessionOrigin;
    readonly parentId?: string;
    readonly delegation?: SessionDelegation;
    readonly contextAssemblyMode?: Exclude<ContextAssemblyMode, "default">;
    readonly importedFrom?: SessionImportProvenance;
    readonly now?: () => Date;
    readonly createId?: () => string;
    readonly openAppendFile?: OpenSessionAppendFile;
    readonly onRecordAppended?: (
        lineNumber: number,
        record: Record<string, unknown>,
    ) => void;
}

export interface SessionCreationMetadata {
    readonly contextAssemblyMode?: Exclude<ContextAssemblyMode, "default">;
    readonly parentId?: string;
    readonly delegation?: SessionDelegation;
}

export interface OpenSessionStoreOptions {
    readonly now?: () => Date;
    readonly createId?: () => string;
    readonly openAppendFile?: OpenSessionAppendFile;
    readonly onRecordAppended?: (
        lineNumber: number,
        record: Record<string, unknown>,
    ) => void;
}

export interface StoredMessage {
    readonly id: string;
    readonly message: ModelMessage;
}

export interface SessionMessageOptions {
    readonly turnStart?: true;
    readonly queuedPromptId?: string;
}

export interface SessionMessageStore {
    appendMessage(message: ModelMessage, options?: SessionMessageOptions): Promise<StoredMessage>;
    removeQueuedPrompt?(id: string): Promise<void>;
}

/** The stored record a message came from: its ID and when it was written, in epoch ms. */
export interface MessageStamp {
    readonly id: string;
    readonly recordedAt: number;
}

export interface SessionPageSource {
    readonly messages: readonly ModelMessage[];
    readonly messageStamps: ReadonlyMap<ModelMessage, MessageStamp>;
    readonly deliveredMessages: ReadonlyMap<ModelMessage, SessionDeliveryEntry>;
    readonly harnessMessages: readonly {
        readonly afterMessage: number;
        readonly text: string;
        readonly tone: "primary" | "soft" | "error";
    }[];
    readonly attachmentName: (id: string) => string | undefined;
    readonly headId?: string;
}

export interface ReadonlySessionSnapshot {
    readonly header: SessionHeader;
    readonly messages: readonly ModelMessage[];
    readonly messageStamps: ReadonlyMap<ModelMessage, MessageStamp>;
    readonly deliveredMessages: ReadonlyMap<ModelMessage, SessionDeliveryEntry>;
    readonly harnessMessages: readonly {
        readonly afterMessage: number;
        readonly text: string;
        readonly tone: "primary" | "soft" | "error";
    }[];
    readonly agentFailure?: SessionAgentFailureEntry;
}

export interface SessionDeliveryInbox {
    pendingDeliveries(): readonly SessionDeliveryEntry[];
    appendDeliveryMessage(
        deliveryId: string,
        message: ModelMessage,
        options?: { readonly turnStart?: true },
    ): Promise<SessionMessageEntry>;
}

interface ParsedSessionFile {
    readonly header: SessionHeader;
    readonly state: SessionProjectionState;
    readonly lineCount: number;
}

export class SessionStore {
    readonly path: string;
    readonly header: SessionHeader;

    private readonly now: () => Date;
    private readonly createId: () => string;
    private readonly openAppendFile: OpenSessionAppendFile;
    private writeFault: Error | undefined;
    private pendingAppend: Promise<void> = Promise.resolve();
    private lineCount: number;
    private onRecordAppended?: (
        lineNumber: number,
        record: Record<string, unknown>,
    ) => void;

    protected readonly projection: SessionProjectionState;

    protected constructor(
        path: string,
        header: SessionHeader,
        state: SessionProjectionState,
        options: OpenSessionStoreOptions,
        lineCount = 1,
    ) {
        this.path = path;
        this.header = header;
        this.projection = state;
        this.now = options.now ?? (() => new Date());
        this.createId = options.createId ?? randomUUID;
        this.openAppendFile = options.openAppendFile
            ?? ((appendPath) => open(appendPath, "a", 0o600));
        this.lineCount = lineCount;
        if (options.onRecordAppended !== undefined) {
            this.onRecordAppended = options.onRecordAppended;
        }
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
            ...(options.parentId === undefined
                ? {}
                : { parentId: nonEmpty(options.parentId, "session parent ID") }),
            ...(options.delegation === undefined
                ? {}
                : { delegation: validSessionDelegation(options.delegation) }),
            ...(options.contextAssemblyMode === undefined
                ? {}
                : { contextAssemblyMode: options.contextAssemblyMode }),
            ...(options.importedFrom === undefined
                ? {}
                : { importedFrom: options.importedFrom }),
        };

        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        let created = false;
        try {
            const file = await open(path, "wx", 0o600);
            created = true;
            try {
                await file.chmod(0o600);
                await file.writeFile(jsonLine(header), "utf8");
                await file.sync();
            } finally {
                await file.close();
            }
        } catch (error) {
            if (created) {
                await rm(path, { force: true }).catch(() => {});
            }
            throw error;
        }

        return new SessionStore(
            path,
            header,
            createSessionProjectionState(),
            {
                now,
                ...(options.createId === undefined
                    ? {}
                    : { createId: options.createId }),
                ...(options.openAppendFile === undefined
                    ? {}
                    : { openAppendFile: options.openAppendFile }),
                ...(options.onRecordAppended === undefined
                    ? {}
                    : { onRecordAppended: options.onRecordAppended }),
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
        return new SessionStore(
            path,
            loaded.header,
            loaded.state,
            options,
            loaded.lineCount,
        );
    }

    entries(): readonly SessionMessageEntry[] {
        return this.projection.messageEntries.slice();
    }

    activeEntries(): readonly SessionMessageEntry[] {
        return activeBranchEntries(this.projection.messageEntries, this.projection.leafId);
    }

    messages(): readonly ModelMessage[] {
        return this.activeEntries().map((entry) => entry.message);
    }

    queuedPrompts(): readonly SessionQueuedPromptEntry[] {
        return [...this.projection.queuedPrompts.values()].map((entry) => structuredClone(entry));
    }

    unsentPrompts(): readonly UnsentPrompt[] {
        return structuredClone(this.projection.unsentPrompts);
    }

    usageMessages(): readonly AssistantMessage[] {
        const replies = this.projection.messageEntries.map((entry) => entry.message)
            .filter((message): message is AssistantMessage => message.role === "assistant" && message.source.api !== "none");
        const compactions = this.projection.compactionEntries.flatMap((entry): AssistantMessage[] =>
            entry.billed === undefined ? [] : [{
                role: "assistant", content: [], stopReason: "stop",
                source: { provider: entry.billed.provider, model: entry.billed.model, api: "compaction" },
                usage: entry.billed.usage,
            }]);
        const asks = this.projection.askEntries.map((entry): AssistantMessage => ({
            role: "assistant", content: [], stopReason: "stop",
            source: { provider: entry.billed.provider, model: entry.billed.model, api: "ask" },
            usage: entry.billed.usage,
        }));
        return [...replies, ...compactions, ...asks];
    }

    /** The ancestor chain ending at `messageId`, for a page request outside the active branch. */
    pageSourceTo(messageId: string): SessionPageSource | undefined {
        const byId = new Map(
            this.projection.messageEntries.map((entry) => [entry.id, entry]),
        );
        const target = byId.get(messageId);
        if (target === undefined) {
            return undefined;
        }
        const chain: SessionMessageEntry[] = [];
        const seen = new Set<string>();
        let current: SessionMessageEntry | undefined = target;
        while (current !== undefined) {
            if (seen.has(current.id)) {
                return undefined;
            }
            seen.add(current.id);
            chain.push(current);
            if (current.parentId === null) {
                current = undefined;
            } else {
                current = byId.get(current.parentId);
                if (current === undefined) {
                    return undefined;
                }
            }
        }
        chain.reverse();
        const attachmentNames = new Map(
            this.projection.attachmentEntries.map((entry) => [
                entry.attachment.id,
                entry.attachment.name,
            ]),
        );
        return {
            messages: chain.map((entry) => entry.message),
            messageStamps: messageStamps(chain),
            deliveredMessages: deliveredMessages(
                chain,
                this.projection.deliveryEntries,
            ),
            harnessMessages: projectHarnessMessages(
                this.projection.harnessMessageEntries,
                chain,
            ),
            attachmentName: (id) => attachmentNames.get(id),
            ...(this.projection.leafId === null
                ? {}
                : { headId: this.projection.leafId }),
        };
    }

    activeMessageStamps(): ReadonlyMap<ModelMessage, MessageStamp> {
        return messageStamps(this.activeEntries());
    }

    deliveredMessages(): ReadonlyMap<ModelMessage, SessionDeliveryEntry> {
        return deliveredMessages(this.activeEntries(), this.projection.deliveryEntries);
    }

    activeHeadId(): string | null {
        return this.projection.leafId;
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
        return this.projection.deliveryEntries.filter(
            (delivery) => {
                const legacyMessageId = this.projection.legacyDeliveryMessageIds.get(
                    delivery.id,
                );
                const legacyReceiptIsActive = this.projection.deliveryReceipts.has(
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

    hasUnansweredDeliveryTurn(): boolean {
        return hasOpenDeliveryTurn(this.activeEntries(), this.projection.harnessMessageEntries);
    }

    modelSettings(): ModelTurnSettings | undefined {
        const settings = this.projection.modelSettingsEntries.at(-1)?.settings;
        return settings === undefined ? undefined : { ...settings };
    }

    modelSettingsOrigin(): SessionSettingOrigin | undefined {
        const entry = this.projection.modelSettingsEntries.at(-1);
        return entry === undefined ? undefined : entry.origin ?? "user";
    }

    modelSettingsHistory(): readonly SessionModelSettingsEntry[] {
        return this.projection.modelSettingsEntries.map((entry) => ({
            ...entry,
            settings: { ...entry.settings },
            origin: entry.origin ?? "user",
        }));
    }

    selectedAgent(): SessionSelectedAgentEntry | undefined {
        const entry = this.projection.selectedAgentEntries.at(-1);
        return entry === undefined ? undefined : structuredClone(entry);
    }

    appendSelectedAgent(
        name: string,
        snapshot: AgentSnapshot,
    ): Promise<SessionSelectedAgentEntry> {
        const result = this.pendingAppend.then(() => {
            this.requireActive();
            return this.commitSelectedAgent(name, snapshot);
        });
        this.pendingAppend = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    private async commitSelectedAgent(
        name: string,
        snapshot: AgentSnapshot,
    ): Promise<SessionSelectedAgentEntry> {
        if (name.length === 0 || snapshot.name !== name) {
            throw new Error("Cannot append an agent selection with a mismatched name");
        }
        const entry: SessionSelectedAgentEntry = {
            type: "agent_select",
            timestamp: this.now().toISOString(),
            name,
            snapshot: structuredClone(snapshot),
        };
        await this.appendRecord(entry);
        this.projection.selectedAgentEntries.push(entry);
        return entry;
    }

    approvalMode(): ApprovalMode | undefined {
        return this.projection.permissionsEntries.at(-1)?.mode;
    }

    approvalModeOrigin(): SessionSettingOrigin | undefined {
        const entry = this.projection.permissionsEntries.at(-1);
        return entry === undefined ? undefined : entry.origin ?? "user";
    }

    name(): string | undefined {
        return this.projection.nameEntries.at(-1)?.name ?? undefined;
    }

    identity(): SessionIdentityEntry | undefined {
        const entry = this.projection.identityEntries[0];
        return entry === undefined ? undefined : { ...entry };
    }

    permissionGrants(): readonly PermissionGrant[] {
        const revoked = new Set(
            this.projection.permissionGrantRevocationEntries.flatMap((entry) => entry.ids),
        );
        return this.projection.permissionGrantEntries.flatMap((entry) =>
            entry.grants
                .filter((grant) => !revoked.has(grant.id))
                .map(copyPermissionGrant)
        );
    }

    attachmentRecords(): readonly SessionImageAttachmentMetadata[] {
        return this.projection.attachmentEntries.map((entry) => ({ ...entry.attachment }));
    }

    agentFailure(): SessionAgentFailureEntry | undefined {
        return this.projection.agentFailure === undefined
            ? undefined
            : { ...this.projection.agentFailure };
    }

    appendMessage(message: ModelMessage, options?: SessionMessageOptions): Promise<SessionMessageEntry> {
        const result = this.pendingAppend.then(() => {
            this.requireActive();
            return this.commitMessage(message, undefined, options?.turnStart, options?.queuedPromptId);
        });
        this.pendingAppend = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    appendQueuedPrompt(id: string, prompt: UnsentPrompt): Promise<void> {
        const result = this.pendingAppend.then(async () => {
            this.requireActive();
            const snapshot = structuredClone(prompt);
            if (!isUnsentPrompt(snapshot)) throw new Error("Cannot append an invalid queued prompt");
            const entry: SessionQueuedPromptEntry = {
                type: "queued_prompt",
                id: nonEmpty(id, "queued prompt ID"),
                timestamp: this.now().toISOString(),
                content: snapshot.content,
                ...(snapshot.attachmentIds === undefined ? {} : { attachmentIds: snapshot.attachmentIds }),
            };
            if (this.projection.knownQueuedPromptIds.has(entry.id)) {
                throw new Error("Cannot append an invalid or duplicate queued prompt");
            }
            for (const attachmentId of entry.attachmentIds ?? []) {
                if (!this.projection.knownAttachmentIds.has(attachmentId)) {
                    throw new Error(`Image attachment ${attachmentId} is not in this session`);
                }
            }
            await this.appendRecord(entry);
            this.projection.queuedPrompts.set(entry.id, entry);
            this.projection.knownQueuedPromptIds.add(entry.id);
        });
        this.pendingAppend = result.then(() => undefined, () => undefined);
        return result;
    }

    removeQueuedPrompt(id: string): Promise<void> {
        const result = this.pendingAppend.then(async () => {
            this.requireActive();
            if (!this.projection.queuedPrompts.has(id)) return;
            await this.appendRecord({ type: "queued_prompt_removed", id, timestamp: this.now().toISOString() });
            this.projection.queuedPrompts.delete(id);
        });
        this.pendingAppend = result.then(() => undefined, () => undefined);
        return result;
    }

    repairCrashedTurn(options?: { readonly workerExited?: boolean }): Promise<boolean> {
        const result = this.pendingAppend.then(async () => {
            const active = this.activeEntries();
            if (this.projection.agentFailure !== undefined) return false;
            const turnOpen = this.projection.openTurnStartId !== undefined
                && turnOpenAtTail(active, this.projection.harnessMessageEntries);
            const queuedPrompts = this.queuedPrompts().map(({ content, attachmentIds }) => ({
                content,
                ...(attachmentIds === undefined ? {} : { attachmentIds }),
            }));
            if (!turnOpen && queuedPrompts.length === 0) return false;
            this.requireActive();
            if (!turnOpen) {
                const completed = active.findLast((entry) => entry.message.role === "assistant"
                    && entry.message.internal !== true && entry.message.stopReason !== "tool_use");
                await this.commitHarnessMessage(
                    queuedPrompts.length === 1 ? CRASH_QUEUED_PROMPT_MESSAGE : CRASH_QUEUED_PROMPTS_MESSAGE,
                    "soft",
                    {
                        ...(completed === undefined ? {} : { afterMessageId: completed.id }),
                        unsentPrompts: queuedPrompts,
                    },
                );
                return true;
            }
            const startIndex = active.findIndex((entry) => entry.id === this.projection.openTurnStartId);
            const turnEntries = active.slice(Math.max(startIndex, 0));
            const previousCut = this.projection.harnessMessageEntries.findLast((entry) => entry.crashCut === true);
            const previousCutIndex = previousCut?.afterMessageId === undefined
                ? -1
                : active.findIndex((entry) => entry.id === previousCut.afterMessageId);
            const lastAssistantIndex = active.findLastIndex((entry) => entry.message.role === "assistant");
            const unansweredPrompts = active.slice(Math.max(startIndex, previousCutIndex + 1, lastAssistantIndex + 1))
                .flatMap((entry): UnsentPrompt[] => {
                    const message = entry.message;
                    if (message.role !== "user" || message.internal === true) return [];
                    const attachmentIds = message.content.flatMap((part) =>
                        part.type === "image_attachment" ? [part.attachmentId] : []
                    );
                    return [{
                        content: message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(""),
                        ...(attachmentIds.length === 0 ? {} : { attachmentIds }),
                    }];
                });
            const unsentPrompts = [
                ...unansweredPrompts,
                ...queuedPrompts,
            ];
            const unanswered = new Map<string, { readonly id: string; readonly name: string }>();
            if (active.at(-1)?.message.role !== "user") {
                const callIndex = turnEntries.findLastIndex((entry) =>
                    entry.message.role === "assistant"
                    && entry.message.content.some((part) => part.type === "tool_call")
                );
                for (const entry of turnEntries.slice(Math.max(callIndex, 0))) {
                    const message = entry.message;
                    if (message.role === "assistant") {
                        for (const part of message.content) {
                            if (part.type === "tool_call") unanswered.set(part.id, part);
                        }
                    } else if (message.role === "tool_result") {
                        unanswered.delete(message.toolCallId);
                    }
                }
            }
            for (const call of unanswered.values()) {
                await this.commitMessage({
                    role: "tool_result",
                    toolCallId: call.id,
                    toolName: call.name,
                    content: [{ type: "text", text: CRASHED_TOOL_RESULT }],
                    isError: true,
                });
            }
            if (options?.workerExited === true) {
                const lastAssistant = active.findLast((entry) => entry.message.role === "assistant")?.message;
                const settings = this.modelSettings();
                await this.commitMessage({
                    role: "assistant", content: [],
                    source: lastAssistant?.role === "assistant" ? lastAssistant.source : {
                        provider: settings?.provider ?? "unknown", api: "unknown",
                        model: settings?.model ?? "unknown",
                    },
                    usage: emptyUsage(), stopReason: "error", errorMessage: WORKER_EXIT_TURN_MESSAGE,
                }, undefined, undefined, undefined, unsentPrompts);
            } else {
                await this.commitHarnessMessage(CRASH_CUT_MESSAGE, "soft", { crashCut: true, unsentPrompts });
            }
            return true;
        });
        this.pendingAppend = result.then(() => undefined, () => undefined);
        return result;
    }

    finishAbortedTurn(): Promise<boolean> {
        const result = this.pendingAppend.then(async () => {
            const startId = this.projection.openTurnStartId;
            if (startId === undefined || this.projection.agentFailure !== undefined) return false;
            this.requireActive();
            const active = this.activeEntries();
            const start = active.findIndex((entry) => entry.id === startId);
            if (start < 0) return false;
            const unanswered = new Map<string, { readonly id: string; readonly name: string }>();
            for (const entry of active.slice(start)) {
                const message = entry.message;
                if (message.role === "assistant") {
                    for (const part of message.content) {
                        if (part.type === "tool_call") unanswered.set(part.id, part);
                    }
                } else if (message.role === "tool_result") {
                    unanswered.delete(message.toolCallId);
                }
            }
            for (const call of unanswered.values()) {
                await this.commitMessage({
                    role: "tool_result", toolCallId: call.id, toolName: call.name,
                    content: [{ type: "text", text: "Turn aborted" }], isError: true,
                });
            }
            const lastAssistant = active.findLast((entry) => entry.message.role === "assistant")?.message;
            const settings = this.modelSettings();
            await this.commitMessage({
                role: "assistant", content: [],
                source: lastAssistant?.role === "assistant" ? lastAssistant.source : {
                    provider: settings?.provider ?? "unknown", api: "unknown",
                    model: settings?.model ?? "unknown",
                },
                usage: emptyUsage(), stopReason: "aborted", errorMessage: "Turn aborted",
            });
            return true;
        });
        this.pendingAppend = result.then(() => undefined, () => undefined);
        return result;
    }

    appendDeliveryMessage(
        deliveryId: string,
        message: ModelMessage,
        options?: { readonly turnStart?: true },
    ): Promise<SessionMessageEntry> {
        const result = this.pendingAppend.then(() => {
            this.requireActive();
            return this.commitDeliveryMessage(deliveryId, message, options?.turnStart);
        });
        this.pendingAppend = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    appendModelSettings(
        settings: ModelTurnSettings,
        origin?: SessionSettingOrigin,
    ): Promise<SessionModelSettingsEntry> {
        const result = this.pendingAppend.then(() => {
            this.requireActive();
            return this.commitModelSettings(settings, origin);
        });
        this.pendingAppend = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    appendApprovalMode(
        mode: ApprovalMode,
        origin?: SessionSettingOrigin,
    ): Promise<SessionPermissionsEntry> {
        const result = this.pendingAppend.then(() => {
            this.requireActive();
            return this.commitApprovalMode(mode, origin);
        });
        this.pendingAppend = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    appendHarnessMessage(
        text: string,
        tone: "primary" | "soft" | "error",
        visibleHeadId?: string | null,
    ): Promise<SessionHarnessMessageEntry> {
        const result = this.pendingAppend.then(() => {
            this.requireActive();
            const leaf = this.activeEntries().at(-1);
            const afterMessageId = leaf?.message.role === "tool_result"
                && visibleHeadId !== undefined && leaf.id !== visibleHeadId
                ? visibleHeadId
                : undefined;
            return this.commitHarnessMessage(text, tone, { afterMessageId });
        });
        this.pendingAppend = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    projectedHarnessMessages(): readonly {
        readonly afterMessage: number;
        readonly text: string;
        readonly tone: "primary" | "soft" | "error";
    }[] {
        const active = this.activeEntries();
        return projectHarnessMessages(this.projection.harnessMessageEntries, active);
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

    // Checked inside the append queue so a rename queued earlier always wins.
    appendFirstName(name: string): Promise<SessionNameEntry | undefined> {
        const result = this.pendingAppend.then(() => {
            this.requireActive();
            if (this.projection.nameEntries.length > 0) {
                return undefined;
            }
            return this.commitName(name);
        });
        this.pendingAppend = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    appendIdentity(identity: {
        readonly name: string;
        readonly key: string;
    }): Promise<SessionIdentityEntry> {
        const result = this.pendingAppend.then(() => {
            this.requireActive();
            return this.commitIdentity(identity);
        });
        this.pendingAppend = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    appendPermissionGrants(
        proposals: readonly PermissionGrantProposal[],
    ): Promise<SessionPermissionGrantsEntry> {
        const result = this.pendingAppend.then(() => {
            this.requireActive();
            return this.commitPermissionGrants(proposals);
        });
        this.pendingAppend = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    revokePermissionGrant(id: string): Promise<boolean> {
        const result = this.pendingAppend.then(() => {
            this.requireActive();
            return this.commitPermissionGrantRevocation(id);
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

    appendCompaction(
        request: AppendCompactionRequest,
    ): Promise<SessionCompactionEntry> {
        const snapshot = structuredClone(request) as AppendCompactionRequest;
        const result = this.pendingAppend.then(() => {
            this.requireActive();
            return this.commitCompaction(snapshot);
        });
        this.pendingAppend = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    appendAskBilling(
        billed: SessionCompactionBilled,
    ): Promise<SessionAskEntry> {
        const snapshot = structuredClone(billed);
        const result = this.pendingAppend.then(async () => {
            this.requireActive();
            const entry: SessionAskEntry = {
                type: "session_ask",
                id: this.createId(),
                timestamp: this.now().toISOString(),
                billed: snapshot,
            };
            await this.appendRecord(entry);
            this.projection.askEntries.push(entry);
            return entry;
        });
        this.pendingAppend = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    latestCompaction(): SessionCompactionEntry | undefined {
        const active = this.activeEntries();
        return this.projection.compactionEntries.findLast(
            (entry) => compactionApplies(entry, active),
        );
    }

    appendContextMeasurement(
        measurement: ContextMeasurement,
    ): Promise<SessionContextMeasurementEntry> {
        const result = this.pendingAppend.then(() => {
            this.requireActive();
            return this.commitContextMeasurement(measurement);
        });
        this.pendingAppend = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    latestContextMeasurement(): ContextMeasurement | undefined {
        const active = new Set(this.activeEntries().map((entry) => entry.id));
        const entries = this.projection.contextMeasurementEntries;
        for (let index = entries.length - 1; index >= 0; index -= 1) {
            const entry = entries[index]!;
            if (entry.afterMessageId !== null && !active.has(entry.afterMessageId)) {
                continue;
            }
            return materializeContextMeasurement(entries, index);
        }
        return undefined;
    }

    unprojectedModelContext(): readonly ModelMessage[] {
        return this.modelContextEntries().map((entry) => entry.message);
    }

    modelContext(
        aging: ToolResultAgingPolicy = {},
    ): readonly ModelMessage[] {
        return assembleAgedToolResults(this.modelContextEntries(), aging);
    }

    private modelContextEntries(): readonly ToolResultHistoryEntry[] {
        const identity = this.identityContextMessage();
        const identityEntries = identity === undefined
            ? []
            : [{ message: identity }];
        const compaction = this.latestCompaction();
        const active = this.activeEntries();
        if (compaction === undefined) {
            return [...identityEntries, ...active];
        }
        const boundary = active.findIndex(
            (entry) => entry.id === compaction.boundaryMessageId,
        );
        return [
            ...identityEntries,
            ...compaction.projection.map((message) => ({ message })),
            ...active.slice(boundary + 1),
        ];
    }

    private identityContextMessage(): ModelMessage | undefined {
        const identity = this.projection.identityEntries[0];
        return identity === undefined
            ? undefined
            : {
                role: "user",
                internal: true,
                content: [{
                    type: "text",
                    text: `Your session identity is ${identity.name}.`,
                }],
            };
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
        turnStart?: true,
        queuedPromptId?: string,
        unsentPrompts?: readonly UnsentPrompt[],
    ): Promise<SessionMessageEntry> {
        const snapshot = structuredClone(message);
        if (!isModelMessage(snapshot)) {
            throw new Error("Cannot append an invalid model message");
        }
        for (const attachmentId of messageAttachmentIds(snapshot)) {
            if (!this.projection.attachmentEntries.some(
                (entry) => entry.attachment.id === attachmentId
            )) {
                throw new Error(
                    `Image attachment ${attachmentId} is not in this session`,
                );
            }
        }
        if (queuedPromptId !== undefined) {
            const queued = this.projection.queuedPrompts.get(queuedPromptId);
            if (queued === undefined || !messageMatchesQueuedPrompt(snapshot, queued)) {
                throw new Error("The message does not match its queued prompt");
            }
        }
        const entry: SessionMessageEntry = {
            type: "message",
            id: nonEmpty(this.createId(), "message entry ID"),
            parentId: this.projection.leafId,
            timestamp: this.now().toISOString(),
            ...(deliveryId === undefined ? {} : { deliveryId }),
            ...(queuedPromptId === undefined ? {} : { queuedPromptId }),
            ...(unsentPrompts === undefined ? {} : { unsentPrompts: structuredClone(unsentPrompts) }),
            message: snapshot,
        };
        if (this.projection.messageEntries.some((candidate) => candidate.id === entry.id)) {
            throw new Error(`Session entry ID ${entry.id} already exists`);
        }

        const record: SessionMessageEntry | SessionTurnStartEntry = turnStart === true
            ? { ...entry, type: "turn_start" }
            : entry;
        await this.appendRecord(record);

        this.projection.messageEntries.push(entry);
        this.projection.knownMessageIds.add(entry.id);
        this.projection.leafId = entry.id;
        applyTurnMessage(this.projection, entry, turnStart === true);
        if (turnStart === true) this.projection.unsentPrompts = [];
        if (unsentPrompts !== undefined) {
            this.projection.queuedPrompts.clear();
            this.projection.unsentPrompts = structuredClone(unsentPrompts);
        }
        if (queuedPromptId !== undefined) this.projection.queuedPrompts.delete(queuedPromptId);
        return entry;
    }

    private async commitDeliveryMessage(
        requestedDeliveryId: string,
        message: ModelMessage,
        turnStart?: true,
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
        return this.commitMessage(message, deliveryId, turnStart);
    }

    private async commitModelSettings(
        settings: ModelTurnSettings,
        origin?: SessionSettingOrigin,
    ): Promise<SessionModelSettingsEntry> {
        if (!isModelTurnSettings(settings)) {
            throw new Error("Cannot append invalid model settings");
        }
        const entry: SessionModelSettingsEntry = {
            type: "model_settings",
            timestamp: this.now().toISOString(),
            settings: {
                ...(settings.provider === undefined
                    ? {}
                    : { provider: settings.provider.trim() }),
                model: settings.model.trim(),
                ...("selectionCleared" in settings && settings.selectionCleared === true
                    ? { selectionCleared: true } : {}),
                ...(settings.reasoningEffort === undefined
                    ? {}
                    : { reasoningEffort: settings.reasoningEffort }),
            },
            ...(origin === undefined ? {} : { origin }),
        };
        await this.appendRecord(entry);
        this.projection.modelSettingsEntries.push(entry);
        return entry;
    }

    private async commitContextMeasurement(
        measurement: ContextMeasurement,
    ): Promise<SessionContextMeasurementEntry> {
        if (!isContextMeasurement(measurement) || measurement.projection === undefined) {
            throw new Error("Cannot append a context measurement without a recipe");
        }
        const entry: SessionContextMeasurementEntry = {
            type: "context_measurement",
            timestamp: this.now().toISOString(),
            afterMessageId: this.projection.leafId,
            measurement,
        };
        const keyframe = !this.projection.contextMeasurementLastRecordCompact
            || this.projection.contextMeasurementBase === undefined
            || this.projection.contextMeasurementsSinceKeyframe
                >= CONTEXT_MEASUREMENT_KEYFRAME_INTERVAL;
        const compact = compactContextMeasurement(
            measurement,
            this.projection.contextMeasurementBase,
            keyframe,
        );
        await this.appendRecord({
            type: entry.type,
            timestamp: entry.timestamp,
            afterMessageId: entry.afterMessageId,
            measurement: compact.measurement,
            contextRecipe: compact.recipe,
        });
        this.projection.contextMeasurementEntries.push(entry);
        this.projection.contextMeasurementBase = measurement.projection.components;
        this.projection.contextMeasurementLastRecordCompact = true;
        this.projection.contextMeasurementsSinceKeyframe = keyframe
            ? 0
            : this.projection.contextMeasurementsSinceKeyframe + 1;
        retainContextMeasurements(this.projection);
        return entry;
    }

    private async commitHarnessMessage(
        requestedText: string,
        tone: "primary" | "soft" | "error",
        options: CommitHarnessMessageOptions = {},
    ): Promise<SessionHarnessMessageEntry> {
        const { crashCut, unsentPrompts, afterMessageId } = options;
        const text = requestedText.trim();
        if (text.length === 0) {
            throw new Error("Cannot append an empty harness message");
        }
        const entry: SessionHarnessMessageEntry = {
            type: "harness_message",
            timestamp: this.now().toISOString(),
            afterMessageId: afterMessageId === undefined ? this.projection.leafId : afterMessageId,
            text,
            tone,
            ...(crashCut === true ? { crashCut } : {}),
            ...(unsentPrompts === undefined ? {} : { unsentPrompts: structuredClone(unsentPrompts) }),
        };
        await this.appendRecord(entry);
        this.projection.harnessMessageEntries.push(entry);
        if (crashCut === true || unsentPrompts !== undefined) this.projection.openTurnStartId = undefined;
        if (unsentPrompts !== undefined) {
            this.projection.queuedPrompts.clear();
            this.projection.unsentPrompts = structuredClone(unsentPrompts);
        }
        return entry;
    }

    private async commitApprovalMode(
        mode: ApprovalMode,
        origin?: SessionSettingOrigin,
    ): Promise<SessionPermissionsEntry> {
        if (!isApprovalMode(mode)) {
            throw new Error("Cannot append invalid permissions mode");
        }
        const entry: SessionPermissionsEntry = {
            type: "permissions",
            timestamp: this.now().toISOString(),
            mode,
            ...(origin === undefined ? {} : { origin }),
        };
        await this.appendRecord(entry);
        this.projection.permissionsEntries.push(entry);
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
        this.projection.nameEntries.push(entry);
        return entry;
    }

    private async commitIdentity(identity: {
        readonly name: string;
        readonly key: string;
    }): Promise<SessionIdentityEntry> {
        if (this.projection.identityEntries.length > 0) {
            throw new Error("Session identity is already recorded");
        }
        const entry: SessionIdentityEntry = {
            type: "session_identity",
            timestamp: this.now().toISOString(),
            name: validIdentityField(identity.name, "identity name"),
            key: validIdentityField(identity.key, "identity key"),
        };
        await this.appendRecord(entry);
        this.projection.identityEntries.push(entry);
        return entry;
    }

    private async commitPermissionGrants(
        proposals: readonly PermissionGrantProposal[],
    ): Promise<SessionPermissionGrantsEntry> {
        if (
            proposals.length === 0
            || !proposals.every(isPermissionGrantProposal)
        ) {
            throw new Error("Cannot append invalid permission grants");
        }
        const id = this.createId();
        const entry: SessionPermissionGrantsEntry = {
            type: "permission_grants",
            id,
            timestamp: this.now().toISOString(),
            grants: proposals.map((proposal, index) => ({
                ...copyPermissionGrantProposal(proposal),
                id: `${id}:${index}`,
            })),
        };
        await this.appendRecord(entry);
        this.projection.permissionGrantEntries.push(entry);
        return entry;
    }

    private async commitPermissionGrantRevocation(
        id: string,
    ): Promise<boolean> {
        const live = this.permissionGrants().some((grant) => grant.id === id);
        if (!live) {
            return false;
        }
        const entry: SessionPermissionGrantRevocationEntry = {
            type: "permission_grant_revocation",
            timestamp: this.now().toISOString(),
            ids: [id],
        };
        await this.appendRecord(entry);
        this.projection.permissionGrantRevocationEntries.push(entry);
        return true;
    }

    private async commitAttachment(
        attachment: SessionImageAttachmentMetadata,
    ): Promise<SessionImageAttachmentMetadata> {
        const stored = attachment;
        const existing = this.projection.attachmentEntries.find(
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
            this.projection.attachmentEntries.push({
                ...entry,
                attachment: durable,
            });
            this.projection.knownAttachmentIds.add(durable.id);
            return { ...durable };
        }
        this.projection.attachmentEntries.push(entry);
        this.projection.knownAttachmentIds.add(entry.attachment.id);
        return { ...stored };
    }

    private async commitAgentFailure(
        requestedId: string,
        requestedDetail: string,
    ): Promise<SessionAgentFailureEntry> {
        const id = nonEmpty(requestedId, "agent failure ID");
        const detail = nonEmpty(requestedDetail, "agent failure detail");
        const existing = this.projection.agentFailure;
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
        this.projection.agentFailure = entry;
        return { ...entry };
    }

    private async commitCompaction(
        request: AppendCompactionRequest,
    ): Promise<SessionCompactionEntry> {
        for (const message of request.projection) {
            for (const attachmentId of messageAttachmentIds(message)) {
                if (!this.projection.attachmentEntries.some(
                    (entry) => entry.attachment.id === attachmentId,
                )) {
                    throw new Error(
                        `Compaction projection references image attachment `
                            + `${attachmentId}, which is not in this session`,
                    );
                }
            }
        }
        const entry: SessionCompactionEntry = {
            type: "compaction",
            id: this.createId(),
            timestamp: this.now().toISOString(),
            ...validateCompaction(request, this.activeEntries()),
        };
        await this.appendRecord(entry);
        this.projection.compactionEntries.push(entry);
        return entry;
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
        if (this.projection.leafId === null) {
            throw new Error("Cannot rewind an empty session");
        }
        const entry: SessionRewindEntry = {
            type: "rewind",
            timestamp: this.now().toISOString(),
            userMessageId,
            previousHeadId: this.projection.leafId,
            headId: boundary.parentId,
        };
        await this.appendRecord(entry);
        this.projection.leafId = entry.headId;
        this.projection.openTurnStartId = undefined;
        retainContextMeasurements(this.projection);
        return entry;
    }

    private async commitDelivery(delivery: PendingDelivery): Promise<boolean> {
        const id = nonEmpty(delivery.id, "delivery ID");
        const kind = delivery.kind ?? "completion";
        if (kind !== "attention" && kind !== "completion" && kind !== "peer") {
            throw new Error("delivery kind must be attention, completion or peer");
        }
        if (delivery.sourceKind !== undefined && delivery.sourceKind !== "extension") {
            throw new Error("delivery source kind must be extension");
        }
        if (delivery.peer !== undefined && (kind !== "peer" || !isPeerDeliveryFacts(delivery.peer))) {
            throw new Error("delivery peer facts need kind peer, a sender label and a message ID");
        }
        if (typeof delivery.content !== "string") {
            throw new Error("delivery content must be a string");
        }
        const sourceAgentId = nonEmpty(
            delivery.sourceAgentId,
            "delivery source agent ID",
        );
        const existing = this.projection.deliveryEntries.find((entry) => entry.id === id);
        if (existing !== undefined) {
            if (
                existing.sourceAgentId !== sourceAgentId
                || existing.content !== delivery.content
                || (existing.kind ?? "completion") !== kind
                || existing.sourceKind !== delivery.sourceKind
                || JSON.stringify(existing.peer)
                    !== JSON.stringify(delivery.peer === undefined ? undefined : peerDeliveryFacts(delivery.peer))
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
            ...(kind === "completion" ? {} : { kind }),
            ...(delivery.sourceKind === undefined ? {} : { sourceKind: delivery.sourceKind }),
            ...(delivery.peer === undefined ? {} : { peer: peerDeliveryFacts(delivery.peer) }),
            timestamp: this.now().toISOString(),
        };
        await this.appendRecord(entry);
        this.projection.deliveryEntries.push(entry);
        this.projection.knownDeliveryIds.add(entry.id);
        return true;
    }

    protected async appendRecord(record: object): Promise<void> {
        if (this.projection.agentFailure !== undefined) {
            throw new Error("Cannot append after the terminal agent failure");
        }
        const lineNumber = await this.writeRecordLine(record);
        this.onRecordAppended?.(
            lineNumber,
            record as Record<string, unknown>,
        );
    }

    watchRecords(
        listener: (
            lineNumber: number,
            record: Record<string, unknown>,
        ) => void,
    ): void {
        this.onRecordAppended = listener;
    }

    appendedLineCount(): number {
        return this.lineCount;
    }

    /** Runs task with no append in flight and none able to start. An append made inside task never finishes. */
    exclusively<T>(task: () => Promise<T>): Promise<T> {
        const result = this.pendingAppend.then(task);
        this.pendingAppend = result.then(() => {}, () => {});
        return result;
    }

    appendForeignRecord(
        record: Record<string, unknown>,
    ): Promise<number> {
        const result = this.pendingAppend.then(async () => {
            if (this.projection.agentFailure !== undefined) {
                throw new Error(
                    "Cannot append after the terminal agent failure",
                );
            }
            const stored = parseJsonObject(
                this.path,
                this.lineCount + 1,
                jsonLine(record),
            );
            ingestSessionRecord(
                this.path,
                this.lineCount + 1,
                stored,
                copyProjectionState(this.projection),
            );
            const lineNumber = await this.writeRecordLine(stored);
            ingestSessionRecord(this.path, lineNumber, stored, this.projection);
            return lineNumber;
        });
        this.pendingAppend = result.then(() => {}, () => {});
        return result;
    }

    // Every append runs behind pendingAppend, so this store's own writes cannot race the rollback.
    private async writeRecordLine(record: object): Promise<number> {
        if (this.writeFault !== undefined) {
            throw this.writeFault;
        }
        const line = jsonLine(record);
        const file = await this.openAppendFile(this.path);
        try {
            const { size: lengthBefore } = await file.stat();
            try {
                await file.writeFile(line, "utf8");
                await file.sync();
            } catch (error) {
                const fault = await this.restoreLength(file, lengthBefore, Buffer.byteLength(line));
                if (fault === undefined) {
                    throw error;
                }
                const reason = error instanceof Error ? error.message : String(error);
                throw new Error(`${reason}. ${fault.message}`, { cause: error });
            }
        } finally {
            // The line is durable or rolled back by now, so a failed close changes neither.
            await file.close().catch(() => {});
        }
        this.lineCount += 1;
        return this.lineCount;
    }

    // A failed append must leave no unapplied line. Another writer (a rename) can append here,
    // so a size outside what our line could add is left alone.
    private async restoreLength(
        file: SessionAppendFile,
        length: number,
        lineBytes: number,
    ): Promise<Error | undefined> {
        try {
            const { size } = await file.stat();
            if (size < length || size > length + lineBytes) {
                throw new Error(`Session file length is ${size}, outside ${length} to ${length + lineBytes}`);
            }
            await file.truncate(length);
            await file.sync();
            return undefined;
        } catch (error) {
            this.writeFault = new Error(
                `Session file ${this.path} may hold a record this session never applied `
                    + "after a failed write. The session now refuses writes. Reopen the session to reload it.",
                { cause: error },
            );
            return this.writeFault;
        }
    }

    protected requireActive(): void {
        if (this.projection.agentFailure !== undefined) {
            throw new Error("Cannot append after the terminal agent failure");
        }
    }
}

export async function readSessionHeader(path: string): Promise<SessionHeader> {
    return (await readSessionIndexMetadata(path)).header;
}

export interface SessionIndexMetadata {
    readonly header: SessionHeader;
    readonly title?: string;
    readonly hasUserContent: boolean;
}

export async function readSessionIndexMetadata(
    path: string,
): Promise<SessionIndexMetadata> {
    const file = await open(path, "r");
    try {
        const buffer = Buffer.alloc(64 * 1_024);
        let length = 0;
        let newlineAt = -1;
        while (length < buffer.length && newlineAt === -1) {
            const { bytesRead } = await file.read(
                buffer,
                length,
                buffer.length - length,
                length,
            );
            if (bytesRead === 0) break;
            length += bytesRead;
            newlineAt = buffer.subarray(0, length).indexOf(0x0a);
        }
        if (newlineAt === -1) {
            throw invalidSession(path, "session header exceeds 64 KiB");
        }
        const header = parseHeader(path, buffer.subarray(0, newlineAt).toString("utf8"));
        let pending: Buffer = Buffer.from(buffer.subarray(newlineAt + 1, length));
        let position = length;
        let firstPrompt: string | undefined;
        let hasUserContent = false;
        let name: string | null | undefined;
        while (true) {
            let lineStart = 0;
            for (
                let lineEnd = pending.indexOf(0x0a);
                lineEnd !== -1;
                lineEnd = pending.indexOf(0x0a, lineStart)
            ) {
                const line = pending.toString("utf8", lineStart, lineEnd);
                lineStart = lineEnd + 1;
                let record: Record<string, unknown>;
                try {
                    record = JSON.parse(line) as Record<string, unknown>;
                } catch {
                    continue;
                }
                if (record.type === "session_name") {
                    if (typeof record.name === "string" || record.name === null) {
                        name = record.name as string | null;
                    }
                    continue;
                }
                const message = record.message as Record<string, unknown> | undefined;
                if (
                    (record.type === "message" || record.type === "turn_start")
                    && message?.role === "user"
                    && message.internal !== true
                    && Array.isArray(message.content)
                ) {
                    hasUserContent = true;
                    const text = message.content.flatMap((part) => {
                        const value = part as Record<string, unknown>;
                        return value.type === "text" && typeof value.text === "string"
                            ? [value.text]
                            : [];
                    }).join(" ").replaceAll(/\s+/g, " ").trim();
                    if (firstPrompt === undefined && text.length > 0) firstPrompt = text;
                }
            }
            if (hasUserContent) break;
            pending = Buffer.from(pending.subarray(lineStart));
            const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
            if (bytesRead === 0) break;
            position += bytesRead;
            pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
        }
        const title = name ?? firstPrompt;
        return {
            header,
            hasUserContent,
            ...(title === undefined ? {} : { title }),
        };
    } finally {
        await file.close();
    }
}

async function readDurableAttachment(
    path: string,
    id: string,
): Promise<SessionImageAttachmentMetadata | undefined> {
    try {
        const source = await readFile(path, "utf8");
        const complete = completeSessionSource(path, source);
        return parseSessionFile(path, complete).state.attachmentEntries.find(
            (entry) => entry.attachment.id === id,
        )?.attachment;
    } catch {
        return undefined;
    }
}

export function defaultSessionPath(sessionId: string): string {
    return join(defaultSessionDirectory(), `${sessionId}.jsonl`);
}

export function defaultSessionDirectory(home?: string): string {
    return join(veraRuntimeDirectoryIn(selectedVeraHome(home)), "sessions");
}

function messageStamps(
    entries: readonly SessionMessageEntry[],
): ReadonlyMap<ModelMessage, MessageStamp> {
    return new Map(entries.map((entry) => [
        entry.message,
        { id: entry.id, recordedAt: Date.parse(entry.timestamp) },
    ]));
}

function deliveredMessages(
    entries: readonly SessionMessageEntry[],
    deliveries: readonly SessionDeliveryEntry[],
): ReadonlyMap<ModelMessage, SessionDeliveryEntry> {
    const byId = new Map(deliveries.map((delivery) => [delivery.id, delivery]));
    const delivered = new Map<ModelMessage, SessionDeliveryEntry>();
    for (const entry of entries) {
        const delivery = entry.deliveryId === undefined ? undefined : byId.get(entry.deliveryId);
        if (delivery !== undefined) {
            delivered.set(entry.message, delivery);
        }
    }
    return delivered;
}

export interface SessionTurnState {
    readonly sessionId: string;
    readonly turnOpen: boolean;
    readonly needsQueueRecovery: boolean;
}

export async function openSessionForRecovery(path: string): Promise<SessionStore> {
    const store = await SessionStore.open(path);
    await store.repairCrashedTurn();
    return store;
}

// Reads the file without repairing it. Only the active branch counts.
export async function readSessionTurnState(
    path: string,
): Promise<SessionTurnState> {
    const source = await readFile(path, "utf8");
    const loaded = parseSessionFile(path, completeSessionSource(path, source));
    const active = activeBranchEntries(
        loaded.state.messageEntries,
        loaded.state.leafId,
    );
    return {
        sessionId: loaded.header.id,
        turnOpen: loaded.state.agentFailure === undefined
            && loaded.state.openTurnStartId !== undefined
            && turnOpenAtTail(active, loaded.state.harnessMessageEntries),
        needsQueueRecovery: loaded.state.agentFailure === undefined
            && loaded.state.queuedPrompts.size > 0,
    };
}

// A turn is open when the branch ends on something the model has not answered.
function turnOpenAtTail(
    entries: readonly SessionMessageEntry[],
    harness: readonly SessionHarnessMessageEntry[],
): boolean {
    const last = entries.at(-1);
    if (last === undefined || harness.some((entry) =>
        entry.crashCut === true && entry.afterMessageId === last.id
    )) return false;
    const tail = last.message;
    if (tail.role === "user" || tail.role === "tool_result") return true;
    return tail.role === "assistant" && (
        tail.stopReason === "tool_use"
        || (tail.turnTiming === undefined && (tail.stopReason === "stop" || tail.stopReason === "length"))
    );
}

function applyTurnMessage(
    state: SessionProjectionState,
    entry: SessionMessageEntry,
    turnStart: boolean,
): void {
    if (turnStart) state.openTurnStartId = entry.id;
    const message = entry.message;
    if (message.role === "assistant" && (
        message.turnTiming !== undefined
        || message.stopReason === "aborted"
        || message.stopReason === "error"
    )) state.openTurnStartId = undefined;
}

function hasOpenDeliveryTurn(
    entries: readonly SessionMessageEntry[],
    harness: readonly SessionHarnessMessageEntry[],
): boolean {
    const lastDeliveryIndex = entries.findLastIndex(
        (entry) => entry.deliveryId !== undefined,
    );
    if (lastDeliveryIndex === -1) return false;
    if (harness.some((message) =>
        message.crashCut === true
        && entries.findIndex((entry) => entry.id === message.afterMessageId) >= lastDeliveryIndex
    )) return false;
    return !entries.slice(lastDeliveryIndex + 1).some(
        (entry) =>
            entry.message.role === "assistant"
            && entry.message.stopReason !== "tool_use",
    );
}

export async function readSessionSnapshot(
    path: string,
): Promise<ReadonlySessionSnapshot> {
    const source = await readFile(path, "utf8");
    const loaded = parseSessionFile(path, completeSessionSource(path, source));
    const active = activeBranchEntries(
        loaded.state.messageEntries,
        loaded.state.leafId,
    );
    return {
        header: loaded.header,
        messages: active.map((entry) => entry.message),
        messageStamps: messageStamps(active),
        deliveredMessages: deliveredMessages(active, loaded.state.deliveryEntries),
        harnessMessages: projectHarnessMessages(
            loaded.state.harnessMessageEntries,
            active,
        ),
        ...(loaded.state.agentFailure === undefined
            ? {}
            : { agentFailure: { ...loaded.state.agentFailure } }),
    };
}

function projectHarnessMessages(
    entries: readonly SessionHarnessMessageEntry[],
    active: readonly SessionMessageEntry[],
): readonly {
    readonly afterMessage: number;
    readonly text: string;
    readonly tone: "primary" | "soft" | "error";
}[] {
    return entries.flatMap((entry) => {
        let afterMessage = entry.afterMessageId === null
            ? 0
            : active.findIndex((message) => message.id === entry.afterMessageId) + 1;
        if (
            afterMessage > 0
            && active[afterMessage - 1]?.message.internal === true
            && entry.crashCut !== true
            && entry.unsentPrompts === undefined
            && !(entry.text === CRASH_CUT_MESSAGE && entry.tone === "soft")
        ) {
            const nextVisibleUser = active.findIndex((message, index) =>
                index >= afterMessage
                && message.message.role === "user"
                && message.message.internal !== true
            );
            if (nextVisibleUser < 0) return [];
            afterMessage = nextVisibleUser + 1;
        }
        return afterMessage === 0 && entry.afterMessageId !== null
            ? []
            : [{ afterMessage, text: entry.text, tone: entry.tone }];
    });
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

export interface SessionProjectionState {
    readonly messageEntries: SessionMessageEntry[];
    readonly queuedPrompts: Map<string, SessionQueuedPromptEntry>;
    readonly knownQueuedPromptIds: Set<string>;
    unsentPrompts: readonly UnsentPrompt[];
    readonly deliveryEntries: SessionDeliveryEntry[];
    readonly deliveryReceipts: Set<string>;
    readonly legacyDeliveryMessageIds: Map<string, string>;
    readonly modelSettingsEntries: SessionModelSettingsEntry[];
    readonly selectedAgentEntries: SessionSelectedAgentEntry[];
    readonly permissionsEntries: SessionPermissionsEntry[];
    readonly harnessMessageEntries: SessionHarnessMessageEntry[];
    readonly nameEntries: SessionNameEntry[];
    readonly identityEntries: SessionIdentityEntry[];
    readonly permissionGrantEntries: SessionPermissionGrantsEntry[];
    readonly permissionGrantRevocationEntries:
        SessionPermissionGrantRevocationEntry[];
    readonly attachmentEntries: SessionAttachmentEntry[];
    readonly compactionEntries: SessionCompactionEntry[];
    readonly askEntries: SessionAskEntry[];
    readonly contextMeasurementEntries: SessionContextMeasurementEntry[];
    /** Components of the last context measurement record on disk. */
    contextMeasurementBase: readonly ContextProjectionComponent[] | undefined;
    contextMeasurementLastRecordCompact: boolean;
    contextMeasurementsSinceKeyframe: number;
    /** Full components of the last retained entry, used to extend its delta chain. */
    contextMeasurementLastComponents:
        readonly ContextProjectionComponent[] | undefined;
    readonly knownMessageIds: Set<string>;
    readonly knownDeliveryIds: Set<string>;
    readonly knownAttachmentIds: Set<string>;
    agentFailure: SessionAgentFailureEntry | undefined;
    leafId: string | null;
    openTurnStartId: string | undefined;
}

export function createSessionProjectionState(): SessionProjectionState {
    return {
        messageEntries: [],
        queuedPrompts: new Map(),
        knownQueuedPromptIds: new Set(),
        unsentPrompts: [],
        deliveryEntries: [],
        deliveryReceipts: new Set(),
        legacyDeliveryMessageIds: new Map(),
        modelSettingsEntries: [],
        selectedAgentEntries: [],
        permissionsEntries: [],
        harnessMessageEntries: [],
        nameEntries: [],
        identityEntries: [],
        permissionGrantEntries: [],
        permissionGrantRevocationEntries: [],
        attachmentEntries: [],
        compactionEntries: [],
        askEntries: [],
        contextMeasurementEntries: [],
        contextMeasurementBase: undefined,
        contextMeasurementLastRecordCompact: false,
        contextMeasurementsSinceKeyframe: 0,
        contextMeasurementLastComponents: undefined,
        knownMessageIds: new Set(),
        knownDeliveryIds: new Set(),
        knownAttachmentIds: new Set(),
        agentFailure: undefined,
        leafId: null,
        openTurnStartId: undefined,
    };
}

// Entries are shared with the original; ingest only appends and never edits one.
function copyProjectionState(
    state: SessionProjectionState,
): SessionProjectionState {
    return {
        messageEntries: [...state.messageEntries],
        queuedPrompts: new Map(state.queuedPrompts),
        knownQueuedPromptIds: new Set(state.knownQueuedPromptIds),
        unsentPrompts: state.unsentPrompts,
        deliveryEntries: [...state.deliveryEntries],
        deliveryReceipts: new Set(state.deliveryReceipts),
        legacyDeliveryMessageIds: new Map(state.legacyDeliveryMessageIds),
        modelSettingsEntries: [...state.modelSettingsEntries],
        selectedAgentEntries: [...state.selectedAgentEntries],
        permissionsEntries: [...state.permissionsEntries],
        harnessMessageEntries: [...state.harnessMessageEntries],
        nameEntries: [...state.nameEntries],
        identityEntries: [...state.identityEntries],
        permissionGrantEntries: [...state.permissionGrantEntries],
        permissionGrantRevocationEntries: [
            ...state.permissionGrantRevocationEntries,
        ],
        attachmentEntries: [...state.attachmentEntries],
        compactionEntries: [...state.compactionEntries],
        askEntries: [...state.askEntries],
        contextMeasurementEntries: [...state.contextMeasurementEntries],
        contextMeasurementBase: state.contextMeasurementBase,
        contextMeasurementLastRecordCompact: state.contextMeasurementLastRecordCompact,
        contextMeasurementsSinceKeyframe: state.contextMeasurementsSinceKeyframe,
        contextMeasurementLastComponents: state.contextMeasurementLastComponents,
        knownMessageIds: new Set(state.knownMessageIds),
        knownDeliveryIds: new Set(state.knownDeliveryIds),
        knownAttachmentIds: new Set(state.knownAttachmentIds),
        agentFailure: state.agentFailure,
        leafId: state.leafId,
        openTurnStartId: state.openTurnStartId,
    };
}

export function ingestSessionRecord(
    path: string,
    lineNumber: number,
    value: Record<string, unknown>,
    state: SessionProjectionState,
): void {
    const {
        messageEntries,
        deliveryEntries,
        deliveryReceipts,
        legacyDeliveryMessageIds,
        modelSettingsEntries,
        selectedAgentEntries,
        permissionsEntries,
        harnessMessageEntries,
        nameEntries,
        identityEntries,
        permissionGrantEntries,
        permissionGrantRevocationEntries,
        attachmentEntries,
        compactionEntries,
        askEntries,
        knownMessageIds,
        knownDeliveryIds,
        knownAttachmentIds,
    } = state;
    if (state.agentFailure !== undefined) {
        if (value.type === "agent_failure") {
            const duplicate = parseAgentFailureEntry(
                path,
                lineNumber,
                value,
            );
            if (
                duplicate.id === state.agentFailure.id
                && duplicate.detail === state.agentFailure.detail
            ) {
                return;
            }
        }
        throw invalidSession(
            path,
            `line ${lineNumber} follows the terminal agent failure`,
        );
    }
    if (value.type === "message" || value.type === "turn_start") {
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
        if (entry.parentId !== state.leafId) {
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
                activeBranchEntries(messageEntries, state.leafId).some(
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
        if (entry.queuedPromptId !== undefined) {
            const queued = state.queuedPrompts.get(entry.queuedPromptId);
            if (queued === undefined || !messageMatchesQueuedPrompt(entry.message, queued)) {
                throw invalidSession(path, `line ${lineNumber} has an invalid queued prompt join`);
            }
            state.queuedPrompts.delete(entry.queuedPromptId);
        }
        knownMessageIds.add(entry.id);
        messageEntries.push(entry);
        state.leafId = entry.id;
        applyTurnMessage(state, entry, value.type === "turn_start");
        if (value.type === "turn_start") state.unsentPrompts = [];
        if (entry.unsentPrompts !== undefined) {
            state.queuedPrompts.clear();
            state.unsentPrompts = structuredClone(entry.unsentPrompts);
        }
        return;
    }
    if (value.type === "queued_prompt") {
        if (typeof value.id !== "string" || value.id.length === 0
            || typeof value.timestamp !== "string" || !isUnsentPrompt(value)
            || state.knownQueuedPromptIds.has(value.id)
            || (value.attachmentIds ?? []).some((id) => !knownAttachmentIds.has(id))) {
            throw invalidSession(path, `line ${lineNumber} is not a valid queued prompt`);
        }
        const entry = value as unknown as SessionQueuedPromptEntry;
        state.queuedPrompts.set(entry.id, entry);
        state.knownQueuedPromptIds.add(entry.id);
        return;
    }
    if (value.type === "queued_prompt_removed") {
        if (typeof value.id !== "string" || typeof value.timestamp !== "string"
            || !state.queuedPrompts.has(value.id)) {
            throw invalidSession(path, `line ${lineNumber} is not a valid queued prompt removal`);
        }
        state.queuedPrompts.delete(value.id);
        return;
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
        return;
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
        const activeHead = state.leafId === null
            ? undefined
            : messageEntries.find((entry) => entry.id === state.leafId);
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
        return;
    }
    if (value.type === "model_settings") {
        modelSettingsEntries.push(
            parseModelSettingsEntry(path, lineNumber, value),
        );
        return;
    }
    // agent_wear is the name this record had before the select rename.
    if (value.type === "agent_select" || value.type === "agent_wear") {
        selectedAgentEntries.push(
            parseSelectedAgentEntry(path, lineNumber, value),
        );
        return;
    }
    if (value.type === "permissions") {
        permissionsEntries.push(
            parsePermissionsEntry(path, lineNumber, value),
        );
        return;
    }
    if (value.type === "harness_message") {
        const entry = parseHarnessMessageEntry(path, lineNumber, value);
        if (entry.crashCut === true && entry.afterMessageId !== state.leafId) {
            throw invalidSession(path, `line ${lineNumber} has an invalid crash cut position`);
        }
        harnessMessageEntries.push(entry);
        if (entry.crashCut === true || entry.unsentPrompts !== undefined) state.openTurnStartId = undefined;
        if (entry.unsentPrompts !== undefined) {
            state.queuedPrompts.clear();
            state.unsentPrompts = entry.unsentPrompts;
        }
        return;
    }
    if (value.type === "session_name") {
        nameEntries.push(
            parseSessionNameEntry(path, lineNumber, value),
        );
        return;
    }
    if (value.type === "session_identity") {
        if (identityEntries.length > 0) {
            throw invalidSession(
                path,
                `line ${lineNumber} repeats session identity`,
            );
        }
        identityEntries.push(
            parseSessionIdentityEntry(path, lineNumber, value),
        );
        return;
    }
    if (value.type === "command_prefix") {
        parseLegacyCommandPrefixEntry(path, lineNumber, value);
        return;
    }
    if (value.type === "permission_grants") {
        permissionGrantEntries.push(
            parsePermissionGrantsEntry(path, lineNumber, value),
        );
        return;
    }
    if (value.type === "permission_grant_revocation") {
        permissionGrantRevocationEntries.push(
            parsePermissionGrantRevocationEntry(path, lineNumber, value),
        );
        return;
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
                return;
            }
            throw invalidSession(
                path,
                `line ${lineNumber} repeats attachment ID ${entry.attachment.id}`,
            );
        }
        knownAttachmentIds.add(entry.attachment.id);
        attachmentEntries.push(entry);
        return;
    }
    if (value.type === "agent_failure") {
        state.agentFailure = parseAgentFailureEntry(path, lineNumber, value);
        state.openTurnStartId = undefined;
        return;
    }
    if (value.type === "rewind") {
        const rewind = parseRewindEntry(path, lineNumber, value);
        if (rewind.previousHeadId !== state.leafId) {
            throw invalidSession(
                path,
                `line ${lineNumber} rewinds from inactive head ${rewind.previousHeadId}`,
            );
        }
        const boundary: SessionMessageEntry | undefined =
            activeBranchEntries(messageEntries, state.leafId).find(
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
        state.leafId = rewind.headId;
        state.openTurnStartId = undefined;
        retainContextMeasurements(state);
        return;
    }
    if (value.type === "compaction") {
        compactionEntries.push(
            parseCompactionEntry(path, lineNumber, value),
        );
        return;
    }
    if (value.type === "session_ask") {
        askEntries.push(parseAskEntry(path, lineNumber, value));
        return;
    }
    if (value.type === "context_measurement") {
        ingestContextMeasurementRecord(path, lineNumber, value, state);
        return;
    }
    if (value.type === "checkpoint") {
        parseRemovedFileCheckpointEntry(path, lineNumber, value);
        return;
    }
    throw invalidSession(
        path,
        `line ${lineNumber} is not a valid session entry`,
    );
}

function parseSessionFile(path: string, source: string): ParsedSessionFile {
    const lines = source.slice(0, -1).split("\n");
    const header = parseHeader(path, lines[0]);
    const state = createSessionProjectionState();
    const deferred: DeferredContextMeasurement[] = [];
    let failureLine: number | undefined;

    for (let index = 1; index < lines.length; index += 1) {
        const lineNumber = index + 1;
        const line = lines[index]!;
        if (line.startsWith(CONTEXT_MEASUREMENT_LINE_PREFIX)) {
            const afterMessageId = measuredAfterMessageId(line);
            if (afterMessageId !== undefined) {
                deferred.push({
                    lineNumber,
                    afterMessageId,
                    line,
                    compact: line.includes('"contextRecipe":'),
                });
                continue;
            }
        }
        const value = parseJsonObject(path, lineNumber, line);
        if (value.type === "context_measurement") {
            const afterMessageId = value.afterMessageId;
            if (afterMessageId !== null && typeof afterMessageId !== "string") {
                throw invalidSession(
                    path,
                    `line ${lineNumber} is not a valid context measurement entry`,
                );
            }
            deferred.push({
                lineNumber,
                afterMessageId,
                line,
                compact: value.contextRecipe !== undefined,
                record: value,
            });
            continue;
        }
        ingestSessionRecord(path, lineNumber, value, state);
        if (state.agentFailure !== undefined && failureLine === undefined) {
            failureLine = lineNumber;
        }
    }

    for (const candidate of deferred) {
        if (failureLine !== undefined && candidate.lineNumber > failureLine) {
            throw invalidSession(
                path,
                `line ${candidate.lineNumber} follows the terminal agent failure`,
            );
        }
    }
    ingestDeferredContextMeasurements(path, state, deferred);

    return { header, state, lineCount: lines.length };
}

interface DeferredContextMeasurement {
    readonly lineNumber: number;
    readonly afterMessageId: string | null;
    readonly line: string;
    readonly compact: boolean;
    readonly record?: Record<string, unknown>;
}

const CONTEXT_MEASUREMENT_LINE_PREFIX = '{"type":"context_measurement"';

/**
 * Reads the top-level afterMessageId without parsing a measurement recipe that
 * may never be kept. Returns undefined when the line needs a full parse.
 */
function measuredAfterMessageId(line: string): string | null | undefined {
    if (!line.endsWith("}")) return undefined;
    const key = '"afterMessageId":';
    const measurementAt = line.indexOf('"measurement":', CONTEXT_MEASUREMENT_LINE_PREFIX.length);
    const keyAt = line.indexOf(key, CONTEXT_MEASUREMENT_LINE_PREFIX.length);
    if (keyAt === -1 || (measurementAt !== -1 && keyAt > measurementAt)) {
        return undefined;
    }
    const valueAt = keyAt + key.length;
    if (line.startsWith("null", valueAt)) return null;
    if (line[valueAt] !== '"') return undefined;
    let end = valueAt + 1;
    let escaped = false;
    for (; end < line.length; end += 1) {
        const character = line[end]!;
        if (escaped) {
            escaped = false;
        } else if (character === "\\") {
            escaped = true;
        } else if (character === '"') {
            break;
        }
    }
    if (end >= line.length) return undefined;
    try {
        const parsed: unknown = JSON.parse(line.slice(valueAt, end + 1));
        return typeof parsed === "string" ? parsed : undefined;
    } catch {
        return undefined;
    }
}

function ingestDeferredContextMeasurements(
    path: string,
    state: SessionProjectionState,
    deferred: readonly DeferredContextMeasurement[],
): void {
    if (deferred.length === 0) return;
    const kept = reachableContextMeasurementIndexes(
        state,
        deferred.map((candidate) => candidate.afterMessageId),
    );
    for (let index = 0; index < deferred.length; index += 1) {
        const candidate = deferred[index]!;
        const isKept = kept.has(index);
        // Compact records carry the base for later deltas, so they are parsed
        // even when dropped. A dropped full record is still skipped.
        if (!isKept && !candidate.compact) {
            state.contextMeasurementBase = undefined;
            state.contextMeasurementLastRecordCompact = false;
            state.contextMeasurementsSinceKeyframe = 0;
            continue;
        }
        const value = candidate.record
            ?? parseJsonObject(path, candidate.lineNumber, candidate.line);
        const parsed = parseContextMeasurementEntry(
            path,
            candidate.lineNumber,
            value,
        );
        const entry = applyContextMeasurementEntry(
            path,
            candidate.lineNumber,
            parsed,
            state,
        );
        if (isKept) state.contextMeasurementEntries.push(entry);
    }
    retainContextMeasurements(state);
}

function ingestContextMeasurementRecord(
    path: string,
    lineNumber: number,
    value: Record<string, unknown>,
    state: SessionProjectionState,
): void {
    const parsed = parseContextMeasurementEntry(path, lineNumber, value);
    state.contextMeasurementEntries.push(
        applyContextMeasurementEntry(path, lineNumber, parsed, state),
    );
    retainContextMeasurements(state);
}

/**
 * Keeps the latest measurement for every head a rewind can reach: null, the
 * parents of active user messages, and the current leaf. Measurements on a
 * branch already left cannot become active again because rewinds only move to
 * an ancestor of the current leaf.
 */
function retainContextMeasurements(state: SessionProjectionState): void {
    const entries = state.contextMeasurementEntries;
    if (entries.length === 0) {
        state.contextMeasurementLastComponents = undefined;
        return;
    }
    const kept = reachableContextMeasurementIndexes(
        state,
        entries.map((entry) => entry.afterMessageId),
    );
    if (kept.size === entries.length) {
        compactContextMeasurementEntries(state, entries.length);
        return;
    }
    const indexes = [...kept].sort((left, right) => left - right);
    if (
        indexes.length === entries.length - 1
        && indexes.at(-1) === entries.length - 1
        && indexes.slice(0, -1).every((index, position) => index === position)
    ) {
        const previous = entries.at(-2);
        const latest = entries.at(-1);
        const components = latest?.measurement.projection?.components;
        if (previous?.retainedRecipe !== undefined
            && (!previous.retainedRecipe.keyframe || entries.length === 2)
            && latest !== undefined
            && latest.retainedRecipe === undefined
            && components !== undefined
            && state.contextMeasurementLastComponents !== undefined) {
            const retainedRecipe = replaceContextMeasurementDelta(
                previous.retainedRecipe,
                state.contextMeasurementLastComponents,
                components,
            );
            if (retainedRecipe !== undefined) {
                entries.splice(entries.length - 2, 2, {
                    ...latest,
                    measurement: aggregateContextMeasurement(latest.measurement),
                    retainedRecipe,
                });
                state.contextMeasurementLastComponents = components;
                return;
            }
        }
    }
    let prefix = true;
    for (let position = 0; position < indexes.length; position += 1) {
        if (indexes[position] !== position) {
            prefix = false;
            break;
        }
    }
    if (prefix) {
        entries.length = indexes.length;
        if (entries.at(-1)?.retainedRecipe !== undefined) {
            state.contextMeasurementLastComponents = contextMeasurementComponentsAt(
                entries,
                entries.length - 1,
            );
        }
        compactContextMeasurementEntries(state, entries.length);
        return;
    }
    rebuildRetainedContextMeasurements(state, indexes);
}

/**
 * Replaces full component lists with deltas against the previous retained
 * entry. Entries before `first` are already compact and `lastComponents`
 * holds the full list of the entry just before it.
 */
function compactContextMeasurementEntries(
    state: SessionProjectionState,
    limit: number,
): void {
    const entries = state.contextMeasurementEntries;
    let first = 0;
    while (first < limit && entries[first]!.retainedRecipe !== undefined) {
        first += 1;
    }
    if (first === limit) {
        state.contextMeasurementLastComponents = first === 0
            ? undefined
            : contextMeasurementComponentsAt(entries, first - 1);
        return;
    }
    let previous = first === 0
        ? undefined
        : state.contextMeasurementLastComponents;
    for (let index = first; index < limit; index += 1) {
        const entry = entries[index]!;
        const components = entry.measurement.projection?.components;
        if (components === undefined) {
            throw new Error("Retained context measurement lost its components");
        }
        entries[index] = {
            ...entry,
            measurement: aggregateContextMeasurement(entry.measurement),
            retainedRecipe: previous === undefined
                ? contextMeasurementKeyframe(components)
                : contextMeasurementDelta(previous, components),
        };
        previous = components;
    }
    state.contextMeasurementLastComponents = previous;
}

function rebuildRetainedContextMeasurements(
    state: SessionProjectionState,
    indexes: readonly number[],
): void {
    const entries = state.contextMeasurementEntries;
    const componentsByIndex: (readonly ContextProjectionComponent[])[] = [];
    let components: readonly ContextProjectionComponent[] | undefined;
    for (const entry of entries) {
        components = entry.retainedRecipe === undefined
            ? entry.measurement.projection?.components
            : applyContextMeasurementRecipe(components, entry.retainedRecipe);
        if (components === undefined) {
            throw new Error("Retained context measurement lost its components");
        }
        componentsByIndex.push(components);
    }
    const retained: SessionContextMeasurementEntry[] = [];
    let previous: readonly ContextProjectionComponent[] | undefined;
    for (const index of indexes) {
        const entry = entries[index]!;
        const current = componentsByIndex[index]!;
        retained.push({
            ...entry,
            measurement: aggregateContextMeasurement(entry.measurement),
            retainedRecipe: previous === undefined
                ? contextMeasurementKeyframe(current)
                : contextMeasurementDelta(previous, current),
        });
        previous = current;
    }
    entries.splice(0, entries.length, ...retained);
    state.contextMeasurementLastComponents = previous;
}

function contextMeasurementComponentsAt(
    entries: readonly SessionContextMeasurementEntry[],
    index: number,
): readonly ContextProjectionComponent[] | undefined {
    let components: readonly ContextProjectionComponent[] | undefined;
    for (let position = 0; position <= index; position += 1) {
        const entry = entries[position]!;
        components = entry.retainedRecipe === undefined
            ? entry.measurement.projection?.components
            : applyContextMeasurementRecipe(components, entry.retainedRecipe);
        if (components === undefined) return undefined;
    }
    return components;
}

function materializeContextMeasurement(
    entries: readonly SessionContextMeasurementEntry[],
    index: number,
): ContextMeasurement {
    const entry = entries[index]!;
    const components = contextMeasurementComponentsAt(entries, index);
    const projection = entry.measurement.projection;
    if (components === undefined || projection === undefined) {
        throw new Error("Retained context measurement lost its components");
    }
    return {
        ...entry.measurement,
        projection: {
            estimatedTokens: projection.estimatedTokens,
            components,
        },
    };
}

function reachableContextMeasurementIndexes(
    state: SessionProjectionState,
    afterMessageIds: readonly (string | null)[],
): Set<number> {
    const active = activeBranchEntries(state.messageEntries, state.leafId);
    const positionById = new Map(
        active.map((entry, index) => [entry.id, index] as const),
    );
    const points = new Set<number>([-1]);
    if (active.length > 0) points.add(active.length - 1);
    for (let index = 0; index < active.length; index += 1) {
        const entry = active[index]!;
        if (entry.message.role !== "user" || entry.message.internal === true) {
            continue;
        }
        points.add(
            entry.parentId === null
                ? -1
                : positionById.get(entry.parentId) ?? -1,
        );
    }

    const latestAt = new Map<number, number>();
    let latestNull = -1;
    for (let index = 0; index < afterMessageIds.length; index += 1) {
        const afterMessageId = afterMessageIds[index]!;
        if (afterMessageId === null) {
            latestNull = index;
            continue;
        }
        const position = positionById.get(afterMessageId);
        if (position !== undefined) latestAt.set(position, index);
    }

    const positions = [...latestAt.keys()].sort((left, right) => left - right);
    const sortedPoints = [...points].sort((left, right) => left - right);
    const kept = new Set<number>();
    let running = latestNull;
    let cursor = 0;
    for (const point of sortedPoints) {
        while (cursor < positions.length && positions[cursor]! <= point) {
            running = Math.max(running, latestAt.get(positions[cursor]!)!);
            cursor += 1;
        }
        if (running >= 0) kept.add(running);
    }
    return kept;
}

function parseHarnessMessageEntry(
    path: string,
    lineNumber: number,
    value: Record<string, unknown>,
): SessionHarnessMessageEntry {
    if (
        typeof value.timestamp !== "string"
        || Number.isNaN(Date.parse(value.timestamp))
        || (value.afterMessageId !== null
            && typeof value.afterMessageId !== "string")
        || typeof value.text !== "string"
        || value.text.trim().length === 0
        || (value.tone !== "primary"
            && value.tone !== "soft"
            && value.tone !== "error")
        || (value.crashCut !== undefined && value.crashCut !== true)
        || (value.unsentPrompts !== undefined
            && (!Array.isArray(value.unsentPrompts) || !value.unsentPrompts.every(isUnsentPrompt)))
    ) {
        throw invalidSession(
            path,
            `line ${lineNumber} is not a valid harness message entry`,
        );
    }
    return value as unknown as SessionHarnessMessageEntry;
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
        ...(value.source === undefined ? {} : { source: value.source }),
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
        || (attachment.source !== undefined && (
            typeof attachment.source !== "string"
            || !isAbsolute(attachment.source)
            || attachment.source.includes("\0")
            || Buffer.byteLength(attachment.source, "utf8") > 4096
        ))
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
    return parseHeaderRecord(path, parseJsonObject(path, 1, line));
}

export function parseHeaderRecord(
    path: string,
    value: Record<string, unknown>,
): SessionHeader {
    if (
        value.type !== "session"
        || value.version !== SESSION_FORMAT_VERSION
        || typeof value.id !== "string"
        || value.id.length === 0
        || typeof value.timestamp !== "string"
        || typeof value.cwd !== "string"
        || value.cwd.length === 0
        || (value.origin !== undefined && !isSessionOrigin(value.origin))
        || (value.parentId !== undefined
            && (typeof value.parentId !== "string" || value.parentId.length === 0))
        || (value.delegation !== undefined
            && !isSessionDelegation(value.delegation))
        || (value.delegation !== undefined
            && value.parentId !== undefined
            && (value.delegation as SessionDelegation).parentId !== value.parentId)
        || storedContextAssemblyModeInvalid(value)
        || (value.importedFrom !== undefined
            && !isSessionImportProvenance(value.importedFrom))
    ) {
        throw invalidSession(path, "line 1 is not a valid session header");
    }
    return headerFromRecord(value);
}

function storedContextAssemblyModeInvalid(
    value: Record<string, unknown>,
): boolean {
    const mode = storedContextAssemblyModeValue(value);
    return mode !== undefined
        && (!isContextAssemblyMode(mode) || mode === "default");
}

function storedContextAssemblyModeValue(
    value: Record<string, unknown>,
): unknown {
    if (
        value.contextAssemblyMode !== undefined
        && value.startupProfile !== undefined
        && value.contextAssemblyMode !== value.startupProfile
    ) {
        return "default";
    }
    return value.contextAssemblyMode ?? value.startupProfile;
}

function headerFromRecord(value: Record<string, unknown>): SessionHeader {
    const {
        startupProfile: _legacyStartupProfile,
        contextAssemblyMode: _rawMode,
        ...rest
    } = value;
    const mode = storedContextAssemblyModeValue(value);
    return {
        ...(rest as unknown as SessionHeader),
        ...(typeof mode === "string" && mode !== "default"
            ? { contextAssemblyMode: mode as Exclude<ContextAssemblyMode, "default"> }
            : {}),
    };
}

function validSessionDelegation(
    delegation: SessionDelegation,
): SessionDelegation {
    if (!isSessionDelegation(delegation)) {
        throw new Error("Cannot create a session with invalid delegation provenance");
    }
    return {
        kind: "subagent",
        parentId: delegation.parentId,
        models: delegation.models.map((settings) => ({ ...settings })),
    };
}

function isSessionDelegation(value: unknown): value is SessionDelegation {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const delegation = value as Record<string, unknown>;
    return delegation.kind === "subagent"
        && typeof delegation.parentId === "string"
        && delegation.parentId.length > 0
        && Array.isArray(delegation.models)
        && delegation.models.length > 0
        && delegation.models.every(isModelTurnSettings);
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
        (value.type !== "message" && value.type !== "turn_start")
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
        || (value.queuedPromptId !== undefined
            && (typeof value.queuedPromptId !== "string" || value.queuedPromptId.length === 0))
        || (value.unsentPrompts !== undefined
            && (!Array.isArray(value.unsentPrompts) || !value.unsentPrompts.every(isUnsentPrompt)
                || value.type !== "message" || !isRecord(value.message)
                || value.message.role !== "assistant" || value.message.stopReason !== "error"))
        || !isModelMessage(value.message)
    ) {
        throw invalidSession(
            path,
            `line ${lineNumber} is not a valid message entry`,
        );
    }
    return value.type === "turn_start"
        ? { ...value, type: "message" } as unknown as SessionMessageEntry
        : value as unknown as SessionMessageEntry;
}

function isUnsentPrompt(value: unknown): value is UnsentPrompt {
    return isRecord(value)
        && typeof value.content === "string"
        && (value.attachmentIds === undefined
            || (Array.isArray(value.attachmentIds)
                && value.attachmentIds.every((id) => typeof id === "string" && id.length > 0)));
}

function messageMatchesQueuedPrompt(message: ModelMessage, prompt: UnsentPrompt): boolean {
    if (message.role !== "user" || message.internal === true) return false;
    const text = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
    const attachments = message.content.flatMap((part) =>
        part.type === "image_attachment" ? [part.attachmentId] : []
    );
    return text === prompt.content
        && JSON.stringify(attachments) === JSON.stringify(prompt.attachmentIds ?? []);
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
        || (
            value.kind !== undefined
            && value.kind !== "attention"
            && value.kind !== "completion"
            && value.kind !== "peer"
        )
        || (value.sourceKind !== undefined && value.sourceKind !== "extension")
        || (value.peer !== undefined && (value.kind !== "peer" || !isPeerDeliveryFacts(value.peer)))
        || typeof value.timestamp !== "string"
    ) {
        throw invalidSession(
            path,
            `line ${lineNumber} is not a valid delivery entry`,
        );
    }
    return value as unknown as SessionDeliveryEntry;
}

function isPeerDeliveryFacts(value: unknown): value is PeerDeliveryFacts {
    return isRecord(value)
        && typeof value.fromLabel === "string"
        && value.fromLabel.length > 0
        && Number.isSafeInteger(value.messageId)
        && (value.messageId as number) > 0
        && (
            value.replyTo === undefined
            || (Number.isSafeInteger(value.replyTo) && (value.replyTo as number) > 0)
        );
}

// Key order is fixed so the stored-payload comparison does not depend on the caller's object.
function peerDeliveryFacts(facts: PeerDeliveryFacts): PeerDeliveryFacts {
    return {
        fromLabel: facts.fromLabel,
        messageId: facts.messageId,
        ...(facts.replyTo === undefined ? {} : { replyTo: facts.replyTo }),
    };
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
        ...(isSessionSettingOrigin(value.origin)
            ? { origin: value.origin }
            : {}),
        settings: {
            ...(settings.provider === undefined
                ? {}
                : { provider: settings.provider.trim() }),
            model: settings.model.trim(),
            ...("selectionCleared" in settings && settings.selectionCleared === true
                ? { selectionCleared: true } : {}),
            ...(settings.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: settings.reasoningEffort }),
        },
    };
}

interface ParsedContextMeasurement {
    readonly entry: SessionContextMeasurementEntry;
    readonly recipe?: ContextMeasurementRecipe;
}

function parseContextMeasurementEntry(
    path: string,
    lineNumber: number,
    value: Record<string, unknown>,
): ParsedContextMeasurement {
    if (
        typeof value.timestamp !== "string"
        || (value.afterMessageId !== null && typeof value.afterMessageId !== "string")
        || !isContextMeasurement(value.measurement)
        || value.measurement.projection === undefined
        || (value.contextRecipe !== undefined
            && !isContextMeasurementRecipe(value.contextRecipe))
    ) {
        throw invalidSession(
            path,
            `line ${lineNumber} is not a valid context measurement entry`,
        );
    }
    return {
        entry: {
            type: "context_measurement",
            timestamp: value.timestamp,
            afterMessageId: value.afterMessageId,
            measurement: value.measurement,
        },
        ...(value.contextRecipe === undefined
            ? {}
            : { recipe: value.contextRecipe }),
    };
}

function applyContextMeasurementEntry(
    path: string,
    lineNumber: number,
    parsed: ParsedContextMeasurement,
    state: SessionProjectionState,
): SessionContextMeasurementEntry {
    const recipe = parsed.recipe;
    const components = recipe === undefined
        ? parsed.entry.measurement.projection?.components
        : applyContextMeasurementRecipe(state.contextMeasurementBase, recipe);
    if (components === undefined) {
        throw invalidSession(
            path,
            `line ${lineNumber} is not a valid context measurement entry`,
        );
    }
    state.contextMeasurementBase = components;
    state.contextMeasurementLastRecordCompact = recipe !== undefined;
    state.contextMeasurementsSinceKeyframe = recipe === undefined || recipe.keyframe
        ? 0
        : state.contextMeasurementsSinceKeyframe + 1;
    if (recipe === undefined) return parsed.entry;
    return {
        ...parsed.entry,
        measurement: {
            ...parsed.entry.measurement,
            projection: {
                estimatedTokens: parsed.entry.measurement.projection!.estimatedTokens,
                components,
            },
        },
    };
}

function parseSelectedAgentEntry(
    path: string,
    lineNumber: number,
    value: Record<string, unknown>,
): SessionSelectedAgentEntry {
    const snapshot = value.snapshot;
    if (
        typeof value.timestamp !== "string"
        || typeof value.name !== "string"
        || value.name.length === 0
        || typeof snapshot !== "object"
        || snapshot === null
        || Reflect.get(snapshot, "name") !== value.name
        || typeof Reflect.get(snapshot, "instructions") !== "string"
    ) {
        throw invalidSession(
            path,
            `line ${lineNumber} is not a valid agent selection entry`,
        );
    }
    return {
        type: "agent_select",
        timestamp: value.timestamp,
        name: value.name,
        snapshot: structuredClone(snapshot) as AgentSnapshot,
    };
}

function parsePermissionsEntry(
    path: string,
    lineNumber: number,
    value: Record<string, unknown>,
): SessionPermissionsEntry {
    const mode = parseApprovalMode(value.mode);
    if (typeof value.timestamp !== "string" || mode === undefined) {
        throw invalidSession(
            path,
            `line ${lineNumber} is not a valid permissions entry`,
        );
    }
    return {
        type: "permissions",
        timestamp: value.timestamp,
        mode,
        ...(isSessionSettingOrigin(value.origin)
            ? { origin: value.origin }
            : {}),
    };
}

function isSessionSettingOrigin(
    value: unknown,
): value is SessionSettingOrigin {
    return value === "agent-default" || value === "user";
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

function parseSessionIdentityEntry(
    path: string,
    lineNumber: number,
    value: Record<string, unknown>,
): SessionIdentityEntry {
    if (
        typeof value.timestamp !== "string"
        || Number.isNaN(Date.parse(value.timestamp))
        || typeof value.name !== "string"
        || !isValidIdentityField(value.name)
        || typeof value.key !== "string"
        || !isValidIdentityField(value.key)
    ) {
        throw invalidSession(
            path,
            `line ${lineNumber} is not a valid session identity entry`,
        );
    }
    return {
        type: "session_identity",
        timestamp: value.timestamp,
        name: value.name,
        key: value.key,
    };
}

function parseLegacyCommandPrefixEntry(
    path: string,
    lineNumber: number,
    value: Record<string, unknown>,
): void {
    const prefix = isRecord(value.prefix) ? value.prefix.tokens : undefined;
    if (
        typeof value.timestamp !== "string"
        || !Array.isArray(prefix)
        || prefix.length === 0
        || !prefix.every((token) =>
            typeof token === "string" && token.length > 0
        )
    ) {
        throw invalidSession(
            path,
            `line ${lineNumber} is not a valid command prefix entry`,
        );
    }
}

function parsePermissionGrantsEntry(
    path: string,
    lineNumber: number,
    value: Record<string, unknown>,
): SessionPermissionGrantsEntry {
    if (
        typeof value.id !== "string"
        || value.id.length === 0
        || typeof value.timestamp !== "string"
        || !Array.isArray(value.grants)
        || value.grants.length === 0
    ) {
        throw invalidSession(
            path,
            `line ${lineNumber} is not a valid permission grants entry`,
        );
    }
    const grants: PermissionGrant[] = [];
    for (const grant of value.grants) {
        const migrated = isPermissionGrant(grant)
            ? grant
            : migratePermissionGrant(grant);
        if (migrated === undefined || isLegacyUnscopedGrant(migrated.when)) {
            continue;
        }
        grants.push(copyPermissionGrant(migrated));
    }
    return {
        type: "permission_grants",
        id: value.id,
        timestamp: value.timestamp,
        grants,
    };
}

function parsePermissionGrantRevocationEntry(
    path: string,
    lineNumber: number,
    value: Record<string, unknown>,
): SessionPermissionGrantRevocationEntry {
    if (
        typeof value.timestamp !== "string"
        || !Array.isArray(value.ids)
        || value.ids.length === 0
        || !value.ids.every((id) => typeof id === "string" && id.length > 0)
    ) {
        throw invalidSession(
            path,
            `line ${lineNumber} is not a valid permission grant revocation entry`,
        );
    }
    return {
        type: "permission_grant_revocation",
        timestamp: value.timestamp,
        ids: [...value.ids],
    };
}

function copyPermissionGrantProposal(
    proposal: PermissionGrantProposal,
): PermissionGrantProposal {
    return {
        kind: proposal.kind,
        when: { ...proposal.when },
        scope: proposal.scope,
        lifetime: proposal.lifetime,
    };
}

function copyPermissionGrant(grant: PermissionGrant): PermissionGrant {
    return {
        id: grant.id,
        ...copyPermissionGrantProposal(grant),
    };
}

function validateCompaction(
    request: AppendCompactionRequest,
    active: readonly SessionMessageEntry[],
): Omit<SessionCompactionEntry, "type" | "id" | "timestamp"> {
    const boundaryMessageId = nonEmpty(
        request.boundaryMessageId,
        "compaction boundary message ID",
    );
    const boundaryIndex = active.findIndex(
        (entry) => entry.id === boundaryMessageId,
    );
    if (boundaryIndex === -1) {
        throw new Error(
            `Compaction boundary ${boundaryMessageId} is not an active message`,
        );
    }
    const barrierIndex = active.findIndex((entry) =>
        entry.message.role === "user"
        && entry.message.compactionBarrier === true
    );
    if (barrierIndex !== -1 && boundaryIndex >= barrierIndex) {
        throw new Error("Compaction cannot cross a model-context barrier");
    }
    if (request.projection.length === 0) {
        throw new Error("Compaction projection cannot be empty");
    }
    if (!request.projection.every(isModelMessage)) {
        throw new Error("Compaction projection contains an invalid message");
    }
    assertToolCallsPaired(request.projection, "Compaction projection");
    const retained = request.firstRetainedMessageId;
    const successor = active[boundaryIndex + 1];
    if (retained !== (successor?.id ?? null)) {
        throw new Error(
            "Compaction must retain the message following its boundary",
        );
    }
    if (successor?.message.role === "tool_result") {
        throw new Error(
            "Compaction retains a tool result whose call it compacted away",
        );
    }
    const measured = validateCompactionMeasurement(request.measured);
    return {
        boundaryMessageId,
        firstRetainedMessageId: retained,
        projection: request.projection,
        measured,
        ...(request.diagnostics === undefined
            ? {}
            : { diagnostics: { ...request.diagnostics } }),
        ...(request.billed === undefined ? {} : { billed: request.billed }),
    };
}

function validateCompactionMeasurement(
    measured: SessionCompactionMeasurement,
): SessionCompactionMeasurement {
    if (
        !Number.isSafeInteger(measured.inputTokens)
        || measured.inputTokens < 0
        || (measured.contextWindow !== undefined
            && (!Number.isSafeInteger(measured.contextWindow)
                || measured.contextWindow <= 0))
        || (measured.model !== undefined
            && (typeof measured.model !== "string"
                || measured.model.length === 0))
        || typeof measured.estimated !== "boolean"
    ) {
        throw new Error("Compaction measurement is not a usable reading");
    }
    return {
        inputTokens: measured.inputTokens,
        ...(measured.contextWindow === undefined
            ? {}
            : { contextWindow: measured.contextWindow }),
        ...(measured.model === undefined ? {} : { model: measured.model }),
        estimated: measured.estimated,
    };
}

function compactionApplies(
    entry: SessionCompactionEntry,
    active: readonly SessionMessageEntry[],
): boolean {
    const boundaryIndex = active.findIndex(
        (candidate) => candidate.id === entry.boundaryMessageId,
    );
    if (boundaryIndex === -1) {
        return false;
    }
    const barrierIndex = active.findIndex((candidate) =>
        candidate.message.role === "user"
        && candidate.message.compactionBarrier === true
    );
    if (barrierIndex !== -1 && boundaryIndex >= barrierIndex) {
        return false;
    }
    const successor = active[boundaryIndex + 1];
    if (successor === undefined) {
        return entry.firstRetainedMessageId === null;
    }
    return successor.message.role !== "tool_result"
        && (
            entry.firstRetainedMessageId === null
            || entry.firstRetainedMessageId === successor.id
        );
}

function parseCompactionEntry(
    path: string,
    lineNumber: number,
    value: Record<string, unknown>,
): SessionCompactionEntry {
    if (
        typeof value.id !== "string"
        || value.id.length === 0
        || typeof value.timestamp !== "string"
        || typeof value.boundaryMessageId !== "string"
        || value.boundaryMessageId.length === 0
        || (
            value.firstRetainedMessageId !== null
            && typeof value.firstRetainedMessageId !== "string"
        )
        || !Array.isArray(value.projection)
        || value.projection.length === 0
        || !value.projection.every(isModelMessage)
        || !isCompactionMeasurement(value.measured)
    ) {
        throw invalidSession(
            path,
            `line ${lineNumber} is not a valid compaction entry`,
        );
    }
    return value as unknown as SessionCompactionEntry;
}

function parseAskEntry(
    path: string,
    lineNumber: number,
    value: Record<string, unknown>,
): SessionAskEntry {
    const billed = value.billed as Record<string, unknown> | undefined;
    if (
        typeof value.id !== "string"
        || value.id.length === 0
        || typeof value.timestamp !== "string"
        || typeof billed !== "object"
        || billed === null
        || typeof billed.provider !== "string"
        || typeof billed.model !== "string"
        || typeof billed.usage !== "object"
        || billed.usage === null
    ) {
        throw invalidSession(
            path,
            `line ${lineNumber} is not a valid session ask entry`,
        );
    }
    return value as unknown as SessionAskEntry;
}

function isCompactionMeasurement(
    value: unknown,
): value is SessionCompactionMeasurement {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const measured = value as Record<string, unknown>;
    return Number.isSafeInteger(measured.inputTokens)
        && (measured.inputTokens as number) >= 0
        && (measured.contextWindow === undefined
            || (Number.isSafeInteger(measured.contextWindow)
                && (measured.contextWindow as number) > 0))
        && (measured.model === undefined
            || (typeof measured.model === "string"
                && measured.model.length > 0))
        && typeof measured.estimated === "boolean";
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

function isHookContextSource(value: unknown): boolean {
    return value === "session_start" || value === "pre_turn" || value === "turn_ending";
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
        return (message.contextSource === undefined
            || (isHookContextSource(message.contextSource) && message.internal === true))
            && (message.hookSource === undefined
                || (typeof message.hookSource === "string"
                    && message.hookSource.length > 0
                    && message.contextSource !== undefined))
            && (message.hookDisplay === undefined
                || (isHookDisplay(message.hookDisplay)
                    && (message.contextSource === "pre_turn"
                        || message.contextSource === "turn_ending")))
            && (message.internal === undefined
                || typeof message.internal === "boolean")
            && (message.compactionBarrier === undefined
                || typeof message.compactionBarrier === "boolean")
            && (message.arrivedDuringTurn === undefined
                || typeof message.arrivedDuringTurn === "boolean")
            && message.content.every((content) =>
                isTextContent(content) || isImageAttachmentContent(content)
            );
    }
    if (message.role === "tool_result") {
        return (message.internal === undefined
            || typeof message.internal === "boolean")
            && typeof message.toolCallId === "string"
            && typeof message.toolName === "string"
            && typeof message.isError === "boolean"
            && (message.processId === undefined
                || (typeof message.processId === "string"
                    && message.processId.length > 0))
            && (message.presentation === undefined
                || isToolPresentation(message.presentation))
            && (message.toolResultSource === undefined
                || isToolResultSource(message.toolResultSource))
            && (message.classifierOutcome === undefined
                || isClassifierOutcome(message.classifierOutcome))
            && (message.withheld === undefined || message.withheld === true)
            && message.content.every(isTextContent);
    }
    if (message.role !== "assistant") {
        return false;
    }
    return (message.internal === undefined
        || typeof message.internal === "boolean")
        && isModelSource(message.source)
        && isModelUsage(message.usage)
        && (message.durationMs === undefined
            || (typeof message.durationMs === "number"
                && Number.isFinite(message.durationMs)
                && message.durationMs >= 0))
        && (message.turnTiming === undefined || isTurnTiming(message.turnTiming))
        && isModelStopReason(message.stopReason)
        && (message.errorMessage === undefined
            || typeof message.errorMessage === "string")
        && (message.steered === undefined || message.steered === true)
        && message.content.every(isAssistantContent);
}

function isToolResultSource(value: unknown): boolean {
    if (!isRecord(value)) return false;
    return Number.isSafeInteger(value.originalBytes)
        && (value.originalBytes as number) >= 0
        && (value.spillPath === undefined
            || (typeof value.spillPath === "string"
                && value.spillPath.length > 0));
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
    return Number.isFinite(value.inputTokens)
        && Number.isFinite(value.outputTokens)
        && Number.isFinite(value.cachedInputTokens)
        && (value.cacheWriteInputTokens === undefined
            || Number.isFinite(value.cacheWriteInputTokens))
        && Number.isFinite(value.reasoningTokens)
        && Number.isFinite(value.totalTokens)
        && (value.cost === undefined || Number.isFinite(value.cost));
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

function validIdentityField(value: string, label: string): string {
    if (!isValidIdentityField(value)) {
        throw new Error(`${label} must be 1 to 200 UTF-8 bytes`);
    }
    return value;
}

function isValidIdentityField(value: string): boolean {
    return value.length > 0
        && value === value.trim()
        && !value.includes("\0")
        && !value.includes("\n")
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
