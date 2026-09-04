import { expect, test } from "bun:test";

import {
    awaitingRuntime,
    downloadSize,
    OUTRIDER_INSTALL_URL_DEFAULT,
    outriderInstallCommand,
    outriderInstallUrl,
    outriderListCommand,
    outriderServeCommand,
    outriderStatusCommand,
    parseOutriderProgress,
    outriderMarkerPaths,
    readInstallMarker,
    readInstallPath,
    readOutriderProfiles,
    readOutriderStatus,
    readOutriderVerdict,
    remaining,
    shortOfMemory,
} from "../../src/providers/outrider.ts";

test("the commands are the ones the CLI actually has", () => {
    expect(outriderStatusCommand()).toEqual(["outrider", "--json", "ps"]);
    expect(outriderServeCommand("qwen35b-mtp"))
        .toEqual(["outrider", "--json", "serve", "qwen35b-mtp"]);
    expect(outriderInstallCommand()[0]).toBe("sh");
});

test("the install URL comes from the environment, and stays an argument", () => {
    const before = process.env.OUTRIDER_INSTALL_URL;
    try {
        delete process.env.OUTRIDER_INSTALL_URL;
        expect(outriderInstallUrl()).toBe(OUTRIDER_INSTALL_URL_DEFAULT);

        process.env.OUTRIDER_INSTALL_URL = "http://127.0.0.1:8000/install.sh";
        const local = outriderInstallCommand();
        expect(local[0]).toBe("sh");
        expect(local[1]).toBe("-c");
        expect(local.at(-1)).toBe("http://127.0.0.1:8000/install.sh");
        // The download lands in a file that is run afterwards. Piped straight
        // into sh, the pipeline would answer for the sh, which succeeds on the
        // empty input a failed download leaves behind.
        expect(local[2]).toContain("set -e");
        expect(local[2]).not.toMatch(/curl[^;]*\|\s*sh/);

        // A URL spliced into the script would put everything after the
        // semicolon on the command line. As an argument it is one string.
        process.env.OUTRIDER_INSTALL_URL = "http://x/i.sh; echo pwned";
        const command = outriderInstallCommand();
        expect(command.at(-1)).toBe("http://x/i.sh; echo pwned");
        expect(command[2]).not.toContain("pwned");

        process.env.OUTRIDER_INSTALL_URL = "";
        expect(outriderInstallUrl()).toBe(OUTRIDER_INSTALL_URL_DEFAULT);
    } finally {
        if (before === undefined) delete process.env.OUTRIDER_INSTALL_URL;
        else process.env.OUTRIDER_INSTALL_URL = before;
    }
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

/** A cold home, as the gateway actually reports it: everything passes but the runtime, which is not on the machine until `serve` fetches it. */
const COLD_HOME_CHECK = JSON.stringify({
    profile: "qwen35b-mtp",
    class: "degraded",
    checks: [
        { id: "platform", result: "pass" },
        { id: "artifact", result: "pass" },
        { id: "state_directory", result: "pass" },
        {
            id: "disk_space",
            result: "pass",
            measured: "86920040448 bytes",
            required: "22674477247 bytes",
        },
        {
            id: "physical_memory",
            result: "pass",
            measured: "68719476736 bytes",
            required: "validated at 68719476736 bytes",
        },
        {
            id: "memory_pressure",
            result: "pass",
            measured: "92% free",
            required: "at least 10% free",
        },
        { id: "port", result: "pass" },
        {
            id: "runtime_capabilities",
            result: "warn",
            measured: "runtime executable unavailable",
            required: "every profile flag advertised by llama-server",
            nextAction:
                "install the pinned runtime before treating this report as complete",
        },
    ],
});

test("a cold home reads as degraded only because the runtime is missing", () => {
    const verdict = readOutriderVerdict(COLD_HOME_CHECK);
    expect(verdict.verdict).toBe("degraded");
    expect(verdict.checks).toHaveLength(8);
    // The word alone would send the user away from a machine that runs it fine.
    expect(awaitingRuntime(verdict)).toBe(true);
    expect(shortOfMemory(verdict)).toBe(false);
});

test("the memory warning is told apart from the runtime warning", () => {
    const small = JSON.stringify({
        class: "degraded",
        checks: [
            {
                id: "physical_memory",
                result: "warn",
                measured: "17179869184 bytes",
                required: "validated at 68719476736 bytes",
            },
            { id: "runtime_capabilities", result: "pass" },
        ],
    });
    const verdict = readOutriderVerdict(small);
    expect(shortOfMemory(verdict)).toBe(true);
    expect(awaitingRuntime(verdict)).toBe(false);
    expect(verdict.checks[0]?.measured).toBe("17179869184 bytes");
});

test("a report that is not JSON leaves no verdict to act on", () => {
    expect(readOutriderVerdict("not json")).toEqual({
        verdict: "unknown",
        checks: [],
    });
    // A line with no id or no result cannot be reasoned about, so it is dropped
    // rather than guessed at.
    const partial = readOutriderVerdict(
        JSON.stringify({ class: "ready", checks: [{ id: "port" }, 7] }),
    );
    expect(partial.verdict).toBe("ready");
    expect(partial.checks).toEqual([]);
});

test("the binary to run can be a path, because an install does not change PATH", () => {
    expect(outriderStatusCommand()).toEqual(["outrider", "--json", "ps"]);
    expect(outriderStatusCommand("/Users/x/.local/bin/outrider"))
        .toEqual(["/Users/x/.local/bin/outrider", "--json", "ps"]);
    expect(outriderServeCommand("qwen35-2b", "/Users/x/.local/bin/outrider"))
        .toEqual([
            "/Users/x/.local/bin/outrider",
            "--json",
            "serve",
            "qwen35-2b",
        ]);
    expect(outriderListCommand("/Users/x/.local/bin/outrider"))
        .toEqual(["/Users/x/.local/bin/outrider", "ls", "--json"]);
});

test("the installer names where it put the binary", () => {
    const stdout = [
        "outrider-install-path=/Users/x/.local/bin/outrider",
        "installed outrider to /Users/x/.local/bin/outrider",
    ].join("\n");
    expect(readInstallPath(stdout)).toBe("/Users/x/.local/bin/outrider");

    // An older installer says nothing, which leaves the caller its lookup.
    expect(readInstallPath("installed outrider to /somewhere\n"))
        .toBeUndefined();
    expect(readInstallPath("outrider-install-path=\n")).toBeUndefined();

    // The first one wins, so a later line cannot move the answer.
    const twice = [
        "outrider-install-path=/first/outrider",
        "outrider-install-path=/second/outrider",
    ].join("\n");
    expect(readInstallPath(twice)).toBe("/first/outrider");
});

test("an earlier install is found through the record Outrider keeps", () => {
    expect(outriderMarkerPaths("/Users/x")).toEqual([
        "/Users/x/.local/share/outrider/install.json",
        "/usr/local/share/outrider/install.json",
    ]);

    // No home leaves only the packaged install to look at.
    expect(outriderMarkerPaths("")).toEqual([
        "/usr/local/share/outrider/install.json",
    ]);

    const marker = JSON.stringify({
        schema: 1,
        target: "/Users/x/.local/bin/outrider",
        sha256: "9b26",
    });
    expect(readInstallMarker(marker)).toBe("/Users/x/.local/bin/outrider");

    expect(readInstallMarker("not json")).toBeUndefined();
    expect(readInstallMarker("{}")).toBeUndefined();
    expect(readInstallMarker(JSON.stringify({ target: "" }))).toBeUndefined();
    expect(readInstallMarker(JSON.stringify({ target: 7 }))).toBeUndefined();
});

test("the roster is whatever the catalog listed, in its order", () => {
    const catalog = JSON.stringify({
        profiles: [
            { id: "qwen35b-mtp", runnable: true },
            { id: "qwen35-2b", runnable: true },
        ],
        developmentModels: [],
    });
    expect(readOutriderProfiles(catalog))
        .toEqual(["qwen35b-mtp", "qwen35-2b"]);

    // Nothing to pick from is an empty roster, never a throw.
    expect(readOutriderProfiles("not json")).toEqual([]);
    expect(readOutriderProfiles("{}")).toEqual([]);
    expect(readOutriderProfiles(JSON.stringify({ profiles: [{}, { id: "" }] })))
        .toEqual([]);
});
