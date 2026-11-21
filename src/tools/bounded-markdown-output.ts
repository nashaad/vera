export const MARKDOWN_LIMIT_REACHED = Symbol("markdown-limit-reached");

export class BoundedMarkdownOutput {
    private output = "";
    private pending = "";
    private pendingLength = 0;
    private trailingSpaces = 0;
    private trailingSpaceTail = "";
    private pendingTail = "";
    private cut = false;

    constructor(private readonly limit: number) {}

    write(value: string): void {
        const runs = /\s+|\S+/g;
        for (let match = runs.exec(value); match !== null; match = runs.exec(value)) {
            const text = match[0];
            if (/^\s/.test(text)) {
                this.writeWhitespace(text);
            } else {
                this.flushPending();
                this.writeText(text);
            }
        }
    }

    result(): { readonly markdown: string; readonly truncated: boolean } {
        return { markdown: this.output, truncated: this.cut };
    }

    private writeText(text: string): void {
        const available = this.limit - this.output.length;
        if (text.length <= available) {
            this.output += text;
            return;
        }
        let end = available;
        if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) {
            end--;
        } else if (end === 0 && /[\uD800-\uDBFF]/.test(this.output.at(-1) ?? "") && /[\uDC00-\uDFFF]/.test(text[0]!)) {
            this.output = this.output.slice(0, -1);
        }
        this.output += text.slice(0, end);
        this.cut = true;
        throw MARKDOWN_LIMIT_REACHED;
    }

    private writeWhitespace(value: string): void {
        if (this.output.length === 0) return;
        const runs = /[ \t]+|\n+|[^\S \t\n]+/g;
        for (let match = runs.exec(value); match !== null; match = runs.exec(value)) {
            const text = match[0];
            if (text[0] === " " || text[0] === "\t") {
                this.appendPending(text);
                this.trailingSpaces += text.length;
                this.trailingSpaceTail = (this.trailingSpaceTail + text).slice(-2);
            } else if (text[0] === "\n") {
                this.pendingLength -= this.trailingSpaces;
                this.pending = this.pending.slice(0, this.pendingLength);
                this.trailingSpaces = 0;
                this.trailingSpaceTail = "";
                const existing = this.pendingTail.endsWith("\n\n") ? 2 : this.pendingTail.endsWith("\n") ? 1 : 0;
                const next = "\n".repeat(Math.min(text.length, 2 - existing));
                this.appendPending(next);
                this.pendingTail = (this.pendingTail + next).slice(-2);
            } else {
                this.pendingTail = (this.pendingTail + this.trailingSpaceTail + text).slice(-2);
                this.trailingSpaces = 0;
                this.trailingSpaceTail = "";
                this.appendPending(text);
            }
        }
    }

    private appendPending(text: string): void {
        const capacity = this.limit - this.output.length + 1;
        if (this.pending.length < capacity) this.pending += text.slice(0, capacity - this.pending.length);
        this.pendingLength += text.length;
    }

    private flushPending(): void {
        if (this.pendingLength > 0 && this.output.length > 0) {
            const available = this.limit - this.output.length;
            this.output += this.pending.slice(0, available);
            if (this.pendingLength > available) {
                this.cut = true;
                throw MARKDOWN_LIMIT_REACHED;
            }
        }
        this.pending = "";
        this.pendingLength = 0;
        this.trailingSpaces = 0;
        this.trailingSpaceTail = "";
        this.pendingTail = "";
    }
}
