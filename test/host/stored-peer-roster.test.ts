import { expect, test } from "bun:test";

import { storedPeerRoster } from "../../src/host/agent-registry/stored-peer.ts";
import { rememberStoredPeerFacts } from "../../src/store/session-peer-metadata.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry/support.ts";

function stored(id: string, age: number, overrides: Partial<RegisteredAgentSummary> = {}): RegisteredAgentSummary {
    const summary: RegisteredAgentSummary = {
        id, workspace: "/project", session_path: `/sessions/${id}.jsonl`,
        kind: "interactive", status: "completed", live: false,
        updated_at: new Date(Date.now() - age).toISOString(), ...overrides,
    };
    rememberStoredPeerFacts(summary, { name: `${id}:1234`, failed: id === "failed" });
    return summary;
}

test("@core parked roster is bounded, recent, interactive and workspace scoped", () => {
    const minute = 60_000;
    const rows = [
        ...Array.from({ length: 23 }, (_, index) => stored(`crow-${String(index).padStart(2, "0")}`, index * minute)),
        stored("old", 11 * 24 * 60 * minute),
        stored("other", 0, { workspace: "/another-project" }),
        stored("background", 0, { kind: "background" }),
        stored("legacy-child", 0, { parent_id: "parent" }),
        stored("failed", 0),
        stored("resident", 0, { live: true }),
        stored("self", 0),
    ];
    const roster = storedPeerRoster(rows, "self", "/project", false, new Set(["crow-00"]));
    expect(roster).toHaveLength(20);
    expect(roster[0]).toMatchObject({ participant_id: "crow-01", name: "crow-01:1234", status: "parked", live: false });
    expect(roster.at(-1)?.participant_id).toBe("crow-20");
    expect(roster.some((row) => ["old", "other", "background", "legacy-child", "failed", "resident", "self", "crow-00"].includes(row.participant_id))).toBe(false);
});
