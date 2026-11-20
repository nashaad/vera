import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "../../src/store/session-store.ts";
import type { ModelMessage } from "../../src/model/types.ts";

const directories: string[] = [];

afterAll(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

test("session JSONL round-trips tool results with and without observed exit codes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-exit-code-store-"));
    directories.push(directory);
    const path = join(directory, "session.jsonl");
    const legacy: ModelMessage = {
        role: "tool_result",
        toolCallId: "call-legacy",
        toolName: "bash",
        content: [{ type: "text", text: "old output" }],
        isError: false,
    };
    const observed: ModelMessage = {
        role: "tool_result",
        toolCallId: "call-exited",
        toolName: "bash",
        content: [{ type: "text", text: "process exited" }],
        isError: true,
        exitCode: 7,
    };
    const store = await SessionStore.create(path, { sessionId: "exit-code", cwd: directory });
    await store.appendMessage(legacy);
    await store.appendMessage(observed);

    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    expect(JSON.parse(lines[1]!).message).not.toHaveProperty("exitCode");
    expect(JSON.parse(lines[2]!).message.exitCode).toBe(7);
    expect((await SessionStore.open(path)).messages()).toEqual([legacy, observed]);
});

test("session reopening rejects a non-integer tool exit code", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-exit-code-invalid-"));
    directories.push(directory);
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, { sessionId: "invalid-exit-code", cwd: directory });
    await store.appendMessage({
        role: "tool_result",
        toolCallId: "call-valid",
        toolName: "bash",
        content: [{ type: "text", text: "done" }],
        isError: false,
    });
    const contents = readFileSync(path, "utf8").replace('"isError":false', '"isError":false,"exitCode":1.5');
    writeFileSync(path, contents);

    await expect(SessionStore.open(path)).rejects.toThrow("not a valid message entry");
});
