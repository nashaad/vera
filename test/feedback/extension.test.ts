import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activate } from "../../extensions/feedback/extension.ts";
import type { VeraExtensionApi, VeraExtensionRequestHandler, VeraExtensionToolSpec } from "../../src/sdk/extensions.ts";

const previousHome = process.env.VERA_HOME;
const roots: string[] = [];
afterEach(() => {
    if (previousHome === undefined) delete process.env.VERA_HOME;
    else process.env.VERA_HOME = previousHome;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("feedback request and tool save through the shared store", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-feedback-extension-"));
    roots.push(root);
    process.env.VERA_HOME = root;
    let handler: VeraExtensionRequestHandler | undefined;
    let tool: VeraExtensionToolSpec | undefined;
    activate({
        requests: { handle(_name: string, value: VeraExtensionRequestHandler) { handler = value; return () => {}; } },
        tools: { register(value: VeraExtensionToolSpec) { tool = value; return () => {}; } },
    } as unknown as VeraExtensionApi);
    expect(tool?.permissionOperation).toBe("feedback.write");
    const signal = new AbortController().signal;
    const saved = await handler!({ kind: "bug", title: "Crow", description: "Sail", source: "window" }, { signal }) as { path: string };
    const report = JSON.parse(readFileSync(join(saved.path, "report.json"), "utf8"));
    expect(report).toMatchObject({ kind: "bug", title: "Crow", source: "window" });
    await expect(handler!({ kind: "unknown", title: "Crow", description: "", source: "window" }, { signal })).rejects.toThrow();
    const answer = await tool!.run({ input: { kind: "feature", title: "Sail", description: "More wind" }, workspace: root, sessionId: "session-1", signal });
    expect(answer.isError).toBeUndefined();
    const path = answer.output.slice("Report saved on this computer: ".length);
    expect(JSON.parse(readFileSync(join(path, "report.json"), "utf8"))).toMatchObject({ source: "chat", session_id: "session-1" });
});
