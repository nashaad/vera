import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("a non-terminal launch refuses before packing", async () => {
    const root = mkdtempSync(join(tmpdir(), "dev-tui-no-tty-"));
    const marker = join(root, "packed");
    const fakeBin = join(root, "bin");
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, "bun"), '#!/bin/sh\nif [ "$2" = "pack:release" ]; then touch "$PACK_MARKER"; exit 42; fi\nexec "$REAL_BUN" "$@"\n', { mode: 0o755 });
    try {
        const child = Bun.spawn([process.execPath, "run", "dev:tui", "--fresh", "--yes"], {
            cwd: process.cwd(),
            env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, PACK_MARKER: marker, REAL_BUN: process.execPath },
            stdin: "ignore", stdout: "pipe", stderr: "pipe",
        });
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        expect(code).not.toBe(0);
        expect(stderr).toContain("stdin and stdout must be terminals");
        expect(existsSync(marker)).toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

import { candidateHomePath, runDevTui } from "../../scripts/dev-tui.ts";
import { clientLaunchHome, clientRecordPath, readClientRecord, stopRecordedClient, trackClient, writeClientRecord, type DevClientProcessInfo } from "../../scripts/dev-tui-client.ts";

for (const scenario of ["matching", "reused", "foreign", "unreadable", "dead", "absent"] as const) {
    test(`stop handles a ${scenario} client record`, async () => {
        const root = mkdtempSync(join(tmpdir(), "dev-tui-client-stop-"));
        const home = candidateHomePath(process.cwd(), root);
        mkdirSync(join(home, "runtime"), { recursive: true });
        writeFileSync(join(home, "keep"), "yes");
        if (scenario !== "absent") writeClientRecord(home, { pid: 1234, startedAt: "original" });
        let alive = true;
        const signals: Array<[number, NodeJS.Signals]> = [];
        const info: DevClientProcessInfo = {
            isAlive: () => scenario !== "dead" && alive,
            startTime: () => scenario === "reused" ? "replacement" : "original",
            launchHome: () => scenario === "foreign" ? `${home}-other` : scenario === "unreadable" ? undefined : home,
            signal: (pid, signal) => { signals.push([pid, signal]); alive = false; },
            graceMs: 0,
        };
        try {
            const code = await runDevTui(["--stop"], process.cwd(), {
                temporaryRoot: root, clientProcessInfo: info, stderr: { write: () => {} },
            });
            expect(code).toBe(0);
            expect(signals).toEqual(scenario === "matching" ? [[1234, "SIGTERM"]] : []);
            expect(existsSync(clientRecordPath(home))).toBe(false);
            expect(existsSync(join(home, "keep"))).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
}

test("client launch home comes from the environment rather than arguments", async () => {
    const home = "/tmp/dev-tui-environment-probe";
    const foreign = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)", `VERA_HOME=${home}`], {
        env: { PATH: process.env.PATH }, stdout: "ignore", stderr: "ignore",
    });
    const matching = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
        env: { PATH: process.env.PATH, VERA_HOME: home }, stdout: "ignore", stderr: "ignore",
    });
    try {
        await Bun.sleep(100);
        expect(clientLaunchHome(foreign.pid)).toBeUndefined();
        expect(clientLaunchHome(matching.pid)).toBe(home);
    } finally {
        foreign.kill();
        matching.kill();
        await Promise.all([foreign.exited, matching.exited]);
    }
});


test("a launched client is recorded until it exits without removing a newer record", async () => {
    const root = mkdtempSync(join(tmpdir(), "dev-tui-client-record-"));
    let exit: (code: number) => void = () => {};
    const child = { pid: 222, exited: new Promise<number>((resolve) => { exit = resolve; }), kill: () => {} };
    try {
        const running = trackClient(root, child, () => "start-222");
        expect(readClientRecord(root)).toEqual({ pid: 222, startedAt: "start-222" });
        writeClientRecord(root, { pid: 333, startedAt: "start-333" });
        exit(0);
        expect(await running).toBe(0);
        expect(readClientRecord(root)).toEqual({ pid: 333, startedAt: "start-333" });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

for (const role of ["host", "worker"] as const) {
    test(`stop leaves a recorded ${role} from another home running`, async () => {
        const root = mkdtempSync(join(tmpdir(), "dev-stop-foreign-"));
        const home = candidateHomePath(process.cwd(), root);
        const runtime = join(home, "runtime");
        mkdirSync(join(runtime, "workers"), { recursive: true });
        const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
            env: { VERA_HOME: `${home}-other` }, stdout: "ignore", stderr: "ignore",
        });
        const messages: string[] = [];
        try {
            const record = { pid: child.pid, started_at: new Date().toISOString() };
            if (role === "host") {
                writeFileSync(join(runtime, "host.json"), JSON.stringify({
                    ...record, schema_version: 1, socket_path: join(runtime, "host.sock"),
                }));
            } else {
                writeFileSync(join(runtime, "workers", "w0.json"), JSON.stringify({ ...record, id: "w0" }));
            }
            const code = await runDevTui(["--stop"], process.cwd(), {
                temporaryRoot: root, stderr: { write: (message) => messages.push(message) },
            });
            expect(code).toBe(1);
            expect(messages.join("")).toContain(`Could not verify VERA_HOME for PID ${child.pid}`);
            expect(child.exitCode).toBeNull();
        } finally {
            child.kill();
            await child.exited;
            rmSync(root, { recursive: true, force: true });
        }
    });
}


test("stop rechecks client identity before escalating", async () => {
    const home = mkdtempSync(join(tmpdir(), "dev-stop-reused-"));
    writeClientRecord(home, { pid: 1234, startedAt: "first" });
    let startedAt = "first";
    const signals: NodeJS.Signals[] = [];
    try {
        const result = await stopRecordedClient(home, { write: () => {} }, {
            isAlive: () => true,
            startTime: () => startedAt,
            launchHome: () => home,
            signal: (_pid, signal) => { signals.push(signal); startedAt = "replacement"; },
            graceMs: 0,
        });
        expect(result).toBe(0);
        expect(signals).toEqual(["SIGTERM"]);
        expect(existsSync(clientRecordPath(home))).toBe(false);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("an exited client removes its record", async () => {
    const home = mkdtempSync(join(tmpdir(), "dev-client-exit-"));
    const child = { pid: 777, exited: Promise.resolve(0), kill: () => {} };
    try {
        expect(await trackClient(home, child, () => "first")).toBe(0);
        expect(existsSync(clientRecordPath(home))).toBe(false);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});
