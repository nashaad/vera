/** Every runtime handle keyed by a pool-admission requestId moves to the retry's id when an `unavailable` verdict is retried. */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "bun:test";

const ROOT = join(import.meta.dir, "../..");

/**
 * The runtime fields that hold a pool-admission requestId. A retry mints a new
 * id, so a field left on the old one never hears the second answer. Adding a
 * consumer means adding it here and rehoming it in `retryPoolAdmission`.
 */
const REHOMED_ON_RETRY = new Set([
    "admissionDialog",
    "onboardingVerification",
    "pendingPoolChanges",
    "pendingPoolName",
    "pendingPoolUndos",
    "poolVerifySweep",
]);

function retryBody(): string {
    const source = readFileSync(
        join(ROOT, "clients/tui/main/session-ops.ts"),
        "utf8",
    );
    const start = source.indexOf("export function retryPoolAdmission");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n}", start);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
}

test("a retried admission carries every handle keyed by its request id", () => {
    const body = retryBody();
    const carried = new Set(
        [...body.matchAll(/rt\.(\w+)/g)].map((match) => match[1] as string),
    );
    // The attempt table is keyed by the old id and rebuilt by the new request,
    // so it is read here rather than rehomed.
    carried.delete("poolAdmissionAttempts");
    carried.delete("state");
    expect([...carried].sort()).toEqual([...REHOMED_ON_RETRY].sort());
    for (const field of REHOMED_ON_RETRY) {
        expect(body).toContain("requestId: retryId");
        expect(body).toContain(`rt.${field}`);
    }
});
