import { keyMatches, literalEnd, nonnegativeInteger, objectProperty, skipWhitespace, stringEnd, valueEnd } from "./session-json-fields.ts";

function objectProperties(bytes: Buffer, start: number, names: readonly string[], slots: number[]): boolean {
    if (bytes[start] !== 123) return false;
    slots.fill(-1);
    let position = skipWhitespace(bytes, start + 1);
    while (bytes[position] !== 125 && position < bytes.length) {
        const end = stringEnd(bytes, position);
        if (end < 0) return false;
        let index = -1;
        for (let candidate = 0; candidate < names.length; candidate += 1) {
            if (keyMatches(bytes, position, end, names[candidate]!)) { index = candidate; break; }
        }
        position = skipWhitespace(bytes, end);
        if (bytes[position++] !== 58) return false;
        position = skipWhitespace(bytes, position);
        const valueStart = position;
        position = valueEnd(bytes, position);
        if (position < 0) return false;
        if (index >= 0) {
            slots[index * 2] = valueStart;
            slots[index * 2 + 1] = position;
        }
        position = skipWhitespace(bytes, position);
        if (bytes[position] === 125) break;
        if (bytes[position++] !== 44) return false;
        position = skipWhitespace(bytes, position);
    }
    return bytes[position] === 125;
}

const COMPONENT_KEYS = ["kind", "id", "owner", "source", "displayName", "count", "estimatedTokens", "parts"] as const;
const PART_KEYS = ["id", "displayName", "scope", "bytes", "estimatedTokens", "imported"] as const;
const COMPONENT_KINDS = ["prompt_contribution", "tool_schema", "message"] as const;
const PART_SCOPES = ["project", "user", "agent", "memory", "skill"] as const;
const MEASUREMENT_TYPE = ["context_measurement"] as const;
const ROOT_MEASUREMENT_FIELDS = ["timestamp", "type", "afterMessageId", "measurement", "contextRecipe"] as const;
const MEASUREMENT_FIELDS = ["tokens", "capacity", "overheadTokens", "estimated", "projection", "compaction"] as const;
const PROJECTION_FIELDS = ["estimatedTokens", "components"] as const;
const COMPACTION_FIELDS = ["triggerFraction", "triggerTokens"] as const;
const RECIPE_FIELDS = ["version", "keyframe", "append", "update", "truncate"] as const;


function literalString(bytes: Buffer, start: number, end: number, values: readonly string[]): boolean {
    for (const value of values) {
        if (keyMatches(bytes, start, end, value)) return true;
    }
    return false;
}

function canonicalObject(bytes: Buffer, start: number, keys: readonly string[], component: boolean): boolean {
    if (bytes[start] !== 123) return false;
    let position = skipWhitespace(bytes, start + 1);
    let seen = 0;
    while (bytes[position] !== 125 && position < bytes.length) {
        const end = stringEnd(bytes, position);
        if (end < 0) return false;
        let keyIndex = -1;
        for (let index = 0; index < keys.length; index += 1) {
            if (keyMatches(bytes, position, end, keys[index]!)) { keyIndex = index; break; }
        }
        if (keyIndex < 0 || (seen & (1 << keyIndex)) !== 0) return false;
        seen |= 1 << keyIndex;
        position = skipWhitespace(bytes, end);
        if (bytes[position++] !== 58) return false;
        position = skipWhitespace(bytes, position);
        const valueStart = position;
        position = valueEnd(bytes, position);
        if (position < 0) return false;
        const key = keys[keyIndex]!;
        if (key === "parts") {
            if (!canonicalArray(bytes, valueStart, false, true)) return false;
        } else if (key === "count" || key === "estimatedTokens" || key === "bytes") {
            if (nonnegativeInteger(bytes, valueStart, position) === undefined) return false;
        } else if (key === "imported") {
            if (literalEnd(bytes, valueStart, "true") !== position) return false;
        } else if (key === "kind") {
            if (!literalString(bytes, valueStart, position, COMPONENT_KINDS)) return false;
        } else if (key === "scope") {
            if (!literalString(bytes, valueStart, position, PART_SCOPES)) return false;
        } else if (bytes[valueStart] !== 34) return false;
        position = skipWhitespace(bytes, position);
        if (bytes[position] === 125) break;
        if (bytes[position++] !== 44) return false;
        position = skipWhitespace(bytes, position);
    }
    const required = component ? 0x7f : 0x1f;
    return bytes[position] === 125 && (seen & required) === required;
}

function canonicalArray(bytes: Buffer, start: number, update: boolean, parts = false): boolean {
    if (bytes[start] !== 91) return false;
    let position = skipWhitespace(bytes, start + 1);
    while (bytes[position] !== 93 && position < bytes.length) {
        const end = valueEnd(bytes, position);
        if (end < 0) return false;
        let item = position;
        if (update) {
            if (bytes[item] !== 91) return false;
            item = skipWhitespace(bytes, item + 1);
            const numberEndAt = valueEnd(bytes, item);
            if (numberEndAt < 0 || nonnegativeInteger(bytes, item, numberEndAt) === undefined) return false;
            item = skipWhitespace(bytes, numberEndAt);
            if (bytes[item++] !== 44) return false;
            item = skipWhitespace(bytes, item);
            const componentEnd = valueEnd(bytes, item);
            if (componentEnd < 0 || bytes[skipWhitespace(bytes, componentEnd)] !== 93) return false;
        }
        if (!canonicalObject(bytes, item, parts ? PART_KEYS : COMPONENT_KEYS, !parts)) return false;
        position = skipWhitespace(bytes, end);
        if (bytes[position] === 93) break;
        if (bytes[position++] !== 44) return false;
        position = skipWhitespace(bytes, position);
    }
    return bytes[position] === 93;
}

export function measurementComponentsCanonical(bytes: Buffer, compact: boolean, start = 0): boolean {
    if (compact) {
        const recipe = objectProperty(bytes, skipWhitespace(bytes, start), "contextRecipe");
        if (recipe === undefined) return false;
        const append = objectProperty(bytes, recipe.start, "append");
        const update = objectProperty(bytes, recipe.start, "update");
        return append !== undefined && update !== undefined
            && canonicalArray(bytes, append.start, false) && canonicalArray(bytes, update.start, true);
    }
    const measurement = objectProperty(bytes, skipWhitespace(bytes, start), "measurement");
    const projection = measurement === undefined ? undefined : objectProperty(bytes, measurement.start, "projection");
    const components = projection === undefined ? undefined : objectProperty(bytes, projection.start, "components");
    return components !== undefined && canonicalArray(bytes, components.start, false);
}

interface ArrayFacts { count: number; maxIndex: number; tokenSum: number }
const arrayFactScratch: ArrayFacts = { count: 0, maxIndex: -1, tokenSum: 0 };
const componentSlots = new Array<number>(COMPONENT_KEYS.length * 2).fill(-1);

function arrayFacts(bytes: Buffer, start: number, updates: boolean, sumTokens = false): ArrayFacts | undefined {
    if (bytes[start] !== 91) return undefined;
    let position = skipWhitespace(bytes, start + 1);
    let count = 0;
    let maxIndex = -1;
    let tokenSum = 0;
    while (bytes[position] !== 93 && position < bytes.length) {
        const end = valueEnd(bytes, position);
        if (end < 0) return undefined;
        let component = position;
        if (updates) {
            if (bytes[component] !== 91) return undefined;
            const indexStart = skipWhitespace(bytes, component + 1);
            const indexEnd = valueEnd(bytes, indexStart);
            const index = nonnegativeInteger(bytes, indexStart, indexEnd);
            if (index === undefined) return undefined;
            maxIndex = Math.max(maxIndex, index);
            component = skipWhitespace(bytes, indexEnd);
            if (bytes[component++] !== 44) return undefined;
            component = skipWhitespace(bytes, component);
            const componentEnd = valueEnd(bytes, component);
            if (componentEnd < 0 || bytes[skipWhitespace(bytes, componentEnd)] !== 93) return undefined;
        }
        if (!canonicalObject(bytes, component, COMPONENT_KEYS, true)) return undefined;
        if (sumTokens) {
            if (!objectProperties(bytes, component, COMPONENT_KEYS, componentSlots)) return undefined;
            const start = componentSlots[12]!;
            const amount = start < 0 ? undefined : nonnegativeInteger(bytes, start, componentSlots[13]!);
            if (amount === undefined) return undefined;
            tokenSum += amount;
        }
        count += 1;
        position = skipWhitespace(bytes, end);
        if (bytes[position] === 93) break;
        if (bytes[position++] !== 44) return undefined;
        position = skipWhitespace(bytes, position);
    }
    if (bytes[position] !== 93) return undefined;
    arrayFactScratch.count = count;
    arrayFactScratch.maxIndex = maxIndex;
    arrayFactScratch.tokenSum = tokenSum;
    return arrayFactScratch;
}

const measurementSlots = new Array<number>(12).fill(-1);

export function canonicalCompactMeasurementLength(
    bytes: Buffer,
    previousLength: number | undefined,
    expectedAfter: string | null | undefined,
    lineStart = 0,
    lineEnd = bytes.length,
    expectedStart = -1,
    expectedEnd = -1,
): number | undefined {
    const slots = measurementSlots;
    const start = skipWhitespace(bytes, lineStart, lineEnd);
    const end = valueEnd(bytes, start, lineEnd);
    if (end < 0 || end > lineEnd) return undefined;
    let trailing = end;
    while (trailing < lineEnd && (bytes[trailing] === 32 || bytes[trailing] === 9 || bytes[trailing] === 13)) trailing += 1;
    if (trailing !== lineEnd) return undefined;
    if (!objectProperties(bytes, start, ROOT_MEASUREMENT_FIELDS, slots)) return undefined;
    const timestamp = slots[0]!;
    const type = slots[2]!;
    const typeEnd = slots[3]!;
    const after = slots[4]!;
    const afterEnd = slots[5]!;
    const measurement = slots[6]!;
    const recipe = slots[8]!;
    if (type < 0 || !literalString(bytes, type, typeEnd, MEASUREMENT_TYPE)
        || timestamp < 0 || bytes[timestamp] !== 34 || after < 0
        || (bytes[after] !== 34 && literalEnd(bytes, after, "null") !== afterEnd)
        || measurement < 0 || recipe < 0) return undefined;
    if (expectedAfter === null) {
        if (literalEnd(bytes, after, "null") !== afterEnd) return undefined;
    } else if (expectedAfter === undefined) {
        if (afterEnd - after !== expectedEnd - expectedStart + 2 || bytes[after] !== 34) return undefined;
        for (let index = 0; index < expectedEnd - expectedStart; index += 1) {
            if (bytes[after + index + 1] !== bytes[expectedStart + index]) return undefined;
        }
    } else if (!keyMatches(bytes, after, afterEnd, expectedAfter)) {
        const actualAfter: unknown = JSON.parse(bytes.toString("utf8", after, afterEnd));
        if (actualAfter !== expectedAfter) return undefined;
    }
    if (!objectProperties(bytes, measurement, MEASUREMENT_FIELDS, slots)) return undefined;
    const tokens = slots[0]!;
    const capacity = slots[2]!;
    const overhead = slots[4]!;
    const estimated = slots[6]!;
    const projection = slots[8]!;
    const compaction = slots[10]!;
    const total = tokens < 0 ? undefined : nonnegativeInteger(bytes, tokens, slots[1]!);
    if (total === undefined || estimated < 0 || projection < 0
        || (literalEnd(bytes, estimated, "true") !== slots[7] && literalEnd(bytes, estimated, "false") !== slots[7])
        || (capacity >= 0 && (nonnegativeInteger(bytes, capacity, slots[3]!) ?? 0) <= 0)
        || (overhead >= 0 && nonnegativeInteger(bytes, overhead, slots[5]!) === undefined)) return undefined;
    if (!objectProperties(bytes, projection, PROJECTION_FIELDS, slots)) return undefined;
    const projectionTotal = slots[0]!;
    const components = slots[2]!;
    const aggregate = components < 0 ? undefined : arrayFacts(bytes, components, false, true);
    if (projectionTotal < 0 || nonnegativeInteger(bytes, projectionTotal, slots[1]!) !== total
        || aggregate === undefined || aggregate.tokenSum !== total) return undefined;
    if (compaction >= 0) {
        if (!objectProperties(bytes, compaction, COMPACTION_FIELDS, slots)) return undefined;
        const fraction = slots[0]!;
        const trigger = slots[2]!;
        if (fraction >= 0) {
            const value = Number(bytes.toString("ascii", fraction, slots[1]!));
            if (!Number.isFinite(value) || value <= 0 || value > 1) return undefined;
        }
        if (trigger >= 0 && (nonnegativeInteger(bytes, trigger, slots[3]!) ?? 0) <= 0) return undefined;
    }
    if (!objectProperties(bytes, recipe, RECIPE_FIELDS, slots)) return undefined;
    const version = slots[0]!;
    const keyframe = slots[2]!;
    const append = slots[4]!;
    const update = slots[6]!;
    const truncate = slots[8]!;
    if (version < 0 || nonnegativeInteger(bytes, version, slots[1]!) !== 1
        || keyframe < 0 || append < 0 || update < 0) return undefined;
    const isKeyframe = literalEnd(bytes, keyframe, "true") === slots[3];
    if (!isKeyframe && literalEnd(bytes, keyframe, "false") !== slots[3]) return undefined;
    const added = arrayFacts(bytes, append, false);
    const addedCount = added?.count;
    const changed = arrayFacts(bytes, update, true);
    const truncated = truncate < 0 ? undefined : nonnegativeInteger(bytes, truncate, slots[9]!);
    if (addedCount === undefined || changed === undefined || (truncate >= 0 && truncated === undefined)) return undefined;
    if (isKeyframe) return addedCount;
    if (previousLength === undefined || (truncated !== undefined && truncated > previousLength)) return undefined;
    const retained = truncated ?? previousLength;
    if (changed.maxIndex >= retained) return undefined;
    return retained + addedCount;
}
