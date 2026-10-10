import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextBuffer, type RGBA, type StyledText } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { TuiAgentClient } from "../../clients/tui/main.ts";
import type { TuiTextTranscriptEntry } from "../../clients/tui/state.ts";
import { createTuiToolHeader, updateTuiToolHeader } from "../../clients/tui/tool-row.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { runHeadlessLoop } from "../../src/engine/run-turn.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { startTuiTestSession } from "../support/tui-harness.ts";

const TURNS = 6;

function color(value: RGBA | undefined): string {
    return value === undefined ? "" : [value.r, value.g, value.b, value.a].join(",");
}

function voyage(turn: number): AssistantMessage {
    return {
        role: "assistant",
        content: [
            { type: "thinking", text: "The crow weighs the tides and counts the cannons. ".repeat(12) },
            { type: "text", text: `The crow plunders reef ${turn} at dawn. VOYAGE-${turn}` },
        ],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

// Each native rewrite can pin an allocator page, so unchanged text must not be rewritten per delta.
test("streaming turns never rewrite a text buffer with identical content", async () => {
    const channel = createInProcessChannel();
    void runHeadlessLoop(channel.engine, new FauxAdapter(
        Array.from({ length: TURNS }, (_, turn) => voyage(turn)),
        { chunkSize: 8 },
    ), "test", "high", { approvalMode: "auto" }, {
        readModelSettings: () => ({ model: "test", reasoningEffort: "high", contextWindow: 100_000 }),
        readApprovalMode: () => "auto",
        updateApprovalMode: async () => undefined,
        router: { updateModelSettings: async () => undefined },
    });
    const client: TuiAgentClient = {
        async send(command) { channel.client.send(command); },
        receive(signal) { return channel.client.receive(signal); },
        async detach() {},
        close() {},
    };
    const home = mkdtempSync(join(tmpdir(), "vera-text-writes-"));
    const session = await startTuiTestSession({
        home,
        width: 120,
        height: 40,
        dependencies: () => ({ client, copyText: async () => undefined }),
    });
    const lastWrite = new WeakMap<TextBuffer, string>();
    const repeated: string[] = [];
    const original = TextBuffer.prototype.setStyledText;
    TextBuffer.prototype.setStyledText = function (text: StyledText): void {
        const key = text.chunks.map((chunk) =>
            `${chunk.text}|${color(chunk.fg)}|${color(chunk.bg)}|${chunk.attributes}|${chunk.link?.url}`
        ).join("\n");
        if (lastWrite.get(this) === key) repeated.push(text.chunks.map((chunk) => chunk.text).join("").slice(0, 60));
        lastWrite.set(this, key);
        original.call(this, text);
    };
    try {
        await session.waitForVisiblePane("Start a conversation");
        for (let turn = 0; turn < TURNS; turn += 1) {
            session.sendText(`sail ${turn}`);
            session.sendKey("Enter");
            await session.waitForVisiblePane(`VOYAGE-${turn}`);
            await session.settle(50);
        }
        expect(repeated).toEqual([]);
    } finally {
        TextBuffer.prototype.setStyledText = original;
        await session.close();
        rmSync(home, { recursive: true, force: true });
    }
}, 30_000);

test("an unchanged tool header keeps its preview rows", async () => {
    const setup = await createTestRenderer({ width: 60, height: 10 });
    const entry: TuiTextTranscriptEntry = {
        kind: "tool_header",
        text: "Read chart.md",
        detailPreview: "  │ X marks the spot\n  └ beware the kraken",
    };
    const node = createTuiToolHeader(setup.renderer, "header", entry, 0);
    try {
        const rows = node.getChildren().slice();
        updateTuiToolHeader(node, { ...entry });
        expect(node.getChildren().every((child, index) => child === rows[index])).toBe(true);
        updateTuiToolHeader(node, { ...entry, detailPreview: "  └ the crow took it" });
        expect(node.getChildren().length).toBe(2);
        expect(node.getChildren()[1]).not.toBe(rows[1]);
    } finally {
        node.destroyRecursively();
        setup.renderer.destroy();
    }
});
