import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RunLine } from "../../clients/ui/src/session/ToolRuns.tsx";
import { runSegments } from "../../clients/ui/src/session/subagentCards.ts";
import { entriesToBlocks } from "../../clients/ui/src/session/transcript.ts";
import { parseSessionLine } from "../../clients/ui/src/session/wire.ts";
import type { ToolCall } from "../../clients/ui/src/session/model.ts";

function markup(calls: readonly ToolCall[]): string {
    return renderToStaticMarkup(createElement(RunLine, { calls }));
}

function reopenedBlocks(): ReturnType<typeof entriesToBlocks> {
    const parsed = parseSessionLine(JSON.stringify({
        type: "history",
        entries: [
            { kind: "user", text: "inspect the directory" },
            { kind: "tool", tool: "read", args: { path: "secret.txt" } },
            { kind: "tool_result", tool: "read", output: "The classifier denied this call.", isError: true,
                classifierOutcome: { kind: "denied", riskLevel: "high", reason: "The file contains private data." }, withheld: true },
            { kind: "tool", tool: "bash", args: { command: "false" } },
            { kind: "tool_result", tool: "bash", output: "permission denied", isError: true },
            { kind: "tool", tool: "read", args: { path: "public.txt" } },
            { kind: "tool_result", tool: "read", output: "ok", isError: false },
            { kind: "tool", tool: "list", args: {} },
            { kind: "tool_result", tool: "list", output: "legacy output", isError: false },
        ],
    }));
    if (parsed?.type !== "history") throw new Error("expected desktop history parsing");
    return entriesToBlocks(parsed.entries);
}

test("@core reopened classifier denials retain a withheld notice without relabeling failures", () => {
    const blocks = reopenedBlocks();
    const calls = blocks.flatMap((block) => block.kind === "tools" ? block.calls : []);
    const denied = calls.find((call) => call.tool === "read" && call.args.path === "secret.txt");
    expect(denied?.state).toBe("withheld");
    const deniedMarkup = markup(denied === undefined ? [] : [denied]);
    expect(deniedMarkup).toContain("Did not run");
    expect(deniedMarkup).toContain("CLASSIFIER DENIED");
    expect(deniedMarkup).toContain("High risk");
    expect(deniedMarkup).toContain("The file contains private data.");
    expect(deniedMarkup).toContain("secret.txt");
    expect(deniedMarkup).not.toContain("failed");
    const segments = runSegments(calls);
    expect(segments.some((segment) => segment.kind === "calls" && segment.calls.length === 1 && segment.calls[0] === denied)).toBe(true);

    const ordinaryFailure = calls.find((call) => call.tool === "bash");
    expect(ordinaryFailure?.state).toBe("failed");
    const failureMarkup = markup(ordinaryFailure === undefined ? [] : [ordinaryFailure]);
    expect(failureMarkup).not.toContain("CLASSIFIER DENIED");
    expect(failureMarkup).not.toContain("risk");

    const allowed = calls.find((call) => call.args.path === "public.txt");
    expect(allowed?.state).toBe("done");
    const allowedMarkup = markup(allowed === undefined ? [] : [allowed]);
    expect(allowedMarkup).not.toContain("CLASSIFIER DENIED");
    expect(allowedMarkup).not.toContain("risk");

    const legacy = calls.find((call) => call.tool === "list");
    expect(legacy?.state).toBe("done");
    expect(markup(legacy === undefined ? [] : [legacy])).not.toContain("CLASSIFIER DENIED");

    const malformed = parseSessionLine(JSON.stringify({
        type: "history",
        entries: [{ kind: "tool_result", tool: "read", output: "bad metadata", isError: true,
            classifierOutcome: { kind: "denied", riskLevel: "impossible", reason: "bad" } }],
    }));
    expect(malformed?.type).toBe("history");
    if (malformed?.type === "history") expect(malformed.entries[0]).toMatchObject({ kind: "tool_result", isError: true });
    expect(JSON.stringify(malformed)).not.toContain("impossible");
});

test("withheld ordinary permission denials do not acquire a classifier notice", () => {
    const parsed = parseSessionLine(JSON.stringify({
        type: "history",
        entries: [
            { kind: "tool", tool: "bash", args: { command: "touch crow.txt" } },
            { kind: "tool_result", tool: "bash", output: "Permission denied", isError: true, withheld: true },
        ],
    }));
    if (parsed?.type !== "history") throw new Error("expected desktop history parsing");
    const blocks = entriesToBlocks(parsed.entries);
    const calls = blocks.flatMap((block) => block.kind === "tools" ? block.calls : []);
    expect(calls[0]?.state).toBe("withheld");
    const view = markup(calls);
    expect(view).toContain("Did not run");
    expect(view).not.toContain("CLASSIFIER DENIED");
});
