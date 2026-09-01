import { expect, test } from "bun:test";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    colorizeVeraDoctor,
    diagnoseVeraProcesses,
    doctorLineEmphasis,
    livePidFromHostLockFile,
    parseVeraProcessList,
    renderVeraDoctor,
    stopStrayVeraProcesses,
    veraRuntimeFromPsLine,
    type DiagnosedVeraProcess,
    type VeraProcessKind,
    type VeraProcessSample,
} from "../clients/process-doctor.ts";
import { processIsAlive } from "../src/host/process-identity.ts";
import { veraHomeDirectory, veraRuntimeDirectory } from "../src/profile-paths.ts";

test("process parsing finds Vera hosts and clients without claiming other Bun work", () => {
    const samples = parseVeraProcessList(`
  101     1   101 03-14:40:44  99.7 Mon Aug 10 12:34:56 2026 /Users/nash/.bun/bin/bun /work/vera/clients/host/main.ts
  102     1   102    02:27:20   0.0 Fri Aug 14 10:00:00 2026 bun /Users/nash/.bun/bin/vera
  103     1   103       01:00  88.0 Fri Aug 14 12:00:00 2026 bun /tmp/unrelated.ts
`);

    expect(samples).toEqual([
        {
            pid: 101,
            ppid: 1,
            pgid: 101,
            elapsed: "03-14:40:44",
            cpuPercent: 99.7,
            startedAt: "Mon Aug 10 12:34:56 2026",
            command: "/Users/nash/.bun/bin/bun /work/vera/clients/host/main.ts",
            kind: "host",
        },
        {
            pid: 102,
            ppid: 1,
            pgid: 102,
            elapsed: "02:27:20",
            cpuPercent: 0,
            startedAt: "Fri Aug 14 10:00:00 2026",
            command: "bun /Users/nash/.bun/bin/vera",
            kind: "client",
        },
    ]);
});

test("process parsing finds orphaned workers and test fixtures", () => {
    const samples = parseVeraProcessList(`
  201     1   201    00:05:00  12.0 Fri Aug 14 12:00:00 2026 bun src/host/worker/entry.ts
  202     1   202    00:05:00   0.0 Fri Aug 14 12:00:00 2026 bun src/host/worker-supervisor.ts
  203     1   203    00:05:00  50.0 Fri Aug 14 12:00:00 2026 /root/.bun/bin/bun run test/support/tui-work-tab-child.ts
`);

    expect(samples.map((sample) => sample.kind)).toEqual([
        "worker",
        "supervisor",
        "test_fixture",
    ]);
});

test("doctor flags extra hosts and only calls CPU sustained across both samples", async () => {
    const samples: VeraProcessSample[][] = [
        [
            here(processSample(200, "host", 1)),
            here(processSample(201, "host", 99)),
            { ...here(processSample(202, "client", 80)), ppid: 400 },
        ],
        [
            here(processSample(200, "host", 2)),
            here(processSample(201, "host", 98)),
            { ...here(processSample(202, "client", 4)), ppid: 400 },
        ],
    ];
    const report = await diagnoseVeraProcesses({
        readHostOwnership: async () => ({
            currentHostPid: 200,
            knownProfileHostPids: new Set([200]),
        }),
        sampleProcesses: async () => samples.shift() ?? [],
        wait: async () => {},
        doctorPid: 999,
    });

    expect(report.healthy).toBe(false);
    expect(report.processes).toMatchObject([
        { pid: 201, currentHost: false, sustainedHighCpu: true },
        { pid: 200, currentHost: true, sustainedHighCpu: false },
        { pid: 202, currentHost: false, sustainedHighCpu: false },
    ]);
    const output = renderVeraDoctor(report);
    expect(output).toContain("Resident host: PID 200");
    expect(output).toContain("PID 201");
    expect(output).toContain("sustained high CPU");
    expect(output).toContain("1 stray process can be stopped safely.");
});

test("doctor summarizes a large quiet host count", () => {
    const processes = Array.from({ length: 12 }, (_, index) => ({
        ...processSample(300 + index, "host", 0),
        currentHost: false,
        knownProfileHost: false,
        sustainedHighCpu: false,
        stray: false,
    }));
    const output = renderVeraDoctor({
        healthy: false,
        currentHostMissing: false,
        processes,
        highCpuPercent: 50,
    });

    expect(output).toContain("Resident host: not running");
    expect(output).toContain("... 7 more unrecognized low-CPU host processes");
});

test("doctor reports one quiet current host as healthy", async () => {
    const sample = [processSample(200, "host", 0)];
    const report = await diagnoseVeraProcesses({
        readHostOwnership: async () => ({
            currentHostPid: 200,
            knownProfileHostPids: new Set([200]),
        }),
        sampleProcesses: async () => sample,
        wait: async () => {},
        doctorPid: 999,
    });

    expect(report.healthy).toBe(true);
    expect(renderVeraDoctor(report)).toContain("Result: healthy");
});

test("doctor omits an unlabeled extra host from this island", async () => {
    const sample = [
        processSample(200, "host", 0),
        processSample(201, "host", 0),
    ];
    const report = await diagnoseVeraProcesses({
        readHostOwnership: async () => ({
            currentHostPid: 200,
            knownProfileHostPids: new Set([200, 201]),
        }),
        sampleProcesses: async () => sample,
        wait: async () => {},
        doctorPid: 999,
    });

    expect(report.healthy).toBe(true);
    expect(report.processes).toMatchObject([
        { pid: 200, currentHost: true, knownProfileHost: false },
    ]);
});

test("doctor retries inconsistent ownership after host replacement", async () => {
    const samples = [
        [processSample(200, "host", 0)],
        [processSample(201, "host", 0)],
        [processSample(201, "host", 0)],
    ];
    const ownership = [
        {
            currentHostPid: 200,
            knownProfileHostPids: new Set([200]),
        },
        {
            currentHostPid: 201,
            knownProfileHostPids: new Set([201]),
        },
    ];
    const report = await diagnoseVeraProcesses({
        readHostOwnership: async () => ownership.shift() ?? {
            knownProfileHostPids: new Set(),
        },
        sampleProcesses: async () => samples.shift() ?? [],
        wait: async () => {},
        doctorPid: 999,
    });

    expect(report.healthy).toBe(true);
    expect(report.currentHostPid).toBe(201);
    expect(report.currentHostMissing).toBe(false);
});

test("doctor retries when another profile replaces its host", async () => {
    const samples = [
        [
            processSample(200, "host", 0),
            processSample(201, "host", 0),
        ],
        [
            processSample(200, "host", 0),
            processSample(202, "host", 0),
        ],
        [
            processSample(200, "host", 0),
            processSample(202, "host", 0),
        ],
    ];
    const ownership = [
        {
            currentHostPid: 200,
            knownProfileHostPids: new Set([200, 201]),
        },
        {
            currentHostPid: 200,
            knownProfileHostPids: new Set([200, 202]),
        },
    ];
    const report = await diagnoseVeraProcesses({
        readHostOwnership: async () => ownership.shift() ?? {
            knownProfileHostPids: new Set(),
        },
        sampleProcesses: async () => samples.shift() ?? [],
        wait: async () => {},
        doctorPid: 999,
    });

    expect(report.healthy).toBe(true);
    expect(report.processes).toMatchObject([
        { pid: 200, currentHost: true },
    ]);
});

test("doctor does not join CPU samples when a PID changes identity", async () => {
    const samples = [
        [processSample(200, "host", 99)],
        [{
            ...processSample(200, "host", 99),
            startedAt: "Fri Aug 14 12:00:01 2026",
        }],
    ];
    const report = await diagnoseVeraProcesses({
        readHostOwnership: async () => ({
            currentHostPid: 200,
            knownProfileHostPids: new Set([200]),
        }),
        sampleProcesses: async () => samples.shift() ?? [],
        wait: async () => {},
        doctorPid: 999,
    });

    expect(report.processes[0]?.sustainedHighCpu).toBe(false);
});

test("doctor reports a busy known client without failing health", async () => {
    const sample = [
        processSample(200, "host", 0),
        { ...here(processSample(201, "client", 90)), ppid: 400 },
    ];
    const report = await diagnoseVeraProcesses({
        readHostOwnership: async () => ({
            currentHostPid: 200,
            knownProfileHostPids: new Set([200]),
        }),
        sampleProcesses: async () => sample,
        wait: async () => {},
        doctorPid: 999,
    });

    expect(report.healthy).toBe(true);
    const output = renderVeraDoctor(report);
    expect(output).toContain("High CPU activity");
    expect(output).toContain("PID 201");
    expect(output).toContain("Result: healthy");
});

test("doctor flags an orphaned worker and test fixture as stray, not one with a live parent", async () => {
    const sample = [
        processSample(200, "host", 0),
        { ...processSample(400, "worker", 0), ppid: 200 },
        here(processSample(401, "worker", 0)),
        here(processSample(402, "test_fixture", 0)),
    ];
    const report = await diagnoseVeraProcesses({
        readHostOwnership: async () => ({
            currentHostPid: 200,
            knownProfileHostPids: new Set([200]),
        }),
        sampleProcesses: async () => sample,
        wait: async () => {},
        doctorPid: 999,
    });

    expect(report.healthy).toBe(false);
    const strayByPid = new Map(
        report.processes.map((process) => [process.pid, process.stray]),
    );
    expect(strayByPid).toEqual(new Map([
        [200, false],
        [400, false],
        [401, true],
        [402, true],
    ]));
    const output = renderVeraDoctor(report);
    expect(output).toContain("Stray processes: 2 orphaned");
    expect(output).toContain("PID 401");
    expect(output).toContain("PID 402");
    expect(output).toMatch(/worker\s+PID 400/);
    expect(output).not.toMatch(/PID 400[^\n]*stray/);
    expect(output).toContain("2 stray processes can be stopped safely.");
});

test("doctor flags workers of a leftover host, not only pid-1 orphans", async () => {
    const sample = [
        processSample(200, "host", 0),
        { ...here(processSample(300, "host", 0)), pid: 300, pgid: 300 },
        { ...here(processSample(301, "worker", 0)), pid: 301, ppid: 300, pgid: 301 },
        { ...here(processSample(302, "worker", 0)), pid: 302, ppid: 300, pgid: 302 },
        { ...processSample(400, "worker", 0), ppid: 200 },
    ];
    const report = await diagnoseVeraProcesses({
        readHostOwnership: async () => ({
            currentHostPid: 200,
            knownProfileHostPids: new Set([200]),
        }),
        sampleProcesses: async () => sample,
        wait: async () => {},
        doctorPid: 999,
    });

    const strayByPid = new Map(
        report.processes.map((process) => [process.pid, process.stray]),
    );
    expect(strayByPid).toEqual(new Map([
        [200, false],
        [300, true],
        [301, true],
        [302, true],
        [400, false],
    ]));
});

test("an unlabeled host is not a stray of another runtime island", async () => {
    const sample = [
        {
            ...processSample(200, "host", 0),
            runtimeDir: "/tmp/vera-keep",
        },
        processSample(201, "host", 0),
        { ...processSample(202, "client", 0), ppid: 1 },
    ];
    const report = await diagnoseVeraProcesses({
        readHostOwnership: async () => ({
            currentHostPid: 200,
            knownProfileHostPids: new Set([200]),
        }),
        sampleProcesses: async () => sample,
        wait: async () => {},
        doctorPid: 999,
        runtimeIsland: "/tmp/vera-keep",
    });

    expect(report.processes.map((process) => process.pid)).toEqual([200]);
    expect(report.processes[0]?.stray).toBe(false);
    expect(report.healthy).toBe(true);
});

test("doctor leaves a foreign isolated runtime alone", async () => {
    const sample = [
        processSample(200, "host", 0),
        {
            ...processSample(500, "client", 0),
            ppid: 499,
            isolated: true,
            runtimeDir: "/tmp/vera-otps",
        },
        {
            ...processSample(501, "host", 0),
            pid: 501,
            ppid: 500,
            pgid: 501,
            isolated: true,
            runtimeDir: "/tmp/vera-otps",
        },
    ];
    const report = await diagnoseVeraProcesses({
        readHostOwnership: async () => ({
            currentHostPid: 200,
            knownProfileHostPids: new Set([200]),
        }),
        sampleProcesses: async () => sample,
        wait: async () => {},
        doctorPid: 999,
    });

    expect(report.processes.map((process) => process.pid)).toEqual([200]);
    expect(report.processes[0]?.stray).toBe(false);
    expect(report.healthy).toBe(true);
});

test("doctor flags leftovers inside the invoked isolated runtime", async () => {
    const sample = [
        {
            ...processSample(500, "client", 0),
            ppid: 499,
            isolated: true,
            runtimeDir: "/tmp/vera-otps",
        },
        {
            ...processSample(501, "host", 0),
            pid: 501,
            ppid: 500,
            pgid: 501,
            isolated: true,
            runtimeDir: "/tmp/vera-otps",
        },
    ];
    const report = await diagnoseVeraProcesses({
        readHostOwnership: async () => ({
            knownProfileHostPids: new Set(),
        }),
        sampleProcesses: async () => sample,
        wait: async () => {},
        doctorPid: 999,
        runtimeIsland: "/tmp/vera-otps",
    });

    const strayByPid = new Map(
        report.processes.map((process) => [process.pid, process.stray]),
    );
    expect(strayByPid.get(500)).toBe(false);
    expect(strayByPid.get(501)).toBe(true);
});

test("doctor leaves a launcher-owned worktree runtime to its own island", async () => {
    const sample = [
        processSample(200, "host", 0),
        {
            ...processSample(500, "client", 0),
            ppid: 499,
            isolated: true,
            runtimeDir: "/tmp/vera-worktrees-501/aspol-a1b2c3d4e5",
            worktreeRuntime: true,
        },
        {
            ...processSample(501, "host", 0),
            pid: 501,
            ppid: 1,
            pgid: 501,
            isolated: true,
            runtimeDir: "/tmp/vera-worktrees-501/aspol-a1b2c3d4e5",
            worktreeRuntime: true,
        },
    ];
    const report = await diagnoseVeraProcesses({
        readHostOwnership: async () => ({
            currentHostPid: 200,
            knownProfileHostPids: new Set([200]),
        }),
        sampleProcesses: async () => sample,
        wait: async () => {},
        doctorPid: 999,
    });

    expect(report.healthy).toBe(true);
    expect(new Map(
        report.processes.map((process) => [process.pid, process.stray]),
    )).toEqual(new Map([[200, false]]));
    expect(renderVeraDoctor(report)).toContain(
        "Resident host: PID 200",
    );
});

test("process environment identifies a deliberate worktree runtime", () => {
    expect(veraRuntimeFromPsLine(
        "bun clients/host/main.ts VERA_RUNTIME_DIR=/tmp/aspol VERA_WORKTREE_RUNTIME=/tmp/aspol",
    )).toEqual({
        isolated: true,
        runtimeDir: "/tmp/aspol",
        worktreeRuntime: true,
    });
});

test("a profile env does not name a second host runtime", () => {
    expect(veraRuntimeFromPsLine(
        "bun clients/host/main.ts VERA_PROFILE=dev",
    )).toEqual({
        isolated: false,
        worktreeRuntime: false,
    });
});

test("an inherited worktree marker does not own a nested runtime", () => {
    expect(veraRuntimeFromPsLine(
        "bun clients/host/main.ts VERA_RUNTIME_DIR=/tmp/nested VERA_WORKTREE_RUNTIME=/tmp/aspol",
    )).toEqual({
        isolated: true,
        runtimeDir: "/tmp/nested",
        worktreeRuntime: false,
    });
});

test("a worktree checkout path is not leftover of this island", async () => {
    const sample = [
        processSample(200, "host", 0),
        {
            ...processSample(201, "host", 0),
            command: "bun /Users/nash/Projects/vera/.worktrees/flash/clients/host/main.ts",
            isolated: true,
            runtimeDir: "/tmp/vera-worktrees-501/flash-deadbeef",
            worktreeRuntime: true,
        },
    ];
    const report = await diagnoseVeraProcesses({
        readHostOwnership: async () => ({
            currentHostPid: 200,
            knownProfileHostPids: new Set([200, 201]),
        }),
        sampleProcesses: async () => sample,
        wait: async () => {},
        doctorPid: 999,
    });

    const strayByPid = new Map(
        report.processes.map((process) => [process.pid, process.stray]),
    );
    expect(strayByPid.get(200)).toBe(false);
    expect(strayByPid.has(201)).toBe(false);
});

test("doctor does not stop a foreign runtime's host", async () => {
    const sample = [
        {
            ...processSample(200, "host", 0),
            isolated: true,
            runtimeDir: "/tmp/vera-keep",
        },
        {
            ...processSample(201, "host", 0),
            pid: 201,
            pgid: 201,
            isolated: true,
            runtimeDir: "/tmp/vera-drop",
        },
    ];
    const report = await diagnoseVeraProcesses({
        readHostOwnership: async () => ({
            currentHostPid: 200,
            knownProfileHostPids: new Set([200]),
        }),
        sampleProcesses: async () => sample,
        wait: async () => {},
        doctorPid: 999,
        runtimeIsland: "/tmp/vera-keep",
    });

    const strayByPid = new Map(
        report.processes.map((process) => [process.pid, process.stray]),
    );
    expect(strayByPid.get(200)).toBe(false);
    expect(strayByPid.has(201)).toBe(false);
});

test("process parsing finds a watchdog separately from the TUI, and a supervisor separately from a worker", () => {
    const samples = parseVeraProcessList(`
  610    92   610    00:01:00   0.0 Tue Aug 25 01:00:00 2026 bun clients/tui/main.ts
  611    92   611    00:01:00   0.0 Tue Aug 25 01:00:00 2026 bun clients/tui/flight-watchdog.ts
  612   200   612    00:01:00   0.0 Tue Aug 25 01:00:00 2026 bun src/host/worker/entry.ts
  613   200   613    00:01:00   0.0 Tue Aug 25 01:00:00 2026 bun src/host/worker-supervisor.ts
`);
    expect(samples.map((sample) => sample.kind)).toEqual([
        "client",
        "watchdog",
        "worker",
        "supervisor",
    ]);
});

test("doctor lists the owned bun tree after healthy, titled and untitled", async () => {
    const sample = [
        { ...processSample(92, "client", 0), ppid: 90, pid: 92, pgid: 92 },
        { ...processSample(200, "host", 0), ppid: 92 },
        { ...processSample(105, "watchdog", 0), ppid: 92, pid: 105, pgid: 105 },
        { ...processSample(301, "worker", 0), ppid: 200, pid: 301, pgid: 301 },
        { ...processSample(401, "supervisor", 0), ppid: 200, pid: 401, pgid: 401 },
        { ...processSample(302, "worker", 0), ppid: 200, pid: 302, pgid: 302 },
        { ...processSample(402, "supervisor", 0), ppid: 200, pid: 402, pgid: 402 },
    ];
    const report = await diagnoseVeraProcesses({
        readHostOwnership: async () => ({
            currentHostPid: 200,
            knownProfileHostPids: new Set([200]),
        }),
        sampleProcesses: async () => sample,
        listWorkerSessions: async () => [
            {
                id: "sess-titled",
                title: "Start a conversation",
                workerPid: 301,
                supervisorPid: 401,
            },
            {
                id: "sess-untitled",
                name: "misty-lark:d367",
                workerPid: 302,
                supervisorPid: 402,
            },
        ],
        wait: async () => {},
        doctorPid: 999,
    });

    expect(report.healthy).toBe(true);
    const output = renderVeraDoctor(report);
    expect(output).toContain("Result: healthy");
    expect(output).toContain("No stray processes found.");
    expect(output).toContain(
        "7 bun  ·  1 TUI  1 host  2 workers  2 supervisors  1 watchdog",
    );
    expect(output).toMatch(/TUI\s+PID 92/);
    expect(output).toMatch(/host\s+PID 200/);
    expect(output).toMatch(/watchdog\s+PID 105/);
    expect(output).toContain("Start a conversation");
    expect(output).toContain("misty-lark:d367");
});

test("doctor counts eleven bun for four worker pairs plus watchdog", async () => {
    const sample = [
        { ...processSample(10, "client", 0), pid: 10, ppid: 9, pgid: 10 },
        { ...processSample(20, "host", 0), ppid: 10 },
        { ...processSample(11, "watchdog", 0), pid: 11, ppid: 10, pgid: 11 },
        ...[1, 2, 3, 4].flatMap((n) => [
            {
                ...processSample(20 + n, "worker", 0),
                pid: 20 + n,
                ppid: 20,
                pgid: 20 + n,
            },
            {
                ...processSample(30 + n, "supervisor", 0),
                pid: 30 + n,
                ppid: 20,
                pgid: 30 + n,
            },
        ]),
    ];
    const report = await diagnoseVeraProcesses({
        readHostOwnership: async () => ({
            currentHostPid: 20,
            knownProfileHostPids: new Set([20]),
        }),
        sampleProcesses: async () => sample,
        listWorkerSessions: async () =>
            [1, 2, 3, 4].map((n) => ({
                id: `sess-${n}`,
                title: n === 4 ? undefined : `chat ${n}`,
                name: n === 4 ? "misty-lark:aaaa" : undefined,
                workerPid: 20 + n,
                supervisorPid: 30 + n,
            })),
        wait: async () => {},
        doctorPid: 999,
    });

    expect(report.healthy).toBe(true);
    const output = renderVeraDoctor(report);
    expect(output).toContain(
        "11 bun  ·  1 TUI  1 host  4 workers  4 supervisors  1 watchdog",
    );
    expect(output).toContain("chat 1");
    expect(output).toContain("misty-lark:aaaa");
    expect(output).toContain("Result: healthy");
});

test("doctor keeps strays out of Running now", async () => {
    const sample = [
        { ...processSample(200, "host", 0), ppid: 92 },
        { ...processSample(92, "client", 0), pid: 92, ppid: 90, pgid: 92 },
        { ...processSample(301, "worker", 0), ppid: 200, pid: 301, pgid: 301 },
        { ...processSample(401, "supervisor", 0), ppid: 200, pid: 401, pgid: 401 },
        here(processSample(501, "worker", 0)),
        here(processSample(502, "supervisor", 0)),
    ];
    const report = await diagnoseVeraProcesses({
        readHostOwnership: async () => ({
            currentHostPid: 200,
            knownProfileHostPids: new Set([200]),
        }),
        sampleProcesses: async () => sample,
        listWorkerSessions: async () => [
            {
                id: "live",
                title: "on screen",
                workerPid: 301,
                supervisorPid: 401,
            },
        ],
        wait: async () => {},
        doctorPid: 999,
    });

    expect(report.healthy).toBe(false);
    const output = renderVeraDoctor(report);
    expect(output).toContain("on screen");
    expect(output).toMatch(/worker\s+PID 301/);
    expect(output).toContain("Stray processes:");
    expect(output).toContain("PID 501");
    expect(output).toContain("PID 502");
    const running = output.slice(
        output.indexOf("Running now"),
        output.indexOf("Stray processes:"),
    );
    expect(running).not.toContain("PID 501");
    expect(running).not.toContain("PID 502");
});

test("doctor lists an untitled worker when the host did not name it", async () => {
    const sample = [
        { ...processSample(200, "host", 0), ppid: 92 },
        { ...processSample(92, "client", 0), pid: 92, ppid: 90, pgid: 92 },
        { ...processSample(301, "worker", 0), ppid: 200, pid: 301, pgid: 301 },
        { ...processSample(401, "supervisor", 0), ppid: 200, pid: 401, pgid: 401 },
    ];
    const report = await diagnoseVeraProcesses({
        readHostOwnership: async () => ({
            currentHostPid: 200,
            knownProfileHostPids: new Set([200]),
        }),
        sampleProcesses: async () => sample,
        wait: async () => {},
        doctorPid: 999,
    });

    expect(report.healthy).toBe(true);
    const output = renderVeraDoctor(report);
    expect(output).toMatch(/worker\s+PID 301  ·  untitled/);
    expect(output).toMatch(/supervisor\s+PID 401  ·  untitled/);
});

test("colorizeVeraDoctor leaves copyable text alone without color", () => {
    const text = renderVeraDoctor({
        healthy: true,
        currentHostMissing: false,
        processes: [{
            ...processSample(200, "host", 0),
            currentHost: true,
            knownProfileHost: false,
            sustainedHighCpu: false,
            stray: false,
        }],
        highCpuPercent: 50,
    });
    expect(colorizeVeraDoctor(text)).toBe(text);
    expect(colorizeVeraDoctor(text, { color: false })).toBe(text);
});

test("colorizeVeraDoctor paints Result and roles when color is on", () => {
    const text = [
        "Vera doctor",
        "",
        "Running now",
        "  2 bun  ·  1 TUI  1 host",
        "  TUI          PID 92",
        "  host         PID 200",
        "Result: healthy",
        "No stray processes found.",
        "",
    ].join("\n");
    const painted = colorizeVeraDoctor(text, { color: true });
    expect(painted).toContain("\x1b[32mResult: healthy\x1b[0m");
    expect(painted).toContain("\x1b[32mNo stray processes found.\x1b[0m");
    expect(painted).toContain("\x1b[1mRunning now\x1b[0m");
    expect(painted).toContain("\x1b[36mTUI\x1b[0m");
    expect(painted).toContain("\x1b[33mhost\x1b[0m");
    expect(doctorLineEmphasis("Result: issues found")).toBe("danger");
    expect(doctorLineEmphasis("  worker       PID 301  ·  untitled")).toBe(
        "role",
    );
});

test("stopStrayVeraProcesses kills a stray's process group", async () => {
    const child = Bun.spawn(
        [process.execPath, "-e", "await Bun.sleep(300000)"],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true },
    );
    try {
        expect(processIsAlive(child.pid)).toBe(true);
        const stray: DiagnosedVeraProcess = {
            ...processSample(child.pid, "test_fixture", 0),
            pgid: child.pid,
            currentHost: false,
            knownProfileHost: false,
            sustainedHighCpu: false,
            stray: true,
        };
        const stopped = stopStrayVeraProcesses([stray]);
        expect(stopped).toBe(1);
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline && processIsAlive(child.pid)) {
            await Bun.sleep(25);
        }
        expect(processIsAlive(child.pid)).toBe(false);
    } finally {
        if (processIsAlive(child.pid)) child.kill("SIGKILL");
    }
});

test("livePidFromHostLockFile trusts a live matching record without a handshake", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-lock-"));
    const path = join(directory, "host.json");
    try {
        writeFileSync(path, JSON.stringify({
            schema_version: 2,
            pid: process.pid,
            started_at: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
            socket_path: join(directory, "host.sock"),
        }));
        expect(await livePidFromHostLockFile(path)).toBe(process.pid);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("livePidFromHostLockFile ignores a record whose pid is gone", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-lock-"));
    const path = join(directory, "host.json");
    try {
        writeFileSync(path, JSON.stringify({
            schema_version: 2,
            pid: 2_147_483_647,
            started_at: new Date().toISOString(),
            socket_path: join(directory, "host.sock"),
        }));
        expect(await livePidFromHostLockFile(path)).toBeUndefined();
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

function here(sample: VeraProcessSample): VeraProcessSample {
    return { ...sample, runtimeDir: veraRuntimeDirectory() };
}

function processSample(
    pid: number,
    kind: VeraProcessKind,
    cpuPercent: number,
): VeraProcessSample {
    const entrypoint = kind === "host"
        ? `/work/${pid}/clients/host/main.ts`
        : kind === "worker"
        ? "src/host/worker/entry.ts"
        : kind === "supervisor"
        ? "src/host/worker-supervisor.ts"
        : kind === "watchdog"
        ? "clients/tui/flight-watchdog.ts"
        : kind === "test_fixture"
        ? "test/support/tui-work-tab-child.ts"
        : "/Users/nash/.bun/bin/vera";
    return {
        pid,
        ppid: 1,
        pgid: pid,
        elapsed: "01:00:00",
        cpuPercent,
        startedAt: "Fri Aug 14 12:00:00 2026",
        command: `bun ${entrypoint}`,
        kind,
    };
}
