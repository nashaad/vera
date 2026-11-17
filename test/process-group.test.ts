import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { signalVerifiedProcessGroup, type ProcessGroupMember, type ProcessGroupReads } from "../src/process-group.ts";

const pid = 4242;
const startedAt = Date.UTC(2026, 10, 8, 12, 0, 0);
const record = { pid, started_at: new Date(startedAt).toISOString() };

function reads(signals: string[], overrides: ProcessGroupReads = {}): ProcessGroupReads {
    return {
        readProcessGroupSnapshot: () => [{ pid, group: pid, state: "S", startedAt }],
        kill: (target, signal) => { signals.push(`${signal}:${target}`); },
        ...overrides,
    };
}

test("@core process group snapshots accept zero group IDs without signalling them", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-ps-snapshot-"));
    try {
        writeFileSync(join(directory, "ps"), "#!/bin/sh\nprintf '%s\\n' \"$VERA_TEST_PS_OUTPUT\"\n", { mode: 0o755 });
        const module = new URL("../src/process-group.ts", import.meta.url).href;
        const script = `import { readProcessGroupSnapshot } from ${JSON.stringify(module)}; console.log(JSON.stringify(readProcessGroupSnapshot() ?? null));`;
        const readRows = (output: string): unknown => JSON.parse(execFileSync(process.execPath, ["-e", script], {
            encoding: "utf8",
            env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`, VERA_TEST_PS_OUTPUT: output },
        }));

        const rows = readRows("2 0 S 00:01\n4242 4242 Ss 00:00") as ProcessGroupMember[];
        expect(rows).toMatchObject([{ pid: 2, group: 0, state: "S" }, { pid: 4242, group: 4242, state: "Ss" }]);
        const signals: string[] = [];
        const leader = rows[1]!;
        expect(signalVerifiedProcessGroup({ pid: leader.pid, started_at: new Date(leader.startedAt).toISOString() }, "SIGTERM", {
            reads: reads(signals, { readProcessGroupSnapshot: () => rows }),
        })).toBe("sent");
        expect(signals).toEqual(["SIGTERM:-4242"]);
        const zeroGroup = rows[0]!;
        expect(signalVerifiedProcessGroup({ pid: zeroGroup.pid, started_at: new Date(zeroGroup.startedAt).toISOString() }, "SIGKILL", {
            reads: reads(signals, { readProcessGroupSnapshot: () => rows }),
        })).toBe("not_group_leader");
        expect(signals).toEqual(["SIGTERM:-4242"]);
        for (const invalid of ["0 0 S 00:01", "2 -1 S 00:01", "2 ? S 00:01", "2 9007199254740992 S 00:01", "2 0 S invalid"]) {
            expect(readRows(invalid)).toBeNull();
        }
        for (const invalid of [-1, 0, 1]) {
            expect(signalVerifiedProcessGroup({ pid: invalid, started_at: record.started_at }, "SIGKILL", {
                reads: reads(signals),
            })).toBe("unverified");
        }
        expect(signals).toEqual(["SIGTERM:-4242"]);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("a verified group leader receives the group signal", () => {
    const signals: string[] = [];
    expect(signalVerifiedProcessGroup(record, "SIGTERM", { reads: reads(signals) })).toBe("sent");
    expect(signals).toEqual([`SIGTERM:${-pid}`]);
});

test("a live group remains signalable after its leader exits", () => {
    const signals: string[] = [];
    const result = signalVerifiedProcessGroup(record, "SIGKILL", {
        reads: reads(signals, {
            readProcessGroupSnapshot: () => [{ pid: pid + 1, group: pid, state: "S", startedAt }],
        }),
        checkIdentity: () => "gone",
    });
    expect(result).toBe("sent");
    expect(signals).toEqual([`SIGKILL:${-pid}`]);
});

test("a nonleader, a reused leader, and a zombie-only orphan are not group signalled", () => {
    for (const scenario of ["nonleader", "replaced", "zombie"] as const) {
        const signals: string[] = [];
        const rows = scenario === "zombie"
            ? [{ pid: pid + 1, group: pid, state: "Z", startedAt }]
            : [{ pid, group: scenario === "nonleader" ? pid + 1 : pid,
                state: "S", startedAt: scenario === "replaced" ? startedAt + 60_000 : startedAt }];
        const result = signalVerifiedProcessGroup(record, "SIGKILL", {
            reads: reads(signals, { readProcessGroupSnapshot: () => rows }),
        });
        expect(result).toBe(scenario === "nonleader" ? "not_group_leader" : scenario === "replaced" ? "replaced" : "gone");
        expect(signals).toEqual([]);
    }
});

test("the last listing determines identity before a group signal", () => {
    const signals: string[] = [];
    let listings = 0;
    const result = signalVerifiedProcessGroup(record, "SIGKILL", {
        reads: reads(signals, {
            readProcessGroupSnapshot: () => {
                listings += 1;
                return [{ pid, group: pid, state: "S", startedAt: startedAt + 60_000 }];
            },
        }),
        checkIdentity: () => "same",
    });
    expect(result).toBe("replaced");
    expect(listings).toBe(1);
    expect(signals).toEqual([]);
});

test("an unreadable process listing or start time prevents the group signal", () => {
    for (const snapshot of [undefined, [{ pid, group: pid, state: "S", startedAt: Number.NaN }]]) {
        const signals: string[] = [];
        expect(signalVerifiedProcessGroup(record, "SIGKILL", {
            reads: reads(signals, { readProcessGroupSnapshot: () => snapshot }),
        })).toBe(snapshot === undefined ? "group_unverified" : "unverified");
        expect(signals).toEqual([]);
    }
});
