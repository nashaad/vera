import { expect, test } from "bun:test";

import { LineBuffer } from "../../src/host/line-buffer.ts";

function lineText(result: ReturnType<LineBuffer["next"]>): string {
    if (result.kind !== "line") {
        throw new Error(`expected a line, got ${result.kind}`);
    }
    return result.bytes.toString("utf8");
}

test("joins a line split across many chunks", () => {
    const buffer = new LineBuffer();
    for (let index = 0; index < 100; index += 1) {
        buffer.push(Buffer.from("ab"));
        expect(buffer.next().kind).toBe("need-more");
    }
    buffer.push(Buffer.from("c\n"));
    expect(lineText(buffer.next())).toBe(`${"ab".repeat(100)}c`);
    expect(buffer.bufferedBytes).toBe(0);
});

test("returns several lines from one chunk", () => {
    const buffer = new LineBuffer();
    buffer.push(Buffer.from("one\ntwo\n\nthree\n"));
    expect(lineText(buffer.next())).toBe("one");
    expect(lineText(buffer.next())).toBe("two");
    expect(lineText(buffer.next())).toBe("");
    expect(lineText(buffer.next())).toBe("three");
    expect(buffer.next().kind).toBe("need-more");
});

test("does not rescan bytes that already arrived without a newline", () => {
    const buffer = new LineBuffer();
    buffer.push(Buffer.from("abc"));
    expect(buffer.next().kind).toBe("need-more");
    buffer.push(Buffer.from("def\n"));
    expect(lineText(buffer.next())).toBe("abcdef");
});

test("accepts a line exactly at the byte limit", () => {
    const buffer = new LineBuffer({ maxLineBytes: 5 });
    buffer.push(Buffer.from("12345\n"));
    expect(lineText(buffer.next())).toBe("12345");
});

test("reports an oversized complete line and keeps the next line", () => {
    const buffer = new LineBuffer({ maxLineBytes: 4 });
    buffer.push(Buffer.from("12345\nok\n"));
    expect(buffer.next()).toEqual({ kind: "oversized", byteLength: 5 });
    expect(lineText(buffer.next())).toBe("ok");
});

test("discards an oversized line without joining it", () => {
    const buffer = new LineBuffer({ maxLineBytes: 4 });
    buffer.push(Buffer.from("0123456789"));
    expect(buffer.next().kind).toBe("need-more");
    expect(buffer.bufferedBytes).toBe(0);
    buffer.push(Buffer.from("tail\nok\n"));
    expect(buffer.next()).toEqual({ kind: "oversized", byteLength: 14 });
    expect(lineText(buffer.next())).toBe("ok");
});

test("reports the bytes of an incomplete line", () => {
    const buffer = new LineBuffer();
    buffer.push(Buffer.from("abc"));
    expect(buffer.bufferedBytes).toBe(3);
});

test("keeps multi-byte characters intact when chunks split them", () => {
    const buffer = new LineBuffer();
    const bytes = Buffer.from("héllo\n", "utf8");
    buffer.push(bytes.subarray(0, 2));
    buffer.push(bytes.subarray(2));
    expect(lineText(buffer.next())).toBe("héllo");
});
