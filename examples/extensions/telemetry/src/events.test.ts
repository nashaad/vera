import { describe, expect, test } from "bun:test";

import {
    MAX_ERROR_CHARS,
    cacheMissEvent,
    cutError,
    modelCallEvent,
    sessionEndEvent,
    telemetryDroppedEvent,
} from "./events.ts";

const TIME = "2026-01-01T12:00:00.000Z";
const IDENTITY = {
    session_id: "session-1",
    parent_session_id: "session-0",
    provider: "rookery",
    model: "crow-test",
    purpose: "turn" as const,
};
const CONTEXT = { install_id: "install-1", developer: "blackfeather" };

describe("event building", () => {
    test("a model call carries the common fields and the counts", () => {
        const event = modelCallEvent(IDENTITY, CONTEXT, {
            input_tokens: 120,
            cached_input_tokens: 100,
            output_tokens: 8,
            latency_ms: 40,
            stop_reason: "stop",
            cache_retention: "long",
            has_cache_key: true,
            message_count: 3,
            tool_count: 2,
            system_hash: "aaaaaaaaaaaa",
            tools_hash: "bbbbbbbbbbbb",
            message_hashes: ["cccccccccccc"],
            prefix_changed: "message:1",
        }, TIME);
        expect(event).toEqual({
            time: TIME,
            event: "model_call",
            install_id: "install-1",
            developer: "blackfeather",
            session_id: "session-1",
            parent_session_id: "session-0",
            provider: "rookery",
            model: "crow-test",
            purpose: "turn",
            input_tokens: 120,
            cached_input_tokens: 100,
            output_tokens: 8,
            latency_ms: 40,
            stop_reason: "stop",
            cache_retention: "long",
            has_cache_key: true,
            message_count: 3,
            tool_count: 2,
            system_hash: "aaaaaaaaaaaa",
            tools_hash: "bbbbbbbbbbbb",
            message_hashes: ["cccccccccccc"],
            prefix_changed: "message:1",
        });
    });

    test("absent optional fields are left out, not written as undefined", () => {
        const event = modelCallEvent(
            { session_id: "s", provider: "p", model: "m", purpose: "ask" },
            { install_id: "i" },
            {
                input_tokens: 0,
                cached_input_tokens: 0,
                output_tokens: 0,
                latency_ms: 0,
                stop_reason: "error",
                cache_retention: "short",
                has_cache_key: false,
                message_count: 0,
                tool_count: 0,
                system_hash: "",
                tools_hash: "",
                message_hashes: [],
                prefix_changed: null,
            },
            TIME,
        );
        const encoded = JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
        expect(encoded).not.toHaveProperty("developer");
        expect(encoded).not.toHaveProperty("parent_session_id");
        expect(encoded).not.toHaveProperty("error");
        expect(encoded).not.toHaveProperty("vera_version");
    });

    test("a cache miss carries both sides of the comparison", () => {
        const event = cacheMissEvent(IDENTITY, CONTEXT, {
            input_tokens: 20_000,
            cached_input_tokens: 1_500,
            previous_input_tokens: 20_000,
            previous_cached_input_tokens: 18_000,
            reread_tokens: 18_500,
            gap_ms: 30_000,
            prefix_changed: null,
        }, TIME);
        expect(event).toMatchObject({
            event: "cache_miss",
            session_id: "session-1",
            provider: "rookery",
            input_tokens: 20_000,
            previous_input_tokens: 20_000,
            previous_cached_input_tokens: 18_000,
            reread_tokens: 18_500,
            gap_ms: 30_000,
        });
    });

    test("a session end carries the hook's close reason", () => {
        const event = sessionEndEvent(IDENTITY, CONTEXT, "shutdown", TIME);
        expect(event.event).toBe("session_end");
        expect(event.reason).toBe("shutdown");
        expect(event.session_id).toBe("session-1");
    });

    test("a drop count is host-wide", () => {
        const event = telemetryDroppedEvent(CONTEXT, 12, TIME);
        expect(event).toMatchObject({
            event: "telemetry_dropped",
            install_id: "install-1",
            developer: "blackfeather",
            session_id: "",
            provider: "",
            model: "",
            purpose: "turn",
            dropped: 12,
        });
    });
});

describe("cutError", () => {
    test("keeps long messages to 300 characters", () => {
        expect(cutError("x".repeat(500))).toHaveLength(MAX_ERROR_CHARS);
    });

    test("counts code points, so an emoji is never split", () => {
        const text = cutError("🙂".repeat(400));
        expect(Array.from(text)).toHaveLength(MAX_ERROR_CHARS);
        expect(text).not.toContain("\uFFFD");
    });

    test("trims surrounding whitespace", () => {
        expect(cutError("  provider said no  ")).toBe("provider said no");
    });
});
