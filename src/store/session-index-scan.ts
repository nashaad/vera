import { scanSessionBytes, scanSessionRanges } from "./session-lines.ts";
import { keyMatches, objectProperty, sessionFirstUserTitle, SessionFieldScanner, skipWhitespace, valueEnd } from "./session-json-fields.ts";
import { canonicalCompactMeasurementLength, measurementComponentsCanonical } from "./session-measurement-fields.ts";
import { SessionRecordIndex } from "./session-record-index.ts";
import { open, type FileHandle } from "node:fs/promises";
import { contextMeasurementHeader, readAsciiMeasurementHeader, readAsciiMessageHeader,
    type AsciiMeasurementHeader, type AsciiMessageHeader } from "./session-record-header.ts";
import { readRecordTimestamp } from "./session-record-timestamp.ts";
import { SessionUsageAccumulator, type SessionModelUsage } from "../model/session-usage.ts";
import { replyUsageFields } from "./session-usage-fields.ts";
import type { ModelUsage } from "../model/types.ts";
import { SessionTimestampMaxima } from "./session-timestamp-maxima.ts";

const IMAGE_ATTACHMENT = Buffer.from("image_attachment");

export interface ScannedSessionIndex {
    readonly header: Record<string, unknown>;
    readonly index: SessionRecordIndex;
    readonly headId: string | null;
    readonly lineCount: number;
    readonly completeBytes: number;
    readonly totalBytes: number;
    readonly firstUser?: { readonly id: string; readonly title?: string };
    readonly latestMessageTimestamp?: string;
    readonly latestMeasuredAssistantTimestamp?: string;
    readonly turnCount: number;
    readonly agentFailure?: { readonly type: "agent_failure"; readonly id: string; readonly timestamp: string; readonly detail: string };
    readonly replyUsage: SessionModelUsage;
    readonly openTurnStartId?: string;
    readonly turnOpen: boolean;
    readonly queuedPromptRecords: readonly number[];
    readonly activeDeliveryIds: readonly string[];
    readonly canonicalMeasurements: boolean;
    readonly unsentPromptRecord?: number;
}

export async function scanSessionRecordLocations(path: string, maxRecords: number): Promise<SessionRecordIndex> {
    const index = new SessionRecordIndex(maxRecords);
    const scanner = new SessionFieldScanner();
    const record = { type: "" };
    await scanSessionBytes(path, (offset, length, bytes) => {
        const fields = scanner.read(bytes);
        if (fields === undefined || typeof fields.type !== "string") {
            throw new Error(`Invalid session file ${path}: line ${index.length + 1} is not a valid record`);
        }
        record.type = fields.type;
        index.append(offset, length, record);
    }, false, undefined, maxRecords);
    return index;
}

export async function scanSessionIndex(path: string, source?: FileHandle, repair = false, maxRecords?: number): Promise<ScannedSessionIndex> {
    const file = source ?? await open(path, "r");
    try {
        return await scanSessionIndexFromFile(path, file, repair, maxRecords);
    } finally {
        if (source === undefined) await file.close();
    }
}

async function scanSessionIndexFromFile(path: string, source: FileHandle, repair: boolean, maxRecords?: number): Promise<ScannedSessionIndex> {
    const index = new SessionRecordIndex(maxRecords ?? await countSessionRecords(path, source));
    let header: Record<string, unknown> | undefined;
    let head: number | undefined;
    let lineCount = 0;
    let scanError: unknown;
    let firstUser: { readonly id: string; readonly title?: string } | undefined;
    let agentFailure: ScannedSessionIndex["agentFailure"];
    const replyUsage = new SessionUsageAccumulator();
    const measuredMaxima = new SessionTimestampMaxima();
    let openTurnStartId: string | undefined;
    const queuedPrompts = new Map<string, number>();
    const deliveries = new Set<string>();
    const activeDeliveries = new Map<string, number>();
    const attachmentIds = new Set<string>();
    let unsentPromptRecord: number | undefined;
    let canonicalMeasurements = true;
    let measurementLength: number | undefined;
    const fieldScanner = new SessionFieldScanner();
    const asciiHeader: AsciiMessageHeader = { type: "message", idStart: 0, idEnd: 0, parentStart: -1, parentEnd: -1 };
    const asciiMeasurement: AsciiMeasurementHeader = { afterStart: -1, afterEnd: -1, compact: false };
    const indexedMeasurement: { type: string; afterMessageId: string | null } = {
        type: "context_measurement", afterMessageId: null,
    };
    const sizes = await scanSessionRanges(path, (offset, length, bytes, start, end) => {
        if (maxRecords !== undefined && lineCount >= maxRecords) return;
        lineCount += 1;
        if (scanError !== undefined) return;
        try {
            if (lineCount > 1) {
                let forceGeneral = false;
                if (canonicalMeasurements && readAsciiMeasurementHeader(bytes, asciiMeasurement, start, end)
                    && asciiMeasurement.compact) {
                    const nextLength = canonicalCompactMeasurementLength(bytes, measurementLength,
                        asciiMeasurement.afterStart < 0 ? null : undefined, start, end,
                        asciiMeasurement.afterStart, asciiMeasurement.afterEnd);
                    if (nextLength !== undefined) {
                        if (agentFailure !== undefined) throw new Error(`Invalid session file ${path}: line ${lineCount} follows the terminal agent failure`);
                        measurementLength = nextLength;
                        index.appendAsciiMeasurement(offset, length, bytes, asciiMeasurement.afterStart, asciiMeasurement.afterEnd);
                        return;
                    }
                    canonicalMeasurements = false;
                    forceGeneral = true;
                }
                const measurement = forceGeneral ? undefined : contextMeasurementHeader(bytes, start, end);
                if (measurement !== undefined) {
                    if (agentFailure !== undefined) throw new Error(`Invalid session file ${path}: line ${lineCount} follows the terminal agent failure`);
                    if (canonicalMeasurements) {
                        if (measurement.compact) {
                            measurementLength = canonicalCompactMeasurementLength(bytes, measurementLength, measurement.afterMessageId, start, end);
                            if (measurementLength === undefined) canonicalMeasurements = false;
                        } else {
                            measurementLength = undefined;
                            if (!measurementComponentsCanonical(bytes, false, start)) canonicalMeasurements = false;
                        }
                    }
                    indexedMeasurement.afterMessageId = measurement.afterMessageId;
                    index.append(offset, length, indexedMeasurement, measurement.compact);
                    return;
                }
            }
            let ascii = lineCount > 1 && readAsciiMessageHeader(bytes, asciiHeader, start, end);
            let fields = fieldScanner.read(bytes, ascii, start, end);
            if (fields === undefined) throw new Error(`Invalid session file ${path}: line ${lineCount} is not valid JSON`);
            if (ascii && (fields.type !== asciiHeader.type || fields.scannedIdCount !== 1 || fields.scannedParentCount !== 1)) {
                ascii = false;
                fields = fieldScanner.read(bytes, false, start, end);
                if (fields === undefined) throw new Error(`Invalid session file ${path}: line ${lineCount} is not valid JSON`);
            }
            if (fields.type === "context_measurement" && canonicalMeasurements) {
                if (fields.compact === true && fields.afterMessageId !== undefined) {
                    measurementLength = canonicalCompactMeasurementLength(bytes, measurementLength, fields.afterMessageId, start, end);
                    if (measurementLength === undefined) canonicalMeasurements = false;
                } else {
                    measurementLength = undefined;
                    if (!measurementComponentsCanonical(bytes, false, start)) canonicalMeasurements = false;
                }
            }
            if (fields.type === "agent_failure") {
                const value: unknown = JSON.parse(bytes.toString("utf8", start, end));
                if (typeof value !== "object" || value === null || Array.isArray(value)
                    || typeof Reflect.get(value, "id") !== "string" || Reflect.get(value, "id").length === 0
                    || typeof Reflect.get(value, "timestamp") !== "string" || Number.isNaN(Date.parse(Reflect.get(value, "timestamp")))
                    || typeof Reflect.get(value, "detail") !== "string" || Reflect.get(value, "detail").trim().length === 0) {
                    throw new Error(`Invalid session file ${path}: line ${lineCount} is not a valid agent failure entry`);
                }
                const failure = { type: "agent_failure" as const, id: Reflect.get(value, "id") as string,
                    timestamp: Reflect.get(value, "timestamp") as string, detail: Reflect.get(value, "detail") as string };
                if (agentFailure !== undefined && (agentFailure.id !== failure.id || agentFailure.detail !== failure.detail)) {
                    throw new Error(`Invalid session file ${path}: line ${lineCount} follows the terminal agent failure`);
                }
                agentFailure ??= failure;
            } else if (agentFailure !== undefined) {
                throw new Error(`Invalid session file ${path}: line ${lineCount} follows the terminal agent failure`);
            }
            if (lineCount === 1) {
                header = JSON.parse(bytes.toString("utf8", start, end)) as Record<string, unknown>;
            } else if (fields.type === "message" || fields.type === "turn_start") {
                if ((!ascii && (typeof fields.id !== "string" || fields.id.length === 0 || fields.parentId === undefined))
                    || fields.timestampStringPresent !== true || fields.message === undefined) {
                    throw new Error(`Invalid session file ${path}: line ${lineCount} is not a valid message entry`);
                }
                if ((fields.message.role !== "user" && fields.message.role !== "assistant" && fields.message.role !== "tool_result")
                    || (fields.message.internal !== undefined && typeof fields.message.internal !== "boolean")) {
                    throw new Error(`Invalid session file ${path}: line ${lineCount} is not a valid message entry`);
                }
                const existing = ascii ? index.messageRecordAscii(bytes, asciiHeader.idStart, asciiHeader.idEnd)
                    : index.messageRecord(fields.id!);
                if (existing !== undefined) {
                    const id = ascii ? bytes.toString("ascii", asciiHeader.idStart, asciiHeader.idEnd) : fields.id;
                    throw new Error(`Invalid session file ${path}: line ${lineCount} repeats entry ID ${id}`);
                }
                const parentExists = ascii ? asciiHeader.parentStart < 0
                    || index.messageRecordAscii(bytes, asciiHeader.parentStart, asciiHeader.parentEnd) !== undefined
                    : fields.parentId === null || index.messageRecord(fields.parentId!) !== undefined;
                if (!parentExists) {
                    const parent = ascii ? bytes.toString("ascii", asciiHeader.parentStart, asciiHeader.parentEnd) : fields.parentId;
                    throw new Error(`Invalid session file ${path}: line ${lineCount} references missing parent ${parent}`);
                }
                const extendsHead = ascii
                    ? asciiHeader.parentStart < 0 ? head === undefined
                        : head !== undefined && index.messageIdMatchesAscii(head, bytes, asciiHeader.parentStart, asciiHeader.parentEnd)
                    : fields.parentId === (head === undefined ? null : index.messageId(head));
                if (!extendsHead) {
                    throw new Error(`Invalid session file ${path}: line ${lineCount} does not extend the active head`);
                }
                if (fields.deliveryId !== undefined) {
                    if (!deliveries.has(fields.deliveryId)) throw new Error(`Invalid session file ${path}: line ${lineCount} references missing delivery ${fields.deliveryId}`);
                    if (fields.message.role !== "user" || fields.message.internal !== true) {
                        throw new Error(`Invalid session file ${path}: line ${lineCount} has a non-internal delivery message`);
                    }
                    if (activeDeliveries.has(fields.deliveryId)) throw new Error(`Invalid session file ${path}: line ${lineCount} repeats active delivery ${fields.deliveryId}`);
                    activeDeliveries.set(fields.deliveryId, index.length);
                }
                if (fields.message.role === "user" && mayReferenceAttachments(bytes, start, end)) {
                    for (const id of referencedAttachments(bytes, start)) {
                        if (!attachmentIds.has(id)) throw new Error(`Invalid session file ${path}: line ${lineCount} references missing attachment ${id}`);
                    }
                }
                const neededId = fields.type === "turn_start"
                    || (firstUser === undefined && fields.message.role === "user" && fields.message.internal !== true);
                const id = ascii && neededId ? bytes.toString("ascii", asciiHeader.idStart, asciiHeader.idEnd) : fields.id;
                if (firstUser === undefined && fields.message.role === "user" && fields.message.internal !== true) {
                    const title = sessionFirstUserTitle(bytes, start);
                    firstUser = { id: id!, ...(title === undefined ? {} : { title }) };
                }
                if (fields.message.role === "assistant") {
                    const reply = replyUsageFields(fields.message);
                    if (reply === undefined) {
                        throw new Error(`Invalid session file ${path}: line ${lineCount} is not a valid message entry`);
                    }
                    if (reply !== null) {
                        const source = reply.source ?? reply;
                        replyUsage.addValues(source.provider!, source.model!, (reply.usage ?? reply) as ModelUsage, reply.durationMs);
                    }
                    if ((fields.message.usage ?? fields.message).inputTokens! > 0) {
                        measuredMaxima.add(bytes, fields.timestampStart!, fields.timestampEnd!, index.length);
                    }
                }
                if (fields.type === "turn_start") {
                    openTurnStartId = id;
                    unsentPromptRecord = undefined;
                }
                if (fields.message.role === "assistant" && (fields.message.turnTimingPresent === true
                    || fields.message.stopReason === "aborted" || fields.message.stopReason === "error")) openTurnStartId = undefined;
                if (fields.queuedPromptId !== undefined) queuedPrompts.delete(fields.queuedPromptId);
                if (fields.unsentPromptsPresent === true) {
                    queuedPrompts.clear();
                    unsentPromptRecord = lineCount - 1;
                }
                if (ascii) index.appendAsciiMessage(offset, length, fields as Record<string, unknown>,
                    bytes, asciiHeader.idStart, asciiHeader.idEnd, head);
                else index.append(offset, length, fields as Record<string, unknown>);
                head = index.length - 1;
                return;
            } else if (fields.type === "rewind") {
                if (typeof fields.userMessageId !== "string" || fields.headId === undefined) {
                    throw new Error(`Invalid session file ${path}: line ${lineCount} is not a valid rewind entry`);
                }
                if (fields.previousHeadId !== (head === undefined ? null : index.messageId(head))) {
                    throw new Error(`Invalid session file ${path}: line ${lineCount} rewinds from inactive head ${fields.previousHeadId}`);
                }
                const target = index.messageRecord(fields.userMessageId);
                let current = head;
                while (current !== undefined && current !== target) current = index.parent(current);
                if (target === undefined || current === undefined || !index.isVisibleUser(target)) {
                    throw new Error(`Invalid session file ${path}: line ${lineCount} does not reference an active user message ${fields.userMessageId}`);
                }
                const parent = index.parent(target);
                if ((parent === undefined ? null : index.messageId(parent)) !== fields.headId) {
                    throw new Error(`Invalid session file ${path}: line ${lineCount} has the wrong rewind target`);
                }
                head = parent;
                for (const [delivery, record] of activeDeliveries) if (record > (head ?? -1)) activeDeliveries.delete(delivery);
                measuredMaxima.rewind(head);
                openTurnStartId = undefined;
                if (firstUser !== undefined) {
                    const first = index.messageRecord(firstUser.id);
                    let ancestor = head;
                    while (ancestor !== undefined && ancestor !== first) ancestor = index.parent(ancestor);
                    if (ancestor === undefined) firstUser = undefined;
                }
            } else if (fields.type === "queued_prompt" && typeof fields.id === "string") {
                queuedPrompts.set(fields.id, lineCount - 1);
            } else if (fields.type === "delivery" && typeof fields.id === "string") {
                if (deliveries.has(fields.id)) throw new Error(`Invalid session file ${path}: line ${lineCount} repeats delivery ID ${fields.id}`);
                deliveries.add(fields.id);
            } else if (fields.type === "attachment") {
                const attachment = objectProperty(bytes, start, "attachment");
                const id = attachment === undefined ? undefined : objectProperty(bytes, attachment.start, "id");
                if (id !== undefined && bytes[id.start] === 34) attachmentIds.add(JSON.parse(bytes.toString("utf8", id.start, id.end)) as string);
            } else if (fields.type === "queued_prompt_removed" && typeof fields.id === "string") {
                queuedPrompts.delete(fields.id);
            } else if (fields.type === "harness_message") {
                if (fields.crashCut === true && fields.afterMessageId !== (head === undefined ? null : index.messageId(head))) {
                    throw new Error(`Invalid session file ${path}: line ${lineCount} has an invalid crash cut position`);
                }
                if (fields.crashCut === true || fields.unsentPromptsPresent === true) openTurnStartId = undefined;
                if (fields.unsentPromptsPresent === true) {
                    queuedPrompts.clear();
                    unsentPromptRecord = lineCount - 1;
                }
            } else if (fields.type === "agent_failure") {
                openTurnStartId = undefined;
            }
            index.append(offset, length, fields as Record<string, unknown>, fields.compact);
            if (fields.type === "delivery_receipt") index.setAssociatedMessage(index.length - 1, head);
        } catch (error) {
            scanError = error;
        }
    }, false, source, maxRecords);
    if (sizes.completeBytes === 0) throw new Error(`Invalid session file ${path}: has no complete header line`);
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
    if (header === undefined) throw new Error(`Invalid session file ${path}: has no complete header line`);
    const headId = head === undefined ? null : index.messageId(head)!;
    let latestMessageTimestamp: string | undefined;
    if (head !== undefined) {
        const location = index.location(head)!;
        latestMessageTimestamp = await readRecordTimestamp(source, location.offset, location.length);
        if (latestMessageTimestamp === undefined) throw new Error(`Invalid session file ${path}: line ${head + 1} is not a valid message entry`);
    }
    const latestMeasuredAssistantTimestamp = measuredMaxima.latest();
    return { header, index, headId, lineCount, ...sizes, replyUsage: replyUsage.result(), turnCount: index.branchFacts(headId).turns,
        turnOpen: agentFailure === undefined && openTurnStartId !== undefined && head !== undefined && index.leavesTurnOpen(head),
        queuedPromptRecords: [...queuedPrompts.values()],
        activeDeliveryIds: [...activeDeliveries.keys()],
        canonicalMeasurements,
        ...(unsentPromptRecord === undefined ? {} : { unsentPromptRecord }),
        ...(openTurnStartId === undefined ? {} : { openTurnStartId }),
        ...(firstUser === undefined ? {} : { firstUser }),
        ...(agentFailure === undefined ? {} : { agentFailure }),
        ...(latestMeasuredAssistantTimestamp === undefined ? {} : { latestMeasuredAssistantTimestamp }),
        ...(latestMessageTimestamp === undefined ? {} : { latestMessageTimestamp }) };
}

function mayReferenceAttachments(bytes: Buffer, start: number, end: number): boolean {
    for (let position = start; position < end; position += 1) {
        if (bytes[position] === 92 && bytes[position + 1] === 117) return true;
        if (bytes[position] !== IMAGE_ATTACHMENT[0] || position + IMAGE_ATTACHMENT.length > end) continue;
        let index = 1;
        while (index < IMAGE_ATTACHMENT.length && bytes[position + index] === IMAGE_ATTACHMENT[index]) index += 1;
        if (index === IMAGE_ATTACHMENT.length) return true;
    }
    return false;
}

function referencedAttachments(bytes: Buffer, start: number): string[] {
    const message = objectProperty(bytes, start, "message");
    const content = message === undefined ? undefined : objectProperty(bytes, message.start, "content");
    if (content === undefined || bytes[content.start] !== 91) return [];
    const ids: string[] = [];
    let position = skipWhitespace(bytes, content.start + 1);
    while (position < content.end && bytes[position] !== 93) {
        const end = valueEnd(bytes, position);
        if (end < 0) break;
        if (bytes[position] === 123) {
            const type = objectProperty(bytes, position, "type");
            if (type !== undefined && bytes[type.start] === 34
                && keyMatches(bytes, type.start, type.end, "image_attachment")) {
                const id = objectProperty(bytes, position, "attachmentId");
                if (id !== undefined && bytes[id.start] === 34) ids.push(JSON.parse(bytes.toString("utf8", id.start, id.end)) as string);
            }
        }
        position = skipWhitespace(bytes, end);
        if (bytes[position] !== 44) break;
        position = skipWhitespace(bytes, position + 1);
    }
    return ids;
}

async function countSessionRecords(path: string, source?: FileHandle): Promise<number> {
    const file = source ?? await open(path, "r");
    try {
        const { size } = await file.stat();
        if (size < 1024 * 1024) return 64;
        const chunk = Buffer.allocUnsafe(256 * 1024);
        let offset = 0;
        let count = 0;
        while (true) {
            const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);
            if (bytesRead === 0) return Math.max(64, count);
            offset += bytesRead;
            let position = 0;
            while (position < bytesRead) {
                const newline = chunk.indexOf(10, position);
                if (newline < 0 || newline >= bytesRead) break;
                count += 1;
                position = newline + 1;
            }
        }
    } finally {
        if (source === undefined) await file.close();
    }
}
