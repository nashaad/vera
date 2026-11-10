export class SessionTimestampMaxima {
    private records = new Uint32Array(64);
    private values = new Uint8Array(64 * 24);
    private canonical = new Uint8Array(64);
    private readonly other = new Map<number, string>();
    private length = 0;

    add(bytes: Buffer, start: number, end: number, record: number): void {
        let ascii = end - start === 26;
        if (ascii) {
            for (let position = start + 1; position < end - 1; position += 1) {
                const byte = bytes[position]!;
                if (byte >= 128 || byte === 92) { ascii = false; break; }
            }
        }
        let value: string | undefined;
        if (this.length > 0) {
            const previous = this.length - 1;
            if (ascii && this.canonical[previous] === 1) {
                let comparison = 0;
                for (let index = 0; index < 24; index += 1) {
                    comparison = bytes[start + index + 1]! - this.values[previous * 24 + index]!;
                    if (comparison !== 0) break;
                }
                if (comparison <= 0) return;
            } else {
                value = JSON.parse(bytes.toString("utf8", start, end)) as string;
                if (value <= this.value(previous)) return;
            }
        }
        if (this.length === this.records.length) this.grow();
        const slot = this.length++;
        this.records[slot] = record;
        this.canonical[slot] = ascii ? 1 : 0;
        if (ascii) {
            for (let index = 0; index < 24; index += 1) this.values[slot * 24 + index] = bytes[start + index + 1]!;
        } else {
            this.other.set(slot, value ?? JSON.parse(bytes.toString("utf8", start, end)) as string);
        }
    }

    rewind(head: number | undefined): void {
        while (this.length > 0 && this.records[this.length - 1]! > (head ?? -1)) {
            this.length -= 1;
            this.other.delete(this.length);
        }
    }

    latest(): string | undefined {
        return this.length === 0 ? undefined : this.value(this.length - 1);
    }

    private value(slot: number): string {
        return this.canonical[slot] === 1
            ? Buffer.from(this.values.buffer, slot * 24, 24).toString("ascii")
            : this.other.get(slot)!;
    }

    private grow(): void {
        const records = new Uint32Array(this.records.length * 2);
        const values = new Uint8Array(this.values.length * 2);
        const canonical = new Uint8Array(this.canonical.length * 2);
        records.set(this.records);
        values.set(this.values);
        canonical.set(this.canonical);
        this.records = records;
        this.values = values;
        this.canonical = canonical;
    }
}
