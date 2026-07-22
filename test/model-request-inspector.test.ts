import { expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inspectLatestModelRequest } from "../src/model-request-inspector.ts";
import { SessionStore } from "../src/store/session-store.ts";

test("model request inspection returns the latest matching completed event", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-request-inspection-"));
    const sessionPath = join(root, "session.jsonl");
    const logPath = join(root, "events.jsonl");
    try {
        await SessionStore.create(sessionPath, {
            sessionId: "session-1",
            cwd: "/work/vera",
        });
        await writeFile(logPath, [
            JSON.stringify(requestEvent("session-1", "first-model", "first")),
            JSON.stringify({ type: "turn_finished", sessionId: "session-1" }),
            JSON.stringify(requestEvent("other-session", "other-model", "other")),
            JSON.stringify(requestEvent("session-1", "latest-model", "latest")),
            "",
        ].join("\n"));
        await appendFile(logPath, "{\"type\":\"model_request\"");

        expect(JSON.parse(
            await inspectLatestModelRequest(sessionPath, logPath),
        )).toEqual({
            format_version: 1,
            session_id: "session-1",
            timestamp: "2026-07-21T12:00:00.000Z",
            request: {
                model: "latest-model",
                max_tokens: 4096,
                reasoning_effort: "medium",
                system_prompt: "latest prompt",
                messages: [{
                    role: "user",
                    content: [{ type: "text", text: "latest" }],
                }],
                tools: [{
                    name: "read",
                    description: "Read a file",
                    inputSchema: { type: "object" },
                }],
            },
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("model request inspection rejects a corrupt latest request", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-request-inspection-"));
    const sessionPath = join(root, "session.jsonl");
    const logPath = join(root, "events.jsonl");
    try {
        await SessionStore.create(sessionPath, {
            sessionId: "session-1",
            cwd: "/work/vera",
        });
        await writeFile(logPath, [
            JSON.stringify(requestEvent("session-1", "valid-model", "valid")),
            JSON.stringify({
                ...requestEvent("session-1", "broken-model", "broken"),
                maxTokens: -1,
                reasoningEffort: "enormous",
                messages: [{ role: "user", content: "not-an-array" }],
            }),
            "",
        ].join("\n"));

        await expect(
            inspectLatestModelRequest(sessionPath, logPath),
        ).rejects.toThrow("contains an invalid model request");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

function requestEvent(sessionId: string, model: string, text: string) {
    return {
        type: "model_request",
        timestamp: "2026-07-21T12:00:00.000Z",
        sessionId,
        model,
        maxTokens: 4096,
        reasoningEffort: "medium",
        systemPrompt: `${text} prompt`,
        messages: [{
            role: "user",
            content: [{ type: "text", text }],
        }],
        tools: [{
            name: "read",
            description: "Read a file",
            inputSchema: { type: "object" },
        }],
    };
}
