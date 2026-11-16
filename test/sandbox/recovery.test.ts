import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxManager as Srt } from "@anthropic-ai/sandbox-runtime";

import type { SandboxConfig } from "../../src/config/sandbox.ts";
import type { HostLogEntry } from "../../src/host/host-log.ts";
import { SandboxManager } from "../../src/sandbox/manager.ts";
import {
    logStamp,
    logWindows,
    type SandboxLogReader,
    type SandboxLogWindow,
} from "../../src/sandbox/recovery.ts";

const mac = process.platform === "darwin";
const enabled: SandboxConfig = {
    enabled: true,
    network: "open",
    allowed_domains: [],
};

const directories: string[] = [];

afterAll(() => {
    for (const directory of directories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function workspace(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-sandbox-recovery-"));
    directories.push(directory);
    return directory;
}

function kernelMessage(
    commandId: string,
    suffix: string,
    target: string,
): string {
    const tag = Buffer.from(commandId).toString("base64");
    return `Sandbox: bash(1) deny(1) file-write-create ${target}\nCMD64_${tag}_END__${suffix}_SBX`;
}

function clock(start = 1_000_000) {
    let time = start;
    return {
        now: (): number => time,
        advance: (ms: number): void => {
            time += ms;
        },
    };
}

async function preparedCommand(
    sandbox: SandboxManager,
    root: string,
    toolCallId: string,
) {
    const preparation = await sandbox.prepare({
        command: "echo ok",
        cwd: root,
        env: {},
        workspace: root,
        sessionId: "session-recovery",
        toolCallId,
    });
    expect(preparation.prepared).toBeDefined();
    return preparation.prepared!;
}

test("@core log windows merge close spans and cut long ones", () => {
    const windows = logWindows([
        { start: 10_000, end: 12_000 },
        { start: 13_000, end: 14_000 },
    ]);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ start: 8_000, end: 16_000, span: 0 });

    const long = logWindows([
        { start: 0, end: 12 * 60 * 1000 },
    ]);
    expect(long).toHaveLength(3);
    for (const window of long) {
        expect(window.end - window.start).toBeLessThanOrEqual(5 * 60 * 1000);
    }
    expect(long[0]!.end).toBe(long[1]!.start);
    expect(long[1]!.end).toBe(long[2]!.start);
    expect(new Set(long.map((window) => window.span))).toEqual(new Set([0]));
});

test("@core the log stamp carries the local UTC offset", () => {
    const moduleUrl = new URL("../../src/sandbox/recovery.ts", import.meta.url).href;
    const script = `import { logStamp } from ${JSON.stringify(moduleUrl)}; console.log(logStamp(0));`;
    const result = Bun.spawnSync([process.execPath, "-e", script], {
        env: { ...process.env, TZ: "Asia/Tokyo" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe("1970-01-01 09:00:00+0900");
    expect(logStamp(0)).toMatch(/0[+-]\d{4}$/);
});

test("@core a denial the monitor missed is recovered exactly once", async () => {
    if (!mac) return;
    const root = workspace();
    const entries: HostLogEntry[] = [];
    const calls: SandboxLogWindow[] = [];
    let commandId = "";
    const reader: SandboxLogReader = async (window) => {
        calls.push(window);
        return [kernelMessage(commandId, window.suffix, join(root, "elsewhere", "f"))];
    };
    const sandbox = new SandboxManager({
        config: () => enabled,
        permissionRules: () => [],
        log: (entry) => entries.push(entry),
        monitorTimeoutMs: 100,
        recoveryDelayMs: 1,
        readLogEvents: reader,
    });
    try {
        const prepared = await preparedCommand(sandbox, root, "call-recovery");
        commandId = prepared.commandId;
        sandbox.commandEnded(prepared);

        sandbox.turnEnded();
        await sandbox.whenRecoveryIdle();
        // A turn with no command since the last query asks nothing.
        sandbox.turnEnded();
        await sandbox.whenRecoveryIdle();

        expect(calls).toHaveLength(1);
        const recovered = entries.filter(
            (entry) => entry.type === "sandbox_violation",
        );
        expect(recovered).toHaveLength(1);
        expect(recovered[0]).toMatchObject({
            type: "sandbox_violation",
            recovered: true,
            session_id: "session-recovery",
            tool_call_id: "call-recovery",
            command_id: commandId,
            kind: "write",
        });
        expect(recovered[0]?.raw).toContain("file-write-create");
    } finally {
        await sandbox.dispose();
    }
});

test("@core a line logged live is not recovered again", async () => {
    if (!mac) return;
    const root = workspace();
    const entries: HostLogEntry[] = [];
    const target = join(root, "elsewhere", "g");
    let commandId = "";
    const reader: SandboxLogReader = async (window) => [
        kernelMessage(commandId, window.suffix, target),
    ];
    const sandbox = new SandboxManager({
        config: () => enabled,
        permissionRules: () => [],
        log: (entry) => entries.push(entry),
        monitorTimeoutMs: 100,
        recoveryDelayMs: 1,
        readLogEvents: reader,
    });
    try {
        const prepared = await preparedCommand(sandbox, root, "call-live");
        commandId = prepared.commandId;
        Srt.getSandboxViolationStore().addViolation({
            encodedCommand: Buffer.from(commandId).toString("base64"),
            line: `bash(1) deny(1) file-write-create ${target}`,
            timestamp: new Date(),
        });
        await sandbox.settle(prepared, 1);
        sandbox.commandEnded(prepared);
        const live = entries.filter((entry) => entry.type === "sandbox_violation");
        expect(live).toHaveLength(1);
        expect(live[0]?.recovered).toBeUndefined();

        sandbox.turnEnded();
        await sandbox.whenRecoveryIdle();
        expect(
            entries.filter((entry) => entry.type === "sandbox_violation"),
        ).toHaveLength(1);
    } finally {
        await sandbox.dispose();
    }
});

test("@core a slow log reader never delays the turn and warns once per turn", async () => {
    if (!mac) return;
    const root = workspace();
    const entries: HostLogEntry[] = [];
    const reader: SandboxLogReader = () => new Promise<readonly string[]>(() => {});
    const sandbox = new SandboxManager({
        config: () => enabled,
        permissionRules: () => [],
        log: (entry) => entries.push(entry),
        monitorTimeoutMs: 100,
        recoveryDelayMs: 10,
        recoveryTimeoutMs: 40,
        readLogEvents: reader,
    });
    try {
        const prepared = await preparedCommand(sandbox, root, "call-slow");
        sandbox.commandEnded(prepared);

        const started = performance.now();
        sandbox.turnEnded();
        expect(performance.now() - started).toBeLessThan(20);
        await sandbox.whenRecoveryIdle();
        expect(
            entries.filter((entry) => entry.type === "sandbox_recovery_failed"),
        ).toHaveLength(1);
        expect(entries.filter((entry) => entry.type === "sandbox_violation")).toHaveLength(0);

        // The next turn that has a command gets its own warn, not silence
        // for the rest of the process.
        sandbox.commandEnded(await preparedCommand(sandbox, root, "call-slow-2"));
        sandbox.turnEnded();
        await sandbox.whenRecoveryIdle();
        expect(
            entries.filter((entry) => entry.type === "sandbox_recovery_failed"),
        ).toHaveLength(2);
    } finally {
        await sandbox.dispose();
    }
});

test("@core commands 20 minutes apart produce two small windows", async () => {
    if (!mac) return;
    const root = workspace();
    const time = clock();
    const windows: SandboxLogWindow[] = [];
    const sandbox = new SandboxManager({
        config: () => enabled,
        permissionRules: () => [],
        log: () => {},
        monitorTimeoutMs: 100,
        recoveryDelayMs: 1,
        now: time.now,
        readLogEvents: async (window) => {
            windows.push(window);
            return [];
        },
    });
    try {
        const first = await preparedCommand(sandbox, root, "call-early");
        time.advance(1_000);
        sandbox.commandEnded(first);
        time.advance(20 * 60 * 1000);
        const second = await preparedCommand(sandbox, root, "call-late");
        time.advance(1_000);
        sandbox.commandEnded(second);

        sandbox.turnEnded();
        await sandbox.whenRecoveryIdle();

        expect(windows).toHaveLength(2);
        expect(windows[1]!.start).toBeGreaterThan(windows[0]!.end);
        expect(windows[0]!.end - windows[0]!.start).toBe(5_000);
    } finally {
        await sandbox.dispose();
    }
});

test("@core a timed-out query does not widen the next window", async () => {
    if (!mac) return;
    const root = workspace();
    const time = clock();
    const windows: SandboxLogWindow[] = [];
    let calls = 0;
    const sandbox = new SandboxManager({
        config: () => enabled,
        permissionRules: () => [],
        log: () => {},
        monitorTimeoutMs: 100,
        recoveryDelayMs: 1,
        recoveryTimeoutMs: 20,
        now: time.now,
        readLogEvents: (window) => {
            calls += 1;
            if (calls === 1) return new Promise<readonly string[]>(() => {});
            windows.push(window);
            return Promise.resolve([]);
        },
    });
    try {
        const first = await preparedCommand(sandbox, root, "call-lost");
        time.advance(1_000);
        sandbox.commandEnded(first);
        sandbox.turnEnded();
        await sandbox.whenRecoveryIdle();
        const failedSpanEnd = time.now();

        time.advance(20 * 60 * 1000);
        const second = await preparedCommand(sandbox, root, "call-next");
        time.advance(1_000);
        sandbox.commandEnded(second);
        sandbox.turnEnded();
        await sandbox.whenRecoveryIdle();

        expect(windows).toHaveLength(1);
        // The new span alone: the failed query's time was dropped.
        expect(windows[0]!.start).toBeGreaterThan(failedSpanEnd);
        expect(windows[0]!.end - windows[0]!.start).toBe(5_000);
    } finally {
        await sandbox.dispose();
    }
});

test("@core a 12-minute command becomes three queries", async () => {
    if (!mac) return;
    const root = workspace();
    const time = clock();
    const windows: SandboxLogWindow[] = [];
    const sandbox = new SandboxManager({
        config: () => enabled,
        permissionRules: () => [],
        log: () => {},
        monitorTimeoutMs: 100,
        recoveryDelayMs: 1,
        now: time.now,
        readLogEvents: async (window) => {
            windows.push(window);
            return [];
        },
    });
    try {
        const prepared = await preparedCommand(sandbox, root, "call-long");
        time.advance(12 * 60 * 1000);
        sandbox.commandEnded(prepared);
        sandbox.turnEnded();
        await sandbox.whenRecoveryIdle();

        expect(windows).toHaveLength(3);
        for (const window of windows) {
            expect(window.end - window.start).toBeLessThanOrEqual(5 * 60 * 1000);
        }
        expect(windows[0]!.end).toBe(windows[1]!.start);
        expect(windows[1]!.end).toBe(windows[2]!.start);
    } finally {
        await sandbox.dispose();
    }
});

test("@core a record that appears a second after the turn is recovered once", async () => {
    if (!mac) return;
    const root = workspace();
    const entries: HostLogEntry[] = [];
    let commandId = "";
    let turnedAt = 0;
    const waited: number[] = [];
    const reader: SandboxLogReader = async (window) => {
        const elapsed = Date.now() - turnedAt;
        waited.push(elapsed);
        if (elapsed < 1_000) return [];
        return [kernelMessage(commandId, window.suffix, join(root, "elsewhere", "late"))];
    };
    const sandbox = new SandboxManager({
        config: () => enabled,
        permissionRules: () => [],
        log: (entry) => entries.push(entry),
        monitorTimeoutMs: 100,
        recoveryDelayMs: 1_500,
        readLogEvents: reader,
    });
    try {
        const prepared = await preparedCommand(sandbox, root, "call-late");
        commandId = prepared.commandId;
        sandbox.commandEnded(prepared);
        turnedAt = Date.now();
        sandbox.turnEnded();
        await sandbox.whenRecoveryIdle();
        // The pass ran after the record was visible, not before it.
        expect(waited).toHaveLength(1);
        expect(waited[0]).toBeGreaterThanOrEqual(1_000);
        const recovered = entries.filter(
            (entry) => entry.type === "sandbox_violation" && entry.recovered === true,
        );
        expect(recovered).toHaveLength(1);
    } finally {
        await sandbox.dispose();
    }
});

test("@core two turns inside the delay share one pass", async () => {
    if (!mac) return;
    const root = workspace();
    let calls = 0;
    const sandbox = new SandboxManager({
        config: () => enabled,
        permissionRules: () => [],
        log: () => {},
        monitorTimeoutMs: 100,
        recoveryDelayMs: 80,
        readLogEvents: async () => {
            calls += 1;
            return [];
        },
    });
    try {
        sandbox.commandEnded(await preparedCommand(sandbox, root, "call-a"));
        sandbox.turnEnded();
        await Bun.sleep(20);
        sandbox.commandEnded(await preparedCommand(sandbox, root, "call-b"));
        sandbox.turnEnded();
        await sandbox.whenRecoveryIdle();
        expect(calls).toBe(1);
    } finally {
        await sandbox.dispose();
    }
});

test("@core dispose during the delay runs no query", async () => {
    if (!mac) return;
    const root = workspace();
    let calls = 0;
    const sandbox = new SandboxManager({
        config: () => enabled,
        permissionRules: () => [],
        log: () => {},
        monitorTimeoutMs: 100,
        recoveryDelayMs: 500,
        readLogEvents: async () => {
            calls += 1;
            return [];
        },
    });
    sandbox.commandEnded(await preparedCommand(sandbox, root, "call-dispose"));
    sandbox.turnEnded();
    const started = performance.now();
    await sandbox.dispose();
    expect(performance.now() - started).toBeLessThan(1_000);
    await sandbox.whenRecoveryIdle();
    expect(calls).toBe(0);
    await Bun.sleep(600);
    expect(calls).toBe(0);
});

test("@core a turn that ends during a query waits its own delay", async () => {
    if (!mac) return;
    const root = workspace();
    const entries: HostLogEntry[] = [];
    const delay = 300;
    let commandIdB = "";
    const calls: number[] = [];
    let signalFirst: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
        signalFirst = resolve;
    });
    let releaseFirst: (lines: readonly string[]) => void = () => {};
    const firstGate = new Promise<readonly string[]>((resolve) => {
        releaseFirst = resolve;
    });
    const reader: SandboxLogReader = async (window) => {
        calls.push(Date.now());
        if (calls.length === 1) {
            signalFirst();
            return firstGate;
        }
        return [kernelMessage(commandIdB, window.suffix, join(root, "elsewhere", "late"))];
    };
    const sandbox = new SandboxManager({
        config: () => enabled,
        permissionRules: () => [],
        log: (entry) => entries.push(entry),
        monitorTimeoutMs: 100,
        recoveryDelayMs: delay,
        recoveryTimeoutMs: 2_000,
        readLogEvents: reader,
    });
    try {
        const first = await preparedCommand(sandbox, root, "call-a");
        sandbox.commandEnded(first);
        sandbox.turnEnded();
        await firstStarted;

        const second = await preparedCommand(sandbox, root, "call-b");
        commandIdB = second.commandId;
        sandbox.commandEnded(second);
        const secondEnd = Date.now();
        sandbox.turnEnded();
        // The first query is still running; releasing it must not make the
        // second turn's spans run at once.
        expect(calls).toHaveLength(1);
        releaseFirst([]);
        await sandbox.whenRecoveryIdle();

        expect(calls).toHaveLength(2);
        expect(calls[1]! - secondEnd).toBeGreaterThanOrEqual(delay - 5);
        const recovered = entries.filter(
            (entry) => entry.type === "sandbox_violation" && entry.recovered === true,
        );
        expect(recovered).toHaveLength(1);
        expect(recovered[0]).toMatchObject({ command_id: commandIdB, kind: "write" });
    } finally {
        await sandbox.dispose();
    }
});
