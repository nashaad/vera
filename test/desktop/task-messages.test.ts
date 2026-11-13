import { expect, test } from "bun:test";

import { decodeJsonLine, LineReader } from "../../clients/desktop/src/tasks/lines.ts";
import {
    logMessage,
    parseRunMessage,
    parseTaskOutput,
    progressMessage,
    resultMessage,
    runMessage,
} from "../../clients/desktop/src/tasks/messages.ts";

const bytes = (text: string): Buffer => Buffer.from(text, "utf8");

test("@core task messages survive structuredClone and JSON unchanged", () => {
    const outputs = [
        progressMessage({ message: "reading", increment: 12.5 }),
        progressMessage({ increment: 0 }),
        progressMessage({}),
        logMessage({ level: "warn", text: "slow" }),
        resultMessage({ pong: 1, nested: ["a", { b: null }] }),
    ];
    for (const output of outputs) {
        expect(parseTaskOutput(structuredClone(output))).toEqual(output);
        expect(parseTaskOutput(JSON.parse(JSON.stringify(output)))).toEqual(output);
    }
    const run = runMessage({ ping: 1 });
    expect(parseRunMessage(structuredClone(run))).toEqual(run);
    expect(parseRunMessage(JSON.parse(JSON.stringify(run)))).toEqual(run);
});

test("@core progress messages carry only the fields that were set", () => {
    expect(Object.keys(progressMessage({}))).toEqual(["type"]);
    expect(Object.keys(progressMessage({ message: "m", increment: undefined }))).toEqual(["type", "message"]);
    expect(parseTaskOutput({ type: "progress", message: undefined, increment: undefined })).toEqual({ type: "progress" });
});

test("@core unknown keys are dropped and malformed messages are refused", () => {
    expect(parseTaskOutput({ type: "log", level: "info", text: "x", extra: 1 })).toEqual({ type: "log", level: "info", text: "x" });
    for (const value of [undefined, null, 3, "x", [], {}, { type: "other" }, { type: "result" }, { type: "log", level: "trace", text: "x" }]) {
        expect(parseTaskOutput(value)).toBeUndefined();
    }
    for (const value of [undefined, null, [], {}, { type: "run" }, { type: "result", task: {} }, { task: {} }]) {
        expect(parseRunMessage(value)).toBeUndefined();
    }
});

test("@core lines are split across chunks and a multi-byte character may straddle two", () => {
    const reader = new LineReader(1024);
    const full = bytes('{"type":"log","level":"info","text":"héllo €"}\n');
    const cut = full.indexOf(0xc3) + 1;
    expect(reader.push(full.subarray(0, cut))).toEqual({ lines: [], overflow: false });
    const second = reader.push(Buffer.concat([full.subarray(cut), bytes('{"a":1}\n{"b":')]));
    expect(second.overflow).toBe(false);
    expect(second.lines.map((line) => decodeJsonLine(line))).toEqual([{ type: "log", level: "info", text: "héllo €" }, { a: 1 }]);
    const third = reader.push(bytes("2}\r\n"));
    expect(third.lines.map((line) => decodeJsonLine(line))).toEqual([{ b: 2 }]);
});

test("@core a line over the limit is refused and the reader stops buffering", () => {
    const reader = new LineReader(8);
    expect(reader.push(bytes("12345678\n")).lines.map(String)).toEqual(["12345678"]);
    expect(reader.push(bytes("123456")).overflow).toBe(false);
    expect(reader.push(bytes("789"))).toEqual({ lines: [], overflow: true });
    expect(reader.push(bytes("ok\n"))).toEqual({ lines: [], overflow: true });
});

test("@core a line that is not strict UTF-8 JSON decodes to nothing", () => {
    expect(decodeJsonLine(bytes("{broken"))).toBeUndefined();
    expect(decodeJsonLine(bytes(""))).toBeUndefined();
    expect(decodeJsonLine(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]))).toBeUndefined();
    expect(decodeJsonLine(bytes('{"a":1}'))).toEqual({ a: 1 });
});
