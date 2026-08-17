import { expect, test } from "bun:test";

import { EngineEventBus } from "../../src/engine/events.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { createProtocolEncoder, parseClientCommand } from "../../src/engine/protocol.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import type { ModelTurnSettings } from "../../src/engine/model-settings.ts";

test("the session-scoped command parses on its own, not as a flag", () => {
    expect(parseClientCommand({
        type: "update_session_model_settings",
        requestId: "one",
        patch: { model: "luna" },
    })).toEqual({
        type: "update_session_model_settings",
        requestId: "one",
        patch: { model: "luna" },
    });
    expect(parseClientCommand({
        type: "get_session_model_settings_history",
        requestId: "two",
    })).toEqual({
        type: "get_session_model_settings_history",
        requestId: "two",
    });
    expect(parseClientCommand({
        type: "update_session_permission_mode",
        requestId: "three",
        mode: "readonly",
    })).toEqual({
        type: "update_session_permission_mode",
        requestId: "three",
        mode: "readonly",
    });
    // A mode the host has never heard of is not a mode.
    expect(parseClientCommand({
        type: "update_session_permission_mode",
        requestId: "four",
        mode: 7,
    })).toBeUndefined();
});

test("a session-scoped write never claims it changed the defaults", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    let written: ModelTurnSettings | undefined;
    new InboundCommandRouter(channel.engine, events, {
        readModelSettings: () => ({ model: "sol", reasoningEffort: "low" }),
        async updateSessionModelSettings(patch) {
            written = { model: patch.model ?? "sol" };
            return { settings: written, origin: "user" };
        },
    });

    channel.client.send({
        type: "update_session_model_settings",
        requestId: "dial",
        patch: { model: "luna" },
    });
    const update = await channel.client.receive();
    expect(update).toEqual({
        type: "model_settings",
        requestId: "dial",
        settings: { model: "luna" },
        pending: false,
        updatedSession: true,
        origin: "user",
        seq: 1,
    });
    expect(Reflect.get(update, "updatedDefaults")).toBeUndefined();
    expect(written).toEqual({ model: "luna" });
});

test("a host without the seam refuses rather than writing the defaults", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    new InboundCommandRouter(channel.engine, events, {});

    channel.client.send({
        type: "update_session_model_settings",
        requestId: "dial",
        patch: { model: "luna" },
    });
    expect(await channel.client.receive()).toEqual({
        type: "model_settings_rejected",
        requestId: "dial",
        reason: "unavailable",
        seq: 1,
    });
});

test("the strip reads its recents from the session rather than its own list", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    new InboundCommandRouter(channel.engine, events, {
        readSessionModelSettingsHistory: () => [
            {
                settings: { model: "sol", reasoningEffort: "low" },
                origin: "agent-default",
                timestamp: "2026-08-17T00:00:00.000Z",
            },
            {
                settings: { model: "luna", reasoningEffort: "high" },
                origin: "user",
                timestamp: "2026-08-17T00:01:00.000Z",
            },
        ],
    });

    channel.client.send({
        type: "get_session_model_settings_history",
        requestId: "recents",
    });
    expect(await channel.client.receive()).toEqual({
        type: "session_model_settings_history",
        requestId: "recents",
        entries: [
            {
                settings: { model: "sol", reasoningEffort: "low" },
                origin: "agent-default",
                timestamp: "2026-08-17T00:00:00.000Z",
            },
            {
                settings: { model: "luna", reasoningEffort: "high" },
                origin: "user",
                timestamp: "2026-08-17T00:01:00.000Z",
            },
        ],
        seq: 1,
    });
});
