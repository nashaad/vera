import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
    encodeHostResponse,
    HOST_PROTOCOL_VERSION,
    parseAttachedClientMessage,
    parseHostRequest,
    requestHostIdentity,
    requestHostShutdownIfIdle,
} from "../../src/host/protocol.ts";

test("host protocol parses identity requests and encodes responses", () => {
    expect(parseHostRequest('{"type":"host_identity"}')).toEqual({
        type: "host_identity",
    });
    expect(parseHostRequest('{"type":"list_agents"}')).toEqual({
        type: "list_agents",
    });
    expect(parseHostRequest(JSON.stringify({
        type: "shutdown_if_idle",
        pid: 101,
        started_at: "2026-07-17T12:00:00.000Z",
    }))).toEqual({
        type: "shutdown_if_idle",
        pid: 101,
        started_at: "2026-07-17T12:00:00.000Z",
    });
    expect(parseHostRequest(JSON.stringify({
        type: "shutdown_if_idle",
        pid: 0,
        started_at: "not-a-date",
    }))).toBeUndefined();
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
        protocol_version: HOST_PROTOCOL_VERSION,
    })).toBe(
        '{"type":"host_identity","pid":101,'
        + '"started_at":"2026-07-17T12:00:00.000Z",'
        + `"protocol_version":${HOST_PROTOCOL_VERSION}}\n`,
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

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "shutdown-if-idle client returns only typed host responses",
    async () => {
    const directory = mkdtempSync(join("/private/tmp", "vera-shutdown-client-"));
    const socketPath = join(directory, "host.sock");
    const server = createServer((socket) => {
        socket.once("data", () => {
            socket.end(`${JSON.stringify({
                type: "shutdown_if_idle_accepted",
                pid: 101,
                started_at: "2026-07-17T12:00:00.000Z",
            })}\n`);
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
    });

    try {
        expect(await requestHostShutdownIfIdle(socketPath, {
            pid: 101,
            started_at: "2026-07-17T12:00:00.000Z",
            protocol_version: HOST_PROTOCOL_VERSION,
        })).toEqual({
            type: "shutdown_if_idle_accepted",
            pid: 101,
            started_at: "2026-07-17T12:00:00.000Z",
        });
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
        type: "get_model_settings",
        requestId: "settings-1",
    }))).toEqual({
        type: "get_model_settings",
        requestId: "settings-1",
    });
    expect(parseAttachedClientMessage(JSON.stringify({
        type: "update_model_settings",
        requestId: "settings-2",
        patch: { model: "next-model", reasoningEffort: "high" },
    }))).toEqual({
        type: "update_model_settings",
        requestId: "settings-2",
        patch: { model: "next-model", reasoningEffort: "high" },
    });
    expect(parseAttachedClientMessage(JSON.stringify({
        type: "update_model_settings",
        requestId: "settings-3",
        patch: { reasoningEffort: null },
    }))).toEqual({
        type: "update_model_settings",
        requestId: "settings-3",
        patch: { reasoningEffort: null },
    });
    expect(parseAttachedClientMessage(JSON.stringify({
        type: "update_model_settings",
        requestId: "settings-4",
        patch: {},
    }))).toBeUndefined();
    expect(parseAttachedClientMessage(JSON.stringify({
        type: "update_model_settings",
        requestId: "settings-5",
        patch: { reasoningEffort: "turbo" },
    }))).toBeUndefined();
    expect(parseAttachedClientMessage(JSON.stringify({
        type: "ui_response",
        requestId: "request-1",
        response: { type: "tool_approval", decision: "allow_once" },
    }))).toEqual({
        type: "ui_response",
        requestId: "request-1",
        response: { type: "tool_approval", decision: "allow_once" },
    });
    expect(parseAttachedClientMessage(JSON.stringify({
        type: "ui_response",
        requestId: "request-2",
        response: { type: "tool_approval", decision: "allow_prefix" },
    }))).toEqual({
        type: "ui_response",
        requestId: "request-2",
        response: { type: "tool_approval", decision: "allow_prefix" },
    });
    expect(parseAttachedClientMessage(JSON.stringify({
        type: "ui_response",
        requestId: "legacy-request",
        response: { type: "tool_approval", decision: "allow" },
    }))).toBeUndefined();
    expect(parseAttachedClientMessage(JSON.stringify({
        type: "list_timeline",
        requestId: "list-1",
    }))).toEqual({
        type: "list_timeline",
        requestId: "list-1",
    });
    expect(parseAttachedClientMessage(JSON.stringify({
        type: "preview_timeline_action",
        requestId: "preview-1",
        boundaryId: "message-1",
        action: "rewind_conversation",
    }))).toEqual({
        type: "preview_timeline_action",
        requestId: "preview-1",
        boundaryId: "message-1",
        action: "rewind_conversation",
    });
    expect(parseAttachedClientMessage(JSON.stringify({
        type: "apply_timeline_action",
        requestId: "apply-1",
        planId: "plan-1",
    }))).toEqual({
        type: "apply_timeline_action",
        requestId: "apply-1",
        planId: "plan-1",
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
