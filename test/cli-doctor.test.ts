import { expect, test } from "bun:test";

import {
    diagnoseVeraProcesses,
    parseVeraProcessList,
    renderVeraDoctor,
    stopStrayVeraProcesses,
    type DiagnosedVeraProcess,
    type VeraProcessSample,
} from "../clients/process-doctor.ts";
import { processIsAlive } from "../src/host/process-identity.ts";

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
        "worker",
        "test_fixture",
    ]);
});

test("doctor flags extra hosts and only calls CPU sustained across both samples", async () => {
    const samples: VeraProcessSample[][] = [
        [
            processSample(200, "host", 1),
            processSample(201, "host", 99),
            processSample(202, "client", 80),
        ],
        [
            processSample(200, "host", 2),
            processSample(201, "host", 98),
            processSample(202, "client", 4),
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
    expect(output).toContain("Resident hosts: 2 (1 unrecognized, 0 other profiles)");
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

    expect(output).toContain("Resident hosts: 12 (12 unrecognized, 0 other profiles)");
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

test("doctor treats another active profile host as known and healthy", async () => {
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
        { pid: 201, currentHost: false, knownProfileHost: true },
    ]);
    expect(renderVeraDoctor(report)).toContain(
        "Resident hosts: 2 (0 unrecognized, 1 other profile)",
    );
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
        { pid: 202, knownProfileHost: true },
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
        processSample(201, "client", 90),
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
        processSample(401, "worker", 0),
        processSample(402, "test_fixture", 0),
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
    expect(output).not.toContain("PID 400");
    expect(output).toContain("2 stray processes can be stopped safely.");
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

function processSample(
    pid: number,
    kind: "host" | "client" | "worker" | "test_fixture",
    cpuPercent: number,
): VeraProcessSample {
    const entrypoint = kind === "host"
        ? `/work/${pid}/clients/host/main.ts`
        : kind === "worker"
        ? "src/host/worker/entry.ts"
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
