import { expect, test } from "bun:test";

import {
    downloadSize,
    outriderInstallCommand,
    outriderServeCommand,
    outriderStatusCommand,
    parseOutriderProgress,
    readOutriderStatus,
    remaining,
} from "../../src/providers/outrider.ts";

test("the commands are the ones the CLI actually has", () => {
    expect(outriderStatusCommand()).toEqual(["outrider", "ps"]);
    expect(outriderServeCommand("qwen35b-mtp"))
        .toEqual(["outrider", "serve", "qwen35b-mtp"]);
    expect(outriderInstallCommand()[0]).toBe("sh");
});

test("a healthy running gateway is the only thing that reads as running", () => {
    const running = JSON.stringify({
        kind: "running",
        pid: 42,
        preset: "granite4.2-3b",
        endpoint: "http://127.0.0.1:11435",
        health: true,
    });
    expect(readOutriderStatus(running)).toEqual({
        state: "running",
        endpoint: "http://127.0.0.1:11435",
        profile: "granite4.2-3b",
    });
    const unhealthy = JSON.stringify({
        kind: "running",
        endpoint: "http://127.0.0.1:11435",
        health: false,
    });
    expect(readOutriderStatus(unhealthy).state).toBe("stopped");
    expect(readOutriderStatus(JSON.stringify({ kind: "stale" })).state)
        .toBe("stopped");
});

test("output that is not a status is not read as one", () => {
    expect(readOutriderStatus("outrider: no such profile").state)
        .toBe("stopped");
});

test("a download line carries its bytes, a step line does not", () => {
    const download = parseOutriderProgress(JSON.stringify({
        name: "qwen35b-mtp",
        downloaded: 8_400_000_000,
        total: 21_000_000_000,
        bytes_per_second: 15_000_000,
        eta_seconds: 840,
        done: false,
    }));
    expect(download).toEqual({
        name: "qwen35b-mtp",
        done: false,
        downloaded: 8_400_000_000,
        total: 21_000_000_000,
        bytesPerSecond: 15_000_000,
        etaSeconds: 840,
    });
    expect(parseOutriderProgress(JSON.stringify({
        name: "starting on 127.0.0.1:11435",
        done: true,
    }))).toEqual({ name: "starting on 127.0.0.1:11435", done: true });
});

test("the human bar on the same stream is skipped, not read as a line", () => {
    for (
        const line of [
            "\rllama.cpp [####--------] 4.0 GB / 12.0 GB  15 MB/s eta 9m[K",
            "",
            "{ not json",
            JSON.stringify({ done: true }),
        ]
    ) {
        expect(parseOutriderProgress(line)).toBeUndefined();
    }
});

test("sizes and waits are said the way a person reads them", () => {
    expect(downloadSize(21_000_000_000)).toBe("21.0 GB");
    expect(downloadSize(9_400_000)).toBe("9.4 MB");
    expect(remaining(45)).toBe("~45 sec");
    expect(remaining(840)).toBe("~14 min");
});
