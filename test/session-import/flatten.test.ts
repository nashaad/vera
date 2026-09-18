import { expect, test } from "bun:test";

import {
    MessageBuilder,
    mainArgument,
    toolCallLine,
    toolResultExcerpt,
} from "../../src/session-import/flatten.ts";

test("a short result is kept whole", () => {
    expect(toolResultExcerpt("one\ntwo\n", false)).toBe("one\ntwo");
});

test("a result over 20 lines keeps the first 20 and names the full size", () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index}`);
    const excerpt = toolResultExcerpt(lines.join("\n"), false);
    expect(excerpt.split("\n").slice(0, 20)).toEqual(lines.slice(0, 20));
    expect(excerpt.split("\n")).toHaveLength(21);
    expect(excerpt).toEndWith("[truncated, 229 B]");
});

test("a result over 2 KB is cut to 2 KB even on fewer than 20 lines", () => {
    const excerpt = toolResultExcerpt("x".repeat(10_000), false);
    expect(excerpt).toBe(`${"x".repeat(2_048)}\n[truncated, 10 KB]`);
});

test("a multi-byte character is never split at the byte cut", () => {
    const excerpt = toolResultExcerpt("é".repeat(2_000), false);
    const body = excerpt.split("\n")[0]!;
    expect(body).toBe("é".repeat(1_024));
});

test("a failed result is prefixed", () => {
    expect(toolResultExcerpt("no such file", true)).toBe("[tool error] no such file");
});

test("the main argument prefers a path, then a command, then a pattern", () => {
    expect(mainArgument({ file_path: "src/a.ts", old_string: "x" })).toBe("src/a.ts");
    expect(mainArgument({ command: "git status\ngit diff" })).toBe("git status");
    expect(mainArgument({ cmd: "ls -la", workdir: "/x" })).toBe("ls -la");
    expect(mainArgument({ command: ["bash", "-lc", "ls"] })).toBe("bash -lc ls");
    expect(mainArgument({ pattern: "TODO", path: "src" })).toBe("TODO");
});

test("a patch names the files it touches", () => {
    const patch = [
        "*** Begin Patch",
        "*** Update File: src/a.ts",
        "@@",
        "-x",
        "+y",
        "*** Add File: src/b.ts",
        "+z",
        "*** End Patch",
    ].join("\n");
    expect(mainArgument(patch)).toBe("src/a.ts, src/b.ts");
    expect(mainArgument({ input: patch })).toBe("src/a.ts, src/b.ts");
});

test("other arguments fall back to compact JSON cut at 200 characters", () => {
    expect(mainArgument({ url: "https://example.com" })).toBe('{"url":"https://example.com"}');
    expect(mainArgument({ text: "y".repeat(500) })).toHaveLength(200);
});

test("a tool call is one line", () => {
    expect(toolCallLine("Read", { file_path: "a.ts" })).toBe("[tool] Read a.ts");
    expect(toolCallLine("Noop", {})).toBe("[tool] Noop {}");
});

test("the builder merges neighbours, alternates, and starts with the user", () => {
    const builder = new MessageBuilder();
    builder.add("assistant", "orphan before any user", "t0");
    builder.add("user", "hello", "t1");
    builder.add("user", "[image]", "t2");
    builder.add("assistant", "  ", "t3");
    builder.add("assistant", "hi", "t4");
    builder.add("assistant", "[tool] Read a.ts", "t5");
    builder.add("user", "thanks", "t6");
    expect(builder.messages()).toEqual([
        { role: "user", text: "hello\n\n[image]", timestamp: "t1" },
        { role: "assistant", text: "hi\n\n[tool] Read a.ts", timestamp: "t4" },
        { role: "user", text: "thanks", timestamp: "t6" },
    ]);
});
