import { expect, test } from "bun:test";

import { runCli } from "../../clients/cli/main.ts";

test("vera --version does not dispatch to a retained client", async () => {
    let dispatched = 0;
    let output = "";
    expect(await runCli(["--version"], {
        version: "vera 0.0.4 (vera-c)",
        dispatchToHostRelease: async () => {
            dispatched += 1;
            return 0;
        },
        stdout: { write: (text) => output += text },
    })).toBe(0);
    expect(output).toBe("vera 0.0.4 (vera-c)\n");
    expect(dispatched).toBe(0);
});

test("vera host stop runs the live host build's client", async () => {
    let argv: readonly string[] | undefined;
    expect(await runCli(["host", "stop"], {
        dispatchToHostRelease: async (passed) => {
            argv = passed;
            return 0;
        },
        confirmHostStop: () => {
            throw new Error("activated client must not stop the host");
        },
    })).toBe(0);
    expect(argv).toEqual(["host", "stop"]);
});

test("an empty vera invocation dispatches before starting the TUI", async () => {
    let dispatched = 0;
    let started = false;
    expect(await runCli([], {
        dispatchToHostRelease: async () => {
            dispatched += 1;
            return 3;
        },
        runTui: async () => {
            started = true;
        },
    })).toBe(3);
    expect(dispatched).toBe(1);
    expect(started).toBe(false);
});
