export interface SessionJsonFields {
    readonly type?: string;
    readonly id?: string;
    readonly parentId?: string | null;
    readonly timestamp?: string;
    readonly timestampStringPresent?: boolean;
    readonly timestampStart?: number;
    readonly timestampEnd?: number;
    readonly scannedIdCount?: number;
    readonly scannedParentCount?: number;
    readonly boundaryMessageId?: string;
    readonly firstRetainedMessageId?: string | null;
    readonly afterMessageId?: string | null;
    readonly userMessageId?: string;
    readonly previousHeadId?: string;
    readonly headId?: string | null;
    readonly role?: string;
    readonly internal?: boolean;
    readonly contextSource?: string;
    readonly arrivedDuringTurn?: boolean;
    readonly compactionBarrier?: boolean;
    readonly message?: SessionJsonFields;
    readonly compact?: boolean;
    readonly source?: SessionJsonFields;
    readonly usage?: SessionJsonFields;
    readonly billed?: SessionJsonFields;
    readonly billedPresent?: boolean;
    readonly provider?: string;
    readonly model?: string;
    readonly api?: string;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cachedInputTokens?: number;
    readonly cacheWriteInputTokens?: number;
    readonly reasoningTokens?: number;
    readonly totalTokens?: number;
    readonly cost?: number;
    readonly durationMs?: number;
    readonly stopReason?: string;
    readonly turnTimingPresent?: boolean;
    readonly queuedPromptId?: string;
    readonly deliveryId?: string;
    readonly crashCut?: boolean;
    readonly unsentPromptsPresent?: boolean;
}

const ROOT_KEYS = [
    "type", "id", "parentId", "timestamp", "boundaryMessageId", "firstRetainedMessageId", "afterMessageId",
    "userMessageId", "previousHeadId", "headId", "queuedPromptId", "deliveryId", "crashCut", "message", "billed", "contextRecipe", "unsentPrompts",
] as const;
const MESSAGE_KEYS = ["role", "internal", "contextSource", "arrivedDuringTurn", "compactionBarrier", "durationMs", "stopReason", "source", "usage", "turnTiming"] as const;
const SOURCE_KEYS = ["provider", "model", "api"] as const;
const USAGE_KEYS = ["inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteInputTokens", "reasoningTokens", "totalTokens", "cost"] as const;
const BILLED_KEYS = ["provider", "model", "usage"] as const;
const MESSAGE_ROLES = ["user", "assistant", "tool_result"] as const;
const STOP_REASONS = ["stop", "length", "tool_use", "content_filter", "aborted", "error"] as const;
const RECORD_TYPES = ["session", "message", "turn_start", "rewind", "context_measurement", "compaction", "session_ask"] as const;

function whitespace(byte: number | undefined): boolean {
    return byte === 32 || byte === 9 || byte === 10 || byte === 13;
}

export function skipWhitespace(bytes: Buffer, start: number, end = bytes.length): number {
    while (start < end && whitespace(bytes[start])) start += 1;
    return start;
}

export function stringEnd(bytes: Buffer, start: number, end = bytes.length): number {
    if (start >= end || bytes[start] !== 34) return -1;
    for (let position = start + 1; position < end; position += 1) {
        const byte = bytes[position]!;
        if (byte === 34) return position + 1;
        if (byte < 32) return -1;
        if (byte !== 92) continue;
        const escaped = bytes[++position];
        if (position >= end || escaped === undefined) return -1;
        if (escaped === 117) {
            for (let count = 0; count < 4; count += 1) {
                const digit = bytes[++position];
                if (position >= end || digit === undefined || !((digit >= 48 && digit <= 57) || (digit >= 65 && digit <= 70) || (digit >= 97 && digit <= 102))) return -1;
            }
        } else if (escaped !== 34 && escaped !== 92 && escaped !== 47 && escaped !== 98 && escaped !== 102
            && escaped !== 110 && escaped !== 114 && escaped !== 116) return -1;
    }
    return -1;
}

function numberEnd(bytes: Buffer, start: number, end: number): number {
    let position = start;
    if (bytes[position] === 45) position += 1;
    if (position >= end) return -1;
    if (bytes[position] === 48) position += 1;
    else {
        if (position >= end || bytes[position]! < 49 || bytes[position]! > 57) return -1;
        do position += 1; while (position < end && bytes[position]! >= 48 && bytes[position]! <= 57);
    }
    if (position < end && bytes[position] === 46) {
        position += 1;
        const first = position;
        while (position < end && bytes[position]! >= 48 && bytes[position]! <= 57) position += 1;
        if (first === position) return -1;
    }
    if (position < end && (bytes[position] === 101 || bytes[position] === 69)) {
        position += 1;
        if (position < end && (bytes[position] === 43 || bytes[position] === 45)) position += 1;
        const first = position;
        while (position < end && bytes[position]! >= 48 && bytes[position]! <= 57) position += 1;
        if (first === position) return -1;
    }
    return position;
}

export function literalEnd(bytes: Buffer, start: number, text: string, end = bytes.length): number {
    if (start + text.length > end) return -1;
    for (let index = 0; index < text.length; index += 1) {
        if (bytes[start + index] !== text.charCodeAt(index)) return -1;
    }
    return start + text.length;
}

const valueStack: number[] = [];

export function valueEnd(bytes: Buffer, start: number, end = bytes.length): number {
    let position = skipWhitespace(bytes, start, end);
    if (position >= end) return -1;
    const first = bytes[position];
    if (first === 34) return stringEnd(bytes, position, end);
    if (first === 116) return literalEnd(bytes, position, "true", end);
    if (first === 102) return literalEnd(bytes, position, "false", end);
    if (first === 110) return literalEnd(bytes, position, "null", end);
    if (first !== 123 && first !== 91) return numberEnd(bytes, position, end);
    let stack = valueStack;
    stack.length = 0;
    let needValue = true;
    while (true) {
        position = skipWhitespace(bytes, position, end);
        if (position >= end) return -1;
        const byte = bytes[position];
        if (needValue) {
            needValue = false;
            if (byte === 123 || byte === 91) {
                if (stack === valueStack && stack.length === 256) stack = stack.slice();
                stack.push(byte === 123 ? 0 : 4);
                position += 1;
                continue;
            }
            if (byte === 34) position = stringEnd(bytes, position, end);
            else if (byte === 116) position = literalEnd(bytes, position, "true", end);
            else if (byte === 102) position = literalEnd(bytes, position, "false", end);
            else if (byte === 110) position = literalEnd(bytes, position, "null", end);
            else position = numberEnd(bytes, position, end);
            if (position < 0) return -1;
            if (stack.length === 0) return position;
            continue;
        }
        const top = stack.length - 1;
        const state = stack[top]!;
        if (state === 0 || state === 1) {
            if (state === 0 && byte === 125) {
                stack.pop(); position += 1;
                if (stack.length === 0) return position;
                continue;
            }
            position = stringEnd(bytes, position, end);
            if (position < 0) return -1;
            stack[top] = 2;
        } else if (state === 2) {
            if (byte !== 58) return -1;
            position += 1;
            stack[top] = 3;
            needValue = true;
        } else if (state === 3) {
            if (byte === 125) {
                stack.pop(); position += 1;
                if (stack.length === 0) return position;
            } else if (byte === 44) { stack[top] = 1; position += 1; }
            else return -1;
        } else if (state === 4 || state === 5) {
            if (state === 4 && byte === 93) {
                stack.pop(); position += 1;
                if (stack.length === 0) return position;
                continue;
            }
            stack[top] = 6;
            needValue = true;
        } else {
            if (byte === 93) {
                stack.pop(); position += 1;
                if (stack.length === 0) return position;
            } else if (byte === 44) { stack[top] = 5; position += 1; }
            else return -1;
        }
    }
}

export function sessionJsonFields(bytes: Buffer, includeBilled = true, flatMessage = false): SessionJsonFields | undefined {
    return parseFields(bytes, "record", includeBilled, flatMessage);
}

export class SessionFieldScanner {
    private readonly root: Record<string, unknown> = {};
    private readonly message: Record<string, unknown> = {};
    private readonly sourceStrings: string[] = [];

    read(bytes: Buffer, skipIds = false, start = 0, end = bytes.length): SessionJsonFields | undefined {
        for (const key of ROOT_KEYS) this.root[key] = undefined;
        this.root.compact = undefined;
        this.root.unsentPromptsPresent = undefined;
        this.root.billedPresent = undefined;
        this.root.timestampStringPresent = undefined;
        this.root.timestampStart = undefined;
        this.root.timestampEnd = undefined;
        this.root.scannedIdCount = skipIds ? 0 : undefined;
        this.root.scannedParentCount = skipIds ? 0 : undefined;
        for (const key of MESSAGE_KEYS) this.message[key] = undefined;
        for (const key of SOURCE_KEYS) this.message[key] = undefined;
        for (const key of USAGE_KEYS) this.message[key] = undefined;
        this.message.turnTimingPresent = undefined;
        return parseFields(bytes, "record", false, true, this.root, start, end, this.message, true, skipIds, this.sourceStrings);
    }
}

type FieldLevel = "record" | "message" | "source" | "usage" | "billed";

export function keyMatches(bytes: Buffer, start: number, end: number, name: string): boolean {
    if (end - start === name.length + 2) {
        let matches = true;
        for (let index = 0; index < name.length; index += 1) {
            if (bytes[start + index + 1] !== name.charCodeAt(index)) { matches = false; break; }
        }
        if (matches) return true;
    }
    if (end - start > name.length * 6 + 2) return false;
    let escaped = false;
    for (let index = start + 1; index < end - 1; index += 1) {
        if (bytes[index] === 92) { escaped = true; break; }
    }
    if (!escaped) return false;
    try { return JSON.parse(bytes.toString("utf8", start, end)) === name; } catch { return false; }
}

function fieldName(bytes: Buffer, start: number, end: number, level: FieldLevel): string | undefined {
    const keys: readonly string[] = level === "record" ? ROOT_KEYS : level === "message" ? MESSAGE_KEYS
        : level === "source" ? SOURCE_KEYS : level === "usage" ? USAGE_KEYS : BILLED_KEYS;
    let escaped = false;
    for (let index = start + 1; index < end - 1; index += 1) {
        if (bytes[index] === 92) { escaped = true; break; }
    }
    if (escaped) {
        if (end - start > 146) return undefined;
        try {
            const decoded: unknown = JSON.parse(bytes.toString("utf8", start, end));
            return typeof decoded === "string" && keys.includes(decoded) ? decoded : undefined;
        } catch { return undefined; }
    }
    for (const key of keys) {
        if (end - start !== key.length + 2) continue;
        let matches = true;
        for (let index = 0; index < key.length; index += 1) {
            if (bytes[start + index + 1] !== key.charCodeAt(index)) { matches = false; break; }
        }
        if (matches) return key;
    }
    return undefined;
}

function decodedString(bytes: Buffer, start: number, end: number): string {
    for (let position = start + 1; position < end - 1; position += 1) {
        if (bytes[position] === 92) return JSON.parse(bytes.toString("utf8", start, end)) as string;
    }
    return bytes.toString("utf8", start + 1, end - 1);
}

function parseFields(
    bytes: Buffer,
    level: FieldLevel,
    includeBilled: boolean,
    flatMessage: boolean,
    target?: Record<string, unknown>,
    startOffset = 0,
    endOffset = bytes.length,
    messageTarget?: Record<string, unknown>,
    skipTimestamp = false,
    skipIds = false,
    sourceStrings?: string[],
): SessionJsonFields | undefined {
    let position = skipWhitespace(bytes, startOffset, endOffset);
    if (position >= endOffset) return undefined;
    if (bytes[position++] !== 123) return undefined;
    const fields: Record<string, unknown> = target ?? {};
    position = skipWhitespace(bytes, position, endOffset);
    if (position >= endOffset) return undefined;
    if (bytes[position] === 125) return position + 1 === endOffset || skipWhitespace(bytes, position + 1, endOffset) === endOffset ? fields : undefined;
    while (position < endOffset) {
        const keyEnd = stringEnd(bytes, position, endOffset);
        if (keyEnd < 0) return undefined;
        const key = fieldName(bytes, position, keyEnd, level);
        position = skipWhitespace(bytes, keyEnd, endOffset);
        if (position >= endOffset) return undefined;
        if (bytes[position++] !== 58) return undefined;
        position = skipWhitespace(bytes, position, endOffset);
        const start = position;
        position = valueEnd(bytes, start, endOffset);
        if (position < 0) return undefined;
        const nested: FieldLevel | undefined = level === "record" && key === "message" ? "message"
            : level === "record" && key === "billed" && includeBilled ? "billed"
            : level === "message" && key === "source" ? "source"
            : (level === "message" || level === "billed") && key === "usage" ? "usage" : undefined;
        if (nested !== undefined && typeof key === "string") {
            if (level === "record" && key === "billed") fields.billedPresent = true;
            if (flatMessage && level === "message" && (key === "source" || key === "usage")) {
                for (const field of key === "source" ? SOURCE_KEYS : USAGE_KEYS) fields[field] = undefined;
                if (bytes[start] === 123) parseFields(bytes, nested, includeBilled, flatMessage, fields, start, position,
                    undefined, false, false, sourceStrings);
            } else {
                const nestedTarget = level === "record" && key === "message" ? messageTarget : undefined;
                fields[key] = bytes[start] === 123
                    ? parseFields(bytes, nested, includeBilled, flatMessage, nestedTarget, start, position, messageTarget, skipTimestamp, skipIds, sourceStrings)
                    : undefined;
            }
        } else if (key === "contextRecipe" && level === "record") {
            fields.compact = true;
        } else if (key === "unsentPrompts" && level === "record") {
            fields.unsentPromptsPresent = true;
        } else if (key === "turnTiming" && level === "message") {
            fields.turnTimingPresent = true;
        } else if (skipTimestamp && key === "timestamp" && level === "record") {
            fields.timestampStringPresent = bytes[start] === 34;
            fields.timestampStart = start;
            fields.timestampEnd = position;
        } else if (skipIds && level === "record" && (key === "id" || key === "parentId")) {
            const count = key === "id" ? "scannedIdCount" : "scannedParentCount";
            fields[count] = (fields[count] as number) + 1;
        } else if (key !== undefined) {
            if (bytes[start] === 34) {
                const choices: readonly string[] | undefined = level === "record" && key === "type" ? RECORD_TYPES
                    : level === "message" && key === "role" ? MESSAGE_ROLES
                    : level === "message" && key === "stopReason" ? STOP_REASONS : undefined;
                let known: string | undefined;
                if (choices !== undefined) {
                    for (const choice of choices) {
                        if (keyMatches(bytes, start, position, choice)) { known = choice; break; }
                    }
                }
                if (known === undefined && level === "source" && sourceStrings !== undefined) {
                    for (const candidate of sourceStrings) {
                        if (keyMatches(bytes, start, position, candidate)) { known = candidate; break; }
                    }
                    if (known === undefined) {
                        try { known = decodedString(bytes, start, position); } catch { return undefined; }
                        sourceStrings.push(known);
                    }
                }
                try { fields[key] = known ?? decodedString(bytes, start, position); } catch { return undefined; }
            } else if (bytes[start] === 110 && position === start + 4) fields[key] = null;
            else if (bytes[start] === 116 && position === start + 4) fields[key] = true;
            else if (bytes[start] === 102 && position === start + 5) fields[key] = false;
            else if (bytes[start] === 45 || (bytes[start]! >= 48 && bytes[start]! <= 57)) {
                fields[key] = nonnegativeInteger(bytes, start, position) ?? Number(bytes.toString("ascii", start, position));
            }
            else fields[key] = undefined;
        }
        position = skipWhitespace(bytes, position, endOffset);
        if (position >= endOffset) return undefined;
        if (bytes[position] === 125) return position + 1 === endOffset || skipWhitespace(bytes, position + 1, endOffset) === endOffset ? fields as SessionJsonFields : undefined;
        if (bytes[position++] !== 44) return undefined;
        position = skipWhitespace(bytes, position, endOffset);
    }
    return undefined;
}

export interface ValueRange {
    readonly start: number;
    readonly end: number;
}

export function objectProperty(bytes: Buffer, start: number, name: string): ValueRange | undefined {
    if (bytes[start] !== 123) return undefined;
    let position = skipWhitespace(bytes, start + 1);
    let found: ValueRange | undefined;
    while (bytes[position] !== 125 && position < bytes.length) {
        const end = stringEnd(bytes, position);
        if (end < 0) return undefined;
        const matches = keyMatches(bytes, position, end, name);
        position = skipWhitespace(bytes, end);
        if (bytes[position++] !== 58) return undefined;
        position = skipWhitespace(bytes, position);
        const valueStart = position;
        position = valueEnd(bytes, valueStart);
        if (position < 0) return undefined;
        if (matches) found = { start: valueStart, end: position };
        position = skipWhitespace(bytes, position);
        if (bytes[position] === 125) break;
        if (bytes[position++] !== 44) return undefined;
        position = skipWhitespace(bytes, position);
    }
    return found;
}


interface TitleAccumulator {
    text: string;
    pendingSpace: boolean;
    seenText: boolean;
}

function appendTitleCharacter(title: TitleAccumulator, character: string): boolean {
    for (let index = 0; index < character.length; index += 1) {
        const unit = character[index]!;
        if (/\s/.test(unit)) {
            if (title.text.length > 0) title.pendingSpace = true;
            continue;
        }
        if (title.pendingSpace && title.text.length < 80) title.text += " ";
        title.pendingSpace = false;
        if (title.text.length < 80) title.text += unit;
        if (title.text.length === 80) return true;
    }
    return false;
}

function utf8Width(bytes: Buffer, position: number, end: number): number {
    const first = bytes[position]!;
    const width = first >= 194 && first <= 223 ? 2 : first >= 224 && first <= 239 ? 3 : first >= 240 && first <= 244 ? 4 : 1;
    if (position + width > end) return 1;
    for (let offset = 1; offset < width; offset += 1) {
        const byte = bytes[position + offset]!;
        if (byte < 128 || byte > 191) return 1;
    }
    const second = bytes[position + 1];
    if ((first === 224 && second! < 160) || (first === 237 && second! > 159)
        || (first === 240 && second! < 144) || (first === 244 && second! > 143)) return 1;
    return width;
}

function appendJsonText(bytes: Buffer, range: ValueRange, title: TitleAccumulator): boolean {
    if (bytes[range.start] !== 34) return false;
    if (title.seenText && title.text.length > 0) title.pendingSpace = true;
    title.seenText = true;
    let position = range.start + 1;
    const end = range.end - 1;
    while (position < end) {
        const byte = bytes[position]!;
        let character: string;
        if (byte === 92) {
            const escaped = bytes[position + 1]!;
            const length = escaped === 117 ? 6 : 2;
            character = JSON.parse(`"${bytes.subarray(position, position + length).toString("ascii")}"`) as string;
            position += length;
        } else if (byte < 128) {
            character = String.fromCharCode(byte);
            position += 1;
        } else {
            const width = utf8Width(bytes, position, end);
            character = bytes.toString("utf8", position, position + width);
            position += width;
        }
        if (appendTitleCharacter(title, character)) return true;
    }
    return false;
}

export function sessionFirstUserTitle(bytes: Buffer, start = 0): string | undefined {
    const message = objectProperty(bytes, skipWhitespace(bytes, start), "message");
    if (message === undefined) return undefined;
    const content = objectProperty(bytes, message.start, "content");
    if (content === undefined || bytes[content.start] !== 91) return undefined;
    const title: TitleAccumulator = { text: "", pendingSpace: false, seenText: false };
    let position = skipWhitespace(bytes, content.start + 1);
    while (position < content.end && bytes[position] !== 93) {
        const end = valueEnd(bytes, position);
        if (end < 0) return undefined;
        if (bytes[position] === 123) {
            const type = objectProperty(bytes, position, "type");
            const text = objectProperty(bytes, position, "text");
            if (type !== undefined && text !== undefined && type.end - type.start <= 26
                && bytes[type.start] === 34
                && JSON.parse(bytes.subarray(type.start, type.end).toString("utf8")) === "text") {
                if (appendJsonText(bytes, text, title)) return title.text;
            }
        }
        position = skipWhitespace(bytes, end);
        if (bytes[position] === 93) break;
        if (bytes[position++] !== 44) return undefined;
        position = skipWhitespace(bytes, position);
    }
    return title.text.length === 0 ? undefined : title.text;
}


export function nonnegativeInteger(bytes: Buffer, start: number, end: number): number | undefined {
    if (start === end || (end - start > 1 && bytes[start] === 48)) return undefined;
    let value = 0;
    for (let position = start; position < end; position += 1) {
        const digit = bytes[position]! - 48;
        if (digit < 0 || digit > 9) return undefined;
        value = value * 10 + digit;
        if (!Number.isSafeInteger(value)) return undefined;
    }
    return value;
}
