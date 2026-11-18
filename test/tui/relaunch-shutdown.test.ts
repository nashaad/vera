import { expect, test } from "bun:test";
import { relaunchAfterRecorderShutdown } from "../../clients/tui/main.ts";
import { launcherRelaunch } from "../../clients/tui/restart-notice.ts";

test("@core relaunch waits for recorder shutdown before invoking the launcher", async () => {
    const calls: string[] = [];
    const shutdown = Promise.withResolvers<void>();
    const relaunch = relaunchAfterRecorderShutdown({
        close: (reason) => {
            calls.push(`close:${reason}`);
            return shutdown.promise;
        },
    }, launcherRelaunch("777", {
        writeRecord: (key, record) => { calls.push(`write:${key}:${record.sessionId}`); },
        markTerminalRestored: () => { calls.push("restored"); },
        exit: (code) => { calls.push(`exit:${code}`); },
    }));
    expect(relaunch).toBeDefined();
    const pending = relaunch!({ sessionId: "crow" });
    await Promise.resolve();
    expect(calls).toEqual(["close:relaunch"]);
    shutdown.resolve();
    await pending;
    expect(calls).toEqual(["close:relaunch", "write:777:crow", "restored", "exit:85"]);
});

test("@core failed recorder shutdown prevents launcher relaunch", async () => {
    let invoked = false;
    const relaunch = relaunchAfterRecorderShutdown({
        close: async () => { throw new Error("watchdog still running"); },
    }, async () => { invoked = true; });
    await expect(relaunch!({})).rejects.toThrow("watchdog still running");
    expect(invoked).toBe(false);
});

test("@core a TUI without a launcher retains its reconnect path", () => {
    let closed = false;
    const relaunch = relaunchAfterRecorderShutdown({
        close: async () => { closed = true; },
    }, undefined);
    expect(relaunch).toBeUndefined();
    expect(closed).toBe(false);
});
