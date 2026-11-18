import { expect, test } from "bun:test";

import { runCli } from "../../clients/cli/main.ts";
import type { HostRequester } from "../../src/host/requester.ts";

for (const force of [false, true]) {
    test(`the CLI identifies a ${force ? "forced" : "plain"} host stop`, async () => {
        let requester: HostRequester | undefined;
        const code = await runCli(["host", "stop", ...(force ? ["--force"] : []), "--yes"], {
            stopHost: async (options) => { requester = options.requester; return { pid: 17, endedBy: "stopped" }; },
            forceStopHost: async () => { throw new Error("Unexpected signal fallback"); },
            stdout: { write: () => {} },
        });
        expect(code).toBe(0);
        expect(requester).toEqual({
            pid: process.pid, client_kind: "cli", command: force ? "host stop --force" : "host stop",
        });
    });
}

test("the CLI identifies a host reset request", async () => {
    let requester: HostRequester | undefined;
    const code = await runCli(["host", "reset", "--yes"], {
        hostReset: async (options) => { requester = options.requester; return 0; },
        stdout: { write: () => {} },
    });
    expect(code).toBe(0);
    expect(requester).toEqual({ pid: process.pid, client_kind: "cli", command: "host reset" });
});
