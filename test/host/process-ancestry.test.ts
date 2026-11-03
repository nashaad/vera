import { expect, test } from "bun:test";

import { targetPidIsAncestor } from "../../src/host/process-ancestry.ts";

// pid 500's chain: 500 -> 400 -> 300 -> 200 -> 1.
const SAMPLE_TABLE = [
    "    1     0",
    "  200     1",
    "  300   200",
    "  400   300",
    "  500   400",
].join("\n");

test("finds a direct parent", () => {
    expect(
        targetPidIsAncestor(400, { listProcesses: () => SAMPLE_TABLE, currentPid: 500 }),
    ).toBe(true);
});

test("finds a grandparent several hops up", () => {
    expect(
        targetPidIsAncestor(200, { listProcesses: () => SAMPLE_TABLE, currentPid: 500 }),
    ).toBe(true);
});

test("a pid outside the chain is not an ancestor", () => {
    expect(
        targetPidIsAncestor(999, { listProcesses: () => SAMPLE_TABLE, currentPid: 500 }),
    ).toBe(false);
});

test("a sibling pid, not on the chain, is not an ancestor", () => {
    const withSibling = `${SAMPLE_TABLE}\n  501   400`;
    expect(
        targetPidIsAncestor(501, { listProcesses: () => withSibling, currentPid: 500 }),
    ).toBe(false);
});

test("an unreadable process table reports undefined, not false", () => {
    expect(
        targetPidIsAncestor(200, { listProcesses: () => undefined, currentPid: 500 }),
    ).toBeUndefined();
});

test("a cycle in the table does not loop forever", () => {
    const cyclic = ["  500   400", "  400   500"].join("\n");
    expect(
        targetPidIsAncestor(999, { listProcesses: () => cyclic, currentPid: 500 }),
    ).toBe(false);
});
