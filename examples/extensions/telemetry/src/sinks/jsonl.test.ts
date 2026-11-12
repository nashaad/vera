import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { modelCallEvent } from "../events.ts";
import { JSONL_FILE, jsonlSink } from "./jsonl.ts";

const TIME = "2026-01-01T12:00:00.000Z";
const IDENTITY = { session_id: "session-1", provider: "rookery", model: "crow-test", purpose: "turn" as const };

const directories: string[] = [];

async function scratch(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "telemetry-jsonl-"));
    directories.push(directory);
    return directory;
}

afterEach(async () => {
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function call(): ReturnType<typeof modelCallEvent> {
    return modelCallEvent(IDENTITY, { install_id: "install-1" }, {
        input_tokens: 1,
        cached_input_tokens: 0,
        output_tokens: 1,
        latency_ms: 2,
        stop_reason: "stop",
        cache_retention: "short",
        has_cache_key: false,
        message_count: 1,
        tool_count: 0,
        system_hash: "aaaaaaaaaaaa",
        tools_hash: "bbbbbbbbbbbb",
        message_hashes: [],
        prefix_changed: null,
    }, TIME);
}

describe("jsonlSink", () => {
    test("appends one JSON line per event", async () => {
        const directory = await scratch();
        const sink = jsonlSink(directory);
        await sink.send([call()]);
        await sink.send([call()]);

        const lines = (await readFile(join(directory, JSONL_FILE), "utf8")).trim().split("\n");
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0]!)).toEqual(JSON.parse(JSON.stringify(call())));
        expect(JSON.parse(lines[0]!).event).toBe("model_call");
    });

    test("creates the profile directory when it is missing", async () => {
        const directory = join(await scratch(), "nested", "profile");
        await jsonlSink(directory).send([call()]);
        const lines = (await readFile(join(directory, JSONL_FILE), "utf8")).trim().split("\n");
        expect(lines).toHaveLength(1);
    });

    test("an empty batch writes nothing", async () => {
        const directory = await scratch();
        await jsonlSink(directory).send([]);
        await expect(readFile(join(directory, JSONL_FILE), "utf8")).rejects.toThrow();
    });
});
