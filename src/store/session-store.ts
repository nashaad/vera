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

import type { AgentWearSnapshot } from "../agents/wear.ts";
import type { ModelMessage } from "../model/types.ts";
import { assertToolCallsPaired } from "../model/tool-pairing.ts";
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
    isStartupProfile,
    type StartupProfile,
} from "../startup-profile.ts";
import { veraRuntimeDirectory } from "../profile-paths.ts";

export const SESSION_FORMAT_VERSION = 1;

export interface SessionHeader {
    readonly type: "session";
    readonly version: typeof SESSION_FORMAT_VERSION;
    readonly id: string;
    readonly timestamp: string;
    readonly cwd: string;
    readonly origin?: SessionOrigin;
    /** Session ID of the agent that spawned this one as a subagent. */
    readonly parentId?: string;
    readonly startupProfile?: Exclude<StartupProfile, "default">;
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

/**
 * Where a session-scoped setting came from.
 *
 * `agent-default` means nobody dialed it: the setting is whatever the worn
 * agent's default was at the time, and it follows the next agent you wear.
 * `user` means it was chosen deliberately and survives an agent switch. A
 * record written before origins existed reads as `user`, because a legacy
 * session's setting was always the user's own.
 */
export type SessionSettingOrigin = "agent-default" | "user";

export interface SessionModelSettingsEntry {
    readonly type: "model_settings";
    readonly timestamp: string;
    readonly settings: ModelTurnSettings;
    readonly origin?: SessionSettingOrigin;
}

/**
 * The agent worn from this point on, with the definition as it resolved then.
 *
 * Append-only, and the latest wins. The header is written once at creation, so
 * a field there could record the agent a session started under and nothing
 * after it — and switching agents mid-session is the ordinary case.
 */
export interface SessionAgentWearEntry {
    readonly type: "agent_wear";
    readonly timestamp: string;
    readonly name: string;
    readonly snapshot: AgentWearSnapshot;
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

export interface SessionPermissionGrantsEntry {
    readonly type: "permission_grants";
    readonly id: string;
    readonly timestamp: string;
    readonly grants: readonly PermissionGrant[];
}

/**
 * Revoking a session grant, which the log records by appending rather than by
 * editing. The session file is append-only, so a revocation has to be its own
 * entry that `permissionGrants()` subtracts. Keeping revocations in memory
 * instead would resurrect a revoked grant on resume, which is the one direction
 * a permission surface must never move on its own.
 */
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

/**
 * A compaction never rewrites or removes a message. It appends the context the
 * model should be sent instead, anchored to the messages it stands for, so the
 * original transcript stays readable and a session that outlives whatever
 * produced the projection can still be resumed from the file alone.
 */
export interface SessionCompactionEntry {
    readonly type: "compaction";
    readonly id: string;
    readonly timestamp: string;
    /** Compacted through, inclusive. */
    readonly boundaryMessageId: string;
    /** Inclusive start of the suffix kept verbatim, or null for none. */
    readonly firstRetainedMessageId: string | null;
    readonly projection: readonly ModelMessage[];
    readonly measured: SessionCompactionMeasurement;
    readonly diagnostics?: SessionCompactionDiagnostics;
}

export interface SessionCompactionMeasurement {
    readonly inputTokens: number;
    /** Absent when the model's window was never discovered. */
    readonly contextWindow?: number;
    readonly estimated: boolean;
}

export interface SessionCompactionDiagnostics {
    readonly strategy: string;
    readonly route?: string;
    readonly catalogEntry?: string;
}

export interface AppendCompactionRequest {
    readonly boundaryMessageId: string;
    readonly firstRetainedMessageId: string | null;
    readonly projection: readonly ModelMessage[];
    readonly measured: SessionCompactionMeasurement;
    readonly diagnostics?: SessionCompactionDiagnostics;
}

export interface CreateSessionStoreOptions {
    readonly sessionId: string;
    readonly cwd: string;
    readonly origin?: SessionOrigin;
    readonly parentId?: string;
    readonly startupProfile?: Exclude<StartupProfile, "default">;
    readonly now?: () => Date;
    readonly createId?: () => string;
}

export interface SessionCreationMetadata {
    readonly startupProfile?: Exclude<StartupProfile, "default">;
}

export interface OpenSessionStoreOptions {
    readonly now?: () => Date;
    readonly createId?: () => string;
}

/** The stored identity and retained snapshot reported by an append. */
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

interface LoadedSessionFile {
    readonly header: SessionHeader;
    readonly messageEntries: SessionMessageEntry[];
    readonly deliveryEntries: SessionDeliveryEntry[];
    readonly deliveryReceipts: Set<string>;
    readonly legacyDeliveryMessageIds: Map<string, string>;
    readonly modelSettingsEntries: SessionModelSettingsEntry[];
    readonly agentWearEntries: SessionAgentWearEntry[];
    readonly permissionsEntries: SessionPermissionsEntry[];
    readonly harnessMessageEntries: SessionHarnessMessageEntry[];
    readonly nameEntries: SessionNameEntry[];
    readonly permissionGrantEntries: SessionPermissionGrantsEntry[];
    readonly permissionGrantRevocationEntries:
        SessionPermissionGrantRevocationEntry[];
    readonly attachmentEntries: SessionAttachmentEntry[];
    readonly compactionEntries: SessionCompactionEntry[];
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
    private readonly agentWearEntries: SessionAgentWearEntry[];
    private readonly permissionsEntries: SessionPermissionsEntry[];
    private readonly harnessMessageEntries: SessionHarnessMessageEntry[];
    private readonly nameEntries: SessionNameEntry[];
    private readonly permissionGrantEntries: SessionPermissionGrantsEntry[];
    private readonly permissionGrantRevocationEntries:
        SessionPermissionGrantRevocationEntry[];
    private readonly attachmentEntries: SessionAttachmentEntry[];
    private readonly compactionEntries: SessionCompactionEntry[];
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
        this.agentWearEntries = loaded.agentWearEntries;
        this.permissionsEntries = loaded.permissionsEntries;
        this.harnessMessageEntries = loaded.harnessMessageEntries;
        this.nameEntries = loaded.nameEntries;
        this.permissionGrantEntries = loaded.permissionGrantEntries;
        this.permissionGrantRevocationEntries =
            loaded.permissionGrantRevocationEntries;
        this.attachmentEntries = loaded.attachmentEntries;
        this.compactionEntries = loaded.compactionEntries;
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
            ...(options.parentId === undefined
                ? {}
                : { parentId: nonEmpty(options.parentId, "session parent ID") }),
            ...(options.startupProfile === undefined
                ? {}
                : { startupProfile: options.startupProfile }),
        };

        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        let created = false;
        try {
            const file = await open(path, "wx", 0o600);
            created = true;
            try {
                await file.chmod(0o600);
                await file.writeFile(jsonLine(header), "utf8");
                // An empty session has no user work to make crash-durable yet.
                // The first append fsyncs this header together with the first
                // record; forcing a disk barrier here made /clear wait seconds
                // on some filesystems for a chat Resume intentionally hides.
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
            {
                header,
                messageEntries: [],
                deliveryEntries: [],
                deliveryReceipts: new Set(),
                legacyDeliveryMessageIds: new Map(),
                modelSettingsEntries: [],
                agentWearEntries: [],
                permissionsEntries: [],
                harnessMessageEntries: [],
                nameEntries: [],
                permissionGrantEntries: [],
                permissionGrantRevocationEntries: [],
                attachmentEntries: [],
                compactionEntries: [],
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

    /**
     * Pairs each active message with its stored ID. Keyed by the same object
     * `messages()` returns, so a projection built from either stays aligned.
     */
    activeMessageIds(): ReadonlyMap<ModelMessage, string> {
        const ids = new Map<ModelMessage, string>();
        for (const entry of this.activeEntries()) {
            ids.set(entry.message, entry.id);
        }
        return ids;
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
        const settings = this.modelSettingsEntries.at(-1)?.settings;
        return settings === undefined ? undefined : { ...settings };
    }

    /**
     * Where the model settings in force came from, or nothing when the session
     * has never written any.
     *
     * No record at all is not the same as a `user` record: a session nobody
     * dialed follows the worn agent's default, and the status line says so by
     * leaving the override marker off.
     */
    modelSettingsOrigin(): SessionSettingOrigin | undefined {
        const entry = this.modelSettingsEntries.at(-1);
        return entry === undefined ? undefined : entry.origin ?? "user";
    }

    /**
     * Every model setting this session has held, oldest first.
     *
     * Read-only, and the reason the dial strip has no store of its own:
     * recents are derived from what the session did rather than remembered
     * beside it, so they cannot drift from it.
     */
    modelSettingsHistory(): readonly SessionModelSettingsEntry[] {
        return this.modelSettingsEntries.map((entry) => ({
            ...entry,
            settings: { ...entry.settings },
            origin: entry.origin ?? "user",
        }));
    }

    /** The agent in force, or nothing when this session has never worn one. */
    agentWear(): SessionAgentWearEntry | undefined {
        const entry = this.agentWearEntries.at(-1);
        return entry === undefined ? undefined : structuredClone(entry);
    }

    appendAgentWear(
        name: string,
        snapshot: AgentWearSnapshot,
    ): Promise<SessionAgentWearEntry> {
        const result = this.pendingAppend.then(() => {
            this.requireActive();
            return this.commitAgentWear(name, snapshot);
        });
        this.pendingAppend = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    private async commitAgentWear(
        name: string,
        snapshot: AgentWearSnapshot,
    ): Promise<SessionAgentWearEntry> {
        if (name.length === 0 || snapshot.name !== name) {
            throw new Error("Cannot append an agent wear with a mismatched name");
        }
        const entry: SessionAgentWearEntry = {
            type: "agent_wear",
            timestamp: this.now().toISOString(),
            name,
            snapshot: structuredClone(snapshot),
        };
        await this.appendRecord(entry);
        this.agentWearEntries.push(entry);
        return entry;
    }

    approvalMode(): ApprovalMode | undefined {
        return this.permissionsEntries.at(-1)?.mode;
    }

    approvalModeOrigin(): SessionSettingOrigin | undefined {
        const entry = this.permissionsEntries.at(-1);
        return entry === undefined ? undefined : entry.origin ?? "user";
    }

    name(): string | undefined {
        return this.nameEntries.at(-1)?.name ?? undefined;
    }

    permissionGrants(): readonly PermissionGrant[] {
        const revoked = new Set(
            this.permissionGrantRevocationEntries.flatMap((entry) => entry.ids),
        );
        return this.permissionGrantEntries.flatMap((entry) =>
            entry.grants
                .filter((grant) => !revoked.has(grant.id))
                .map(copyPermissionGrant)
        );
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
        return projectHarnessMessages(this.harnessMessageEntries, active);
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

    /**
     * Revokes one live session grant, reporting whether it was live. An ID that
     * is unknown or already revoked writes nothing, so a client cannot grow the
     * log by retrying a stale ID.
     */
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
        // Copied on the way in, not at commit: the request waits behind
        // whatever is already queued, and the caller still holds the arrays.
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

    /**
     * The compaction that currently applies, or undefined when none does. A
     * rewind past the boundary leaves the record in the file but unresolvable
     * on the active branch, which is how a compaction is undone: by the
     * history moving out from under it, never by deleting what was written.
     */
    latestCompaction(): SessionCompactionEntry | undefined {
        const active = this.activeEntries();
        return this.compactionEntries.findLast(
            (entry) => compactionApplies(entry, active),
        );
    }

    /**
     * What the model should be sent: the accepted projection followed by the
     * messages kept verbatim after it. Distinct from `messages()`, which stays
     * the original transcript so clients keep showing what was really said.
     *
     * The suffix is everything past the boundary as the branch stands now, not
     * a span fixed when the record was written. A record is a statement about
     * its prefix only; the turns that follow it, including ones appended after
     * it was accepted, are still owed to the model.
     */
    modelContext(): readonly ModelMessage[] {
        const compaction = this.latestCompaction();
        if (compaction === undefined) {
            return this.messages();
        }
        const active = this.activeEntries();
        const boundary = active.findIndex(
            (entry) => entry.id === compaction.boundaryMessageId,
        );
        return [
            ...compaction.projection,
            ...active.slice(boundary + 1).map((entry) => entry.message),
        ];
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
                ...(settings.reasoningEffort === undefined
                    ? {}
                    : { reasoningEffort: settings.reasoningEffort }),
            },
            ...(origin === undefined ? {} : { origin }),
        };
        await this.appendRecord(entry);
        this.modelSettingsEntries.push(entry);
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
            afterMessageId: this.leafId,
            text,
            tone,
        };
        await this.appendRecord(entry);
        this.harnessMessageEntries.push(entry);
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
        this.permissionGrantEntries.push(entry);
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
        this.permissionGrantRevocationEntries.push(entry);
        return true;
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

    private async commitCompaction(
        request: AppendCompactionRequest,
    ): Promise<SessionCompactionEntry> {
        for (const message of request.projection) {
            for (const attachmentId of messageAttachmentIds(message)) {
                if (!this.attachmentEntries.some(
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
        this.compactionEntries.push(entry);
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
        const existing = this.deliveryEntries.find((entry) => entry.id === id);
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
        const source = buffer.subarray(0, length).toString("utf8");
        const lines = source.split("\n");
        const header = parseHeader(path, lines.shift() ?? "");
        let firstPrompt: string | undefined;
        let hasUserContent = false;
        let name: string | null | undefined;
        for (const line of lines.slice(0, -1)) {
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
    return join(veraRuntimeDirectory(), "sessions");
}

export async function readSessionSnapshot(
    path: string,
): Promise<ReadonlySessionSnapshot> {
    const source = await readFile(path, "utf8");
    const loaded = parseSessionFile(path, completeSessionSource(path, source));
    const active = activeBranchEntries(loaded.messageEntries, loaded.leafId);
    return {
        header: loaded.header,
        messages: active.map((entry) => entry.message),
        messageIds: new Map(active.map((entry) => [entry.message, entry.id])),
        harnessMessages: projectHarnessMessages(
            loaded.harnessMessageEntries,
            active,
        ),
        ...(loaded.agentFailure === undefined
            ? {}
            : { agentFailure: { ...loaded.agentFailure } }),
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

function parseSessionFile(path: string, source: string): LoadedSessionFile {
    const lines = source.slice(0, -1).split("\n");
    const header = parseHeader(path, lines[0]);
    const messageEntries: SessionMessageEntry[] = [];
    const deliveryEntries: SessionDeliveryEntry[] = [];
    const deliveryReceipts = new Set<string>();
    const legacyDeliveryMessageIds = new Map<string, string>();
    const modelSettingsEntries: SessionModelSettingsEntry[] = [];
    const agentWearEntries: SessionAgentWearEntry[] = [];
    const permissionsEntries: SessionPermissionsEntry[] = [];
    const harnessMessageEntries: SessionHarnessMessageEntry[] = [];
    const nameEntries: SessionNameEntry[] = [];
    const permissionGrantEntries: SessionPermissionGrantsEntry[] = [];
    const permissionGrantRevocationEntries:
        SessionPermissionGrantRevocationEntry[] = [];
    const attachmentEntries: SessionAttachmentEntry[] = [];
    const compactionEntries: SessionCompactionEntry[] = [];
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
        if (value.type === "agent_wear") {
            agentWearEntries.push(
                parseAgentWearEntry(path, lineNumber, value),
            );
            continue;
        }
        if (value.type === "permissions") {
            permissionsEntries.push(
                parsePermissionsEntry(path, lineNumber, value),
            );
            continue;
        }
        if (value.type === "harness_message") {
            harnessMessageEntries.push(
                parseHarnessMessageEntry(path, lineNumber, value),
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
            parseLegacyCommandPrefixEntry(path, lineNumber, value);
            continue;
        }
        if (value.type === "permission_grants") {
            permissionGrantEntries.push(
                parsePermissionGrantsEntry(path, lineNumber, value),
            );
            continue;
        }
        if (value.type === "permission_grant_revocation") {
            permissionGrantRevocationEntries.push(
                parsePermissionGrantRevocationEntry(path, lineNumber, value),
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
        if (value.type === "compaction") {
            compactionEntries.push(
                parseCompactionEntry(path, lineNumber, value),
            );
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
        agentWearEntries,
        permissionsEntries,
        harnessMessageEntries,
        nameEntries,
        permissionGrantEntries,
        permissionGrantRevocationEntries,
        attachmentEntries,
        compactionEntries,
        agentFailure,
        leafId,
    };
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
        || (value.parentId !== undefined
            && (typeof value.parentId !== "string" || value.parentId.length === 0))
        || (value.startupProfile !== undefined
            && (!isStartupProfile(value.startupProfile)
                || value.startupProfile === "default"))
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
            // Entries written before providers were persisted have no
            // provider. They stay absent here so the resume path can tell
            // "unrecorded" from "recorded" and fall back to the default only
            // for the former.
            ...(settings.provider === undefined
                ? {}
                : { provider: settings.provider.trim() }),
            model: settings.model.trim(),
            ...(settings.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: settings.reasoningEffort }),
        },
    };
}

function parseAgentWearEntry(
    path: string,
    lineNumber: number,
    value: Record<string, unknown>,
): SessionAgentWearEntry {
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
            `line ${lineNumber} is not a valid agent wear entry`,
        );
    }
    return {
        type: "agent_wear",
        timestamp: value.timestamp,
        name: value.name,
        snapshot: structuredClone(snapshot) as AgentWearSnapshot,
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

/** A written origin, refused rather than guessed when it is anything else. */
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
    // Grants written before the permission model was simplified are migrated
    // when the rename preserves meaning, and dropped otherwise. Dropping a
    // grant only means the user is asked again, so it is the safe direction.
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
    // Revoked IDs are not checked against the grants seen so far. A revocation
    // naming a grant that was dropped by migration is harmless, and rejecting it
    // would make an old session unloadable over a permission the user already
    // gave up.
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

/**
 * A record is only worth writing if the context it describes can be sent. The
 * anchors have to resolve on the branch that is live now, and the seam between
 * the projection and the retained suffix cannot split a tool call from its
 * result: a provider rejects an unmatched pair outright, and it would do so on
 * every later turn of a session whose original history is still intact.
 */
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
        // Anything other than the message directly after the boundary would
        // drop the messages in between without the record saying so.
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
        || typeof measured.estimated !== "boolean"
    ) {
        throw new Error("Compaction measurement is not a usable reading");
    }
    return {
        inputTokens: measured.inputTokens,
        ...(measured.contextWindow === undefined
            ? {}
            : { contextWindow: measured.contextWindow }),
        estimated: measured.estimated,
    };
}

/**
 * Whether a stored record still describes the branch that is live. Checked on
 * every read rather than trusted from the file: the record was written against
 * one branch, and a rewind or a fork can leave it describing history that is
 * no longer reachable.
 */
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
            && (message.presentation === undefined
                || isToolPresentation(message.presentation))
            && message.content.every(isTextContent);
    }
    if (message.role !== "assistant") {
        return false;
    }
    return (message.internal === undefined
        || typeof message.internal === "boolean")
        && isModelSource(message.source)
        && isModelUsage(message.usage)
        && isModelStopReason(message.stopReason)
        && (message.errorMessage === undefined
            || typeof message.errorMessage === "string")
        && message.content.every(isAssistantContent);
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
    // Finite is part of the shape: NaN and Infinity survive as numbers in
    // memory but serialize to null, which the loader then rejects.
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

function nonEmpty(value: string, name: string): string {
    if (value.length === 0) {
        throw new Error(`${name} must not be empty`);
    }
    return value;
}

function invalidSession(path: string, message: string, cause?: unknown): Error {
    return new Error(`Invalid session file ${path}: ${message}`, { cause });
}
