import { expect, test } from "bun:test";

import {
    diagnoseVeraProcesses,
    parseVeraProcessList,
    renderVeraDoctor,
    type VeraProcessSample,
} from "../clients/process-doctor.ts";

test("process parsing finds Vera hosts and clients without claiming other Bun work", () => {
    const samples = parseVeraProcessList(`
  101     1 03-14:40:44  99.7 Mon Aug 10 12:34:56 2026 /Users/nash/.bun/bin/bun /work/vera/clients/host/main.ts
  102     1    02:27:20   0.0 Fri Aug 14 10:00:00 2026 bun /Users/nash/.bun/bin/vera
  103     1       01:00  88.0 Fri Aug 14 12:00:00 2026 bun /tmp/unrelated.ts
`);

    expect(samples).toEqual([
        {
            pid: 101,
            ppid: 1,
            elapsed: "03-14:40:44",
            cpuPercent: 99.7,
            startedAt: "Mon Aug 10 12:34:56 2026",
            command: "/Users/nash/.bun/bin/bun /work/vera/clients/host/main.ts",
            kind: "host",
        },
        {
            pid: 102,
            ppid: 1,
            elapsed: "02:27:20",
            cpuPercent: 0,
            startedAt: "Fri Aug 14 10:00:00 2026",
            command: "bun /Users/nash/.bun/bin/vera",
            kind: "client",
        },
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
    expect(output).toContain("No processes were stopped.");
});

test("doctor summarizes a large quiet host count", () => {
    const processes = Array.from({ length: 12 }, (_, index) => ({
        ...processSample(300 + index, "host", 0),
        currentHost: false,
        knownProfileHost: false,
        sustainedHighCpu: false,
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

function processSample(
    pid: number,
    kind: "host" | "client",
    cpuPercent: number,
): VeraProcessSample {
    const entrypoint = kind === "host"
        ? `/work/${pid}/clients/host/main.ts`
        : "/Users/nash/.bun/bin/vera";
    return {
        pid,
        ppid: 1,
        elapsed: "01:00:00",
        cpuPercent,
        startedAt: "Fri Aug 14 12:00:00 2026",
        command: `bun ${entrypoint}`,
        kind,
    };
}
