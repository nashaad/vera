import { expect, test } from "bun:test";

import { parseImportSource } from "../../src/session-import/index.ts";

type Record = { readonly [key: string]: unknown };

let clock = 0;

function entry(
    uuid: string,
    parentUuid: string | null,
    type: "user" | "assistant",
    content: unknown,
    extra: Record = {},
): Record {
    clock += 1;
    return {
        type,
        uuid,
        parentUuid,
        sessionId: "cc-session",
        cwd: "/work/project",
        timestamp: `2026-09-01T10:00:${String(clock).padStart(2, "0")}.000Z`,
        isSidechain: false,
        message: { role: type, content },
        ...extra,
    };
}

function file(records: readonly Record[]): string {
    return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

test("a plain exchange keeps its text and source facts", () => {
    clock = 0;
    const parsed = parseImportSource(file([
        { type: "custom-title", customTitle: "Fix the build", sessionId: "cc-session" },
        entry("u1", null, "user", "fix the build"),
        entry("a1", "u1", "assistant", [{ type: "text", text: "Looking now." }]),
    ]));
    expect(parsed.tool).toBe("claude-code");
    expect(parsed.sourceSessionId).toBe("cc-session");
    expect(parsed.cwd).toBe("/work/project");
    expect(parsed.startedAt).toBe("2026-09-01T10:00:01.000Z");
    expect(parsed.title).toBe("Fix the build");
    expect(parsed.messages).toEqual([
        { role: "user", text: "fix the build", timestamp: "2026-09-01T10:00:01.000Z" },
        { role: "assistant", text: "Looking now.", timestamp: "2026-09-01T10:00:02.000Z" },
    ]);
});

test("tool calls and results flatten into the assistant message", () => {
    clock = 0;
    const parsed = parseImportSource(file([
        entry("u1", null, "user", "read it"),
        entry("a1", "u1", "assistant", [
            { type: "thinking", thinking: "secret", signature: "sig" },
            { type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/a.ts" } },
        ]),
        entry("r1", "a1", "user", [
            { type: "tool_result", tool_use_id: "t1", content: "const a = 1;" },
        ]),
        entry("a2", "r1", "assistant", [
            { type: "tool_use", id: "t2", name: "Bash", input: { command: "false" } },
        ]),
        entry("r2", "a2", "user", [
            {
                type: "tool_result",
                tool_use_id: "t2",
                is_error: true,
                content: [{ type: "text", text: "exit 1" }],
            },
        ]),
        entry("a3", "r2", "assistant", [{ type: "text", text: "Done." }]),
    ]));
    expect(parsed.messages.map((message) => message.text)).toEqual([
        "read it",
        [
            "[tool] Read src/a.ts",
            "const a = 1;",
            "[tool] Bash false",
            "[tool error] exit 1",
            "Done.",
        ].join("\n\n"),
    ]);
    expect(JSON.stringify(parsed)).not.toContain("secret");
});

test("harness-injected user records are dropped", () => {
    clock = 0;
    const parsed = parseImportSource(file([
        entry("m1", null, "user", "meta context", { isMeta: true }),
        entry("u0", "m1", "user", "<command-name>/model</command-name>"),
        entry("u1", "u0", "user", [
            { type: "text", text: "<system-reminder>hidden</system-reminder>real question" },
            { type: "image", source: { type: "base64", data: "AAAA" } },
        ]),
        entry("a1", "u1", "assistant", [{ type: "text", text: "answer" }]),
        entry("u2", "a1", "user", "[Request interrupted by user]"),
        entry("u3", "u2", "user", "<local-command-stdout>ok</local-command-stdout>"),
        entry("u4", "u3", "user", "<task-notification>done</task-notification>"),
        entry("u5", "u4", "user", "A note\n<cross-session-message from=\"x\">hi</cross-session-message>"),
        entry("u6", "u5", "user", "<bash-input>ls</bash-input>"),
        entry("s1", "u6", "user", "summary of earlier work", { isCompactSummary: true }),
        entry("u7", "s1", "user", "next question"),
    ]));
    expect(parsed.messages.map((message) => [message.role, message.text])).toEqual([
        ["user", "real question\n\n[image]"],
        ["assistant", "answer"],
        ["user", "next question"],
    ]);
});

test("sidechain records are dropped", () => {
    clock = 0;
    const parsed = parseImportSource(file([
        entry("u1", null, "user", "delegate it"),
        entry("a1", "u1", "assistant", [
            { type: "tool_use", id: "t1", name: "Task", input: { description: "look" } },
        ]),
        entry("x1", null, "user", "subagent prompt", { isSidechain: true }),
        entry("x2", "x1", "assistant", [{ type: "text", text: "subagent work" }], { isSidechain: true }),
        entry("r1", "a1", "user", [
            { type: "tool_result", tool_use_id: "t1", content: "subagent answer" },
        ]),
    ]));
    const text = parsed.messages.map((message) => message.text).join("\n");
    expect(text).toContain('[tool] Task {"description":"look"}');
    expect(text).toContain("subagent answer");
    expect(text).not.toContain("subagent work");
    expect(text).not.toContain("subagent prompt");
});

test("only the active branch is imported, across compact boundaries", () => {
    clock = 0;
    const parsed = parseImportSource(file([
        entry("u1", null, "user", "first"),
        entry("a1", "u1", "assistant", [{ type: "text", text: "first answer" }]),
        entry("u2", "a1", "user", "abandoned question"),
        entry("a2", "u2", "assistant", [{ type: "text", text: "abandoned answer" }]),
        entry("u3", "a1", "user", "rewound question"),
        entry("a3", "u3", "assistant", [{ type: "text", text: "kept answer" }]),
        {
            type: "system",
            subtype: "compact_boundary",
            uuid: "b1",
            parentUuid: null,
            logicalParentUuid: "a3",
            timestamp: "2026-09-01T11:00:00.000Z",
        },
        entry("s1", "b1", "user", "compaction summary", { isCompactSummary: true }),
        entry("u4", "s1", "user", "after compaction"),
    ]));
    expect(parsed.messages.map((message) => message.text)).toEqual([
        "first",
        "first answer",
        "rewound question",
        "kept answer",
        "after compaction",
    ]);
});

test("a boundary whose logical parent loops forward resumes before the boundary", () => {
    clock = 0;
    const parsed = parseImportSource(file([
        entry("u1", null, "user", "before"),
        entry("a1", "u1", "assistant", [{ type: "text", text: "before answer" }]),
        {
            type: "system",
            subtype: "compact_boundary",
            uuid: "b1",
            parentUuid: null,
            logicalParentUuid: "t1",
            timestamp: "2026-09-01T11:00:00.000Z",
        },
        entry("s1", "b1", "user", "compaction summary", { isCompactSummary: true }),
        { type: "attachment", uuid: "t1", parentUuid: "s1", attachment: { type: "file" } },
        entry("u2", "t1", "user", "after"),
    ]));
    expect(parsed.messages.map((message) => message.text)).toEqual([
        "before",
        "before answer",
        "after",
    ]);
});

test("a session with no typed messages is rejected as empty", () => {
    clock = 0;
    expect(() => parseImportSource(file([
        entry("m1", null, "user", "meta", { isMeta: true }),
        entry("a1", "m1", "assistant", [{ type: "text", text: "orphan" }]),
    ]))).toThrow(expect.objectContaining({ reason: "empty" }));
});

test("the ai title is used when there is no custom title", () => {
    clock = 0;
    const parsed = parseImportSource(file([
        entry("u1", null, "user", "hi"),
        { type: "ai-title", aiTitle: "Old", sessionId: "cc-session" },
        { type: "ai-title", aiTitle: "Greeting", sessionId: "cc-session" },
    ]));
    expect(parsed.title).toBe("Greeting");
});
