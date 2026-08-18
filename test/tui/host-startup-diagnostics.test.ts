import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readLatestHostStartupTiming } from
    "../../clients/tui/host-startup-diagnostics.ts";

test("startup diagnostics reads the latest completed host start", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-startup-diagnostics-"));
    const path = join(directory, "host.jsonl");
    try {
        writeFileSync(path, [
            entry("host_startup_phase", 900, { phase: "old" }),
            entry("host_startup_complete", 1_000),
            entry("host_startup_phase", 300, { phase: "model_discovery" }),
            entry("host_startup_extension", 1_320, {
                extension_id: "vera.mcp",
                outcome: "loaded",
            }),
            entry("host_startup_phase", 15, {
                phase: "server_listen_and_lockfile",
            }),
            entry("host_startup_complete", 1_676),
            "",
        ].join("\n"));

        expect(readLatestHostStartupTiming(path)).toEqual({
            totalMs: 1_676,
            rows: [{
                label: "model_discovery",
                durationMs: 300,
                outcome: "completed",
            }, {
                label: "extension · vera.mcp",
                durationMs: 1_320,
                outcome: "loaded",
            }, {
                label: "server_listen_and_lockfile",
                durationMs: 15,
                outcome: "completed",
            }],
        });
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

function entry(
    type: string,
    durationMs: number,
    fields: Readonly<Record<string, unknown>> = {},
): string {
    return JSON.stringify({
        type,
        duration_ms: durationMs,
        outcome: "completed",
        ...fields,
    });
}
