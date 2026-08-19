import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    searchSessions,
    snippetAround,
} from "../../src/store/session-search.ts";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

function root(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-search-"));
    roots.push(directory);
    return directory;
}

interface SessionSpec {
    readonly id: string;
    readonly cwd?: string;
    readonly name?: string;
    readonly entries?: readonly Record<string, unknown>[];
    /** Seconds of age, so newest-first ordering is deterministic. */
    readonly age?: number;
}

function writeSession(directory: string, spec: SessionSpec): string {
    const path = join(directory, `${spec.id}.jsonl`);
    const lines: string[] = [JSON.stringify({
        type: "session",
        version: 1,
        id: spec.id,
        timestamp: "2026-08-01T00:00:00.000Z",
        cwd: spec.cwd ?? "/work/one",
    })];
    if (spec.name !== undefined) {
        lines.push(JSON.stringify({ type: "session_name", name: spec.name }));
    }
    for (const entry of spec.entries ?? []) lines.push(JSON.stringify(entry));
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
    if (spec.age !== undefined) {
        const when = new Date(Date.now() - spec.age * 1_000);
        utimesSync(path, when, when);
    }
    return path;
}

function message(
    id: string,
    role: "user" | "assistant",
    content: readonly Record<string, unknown>[],
    extra: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        type: "message",
        id,
        parentId: null,
        timestamp: "2026-08-01T00:00:00.000Z",
        message: { role, content, ...extra },
    };
}

function text(value: string): Record<string, unknown> {
    return { type: "text", text: value };
}

test("an empty query finds nothing rather than everything", async () => {
    const directory = root();
    writeSession(directory, {
        id: "one",
        entries: [message("m1", "user", [text("provider fallback")])],
    });

    expect(await searchSessions(directory, { query: "   " }))
        .toEqual({ results: [], truncated: false });
});

test("results group by session with the hit kind on each snippet", async () => {
    const directory = root();
    writeSession(directory, {
        id: "one",
        name: "relay-gui",
        age: 10,
        entries: [
            message("m1", "user", [
                text("if the provider fallback kicks in, does the sidebar move"),
            ]),
            message("m2", "assistant", [
                text("the fallback ladder degrades in place"),
                {
                    type: "tool_call",
                    id: "t1",
                    name: "bash",
                    input: { command: "bun test tests/unit/fallback" },
                },
            ]),
        ],
    });
    writeSession(directory, {
        id: "two",
        name: "memory-retrieval",
        age: 100,
        entries: [
            message("m3", "assistant", [{
                type: "tool_call",
                id: "t2",
                name: "edit",
                input: { file_path: "src/extensions/fallback/ladder.ts" },
            }]),
        ],
    });

    const found = await searchSessions(directory, { query: "fallback" });

    expect(found.results.map((result) => result.title))
        .toEqual(["relay-gui", "memory-retrieval"]);
    expect(found.results[0]?.hits.map((hit) => hit.kind))
        .toEqual(["user_message", "agent_message", "tool_command"]);
    expect(found.results[0]?.hits[2]?.snippet)
        .toBe("bash bun test tests/unit/fallback");
    expect(found.results[1]?.hits[0]?.kind).toBe("file_edit");
    expect(found.results[1]?.hits[0]?.snippet)
        .toBe("src/extensions/fallback/ladder.ts");
});

test("every hit carries the transcript entry the session opens at", async () => {
    const directory = root();
    writeSession(directory, {
        id: "one",
        entries: [message("entry-7", "user", [text("provider fallback")])],
    });

    const found = await searchSessions(directory, { query: "fallback" });
    expect(found.results[0]?.hits[0]?.entry_id).toBe("entry-7");
});

test("the filter narrows to one kind of hit", async () => {
    const directory = root();
    writeSession(directory, {
        id: "one",
        entries: [
            message("m1", "user", [text("fallback question")]),
            message("m2", "assistant", [
                {
                    type: "tool_call",
                    id: "t1",
                    name: "bash",
                    input: { command: "run fallback" },
                },
                {
                    type: "tool_call",
                    id: "t2",
                    name: "edit",
                    input: { file_path: "src/fallback.ts" },
                },
            ]),
        ],
    });

    const kinds = async (kind: "messages" | "tools" | "files") =>
        (await searchSessions(directory, { query: "fallback", kind }))
            .results.flatMap((result) => result.hits.map((hit) => hit.kind));

    expect(await kinds("messages")).toEqual(["user_message"]);
    expect(await kinds("tools")).toEqual(["tool_command"]);
    expect(await kinds("files")).toEqual(["file_edit"]);
});

test("the workspace scope narrows to one directory", async () => {
    const directory = root();
    writeSession(directory, {
        id: "here",
        cwd: "/work/one",
        entries: [message("m1", "user", [text("fallback")])],
    });
    writeSession(directory, {
        id: "there",
        cwd: "/work/two",
        entries: [message("m2", "user", [text("fallback")])],
    });

    expect((await searchSessions(directory, { query: "fallback" }))
        .results.map((result) => result.session_id).sort())
        .toEqual(["here", "there"]);
    expect((await searchSessions(directory, {
        query: "fallback",
        workspace: "/work/one",
    })).results.map((result) => result.session_id)).toEqual(["here"]);
});

test("internal messages are not searchable text", async () => {
    const directory = root();
    writeSession(directory, {
        id: "one",
        entries: [
            message("m1", "user", [text("hidden fallback note")], {
                internal: true,
            }),
        ],
    });

    expect((await searchSessions(directory, { query: "fallback" })).results)
        .toEqual([]);
});

test("matching is case insensitive", async () => {
    const directory = root();
    writeSession(directory, {
        id: "one",
        entries: [message("m1", "user", [text("Provider FALLBACK ladder")])],
    });

    expect((await searchSessions(directory, { query: "provider fallback" }))
        .results).toHaveLength(1);
});

test("the hits per session are bounded", async () => {
    const directory = root();
    writeSession(directory, {
        id: "one",
        entries: Array.from({ length: 20 }, (_, index) =>
            message(`m${index}`, "user", [text(`fallback ${index}`)])),
    });

    const found = await searchSessions(directory, { query: "fallback" }, {
        maxHitsPerSession: 2,
    });
    expect(found.results[0]?.hits).toHaveLength(2);
});

test("the result count is bounded and says so", async () => {
    const directory = root();
    for (let index = 0; index < 5; index += 1) {
        writeSession(directory, {
            id: `s${index}`,
            age: index,
            entries: [message("m1", "user", [text("fallback")])],
        });
    }

    const found = await searchSessions(directory, { query: "fallback" }, {
        maxResults: 2,
    });
    expect(found.results).toHaveLength(2);
    expect(found.truncated).toBe(true);
    // Newest first, so the bound drops the oldest rather than an arbitrary two.
    expect(found.results.map((result) => result.session_id))
        .toEqual(["s0", "s1"]);
});

test("a malformed line is skipped without losing the transcript", async () => {
    const directory = root();
    const path = join(directory, "one.jsonl");
    writeFileSync(path, [
        JSON.stringify({
            type: "session",
            version: 1,
            id: "one",
            timestamp: "2026-08-01T00:00:00.000Z",
            cwd: "/work/one",
        }),
        "{ this is not json",
        "",
        JSON.stringify(message("m1", "user", [text("provider fallback")])),
        // A half-written trailing line, which is normal mid-append.
        '{"type":"message","id":"m2"',
    ].join("\n"), "utf8");

    const found = await searchSessions(directory, { query: "fallback" });
    expect(found.results[0]?.hits).toHaveLength(1);
});

test("a directory that is not there searches to nothing", async () => {
    expect(await searchSessions(join(root(), "absent"), { query: "x" }))
        .toEqual({ results: [], truncated: false });
});

test("a session with no header is not a result", async () => {
    const directory = root();
    writeFileSync(
        join(directory, "one.jsonl"),
        `${JSON.stringify(message("m1", "user", [text("fallback")]))}\n`,
        "utf8",
    );

    expect((await searchSessions(directory, { query: "fallback" })).results)
        .toEqual([]);
});

test("a snippet is centred on the match and marks what it cut", () => {
    expect(snippetAround("short and sweet", "sweet")).toBe("short and sweet");
    expect(snippetAround("nothing here", "absent")).toBeUndefined();

    const long = `${"lead ".repeat(40)}needle${" tail".repeat(40)}`;
    const snippet = snippetAround(long, "needle") ?? "";
    expect(snippet).toContain("needle");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(98);
});

test("whitespace in a snippet is collapsed to one line", () => {
    expect(snippetAround("one\n  two\tthree", "two")).toBe("one two three");
});
