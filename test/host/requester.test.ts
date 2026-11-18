import { expect, test } from "bun:test";

import { cliHostRequester, HOST_REQUESTER_KIND_ENV, hostRequester } from "../../src/host/requester.ts";

test("requester identifies the calling process and preserves known session details", () => {
    expect(hostRequester("tui", "reconnect host", { id: "s1", name: "work" })).toEqual({
        pid: process.pid, client_kind: "tui", command: "reconnect host", session_id: "s1", session_name: "work",
    });
    expect(hostRequester("tui", "startup", { id: "x".repeat(257), name: "bad\0name" }))
        .toEqual({ pid: process.pid, client_kind: "tui", command: "startup" });
});

test("the desktop boot marker identifies the CLI child as a desktop request", () => {
    const previous = process.env[HOST_REQUESTER_KIND_ENV];
    try {
        process.env[HOST_REQUESTER_KIND_ENV] = "desktop";
        expect(cliHostRequester("boot")).toEqual({ pid: process.pid, client_kind: "desktop", command: "boot" });
        process.env[HOST_REQUESTER_KIND_ENV] = "other";
        expect(cliHostRequester("boot")).toEqual({ pid: process.pid, client_kind: "cli", command: "boot" });
    } finally {
        if (previous === undefined) delete process.env[HOST_REQUESTER_KIND_ENV];
        else process.env[HOST_REQUESTER_KIND_ENV] = previous;
    }
});
