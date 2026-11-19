import type { HighlightedCode } from "./tokens.ts";

// Least recently used, capped by entry count and by the characters of source text kept.
export class HighlightCache {
    private readonly entries = new Map<string, { readonly value: HighlightedCode; readonly cost: number }>();
    private total = 0;

    constructor(
        private readonly maxEntries: number,
        private readonly maxCost: number,
    ) {}

    get(key: string): HighlightedCode | undefined {
        const found = this.entries.get(key);
        if (found === undefined) return undefined;
        this.entries.delete(key);
        this.entries.set(key, found);
        return found.value;
    }

    set(key: string, value: HighlightedCode, cost: number): void {
        if (cost > this.maxCost) return;
        const existing = this.entries.get(key);
        if (existing !== undefined) {
            this.total -= existing.cost;
            this.entries.delete(key);
        }
        this.entries.set(key, { value, cost });
        this.total += cost;
        for (const [oldest, item] of this.entries) {
            if (this.entries.size <= this.maxEntries && this.total <= this.maxCost) break;
            this.entries.delete(oldest);
            this.total -= item.cost;
        }
    }

    get size(): number {
        return this.entries.size;
    }

    get cost(): number {
        return this.total;
    }
}
