import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    assembleAgedToolResults,
    ToolResultDigestCache,
    TOOL_RESULT_STUB_AFTER_TURNS,
    toolResultAgingLevel,
    TOOL_RESULT_TOTAL_BUDGET_BYTES,
    TOOL_RESULT_TOTAL_BUDGET_FLOOR_BYTES,
    TOOL_RESULT_TOTAL_BUDGET_MAX_BYTES,
    toolResultTotalBudgetBytes,
    type ToolResultAgingPolicy,
} from "../../src/engine/tool-result-history.ts";
import { measureMessages } from "../../src/engine/context-measurement.ts";
import { toolResultCeilingBytes } from "../../src/tools/tool-result-limit.ts";
import { emptyUsage, type ModelMessage } from "../../src/model/types.ts";

test("pending and committed messages can cross the aging gate differently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-aging-gate-"));
    try {
        const output = "src/chart.ts:12:buried chest\n".repeat(180);
        const path = join(directory, "grep.txt");
        await writeFile(path, output);
        const entries = agedEntries("grep", output, path);
        for (let index = 0; index < 1_000; index += 1) {
            entries.push(user(`turn ${index}`), assistant(`charted ${index}`), {
                message: {
                    role: "tool_result",
                    toolCallId: `synthetic-${index}`,
                    toolName: "read",
                    content: [{ type: "text", text: "small result" }],
                    isError: false,
                },
            });
        }
        let pending = user("x");
        let history = entries.map((entry) => entry.message);
        for (let adjustment = 0; adjustment < 4; adjustment += 1) {
            pending = user("x".repeat(adjustment + 1));
            if (measureMessages(history) + measureMessages([pending.message])
                === measureMessages([...history, pending.message]) + 1) break;
        }
        if (measureMessages(history) + measureMessages([pending.message])
            !== measureMessages([...history, pending.message]) + 1) {
            entries.push(user("x"));
            history = entries.map((entry) => entry.message);
            pending = user("x");
        }
        expect(measureMessages(history) + measureMessages([pending.message]))
            .toBe(measureMessages([...history, pending.message]) + 1);
        const fixedOverhead = 60_000
            - measureMessages(history)
            - measureMessages([pending.message]);
        expect(fixedOverhead).toBeGreaterThan(0);
        const cache = new ToolResultDigestCache();
        const beforePolicy = {
            capacity: 100_000,
            level: "normal" as const,
            ageAfterTurns: 1,
            budgetBytes: 2_000_000,
            overheadTokens: fixedOverhead + measureMessages([pending.message]),
            pendingUserTurns: 1,
        };
        const before = assembleAgedToolResults(entries, beforePolicy, cache);
        expect(before).toEqual(assembleAgedToolResults(entries, beforePolicy, null));
        expect(resultTexts(before)[0]).toContain("Digest of older grep");

        const committed = [...entries, pending];
        const afterPolicy = {
            capacity: 100_000,
            level: "normal" as const,
            ageAfterTurns: 1,
            budgetBytes: 2_000_000,
            overheadTokens: fixedOverhead,
        };
        const after = assembleAgedToolResults(committed, afterPolicy, cache);
        expect(after).toEqual(assembleAgedToolResults(committed, afterPolicy, null));
        expect(resultTexts(after)[0]).toBe(output);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("cached assembly matches fresh assembly as spills and history change", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-tool-cache-"));
    try {
        const sources = [
            ["grep", "grep", "src/map.ts:12:buried chest\n".repeat(180)],
            ["extension", "extension_dump", "extension output\n".repeat(200)],
            ["read", "read", "12\tburied chest\n".repeat(200)],
            ["recent", "bash", "recent output\n".repeat(250)],
        ] as const;
        const entries: { readonly message: ModelMessage }[] = [user("first")];
        for (const [id, tool, output] of sources.slice(0, 3)) {
            const path = join(directory, `${id}.txt`);
            await writeFile(path, output);
            entries.push(call(id, tool), spilled(id, tool, output, path));
        }
        entries.push(
            assistant("Used src/map.ts:12 and the `buried chest` line."),
            user("second"),
            assistant("The chest is on the map."),
            user("third"),
        );
        const [id, tool, output] = sources[3];
        const recentPath = join(directory, `${id}.txt`);
        await writeFile(recentPath, output);
        entries.push(call(id, tool), spilled(id, tool, output, recentPath));

        const cache = new ToolResultDigestCache();
        const lookup = spyOn(cache, "get");
        const policy = { capacity: 1, ageAfterTurns: 2, budgetBytes: 128_000 };
        const compare = (settings: ToolResultAgingPolicy = policy) => {
            const uncached = JSON.stringify(assembleAgedToolResults(entries, settings, null));
            const cached = JSON.stringify(assembleAgedToolResults(entries, settings, cache));
            expect(cached).toBe(uncached);
            return resultTexts(assembleAgedToolResults(entries, settings, cache));
        };

        const results = compare();
        expect(results[0]).toContain("Digest of older grep");
        expect(results[1]).toContain("Stub for older extension_dump");
        expect(results[2]).toContain("Digest of older read");
        expect(results[3]).toBe(output);
        expect(lookup.mock.results.some((result) => result.value !== undefined)).toBe(true);

        const gatePolicy = {
            ...policy,
            level: "normal" as const,
            capacity: 100_000,
            budgetBytes: 1,
            overheadTokens: 60_000 - measureMessages(entries.map((entry) => entry.message)),
        };
        const originalTexts = sources.map((source) => source[2]);
        expect(gatePolicy.overheadTokens).toBeGreaterThan(0);
        expect(compare({ ...gatePolicy, overheadTokens: gatePolicy.overheadTokens - 1 }))
            .toEqual(originalTexts);

        const atGate = compare(gatePolicy);
        expect(atGate[0]).toContain("Digest of older grep");
        expect(atGate[1]).toContain("Stub for older extension_dump");
        expect(atGate[2]).toContain("Digest of older read");
        expect(atGate[3]).toBe(output);
        expect(compare({ ...gatePolicy, overheadTokens: gatePolicy.overheadTokens + 1 }))
            .toEqual(atGate);
        expect(compare({ ...gatePolicy, ageAfterTurns: 3 })).toEqual(originalTexts);
        expect(compare({ ...gatePolicy, pendingUserTurns: 2 })[3])
            .toContain("Digest of older bash");
        expect(compare({ ...gatePolicy, ageAfterTurns: 0 })[3])
            .toContain("Digest of older bash");
        expect(compare({ ...gatePolicy, overheadTokens: gatePolicy.overheadTokens - 1 }))
            .toEqual(originalTexts);

        const grepPath = join(directory, "grep.txt");
        const before = await stat(grepPath);
        await writeFile(grepPath, sources[0][2].replaceAll("chest", "coast"));
        await utimes(grepPath, before.atime, before.mtime);
        expect(compare()[0]).toContain("coast");

        entries.splice(7, 0, assistant("The map says `coast`."));
        compare();
        await rm(grepPath);
        await rm(join(directory, "extension.txt"));
        expect(compare()[0]).toBe(sources[0][2]);
        expect(compare({ ...policy, budgetBytes: 1 })[1])
            .toContain("no re-readable spill is available");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("cached digests follow changes to the call and result metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-tool-cache-input-"));
    try {
        const source = "buried chest\n".repeat(400);
        const path = join(directory, "bash.txt");
        await writeFile(path, source);
        const entries = agedEntries("bash", source, path);
        const cache = new ToolResultDigestCache();
        const compare = () => {
            const fresh = assembleAgedToolResults(entries, PRESSURED, null);
            const cached = assembleAgedToolResults(entries, PRESSURED, cache);
            expect(JSON.stringify(cached)).toBe(JSON.stringify(fresh));
            return resultTexts(cached)[0]!;
        };
        expect(compare()).toContain("Command: echo hi");
        expect(compare()).toContain("Command: echo hi");
        entries[1] = callWithInput("call-1", "bash", { command: "echo ahoy" });
        expect(compare()).toContain("Command: echo ahoy");
        const message = entries[2]!.message;
        if (message.role !== "tool_result") throw new Error("Expected tool result");
        entries[2] = { message: { ...message, isError: true } };
        expect(compare()).toContain("Exit: non-zero");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("the digest cache skips oversized entries and evicts least recently used entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-tool-cache-limit-"));
    try {
        const source = "src/map.ts:12:buried chest\n".repeat(180);
        const path = join(directory, "grep.txt");
        await writeFile(path, source);
        const entries = agedEntries("grep", source, path);
        const cache = new ToolResultDigestCache(1);
        const lookup = spyOn(cache, "get");
        assembleAgedToolResults(entries, PRESSURED, cache);
        assembleAgedToolResults(entries, PRESSURED, cache);
        expect(lookup.mock.calls.length).toBeGreaterThan(1);
        expect(lookup.mock.results.every((result) => result.value === undefined)).toBe(true);

        const otherPath = join(directory, "other.txt");
        await writeFile(otherPath, source);
        const other = agedEntries("grep", source, otherPath);
        const bounded = new ToolResultDigestCache(16_000);
        const boundedLookup = spyOn(bounded, "get");
        assembleAgedToolResults(entries, PRESSURED, bounded);
        assembleAgedToolResults(entries, PRESSURED, bounded);
        assembleAgedToolResults(other, PRESSURED, bounded);
        assembleAgedToolResults(entries, PRESSURED, bounded);
        expect(boundedLookup.mock.results.map((result) => result.value !== undefined))
            .toEqual([false, true, false, false]);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

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
                PRESSURED,
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
            PRESSURED,
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
        const entries = agedEntries("grep", original, spillPath);
        entries.splice(
            entries.length - 1,
            0,
            assistant("I used src/a.ts:12, needleIdentifier, and the \"needle\" line."),
        );
        const result = assembleAgedToolResults(entries, PRESSURED)
            .find((message) => message.role === "tool_result");

        expect(result?.role === "tool_result" && result.content[0]?.text)
            .toContain("Provenance retained");
        expect(result?.role === "tool_result" && result.content[0]?.text)
            .toContain("src/a.ts:12:needle");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("an aged digest keeps the same bytes as later turns arrive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-tool-provenance-"));
    try {
        const spillPath = join(directory, "grep.txt");
        const original = "src/map.ts:12:buried chest\nsrc/map.ts:20:parrot perch";
        await writeFile(spillPath, original, "utf8");
        const entries = agedEntries("grep", original, spillPath);
        const before = resultTexts(assembleAgedToolResults(entries, PRESSURED));
        const after = resultTexts(assembleAgedToolResults([
            ...entries,
            assistant("Dig at src/map.ts:20 under the parrot perch."),
            user("third"),
        ], PRESSURED));

        expect(before[0]).toContain("[vera]");
        expect(after[0]).toBe(before[0]);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("a missing spill preserves the durable result instead of a dead pointer", () => {
    const original = "x".repeat(3_000);
    const result = assembleAgedToolResults(
        agedEntries("extension_dump", original, "/missing/spill"),
        PRESSURED,
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
            PRESSURED,
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
            PRESSURED,
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
        { ...PRESSURED, ageAfterTurns: TOOL_RESULT_STUB_AFTER_TURNS },
    );
    const result = projected.find((message) => message.role === "tool_result");
    expect(result?.role === "tool_result" && result.content[0]?.text)
        .toBe(original.padEnd(3_000, "\n"));
});

test("several legal results in one turn are bounded once the turn has ended", async () => {
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

        const projected = assembleAgedToolResults(
            [...entries, assistant("done"), user("next")],
            { ageAfterTurns: 1 },
        );
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

    const projected = assembleAgedToolResults(
        [...entries, assistant("done"), user("next")],
        PRESSURED,
    );
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

    const text = assembleAgedToolResults(
        [...entries, assistant("done"), user("next")],
        PRESSURED,
    )
        .filter((message) => message.role === "tool_result")
        .map((message) => message.content[0]?.text ?? "")
        .join("\n");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
        TOOL_RESULT_TOTAL_BUDGET_BYTES,
    );
    expect(text).not.toContain("Full output remains available");
    expect(text).toContain("no re-readable spill");
});

test("nothing ages while the context sits under the level's gate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-tool-gate-"));
    try {
        const original = "x".repeat(3_000);
        const spillPath = join(directory, "bash.txt");
        await writeFile(spillPath, original, "utf8");
        const result = assembleAgedToolResults(
            agedEntries("bash", original, spillPath),
            { ageAfterTurns: 1, capacity: 200_000 },
        ).find((message) => message.role === "tool_result");

        expect(result?.role === "tool_result" && result.content[0]?.text)
            .toBe(original);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("over the gate, bash ages before read, in whole steps", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-tool-order-"));
    try {
        const entries = pair(directory, [
            ["call-read", "read", "1\tline\n".repeat(400)],
            ["call-bash-1", "bash", "output\n".repeat(400)],
            ["call-bash-2", "bash", "output\n".repeat(400)],
        ]);
        // Each result is ~700 tokens. The trim target rounds up to the next
        // step (10% of the window), so one digest is not enough here.
        const texts = resultTexts(assembleAgedToolResults(await entries, {
            ageAfterTurns: 1,
            level: "normal",
            capacity: 1_600 / 0.6,
        }));

        expect(texts[0]).toBe("1\tline\n".repeat(400));
        expect(texts[1]).toContain("Digest of older bash");
        expect(texts[2]).toContain("Digest of older bash");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("a long turn of reads keeps current-turn results verbatim", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-tool-live-read-"));
    try {
        const entries = await pair(directory, [
            ["call-old", "grep", "src/a.ts:1:needle\n".repeat(3_000)],
        ]);
        for (let index = 0; index < 4; index += 1) {
            const id = `call-read-${index}`;
            const output = "1\tline\n".repeat(10_000);
            const spillPath = join(directory, `${id}.txt`);
            await writeFile(spillPath, output, "utf8");
            entries.push(
                call(id, "read"),
                spilled(id, "read", output, spillPath),
            );
        }
        const texts = resultTexts(
            assembleAgedToolResults(entries, PRESSURED),
        );

        expect(texts[0]).toContain("Digest of older grep");
        for (let index = 1; index < texts.length; index += 1) {
            expect(texts[index]).toBe("1\tline\n".repeat(10_000));
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("under the gate, the budget leaves an over-budget request alone", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-tool-budget-gate-"));
    try {
        const entries = await pair(directory, [
            ["call-1", "bash", "output\n".repeat(20_000)],
            ["call-2", "bash", "output\n".repeat(20_000)],
        ]);
        const texts = resultTexts(assembleAgedToolResults(entries, {
            ageAfterTurns: 1,
            capacity: 1_000_000,
        }));

        expect(texts[0]).toBe("output\n".repeat(20_000));
        expect(texts[1]).toBe("output\n".repeat(20_000));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("the budget stubs the oldest result before touching a fresh read", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-tool-budget-age-"));
    try {
        const entries: { readonly message: ModelMessage }[] = [user("first")];
        for (let index = 0; index < 3; index += 1) {
            const id = `call-small-${index}`;
            entries.push(call(id, "bash"), {
                message: {
                    role: "tool_result",
                    toolCallId: id,
                    toolName: "bash",
                    content: [{ type: "text", text: "x".repeat(1_024) }],
                    isError: false,
                },
            });
        }
        entries.push(assistant("done"), user("second"));
        const read = "1\tline\n".repeat(720);
        const spillPath = join(directory, "read.txt");
        await writeFile(spillPath, read, "utf8");
        entries.push(
            call("call-read", "read"),
            spilled("call-read", "read", read, spillPath),
        );
        const texts = resultTexts(assembleAgedToolResults(entries, {
            ...PRESSURED,
            budgetBytes: 7_600,
        }));

        // The 1,900-byte step (25% of the budget) rounds the target up, so all
        // three small bash results are stubbed before the read is touched.
        expect(texts[0]).toContain("Stub for older bash");
        expect(texts[1]).toContain("Stub for older bash");
        expect(texts[2]).toContain("Stub for older bash");
        expect(texts.at(-1)).toBe(read);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("@core gate trimming holds still while pressure stays inside one step", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-tool-step-gate-"));
    try {
        const output = "output\n".repeat(400);
        const entries = await pair(directory, eightBashResults(output));
        const raw = measureMessages(entries.map((entry) => entry.message));
        const gate = 10_000 * 0.6;
        const trimmedAt = (excess: number) => resultTexts(
            assembleAgedToolResults(entries, {
                ageAfterTurns: 1,
                level: "normal",
                capacity: 10_000,
                overheadTokens: gate + excess - raw,
            }),
        );

        // Step is 1,000 tokens (10% of 10,000). Both excesses round up to the
        // same 2,000-token target, though one digest alone covers the first.
        expect(trimmedAt(1_001)).toEqual(trimmedAt(1_999));
        expect(digestCount(trimmedAt(3_500))).toBeGreaterThan(
            digestCount(trimmedAt(1_500)),
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("@core budget trimming holds still while the excess stays inside one step", () => {
    const sized = (lengths: readonly number[]) => {
        const entries: { readonly message: ModelMessage }[] = [user("first")];
        lengths.forEach((length, index) => {
            const id = `call-${index}`;
            entries.push(call(id, "bash"), {
                message: {
                    role: "tool_result",
                    toolCallId: id,
                    toolName: "bash",
                    content: [{ type: "text", text: "x".repeat(length) }],
                    isError: false,
                },
            });
        });
        entries.push(assistant("done"), user("second"));
        return entries;
    };
    const stubsAt = (lengths: readonly number[]) => resultTexts(
        assembleAgedToolResults(sized(lengths), {
            ...PRESSURED,
            budgetBytes: 4_000,
        }),
    ).map((text) => text.startsWith("[vera] Stub"));

    // Step is 1,000 bytes (25% of 4,000). Excesses of 860 and 900 share the
    // step, so both stub two results; a single stub would cover only 860.
    const excess860 = stubsAt([1_024, 1_024, 1_024, 1_024, 764]);
    const excess900 = stubsAt([1_024, 1_024, 1_024, 1_024, 804]);
    expect(excess900).toEqual(excess860);
    expect(excess860.filter(Boolean).length).toBe(2);
});

function eightBashResults(output: string): [string, string, string][] {
    return Array.from({ length: 8 }, (_, index): [string, string, string] => [
        `call-${index}`,
        "bash",
        output,
    ]);
}

function digestCount(texts: readonly string[]): number {
    return texts.filter((text) => text.includes("Digest of older")).length;
}

test("relaxed never ages a read, even with nothing else left to give", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-tool-relaxed-"));
    try {
        const entries = pair(directory, [
            ["call-read", "read", "1\tline\n".repeat(400)],
        ]);
        const relaxed = resultTexts(assembleAgedToolResults(await entries, {
            ageAfterTurns: 1,
            level: "relaxed",
            capacity: 1,
        }));
        const normal = resultTexts(assembleAgedToolResults(await entries, {
            ageAfterTurns: 1,
            level: "normal",
            capacity: 1,
        }));

        expect(relaxed[0]).toBe("1\tline\n".repeat(400));
        expect(normal[0]).toContain("Digest of older read");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("a re-read of a spill file stays verbatim at any pressure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-tool-reread-"));
    try {
        const spillDir = join(directory, "scratch", "tool-results");
        const original = "1\tline\n".repeat(400);
        const entries = [
            user("first"),
            callWithInput("call-read", "read", {
                path: join(spillDir, "read-1.txt"),
            }),
            spilled("call-read", "read", original, join(directory, "a.txt")),
            callWithInput("call-bash", "bash", {
                command: `awk 'NR>=1' ${join(spillDir, "read-1.txt")}`,
            }),
            spilled("call-bash", "bash", original, join(directory, "b.txt")),
            assistant("done"),
            user("second"),
        ];
        for (const entry of entries) {
            const message = entry.message;
            if (message.role === "tool_result") {
                await writeFile(
                    message.toolResultSource?.spillPath ?? "",
                    original,
                    "utf8",
                );
            }
        }
        const texts = resultTexts(assembleAgedToolResults(entries, {
            ...PRESSURED,
            spillDirectory: spillDir,
        }));
        const unanchored = resultTexts(assembleAgedToolResults(entries, PRESSURED));

        expect(texts).toEqual([original, original]);
        expect(unanchored[0]).toContain("Digest of older read");
        expect(unanchored[1]).toContain("Digest of older bash");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("a digest that would be larger than the excerpt is not swapped in", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-tool-grow-"));
    try {
        const identifiers = Array.from({ length: 40 }, (_, i) => `needleIdent${i}`);
        const original = identifiers
            .map((name, i) => `src/file-${i}.ts:${i + 1}:${name} ${"pad".repeat(30)}`)
            .join("\n");
        const excerpt = original.slice(0, 2_100);
        const spillPath = join(directory, "grep.txt");
        await writeFile(spillPath, original, "utf8");
        const entries = [
            user("first"),
            call("call-1", "grep"),
            {
                message: {
                    role: "tool_result" as const,
                    toolCallId: "call-1",
                    toolName: "grep",
                    content: [{ type: "text" as const, text: excerpt }],
                    isError: false,
                    toolResultSource: {
                        originalBytes: Buffer.byteLength(original, "utf8"),
                        spillPath,
                    },
                },
            },
            assistant(`I used ${identifiers.join(", ")}.`),
            user("second"),
        ];
        const texts = resultTexts(assembleAgedToolResults(entries, PRESSURED));

        expect(texts[0]).toBe(excerpt);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("the aging level follows the context cap", () => {
    expect(toolResultAgingLevel(1_000_000)).toBe("relaxed");
    expect(toolResultAgingLevel(400_000)).toBe("relaxed");
    expect(toolResultAgingLevel(204_800)).toBe("normal");
    expect(toolResultAgingLevel(undefined)).toBe("normal");
    expect(toolResultAgingLevel(64_000)).toBe("tight");
});

test("a pending user turn advances tool-result aging", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-tool-pending-turn-"));
    try {
        const output = "line\n".repeat(5_000);
        const spillPath = join(directory, "result.txt");
        await writeFile(spillPath, output, "utf8");
        const entries = agedEntries("bash", output, spillPath).slice(0, 3);

        expect(resultTexts(assembleAgedToolResults(entries, PRESSURED))[0])
            .toBe(output);
        expect(resultTexts(assembleAgedToolResults(entries, {
            ...PRESSURED,
            pendingUserTurns: 1,
        }))[0]).not.toBe(output);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

/** Any level's gate is crossed at once, so age lines alone decide. */
const PRESSURED = { ageAfterTurns: 1, capacity: 1 } as const;

function resultTexts(messages: readonly ModelMessage[]): string[] {
    return messages
        .filter((message) => message.role === "tool_result")
        .map((message) =>
            message.role === "tool_result" ? message.content[0]?.text ?? "" : ""
        );
}

async function pair(
    directory: string,
    results: readonly [string, string, string][],
): Promise<{ readonly message: ModelMessage }[]> {
    const entries: { readonly message: ModelMessage }[] = [user("first")];
    for (const [id, tool, output] of results) {
        const spillPath = join(directory, `${id}.txt`);
        await writeFile(spillPath, output, "utf8");
        entries.push(call(id, tool), spilled(id, tool, output, spillPath));
    }
    entries.push(assistant("done"), user("second"));
    return entries;
}

function spilled(
    id: string,
    tool: string,
    output: string,
    spillPath: string,
): { readonly message: ModelMessage } {
    return {
        message: {
            role: "tool_result",
            toolCallId: id,
            toolName: tool,
            content: [{ type: "text", text: output }],
            isError: false,
            toolResultSource: {
                originalBytes: Math.max(3_000, Buffer.byteLength(output, "utf8")),
                spillPath,
            },
        },
    };
}

function callWithInput(
    id: string,
    name: string,
    input: Record<string, unknown>,
): { readonly message: ModelMessage } {
    return {
        message: {
            role: "assistant",
            content: [{ type: "tool_call", id, name, input }],
            source: { provider: "test", api: "test", model: "test" },
            usage: emptyUsage(),
            stopReason: "tool_use",
        },
    };
}

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
                // Results under the verbatim floor never carry a source, so
                // an aged entry's in-context text is at least floor-sized.
                content: [{ type: "text", text: output.padEnd(3_000, "\n") }],
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

test("the total tool-result budget follows the window and keeps the flat value when unknown", () => {
    expect(toolResultTotalBudgetBytes(undefined)).toBe(TOOL_RESULT_TOTAL_BUDGET_BYTES);
    expect(toolResultTotalBudgetBytes(0)).toBe(TOOL_RESULT_TOTAL_BUDGET_BYTES);
    expect(toolResultTotalBudgetBytes(131_072)).toBe(128 * 1024);
    expect(toolResultTotalBudgetBytes(8_192)).toBe(TOOL_RESULT_TOTAL_BUDGET_FLOOR_BYTES);
    expect(toolResultTotalBudgetBytes(262_144)).toBe(256 * 1024);
    expect(toolResultTotalBudgetBytes(10_000_000)).toBe(TOOL_RESULT_TOTAL_BUDGET_MAX_BYTES);
});

test("the per-result ceiling never exceeds the scaled budget by default", () => {
    for (const capacity of [4_096, 8_192, 32_768, 65_536, 131_072, 400_000, 1_000_000]) {
        expect(toolResultCeilingBytes(capacity))
            .toBeLessThanOrEqual(toolResultTotalBudgetBytes(capacity));
    }
});
