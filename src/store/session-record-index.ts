export class SessionRecordIndex {
    private offsets = new Float64Array(64);
    private lengths = new Float64Array(64);
    private parents = new Int32Array(64);
    private kinds = new Uint16Array(64);
    private readonly kindNumbers = new Map<string, number>();
    private readonly messageNumbers = new Map<string, number>();
    private count = 0;

    append(offset: number, length: number, record: Record<string, unknown>): void {
        if (this.count === this.offsets.length) this.grow();
        const index = this.count++;
        this.offsets[index] = offset;
        this.lengths[index] = length;
        const kind = typeof record.type === "string" ? record.type : "";
        let kindNumber = this.kindNumbers.get(kind);
        if (kindNumber === undefined) {
            kindNumber = this.kindNumbers.size + 1;
            this.kindNumbers.set(kind, kindNumber);
        }
        this.kinds[index] = kindNumber;
        this.parents[index] = typeof record.parentId === "string"
            ? this.messageNumbers.get(record.parentId) ?? -1 : -1;
        if ((kind === "message" || kind === "turn_start") && typeof record.id === "string") {
            this.messageNumbers.set(record.id, index);
        }
    }

    location(index: number): { offset: number; length: number } | undefined {
        return index < 0 || index >= this.count ? undefined : {
            offset: this.offsets[index]!, length: this.lengths[index]!,
        };
    }

    messageRecord(id: string): number | undefined {
        return this.messageNumbers.get(id);
    }

    get length(): number { return this.count; }
    get columnBytes(): number {
        return this.offsets.byteLength + this.lengths.byteLength + this.parents.byteLength + this.kinds.byteLength;
    }

    private grow(): void {
        const offsets = new Float64Array(this.offsets.length * 2);
        const lengths = new Float64Array(this.lengths.length * 2);
        const parents = new Int32Array(this.parents.length * 2);
        const kinds = new Uint16Array(this.kinds.length * 2);
        offsets.set(this.offsets);
        lengths.set(this.lengths);
        parents.set(this.parents);
        kinds.set(this.kinds);
        this.offsets = offsets;
        this.lengths = lengths;
        this.parents = parents;
        this.kinds = kinds;
    }
}
