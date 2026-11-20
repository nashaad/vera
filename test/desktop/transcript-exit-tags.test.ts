import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CallList, RunLine } from "../../clients/ui/src/session/ToolRuns.tsx";
import type { ToolCall } from "../../clients/ui/src/session/model.ts";
import { initialWatch, reduceWatch, entriesToBlocks } from "../../clients/ui/src/session/transcript.ts";
import { parseSessionLine } from "../../clients/ui/src/session/wire.ts";

function render(calls: readonly ToolCall[]): string {
    return renderToStaticMarkup(createElement(RunLine, { calls }));
}

function renderRows(calls: readonly ToolCall[]): string {
    return renderToStaticMarkup(createElement(CallList, { calls }));
}

function historyCalls(entries: readonly unknown[]): ToolCall[] {
    const parsed = parseSessionLine(JSON.stringify({ type: "history", entries }));
    if (parsed?.type !== "history") throw new Error("expected desktop history parsing");
    return entriesToBlocks(parsed.entries).flatMap((block) => block.kind === "tools" ? block.calls : []);
}

test("@core desktop live and replay show nonzero exits without counting them as failures", () => {
    let watch = initialWatch("agent-a");
    for (const message of [
        { type: "tool_started", tool: "bash", args: { command: "false" } },
        { type: "tool_finished", tool: "bash", output: "", isError: true, exitCode: 7 },
    ] as const) watch = reduceWatch(watch, message);
    const liveCalls = watch.live.flatMap((block) => block.kind === "tools" ? block.calls : []);
    expect(liveCalls[0]).toMatchObject({ state: "done", exitCode: 7, isError: true });
    const liveMarkup = render(liveCalls);
    expect(liveMarkup).toContain('class="exit-tag">exit 7</span>');
    expect(liveMarkup).not.toContain("failed");
    expect(renderRows(liveCalls)).toContain('class="exit-tag">exit 7</span>');

    const calls = historyCalls([
        { kind: "tool", tool: "bash", args: { command: "false" } },
        { kind: "tool_result", tool: "bash", output: "", isError: true, exitCode: 7 },
    ]);
    expect(calls[0]).toMatchObject({ state: "done", exitCode: 7, isError: true });
    const replayMarkup = render(calls);
    expect(replayMarkup).toContain('class="exit-tag">exit 7</span>');
    expect(replayMarkup).not.toContain("failed");
});

test("@core desktop hides zero, preserves legacy errors, and gives withheld calls no exit tag", () => {
    const calls = historyCalls([
        { kind: "tool", tool: "bash", args: { command: "true" } },
        { kind: "tool_result", tool: "bash", output: "", isError: false, exitCode: 0 },
        { kind: "tool", tool: "bash", args: { command: "legacy" } },
        { kind: "tool_result", tool: "bash", output: "old error", isError: true },
        { kind: "tool", tool: "bash", args: { command: "denied" } },
        { kind: "tool_result", tool: "bash", output: "denied", isError: true, exitCode: 9, withheld: true },
    ]);
    expect(calls.map((call) => call.state)).toEqual(["done", "failed", "withheld"]);
    expect(renderRows([calls[0]!])).not.toContain("exit-tag");
    expect(renderRows([calls[1]!])).toContain("failed-tag");
    const withheld = render([calls[2]!]);
    expect(withheld).toContain("Did not run");
    expect(withheld).not.toContain("exit-tag");
});

test("@core collapsed desktop groups summarize repeated distinct exits with a bounded list", () => {
    const codes = [3, 8, 3, 12, 12, 15, 15, 19];
    const calls: ToolCall[] = codes.map((exitCode, index) => ({
        tool: "bash", title: `bash ${index}`, args: { command: `cmd-${index}` },
        state: "done", isError: true, exitCode,
    }));
    const html = render(calls);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('class="exit-tag">exit 3 ×2</span>');
    expect(html).toContain('class="exit-tag">exit 8</span>');
    expect(html).toContain('class="exit-tag">exit 12 ×2</span>');
    expect(html).toContain('class="exit-tag">+2</span>');
    expect(html).not.toContain("failed");
});
