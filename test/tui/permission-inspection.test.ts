import { expect, test } from "bun:test";

import { renderPermissionInspection } from "../../clients/tui/permission-inspection.ts";

test("the mode is described, not itemized into rules the user cannot edit", () => {
    expect(renderPermissionInspection({
        selected: {
            name: "auto",
            rules: [
                { name: "routine.read", when: { verb: "read" }, then: "allow" },
                { name: "routine.write", when: { verb: "write" }, then: "ask" },
            ],
            defaultOutcome: "review",
            reviewerProfile: "default",
        },
        availableModes: ["ask", "auto", "full_access"],
        activeGrants: [{
            id: "grant-1:0",
            kind: "action",
            when: { operation: "git.push" },
            scope: "session",
            lifetime: "session",
        }],
    })).toBe([
        "Permission mode: auto",
        "a reviewer clears the safe ones, you decide the rest",
        "1 session grant · 0 preferences",
        "/settings to review or remove them",
    ].join("\n"));
});

test("the pointer is omitted when there is nothing to review", () => {
    // The zero counts stay: they say the two tiers exist and are yours. Only the
    // pointer goes, because it would open on an empty list.
    expect(renderPermissionInspection({
        selected: {
            name: "ask",
            rules: [
                { name: "routine.read", when: { verb: "read" }, then: "allow" },
            ],
            defaultOutcome: "ask",
        },
        availableModes: ["ask", "auto", "full_access"],
        activeGrants: [],
    })).toBe([
        "Permission mode: ask",
        "ask before every bash command",
        "0 session grants · 0 preferences",
    ].join("\n"));
});

test("preferences alone are enough to point at the overlay", () => {
    expect(renderPermissionInspection({
        selected: {
            name: "auto",
            rules: [],
            defaultOutcome: "review",
            reviewerProfile: "default",
        },
        availableModes: ["ask", "auto", "full_access"],
        activeGrants: [],
        activePreferences: [{
            id: "pref-1",
            when: { verb: "delete", path: "/repo/other" },
            createdAt: "2026-01-01T00:00:00.000Z",
        }],
    })).toContain("0 session grants · 1 preference");
});

test("a custom mode with no written description falls back to its default", () => {
    expect(renderPermissionInspection({
        selected: {
            name: "house-style",
            rules: [],
            defaultOutcome: "deny",
        },
        availableModes: ["ask", "auto", "full_access", "house-style"],
        activeGrants: [],
    })).toBe([
        "Permission mode: house-style",
        "everything unmatched: deny",
        "0 session grants · 0 preferences",
    ].join("\n"));
});
