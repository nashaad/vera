import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHostLogger } from "../../src/host/host-log.ts";

test("host log appends timestamped JSONL entries", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-host-log-"));
    try {
        const path = join(directory, "nested", "host.jsonl");
        const log = createHostLogger({
            path,
            now: () => new Date("2026-08-05T12:00:00.000Z"),
        });
        log({ type: "ollama_discovery_listed", models: ["granite4.1:8b"] });
        log({ type: "ollama_catalog_written", models: [] });

        const lines = readFileSync(path, "utf8").trim().split("\n")
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(lines).toEqual([
            {
                timestamp: "2026-08-05T12:00:00.000Z",
                level: "debug",
                type: "ollama_discovery_listed",
                models: ["granite4.1:8b"],
            },
            {
                timestamp: "2026-08-05T12:00:00.000Z",
                level: "debug",
                type: "ollama_catalog_written",
                models: [],
            },
        ]);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("an unwritable host log path is swallowed", () => {
    const log = createHostLogger({ path: "/dev/null/not-a-directory/x.jsonl" });
    expect(() => log({ type: "ollama_discovery_listed" })).not.toThrow();
});
