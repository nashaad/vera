import { expect, test } from "bun:test";

import {
    parseSettingsDestination,
    type SettingsDestination,
} from "../../src/engine/settings-destination.ts";

test("semantic settings destinations round-trip without presentation data", () => {
    const destinations: readonly SettingsDestination[] = [
        { kind: "settings" },
        { kind: "model" },
        { kind: "reasoning" },
        { kind: "permission_mode", mode: "ask" },
        { kind: "agent", name: "explorer" },
        { kind: "provider", provider: "openrouter" },
        { kind: "model_shortlist" },
        { kind: "model_assignments" },
        { kind: "model_assignment", assignment: "reviewer" },
    ];

    for (const destination of destinations) {
        expect(parseSettingsDestination(JSON.parse(JSON.stringify(destination))))
            .toEqual(destination);
        expect(JSON.stringify(destination)).not.toMatch(
            /"(?:tab|row|focus|dialog|modal|component)"/,
        );
    }
});

test("missing, stale, and positional destinations fail closed", () => {
    expect(parseSettingsDestination(undefined)).toBeUndefined();
    expect(parseSettingsDestination({ kind: "missing" })).toBeUndefined();
    expect(parseSettingsDestination({
        kind: "model_assignment",
        assignment: "retired-job",
    })).toBeUndefined();
    expect(parseSettingsDestination({ kind: "provider", provider: "" }))
        .toBeUndefined();
    expect(parseSettingsDestination({ kind: "model", tab: 2 }))
        .toBeUndefined();
    expect(parseSettingsDestination({ kind: "agent", row: 3 }))
        .toBeUndefined();
});
