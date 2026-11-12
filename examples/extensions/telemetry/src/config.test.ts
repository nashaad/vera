import { describe, expect, test } from "bun:test";

import { DEFAULT_AXIOM_URL, telemetryConfig } from "./config.ts";

describe("telemetryConfig", () => {
    test("no config entry and no sink both mean off", () => {
        expect(telemetryConfig(undefined)).toBeNull();
        expect(telemetryConfig(null)).toBeNull();
        expect(telemetryConfig({})).toBeNull();
        expect(telemetryConfig({ sink: null })).toBeNull();
    });

    test("a full axiom entry keeps every value", () => {
        const config = telemetryConfig({
            sink: { type: "axiom", dataset: "crow-nest", token: "xaat-secret" },
            developer: "  blackfeather  ",
            flush_seconds: 5,
            cache_miss: { min_reread_tokens: 4096, min_share: 0.25 },
        });
        expect(config).toEqual({
            sink: { type: "axiom", dataset: "crow-nest", token: "xaat-secret", url: DEFAULT_AXIOM_URL },
            developer: "blackfeather",
            flushSeconds: 5,
            cacheMiss: { min_reread_tokens: 4096, min_share: 0.25 },
        });
    });

    test("axiom defaults the edge URL and the flush interval", () => {
        const config = telemetryConfig({ sink: { type: "axiom", dataset: "crow-nest", token: "xaat-secret" } });
        expect(config?.sink).toEqual({
            type: "axiom",
            dataset: "crow-nest",
            token: "xaat-secret",
            url: DEFAULT_AXIOM_URL,
        });
        expect(config?.flushSeconds).toBe(10);
        expect(config?.cacheMiss).toEqual({ min_reread_tokens: 8192, min_share: 0.5 });
        expect(config?.developer).toBeUndefined();
    });

    test("a custom Axiom URL loses its trailing slash", () => {
        const config = telemetryConfig({
            sink: { type: "axiom", dataset: "crow-nest", token: "t", url: "https://logs.example.test/" },
        });
        expect(config?.sink).toEqual({
            type: "axiom",
            dataset: "crow-nest",
            token: "t",
            url: "https://logs.example.test",
        });
    });

    test("jsonl needs nothing else", () => {
        expect(telemetryConfig({ sink: { type: "jsonl" } })).toEqual({
            sink: { type: "jsonl" },
            flushSeconds: 10,
            cacheMiss: { min_reread_tokens: 8192, min_share: 0.5 },
        });
    });

    const invalid: readonly [string, unknown][] = [
        ["a bare array", []],
        ["a string config", "axiom"],
        ["a string sink", { sink: "axiom" }],
        ["an unknown sink type", { sink: { type: "splunk" } }],
        ["a missing token", { sink: { type: "axiom", dataset: "crow-nest" } }],
        ["a blank token", { sink: { type: "axiom", dataset: "crow-nest", token: "   " } }],
        ["a missing dataset", { sink: { type: "axiom", token: "t" } }],
        ["a blank dataset", { sink: { type: "axiom", dataset: "   ", token: "t" } }],
        ["a non-http url", { sink: { type: "axiom", dataset: "crow-nest", token: "t", url: "ftp://logs" } }],
        ["a malformed url", { sink: { type: "axiom", dataset: "crow-nest", token: "t", url: "not a url" } }],
        ["a zero flush interval", { sink: { type: "jsonl" }, flush_seconds: 0 }],
        ["a negative flush interval", { sink: { type: "jsonl" }, flush_seconds: -1 }],
        ["a cache_miss that is not an object", { sink: { type: "jsonl" }, cache_miss: 5 }],
        ["a negative reread floor", { sink: { type: "jsonl" }, cache_miss: { min_reread_tokens: -1 } }],
        ["a reread floor that is not whole", { sink: { type: "jsonl" }, cache_miss: { min_reread_tokens: 1.5 } }],
        ["a share over 1", { sink: { type: "jsonl" }, cache_miss: { min_share: 1.5 } }],
        ["a negative share", { sink: { type: "jsonl" }, cache_miss: { min_share: -0.1 } }],
        ["a developer that is not a string", { sink: { type: "jsonl" }, developer: 7 }],
    ];

    for (const [name, value] of invalid) {
        test(`rejects ${name}`, () => {
            expect(() => telemetryConfig(value)).toThrow(/^telemetry: /);
        });
    }

    test("an error names the field and never the token", () => {
        let message = "";
        try {
            telemetryConfig({ sink: { type: "axiom", dataset: "crow-nest", token: "" } });
        } catch (error) {
            message = (error as Error).message;
        }
        expect(message).toContain("sink.token");
        expect(message).not.toContain("xaat");
    });
});
