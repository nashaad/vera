import { closeSync, existsSync, fstatSync, openSync, readSync, type BigIntStats } from "node:fs";
import { addRecordedSpend, type ConversationCost, type SpendTotals } from "./budget.ts";

interface CostCursor {
    readonly stat: BigIntStats;
    readonly offset: number;
    readonly tail: Buffer;
    readonly dollars: number;
    readonly priced: number;
    readonly unpriced: number;
    readonly result: ConversationCost;
}

const chunkBytes = 64 * 1024;
const tailBytes = 4096;

export class ConversationCosts {
    private readonly cursors = new Map<string, CostCursor>();

    read(path: string): ConversationCost {
        if (!existsSync(path)) {
            this.cursors.delete(path);
            return { dollars: 0, priced: 0, unpriced: 0 };
        }
        const file = openSync(path, "r");
        try {
            const stat = fstatSync(file, { bigint: true });
            let prior = this.cursors.get(path);
            if (prior !== undefined && (prior.stat.dev !== stat.dev || prior.stat.ino !== stat.ino
                || prior.stat.birthtimeNs !== stat.birthtimeNs || stat.size < prior.stat.size
                || (stat.size === prior.stat.size
                    && (stat.mtimeNs !== prior.stat.mtimeNs || stat.ctimeNs !== prior.stat.ctimeNs)))) {
                prior = undefined;
            }
            if (prior !== undefined && stat.size > prior.stat.size) {
                const tail = Buffer.alloc(prior.tail.length);
                const count = readSync(file, tail, 0, tail.length, prior.offset - tail.length);
                if (count !== tail.length || !tail.equals(prior.tail)) prior = undefined;
            }
            if (prior !== undefined && stat.size === prior.stat.size) return prior.result;
            const cursor = scan(file, stat, prior);
            this.cursors.delete(path);
            this.cursors.set(path, cursor);
            // Closed sessions must not leave an unbounded cache in a resident process.
            if (this.cursors.size > 128) this.cursors.delete(this.cursors.keys().next().value!);
            return cursor.result;
        } catch (error) {
            this.cursors.delete(path);
            throw error;
        } finally {
            closeSync(file);
        }
    }
}

function scan(file: number, stat: BigIntStats, prior?: CostCursor): CostCursor {
    const totals: SpendTotals = {
        dollars: prior?.dollars ?? 0,
        priced: prior?.priced ?? 0,
        unpriced: prior?.unpriced ?? 0,
    };
    let position = prior?.offset ?? 0;
    let offset = position;
    let pending: Buffer[] = [];
    const chunk = Buffer.alloc(chunkBytes);
    const size = Number(stat.size);
    const add = (line: string): void => {
        if (!line.trim()) return;
        addRecordedSpend(totals, JSON.parse(line));
    };
    while (position < size) {
        const count = readSync(file, chunk, 0, Math.min(chunk.length, size - position), position);
        if (count === 0) throw new Error("Session file changed while reading cost");
        let start = 0;
        for (let end = chunk.indexOf(10, start); end >= 0 && end < count; end = chunk.indexOf(10, start)) {
            const part = chunk.subarray(start, end);
            add(pending.length === 0 ? part.toString("utf8") : Buffer.concat([...pending, part]).toString("utf8"));
            pending = [];
            start = end + 1;
            offset = position + start;
        }
        if (start < count) pending.push(Buffer.from(chunk.subarray(start, count)));
        position += count;
    }
    // A valid final record without a newline counts now, but must be reread after an append.
    const complete = { ...totals };
    if (pending.length > 0) add(Buffer.concat(pending).toString("utf8"));
    const result = rounded(totals);
    const tail = Buffer.alloc(Math.min(tailBytes, offset));
    if (tail.length > 0 && readSync(file, tail, 0, tail.length, offset - tail.length) !== tail.length) {
        throw new Error("Session file changed while reading cost");
    }
    return { stat, offset, tail, ...complete, result };
}

function rounded(cost: ConversationCost): ConversationCost {
    return { dollars: Math.round(cost.dollars * 1e9) / 1e9, priced: cost.priced, unpriced: cost.unpriced };
}
