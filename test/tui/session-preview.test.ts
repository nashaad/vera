import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";

import { emptyUsage } from "../../src/model/types.ts";
import { projectTranscript } from "../../src/engine/protocol.ts";
import { readSessionSnapshot } from "../../src/store/session-store.ts";
import { wrappedTo } from "../../clients/tui/settings-picker-model.ts";
import {
    createTuiSettingsPickerView,
    handleTuiSettingsPickerKey,
    startTuiSessionPicker,
} from "../../clients/tui/settings-picker.ts";
import {
    readSessionPreview,
    SESSION_PREVIEW_EMPTY,
    sessionPreviewLines,
    sessionPreviewWindow,
    type SessionPreviewDisplayLine,
} from "../../clients/tui/session-preview.ts";

test("a preview keeps the last user and assistant turns", () => {
    expect(sessionPreviewLines([
        { kind: "user", text: "first" },
        { kind: "reasoning", text: "follow the stars" },
        { kind: "tool", tool: "bash", args: {} },
        { kind: "assistant", text: "second" },
    ])).toEqual([
        "You",
        "first",
        "",
        "Vera",
        "second",
    ]);
});

test("a conversation with no messages says so", () => {
    expect(sessionPreviewLines([
        { kind: "tool", tool: "bash", args: {} },
    ])).toEqual([SESSION_PREVIEW_EMPTY]);
});

test("readSessionPreview paints the saved transcript", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-session-preview-"));
    const path = join(directory, "chat.jsonl");
    writeFileSync(path, [
        JSON.stringify({
            type: "session",
            version: 1,
            id: "preview-session",
            timestamp: "2026-09-17T00:00:00.000Z",
            cwd: "/work/vera",
        }),
        JSON.stringify({
            type: "message",
            id: "user-1",
            parentId: null,
            timestamp: "2026-09-17T00:00:00.000Z",
            message: {
                role: "user",
                content: [{ type: "text", text: "whats 2 + 2" }],
            },
        }),
        JSON.stringify({
            type: "message",
            id: "assistant-1",
            parentId: "user-1",
            timestamp: "2026-09-17T00:00:01.000Z",
            message: {
                role: "assistant",
                content: [{ type: "text", text: "4" }],
                source: { provider: "faux", api: "scripted", model: "test" },
                usage: emptyUsage(),
                stopReason: "stop",
            },
        }),
    ].join("\n") + "\n");

    expect(await readSessionPreview(path)).toEqual([
        "You",
        "whats 2 + 2",
        "",
        "Vera",
        "4",
    ]);
});

function previousWindow(
    lines: readonly string[],
    scroll: number,
    rows: number,
    width: number,
): readonly SessionPreviewDisplayLine[] {
    const wrapped = lines.flatMap((line, index) => {
        const previous = lines[index - 1];
        const tone: SessionPreviewDisplayLine["tone"] = line === ""
            ? "blank"
            : (line === "You" || line === "Vera")
                && (previous === undefined || previous === "")
            ? "speaker"
            : "body";
        if (line === "") return [{ tone: "blank" as const, text: "" }];
        const parts = wrappedTo(line, Math.max(1, width));
        return (parts.length === 0 ? [line] : parts).map((text) => ({ tone, text }));
    });
    const start = Math.max(0, Math.min(scroll, Math.max(0, wrapped.length - rows)));
    return wrapped.slice(start, start + Math.max(1, rows));
}

test("cached windows match previous wrapping after line and width changes", () => {
    const lines = Array.from({ length: 6000 }, (_, index) => {
        if (index % 500 === 0) return "You";
        if (index % 500 === 1) return "Vera";
        if (index % 23 === 0) return "";
        return `crow ${index} follows a long chart through calm and stormy seas`;
    });
    const compare = () => {
        for (const width of [1, 17, 60, 0, Number.NaN]) {
            for (const [scroll, rows] of [[0, 8], [55, 2], [5000, 0], [-1, 12]]) {
                expect(sessionPreviewWindow(lines, scroll!, rows!, width))
                    .toEqual(previousWindow(lines, scroll!, rows!, width));
            }
        }
    };
    compare();
    sessionPreviewWindow(lines, 0, 8, 60);
    lines.push("", "Vera", "a new ending");
    expect(sessionPreviewWindow(lines, 0, 8, 60)).toEqual(previousWindow(lines, 0, 8, 60));
    compare();
    sessionPreviewWindow(lines, 0, 8, 60);
    lines[0] = "sailor";
    lines[1] = "You";
    expect(sessionPreviewWindow(lines, 0, 8, 60)).toEqual(previousWindow(lines, 0, 8, 60));
    compare();
    sessionPreviewWindow(lines, 0, 8, 60);
    lines.splice(2, 3);
    expect(sessionPreviewWindow(lines, 0, 8, 60)).toEqual(previousWindow(lines, 0, 8, 60));
    compare();
    sessionPreviewWindow(lines, 0, 8, 60);
    lines.length = 10;
    expect(sessionPreviewWindow(lines, 0, 8, 60)).toEqual(previousWindow(lines, 0, 8, 60));
    compare();

    const returned = sessionPreviewWindow(lines, 0, 2, 60);
    (returned[0] as { text: string }).text = "changed by a caller";
    expect(sessionPreviewWindow(lines, 0, 2, 60)).toEqual(previousWindow(lines, 0, 2, 60));

    const sparse = new Array<string>(4);
    sparse[0] = "You";
    sparse[2] = "Vera";
    expect(sessionPreviewWindow(sparse, 0, 8, 60)).toEqual(previousWindow(sparse, 0, 8, 60));
    sparse[1] = "";
    expect(sessionPreviewWindow(sparse, 0, 8, 60)).toEqual(previousWindow(sparse, 0, 8, 60));
    delete sparse[1];
    expect(sessionPreviewWindow(sparse, 0, 8, 60)).toEqual(previousWindow(sparse, 0, 8, 60));
});

test("large saved previews match the previous projection through append, compaction, rewind, branch and file replacement", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-preview-history-"));
    const path = join(directory, "history.jsonl");
    const timestamp = "2026-09-17T00:00:00.000Z";
    const header = { type: "session", version: 1, id: "preview", timestamp, cwd: "/work/crows" };
    const source = { provider: "fake", api: "scripted", model: "test" };
    const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
    const assistant = (text: string) => ({
        role: "assistant", content: [{ type: "text", text }], source,
        usage: emptyUsage(), stopReason: "stop",
    });
    const records: object[] = [header];
    let head: string | null = null;
    const message = (id: string, value: object) => {
        const record = { type: "message", id, parentId: head, timestamp, message: value };
        head = id;
        return record;
    };
    for (let index = 0; index < 1200; index += 1) {
        records.push(message(`u${index}`, user(`question ${index}\nread the chart`)));
        records.push(message(`a${index}`, {
            role: "assistant",
            content: [{ type: "tool_call", id: `call${index}`, name: "read", input: { path: "chart.txt" } }],
            source, usage: emptyUsage(), stopReason: "tool_use",
        }));
        records.push(message(`t${index}`, {
            role: "tool_result", toolCallId: `call${index}`, toolName: "read", isError: false,
            content: [{ type: "text", text: `cargo ${index}` }],
        }));
        records.push(message(`z${index}`, assistant(`answer ${index}`)));
    }
    const append = (...values: object[]) => appendFileSync(path, values.map((value) => JSON.stringify(value)).join("\n") + "\n");
    const compare = async () => {
        const snapshot = await readSessionSnapshot(path);
        const previous = sessionPreviewLines(projectTranscript(
            snapshot.messages, undefined, snapshot.messageStamps, snapshot.harnessMessages,
        ));
        const actual = await readSessionPreview(path);
        expect(actual).toEqual(previous);
        for (const width of [12, 38, 80]) {
            for (const scroll of [0, 3, 20]) {
                expect(sessionPreviewWindow(actual, scroll, 7, width))
                    .toEqual(previousWindow(previous, scroll, 7, width));
            }
        }
        return actual;
    };
    try {
        writeFileSync(path, records.map((value) => JSON.stringify(value)).join("\n") + "\n");
        const initial = await compare();
        expect(initial).toContain("answer 1199");
        append(message("extra-user", user("watch the northern tide")), message("extra-answer", assistant("the tide is high")));
        const afterAppend = await compare();
        expect(afterAppend).toContain("the tide is high");
        expect(afterAppend).not.toEqual(initial);
        append({
            type: "compaction", id: "compact-1", timestamp,
            boundaryMessageId: "z1198", firstRetainedMessageId: "u1199",
            projection: [assistant("summary")], measured: { inputTokens: 40, estimated: true },
        });
        expect(await compare()).toEqual(afterAppend);
        append({ type: "rewind", timestamp, userMessageId: "u1199", previousHeadId: head, headId: "z1198" });
        head = "z1198";
        const rewound = await compare();
        expect(rewound).toContain("answer 1198");
        expect(rewound).not.toContain("answer 1199");
        append(message("branch-user", user("take the southern route")), message("branch-answer", assistant("turn south")));
        const branched = await compare();
        expect(branched).toContain("turn south");
        expect(branched).not.toContain("the tide is high");
        head = null;
        writeFileSync(path, [header, message("replacement", user("a new file"))].map((value) => JSON.stringify(value)).join("\n") + "\n");
        expect(await compare()).toEqual(["You", "a new file"]);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("preview renderer keeps the previous layout while scrolling, resizing and replacing content", async () => {
    const start = startTuiSessionPicker([{
        id: "voyage", workspace: "/work/crow", session_path: "/sessions/voyage.jsonl",
        kind: "interactive", status: "idle", live: false, title: "Voyage",
    }]);
    const opened = handleTuiSettingsPickerKey(start, { name: "space" }).state!;
    const lines = [
        "You", "Where does the pirate crow go on the longest voyage across the stormy seas?",
        "", "Vera", "The crow sails to the island and follows the old chart beneath the stars.",
        "", "You", "Open the map and read the course carefully.",
        "", "Vera", "The harbor waits beyond the fog and the sea is calm.",
        "", "You", "What did the lookout see?", "", "Vera", "A lantern glowing on the shore.",
    ];
    const state = { ...opened, loading: false, previewLines: lines, previewScroll: 0 };
    const setup = await createTestRenderer({ width: 60, height: 18 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    const title = "    Voyage                                           esc";
    const rule = "    ────────────────────────────────────────────────────";
    const footer = "    ↑↓ scroll · ⏎ switch · esc back";
    const expected = (middle: string[], narrow = false) => [
        "", "", "",
        narrow ? "    Voyage                           esc" : title,
        narrow ? "    ────────────────────────────────────" : rule,
        ...middle,
        ...Array.from({ length: 19 - 5 - middle.length }, () => ""),
    ].join("\n");
    const frame = () => setup.captureCharFrame().split("\n").map((line) => line.trimEnd()).join("\n");
    try {
        view.update(state);
        await setup.flush();
        expect(frame()).toBe(expected([
            "", "    You", "    Where does the pirate crow go on the longest voyage",
            "    across the stormy seas?", "", "", footer,
        ]));
        view.update({ ...state, previewScroll: 4 });
        await setup.flush();
        const scrolled = expected([
            "", "    Vera", "    The crow sails to the island and follows the old",
            "    chart beneath the stars.", "", "", footer,
        ]);
        expect(frame()).toBe(scrolled);
        setup.resize(44, 18);
        view.update({ ...state, previewScroll: 4 });
        await setup.flush();
        expect(frame()).toBe(expected([
            "", "", "    Vera", "    The crow sails to the island and",
            "    follows the old chart beneath the", "", footer,
        ], true));
        setup.resize(60, 18);
        view.update({ ...state, previewScroll: 4 });
        await setup.flush();
        expect(frame()).toBe(scrolled);
        lines[4] = "A different chart points the crow toward the northern shore.";
        view.update({ ...state, previewScroll: 4 });
        await setup.flush();
        expect(frame()).toBe(expected([
            "", "    Vera", "    A different chart points the crow toward the",
            "    northern shore.", "", "", footer,
        ]));
        view.update({ ...state, previewLines: ["You", "A changed file."], previewScroll: 0 });
        await setup.flush();
        expect(frame()).toBe(expected(["", "    You", "    A changed file.", "", footer]));
    } finally {
        setup.renderer.destroy();
    }
});
