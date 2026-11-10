import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
    encodeHostResponse,
    HOST_MIN_COMPATIBLE_PROTOCOL_VERSION,
    HOST_PROTOCOL_VERSION,
    parseAgentLocationReply,
    parseAttachedClientMessage,
    parseHostRequest,
    parseHostStopWaitEvent,
    stopWaitWireMessage,
    requestHostIdentity,
    requestHostShutdownIfIdle,
    type HistoryPageResponse,
} from "../../src/host/protocol.ts";
import { socketTest } from "../support/socket-probe.ts";

test("the host history page wire carries reasoning facts", () => {
    const page: HistoryPageResponse = {
        type: "history_page",
        request_id: "page-1",
        before: "later#0",
        entries: [{ kind: "reasoning", id: "earlier#r0", text: "follow the stars" }],
        page: { pageVersion: 1, hasMore: false },
    };
    expect(JSON.parse(encodeHostResponse(page))).toEqual(page);
});

test("host protocol parses identity requests and encodes responses", () => {
    expect(HOST_MIN_COMPATIBLE_PROTOCOL_VERSION).toBe(HOST_PROTOCOL_VERSION);
    expect(parseHostRequest('{"type":"host_identity"}')).toEqual({
        type: "host_identity",
    });
    expect(parseHostRequest('{"type":"annex_url"}')).toEqual({
        type: "annex_url",
    });
    expect(parseHostRequest(JSON.stringify({
        type: "catalog_refresh",
        provider: "outrider",
    }))).toEqual({
        type: "catalog_refresh",
        provider: "outrider",
    });
    expect(parseHostRequest(JSON.stringify({
        type: "catalog_refresh",
        provider: "outrider",
        workspace: "/work/vera",
    }))).toEqual({
        type: "catalog_refresh",
        provider: "outrider",
        workspace: "/work/vera",
    });
    expect(parseHostRequest('{"type":"catalog_refresh"}')).toBeUndefined();
    expect(parseHostRequest('{"type":"refresh_catalogs"}')).toEqual({
        type: "refresh_catalogs",
    });
    expect(parseHostRequest(JSON.stringify({
        type: "catalog_refresh",
        provider: "",
    }))).toBeUndefined();
    expect(parseHostRequest(JSON.stringify({
        type: "checkpoint_stores",
        destination: "/tmp/vera-dev/one/runtime",
    }))).toEqual({
        type: "checkpoint_stores",
        destination: "/tmp/vera-dev/one/runtime",
    });
    expect(parseHostRequest(JSON.stringify({
        type: "checkpoint_stores",
        destination: "relative/runtime",
    }))).toBeUndefined();
    expect(parseHostRequest(JSON.stringify({
        type: "schedule_operation",
        operation: {
            action: "add",
            id: "daily-review",
            cron: "0 9 * * *",
            timezone: "UTC",
            address: "peer",
            payload: { text: "Review" },
        },
    }))).toEqual({
        type: "schedule_operation",
        operation: {
            action: "add",
            id: "daily-review",
            cron: "0 9 * * *",
            timezone: "UTC",
            address: "peer",
            payload: { text: "Review" },
        },
    });
    expect(parseHostRequest(JSON.stringify({
        type: "schedule_operation",
        operation: { action: "add", id: "missing-fields" },
    }))).toBeUndefined();
    expect(parseHostRequest(JSON.stringify({
        type: "shutdown_if_idle",
        pid: 101,
        started_at: "2026-07-17T12:00:00.000Z",
        requester_protocol_version: HOST_PROTOCOL_VERSION,
    }))).toEqual({
        type: "shutdown_if_idle",
        pid: 101,
        started_at: "2026-07-17T12:00:00.000Z",
        requester_protocol_version: HOST_PROTOCOL_VERSION,
    });
    expect(parseHostRequest(JSON.stringify({
        type: "shutdown_for_replacement",
        pid: 101,
        started_at: "2026-07-17T12:00:00.000Z",
        requester_protocol_version: HOST_PROTOCOL_VERSION + 1,
    }))).toEqual({
        type: "shutdown_for_replacement",
        pid: 101,
        started_at: "2026-07-17T12:00:00.000Z",
        requester_protocol_version: HOST_PROTOCOL_VERSION + 1,
    });
    expect(parseHostRequest(JSON.stringify({
        type: "shutdown_if_idle",
        pid: 101,
        started_at: "2026-07-17T12:00:00.000Z",
    }))).toBeUndefined();
    expect(parseHostRequest(JSON.stringify({
        type: "shutdown_if_idle",
        pid: 0,
        started_at: "not-a-date",
    }))).toBeUndefined();
    expect(parseHostRequest(
        '{"type":"create_agent","workspace":"/work/one"}',
    )).toEqual({ type: "create_agent", workspace: "/work/one" });
    expect(parseHostRequest(JSON.stringify({
        type: "create_agent",
        workspace: "/work/one",
        approval_mode: "readonly",
        lifetime: "ephemeral",
        startup_profile: "bare",
    }))).toEqual({
        type: "create_agent",
        workspace: "/work/one",
        approval_mode: "readonly",
        lifetime: "ephemeral",
        startup_profile: "bare",
    });
    expect(parseHostRequest(JSON.stringify({
        type: "create_agent",
        workspace: "/work/one",
        startup_profile: "unknown",
    }))).toBeUndefined();
    expect(parseHostRequest(JSON.stringify({
        type: "create_agent",
        workspace: "/work/one",
        approval_mode: "not valid",
    }))).toBeUndefined();
    expect(parseHostRequest(JSON.stringify({
        type: "create_agent",
        workspace: "/work/one",
        lifetime: "temporary",
    }))).toBeUndefined();
    expect(parseHostRequest(JSON.stringify({
        type: "run_once",
        workspace: "/work/one",
        prompt: "measure",
    }))).toBeUndefined();
    expect(parseHostRequest(
        '{"type":"resume_agent","session_path":"/sessions/one.jsonl"}',
    )).toEqual({
        type: "resume_agent",
        session_path: "/sessions/one.jsonl",
    });
    expect(parseHostRequest(JSON.stringify({
        type: "branch_agent",
        source_agent_id: "source",
        position: "before",
        entry_id: "message-2",
    }))).toEqual({
        type: "branch_agent",
        source_agent_id: "source",
        position: "before",
        entry_id: "message-2",
    });
    expect(parseHostRequest(JSON.stringify({
        type: "branch_agent",
        source_agent_id: "source",
        position: "at",
        approval_mode: "readonly",
        lifetime: "ephemeral",
        initial_messages: [{
            role: "user",
            content: [{ type: "text", text: "boundary" }],
            internal: true,
        }],
    }))).toEqual({
        type: "branch_agent",
        source_agent_id: "source",
        position: "at",
        approval_mode: "readonly",
        lifetime: "ephemeral",
        initial_messages: [{
            role: "user",
            content: [{ type: "text", text: "boundary" }],
            internal: true,
        }],
    });
    expect(parseHostRequest(JSON.stringify({
        type: "branch_agent",
        source_agent_id: "source",
        position: "at",
        initial_messages: [{
            role: "assistant",
            content: [{ type: "text", text: "not allowed" }],
        }],
    }))).toBeUndefined();
    expect(parseHostRequest(JSON.stringify({
        type: "branch_agent",
        source_agent_id: "x".repeat(257),
        position: "at",
    }))).toBeUndefined();
    expect(parseHostRequest(JSON.stringify({
        type: "branch_agent",
        source_agent_id: "source",
        position: "at",
        initial_messages: [{
            role: "user",
            content: [{ type: "text", text: "\\".repeat(16_000) }],
        }, {
            role: "user",
            content: [{ type: "text", text: "\\".repeat(16_000) }],
        }],
    }))).toBeUndefined();
    expect(parseHostRequest(JSON.stringify({
        type: "branch_agent",
        source_agent_id: "source",
        position: "at",
        initial_messages: Array.from({ length: 4 }, () => ({
            role: "user",
            content: [{ type: "text", text: "x".repeat(16_000) }],
        })),
    }))).toBeUndefined();
    expect(parseHostRequest(JSON.stringify({
        type: "branch_agent",
        source_agent_id: "source",
        position: "at",
        approval_mode: "not valid",
    }))).toBeUndefined();
    expect(parseHostRequest(JSON.stringify({
        type: "trash_session",
        target_agent_id: "saved",
    }))).toEqual({
        type: "trash_session",
        target_agent_id: "saved",
    });
    expect(parseHostRequest(JSON.stringify({
        type: "close_agent",
        target_agent_id: "runaway",
    }))).toEqual({
        type: "close_agent",
        target_agent_id: "runaway",
    });
    expect(parseHostRequest(JSON.stringify({
        type: "close_agent",
        target_agent_id: "",
    }))).toBeUndefined();
    expect(parseHostRequest(JSON.stringify({
        type: "commit_agent_branch",
        agent_id: "branch",
    }))).toEqual({ type: "commit_agent_branch", agent_id: "branch" });
    expect(parseHostRequest(JSON.stringify({
        type: "trash_session",
        target_agent_id: "",
    }))).toBeUndefined();
    expect(parseHostRequest(JSON.stringify({
        type: "rename_session",
        target_agent_id: "saved",
        name: "release notes",
    }))).toEqual({
        type: "rename_session",
        target_agent_id: "saved",
        name: "release notes",
    });
    expect(parseHostRequest(JSON.stringify({
        type: "rename_session",
        target_agent_id: "saved",
        name: null,
    }))).toEqual({
        type: "rename_session",
        target_agent_id: "saved",
        name: null,
    });
    expect(parseHostRequest(JSON.stringify({
        type: "rename_session",
        target_agent_id: "saved",
        name: "",
    }))).toBeUndefined();
    expect(parseHostRequest(JSON.stringify({
        type: "rename_session",
        target_agent_id: "saved",
    }))).toBeUndefined();
    expect(parseHostRequest('{"type":"create_agent","workspace":""}'))
        .toBeUndefined();
    expect(parseHostRequest('{"type":"resume_agent","session_path":""}'))
        .toBeUndefined();
    expect(parseHostRequest('{"type":"attach","agent_id":"agent-1"}'))
        .toEqual({ type: "attach", agent_id: "agent-1" });
    expect(parseHostRequest(JSON.stringify({
        type: "attach",
        agent_id: "agent-1",
        attachment_kind: "interactive",
        client_id: "client-1",
    }))).toEqual({
        type: "attach",
        agent_id: "agent-1",
        attachment_kind: "interactive",
        client_id: "client-1",
    });
    expect(parseHostRequest(JSON.stringify({
        type: "attach",
        agent_id: "agent-1",
        attachment_kind: "interactive",
    }))).toBeUndefined();
    expect(parseHostRequest(JSON.stringify({
        type: "attach",
        agent_id: "agent-1",
        attachment_kind: "background",
    }))).toBeUndefined();
    expect(parseHostRequest(JSON.stringify({
        type: "attach",
        agent_id: "agent-1",
        requested_capabilities: ["agent.branch-options.v1"],
        after_seq: 17,
    }))).toEqual({
        type: "attach",
        agent_id: "agent-1",
        requested_capabilities: ["agent.branch-options.v1"],
        after_seq: 17,
    });
    expect(parseHostRequest(JSON.stringify({
        type: "attach",
        agent_id: "agent-1",
        requested_capabilities: ["not versioned"],
    }))).toBeUndefined();
    expect(parseHostRequest(
        '{"type":"attach","agent_id":"agent-1","after_seq":-1}',
    )).toBeUndefined();
    expect(parseHostRequest('{"type":"attach","agent_id":""}'))
        .toBeUndefined();
    expect(parseHostRequest('{"type":"unknown"}')).toBeUndefined();
    expect(parseHostRequest("not json")).toBeUndefined();
    expect(encodeHostResponse({
        type: "host_identity",
        pid: 101,
        started_at: "2026-07-17T12:00:00.000Z",
        protocol_version: HOST_PROTOCOL_VERSION,
        minimum_compatible_protocol_version:
            HOST_MIN_COMPATIBLE_PROTOCOL_VERSION,
        build_id: "vera-abc1234",
    })).toBe(
        '{"type":"host_identity","pid":101,'
        + '"started_at":"2026-07-17T12:00:00.000Z",'
        + `"protocol_version":${HOST_PROTOCOL_VERSION},`
        + `"minimum_compatible_protocol_version":${
            HOST_MIN_COMPATIBLE_PROTOCOL_VERSION
        },"build_id":"vera-abc1234"}\n`,
    );
    expect(encodeHostResponse({
        type: "agent_list",
        agents: [{
            id: "agent-1",
            workspace: "/work/one",
            session_path: "/sessions/agent-1.jsonl",
            kind: "background",
            status: "working",
            live: true,
        }],
    })).toBe(
        '{"type":"agent_list","agents":[{"id":"agent-1",'
        + '"workspace":"/work/one",'
        + '"session_path":"/sessions/agent-1.jsonl",'
        + '"kind":"background",'
        + '"status":"working","live":true}]}\n',
    );
});

test("host protocol parses attached extension command requests", () => {
    expect(parseAttachedClientMessage(JSON.stringify({
        type: "list_extension_commands",
        request_id: "commands-1",
    }))).toEqual({
        type: "list_extension_commands",
        request_id: "commands-1",
    });
    expect(parseAttachedClientMessage(JSON.stringify({
        type: "run_extension_command",
        request_id: "command-1",
        command: "hello",
        arguments_text: "Nash",
    }))).toEqual({
        type: "run_extension_command",
        request_id: "command-1",
        command: "hello",
        arguments_text: "Nash",
    });
    expect(parseAttachedClientMessage(JSON.stringify({
        type: "run_extension_command",
        request_id: "",
        command: "hello",
        arguments_text: "",
    }))).toBeUndefined();
    expect(parseAttachedClientMessage(JSON.stringify({
        type: "run_extension_command",
        request_id: "command-2",
        command: "../bad",
        arguments_text: "",
    }))).toBeUndefined();
    expect(parseAttachedClientMessage(JSON.stringify({
        type: "history_page",
        request_id: "page-1",
        before: "message-1#0",
    }))).toEqual({
        type: "history_page",
        request_id: "page-1",
        before: "message-1#0",
    });
    expect(parseAttachedClientMessage(JSON.stringify({
        type: "history_page",
        request_id: "",
        before: "message-1#0",
    }))).toBeUndefined();
    expect(parseAttachedClientMessage(JSON.stringify({
        type: "history_page",
        request_id: "page-2",
        before: "",
    }))).toBeUndefined();
});

socketTest(
    "shutdown-if-idle client returns only typed host responses",
    async () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-shutdown-client-"));
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
        type: "release_attachment",
        policy: "stop_if_last",
    }))).toEqual({
        type: "release_attachment",
        policy: "stop_if_last",
    });
    expect(parseAttachedClientMessage(JSON.stringify({
        type: "release_attachment",
        policy: "stop_sometime",
    }))).toBeUndefined();
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
        patch: { reasoningEffort: "" },
    }))).toBeUndefined();
    expect(parseAttachedClientMessage(JSON.stringify({
        type: "catalog_refresh",
        requestId: "refresh-1",
        provider: "openrouter",
    }))).toEqual({
        type: "catalog_refresh",
        requestId: "refresh-1",
        provider: "openrouter",
    });
    // A refresh names its provider. An unreadable or absent one is refused
    // rather than widened into asking every provider at once.
    expect(parseAttachedClientMessage(JSON.stringify({
        type: "catalog_refresh",
        requestId: "refresh-2",
    }))).toBeUndefined();
    expect(parseAttachedClientMessage(JSON.stringify({
        type: "catalog_refresh",
        requestId: "refresh-3",
        provider: 42,
    }))).toBeUndefined();
    expect(parseAttachedClientMessage(JSON.stringify({
        type: "catalog_refresh",
        requestId: "refresh-4",
        provider: "",
    }))).toBeUndefined();
    expect(parseAttachedClientMessage(JSON.stringify({
        type: "catalog_refresh",
        provider: "openrouter",
    }))).toBeUndefined();
    expect(parseAttachedClientMessage(JSON.stringify({
        type: "pool_add",
        requestId: "pool-verify",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        verify: true,
    }))).toEqual({
        type: "pool_add",
        requestId: "pool-verify",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        verify: true,
    });
    for (const type of ["pool_add", "pool_remove"] as const) {
        expect(parseAttachedClientMessage(JSON.stringify({
            type,
            requestId: "pool-1",
            provider: "openai-codex",
            model: "gpt-5.6-sol",
        }))).toEqual({
            type,
            requestId: "pool-1",
            provider: "openai-codex",
            model: "gpt-5.6-sol",
        });
        for (const invalid of [
            { provider: "", model: "gpt-5.6-sol" },
            { provider: "openai-codex", model: "   " },
            { provider: "openai-codex" },
        ]) {
            expect(parseAttachedClientMessage(JSON.stringify({
                type,
                requestId: "pool-invalid",
                ...invalid,
            }))).toBeUndefined();
        }
    }
    for (const name of ["frosty", null]) {
        expect(parseAttachedClientMessage(JSON.stringify({
            type: "pool_name",
            requestId: "pool-name-1",
            provider: "openai-codex",
            model: "gpt-5.6-sol",
            name,
        }))).toEqual({
            type: "pool_name",
            requestId: "pool-name-1",
            provider: "openai-codex",
            model: "gpt-5.6-sol",
            name,
        });
    }
    // An absent or empty name is not a request to clear it, which `null` says.
    for (const name of ["", undefined]) {
        expect(parseAttachedClientMessage(JSON.stringify({
            type: "pool_name",
            requestId: "pool-name-2",
            provider: "openai-codex",
            model: "gpt-5.6-sol",
            name,
        }))).toBeUndefined();
    }
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
        response: { type: "tool_approval", decision: "allow_similar" },
    }))).toEqual({
        type: "ui_response",
        requestId: "request-2",
        response: { type: "tool_approval", decision: "allow_similar" },
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

socketTest(
    "identity request finishes when a peer closes without a response",
    async () => {
        const directory = mkdtempSync(join(tmpdir(), "vera-protocol-"));
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

socketTest(
    "identity request has a fixed deadline while a peer drips bytes",
    async () => {
        const directory = mkdtempSync(join(tmpdir(), "vera-protocol-"));
        const socketPath = join(directory, "host.sock");
        const server = createServer((socket) => {
            const drip = setInterval(() => socket.write(" "), 50);
            const stop = () => clearInterval(drip);
            socket.once("close", stop);
            // The client hangs up on its own deadline, so a drip can land on a
            // socket the peer has already finished. EPIPE is the expected end
            // of this connection, not a failure.
            socket.once("error", stop);
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

async function requestIdentityFromPeer(reply: string) {
    const directory = mkdtempSync(join(tmpdir(), "vera-protocol-"));
    const socketPath = join(directory, "host.sock");
    const server = createServer((socket) => socket.end(reply));
    try {
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, resolve);
        });
        return await requestHostIdentity(socketPath);
    } finally {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => error === undefined
                ? resolve()
                : reject(error));
        });
        rmSync(directory, { recursive: true, force: true });
    }
}

socketTest("host identity round trips role and worker fields", async () => {
    expect(await requestIdentityFromPeer(encodeHostResponse({
        type: "host_identity",
        pid: 202,
        started_at: "2026-07-17T12:00:00.000Z",
        protocol_version: HOST_PROTOCOL_VERSION,
        minimum_compatible_protocol_version:
            HOST_MIN_COMPATIBLE_PROTOCOL_VERSION,
        build_id: "vera-abc1234",
        role: "worker",
        worker_id: "w1",
        worker_generation: 7,
        worker_index: 1,
        worker_count: 4,
        workers_ready: 2,
    }))).toEqual({
        pid: 202,
        started_at: "2026-07-17T12:00:00.000Z",
        protocol_version: HOST_PROTOCOL_VERSION,
        minimum_compatible_protocol_version:
            HOST_MIN_COMPATIBLE_PROTOCOL_VERSION,
        build_id: "vera-abc1234",
        role: "worker",
        worker_id: "w1",
        worker_generation: 7,
        worker_index: 1,
        worker_count: 4,
        workers_ready: 2,
    });
});

socketTest("a worker identity rejects an invalid generation", async () => {
    const identity = {
        type: "host_identity", pid: 202, started_at: "2026-07-17T12:00:00.000Z",
        build_id: "vera-abc1234", role: "worker", worker_id: "w1", worker_generation: 0,
    };
    expect(await requestIdentityFromPeer(`${JSON.stringify(identity)}\n`)).toBeUndefined();
});

socketTest("an identity without a role parses as the host role", async () => {
    const oldIdentity = JSON.stringify({
        type: "host_identity",
        pid: 101,
        started_at: "2026-07-17T12:00:00.000Z",
        protocol_version: HOST_PROTOCOL_VERSION,
        minimum_compatible_protocol_version:
            HOST_MIN_COMPATIBLE_PROTOCOL_VERSION,
        build_id: "vera-abc1234",
    });
    expect(await requestIdentityFromPeer(`${oldIdentity}\n`)).toEqual({
        pid: 101,
        started_at: "2026-07-17T12:00:00.000Z",
        protocol_version: HOST_PROTOCOL_VERSION,
        minimum_compatible_protocol_version:
            HOST_MIN_COMPATIBLE_PROTOCOL_VERSION,
        build_id: "vera-abc1234",
        role: "host",
    });
});

test("locate_agent requests need a non-empty agent id", () => {
    expect(parseHostRequest('{"type":"locate_agent","agent_id":"agent-1"}'))
        .toEqual({ type: "locate_agent", agent_id: "agent-1" });
    expect(parseHostRequest('{"type":"locate_agent","agent_id":""}'))
        .toBeUndefined();
    expect(parseHostRequest('{"type":"locate_agent"}')).toBeUndefined();
});

test("agent location replies round trip through the wire encoding", () => {
    const found = {
        type: "agent_location",
        socket_path: "/runtime/host.sock",
        worker_id: "host",
        worker_generation: 1,
        build_id: "vera-abc1234",
    } as const;
    const failed = {
        type: "agent_location_failed",
        reason: "worker_unavailable",
        message: "The session is closed.",
    } as const;
    expect(parseAgentLocationReply(encodeHostResponse(found))).toEqual(found);
    expect(parseAgentLocationReply(encodeHostResponse(failed)))
        .toEqual(failed);
    expect(parseAgentLocationReply(JSON.stringify({
        ...found,
        socket_path: "host.sock",
    }))).toBeUndefined();
    expect(parseAgentLocationReply(JSON.stringify({
        ...found,
        worker_generation: 0,
    }))).toBeUndefined();
    expect(parseAgentLocationReply(JSON.stringify({
        ...failed,
        reason: "unknown",
    }))).toBeUndefined();
});

test("host stop-wait events encode to wire shapes and decode back", () => {
    const target = { session_id: "s1", name: null, status: "queued" as const };
    const update = stopWaitWireMessage({
        type: "wait",
        kind: "update",
        target_build_id: "build-9",
        waiting_on: [target],
    });
    expect(update).toEqual({
        type: "host_stop_wait",
        kind: "update",
        target_build_id: "build-9",
        waiting_on: [target],
    });
    expect(parseHostStopWaitEvent(JSON.parse(JSON.stringify(update)))).toEqual(update);

    const stop = stopWaitWireMessage({ type: "wait", kind: "stop", waiting_on: [] });
    expect(parseHostStopWaitEvent(stop)).toEqual({ type: "host_stop_wait", kind: "stop", waiting_on: [] });

    const cleared = stopWaitWireMessage({ type: "wait_cleared", reason: "abandoned", message: "no" });
    expect(parseHostStopWaitEvent(cleared)).toEqual(cleared);

    const restarting = stopWaitWireMessage({ type: "restarting", build_id: "build-9" });
    expect(restarting).toEqual({ type: "host_restarting", build_id: "build-9" });
    expect(parseHostStopWaitEvent(restarting)).toEqual(restarting);
});

test("host stop-wait decoder rejects malformed events", () => {
    expect(parseHostStopWaitEvent({ type: "host_stop_wait", kind: "update", waiting_on: [] })).toBeUndefined();
    expect(parseHostStopWaitEvent({ type: "host_stop_wait", kind: "stop", waiting_on: [{ session_id: "s1" }] }))
        .toBeUndefined();
    expect(parseHostStopWaitEvent({ type: "host_stop_wait_cleared", reason: "refused" })).toBeUndefined();
    expect(parseHostStopWaitEvent({ type: "host_restarting", build_id: "" })).toBeUndefined();
    expect(parseHostStopWaitEvent(null)).toBeUndefined();
});

test("host protocol parses cut_stop_wait and the forced stop_host flag", () => {
    expect(parseHostRequest('{"type":"cut_stop_wait"}')).toEqual({ type: "cut_stop_wait" });
    const identity = { pid: 101, started_at: "2026-07-17T12:00:00.123Z" };
    expect(parseHostRequest(JSON.stringify({ type: "stop_host", ...identity, force: true })))
        .toEqual({ type: "stop_host", ...identity, force: true });
    expect(parseHostRequest(JSON.stringify({ type: "stop_host", ...identity, force: false })))
        .toEqual({ type: "stop_host", ...identity });
    expect(parseHostRequest(JSON.stringify({ type: "stop_host", ...identity, force: "yes" })))
        .toBeUndefined();
});
