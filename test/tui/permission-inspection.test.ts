import { expect, test } from "bun:test";

import { renderPermissionInspection } from "../../clients/tui/permission-inspection.ts";

test("permission inspection renders rules and active grants", () => {
    expect(renderPermissionInspection({
        selected: {
            name: "auto",
            rules: [{
                name: "routine.read",
                when: { verb: "read" },
                then: "allow",
            }],
            defaultOutcome: "review",
            reviewerProfile: "default",
        },
        availableProfiles: ["ask", "auto", "full_access"],
        activeGrants: [{
            id: "grant-1:0",
            kind: "action",
            when: { operation: "git.push" },
            scope: "session",
            lifetime: "session",
        }],
    })).toBe([
        "Permission profile: auto",
        "Default: review",
        "Reviewer: default",
        "Rules:",
        "  routine.read: verb=read -> allow",
        "Session grants:",
        "  grant-1:0 [action]: operation=git.push",
    ].join("\n"));
});
