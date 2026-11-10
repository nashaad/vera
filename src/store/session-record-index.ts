export interface SessionCompactionAnchor {
    readonly crossesBarrier: boolean;
    readonly successorId: string | null;
    readonly successorIsToolResult: boolean;
}

const ASCII_MEASUREMENT = { type: "context_measurement", afterMessageId: null };

export class SessionRecordIndex {
    private offsets = new Float64Array(64);
    private lengths = new Uint32Array(64);
    private readonly longLengths = new Map<number, number>();
    private parents = new Int32Array(64);
    private kinds = new Uint16Array(64);
    private messageFlags = new Uint8Array(64);
    private readonly kindNumbers = new Map<string, number>();
    private readonly kindNames: string[] = [""];
    private idOffsets = new Uint32Array(64);
    private idLengths = new Uint32Array(64);
    private retainedOffsets = new Uint32Array(16);
    private retainedLengths = new Uint32Array(16);
    private compactionCount = 0;
    private idData = new Uint8Array(256);
    private idDataLength = 0;
    private idSlots = new Uint32Array(128);
    private idCount = 0;
    private count = 0;

    constructor(recordCapacity = 64) {
        if (recordCapacity <= 64) return;
        this.offsets = new Float64Array(recordCapacity);
        this.lengths = new Uint32Array(recordCapacity);
        this.parents = new Int32Array(recordCapacity);
        this.kinds = new Uint16Array(recordCapacity);
        this.messageFlags = new Uint8Array(recordCapacity);
        this.idOffsets = new Uint32Array(recordCapacity);
        this.idLengths = new Uint32Array(recordCapacity);
    }

    append(offset: number, length: number, record: Record<string, unknown>, scannedCompact?: boolean): void {
        if (this.count === this.offsets.length) this.grow();
        const index = this.count++;
        this.offsets[index] = offset;
        if (length > 0xffffffff) {
            this.longLengths.set(index, length);
        } else {
            this.lengths[index] = length;
        }
        const kind = typeof record.type === "string" ? record.type : "";
        let kindNumber = this.kindNumbers.get(kind);
        if (kindNumber === undefined) {
            kindNumber = this.kindNumbers.size + 1;
            this.kindNumbers.set(kind, kindNumber);
            this.kindNames[kindNumber] = kind;
        }
        this.kinds[index] = kindNumber;
        this.parents[index] = typeof record.parentId === "string"
            ? this.messageRecord(record.parentId) ?? -1 : -1;
        if ((kind === "message" || kind === "turn_start") && typeof record.message === "object"
            && record.message !== null && !Array.isArray(record.message)) {
            const message = record.message as Record<string, unknown>;
            this.messageFlags[index] = (message.role === "user" ? 1 : message.role === "assistant" ? 2
                : message.role === "tool_result" ? 3 : 0) | (message.internal === true ? 4 : 0)
                | ((message.role === "user" && message.compactionBarrier === true)
                    || (message.role === "assistant" && message.stopReason !== "tool_use") ? 8 : 0)
                | (message.role === "user" && message.internal !== true && message.contextSource === undefined
                    && message.arrivedDuringTurn !== true ? 16 : 0)
                | (typeof record.deliveryId === "string" ? 32 : 0)
                | (message.role === "user" || message.role === "tool_result"
                    || (message.role === "assistant" && (message.stopReason === "tool_use"
                        || (message.turnTiming === undefined && message.turnTimingPresent !== true
                            && (message.stopReason === "stop" || message.stopReason === "length")))) ? 64 : 0);
        }
        if (kind === "compaction") {
            if (this.compactionCount === this.retainedOffsets.length) {
                const offsets = new Uint32Array(this.retainedOffsets.length * 2);
                const lengths = new Uint32Array(this.retainedLengths.length * 2);
                offsets.set(this.retainedOffsets);
                lengths.set(this.retainedLengths);
                this.retainedOffsets = offsets;
                this.retainedLengths = lengths;
            }
            const slot = this.compactionCount++;
            this.parents[index] = slot;
            if (typeof record.boundaryMessageId === "string") {
                this.messageFlags[index] = this.messageFlags[index]! | 1;
                this.idOffsets[index] = this.storeId(record.boundaryMessageId);
                this.idLengths[index] = record.boundaryMessageId.length;
            }
            if (record.firstRetainedMessageId === null) this.messageFlags[index] = this.messageFlags[index]! | 2;
            else if (typeof record.firstRetainedMessageId === "string") {
                this.messageFlags[index] = this.messageFlags[index]! | 4;
                this.retainedOffsets[slot] = this.storeId(record.firstRetainedMessageId);
                this.retainedLengths[slot] = record.firstRetainedMessageId.length;
            }
        }
        if (kind === "context_measurement") {
            if (typeof record.afterMessageId === "string") {
                this.messageFlags[index] = 1;
                const after = this.messageRecord(record.afterMessageId);
                if (after === undefined) {
                    this.idOffsets[index] = this.storeId(record.afterMessageId);
                    this.idLengths[index] = record.afterMessageId.length;
                } else {
                    this.messageFlags[index] = this.messageFlags[index]! | 16;
                    this.parents[index] = after;
                }
            } else if (record.afterMessageId === null) this.messageFlags[index] = 2;
            if (scannedCompact === true || record.contextRecipe !== undefined) {
                this.messageFlags[index] = this.messageFlags[index]! | 4;
            }
        }
        if (kind === "harness_message") {
            if (typeof record.afterMessageId === "string") {
                const after = this.messageRecord(record.afterMessageId);
                this.messageFlags[index] = after === undefined ? 1 : 17;
                if (after === undefined) {
                    this.idOffsets[index] = this.storeId(record.afterMessageId);
                    this.idLengths[index] = record.afterMessageId.length;
                } else {
                    this.parents[index] = after;
                    if (record.crashCut === true) this.messageFlags[after] = this.messageFlags[after]! | 128;
                }
            } else if (record.afterMessageId === null) this.messageFlags[index] = 2;
        }
        if ((kind === "message" || kind === "turn_start") && typeof record.id === "string") {
            this.insertMessageId(record.id, index);
        }
    }

    location(index: number): { offset: number; length: number } | undefined {
        return index < 0 || index >= this.count ? undefined : {
            offset: this.offsets[index]!, length: this.longLengths.get(index) ?? this.lengths[index]!,
        };
    }

    kind(index: number): string | undefined {
        const number = this.kinds[index];
        return number === undefined || number === 0 ? undefined : this.kindNames[number];
    }

    messageRecord(id: string): number | undefined {
        const slot = this.findSlot(id);
        const value = this.idSlots[slot]!;
        return value === 0 ? undefined : value - 1;
    }

    messageRecordAscii(bytes: Buffer, start: number, end: number): number | undefined {
        const value = this.idSlots[this.findAsciiSlot(bytes, start, end)]!;
        return value === 0 ? undefined : value - 1;
    }

    messageIdMatchesAscii(index: number, bytes: Buffer, start: number, end: number): boolean {
        if (index < 0 || index >= this.count || this.idLengths[index] !== end - start) return false;
        const offset = this.idOffsets[index]!;
        for (let position = start; position < end; position += 1) {
            if (this.idData[offset + position - start] !== bytes[position]) return false;
        }
        return true;
    }

    appendAsciiMessage(
        offset: number, length: number, record: Record<string, unknown>,
        bytes: Buffer, start: number, end: number, parent: number | undefined,
    ): void {
        this.append(offset, length, record);
        const number = this.count - 1;
        this.parents[number] = parent ?? -1;
        if ((this.idCount + 1) * 2 > this.idSlots.length) this.growIdSlots();
        const slot = this.findAsciiSlot(bytes, start, end);
        const previous = this.idSlots[slot]!;
        if (previous !== 0) {
            this.idOffsets[number] = this.idOffsets[previous - 1]!;
            this.idLengths[number] = this.idLengths[previous - 1]!;
        } else {
            const needed = this.idDataLength + end - start;
            if (needed > this.idData.length) {
                let capacity = this.idData.length;
                while (capacity < needed) capacity *= 2;
                const data = new Uint8Array(capacity);
                data.set(this.idData);
                this.idData = data;
            }
            this.idOffsets[number] = this.idDataLength;
            this.idLengths[number] = end - start;
            for (let position = start; position < end; position += 1) this.idData[this.idDataLength++] = bytes[position]!;
            this.idCount += 1;
        }
        this.idSlots[slot] = number + 1;
    }

    appendAsciiMeasurement(offset: number, length: number, bytes: Buffer, start: number, end: number): void {
        this.append(offset, length, ASCII_MEASUREMENT, true);
        if (start < 0) return;
        const number = this.count - 1;
        const after = this.messageRecordAscii(bytes, start, end);
        this.messageFlags[number] = after === undefined ? 5 : 21;
        if (after !== undefined) {
            this.parents[number] = after;
            return;
        }
        const needed = this.idDataLength + end - start;
        if (needed > this.idData.length) {
            let capacity = this.idData.length;
            while (capacity < needed) capacity *= 2;
            const data = new Uint8Array(capacity);
            data.set(this.idData);
            this.idData = data;
        }
        this.idOffsets[number] = this.idDataLength;
        this.idLengths[number] = end - start;
        for (let position = start; position < end; position += 1) this.idData[this.idDataLength++] = bytes[position]!;
    }

    private findAsciiSlot(bytes: Buffer, start: number, end: number): number {
        let hash = 2166136261;
        for (let position = start; position < end; position += 1) hash = Math.imul(hash ^ bytes[position]!, 16777619);
        let slot = (hash >>> 0) & (this.idSlots.length - 1);
        while (this.idSlots[slot] !== 0) {
            if (this.messageIdMatchesAscii(this.idSlots[slot]! - 1, bytes, start, end)) break;
            slot = (slot + 1) & (this.idSlots.length - 1);
        }
        return slot;
    }

    parent(index: number): number | undefined {
        if (index < 0 || index >= this.count) return undefined;
        const kind = this.kinds[index];
        if (kind !== this.kindNumbers.get("message") && kind !== this.kindNumbers.get("turn_start")) return undefined;
        const parent = this.parents[index]!;
        return parent < 0 ? undefined : parent;
    }

    setAssociatedMessage(index: number, message: number | undefined): void {
        this.parents[index] = message ?? -1;
    }

    associatedMessage(index: number): number | undefined {
        const parent = this.parents[index];
        return parent === undefined || parent < 0 ? undefined : parent;
    }

    harnessAnchor(index: number): number | undefined {
        if (this.kinds[index] !== this.kindNumbers.get("harness_message") || (this.messageFlags[index]! & 1) === 0) return undefined;
        if ((this.messageFlags[index]! & 16) !== 0) return this.associatedMessage(index);
        return this.messageRecord(this.readId(this.idOffsets[index]!, this.idLengths[index]!));
    }

    isLegacyDeliveryMessage(index: number): boolean {
        return (this.messageFlags[index]! & 39) === 5;
    }

    hasUnansweredDelivery(headId: string | null): boolean {
        let current = headId === null ? undefined : this.messageRecord(headId);
        while (current !== undefined) {
            const flags = this.messageFlags[current]!;
            if ((flags & 128) !== 0) return false;
            if ((flags & 32) !== 0) return true;
            if ((flags & 3) === 2 && (flags & 8) !== 0) return false;
            current = this.parent(current);
        }
        return false;
    }

    recordOfKind(kind: string, fromEnd = true): number | undefined {
        const number = this.kindNumbers.get(kind);
        if (number === undefined) return undefined;
        if (fromEnd) {
            for (let index = this.count - 1; index >= 0; index -= 1) {
                if (this.kinds[index] === number) return index;
            }
        } else {
            for (let index = 0; index < this.count; index += 1) {
                if (this.kinds[index] === number) return index;
            }
        }
        return undefined;
    }

    previousRecordOfKind(kind: string, before: number): number | undefined {
        const number = this.kindNumbers.get(kind);
        if (number === undefined) return undefined;
        for (let index = Math.min(before, this.count) - 1; index >= 0; index -= 1) {
            if (this.kinds[index] === number) return index;
        }
        return undefined;
    }

    nextRecordOfKind(kind: string, after: number): number | undefined {
        const number = this.kindNumbers.get(kind);
        if (number === undefined) return undefined;
        for (let index = Math.max(0, after + 1); index < this.count; index += 1) {
            if (this.kinds[index] === number) return index;
        }
        return undefined;
    }

    isCompactMeasurement(index: number): boolean {
        return this.kinds[index] === this.kindNumbers.get("context_measurement") && (this.messageFlags[index]! & 4) !== 0;
    }

    isVisibleUser(index: number): boolean {
        return (this.messageFlags[index]! & 7) === 1;
    }

    isInternal(index: number): boolean {
        return (this.messageFlags[index]! & 4) !== 0;
    }

    isToolResult(index: number): boolean {
        return (this.messageFlags[index]! & 3) === 3;
    }

    startsTurnOrDelivery(index: number): boolean {
        return (this.messageFlags[index]! & (16 | 32)) !== 0;
    }

    isVisibleTextMessage(index: number): boolean {
        const flags = this.messageFlags[index]!;
        return (flags & 4) === 0 && ((flags & 3) === 1 || (flags & 3) === 2);
    }

    leavesTurnOpen(index: number): boolean {
        return (this.messageFlags[index]! & 64) !== 0 && (this.messageFlags[index]! & 128) === 0;
    }

    isAncestor(headId: string | null, candidateId: string): boolean {
        const candidate = this.messageRecord(candidateId);
        let current = headId === null ? undefined : this.messageRecord(headId);
        if (candidate === undefined) return false;
        while (current !== undefined) {
            if (current === candidate) return true;
            current = this.parent(current);
        }
        return false;
    }

    branchFacts(headId: string | null): { readonly turns: number; readonly firstUser?: number } {
        let current = headId === null ? undefined : this.messageRecord(headId);
        let turns = 0;
        let firstUser: number | undefined;
        while (current !== undefined) {
            if ((this.messageFlags[current]! & 16) !== 0) turns += 1;
            if (this.isVisibleUser(current)) firstUser = current;
            current = this.parent(current);
        }
        return { turns, ...(firstUser === undefined ? {} : { firstUser }) };
    }

    recentMessages(headId: string | null, maxBytes: number): number[] {
        let current = headId === null ? undefined : this.messageRecord(headId);
        const records: number[] = [];
        let bytes = 0;
        while (current !== undefined) {
            const length = this.location(current)!.length;
            if (length > maxBytes - bytes) break;
            records.push(current);
            bytes += length;
            current = this.parent(current);
        }
        return records.reverse();
    }

    compactionAnchor(headId: string | null, boundaryId: string): SessionCompactionAnchor | undefined {
        const target = this.messageRecord(boundaryId);
        let current = headId === null ? undefined : this.messageRecord(headId);
        if (target === undefined || current === undefined) return undefined;
        let next: number | undefined;
        let successor: number | undefined;
        let found = false;
        let barrier = this.count;
        while (current !== undefined) {
            if ((this.messageFlags[current]! & 11) === 9) barrier = current;
            if (current === target) {
                found = true;
                successor = next;
            }
            next = current;
            current = this.parent(current);
        }
        if (!found) return undefined;
        return {
            crossesBarrier: target >= barrier,
            successorId: successor === undefined ? null : this.messageId(successor)!,
            successorIsToolResult: successor !== undefined && this.isToolResult(successor),
        };
    }

    messageId(index: number): string | undefined {
        if (index < 0 || index >= this.count) return undefined;
        const kind = this.kinds[index];
        if (kind !== this.kindNumbers.get("message") && kind !== this.kindNumbers.get("turn_start")) return undefined;
        return this.readId(this.idOffsets[index]!, this.idLengths[index]!);
    }

    private readId(start: number, length: number): string {
        let id = "";
        let offset = start;
        for (let index = 0; index < length; index += 1) {
            const first = this.idData[offset++]!;
            const code = first < 128 ? first : first < 224
                ? ((first & 31) << 6) | (this.idData[offset++]! & 63)
                : ((first & 15) << 12) | ((this.idData[offset++]! & 63) << 6) | (this.idData[offset++]! & 63);
            id += String.fromCharCode(code);
        }
        return id;
    }

    latestApplicableCompaction(headId: string | null): number | undefined {
        if (headId === null) return undefined;
        let current = this.messageRecord(headId);
        const kind = this.kindNumbers.get("compaction");
        if (current === undefined || kind === undefined) return undefined;
        const members = new Uint8Array(Math.ceil(this.count / 8));
        const successors = new Int32Array(this.count).fill(-1);
        let successor = -1;
        let barrier = this.count;
        while (current !== undefined) {
            members[current >>> 3]! |= 1 << (current & 7);
            successors[current] = successor;
            if ((this.messageFlags[current]! & 11) === 9) barrier = current;
            successor = current;
            current = this.parent(current);
        }
        for (let index = this.count - 1; index >= 0; index -= 1) {
            if (this.kinds[index] !== kind || (this.messageFlags[index]! & 1) === 0) continue;
            const boundary = this.messageRecord(this.readId(this.idOffsets[index]!, this.idLengths[index]!));
            if (boundary === undefined || boundary >= barrier || (members[boundary >>> 3]! & (1 << (boundary & 7))) === 0) continue;
            const next = successors[boundary]!;
            const isNull = (this.messageFlags[index]! & 2) !== 0;
            const slot = this.parents[index]!;
            const retained = (this.messageFlags[index]! & 4) === 0 ? undefined
                : this.messageRecord(this.readId(this.retainedOffsets[slot]!, this.retainedLengths[slot]!));
            if (next < 0 ? isNull : (this.messageFlags[next]! & 3) !== 3 && (isNull || retained === next)) return index;
        }
        return undefined;
    }

    compactionBoundary(index: number): number | undefined {
        if (this.kinds[index] !== this.kindNumbers.get("compaction") || (this.messageFlags[index]! & 1) === 0) return undefined;
        return this.messageRecord(this.readId(this.idOffsets[index]!, this.idLengths[index]!));
    }

    latestMeasurement(headId: string | null): number | undefined {
        const kind = this.kindNumbers.get("context_measurement");
        if (kind === undefined) return undefined;
        const members = new Uint8Array(Math.ceil(this.count / 8));
        let current = headId === null ? undefined : this.messageRecord(headId);
        while (current !== undefined) {
            members[current >>> 3]! |= 1 << (current & 7);
            current = this.parent(current);
        }
        for (let index = this.count - 1; index >= 0; index -= 1) {
            if (this.kinds[index] !== kind) continue;
            const flags = this.messageFlags[index]!;
            if ((flags & 2) !== 0) return index;
            if ((flags & 1) === 0) continue;
            const after = this.measurementAfter(index);
            if (after !== undefined && (members[after >>> 3]! & (1 << (after & 7))) !== 0) return index;
        }
        return undefined;
    }

    rewindMeasurements(headId: string | null): number[] {
        const kind = this.kindNumbers.get("context_measurement");
        if (kind === undefined) return [];
        const members = new Uint8Array(Math.ceil(this.count / 8));
        const points = new Uint8Array(members.length);
        let current = headId === null ? undefined : this.messageRecord(headId);
        const head = current;
        while (current !== undefined) {
            members[current >>> 3]! |= 1 << (current & 7);
            const parent = this.parent(current);
            if (this.isVisibleUser(current) && parent !== undefined) points[parent >>> 3]! |= 1 << (parent & 7);
            current = parent;
        }
        const latestAt = new Int32Array(this.count).fill(-1);
        let latestNull = -1;
        for (let index = 0; index < this.count; index += 1) {
            if (this.kinds[index] !== kind) continue;
            const flags = this.messageFlags[index]!;
            if ((flags & 2) !== 0) latestNull = index;
            else if ((flags & 1) !== 0) {
                const after = this.measurementAfter(index);
                if (after !== undefined && (members[after >>> 3]! & (1 << (after & 7))) !== 0) latestAt[after] = index;
            }
        }
        const retained = new Uint8Array(members.length);
        let latest = latestNull;
        if (latest >= 0) retained[latest >>> 3]! |= 1 << (latest & 7);
        for (let index = 0; index < this.count; index += 1) {
            if ((members[index >>> 3]! & (1 << (index & 7))) === 0) continue;
            latest = Math.max(latest, latestAt[index]!);
            if (latest >= 0 && (index === head || (points[index >>> 3]! & (1 << (index & 7))) !== 0)) {
                retained[latest >>> 3]! |= 1 << (latest & 7);
            }
        }
        const records: number[] = [];
        for (let index = 0; index < this.count; index += 1) {
            if ((retained[index >>> 3]! & (1 << (index & 7))) !== 0) records.push(index);
        }
        return records;
    }

    private measurementAfter(index: number): number | undefined {
        return (this.messageFlags[index]! & 16) !== 0
            ? this.parents[index]!
            : this.messageRecord(this.readId(this.idOffsets[index]!, this.idLengths[index]!));
    }

    get length(): number { return this.count; }
    get columnBytes(): number {
        return this.offsets.byteLength + this.lengths.byteLength + this.parents.byteLength + this.kinds.byteLength + this.messageFlags.byteLength
            + this.idOffsets.byteLength + this.idLengths.byteLength + this.retainedOffsets.byteLength + this.retainedLengths.byteLength
            + this.idData.byteLength + this.idSlots.byteLength;
    }

    private findSlot(id: string): number {
        let hash = 2166136261;
        for (let index = 0; index < id.length; index += 1) {
            hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
        }
        let slot = (hash >>> 0) & (this.idSlots.length - 1);
        while (this.idSlots[slot] !== 0) {
            const record = this.idSlots[slot]! - 1;
            let offset = this.idOffsets[record]!;
            if (this.idLengths[record] === id.length) {
                let matches = true;
                for (let index = 0; index < id.length; index += 1) {
                    const first = this.idData[offset++]!;
                    const code = first < 128 ? first : first < 224
                        ? ((first & 31) << 6) | (this.idData[offset++]! & 63)
                        : ((first & 15) << 12) | ((this.idData[offset++]! & 63) << 6) | (this.idData[offset++]! & 63);
                    if (code !== id.charCodeAt(index)) {
                        matches = false;
                        break;
                    }
                }
                if (matches) break;
            }
            slot = (slot + 1) & (this.idSlots.length - 1);
        }
        return slot;
    }

    private insertMessageId(id: string, record: number): void {
        if ((this.idCount + 1) * 2 > this.idSlots.length) this.growIdSlots();
        const slot = this.findSlot(id);
        const existing = this.idSlots[slot];
        if (existing !== 0) {
            const previous = existing! - 1;
            this.idOffsets[record] = this.idOffsets[previous]!;
            this.idLengths[record] = this.idLengths[previous]!;
        } else {
            this.idOffsets[record] = this.storeId(id);
            this.idLengths[record] = id.length;
            this.idCount += 1;
        }
        this.idSlots[slot] = record + 1;
    }

    private storeId(id: string): number {
        // Encoding UTF-16 code units separately preserves unpaired surrogates.
        let size = 0;
        for (let index = 0; index < id.length; index += 1) {
            const code = id.charCodeAt(index);
            size += code < 128 ? 1 : code < 2048 ? 2 : 3;
        }
        const needed = this.idDataLength + size;
        if (needed > this.idData.length) {
            let capacity = this.idData.length;
            while (capacity < needed) capacity *= 2;
            const data = new Uint8Array(capacity);
            data.set(this.idData);
            this.idData = data;
        }
        const offset = this.idDataLength;
        for (let index = 0; index < id.length; index += 1) {
            const code = id.charCodeAt(index);
            if (code < 128) this.idData[this.idDataLength++] = code;
            else if (code < 2048) {
                this.idData[this.idDataLength++] = 192 | (code >>> 6);
                this.idData[this.idDataLength++] = 128 | (code & 63);
            } else {
                this.idData[this.idDataLength++] = 224 | (code >>> 12);
                this.idData[this.idDataLength++] = 128 | ((code >>> 6) & 63);
                this.idData[this.idDataLength++] = 128 | (code & 63);
            }
        }
        return offset;
    }

    private growIdSlots(): void {
        const oldSlots = this.idSlots;
        this.idSlots = new Uint32Array(oldSlots.length * 2);
        for (const value of oldSlots) {
            if (value === 0) continue;
            const record = value - 1;
            let offset = this.idOffsets[record]!;
            const length = this.idLengths[record]!;
            let hash = 2166136261;
            for (let index = 0; index < length; index += 1) {
                const first = this.idData[offset++]!;
                const code = first < 128 ? first : first < 224
                    ? ((first & 31) << 6) | (this.idData[offset++]! & 63)
                    : ((first & 15) << 12) | ((this.idData[offset++]! & 63) << 6) | (this.idData[offset++]! & 63);
                hash = Math.imul(hash ^ code, 16777619);
            }
            let slot = (hash >>> 0) & (this.idSlots.length - 1);
            while (this.idSlots[slot] !== 0) slot = (slot + 1) & (this.idSlots.length - 1);
            this.idSlots[slot] = value;
        }
    }

    private grow(): void {
        const offsets = new Float64Array(this.offsets.length * 2);
        const lengths = new Uint32Array(this.lengths.length * 2);
        const parents = new Int32Array(this.parents.length * 2);
        const kinds = new Uint16Array(this.kinds.length * 2);
        const messageFlags = new Uint8Array(this.messageFlags.length * 2);
        const idOffsets = new Uint32Array(this.idOffsets.length * 2);
        const idLengths = new Uint32Array(this.idLengths.length * 2);
        offsets.set(this.offsets);
        lengths.set(this.lengths);
        parents.set(this.parents);
        kinds.set(this.kinds);
        messageFlags.set(this.messageFlags);
        idOffsets.set(this.idOffsets);
        idLengths.set(this.idLengths);
        this.offsets = offsets;
        this.lengths = lengths;
        this.parents = parents;
        this.kinds = kinds;
        this.messageFlags = messageFlags;
        this.idOffsets = idOffsets;
        this.idLengths = idLengths;
    }
}
