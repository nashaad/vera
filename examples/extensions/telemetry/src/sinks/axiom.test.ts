import { describe, expect, test } from "bun:test";

import { modelCallEvent, sessionEndEvent, type TelemetryEvent } from "../events.ts";
import { axiomSink } from "./axiom.ts";

const TIME = "2026-01-01T12:00:00.000Z";
const IDENTITY = { session_id: "session-1", provider: "rookery", model: "crow-test", purpose: "turn" as const };

const CALL: TelemetryEvent = modelCallEvent(IDENTITY, { install_id: "install-1" }, {
    input_tokens: 120,
    cached_input_tokens: 100,
    output_tokens: 8,
    latency_ms: 40,
    stop_reason: "stop",
    cache_retention: "short",
    has_cache_key: true,
    message_count: 3,
    tool_count: 2,
    system_hash: "aaaaaaaaaaaa",
    tools_hash: "bbbbbbbbbbbb",
    message_hashes: ["cccccccccccc"],
    prefix_changed: null,
}, TIME);

interface Captured {
    readonly url: string;
    readonly init: RequestInit;
}

function fakeFetch(status = 200): { calls: Captured[]; fetch: typeof fetch } {
    const calls: Captured[] = [];
    const transport = (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} });
        return new Response("{}", { status });
    }) as typeof fetch;
    return { calls, fetch: transport };
}

function headers(init: RequestInit): Record<string, string> {
    return init.headers as Record<string, string>;
}

describe("axiomSink", () => {
    test("posts the batch to the edge ingest endpoint", async () => {
        const transport = fakeFetch();
        const sink = axiomSink({
            url: "https://us-east-1.aws.edge.axiom.co",
            dataset: "crow-nest",
            token: "xaat-secret",
            fetch: transport.fetch,
        });
        await sink.send([CALL]);

        expect(transport.calls).toHaveLength(1);
        expect(transport.calls[0]!.url).toBe(
            "https://us-east-1.aws.edge.axiom.co/v1/ingest/crow-nest?timestamp-field=_time",
        );
        expect(transport.calls[0]!.init.method).toBe("POST");
        expect(headers(transport.calls[0]!.init)).toEqual({
            Authorization: "Bearer xaat-secret",
            "Content-Type": "application/json",
        });
    });

    test("maps the event time to Axiom's _time field and keeps the rest", async () => {
        const transport = fakeFetch();
        const sink = axiomSink({
            url: "https://us-east-1.aws.edge.axiom.co",
            dataset: "crow-nest",
            token: "t",
            fetch: transport.fetch,
        });
        await sink.send([CALL]);

        const body = JSON.parse(String(transport.calls[0]!.init.body)) as Record<string, unknown>[];
        expect(Array.isArray(body)).toBe(true);
        expect(body).toHaveLength(1);
        expect(body[0]!._time).toBe(TIME);
        expect(body[0]).not.toHaveProperty("time");
        expect(body[0]).toMatchObject({
            event: "model_call",
            install_id: "install-1",
            input_tokens: 120,
            message_hashes: ["cccccccccccc"],
        });
    });

    test("sends a trailing-slash URL without doubling the slash", async () => {
        const transport = fakeFetch();
        const sink = axiomSink({
            url: "https://logs.example.test/edge/",
            dataset: "crow-nest",
            token: "t",
            fetch: transport.fetch,
        });
        await sink.send([sessionEndEvent(IDENTITY, { install_id: "i" }, "closed", TIME)]);
        expect(transport.calls[0]!.url).toBe("https://logs.example.test/edge/v1/ingest/crow-nest?timestamp-field=_time");
    });

    test("throws on a rejected ingest and names the status", async () => {
        const transport = fakeFetch(403);
        const sink = axiomSink({
            url: "https://us-east-1.aws.edge.axiom.co",
            dataset: "crow-nest",
            token: "t",
            fetch: transport.fetch,
        });
        await expect(sink.send([CALL])).rejects.toThrow("status 403");
    });

    test("an empty batch makes no request", async () => {
        const transport = fakeFetch();
        const sink = axiomSink({
            url: "https://us-east-1.aws.edge.axiom.co",
            dataset: "crow-nest",
            token: "t",
            fetch: transport.fetch,
        });
        await sink.send([]);
        expect(transport.calls).toHaveLength(0);
    });
});
