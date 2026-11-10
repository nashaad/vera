import {
    emptyUsage,
    isClassifierOutcome,
    isHookDisplay,
    isToolPresentation,
    isTurnTiming,
} from "../model/types.ts";
import { randomUUID } from "node:crypto";
import { scanSessionLines, readSessionLine, SESSION_SCAN_CHUNK_BYTES } from "./session-lines.ts";
import { SessionRecordIndex, type SessionCompactionAnchor } from "./session-record-index.ts";
import { scanSessionIndex } from "./session-index-scan.ts";
import { contextMeasurementHeader } from "./session-record-header.ts";
import { measurementComponentsCanonical } from "./session-measurement-fields.ts";
import { addSessionModelUsage, SessionUsageAccumulator, type SessionModelUsage } from "../model/session-usage.ts";
import { billedUsageFields } from "./session-usage-fields.ts";
import { sessionJsonFields } from "./session-json-fields.ts";
import {
    chmod,
    mkdir,
    open,
    rm,
    type FileHandle,
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
    /** Writes every byte at the end of the file. */
    append(bytes: Uint8Array): Promise<void>;
    truncate(length: number): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
}

export type OpenSessionAppendFile = (path: string) => Promise<SessionAppendFile>;

// Bun's FileHandle.writeFile preallocates a large payload from offset 0 before an
// O_APPEND write on Linux, which leaves a zero-filled hole the size of the payload
// ahead of the record. Plain write calls carry no preallocation.
export async function openSessionAppendFile(path: string): Promise<SessionAppendFile> {
    const handle: FileHandle = await open(path, "a", 0o600);
    return {
        stat: () => handle.stat(),
        append: async (bytes) => {
            let offset = 0;
            while (offset < bytes.length) {
                const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
                if (bytesWritten <= 0) throw new Error(`Session file ${path} accepted no bytes`);
                offset += bytesWritten;
            }
        },
        truncate: (length) => handle.truncate(length),
        sync: () => handle.sync(),
        close: () => handle.close(),
    };
}

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

export interface ReadonlySessionSnapshot {
    readonly header: SessionHeader;
    readonly messages: readonly ModelMessage[];
    readonly messageStamps: ReadonlyMap<ModelMessage, MessageStamp>;
    readonly deliveredMessages: ReadonlyMap<ModelMessage, SessionDeliveryEntry>;
    readonly harnessMessages: readonly {
        readonly afterMessage: number;
        readonly id: string;
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
    readonly index: SessionRecordIndex;
}

interface IndexedMeasurementRecipeState {
    readonly measurement?: ContextMeasurement;
    readonly base?: readonly ContextProjectionComponent[];
    readonly lastRecordCompact: boolean;
    readonly sinceKeyframe: number;
}

export interface SessionTurnText {
    readonly prompt: readonly string[];
    readonly reply: readonly string[];
}

export interface IndexedLiveContext {
    readonly header: SessionHeader;
    readonly headId: string | null;
    readonly compaction?: SessionCompactionEntry;
    readonly compactionNumber?: number;
    readonly entries: readonly SessionMessageEntry[];
    readonly tail: readonly SessionMessageEntry[];
    readonly index: SessionRecordIndex;
    readonly lineCount: number;
    readonly usage: SessionModelUsage;
    readonly replyUsage: SessionModelUsage;
    readonly canonicalMeasurements: boolean;
    readonly measurementRecipeState: IndexedMeasurementRecipeState;
    readonly queuedPrompts: readonly SessionQueuedPromptEntry[];
    readonly unsentPrompts: readonly UnsentPrompt[];
    readonly turnCount: number;
    readonly firstUser?: { readonly id: string; readonly title?: string };
    readonly latestMessageTimestamp?: string;
    readonly latestMeasuredAssistantTimestamp?: string;
    readonly name?: SessionNameEntry;
    readonly settings?: SessionModelSettingsEntry;
    readonly permissions?: SessionPermissionsEntry;
    readonly identity?: SessionIdentityEntry;
    readonly selectedAgent?: SessionSelectedAgentEntry;
    readonly measurement?: ContextMeasurement;
    readonly agentFailure?: SessionAgentFailureEntry;
    readonly openTurnStartId?: string;
    readonly activeDeliveryIds: readonly string[];
}

const INDEXED_HISTORY_TAIL_BYTES = 128 * 1024;
const INDEXED_HARNESS_TAIL_BYTES = 128 * 1024;

function billedAssistant(billed: SessionCompactionBilled, api: "compaction" | "ask"): AssistantMessage {
    return { role: "assistant", content: [], stopReason: "stop",
        source: { provider: billed.provider, model: billed.model, api }, usage: billed.usage };
}

export async function readIndexedLiveContext(path: string, source?: FileHandle, repair = false): Promise<IndexedLiveContext> {
    const file = source ?? await open(path, "r");
    try {
        const scanned = await scanSessionIndex(path, file, repair);
        const header = parseHeaderRecord(path, scanned.header);
        const readFact = async <T>(number: number | undefined,
            parse: (path: string, line: number, value: Record<string, unknown>) => T): Promise<T | undefined> => {
            if (number === undefined) return undefined;
            const location = scanned.index.location(number)!;
            const record = parseJsonObject(path, number + 1,
                await readSessionLine(path, location.offset, location.length, file));
            return parse(path, number + 1, record);
        };
        const name = await readFact(scanned.index.recordOfKind("session_name"), parseSessionNameEntry);
        const settings = await readFact(scanned.index.recordOfKind("model_settings"), parseModelSettingsEntry);
        const permissions = await readFact(scanned.index.recordOfKind("permissions"), parsePermissionsEntry);
        const identity = await readFact(scanned.index.recordOfKind("session_identity", false), parseSessionIdentityEntry);
        const selected = Math.max(scanned.index.recordOfKind("agent_select") ?? -1, scanned.index.recordOfKind("agent_wear") ?? -1);
        const selectedAgent = await readFact(selected < 0 ? undefined : selected, parseSelectedAgentEntry);
        const usage = await readIndexedUsage(path, file, scanned.index, scanned.replyUsage);
        const queuedPrompts: SessionQueuedPromptEntry[] = [];
        for (const number of scanned.queuedPromptRecords) {
            const location = scanned.index.location(number)!;
            const record = parseJsonObject(path, number + 1,
                await readSessionLine(path, location.offset, location.length, file));
            if (record.type !== "queued_prompt" || typeof record.id !== "string" || typeof record.timestamp !== "string"
                || !isUnsentPrompt(record)) throw invalidSession(path, `line ${number + 1} is not a valid queued prompt`);
            queuedPrompts.push(record as unknown as SessionQueuedPromptEntry);
        }
        let unsentPrompts: readonly UnsentPrompt[] = [];
        if (scanned.unsentPromptRecord !== undefined) {
            const number = scanned.unsentPromptRecord;
            const location = scanned.index.location(number)!;
            const record = parseJsonObject(path, number + 1,
                await readSessionLine(path, location.offset, location.length, file));
            if (!Array.isArray(record.unsentPrompts) || !record.unsentPrompts.every(isUnsentPrompt)) {
                throw invalidSession(path, `line ${number + 1} is not a valid ${record.type === "harness_message" ? "harness message" : "message"} entry`);
            }
            unsentPrompts = record.unsentPrompts;
        }
        const lastMeasurement = scanned.index.recordOfKind("context_measurement");
        const activeMeasurement = scanned.index.latestMeasurement(scanned.headId);
        const measurementRecipeState = await readIndexedMeasurementRecipeState(path, file, scanned.index, lastMeasurement);
        const measurement = scanned.canonicalMeasurements && lastMeasurement === activeMeasurement
            ? measurementRecipeState.measurement
            : await readIndexedMeasurement(path, file, scanned.index, scanned.headId, scanned.canonicalMeasurements);
        const compactionNumber = scanned.index.latestApplicableCompaction(scanned.headId);
        let compaction: SessionCompactionEntry | undefined;
        if (compactionNumber !== undefined) {
            const location = scanned.index.location(compactionNumber)!;
            const record = parseJsonObject(path, compactionNumber + 1,
                await readSessionLine(path, location.offset, location.length, file));
            compaction = parseCompactionEntry(path, compactionNumber + 1, record);
        }
        const boundary = compactionNumber === undefined ? undefined : scanned.index.compactionBoundary(compactionNumber);
        const numbers: number[] = [];
        let current = scanned.headId === null ? undefined : scanned.index.messageRecord(scanned.headId);
        while (current !== undefined && current !== boundary) {
            numbers.push(current);
            current = scanned.index.parent(current);
        }
        const entries: SessionMessageEntry[] = [];
        for (const number of numbers.toReversed()) {
            const location = scanned.index.location(number)!;
            const record = parseJsonObject(path, number + 1,
                await readSessionLine(path, location.offset, location.length, file));
            entries.push(parseMessageEntry(path, number + 1, record));
        }
        const liveById = new Map(entries.map((entry) => [entry.id, entry]));
        const tail: SessionMessageEntry[] = [];
        for (const number of scanned.index.recentMessages(scanned.headId, INDEXED_HISTORY_TAIL_BYTES)) {
            const id = scanned.index.messageId(number)!;
            const live = liveById.get(id);
            if (live !== undefined) {
                tail.push(live);
                continue;
            }
            const location = scanned.index.location(number)!;
            const record = parseJsonObject(path, number + 1,
                await readSessionLine(path, location.offset, location.length, file));
            tail.push(parseMessageEntry(path, number + 1, record));
        }
        return { header, headId: scanned.headId, index: scanned.index, lineCount: scanned.lineCount, usage,
            replyUsage: scanned.replyUsage, canonicalMeasurements: scanned.canonicalMeasurements, measurementRecipeState,
            queuedPrompts, unsentPrompts, activeDeliveryIds: scanned.activeDeliveryIds,
            turnCount: scanned.turnCount, ...(scanned.firstUser === undefined ? {} : { firstUser: scanned.firstUser }),
            ...(scanned.latestMessageTimestamp === undefined ? {} : { latestMessageTimestamp: scanned.latestMessageTimestamp }),
            ...(scanned.latestMeasuredAssistantTimestamp === undefined ? {} : { latestMeasuredAssistantTimestamp: scanned.latestMeasuredAssistantTimestamp }),
            ...(compaction === undefined ? {} : { compaction, compactionNumber }), entries, tail,
            ...(name === undefined ? {} : { name }), ...(settings === undefined ? {} : { settings }),
            ...(permissions === undefined ? {} : { permissions }), ...(identity === undefined ? {} : { identity }),
            ...(selectedAgent === undefined ? {} : { selectedAgent }), ...(measurement === undefined ? {} : { measurement }),
            ...(scanned.openTurnStartId === undefined ? {} : { openTurnStartId: scanned.openTurnStartId }),
            ...(scanned.agentFailure === undefined ? {} : { agentFailure: scanned.agentFailure }) };
    } finally {
        if (source === undefined) await file.close();
    }
}

async function readCarriedTurnText(
    path: string,
    file: FileHandle,
    index: SessionRecordIndex,
    boundary: number | undefined,
    entries: readonly SessionMessageEntry[],
): Promise<SessionTurnText | undefined> {
    if (boundary === undefined || entries.some(startsTurnEntry)) return undefined;
    let start: number | undefined = boundary;
    while (start !== undefined && !index.startsTurnOrDelivery(start)) start = index.parent(start);
    if (start === undefined) return undefined;
    const prompt: string[] = [];
    const reply: string[] = [];
    let current: number | undefined = boundary;
    while (current !== undefined) {
        if (index.isVisibleTextMessage(current)) {
            const location = index.location(current)!;
            const value = parseJsonObject(path, current + 1, await readSessionLine(path, location.offset, location.length, file));
            const part = sessionTurnTextPart(parseMessageEntry(path, current + 1, value).message);
            if (part !== undefined) (part.role === "user" ? prompt : reply).push(part.text);
        }
        if (current === start) return { prompt: prompt.reverse(), reply: reply.reverse() };
        current = index.parent(current);
    }
    return undefined;
}

async function readIndexedUsage(
    path: string,
    file: Awaited<ReturnType<typeof open>>,
    index: SessionRecordIndex,
    initial: SessionModelUsage,
): Promise<SessionModelUsage> {
    let usage = initial;
    let window = Buffer.allocUnsafe(64 * 1024);
    let windowOffset = -1;
    let windowLength = 0;
    for (const kind of ["compaction", "session_ask"] as const) {
        let number = index.nextRecordOfKind(kind, -1);
        while (number !== undefined) {
            const location = index.location(number)!;
            if (location.offset < windowOffset || location.offset + location.length > windowOffset + windowLength) {
                if (window.length < location.length) window = Buffer.allocUnsafe(location.length);
                windowOffset = location.offset;
                windowLength = 0;
                while (windowLength < location.length) {
                    const result = await file.read(window, windowLength, window.length - windowLength, windowOffset + windowLength);
                    if (result.bytesRead === 0) throw new Error(`Unexpected end of session file ${path}`);
                    windowLength += result.bytesRead;
                }
            }
            const start = location.offset - windowOffset;
            const fields = sessionJsonFields(window.subarray(start, start + location.length - 1));
            const billed = billedUsageFields(fields?.billed, kind === "compaction" ? "compaction" : "ask");
            if (fields?.billedPresent === true && billed === undefined) {
                throw invalidSession(path, `line ${number + 1} has invalid billing`);
            }
            if (billed !== undefined) usage = addSessionModelUsage(usage, billed);
            number = index.nextRecordOfKind(kind, number);
        }
    }
    return usage;
}

async function readIndexedMeasurement(
    path: string,
    file: Awaited<ReturnType<typeof open>>,
    index: SessionRecordIndex,
    headId: string | null,
    canonical: boolean,
): Promise<ContextMeasurement | undefined> {
    if (canonical) return (await readIndexedMeasurementRecipeState(path, file, index, index.latestMeasurement(headId))).measurement;
    const retained = index.rewindMeasurements(headId);
    const state = createSessionProjectionState();
    let measurement: ContextMeasurement | undefined;
    let previous: readonly ContextProjectionComponent[] | undefined;
    let reconstructed: readonly ContextProjectionComponent[] | undefined;
    let retainedPosition = 0;
    let number = index.nextRecordOfKind("context_measurement", -1);
    while (number !== undefined) {
        const keep = retained[retainedPosition] === number;
        if (!keep && !index.isCompactMeasurement(number)) {
            state.contextMeasurementBase = undefined;
            state.contextMeasurementLastRecordCompact = false;
            state.contextMeasurementsSinceKeyframe = 0;
            number = index.nextRecordOfKind("context_measurement", number);
            continue;
        }
        const location = index.location(number)!;
        const value = parseJsonObject(path, number + 1,
            await readSessionLine(path, location.offset, location.length, file));
        const entry = applyContextMeasurementEntry(path, number + 1,
            parseContextMeasurementEntry(path, number + 1, value), state);
        if (keep) {
            const projection = entry.measurement.projection!;
            const components = projection.components;
            const recipe = previous === undefined ? contextMeasurementKeyframe(components) : contextMeasurementDelta(previous, components);
            reconstructed = applyContextMeasurementRecipe(reconstructed, recipe);
            if (reconstructed === undefined) throw new Error("Retained context measurement lost its components");
            measurement = { ...entry.measurement, projection: { ...projection, components: reconstructed } };
            previous = components;
            retainedPosition += 1;
        }
        number = index.nextRecordOfKind("context_measurement", number);
    }
    return measurement;
}

async function readIndexedMeasurementRecipeState(
    path: string,
    file: Awaited<ReturnType<typeof open>>,
    index: SessionRecordIndex,
    latest: number | undefined,
): Promise<IndexedMeasurementRecipeState> {
    if (latest === undefined) return { lastRecordCompact: false, sinceKeyframe: 0 };
    const records: number[] = [];
    let current: number | undefined = latest;
    while (current !== undefined) {
        records.push(current);
        const location = index.location(current)!;
        const value = parseJsonObject(path, current + 1,
            await readSessionLine(path, location.offset, location.length, file));
        const parsed = parseContextMeasurementEntry(path, current + 1, value);
        if (parsed.recipe === undefined || parsed.recipe.keyframe) break;
        current = index.previousRecordOfKind("context_measurement", current);
    }
    const state = createSessionProjectionState();
    let measurement: ContextMeasurement | undefined;
    for (const number of records.reverse()) {
        const location = index.location(number)!;
        const value = parseJsonObject(path, number + 1,
            await readSessionLine(path, location.offset, location.length, file));
        measurement = applyContextMeasurementEntry(path, number + 1,
            parseContextMeasurementEntry(path, number + 1, value), state).measurement;
    }
    return {
        ...(measurement === undefined ? {} : { measurement }),
        ...(state.contextMeasurementBase === undefined ? {} : { base: state.contextMeasurementBase }),
        lastRecordCompact: state.contextMeasurementLastRecordCompact,
        sinceKeyframe: state.contextMeasurementsSinceKeyframe,
    };
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
    private recordIndex: SessionRecordIndex;
    private readSource: FileHandle | undefined;
    private readonlySnapshot = false;
    private onRecordAppended?: (
        lineNumber: number,
        record: Record<string, unknown>,
    ) => void;

    protected projection: SessionProjectionState;

    protected constructor(
        path: string,
        header: SessionHeader,
        state: SessionProjectionState,
        options: OpenSessionStoreOptions,
        lineCount = 1,
        index?: SessionRecordIndex,
    ) {
        this.path = path;
        this.header = header;
        this.projection = state;
        this.now = options.now ?? (() => new Date());
        this.createId = options.createId ?? randomUUID;
        this.openAppendFile = options.openAppendFile ?? openSessionAppendFile;
        this.lineCount = lineCount;
        this.recordIndex = index ?? new SessionRecordIndex();
        if (index === undefined) {
            this.recordIndex.append(0, Buffer.byteLength(jsonLine(header)), header as unknown as Record<string, unknown>);
        }
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

        const index = new SessionRecordIndex();
        index.append(0, Buffer.byteLength(jsonLine(header)), header as unknown as Record<string, unknown>);
        const state = createSessionProjectionState(index);
        state.indexedLive = true;
        return new SessionStore(
            path,
            header,
            state,
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
            1,
            index,
        );
    }

    static async open(
        path: string,
        options: OpenSessionStoreOptions = {},
    ): Promise<SessionStore> {
        const loaded = await scanIndexedSessionFile(path, true);
        await chmod(path, 0o600);
        return new SessionStore(
            path,
            loaded.header,
            loaded.state,
            options,
            loaded.lineCount,
            loaded.index,
        );
    }

    static async openReadOnly(path: string): Promise<SessionStore> {
        const file = await open(path, "r");
        try {
            const loaded = await scanIndexedSessionFile(path, false, file);
            const store = new SessionStore(path, loaded.header, loaded.state, {}, loaded.lineCount, loaded.index);
            store.readSource = file;
            store.readonlySnapshot = true;
            return store;
        } catch (error) {
            await file.close();
            throw error;
        }
    }

    async closeReadOnly(): Promise<void> {
        const file = this.readSource;
        this.readSource = undefined;
        if (file !== undefined) await file.close();
    }

    async readIndexedMessage(id: string): Promise<Record<string, unknown> | undefined> {
        await this.ensureMessageIndexed(id);
        const number = this.recordIndex.messageRecord(id);
        const location = number === undefined ? undefined : this.recordIndex.location(number);
        if (location === undefined) return undefined;
        return parseJsonObject(this.path, number! + 1, await readSessionLine(this.path, location.offset, location.length, this.readSource));
    }

    async readRecord(number: number): Promise<Record<string, unknown> | undefined> {
        if (!Number.isSafeInteger(number)) return undefined;
        const { index, limit } = await this.recordReadIndex();
        if (number < 0 || number >= limit) return undefined;
        const location = index.location(number);
        if (location === undefined) return undefined;
        return parseJsonObject(this.path, number + 1,
            await readSessionLine(this.path, location.offset, location.length, this.readSource));
    }

    async *walkRecords(kind?: string): AsyncGenerator<{ readonly number: number; readonly record: Record<string, unknown> }> {
        const { index, limit } = await this.recordReadIndex();
        const source = this.readSource;
        const file = source ?? await open(this.path, "r");
        try {
            let number: number | undefined = kind === undefined ? 0 : index.nextRecordOfKind(kind, -1);
            while (number !== undefined && number < limit) {
                const location = index.location(number)!;
                const record = parseJsonObject(this.path, number + 1,
                    await readSessionLine(this.path, location.offset, location.length, file));
                yield { number, record };
                number = kind === undefined ? number + 1 : index.nextRecordOfKind(kind, number);
            }
        } finally {
            if (source === undefined) await file.close();
        }
    }

    async *walkEntries(): AsyncGenerator<SessionMessageEntry> {
        const { index, limit } = await this.recordReadIndex();
        const source = this.readSource;
        const file = source ?? await open(this.path, "r");
        try {
            let message = index.nextRecordOfKind("message", -1);
            let turnStart = index.nextRecordOfKind("turn_start", -1);
            while (message !== undefined || turnStart !== undefined) {
                const number = Math.min(message ?? Infinity, turnStart ?? Infinity);
                if (number >= limit) break;
                const location = index.location(number)!;
                const value = parseJsonObject(this.path, number + 1,
                    await readSessionLine(this.path, location.offset, location.length, file));
                yield parseMessageEntry(this.path, number + 1, value);
                if (message === number) message = index.nextRecordOfKind("message", number);
                if (turnStart === number) turnStart = index.nextRecordOfKind("turn_start", number);
            }
        } finally {
            if (source === undefined) await file.close();
        }
    }

    async *walkHarnessMessages(): AsyncGenerator<{ readonly ordinal: number; readonly number: number; readonly entry: SessionHarnessMessageEntry }> {
        let ordinal = 0;
        for await (const { number, record } of this.walkRecords("harness_message")) {
            yield { ordinal, number, entry: parseHarnessMessageEntry(this.path, number + 1, record) };
            ordinal += 1;
        }
    }

    async messageRecordNumber(id: string): Promise<number | undefined> {
        await this.ensureMessageIndexed(id);
        return this.recordIndex.messageRecord(id);
    }

    async harnessPosition(headId: string | null, entry: SessionHarnessMessageEntry): Promise<number | undefined> {
        if (entry.afterMessageId === null) return -1;
        if (headId === null) return undefined;
        await this.ensureMessageIndexed(headId);
        const anchor = this.recordIndex.messageRecord(entry.afterMessageId);
        let current = this.recordIndex.messageRecord(headId);
        let nextUser: number | undefined;
        while (current !== undefined && current !== anchor) {
            if (this.recordIndex.isVisibleUser(current)) nextUser = current;
            current = this.recordIndex.parent(current);
        }
        if (anchor === undefined || current === undefined) return undefined;
        const delayed = this.recordIndex.isInternal(anchor) && entry.crashCut !== true
            && entry.unsentPrompts === undefined && !(entry.text === CRASH_CUT_MESSAGE && entry.tone === "soft");
        return delayed ? nextUser : anchor;
    }

    async readHarnessMessage(number: number): Promise<SessionHarnessMessageEntry | undefined> {
        const record = await this.readRecord(number);
        return record === undefined || record.type !== "harness_message"
            ? undefined : parseHarnessMessageEntry(this.path, number + 1, record);
    }

    async readDelivery(id: string): Promise<SessionDeliveryEntry | undefined> {
        for await (const { number, record } of this.walkRecords("delivery")) {
            if (record.id === id) return parseDeliveryEntry(this.path, number + 1, record);
        }
        return undefined;
    }

    async readAttachmentName(id: string): Promise<string | undefined> {
        for await (const { number, record } of this.walkRecords("attachment")) {
            const entry = parseAttachmentEntry(this.path, number + 1, record);
            if (entry.attachment.id === id) return entry.attachment.name;
        }
        return undefined;
    }

    protected async recordReadIndex(): Promise<{ readonly index: SessionRecordIndex; readonly limit: number }> {
        return { index: this.recordIndex, limit: this.recordIndex.length };
    }

    async readMessageEntry(id: string): Promise<SessionMessageEntry | undefined> {
        await this.ensureMessageIndexed(id);
        const number = this.recordIndex.messageRecord(id);
        if (number === undefined) return undefined;
        const location = this.recordIndex.location(number)!;
        const value = parseJsonObject(this.path, number + 1,
            await readSessionLine(this.path, location.offset, location.length, this.readSource));
        return parseMessageEntry(this.path, number + 1, value);
    }

    async readApplicableCompaction(): Promise<SessionCompactionEntry | undefined> {
        if (this.projection.leafId !== null) await this.ensureMessageIndexed(this.projection.leafId);
        const number = this.recordIndex.latestApplicableCompaction(this.projection.leafId);
        if (number === undefined) return undefined;
        const location = this.recordIndex.location(number)!;
        const value = parseJsonObject(this.path, number + 1,
            await readSessionLine(this.path, location.offset, location.length, this.readSource));
        return parseCompactionEntry(this.path, number + 1, value);
    }

    async *walkMessageAncestors(headId: string): AsyncGenerator<SessionMessageEntry> {
        await this.ensureMessageIndexed(headId);
        let number = this.recordIndex.messageRecord(headId);
        if (number === undefined) throw new Error(`Session message ${headId} is unavailable`);
        const source = this.readSource;
        const file = source ?? await open(this.path, "r");
        try {
            while (number !== undefined) {
                const location = this.recordIndex.location(number)!;
                const value = parseJsonObject(this.path, number + 1,
                    await readSessionLine(this.path, location.offset, location.length, file));
                yield parseMessageEntry(this.path, number + 1, value);
                number = this.recordIndex.parent(number);
            }
        } finally {
            if (source === undefined) await file.close();
        }
    }

    async *walkMessageBranch(headId: string): AsyncGenerator<SessionMessageEntry> {
        await this.ensureMessageIndexed(headId);
        let number = this.recordIndex.messageRecord(headId);
        if (number === undefined) throw new Error(`Session message ${headId} is unavailable`);
        const recordCount = this.recordIndex.length;
        const members = new Uint8Array(Math.ceil(recordCount / 8));
        while (number !== undefined) {
            members[number >>> 3]! |= 1 << (number & 7);
            number = this.recordIndex.parent(number);
        }
        const source = this.readSource;
        const file = source ?? await open(this.path, "r");
        try {
            for (let record = 0; record < recordCount; record += 1) {
                if ((members[record >>> 3]! & (1 << (record & 7))) === 0) continue;
                const location = this.recordIndex.location(record)!;
                const value = parseJsonObject(this.path, record + 1,
                    await readSessionLine(this.path, location.offset, location.length, file));
                yield parseMessageEntry(this.path, record + 1, value);
            }
        } finally {
            if (source === undefined) await file.close();
        }
    }

    private async ensureMessageIndexed(id: string): Promise<void> {
        if (this.recordIndex.messageRecord(id) !== undefined || !this.projection.knownMessageIds.has(id)) return;
        this.recordIndex = (await scanSessionIndex(this.path, undefined, false, this.recordScanLimit())).index;
    }

    protected recordScanLimit(): number | undefined {
        return undefined;
    }

    recordIndexStats(): { records: number; columnBytes: number } {
        return { records: this.recordIndex.length, columnBytes: this.recordIndex.columnBytes };
    }

    entries(): readonly SessionMessageEntry[] {
        const live = this.liveMessageEntries();
        const head = this.activeBranch().at(-1) ?? this.projection.historyTail.at(-1);
        return live.length > 0 || head === undefined ? live : [{ ...head }];
    }

    activeEntries(): readonly SessionMessageEntry[] {
        // Entry copies protect branch indexes while preserving shared message identity.
        return this.activeBranch().map((entry) => ({ ...entry }));
    }

    carriedTurnText(): SessionTurnText | undefined {
        return this.projection.carriedTurnText;
    }

    liveMessageEntries(): readonly SessionMessageEntry[] {
        const active = this.activeBranch();
        if (this.projection.indexedLive) return active.map((entry) => ({ ...entry }));
        const compaction = this.latestCompaction();
        if (compaction === undefined) return active.map((entry) => ({ ...entry }));
        const boundary = active.findIndex((entry) => entry.id === compaction.boundaryMessageId);
        return active.slice(boundary + 1).map((entry) => ({ ...entry }));
    }

    private activeBranch(): readonly SessionMessageEntry[] {
        return this.projection.activeMessageEntries;
    }

    messages(): readonly ModelMessage[] {
        return this.activeBranch().map((entry) => entry.message);
    }

    queuedPrompts(): readonly SessionQueuedPromptEntry[] {
        return [...this.projection.queuedPrompts.values()].map((entry) => structuredClone(entry));
    }

    unsentPrompts(): readonly UnsentPrompt[] {
        return structuredClone(this.projection.unsentPrompts);
    }

    usageSummary(): SessionModelUsage {
        if (this.projection.indexedLive) {
            return { rows: (this.projection.indexedUsage ?? this.projection.replyUsage.result()).rows.map((row) => ({ ...row })) };
        }
        let usage: SessionModelUsage = { rows: this.projection.replyUsage.result().rows.map((row) => ({ ...row })) };
        for (const entry of this.projection.compactionEntries) {
            if (entry.billed !== undefined && entry.id !== this.projection.loadedCompactionId) {
                usage = addSessionModelUsage(usage, billedAssistant(entry.billed, "compaction"));
            }
        }
        for (const entry of this.projection.askEntries) usage = addSessionModelUsage(usage, billedAssistant(entry.billed, "ask"));
        return usage;
    }


    activeMessageStamps(): ReadonlyMap<ModelMessage, MessageStamp> {
        return messageStamps(this.activeBranch());
    }

    deliveredMessages(): ReadonlyMap<ModelMessage, SessionDeliveryEntry> {
        return deliveredMessages(this.activeBranch(), this.projection.deliveryEntries);
    }

    activeHeadId(): string | null {
        return this.projection.leafId;
    }

    firstUserFacts(): { readonly title?: string } | undefined {
        const first = this.projection.firstUser;
        return first === undefined ? undefined : first.title === undefined ? {} : { title: first.title };
    }

    latestMessageTimestamp(): string | undefined {
        return this.projection.latestMessageTimestamp;
    }

    latestMeasuredAssistantTimestamp(): string | undefined {
        return this.projection.latestMeasuredAssistantTimestamp;
    }

    turnCount(): number {
        return this.projection.turnCount;
    }

    pendingDeliveries(): readonly SessionDeliveryEntry[] {
        const activeMessageIds = this.projection.activeMessagePositions;
        const deliveredOnActiveBranch = this.projection.activeDeliveryIds;
        return this.projection.deliveryEntries.filter(
            (delivery) => {
                const legacyMessageId = this.projection.legacyDeliveryMessageIds.get(
                    delivery.id,
                );
                const legacyReceiptIsActive = this.projection.deliveryReceipts.has(
                    delivery.id,
                ) && (
                    legacyMessageId === undefined
                    || (this.projection.indexedLive
                        ? this.recordIndex.isAncestor(this.projection.leafId, legacyMessageId)
                        : activeMessageIds.has(legacyMessageId))
                );
                return !legacyReceiptIsActive
                    && !deliveredOnActiveBranch.has(delivery.id);
            },
        );
    }

    hasUnansweredDeliveryTurn(): boolean {
        if (this.projection.indexedLive) return this.recordIndex.hasUnansweredDelivery(this.projection.leafId);
        return hasOpenDeliveryTurn(this.activeBranch(), this.projection.harnessMessageEntries);
    }

    modelSettings(): ModelTurnSettings | undefined {
        const settings = this.projection.modelSettingsEntries.at(-1)?.settings;
        return settings === undefined ? undefined : { ...settings };
    }

    modelSettingsOrigin(): SessionSettingOrigin | undefined {
        const entry = this.projection.modelSettingsEntries.at(-1);
        return entry === undefined ? undefined : entry.origin ?? "user";
    }

    async readModelSettingsHistory(): Promise<readonly SessionModelSettingsEntry[]> {
        const entries: SessionModelSettingsEntry[] = [];
        const { index, limit } = await this.recordReadIndex();
        const source = this.readSource;
        const file = source ?? await open(this.path, "r");
        try {
            let number = index.nextRecordOfKind("model_settings", -1);
            while (number !== undefined && number < limit) {
                const location = index.location(number)!;
                const value = parseJsonObject(this.path, number + 1,
                    await readSessionLine(this.path, location.offset, location.length, file));
                const entry = parseModelSettingsEntry(this.path, number + 1, value);
                entries.push({ ...entry, settings: { ...entry.settings }, origin: entry.origin ?? "user" });
                number = index.nextRecordOfKind("model_settings", number);
            }
            return entries;
        } finally {
            if (source === undefined) await file.close();
        }
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
        this.projection.selectedAgentEntries.splice(0, this.projection.selectedAgentEntries.length, entry);
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
            if (this.projection.agentFailure !== undefined) return false;
            const headId = this.projection.leafId;
            const head = headId === null ? undefined : await this.readMessageEntry(headId);
            const turnOpen = this.projection.openTurnStartId !== undefined
                && (this.projection.indexedLive && headId !== null
                    ? this.recordIndex.leavesTurnOpen(this.recordIndex.messageRecord(headId)!)
                    : turnOpenAtTail(head === undefined ? [] : [head], this.projection.harnessMessageEntries));
            const queuedPrompts = this.queuedPrompts().map(({ content, attachmentIds }) => ({
                content,
                ...(attachmentIds === undefined ? {} : { attachmentIds }),
            }));
            if (!turnOpen && queuedPrompts.length === 0) return false;
            this.requireActive();
            if (!turnOpen) {
                let completed: SessionMessageEntry | undefined;
                if (headId !== null) {
                    for await (const entry of this.walkMessageAncestors(headId)) {
                        if (entry.message.role === "assistant" && entry.message.internal !== true
                            && entry.message.stopReason !== "tool_use") {
                            completed = entry;
                            break;
                        }
                    }
                }
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
            const active = await this.readActiveSuffix(this.projection.openTurnStartId!);
            const startIndex = active.findIndex((entry) => entry.id === this.projection.openTurnStartId);
            const turnEntries = active.slice(Math.max(startIndex, 0));
            let previousCut = this.projection.harnessMessageEntries.findLast((entry) => entry.crashCut === true);
            if (this.projection.indexedLive) {
                previousCut = undefined;
                for await (const { entry } of this.walkHarnessMessages()) if (entry.crashCut === true) previousCut = entry;
            }
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
                let lastAssistant = active.findLast((entry) => entry.message.role === "assistant")?.message;
                if (lastAssistant === undefined && headId !== null) {
                    for await (const entry of this.walkMessageAncestors(headId)) {
                        if (entry.message.role === "assistant") {
                            lastAssistant = entry.message;
                            break;
                        }
                    }
                }
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
            const active = await this.readActiveSuffix(startId);
            const headId = this.projection.leafId;
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
            let lastAssistant = active.findLast((entry) => entry.message.role === "assistant")?.message;
            if (lastAssistant === undefined && headId !== null) {
                for await (const entry of this.walkMessageAncestors(headId)) {
                    if (entry.message.role === "assistant") {
                        lastAssistant = entry.message;
                        break;
                    }
                }
            }
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

    private async readActiveSuffix(startId: string): Promise<SessionMessageEntry[]> {
        if (this.projection.leafId === null) return [];
        const entries: SessionMessageEntry[] = [];
        for await (const entry of this.walkMessageAncestors(this.projection.leafId)) {
            entries.push(entry);
            if (entry.id === startId) break;
        }
        entries.reverse();
        return entries;
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
        const result = this.pendingAppend.then(async () => {
            this.requireActive();
            const leafId = this.projection.leafId;
            if (leafId !== null) await this.ensureMessageIndexed(leafId);
            const leafRecord = leafId === null ? undefined : this.recordIndex.messageRecord(leafId);
            if (leafId !== null && leafRecord === undefined) throw new Error(`Session message ${leafId} is unavailable`);
            const afterMessageId = leafRecord !== undefined && this.recordIndex.isToolResult(leafRecord)
                && visibleHeadId !== undefined && leafId !== visibleHeadId
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
        readonly id: string;
        readonly text: string;
        readonly tone: "primary" | "soft" | "error";
    }[] {
        const active = this.activeBranch();
        const projected = projectHarnessMessages(this.projection.harnessMessageEntries, active);
        if (!this.projection.indexedLive) return projected;
        return projected.map((entry) => ({ ...entry,
            id: `harness:${this.projection.harnessTailOrdinals[Number(entry.id.slice("harness:".length))]}` }));
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
            if (this.projection.indexedLive) await this.refreshIndexedUsage();
            else this.projection.askEntries.push(entry);
            return entry;
        });
        this.pendingAppend = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    latestCompaction(): SessionCompactionEntry | undefined {
        if (this.projection.indexedLive) {
            return this.recordIndex.latestApplicableCompaction(this.projection.leafId) === undefined
                ? undefined : this.projection.compactionEntries.at(-1);
        }
        const active = this.activeBranch();
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
        const active = this.projection.activeMessagePositions;
        const entries = this.projection.contextMeasurementEntries;
        for (let index = entries.length - 1; index >= 0; index -= 1) {
            const entry = entries[index]!;
            if (entry.afterMessageId !== null && !(this.projection.indexedLive
                ? this.recordIndex.isAncestor(this.projection.leafId, entry.afterMessageId)
                : active.has(entry.afterMessageId))) {
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
        const active = this.activeBranch();
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
        if (this.recordIndex.messageRecord(entry.id) !== undefined || this.projection.knownMessageIds.has(entry.id)) {
            throw new Error(`Session entry ID ${entry.id} already exists`);
        }

        const record: SessionMessageEntry | SessionTurnStartEntry = turnStart === true
            ? { ...entry, type: "turn_start" }
            : entry;
        await this.appendRecord(record);

        appendActiveMessage(this.projection, entry);
        if (this.projection.indexedLive && entry.message.role === "assistant" && entry.message.source.api !== "none") {
            await this.refreshIndexedUsage();
        }
        if (this.projection.indexedLive) {
            const tail = this.projection.historyTail;
            const length = this.recordIndex.location(this.recordIndex.messageRecord(entry.id)!)!.length;
            if (length > INDEXED_HISTORY_TAIL_BYTES) {
                tail.length = 0;
                this.projection.historyTailBytes = 0;
            } else {
                tail.push(this.projection.activeMessageEntries.at(-1)!);
                this.projection.historyTailBytes += length;
                while (this.projection.historyTailBytes > INDEXED_HISTORY_TAIL_BYTES) {
                    const removed = tail.shift()!;
                    this.projection.historyTailBytes -= this.recordIndex.location(this.recordIndex.messageRecord(removed.id)!)!.length;
                }
            }
        }
        applyTurnMessage(this.projection, entry, turnStart === true);
        if (turnStart === true) this.projection.unsentPrompts = [];
        if (unsentPrompts !== undefined) {
            this.projection.queuedPrompts.clear();
            this.projection.unsentPrompts = structuredClone(unsentPrompts);
        }
        if (queuedPromptId !== undefined) this.projection.queuedPrompts.delete(queuedPromptId);
        if (this.projection.indexedLive) {
            const current = this.projection.compactionEntries.at(-1);
            const mayChange = current === undefined
                ? this.recordIndex.recordOfKind("compaction") !== undefined
                : current.firstRetainedMessageId === null && current.boundaryMessageId === entry.parentId
                    && entry.message.role === "tool_result";
            if (mayChange && this.recordIndex.latestApplicableCompaction(entry.id) !== this.projection.currentCompactionNumber) {
                const loaded = await scanIndexedSessionFile(this.path, false, this.readSource);
                this.projection = loaded.state;
                this.recordIndex = loaded.index;
            }
        }
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
        this.projection.modelSettingsEntries.splice(0, this.projection.modelSettingsEntries.length, entry);
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
        const previous = this.projection.contextMeasurementEntries.at(-1);
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
        if (this.projection.indexedLive) {
            this.projection.canonicalMeasurements &&= measurementComponentsCanonical(Buffer.from(JSON.stringify({ measurement })), false);
            let retained = measurement;
            if (!this.projection.canonicalMeasurements) {
                let base = previous?.measurement.projection?.components;
                if (previous?.afterMessageId === entry.afterMessageId) {
                    const head = this.projection.leafId === null ? undefined : this.recordIndex.messageRecord(this.projection.leafId);
                    const parent = head === undefined ? undefined : this.recordIndex.parent(head);
                    if (parent === undefined) base = undefined;
                    else {
                        const file = await open(this.path, "r");
                        try {
                            base = (await readIndexedMeasurement(this.path, file, this.recordIndex,
                                this.recordIndex.messageId(parent)!, false))?.projection?.components;
                        } finally {
                            await file.close();
                        }
                    }
                }
                const components = base === undefined ? measurement.projection.components
                    : applyContextMeasurementRecipe(base, contextMeasurementDelta(base, measurement.projection.components));
                if (components !== undefined) retained = { ...measurement, projection: { ...measurement.projection, components } };
            }
            this.projection.contextMeasurementEntries.splice(0, this.projection.contextMeasurementEntries.length,
                { ...entry, measurement: retained });
            this.projection.contextMeasurementLastComponents = retained.projection?.components;
        } else {
            this.projection.contextMeasurementEntries.push(entry);
        }
        this.projection.contextMeasurementBase = measurement.projection.components;
        this.projection.contextMeasurementLastRecordCompact = true;
        this.projection.contextMeasurementsSinceKeyframe = keyframe
            ? 0
            : this.projection.contextMeasurementsSinceKeyframe + 1;
        if (!this.projection.indexedLive) retainContextMeasurements(this.projection);
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
        if (this.projection.indexedLive) {
            const length = this.recordIndex.location(this.recordIndex.length - 1)!.length;
            const ordinal = this.projection.harnessTotal++;
            this.projection.harnessMessageEntries.push(entry);
            this.projection.harnessTailLengths.push(length);
            this.projection.harnessTailOrdinals.push(ordinal);
            this.trimHarnessTail();
        } else this.projection.harnessMessageEntries.push(entry);
        if (crashCut === true || unsentPrompts !== undefined) this.projection.openTurnStartId = undefined;
        if (unsentPrompts !== undefined) {
            this.projection.queuedPrompts.clear();
            this.projection.unsentPrompts = structuredClone(unsentPrompts);
        }
        return entry;
    }

    private trimHarnessTail(): void {
        const state = this.projection;
        let budget = INDEXED_HARNESS_TAIL_BYTES;
        let retainedBytes = 0;
        for (let index = state.harnessMessageEntries.length - 1; index >= 0; index -= 1) {
            const entry = state.harnessMessageEntries[index]!;
            if (entry.afterMessageId !== null && state.activeMessagePositions.has(entry.afterMessageId)) continue;
            const length = state.harnessTailLengths[index]!;
            if (length <= budget) {
                budget -= length;
                retainedBytes += length;
                continue;
            }
            budget = 0;
            state.harnessMessageEntries.splice(index, 1);
            state.harnessTailLengths.splice(index, 1);
            state.harnessTailOrdinals.splice(index, 1);
        }
        state.harnessTailBytes = retainedBytes;
    }

    private async restoreLiveHarness(): Promise<void> {
        const state = this.projection;
        const live = new Set(state.activeMessageEntries.map((entry) => this.recordIndex.messageRecord(entry.id)!));
        const retained = new Set(state.harnessTailOrdinals);
        const source = this.readSource;
        const file = source ?? await open(this.path, "r");
        try {
            let number = this.recordIndex.nextRecordOfKind("harness_message", -1);
            let ordinal = 0;
            while (number !== undefined) {
                const anchor = this.recordIndex.harnessAnchor(number);
                if (anchor !== undefined && live.has(anchor) && !retained.has(ordinal)) {
                    const location = this.recordIndex.location(number)!;
                    const value = parseJsonObject(this.path, number + 1,
                        await readSessionLine(this.path, location.offset, location.length, file));
                    const entry = parseHarnessMessageEntry(this.path, number + 1, value);
                    let position = state.harnessTailOrdinals.findIndex((item) => item > ordinal);
                    if (position < 0) position = state.harnessTailOrdinals.length;
                    state.harnessMessageEntries.splice(position, 0, entry);
                    state.harnessTailLengths.splice(position, 0, location.length);
                    state.harnessTailOrdinals.splice(position, 0, ordinal);
                }
                ordinal += 1;
                number = this.recordIndex.nextRecordOfKind("harness_message", number);
            }
        } finally {
            if (source === undefined) await file.close();
        }
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
        this.projection.permissionsEntries.splice(0, this.projection.permissionsEntries.length, entry);
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
        this.projection.nameEntries.splice(0, this.projection.nameEntries.length, entry);
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
        const existing = this.projection.attachmentsById.get(stored.id);
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
                || !sameAttachmentContent(durable.attachment, stored)
            ) {
                throw error;
            }
            this.recordIndex = durable.index;
            this.projection.knownMessageIds = new IndexedMessageIds(durable.index);
            addAttachmentEntry(this.projection, {
                ...entry,
                attachment: durable.attachment,
            });
            return { ...durable.attachment };
        }
        addAttachmentEntry(this.projection, entry);
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
        if (this.projection.leafId !== null) await this.ensureMessageIndexed(this.projection.leafId);
        const entry: SessionCompactionEntry = {
            type: "compaction",
            id: this.createId(),
            timestamp: this.now().toISOString(),
            ...validateCompaction(request, typeof request.boundaryMessageId === "string"
                ? this.recordIndex.compactionAnchor(this.projection.leafId, request.boundaryMessageId)
                : undefined),
        };
        await this.appendRecord(entry);
        if (this.projection.indexedLive) {
            await this.refreshIndexedUsage();
            this.projection.loadedCompactionId = entry.id;
            this.projection.currentCompactionNumber = this.recordIndex.length - 1;
            this.projection.compactionEntries.splice(0, this.projection.compactionEntries.length, entry);
            this.projection.askEntries.length = 0;
            const boundary = this.projection.activeMessagePositions.get(entry.boundaryMessageId);
            if (boundary !== undefined) {
                this.projection.carriedTurnText = carryDroppedTurnText(
                    this.projection.carriedTurnText, this.projection.activeMessageEntries, boundary,
                );
                this.projection.activeMessageEntries.splice(0, boundary + 1);
            }
            else {
                const active = await this.readActiveSuffix(entry.boundaryMessageId);
                const firstLive = this.projection.activeMessageEntries[0]?.id;
                const firstLivePosition = firstLive === undefined ? active.length : active.findIndex((item) => item.id === firstLive);
                this.projection.carriedTurnText = removeRestoredTurnText(
                    this.projection.carriedTurnText, active.slice(1, firstLivePosition),
                );
                this.projection.activeMessageEntries.splice(0, this.projection.activeMessageEntries.length, ...active.slice(1));
            }
            this.projection.activeMessagePositions.clear();
            for (const [position, current] of this.projection.activeMessageEntries.entries()) {
                this.projection.activeMessagePositions.set(current.id, position);
            }
            await this.restoreLiveHarness();
            this.trimHarnessTail();
            const tail: SessionMessageEntry[] = [];
            for (const number of this.recordIndex.recentMessages(this.projection.leafId, INDEXED_HISTORY_TAIL_BYTES)) {
                const id = this.recordIndex.messageId(number)!;
                const existing = this.projection.activeMessageEntries.find((current) => current.id === id)
                    ?? this.projection.historyTail.find((current) => current.id === id);
                const current = existing ?? await this.readMessageEntry(id);
                if (current !== undefined) tail.push(current);
            }
            this.projection.historyTail.splice(0, this.projection.historyTail.length, ...tail);
            this.projection.historyTailBytes = tail.reduce((total, current) =>
                total + this.recordIndex.location(this.recordIndex.messageRecord(current.id)!)!.length, 0);
        } else {
            this.projection.compactionEntries.push(entry);
        }
        return entry;
    }

    private async commitRewind(
        requestedUserMessageId: string,
    ): Promise<SessionRewindEntry> {
        const userMessageId = nonEmpty(
            requestedUserMessageId,
            "rewind user-message ID",
        );
        if (this.projection.leafId !== null) await this.ensureMessageIndexed(this.projection.leafId);
        const boundary = this.recordIndex.isAncestor(this.projection.leafId, userMessageId)
            ? await this.readMessageEntry(userMessageId)
            : undefined;
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
        if (this.projection.indexedLive) {
            const loaded = await scanIndexedSessionFile(this.path, false, this.readSource);
            this.projection = loaded.state;
            this.recordIndex = loaded.index;
            return entry;
        }
        rewindActiveBranch(this.projection, entry.headId);
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

    private async refreshIndexedUsage(): Promise<void> {
        const reply = this.projection.replyUsage.result();
        if (this.recordIndex.recordOfKind("compaction") === undefined
            && this.recordIndex.recordOfKind("session_ask") === undefined) {
            this.projection.indexedUsage = { rows: reply.rows.map((row) => ({ ...row })) };
            return;
        }
        const file = await open(this.path, "r");
        try {
            this.projection.indexedUsage = await readIndexedUsage(this.path, file, this.recordIndex, reply);
        } finally {
            await file.close();
        }
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
            const previous = this.projection;
            const compactionBoundary = stored.type === "compaction" && typeof stored.boundaryMessageId === "string"
                ? previous.activeMessagePositions.get(stored.boundaryMessageId) : undefined;
            const carried = stored.type === "compaction" && compactionBoundary !== undefined
                ? carryDroppedTurnText(previous.carriedTurnText, previous.activeMessageEntries, compactionBoundary)
                : undefined;
            if (this.projection.indexedLive && stored.type === "rewind") {
                await this.validateIndexedForeignRewind(this.lineCount + 1, stored);
            } else {
                ingestSessionRecord(this.path, this.lineCount + 1, stored, copyProjectionState(this.projection));
            }
            const lineNumber = await this.writeRecordLine(stored);
            if (this.projection.indexedLive && !(await this.applyIndexedForeignMessage(lineNumber, stored))) {
                const loaded = await scanIndexedSessionFile(this.path, false, this.readSource,
                    stored.type === "compaction" ? { value: carried } : undefined);
                if (stored.type === "compaction" && loaded.state.currentCompactionNumber !== lineNumber - 1) {
                    loaded.state.carriedTurnText = previous.carriedTurnText;
                } else if (stored.type === "compaction" && compactionBoundary === undefined) {
                    const firstLive = previous.activeMessageEntries[0]?.id;
                    const entries = loaded.state.activeMessageEntries;
                    const firstLivePosition = firstLive === undefined ? entries.length : entries.findIndex((item) => item.id === firstLive);
                    loaded.state.carriedTurnText = removeRestoredTurnText(previous.carriedTurnText,
                        entries.slice(0, firstLivePosition));
                }
                this.projection = loaded.state;
                this.recordIndex = loaded.index;
                return lineNumber;
            }
            if (!this.projection.indexedLive) ingestSessionRecord(this.path, lineNumber, stored, this.projection, true);
            return lineNumber;
        });
        this.pendingAppend = result.then(() => {}, () => {});
        return result;
    }

    private async validateIndexedForeignRewind(lineNumber: number, value: Record<string, unknown>): Promise<void> {
        const rewind = parseRewindEntry(this.path, lineNumber, value);
        if (rewind.previousHeadId !== this.projection.leafId) {
            throw invalidSession(this.path, `line ${lineNumber} rewinds from inactive head ${rewind.previousHeadId}`);
        }
        const boundary = this.recordIndex.isAncestor(this.projection.leafId, rewind.userMessageId)
            ? await this.readMessageEntry(rewind.userMessageId) : undefined;
        if (boundary === undefined || boundary.message.role !== "user" || boundary.message.internal === true) {
            throw invalidSession(this.path, `line ${lineNumber} does not reference an active user message ${rewind.userMessageId}`);
        }
        if (rewind.headId !== boundary.parentId) {
            throw invalidSession(this.path, `line ${lineNumber} has the wrong rewind target`);
        }
    }

    // Applies a durable foreign message like a local append; false means the caller rescans.
    private async applyIndexedForeignMessage(lineNumber: number, value: Record<string, unknown>): Promise<boolean> {
        if (value.type !== "message" && value.type !== "turn_start") return false;
        ingestSessionRecord(this.path, lineNumber, value, this.projection, true);
        const entry = this.projection.activeMessageEntries.at(-1)!;
        if (entry.message.role === "assistant" && entry.message.source.api !== "none") await this.refreshIndexedUsage();
        this.pushIndexedHistoryTail(entry);
        return !this.compactionMayChange(entry);
    }

    private pushIndexedHistoryTail(entry: SessionMessageEntry): void {
        const tail = this.projection.historyTail;
        const length = this.recordIndex.location(this.recordIndex.messageRecord(entry.id)!)!.length;
        if (length > INDEXED_HISTORY_TAIL_BYTES) {
            tail.length = 0;
            this.projection.historyTailBytes = 0;
            return;
        }
        tail.push(entry);
        this.projection.historyTailBytes += length;
        while (this.projection.historyTailBytes > INDEXED_HISTORY_TAIL_BYTES) {
            const removed = tail.shift()!;
            this.projection.historyTailBytes -= this.recordIndex.location(this.recordIndex.messageRecord(removed.id)!)!.length;
        }
    }

    private compactionMayChange(entry: SessionMessageEntry): boolean {
        const current = this.projection.compactionEntries.at(-1);
        const mayChange = current === undefined
            ? this.recordIndex.recordOfKind("compaction") !== undefined
            : current.firstRetainedMessageId === null && current.boundaryMessageId === entry.parentId
                && entry.message.role === "tool_result";
        return mayChange && this.recordIndex.latestApplicableCompaction(entry.id) !== this.projection.currentCompactionNumber;
    }

    // Every append runs behind pendingAppend, so this store's own writes cannot race the rollback.
    private async writeRecordLine(record: object): Promise<number> {
        if (this.readonlySnapshot) throw new Error(`Session snapshot ${this.path} cannot write records`);
        if (this.writeFault !== undefined) {
            throw this.writeFault;
        }
        const line = jsonLine(record);
        const bytes = Buffer.from(line, "utf8");
        const file = await this.openAppendFile(this.path);
        let lengthBefore = 0;
        try {
            ({ size: lengthBefore } = await file.stat());
            try {
                await file.append(bytes);
                await file.sync();
            } catch (error) {
                const fault = await this.restoreLength(file, lengthBefore, bytes.length);
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
        this.recordIndex.append(lengthBefore, bytes.length, record as Record<string, unknown>);
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
): Promise<{ attachment: SessionImageAttachmentMetadata; index: SessionRecordIndex } | undefined> {
    try {
        const loaded = await scanIndexedSessionFile(path, false);
        const attachment = loaded.state.attachmentEntries.find(
            (entry) => entry.attachment.id === id,
        )?.attachment;
        return attachment === undefined ? undefined : { attachment, index: loaded.index };
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
    const loaded = await scanSessionIndex(path);
    const header = parseHeaderRecord(path, loaded.header);
    return {
        sessionId: header.id,
        turnOpen: loaded.turnOpen,
        needsQueueRecovery: loaded.agentFailure === undefined && loaded.queuedPromptRecords.length > 0,
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
    const loaded = await scanSessionFile(path, false);
    const active = loaded.state.activeMessageEntries;
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
    readonly id: string;
    readonly text: string;
    readonly tone: "primary" | "soft" | "error";
}[] {
    return entries.flatMap((entry, index) => {
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
            : [{
                afterMessage,
                id: `harness:${index}`,
                text: entry.text,
                tone: entry.tone,
            }];
    });
}

interface KnownMessageIds {
    has(id: string): boolean;
    add(id: string): void;
    copy(): KnownMessageIds;
}

class IndexedMessageIds implements KnownMessageIds {
    constructor(private readonly index: SessionRecordIndex) {}
    has(id: string): boolean { return this.index.messageRecord(id) !== undefined; }
    add(_id: string): void {}
    copy(): KnownMessageIds { return new IndexedMessageIds(this.index); }
}

class ReplicaMessageIds implements KnownMessageIds {
    private readonly ids: Set<string>;
    constructor(ids: Iterable<string> = []) { this.ids = new Set(ids); }
    has(id: string): boolean { return this.ids.has(id); }
    add(id: string): void { this.ids.add(id); }
    copy(): KnownMessageIds { return new ReplicaMessageIds(this.ids); }
}

export interface SessionProjectionState {
    replyUsage: SessionUsageAccumulator;
    indexedLive: boolean;
    indexedUsage: SessionModelUsage | undefined;
    canonicalMeasurements: boolean;
    currentCompactionNumber: number | undefined;
    loadedCompactionId: string | undefined;
    readonly historyTail: SessionMessageEntry[];
    historyTailBytes: number;
    harnessTailBytes: number;
    readonly harnessTailLengths: number[];
    readonly harnessTailOrdinals: number[];
    harnessTotal: number;
    // Message appends and rewinds update these indexes, including replica and repair appends.
    // Compaction and harness records do not change the active branch.
    readonly activeMessageEntries: SessionMessageEntry[];
    readonly activeMessagePositions: Map<string, number>;
    readonly activeDeliveryIds: Set<string>;
    firstUser: { readonly id: string; readonly title?: string } | undefined;
    latestMessageTimestamp: string | undefined;
    latestMeasuredAssistantTimestamp: string | undefined;
    turnCount: number;
    carriedTurnText: SessionTurnText | undefined;
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
    // Attachments are append-only, including when an uncertain write is recovered.
    readonly attachmentsById: Map<string, SessionAttachmentEntry>;
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
    knownMessageIds: KnownMessageIds;
    readonly knownDeliveryIds: Set<string>;
    readonly knownAttachmentIds: Set<string>;
    agentFailure: SessionAgentFailureEntry | undefined;
    leafId: string | null;
    openTurnStartId: string | undefined;
}

export function createSessionProjectionState(index?: SessionRecordIndex): SessionProjectionState {
    return {
        replyUsage: new SessionUsageAccumulator(),
        indexedLive: false,
        indexedUsage: undefined,
        canonicalMeasurements: true,
        currentCompactionNumber: undefined,
        loadedCompactionId: undefined,
        historyTail: [],
        historyTailBytes: 0,
        harnessTailBytes: 0,
        harnessTailLengths: [],
        harnessTailOrdinals: [],
        harnessTotal: 0,
        activeMessageEntries: [],
        activeMessagePositions: new Map(),
        activeDeliveryIds: new Set(),
        firstUser: undefined,
        latestMessageTimestamp: undefined,
        latestMeasuredAssistantTimestamp: undefined,
        turnCount: 0,
        carriedTurnText: undefined,
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
        attachmentsById: new Map(),
        compactionEntries: [],
        askEntries: [],
        contextMeasurementEntries: [],
        contextMeasurementBase: undefined,
        contextMeasurementLastRecordCompact: false,
        contextMeasurementsSinceKeyframe: 0,
        contextMeasurementLastComponents: undefined,
        knownMessageIds: index === undefined ? new ReplicaMessageIds() : new IndexedMessageIds(index),
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
        replyUsage: new SessionUsageAccumulator(state.replyUsage.result()),
        indexedLive: state.indexedLive,
        indexedUsage: state.indexedUsage,
        canonicalMeasurements: state.canonicalMeasurements,
        currentCompactionNumber: state.currentCompactionNumber,
        loadedCompactionId: state.loadedCompactionId,
        historyTail: [...state.historyTail],
        historyTailBytes: state.historyTailBytes,
        harnessTailBytes: state.harnessTailBytes,
        harnessTailLengths: [...state.harnessTailLengths],
        harnessTailOrdinals: [...state.harnessTailOrdinals],
        harnessTotal: state.harnessTotal,
        activeMessageEntries: [...state.activeMessageEntries],
        activeMessagePositions: new Map(state.activeMessagePositions),
        activeDeliveryIds: new Set(state.activeDeliveryIds),
        firstUser: state.firstUser,
        latestMessageTimestamp: state.latestMessageTimestamp,
        latestMeasuredAssistantTimestamp: state.latestMeasuredAssistantTimestamp,
        turnCount: state.turnCount,
        carriedTurnText: state.carriedTurnText,
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
        attachmentsById: new Map(state.attachmentsById),
        compactionEntries: [...state.compactionEntries],
        askEntries: [...state.askEntries],
        contextMeasurementEntries: [...state.contextMeasurementEntries],
        contextMeasurementBase: state.contextMeasurementBase,
        contextMeasurementLastRecordCompact: state.contextMeasurementLastRecordCompact,
        contextMeasurementsSinceKeyframe: state.contextMeasurementsSinceKeyframe,
        contextMeasurementLastComponents: state.contextMeasurementLastComponents,
        knownMessageIds: state.knownMessageIds.copy(),
        knownDeliveryIds: new Set(state.knownDeliveryIds),
        knownAttachmentIds: new Set(state.knownAttachmentIds),
        agentFailure: state.agentFailure,
        leafId: state.leafId,
        openTurnStartId: state.openTurnStartId,
    };
}

function appendActiveMessage(state: SessionProjectionState, entry: SessionMessageEntry): void {
    const stored = { ...entry };
    if (stored.message.role === "assistant" && stored.message.source.api !== "none") state.replyUsage.add(stored.message);
    state.knownMessageIds.add(stored.id);
    state.activeMessagePositions.set(stored.id, state.activeMessageEntries.length);
    state.activeMessageEntries.push(stored);
    if (state.firstUser === undefined && stored.message.role === "user" && stored.message.internal !== true) {
        const title = firstUserTitle(stored.message);
        state.firstUser = { id: stored.id, ...(title === undefined ? {} : { title }) };
    }
    state.latestMessageTimestamp = stored.timestamp;
    if (stored.message.role === "assistant" && stored.message.usage.inputTokens > 0
        && (state.latestMeasuredAssistantTimestamp === undefined || stored.timestamp > state.latestMeasuredAssistantTimestamp)) {
        state.latestMeasuredAssistantTimestamp = stored.timestamp;
    }
    if (startsSessionTurn(stored.message)) state.turnCount += 1;
    if (startsTurnEntry(stored)) state.carriedTurnText = undefined;
    if (stored.deliveryId !== undefined) state.activeDeliveryIds.add(stored.deliveryId);
    state.leafId = stored.id;
}

function firstUserTitle(message: Extract<ModelMessage, { role: "user" }>): string | undefined {
    let title = "";
    let pendingSpace = false;
    let seenText = false;
    for (const part of message.content) {
        if (part.type !== "text") continue;
        if (seenText && title.length > 0) pendingSpace = true;
        seenText = true;
        for (let index = 0; index < part.text.length; index += 1) {
            const character = part.text[index]!;
            if (/\s/.test(character)) {
                if (title.length > 0) pendingSpace = true;
                continue;
            }
            if (pendingSpace && title.length < 80) title += " ";
            pendingSpace = false;
            if (title.length < 80) title += character;
            if (title.length === 80) return title;
        }
    }
    return title.length === 0 ? undefined : title;
}

function rewindActiveBranch(state: SessionProjectionState, headId: string | null): void {
    while (state.activeMessageEntries.length > 0 && state.activeMessageEntries.at(-1)?.id !== headId) {
        const removed = state.activeMessageEntries.pop()!;
        if (state.firstUser?.id === removed.id) state.firstUser = undefined;
        if (startsSessionTurn(removed.message)) state.turnCount -= 1;
        state.activeMessagePositions.delete(removed.id);
        if (removed.deliveryId !== undefined) state.activeDeliveryIds.delete(removed.deliveryId);
    }
    state.latestMessageTimestamp = state.activeMessageEntries.at(-1)?.timestamp;
    state.latestMeasuredAssistantTimestamp = undefined;
    for (const entry of state.activeMessageEntries) {
        if (entry.message.role === "assistant" && entry.message.usage.inputTokens > 0
            && (state.latestMeasuredAssistantTimestamp === undefined || entry.timestamp > state.latestMeasuredAssistantTimestamp)) {
            state.latestMeasuredAssistantTimestamp = entry.timestamp;
        }
    }
    state.leafId = headId;
}

export function startsSessionTurn(message: ModelMessage): boolean {
    return message.role === "user"
        && message.internal !== true
        && message.contextSource === undefined
        && message.arrivedDuringTurn !== true;
}

function startsTurnEntry(entry: SessionMessageEntry): boolean {
    return startsSessionTurn(entry.message) || entry.deliveryId !== undefined;
}

export function sessionTurnTextPart(message: ModelMessage): { readonly role: "user" | "assistant"; readonly text: string } | undefined {
    if ((message.role !== "user" && message.role !== "assistant") || message.internal === true
        || (message.role === "user" && message.contextSource !== undefined)) return undefined;
    const text = message.content.map((part) => part.type === "text" ? part.text : "").join("").trim();
    return text.length === 0 ? undefined : { role: message.role, text };
}

function carryDroppedTurnText(
    previous: SessionTurnText | undefined,
    entries: readonly SessionMessageEntry[],
    boundary: number,
): SessionTurnText | undefined {
    const lastStart = entries.findLastIndex(startsTurnEntry);
    if (lastStart > boundary) return undefined;
    if (lastStart < 0 && previous === undefined) return undefined;
    const prompt = lastStart < 0 ? [...previous!.prompt] : [];
    const reply = lastStart < 0 ? [...previous!.reply] : [];
    for (let position = Math.max(0, lastStart); position <= boundary; position += 1) {
        const part = sessionTurnTextPart(entries[position]!.message);
        if (part !== undefined) (part.role === "user" ? prompt : reply).push(part.text);
    }
    return { prompt, reply };
}

function removeRestoredTurnText(
    previous: SessionTurnText | undefined,
    entries: readonly SessionMessageEntry[],
): SessionTurnText | undefined {
    if (previous === undefined || entries.some(startsTurnEntry)) return undefined;
    const prompt = [...previous.prompt];
    const reply = [...previous.reply];
    for (const entry of entries.toReversed()) {
        const part = sessionTurnTextPart(entry.message);
        if (part === undefined) continue;
        const parts = part.role === "user" ? prompt : reply;
        if (parts.pop() !== part.text) throw new Error("Restored turn text does not match the carried text");
    }
    return { prompt, reply };
}

function addAttachmentEntry(state: SessionProjectionState, entry: SessionAttachmentEntry): void {
    const stored = { ...entry, attachment: { ...entry.attachment } };
    state.attachmentEntries.push(stored);
    state.attachmentsById.set(stored.attachment.id, stored);
    state.knownAttachmentIds.add(stored.attachment.id);
}

export function ingestSessionRecord(
    path: string,
    lineNumber: number,
    value: Record<string, unknown>,
    state: SessionProjectionState,
    alreadyIndexed = false,
): void {
    const {
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
        if (!alreadyIndexed && knownMessageIds.has(entry.id)) {
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
            if (state.activeDeliveryIds.has(entry.deliveryId)) {
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
        appendActiveMessage(state, entry);
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
        const activeHead = state.activeMessageEntries.at(-1);
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
        const entry = parseModelSettingsEntry(path, lineNumber, value);
        modelSettingsEntries.splice(0, modelSettingsEntries.length, entry);
        return;
    }
    // agent_wear is the name this record had before the select rename.
    if (value.type === "agent_select" || value.type === "agent_wear") {
        const entry = parseSelectedAgentEntry(path, lineNumber, value);
        selectedAgentEntries.splice(0, selectedAgentEntries.length, entry);
        return;
    }
    if (value.type === "permissions") {
        const entry = parsePermissionsEntry(path, lineNumber, value);
        permissionsEntries.splice(0, permissionsEntries.length, entry);
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
        const entry = parseSessionNameEntry(path, lineNumber, value);
        nameEntries.splice(0, nameEntries.length, entry);
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
            const existing = state.attachmentsById.get(entry.attachment.id);
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
        addAttachmentEntry(state, entry);
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
        const position = state.activeMessagePositions.get(rewind.userMessageId);
        const boundary = position === undefined ? undefined : state.activeMessageEntries[position];
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
        rewindActiveBranch(state, rewind.headId);
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

async function scanIndexedSessionFile(
    path: string,
    repair: boolean,
    source?: FileHandle,
    carried?: { readonly value: SessionTurnText | undefined },
): Promise<ParsedSessionFile> {
    const file = source ?? await open(path, "r");
    try {
        const live = await readIndexedLiveContext(path, file, repair);
        const state = createSessionProjectionState(live.index);
        state.indexedLive = true;
        state.replyUsage = new SessionUsageAccumulator(live.replyUsage);
        state.indexedUsage = live.usage;
        state.canonicalMeasurements = live.canonicalMeasurements;
        state.contextMeasurementBase = live.measurementRecipeState.base;
        state.contextMeasurementLastRecordCompact = live.measurementRecipeState.lastRecordCompact;
        state.contextMeasurementsSinceKeyframe = live.measurementRecipeState.sinceKeyframe;
        state.leafId = live.headId;
        state.firstUser = live.firstUser;
        state.latestMessageTimestamp = live.latestMessageTimestamp;
        state.latestMeasuredAssistantTimestamp = live.latestMeasuredAssistantTimestamp;
        state.turnCount = live.turnCount;
        state.carriedTurnText = carried === undefined
            ? await readCarriedTurnText(path, file, live.index,
                live.compactionNumber === undefined ? undefined : live.index.compactionBoundary(live.compactionNumber), live.entries)
            : carried.value;
        state.openTurnStartId = live.openTurnStartId;
        state.unsentPrompts = live.unsentPrompts;
        state.activeMessageEntries.push(...live.entries);
        for (const id of live.activeDeliveryIds) state.activeDeliveryIds.add(id);
        for (const [position, entry] of live.entries.entries()) {
            state.activeMessagePositions.set(entry.id, position);
            if (entry.deliveryId !== undefined) state.activeDeliveryIds.add(entry.deliveryId);
        }
        state.historyTail.push(...live.tail);
        for (const entry of live.tail) {
            state.historyTailBytes += live.index.location(live.index.messageRecord(entry.id)!)!.length;
        }
        for (const prompt of live.queuedPrompts) state.queuedPrompts.set(prompt.id, prompt);
        if (live.name !== undefined) state.nameEntries.push(live.name);
        if (live.settings !== undefined) state.modelSettingsEntries.push(live.settings);
        if (live.permissions !== undefined) state.permissionsEntries.push(live.permissions);
        if (live.identity !== undefined) state.identityEntries.push(live.identity);
        if (live.selectedAgent !== undefined) state.selectedAgentEntries.push(live.selectedAgent);
        if (live.compaction !== undefined) {
            state.compactionEntries.push(live.compaction);
            state.loadedCompactionId = live.compaction.id;
            state.currentCompactionNumber = live.compactionNumber;
        }
        if (live.measurement !== undefined) {
            const number = live.index.latestMeasurement(live.headId)!;
            const location = live.index.location(number)!;
            const value = parseJsonObject(path, number + 1, await readSessionLine(path, location.offset, location.length, file));
            if (typeof value.timestamp !== "string" || (value.afterMessageId !== null && typeof value.afterMessageId !== "string")) {
                throw invalidSession(path, `line ${number + 1} is not a valid context measurement entry`);
            }
            state.contextMeasurementEntries.push({ type: "context_measurement", timestamp: value.timestamp,
                afterMessageId: value.afterMessageId, measurement: live.measurement });
            state.contextMeasurementLastComponents = live.measurement.projection?.components;
        }
        const read = async (number: number): Promise<Record<string, unknown>> => {
            const location = live.index.location(number)!;
            return parseJsonObject(path, number + 1, await readSessionLine(path, location.offset, location.length, file));
        };
        const plain = new Set(["message", "turn_start", "rewind", "compaction", "context_measurement", "session_ask",
            "session_name", "model_settings", "permissions", "session_identity", "agent_select", "agent_wear", "agent_failure"]);
        const liveMessageNumbers = new Set(live.entries.map((entry) => live.index.messageRecord(entry.id)!));
        const unanchoredTail = new Set<number>();
        let harnessTailBudget = INDEXED_HARNESS_TAIL_BYTES;
        for (let number = live.index.length - 1; number > 0; number -= 1) {
            if (live.index.kind(number) !== "harness_message") continue;
            const anchor = live.index.harnessAnchor(number);
            if (anchor !== undefined && liveMessageNumbers.has(anchor)) continue;
            const length = live.index.location(number)!.length;
            if (length > harnessTailBudget) harnessTailBudget = 0;
            else {
                unanchoredTail.add(number);
                harnessTailBudget -= length;
            }
        }
        for (let number = 1; number < live.index.length; number += 1) {
            const kind = live.index.kind(number);
            if (kind !== undefined && plain.has(kind)) continue;
            const harnessOrdinal = kind === "harness_message" ? state.harnessTotal++ : undefined;
            const harnessAnchor = kind === "harness_message" ? live.index.harnessAnchor(number) : undefined;
            const liveHarness = harnessAnchor !== undefined && liveMessageNumbers.has(harnessAnchor);
            if (kind === "harness_message" && !liveHarness && !unanchoredTail.has(number)) continue;
            const value = await read(number);
            if (kind === "queued_prompt") {
                if (typeof value.id !== "string" || value.id.length === 0) throw invalidSession(path, `line ${number + 1} is not a valid queued prompt`);
                state.knownQueuedPromptIds.add(value.id);
            } else if (kind === "queued_prompt_removed") {
                continue;
            } else if (kind === "harness_message") {
                state.harnessMessageEntries.push(parseHarnessMessageEntry(path, number + 1, value));
                const length = live.index.location(number)!.length;
                if (!liveHarness) state.harnessTailBytes += length;
                state.harnessTailLengths.push(length);
                state.harnessTailOrdinals.push(harnessOrdinal!);
            } else if (kind === "delivery") {
                const entry = parseDeliveryEntry(path, number + 1, value);
                state.deliveryEntries.push(entry);
                state.knownDeliveryIds.add(entry.id);
            } else if (kind === "delivery_receipt") {
                const entry = parseDeliveryReceipt(path, number + 1, value);
                if (!state.knownDeliveryIds.has(entry.deliveryId)) {
                    throw invalidSession(path, `line ${number + 1} references missing delivery ${entry.deliveryId}`);
                }
                if (state.deliveryReceipts.has(entry.deliveryId)) {
                    throw invalidSession(path, `line ${number + 1} repeats delivery receipt ${entry.deliveryId}`);
                }
                state.deliveryReceipts.add(entry.deliveryId);
                const associated = live.index.associatedMessage(number);
                if (associated !== undefined && live.index.isLegacyDeliveryMessage(associated)) {
                    state.legacyDeliveryMessageIds.set(entry.deliveryId, live.index.messageId(associated)!);
                }
            } else if (kind === "attachment") {
                const entry = parseAttachmentEntry(path, number + 1, value);
                const existing = state.attachmentsById.get(entry.attachment.id);
                if (existing === undefined) addAttachmentEntry(state, entry);
                else if (!sameAttachmentContent(existing.attachment, entry.attachment)) {
                    throw invalidSession(path, `line ${number + 1} repeats attachment ID ${entry.attachment.id}`);
                }
            } else if (kind === "permission_grants") {
                state.permissionGrantEntries.push(parsePermissionGrantsEntry(path, number + 1, value));
            } else if (kind === "permission_grant_revocation") {
                state.permissionGrantRevocationEntries.push(parsePermissionGrantRevocationEntry(path, number + 1, value));
            } else if (kind === "command_prefix") {
                parseLegacyCommandPrefixEntry(path, number + 1, value);
            } else if (kind === "checkpoint") {
                parseRemovedFileCheckpointEntry(path, number + 1, value);
            } else {
                throw invalidSession(path, `line ${number + 1} is not a valid session entry`);
            }
        }
        state.agentFailure = live.agentFailure;
        return { header: live.header, state, index: live.index, lineCount: live.lineCount };
    } finally {
        if (source === undefined) await file.close();
    }
}

async function scanSessionFile(path: string, repair: boolean, source?: FileHandle): Promise<ParsedSessionFile> {
    let header: SessionHeader | undefined;
    const index = new SessionRecordIndex();
    const state = createSessionProjectionState(index);
    const deferred: DeferredContextMeasurement[] = [];
    let failureLine: number | undefined;
    let scanError: unknown;
    let lineCount = 0;
    const file = source ?? await open(path, "r");
    try {
        const sizes = await scanSessionLines(path, (scanned) => {
            const { offset, length, bytes } = scanned;
            lineCount += 1;
            if (scanError !== undefined) return;
            try {
                if (lineCount === 1) {
                    header = parseHeader(path, scanned.text);
                    index.append(offset, length, header as unknown as Record<string, unknown>);
                    return;
                }
                const measurementHeader = contextMeasurementHeader(bytes);
                if (measurementHeader !== undefined) {
                    deferred.push({ lineNumber: lineCount, afterMessageId: measurementHeader.afterMessageId, offset, length,
                        compact: measurementHeader.compact });
                    index.append(offset, length, { type: "context_measurement", afterMessageId: measurementHeader.afterMessageId },
                        measurementHeader.compact);
                    return;
                }
                const value = parseJsonObject(path, lineCount, scanned.text);
                if (value.type === "context_measurement") {
                    const afterMessageId = value.afterMessageId;
                    if (afterMessageId !== null && typeof afterMessageId !== "string") {
                        throw invalidSession(path, `line ${lineCount} is not a valid context measurement entry`);
                    }
                    deferred.push({ lineNumber: lineCount, afterMessageId, offset, length,
                        compact: value.contextRecipe !== undefined });
                } else {
                    ingestSessionRecord(path, lineCount, value, state);
                    if (state.agentFailure !== undefined && failureLine === undefined) failureLine = lineCount;
                }
                index.append(offset, length, value);
            } catch (error) {
                scanError = error;
            }
        }, false, file);
        if (sizes.completeBytes === 0) throw invalidSession(path, "has no complete header line");
        if (repair && sizes.completeBytes !== sizes.totalBytes) {
            const file = await open(path, "r+");
            try {
                await file.truncate(sizes.completeBytes);
                await file.sync();
            } finally {
                await file.close();
            }
        }
        if (scanError !== undefined) throw scanError;
        for (const candidate of deferred) {
            if (failureLine !== undefined && candidate.lineNumber > failureLine) {
                throw invalidSession(path, `line ${candidate.lineNumber} follows the terminal agent failure`);
            }
        }
        await ingestDeferredContextMeasurements(path, state, deferred, file);
        return { header: header!, state, lineCount, index };
    } finally {
        if (source === undefined) await file.close();
    }
}

interface DeferredContextMeasurement {
    readonly lineNumber: number;
    readonly afterMessageId: string | null;
    readonly offset: number;
    readonly length: number;
    readonly compact: boolean;
}

async function ingestDeferredContextMeasurements(
    path: string,
    state: SessionProjectionState,
    deferred: readonly DeferredContextMeasurement[],
    file: Awaited<ReturnType<typeof open>>,
): Promise<void> {
    if (deferred.length === 0) return;
    const kept = reachableContextMeasurementIndexes(
        state,
        deferred.map((candidate) => candidate.afterMessageId),
    );
    let window = Buffer.allocUnsafe(SESSION_SCAN_CHUNK_BYTES);
    let windowOffset = -1;
    let windowLength = 0;
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
        if (candidate.offset < windowOffset || candidate.offset + candidate.length > windowOffset + windowLength) {
            if (window.length < candidate.length) window = Buffer.allocUnsafe(candidate.length);
            windowOffset = candidate.offset;
            windowLength = 0;
            while (windowLength < candidate.length) {
                const result = await file.read(window, windowLength, window.length - windowLength, windowOffset + windowLength);
                if (result.bytesRead === 0) throw new Error(`Unexpected end of session file ${path}`);
                windowLength += result.bytesRead;
            }
        }
        const start = candidate.offset - windowOffset;
        const value = parseJsonObject(path, candidate.lineNumber,
            window.subarray(start, start + candidate.length - 1).toString("utf8"));
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
    const active = state.activeMessageEntries;
    const positionById = state.activeMessagePositions;
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

    const kept = new Set<number>();
    let running = latestNull;
    for (let position = -1; position < active.length; position += 1) {
        const latest = latestAt.get(position);
        if (latest !== undefined) running = Math.max(running, latest);
        if (points.has(position) && running >= 0) kept.add(running);
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
    anchor: SessionCompactionAnchor | undefined,
): Omit<SessionCompactionEntry, "type" | "id" | "timestamp"> {
    const boundaryMessageId = nonEmpty(
        request.boundaryMessageId,
        "compaction boundary message ID",
    );
    if (anchor === undefined) {
        throw new Error(
            `Compaction boundary ${boundaryMessageId} is not an active message`,
        );
    }
    if (anchor.crossesBarrier) {
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
    if (retained !== anchor.successorId) {
        throw new Error(
            "Compaction must retain the message following its boundary",
        );
    }
    if (anchor.successorIsToolResult) {
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
