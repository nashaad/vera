import { expect, test } from "bun:test";

import { classifyVeraProcess } from "../../src/host/process-identity.ts";

test("recognizes source and bundled release processes", () => {
    for (const [source, bundled, kind] of [
        ["clients/host/main.ts", "bundle/clients/host/main.js", "host"],
        ["clients/cli/main.ts", "bundle/clients/cli/main.js", "client"],
        ["clients/tui/flight-watchdog.ts", "bundle/clients/tui/flight-watchdog.js", "watchdog"],
        ["src/host/worker/entry.ts", "bundle/src/host/worker/entry.js", "worker"],
        ["clients/host/session-worker.ts", "bundle/clients/host/session-worker.js", "worker"],
        ["src/host/worker-supervisor.ts", "bundle/src/host/worker-supervisor.js", "supervisor"],
    ] as const) {
        expect(classifyVeraProcess(`bun /release/${source} --arg`)).toBe(kind);
        expect(classifyVeraProcess(`bun /release/${bundled} --arg`)).toBe(kind);
    }
    expect(classifyVeraProcess("vera-bin --vera-role=host")).toBe("host");
    expect(classifyVeraProcess("vera-bin --vera-role=session-worker")).toBe("worker");
    expect(classifyVeraProcess("bun /unrelated/clients/host/main.js")).toBeUndefined();
});
