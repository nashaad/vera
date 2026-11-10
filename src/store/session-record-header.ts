export interface SessionMessageHeader {
    readonly type: "message" | "turn_start";
    readonly id: string;
    readonly parentId: string | null;
    readonly timestamp: string;
}

export interface SessionCompactionHeader {
    readonly type: "compaction";
    readonly id: string;
    readonly timestamp: string;
    readonly boundaryMessageId: string;
    readonly firstRetainedMessageId: string | null;
}

const PREFIX_BYTES = 512;
const MESSAGE_PREFIX = Buffer.from('{"type":"message","id":');
const TURN_START_PREFIX = Buffer.from('{"type":"turn_start","id":');
const COMPACTION_PREFIX = Buffer.from('{"type":"compaction","id":');
const PARENT_KEY = Buffer.from(',"parentId":');
const TIMESTAMP_KEY = Buffer.from(',"timestamp":');
const BOUNDARY_KEY = Buffer.from(',"boundaryMessageId":');
const RETAINED_KEY = Buffer.from(',"firstRetainedMessageId":');
const NULL = Buffer.from("null");
const MEASUREMENT_PREFIX = Buffer.from('{"type":"context_measurement"');
const RECIPE_KEY = Buffer.from('"contextRecipe":');
const AFTER_MESSAGE_KEY = Buffer.from('"afterMessageId":');
const MEASUREMENT_KEY = Buffer.from('"measurement":');

export interface SessionMeasurementHeader {
    readonly afterMessageId: string | null;
    readonly compact: boolean;
}

export interface AsciiMessageHeader {
    type: "message" | "turn_start";
    idStart: number;
    idEnd: number;
    parentStart: number;
    parentEnd: number;
}

export interface AsciiMeasurementHeader {
    afterStart: number;
    afterEnd: number;
    compact: boolean;
}

export function readAsciiMeasurementHeader(
    line: Buffer, result: AsciiMeasurementHeader, start = 0, end = line.length,
): boolean {
    if (!begins(line, start, MEASUREMENT_PREFIX) || line[end - 1] !== 125) return false;
    const keyAt = findWithin(line, AFTER_MESSAGE_KEY, start + MEASUREMENT_PREFIX.length, end);
    const measurementAt = findWithin(line, MEASUREMENT_KEY, start + MEASUREMENT_PREFIX.length, end);
    if (keyAt < 0 || (measurementAt >= 0 && keyAt > measurementAt)) return false;
    let position = keyAt + AFTER_MESSAGE_KEY.length;
    if (begins(line, position, NULL)) {
        result.afterStart = -1;
        result.afterEnd = -1;
    } else {
        if (line[position++] !== 34) return false;
        result.afterStart = position;
        while (position < end && line[position] !== 34) {
            const byte = line[position++]!;
            if (byte < 32 || byte >= 128 || byte === 92) return false;
        }
        if (position >= end) return false;
        result.afterEnd = position;
    }
    result.compact = findWithin(line, RECIPE_KEY, start, end) >= 0;
    return true;
}

export function readAsciiMessageHeader(line: Buffer, result: AsciiMessageHeader, start = 0, end = line.length): boolean {
    const type = begins(line, start, MESSAGE_PREFIX) ? "message"
        : begins(line, start, TURN_START_PREFIX) ? "turn_start" : undefined;
    if (type === undefined) return false;
    const limit = Math.min(end, start + PREFIX_BYTES);
    let position = start + (type === "message" ? MESSAGE_PREFIX.length : TURN_START_PREFIX.length);
    if (line[position++] !== 34) return false;
    const idStart = position;
    while (position < limit && line[position] !== 34) {
        const byte = line[position++]!;
        if (byte < 32 || byte >= 128 || byte === 92) return false;
    }
    if (position === idStart || position >= limit) return false;
    const idEnd = position++;
    if (!begins(line, position, PARENT_KEY)) return false;
    position += PARENT_KEY.length;
    let parentStart = -1;
    let parentEnd = -1;
    if (begins(line, position, NULL)) position += NULL.length;
    else {
        if (line[position++] !== 34) return false;
        parentStart = position;
        while (position < limit && line[position] !== 34) {
            const byte = line[position++]!;
            if (byte < 32 || byte >= 128 || byte === 92) return false;
        }
        if (position >= limit) return false;
        parentEnd = position++;
    }
    if (position + TIMESTAMP_KEY.length > limit || !begins(line, position, TIMESTAMP_KEY)) return false;
    result.type = type;
    result.idStart = idStart;
    result.idEnd = idEnd;
    result.parentStart = parentStart;
    result.parentEnd = parentEnd;
    return true;
}

interface ParsedString {
    readonly value: string;
    readonly end: number;
}

function jsonString(bytes: Buffer, start: number, limit = bytes.length): ParsedString | undefined {
    if (bytes[start] !== 34) return undefined;
    let end = start + 1;
    let escaped = false;
    let hadEscape = false;
    while (end < limit) {
        const byte = bytes[end]!;
        if (escaped) escaped = false;
        else if (byte === 92) { escaped = true; hadEscape = true; }
        else if (byte === 34) {
            try {
                const value: unknown = hadEscape ? JSON.parse(bytes.toString("utf8", start, end + 1))
                    : bytes.toString("utf8", start + 1, end);
                return typeof value === "string" ? { value, end: end + 1 } : undefined;
            } catch {
                return undefined;
            }
        }
        else if (byte < 32) return undefined;
        end += 1;
    }
    return undefined;
}

function begins(bytes: Buffer, offset: number, token: Buffer): boolean {
    if (offset < 0 || offset + token.length > bytes.length) return false;
    for (let index = 0; index < token.length; index += 1) {
        if (bytes[offset + index] !== token[index]) return false;
    }
    return true;
}

function findWithin(bytes: Buffer, token: Buffer, start: number, end: number): number {
    const last = end - token.length;
    for (let position = start; position <= last; position += 1) {
        if (bytes[position] !== token[0]) continue;
        let index = 1;
        while (index < token.length && bytes[position + index] === token[index]) index += 1;
        if (index === token.length) return position;
    }
    return -1;
}

export function contextMeasurementHeader(line: Buffer, start = 0, end = line.length): SessionMeasurementHeader | undefined {
    if (!begins(line, start, MEASUREMENT_PREFIX) || line[end - 1] !== 125) return undefined;
    const measurementAt = findWithin(line, MEASUREMENT_KEY, start + MEASUREMENT_PREFIX.length, end);
    const keyAt = findWithin(line, AFTER_MESSAGE_KEY, start + MEASUREMENT_PREFIX.length, end);
    if (keyAt === -1 || (measurementAt !== -1 && keyAt > measurementAt)) return undefined;
    const compact = findWithin(line, RECIPE_KEY, start, end) >= 0;
    const valueAt = keyAt + AFTER_MESSAGE_KEY.length;
    if (begins(line, valueAt, NULL)) return { afterMessageId: null, compact };
    const value = jsonString(line, valueAt, end);
    return value === undefined ? undefined : { afterMessageId: value.value, compact };
}

export function messageRecordHeader(line: Buffer): SessionMessageHeader | undefined {
    const bytes = line.subarray(0, PREFIX_BYTES);
    const type = begins(bytes, 0, MESSAGE_PREFIX) ? "message"
        : begins(bytes, 0, TURN_START_PREFIX) ? "turn_start"
        : undefined;
    if (type === undefined) return undefined;
    let position = type === "message" ? MESSAGE_PREFIX.length : TURN_START_PREFIX.length;
    const id = jsonString(bytes, position);
    if (id === undefined || id.value.length === 0 || !begins(bytes, id.end, PARENT_KEY)) return undefined;
    position = id.end + PARENT_KEY.length;
    let parentId: string | null;
    if (begins(bytes, position, NULL)) {
        parentId = null;
        position += 4;
    } else {
        const parent = jsonString(bytes, position);
        if (parent === undefined) return undefined;
        parentId = parent.value;
        position = parent.end;
    }
    if (!begins(bytes, position, TIMESTAMP_KEY)) return undefined;
    const timestamp = jsonString(bytes, position + TIMESTAMP_KEY.length);
    if (timestamp === undefined || bytes[timestamp.end] !== 44) return undefined;
    return { type, id: id.value, parentId, timestamp: timestamp.value };
}

export function compactionRecordHeader(line: Buffer): SessionCompactionHeader | undefined {
    const bytes = line.subarray(0, PREFIX_BYTES);
    if (!begins(bytes, 0, COMPACTION_PREFIX)) return undefined;
    const id = jsonString(bytes, COMPACTION_PREFIX.length);
    if (id === undefined || id.value.length === 0 || !begins(bytes, id.end, TIMESTAMP_KEY)) return undefined;
    const timestamp = jsonString(bytes, id.end + TIMESTAMP_KEY.length);
    if (timestamp === undefined || !begins(bytes, timestamp.end, BOUNDARY_KEY)) return undefined;
    const boundary = jsonString(bytes, timestamp.end + BOUNDARY_KEY.length);
    if (boundary === undefined || boundary.value.length === 0 || !begins(bytes, boundary.end, RETAINED_KEY)) return undefined;
    const position = boundary.end + RETAINED_KEY.length;
    let firstRetainedMessageId: string | null;
    let end: number;
    if (begins(bytes, position, NULL)) {
        firstRetainedMessageId = null;
        end = position + NULL.length;
    } else {
        const retained = jsonString(bytes, position);
        if (retained === undefined) return undefined;
        firstRetainedMessageId = retained.value;
        end = retained.end;
    }
    if (bytes[end] !== 44) return undefined;
    return { type: "compaction", id: id.value, timestamp: timestamp.value,
        boundaryMessageId: boundary.value, firstRetainedMessageId };
}
