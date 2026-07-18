import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
    encodeHostResponse,
    parseAttachedClientMessage,
    parseHostRequest,
    requestHostIdentity,
} from "../../src/host/protocol.ts";

test("host protocol parses identity requests and encodes responses", () => {
    expect(parseHostRequest('{"type":"host_identity"}')).toEqual({
        type: "host_identity",
    });
    expect(parseHostRequest('{"type":"list_agents"}')).toEqual({
        type: "list_agents",
    });
    expect(parseHostRequest(
        '{"type":"create_agent","workspace":"/work/one"}',
    )).toEqual({ type: "create_agent", workspace: "/work/one" });
    expect(parseHostRequest(
        '{"type":"resume_agent","session_path":"/sessions/one.jsonl"}',
    )).toEqual({
        type: "resume_agent",
        session_path: "/sessions/one.jsonl",
    });
    expect(parseHostRequest('{"type":"create_agent","workspace":""}'))
        .toBeUndefined();
    expect(parseHostRequest('{"type":"resume_agent","session_path":""}'))
        .toBeUndefined();
    expect(parseHostRequest('{"type":"attach","agent_id":"agent-1"}'))
        .toEqual({ type: "attach", agent_id: "agent-1" });
    expect(parseHostRequest('{"type":"attach","agent_id":""}'))
        .toBeUndefined();
    expect(parseHostRequest('{"type":"unknown"}')).toBeUndefined();
    expect(parseHostRequest("not json")).toBeUndefined();
    expect(encodeHostResponse({
        type: "host_identity",
        pid: 101,
        started_at: "2026-07-17T12:00:00.000Z",
    })).toBe(
        '{"type":"host_identity","pid":101,'
        + '"started_at":"2026-07-17T12:00:00.000Z"}\n',
    );
    expect(encodeHostResponse({
        type: "agent_list",
        agents: [{
            id: "agent-1",
            workspace: "/work/one",
            session_path: "/sessions/agent-1.jsonl",
            kind: "background",
            status: "working",
        }],
    })).toBe(
        '{"type":"agent_list","agents":[{"id":"agent-1",'
        + '"workspace":"/work/one",'
        + '"session_path":"/sessions/agent-1.jsonl",'
        + '"kind":"background",'
        + '"status":"working"}]}\n',
    );
});

test("host protocol parses messages after attach", () => {
    expect(parseAttachedClientMessage(
        '{"type":"prompt","content":"hello"}',
    )).toEqual({ type: "prompt", content: "hello" });
    expect(parseAttachedClientMessage('{"type":"abort"}')).toEqual({
        type: "abort",
    });
    expect(parseAttachedClientMessage('{"type":"detach"}')).toEqual({
        type: "detach",
    });
    expect(parseAttachedClientMessage(JSON.stringify({
        type: "ui_response",
        requestId: "request-1",
        response: { type: "tool_approval", decision: "allow" },
    }))).toEqual({
        type: "ui_response",
        requestId: "request-1",
        response: { type: "tool_approval", decision: "allow" },
    });
    expect(parseAttachedClientMessage('{"type":"unknown"}')).toBeUndefined();
});

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "identity request finishes when a peer closes without a response",
    async () => {
        const directory = mkdtempSync(join("/private/tmp", "vera-protocol-"));
        const socketPath = join(directory, "host.sock");
        const server = createServer((socket) => socket.end());
        try {
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(socketPath, resolve);
            });
            expect(await requestHostIdentity(socketPath)).toBeUndefined();
        } finally {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => error === undefined
                    ? resolve()
                    : reject(error));
            });
            rmSync(directory, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "identity request has a fixed deadline while a peer drips bytes",
    async () => {
        const directory = mkdtempSync(join("/private/tmp", "vera-protocol-"));
        const socketPath = join(directory, "host.sock");
        const server = createServer((socket) => {
            const drip = setInterval(() => socket.write(" "), 50);
            socket.once("close", () => clearInterval(drip));
        });
        try {
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(socketPath, resolve);
            });
            const startedAt = Date.now();
            expect(await requestHostIdentity(socketPath)).toBeUndefined();
            expect(Date.now() - startedAt).toBeLessThan(750);
        } finally {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => error === undefined
                    ? resolve()
                    : reject(error));
            });
            rmSync(directory, { recursive: true, force: true });
        }
    },
);
