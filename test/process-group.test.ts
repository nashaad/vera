import { expect, test } from "bun:test";

import { signalVerifiedProcessGroup, type ProcessGroupReads } from "../src/process-group.ts";

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
