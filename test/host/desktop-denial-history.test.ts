import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entriesToBlocks } from "../../clients/ui/src/session/transcript.ts";
import { parseSessionLine } from "../../clients/ui/src/session/wire.ts";
import { historyPageFromStore } from "../../src/host/history-page.ts";
import { emptyUsage } from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";

test("@core desktop reopens a stored classifier denial under its withheld call", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-desktop-denial-"));
    const path = join(directory, "session.jsonl");
    try {
        const store = await SessionStore.create(path, { sessionId: "denial-session", cwd: directory });
        await store.appendMessage({ role: "user", content: [{ type: "text", text: "inspect the chart" }] });
        await store.appendMessage({
            role: "assistant",
            content: [{ type: "tool_call", id: "call", name: "read", input: { path: "secret.txt" } }],
            source: { provider: "faux", api: "scripted", model: "test" },
            usage: emptyUsage(),
            stopReason: "tool_use",
        });
        await store.appendMessage({
            role: "tool_result", toolCallId: "call", toolName: "read",
            content: [{ type: "text", text: "The classifier denied this call." }],
            isError: true, withheld: true,
            classifierOutcome: { kind: "denied", riskLevel: "high", reason: "The chart is private." },
        });
        const reopened = await SessionStore.open(path);
        const page = await historyPageFromStore(reopened);
        if (page.kind !== "page") throw new Error("expected a history page");
        const parsed = parseSessionLine(JSON.stringify({ type: "history", entries: page.entries }));
        if (parsed?.type !== "history") throw new Error("expected desktop history parsing");
        const calls = entriesToBlocks(parsed.entries).flatMap((block) => block.kind === "tools" ? block.calls : []);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
            tool: "read", args: { path: "secret.txt" }, state: "withheld",
            classifierOutcome: { kind: "denied", riskLevel: "high", reason: "The chart is private." },
        });
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
