import { isTurnTiming } from "../model/types.ts";
import { randomUUID } from "node:crypto";
import {
    chmod,
    mkdir,
    open,
    readFile,
    rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
import { migratePermissionGrant } from "../engine/permission-compat.ts";
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
import { veraRuntimeDirectory } from "../profile-paths.ts";
import {
    isContextMeasurement,
    type ContextMeasurement,
} from "../engine/context-measurement.ts";

export const SESSION_FORMAT_VERSION = 1;

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
    readonly message: ModelMessage;
}

export interface PendingDelivery {
    readonly id: string;
    readonly sourceAgentId: string;
    readonly content: string;
    readonly kind?: "attention" | "completion" | "peer";
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

export interface CreateSessionStoreOptions {
    readonly sessionId: string;
    readonly cwd: string;
    readonly origin?: SessionOrigin;
    readonly parentId?: string;
    readonly delegation?: SessionDelegation;
    readonly contextAssemblyMode?: Exclude<ContextAssemblyMode, "default">;
    readonly now?: () => Date;
    readonly createId?: () => string;
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
    readonly onRecordAppended?: (
        lineNumber: number,
        record: Record<string, unknown>,
    ) => void;
}

export interface StoredMessage {
    readonly id: string;
    readonly message: ModelMessage;
}

export interface SessionMessageStore {
    appendMessage(message: ModelMessage): Promise<StoredMessage>;
}

export interface ReadonlySessionSnapshot {
    readonly header: SessionHeader;
    readonly messages: readonly ModelMessage[];
    readonly messageIds: ReadonlyMap<ModelMessage, string>;
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
        };

        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        let created = false;
        try {
            const file = await open(path, "wx", 0o600);
            created = true;
            try {
                await file.chmod(0o600);
                await file.writeFile(jsonLine(header), "utf8");
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

    usageMessages(): readonly AssistantMessage[] {
        const replies = this.projection.messageEntries.map((entry) => entry.message)
            .filter((message): message is AssistantMessage => message.role === "assistant" && message.source.api !== "none");
        const compactions = this.projection.compactionEntries.flatMap((entry): AssistantMessage[] =>
            entry.billed === undefined ? [] : [{
                role: "assistant", content: [], stopReason: "stop",
                source: { provider: entry.billed.provider, model: entry.billed.model, api: "compaction" },
                usage: entry.billed.usage,
            }]);
        return [...replies, ...compactions];
    }

    activeMessageIds(): ReadonlyMap<ModelMessage, string> {
        const ids = new Map<ModelMessage, string>();
        for (const entry of this.activeEntries()) {
            ids.set(entry.message, entry.id);
        }
        return ids;
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
        const entries = this.activeEntries();
        const lastDeliveryIndex = entries.findLastIndex(
            (entry) => entry.deliveryId !== undefined,
        );
        if (lastDeliveryIndex === -1) return false;
        return !entries.slice(lastDeliveryIndex + 1).some(
            (entry) =>
                entry.message.role === "assistant"
                && entry.message.stopReason !== "tool_use",
        );
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
    ): Promise<SessionHarnessMessageEntry> {
        const result = this.pendingAppend.then(() => {
            this.requireActive();
            return this.commitHarnessMessage(text, tone);
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
        return this.projection.contextMeasurementEntries.findLast((entry) =>
            entry.afterMessageId === null
            || active.has(entry.afterMessageId)
        )?.measurement;
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
        const entry: SessionMessageEntry = {
            type: "message",
            id: nonEmpty(this.createId(), "message entry ID"),
            parentId: this.projection.leafId,
            timestamp: this.now().toISOString(),
            ...(deliveryId === undefined ? {} : { deliveryId }),
            message: snapshot,
        };
        if (this.projection.messageEntries.some((candidate) => candidate.id === entry.id)) {
            throw new Error(`Session entry ID ${entry.id} already exists`);
        }

        await this.appendRecord(entry);

        this.projection.messageEntries.push(entry);
        this.projection.knownMessageIds.add(entry.id);
        this.projection.leafId = entry.id;
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
        await this.appendRecord(entry);
        this.projection.contextMeasurementEntries.push(entry);
        return entry;
    }

    private async commitHarnessMessage(
        requestedText: string,
        tone: "primary" | "soft" | "error",
    ): Promise<SessionHarnessMessageEntry> {
        const text = requestedText.trim();
        if (text.length === 0) {
            throw new Error("Cannot append an empty harness message");
        }
        const entry: SessionHarnessMessageEntry = {
            type: "harness_message",
            timestamp: this.now().toISOString(),
            afterMessageId: this.projection.leafId,
            text,
            tone,
        };
        await this.appendRecord(entry);
        this.projection.harnessMessageEntries.push(entry);
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
        return entry;
    }

    private async commitDelivery(delivery: PendingDelivery): Promise<boolean> {
        const id = nonEmpty(delivery.id, "delivery ID");
        const kind = delivery.kind ?? "completion";
        if (kind !== "attention" && kind !== "completion" && kind !== "peer") {
            throw new Error("delivery kind must be attention, completion or peer");
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

    appendForeignRecord(
        record: Record<string, unknown>,
    ): Promise<number> {
        const result = this.pendingAppend.then(async () => {
            if (this.projection.agentFailure !== undefined) {
                throw new Error(
                    "Cannot append after the terminal agent failure",
                );
            }
            const lineNumber = await this.writeRecordLine(record);
            ingestSessionRecord(this.path, lineNumber, record, this.projection);
            return lineNumber;
        });
        this.pendingAppend = result.then(() => {}, () => {});
        return result;
    }

    private async writeRecordLine(record: object): Promise<number> {
        const file = await open(this.path, "a", 0o600);
        try {
            await file.writeFile(jsonLine(record), "utf8");
            await file.sync();
        } finally {
            await file.close();
        }
        this.lineCount += 1;
        return this.lineCount;
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
                    record.type === "message"
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

export function defaultSessionDirectory(): string {
    return join(veraRuntimeDirectory(), "sessions");
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
        messageIds: new Map(active.map((entry) => [entry.message, entry.id])),
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
    readonly contextMeasurementEntries: SessionContextMeasurementEntry[];
    readonly knownMessageIds: Set<string>;
    readonly knownDeliveryIds: Set<string>;
    readonly knownAttachmentIds: Set<string>;
    agentFailure: SessionAgentFailureEntry | undefined;
    leafId: string | null;
}

export function createSessionProjectionState(): SessionProjectionState {
    return {
        messageEntries: [],
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
        contextMeasurementEntries: [],
        knownMessageIds: new Set(),
        knownDeliveryIds: new Set(),
        knownAttachmentIds: new Set(),
        agentFailure: undefined,
        leafId: null,
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
        contextMeasurementEntries,
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
        knownMessageIds.add(entry.id);
        messageEntries.push(entry);
        state.leafId = entry.id;
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
        harnessMessageEntries.push(
            parseHarnessMessageEntry(path, lineNumber, value),
        );
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
        return;
    }
    if (value.type === "compaction") {
        compactionEntries.push(
            parseCompactionEntry(path, lineNumber, value),
        );
        return;
    }
    if (value.type === "context_measurement") {
        contextMeasurementEntries.push(
            parseContextMeasurementEntry(path, lineNumber, value),
        );
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

    for (let index = 1; index < lines.length; index += 1) {
        const lineNumber = index + 1;
        ingestSessionRecord(
            path,
            lineNumber,
            parseJsonObject(path, lineNumber, lines[index]),
            state,
        );
    }

    return { header, state, lineCount: lines.length };
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
        || (
            value.kind !== undefined
            && value.kind !== "attention"
            && value.kind !== "completion"
            && value.kind !== "peer"
        )
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

function parseContextMeasurementEntry(
    path: string,
    lineNumber: number,
    value: Record<string, unknown>,
): SessionContextMeasurementEntry {
    if (
        typeof value.timestamp !== "string"
        || (value.afterMessageId !== null && typeof value.afterMessageId !== "string")
        || !isContextMeasurement(value.measurement)
        || value.measurement.projection === undefined
    ) {
        throw invalidSession(
            path,
            `line ${lineNumber} is not a valid context measurement entry`,
        );
    }
    return {
        type: "context_measurement",
        timestamp: value.timestamp,
        afterMessageId: value.afterMessageId,
        measurement: value.measurement,
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
        if (migrated === undefined) {
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
            || (message.contextSource === "session_start" && message.internal === true))
            && (message.internal === undefined
                || typeof message.internal === "boolean")
            && (message.compactionBarrier === undefined
                || typeof message.compactionBarrier === "boolean")
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

function isToolPresentation(value: unknown): boolean {
    if (!isRecord(value)) return false;
    if (value.kind === "unified_diff") {
        return typeof value.path === "string"
            && value.path.length > 0
            && typeof value.patch === "string"
            && value.patch.length > 0;
    }
    return value.kind === "tool_notice"
        && typeof value.text === "string"
        && value.text.trim().length > 0;
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
