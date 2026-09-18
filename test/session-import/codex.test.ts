import { expect, test } from "bun:test";

import { parseImportSource } from "../../src/session-import/index.ts";

type Record = { readonly [key: string]: unknown };

let clock = 0;

function line(type: string, payload: Record): Record {
    clock += 1;
    return {
        timestamp: `2026-09-02T09:00:${String(clock).padStart(2, "0")}.000Z`,
        type,
        payload,
    };
}

function meta(): Record {
    return line("session_meta", {
        id: "codex-session",
        cwd: "/work/codex",
        timestamp: "2026-09-02T08:59:59.000Z",
    });
}

function message(role: string, parts: readonly Record[]): Record {
    return line("response_item", { type: "message", role, content: parts });
}

function file(records: readonly Record[]): string {
    return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

test("a plain exchange keeps its text and source facts", () => {
    clock = 0;
    const parsed = parseImportSource(file([
        meta(),
        message("developer", [{ type: "input_text", text: "system rules" }]),
        message("user", [
            { type: "input_text", text: "# AGENTS.md instructions for /work\n\nrules" },
            { type: "input_text", text: "<environment_context>\n<cwd>/work</cwd>\n</environment_context>" },
        ]),
        message("user", [{ type: "input_text", text: "what changed?" }]),
        line("response_item", { type: "reasoning", encrypted_content: "opaque" }),
        message("assistant", [{ type: "output_text", text: "Two files." }]),
    ]));
    expect(parsed.tool).toBe("codex");
    expect(parsed.sourceSessionId).toBe("codex-session");
    expect(parsed.cwd).toBe("/work/codex");
    expect(parsed.startedAt).toBe("2026-09-02T08:59:59.000Z");
    expect(parsed.title).toBeUndefined();
    expect(parsed.messages.map((entry) => [entry.role, entry.text])).toEqual([
        ["user", "what changed?"],
        ["assistant", "Two files."],
    ]);
    expect(JSON.stringify(parsed)).not.toContain("opaque");
});

test("calls and outputs flatten, and a non-zero exit is an error", () => {
    clock = 0;
    const parsed = parseImportSource(file([
        meta(),
        message("user", [{ type: "input_text", text: "run it" }]),
        line("response_item", {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({ cmd: "git status", workdir: "/work" }),
            call_id: "c1",
        }),
        line("response_item", {
            type: "function_call_output",
            call_id: "c1",
            output: "Chunk ID: 1\nWall time: 0.1 seconds\nProcess exited with code 0\nOutput:\nclean",
        }),
        line("response_item", {
            type: "custom_tool_call",
            name: "apply_patch",
            input: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch",
            call_id: "c2",
        }),
        line("response_item", {
            type: "custom_tool_call_output",
            call_id: "c2",
            output: JSON.stringify({ output: "patch rejected", metadata: { exit_code: 1 } }),
        }),
        line("response_item", {
            type: "custom_tool_call_output",
            call_id: "c3",
            output: [
                { type: "input_text", text: "Script completed\nWall time 0.3 seconds\nOutput:\n" },
                { type: "input_text", text: "listing" },
            ],
        }),
        message("assistant", [{ type: "output_text", text: "Patched." }]),
    ]));
    expect(parsed.messages[1]!.text).toBe([
        "[tool] exec_command git status",
        "clean",
        "[tool] apply_patch src/a.ts",
        "[tool error] patch rejected",
        "listing",
        "Patched.",
    ].join("\n\n"));
});

test("images become placeholders and their wrappers are dropped", () => {
    clock = 0;
    const parsed = parseImportSource(file([
        meta(),
        message("user", [
            { type: "input_text", text: "<image name=[Image #1] path=/tmp/a.png>" },
            { type: "input_image", image_url: "data:image/png;base64,AAAA" },
            { type: "input_text", text: "</image>" },
            { type: "input_text", text: "what is this" },
        ]),
    ]));
    expect(parsed.messages).toEqual([
        { role: "user", text: "[image]\n\nwhat is this", timestamp: "2026-09-02T09:00:02.000Z" },
    ]);
});

test("compaction records are dropped", () => {
    clock = 0;
    const parsed = parseImportSource(file([
        meta(),
        message("user", [{ type: "input_text", text: "hello" }]),
        line("compacted", { message: "summary of everything" }),
        message("assistant", [{ type: "output_text", text: "hi" }]),
    ]));
    expect(JSON.stringify(parsed.messages)).not.toContain("summary of everything");
});

test("a session with only injected messages is rejected as empty", () => {
    clock = 0;
    expect(() => parseImportSource(file([
        meta(),
        message("user", [{ type: "input_text", text: "<environment_context></environment_context>" }]),
        message("assistant", [{ type: "output_text", text: "ready" }]),
    ]))).toThrow(expect.objectContaining({ reason: "empty" }));
});

test("an unrelated file is rejected as unrecognized", () => {
    expect(() => parseImportSource('{"hello":"world"}\nnot json\n'))
        .toThrow(expect.objectContaining({ reason: "unrecognized" }));
    expect(() => parseImportSource(""))
        .toThrow(expect.objectContaining({ reason: "unrecognized" }));
});

test("compaction records and events leave the conversation unchanged", () => {
    clock = 0;
    const parsed = parseImportSource(file([
        meta(),
        message("user", [{ type: "input_text", text: "first" }]),
        line("event_msg", { type: "item_completed", item: { text: "echo" } }),
        { ...line("compacted", { replacement_history: [message("user", [{ type: "input_text", text: "stale" }])] }), ordinal: 7 },
        message("assistant", [{ type: "output_text", text: "done" }]),
    ]));
    expect(parsed.messages.map((entry) => [entry.role, entry.text])).toEqual([
        ["user", "first"],
        ["assistant", "done"],
    ]);
});
