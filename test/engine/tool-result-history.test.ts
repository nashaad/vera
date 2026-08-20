import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    assembleAgedToolResults,
    TOOL_RESULT_STUB_AFTER_TURNS,
    TOOL_RESULT_TOTAL_BUDGET_BYTES,
} from "../../src/engine/tool-result-history.ts";
import { emptyUsage, type ModelMessage } from "../../src/model/types.ts";

test("old built-in results get mechanical digests at assembly time", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-tool-history-"));
    try {
        const cases: readonly [string, string, string][] = [
            [
                "grep",
                "src/a.ts:12:needle\nsrc/a.ts:20:other\nsrc/b.ts:4:needle",
                "src/a.ts: 2 matches",
            ],
            ["bash", "first\nsecond\nthird", "Command: echo hi"],
            ["read", "12\tneedle\n[vera] Showing lines 12-12 of 20.", "Path: note.md"],
            ["list", "a.md\nb.md\n", "Entries: 2"],
        ];

        for (const [tool, original, expected] of cases) {
            const spillPath = join(directory, `${tool}.txt`);
            await writeFile(spillPath, original, "utf8");
            const projected = assembleAgedToolResults(
                agedEntries(tool, original, spillPath),
                1,
            );
            const result = projected.find((message) =>
                message.role === "tool_result"
            );
            expect(result?.role === "tool_result" && result.content[0]?.text)
                .toContain(expected);
            expect(result?.role === "tool_result" && result.content[0]?.text)
                .toContain(`Full output remains available at ${spillPath}`);
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("unknown tools receive a recoverable stub instead of an invented digest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-tool-stub-"));
    try {
        const spillPath = join(directory, "extension.txt");
        await writeFile(spillPath, "extension output", "utf8");
        const result = assembleAgedToolResults(
            agedEntries("extension_dump", "extension output", spillPath),
            1,
        ).find((message) => message.role === "tool_result");

        expect(result?.role === "tool_result" && result.content[0]?.text)
            .toContain("Stub for older extension_dump result");
        expect(result?.role === "tool_result" && result.content[0]?.text)
            .toContain(spillPath);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("provenance references add original lines to, never subtract from, a digest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-tool-provenance-"));
    try {
        const spillPath = join(directory, "grep.txt");
        const original = "src/a.ts:12:needle needleIdentifier\nsrc/a.ts:20:unrelated";
        await writeFile(spillPath, original, "utf8");
        const result = assembleAgedToolResults([
            ...agedEntries("grep", original, spillPath),
            assistant("I used src/a.ts:12, needleIdentifier, and the \"needle\" line."),
        ], 1).find((message) => message.role === "tool_result");

        expect(result?.role === "tool_result" && result.content[0]?.text)
            .toContain("Provenance retained");
        expect(result?.role === "tool_result" && result.content[0]?.text)
            .toContain("src/a.ts:12:needle");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("a missing spill preserves the durable result instead of a dead pointer", () => {
    const original = "x".repeat(3_000);
    const result = assembleAgedToolResults(
        agedEntries("extension_dump", original, "/missing/spill"),
        1,
    ).find((message) => message.role === "tool_result");

    expect(result?.role === "tool_result" && result.content[0]?.text)
        .toBe(original);
});

test("generated digests stay under the tool-result ceiling", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-tool-digest-cap-"));
    try {
        const original = "x".repeat(200_000);
        const spillPath = join(directory, "huge.txt");
        await writeFile(spillPath, original, "utf8");
        const result = assembleAgedToolResults(
            agedEntries("bash", original, spillPath),
            1,
        ).find((message) => message.role === "tool_result");

        expect(result?.role === "tool_result" && result.content[0]?.text)
            .toHaveLength(65_536);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("grep count output is rolled up as counts, not one match per file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-tool-grep-count-"));
    try {
        const original = "src/a.ts:12\nsrc/b.ts:3\n";
        const spillPath = join(directory, "count.txt");
        await writeFile(spillPath, original, "utf8");
        const result = assembleAgedToolResults(
            agedEntries("grep", original, spillPath, "count"),
            1,
        ).find((message) => message.role === "tool_result");
        const text = result?.role === "tool_result"
            ? result.content[0]?.text
            : undefined;

        expect(text).toContain("src/a.ts: 12 matches");
        expect(text).toContain("src/b.ts: 3 matches");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("results younger than the age line remain verbatim", async () => {
    const original = "src/a.ts:12:needle";
    const projected = assembleAgedToolResults(
        agedEntries("grep", original, "/missing/spill"),
        TOOL_RESULT_STUB_AFTER_TURNS,
    );
    const result = projected.find((message) => message.role === "tool_result");
    expect(result?.role === "tool_result" && result.content[0]?.text)
        .toBe(original);
});

test("several legal results in one turn are bounded together", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-tool-budget-"));
    try {
        const entries: { readonly message: ModelMessage }[] = [user("find it")];
        const originals: string[] = [];
        for (let index = 0; index < 4; index += 1) {
            const id = `call-${index}`;
            const original = Array.from(
                { length: 2_400 },
                (_, line) => `src/file-${index}.ts:${line + 1}:result-${index}`,
            ).join("\n");
            const spillPath = join(directory, `${id}.txt`);
            await writeFile(spillPath, original, "utf8");
            originals.push(original);
            entries.push(call(id, "grep"));
            entries.push({
                message: {
                    role: "tool_result",
                    toolCallId: id,
                    toolName: "grep",
                    content: [{ type: "text", text: original }],
                    isError: false,
                    toolResultSource: {
                        originalBytes: Buffer.byteLength(original, "utf8"),
                        spillPath,
                    },
                },
            });
        }

        const projected = assembleAgedToolResults(entries);
        const results = projected.filter((message) =>
            message.role === "tool_result"
        );
        const carriedBytes = results.reduce((total, message) =>
            total + (message.role === "tool_result"
                ? Buffer.byteLength(message.content[0]?.text ?? "", "utf8")
                : 0), 0);

        expect(carriedBytes).toBeLessThanOrEqual(
            TOOL_RESULT_TOTAL_BUDGET_BYTES,
        );
        expect(results[0]?.role === "tool_result"
            && results[0].content[0]?.text).toContain("Digest of older grep");
        expect(results.at(-1)?.role === "tool_result"
            && results.at(-1)?.content[0]?.text).toBe(originals.at(-1));
        const durable = entries.filter((entry) =>
            entry.message.role === "tool_result"
        );
        for (let index = 0; index < durable.length; index += 1) {
            const message = durable[index]?.message;
            expect(message?.role === "tool_result"
                && message.content[0]?.text).toBe(originals[index]);
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("source-less results cannot fail open past the cumulative budget", () => {
    const entries: { readonly message: ModelMessage }[] = [user("work")];
    for (let index = 0; index < 65; index += 1) {
        const id = `call-${index}`;
        entries.push(call(id, "extension_tool"));
        entries.push({
            message: {
                role: "tool_result",
                toolCallId: id,
                toolName: "extension_tool",
                content: [{ type: "text", text: "x".repeat(2_048) }],
                isError: false,
            },
        });
    }

    const projected = assembleAgedToolResults(entries);
    const carriedBytes = projected.reduce((total, message) =>
        total + (message.role === "tool_result"
            ? Buffer.byteLength(message.content[0]?.text ?? "", "utf8")
            : 0), 0);
    expect(carriedBytes).toBeLessThanOrEqual(TOOL_RESULT_TOTAL_BUDGET_BYTES);
    expect(projected.some((message) =>
        message.role === "tool_result"
        && message.content[0]?.text.includes("no re-readable spill")
    )).toBe(true);
});

test("an expired spill never becomes a false recovery pointer", () => {
    const entries: { readonly message: ModelMessage }[] = [user("work")];
    for (let index = 0; index < 3; index += 1) {
        const id = `call-${index}`;
        entries.push(call(id, "grep"));
        entries.push({
            message: {
                role: "tool_result",
                toolCallId: id,
                toolName: "grep",
                content: [{ type: "text", text: "x".repeat(65_536) }],
                isError: false,
                toolResultSource: {
                    originalBytes: 65_536,
                    spillPath: `/missing/${id}`,
                },
            },
        });
    }

    const text = assembleAgedToolResults(entries)
        .filter((message) => message.role === "tool_result")
        .map((message) => message.content[0]?.text ?? "")
        .join("\n");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
        TOOL_RESULT_TOTAL_BUDGET_BYTES,
    );
    expect(text).not.toContain("Full output remains available");
    expect(text).toContain("no re-readable spill");
});

function agedEntries(
    tool: string,
    output: string,
    spillPath: string,
    outputMode?: "count",
): { readonly message: ModelMessage }[] {
    return [
        user("first"),
        call("call-1", tool, outputMode),
        {
            message: {
                role: "tool_result",
                toolCallId: "call-1",
                toolName: tool,
                content: [{ type: "text", text: output }],
                isError: false,
                toolResultSource: {
                    originalBytes: Math.max(
                        3_000,
                        Buffer.byteLength(output, "utf8"),
                    ),
                    spillPath,
                },
            },
        },
        assistant("done"),
        user("second"),
    ];
}

function user(text: string): { readonly message: ModelMessage } {
    return { message: { role: "user", content: [{ type: "text", text }] } };
}

function assistant(text: string): { readonly message: ModelMessage } {
    return {
        message: {
            role: "assistant",
            content: [{ type: "text", text }],
            source: { provider: "test", api: "test", model: "test" },
            usage: emptyUsage(),
            stopReason: "stop",
        },
    };
}

function call(
    id: string,
    name: string,
    outputMode?: "count",
): { readonly message: ModelMessage } {
    return {
        message: {
            role: "assistant",
            content: [{
                type: "tool_call",
                id,
                name,
                input: {
                    path: "note.md",
                    command: "echo hi",
                    ...(outputMode === undefined ? {} : { output_mode: outputMode }),
                },
            }],
            source: { provider: "test", api: "test", model: "test" },
            usage: emptyUsage(),
            stopReason: "tool_use",
        },
    };
}
